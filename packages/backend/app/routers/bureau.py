"""Credit bureau pull on the CIBIL page ("Fetch credit report"), through the provider of app/bureau.py.

GET  /projects/{project_id}/eligibility/bureau        the provider (none or mock) and whether a pull is possible
POST /projects/{project_id}/eligibility/bureau/fetch  pull the applicant's credit report, with their consent

The pull answers with the CIBIL block of the report, read like an uploaded credit report (score,
enquiries, tradelines: active loans Obligate, closed ones Close), with source "bureau" and the
report date. Nothing is saved: the page puts the block in the form and PUT .../eligibility/inputs
saves it like any other input. A report the bureau does not have (no hit) answers found=false.

Consent: the request carries the applicant's consent (given, how it was taken: OTP, signed form
or recorded call, an optional reference and the purpose). It is logged BEFORE the pull, and
without a logged consent there is no pull (502). The log item: PK = PROJ#{project_id}, SK =
BUREAUPULL#{timestamp}#{consent_id}, with the consent (method, purpose, reference), the user who
recorded it, the provider, the applicant key (the SHA-256 key the ELIG# items use: no PAN or
name), the masked PAN (XXXXXX821K), the outcome (requested, then fetched, no_record or failed)
and expires_at = now + the retention period (DynamoDB TTL, default 7 days). It holds no name,
date of birth, mobile or report data.

One pull per applicant every PULL_INTERVAL_S per process (a double click must not pull, and pay
for, a report twice): 429 otherwise.
"""

import datetime as dt
import math
import re
import threading
import time
import uuid
from typing import Annotated, Any

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StringConstraints

from app import bureau
from app.config import get_config
from app.ddb import get_table
from app.ddb.ask_usage import TTL_ATTRIBUTE
from app.routers import eligibility as elig
from app.routers.file_check import ErrorResponse, ProjectId, UserId

router = APIRouter(prefix="/projects/{project_id}/eligibility/bureau", tags=["eligibility"])

PULL_SK_PREFIX = "BUREAUPULL#"
PULL_INTERVAL_S = 10
MAX_TRADELINES = 50  # as many as the CIBIL block holds
DEFAULT_PURPOSE = "Loan eligibility assessment"

# Replaced in tests.
_monotonic = time.monotonic
_pull_lock = threading.Lock()
_last_pull_at: dict[tuple[str, str], float] = {}


class _Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ConsentIn(_Input):
    given: bool = Field(description="The applicant agreed to this credit report pull (must be true)")
    method: bureau.ConsentMethod = Field(
        description="How the consent was taken: otp (OTP sent to the applicant's mobile), signed_form or recorded_call"
    )
    reference: Annotated[
        Annotated[str, StringConstraints(max_length=64, pattern=r"^[A-Za-z0-9 ._/#:-]+$")] | None,
        BeforeValidator(elig._blank_to_none),
    ] = Field(default=None, description="The consent's reference (OTP request id, form number, call id)")
    purpose: Annotated[str, StringConstraints(min_length=1, max_length=200, pattern=elig._LINE)] = Field(
        default=DEFAULT_PURPOSE, description="Why the report is pulled"
    )


class FetchRequest(_Input):
    applicant: elig.ApplicantName
    consent: ConsentIn
    pan: Annotated[str | None, BeforeValidator(elig._pan)] = Field(
        default=None,
        description="The applicant's full PAN; a masked PAN (XXXXXX234F) or none uses the applicant's own "
        "PAN (when `applicant` is the PAN)",
    )
    name: elig.OptionalName = Field(default=None, description="Name as per PAN")
    dob: elig.OptionalDate = Field(default=None, description="Date of birth, YYYY-MM-DD")
    mobile: Annotated[str | None, BeforeValidator(elig._mobile)] = Field(
        default=None, description="10-digit mobile number"
    )

    model_config = ConfigDict(
        json_schema_extra={
            "examples": [
                {
                    "applicant": "BQXPD4821K",
                    "consent": {"given": True, "method": "otp", "reference": "OTP-2026-1042"},
                    "pan": "BQXPD4821K",
                    "name": "Rahul Vijay Deshmukh",
                    "dob": "1992-02-14",
                    "mobile": "9000000101",
                }
            ]
        }
    )


class ConsentMethodOut(BaseModel):
    id: str
    label: str


class BureauStatus(BaseModel):
    provider: str = Field(description="none or mock")
    enabled: bool = Field(description="A pull is possible")
    sample: bool = Field(description="The provider returns SAMPLE (synthetic) reports")
    label: str
    detail: str | None = Field(default=None, description="Why a pull is not possible")
    consent_methods: list[ConsentMethodOut]


class FetchResponse(BaseModel):
    applicant: str
    provider: str
    sample: bool
    found: bool = Field(description="False: the bureau has no record (no hit); cibil is null")
    consent_id: str = Field(description="The logged consent (BUREAUPULL# item)")
    requested_at: str
    cibil: elig.Cibil | None = Field(
        default=None, description="The report's CIBIL block, source bureau, as PUT .../inputs takes it"
    )
    name_on_report: str | None = None
    notes: list[str] = []


