"""Customer side of the upload links: no Cognito, the link token is the only key.

Every call sends the token in the X-Upload-Token header (app/upload_links.py)
and every call looks the link up by the token's hash. An unknown, malformed,
expired, submitted or revoked token gets the same 404, so the endpoints say
nothing about which links exist. Nothing here takes a project id or a link id
from the caller: the link names its project, and a document id is only
accepted when that document was uploaded through this same link.

- GET  /public/upload-link                          what the page shows
- POST /public/upload-link/consent                  log the DPDP consent
- POST /public/upload-link/files                    one single-use presigned PUT (after consent)
- POST /public/upload-link/files/{doc}/unlock       password of a protected PDF
- POST /public/upload-link/submit                   done: the link stops working
"""

import time
import uuid
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Header, HTTPException, Path
from pydantic import BaseModel, Field, SecretStr

from app.config import get_config
from app.ddb import DocumentData, get_document_item, get_project_item, put_document_item, query_documents
from app.ddb.upload_links import (
    close_link,
    count_unlock_attempt,
    get_link,
    record_consent,
    reserve_file_slot,
)
from app.pdf_unlock import STATUS_WRONG_PASSWORD
from app.presigned import PresignError, check_upload
from app.routers.upload_links import RequestedItem, unlock_customer_document
from app.s3 import PRESIGNED_URL_EXPIRES_IN, presign_put
from app.upload_links import (
    CONSENT_VERSION,
    DOC_PASSWORD_REQUIRED,
    MAX_FILE_BYTES,
    MAX_PASSWORD_LENGTH,
    MAX_UNLOCK_ATTEMPTS,
    MAX_USER_AGENT_LENGTH,
    SOURCE_CUSTOMER_LINK,
    STATUS_ACTIVE,
    STATUS_SUBMITTED,
    clean_text,
    customer_extension,
    document_keys,
    token_hash,
    valid_token,
)

router = APIRouter(prefix="/public/upload-link", tags=["public-upload"])

# Same answer for every token that does not open an active link.
LINK_NOT_FOUND = "This link is not valid any more. Ask your loan advisor for a new one."
# Consent logs are kept as long as the uploaded documents (7 days).
CONSENT_RETENTION_SECONDS = 7 * 24 * 3600

Token = Annotated[str | None, Header(alias="x-upload-token", max_length=64)]
UserAgent = Annotated[str | None, Header(alias="user-agent")]
DocumentId = Annotated[str, Path(pattern=r"^[0-9a-f-]{36}$")]
Language = Literal["en", "hi", "mr"]


class PublicFile(BaseModel):
    document_id: str
    file_name: str
    # uploading, password_required, or a pipeline status
    status: str
    locked: bool


class PublicLink(BaseModel):
    dsa_name: str
    items: list[RequestedItem]
    language: str
    expires_at: str
    consented: bool
    consent_version: str
    file_count: int
    max_files: int
    max_file_bytes: int
    files: list[PublicFile]


class ConsentRequest(BaseModel):
    # The page's checkbox: the call is refused unless it is true.
    accepted: bool
    language: Language = "en"
    consent_version: str = Field(max_length=32)


class ConsentResponse(BaseModel):
    consented_at: str


class PublicFileRequest(BaseModel):
    file_name: str = Field(min_length=1, max_length=255)
    content_type: str = Field(min_length=1, max_length=255)
    file_size: int = Field(ge=1, le=MAX_FILE_BYTES)
    # The page found a PDF Encrypt dictionary: the file goes to the locked key
    # and waits for its password.
    encrypted: bool = False


class PublicFileResponse(BaseModel):
    document_id: str
    upload_url: str
    expires_in: int
    status: str


class PublicUnlockRequest(BaseModel):
    password: SecretStr = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)


class PublicUnlockResponse(BaseModel):
    status: str
    attempts_left: int | None = None


class SubmitResponse(BaseModel):
    status: str
    file_count: int


def _active_link(token: str | None) -> tuple[str, dict]:
    """(token hash, link) of an active, unexpired link, else 404."""
    if not valid_token(token):
        raise HTTPException(status_code=404, detail=LINK_NOT_FOUND)
    hashed = token_hash(token)
    link = get_link(hashed)
    if not link or link.get("status") != STATUS_ACTIVE or int(link.get("expires_at") or 0) <= int(time.time()):
        raise HTTPException(status_code=404, detail=LINK_NOT_FOUND)
    # The link lives in its own partition: once its project is deleted (which
    # also revokes it), it must not add files to a project nobody can see.
    if not get_project_item(link["project_id"]):
        raise HTTPException(status_code=404, detail=LINK_NOT_FOUND)
    return hashed, link


def _link_files(link: dict) -> list[PublicFile]:
    files = [
        PublicFile(
            document_id=doc.data.document_id,
            file_name=doc.data.name,
            status=doc.data.status,
            locked=doc.data.locked,
        )
        for doc in query_documents(link["project_id"])
        if doc.data.upload_link_id == link["link_id"]
    ]
    files.sort(key=lambda f: f.file_name)
    return files


@router.get("")
def get_public_link(x_upload_token: Token = None) -> PublicLink:
    """What the customer's page shows: who asks, for what, and the files sent so far."""
    _, link = _active_link(x_upload_token)
    return PublicLink(
        dsa_name=link.get("dsa_name") or get_config().dsa_name,
        items=[RequestedItem(**item) for item in link.get("items") or []],
        language=link.get("language") or "en",
        expires_at=link.get("expires_at_iso") or "",
        consented=bool(link.get("consented_at")),
        consent_version=CONSENT_VERSION,
        file_count=int(link.get("file_count") or 0),
        max_files=int(link.get("max_files") or 0),
        max_file_bytes=MAX_FILE_BYTES,
        files=_link_files(link),
    )


