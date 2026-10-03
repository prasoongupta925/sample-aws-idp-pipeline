"""Tests for the PDF unlock Lambda (index.py). No AWS calls: S3 is a fake.

Needs pypdf (the Lambda's layer), which the repo's Python env does not carry:

    uv run --frozen --with pypdf python -m pytest -q   (from this folder)
"""

import importlib.util
import io
import os

import pytest

pypdf = pytest.importorskip('pypdf')

os.environ.setdefault('DOCUMENT_STORAGE_BUCKET_NAME', 'docs-bucket')
os.environ.setdefault('AWS_REGION', 'ap-south-1')

HERE = os.path.dirname(os.path.abspath(__file__))


def _load():
    spec = importlib.util.spec_from_file_location('pdf_unlock_index', os.path.join(HERE, 'index.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


unlock = _load()

PROJECT = 'proj_AbCdEf123'
DOC = '0b6f8f1e-1111-4222-8333-944445555666'
SOURCE = f'projects/{PROJECT}/documents/{DOC}/locked/{DOC}.pdf'
TARGET = f'projects/{PROJECT}/documents/{DOC}/{DOC}.pdf'
PASSWORD = 'ASHA1990'


def make_pdf(password: str | None = None, algorithm: str = 'AES-256') -> bytes:
    writer = pypdf.PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.add_metadata({'/Title': 'Synthetic bank statement for Asha Verma'})
    if password is not None:
        writer.encrypt(user_password=password, owner_password='owner-' + password, algorithm=algorithm)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


class FakeS3:
    """Objects by key, each a list of (version_id, body); delete markers tracked apart."""

    def __init__(self):
        self.objects: dict[str, list[tuple[str, bytes]]] = {}
        self.markers: dict[str, list[str]] = {}
        self.puts: list[dict] = []
        self.deleted: list[tuple[str, str]] = []
        self._n = 0

    def add(self, key: str, body: bytes):
        self._n += 1
        self.objects.setdefault(key, []).append((f'v{self._n}', body))

    # boto3 surface used by index.py
    def head_object(self, Bucket, Key):
        if not self.objects.get(Key):
            from botocore.exceptions import ClientError as BotoClientError

            raise BotoClientError({'Error': {'Code': '404'}}, 'HeadObject')
        return {'ContentLength': len(self.objects[Key][-1][1])}

    def get_object(self, Bucket, Key):
        return {'Body': io.BytesIO(self.objects[Key][-1][1])}

    def put_object(self, Bucket, Key, Body, ContentType, Metadata=None):
        self.puts.append({'Key': Key, 'Body': Body, 'ContentType': ContentType, 'Metadata': Metadata})
        self.add(Key, Body)

    def delete_object(self, Bucket, Key, VersionId):
        self.deleted.append((Key, VersionId))
        self.objects[Key] = [v for v in self.objects.get(Key, []) if v[0] != VersionId]
        self.markers[Key] = [m for m in self.markers.get(Key, []) if m != VersionId]

    def get_paginator(self, name):
        assert name == 'list_object_versions'
        s3 = self

        class Paginator:
            def paginate(self, Bucket, Prefix):
                versions = [
                    {'Key': k, 'VersionId': v} for k, vs in s3.objects.items() if k.startswith(Prefix) for v, _ in vs
                ]
                markers = [
                    {'Key': k, 'VersionId': m} for k, ms in s3.markers.items() if k.startswith(Prefix) for m in ms
                ]
                yield {'Versions': versions, 'DeleteMarkers': markers}

        return Paginator()


@pytest.fixture
def s3(monkeypatch):
    fake = FakeS3()
    monkeypatch.setattr(unlock, '_s3_client', fake)
    monkeypatch.setattr(unlock, 'DOCUMENT_STORAGE_BUCKET_NAME', 'docs-bucket')
    return fake


def event(**overrides):
    return {'source_key': SOURCE, 'target_key': TARGET, 'password': PASSWORD, **overrides}


@pytest.mark.parametrize('algorithm', ['AES-256', 'AES-128', 'RC4-128'])
def test_unlocks_writes_target_and_deletes_every_locked_version(s3, algorithm):
    s3.add(SOURCE, make_pdf(PASSWORD, algorithm))
    s3.add(SOURCE, make_pdf(PASSWORD, algorithm))  # an overwritten earlier version
    s3.markers[SOURCE] = ['dm1']

    result = unlock.handler(event(), None)

    assert result == {'status': 'unlocked', 'size': len(s3.puts[0]['Body'])}
    assert [p['Key'] for p in s3.puts] == [TARGET]
    assert s3.puts[0]['ContentType'] == 'application/pdf'
    # Tagged, so type detection never holds the unlocked copy again (no password loop).
    assert s3.puts[0]['Metadata'] == {'unlocked': 'true'}
    reader = pypdf.PdfReader(io.BytesIO(s3.puts[0]['Body']))
    assert not reader.is_encrypted
    assert len(reader.pages) == 1
    assert s3.objects[SOURCE] == [] and s3.markers[SOURCE] == []
    assert {k for k, _ in s3.deleted} == {SOURCE}


def test_wrong_password_keeps_the_locked_copy(s3):
    s3.add(SOURCE, make_pdf(PASSWORD))

    assert unlock.handler(event(password='wrong'), None) == {'status': 'wrong_password'}
    assert s3.puts == [] and s3.deleted == []
    assert len(s3.objects[SOURCE]) == 1


def test_owner_password_also_unlocks(s3):
    s3.add(SOURCE, make_pdf(PASSWORD))

    assert unlock.handler(event(password='owner-' + PASSWORD), None)['status'] == 'unlocked'


def test_unencrypted_pdf_is_copied_unchanged(s3):
    plain = make_pdf()
    s3.add(SOURCE, plain)

    assert unlock.handler(event(), None) == {'status': 'unlocked', 'size': len(plain)}
    assert s3.puts[0]['Body'] == plain


def test_does_not_delete_other_keys_with_the_same_prefix(s3):
    s3.add(SOURCE, make_pdf(PASSWORD))
    s3.add(SOURCE + '.bak', b'other')

    unlock.handler(event(), None)

    assert len(s3.objects[SOURCE + '.bak']) == 1


@pytest.mark.parametrize(
    'overrides',
    [
        {'target_key': f'projects/{PROJECT}/documents/other-doc/other-doc.pdf'},
        {'target_key': f'projects/other/documents/{DOC}/{DOC}.pdf'},
        {'target_key': f'projects/{PROJECT}/documents/{DOC}/locked/{DOC}.pdf'},
        {'source_key': TARGET, 'target_key': TARGET},
        {'source_key': f'projects/{PROJECT}/documents/{DOC}/locked/../{DOC}.pdf'},
        {'source_key': f'projects/{PROJECT}/documents/{DOC}/locked/other.pdf'},
        {'source_key': f'projects/{PROJECT}/documents/{DOC}/locked/{DOC}.jpg'},
        {'source_key': f'agents/{DOC}/locked/{DOC}.pdf'},
        {'password': 'x' * 129},
        {'password': None},
        {'source_key': 7},
    ],
)
def test_rejects_any_other_request(s3, overrides):
    s3.add(SOURCE, make_pdf(PASSWORD))

    assert unlock.handler(event(**overrides), None) == {'status': 'invalid_request'}
    assert s3.puts == [] and s3.deleted == []


def test_rejects_non_dict_event(s3):
    assert unlock.handler('nope', None) == {'status': 'invalid_request'}


def test_missing_locked_copy(s3):
    assert unlock.handler(event(), None) == {'status': 'not_found'}


def test_too_large(s3, monkeypatch):
    monkeypatch.setattr(unlock, 'MAX_SOURCE_BYTES', 10)
    s3.add(SOURCE, make_pdf(PASSWORD))

    assert unlock.handler(event(), None) == {'status': 'too_large'}
    assert s3.puts == []


def test_unreadable_file(s3):
    s3.add(SOURCE, b'%PDF-1.7 this is not really a pdf')

    assert unlock.handler(event(), None) == {'status': 'unreadable'}
    assert s3.puts == [] and s3.deleted == []


@pytest.mark.parametrize('password', [PASSWORD, 'wrong-Rohan-1985'])
def test_never_logs_the_password(s3, capsys, password):
    s3.add(SOURCE, make_pdf(PASSWORD))

    unlock.handler(event(password=password), None)

    out = capsys.readouterr()
    assert password not in out.out and password not in out.err
