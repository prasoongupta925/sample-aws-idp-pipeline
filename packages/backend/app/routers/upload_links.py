"""Staff side of the customer upload links (signed-in users, IAM auth).

- POST   /projects/{id}/upload-links            create a link (the token is returned once)
- GET    /projects/{id}/upload-links            the project's links (never a token)
- DELETE /projects/{id}/upload-links/{link_id}  revoke a link
- POST   /projects/{id}/documents/{doc}/unlock  unlock a customer's password-protected PDF

The customer side is app/routers/public_upload.py; the rules are in
app/upload_links.py.
"""

import time
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Header, HTTPException, Path
from pydantic import BaseModel, Field, SecretStr

from app.config import get_config
from app.ddb import Document, get_document_item, get_project_item, mark_project_updated
from app.ddb.client import generate_nanoid, now_iso
from app.ddb.upload_links import (
    close_link,
    get_link,
    get_pointer,
    put_link,
    query_pointers,
    set_document_fields,
    set_document_status_if,
)
from app.pdf_unlock import (
    STATUS_WRONG_PASSWORD,
    PdfUnlockNotConfiguredError,
    PdfUnlockServiceError,
    unlock_pdf,
)
from app.upload_links import (
    DEFAULT_EXPIRY_HOURS,
    DOC_PASSWORD_REQUIRED,
    ITEM_CODE_PATTERN,
    MAX_DSA_NAME_LENGTH,
    MAX_EXPIRY_HOURS,
    MAX_FILES,
    MAX_ITEMS,
    MAX_NOTE_LENGTH,
    MAX_PASSWORD_LENGTH,
    MIN_EXPIRY_HOURS,
    STATUS_ACTIVE,
    STATUS_EXPIRED,
    STATUS_REVOKED,
    clean_text,
    document_keys,
    new_token,
    token_hash,
)

router = APIRouter(prefix="/projects/{project_id}", tags=["upload-links"])

ProjectId = Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{1,128}$")]
LinkId = Annotated[str, Path(pattern=r"^ul_[A-Za-z0-9_-]{1,40}$")]
DocumentId = Annotated[str, Path(pattern=r"^[0-9a-f-]{36}$")]
_USER_ID_PATTERN = r"^[^\x00-\x1f\x7f]{1,256}$"
OptionalUserId = Annotated[str | None, Header(alias="x-user-id", pattern=_USER_ID_PATTERN)]

# app.upload_links.LANGUAGES
Language = Literal["en", "hi", "mr"]


class RequestedItem(BaseModel):
    """One requested document: a code the web app names in en/hi/mr, plus an optional note."""

    code: str = Field(pattern=ITEM_CODE_PATTERN.pattern)
    note: str | None = Field(default=None, max_length=MAX_NOTE_LENGTH)


class UploadLinkCreate(BaseModel):
    items: list[RequestedItem] = Field(min_length=1, max_length=MAX_ITEMS)
    expires_in_hours: int = Field(default=DEFAULT_EXPIRY_HOURS, ge=MIN_EXPIRY_HOURS, le=MAX_EXPIRY_HOURS)
    language: Language = "en"
    # Shown to the customer; the deployment's DSA_NAME when empty.
    dsa_name: str | None = Field(default=None, max_length=MAX_DSA_NAME_LENGTH)


class UploadLinkResponse(BaseModel):
    link_id: str
    # active, submitted, revoked or expired
    status: str
    items: list[RequestedItem]
    language: str
    dsa_name: str
    created_at: str
    created_by: str | None = None
    expires_at: str
    file_count: int
    max_files: int
    consented_at: str | None = None
    closed_at: str | None = None


class UploadLinkCreated(UploadLinkResponse):
    # The only time the token is returned: the web app puts it in the link.
    token: str


class UnlockRequest(BaseModel):
    password: SecretStr = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)


class UnlockResponse(BaseModel):
    status: str


def link_status(link: dict[str, Any], now_epoch: int | None = None) -> str:
    status = link.get("status") or STATUS_ACTIVE
    now = int(time.time()) if now_epoch is None else now_epoch
    if status == STATUS_ACTIVE and int(link.get("expires_at") or 0) <= now:
        return STATUS_EXPIRED
    return status


def link_response(link: dict[str, Any]) -> UploadLinkResponse:
    return UploadLinkResponse(
        link_id=link["link_id"],
        status=link_status(link),
        items=[RequestedItem(**item) for item in link.get("items") or []],
        language=link.get("language") or "en",
        dsa_name=link.get("dsa_name") or "",
        created_at=link.get("created_at") or "",
        created_by=link.get("created_by"),
        expires_at=link.get("expires_at_iso") or "",
        file_count=int(link.get("file_count") or 0),
        max_files=int(link.get("max_files") or MAX_FILES),
        consented_at=link.get("consented_at"),
        closed_at=link.get("closed_at"),
    )


def _require_project(project_id: str) -> None:
    if not get_project_item(project_id):
        raise HTTPException(status_code=404, detail="Project not found")


