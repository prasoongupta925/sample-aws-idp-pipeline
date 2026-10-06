"""Nearest lender branches for a pincode, and the DSA's own reference lists (CSV upload).

GET    /projects/{project_id}/eligibility/branches?pincode=&lenders=  per lender: serviceable, source, nearest branches
GET    /projects/{project_id}/eligibility/reference-data              the uploaded lists and each kind's columns
POST   /projects/{project_id}/eligibility/reference-data?kind=        upload a CSV list (replaces that kind's list)
POST   /projects/{project_id}/eligibility/reference-data?kind=&preview=true   check a CSV list and show it, not saved
DELETE /projects/{project_id}/eligibility/reference-data/{kind}       remove an uploaded list

Branches (app/branches.py) come from public open data, the India Post pincode directory
(data.gov.in, Government Open Data License - India) and RBI's bank branch list (razorpay/ifsc,
public domain), plus a few SAMPLE rows for the NBFCs that publish no list; every answer names
its sources and their licences. A distance is pincode centre to pincode centre, so "about" N
km. The DSA's own lists come first: a lender in the uploaded branch list gets those branches,
a lender in the uploaded serviceability list is serviceable exactly where it says; otherwise
serviceability is the SAMPLE pincode list the eligibility calculation uses.

Uploads (app/reference_data.py): kind = pincode_serviceability | lender_branches |
company_categories | lender_grid (a lender policy grid: the eligibility calculation uses it for
its lenders instead of the SAMPLE policy; the GET answer has its template, the sample HDFC
grid). With ?preview=true the file is checked and shown (a grid as its lender policies) but not
saved, so the UI shows a preview before Save. The body is the CSV file itself (Content-Type text/csv, or what a browser
sends for a .csv file: application/vnd.ms-excel, application/octet-stream) with ?kind= and
?filename=, or multipart/form-data with a `file` part (and a `kind` part). A list replaces the
previous list of its kind. A pincode, branch or grid list is deleted after the retention period
(default 7 days, DynamoDB TTL), or with the project; a company list holds no client data, so it
is kept until a new upload replaces it or it is removed (expires_at null in the answers). Lists
hold lender, branch, pincode and company names, no applicant data, and nothing about the
applicant is logged here.
"""

import datetime as dt
import re
from typing import Annotated, Any, Literal

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from pydantic import BaseModel, Field
from starlette.datastructures import UploadFile

from app import branches, eligibility, reference_data
from app.config import get_config
from app.ddb import get_project_item
from app.ddb.ask_usage import TTL_ATTRIBUTE
from app.routers.file_check import ErrorResponse, ProjectId, UserId

router = APIRouter(prefix="/projects/{project_id}/eligibility", tags=["eligibility"])

MAX_LENDERS = 20
_LINE = r"^[^\x00-\x1f\x7f]*$"
# What a browser or a client sends for a .csv file.
CSV_TYPES = frozenset(
    {"", "text/csv", "text/plain", "application/csv", "application/vnd.ms-excel", "application/octet-stream"}
)

SourceId = Literal["dsa_list", "public_data", "sample"]


# ------------------------------------------------------------------ responses
class BranchPlace(BaseModel):
    office: str = Field(description="The pincode's delivery post office")
    district: str
    state: str
    lat: float | None
    lon: float | None
    approximate: bool = Field(
        description="No point of its own in the directory: a point its post offices share, or its district's centre"
    )


class BranchOut(BaseModel):
    name: str
    address: str | None
    city: str | None
    district: str | None
    state: str | None
    pincode: str
    ifsc: str | None = Field(description="Banks only")
    distance_km: float = Field(description="About: pincode centre to pincode centre, 0 in the same pincode")
    approximate: bool = Field(
        default=False, description="Rougher: one of the two pincodes has no point of its own in the directory"
    )


