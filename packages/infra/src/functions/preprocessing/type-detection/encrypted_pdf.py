"""Server-side check for a password-protected PDF from a customer upload link.

The customer page looks for an Encrypt dictionary before it uploads, and sends
a protected PDF to the document's ``locked/`` key (which the S3 upload rule
ignores). When that check misses one (an old browser, a file it could not
read), the PDF lands on the normal key and would start the pipeline, which
cannot read it. Type detection then calls hold_if_encrypted: the file moves to
the locked key, the document becomes ``password_required`` (the page and staff
then ask for the password) and no workflow starts.

The check reads only the first and last 64 KB (no PDF library in this Lambda):
an encrypted PDF names /Encrypt in its trailer (at the end; also near the start
in a linearized file). The trailer is never compressed, also with xref streams.
"""

import re

from boto3.dynamodb.conditions import Attr

SOURCE_CUSTOMER_LINK = 'customer_link'
DOC_PASSWORD_REQUIRED = 'password_required'
CHUNK_BYTES = 64 * 1024

# "/Encrypt" as a name (followed by a delimiter), not a longer name like /EncryptMetadata.
ENCRYPT_NAME = re.compile(rb'/Encrypt(?=[\s/<\[(0-9])')


def has_encrypt_dictionary(chunk: bytes) -> bool:
    return ENCRYPT_NAME.search(chunk) is not None


def customer_pdf_key(project_id: str, document_id: str) -> str:
    """The normal key of a customer PDF (backend app/upload_links.document_keys)."""
    return f'projects/{project_id}/documents/{document_id}/{document_id}.pdf'


def locked_key(project_id: str, document_id: str) -> str:
    return f'projects/{project_id}/documents/{document_id}/locked/{document_id}.pdf'


def should_check(document: dict | None, object_key: str, project_id: str, document_id: str) -> bool:
    """Only customer-link PDFs on their normal key are checked."""
    if not document or document.get('source') != SOURCE_CUSTOMER_LINK:
        return False
    return object_key == customer_pdf_key(project_id, document_id)


def is_encrypted_object(s3, bucket: str, key: str) -> bool:
    size = int(s3.head_object(Bucket=bucket, Key=key).get('ContentLength') or 0)
    if size <= 2 * CHUNK_BYTES:
        return has_encrypt_dictionary(s3.get_object(Bucket=bucket, Key=key)['Body'].read())
    head = s3.get_object(Bucket=bucket, Key=key, Range=f'bytes=0-{CHUNK_BYTES - 1}')['Body'].read()
    tail = s3.get_object(Bucket=bucket, Key=key, Range=f'bytes=-{CHUNK_BYTES}')['Body'].read()
    return has_encrypt_dictionary(head) or has_encrypt_dictionary(tail)


def delete_all_versions(s3, bucket: str, key: str) -> None:
    paginator = s3.get_paginator('list_object_versions')
    for page in paginator.paginate(Bucket=bucket, Prefix=key):
        for entry in page.get('Versions', []) + page.get('DeleteMarkers', []):
            if entry.get('Key') == key:
                s3.delete_object(Bucket=bucket, Key=key, VersionId=entry['VersionId'])


def hold_if_encrypted(s3, table, bucket: str, object_key: str, project_id: str, document_id: str) -> bool:
    """Move an encrypted customer PDF to its locked key. True when it was held."""
    if not is_encrypted_object(s3, bucket, object_key):
        return False
    target = locked_key(project_id, document_id)
    s3.copy_object(
        Bucket=bucket,
        Key=target,
        CopySource={'Bucket': bucket, 'Key': object_key},
        ContentType='application/pdf',
        MetadataDirective='REPLACE',
    )
    delete_all_versions(s3, bucket, object_key)
    table.update_item(
        Key={'PK': f'PROJ#{project_id}', 'SK': f'DOC#{document_id}'},
        UpdateExpression='SET #data.#locked = :true, #data.#status = :status',
        ConditionExpression=Attr('PK').exists(),
        ExpressionAttributeNames={'#data': 'data', '#locked': 'locked', '#status': 'status'},
        ExpressionAttributeValues={':true': True, ':status': DOC_PASSWORD_REQUIRED},
    )
    return True
