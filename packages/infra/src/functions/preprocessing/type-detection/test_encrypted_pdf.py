"""Tests for the encrypted customer PDF hold (encrypted_pdf.py) and its use in
type detection (index.py). No AWS calls: S3, DynamoDB and SQS are fakes.

Run (from this folder): python -m pytest -q
"""

import importlib.util
import io
import json
import os
import sys

import pytest

os.environ.setdefault('BACKEND_TABLE_NAME', 'test-table')
os.environ.setdefault('AWS_DEFAULT_REGION', 'ap-south-1')
os.environ.setdefault('AWS_REGION', 'ap-south-1')
os.environ.setdefault('AWS_ACCESS_KEY_ID', 'testing')
os.environ.setdefault('AWS_SECRET_ACCESS_KEY', 'testing')

HERE = os.path.dirname(os.path.abspath(__file__))
FUNCTIONS = os.path.abspath(os.path.join(HERE, '..', '..'))
for p in (HERE, FUNCTIONS):  # encrypted_pdf (same asset) and the shared layer
    if p not in sys.path:
        sys.path.insert(0, p)

import encrypted_pdf  # noqa: E402


def _load_index():
    spec = importlib.util.spec_from_file_location('type_detection_index', os.path.join(HERE, 'index.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


type_detection = _load_index()

BUCKET = 'docs-bucket'
PROJECT = 'proj_AbCdEf123'
DOC = '0b6f8f1e-1111-4222-8333-944445555666'
KEY = f'projects/{PROJECT}/documents/{DOC}/{DOC}.pdf'
LOCKED = f'projects/{PROJECT}/documents/{DOC}/locked/{DOC}.pdf'

PLAIN_PDF = b'%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R /Size 2 >>\n%%EOF\n'
ENCRYPTED_PDF = (
    b'%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n'
    b'trailer << /Root 1 0 R /Encrypt 5 0 R /Size 6 >>\n%%EOF\n'
)


class FakeS3:
    def __init__(self, objects: dict[str, bytes]):
        self.objects = {k: [('v1', v)] for k, v in objects.items()}
        self.copies: list[dict] = []
        self.deleted: list[tuple[str, str]] = []
        self.ranges: list[str | None] = []
        self.metadata: dict[str, dict] = {}

    def head_object(self, Bucket, Key):
        return {'ContentLength': len(self.objects[Key][-1][1]), 'Metadata': self.metadata.get(Key, {})}

    def get_object(self, Bucket, Key, Range=None):
        self.ranges.append(Range)
        body = self.objects[Key][-1][1]
        if Range:
            spec = Range.removeprefix('bytes=')
            if spec.startswith('-'):
                body = body[int(spec):]
            else:
                start, end = spec.split('-')
                body = body[int(start): int(end) + 1]
        return {'Body': io.BytesIO(body)}

    def copy_object(self, Bucket, Key, CopySource, **kwargs):
        self.copies.append({'Key': Key, 'Source': CopySource['Key'], **kwargs})
        self.objects.setdefault(Key, []).append(('c1', self.objects[CopySource['Key']][-1][1]))

    def delete_object(self, Bucket, Key, VersionId):
        self.deleted.append((Key, VersionId))
        self.objects[Key] = [v for v in self.objects[Key] if v[0] != VersionId]

    def get_paginator(self, name):
        s3 = self

        class Paginator:
            def paginate(self, Bucket, Prefix):
                yield {
                    'Versions': [
                        {'Key': k, 'VersionId': v} for k, vs in s3.objects.items() if k.startswith(Prefix) for v, _ in vs
                    ]
                }

        return Paginator()


class FakeTable:
    def __init__(self):
        self.updates: list[dict] = []

    def update_item(self, **kwargs):
        self.updates.append(kwargs)


# ---- the byte check ----------------------------------------------------------


@pytest.mark.parametrize(
    'chunk',
    [
        b'trailer << /Root 1 0 R /Encrypt 5 0 R >>',
        b'<< /Type /XRef /Encrypt<< /Filter /Standard >> >>',
        b'/Encrypt\n12 0 R',
        b'/Encrypt/Standard',
    ],
)
def test_finds_an_encrypt_dictionary(chunk):
    assert encrypted_pdf.has_encrypt_dictionary(chunk)


@pytest.mark.parametrize('chunk', [PLAIN_PDF, b'<< /EncryptMetadata false >>', b'/Encryption 1', b''])
def test_ignores_other_names(chunk):
    assert not encrypted_pdf.has_encrypt_dictionary(chunk)


def test_large_file_reads_only_head_and_tail():
    middle = b'x' * (3 * encrypted_pdf.CHUNK_BYTES)
    s3 = FakeS3({KEY: b'%PDF-1.7\n' + middle + b'trailer << /Encrypt 5 0 R >>\n%%EOF'})

    assert encrypted_pdf.is_encrypted_object(s3, BUCKET, KEY)
    assert s3.ranges == [f'bytes=0-{encrypted_pdf.CHUNK_BYTES - 1}', f'bytes=-{encrypted_pdf.CHUNK_BYTES}']


def test_large_linearized_file_found_in_head():
    middle = b'x' * (3 * encrypted_pdf.CHUNK_BYTES)
    s3 = FakeS3({KEY: b'%PDF-1.7\ntrailer << /Encrypt 5 0 R >>\n' + middle + b'%%EOF'})

    assert encrypted_pdf.is_encrypted_object(s3, BUCKET, KEY)


def test_large_plain_file():
    s3 = FakeS3({KEY: PLAIN_PDF + b'x' * (3 * encrypted_pdf.CHUNK_BYTES)})

    assert not encrypted_pdf.is_encrypted_object(s3, BUCKET, KEY)


# ---- which uploads are checked -----------------------------------------------


def test_checks_only_customer_link_pdfs_on_their_normal_key():
    customer = {'source': 'customer_link'}

    assert encrypted_pdf.should_check(customer, KEY, PROJECT, DOC)
    assert not encrypted_pdf.should_check({'source': None}, KEY, PROJECT, DOC)
    assert not encrypted_pdf.should_check({}, KEY, PROJECT, DOC)
    assert not encrypted_pdf.should_check(None, KEY, PROJECT, DOC)
    assert not encrypted_pdf.should_check(customer, KEY.replace('.pdf', '.jpg'), PROJECT, DOC)
    assert not encrypted_pdf.should_check(customer, f'projects/{PROJECT}/documents/{DOC}/statement.pdf', PROJECT, DOC)


# ---- the hold ----------------------------------------------------------------


def test_holds_an_encrypted_pdf():
    s3 = FakeS3({KEY: ENCRYPTED_PDF})
    table = FakeTable()

    assert encrypted_pdf.hold_if_encrypted(s3, table, BUCKET, KEY, PROJECT, DOC)

    assert [c['Key'] for c in s3.copies] == [LOCKED]
    assert s3.objects[KEY] == []
    assert s3.objects[LOCKED][-1][1] == ENCRYPTED_PDF
    [update] = table.updates
    assert update['Key'] == {'PK': f'PROJ#{PROJECT}', 'SK': f'DOC#{DOC}'}
    assert update['ExpressionAttributeValues'] == {':true': True, ':status': 'password_required'}


def test_leaves_a_plain_pdf():
    s3 = FakeS3({KEY: PLAIN_PDF})
    table = FakeTable()

    assert not encrypted_pdf.hold_if_encrypted(s3, table, BUCKET, KEY, PROJECT, DOC)
    assert s3.copies == [] and s3.deleted == [] and table.updates == []


# ---- type detection ----------------------------------------------------------


def _record(key: str) -> dict:
    body = {'detail-type': 'Object Created', 'detail': {'bucket': {'name': BUCKET}, 'object': {'key': key}}}
    return {'Records': [{'body': json.dumps(body)}]}


@pytest.fixture
def pipeline(monkeypatch):
    calls = {'workflows': [], 'queued': []}
    monkeypatch.setattr(type_detection, 'get_project_language', lambda p: 'en')
    monkeypatch.setattr(type_detection, 'get_project_ocr_settings', lambda p: {})
    monkeypatch.setattr(type_detection, 'get_project_document_prompt', lambda p: '')
    monkeypatch.setattr(type_detection, 'create_workflow', lambda **kw: calls['workflows'].append(kw))
    monkeypatch.setattr(type_detection, 'send_to_workflow_queue', lambda **kw: calls['queued'].append(kw))
    table = FakeTable()
    monkeypatch.setattr(type_detection, 'get_table', lambda: table)
    calls['table'] = table
    return calls


def test_handler_holds_encrypted_customer_pdf(monkeypatch, pipeline):
    s3 = FakeS3({KEY: ENCRYPTED_PDF})
    monkeypatch.setattr(type_detection, 'get_s3_client', lambda: s3)
    monkeypatch.setattr(type_detection, 'get_document', lambda p, d: {'source': 'customer_link'})

    result = json.loads(type_detection.handler(_record(KEY), None)['body'])

    assert result['results'] == [{'document_id': DOC, 'status': 'password_required'}]
    assert pipeline['workflows'] == [] and pipeline['queued'] == []
    assert s3.objects[KEY] == [] and LOCKED in s3.objects


def test_handler_runs_plain_customer_pdf(monkeypatch, pipeline):
    s3 = FakeS3({KEY: PLAIN_PDF})
    monkeypatch.setattr(type_detection, 'get_s3_client', lambda: s3)
    monkeypatch.setattr(type_detection, 'get_document', lambda p, d: {'source': 'customer_link'})

    type_detection.handler(_record(KEY), None)

    assert len(pipeline['workflows']) == 1 and len(pipeline['queued']) == 1
    assert s3.copies == []


def test_handler_does_not_read_staff_uploads(monkeypatch, pipeline):
    def no_s3():
        raise AssertionError('S3 must not be read for a staff upload')

    monkeypatch.setattr(type_detection, 'get_s3_client', no_s3)
    monkeypatch.setattr(type_detection, 'get_document', lambda p, d: {'file_name': 'statement.pdf'})

    type_detection.handler(_record(f'projects/{PROJECT}/documents/{DOC}/statement.pdf'), None)

    assert len(pipeline['workflows']) == 1


# ---- the unlock Lambda's own output and repeat uploads -----------------------


def test_the_unlocked_copy_is_never_held_again():
    """A plain PDF whose content names /Encrypt comes back from the unlock Lambda tagged: no loop."""
    s3 = FakeS3({KEY: ENCRYPTED_PDF})
    s3.metadata[KEY] = {'unlocked': 'true'}
    table = FakeTable()

    assert not encrypted_pdf.is_encrypted_object(s3, BUCKET, KEY)
    assert not encrypted_pdf.hold_if_encrypted(s3, table, BUCKET, KEY, PROJECT, DOC)
    assert s3.ranges == [] and s3.copies == [] and table.updates == []


def test_other_metadata_does_not_skip_the_check():
    s3 = FakeS3({KEY: ENCRYPTED_PDF})
    s3.metadata[KEY] = {'unlocked': 'yes'}

    assert encrypted_pdf.is_encrypted_object(s3, BUCKET, KEY)


@pytest.mark.parametrize('status', sorted(type_detection.PIPELINE_STARTED_STATUSES))
def test_a_repeat_upload_starts_nothing(monkeypatch, pipeline, status):
    """The same presigned PUT used again (or a repeated event) must not restart the pipeline."""
    monkeypatch.setattr(type_detection, 'get_s3_client', lambda: FakeS3({KEY: PLAIN_PDF}))
    monkeypatch.setattr(type_detection, 'get_document', lambda p, d: {'source': 'customer_link', 'status': status})

    result = json.loads(type_detection.handler(_record(KEY), None)['body'])

    assert result['results'] == [{'document_id': DOC, 'status': 'skipped_repeat'}]
    assert pipeline['workflows'] == [] and pipeline['queued'] == []


@pytest.mark.parametrize('status', [None, 'uploading', 'uploaded', 'password_required'])
def test_a_first_upload_or_an_unlocked_copy_runs(monkeypatch, pipeline, status):
    s3 = FakeS3({KEY: PLAIN_PDF})
    s3.metadata[KEY] = {'unlocked': 'true'} if status == 'password_required' else {}
    monkeypatch.setattr(type_detection, 'get_s3_client', lambda: s3)
    document = {'source': 'customer_link'} | ({'status': status} if status else {})
    monkeypatch.setattr(type_detection, 'get_document', lambda p, d: document)

    type_detection.handler(_record(KEY), None)

    assert len(pipeline['workflows']) == 1 and len(pipeline['queued']) == 1