@router.post("/consent")
def give_consent(
    request: ConsentRequest, x_upload_token: Token = None, user_agent: UserAgent = None
) -> ConsentResponse:
    """Log the customer's DPDP consent: time, link id, user-agent, language, text version."""
    hashed, link = _active_link(x_upload_token)
    if not request.accepted:
        raise HTTPException(status_code=400, detail="Consent is needed before uploading")
    if request.consent_version != CONSENT_VERSION:
        # The page is an old copy: it showed another text.
        raise HTTPException(status_code=409, detail="Reload the page to see the current consent text")
    consented_at = datetime.now(UTC).isoformat()
    record_consent(
        hashed,
        link_id=link["link_id"],
        project_id=link["project_id"],
        consented_at=consented_at,
        user_agent=clean_text(user_agent, MAX_USER_AGENT_LENGTH),
        language=request.language,
        consent_version=CONSENT_VERSION,
        expires_at=int(time.time()) + CONSENT_RETENTION_SECONDS,
    )
    print(f"upload link consent link={link['link_id']} project={link['project_id']}")
    return ConsentResponse(consented_at=consented_at)


@router.post("/files")
def create_public_file(request: PublicFileRequest, x_upload_token: Token = None) -> PublicFileResponse:
    """One file: a document record and a 5-minute presigned PUT for its key, type and size.

    The PUT is single-use: it signs If-None-Match: * (the page sends that
    header), so the link holder cannot upload over the file again and again
    and restart the pipeline each time.
    """
    hashed, link = _active_link(x_upload_token)
    if not link.get("consented_at"):
        raise HTTPException(status_code=403, detail="Consent is needed before uploading")
    ext = customer_extension(request.file_name)
    if ext is None:
        raise HTTPException(status_code=400, detail="Only PDF files and photos (JPG, PNG, WebP) can be uploaded")
    try:
        check_upload(request.file_name, request.content_type, request.file_size, video_allowed=False)
    except PresignError as e:
        raise HTTPException(status_code=e.status, detail=e.detail) from None
    if request.encrypted and ext != "pdf":
        raise HTTPException(status_code=400, detail="Only a PDF can be password-protected")
    config = get_config()
    if not config.document_storage_bucket_name:
        raise HTTPException(status_code=503, detail="Document storage is not configured")

    # The slot is taken atomically, with the link's state and expiry checked
    # again: parallel calls cannot pass max_files, nor use a closed link.
    if reserve_file_slot(hashed, now_epoch=int(time.time())) is None:
        raise HTTPException(status_code=409, detail="No more files can be added to this link")

    project_id = link["project_id"]
    document_id = str(uuid.uuid4())
    final_key, locked_key = document_keys(project_id, document_id, ext)
    status = DOC_PASSWORD_REQUIRED if request.encrypted else "uploading"
    put_document_item(
        project_id,
        document_id,
        DocumentData(
            document_id=document_id,
            project_id=project_id,
            name=clean_text(request.file_name, 255),
            file_type=request.content_type,
            file_size=request.file_size,
            status=status,
            # Always the final key: the unlocked copy is written there.
            s3_key=final_key,
            language=link.get("language"),
            source=SOURCE_CUSTOMER_LINK,
            upload_link_id=link["link_id"],
            locked=request.encrypted,
        ),
    )
    upload_url = presign_put(
        config.document_storage_bucket_name,
        locked_key if request.encrypted else final_key,
        content_type=request.content_type,
        content_length=request.file_size,
        if_none_match=True,
    )
    print(f"upload link presign put link={link['link_id']} project={project_id} document={document_id}")
    return PublicFileResponse(
        document_id=document_id, upload_url=upload_url, expires_in=PRESIGNED_URL_EXPIRES_IN, status=status
    )


@router.post("/files/{document_id}/unlock")
def unlock_public_file(
    document_id: DocumentId, request: PublicUnlockRequest, x_upload_token: Token = None
) -> PublicUnlockResponse:
    """The password of a protected PDF from this link. It is used once and dropped."""
    _, link = _active_link(x_upload_token)
    doc = get_document_item(link["project_id"], document_id)
    # A document of another link (or project) is "not found" too.
    if not doc or doc.data.upload_link_id != link["link_id"]:
        raise HTTPException(status_code=404, detail="File not found")
    if not doc.data.locked or doc.data.status != DOC_PASSWORD_REQUIRED:
        raise HTTPException(status_code=409, detail="This file is not waiting for a password")
    if not count_unlock_attempt(link["project_id"], document_id, max_attempts=MAX_UNLOCK_ATTEMPTS):
        raise HTTPException(status_code=429, detail="Too many attempts. Your loan advisor will unlock this file.")
    status = unlock_customer_document(link["project_id"], doc, request.password.get_secret_value())
    if status == STATUS_WRONG_PASSWORD:
        used = doc.data.unlock_attempts + 1
        return PublicUnlockResponse(status=status, attempts_left=max(MAX_UNLOCK_ATTEMPTS - used, 0))
    return PublicUnlockResponse(status=status)


@router.post("/submit")
def submit_link(x_upload_token: Token = None) -> SubmitResponse:
    """The customer is done: the link is closed for good."""
    hashed, link = _active_link(x_upload_token)
    if not close_link(hashed, STATUS_SUBMITTED, at=datetime.now(UTC).isoformat()):
        raise HTTPException(status_code=404, detail=LINK_NOT_FOUND)
    print(f"upload link submitted link={link['link_id']} project={link['project_id']} files={link.get('file_count')}")
    return SubmitResponse(status=STATUS_SUBMITTED, file_count=int(link.get("file_count") or 0))
