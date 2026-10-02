"""Bedrock Data Automation off (the all-Mumbai build): bda-start skips the step
and bda-check reports a skipped start without calling BDA. BDA runs only
through a geographic cross-Region profile, so ap-south-1 (region config
bdaEnabled false) never starts a job. No AWS calls: the DynamoDB helpers and
the BDA clients are fakes; synthetic data only.

Run from the repo root:
    uv run --with pytest python -m pytest -q packages/infra/src/test_bda_off.py
"""

import importlib.util
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


def _load(name: str, folder: str):
    spec = importlib.util.spec_from_file_location(name, FUNCTIONS / 'preprocessing' / folder / 'index.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bda_start = _load('bda_start_index', 'bda-start')
bda_check = _load('bda_check_index', 'bda-check')

EVENT = {
    'workflow_id': 'wf_demo0001',
    'document_id': 'doc_demo0001',
    'project_id': 'proj_demo',
    'file_uri': 's3://demo-bucket/projects/proj_demo/documents/doc_demo0001/doc_demo0001.pdf',
    'file_type': 'application/pdf',
    'use_bda': True,
}


class NoBda:
    """A BDA client that fails the test when called."""

    def __getattr__(self, name):
        raise AssertionError(f'BDA was called ({name}) although it is off')


@pytest.fixture
def recorded(monkeypatch):
    calls = []
    monkeypatch.setattr(bda_start, 'update_preprocess_status', lambda **kw: calls.append(('preprocess', kw)))
    monkeypatch.setattr(bda_start, 'record_step_skipped', lambda *a: calls.append(('skipped', a)))
    monkeypatch.setattr(bda_start, 'record_step_start', lambda *a: calls.append(('start', a)))
    monkeypatch.setattr(bda_start, 'get_bda_client', NoBda)
    monkeypatch.setattr(bda_start, 'get_bda_runtime_client', NoBda)
    monkeypatch.setattr(bda_check, 'get_bda_runtime_client', NoBda)
    return calls


@pytest.mark.parametrize('value', ['false', 'False', ' false '])
def test_start_skips_when_bda_is_off(monkeypatch, recorded, value):
    monkeypatch.setenv('BDA_ENABLED', value)

    out = bda_start.handler(dict(EVENT), None)

    assert out['bda_status'] == 'SKIPPED'
    assert 'bda_invocation_arn' not in out
    (preprocess, skipped) = recorded
    assert preprocess[1]['status'] == bda_start.PreprocessStatus.SKIPPED
    assert 'cross-Region' in preprocess[1]['reason']
    assert skipped[1] == ('wf_demo0001', bda_start.StepName.BDA_PROCESSOR, bda_start.BDA_DISABLED_REASON)


@pytest.mark.parametrize('value', [None, 'true'])
def test_start_tries_bda_where_it_is_on(monkeypatch, recorded, value):
    if value is None:
        monkeypatch.delenv('BDA_ENABLED', raising=False)
    else:
        monkeypatch.setenv('BDA_ENABLED', value)

    # The fake client refuses: BDA would have been called.
    with pytest.raises(AssertionError, match='BDA was called'):
        bda_start.handler(dict(EVENT), None)
    assert recorded[0][0] == 'start'


def test_check_reports_a_skipped_start_without_calling_bda(recorded):
    # The state machine always runs WaitForBda -> CheckBda after StartBda.
    event = {**EVENT, 'bda_status': 'SKIPPED'}
    assert bda_check.handler(event, None)['bda_status'] == 'SKIPPED'
    # An unsupported file type is skipped the same way (no invocation ARN).
    assert bda_check.handler(dict(EVENT), None)['bda_status'] == 'SKIPPED'
