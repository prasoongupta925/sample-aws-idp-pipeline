"""Tests for the Step Functions trigger (index.py). No AWS calls.

get_workflow, update_workflow_status and the Step Functions client are fakes.
Step Functions keeps execution history for 90 days, so the execution input and
name must carry no file name, even when the queue message has one.

Run (from this folder): python -m pytest -q
"""

import importlib.util
import json
import os
import re
import sys

import pytest

os.environ.setdefault("BACKEND_TABLE_NAME", "test-table")
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-south-1")
os.environ.setdefault("AWS_REGION", "ap-south-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")

HERE = os.path.dirname(os.path.abspath(__file__))
FUNCTIONS = os.path.abspath(os.path.join(HERE, ".."))
if FUNCTIONS not in sys.path:
    sys.path.insert(0, FUNCTIONS)  # the shared layer: shared.ddb_client


def _load():
    spec = importlib.util.spec_from_file_location("step_function_trigger_index", os.path.join(HERE, "index.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


trigger = _load()

STATE_MACHINE_ARN = "arn:aws:states:ap-south-1:111111111111:stateMachine:idp-v2-document-analysis"
WORKFLOW_ID = "wf_AbCdEfGhIjKlMnOpQrStU"
DOC_ID = "3f2b8c1e-5d4a-4e6b-9c7d-1a2b3c4d5e6f"
FILE_URI = f"s3://doc-bucket/projects/proj_1/documents/{DOC_ID}/{DOC_ID}.pdf"
ORIGINAL_NAME = "Rahul_Deshmukh_salary_slip_aug.pdf"

# Workflow Queue message as type-detection sends it, here with an original name
MESSAGE = {
    "workflow_id": WORKFLOW_ID,
    "document_id": DOC_ID,
    "project_id": "proj_1",
    "file_uri": FILE_URI,
    "file_name": ORIGINAL_NAME,
    "file_type": "application/pdf",
    "language": "en",
    "processing_type": "document",
    "use_bda": False,
    "use_ocr": True,
    "use_transcribe": False,
    "ocr_model": "pp-ocrv5",
    "ocr_options": {"lang": "en"},
    "document_prompt": "",
}

INPUT_KEYS = {
    "workflow_id",
    "document_id",
    "project_id",
    "file_uri",
    "file_type",
    "processing_type",
    "language",
    "use_bda",
    "use_ocr",
    "use_transcribe",
    "ocr_model",
    "ocr_options",
    "document_prompt",
    "source_url",
    "crawl_instruction",
    "is_reanalysis",
    "triggered_at",
}


class FakeSfn:
    def __init__(self):
        self.calls = []

    def start_execution(self, **kwargs):
        self.calls.append(kwargs)
        return {"executionArn": f"arn:aws:states:ap-south-1:111111111111:execution:sm:{kwargs['name']}"}


@pytest.fixture
def env(monkeypatch):
    state = {"sfn": FakeSfn(), "updates": [], "workflow": {"data": {"status": "pending"}}}

    def fake_update(**kwargs):
        state["updates"].append(kwargs)

    monkeypatch.setattr(trigger, "STEP_FUNCTION_ARN", STATE_MACHINE_ARN)
    monkeypatch.setattr(trigger, "sfn_client", state["sfn"])
    monkeypatch.setattr(trigger, "get_workflow", lambda document_id, workflow_id, entity_type: state["workflow"])
    monkeypatch.setattr(trigger, "update_workflow_status", fake_update)
    return state


def _event(message):
    return {"Records": [{"body": json.dumps(message)}]}


def test_execution_input_and_name_carry_no_file_name(env):
    trigger.handler(_event(MESSAGE), None)

    (call,) = env["sfn"].calls
    assert call["stateMachineArn"] == STATE_MACHINE_ARN
    sfn_input = json.loads(call["input"])
    assert set(sfn_input) == INPUT_KEYS
    assert "file_name" not in sfn_input
    assert sfn_input["file_uri"] == FILE_URI
    assert sfn_input["is_reanalysis"] is False
    # Neither the name nor its stem anywhere in what Step Functions keeps
    sent = json.dumps(call)
    assert ORIGINAL_NAME not in sent
    assert "Rahul" not in sent
    assert re.fullmatch(rf"{WORKFLOW_ID[:16]}-\d{{14}}", call["name"])


def test_preprocessing_fields_are_passed_through(env):
    message = {
        **MESSAGE,
        "transcribe_options": {"language_mode": "auto"},
        "source_url": "https://example.com/rates",
        "crawl_instruction": "home loan rates",
    }

    trigger.handler(_event(message), None)

    sfn_input = json.loads(env["sfn"].calls[0]["input"])
    for key in INPUT_KEYS - {"is_reanalysis", "triggered_at"}:
        assert sfn_input[key] == message[key], key
    assert sfn_input["transcribe_options"] == {"language_mode": "auto"}


def test_execution_arn_is_recorded_on_the_workflow(env):
    result = trigger.handler(_event(MESSAGE), None)

    (update,) = env["updates"]
    assert update["document_id"] == DOC_ID
    assert update["workflow_id"] == WORKFLOW_ID
    assert update["status"] == "in_progress"
    assert update["entity_type"] == "DOC"
    assert update["execution_arn"].endswith(env["sfn"].calls[0]["name"])
    body = json.loads(result["body"])
    assert body["results"][0]["status"] == "started"
    assert ORIGINAL_NAME not in result["body"]


def test_unknown_workflow_starts_no_execution(env):
    env["workflow"] = None

    trigger.handler(_event(MESSAGE), None)

    assert env["sfn"].calls == []
    assert env["updates"] == []