_ERRORS = {
    400: {"model": ErrorResponse, "description": "No consent, or no usable PAN"},
    404: {"model": ErrorResponse, "description": "Project not found"},
    429: {"model": ErrorResponse, "description": "The applicant's report was pulled moments ago"},
    502: {"model": ErrorResponse, "description": "The consent could not be logged, or the bureau failed"},
    503: {"model": ErrorResponse, "description": "No credit bureau is connected (provider none)"},
}


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def reset_pull_limits() -> None:
    with _pull_lock:
        _last_pull_at.clear()


def _status(provider: bureau.BureauProvider) -> BureauStatus:
    return BureauStatus(
        provider=provider.name,
        enabled=provider.enabled,
        sample=provider.sample,
        label=provider.label,
        detail=provider.detail,
        consent_methods=[ConsentMethodOut(id=k, label=v) for k, v in bureau.CONSENT_METHODS.items()],
    )


def _pan_of(request: FetchRequest, applicant: str) -> str:
    """The full PAN to pull with: the request's, else the applicant's (when it is a PAN); never two."""
    given = request.pan or ""
    pans = {re.sub(r"\s", "", p).upper() for p in (given, applicant) if elig.is_full_pan(p)}
    if len(pans) > 1:
        shown = " and ".join(sorted(elig._mask_pan(p) or "" for p in pans))
        raise HTTPException(
            status_code=400,
            detail=f"Two PANs for one applicant ({shown}): correct the PAN on the Profile tab, then pull",
        )
    if not pans:
        raise HTTPException(
            status_code=400, detail="A bureau pull needs the applicant's full PAN: enter it on the Profile tab"
        )
    pan = pans.pop()
    if given and not elig.is_full_pan(given) and given[-4:] != pan[-4:]:
        raise HTTPException(
            status_code=400,
            detail=f"The PAN on the form ({given}) is not the applicant's ({elig._mask_pan(pan)}): correct it first",
        )
    return pan


def _begin_pull(key: tuple[str, str]) -> None:
    now = _monotonic()
    with _pull_lock:
        last = _last_pull_at.get(key)
        if last is not None and now - last < PULL_INTERVAL_S:
            wait = max(1, math.ceil(PULL_INTERVAL_S - (now - last)))
            raise HTTPException(
                status_code=429,
                detail=f"This applicant's credit report was just pulled: wait {wait} s",
                headers={"Retry-After": str(wait)},
            )
        if len(_last_pull_at) > 512:
            for stale in [k for k, t in _last_pull_at.items() if now - t >= PULL_INTERVAL_S]:
                del _last_pull_at[stale]
        _last_pull_at[key] = now


def _end_pull(key: tuple[str, str], pulled: bool) -> None:
    """A request that pulled nothing (consent not logged, bureau failed) may be retried at once."""
    if not pulled:
        with _pull_lock:
            _last_pull_at.pop(key, None)


def _log_consent(project_id: str, consent: bureau.Consent, provider: str, pan: str) -> dict[str, str]:
    key = {
        "PK": f"PROJ#{project_id}",
        "SK": f"{PULL_SK_PREFIX}{elig._iso(consent.recorded_at)}#{consent.consent_id}",
    }
    item: dict[str, Any] = {
        **key,
        "consent_id": consent.consent_id,
        "consent_method": consent.method,
        "consent_purpose": consent.purpose,
        "requested_at": elig._iso(consent.recorded_at),
        "requested_by": consent.recorded_by,
        "provider": provider,
        "applicant_key": elig.applicant_key(pan),
        "pan_masked": elig._mask_pan(pan),
        "outcome": "requested",
        TTL_ATTRIBUTE: int(consent.recorded_at.timestamp()) + get_config().retention_days * 86400,
    }
    if consent.reference:
        item["consent_reference"] = consent.reference
    get_table().put_item(Item=item)
    return key


def _log_outcome(key: dict[str, str], outcome: str) -> None:
    try:
        get_table().update_item(
            Key=key,
            UpdateExpression="SET outcome = :outcome",
            ConditionExpression="attribute_exists(PK)",
            ExpressionAttributeValues={":outcome": outcome},
        )
    except (ClientError, BotoCoreError) as e:
        print(f"bureau pull: outcome not logged ({type(e).__name__})")


