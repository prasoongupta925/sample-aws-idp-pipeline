#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["boto3"]
# ///
"""Re-index every document after the switch to Titan Text Embeddings V2.

A LanceDB table must only ever hold vectors of one embedding model, and the vectors stored before the
all-Mumbai deploy come from Nova multimodal embeddings. Run this right after that deploy: until it has
run, search compares Titan V2 queries with the old vectors, and a new upload adds Titan V2 vectors to an
old table (the drop removes those too, and that document is re-analyzed like the others). It:

  1. checks that the LanceDB service now embeds with Titan V2 in-Region, that no document is being
     processed and that the LanceDB write queue is empty;
  2. drops every LanceDB table (each project's documents and datasets tables, the graph keywords table,
     tables of deleted projects), checks that none is left and that the lock table holds no commit entry
     of them (a re-created table would clash with those), so no Titan vector joins a Nova table;
  3. re-analyzes every document through the backend (POST /documents/{id}/workflows/{wf}/reanalyze,
     SigV4, x-user-id asha.verma): one document first, and only when it completes the others, at most
     --max-in-flight at a time and --interval seconds apart. The pages are read again with the
     deployed models (so the facts the file check uses are extracted again too) and each
     question/answer entry is embedded again (Titan V2 allows 60 requests a minute in ap-south-1);
  4. waits until every re-analysis has ended and the write queue has drained, then prints a check per
     project: documents completed, LanceDB rows = question/answer entries of the analyses, search works.

Dry run by default: step 1 and the current state only, nothing is changed. --apply acts.
Needs the Re-analyze fix (state machine input with processing_type, failed runs marked failed) deployed.
Search has no results from the drop until the re-analyses are done. A run stopped half way can simply
be started again: it drops the tables and re-analyzes everything again.

Usage (profile AWS_PROFILE, default idp-demo; region AWS_REGION, default ap-south-1):
  uv run deploy/lean/reindex.py            # dry run
  uv run deploy/lean/reindex.py --apply
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Callable

PROFILE = os.environ.get('AWS_PROFILE') or 'idp-demo'
REGION = os.environ.get('AWS_REGION') or 'ap-south-1'
USER = 'asha.verma'  # x-user-id: the made-up demo case handler
APP_STACK = 'IDP-V2-Application'
LANCE_FUNCTION = 'idp-v2-lance-service'
WRITE_QUEUE = 'idp-v2-lancedb-write-queue'
LOCK_TABLE_PARAM = '/idp-v2/lancedb/lock/table-name'
TITAN_V2 = 'amazon.titan-embed-text-v2:0'

# Workflow statuses (infra shared/ddb_client.py WorkflowStatus; the backend sets "reanalyzing").
REANALYZABLE = frozenset({'completed', 'failed'})  # what POST .../reanalyze accepts
FINISHED = frozenset({'completed', 'failed', 'skipped', 'needs_user_fix'})
NO_WORKFLOW = 'no workflow'

POLL_SECONDS = 15

Log = Callable[[str], None]


def redact(text: str) -> str:
    """No account ids in the output (error messages can carry ARNs)."""
    return re.sub(r'\b\d{12}\b', '<account>', text)


class ReindexError(Exception):
    """Stops the run with a message."""


@dataclass
class Doc:
    project_id: str
    project_name: str
    document_id: str
    name: str
    workflow_id: str | None
    status: str
    language: str
    started: float | None = None
    outcome: str | None = None  # a finished status, 'stuck' or 'not started'

    @property
    def label(self) -> str:
        return f'{self.project_name} / {self.name}'


@dataclass
class Project:
    project_id: str
    name: str
    docs: list[Doc] = field(default_factory=list)


@dataclass
class Settings:
    apply: bool = False
    max_in_flight: int = 3
    interval: float = 15.0  # seconds between two starts
    doc_timeout: float = 30 * 60  # seconds before a run counts as stuck
    timeout: float = 120 * 60  # seconds for all re-analyses
    drain_timeout: float = 20 * 60  # seconds for the write queue


# --------------------------------------------------------------------------- AWS access


class Backend:
    """The backend HTTP API (IAM auth), called as the web app and the demo seed script call it."""

    def __init__(self, session, url: str):
        self._session = session
        self.url = url.rstrip('/')

    def _send(self, method: str, path: str, body: dict | None) -> object:
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest

        data = json.dumps(body).encode() if body is not None else None
        headers = {'x-user-id': USER}
        if data is not None:
            headers['Content-Type'] = 'application/json'
        request = AWSRequest(method=method, url=f'{self.url}/{path}', data=data, headers=headers)
        credentials = self._session.get_credentials().get_frozen_credentials()
        SigV4Auth(credentials, 'execute-api', REGION).add_auth(request)
        signed = urllib.request.Request(
            request.url, data=data, method=method, headers=dict(request.headers)
        )
        with urllib.request.urlopen(signed, timeout=60) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}

    def get(self, path: str) -> object:
        """GET, retried on throttling, 5xx and network errors (the API runs on Lambda)."""
        for attempt in range(1, 5):
            try:
                return self._send('GET', path, None)
            except urllib.error.HTTPError as e:
                detail = e.read()[:300].decode(errors='replace')
                if e.code not in (429, 500, 502, 503, 504) or attempt == 4:
                    raise ReindexError(f'GET /{path}: HTTP {e.code} {redact(detail)}') from None
            except (urllib.error.URLError, TimeoutError) as e:
                if attempt == 4:
                    raise ReindexError(f'GET /{path}: {redact(str(e))}') from None
            time.sleep(5 * attempt)
        raise AssertionError('unreachable')

    def post(self, path: str, body: dict) -> object:
        """POST once (a retry could start a second run); the caller re-reads the status on errors."""
        try:
            return self._send('POST', path, body)
        except urllib.error.HTTPError as e:
            detail = e.read()[:300].decode(errors='replace')
            raise ReindexError(f'POST /{path}: HTTP {e.code} {redact(detail)}') from None
        except (urllib.error.URLError, TimeoutError) as e:
            raise ReindexError(f'POST /{path}: {redact(str(e))}') from None


class Aws:
    """The LanceDB service Lambda, its write queue and its commit-lock table."""

    def __init__(self, session):
        from botocore.config import Config

        # drop_table also deletes the table's commit entries: allow the function's 5 minutes.
        self._lambda = session.client(
            'lambda', config=Config(read_timeout=310, retries={'max_attempts': 3, 'mode': 'standard'})
        )
        self._sqs = session.client('sqs')
        self._ssm = session.client('ssm')
        self._ddb = session.client('dynamodb')
        self._queue_url: str | None = None
        self._lock_table: str | None = None

    def lance(self, action: str, params: dict | None = None) -> dict:
        # list_tables takes no params at all: the service rejects even an empty object.
        payload = {'action': action} if params is None else {'action': action, 'params': params}
        response = self._lambda.invoke(
            FunctionName=LANCE_FUNCTION,
            InvocationType='RequestResponse',
            Payload=json.dumps(payload).encode(),
        )
        body = json.loads(response['Payload'].read() or b'{}')
        if response.get('FunctionError') or body.get('statusCode') != 200:
            error = body.get('error') or body.get('errorMessage') or body
            raise ReindexError(f'LanceDB {action}: {redact(str(error))[:300]}')
        return body

    def lance_embedding(self) -> dict:
        """EMBEDDING_MODEL_ID / EMBEDDING_REGION and update state of the deployed service."""
        config = self._lambda.get_function_configuration(FunctionName=LANCE_FUNCTION)
        env = (config.get('Environment') or {}).get('Variables') or {}
        return {
            'model': env.get('EMBEDDING_MODEL_ID', ''),
            'region': env.get('EMBEDDING_REGION', ''),
            'state': config.get('State', ''),
            'update': config.get('LastUpdateStatus', ''),
        }

    def queue_depth(self) -> int:
        if self._queue_url is None:
            self._queue_url = self._sqs.get_queue_url(QueueName=WRITE_QUEUE)['QueueUrl']
        attributes = self._sqs.get_queue_attributes(
            QueueUrl=self._queue_url,
            AttributeNames=[
                'ApproximateNumberOfMessages',
                'ApproximateNumberOfMessagesNotVisible',
                'ApproximateNumberOfMessagesDelayed',
            ],
        )['Attributes']
        return sum(int(value) for value in attributes.values())

    def _lock(self) -> str:
        if self._lock_table is None:
            self._lock_table = self._ssm.get_parameter(Name=LOCK_TABLE_PARAM)['Parameter']['Value']
        return self._lock_table

    def commit_entries(self, tables: list[str]) -> list[dict]:
        """Keys of the lock-table entries (one per table version) of the LanceDB tables `tables`."""
        if not tables:
            return []
        exact = {f'{t}.lance' for t in tables}
        suffixes = tuple(f'/{t}.lance' for t in tables)
        keys: list[dict] = []
        start = None
        while True:
            request = {
                'TableName': self._lock(),
                'ProjectionExpression': '#b, #v',
                'ExpressionAttributeNames': {'#b': 'base_uri', '#v': 'version'},
            }
            if start:
                request['ExclusiveStartKey'] = start
            page = self._ddb.scan(**request)
            for item in page.get('Items', []):
                uri = item['base_uri']['S']
                if uri in exact or uri.endswith(suffixes):
                    keys.append({'base_uri': item['base_uri'], 'version': item['version']})
            start = page.get('LastEvaluatedKey')
            if not start:
                return keys

    def delete_commit_entries(self, keys: list[dict]) -> None:
        table = self._lock()
        for i in range(0, len(keys), 25):
            requests = [{'DeleteRequest': {'Key': key}} for key in keys[i : i + 25]]
            while requests:
                out = self._ddb.batch_write_item(RequestItems={table: requests})
                requests = (out.get('UnprocessedItems') or {}).get(table, [])
                if requests:
                    time.sleep(1)


def api_url(session) -> str:
    stack = session.client('cloudformation').describe_stacks(StackName=APP_STACK)['Stacks'][0]
    for output in stack.get('Outputs', []):
        if 'BackendUrl' in output['OutputKey']:
            return output['OutputValue']
    raise ReindexError(f'no BackendUrl output on {APP_STACK}: is the app deployed?')


# --------------------------------------------------------------------------- steps


def _items(listing) -> list:
    if isinstance(listing, list):
        return listing
    return listing.get('items') or listing.get('projects') or listing.get('documents') or []


def collect(api) -> list[Project]:
    """Every project with its documents (not deleted ones) and each document's latest workflow."""
    projects = []
    for p in _items(api.get('projects')):
        project = Project(p['project_id'], p.get('name') or p['project_id'])
        language = p.get('language') or 'en'
        documents = _items(api.get(f'projects/{project.project_id}/documents'))
        statuses = {d['document_id']: d.get('status', '') for d in documents}
        for entry in _items(api.get(f'projects/{project.project_id}/workflows')):
            document_id = entry['document_id']
            if document_id not in statuses or statuses[document_id] == 'deleted':
                continue
            workflows = sorted(entry.get('workflows') or [], key=lambda w: w.get('created_at') or '')
            latest = workflows[-1] if workflows else {}
            project.docs.append(
                Doc(
                    project_id=project.project_id,
                    project_name=project.name,
                    document_id=document_id,
                    name=entry.get('document_name') or document_id,
                    workflow_id=latest.get('workflow_id'),
                    status=latest.get('status') or NO_WORKFLOW,
                    language=latest.get('language') or language,
                )
            )
        projects.append(project)
    return projects


