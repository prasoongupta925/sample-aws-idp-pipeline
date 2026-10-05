"""The client's lender policy workbook (Policy.xlsx): stored for the whole app, applied to every
eligibility calculation.

One current policy, for every project. An admin uploads the workbook (app/routers/lender_policy.py);
it is read by app/policy_workbook.py (never executing a formula, refusing macro workbooks) and kept:

- in S3, the document bucket under S3_PREFIX: {upload_id}/original.xlsx (the file's bytes exactly
  as uploaded, for download) and {upload_id}/policy.json (what was read from it). The bucket expires
  its objects after the retention period (CDK context retentionDays, default 7 days), and keys
  outside projects/*/documents/* start no document processing.
- in DynamoDB, PK = APP#LENDERPOLICY, SK = CURRENT: the upload's id, file name, size, SHA-256,
  upload time, effective date, banks and warnings, and expires_at = upload time + the same
  retention period (TTL). A policy past expires_at is not used: "re-upload needed by <date>".

A new upload writes its objects, then points the header at them, then deletes the previous
upload's objects. The workbook holds lender terms only: no applicant data.

lender_policies() turns the workbook into the engine's LenderPolicy per bank, with the sheet's
grid (eligibility.SheetGrid) that prices each applicant by slab and category. A bank the app
already knows keeps the fields the sheet does not give (minimum CIBIL, maximum enquiries,
employment types, processing fee) from its SAMPLE policy; a new bank (Bandhan Bank, IndusInd
Bank) gets them from the TEMPLATE_LENDER's SAMPLE policy, without a processing fee.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
import threading
import uuid
from dataclasses import dataclass, field
from typing import Any

from app import eligibility
from app.config import get_config
from app.ddb import get_table
from app.ddb.ask_usage import TTL_ATTRIBUTE
from app.policy_workbook import MAX_FILE_BYTES, PolicyWorkbook, PolicyWorkbookError, parse_policy_workbook
from app.s3 import PRESIGNED_URL_EXPIRES_IN, get_s3_client, get_s3_presign_client

SOURCE_LABEL = "From Policy (your sheet)"
NOT_IN_SHEET_LABEL = "Sample: not in your policy sheet"
S3_PREFIX = "lender-policy/"
HEADER_KEY = {"PK": "APP#LENDERPOLICY", "SK": "CURRENT"}
# Under the backend Lambda's 6 MB request limit (also as multipart), and the parser's own limit.
MAX_UPLOAD_BYTES = min(4 * 1024 * 1024, MAX_FILE_BYTES)
XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
TEMPLATE_LENDER = "hdfc_bank"
_UNLISTED_CODE = "CAT_U"

__all__ = ["PolicyWorkbookError", "parse_policy_workbook"]


# ------------------------------------------------------------------ workbook -> lender policies
def _first(values: list[float | None], default: float, *, le: float | None = None) -> float:
    """The first positive value (within `le`), else `default`: a placeholder for the policy's flat
    fields, which the sheet's grid replaces in every calculation."""
    for v in values:
        if v is not None and v > 0 and (le is None or v <= le):
            return float(v)
    return default


def sheet_grid(workbook: PolicyWorkbook, bank) -> eligibility.SheetGrid:
    """The bank's grid as the engine takes it."""
    labels = [c.label for c in workbook.categories]
    codes = [c.code for c in workbook.categories]
    values: dict[str, dict[str, list]] = {}
    cells: dict[str, dict[str, list]] = {}
    for key in eligibility.SHEET_PARAMETERS:
        values[key] = {label: [] for label in labels}
        cells[key] = {label: [] for label in labels}
        for slab in bank.slabs:
            column = slab.values.get(key) or {}
            for code, label in zip(codes, labels, strict=True):
                v = column.get(code)
                values[key][label].append(v.value if v is not None else None)
                cells[key][label].append(v.cell if v is not None else "")
    unlisted = next((c.label for c in workbook.categories if c.code == _UNLISTED_CODE), None)
    return eligibility.SheetGrid(
        label=SOURCE_LABEL,
        bank=bank.name,
        sheet=workbook.grid_sheet,
        slab_starts=tuple(s.start for s in bank.slabs),
        categories=tuple(labels),
        codes=tuple(codes),
        unlisted_category=unlisted,
        values=values,
        cells=cells,
    )


