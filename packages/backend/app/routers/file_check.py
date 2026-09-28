"""Loan-file check integration API.

Lets an external system (e.g. a DSA CRM before "send loan login") get the
deterministic READY / NOT READY verdict without the chat. The verdict comes from
the file-check Lambda (the chat's run_file_check tool); this router validates
the request, checks the project exists and returns the engine's result.
"""

import datetime as dt
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Body, Header, HTTPException, Path
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.ddb import get_project_item
from app.file_check import (
    TOOL_LIST_CHECKLISTS,
    TOOL_RUN_FILE_CHECK,
    FileCheckNotConfiguredError,
    FileCheckServiceError,
    UnknownChecklistError,
    invoke_file_check_tool,
)

router = APIRouter(prefix="/projects/{project_id}", tags=["file-check"])

Verdict = Literal["READY", "NOT READY"]

# Project ids are "proj_" + a nanoid; the pattern also keeps the value safe to log.
ProjectId = Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{1,128}$", description="Project id, e.g. proj_...")]

# Audit label of the caller. Authentication is AWS IAM (SigV4) at API Gateway;
# rejecting control characters keeps the value safe to log.
UserId = Annotated[
    str,
    Header(
        alias="x-user-id",
        pattern=r"^[^\x00-\x1f\x7f]{1,256}$",
        description=(
            "Caller id for the audit log: the web app sends the Cognito username, an "
            "integration sends its own name (e.g. `smartdial-crm`). Authentication is "
            "AWS IAM (SigV4) at API Gateway, not this header."
        ),
    ),
]


class ErrorResponse(BaseModel):
    detail: str


class UnknownChecklistDetail(BaseModel):
    message: str
    available: list[str]


class UnknownChecklistResponse(BaseModel):
    detail: UnknownChecklistDetail


_ERRORS: dict[int | str, dict[str, Any]] = {
    404: {"model": ErrorResponse, "description": "Project not found"},
    502: {"model": ErrorResponse, "description": "The file-check service failed or answered unexpectedly"},
    503: {"model": ErrorResponse, "description": "The file-check service is not configured"},
}


# ------------------------------------------------------------------ checklists
class ChecklistRule(BaseModel):
    kind: Literal["present", "monthly", "period", "manual"] = Field(
        description=(
            "present: at least min_count documents of doc_types; monthly: one document per month for "
            "the last `months` months (by `field`); period: statements covering the last `months` "
            "months (from_field..to_field); manual: cannot be verified automatically (REVIEW)"
        )
    )
    months: int | None = None
    field: str | None = None
    from_field: str | None = None
    to_field: str | None = None
    min_count: int | None = None


class ChecklistItem(BaseModel):
    id: str
    label: str
    required: bool = Field(description="A required item that is not PRESENT makes the verdict NOT READY")
    doc_types: list[str]
    rule: ChecklistRule


class Checklist(BaseModel):
    id: str = Field(description="Pass as checklist_id to POST /projects/{project_id}/file-check")
    name: str
    product: str | None = None
    applicant_type: str | None = None
    description: str | None = None
    items: list[ChecklistItem]
    consistency_checks: list[str] = Field(description="Cross-document checks this checklist runs")
    foir: dict[str, Any] | None = Field(default=None, description="The checklist's indicative FOIR policy, if any")


class ChecklistCatalog(BaseModel):
    default_checklist: str = Field(description="Checklist applied when checklist_id is omitted")
    checklists: list[Checklist]


