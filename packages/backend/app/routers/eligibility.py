"""Loan eligibility per lender: the CIBIL page of a loan file (profile, CIBIL, eligibility).

GET  /projects/{project_id}/eligibility/lenders             SAMPLE lender policies and the form's choices
GET  /projects/{project_id}/eligibility/pincodes/{pincode}  "Check Availability": the lenders serving a pincode
GET  /projects/{project_id}/eligibility/companies?name=     "Check Category": a company's category per lender
GET  /projects/{project_id}/eligibility/inputs?applicant=   saved inputs, else a draft pre-filled from the file check
PUT  /projects/{project_id}/eligibility/inputs              save one applicant's inputs
POST /projects/{project_id}/eligibility/calculate           eligibility at every lender
POST /projects/{project_id}/eligibility/login               record a login request; notify the CRM webhook

Every number comes from app/eligibility.py (fixed formulas, never a model). Every lender
policy, pincode list and company category is SAMPLE data (app/data), labelled "sample
policy — replace with your lender grid" wherever it is returned, and every result is
indicative: the lender decides. Choices (employment type, loan type, BT / Obligate / Close
...) are returned as ids (private_limited, bt) and accepted as ids or labels in any case.

The CIBIL block is entered by hand for now; its shape is the one a bureau pull fills
(cibil.source "bureau", tradelines with source "bureau"), so an integration can write it
with PUT .../inputs unchanged.

Storage (DynamoDB, deleted by TTL on expires_at, and with the project):
- inputs: PK = PROJ#{project_id}, SK = ELIG#{key}, where key is a SHA-256 of the
  applicant's PAN or normalised name (so the key does not show them; it is not
  anonymous: the item itself holds the PAN, name and the other inputs), with applicant,
  inputs, created_at, updated_at and expires_at = first save + the retention period
  (default 7 days); later saves do not extend it, so nothing is kept longer. Erasing
  the applicant (POST .../applicants/erase) deletes these items at once.
- login requests: PK = PROJ#{project_id}, SK = LOGINREQ#{timestamp}#{uuid} with the lender
  id and the webhook outcome only (no applicant data, no amounts), same TTL.

The file check (the file-check Lambda, as POST .../file-check) supplies the verified net
salary (the lower of the salary slips' median net pay and the bank salary credits'
median), the loan EMIs seen in the bank statement, and the draft's pre-fill (name, masked
PAN, employer, DOB when extracted, loan amount and tenure from the application, bank EMIs
as suggested tradelines). Without it (not configured, failed, no or several matching
applicants) the entered values are used and the answer says so.

POST .../login recomputes the lender's figures from the saved inputs (never from the
request), refuses a lender that is not eligible (409) and, when the project's CRM webhook
is enabled, sends event file_login.requested through the webhook delivery Lambda, signed
like every delivery, with results = [{applicant, lender, eligible_amount, emi,
tenure_months, roi, note}].
"""

import datetime as dt
import hashlib
import json
import math
import re
import threading
import time
import uuid
from collections.abc import Iterable
from decimal import Decimal
from typing import Annotated, Any, Literal

from boto3.dynamodb.conditions import Key
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, HTTPException, Path, Query
from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    field_validator,
    model_validator,
)

from app import eligibility
from app.config import get_config
from app.ddb import get_project_item, get_table
from app.ddb.ask_usage import TTL_ATTRIBUTE
from app.ddb.facts import query_facts
from app.ddb.webhooks import get_webhook_settings
from app.ddb.workflows import _decimal_to_python
from app.file_check import (
    TOOL_RUN_FILE_CHECK,
    FileCheckNotConfiguredError,
    FileCheckServiceError,
    UnknownChecklistError,
    invoke_file_check_tool,
)
from app.routers.file_check import ErrorResponse, ProjectId, UserId
from app.safe_ids import safe_segment
from app.webhook_delivery import get_webhook_lambda_client

router = APIRouter(prefix="/projects/{project_id}/eligibility", tags=["eligibility"])

INPUTS_SK_PREFIX = "ELIG#"
LOGIN_SK_PREFIX = "LOGINREQ#"
EVENT_LOGIN = "file_login.requested"
# One login per applicant and lender every LOGIN_INTERVAL_S (a double click must not log the
# file in twice), and only a few webhook calls (up to ~25 s each) at a time per process.
LOGIN_INTERVAL_S = 10
MAX_CONCURRENT_LOGINS = 3
MAX_AMOUNT = 1_000_000_000

_PAN_RE = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$")
_MASKED_PAN_RE = re.compile(r"^X{6}[0-9]{3}[A-Z]$")
_LINE = r"^[^\x00-\x1f\x7f]*$"
_MULTILINE = r"^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$"

# Replaced in tests.
_monotonic = time.monotonic
_login_lock = threading.Lock()
_last_login_at: dict[tuple[str, str, str], float] = {}
_running_logins = 0


# ------------------------------------------------------------------ input types
def _blank_to_none(value: Any) -> Any:
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return value


def _vocabulary(choices: dict[str, str], aliases: dict[str, str] | None = None, suffixes: tuple[str, ...] = ()):
    """Accept an id or a label (any case): 'Private Limited' -> 'private_limited'."""

    def parse(value: Any) -> Any:
        value = _blank_to_none(value)
        if value is None:
            return None
        found = eligibility.enum_id(value, choices, aliases, suffixes)
        if found is None:
            raise ValueError(f"must be one of: {', '.join(choices)}")
        return found

    return BeforeValidator(parse)


def _pan(value: Any) -> Any:
    value = _blank_to_none(value)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("must be a string")
    pan = re.sub(r"\s", "", value).upper()
    if not (_PAN_RE.match(pan) or _MASKED_PAN_RE.match(pan)):
        raise ValueError("must be a PAN such as ABCDE1234F (or the masked PAN of a pre-fill, XXXXXX234F)")
    return pan


def _mobile(value: Any) -> Any:
    value = _blank_to_none(value)
    if value is None:
        return None
    if isinstance(value, int) and not isinstance(value, bool):
        value = str(value)
    if not isinstance(value, str):
        raise ValueError("must be a string")
    digits = re.sub(r"[\s-]", "", value)
    if digits.startswith("+91"):
        digits = digits[3:]
    elif len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    if not re.fullmatch(r"[6-9][0-9]{9}", digits):
        raise ValueError("must be a 10-digit Indian mobile number")
    return digits


def _pincode(value: Any) -> Any:
    value = _blank_to_none(value)
    if value is None:
        return None
    if isinstance(value, int) and not isinstance(value, bool):
        value = str(value)
    if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]{5}", re.sub(r"\s", "", value)):
        raise ValueError("must be a 6-digit pincode")
    return re.sub(r"\s", "", value)


def _past_date(value: dt.date | None) -> dt.date | None:
    """Not after today (in the user's time zone: UTC + 1 day of slack, so today in IST passes)."""
    latest = (dt.datetime.now(dt.UTC) + dt.timedelta(days=1)).date()
    if value is not None and not dt.date(1900, 1, 1) <= value <= latest:
        raise ValueError("must not be a future date")
    return value


def _finite(value: Any) -> Any:
    """NaN and infinity (json.loads accepts them) become strings, so that their 422 error renders as JSON."""
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    return value


