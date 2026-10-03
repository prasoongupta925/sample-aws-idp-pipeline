"""Phone call recordings (MP3, M4A, WAV, AMR, Ogg, WebM audio) reach Amazon
Transcribe as they are: type-detection types them as audio, the workflow
needs the Transcribe step, and transcribe-start passes the matching
MediaFormat. Transcribe's batch jobs read all of these formats, so nothing is
converted. No AWS calls: the DynamoDB helpers and the Transcribe client are
fakes; synthetic data only.

Run from the repo root:
    uv run --frozen python -m pytest -q packages/infra/src/test_call_recordings.py
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

from shared.ddb_client import PreprocessType, determine_preprocess_required  # noqa: E402


def _load(name: str, folder: str):
    spec = importlib.util.spec_from_file_location(name, FUNCTIONS / 'preprocessing' / folder / 'index.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


type_detection = _load('type_detection_calls', 'type-detection')
transcribe_start = _load('transcribe_start_calls', 'transcribe-start')

# Extension of the stored key (the backend stores an audio-only WebM as .weba),
# the type type-detection gives it and the MediaFormat Transcribe gets.
RECORDINGS = [
    ('mp3', 'audio/mpeg', 'mp3'),
    ('m4a', 'audio/mp4', 'mp4'),
    ('wav', 'audio/wav', 'wav'),
    ('amr', 'audio/amr', 'amr'),
    ('ogg', 'audio/ogg', 'ogg'),
    ('weba', 'audio/webm', 'webm'),
]


@pytest.mark.parametrize(('ext', 'file_type', 'media_format'), RECORDINGS)
def test_type_detection_types_the_recording_as_audio(ext, file_type, media_format):
    key = f'projects/proj-calls/documents/doc-1/doc-1.{ext}'
    parsed = type_detection.parse_eventbridge_s3_event(
        {
            'detail-type': 'Object Created',
            'detail': {'bucket': {'name': 'doc-bucket'}, 'object': {'key': key}},
        }
    )

    assert parsed['file_type'] == file_type
    assert type_detection.get_processing_type(file_type) == 'audio'


@pytest.mark.parametrize(('ext', 'file_type', 'media_format'), RECORDINGS)
def test_the_workflow_runs_transcribe_for_the_recording(monkeypatch, ext, file_type, media_format):
    sent = []
    monkeypatch.setattr(type_detection, 'send_to_queue', lambda url, message: sent.append(message))
    type_detection.send_to_workflow_queue(
        workflow_id='wf_calls0001',
        document_id='doc-1',
        project_id='proj-calls',
        file_uri=f's3://doc-bucket/projects/proj-calls/documents/doc-1/doc-1.{ext}',
        file_name=f'doc-1.{ext}',
        file_type=file_type,
        language='en',
        use_bda=False,
        use_ocr=False,
        use_transcribe=True,
        ocr_model='pp-ocrv5',
    )

    assert sent[0]['processing_type'] == 'audio'
    required = determine_preprocess_required(file_type, use_bda=False, use_ocr=False, use_transcribe=True)
    assert required[PreprocessType.TRANSCRIBE]['required'] is True
    assert required[PreprocessType.OCR]['required'] is False


class _FakeTranscribe:
    def __init__(self):
        self.jobs = []

    def start_transcription_job(self, **params):
        self.jobs.append(params)


@pytest.mark.parametrize(('ext', 'file_type', 'media_format'), RECORDINGS)
def test_transcribe_start_reads_the_recording_as_it_is(monkeypatch, ext, file_type, media_format):
    fake = _FakeTranscribe()
    monkeypatch.setattr(transcribe_start, 'get_transcribe_client', lambda: fake)
    monkeypatch.setattr(transcribe_start, 'record_step_start', lambda *args, **kwargs: None)
    monkeypatch.setattr(transcribe_start, 'update_preprocess_status', lambda *args, **kwargs: None)
    file_uri = f's3://doc-bucket/projects/proj-calls/documents/doc-1/doc-1.{ext}'

    result = transcribe_start.handler(
        {
            'workflow_id': 'wf_calls0001',
            'document_id': 'doc-1',
            'project_id': 'proj-calls',
            'file_uri': file_uri,
            'file_type': file_type,
        },
        None,
    )

    assert result['transcribe_status'] == 'IN_PROGRESS'
    [job] = fake.jobs
    assert job['MediaFormat'] == media_format
    # The original file, not a converted copy.
    assert job['Media'] == {'MediaFileUri': file_uri}
    # Auto language: Indian English, Hindi, Marathi (plus US English).
    assert job['IdentifyLanguage'] is True
    assert set(job['LanguageOptions']) >= {'en-IN', 'hi-IN', 'mr-IN'}
