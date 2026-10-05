"""The client's lender policy workbook and the app-wide company list: admins only, for the whole app.

GET    /eligibility/lender-policy                       the current policy (file, upload time, effective date,
                                                        re-upload date, warnings) and the app-wide company list
POST   /eligibility/lender-policy?preview=true          read an .xlsx and show its policies and warnings, not saved
POST   /eligibility/lender-policy                       read and save it: the app's one current policy
GET    /eligibility/lender-policy/download              a 5-minute link to the original file, as uploaded
DELETE /eligibility/lender-policy                       remove it (the sample policies apply again)
POST   /eligibility/lender-policy/company-list[?preview=true]   the app-wide company_categories CSV
DELETE /eligibility/lender-policy/company-list          remove it

The workbook is read by app/policy_workbook.py: .xlsx only (a macro workbook, .xlsm, is refused),
at most lender_policy.MAX_UPLOAD_BYTES, no formula is ever executed. It is stored by
app/lender_policy.py (S3 + DynamoDB, deleted after the retention period) and used by every
project's eligibility calculation for its banks. The body is the file itself (Content-Type of an
.xlsx, or application/octet-stream) with ?filename=, or multipart/form-data with a `file` part.
The workbook and the company list hold lender terms and company names only: no applicant data,
and nothing of their content is logged.
"""

import datetime as dt
from typing import Annotated, Any

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from starlette.datastructures import UploadFile

from app import eligibility, lender_policy, reference_data
from app.caller import Caller, require_admin
from app.config import get_config
from app.ddb.ask_usage import TTL_ATTRIBUTE
from app.policy_workbook import PolicyWorkbook, PolicyWorkbookError, parse_policy_workbook
from app.routers.branches import (
    CsvErrorResponse,
    ReferenceListOut,
    _clean_filename,
    _list_out,
    _read_upload,
)
from app.routers.branches import CsvUpload as _CsvUpload
from app.routers.file_check import ErrorResponse

router = APIRouter(prefix="/eligibility/lender-policy", tags=["eligibility"])

Admin = Annotated[Caller, Depends(require_admin)]
_LINE = r"^[^\x00-\x1f\x7f]*$"
XLSX_TYPES = frozenset({"", lender_policy.XLSX_CONTENT_TYPE, "application/octet-stream", "application/zip"})
_STORAGE = {502: {"model": ErrorResponse, "description": "The storage could not be read or written"}}
_ADMIN = {403: {"model": ErrorResponse, "description": "Only admins can do this"}}


# ------------------------------------------------------------------ responses
class PolicyStatus(BaseModel):
    filename: str | None
    uploaded_at: str
    expires_at: str = Field(description="When it is deleted (the retention period): re-upload needed by then")
    reupload_by: str = Field(description='"12 Oct 2026"')
    effective_date: str | None = Field(description="The workbook's date (Sheet2!SGQ1), ISO")
    size: int
    sha256: str = Field(description="Of the original file, as stored")
    banks: list[str]
    lender_ids: list[str]
    warnings: list[str]


class PolicyCell(BaseModel):
    value: float | None
    cell: str


class PolicySlab(BaseModel):
    start: int = Field(description="Net monthly salary slab start, rupees")
    row: int
    values: dict[str, dict[str, PolicyCell]] = Field(
        description="parameter (roi, foir, multiplier, max_funding, max_tenure_months, calculation_tenure_months) "
        "-> category code -> value; ROI and FOIR as fractions"
    )


class PolicyBank(BaseModel):
    lender_id: str
    name: str
    new: bool = Field(description="Not one of the app's sample lenders (added by this policy)")
    slabs: list[PolicySlab]
    rules: dict[str, Any] | None = Field(description="Sheet2: the bank's rules, structured, and `raw` as shown")


class PolicyCategory(BaseModel):
    code: str = Field(description='As the sheet writes it: "CAT_A+"')
    label: str = Field(description='As the app shows it: "CAT A+"')


class PolicyPreview(BaseModel):
    filename: str | None
    preview: bool
    effective_date: str | None
    categories: list[PolicyCategory]
    parameters: dict[str, str] = Field(description="Parameter key -> the sheet's name")
    banks: list[PolicyBank]
    warnings: list[str] = Field(description="What to check in the file (duplicate slabs, unknown text ...)")
    notes: list[str]
    current: PolicyStatus | None = Field(description="After a save: the stored policy")


class LenderPolicyResponse(BaseModel):
    current: PolicyStatus | None = Field(description="null: no policy stored (the sample policies apply)")
    company_list: ReferenceListOut = Field(description="The app-wide company list (a project's own list comes first)")
    retention_days: int
    max_upload_bytes: int


class DownloadResponse(BaseModel):
    url: str = Field(description="Presigned GET of the original file, valid 5 minutes")
    filename: str | None


class DeletedResponse(BaseModel):
    deleted: bool


# ------------------------------------------------------------------ helpers
def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


class XlsxUpload(BaseModel):
    data: bytes
    filename: str | None