class LenderBranches(BaseModel):
    lender: str = Field(description="The lender as asked")
    lender_id: str | None = Field(description="The policy file's id, when the lender is one of it")
    serviceable: bool | None = Field(description="null: no list covers this lender")
    source: SourceId = Field(description="dsa_list when any of this answer came from your lists")
    serviceable_source: SourceId | None
    branches_source: SourceId | None
    branches: list[BranchOut] = Field(
        description=f"Nearest first, at most {branches.MAX_BRANCHES}, within {branches.MAX_DISTANCE_KM} km"
    )
    label: str | None = Field(description="The SAMPLE label of made-up rows")
    notes: list[str]


class DataSource(BaseModel):
    name: str
    licence: str
    url: str | None


class BranchesResponse(BaseModel):
    pincode: str
    place: BranchPlace | None = Field(description="null: the pincode is not in the India Post directory")
    lenders: list[LenderBranches]
    sources: list[DataSource] = Field(description="Every data source this answer used, with its licence")
    notes: list[str]


class GridCategoryOut(BaseModel):
    foir: float = Field(description="The category's FOIR outside the grid's slabs")
    multiplier: float


class GridLenderOut(BaseModel):
    """One lender's policy as an uploaded grid gives it."""

    lender_id: str
    lender: str
    roi: float = Field(description="ROI from, percent a year (the calculation uses it)")
    roi_max: float | None
    min_cibil_score: int
    max_enquiries_90d: int
    min_tenure_months: int
    max_tenure_months: int
    calculation_tenure_months: int
    min_amount: float
    max_amount: float
    foir: float = Field(description="Base FOIR (a company not in any category)")
    multiplier: float
    processing_fee: dict[str, float | None] | None = Field(description="pct, min_amount, max_amount; null: no fee")
    categories: dict[str, GridCategoryOut]
    slab_starts: list[int] = Field(description="The FOIR grid's net monthly salary slabs (rupees); empty: no grid")
    foir_grid: dict[str, list[float]] = Field(description="Per category, one FOIR per slab")


class ReferenceListOut(BaseModel):
    kind: reference_data.Kind
    label: str
    description: str
    columns: list[str] = Field(description="Required columns")
    optional_columns: list[str]
    uploaded: bool
    filename: str | None = None
    rows: int = 0
    lenders: list[str] = []
    uploaded_at: str | None = None
    expires_at: str | None = Field(
        default=None,
        description="When the list is deleted (DynamoDB TTL); null for a company list, kept until a new upload "
        "replaces it (company names, not client data)",
    )
    duplicates: int | None = Field(default=None, description="Identical duplicate rows dropped (upload answer only)")
    notes: list[str] = Field(
        default=[], description="What to check in the accepted list, e.g. unknown pincodes (upload answer only)"
    )
    preview: bool = Field(default=False, description="Checked but not saved (?preview=true)")
    grid: list[GridLenderOut] | None = Field(
        default=None, description="lender_grid upload or preview answer: the lender policies of the file"
    )
    template: str | None = Field(default=None, description="lender_grid: a template CSV (the sample HDFC grid)")


class ReferenceDataResponse(BaseModel):
    lists: list[ReferenceListOut]
    retention_days: int
    max_upload_bytes: int
    max_rows: int


class ReferenceDeleteResponse(BaseModel):
    kind: reference_data.Kind
    deleted: bool


class CsvErrorDetail(BaseModel):
    message: str
    errors: list[str]


class CsvErrorResponse(BaseModel):
    detail: CsvErrorDetail


_NOT_FOUND = {404: {"model": ErrorResponse, "description": "Project not found"}}
_STORAGE = {502: {"model": ErrorResponse, "description": "The lists could not be read or written"}}


# ------------------------------------------------------------------ helpers
def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def _require_project(project_id: str) -> None:
    if not get_project_item(project_id):
        raise HTTPException(status_code=404, detail="Project not found")


def _iso(epoch: Any) -> str | None:
    return dt.datetime.fromtimestamp(int(epoch), dt.UTC).isoformat() if epoch else None