def _lender_policy(workbook: PolicyWorkbook, bank, book: eligibility.PolicyBook) -> eligibility.LenderPolicy:
    grid = sheet_grid(workbook, bank)
    base = book.lender(bank.lender_id)
    template = base or book.lender(TEMPLATE_LENDER) or book.lenders[0]
    every = {key: [v for column in grid.values[key].values() for v in column] for key in grid.values}
    rois = [v * 100 for v in every["roi"] if v is not None and 0 < v * 100 <= 60]
    funding = max((v for v in every["max_funding"] if v), default=0) or template.max_amount
    max_tenure = int(max((v for v in every["max_tenure_months"] if v and v <= 480), default=0)) or (
        template.max_tenure_months
    )
    tenure = int(_first(every["calculation_tenure_months"], max_tenure, le=max_tenure))
    categories = {
        label: eligibility.CategoryPolicy(
            foir=_first(grid.values["foir"][label], 0.5, le=1),
            multiplier=_first(grid.values["multiplier"][label], 10, le=100),
        )
        for label in grid.categories
    }
    unlisted = (
        eligibility.UnlistedCompanyPolicy(
            accepted=True,
            foir=categories[grid.unlisted_category].foir,
            multiplier=categories[grid.unlisted_category].multiplier,
        )
        if grid.unlisted_category
        else eligibility.UnlistedCompanyPolicy(accepted=False)
    )
    first = categories[grid.categories[0]]
    return eligibility.LenderPolicy(
        id=bank.lender_id,
        name=base.name if base else bank.name,
        product=template.product,
        roi=min(rois) if rois else template.roi,
        roi_max=max(rois) if rois and max(rois) > min(rois) else None,
        foir=first.foir,
        multiplier=first.multiplier,
        min_tenure_months=min(template.min_tenure_months, tenure),
        max_tenure_months=max_tenure,
        calculation_tenure_months=tenure,
        min_amount=min(template.min_amount, funding),
        max_amount=funding,
        min_cibil_score=template.min_cibil_score,
        max_enquiries_90d=template.max_enquiries_90d,
        employment_types=template.employment_types,
        company_categories=categories,
        unlisted_company=unlisted,
        income_consideration_pct=template.income_consideration_pct,
        processing_fee=base.processing_fee if base else None,
        sheet=grid,
    )


def lender_policies(
    workbook: PolicyWorkbook, book: eligibility.PolicyBook
) -> tuple[dict[str, eligibility.LenderPolicy], list[str]]:
    """Per lender id, the bank's policy from the workbook; and the banks that could not be used, why."""
    out: dict[str, eligibility.LenderPolicy] = {}
    problems: list[str] = []
    for bank in workbook.banks:
        if not bank.slabs:
            problems.append(f"{bank.name}: no slab rows, so its sample policy is used")
            continue
        try:
            out[bank.lender_id] = _lender_policy(workbook, bank, book)
        except ValueError as e:
            problems.append(f"{bank.name} cannot be used ({e}): its sample policy is used")
    return out, problems


# ------------------------------------------------------------------ stored policy
@dataclass
class StoredPolicy:
    upload_id: str
    filename: str | None
    uploaded_at: str
    expires_at: int
    size: int
    sha256: str
    workbook: PolicyWorkbook = field(repr=False)
    _policies: dict[str, eligibility.LenderPolicy] | None = field(default=None, repr=False)

    def policies(self) -> dict[str, eligibility.LenderPolicy]:
        """Per lender id, its policy from the workbook (built once per upload)."""
        if self._policies is None:
            self._policies, problems = lender_policies(self.workbook, eligibility.load_policy_book())
            if problems:
                print(f"lender-policy: {self.upload_id} not fully used ({len(problems)} problems)")
        return self._policies

    def expires_on(self) -> str:
        return dt.datetime.fromtimestamp(self.expires_at, dt.UTC).strftime("%d %b %Y")

    def source(self) -> dict[str, Any]:
        """The `sources` entry of an answer that used this policy."""
        try:
            uploaded = dt.datetime.fromisoformat(self.uploaded_at).strftime("%d %b %Y")
        except ValueError:
            uploaded = self.uploaded_at
        detail = f"{self.filename}, uploaded {uploaded}" if self.filename else f"uploaded {uploaded}"
        return {
            "name": f"{SOURCE_LABEL} ({detail})",
            "licence": f"Your own data, deleted on {self.expires_on()}: re-upload needed by then",
            "url": None,
        }

    def status(self) -> dict[str, Any]:
        """What the UI's "Current policy" line shows."""
        return {
            "filename": self.filename,
            "uploaded_at": self.uploaded_at,
            "expires_at": dt.datetime.fromtimestamp(self.expires_at, dt.UTC).isoformat(timespec="seconds"),
            "reupload_by": self.expires_on(),
            "effective_date": self.workbook.effective_date,
            "size": self.size,
            "sha256": self.sha256,
            "banks": [b.name for b in self.workbook.banks],
            "lender_ids": [b.lender_id for b in self.workbook.banks],
            "warnings": list(self.workbook.warnings),
        }


_cache: dict[str, StoredPolicy] = {}
_cache_lock = threading.Lock()


def reset_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _bucket() -> str:
    bucket = get_config().document_storage_bucket_name
    if not bucket:
        raise RuntimeError("DOCUMENT_STORAGE_BUCKET_NAME is not set")
    return bucket


