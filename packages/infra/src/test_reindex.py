"""deploy/lean/reindex.py against in-memory fakes of the backend API, the LanceDB service, its write
queue and its lock table (no AWS calls, synthetic data only).

Run from the repo root:
    uv run --with pytest python -m pytest -q packages/infra/src/test_reindex.py
"""

import importlib.util
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location('reindex', REPO / 'deploy' / 'lean' / 'reindex.py')
reindex = importlib.util.module_from_spec(SPEC)
sys.modules['reindex'] = reindex  # dataclasses look their module up
SPEC.loader.exec_module(reindex)

NOVA = 'amazon.nova-2-multimodal-embeddings-v1:0'


def page_analysis(name):
    """A page's main analysis as the backend returns it: markdown, a signed image link, then text."""
    return (
        f'## Page 1\n![page 1](https://example.invalid/page-1.png?X-Amz-Signature=synthetic)\n'
        f'A synthetic **{name}** of a made-up applicant. ' + 'Net pay 82,500. ' * 60
    )


class World:
    """Projects, workflows and LanceDB; each sleep() is one tick of the pipeline."""

    def __init__(
        self, projects, model=reindex.TITAN_V2, queue=(), run_ticks=2, fail=(), hang=(), webhooks=('proj-rahul',)
    ):
        self.t = 0.0
        self.webhooks = set(webhooks)  # projects whose CRM webhook is on
        self.log: list[str] = []
        self.events: list[tuple] = []
        self.projects = projects  # {pid: {'name', 'docs': {doc_id: {'name', 'wf', 'status', 'qa'}}}}
        self.model = model
        self.queue = list(queue)  # queue depths answered in turn, then 0
        self.run_ticks = run_ticks
        self.fail, self.hang = set(fail), set(hang)
        self.running: dict[str, int] = {}  # doc_id -> ticks left
        self.max_running = 0
        self.tables = {pid: 99 for pid in projects}  # old (Nova) vectors
        self.tables.update({'proj-gone': 3, 'graph_keywords': 7, f'{next(iter(projects))}_datasets': 2})
        self.commit = {f'{t}.lance': 40 for t in self.tables}
        self.commit['bucket/proj-gone.lance'] = 5
        self.left_by_drop = {'graph_keywords.lance': 3}  # one query page was not deleted

    # clock
    def now(self):
        return self.t

    def sleep(self, seconds):
        self.t += seconds
        for doc_id in list(self.running):
            self.running[doc_id] -= 1
            if self.running[doc_id] <= 0 and doc_id not in self.hang:
                del self.running[doc_id]
                pid, doc = self._doc(doc_id)
                doc['status'] = 'failed' if doc_id in self.fail else 'completed'
                if doc_id not in self.fail:
                    self.tables[pid] = self.tables.get(pid, 0) + doc['qa']

    def _doc(self, doc_id):
        for pid, project in self.projects.items():
            if doc_id in project['docs']:
                return pid, project['docs'][doc_id]
        raise KeyError(doc_id)

    # backend API
    def get(self, path):
        parts = path.split('/')
        if path == 'projects':
            return [{'project_id': pid, 'name': p['name'], 'language': 'en'} for pid, p in self.projects.items()]
        if parts[0] == 'projects' and parts[2] == 'documents':
            docs = self.projects[parts[1]]['docs']
            return [{'document_id': d, 'status': doc.get('doc_status', 'completed')} for d, doc in docs.items()]
        if parts[0] == 'projects' and parts[2:] == ['integrations', 'webhook']:
            if parts[1] == 'proj-empty':
                raise reindex.ReindexError(f'GET /{path}: HTTP 404 project settings not found')
            return {'url': 'https://crm.example.invalid/hook', 'enabled': parts[1] in self.webhooks}
        if parts[0] == 'projects' and parts[2] == 'workflows':
            return [
                {
                    'document_id': d,
                    'document_name': doc['name'],
                    'workflows': [
                        {'workflow_id': doc['wf'], 'status': doc['status'], 'language': 'en', 'created_at': '2'},
                        {'workflow_id': 'wf-old', 'status': 'completed', 'created_at': '1'},
                    ]
                    if doc['wf']
                    else [],
                }
                for d, doc in self.projects[parts[1]]['docs'].items()
            ]
        if parts[0] == 'documents' and parts[2] == 'workflows' and len(parts) == 4:
            # Like the backend: no segments in the workflow, only how many there are.
            return {'total_segments': 3, 'segments': []}
        if parts[0] == 'documents' and parts[4] == 'segments':
            _, doc = self._doc(parts[1])
            index = int(parts[5])
            if index == 2:
                raise reindex.ReindexError(f'GET /{path}: HTTP 404 segment not found')
            # Every page's first entry has the same question; the tool answers are short.
            main = {'analysis_query': 'Page 1 Analysis', 'content': page_analysis(doc['name'])}
            short = {'analysis_query': 'What is the net pay?', 'content': 'synthetic'}
            entries = [main] + [short] * (doc['qa'] - 1) if doc['qa'] else []
            empty = [{'analysis_query': 'empty', 'content': ''}]
            return {'ai_analysis': entries + empty if index == 0 else empty}
        raise AssertionError(path)

    def post(self, path, body):
        doc_id = path.split('/')[1]
        self.events.append(('reanalyze', doc_id, body))
        _, doc = self._doc(doc_id)
        assert doc['status'] in reindex.REANALYZABLE
        doc['status'] = 'reanalyzing'
        self.running[doc_id] = self.run_ticks
        self.max_running = max(self.max_running, len(self.running))
        return {'status': 'reanalyzing'}

    # LanceDB service, queue, lock table
    def lance(self, action, params=None):
        self.events.append(('lance', action, params))
        if action == 'list_tables':
            assert params is None
            return {'statusCode': 200, 'tables': list(self.tables)}
        if action == 'count':
            name = params['project_id']
            return {'statusCode': 200, 'exists': name in self.tables, 'count': self.tables.get(name, 0)}
        if action == 'drop_table':
            name = params['project_id']
            self.tables.pop(name, None)
            for uri in [u for u in self.commit if u == f'{name}.lance' or u.endswith(f'/{name}.lance')]:
                left = self.left_by_drop.get(uri, 0)
                if left:
                    self.commit[uri] = left
                else:
                    del self.commit[uri]
            return {'statusCode': 200, 'success': True}
        if action == 'hybrid_search':
            pid = params['project_id']
            assert params['language'] == 'en' and params['limit'] == 5
            docs = self.projects[pid]['docs']
            hits = [
                d
                for d, doc in docs.items()
                if params['query'] == reindex.search_probe(page_analysis(doc['name']))
            ]
            return {'statusCode': 200, 'results': [{'document_id': d} for d in hits]}
        raise AssertionError(action)

    def lance_embedding(self):
        return {'model': self.model, 'region': 'ap-south-1', 'state': 'Active', 'update': 'Successful'}

    def queue_depth(self):
        return self.queue.pop(0) if self.queue else 0

    def commit_entries(self, tables):
        names = {f'{t}.lance' for t in tables}
        suffixes = tuple(f'/{t}.lance' for t in tables)
        return [{'base_uri': u, 'version': v} for u in self.commit if u in names or u.endswith(suffixes)
                for v in range(self.commit[u])]

    def delete_commit_entries(self, keys):
        self.events.append(('delete_commit_entries', len(keys)))
        for uri in {k['base_uri'] for k in keys}:
            del self.commit[uri]


