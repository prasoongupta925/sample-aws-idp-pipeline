"""The client's lender policy workbook (Policy.xlsx): stored for the whole app, applied to every
eligibility calculation.

One current policy, for every project. An admin uploads the workbook (app/routers/lender_policy.py);
it is read by app/policy_workbook.py (never executing a formula, refusing macro workbooks) and kept:

- in S3, the document bucket under S3_PREFIX: {upload_id}/original.xlsx (the file's bytes exactly
  as uploaded, for download) and {upload_id}/policy.json (what was read from it). Keys outside
  projects/*/documents/* start no document processing, and the daily retention sweep deletes only
  expired documents, so these objects stay.
- in DynamoDB, PK = APP#LENDERPOLICY, SK = CURRENT: the upload's id, file name, size, SHA-256,
  upload time, effective date, banks and warnings. No TTL: the workbook holds lender terms, not
  client data, so it is kept until a new upload replaces it or an admin removes it (the 7-day rule
  is for client data). An older header that still has a TTL in the past is not used.

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
import gzip
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

SOURCE_LABEL = eligibility.SHEET_SOURCE_LABEL
NOT_IN_SHEET_LABEL = eligibility.NOT_IN_SHEET_LABEL
S3_PREFIX = "lender-policy/"
HEADER_KEY = {"PK": "APP#LENDERPOLICY", "SK": "CURRENT"}
# Under the backend Lambda's 6 MB request limit (also as multipart), and the parser's own limit.
MAX_UPLOAD_BYTES = min(4 * 1024 * 1024, MAX_FILE_BYTES)
XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
TEMPLATE_LENDER = eligibility.SHEET_TEMPLATE_LENDER
# The header also carries the parsed policy, gzipped, for the chat's eligibility tool (the File Check
# MCP Lambda reads this table only, not S3), when it fits well under DynamoDB's 400 KB item limit.
HEADER_POLICY_ATTRIBUTE = "policy_json_gz"
MAX_HEADER_POLICY_BYTES = 300 * 1024

__all__ = ["PolicyWorkbookError", "parse_policy_workbook"]


# ------------------------------------------------------------------ workbook -> lender policies
def sheet_grid(workbook: PolicyWorkbook, bank) -> eligibility.SheetGrid:
    """The bank's grid (and Sheet2 rules) as the engine takes it."""
    return eligibility.sheet_grid(workbook.to_json(), _bank_json(workbook, bank))


def _bank_json(workbook: PolicyWorkbook, bank) -> dict:
    return next(b for b in workbook.to_json()["banks"] if b["lender_id"] == bank.lender_id)


def lender_policies(
    workbook: PolicyWorkbook, book: eligibility.PolicyBook
) -> tuple[dict[str, eligibility.LenderPolicy], list[str]]:
    """Per lender id, the bank's policy from the workbook; and the banks that could not be used, why.
    The same builder (eligibility.sheet_lenders) as the chat's tool, from the same JSON."""
    return eligibility.sheet_lenders(workbook.to_json(), book)


# ------------------------------------------------------------------ stored policy
@dataclass
class StoredPolicy:
    upload_id: str
    filename: str | None
    uploaded_at: str
    expires_at: int | None
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

    def expires_on(self) -> str | None:
        if self.expires_at is None:
            return None
        return dt.datetime.fromtimestamp(self.expires_at, dt.UTC).strftime("%d %b %Y")

    def source(self) -> dict[str, Any]:
        """The `sources` entry of an answer that used this policy."""
        return {
            "name": eligibility.sheet_source_name(self.filename, self.uploaded_at),
            "licence": (
                "Your own bank rules (no client data): kept until you upload a new sheet"
                if self.expires_at is None
                else f"Your own data, deleted on {self.expires_on()}: re-upload needed by then"
            ),
            "url": None,
        }

    def status(self) -> dict[str, Any]:
        """What the UI's "Current policy" line shows."""
        return {
            "filename": self.filename,
            "uploaded_at": self.uploaded_at,
            "expires_at": None
            if self.expires_at is None
            else dt.datetime.fromtimestamp(self.expires_at, dt.UTC).isoformat(timespec="seconds"),
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
    """The live header item, or None (also an older header whose TTL has passed, not yet removed)."""
    item = get_table().get_item(Key=HEADER_KEY, ConsistentRead=True).get("Item")
    if not item or _ttl_passed(item, now):
        return None
    return item


def _ttl_passed(item: dict[str, Any], now: dt.datetime) -> bool:
    """True for an older header written with a TTL that has passed; a header without one stays."""
    ttl = item.get(TTL_ATTRIBUTE)
    return ttl is not None and int(ttl) <= int(now.timestamp())


def _delete_objects(upload_id: str) -> None:
    s3 = get_s3_client()
    for key in (original_key(upload_id), parsed_key(upload_id)):
        s3.delete_object(Bucket=_bucket(), Key=key)


def save(data: bytes, filename: str | None, workbook: PolicyWorkbook, now: dt.datetime) -> StoredPolicy:
    """Store the workbook's bytes unchanged and what was read from it as the app's current policy."""
    bucket = _bucket()
    previous = _header(now)
    upload_id = uuid.uuid4().hex
    s3 = get_s3_client()
    parsed = json.dumps(workbook.to_json(), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    s3.put_object(Bucket=bucket, Key=original_key(upload_id), Body=data, ContentType=XLSX_CONTENT_TYPE)
    s3.put_object(Bucket=bucket, Key=parsed_key(upload_id), Body=parsed, ContentType="application/json")
    packed = gzip.compress(parsed, mtime=0)
    stored = StoredPolicy(
        upload_id=upload_id,
        filename=filename,
        uploaded_at=_iso(now),
        expires_at=None,
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
            **({HEADER_POLICY_ATTRIBUTE: packed} if len(packed) <= MAX_HEADER_POLICY_BYTES else {}),
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
        expires_at=None if header.get(TTL_ATTRIBUTE) is None else int(header[TTL_ATTRIBUTE]),
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
    return not _ttl_passed(item, now)
