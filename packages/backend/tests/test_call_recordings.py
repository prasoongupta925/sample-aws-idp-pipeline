"""Call recordings from a phone's call recorder (the "Upload call recordings" page).

The recorders save MP3, M4A, WAV, AMR, Ogg or WebM audio. Amazon Transcribe
reads all of them as they are, so the upload only has to reach Transcribe:
the backend signs the upload (also in the Mumbai build, which has no video
model) and type-detection, which types a file by its key's extension, must
see audio. An audio-only WebM is stored as .weba for that reason.
"""

import importlib.util
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.parse import urlsplit

import pytest
from fastapi.testclient import TestClient

from app.config import Config
from app.main import app
from app.presigned import AUDIO_WEBM_EXTENSION, UPLOAD_CONTENT_TYPES, check_upload

client = TestClient(app)

DOC_BUCKET = "idp-v2-document-storage-test-ap-south-1"
PROJECT_ITEM = {
    "Item": {
        "PK": "PROJ#proj-calls",
        "SK": "META",
        "data": {
            "project_id": "proj-calls",
            "name": "Telecaller QA – Sample calls",
            "description": "Sample recorded telecaller calls for the Call QA Reviewer",
            "status": "active",
        },
        "created_at": "2026-10-01T00:00:00+00:00",
        "updated_at": "2026-10-01T00:00:00+00:00",
    }
}

# File name, content type the page sends, extension of the stored key.
RECORDINGS = [
    ("asha_verma_call_0930.mp3", "audio/mpeg", "mp3"),
    ("Call recording Rohan Iyer.m4a", "audio/mp4", "m4a"),
    ("call_20261001_1015.wav", "audio/wav", "wav"),
    ("call_20261001_1020.amr", "audio/amr", "amr"),
    ("call_20261001_1030.ogg", "audio/ogg", "ogg"),
    ("call_20261001_1045.webm", "audio/webm", "weba"),
]

FUNCTIONS_DIR = Path(__file__).resolve().parents[2] / "infra" / "src" / "functions"
TYPE_DETECTION = FUNCTIONS_DIR / "preprocessing" / "type-detection" / "index.py"


@pytest.fixture
def mumbai_build():
    """The Mumbai build: no video model, so video uploads are refused."""
    cfg = Config(aws_region="ap-south-1", document_storage_bucket_name=DOC_BUCKET, video_uploads_enabled=False)
    with patch("app.s3.get_config", return_value=cfg), patch("app.routers.documents.get_config", return_value=cfg):
        yield cfg


@pytest.fixture
def table():
    mock_table = MagicMock()
    mock_table.get_item.side_effect = lambda Key: PROJECT_ITEM if Key == {"PK": "PROJ#proj-calls", "SK": "META"} else {}
    with (
        patch("app.ddb.projects.get_table", return_value=mock_table),
        patch("app.ddb.documents.get_table", return_value=mock_table),
    ):
        yield mock_table


@pytest.fixture(scope="module")
def type_detection():
    """type-detection's index.py (no AWS calls at import)."""
    if not TYPE_DETECTION.exists():
        pytest.skip("type-detection Lambda source not in this checkout")
    # As on Lambda: the shared layer (shared.ddb_client) and the function's own
    # folder (index.py imports its sibling encrypted_pdf) are on sys.path.
    paths = [str(FUNCTIONS_DIR), str(TYPE_DETECTION.parent)]
    for path in paths:
        sys.path.insert(0, path)
    try:
        spec = importlib.util.spec_from_file_location("type_detection_for_calls", TYPE_DETECTION)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        for path in paths:
            sys.path.remove(path)
    return module


def _upload(file_name: str, content_type: str):
    # What the page sends: Transcribe on, no OCR or BDA.
    return client.post(
        "/projects/proj-calls/documents",
        json={
            "file_name": file_name,
            "content_type": content_type,
            "file_size": 480_000,
            "use_bda": False,
            "use_ocr": False,
            "use_transcribe": True,
        },
        headers={"x-user-id": "asha.verma"},
    )


@pytest.mark.parametrize(("file_name", "content_type", "key_ext"), RECORDINGS)
def test_every_recorder_format_uploads_in_the_mumbai_build(mumbai_build, table, file_name, content_type, key_ext):
    response = _upload(file_name, content_type)

    assert response.status_code == 200, response.text
    doc_id = response.json()["document_id"]
    key = f"projects/proj-calls/documents/{doc_id}/{doc_id}.{key_ext}"
    assert urlsplit(response.json()["upload_url"]).path == f"/{key}"

    data = table.put_item.call_args.kwargs["Item"]["data"]
    assert data["s3_key"] == key
    # The record keeps the recording's own name and type.
    assert data["name"] == file_name
    assert data["file_type"] == content_type
    assert data["use_transcribe"] is True
    assert data["use_ocr"] is False


@pytest.mark.parametrize(("file_name", "content_type", "key_ext"), RECORDINGS)
def test_type_detection_sends_each_recording_to_transcribe(type_detection, file_name, content_type, key_ext):
    stored_as = f"doc-1.{check_upload(file_name, content_type, 1, video_allowed=False)}"
    assert stored_as == f"doc-1.{key_ext}"

    file_type = type_detection.get_mime_type(stored_as)
    assert file_type.startswith("audio/")
    assert type_detection.get_processing_type(file_type) == "audio"


def test_audio_webm_with_codecs_is_audio_and_video_webm_stays_video():
    assert check_upload("call.webm", "audio/webm;codecs=opus", 10, video_allowed=False) == AUDIO_WEBM_EXTENSION
    assert check_upload("CALL.WEBM", "audio/webm", 10) == AUDIO_WEBM_EXTENSION
    assert check_upload("site_visit.webm", "video/webm", 10) == "webm"
    assert check_upload("site_visit.webm", "application/octet-stream", 10) == "webm"


@pytest.mark.parametrize(
    ("file_name", "content_type", "detail"),
    [
        # AAC and 3GP need a conversion first: Transcribe does not read them.
        ("call.aac", "audio/aac", "Unsupported file type: .aac"),
        ("call.3gp", "audio/3gpp", "Unsupported file type: .3gp"),
        ("call.amr", "audio/mpeg", "Content type audio/mpeg does not match a .amr file"),
        ("call.ogg", "video/ogg", "Content type video/ogg does not match a .ogg file"),
    ],
)
def test_other_audio_is_refused_with_a_reason(mumbai_build, table, file_name, content_type, detail):
    response = _upload(file_name, content_type)

    assert response.status_code == 400
    assert response.json()["detail"] == detail
    table.put_item.assert_not_called()


def test_every_upload_extension_is_known_to_type_detection(type_detection):
    # A type the backend signs but type-detection does not know would run as an
    # unknown document instead of its own pipeline.
    assert set(UPLOAD_CONTENT_TYPES) <= set(type_detection.MIME_TYPE_MAP)
