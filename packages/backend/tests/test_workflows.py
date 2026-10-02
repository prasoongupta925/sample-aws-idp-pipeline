import importlib.util
import json
import re
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.config import get_config
from app.ddb.models import Workflow, WorkflowData
from app.main import app
from app.routers.workflows import _processing_type

client = TestClient(app)

STATE_MACHINE_ARN = "arn:aws:states:ap-south-1:111111111111:stateMachine:idp-v2-document-analysis"


class TestListWorkflows:
    @patch("app.routers.workflows.get_document_item")
    @patch("app.ddb.workflows.get_table")
    def test_list_workflows_success(self, mock_get_table, mock_get_document_item):
        mock_table = MagicMock()
        # query_workflows now queries both DOC and WEB entities
        mock_table.query.side_effect = [
            {
                "Items": [
                    {
                        "PK": "DOC#doc-1",
                        "SK": "WF#wf-1",
                        "data": {
                            "execution_arn": "arn:aws:states:us-east-1:123456789012:execution:test:wf-1",
                            "file_name": "test.pdf",
                            "file_type": "application/pdf",
                            "file_uri": "s3://bucket/test.pdf",
                            "project_id": "proj-1",
                            "status": "completed",
                            "summary": "Test summary",
                            "total_segments": 3,
                        },
                        "created_at": "2024-01-01T00:00:00+00:00",
                        "updated_at": "2024-01-01T01:00:00+00:00",
                    },
                ]
            },
            {"Items": []},  # WEB query returns empty
        ]
        mock_get_table.return_value = mock_table
        mock_get_document_item.return_value = None

        response = client.get("/documents/doc-1/workflows")

        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["workflow_id"] == "wf-1"
        assert data[0]["status"] == "completed"
        assert data[0]["file_name"] == "test.pdf"
        assert data[0]["file_uri"] == "s3://bucket/test.pdf"
        assert data[0]["created_at"] == "2024-01-01T00:00:00+00:00"
        assert data[0]["updated_at"] == "2024-01-01T01:00:00+00:00"

    @patch("app.routers.workflows.get_document_item")
    @patch("app.ddb.workflows.get_table")
    def test_list_workflows_empty(self, mock_get_table, mock_get_document_item):
        mock_table = MagicMock()
        # query_workflows now queries both DOC and WEB entities
        mock_table.query.side_effect = [{"Items": []}, {"Items": []}]
        mock_get_table.return_value = mock_table
        mock_get_document_item.return_value = None

        response = client.get("/documents/doc-1/workflows")

        assert response.status_code == 200
        assert response.json() == []


def _workflow(file_type="application/pdf", ext="pdf", file_name=None):
    uri = f"s3://bucket/projects/proj-1/documents/doc-1/doc-1.{ext}"
    return Workflow(
        PK="DOC#doc-1",
        SK="WF#wf_AbCdEfGhIjKlMnOpQr",
        data=WorkflowData(
            execution_arn="",
            file_name=file_name or f"doc-1.{ext}",
            file_type=file_type,
            file_uri=uri,
            project_id="proj-1",
            status="completed",
        ),
        created_at="2026-10-01T00:00:00+00:00",
        updated_at="2026-10-01T01:00:00+00:00",
    )


class TestReanalyzeWorkflow:
    """Step Functions keeps execution history for 90 days: the re-analysis
    execution input and name carry no file name."""

    @pytest.fixture
    def sfn(self, monkeypatch):
        monkeypatch.setattr(get_config(), "step_function_arn", STATE_MACHINE_ARN)
        sfn_client = MagicMock()
        sfn_client.start_execution.side_effect = lambda **kwargs: {
            "executionArn": f"arn:aws:states:ap-south-1:111111111111:execution:sm:{kwargs['name']}"
        }
        with (
            patch("app.routers.workflows.boto3.client", return_value=sfn_client),
            patch("app.routers.workflows.update_workflow_status") as update_workflow,
            patch("app.routers.workflows.update_document_status") as update_document,
        ):
            yield {"client": sfn_client, "update_workflow": update_workflow, "update_document": update_document}

    def _reanalyze(self, workflow):
        with patch("app.routers.workflows.get_workflow_item", return_value=workflow):
            return client.post(
                f"/documents/doc-1/workflows/{workflow.SK[3:]}/reanalyze",
                json={"user_instructions": "Check the net pay", "language": "en"},
            )

    def test_input_and_name_carry_no_file_name(self, sfn):
        # An older workflow record holding an original name
        response = self._reanalyze(_workflow(file_name="Rahul_Deshmukh_salary_slip_aug.pdf"))

        assert response.status_code == 200
        call = sfn["client"].start_execution.call_args.kwargs
        assert call["stateMachineArn"] == STATE_MACHINE_ARN
        sfn_input = json.loads(call["input"])
        assert "file_name" not in sfn_input
        assert "Rahul" not in json.dumps(call)
        assert re.fullmatch(r"reanalyze-wf_AbCdEfGhIjKlM-\d{14}", call["name"])
        assert sfn_input["file_uri"] == "s3://bucket/projects/proj-1/documents/doc-1/doc-1.pdf"
        assert sfn_input["is_reanalysis"] is True
        assert sfn_input["user_instructions"] == "Check the net pay"
        assert response.json()["execution_arn"].endswith(call["name"])
        sfn["update_workflow"].assert_called_once_with(
            "doc-1", "wf_AbCdEfGhIjKlMnOpQr", "reanalyzing", response.json()["execution_arn"], entity_type="DOC"
        )
        sfn["update_document"].assert_called_once_with("proj-1", "doc-1", "reanalyzing")

    def test_web_document_updates_its_web_workflow_item(self, sfn):
        # A web document's workflow is WEB#{document_id}: the update (status and
        # the new execution ARN, which the failure catcher matches) goes there,
        # not to a DOC# item that does not exist.
        workflow = _workflow(file_type="application/x-webreq", ext="webreq")
        workflow.PK = "WEB#doc-1"

        response = self._reanalyze(workflow)

        assert response.status_code == 200
        sfn_input = json.loads(sfn["client"].start_execution.call_args.kwargs["input"])
        assert sfn_input["processing_type"] == "web"
        sfn["update_workflow"].assert_called_once_with(
            "doc-1", "wf_AbCdEfGhIjKlMnOpQr", "reanalyzing", response.json()["execution_arn"], entity_type="WEB"
        )

    @pytest.mark.parametrize(
        ("file_type", "ext", "processing_type"),
        [
            ("application/pdf", "pdf", "document"),
            ("audio/wav", "wav", "audio"),
            ("text/csv", "csv", "dataset"),
        ],
    )
    def test_input_has_the_processing_type(self, sfn, file_type, ext, processing_type):
        # The state machine's first Choice (IsDataset) reads $.processing_type
        response = self._reanalyze(_workflow(file_type=file_type, ext=ext))

        assert response.status_code == 200
        sfn_input = json.loads(sfn["client"].start_execution.call_args.kwargs["input"])
        assert sfn_input["processing_type"] == processing_type