@router.post("/upload-links", status_code=201)
def create_upload_link(
    project_id: ProjectId, request: UploadLinkCreate, user_id: OptionalUserId = None
) -> UploadLinkCreated:
    """Create a customer upload link. The token is in this answer only (it is stored hashed)."""
    _require_project(project_id)
    now = datetime.now(UTC)
    expires = now + timedelta(hours=request.expires_in_hours)
    token = new_token()
    items = [
        {"code": item.code, **({"note": note} if (note := clean_text(item.note, MAX_NOTE_LENGTH)) else {})}
        for item in request.items
    ]
    link = {
        "link_id": f"ul_{generate_nanoid(16)}",
        "project_id": project_id,
        "items": items,
        "language": request.language,
        "dsa_name": clean_text(request.dsa_name, MAX_DSA_NAME_LENGTH) or get_config().dsa_name,
        "status": STATUS_ACTIVE,
        "file_count": 0,
        "max_files": MAX_FILES,
        "created_by": user_id,
        "created_at": now.isoformat(),
        "expires_at_iso": expires.isoformat(),
        # DynamoDB TTL (epoch seconds) and the expiry every call checks.
        "expires_at": int(expires.timestamp()),
    }
    put_link(token_hash(token), link)
    print(f"upload link created project={project_id} link={link['link_id']} user={user_id or '-'}")
    return UploadLinkCreated(**link_response(link).model_dump(), token=token)


@router.get("/upload-links")
def list_upload_links(project_id: ProjectId) -> list[UploadLinkResponse]:
    """The project's links, newest first (expired ones until DynamoDB TTL removes them)."""
    _require_project(project_id)
    links = []
    for pointer in query_pointers(project_id):
        link = get_link(pointer["token_hash"])
        if link and link.get("project_id") == project_id:
            links.append(link_response(link))
    links.sort(key=lambda link: link.created_at, reverse=True)
    return links


@router.delete("/upload-links/{link_id}")
def revoke_upload_link(project_id: ProjectId, link_id: LinkId, user_id: OptionalUserId = None) -> UploadLinkResponse:
    """Revoke a link at once (the customer's page stops working)."""
    pointer = get_pointer(project_id, link_id)
    link = get_link(pointer["token_hash"]) if pointer else None
    if not link or link.get("project_id") != project_id:
        raise HTTPException(status_code=404, detail="Upload link not found")
    if close_link(pointer["token_hash"], STATUS_REVOKED, at=now_iso()):
        print(f"upload link revoked project={project_id} link={link_id} user={user_id or '-'}")
    return link_response(get_link(pointer["token_hash"]) or link)


def unlock_customer_document(project_id: str, doc: Document, password: str) -> str:
    """Unlock a locked customer PDF; returns 'unlocked' or 'wrong_password'.

    Shared by the staff endpoint below and the customer page. The password is
    passed to the unlock Lambda and dropped: never stored, never logged.
    """
    data = doc.data
    if not data.locked or data.status != DOC_PASSWORD_REQUIRED:
        raise HTTPException(status_code=409, detail="This document is not waiting for a password")
    ext = data.s3_key.rsplit(".", 1)[-1]
    final_key, locked_key = document_keys(project_id, data.document_id, ext)
    if data.s3_key != final_key:
        raise HTTPException(status_code=409, detail="This document is not a customer upload")
    try:
        result = unlock_pdf(locked_key, final_key, password)
    except PdfUnlockNotConfiguredError:
        raise HTTPException(status_code=503, detail="PDF unlock is not configured") from None
    except PdfUnlockServiceError as e:
        print(f"pdf unlock failed project={project_id} document={data.document_id}: {e}")
        raise HTTPException(status_code=502, detail="The PDF could not be unlocked") from None
    if result["status"] == STATUS_WRONG_PASSWORD:
        print(f"pdf unlock wrong password project={project_id} document={data.document_id}")
        return STATUS_WRONG_PASSWORD
    # The unlocked copy is at the final key now and the pipeline has started:
    # set the fields one by one (the pipeline writes data.status too).
    set_document_fields(project_id, data.document_id, {"locked": False, "file_size": result["size"]})
    set_document_status_if(project_id, data.document_id, status="uploaded", expected=DOC_PASSWORD_REQUIRED)
    mark_project_updated(project_id)
    print(f"pdf unlocked project={project_id} document={data.document_id}")
    return result["status"]


@router.post(
    "/documents/{document_id}/unlock",
    responses={400: {"description": "Wrong password"}, 409: {"description": "Not a locked document"}},
)
def unlock_document(
    project_id: ProjectId, document_id: DocumentId, request: UnlockRequest, user_id: OptionalUserId = None
) -> UnlockResponse:
    """Staff enter the password of a customer's protected PDF (the customer skipped it)."""
    doc = get_document_item(project_id, document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    status = unlock_customer_document(project_id, doc, request.password.get_secret_value())
    if status == STATUS_WRONG_PASSWORD:
        raise HTTPException(status_code=400, detail="wrong_password")
    print(f"pdf unlock by staff project={project_id} document={document_id} user={user_id or '-'}")
    return UnlockResponse(status=status)