def webhook_on(api, projects: list[Project]) -> set[str]:
    """Ids of the projects whose CRM webhook is on (its URL is never read out)."""
    on = set()
    for project in projects:
        try:
            settings = api.get(f'projects/{project.project_id}/integrations/webhook')
        except ReindexError:
            continue
        if isinstance(settings, dict) and settings.get('enabled') is True:
            on.add(project.project_id)
    return on


def table_label(table: str, names: dict[str, str]) -> str:
    project = table[: -len('_datasets')] if table.endswith('_datasets') else None
    if table in names:
        return f'documents of {names[table]}'
    if project in names:
        return f'datasets of {names[project]}'
    if table == 'graph_keywords':
        return 'graph keywords'
    return 'no such project: left by a deleted project'


def lance_tables(aws) -> list[str]:
    return sorted(aws.lance('list_tables').get('tables') or [])


def table_rows(aws, table: str) -> int | None:
    """Rows of a LanceDB table, None when it does not exist."""
    body = aws.lance('count', {'project_id': table})
    return int(body.get('count') or 0) if body.get('exists') else None


def preflight(aws, projects: list[Project], log: Log) -> list[str]:
    """Problems that stop --apply (empty when it may run)."""
    problems = []
    lance = aws.lance_embedding()
    log(f'LanceDB service embeds with {lance["model"] or "(unset)"} in {lance["region"] or "(unset)"}')
    if lance['model'] != TITAN_V2 or lance['region'] != REGION:
        problems.append(
            f'the LanceDB service must embed with {TITAN_V2} in {REGION}: deploy the all-Mumbai build '
            "first (re-indexing now would store the old model's vectors again)"
        )
    elif lance['state'] not in ('', 'Active') or lance['update'] not in ('', 'Successful'):
        problems.append(
            f'the LanceDB service is {lance["state"]}/{lance["update"]}: wait until its update has finished'
        )
    busy = [d for p in projects for d in p.docs if d.status not in FINISHED | {NO_WORKFLOW}]
    for d in busy:
        problems.append(f'still processing ({d.status}): {d.label}')
    if busy:
        problems.append(
            'wait until those documents have finished (a run stuck on "reanalyzing": deploy/lean/unstick.sh)'
        )
    depth = aws.queue_depth()
    log(f'LanceDB write queue: {depth} message(s)')
    if depth:
        problems.append(f'the LanceDB write queue still holds {depth} message(s): wait until it is empty')
    return problems