@pytest.mark.parametrize(
    ("file_type", "processing_type"),
    [
        ("application/pdf", "document"),
        ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document"),
        ("application/vnd.openxmlformats-officedocument.presentationml.presentation", "document"),
        ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "dataset"),
        ("application/vnd.ms-excel", "dataset"),
        ("text/csv", "dataset"),
        ("text/tab-separated-values", "dataset"),
        ("application/x-webreq", "web"),
        ("text/plain", "text"),
        ("text/markdown", "text"),
        ("application/dxf", "text"),
        ("image/vnd.dxf", "text"),
        ("image/png", "image"),
        ("video/mp4", "video"),
        ("audio/mpeg", "audio"),
        ("application/octet-stream", "document"),
        # A record without a file type is a document (the state machine's default)
        ("", "document"),
    ],
)
def test_processing_type_matches_type_detection(file_type, processing_type):
    assert _processing_type(file_type) == processing_type


FUNCTIONS_DIR = Path(__file__).resolve().parents[2] / "infra" / "src" / "functions"
TYPE_DETECTION = FUNCTIONS_DIR / "preprocessing" / "type-detection" / "index.py"


@pytest.fixture(scope="module")
def type_detection():
    """type-detection's index.py: the processing_type an upload gets (no AWS calls)."""
    if not TYPE_DETECTION.exists():
        pytest.skip("type-detection Lambda source not in this checkout")
    functions = str(FUNCTIONS_DIR)  # the shared layer: shared.ddb_client
    sys.path.insert(0, functions)
    try:
        spec = importlib.util.spec_from_file_location("type_detection_index", TYPE_DETECTION)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(functions)
    return module


def test_reanalysis_routes_like_the_upload(type_detection, monkeypatch):
    # Re-analyze must route an execution the way the upload did (IsDataset reads
    # processing_type), for every file type type-detection knows.
    sent = []
    monkeypatch.setattr(type_detection, "send_to_queue", lambda url, message: sent.append(message))
    file_types = sorted(set(type_detection.MIME_TYPE_MAP.values()) | {"application/octet-stream", "image/vnd.dxf"})
    for file_type in file_types:
        sent.clear()
        type_detection.send_to_workflow_queue(
            workflow_id="wf_AbCdEfGhIjKlMnOpQr",
            document_id="doc-1",
            project_id="proj-1",
            file_uri="s3://bucket/projects/proj-1/documents/doc-1/doc-1.bin",
            file_name="doc-1.bin",
            file_type=file_type,
            language="en",
            use_bda=False,
            use_ocr=False,
        )
        assert _processing_type(file_type) == sent[0]["processing_type"], file_type
    assert len(file_types) > 20


@pytest.mark.parametrize(("entity_type", "pk"), [("DOC", "DOC#doc-1"), ("WEB", "WEB#doc-1")])
def test_update_workflow_status_writes_the_items_own_key(entity_type, pk):
    from app.ddb.workflows import update_workflow_status

    table = MagicMock()
    with patch("app.ddb.workflows.get_table", return_value=table):
        update_workflow_status("doc-1", "wf_1", "reanalyzing", "arn:exec", entity_type=entity_type)

    kwargs = table.update_item.call_args.kwargs
    assert kwargs["Key"] == {"PK": pk, "SK": "WF#wf_1"}
    assert kwargs["ExpressionAttributeValues"][":execution_arn"] == "arn:exec"