# ------------------------------------------------------------------ file check
class FileCheckRequest(BaseModel):
    # Stripped before the length checks: a blank applicant is rejected instead of
    # silently widening the check to every applicant (the Lambda strips too).
    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
        json_schema_extra={
            "examples": [
                {"checklist_id": "salaried_personal_loan", "applicant": "Sneha Anil Kulkarni"},
                {"applicant": "CKRPK7314M"},
                {},
            ]
        },
    )

    checklist_id: str | None = Field(
        default=None,
        pattern=r"^[a-z0-9_]+$",
        max_length=64,
        description="Checklist to apply (see GET /projects/{project_id}/checklists). Default: default_checklist.",
    )
    applicant: str | None = Field(
        default=None,
        min_length=1,
        max_length=200,
        description=(
            "Check only this applicant: full name (initials and a missing middle name still match) or PAN. "
            "Default: every applicant found in the project."
        ),
    )
    reference_month: str | None = Field(
        default=None,
        pattern=r"^\d{4}-(0[1-9]|1[0-2])$",
        description=(
            "YYYY-MM month that 'last N months' rules end at. Default: the latest salary-slip month "
            "in the file (else the latest statement end)."
        ),
    )


class ChecklistRef(BaseModel):
    id: str
    name: str | None = None


class ApplicantDocument(BaseModel):
    document_id: str | None = None
    document_name: str
    doc_type: str = Field(
        description="loan_application, identity_details, salary_slip, bank_statement, form16_itr or other"
    )
    grounded: bool | None = Field(
        default=None, description="The document had a machine text layer to verify values against"
    )
    grounding_notes: list[str] = []
    unverified_fields: list[str] = Field(default=[], description="Numeric fields not found in the document text")


class ChecklistItemResult(BaseModel):
    item_id: str
    item: str
    required: bool
    status: Literal["PRESENT", "MISSING", "REVIEW"]
    ok: bool | None = Field(description="null for REVIEW (manual) items")
    detail: str = Field(description="Human-readable finding citing document names and months")
    documents: list[str] = Field(description="Names of the documents this item used")
    required_months: list[str] | None = Field(default=None, description="monthly / period items: YYYY-MM needed")
    missing_months: list[str] | None = Field(default=None, description="monthly / period items: YYYY-MM missing")


class ConsistencyResult(BaseModel):
    check_id: str
    check: str
    status: Literal["OK", "MISMATCH", "REVIEW", "N/A", "INFO"] = Field(
        description=(
            "MISMATCH makes the verdict NOT READY; REVIEW is a finding a person must look at "
            "(listed in needs_review) that does not change the verdict"
        )
    )
    detail: str
    documents: list[str]


class BankCredit(BaseModel):
    document_name: str
    date: str | None = None
    amount: float


class IncomeSummary(BaseModel):
    declared_net: float | None = Field(default=None, description="Net monthly salary declared on the application")
    slip_net: float | None = Field(default=None, description="Median net salary on the salary slips")
    slip_gross: float | None = Field(default=None, description="Median gross salary on the salary slips")
    bank_salary_credit: float | None = Field(default=None, description="Median salary credit in the bank statement")
    form16_gross: float | None = None
    slip_gross_x12: float | None = None
    bank_credits: list[BankCredit] = []


class ApplicantResult(BaseModel):
    applicant: str
    pan: str | None = None
    verdict: Verdict
    reference_month: str | None = Field(default=None, description="YYYY-MM the monthly rules ended at")
    reference_month_label: str | None = None
    documents: list[ApplicantDocument]
    checklist: list[ChecklistItemResult]
    consistency: list[ConsistencyResult]
    income: IncomeSummary
    reasons: list[str] = Field(
        description="Every reason for NOT READY, in order (MISSING / MISMATCH / REVIEW / PENDING)"
    )
    missing_items: list[str] = Field(description="What to collect from the applicant, with exact months")
    mismatches: list[str]
    needs_review: list[str] = Field(
        default=[], description="Consistency findings with status REVIEW; reported, the verdict is unchanged"
    )
    manual_review: list[str] = Field(description="Items a person must verify (not decided by the rules)")
    obligations: dict[str, Any] | None = Field(
        default=None, description="Existing obligations from the bank statement and the application, if computed"
    )
    foir: dict[str, Any] | None = Field(
        default=None, description="Indicative FOIR, if the checklist enables it; the lender's policy decides"
    )


class PendingDocument(BaseModel):
    document_id: str | None = None
    document_name: str | None = None
    status: str | None = None