Money = Annotated[Annotated[float, Field(ge=0, le=MAX_AMOUNT, allow_inf_nan=False)], BeforeValidator(_finite)]
Count = Annotated[Annotated[int, Field(ge=0, le=999)], BeforeValidator(_finite)]
Score = Annotated[Annotated[int, Field(ge=300, le=900)], BeforeValidator(_finite)]
InstalmentCount = Annotated[Annotated[int, Field(ge=0, le=600)], BeforeValidator(_finite)]
TenureMonths = Annotated[Annotated[int, Field(ge=1, le=480)], BeforeValidator(_finite)]
OptionalName = Annotated[
    Annotated[str, StringConstraints(max_length=200, pattern=_LINE)] | None, BeforeValidator(_blank_to_none)
]
OptionalLender = Annotated[
    Annotated[str, StringConstraints(max_length=100, pattern=_LINE)] | None, BeforeValidator(_blank_to_none)
]
OptionalAddress = Annotated[
    Annotated[str, StringConstraints(max_length=300, pattern=_MULTILINE)] | None, BeforeValidator(_blank_to_none)
]
OptionalDate = Annotated[dt.date | None, BeforeValidator(_blank_to_none)]
AccountNumber = Annotated[
    Annotated[str, StringConstraints(max_length=30, pattern=r"^[A-Za-z0-9 ./-]+$")] | None,
    BeforeValidator(_blank_to_none),
]

EmploymentTypeId = Literal[
    "defence",
    "government",
    "grade_4",
    "llp",
    "merchant_navy",
    "partnership_proprietorship",
    "private_limited",
    "public_limited",
]
LoanTypeId = Literal["personal", "home", "mortgage", "car", "education", "application", "consumer", "credit_card"]
TradelineActionId = Literal["bt", "obligate", "close"]
TradelineStatusId = Literal[
    "active", "closed", "settled", "written_off", "suit_filed", "wilful_default", "restructured"
]
TradelineSourceId = Literal["manual", "bureau", "bank_statement"]
CibilSourceId = Literal["manual", "bureau"]
OtherIncomeTypeId = Literal["rented", "bonus", "incentive", "pension"]
IncomeFrequencyId = Literal["yearly", "half_yearly", "quarterly", "monthly"]
RentAgreementId = Literal["notary", "registered"]
HouseOwnershipId = Literal["owned", "rented"]
LenderStatus = Literal["eligible", "not_serviceable", "not_eligible"]
SourceId = Literal["policy", "formula", "table"]


class _Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class OtherIncome(_Input):
    type: Annotated[
        OtherIncomeTypeId,
        _vocabulary(eligibility.OTHER_INCOME_TYPES, eligibility.OTHER_INCOME_ALIASES, ("_income",)),
    ] = Field(description="rented, bonus, incentive or pension (labels such as 'Rented Income' are accepted)")
    amount: Money | None = Field(
        default=None, description="Rupees per `frequency` (rented income and pension: per month unless given)"
    )
    frequency: Annotated[
        IncomeFrequencyId | None, _vocabulary(eligibility.INCOME_FREQUENCIES, eligibility.INCOME_FREQUENCY_ALIASES)
    ] = Field(
        default=None,
        description="yearly, half_yearly, quarterly or monthly. Bonus and incentive without it count as yearly "
        "(the lowest); rented income and pension as monthly.",
    )
    agreement: Annotated[
        RentAgreementId | None, _vocabulary(eligibility.RENT_AGREEMENTS, eligibility.RENT_AGREEMENT_ALIASES)
    ] = Field(
        default=None,
        description="Rented income only: notary or registered agreement (without it: notary, the lower share)",
    )

    @model_validator(mode="after")
    def _agreement_only_for_rent(self):
        if self.type != "rented":
            self.agreement = None
        return self


class Profile(_Input):
    pan: Annotated[str | None, BeforeValidator(_pan)] = Field(
        default=None, description="PAN (ABCDE1234F), or the masked PAN of a pre-fill (XXXXXX234F)"
    )
    name: OptionalName = Field(default=None, description="Name as per PAN")
    mobile: Annotated[str | None, BeforeValidator(_mobile)] = Field(
        default=None, description="10-digit mobile number (+91 / 0 prefix accepted)"
    )
    dob: OptionalDate = Field(default=None, description="Date of birth, YYYY-MM-DD")
    house_ownership: Annotated[
        HouseOwnershipId | None, _vocabulary(eligibility.HOUSE_OWNERSHIP, eligibility.HOUSE_OWNERSHIP_ALIASES)
    ] = None
    pincode: Annotated[str | None, BeforeValidator(_pincode)] = Field(
        default=None, description="6-digit pincode of the current address (checked against each lender's list)"
    )
    current_address: OptionalAddress = None
    permanent_address: OptionalAddress = None
    company: OptionalName = Field(default=None, description="Employer (its category is looked up per lender)")
    employment_type: Annotated[
        EmploymentTypeId | None, _vocabulary(eligibility.EMPLOYMENT_TYPES, eligibility.EMPLOYMENT_TYPE_ALIASES)
    ] = None
    net_income: Money | None = Field(
        default=None, description="Net monthly salary; a salary verified by the file check is used instead"
    )
    other_income: list[OtherIncome] = Field(default=[], max_length=10)

    @field_validator("dob")
    @classmethod
    def _dob_in_past(cls, value: dt.date | None) -> dt.date | None:
        return _past_date(value)


class Enquiries(_Input):
    """Cumulative bureau enquiries: enquiries in the last 30, 60, 90 and 120 days."""

    d30: Count | None = None
    d60: Count | None = None
    d90: Count | None = Field(default=None, description="Checked against each lender's limit")
    d120: Count | None = None

    @model_validator(mode="after")
    def _cumulative(self):
        known = [(k, getattr(self, k)) for k in ("d30", "d60", "d90", "d120") if getattr(self, k) is not None]
        for (first, a), (second, b) in zip(known, known[1:], strict=False):
            if a > b:
                raise ValueError(f"enquiries are cumulative: {first} ({a}) cannot be more than {second} ({b})")
        return self


class Tradeline(_Input):
    loan_type: Annotated[
        LoanTypeId | None, _vocabulary(eligibility.LOAN_TYPES, eligibility.LOAN_TYPE_ALIASES, ("_loan",))
    ] = None
    lender: OptionalLender = Field(default=None, description="Lender name (manual entry; a bureau pull fills it)")
    sanction_amount: Money | None = None
    outstanding: Money | None = Field(default=None, description="Needed for BT: the balance-transfer amount")
    emi: Money | None = Field(default=None, description="Monthly EMI; needed for Obligate")
    status: Annotated[
        TradelineStatusId | None,
        _vocabulary(eligibility.TRADELINE_STATUSES, eligibility.TRADELINE_STATUS_ALIASES),
    ] = None
    account_number: AccountNumber = None
    overdue: Money | None = None
    emis_paid: InstalmentCount | None = None
    emis_pending: InstalmentCount | None = None
    open_date: OptionalDate = None
    last_payment_date: OptionalDate = None
    action: Annotated[
        TradelineActionId, _vocabulary(eligibility.TRADELINE_ACTIONS, eligibility.TRADELINE_ACTION_ALIASES)
    ] = Field(
        default="obligate",
        description="bt: the new lender takes over the outstanding; obligate: it keeps running (its EMI is an "
        "obligation); close: closed before disbursal",
    )
    source: Annotated[TradelineSourceId, _vocabulary(eligibility.TRADELINE_SOURCES)] = Field(
        default="manual", description="manual, bureau (a bureau pull) or bank_statement (suggested by the pre-fill)"
    )

    @field_validator("open_date", "last_payment_date")
    @classmethod
    def _dates_in_past(cls, value: dt.date | None) -> dt.date | None:
        return _past_date(value)

    @model_validator(mode="after")
    def _date_order(self):
        if self.open_date and self.last_payment_date and self.last_payment_date < self.open_date:
            raise ValueError("last_payment_date is before open_date")
        return self


