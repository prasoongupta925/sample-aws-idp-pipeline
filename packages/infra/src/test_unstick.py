"""deploy/lean/unstick.sh against a stub `aws` (stdlib + pytest only).

Run from the repo root:
    python -m pytest -q packages/infra/src/test_unstick.py

No AWS calls: the script runs with a stub `aws` executable first on PATH that
answers from a fixture and logs every call. The case of 2026-10-02: the sample
call of "Telecaller QA – Sample calls" stuck on "reanalyzing" because its
Re-analyze failed at the first state and the failure catcher could not
describe the execution.
"""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

INFRA_SRC = Path(__file__).resolve().parent
REPO = INFRA_SRC.parents[2]
SCRIPT = REPO / 'deploy' / 'lean' / 'unstick.sh'
BASH = shutil.which('bash')

pytestmark = pytest.mark.skipif(
    BASH is None or shutil.which('jq') is None, reason='bash and jq are required'
)

ACCOUNT = '111111111111'
SM = f'arn:aws:states:ap-south-1:{ACCOUNT}:execution:idp-v2-document-analysis'
QA_PROJECT = 'Telecaller QA – Sample calls'

# Stub `aws`: answers from $UNSTICK_FIXTURE, logs each call (JSON args) to $STUB_LOG.
AWS_STUB = r"""#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['STUB_LOG'], 'a') as log:
    log.write(json.dumps(args) + '\n')
fixture = json.load(open(os.environ['UNSTICK_FIXTURE']))
def opt(name):
    return args[args.index(name) + 1] if name in args else None
call = (args[0], args[1])
if call == ('ssm', 'get-parameter'):
    print(fixture['table'])
elif call == ('dynamodb', 'query'):
    print(json.dumps({'Items': fixture['projects']}))
elif call == ('dynamodb', 'scan'):
    print(json.dumps({'Items': fixture['workflows']}))
elif call == ('dynamodb', 'get-item'):
    key = json.loads(opt('--key'))
    item = fixture['items'].get(key['PK']['S'] + '|' + key['SK']['S'])
    print(json.dumps({'Item': item} if item else {}))
elif call == ('stepfunctions', 'describe-execution'):
    execution = fixture['executions'].get(opt('--execution-arn'))
    if execution is None:
        sys.stderr.write('An error occurred (ExecutionDoesNotExist) when calling the '
                         'DescribeExecution operation: Execution Does Not Exist\n')
        sys.exit(254)
    print(json.dumps(execution))
elif call == ('dynamodb', 'update-item'):
    key = json.loads(opt('--key'))
    if key['PK']['S'] + '|' + key['SK']['S'] in fixture.get('failing_updates', []):
        sys.stderr.write('An error occurred (ConditionalCheckFailedException)\n')
        sys.exit(254)
else:
    sys.stderr.write('unexpected call: ' + ' '.join(args) + '\n')
    sys.exit(1)
"""


def _s(value):
    return {'S': value}


def _project(project_id, name):
    return {
        'PK': _s(f'PROJ#{project_id}'),
        'SK': _s('META'),
        'data': {'M': {'project_id': _s(project_id), 'name': _s(name)}},
    }


def _workflow(document_id, workflow_id, status, execution, project_id, updated='2026-10-01T15:00:00+00:00'):
    data = {'status': _s(status), 'project_id': _s(project_id)}
    data['execution_arn'] = _s(f'{SM}:{execution}' if execution else '')
    return {
        'PK': _s(f'DOC#{document_id}'),
        'SK': _s(f'WF#{workflow_id}'),
        'data': {'M': data},
        'updated_at': _s(updated),
    }


def _document(project_id, document_id, name):
    return {
        f'PROJ#{project_id}|DOC#{document_id}': {
            'data': {'M': {'name': _s(name), 'status': _s('reanalyzing')}}
        }
    }


def _steps(workflow_id, **statuses):
    return {
        f'WF#{workflow_id}|STEP': {
            'data': {
                'M': {
                    'current_step': _s(next(iter(statuses), '')),
                    **{name: {'M': {'status': _s(status)}} for name, status in statuses.items()},
                }
            }
        }
    }