class FailedDocument(BaseModel):
    document_id: str | None = None
    document_name: str | None = None


class NoFactsDocument(BaseModel):
    document_id: str | None = None
    document_name: str | None = None
    reason: str


class UnsupportedDocument(BaseModel):
    document_id: str | None = None
    document_name: str | None = None
    file_type: str | None = None
    reason: str


class UnassignedDocument(BaseModel):
    document_id: str | None = None
    document_name: str | None = None
    doc_type: str


class FileCheckResponse(BaseModel):
    project_id: str | None = None
    engine_version: str
    as_of: dt.date
    checklist: ChecklistRef
    overall_verdict: Verdict = Field(
        description="READY only when every applicant is READY and no document is still being analysed"
    )
    summary: str
    applicants: list[ApplicantResult]
    pending_documents: list[PendingDocument] = Field(description="Still being analysed: every applicant is NOT READY")
    failed_documents: list[FailedDocument]
    no_facts_documents: list[NoFactsDocument]
    unsupported_documents: list[UnsupportedDocument]
    unassigned_documents: list[UnassignedDocument]


# ------------------------------------------------------------------ helpers
def _require_project(project_id: str) -> None:
    if not get_project_item(project_id):
        raise HTTPException(status_code=404, detail="Project not found")


def _invoke[M: BaseModel](tool: str, arguments: dict[str, Any], model: type[M]) -> M:
    try:
        payload = invoke_file_check_tool(tool, arguments)
    except FileCheckNotConfiguredError as e:
        raise HTTPException(status_code=503, detail="File check is not configured") from e
    except UnknownChecklistError as e:
        raise HTTPException(status_code=400, detail={"message": str(e), "available": e.available}) from e
    except FileCheckServiceError as e:
        print(f"file-check {tool} failed: {e}")
        raise HTTPException(status_code=502, detail=f"File check failed: {e}") from e
    try:
        return model.model_validate(payload)
    except ValidationError as e:
        # Log field locations only: values could be document facts.
        print(f"file-check {tool} unexpected response at {[err['loc'] for err in e.errors()][:5]}")
        raise HTTPException(status_code=502, detail="File check returned an unexpected response") from e


# ------------------------------------------------------------------ routes
@router.get(
    "/checklists",
    response_model_exclude_none=True,
    responses=_ERRORS,
    summary="List the checklists the file check can apply",
)
def list_checklists(project_id: ProjectId, user_id: UserId) -> ChecklistCatalog:
    """Checklists (loan product x applicant type) with their items and rules."""
    _require_project(project_id)
    catalog = _invoke(TOOL_LIST_CHECKLISTS, {}, ChecklistCatalog)
    print(f"file-check checklists user={user_id} project={project_id} count={len(catalog.checklists)}")
    return catalog


@router.post(
    "/file-check",
    responses={400: {"model": UnknownChecklistResponse, "description": "Unknown checklist_id"}, **_ERRORS},
    summary="Run the deterministic loan-file check",
)
def run_file_check(
    project_id: ProjectId,
    user_id: UserId,
    request: Annotated[FileCheckRequest | None, Body()] = None,
) -> FileCheckResponse:
    """READY / NOT READY for each applicant in the project, decided by rules (no LLM).

    Findings cite document names and exact months: missing documents
    (`missing_items`, `checklist[].missing_months`), cross-document mismatches
    (PAN, name, employer, declared vs slip vs bank salary) and items that need a
    manual review. Only documents whose analysis has finished are checked; any
    document still being analysed keeps every applicant NOT READY.
    """
    _require_project(project_id)
    body = request or FileCheckRequest()
    arguments: dict[str, Any] = {"project_id": project_id, **body.model_dump(exclude_none=True)}
    result = _invoke(TOOL_RUN_FILE_CHECK, arguments, FileCheckResponse)
    print(
        f"file-check user={user_id} project={project_id} checklist={result.checklist.id} "
        f"applicants={len(result.applicants)} verdict={result.overall_verdict}"
    )
    return result