async def _read_xlsx(request: Request) -> XlsxUpload:
    """The uploaded workbook: the request body, or the `file` part of a multipart form."""
    limit = lender_policy.MAX_UPLOAD_BYTES
    content_type = request.headers.get("content-type", "").split(";")[0].strip().casefold()
    if content_type == "multipart/form-data":
        form = await request.form(max_files=1, max_fields=2)
        try:
            upload = form.get("file")
            if not isinstance(upload, UploadFile):
                raise HTTPException(status_code=400, detail="Send the workbook as the 'file' part of the form")
            return XlsxUpload(data=await upload.read(limit + 1), filename=upload.filename)
        finally:
            await form.close()
    if content_type not in XLSX_TYPES:
        raise HTTPException(status_code=415, detail="Send an Excel workbook (.xlsx)")
    return XlsxUpload(data=await request.body(), filename=None)


def _preview(workbook: PolicyWorkbook, filename: str | None, *, preview: bool) -> dict[str, Any]:
    book = eligibility.load_policy_book()
    _, problems = lender_policy.lender_policies(workbook, book)
    data = workbook.to_json()
    banks = []
    for bank in data["banks"]:
        banks.append({**bank, "new": book.lender(bank["lender_id"]) is None})
    return {
        "filename": filename,
        "preview": preview,
        "effective_date": workbook.effective_date,
        "categories": data["categories"],
        "parameters": eligibility.SHEET_PARAMETERS,
        "banks": banks,
        "warnings": [*workbook.warnings, *problems],
        "notes": workbook.notes,
        "current": None,
    }


def _status(now: dt.datetime) -> dict[str, Any] | None:
    stored = lender_policy.load(now)
    return stored.status() if stored else None


# ------------------------------------------------------------------ routes
@router.get("", responses={**_ADMIN, **_STORAGE}, summary="The current lender policy workbook and company list")
def get_policy(caller: Admin) -> LenderPolicyResponse:
    now = _now()
    try:
        current = _status(now)
        companies = reference_data.status(reference_data.APP_SCOPE, now)["company_categories"]
    except (BotoCoreError, ClientError) as e:
        print(f"lender-policy: status failed ({type(e).__name__})")
        raise HTTPException(status_code=502, detail="The policy could not be read") from e
    print(f"lender-policy status user={caller.sub} stored={current is not None}")
    return LenderPolicyResponse(
        current=current,
        company_list=_list_out("company_categories", companies),
        retention_days=get_config().retention_days,
        max_upload_bytes=lender_policy.MAX_UPLOAD_BYTES,
    )


@router.post(
    "",
    responses={
        **_ADMIN,
        **_STORAGE,
        400: {"model": ErrorResponse, "description": "The workbook cannot be read"},
        413: {"model": ErrorResponse, "description": "The file is too large"},
        415: {"model": ErrorResponse, "description": "Not an .xlsx file"},
    },
    summary="Read the lender policy workbook (.xlsx); without preview, store it as the app's policy",
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                lender_policy.XLSX_CONTENT_TYPE: {"schema": {"type": "string", "format": "binary"}},
                "multipart/form-data": {
                    "schema": {
                        "type": "object",
                        "required": ["file"],
                        "properties": {"file": {"type": "string", "format": "binary"}},
                    }
                },
            },
        }
    },
)
def upload_policy(
    caller: Admin,
    upload: Annotated[XlsxUpload, Depends(_read_xlsx)],
    filename: Annotated[str | None, Query(max_length=200, pattern=_LINE, description="The file's name, shown")] = None,
    preview: Annotated[bool, Query(description="Read the file and show it without saving it")] = False,
) -> PolicyPreview:
    """Sheet1: ROI, FOIR, multiplier, maximum funding, maximum tenure and the tenure for eligibility by bank,
    net-salary slab and company category. Sheet2: each bank's rules. The original file is kept as uploaded."""
    name = _clean_filename(filename or upload.filename) or "policy.xlsx"
    if len(upload.data) > lender_policy.MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413, detail=f"The file is over {lender_policy.MAX_UPLOAD_BYTES // (1024 * 1024)} MB"
        )
    if not name.lower().endswith(".xlsx"):
        detail = (
            "Macro-enabled workbooks (.xlsm) are not accepted: save it as .xlsx"
            if name.lower().endswith((".xlsm", ".xlsb", ".xltm"))
            else "Only .xlsx workbooks are accepted"
        )
        raise HTTPException(status_code=415, detail=detail)
    try:
        workbook = parse_policy_workbook(upload.data, name)
    except PolicyWorkbookError as e:
        print(f"lender-policy upload refused user={caller.sub} ({type(e).__name__})")
        raise HTTPException(status_code=400, detail=f"The workbook cannot be used: {e}") from e
    if not workbook.banks:
        raise HTTPException(status_code=400, detail="The workbook cannot be used: no bank rows found in the grid")
    out = _preview(workbook, name, preview=preview)
    if preview:
        print(f"lender-policy preview user={caller.sub} banks={len(workbook.banks)} warnings={len(out['warnings'])}")
        return PolicyPreview.model_validate(out)
    try:
        stored = lender_policy.save(upload.data, name, workbook, _now())
    except (BotoCoreError, ClientError, RuntimeError) as e:
        print(f"lender-policy save failed user={caller.sub} ({type(e).__name__})")
        raise HTTPException(status_code=502, detail="The policy could not be saved") from e
    print(f"lender-policy saved user={caller.sub} upload={stored.upload_id} banks={len(workbook.banks)}")
    out["current"] = stored.status()
    return PolicyPreview.model_validate(out)