def _lender_names(value: str | None) -> list[str]:
    """The asked lenders, in order, once each; the policy file's lenders when none is asked."""
    if not value or not value.strip():
        return [lender.name for lender in eligibility.load_policy_book().lenders]
    names: dict[str, str] = {}
    for part in value.split(","):
        name = " ".join(part.split())
        if name:
            names.setdefault(name.casefold(), name)
    if len(names) > MAX_LENDERS:
        raise HTTPException(status_code=400, detail=f"At most {MAX_LENDERS} lenders")
    return list(names.values())


def _grid_out(rows: list[list]) -> list[GridLenderOut]:
    policies, _, _ = reference_data.grid_policies(rows, eligibility.load_policy_book())
    out = []
    for lender in policies.values():
        grid = lender.foir_grid
        out.append(
            GridLenderOut(
                lender_id=lender.id,
                lender=lender.name,
                roi=lender.roi,
                roi_max=lender.roi_max,
                min_cibil_score=lender.min_cibil_score,
                max_enquiries_90d=lender.max_enquiries_90d,
                min_tenure_months=lender.min_tenure_months,
                max_tenure_months=lender.max_tenure_months,
                calculation_tenure_months=lender.calculation_tenure,
                min_amount=lender.min_amount,
                max_amount=lender.max_amount,
                foir=lender.foir,
                multiplier=lender.multiplier,
                processing_fee=lender.processing_fee.model_dump() if lender.processing_fee else None,
                categories={
                    c: GridCategoryOut(foir=policy.foir, multiplier=policy.multiplier)
                    for c, policy in lender.company_categories.items()
                },
                slab_starts=list(grid.slab_starts) if grid else [],
                foir_grid={c: list(v) for c, v in grid.categories.items()} if grid else {},
            )
        )
    return out


def _list_out(kind: reference_data.Kind, header: dict[str, Any] | None, **extra: Any) -> ReferenceListOut:
    required, optional = reference_data.COLUMNS[kind]
    base = {
        "kind": kind,
        "label": reference_data.KIND_LABELS[kind],
        "description": reference_data.KIND_DESCRIPTIONS[kind],
        "columns": list(required),
        "optional_columns": list(optional),
        "template": reference_data.grid_template() if kind == "lender_grid" else None,
    }
    if header is None:
        return ReferenceListOut(**base, uploaded=False, **extra)
    return ReferenceListOut(
        **base,
        uploaded=True,
        filename=header.get("filename"),
        rows=int(header.get("row_count") or 0),
        lenders=[str(x) for x in header.get("lenders") or []],
        uploaded_at=header.get("uploaded_at"),
        expires_at=_iso(header.get(TTL_ATTRIBUTE)),
        **extra,
    )


def _clean_filename(name: str | None) -> str | None:
    """The file's own name (no folders, no control characters), at most 200 characters."""
    base = re.split(r"[\\/]", str(name or ""))[-1]
    base = " ".join(re.sub(r"[\x00-\x1f\x7f]", " ", base).split())[:200]
    return base or None


class CsvUpload(BaseModel):
    data: bytes
    kind: str | None
    filename: str | None


async def _read_upload(request: Request) -> CsvUpload:
    """The uploaded file: the request body, or the `file` part of a multipart form."""
    content_type = request.headers.get("content-type", "").split(";")[0].strip().casefold()
    if content_type == "multipart/form-data":
        form = await request.form(max_files=1, max_fields=4)
        try:
            upload = form.get("file")
            if not isinstance(upload, UploadFile):
                raise HTTPException(status_code=400, detail="Send the CSV file as the 'file' part of the form")
            data = await upload.read(reference_data.MAX_UPLOAD_BYTES + 1)
            kind = form.get("kind")
            return CsvUpload(data=data, kind=kind if isinstance(kind, str) else None, filename=upload.filename)
        finally:
            await form.close()
    if content_type not in CSV_TYPES:
        raise HTTPException(status_code=415, detail="Send a CSV file (Content-Type text/csv or a multipart form)")
    return CsvUpload(data=await request.body(), kind=None, filename=None)