def original_key(upload_id: str) -> str:
    return f"{S3_PREFIX}{upload_id}/original.xlsx"


def parsed_key(upload_id: str) -> str:
    return f"{S3_PREFIX}{upload_id}/policy.json"


def _iso(ts: dt.datetime) -> str:
    return ts.astimezone(dt.UTC).isoformat(timespec="seconds")


def _header(now: dt.datetime) -> dict[str, Any] | None:
    """The live header item, or None (also when past expires_at but not yet removed by TTL)."""
    item = get_table().get_item(Key=HEADER_KEY, ConsistentRead=True).get("Item")
    if not item or int(item.get(TTL_ATTRIBUTE) or 0) <= int(now.timestamp()):
        return None
    return item


def _delete_objects(upload_id: str) -> None:
    s3 = get_s3_client()
    for key in (original_key(upload_id), parsed_key(upload_id)):
        s3.delete_object(Bucket=_bucket(), Key=key)


def save(data: bytes, filename: str | None, workbook: PolicyWorkbook, now: dt.datetime) -> StoredPolicy:
    """Store the workbook's bytes unchanged and what was read from it as the app's current policy."""
    bucket = _bucket()
    previous = _header(now)
    upload_id = uuid.uuid4().hex
    expires_at = int(now.timestamp()) + get_config().retention_days * 86400
    s3 = get_s3_client()
    s3.put_object(Bucket=bucket, Key=original_key(upload_id), Body=data, ContentType=XLSX_CONTENT_TYPE)
    s3.put_object(
        Bucket=bucket,
        Key=parsed_key(upload_id),
        Body=json.dumps(workbook.to_json(), ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        ContentType="application/json",
    )
    stored = StoredPolicy(
        upload_id=upload_id,
        filename=filename,
        uploaded_at=_iso(now),
        expires_at=expires_at,
        size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        workbook=workbook,
    )
    get_table().put_item(
        Item={
            **HEADER_KEY,
            "upload_id": upload_id,
            "filename": filename,
            "uploaded_at": stored.uploaded_at,
            "size": stored.size,
            "sha256": stored.sha256,
            "effective_date": workbook.effective_date,
            "banks": [b.name for b in workbook.banks],
            "warnings": len(workbook.warnings),
            TTL_ATTRIBUTE: expires_at,
        }
    )
    if previous and previous.get("upload_id"):
        _delete_objects(str(previous["upload_id"]))
    with _cache_lock:
        _cache.clear()
        _cache[upload_id] = stored
    return stored


def load(now: dt.datetime) -> StoredPolicy | None:
    """The app's live policy, or None."""
    header = _header(now)
    if header is None:
        return None
    upload_id = str(header["upload_id"])
    with _cache_lock:
        cached = _cache.get(upload_id)
    if cached is not None:
        return cached
    body = get_s3_client().get_object(Bucket=_bucket(), Key=parsed_key(upload_id))["Body"].read()
    stored = StoredPolicy(
        upload_id=upload_id,
        filename=header.get("filename"),
        uploaded_at=str(header.get("uploaded_at") or ""),
        expires_at=int(header[TTL_ATTRIBUTE]),
        size=int(header.get("size") or 0),
        sha256=str(header.get("sha256") or ""),
        workbook=PolicyWorkbook.from_json(json.loads(body)),
    )
    with _cache_lock:
        _cache.clear()
        _cache[upload_id] = stored
    return stored


def download_url(now: dt.datetime) -> tuple[str, str | None] | None:
    """A presigned GET (5 minutes) of the live policy's original file, and its name; None: no policy."""
    header = _header(now)
    if header is None:
        return None
    filename = header.get("filename")
    # The name the browser saves it as: ASCII, no quotes or path, always .xlsx.
    name = re.sub(r"[^A-Za-z0-9 ._()-]+", "_", str(filename or "policy.xlsx")).strip(" .") or "policy"
    if not name.lower().endswith(".xlsx"):
        name += ".xlsx"
    url = get_s3_presign_client().generate_presigned_url(
        "get_object",
        Params={
            "Bucket": _bucket(),
            "Key": original_key(str(header["upload_id"])),
            "ResponseContentDisposition": f'attachment; filename="{name}"',
            "ResponseContentType": XLSX_CONTENT_TYPE,
        },
        ExpiresIn=PRESIGNED_URL_EXPIRES_IN,
    )
    return url, filename


def delete(now: dt.datetime) -> bool:
    """Remove the app's policy (the sample policies apply again); False when there was none live."""
    item = get_table().get_item(Key=HEADER_KEY, ConsistentRead=True).get("Item")
    if not item:
        return False
    get_table().delete_item(Key=HEADER_KEY)
    if item.get("upload_id"):
        _delete_objects(str(item["upload_id"]))
    reset_cache()
    return int(item.get(TTL_ATTRIBUTE) or 0) > int(now.timestamp())
