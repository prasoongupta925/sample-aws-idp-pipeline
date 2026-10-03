"""PDF unlock Lambda (idp-v2-pdf-unlock).

The backend (packages/backend app/pdf_unlock.py) invokes it synchronously for a
password-protected PDF from a customer upload link:

    {"source_key": "projects/<p>/documents/<d>/locked/<d>.pdf",
     "target_key": "projects/<p>/documents/<d>/<d>.pdf",
     "password": "..."}

It opens the locked copy with the password, writes an unprotected copy to the
document's normal key (its ObjectCreated event starts the pipeline) and then
deletes every version of the locked copy, so only the unlocked file is kept.

Answers (never an exception for an expected case):
- {"status": "unlocked", "size": n}
- {"status": "wrong_password"}
- {"status": "invalid_request" | "not_found" | "too_large" | "unreadable"}

The password is NEVER stored or logged: the event is not printed, and errors
are logged by type only (a library message could quote its input).
"""

import io
import os
import re

import boto3
from botocore.exceptions import ClientError

DOCUMENT_STORAGE_BUCKET_NAME = os.environ.get('DOCUMENT_STORAGE_BUCKET_NAME', '')
# A customer file is at most 15 MB (backend app/upload_links.MAX_FILE_BYTES).
MAX_SOURCE_BYTES = 15 * 1024 * 1024
MAX_PASSWORD_LENGTH = 128

_ID = r'[A-Za-z0-9_-]{1,64}'
SOURCE_KEY_PATTERN = re.compile(
    rf'^projects/(?P<project>{_ID})/documents/(?P<document>{_ID})/locked/(?P<name>{_ID})\.pdf$'
)

STATUS_UNLOCKED = 'unlocked'
STATUS_WRONG_PASSWORD = 'wrong_password'
STATUS_INVALID_REQUEST = 'invalid_request'
STATUS_NOT_FOUND = 'not_found'
STATUS_TOO_LARGE = 'too_large'
STATUS_UNREADABLE = 'unreadable'

_s3_client = None


def get_s3_client():
    global _s3_client
    if _s3_client is None:
        _s3_client = boto3.client('s3', region_name=os.environ.get('AWS_REGION'))
    return _s3_client


def expected_target_key(source_key: str) -> str | None:
    """The only target a locked key may be written to (same document, normal key)."""
    match = SOURCE_KEY_PATTERN.fullmatch(source_key or '')
    if not match or match['name'] != match['document']:
        return None
    return f"projects/{match['project']}/documents/{match['document']}/{match['document']}.pdf"


def valid_request(event) -> bool:
    if not isinstance(event, dict):
        return False
    source_key = event.get('source_key')
    target_key = event.get('target_key')
    password = event.get('password')
    if not isinstance(source_key, str) or not isinstance(target_key, str) or not isinstance(password, str):
        return False
    if len(password) > MAX_PASSWORD_LENGTH:
        return False
    return expected_target_key(source_key) == target_key


def unlock_bytes(data: bytes, password: str) -> bytes | None:
    """The PDF without protection, or None when the password is wrong.

    A PDF that is not encrypted comes back unchanged. Raises ValueError when
    the file cannot be read as a PDF.
    """
    import pypdf  # the pdf-unlock layer (pypdf + cryptography for AES)

    try:
        reader = pypdf.PdfReader(io.BytesIO(data))
        if not reader.is_encrypted:
            return data
        if reader.decrypt(password) == pypdf.PasswordType.NOT_DECRYPTED:
            return None
        writer = pypdf.PdfWriter(clone_from=reader)
        out = io.BytesIO()
        writer.write(out)
    except Exception as e:  # noqa: BLE001 - any parse failure is "unreadable"
        raise ValueError(type(e).__name__) from None
    return out.getvalue()


def delete_all_versions(bucket: str, key: str) -> int:
    """Delete every version and delete marker of exactly `key`. Returns the count."""
    s3 = get_s3_client()
    deleted = 0
    paginator = s3.get_paginator('list_object_versions')
    for page in paginator.paginate(Bucket=bucket, Prefix=key):
        entries = page.get('Versions', []) + page.get('DeleteMarkers', [])
        for entry in entries:
            if entry.get('Key') != key:
                continue
            s3.delete_object(Bucket=bucket, Key=key, VersionId=entry['VersionId'])
            deleted += 1
    return deleted


def handler(event, context):
    if not valid_request(event):
        print('pdf unlock: invalid request')
        return {'status': STATUS_INVALID_REQUEST}

    bucket = DOCUMENT_STORAGE_BUCKET_NAME
    source_key = event['source_key']
    target_key = event['target_key']
    s3 = get_s3_client()

    try:
        head = s3.head_object(Bucket=bucket, Key=source_key)
    except ClientError as e:
        code = e.response.get('Error', {}).get('Code', '')
        # 403: without s3:ListBucket on the key S3 answers a missing key with 403.
        if code in ('403', '404', 'NoSuchKey', 'NotFound', 'AccessDenied'):
            print('pdf unlock: locked copy not found')
            return {'status': STATUS_NOT_FOUND}
        raise
    if int(head.get('ContentLength') or 0) > MAX_SOURCE_BYTES:
        print('pdf unlock: locked copy too large')
        return {'status': STATUS_TOO_LARGE}

    data = s3.get_object(Bucket=bucket, Key=source_key)['Body'].read()
    try:
        unlocked = unlock_bytes(data, event['password'])
    except ValueError as e:
        print(f'pdf unlock: unreadable PDF ({e})')
        return {'status': STATUS_UNREADABLE}
    if unlocked is None:
        print('pdf unlock: wrong password')
        return {'status': STATUS_WRONG_PASSWORD}

    s3.put_object(Bucket=bucket, Key=target_key, Body=unlocked, ContentType='application/pdf')
    deleted = delete_all_versions(bucket, source_key)
    print(f'pdf unlock: unlocked, {len(unlocked)} bytes written, {deleted} locked version(s) deleted')
    return {'status': STATUS_UNLOCKED, 'size': len(unlocked)}
