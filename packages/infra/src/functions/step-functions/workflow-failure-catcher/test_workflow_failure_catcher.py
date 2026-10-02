"""Tests for the workflow failure catcher (index.py). No AWS calls.

The DynamoDB helpers and the Step Functions client are fakes. The catcher must
fail the workflow, its document and its running steps when an execution fails
where no Catch can run (the Re-analyze bug: States.Runtime at the first
Choice), and must leave a newer run alone.

Run (from this folder): python -m pytest -q
"""

import importlib.util
import json
import os
import sys

import pytest

os.environ.setdefault("BACKEND_TABLE_NAME", "test-table")
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-south-1")
os.environ.setdefault("AWS_REGION", "ap-south-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")

HERE = os.path.dirname(os.path.abspath(__file__))
FUNCTIONS = os.path.abspath(os.path.join(HERE, "..", ".."))
if FUNCTIONS not in sys.path:
    sys.path.insert(0, FUNCTIONS)  # the shared layer: shared.ddb_client


def _load():
    spec = importlib.util.spec_from_file_location("workflow_failure_catcher_index", os.path.join(HERE, "index.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


catcher = _load()

STATE_MACHINE_ARN = "arn:aws:states:ap-south-1:111111111111:stateMachine:idp-v2-document-analysis"
EXECUTION = "arn:aws:states:ap-south-1:111111111111:execution:idp-v2-document-analysis:reanalyze-wf_AbCdEfGhIjKlM-20261002101500"
OLD_EXECUTION = "arn:aws:states:ap-south-1:111111111111:execution:idp-v2-document-analysis:wf_AbCdEfGhIjKlM-20261001090000"
NEWER_EXECUTION = "arn:aws:states:ap-south-1:111111111111:execution:idp-v2-document-analysis:reanalyze-wf_AbCdEfGhIjKlM-20261002101900"
WORKFLOW_ID = "wf_AbCdEfGhIjKlMnOpQrStU"
DOC_ID = "3f2b8c1e-5d4a-4e6b-9c7d-1a2b3c4d5e6f"
PROJECT_ID = "proj_telecaller_qa"

# Re-analysis input as the backend sends it (no file name), before the fix:
# without processing_type, so the IsDataset Choice failed with States.Runtime.
REANALYSIS_INPUT = {
    "workflow_id": WORKFLOW_ID,
    "document_id": DOC_ID,
    "project_id": PROJECT_ID,
    "file_uri": f"s3://doc-bucket/projects/{PROJECT_ID}/documents/{DOC_ID}/{DOC_ID}.wav",
    "file_type": "audio/wav",
    "is_reanalysis": True,
    "user_instructions": "",
    "language": "en",
}
RUNTIME_ERROR = "States.Runtime"
RUNTIME_CAUSE = (
    "An error occurred while executing the state 'IsDataset' (entered at the event id #2). "
    "Invalid path '$.processing_type': The choice state's condition path references an invalid value."
)


def _event(status="FAILED", sfn_input=REANALYSIS_INPUT, include_input=True, execution_arn=EXECUTION):
    detail = {
        "executionArn": execution_arn,
        "stateMachineArn": STATE_MACHINE_ARN,
        "name": execution_arn.rsplit(":", 1)[-1],
        "status": status,
        "startDate": 1790298000000,
        "stopDate": 1790298000100,
        "input": json.dumps(sfn_input) if include_input else None,
        "inputDetails": {"included": include_input},
    }
    if status == "FAILED":
        detail["error"] = RUNTIME_ERROR
        detail["cause"] = RUNTIME_CAUSE
    return {
        "version": "0",
        "detail-type": "Step Functions Execution Status Change",
        "source": "aws.states",
        "region": "ap-south-1",
        "resources": [execution_arn],
        "detail": detail,
    }


class FakeSfn:
    def __init__(self, sfn_input=REANALYSIS_INPUT, error=None):
        self.calls = []
        self.sfn_input = sfn_input
        self.error = error

    def describe_execution(self, executionArn):
        self.calls.append(executionArn)
        if self.error:
            raise self.error
        return {"executionArn": executionArn, "status": "FAILED", "input": json.dumps(self.sfn_input)}


def _record(status="reanalyzing", execution_arn=EXECUTION, project_id=PROJECT_ID):
    data = {
        "file_uri": REANALYSIS_INPUT["file_uri"],
        "file_type": "audio/wav",
        "execution_arn": execution_arn,
        "status": status,
    }
    if project_id:
        data["project_id"] = project_id
    return {"PK": f"DOC#{DOC_ID}", "SK": f"WF#{WORKFLOW_ID}", "data": data}


@pytest.fixture
def env(monkeypatch):
    state = {
        "sfn": FakeSfn(),
        # Each read of the workflow record pops the next one (the last one stays).
        "records": [_record()],
        "reads": [],
        "workflow_updates": [],
        "document_updates": [],
        "steps": {"data": {"segment_analyzer": {"status": "completed"}, "transcribe": {"status": "completed"}}},
        "step_errors": [],
    }

    def get_workflow(document_id, workflow_id, entity_type):
        state["reads"].append((document_id, workflow_id, entity_type))
        records = state["records"]
        return records.pop(0) if len(records) > 1 else records[0]

    monkeypatch.setattr(catcher, "sfn_client", state["sfn"])
    monkeypatch.setattr(catcher, "RECORD_READ_INTERVAL_SECONDS", 0)
    monkeypatch.setattr(catcher, "get_workflow", get_workflow)
    monkeypatch.setattr(
        catcher,
        "update_workflow_status",
        lambda document_id, workflow_id, status, entity_type, **kwargs: state["workflow_updates"].append(
            {"document_id": document_id, "workflow_id": workflow_id, "status": status, "entity_type": entity_type, **kwargs}
        ),
    )
    monkeypatch.setattr(
        catcher,
        "update_document_status",
        lambda project_id, document_id, status: state["document_updates"].append((project_id, document_id, status)),
    )
    monkeypatch.setattr(catcher, "get_steps", lambda workflow_id: state["steps"])
    monkeypatch.setattr(
        catcher,
        "record_step_error",
        lambda workflow_id, step_name, error: state["step_errors"].append((workflow_id, step_name, error)),
    )
    return state


def test_reanalysis_that_failed_at_the_first_state_is_set_to_failed(env):
    # The live bug: Re-analyze started without processing_type; the IsDataset
    # Choice failed with States.Runtime, which no Catch handles.
    result = catcher.handler(_event(), None)

    assert result["handled"] is True
    (update,) = env["workflow_updates"]
    assert update["document_id"] == DOC_ID
    assert update["workflow_id"] == WORKFLOW_ID
    assert update["status"] == "failed"
    assert update["entity_type"] == "DOC"
    assert update["error"] == f"{RUNTIME_ERROR}: {RUNTIME_CAUSE}"
    # The input came with the event: no DescribeExecution call.
    assert env["sfn"].calls == []
    # update_workflow_status sets the document status itself (the record has
    # its project id), so no second document write.
    assert env["document_updates"] == []
    assert len(env["reads"]) == 1


def test_input_left_out_of_the_event_is_read_from_the_execution(env):
    result = catcher.handler(_event(include_input=False), None)

    assert result["handled"] is True
    assert env["sfn"].calls == [EXECUTION]
    assert env["workflow_updates"][0]["status"] == "failed"


def test_a_describe_error_is_raised_so_the_invoke_is_retried(env):
    env["sfn"].error = RuntimeError("AccessDeniedException")

    with pytest.raises(RuntimeError):
        catcher.handler(_event(include_input=False), None)
    assert env["workflow_updates"] == []


def test_running_steps_are_set_to_failed(env):
    env["steps"] = {
        "data": {
            "current_step": "segment_analyzer",
            "transcribe": {"status": "completed"},
            "segment_analyzer": {"status": "in_progress"},
            "document_summarizer": {"status": "pending"},
            "dataset_process": {"status": "skipped"},
        }
    }

    result = catcher.handler(_event(), None)

    # The segment analyzer's step error also frees the analysis throttle (GSI1SK).
    assert env["step_errors"] == [(WORKFLOW_ID, "segment_analyzer", f"{RUNTIME_ERROR}: {RUNTIME_CAUSE}")]
    assert result["failed_steps"] == ["segment_analyzer"]


def test_a_record_that_names_the_run_only_after_a_moment_is_still_failed(env):
    # The backend records the execution ARN right after StartExecution; the
    # failure can be reported before that write lands.
    env["records"] = [_record(status="completed", execution_arn=OLD_EXECUTION), _record()]

    result = catcher.handler(_event(), None)

    assert result["handled"] is True
    assert len(env["reads"]) == 2
    assert env["workflow_updates"][0]["status"] == "failed"


def test_an_old_execution_does_not_fail_a_newer_run(env):
    env["records"] = [_record(status="reanalyzing", execution_arn=NEWER_EXECUTION)]

    result = catcher.handler(_event(), None)

    assert result == {"handled": False, "workflow_id": WORKFLOW_ID, "reason": "other_execution"}
    assert len(env["reads"]) == catcher.RECORD_READS
    assert env["workflow_updates"] == []
    assert env["step_errors"] == []


def test_a_first_run_whose_arn_was_never_recorded_is_failed(env):
    env["records"] = [_record(status="pending", execution_arn="")]

    result = catcher.handler(_event(sfn_input={**REANALYSIS_INPUT, "is_reanalysis": False}), None)

    assert result["handled"] is True
    assert len(env["reads"]) == catcher.RECORD_READS
    assert env["workflow_updates"][0]["status"] == "failed"


def test_a_failure_already_recorded_by_the_error_handler_is_kept(env):
    env["records"] = [_record(status="failed")]

    result = catcher.handler(_event(), None)

    assert result["reason"] == "already_failed"
    assert env["workflow_updates"] == []


def test_a_deleted_workflow_is_left_alone(env):
    env["records"] = [None]

    result = catcher.handler(_event(), None)

    assert result["reason"] == "no_workflow"
    assert env["workflow_updates"] == []
    assert env["document_updates"] == []


def test_the_document_is_failed_too_when_the_record_lacks_the_project(env):
    env["records"] = [_record(project_id="")]

    catcher.handler(_event(), None)

    assert env["document_updates"] == [(PROJECT_ID, DOC_ID, "failed")]


@pytest.mark.parametrize("status", ["TIMED_OUT", "ABORTED"])
def test_timeouts_and_stops_are_failures_too(env, status):
    catcher.handler(_event(status=status), None)

    assert env["workflow_updates"][0]["error"] == f"Step Functions execution {status}: {EXECUTION}"


def test_web_documents_use_their_own_entity(env):
    web_input = {**REANALYSIS_INPUT, "file_type": "application/x-webreq"}

    catcher.handler(_event(sfn_input=web_input), None)

    assert env["reads"][0][2] == "WEB"
    assert env["workflow_updates"][0]["entity_type"] == "WEB"


@pytest.mark.parametrize(
    "sfn_input",
    [{}, {"workflow_id": WORKFLOW_ID}, {"document_id": DOC_ID}],
)
def test_input_without_ids_is_ignored(env, sfn_input):
    assert catcher.handler(_event(sfn_input=sfn_input), None) == {"handled": False}
    assert env["reads"] == []


def test_event_without_execution_arn_is_ignored(env):
    assert catcher.handler({"detail": {"status": "FAILED"}}, None) == {"handled": False}
