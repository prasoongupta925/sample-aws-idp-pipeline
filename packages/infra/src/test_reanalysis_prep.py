"""Re-analyze removes the workflow's old search-index rows first (reanalysis-prep).

The LanceDB service's delete_record needs a segment index, so the old call
never deleted anything and a Re-analyze left the old rows next to the new ones.
reanalysis-prep now calls delete_by_workflow (as the backend's document delete
does) and stops, before any analysis is cleared, when that delete fails. No AWS
calls: the Lambda client, DynamoDB and S3 helpers are fakes; synthetic data only.

Run from the repo root:
    uv run --with pytest python -m pytest -q packages/infra/src/test_reanalysis_prep.py
"""

import importlib.util
import io
import json
import os
import sys
from pathlib import Path

import pytest

os.environ.setdefault('BACKEND_TABLE_NAME', 'test-table')
os.environ.setdefault('AWS_DEFAULT_REGION', 'ap-south-1')
os.environ.setdefault('AWS_REGION', 'ap-south-1')
os.environ.setdefault('AWS_ACCESS_KEY_ID', 'testing')
os.environ.setdefault('AWS_SECRET_ACCESS_KEY', 'testing')

FUNCTIONS = Path(__file__).resolve().parent / 'functions'
if str(FUNCTIONS) not in sys.path:
    sys.path.insert(0, str(FUNCTIONS))  # the shared layer: shared.ddb_client

SPEC = importlib.util.spec_from_file_location(
    'reanalysis_prep_index', FUNCTIONS / 'step-functions' / 'reanalysis-prep' / 'index.py'
)
prep = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prep)

EVENT = {
    'workflow_id': 'wf_demo0001',
    'document_id': 'doc_demo0001',
    'project_id': 'proj_demo',
    'file_uri': 's3://demo-bucket/projects/proj_demo/documents/doc_demo0001/doc_demo0001.pdf',
    'file_type': 'application/pdf',
    'is_reanalysis': True,
    'language': 'en',
}


class FakeLambda:
    """The LanceDB service: answers like the Rust service ({statusCode, ...})."""

    def __init__(self, answer=None, function_error=None):
        self.answer = answer if answer is not None else {'statusCode': 200, 'success': True}
        self.function_error = function_error
        self.calls = []

    def invoke(self, **kwargs):
        self.calls.append(json.loads(kwargs['Payload']))
        response = {'Payload': io.BytesIO(json.dumps(self.answer).encode('utf-8')), 'StatusCode': 200}
        if self.function_error:
            response['FunctionError'] = self.function_error
        return response


@pytest.fixture
def world(monkeypatch):
    events = []
    monkeypatch.setattr(prep, '_reset_analysis_steps', lambda wf: events.append(('reset', wf)))
    monkeypatch.setattr(prep, 'update_workflow_status', lambda *a, **kw: events.append(('status', a[2], kw)))
    monkeypatch.setattr(prep, 'record_step_start', lambda *a: events.append(('step_start', a)))
    monkeypatch.setattr(prep, 'record_step_complete', lambda *a, **kw: events.append(('step_done', a)))
    monkeypatch.setattr(prep, 'record_step_error', lambda *a: events.append(('step_error', a)))
    monkeypatch.setattr(prep, 'get_segment_count_from_s3', lambda uri: 2)
    monkeypatch.setattr(prep, 'clear_segment_ai_analysis', lambda uri, i: events.append(('clear', i)))
    monkeypatch.setattr(prep, 'save_reanalysis_instructions', lambda uri, i, text: events.append(('instr', i)))
    monkeypatch.setattr(prep, 'GRAPH_SERVICE_FUNCTION_NAME', '')  # the lean build: no graph
    return events


def test_deletes_the_workflows_rows_with_delete_by_workflow(monkeypatch, world):
    lam = FakeLambda()
    monkeypatch.setattr(prep, '_lambda_client', lam)

    out = prep.handler(dict(EVENT), None)

    assert lam.calls == [
        {'action': 'delete_by_workflow', 'params': {'project_id': 'proj_demo', 'workflow_id': 'wf_demo0001'}}
    ]
    assert out['segment_ids'] == [0, 1] and out['is_reanalysis'] is True
    assert ('clear', 0) in world and ('clear', 1) in world


@pytest.mark.parametrize(
    'lam',
    [
        FakeLambda({'statusCode': 500, 'success': False, 'error': 'lance error'}),
        # A payload the service cannot parse (the old delete_record call).
        FakeLambda({'errorType': 'Runtime.Error', 'errorMessage': 'missing field segment_index'}, 'Unhandled'),
    ],
)
def test_a_failed_delete_stops_before_any_analysis_is_cleared(monkeypatch, world, lam):
    monkeypatch.setattr(prep, '_lambda_client', lam)

    with pytest.raises(RuntimeError, match='delete_by_workflow failed'):
        prep.handler(dict(EVENT), None)

    assert not [e for e in world if e[0] == 'clear']
    assert ('step_error', ('wf_demo0001', prep.StepName.SEGMENT_BUILDER, 'LanceDB delete_by_workflow failed (statusCode=500)')) in world
    assert [e for e in world if e[0] == 'status'][-1][1] == prep.WorkflowStatus.FAILED
