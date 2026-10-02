"""Tests for the dataset-process Lambda's Step Functions contract (index.py).

Step Functions keeps execution history for 90 days, so the event carries no file
name and the returned output names no file or sheet: the original name comes
from the DOC# record and reaches DynamoDB only. S3, DynamoDB, the dataset
catalog and the reference model are fakes; synthetic data only.

Run (from this folder):
    uv run --no-project --with pytest --with boto3 --with pandas --with pyarrow \
        --with openpyxl --with duckdb python -m pytest -q
"""

import importlib.util
import io
import json
import os
import sys
import types

import pytest

os.environ.setdefault("BACKEND_TABLE_NAME", "test-table")
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-south-1")
os.environ.setdefault("AWS_REGION", "ap-south-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")

for _module in ("pandas", "pyarrow", "openpyxl", "duckdb"):
    pytest.importorskip(_module, reason="dataset-process image dependency (requirements.txt)")

HERE = os.path.dirname(os.path.abspath(__file__))
FUNCTIONS = os.path.abspath(os.path.join(HERE, "..", ".."))
for _path in (FUNCTIONS, HERE):  # the shared layer, then validator.py
    if _path not in sys.path:
        sys.path.insert(0, _path)


def _load():
    spec = importlib.util.spec_from_file_location("dataset_process_index", os.path.join(HERE, "index.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


dp = _load()

DOC_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
CSV_URI = f"s3://doc-bucket/projects/proj_1/documents/{DOC_ID}/{DOC_ID}.csv"
XLSX_URI = f"s3://doc-bucket/projects/proj_1/documents/{DOC_ID}/{DOC_ID}.xlsx"
CSV_TYPE = "text/csv"
XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
ORIGINAL_CSV = "Rahul_Deshmukh_bank_statement.csv"
ORIGINAL_XLSX = "Rahul_Deshmukh_bank_statement.xlsx"
SHEET_NAME = "Rahul Deshmukh"


def _event(file_uri, file_type):
    return {
        "workflow_id": "wf_1",
        "document_id": DOC_ID,
        "project_id": "proj_1",
        "file_uri": file_uri,
        "file_type": file_type,
        "processing_type": "dataset",
        "is_reanalysis": False,
    }


def _xlsx(sheets):
    import openpyxl

    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for title, rows in sheets:
        ws = wb.create_sheet(title)
        for row in rows:
            ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


class Recorder:
    def __init__(self, result=None):
        self.calls = []
        self.result = result

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return self.result


class FakeS3:
    def __init__(self):
        self.body = b""
        self.gets = []
        self.puts = []

    def get_object(self, Bucket, Key):
        self.gets.append((Bucket, Key))
        return {"Body": io.BytesIO(self.body)}

    def put_object(self, **kwargs):
        self.puts.append(kwargs)
        return {}


@pytest.fixture
def env(monkeypatch):
    rec = {
        name: Recorder()
        for name in (
            "record_step_start",
            "record_step_complete",
            "record_step_needs_fix",
            "update_workflow_status",
            "save_dataset",
            "_index_dataset_catalog",
        )
    }
    rec["get_document"] = Recorder({"name": ORIGINAL_CSV, "status": "in_progress"})
    for name, recorder in rec.items():
        monkeypatch.setattr(dp, name, recorder)
    rec["s3"] = FakeS3()
    monkeypatch.setattr(dp, "_s3", rec["s3"])
    # Reference doc model (strands + Bedrock): a fake module for the lazy import
    reference = types.ModuleType("reference")
    reference.build_reference = lambda con, name: ("reference text", "bank statement rows")
    monkeypatch.setitem(sys.modules, "reference", reference)
    return rec


def _dumped(result):
    return json.dumps(result, ensure_ascii=False)


def test_csv_without_rows_returns_no_name(env):
    env["s3"].body = b"pan,net_salary\n"

    result = dp.handler(_event(CSV_URI, CSV_TYPE), None)

    assert result == {"workflow_id": "wf_1", "status": "needs_user_fix"}
    # The reason names the file for the user, on the step record only
    ((args, _),) = env["record_step_needs_fix"].calls
    assert ORIGINAL_CSV in args[2]
    assert env["get_document"].calls == [(("proj_1", DOC_ID), {})]


def test_unreadable_workbook_returns_no_reason(env):
    env["get_document"].result = {"name": ORIGINAL_XLSX}
    env["s3"].body = b"not a workbook"

    result = dp.handler(_event(XLSX_URI, XLSX_TYPE), None)

    assert result == {"workflow_id": "wf_1", "status": "needs_user_fix"}
    assert len(env["record_step_needs_fix"].calls) == 1


def test_completed_output_counts_skipped_sheets_without_names(env):
    env["get_document"].result = {"name": ORIGINAL_XLSX}
    env["s3"].body = _xlsx(
        [
            ("Statement", [["month", "credit"], ["2026-07", 82500], ["2026-08", 82500]]),
            (SHEET_NAME, [["pan"]]),
        ]
    )

    result = dp.handler(_event(XLSX_URI, XLSX_TYPE), None)

    assert result == {
        "workflow_id": "wf_1",
        "status": "completed",
        "datasets": [
            {
                "dataset_id": f"{DOC_ID}__0",
                "dataset_s3_uri": f"s3://doc-bucket/projects/proj_1/documents/{DOC_ID}/dataset/{DOC_ID}__0.parquet",
                "rows": 2,
            }
        ],
        "skipped_sheets": 1,
    }
    assert SHEET_NAME not in _dumped(result)
    assert "Rahul" not in _dumped(result)
    # Names stay in DynamoDB: the DATASET# name and the step's skipped detail
    ((_, saved),) = env["save_dataset"].calls
    assert saved["name"] == f"{ORIGINAL_XLSX} / Statement"
    ((_, step),) = env["record_step_complete"].calls
    assert step["skipped_sheets"] == 1
    assert step["skipped_detail"][0]["sheet_name"] == SHEET_NAME


def test_name_falls_back_to_the_s3_key_without_a_doc_record(env):
    env["get_document"].result = None
    env["s3"].body = b"pan,net_salary\nABCDE1234F,82500\n"

    result = dp.handler(_event(CSV_URI, CSV_TYPE), None)

    assert result["status"] == "completed"
    assert result["skipped_sheets"] == 0
    ((_, saved),) = env["save_dataset"].calls
    assert saved["name"] == f"{DOC_ID}.csv"
    assert saved["row_count"] == 1