def cibil_block(report: dict[str, Any]) -> tuple[elig.Cibil, list[str]]:
    """The CIBIL block of a normalized report, read as the CIBIL page reads an uploaded credit report
    (values it refuses dropped), with source "bureau"; and notes on what was left out."""
    notes: list[str] = []
    score = elig._checked(elig.Cibil, {"score": report.get("credit_score")})
    windows = {w: report.get(f"enquiries_{w[1:]}d") for w in elig.ENQUIRY_WINDOWS}
    enquiries = elig._checked(elig.Enquiries, windows)
    if not enquiries and any(v is not None for v in windows.values()):
        notes.append("The report's enquiries do not add up over 30, 60, 90 and 120 days: enter them by hand")
    date = elig._checked(elig.Cibil, {"report_date": report.get("report_date")})
    items = report["tradelines"]
    rows = []
    for item in items[:MAX_TRADELINES]:
        row = elig._cam_tradeline(item)
        if row:
            rows.append({**row, "source": "bureau"})
    unread = min(len(items), MAX_TRADELINES) - len(rows)
    if unread:
        notes.append(f"{unread} account(s) of the report could not be read: add them by hand")
    if len(items) > MAX_TRADELINES:
        notes.append(f"The report lists {len(items)} accounts: the first {MAX_TRADELINES} are used")
    block = elig.Cibil.model_validate(
        {
            "score": (score or {}).get("score"),
            "enquiries": enquiries or {},
            "tradelines": rows,
            "source": "bureau",
            "report_date": (date or {}).get("report_date"),
        }
    )
    return block, notes


@router.get("", responses={404: _ERRORS[404]}, summary="The credit bureau provider and whether a pull is possible")
def get_status(project_id: ProjectId, user_id: UserId) -> BureauStatus:
    elig._require_project(project_id)
    return _status(bureau.get_provider())


@router.post("/fetch", responses=_ERRORS, summary="Pull the applicant's credit report with their consent")
def fetch(project_id: ProjectId, user_id: UserId, request: FetchRequest) -> FetchResponse:
    """Logs the applicant's consent, pulls the report from the provider and answers with its CIBIL
    block (source bureau, not saved). 503 when no bureau is connected, 400 without consent or without
    the applicant's full PAN, 429 when the applicant's report was pulled moments ago."""
    elig._require_project(project_id)
    applicant = elig._applicant(request.applicant)
    provider = bureau.get_provider()
    if not provider.enabled:
        raise HTTPException(status_code=503, detail=provider.detail or bureau.NOT_CONNECTED)
    if not request.consent.given:
        raise HTTPException(
            status_code=400,
            detail="The applicant's consent is needed for a credit report pull: take it, then tick the consent box",
        )
    pan = _pan_of(request, applicant)
    slot = (project_id, elig.applicant_key(pan))
    _begin_pull(slot)
    pulled = False
    try:
        answer = _pull(project_id, user_id, request, applicant, provider, pan)
        pulled = True
        return answer
    finally:
        _end_pull(slot, pulled)


def _pull(
    project_id: str, user_id: str, request: FetchRequest, applicant: str, provider: bureau.BureauProvider, pan: str
) -> FetchResponse:
    consent = bureau.Consent(
        consent_id=uuid.uuid4().hex,
        method=request.consent.method,
        purpose=request.consent.purpose,
        recorded_at=_now(),
        recorded_by=user_id,
        reference=request.consent.reference,
    )
    try:
        log_key = _log_consent(project_id, consent, provider.name, pan)
    except (ClientError, BotoCoreError) as e:
        print(f"bureau pull: consent not logged project={project_id} ({type(e).__name__})")
        raise HTTPException(status_code=502, detail="The consent could not be logged: no report was pulled") from e

    def done(outcome: str) -> None:
        _log_outcome(log_key, outcome)
        print(
            f"bureau pull user={user_id} project={project_id} provider={provider.name} "
            f"consent={consent.consent_id} outcome={outcome}"
        )

    try:
        raw = provider.fetch_report(consent, pan, request.name, request.dob, request.mobile)
    except bureau.BureauError as e:
        done("failed")
        raise HTTPException(status_code=502, detail=f"The bureau pull failed: {str(e)[:300]}") from e
    except Exception as e:  # a provider's bug or an unexpected client error: never a 500 with its message
        print(f"bureau pull: provider error ({type(e).__name__})")
        done("failed")
        raise HTTPException(status_code=502, detail="The bureau pull failed (unexpected error)") from e
    answer: dict[str, Any] = {
        "applicant": applicant,
        "provider": provider.name,
        "sample": provider.sample,
        "consent_id": consent.consent_id,
        "requested_at": elig._iso(consent.recorded_at),
    }
    if raw is None:
        done("no_record")
        return FetchResponse(
            **answer,
            found=False,
            notes=[
                f"The bureau has no record for PAN {elig._mask_pan(pan)}: check the PAN and the date of birth on "
                "the Profile tab (an applicant new to credit has no report)"
            ],
        )
    report = bureau.normalized(raw)
    block, notes = cibil_block(report)
    done("fetched")
    on_report = elig._str(report.get("applicant_name"))
    if on_report and request.name and not elig._same_person(on_report, request.name):
        notes.insert(0, f"The report is in the name {on_report!r}, not {request.name!r}: check the PAN")
    kind = "SAMPLE report of the mock bureau (synthetic data)" if provider.sample else "Bureau report"
    when = f" of {block.report_date.isoformat()}" if block.report_date else ""
    notes.insert(
        0,
        f"{kind}{when}: active loans are marked Obligate and closed ones Close; check each loan, then save",
    )
    return FetchResponse(**answer, found=True, cibil=block, name_on_report=on_report, notes=notes)