@router.get(
    "/download",
    responses={**_ADMIN, **_STORAGE, 404: {"model": ErrorResponse, "description": "No policy stored"}},
    summary="A 5-minute link to the original workbook, exactly as uploaded",
)
def download_policy(caller: Admin) -> DownloadResponse:
    try:
        found = lender_policy.download_url(_now())
    except (BotoCoreError, ClientError, RuntimeError) as e:
        print(f"lender-policy download failed ({type(e).__name__})")
        raise HTTPException(status_code=502, detail="The policy could not be read") from e
    if found is None:
        raise HTTPException(status_code=404, detail="No lender policy is stored")
    print(f"lender-policy download user={caller.sub}")
    return DownloadResponse(url=found[0], filename=found[1])


@router.delete("", responses={**_ADMIN, **_STORAGE}, summary="Remove the lender policy (sample policies apply again)")
def delete_policy(caller: Admin) -> DeletedResponse:
    try:
        deleted = lender_policy.delete(_now())
    except (BotoCoreError, ClientError, RuntimeError) as e:
        print(f"lender-policy delete failed ({type(e).__name__})")
        raise HTTPException(status_code=502, detail="The policy could not be removed") from e
    print(f"lender-policy delete user={caller.sub} deleted={deleted}")
    return DeletedResponse(deleted=deleted)


@router.post(
    "/company-list",
    responses={
        **_ADMIN,
        **_STORAGE,
        400: {"model": CsvErrorResponse, "description": "The CSV has problems (all listed, up to 20)"},
        413: {"model": ErrorResponse, "description": "The file is too large"},
        415: {"model": ErrorResponse, "description": "Not a CSV file"},
    },
    summary="The app-wide company list (lender, company, category) as CSV; a project's own list comes first",
)
def upload_company_list(
    caller: Admin,
    upload: Annotated[_CsvUpload, Depends(_read_upload)],
    filename: Annotated[str | None, Query(max_length=200, pattern=_LINE, description="The file's name, shown")] = None,
    preview: Annotated[bool, Query(description="Check the file and show it without saving it")] = False,
) -> ReferenceListOut:
    if len(upload.data) > reference_data.MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413, detail=f"The file is over {reference_data.MAX_UPLOAD_BYTES // (1024 * 1024)} MB"
        )
    now = _now()
    try:
        book = reference_data.effective_book(now)
    except (BotoCoreError, ClientError, RuntimeError) as e:
        raise HTTPException(status_code=502, detail="The policy could not be read") from e
    try:
        parsed = reference_data.parse_csv("company_categories", upload.data, book)
    except reference_data.CsvError as e:
        print(f"lender-policy company list refused user={caller.sub} problems={len(e.errors)}")
        raise HTTPException(status_code=400, detail={"message": e.message, "errors": e.errors}) from e
    name = _clean_filename(filename or upload.filename)
    if preview:
        return _list_out(
            "company_categories",
            None,
            rows=len(parsed.rows),
            lenders=parsed.lenders,
            filename=name,
            duplicates=parsed.duplicates,
            notes=parsed.notes,
            preview=True,
        )
    try:
        stored = reference_data.save(reference_data.APP_SCOPE, parsed, name, now)
    except (BotoCoreError, ClientError) as e:
        print(f"lender-policy company list save failed ({type(e).__name__})")
        raise HTTPException(status_code=502, detail="The list could not be saved") from e
    print(f"lender-policy company list saved user={caller.sub} rows={len(parsed.rows)}")
    header = {
        "filename": stored.filename,
        "row_count": len(stored.rows),
        "lenders": stored.lenders,
        "uploaded_at": stored.uploaded_at,
        TTL_ATTRIBUTE: stored.expires_at,
    }
    return _list_out("company_categories", header, duplicates=parsed.duplicates, notes=parsed.notes)


@router.delete("/company-list", responses={**_ADMIN, **_STORAGE}, summary="Remove the app-wide company list")
def delete_company_list(caller: Admin) -> DeletedResponse:
    try:
        deleted = reference_data.delete(reference_data.APP_SCOPE, "company_categories", _now())
    except (BotoCoreError, ClientError) as e:
        raise HTTPException(status_code=502, detail="The list could not be removed") from e
    print(f"lender-policy company list delete user={caller.sub} deleted={deleted}")
    return DeletedResponse(deleted=deleted)