def _fixture():
    return {
        'table': 'idp-v2-backend-table',
        'projects': [
            _project('proj_qa', QA_PROJECT),
            _project('proj_files', 'Home loan files'),
        ],
        'workflows': [
            # The sample call: Re-analyze failed at IsDataset (States.Runtime).
            _workflow('doc-call', 'wf_call', 'reanalyzing', 'reanalyze-wf_call-20261001150000', 'proj_qa'),
            # A run that is really going.
            _workflow('doc-live', 'wf_live', 'in_progress', 'wf_live-20261002100000', 'proj_qa'),
            # The record disagrees with an execution that finished well.
            _workflow('doc-done', 'wf_done', 'in_progress', 'wf_done-20261001100000', 'proj_qa'),
            # Another project: an execution older than the 90-day history.
            _workflow('doc-old', 'wf_old', 'in_progress', 'wf_old-20260601100000', 'proj_files'),
            # Never started (no ARN), long ago and just now.
            _workflow('doc-never', 'wf_never', 'pending', '', 'proj_files'),
            _workflow('doc-new', 'wf_new', 'pending', '', 'proj_files', updated='2999-01-01T00:00:00+00:00'),
            # Final statuses are never looked at.
            _workflow('doc-ok', 'wf_ok', 'completed', 'wf_ok-20261001090000', 'proj_qa'),
        ],
        'items': {
            **_document('proj_qa', 'doc-call', 'sample_call_hinglish.wav'),
            **_document('proj_qa', 'doc-live', 'call_2.wav'),
            **_document('proj_qa', 'doc-done', 'call_3.wav'),
            **_document('proj_files', 'doc-old', 'salary_slip.pdf'),
            **_document('proj_files', 'doc-never', 'pan.pdf'),
            **_steps('wf_call', transcribe='completed'),
            **_steps('wf_old', segment_analyzer='in_progress', document_summarizer='pending'),
            **_steps('wf_never'),
        },
        'executions': {
            f'{SM}:reanalyze-wf_call-20261001150000': {
                'status': 'FAILED',
                'error': 'States.Runtime',
                'cause': "An error occurred while executing the state 'IsDataset'. Invalid path '$.processing_type'",
            },
            f'{SM}:wf_live-20261002100000': {'status': 'RUNNING'},
            f'{SM}:wf_done-20261001100000': {'status': 'SUCCEEDED'},
        },
    }


@pytest.fixture
def run(tmp_path):
    bin_dir = tmp_path / 'bin'
    bin_dir.mkdir()
    stub = bin_dir / 'aws'
    stub.write_text(AWS_STUB)
    stub.chmod(0o755)
    log = tmp_path / 'aws.log'
    fixture_path = tmp_path / 'fixture.json'

    def _run(*args, fixture=None):
        fixture_path.write_text(json.dumps(fixture or _fixture()))
        log.write_text('')
        env = {
            **os.environ,
            'PATH': f'{bin_dir}{os.pathsep}{os.environ["PATH"]}',
            'STUB_LOG': str(log),
            'UNSTICK_FIXTURE': str(fixture_path),
            'AWS_CONFIG_FILE': os.devnull,
            'AWS_SHARED_CREDENTIALS_FILE': os.devnull,
        }
        result = subprocess.run(
            [BASH, str(SCRIPT), *args], env=env, capture_output=True, text=True, timeout=120
        )
        calls = [json.loads(line) for line in log.read_text().splitlines() if line]
        return result, calls

    return _run


def _updates(calls):
    def opt(call, name):
        return call[call.index(name) + 1] if name in call else None

    return [
        {
            'key': json.loads(opt(call, '--key')),
            'update': opt(call, '--update-expression'),
            'condition': opt(call, '--condition-expression'),
            'names': json.loads(opt(call, '--expression-attribute-names') or '{}'),
            'values': json.loads(opt(call, '--expression-attribute-values') or '{}'),
        }
        for call in calls
        if call[:2] == ['dynamodb', 'update-item']
    ]


def _line(stdout, document_id):
    return next(line for line in stdout.splitlines() if f'document {document_id}' in line)


def test_dry_run_lists_what_is_stuck_and_writes_nothing(run):
    result, calls = run()

    assert result.returncode == 0, result.stderr
    out = result.stdout
    call = _line(out, 'doc-call')
    assert call.startswith('stuck ')
    assert f'{QA_PROJECT} / sample_call_hinglish.wav' in call
    assert 'reanalyzing' in call and 'FAILED' in call and 'States.Runtime' in call
    assert _line(out, 'doc-live').startswith('skip ')
    assert 'still running' in _line(out, 'doc-live')
    assert _line(out, 'doc-done').startswith('check ')
    assert _line(out, 'doc-old').startswith('stuck ')
    assert 'no longer exists' in _line(out, 'doc-old')
    assert _line(out, 'doc-never').startswith('stuck ')
    assert 'no execution was ever recorded' in _line(out, 'doc-never')
    assert _line(out, 'doc-new').startswith('skip ')
    assert 'doc-ok' not in out
    assert 'dry run: 3 stuck workflow(s) of 6 still marked running' in out
    assert _updates(calls) == []
    # Neither the account id (in every execution ARN) nor the table name.
    assert ACCOUNT not in out + result.stderr
    assert 'idp-v2-backend-table' not in out