class Cibil(_Input):
    score: Score | None = Field(default=None, description="CIBIL score, 300-900")
    enquiries: Enquiries = Field(default_factory=Enquiries)
    tradelines: list[Tradeline] = Field(default=[], max_length=50)
    source: Annotated[CibilSourceId, _vocabulary(eligibility.CIBIL_SOURCES)] = Field(
        default="manual", description="manual now; bureau when a CIBIL pull fills this block"
    )
    report_date: OptionalDate = None

    @field_validator("report_date")
    @classmethod
    def _report_in_past(cls, value: dt.date | None) -> dt.date | None:
        return _past_date(value)


class Loan(_Input):
    amount: Money | None = Field(default=None, description="Loan amount requested, rupees")
    tenure_months: TenureMonths | None = Field(
        default=None, description="Requested tenure; each lender calculates at most at its max tenure"
    )


class EligibilityInputs(_Input):
    profile: Profile = Field(default_factory=Profile)
    cibil: Cibil = Field(default_factory=Cibil)
    loan: Loan = Field(default_factory=Loan)


ApplicantName = Annotated[
    str,
    Field(
        min_length=1,
        max_length=200,
        description="The applicant: PAN (preferred) or name as the file check shows it; the same value finds "
        "the saved inputs again",
    ),
]


class SaveInputsRequest(EligibilityInputs):
    applicant: ApplicantName

    model_config = ConfigDict(
        json_schema_extra={
            "examples": [
                {
                    "applicant": "Rahul Vijay Deshmukh",
                    "profile": {
                        "name": "Rahul Vijay Deshmukh",
                        "pincode": "411045",
                        "company": "Konkan Softworks Pvt Ltd",
                        "employment_type": "private_limited",
                        "net_income": 82500,
                        "other_income": [{"type": "rented", "agreement": "registered", "amount": 12000}],
                    },
                    "cibil": {
                        "score": 772,
                        "enquiries": {"d30": 0, "d60": 1, "d90": 1, "d120": 2},
                        "tradelines": [
                            {
                                "loan_type": "car",
                                "lender": "Mulshi Auto Finance",
                                "sanction_amount": 450000,
                                "outstanding": 210000,
                                "emi": 8200,
                                "status": "active",
                                "action": "obligate",
                            }
                        ],
                    },
                    "loan": {"amount": 600000, "tenure_months": 48},
                }
            ]
        }
    )


class CalculateRequest(_Input):
    applicant: ApplicantName
    inputs: EligibilityInputs | None = Field(
        default=None, description="Calculate these (not saved); default: the applicant's saved inputs"
    )


class LoginRequest(_Input):
    applicant: ApplicantName
    lender: str = Field(min_length=1, max_length=100, description="Lender id (icici_bank) or name (ICICI Bank)")


# ------------------------------------------------------------------ responses
class Option(BaseModel):
    id: str
    label: str


class FormOptions(BaseModel):
    employment_types: list[Option]
    house_ownership: list[Option]
    other_income_types: list[Option]
    income_frequencies: list[Option]
    rent_agreements: list[Option]
    loan_types: list[Option]
    tradeline_actions: list[Option]
    tradeline_statuses: list[Option]
    sources: list[Option] = Field(description="The sheet's legend: From Policy, Formula Calculation, From Table")


class CategoryPolicyOut(BaseModel):
    foir: float
    multiplier: float


class UnlistedCompanyOut(BaseModel):
    accepted: bool
    foir: float | None = None
    multiplier: float | None = None


class LenderPolicyOut(BaseModel):
    id: str
    name: str
    product: str | None = None
    roi: float = Field(description="Annual rate of interest, percent")
    foir: float = Field(description="Base FOIR (fraction of the monthly income); a company category may override it")
    multiplier: float = Field(description="Base income multiplier; a company category may override it")
    min_tenure_months: int
    max_tenure_months: int
    min_amount: float
    max_amount: float
    min_cibil_score: int
    max_enquiries_90d: int
    employment_types: list[str]
    company_categories: dict[str, CategoryPolicyOut]
    unlisted_company: UnlistedCompanyOut
    income_consideration_pct: dict[str, float] = Field(
        description="Percent of each other income counted: rented_notary, rented_registered, bonus, incentive, pension"
    )
    serviceable_regions: list[str]
    sample: bool
    label: str | None = Field(description='"sample policy — replace with your lender grid" for SAMPLE data')


class LendersResponse(BaseModel):
    sample: bool
    label: str | None
    version: str
    lenders: list[LenderPolicyOut]
    options: FormOptions
    disclaimers: list[str]


class PincodeLender(BaseModel):
    lender_id: str
    lender: str
    serviceable: bool


class PincodeResponse(BaseModel):
    pincode: str
    region: str | None = Field(description="SAMPLE region the pincode is in, if any")
    serviceable_by: int
    lenders: list[PincodeLender]
    sample: bool
    label: str | None


class CompanyCategory(BaseModel):
    lender_id: str
    lender: str
    category: str | None = Field(description="The company's category with this lender; null when unlisted")
    listed: bool
    accepted: bool = Field(description="Listed, or unlisted and the lender takes unlisted companies")
    foir: float | None
    multiplier: float | None


class CompanyMatch(BaseModel):
    name: str
    aliases: list[str]
    employment_type: str | None
    synthetic: bool = Field(description="A fictional employer of the demo applicants")


class CompanyResponse(BaseModel):
    query: str
    match: CompanyMatch | None = Field(description="The listed company the name is (legal suffixes ignored)")
    categories: list[CompanyCategory] = Field(description="Per lender: its category, or its unlisted-company policy")
    suggestions: list[str] = Field(description="Listed companies whose name contains the query")
    sample: bool
    label: str | None


class Prefill(BaseModel):
    available: bool = Field(description="The file check found exactly one matching applicant")
    detail: str
    applicant_name: str | None = None
    pan_masked: str | None = None
    employer: str | None = None
    verified_net_income: float | None = None
    income_source: str | None = None
    dob: dt.date | None = None
    suggested_tradelines: int = 0
    documents: int = 0


class InputsResponse(BaseModel):
    applicant: str
    saved: bool = Field(description="The inputs were saved (else a draft, pre-filled when possible)")
    inputs: EligibilityInputs
    from_documents: list[str] = Field(
        description="Fields the draft took from the documents: name, pan, company, employment_type, net_income, "
        "dob, loan_amount, tenure_months, tradelines"
    )
    prefill: Prefill | None = Field(description="How the draft was pre-filled; null for saved inputs")
    created_at: str | None = None
    updated_at: str | None = None
    expires_at: str | None = Field(default=None, description="When the saved inputs are deleted (DynamoDB TTL)")
    notes: list[str] = []
    label: str | None = None


class OtherIncomeConsidered(BaseModel):
    type: str
    label: str
    agreement: str | None
    frequency: str
    monthly_amount: float
    consideration_pct: float
    considered: float