def drop_all_tables(aws, names: dict[str, str], log: Log) -> None:
    """Drops every LanceDB table; raises unless no table and no commit entry of one is left."""
    tables = lance_tables(aws)
    for table in tables:
        aws.lance('drop_table', {'project_id': table})
        log(f'  dropped {table} ({table_label(table, names)})')
    left = lance_tables(aws)
    if left:
        raise ReindexError(
            f'LanceDB tables still there after the drop: {", ".join(left)}. Nothing was re-analyzed; '
            'run this again.'
        )
    # drop_table deletes one query page of a table's commit entries: remove what it left, or the
    # re-created table (same name, versions from 1) would clash with the old versions.
    stale = aws.commit_entries(tables)
    if stale:
        aws.delete_commit_entries(stale)
        log(f'  removed {len(stale)} commit entries the drop left in the lock table')
        if aws.commit_entries(tables):
            raise ReindexError('commit entries of the dropped tables are still in the lock table; run again')
    log(f'  {len(tables)} table(s) dropped, none left')


def _refresh(api, docs: list[Doc]) -> None:
    """Re-reads the workflow status of `docs` (one call per project)."""
    for project_id in {d.project_id for d in docs}:
        current = {}
        for entry in _items(api.get(f'projects/{project_id}/workflows')):
            for w in entry.get('workflows') or []:
                current[w['workflow_id']] = w.get('status', '')
        for d in docs:
            if d.project_id == project_id and d.workflow_id in current:
                d.status = current[d.workflow_id]