def demo_projects():
    return {
        'proj-rahul': {
            'name': 'Rahul Deshmukh - Personal Loan',
            'docs': {
                'doc-slip': {'name': 'salary_slip.pdf', 'wf': 'wf-slip', 'status': 'completed', 'qa': 3},
                'doc-bank': {'name': 'bank_statement.pdf', 'wf': 'wf-bank', 'status': 'failed', 'qa': 4},
                'doc-xlsx': {'name': 'cam.xlsx', 'wf': 'wf-xlsx', 'status': 'needs_user_fix', 'qa': 0},
                'doc-gone': {'name': 'old.pdf', 'wf': 'wf-gone', 'status': 'completed', 'qa': 1,
                             'doc_status': 'deleted'},
            },
        },
        'proj-calls': {
            'name': 'Telecaller QA',
            'docs': {'doc-call': {'name': 'call.wav', 'wf': 'wf-call', 'status': 'completed', 'qa': 2}},
        },
        'proj-empty': {'name': 'Empty project', 'docs': {}},
    }


def run(world, **settings):
    return reindex.run(
        reindex.Settings(**settings), world, world, log=world.log.append, now=world.now, sleep=world.sleep
    )


def test_dry_run_changes_nothing():
    world = World(demo_projects(), model=NOVA, queue=[4])
    assert run(world) == 0
    actions = {e[1] for e in world.events}
    assert actions <= {'list_tables', 'count'}
    assert 'proj-rahul' in world.tables and world.commit
    text = '\n'.join(world.log)
    assert 'Dry run: nothing changed' in text
    assert 'would stop: the LanceDB service must embed with amazon.titan-embed-text-v2:0' in text
    assert 'would stop: the LanceDB write queue still holds 4 message(s)' in text
    assert 'proj-gone: 3 rows, no such project: left by a deleted project' in text
    assert 'skip (needs_user_fix): cam.xlsx' in text
    assert 'old.pdf' not in text  # deleted documents are left alone
    # Rahul's two re-analyzable documents each send the CRM webhook; its URL is never printed.
    assert (
        'CRM webhook on in 1 project(s): each completed re-analysis sends it, as an upload does (2 deliveries)'
    ) in text
    assert 'crm.example.invalid' not in text


def test_no_webhook_line_without_a_webhook():
    world = World(demo_projects(), webhooks=())
    assert run(world) == 0
    assert not any('CRM webhook' in line for line in world.log)