def test_apply_fails_the_workflow_its_document_and_running_steps(run):
    result, calls = run('--project', QA_PROJECT, '--apply')

    assert result.returncode == 0, result.stderr
    assert _line(result.stdout, 'doc-call').startswith('reset ')
    assert '1 of 1 stuck workflow(s) reset to failed' in result.stdout
    updates = _updates(calls)
    workflow, document = updates  # wf_call has no running step
    assert workflow['key'] == {'PK': _s('DOC#doc-call'), 'SK': _s('WF#wf_call')}
    assert workflow['update'] == 'SET #d.#s = :failed, #d.#e = :err, updated_at = :now'
    # Only while it still has the status and execution this run read.
    assert workflow['condition'] == '#d.#s = :old AND (attribute_not_exists(#d.#x) OR #d.#x = :arn)'
    assert workflow['values'][':old'] == _s('reanalyzing')
    assert workflow['values'][':arn'] == _s(f'{SM}:reanalyze-wf_call-20261001150000')
    assert workflow['values'][':failed'] == _s('failed')
    assert workflow['values'][':err']['S'].startswith('Reset by deploy/lean/unstick.sh: execution reanalyze-wf_call-')
    assert document['key'] == {'PK': _s('PROJ#proj_qa'), 'SK': _s('DOC#doc-call')}
    assert document['update'] == 'SET #d.#s = :failed, updated_at = :now'
    assert document['condition'] == 'attribute_exists(PK)'
    assert ACCOUNT not in result.stdout


def test_apply_fails_a_running_step_and_frees_the_analysis_throttle(run):
    result, calls = run('--project', 'proj_files', '--apply')

    assert result.returncode == 0, result.stderr
    updates = _updates(calls)
    steps = [u for u in updates if u['key'] == {'PK': _s('WF#wf_old'), 'SK': _s('STEP')}]
    (step,) = steps
    assert step['names']['#step'] == 'segment_analyzer'
    assert step['update'].endswith(', GSI1SK = :failed')
    assert step['condition'] == '#d.#step.#s = :running'
    # pan.pdf never started: workflow + document, no step was running.
    assert {u['key']['PK']['S'] for u in updates} == {'DOC#doc-old', 'PROJ#proj_files', 'WF#wf_old', 'DOC#doc-never'}
    assert '2 of 2 stuck workflow(s) reset to failed' in result.stdout
    assert _line(result.stdout, 'doc-old').endswith('; steps failed: segment_analyzer)')
    assert 'steps failed' not in _line(result.stdout, 'doc-never')


def test_a_step_that_changed_meanwhile_is_left_alone_and_not_reported(run):
    fixture = _fixture()
    fixture['failing_updates'] = ['WF#wf_old|STEP']

    result, calls = run('--project', 'proj_files', '--apply', fixture=fixture)

    assert result.returncode == 0, result.stderr
    out = result.stdout
    assert 'step segment_analyzer changed since it was read: left alone' in out
    reset = next(line for line in out.splitlines() if line.startswith('reset ') and 'document doc-old' in line)
    # The workflow and document are failed; the refused step is not listed as failed.
    assert 'steps failed' not in reset
    assert '2 of 2 stuck workflow(s) reset to failed' in out


def test_a_record_that_changed_meanwhile_is_left_alone(run):
    fixture = _fixture()
    fixture['failing_updates'] = ['DOC#doc-call|WF#wf_call']

    result, calls = run('--project', QA_PROJECT, '--apply', fixture=fixture)

    assert result.returncode == 0, result.stderr
    assert 'changed since it was read' in _line(result.stdout, 'doc-call')
    # No document or step write after the refused workflow write.
    assert len(_updates(calls)) == 1
    assert '0 of 1 stuck workflow(s) reset' in result.stdout


def test_one_document_only(run):
    result, _ = run('--document', 'doc-never')

    assert result.returncode == 0, result.stderr
    assert 'document doc-never' in result.stdout
    assert 'doc-call' not in result.stdout
    assert 'dry run: 1 stuck workflow(s) of 1' in result.stdout


def test_unknown_project_is_an_error(run):
    result, calls = run('--project', 'No such project')

    assert result.returncode == 1
    assert 'no project with the name or id "No such project"' in result.stdout
    assert all(call[:2] != ['dynamodb', 'scan'] for call in calls)


def test_bad_options_are_refused(run):
    assert run('--min-age', 'soon')[0].returncode == 2
    assert run('--frobnicate')[0].returncode == 2