def reanalyze_all(
    api,
    docs: list[Doc],
    settings: Settings,
    log: Log,
    now: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    """Re-analyzes `docs`, paced, and waits for them; sets each doc's outcome."""
    waiting = list(docs)
    running: list[Doc] = []
    last_start: float | None = None
    deadline = now() + settings.timeout
    while waiting or running:
        if running:
            _refresh(api, running)
        for d in list(running):
            elapsed = now() - (d.started or 0)
            if d.status in FINISHED:
                d.outcome = d.status
                running.remove(d)
                log(f'  {d.outcome:<9} {d.label} ({elapsed / 60:.1f} min)')
            elif elapsed > settings.doc_timeout:
                d.outcome = 'stuck'
                running.remove(d)
                log(f'  stuck     {d.label}: still "{d.status}" after {elapsed / 60:.0f} min')
        if now() > deadline:
            for d in running + waiting:
                d.outcome = 'stuck' if d.started else 'not started'
            log(f'  stopped waiting after {settings.timeout / 60:.0f} min')
            return
        while (
            waiting
            and len(running) < settings.max_in_flight
            and (last_start is None or now() - last_start >= settings.interval)
        ):
            d = waiting.pop(0)
            last_start = now()
            try:
                api.post(
                    f'documents/{d.document_id}/workflows/{d.workflow_id}/reanalyze',
                    {'user_instructions': '', 'language': d.language},
                )
            except ReindexError as e:
                # The run may have started all the same (e.g. a gateway timeout): look.
                _refresh(api, [d])
                if d.status in REANALYZABLE:
                    d.outcome = 'not started'
                    log(f'  not started {d.label}: {e}')
                    continue
            d.started = now()
            d.status = 'reanalyzing'
            running.append(d)
            log(f'  started   {d.label} ({len(running)} running, {len(waiting)} waiting)')
        if waiting or running:
            sleep(POLL_SECONDS)


def wait_drained(aws, settings: Settings, log: Log, now=time.monotonic, sleep=time.sleep) -> bool:
    """True once the write queue was empty twice in a row."""
    deadline = now() + settings.drain_timeout
    empty_reads = 0
    while now() <= deadline:
        empty_reads = empty_reads + 1 if aws.queue_depth() == 0 else 0
        if empty_reads == 2:
            return True
        sleep(POLL_SECONDS)
    log(f'  the LanceDB write queue did not drain in {settings.drain_timeout / 60:.0f} min')
    return False


_MARKUP = re.compile(r'!?\[([^\]]*)\]\([^)]*\)|https?://\S+|[#*`>|]+')
PROBE_CHARS = 500


def search_probe(text: str) -> str:
    """A search query from an analysis text: its first PROBE_CHARS characters, without markup or links."""
    return ' '.join(_MARKUP.sub(r' \1 ', text).split())[:PROBE_CHARS]


def expected_rows(api, d: Doc) -> tuple[int, str]:
    """Question/answer entries the analysis-finalizer sends to LanceDB (those with content), and a
    search query made of the document's longest analysis (every page's first entry has the same
    question, "Page N Analysis", so a question would not single the document out). The workflow
    lists no segments: each is read."""
    path = f'documents/{d.document_id}/workflows/{d.workflow_id}'
    entries = []
    for index in range(int(api.get(path).get('total_segments') or 0)):
        try:
            segment = api.get(f'{path}/segments/{index}')
        except ReindexError as e:
            if 'HTTP 404' in str(e):
                continue
            raise
        entries += [a for a in segment.get('ai_analysis') or [] if isinstance(a, dict) and a.get('content')]
    longest = max((str(a['content']) for a in entries), key=len, default='')
    return len(entries), search_probe(longest)


def _search_finds(aws, project_id: str, probe: Doc, query: str) -> tuple[bool, str]:
    params = {'project_id': project_id, 'query': query, 'limit': 5, 'language': probe.language}
    try:
        hits = aws.lance('hybrid_search', params).get('results') or []
    except ReindexError as e:
        return False, f', search failed ({e})'
    found = any(h.get('document_id') == probe.document_id for h in hits)
    return found, f', search {"finds" if found else "MISSES"} {probe.name} in the top 5'


def check(api, aws, projects: list[Project], drained: bool, log: Log) -> bool:
    """Per project: documents completed, LanceDB rows as expected, search works. True when all pass."""
    ok = drained
    lance = aws.lance_embedding()
    if lance['model'] != TITAN_V2 or lance['region'] != REGION:
        log(f'FAIL  the LanceDB service embeds with {lance["model"]} in {lance["region"]}')
        ok = False
    for project in projects:
        reindexed = [d for d in project.docs if d.outcome]
        bad = [d for d in reindexed if d.outcome != 'completed']
        expected, query, probe = 0, '', None
        for d in reindexed:
            count, text = expected_rows(api, d)
            expected += count
            if text and probe is None and d.outcome == 'completed':
                query, probe = text, d
        rows = table_rows(aws, project.project_id) or 0
        search_ok, searched = True, ''
        if probe and rows:
            search_ok, searched = _search_finds(aws, project.project_id, probe, query)
        passed = not bad and rows == expected and search_ok
        ok = ok and passed
        log(
            f'{"PASS" if passed else "FAIL"}  {project.name}: '
            f'{len(reindexed) - len(bad)}/{len(reindexed)} documents completed, '
            f'{rows} LanceDB rows (expected {expected}){searched}'
        )
        for d in bad:
            log(f'      {d.outcome}: {d.name}')
        for d in project.docs:
            if not d.outcome:
                log(f'      not re-analyzed ({d.status}): {d.name}')
    known = {p.project_id for p in projects} | {f'{p.project_id}_datasets' for p in projects}
    others = [t for t in lance_tables(aws) if t not in known]
    if others:
        log(f'note  other LanceDB tables (created after the drop, so Titan V2): {", ".join(others)}')
    if ok:
        log('Every LanceDB table was dropped and written again by the Titan V2 service: no old vector left.')
    return ok


def _minutes(settings: Settings, documents: int) -> float:
    """Rough duration: ~4 min per document, max_in_flight at a time, starts paced."""
    per_document = max(4.0 / settings.max_in_flight, settings.interval / 60)
    return 4.0 + max(documents - 1, 0) * per_document


def run(settings: Settings, api, aws, log: Log = print, now=time.monotonic, sleep=time.sleep) -> int:
    projects = collect(api)
    names = {p.project_id: p.name for p in projects}
    docs = [d for p in projects for d in p.docs]
    todo = [d for d in docs if d.status in REANALYZABLE]

    log(f'Region {REGION}: {len(projects)} project(s), {len(docs)} document(s), {len(todo)} to re-analyze')
    for project in projects:
        log(f'  {project.name}: {len(project.docs)} document(s)')
        for d in project.docs:
            if d.status not in REANALYZABLE:
                log(f'    skip ({d.status}): {d.name}')
    tables = lance_tables(aws)
    log(f'LanceDB tables to drop: {len(tables)}')
    for table in tables:
        log(f'  {table}: {table_rows(aws, table)} rows, {table_label(table, names)}')
    if tables:
        log(f'  their commit entries in the lock table: {len(aws.commit_entries(tables))}')
    problems = preflight(aws, projects, log)
    log(
        f'Plan: drop {len(tables)} table(s), re-analyze {len(todo)} document(s) (one first, then '
        f'{settings.max_in_flight} at a time, {settings.interval:.0f} s apart): '
        f'about {_minutes(settings, len(todo)):.0f} min'
    )
    hooked = webhook_on(api, projects)
    pushes = sum(1 for d in todo if d.project_id in hooked)
    if pushes:
        log(
            f'  CRM webhook on in {len(hooked)} project(s): each completed re-analysis sends it, as an '
            f'upload does ({pushes} deliveries)'
        )
    if not settings.apply:
        for problem in problems:
            log(f'  would stop: {problem}')
        log('Dry run: nothing changed. Run with --apply to re-index.')
        return 0
    if problems:
        for problem in problems:
            log(f'  stop: {problem}')
        return 2

    log('Dropping the LanceDB tables')
    drop_all_tables(aws, names, log)
    if todo:
        # One document first: if Re-analyze is broken (deployed without its fix), one run fails, not all.
        log(f'Re-analyzing 1 document first: {todo[0].label}')
        reanalyze_all(api, todo[:1], settings, log, now=now, sleep=sleep)
        if todo[0].outcome != 'completed':
            for d in todo[1:]:
                d.outcome = 'not started'
            log(
                f'The first re-analysis ended "{todo[0].outcome}": stopped before the others. Check that the '
                'Re-analyze fix is deployed (deploy/lean/unstick.sh resets a run stuck on "reanalyzing"), '
                'then run this again. Search has no results until then.'
            )
            return 1
    if len(todo) > 1:
        log(f'Re-analyzing the other {len(todo) - 1} document(s)')
        reanalyze_all(api, todo[1:], settings, log, now=now, sleep=sleep)
    log('Waiting for the LanceDB write queue to drain')
    drained = wait_drained(aws, settings, log, now=now, sleep=sleep)
    log('Check')
    return 0 if check(api, aws, projects, drained, log) else 1


def parse_args(argv: list[str]) -> Settings:
    parser = argparse.ArgumentParser(
        description='Re-index every document after the switch to Titan Text Embeddings V2 '
        '(dry run unless --apply).'
    )
    parser.add_argument('--apply', action='store_true', help='act (default: dry run, nothing changed)')
    parser.add_argument('--max-in-flight', type=int, default=3, help='re-analyses at once (default 3)')
    parser.add_argument('--interval', type=float, default=15, help='seconds between starts (default 15)')
    parser.add_argument('--doc-timeout', type=float, default=30, help='minutes until stuck (default 30)')
    parser.add_argument('--timeout', type=float, default=120, help='minutes for all runs (default 120)')
    parser.add_argument('--drain-timeout', type=float, default=20, help='minutes for the queue (default 20)')
    a = parser.parse_args(argv)
    if a.max_in_flight < 1 or a.interval < 0:
        parser.error('--max-in-flight must be 1 or more and --interval 0 or more')
    return Settings(
        apply=a.apply,
        max_in_flight=a.max_in_flight,
        interval=a.interval,
        doc_timeout=a.doc_timeout * 60,
        timeout=a.timeout * 60,
        drain_timeout=a.drain_timeout * 60,
    )


def main(argv: list[str]) -> int:
    settings = parse_args(argv)
    try:
        import boto3

        session = boto3.Session(profile_name=PROFILE, region_name=REGION)
        return run(settings, Backend(session, api_url(session)), Aws(session))
    except KeyboardInterrupt:
        print('interrupted: run it again to finish (it drops the tables and re-analyzes everything again)')
        return 130
    except Exception as e:  # AWS errors can carry ARNs: print them redacted, never a raw traceback
        print(f'stopped: {type(e).__name__}: {redact(str(e))}')
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