@pytest.mark.parametrize(
    'change, message',
    [
        ({'model': NOVA}, 'deploy the all-Mumbai build first'),
        ({'queue': [1]}, 'write queue still holds 1 message(s)'),
    ],
)
def test_apply_stops_before_any_change(change, message):
    world = World(demo_projects(), **change)
    assert run(world, apply=True) == 2
    assert not [e for e in world.events if e[1] in ('drop_table', 'doc-slip')]
    assert any(message in line for line in world.log)


def test_apply_stops_while_a_document_is_processing():
    projects = demo_projects()
    projects['proj-calls']['docs']['doc-call']['status'] = 'reanalyzing'
    world = World(projects)
    assert run(world, apply=True) == 2
    assert not [e for e in world.events if e[0] == 'reanalyze' or e[1] == 'drop_table']
    assert any('still processing (reanalyzing): Telecaller QA / call.wav' in line for line in world.log)


def test_apply_drops_everything_first_then_reindexes_and_checks():
    world = World(demo_projects(), fail={'doc-bank'})
    assert run(world, apply=True, max_in_flight=2, interval=15) == 1  # the bank statement fails again

    drops = [i for i, e in enumerate(world.events) if e[1] == 'drop_table']
    starts = [i for i, e in enumerate(world.events) if e[0] == 'reanalyze']
    assert max(drops) < min(starts)  # no Titan vector ever joins an old table
    dropped = {world.events[i][2]['project_id'] for i in drops}
    assert dropped == {'proj-rahul', 'proj-calls', 'proj-empty', 'proj-gone', 'graph_keywords',
                       'proj-rahul_datasets'}
    assert ('delete_commit_entries', 3) in world.events  # what the graph_keywords drop left
    assert not world.commit  # ... no commit entry of a dropped table is left
    # Canary first, alone; then the others. Deleted and needs_user_fix documents are skipped.
    reanalyzed = [world.events[i][1] for i in starts]
    assert reanalyzed == ['doc-slip', 'doc-bank', 'doc-call']
    assert world.events[starts[0]][2] == {'user_instructions': '', 'language': 'en'}
    assert world.max_running <= 2

    text = '\n'.join(world.log)
    # The search check probes a completed document (the failed one has no rows).
    assert (
        'FAIL  Rahul Deshmukh - Personal Loan: 1/2 documents completed, 3 LanceDB rows (expected 7), '
        'search finds salary_slip.pdf in the top 5'
    ) in text
    assert 'failed: bank_statement.pdf' in text
    assert (
        'PASS  Telecaller QA: 1/1 documents completed, 2 LanceDB rows (expected 2), '
        'search finds call.wav in the top 5'
    ) in text
    assert 'PASS  Empty project: 0/0 documents completed, 0 LanceDB rows (expected 0)' in text
    searches = [e[2] for e in world.events if e[1] == 'hybrid_search']
    assert len(searches) == 2
    assert all(len(s['query']) == reindex.PROBE_CHARS for s in searches)


def test_search_probe_is_the_text_without_markup_or_links():
    probe = reindex.search_probe(page_analysis('salary_slip.pdf'))
    assert probe.startswith('Page 1 page 1 A synthetic salary_slip.pdf of a made-up applicant. Net pay')
    assert 'http' not in probe and 'Signature' not in probe and '*' not in probe and '#' not in probe
    assert len(probe) == reindex.PROBE_CHARS
    assert reindex.search_probe('') == ''


def test_all_completed_passes():
    projects = demo_projects()
    projects['proj-rahul']['docs']['doc-bank']['status'] = 'completed'
    world = World(projects)
    assert run(world, apply=True) == 0
    assert world.tables == {'proj-rahul': 7, 'proj-calls': 2}
    assert 'no old vector left' in world.log[-1]


def test_a_failed_first_run_stops_before_the_others():
    world = World(demo_projects(), fail={'doc-slip'})
    assert run(world, apply=True) == 1
    assert [e[1] for e in world.events if e[0] == 'reanalyze'] == ['doc-slip']
    assert any('stopped before the others' in line for line in world.log)


def test_a_run_that_never_ends_counts_as_stuck():
    world = World(demo_projects(), hang={'doc-call'})
    assert run(world, apply=True, doc_timeout=120) == 1
    assert any('stuck     Telecaller QA / call.wav' in line for line in world.log)


def test_starts_are_paced():
    projects = demo_projects()
    projects['proj-calls']['docs'].update(
        {f'doc-{i}': {'name': f'page{i}.pdf', 'wf': f'wf-{i}', 'status': 'completed', 'qa': 1} for i in range(6)}
    )
    world = World(projects, run_ticks=5)
    starts = []
    post = world.post
    world.post = lambda path, body: (starts.append(world.t), post(path, body))[1]
    run(world, apply=True, max_in_flight=3, interval=30)
    assert world.max_running <= 3
    assert all(b - a >= 30 for a, b in zip(starts, starts[1:]))


def test_redact_hides_account_ids():
    assert reindex.redact('arn:aws:iam::123456789012:role/x') == 'arn:aws:iam::<account>:role/x'