class LenderEligibility(BaseModel):
    lender: str
    lender_id: str
    status: LenderStatus
    status_label: str = Field(description="Eligible, Not serviceable or Not eligible")
    reasons: list[str] = Field(description="Why not eligible / not serviceable (empty when eligible)")
    notes: list[str] = Field(description="Remarks that do not change the status")
    eligible_amount: float = Field(
        description="min(FOIR eligibility, multiplier eligibility, max_amount), to the paisa; 0 unless eligible"
    )
    computed_amount: float | None = Field(description="What the formulas give, whatever the status")
    tenure_months: int = Field(description="The lender's max tenure: the EMI is shown at it")
    roi: float = Field(description="Annual rate, percent")
    emi: float = Field(description="EMI of eligible_amount at roi over tenure_months; 0 unless eligible")
    calculation_tenure_months: int = Field(description="Requested tenure capped at the lender's max")
    emi_at_calculation_tenure: float = Field(description="EMI of eligible_amount over calculation_tenure_months")
    per_lakh_emi: float
    foir_eligibility: float | None
    multiplier_eligibility: float | None
    income_considered: float | None = Field(description="Net salary + other income at this lender's consideration %")
    other_income_considered: list[OtherIncomeConsidered]
    obligations: float
    foir: float
    multiplier: float
    company_category: str | None
    company_policy: Literal["category", "unlisted", "base"]
    max_amount: float
    min_amount: float
    bt_amount: float
    covers_bt: bool | None
    covers_requested: bool | None
    serviceable: bool | None
    region: str | None
    sources: dict[str, SourceId] = Field(
        description="policy = From Policy, formula = Formula Calculation, table = From Table"
    )
    label: str | None


class OtherIncomeRow(BaseModel):
    type: str
    label: str
    agreement: str | None
    frequency: str
    amount: float
    monthly_amount: float


class EligibilityIncome(BaseModel):
    net_salary: float | None
    net_salary_source: Literal["verified", "entered"] | None
    net_salary_source_label: str
    entered_net_income: float | None
    verified_net_income: float | None
    other_income: list[OtherIncomeRow]
    other_income_monthly: float


class ObligationRow(BaseModel):
    index: int | None = Field(description="1-based tradeline number; null for a bank-statement EMI")
    lender: str | None
    loan_type: str | None
    action: str
    emi: float | None
    outstanding: float | None
    source: str | None = None
    flag: str | None = None
    note: str | None = None


class BankStatementEmi(BaseModel):
    payee: str | None
    lender: str | None
    amount: float
    months_seen: int | None
    months_total: int | None
    matched_tradeline: int | None
    counted: bool


class ObligationDetails(BaseModel):
    counted: list[ObligationRow]
    bt: list[ObligationRow]
    closed: list[ObligationRow]
    not_counted: list[ObligationRow]
    bank_statement_emis: list[BankStatementEmi]


class FileCheckUse(BaseModel):
    used: bool
    detail: str
    applicant: str | None = None


class RequestedLoan(BaseModel):
    amount: float | None
    tenure_months: int | None


class CalculateResponse(BaseModel):
    applicant: str
    calculated_at: str
    sample: bool
    policy_label: str | None
    label: str
    income_considered: float | None = Field(description="Net monthly salary used (verified, else entered)")
    income: EligibilityIncome
    obligations: float = Field(description="Monthly obligations counted")
    obligation_details: ObligationDetails
    bt_amount: float
    requested: RequestedLoan
    per_lender: list[LenderEligibility]
    best_lender: str | None
    best_lender_id: str | None
    best_lender_reason: str | None
    file_check: FileCheckUse
    notes: list[str]
    disclaimers: list[str]


class LoginDelivery(BaseModel):
    delivery_id: str | None
    status: Literal["delivered", "failed"]
    http_status: int | None = None
    error: str | None = None


class LoginResponse(BaseModel):
    status: Literal["recorded"]
    applicant: str
    lender: str
    lender_id: str
    eligible_amount: float
    emi: float
    tenure_months: int
    roi: float
    requested_at: str
    webhook: Literal["delivered", "failed", "not_enabled", "not_configured", "skipped"]
    webhook_detail: str | None = None
    delivery: LoginDelivery | None = Field(description="The CRM webhook delivery; null when none was attempted")
    label: str
    policy_label: str | None


_NOT_FOUND = {404: {"model": ErrorResponse, "description": "Project not found"}}
_INVALID_APPLICANT = {400: {"model": ErrorResponse, "description": "Invalid applicant"}}


# ------------------------------------------------------------------ helpers
def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def _iso(ts: dt.datetime) -> str:
    return ts.astimezone(dt.UTC).isoformat(timespec="microseconds")


def _require_project(project_id: str) -> None:
    if not get_project_item(project_id):
        raise HTTPException(status_code=404, detail="Project not found")


def _applicant(value: str) -> str:
    """The applicant as given (stripped); 400 unless it is safe like an id (app/safe_ids.py)."""
    return safe_segment((value or "").strip(), "applicant")


def is_full_pan(value: Any) -> bool:
    return isinstance(value, str) and bool(_PAN_RE.match(re.sub(r"\s", "", value).upper()))


def applicant_key(applicant: str) -> str:
    """ELIG# key of an applicant: SHA-256 of the PAN (any case / spacing) or the name (case and spacing ignored)."""
    compact = re.sub(r"\s", "", applicant).upper()
    basis = f"pan:{compact}" if _PAN_RE.match(compact) else "name:" + " ".join(applicant.split()).casefold()
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()[:40]


def _inputs_key(project_id: str, applicant: str) -> dict[str, str]:
    return {"PK": f"PROJ#{project_id}", "SK": f"{INPUTS_SK_PREFIX}{applicant_key(applicant)}"}


def _mask_pan(pan: Any) -> str | None:
    """'BQXPD4821K' -> 'XXXXXX821K' (as the file check masks it)."""
    if not isinstance(pan, str):
        return None
    compact = re.sub(r"\s", "", pan).upper()
    return "X" * 6 + compact[-4:] if _PAN_RE.match(compact) else None


def _to_dynamo(value: Any) -> Any:
    """JSON-safe inputs with floats as Decimal (DynamoDB has no float)."""
    return json.loads(json.dumps(value), parse_float=Decimal)