# ------------------------------------------------------------------ routes
@router.get(
    "/branches",
    responses=_NOT_FOUND,
    summary="Nearest branch and serviceability of each lender at a pincode (public data, SAMPLE NBFC rows, your lists)",
)
def find_branches(
    project_id: ProjectId,
    user_id: UserId,
    pincode: Annotated[str, Query(pattern=r"^[1-9][0-9]{5}$", description="6-digit pincode")],
    lenders: Annotated[
        str | None,
        Query(max_length=2000, pattern=_LINE, description="Comma-separated lender names (default: every lender)"),
    ] = None,
) -> BranchesResponse:
    """Per lender: serviceable or not and from which list, and up to 3 nearest branches (name, address,
    city, district, state, pincode, IFSC for banks, about how far). Your uploaded lists come first."""
    _require_project(project_id)
    names = _lender_names(lenders)
    notes: list[str] = []
    try:
        own = reference_data.own_lists(project_id, _now())
    except (BotoCoreError, ClientError) as e:
        print(f"branches: lists unreadable project={project_id} ({type(e).__name__})")
        own = None
        notes.append("Your uploaded lists could not be read just now: this answer uses the public and sample data")
    answer = branches.find(pincode, names, own)
    answer["notes"] = notes + answer["notes"]
    found = sum(1 for row in answer["lenders"] if row["branches"])
    print(f"branches user={user_id} project={project_id} lenders={len(names)} with_branches={found}")
    return BranchesResponse.model_validate(answer)


@router.get(
    "/reference-data",
    responses={**_NOT_FOUND, **_STORAGE},
    summary="Your uploaded lists (pincode serviceability, lender branches, company categories, lender grid)",
)
def list_reference_data(project_id: ProjectId, user_id: UserId) -> ReferenceDataResponse:
    _require_project(project_id)
    try:
        headers = reference_data.status(project_id, _now())
    except (BotoCoreError, ClientError) as e:
        print(f"reference-data: status failed project={project_id} ({type(e).__name__})")
        raise HTTPException(status_code=502, detail="The lists could not be read") from e
    print(f"reference-data user={user_id} project={project_id} uploaded={sum(1 for h in headers.values() if h)}")
    return ReferenceDataResponse(
        lists=[_list_out(kind, headers[kind]) for kind in reference_data.KINDS],
        retention_days=get_config().retention_days,
        max_upload_bytes=reference_data.MAX_UPLOAD_BYTES,
        max_rows=reference_data.MAX_ROWS,
    )