def _positive(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def _str(value: Any, limit: int = 200) -> str | None:
    if not isinstance(value, str):
        return None
    return value.strip()[:limit] or None


def _int(value: Any) -> int | None:
    return int(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


# ------------------------------------------------------------------ storage
def _load_saved(project_id: str, applicant: str, now: dt.datetime) -> dict[str, Any] | None:
    """The saved item, or None (also when past expires_at but not yet removed by TTL)."""
    item = get_table().get_item(Key=_inputs_key(project_id, applicant), ConsistentRead=True).get("Item")
    if not item:
        return None
    item = _decimal_to_python(item)
    expires_at = item.get(TTL_ATTRIBUTE)
    if not isinstance(expires_at, int) or expires_at <= int(now.timestamp()):
        return None
    return item


def _saved_inputs(item: dict[str, Any], project_id: str) -> EligibilityInputs | None:
    try:
        return EligibilityInputs.model_validate(item.get("inputs") or {})
    except ValidationError as e:
        print(f"eligibility: saved inputs unreadable project={project_id} at {[err['loc'] for err in e.errors()][:5]}")
        return None


def _save(project_id: str, applicant: str, inputs: EligibilityInputs, now: dt.datetime) -> dict[str, Any]:
    existing = _load_saved(project_id, applicant, now)
    if existing and isinstance(existing.get("created_at"), str):
        created_at, expires_at = existing["created_at"], int(existing[TTL_ATTRIBUTE])
    else:
        created_at = _iso(now)
        expires_at = int(now.timestamp()) + get_config().retention_days * 86400
    item = {
        **_inputs_key(project_id, applicant),
        "applicant": applicant,
        "inputs": _to_dynamo(inputs.model_dump(mode="json")),
        "created_at": created_at,
        "updated_at": _iso(now),
        TTL_ATTRIBUTE: expires_at,
    }
    get_table().put_item(Item=item)
    return item


def _expires_iso(item: dict[str, Any]) -> str | None:
    expires_at = item.get(TTL_ATTRIBUTE)
    if not isinstance(expires_at, int):
        return None
    return _iso(dt.datetime.fromtimestamp(expires_at, dt.UTC))


def erase_applicant_eligibility(project_id: str, identifiers: Iterable[str]) -> int:
    """Delete an applicant's saved eligibility inputs (for the erase-applicant flow).

    Deletes the ELIG# items whose key is one of `identifiers` (names or PANs) or whose saved
    name or PAN is; returns how many were deleted. Login-request items hold no applicant data.
    """
    wanted = {i.strip() for i in identifiers if isinstance(i, str) and i.strip()}
    keys = {applicant_key(i) for i in wanted}
    names = {" ".join(i.split()).casefold() for i in wanted if not is_full_pan(i)}
    pans = {re.sub(r"\s", "", i).upper() for i in wanted if is_full_pan(i)}
    table = get_table()
    kwargs: dict[str, Any] = {
        "KeyConditionExpression": Key("PK").eq(f"PROJ#{project_id}") & Key("SK").begins_with(INPUTS_SK_PREFIX)
    }
    deleted = 0
    while True:
        page = table.query(**kwargs)
        for item in page.get("Items", []):
            profile = (item.get("inputs") or {}).get("profile") or {}
            name = " ".join(str(profile.get("name") or item.get("applicant") or "").split()).casefold()
            match = (
                str(item["SK"])[len(INPUTS_SK_PREFIX) :] in keys
                or (name and name in names)
                or (profile.get("pan") in pans)
            )
            if match:
                table.delete_item(Key={"PK": item["PK"], "SK": item["SK"]})
                deleted += 1
        if not page.get("LastEvaluatedKey"):
            return deleted
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


# ------------------------------------------------------------------ file check
def _file_check_applicant(project_id: str, identifier: str) -> tuple[dict | None, str, dict]:
    """(the applicant's file-check result, what happened, the whole check)."""
    try:
        check = invoke_file_check_tool(TOOL_RUN_FILE_CHECK, {"project_id": project_id, "applicant": identifier})
    except FileCheckNotConfiguredError:
        return None, "the file check is not configured", {}
    except (FileCheckServiceError, UnknownChecklistError) as e:
        print(f"eligibility: file check failed project={project_id} ({type(e).__name__})")
        return None, "the file check failed", {}
    applicants = [a for a in check.get("applicants") or [] if isinstance(a, dict)]
    if not applicants:
        return None, "no applicant with this name or PAN in the analysed documents", check
    if len(applicants) > 1:
        return None, f"{len(applicants)} applicants in the documents match: use the PAN", check
    return applicants[0], "verified figures from the file check", check


def verified_income(applicant: dict | None) -> dict | None:
    """{amount, source}: the lower of the slips' median net pay and the bank salary credits' median."""
    income = (applicant or {}).get("income") or {}
    candidates = [
        (value, source)
        for value, source in (
            (income.get("slip_net"), "salary slips, median net pay"),
            (income.get("bank_salary_credit"), "bank salary credits, median"),
        )
        if _positive(value)
    ]
    if not candidates:
        return None
    amount, source = min(candidates, key=lambda c: c[0])
    return {"amount": amount, "source": source}


def bank_statement_emis(applicant: dict | None) -> list[dict]:
    """The loan EMIs the file check found in the bank statement (obligations.fixed_loan_emis)."""
    obligations = (applicant or {}).get("obligations") or {}
    if not isinstance(obligations, dict) or not obligations.get("available"):
        return []
    rows = []
    for view in obligations.get("fixed_loan_emis") or []:
        if not isinstance(view, dict) or not _positive(view.get("amount")):
            continue
        rows.append(
            {
                "amount": view["amount"],
                "payee": _str(view.get("payee"), 100),
                "lender": _str(view.get("declared_lender"), 100),
                "narration": _str(view.get("narration"), 300),
                "months_seen": _int(view.get("months_seen")),
                "months_total": _int(view.get("months_total")),
                "unverified": view.get("unverified") is True,
            }
        )
    return rows


_LOAN_TYPE_WORDS = (
    (r"\b(HOME|HOUSING|HL)\b", "home"),
    (r"\b(LAP|MORTGAGE|PROPERTY)\b", "mortgage"),
    (r"\b(CAR|AUTO|VEHICLE|TW|TWO ?WHEELER|BIKE)\b", "car"),
    (r"\b(EDU|EDUCATION)\b", "education"),
    (r"\b(CONSUMER|DURABLE)\b", "consumer"),
    (r"\bCARD\b", "credit_card"),
)


def _suggested_tradeline(bank: dict) -> dict:
    text = " ".join(str(bank.get(k) or "") for k in ("narration", "payee", "lender")).upper()
    loan_type = next((kind for pattern, kind in _LOAN_TYPE_WORDS if re.search(pattern, text)), "personal")
    lender = bank.get("lender") or (bank.get("payee") or "").title() or None
    return {
        "loan_type": loan_type,
        "lender": lender,
        "emi": bank["amount"],
        "status": "active",
        "action": "obligate",
        "source": "bank_statement",
    }


def _applicant_facts(project_id: str, applicant: dict, notes: list[str]) -> list[dict]:
    ids = {d.get("document_id") for d in applicant.get("documents") or [] if isinstance(d, dict)}
    try:
        facts = query_facts(project_id)
    except (ClientError, BotoCoreError) as e:
        print(f"eligibility: facts not read project={project_id} ({type(e).__name__})")
        notes.append("Employer, DOB and loan details could not be read from the documents")
        return []
    return [facts[i] for i in sorted(ids, key=str) if i in facts and isinstance(facts[i].get("fields"), dict)]


def _employer(facts: list[dict]) -> str | None:
    """The loan application's employer, else the longest one on the slips / Form-16 (never a bank statement)."""

    def of(doc_type: str) -> list[str]:
        return [
            f["fields"]["employer"].strip()
            for f in facts
            if f.get("doc_type") == doc_type
            and isinstance(f["fields"].get("employer"), str)
            and f["fields"]["employer"].strip()
        ]

    declared = of("loan_application")
    if declared:
        return declared[0]
    others = [e for kind in ("salary_slip", "form16_itr", "identity_details", "other") for e in of(kind)]
    return max(others, key=len) if others else None


def _employment_type_of(employer: str) -> str | None:
    company = eligibility.load_policy_book().find_company(employer)
    if company and company.employment_type:
        return company.employment_type
    text = employer.casefold()
    if re.search(r"\b(pvt|private)\b.*\b(ltd|limited)\b", text):
        return "private_limited"
    if re.search(r"\bllp\b", text):
        return "llp"
    if re.search(r"\b(ltd|limited)\b", text):
        return "public_limited"
    return None


def _dob(facts: list[dict]) -> dt.date | None:
    """A date of birth the facts extraction recorded (dob / date_of_birth), identity details first."""
    ordered = sorted(facts, key=lambda f: f.get("doc_type") != "identity_details")
    for fact in ordered:
        for field in ("dob", "date_of_birth"):
            value = fact["fields"].get(field)
            if not isinstance(value, str):
                continue
            for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y"):
                try:
                    parsed = dt.datetime.strptime(value.strip(), fmt).date()
                except ValueError:
                    continue
                if dt.date(1900, 1, 1) <= parsed < dt.datetime.now(dt.UTC).date():
                    return parsed
    return None


def _draft(project_id: str, applicant: str) -> tuple[EligibilityInputs, list[str], Prefill, list[str]]:
    """Inputs pre-filled from the file check: (inputs, fields taken from the documents, prefill, notes)."""
    found, detail, _check = _file_check_applicant(project_id, applicant)
    notes: list[str] = []
    if found is None:
        return EligibilityInputs(), [], Prefill(available=False, detail=f"Not pre-filled: {detail}"), notes
    facts = _applicant_facts(project_id, found, notes)
    profile: dict[str, Any] = {}
    loan: dict[str, Any] = {}
    fields: list[str] = []
    name = _str(found.get("applicant"))
    if name and name != "Unknown":
        profile["name"] = name
        fields.append("name")
    pan = _mask_pan(found.get("pan"))
    if pan:
        profile["pan"] = pan
        fields.append("pan")
    employer = _employer(facts)
    employment_type = _employment_type_of(employer) if employer else None
    if employer:
        profile["company"] = employer[:200]
        fields.append("company")
    if employment_type:
        profile["employment_type"] = employment_type
        fields.append("employment_type")
    verified = verified_income(found)
    income = found.get("income") if isinstance(found.get("income"), dict) else {}
    declared = income.get("declared_net")
    income_source = None
    if verified:
        profile["net_income"] = verified["amount"]
        income_source = f"verified: {verified['source']}"
        fields.append("net_income")
    elif _positive(declared):
        profile["net_income"] = declared
        income_source = "declared on the loan application, not verified"
        fields.append("net_income")
    dob = _dob(facts)
    if dob:
        profile["dob"] = dob.isoformat()
        fields.append("dob")
    application = next((f["fields"] for f in facts if f.get("doc_type") == "loan_application"), {})
    if _positive(application.get("loan_amount")) and application["loan_amount"] <= MAX_AMOUNT:
        loan["amount"] = application["loan_amount"]
        fields.append("loan_amount")
    tenure = application.get("loan_tenure_months")
    if _positive(tenure) and 1 <= int(tenure) <= 480:
        loan["tenure_months"] = int(tenure)
        fields.append("tenure_months")
    tradelines = [_suggested_tradeline(b) for b in bank_statement_emis(found)[:50]]
    if tradelines:
        fields.append("tradelines")
        notes.append(
            f"{len(tradelines)} loan EMI(s) from the bank statement were added as tradelines: check the loan type, "
            "lender and action, and add the outstanding"
        )
    try:
        inputs = EligibilityInputs.model_validate(
            {"profile": profile, "loan": loan, "cibil": {"tradelines": tradelines}}
        )
    except ValidationError as e:
        print(f"eligibility: pre-fill rejected project={project_id} at {[err['loc'] for err in e.errors()][:5]}")
        inputs, fields = EligibilityInputs(), []
        notes.append("The documents' values could not be used: fill the form by hand")
    prefill = Prefill(
        available=True,
        detail=f"Pre-filled from the file check ({len(found.get('documents') or [])} documents)",
        applicant_name=name,
        pan_masked=pan,
        employer=employer,
        verified_net_income=verified["amount"] if verified else None,
        income_source=income_source,
        dob=dob,
        suggested_tradelines=len(tradelines),
        documents=len(found.get("documents") or []),
    )
    return inputs, fields, prefill, notes


def _run(project_id: str, applicant: str, inputs: EligibilityInputs) -> dict[str, Any]:
    """The engine's calculation with the file check's verified salary and bank-statement EMIs."""
    identifier = inputs.profile.pan if is_full_pan(inputs.profile.pan) else applicant
    found, detail, check = _file_check_applicant(project_id, identifier)
    notes: list[str] = []
    if found is None:
        notes.append(
            f"File check not used ({detail}): the entered net income is used and no bank-statement EMIs are added"
        )
    elif check.get("pending_documents"):
        notes.append(
            f"{len(check['pending_documents'])} document(s) still being analysed: the verified figures may change"
        )
    result = eligibility.calculate(
        inputs.model_dump(mode="json"),
        verified_income=verified_income(found),
        bank_emis=bank_statement_emis(found),
    )
    result["notes"] = notes + result["notes"]
    result["file_check"] = {
        "used": found is not None,
        "detail": detail,
        "applicant": _str(found.get("applicant")) if found else None,
    }
    result["applicant"] = applicant
    result["calculated_at"] = _iso(_now())
    return result


# ------------------------------------------------------------------ login
def reset_login_limits() -> None:
    """Forget every login's time and count (tests)."""
    global _running_logins
    with _login_lock:
        _last_login_at.clear()
        _running_logins = 0


def _begin_login(key: tuple[str, str, str]) -> None:
    global _running_logins
    now = _monotonic()
    with _login_lock:
        last = _last_login_at.get(key)
        if last is not None and now - last < LOGIN_INTERVAL_S:
            wait = max(1, math.ceil(LOGIN_INTERVAL_S - (now - last)))
            raise HTTPException(
                status_code=429,
                detail=f"This file was just logged in with this lender: wait {wait} s",
                headers={"Retry-After": str(wait)},
            )
        if _running_logins >= MAX_CONCURRENT_LOGINS:
            raise HTTPException(
                status_code=429,
                detail="Too many login requests are being sent; try again in a few seconds",
                headers={"Retry-After": "5"},
            )
        if len(_last_login_at) > 512:
            for stale in [k for k, t in _last_login_at.items() if now - t >= LOGIN_INTERVAL_S]:
                del _last_login_at[stale]
        _last_login_at[key] = now
        _running_logins += 1


def _end_login(key: tuple[str, str, str], recorded: bool) -> None:
    """Free the slot; a request that was not recorded may be retried at once."""
    global _running_logins
    with _login_lock:
        _running_logins = max(0, _running_logins - 1)
        if not recorded:
            _last_login_at.pop(key, None)


def _failed(error: str) -> tuple[str, dict, None]:
    return "failed", {"delivery_id": None, "status": "failed", "http_status": None, "error": error}, None


def _notify_crm(project_id: str, login: dict[str, Any]) -> tuple[str, dict | None, str | None]:
    """(webhook outcome, delivery, detail): event file_login.requested through the delivery Lambda."""
    settings = get_webhook_settings(project_id)
    if settings is None or not (settings.enabled and settings.url and settings.secret_set):
        return "not_enabled", None, "the project's CRM webhook is not enabled"
    function_name = get_config().webhook_function_name
    if not function_name:
        return "not_configured", None, "webhook delivery is not configured"
    try:
        response = get_webhook_lambda_client().invoke(
            FunctionName=function_name,
            InvocationType="RequestResponse",
            Payload=json.dumps({"project_id": project_id, "event": EVENT_LOGIN, "login": login}).encode("utf-8"),
        )
        raw = response["Payload"].read()
    except ClientError as e:
        return _failed(f"invoke failed ({e.response.get('Error', {}).get('Code') or 'ClientError'})")
    except BotoCoreError as e:
        return _failed(f"invoke failed ({type(e).__name__})")
    if response.get("FunctionError"):
        return _failed(f"function error ({response['FunctionError']})")
    try:
        payload = json.loads(raw)
    except ValueError:
        return _failed("non-JSON response")
    if not isinstance(payload, dict):
        return _failed("non-object response")
    if payload.get("status") == "skipped":
        return "skipped", None, str(payload.get("reason") or "not sent")
    if payload.get("status") in ("delivered", "failed") and isinstance(payload.get("delivery_id"), str):
        http_status = payload.get("http_status")
        error = payload.get("error")
        return (
            payload["status"],
            {
                "delivery_id": payload["delivery_id"],
                "status": payload["status"],
                "http_status": http_status if isinstance(http_status, int) else None,
                "error": error if isinstance(error, str) and error else None,
            },
            None,
        )
    return _failed(str(payload.get("error") or "unexpected response")[:300])


def _write_login_audit(project_id: str, lender_id: str, at: dt.datetime) -> dict[str, str]:
    key = {"PK": f"PROJ#{project_id}", "SK": f"{LOGIN_SK_PREFIX}{_iso(at)}#{uuid.uuid4().hex}"}
    get_table().put_item(
        Item={
            **key,
            "lender_id": lender_id,
            "requested_at": _iso(at),
            "webhook_status": "pending",
            TTL_ATTRIBUTE: int(at.timestamp()) + get_config().retention_days * 86400,
        }
    )
    return key


def _update_login_audit(key: dict[str, str], webhook: str) -> None:
    try:
        get_table().update_item(
            Key=key,
            UpdateExpression="SET webhook_status = :webhook",
            ConditionExpression="attribute_exists(PK)",
            ExpressionAttributeValues={":webhook": webhook},
        )
    except (ClientError, BotoCoreError) as e:
        print(f"eligibility login: audit not updated ({type(e).__name__})")


def _display_name(applicant: str, inputs: EligibilityInputs) -> str:
    """The applicant's name for the CRM: the saved name, else the applicant; never a full PAN."""
    if inputs.profile.name:
        return inputs.profile.name
    if is_full_pan(applicant):
        return _mask_pan(applicant) or "applicant"
    return applicant


# ------------------------------------------------------------------ routes
@router.get("/lenders", responses=_NOT_FOUND, summary="SAMPLE lender policies and the form's choices")
def list_lenders(project_id: ProjectId, user_id: UserId) -> LendersResponse:
    """Every lender's SAMPLE policy (ROI, FOIR, multiplier, tenure, amounts, CIBIL and enquiry limits,
    employment types, company categories, income consideration, serviceable regions)."""
    _require_project(project_id)
    book = eligibility.load_policy_book()
    lenders = [
        LenderPolicyOut(
            **lender.model_dump(exclude={"employment_types", "company_categories", "unlisted_company"}),
            employment_types=list(lender.employment_types),
            company_categories={k: CategoryPolicyOut(**v.model_dump()) for k, v in lender.company_categories.items()},
            unlisted_company=UnlistedCompanyOut(**lender.unlisted_company.model_dump()),
            serviceable_regions=[region.name for region in book.regions_of(lender.id)],
            sample=book.sample,
            label=book.label,
        )
        for lender in book.lenders
    ]
    disclaimers = [f"Every result is {eligibility.INDICATIVE_LABEL}."]
    if book.sample:
        disclaimers.insert(0, f"All lender data here is SAMPLE data: {eligibility.SAMPLE_LABEL}.")
    return LendersResponse(
        sample=book.sample,
        label=book.label,
        version=book.policies.version,
        lenders=lenders,
        options=FormOptions(**eligibility.options()),
        disclaimers=disclaimers,
    )


@router.get(
    "/pincodes/{pincode}",
    responses=_NOT_FOUND,
    summary='"Check Availability": the lenders that serve a pincode (SAMPLE lists)',
)
def check_pincode(
    project_id: ProjectId,
    user_id: UserId,
    pincode: Annotated[str, Path(pattern=r"^[1-9][0-9]{5}$", description="6-digit pincode")],
) -> PincodeResponse:
    _require_project(project_id)
    book = eligibility.load_policy_book()
    region = book.region_of(pincode)
    lenders = [
        PincodeLender(lender_id=lender.id, lender=lender.name, serviceable=book.serviceable(lender.id, pincode))
        for lender in book.lenders
    ]
    return PincodeResponse(
        pincode=pincode,
        region=region.name if region else None,
        serviceable_by=sum(1 for lender in lenders if lender.serviceable),
        lenders=lenders,
        sample=book.sample,
        label=book.label,
    )


@router.get(
    "/companies",
    responses=_NOT_FOUND,
    summary='"Check Category": a company\'s category with every lender (SAMPLE lists)',
)
def check_company(
    project_id: ProjectId,
    user_id: UserId,
    name: Annotated[str, Query(min_length=1, max_length=200, pattern=_LINE, description="Company name or part of it")],
) -> CompanyResponse:
    _require_project(project_id)
    book = eligibility.load_policy_book()
    query = name.strip()
    company = book.find_company(query)
    categories = []
    for lender in book.lenders:
        category = company.categories.get(lender.id) if company else None
        if category is not None:
            policy = lender.company_categories[category]
            foir, multiplier, accepted = policy.foir, policy.multiplier, True
        else:
            unlisted = lender.unlisted_company
            foir, multiplier, accepted = unlisted.foir, unlisted.multiplier, unlisted.accepted
        categories.append(
            CompanyCategory(
                lender_id=lender.id,
                lender=lender.name,
                category=category,
                listed=category is not None,
                accepted=accepted,
                foir=foir,
                multiplier=multiplier,
            )
        )
    match = (
        CompanyMatch(
            name=company.name,
            aliases=list(company.aliases),
            employment_type=company.employment_type,
            synthetic=company.synthetic,
        )
        if company
        else None
    )
    return CompanyResponse(
        query=query,
        match=match,
        categories=categories,
        suggestions=[c.name for c in book.company_suggestions(query) if not company or c is not company],
        sample=book.sample,
        label=book.label,
    )


@router.get(
    "/inputs",
    responses={**_INVALID_APPLICANT, **_NOT_FOUND},
    summary="An applicant's saved inputs, else a draft pre-filled from the file check",
)
def get_inputs(
    project_id: ProjectId,
    user_id: UserId,
    applicant: Annotated[str, Query(min_length=1, max_length=200, description="PAN (preferred) or name")],
) -> InputsResponse:
    """Saved inputs (until they expire), else a draft: name, masked PAN, employer (and its employment
    type), verified net income, DOB when extracted, loan amount and tenure from the application, and
    the bank statement's loan EMIs as suggested tradelines. Nothing is saved by this call."""
    _require_project(project_id)
    applicant = _applicant(applicant)
    book = eligibility.load_policy_book()
    stored = _load_saved(project_id, applicant, _now())
    saved_inputs = _saved_inputs(stored, project_id) if stored else None
    if stored and saved_inputs is not None:
        print(f"eligibility inputs user={user_id} project={project_id} saved=true")
        return InputsResponse(
            applicant=applicant,
            saved=True,
            inputs=saved_inputs,
            from_documents=[],
            prefill=None,
            created_at=stored.get("created_at"),
            updated_at=stored.get("updated_at"),
            expires_at=_expires_iso(stored),
            label=book.label,
        )
    inputs, fields, prefill, notes = _draft(project_id, applicant)
    if stored:
        notes.insert(0, "The saved inputs could not be read (saved by an older version): check the form again")
    print(
        f"eligibility inputs user={user_id} project={project_id} saved=false prefill={prefill.available} "
        f"fields={len(fields)}"
    )
    return InputsResponse(
        applicant=applicant,
        saved=False,
        inputs=inputs,
        from_documents=fields,
        prefill=prefill,
        notes=notes,
        label=book.label,
    )


@router.put(
    "/inputs",
    responses={**_INVALID_APPLICANT, **_NOT_FOUND},
    summary="Save an applicant's inputs (deleted after the retention period)",
)
def put_inputs(project_id: ProjectId, user_id: UserId, request: SaveInputsRequest) -> InputsResponse:
    """Replaces the applicant's saved inputs. They expire (DynamoDB TTL) the retention period (default
    7 days) after the first save; later saves keep that date."""
    _require_project(project_id)
    applicant = _applicant(request.applicant)
    inputs = EligibilityInputs(profile=request.profile, cibil=request.cibil, loan=request.loan)
    item = _save(project_id, applicant, inputs, _now())
    print(
        f"eligibility inputs saved user={user_id} project={project_id} tradelines={len(inputs.cibil.tradelines)} "
        f"other_income={len(inputs.profile.other_income)}"
    )
    return InputsResponse(
        applicant=applicant,
        saved=True,
        inputs=inputs,
        from_documents=[],
        prefill=None,
        created_at=item["created_at"],
        updated_at=item["updated_at"],
        expires_at=_expires_iso(item),
        label=eligibility.load_policy_book().label,
    )


@router.post(
    "/calculate",
    responses={
        **_INVALID_APPLICANT,
        404: {"model": ErrorResponse, "description": "Project not found, or no saved inputs (and none sent)"},
    },
    summary="Eligibility at every lender (fixed formulas; SAMPLE policies; indicative)",
)
def calculate(project_id: ProjectId, user_id: UserId, request: CalculateRequest) -> CalculateResponse:
    """Per lender: status (eligible / not_serviceable / not_eligible with reasons), eligible amount, EMI at
    the lender's max tenure and ROI, and the working: per-lakh EMI, FOIR and multiplier eligibility,
    income and obligations considered, with each parameter's source (policy / formula / table)."""
    _require_project(project_id)
    applicant = _applicant(request.applicant)
    inputs = request.inputs
    if inputs is None:
        stored = _load_saved(project_id, applicant, _now())
        inputs = _saved_inputs(stored, project_id) if stored else None
        if inputs is None:
            raise HTTPException(
                status_code=404,
                detail="No saved eligibility inputs for this applicant: save them (PUT .../inputs) or send inputs",
            )
    result = _run(project_id, applicant, inputs)
    eligible = sum(1 for r in result["per_lender"] if r["status"] == "eligible")
    print(
        f"eligibility calculate user={user_id} project={project_id} lenders={len(result['per_lender'])} "
        f"eligible={eligible} file_check={result['file_check']['used']}"
    )
    return CalculateResponse.model_validate(result)


@router.post(
    "/login",
    responses={
        400: {"model": ErrorResponse, "description": "Invalid applicant or unknown lender"},
        404: {"model": ErrorResponse, "description": "Project not found, or no saved inputs for the applicant"},
        409: {"model": ErrorResponse, "description": "The lender is not eligible for this file (reasons given)"},
        429: {"model": ErrorResponse, "description": "Just logged in with this lender, or too many at once"},
        502: {"model": ErrorResponse, "description": "The login request could not be recorded"},
    },
    summary="Log the file in with a lender: record it and notify the CRM webhook",
)
def login(project_id: ProjectId, user_id: UserId, request: LoginRequest) -> LoginResponse:
    """Recomputes the lender's figures from the saved inputs, records the request (an audit item without
    applicant data, deleted after the retention period) and, when the CRM webhook is enabled, sends event
    file_login.requested {applicant, lender, eligible_amount, emi, tenure_months, roi} signed like every
    delivery. A CRM that is down makes `webhook` "failed", not an error."""
    _require_project(project_id)
    applicant = _applicant(request.applicant)
    book = eligibility.load_policy_book()
    lender = book.lender(request.lender.strip())
    if lender is None:
        known = ", ".join(policy.id for policy in book.lenders)
        raise HTTPException(status_code=400, detail=f"Unknown lender (known: {known})")
    stored = _load_saved(project_id, applicant, _now())
    inputs = _saved_inputs(stored, project_id) if stored else None
    if inputs is None:
        raise HTTPException(
            status_code=404, detail="No saved eligibility inputs for this applicant: save them (PUT .../inputs) first"
        )
    result = _run(project_id, applicant, inputs)
    row = next(r for r in result["per_lender"] if r["lender_id"] == lender.id)
    if row["status"] != "eligible":
        raise HTTPException(
            status_code=409, detail=f"{lender.name}: {row['status_label']}: " + "; ".join(row["reasons"])
        )

    limit_key = (project_id, applicant_key(applicant), lender.id)
    _begin_login(limit_key)
    recorded = False
    try:
        requested_at = _now()
        try:
            audit_key = _write_login_audit(project_id, lender.id, requested_at)
        except (ClientError, BotoCoreError) as e:
            print(f"eligibility login: not recorded user={user_id} project={project_id} ({type(e).__name__})")
            raise HTTPException(status_code=502, detail="The login request could not be recorded") from e
        recorded = True
        note = eligibility.INDICATIVE_LABEL + (f"; {book.label}" if book.label else "")
        login_event = {
            "applicant": _display_name(applicant, inputs),
            "lender": lender.name,
            "eligible_amount": row["eligible_amount"],
            "emi": row["emi"],
            "tenure_months": row["tenure_months"],
            "roi": row["roi"],
            "note": note,
        }
        webhook, delivery, detail = _notify_crm(project_id, login_event)
        _update_login_audit(audit_key, webhook)
    finally:
        _end_login(limit_key, recorded)
    # Ids and outcome only: no applicant data, no amounts.
    print(
        f"eligibility login user={user_id} project={project_id} lender={lender.id} webhook={webhook} "
        f"delivery={(delivery or {}).get('delivery_id')}"
    )
    return LoginResponse(
        status="recorded",
        applicant=login_event["applicant"],
        lender=lender.name,
        lender_id=lender.id,
        eligible_amount=row["eligible_amount"],
        emi=row["emi"],
        tenure_months=row["tenure_months"],
        roi=row["roi"],
        requested_at=_iso(requested_at),
        webhook=webhook,
        webhook_detail=detail,
        delivery=LoginDelivery(**delivery) if delivery else None,
        label=eligibility.INDICATIVE_LABEL,
        policy_label=book.label,
    )