@router.post(
    "/reference-data",
    responses={
        **_NOT_FOUND,
        **_STORAGE,
        400: {"model": CsvErrorResponse, "description": "The CSV has problems (all listed, up to 20)"},
        413: {"model": ErrorResponse, "description": "The file is too large"},
        415: {"model": ErrorResponse, "description": "Not a CSV file"},
    },
    summary="Upload one of your lists as CSV: replaces that kind's list, deleted after the retention period "
    "(a company list is kept until a new one replaces it)",
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "text/csv": {"schema": {"type": "string", "format": "binary"}},
                "multipart/form-data": {
                    "schema": {
                        "type": "object",
                        "required": ["file"],
                        "properties": {
                            "file": {"type": "string", "format": "binary"},
                            "kind": {"type": "string", "enum": list(reference_data.KINDS)},
                        },
                    }
                },
            },
        }
    },
)
def upload_reference_data(
    project_id: ProjectId,
    user_id: UserId,
    upload: Annotated[CsvUpload, Depends(_read_upload)],
    kind: Annotated[
        reference_data.Kind | None,
        Query(
            description="pincode_serviceability, lender_branches, company_categories or lender_grid "
            "(or the form's kind)"
        ),
    ] = None,
    filename: Annotated[str | None, Query(max_length=200, pattern=_LINE, description="The file's name, shown")] = None,
    preview: Annotated[bool, Query(description="Check the file and show it without saving it")] = False,
) -> ReferenceListOut:
    """pincode_serviceability: lender, pincode[, serviceable]. lender_branches: lender, branch, pincode[, address,
    city, district, state, ifsc]. company_categories: lender, company, category. lender_grid: lender, field,
    value[, category, slab_from] (the template is in the GET answer). A file with any bad row is refused with its
    problems; nothing is half applied."""
    _require_project(project_id)
    kind = kind or upload.kind
    if kind not in reference_data.KINDS:
        raise HTTPException(status_code=400, detail=f"kind must be one of: {', '.join(reference_data.KINDS)}")
    if len(upload.data) > reference_data.MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413, detail=f"The file is over {reference_data.MAX_UPLOAD_BYTES // (1024 * 1024)} MB"
        )
    try:
        # A company list is checked against the lenders and categories of the policy workbook too.
        book = reference_data.effective_book(_now()) if kind == "company_categories" else None
    except (BotoCoreError, ClientError) as e:
        print(f"reference-data: policy unreadable project={project_id} ({type(e).__name__})")
        book = None
    try:
        parsed = reference_data.parse_csv(kind, upload.data, book)
    except reference_data.CsvError as e:
        print(f"reference-data upload refused user={user_id} project={project_id} kind={kind} problems={len(e.errors)}")
        raise HTTPException(status_code=400, detail={"message": e.message, "errors": e.errors}) from e
    grid = _grid_out(parsed.rows) if kind == "lender_grid" else None
    if preview:
        print(f"reference-data preview user={user_id} project={project_id} kind={kind} rows={len(parsed.rows)}")
        return _list_out(
            kind,
            None,
            rows=len(parsed.rows),
            lenders=parsed.lenders,
            filename=_clean_filename(filename or upload.filename),
            duplicates=parsed.duplicates,
            notes=parsed.notes,
            preview=True,
            grid=grid,
        )
    try:
        stored = reference_data.save(project_id, parsed, _clean_filename(filename or upload.filename), _now())
    except (BotoCoreError, ClientError) as e:
        print(f"reference-data upload failed user={user_id} project={project_id} kind={kind} ({type(e).__name__})")
        raise HTTPException(status_code=502, detail="The list could not be saved") from e
    print(
        f"reference-data upload user={user_id} project={project_id} kind={kind} rows={len(parsed.rows)} "
        f"lenders={len(parsed.lenders)}"
    )
    header = {
        "filename": stored.filename,
        "row_count": len(stored.rows),
        "lenders": stored.lenders,
        "uploaded_at": stored.uploaded_at,
        TTL_ATTRIBUTE: stored.expires_at,
    }
    return _list_out(kind, header, duplicates=parsed.duplicates, notes=parsed.notes, grid=grid)


@router.delete(
    "/reference-data/{kind}",
    responses={**_NOT_FOUND, **_STORAGE},
    summary="Remove one of your uploaded lists (the public and sample data apply again)",
)
def delete_reference_data(
    project_id: ProjectId,
    user_id: UserId,
    kind: Annotated[reference_data.Kind, Path(description="The list to remove")],
) -> ReferenceDeleteResponse:
    _require_project(project_id)
    try:
        deleted = reference_data.delete(project_id, kind, _now())
    except (BotoCoreError, ClientError) as e:
        print(f"reference-data delete failed user={user_id} project={project_id} kind={kind} ({type(e).__name__})")
        raise HTTPException(status_code=502, detail="The list could not be removed") from e
    print(f"reference-data delete user={user_id} project={project_id} kind={kind} deleted={deleted}")
    return ReferenceDeleteResponse(kind=kind, deleted=deleted)
