"""Loan eligibility per lender for the CIBIL page: deterministic maths, never a model.

Implements the client's "Cibil Page Function" sheet (Data Entry, CAM, Eligibility)
for every lender of the policy file:

    calculation tenure     = requested tenure capped at the lender's max tenure
                             (raised to its min tenure; its max tenure when none is requested)
    per-lakh EMI           = EMI(1,00,000, ROI / 12, calculation tenure)
    FOIR eligibility       = (income x FOIR - obligations) / per-lakh EMI x 1,00,000
    multiplier eligibility = income x multiplier
    eligible amount        = min(FOIR eligibility, multiplier eligibility, lender max amount)
                             (the sheet's MIN: exact, rounded to the paisa only for display)
    EMI                    = EMI(eligible amount, ROI / 12, lender max tenure)

where EMI(P, r, n) = P r (1 + r)^n / ((1 + r)^n - 1), Excel's PMT. The sheet's worked
example (income 98,000, FOIR 0.70, multiplier 21, obligations 15,000, 60 months at 11%)
gives a per-lakh EMI of 2,174.24, FOIR eligibility 24,65,226.61 and multiplier eligibility
20,58,000, so ICICI Bank offers 20,58,000 (EMI 39,172.13 over its max 72 months); HDFC
Bank's cap gives 15,00,000 (EMI 33,366.67 over 60 months at 12%).

Income considered = net monthly salary (verified by the file check when it is available,
else as entered) + every other income normalised to a month (yearly / 12, half-yearly / 6,
quarterly / 3, monthly) x the lender's consideration % for it (rented income by notary or
registered agreement, bonus, incentive, pension).

Obligations = EMIs of the tradelines marked Obligate + the loan EMIs the file check found
in the bank statement that match no tradeline (flagged as such; a bank EMI that matches a
tradeline, whatever its action, is never counted twice). BT: the EMI is not an obligation
and the outstanding is the balance-transfer amount, which the eligible amount must cover.
Close: the EMI is not an obligation; the loan is to be closed before disbursal. A
tradeline the bureau reports closed is never an obligation.

Per lender: the pincode must be serviceable (else "not_serviceable"); the employment type
accepted; the company's category gives the FOIR and multiplier (an unlisted company gets
the lender's unlisted-company policy or is refused); CIBIL score at least the lender's
minimum; enquiries in the last 90 days within its limit; FOIR headroom left after the
obligations; at least the lender's minimum amount; the BT amount covered. Any failure makes
the lender "not_eligible" with every reason; its eligible amount and EMI are then 0 and
`computed_amount` keeps what the formulas gave.

Parameter sources follow the sheet's legend: "policy" (From Policy: the lender policy),
"formula" (Formula Calculation) and "table" (From Table: the data entered or read from the
documents, and the company and pincode lists).

Money is kept exact (Decimal, 34 digits) through the maths and rounded to the paisa
(half up) only in the output. Every lender policy, pincode list and company category in
app/data is SAMPLE data, labelled "sample policy — replace with your lender grid" wherever
it is shown, and every result is indicative: the lender decides.
"""

import json
import re
from decimal import ROUND_HALF_UP, Decimal, localcontext
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

DATA_DIR = Path(__file__).resolve().parent / "data"
POLICY_FILE = "lender_policies.json"
PINCODE_FILE = "pincodes.json"
COMPANY_FILE = "companies.json"

SAMPLE_LABEL = "sample policy — replace with your lender grid"
INDICATIVE_LABEL = "indicative — the lender decides"

LAKH = Decimal(100_000)
# The smallest loan worth offering (a lender's own min_amount may be higher).
MIN_LOAN_AMOUNT = Decimal(1_000)
PAISA = Decimal("0.01")
PRECISION = 34
# A bank-statement EMI and a tradeline EMI are the same loan within 2% (min Rs 1),
# the file check's own tolerance for declared vs debited EMIs.
EMI_MATCH_TOLERANCE = Decimal("0.02")

# ------------------------------------------------------------------ vocabularies (id -> label)
EMPLOYMENT_TYPES = {
    "defence": "Defence",
    "government": "Government",
    "grade_4": "Grade 4",
    "llp": "LLP",
    "merchant_navy": "Merchant Navy",
    "partnership_proprietorship": "Partnership/Proprietorship",
    "private_limited": "Private Limited",
    "public_limited": "Public Limited",
}
EMPLOYMENT_TYPE_ALIASES = {
    "defense": "defence",
    "govt": "government",
    "psu": "government",
    "grade_iv": "grade_4",
    "grade4": "grade_4",
    "class_iv": "grade_4",
    "class_4": "grade_4",
    "partnership": "partnership_proprietorship",
    "proprietorship": "partnership_proprietorship",
    "partnership_or_proprietorship": "partnership_proprietorship",
    "private": "private_limited",
    "pvt_ltd": "private_limited",
    "private_ltd": "private_limited",
    "public": "public_limited",
    "public_ltd": "public_limited",
}
LOAN_TYPES = {
    "personal": "Personal Loan",
    "home": "Home Loan",
    "mortgage": "Mortgage Loan",
    "car": "Car Loan",
    "education": "Education Loan",
    "application": "Application Loan",
    "consumer": "Consumer Loan",
    "credit_card": "Credit Card",
}
LOAN_TYPE_ALIASES = {
    "pl": "personal",
    "hl": "home",
    "housing": "home",
    "lap": "mortgage",
    "loan_against_property": "mortgage",
    "auto": "car",
    "vehicle": "car",
    "app": "application",
    "consumer_durable": "consumer",
    "cc": "credit_card",
    "card": "credit_card",
}
TRADELINE_ACTIONS = {"bt": "BT", "obligate": "Obligate", "close": "Close"}
TRADELINE_ACTION_ALIASES = {"balance_transfer": "bt", "obligation": "obligate", "closed": "close"}
TRADELINE_STATUSES = {
    "active": "Active",
    "closed": "Closed",
    "settled": "Settled",
    "written_off": "Written off",
    "suit_filed": "Suit filed",
    "wilful_default": "Wilful default",
    "restructured": "Restructured",
}
TRADELINE_STATUS_ALIASES = {"open": "active", "live": "active", "writeoff": "written_off", "write_off": "written_off"}
# Bureau statuses lenders usually decline a file for (reported as notes, never decided here).
ADVERSE_STATUSES = frozenset({"settled", "written_off", "suit_filed", "wilful_default", "restructured"})
TRADELINE_SOURCES = {"manual": "Manual entry", "bureau": "Bureau report", "bank_statement": "Bank statement"}
CIBIL_SOURCES = {"manual": "Manual entry", "bureau": "Bureau report"}
OTHER_INCOME_TYPES = {"rented": "Rented income", "bonus": "Bonus", "incentive": "Incentive", "pension": "Pension"}
OTHER_INCOME_ALIASES = {"rent": "rented", "rental": "rented"}
INCOME_FREQUENCIES = {"yearly": "Yearly", "half_yearly": "Half yearly", "quarterly": "Quarterly", "monthly": "Monthly"}
INCOME_FREQUENCY_ALIASES = {
    "annual": "yearly",
    "annually": "yearly",
    "halfyearly": "half_yearly",
    "semi_annual": "half_yearly",
    "semi_annually": "half_yearly",
    "month": "monthly",
}
MONTHS_PER_PERIOD = {"yearly": 12, "half_yearly": 6, "quarterly": 3, "monthly": 1}
RENT_AGREEMENTS = {"notary": "Notary", "registered": "Registered"}
RENT_AGREEMENT_ALIASES = {"notarised": "notary", "notarized": "notary", "notary_agreement": "notary"}
HOUSE_OWNERSHIP = {"owned": "Owned", "rented": "Rented"}
HOUSE_OWNERSHIP_ALIASES = {"own": "owned", "self_owned": "owned", "rent": "rented"}
STATUS_LABELS = {"eligible": "Eligible", "not_serviceable": "Not serviceable", "not_eligible": "Not eligible"}
SOURCE_LABELS = {"policy": "From Policy", "formula": "Formula Calculation", "table": "From Table"}

_KEY_RE = re.compile(r"[^a-z0-9]+")


def _enum_key(value: str) -> str:
    return _KEY_RE.sub("_", value.strip().casefold()).strip("_")


def enum_id(
    value: Any,
    choices: dict[str, str],
    aliases: dict[str, str] | None = None,
    suffixes: tuple[str, ...] = (),
) -> str | None:
    """The id in `choices` that `value` names: an id or a label in any case, spaces, slashes and
    hyphens ignored (``"Private Limited"`` -> ``private_limited``, ``"BT"`` -> ``bt``); None if none."""
    if not isinstance(value, str):
        return None
    key = _enum_key(value)
    if not key:
        return None
    keys = [key] + [key[: -len(s)] for s in suffixes if key.endswith(s) and len(key) > len(s)]
    by_label = {_enum_key(label): choice for choice, label in choices.items()}
    for k in keys:
        if k in choices:
            return k
        if aliases and k in aliases:
            return aliases[k]
        if k in by_label:
            return by_label[k]
    return None


def options() -> dict[str, list[dict[str, str]]]:
    """The form's choices, id and label (the API takes either)."""

    def pairs(choices: dict[str, str]) -> list[dict[str, str]]:
        return [{"id": k, "label": v} for k, v in choices.items()]

    return {
        "employment_types": pairs(EMPLOYMENT_TYPES),
        "house_ownership": pairs(HOUSE_OWNERSHIP),
        "other_income_types": pairs(OTHER_INCOME_TYPES),
        "income_frequencies": pairs(INCOME_FREQUENCIES),
        "rent_agreements": pairs(RENT_AGREEMENTS),
        "loan_types": pairs(LOAN_TYPES),
        "tradeline_actions": pairs(TRADELINE_ACTIONS),
        "tradeline_statuses": pairs(TRADELINE_STATUSES),
        "sources": pairs(SOURCE_LABELS),
    }


# ------------------------------------------------------------------ money
def dec(value: Any) -> Decimal:
    """Exact Decimal of a number (floats through str, so 0.7 is Decimal('0.7'))."""
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool) or not isinstance(value, int | float | str):
        raise TypeError(f"not a number: {type(value).__name__}")
    return Decimal(str(value))


def emi(principal: Any, roi_pct: Any, months: int) -> Decimal:
    """Monthly EMI of `principal` at `roi_pct` % a year over `months` months (Excel PMT, unrounded)."""
    n = int(months)
    if n < 1:
        raise ValueError("months must be at least 1")
    with localcontext() as ctx:
        ctx.prec = PRECISION
        p = dec(principal)
        r = dec(roi_pct) / Decimal(1200)
        if r == 0:
            return p / n
        growth = (1 + r) ** n
        return p * r * growth / (growth - 1)


def money(value: Any) -> float | None:
    """Display rounding: to the paisa, half up."""
    if value is None:
        return None
    return float(dec(value).quantize(PAISA, rounding=ROUND_HALF_UP))


def inr(value: Any) -> str:
    """Indian digit grouping for messages: 2058000 -> Rs 20,58,000 (paise only when not zero)."""
    if value is None:
        return "–"
    d = dec(value).quantize(PAISA, rounding=ROUND_HALF_UP)
    sign = "-" if d < 0 else ""
    whole, _, frac = f"{abs(d):.2f}".partition(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        head = ",".join(re.findall(r"\d{1,2}", head[::-1]))[::-1]
        whole = f"{head},{tail}"
    return f"{sign}₹{whole}" + (f".{frac}" if frac != "00" else "")


def _pct(fraction: Decimal) -> str:
    value = (fraction * 100).normalize()
    return f"{value:f}%"


def _number(value: Decimal) -> str:
    return f"{value.normalize():f}"


# ------------------------------------------------------------------ SAMPLE data files
class _Data(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class CategoryPolicy(_Data):
    foir: float = Field(gt=0, le=1)
    multiplier: float = Field(gt=0, le=100)


class UnlistedCompanyPolicy(_Data):
    accepted: bool
    foir: float | None = Field(default=None, gt=0, le=1)
    multiplier: float | None = Field(default=None, gt=0, le=100)

    @model_validator(mode="after")
    def _values_when_accepted(self):
        if self.accepted and (self.foir is None or self.multiplier is None):
            raise ValueError("an accepted unlisted company needs foir and multiplier")
        return self


class IncomeConsideration(_Data):
    """Percent of each other income (normalised to a month) the lender counts."""

    rented_notary: float = Field(ge=0, le=100)
    rented_registered: float = Field(ge=0, le=100)
    bonus: float = Field(ge=0, le=100)
    incentive: float = Field(ge=0, le=100)
    pension: float = Field(ge=0, le=100)


class LenderPolicy(_Data):
    id: str = Field(pattern=r"^[a-z0-9_]{1,64}$")
    name: str = Field(min_length=1, max_length=100)
    product: str | None = None
    roi: float = Field(ge=0, le=60, description="Annual rate of interest, percent")
    foir: float = Field(gt=0, le=1)
    multiplier: float = Field(gt=0, le=100)
    min_tenure_months: int = Field(default=1, ge=1, le=480)
    max_tenure_months: int = Field(ge=1, le=480)
    min_amount: float = Field(default=0, ge=0)
    max_amount: float = Field(gt=0)
    min_cibil_score: int = Field(ge=300, le=900)
    max_enquiries_90d: int = Field(ge=0)
    employment_types: tuple[str, ...]
    company_categories: dict[str, CategoryPolicy]
    unlisted_company: UnlistedCompanyPolicy
    income_consideration_pct: IncomeConsideration

    @model_validator(mode="after")
    def _consistent(self):
        unknown = [t for t in self.employment_types if t not in EMPLOYMENT_TYPES]
        if unknown:
            raise ValueError(f"unknown employment types {unknown}")
        if self.min_tenure_months > self.max_tenure_months:
            raise ValueError("min_tenure_months is more than max_tenure_months")
        if self.min_amount > self.max_amount:
            raise ValueError("min_amount is more than max_amount")
        return self


class PolicyFile(_Data):
    sample: bool
    label: str | None = None
    version: str
    note: str | None = None
    lenders: tuple[LenderPolicy, ...] = Field(min_length=1)


class Region(_Data):
    id: str = Field(pattern=r"^[a-z0-9_]{1,64}$")
    name: str
    ranges: tuple[tuple[int, int], ...] = Field(min_length=1)

    @model_validator(mode="after")
    def _six_digit_ranges(self):
        for low, high in self.ranges:
            if not 100000 <= low <= high <= 999999:
                raise ValueError(f"bad pincode range {low}-{high}")
        return self

    def contains(self, pincode: int) -> bool:
        return any(low <= pincode <= high for low, high in self.ranges)


class PincodeFile(_Data):
    sample: bool
    label: str | None = None
    version: str
    note: str | None = None
    regions: tuple[Region, ...] = Field(min_length=1)
    lenders: dict[str, tuple[str, ...]]


class Company(_Data):
    name: str = Field(min_length=1, max_length=200)
    aliases: tuple[str, ...] = ()
    employment_type: str | None = None
    synthetic: bool = False
    categories: dict[str, str]


class CompanyFile(_Data):
    sample: bool
    label: str | None = None
    version: str
    note: str | None = None
    companies: tuple[Company, ...]


_COMPANY_STOP = frozenset(
    {"pvt", "private", "ltd", "limited", "llp", "co", "company", "corp", "corporation", "inc", "the", "india"}
)


def company_key(name: str) -> str:
    """Comparison key of an employer name: case, punctuation and legal suffixes ignored."""
    text = str(name or "").casefold().replace("&", " and ")
    return " ".join(t for t in re.sub(r"[^a-z0-9]+", " ", text).split() if t not in _COMPANY_STOP)


class PolicyBook:
    """The three SAMPLE data files, validated together (every reference must resolve)."""

    def __init__(self, policies: PolicyFile, pincodes: PincodeFile, companies: CompanyFile):
        self.policies, self.pincodes, self.companies = policies, pincodes, companies
        self.lenders = policies.lenders
        self._lenders = {lender.id: lender for lender in self.lenders}
        if len(self._lenders) != len(self.lenders):
            raise ValueError("duplicate lender id")
        self._regions = {region.id: region for region in pincodes.regions}
        if len(self._regions) != len(pincodes.regions):
            raise ValueError("duplicate region id")
        for lender_id, region_ids in pincodes.lenders.items():
            if lender_id not in self._lenders:
                raise ValueError(f"pincodes: unknown lender {lender_id}")
            missing = [r for r in region_ids if r not in self._regions]
            if missing:
                raise ValueError(f"pincodes: unknown regions {missing} for {lender_id}")
        self._company_index: dict[str, Company] = {}
        for company in companies.companies:
            if company.employment_type is not None and company.employment_type not in EMPLOYMENT_TYPES:
                raise ValueError(f"companies: unknown employment type for {company.name}")
            for lender_id, category in company.categories.items():
                lender = self._lenders.get(lender_id)
                if lender is None:
                    raise ValueError(f"companies: unknown lender {lender_id} for {company.name}")
                if category not in lender.company_categories:
                    raise ValueError(f"companies: {lender.name} has no category {category!r} ({company.name})")
            for alias in (company.name, *company.aliases):
                key = company_key(alias)
                if not key:
                    raise ValueError(f"companies: empty name key for {company.name}")
                other = self._company_index.setdefault(key, company)
                if other is not company:
                    raise ValueError(f"companies: {alias!r} names both {other.name} and {company.name}")

    @property
    def sample(self) -> bool:
        return self.policies.sample or self.pincodes.sample or self.companies.sample

    @property
    def label(self) -> str | None:
        """The SAMPLE label, shown wherever this data is shown; None for a real grid."""
        return SAMPLE_LABEL if self.sample else None

    def lender(self, id_or_name: str | None) -> LenderPolicy | None:
        """A lender by id (icici_bank) or name (ICICI Bank), case and spacing ignored."""
        if not id_or_name:
            return None
        key = _enum_key(id_or_name)
        for lender in self.lenders:
            if key in (lender.id, _enum_key(lender.name)):
                return lender
        return None

    def region_of(self, pincode: str | None) -> Region | None:
        if not pincode or not str(pincode).isdigit():
            return None
        number = int(pincode)
        return next((region for region in self.pincodes.regions if region.contains(number)), None)

    def serviceable(self, lender_id: str, pincode: str) -> bool:
        if not str(pincode).isdigit():
            return False
        number = int(pincode)
        return any(self._regions[r].contains(number) for r in self.pincodes.lenders.get(lender_id, ()))

    def regions_of(self, lender_id: str) -> list[Region]:
        return [self._regions[r] for r in self.pincodes.lenders.get(lender_id, ())]

    def find_company(self, name: str | None) -> Company | None:
        """The listed company `name` is (its name or an alias, legal suffixes ignored); None if unlisted."""
        key = company_key(name or "")
        return self._company_index.get(key) if key else None

    def company_suggestions(self, text: str, limit: int = 10) -> list[Company]:
        """Listed companies whose name or alias contains `text` (starts-with first), for the lookup."""
        key = company_key(text)
        if not key:
            return []
        scored = []
        for company in self.companies.companies:
            keys = [company_key(n) for n in (company.name, *company.aliases)]
            if any(k.startswith(key) for k in keys):
                scored.append((0, company.name.casefold(), company))
            elif any(key in k for k in keys):
                scored.append((1, company.name.casefold(), company))
        return [company for _, _, company in sorted(scored, key=lambda s: s[:2])][:limit]


def _read(name: str, model: type[BaseModel]) -> Any:
    return model.model_validate(json.loads((DATA_DIR / name).read_text(encoding="utf-8")))


@lru_cache(maxsize=1)
def load_policy_book() -> PolicyBook:
    """The shipped SAMPLE policies, pincodes and companies (validated once)."""
    return PolicyBook(
        _read(POLICY_FILE, PolicyFile),
        _read(PINCODE_FILE, PincodeFile),
        _read(COMPANY_FILE, CompanyFile),
    )


# ------------------------------------------------------------------ name matching
_LENDER_STOP = frozenset(
    {
        "bank",
        "ltd",
        "limited",
        "pvt",
        "private",
        "finance",
        "financial",
        "fin",
        "services",
        "loan",
        "loans",
        "emi",
        "ach",
        "nach",
        "ecs",
        "the",
        "and",
        "india",
        "company",
        "corp",
        "sample",
        "auto",
        "motor",
        "motors",
        "home",
        "housing",
        "personal",
        "car",
        "credit",
        "card",
    }
)


def _name_tokens(name: Any) -> set[str]:
    text = re.sub(r"\(.*?\)", " ", str(name or "").casefold())
    return {t for t in re.findall(r"[a-z0-9]+", text) if len(t) >= 3 and not t.isdigit() and t not in _LENDER_STOP}


def same_lender(a: Any, b: Any) -> bool:
    """Two lender names share a distinctive word (HDFC Bank Ltd ~ HDFC BANK)."""
    return bool(_name_tokens(a) & _name_tokens(b))


def match_bank_emis(tradelines: list[dict], bank_emis: list[dict]) -> list[tuple[dict, int | None]]:
    """Pair each bank-statement EMI with at most one tradeline (1-based index) of the same EMI.

    Same EMI = within 2% (min Rs 1). Among several, one with a common lender word wins, then
    the closest amount, then the first. A tradeline is paired at most once.
    """
    used: set[int] = set()
    pairs: list[tuple[dict, int | None]] = []
    for bank in bank_emis:
        amount = dec(bank["amount"])
        tolerance = max(Decimal(1), amount * EMI_MATCH_TOLERANCE)
        names = _name_tokens(bank.get("lender")) | _name_tokens(bank.get("payee"))
        best: tuple[tuple, int] | None = None
        for index, tradeline in enumerate(tradelines, 1):
            if index in used or tradeline.get("emi") is None:
                continue
            difference = abs(dec(tradeline["emi"]) - amount)
            if difference > tolerance:
                continue
            rank = (0 if names & _name_tokens(tradeline.get("lender")) else 1, difference, index)
            if best is None or rank < best[0]:
                best = (rank, index)
        if best is None:
            pairs.append((bank, None))
        else:
            used.add(best[1])
            pairs.append((bank, best[1]))
    return pairs


# ------------------------------------------------------------------ calculation
def _tradeline_name(index: int, tradeline: dict) -> str:
    parts = [p for p in (tradeline.get("lender"), LOAN_TYPES.get(tradeline.get("loan_type") or "")) if p]
    return f"Tradeline {index}" + (f" ({', '.join(parts)})" if parts else "")


def _income(profile: dict, verified_income: dict | None, notes: list[str]) -> dict:
    entered = profile.get("net_income")
    verified = None
    if verified_income and verified_income.get("amount"):
        verified = dec(verified_income["amount"])
    verified_from = (verified_income or {}).get("source") or "the file check"
    if verified is not None:
        net, source = verified, "verified"
        source_label = f"verified from the documents ({verified_from})"
        if entered is not None and abs(dec(entered) - verified) > max(Decimal(1), verified * Decimal("0.01")):
            notes.append(
                f"Entered net income {inr(entered)} differs from the verified {inr(verified)} ({verified_from}): "
                "the verified amount is used"
            )
    elif entered is not None:
        net, source, source_label = dec(entered), "entered", "as entered (not verified against the documents)"
    else:
        net, source, source_label = None, None, "not entered"

    others = []
    for index, row in enumerate(profile.get("other_income") or [], 1):
        kind = row.get("type")
        label = OTHER_INCOME_TYPES.get(kind, str(kind))
        if row.get("amount") is None:
            notes.append(f"{label} (other income {index}) has no amount: not counted")
            continue
        frequency = row.get("frequency")
        if frequency is None:
            if kind in ("bonus", "incentive"):
                frequency = "yearly"
                notes.append(f"{label} (other income {index}) has no frequency: counted as yearly (the lowest)")
            else:
                frequency = "monthly"
        agreement = None
        key = kind
        if kind == "rented":
            agreement = row.get("agreement")
            if agreement is None:
                agreement = "notary"
                notes.append(
                    f"{label} (other income {index}) has no agreement type: counted as notary (the lower share)"
                )
            key = f"rented_{agreement}"
        amount = dec(row["amount"])
        others.append(
            {
                "index": index,
                "type": kind,
                "label": label,
                "agreement": agreement,
                "frequency": frequency,
                "amount": amount,
                "monthly": amount / MONTHS_PER_PERIOD[frequency],
                "key": key,
            }
        )
    return {
        "net": net,
        "entered": dec(entered) if entered is not None else None,
        "verified": verified,
        "source": source,
        "source_label": source_label,
        "others": others,
    }


def _obligations(tradelines: list[dict], bank_emis: list[dict], notes: list[str]) -> dict:
    counted, bt_rows, closed, not_counted, incomplete = [], [], [], [], []
    bt_amount = Decimal(0)
    for index, tradeline in enumerate(tradelines, 1):
        name = _tradeline_name(index, tradeline)
        action = tradeline.get("action") or "obligate"
        status = tradeline.get("status")
        row = {
            "index": index,
            "lender": tradeline.get("lender"),
            "loan_type": tradeline.get("loan_type"),
            "action": action,
            "emi": money(tradeline.get("emi")),
            "outstanding": money(tradeline.get("outstanding")),
        }
        if tradeline.get("overdue"):
            notes.append(
                f"{name} has an overdue of {inr(tradeline['overdue'])}: lenders usually decline a file with "
                "overdues until they are cleared"
            )
        if status in ADVERSE_STATUSES:
            notes.append(
                f"{name} is '{TRADELINE_STATUSES[status]}' on the bureau report: lenders usually decline such files"
            )
        if status == "closed":
            not_counted.append({**row, "note": "closed on the bureau report: not an obligation"})
            continue
        if action == "bt":
            if tradeline.get("outstanding") is None:
                incomplete.append(
                    f"Outstanding not entered for {name} marked BT: the balance-transfer amount is unknown"
                )
            else:
                bt_amount += dec(tradeline["outstanding"])
            bt_rows.append(
                {**row, "note": "balance transfer: its EMI is not an obligation; the outstanding is taken over"}
            )
        elif action == "close":
            closed.append({**row, "note": "to be closed before disbursal"})
            notes.append(f"{name}: to be closed before disbursal (its EMI is not counted)")
        elif tradeline.get("emi") is None:
            hint = (
                ": enter the monthly amount the lender counts for the card (often 5% of the outstanding)"
                if tradeline.get("loan_type") == "credit_card"
                else ""
            )
            incomplete.append(f"EMI not entered for {name} marked Obligate{hint}")
            not_counted.append({**row, "note": "EMI not entered"})
        else:
            counted.append({**row, "source": "tradeline", "flag": None, "_emi": dec(tradeline["emi"])})

    bank_rows = []
    for bank, index in match_bank_emis(tradelines, bank_emis):
        amount = dec(bank["amount"])
        shown = bank.get("lender") or bank.get("payee") or "an unnamed payee"
        bank_rows.append(
            {
                "payee": bank.get("payee"),
                "lender": bank.get("lender"),
                "amount": money(amount),
                "months_seen": bank.get("months_seen"),
                "months_total": bank.get("months_total"),
                "matched_tradeline": index,
                "counted": index is None,
            }
        )
        if index is not None:
            continue
        unverified = " (amount not verified against the statement text)" if bank.get("unverified") else ""
        flag = (
            f"Loan EMI {inr(amount)} to '{shown}' in the bank statement{unverified} matches no tradeline: it is "
            "counted as an obligation; add it as a tradeline (or mark that loan Close) to confirm"
        )
        notes.append(flag)
        counted.append(
            {
                "index": None,
                "lender": shown,
                "loan_type": None,
                "action": "obligate",
                "emi": money(amount),
                "outstanding": None,
                "source": "bank_statement",
                "flag": flag,
                "_emi": amount,
            }
        )
    total = sum((c.pop("_emi") for c in counted), Decimal(0))
    return {
        "total": total,
        "bt_amount": bt_amount,
        "incomplete": incomplete,
        "details": {
            "counted": counted,
            "bt": bt_rows,
            "closed": closed,
            "not_counted": not_counted,
            "bank_statement_emis": bank_rows,
        },
    }


def _calculation_tenure(lender: LenderPolicy, requested: int | None, notes: list[str]) -> tuple[int, str]:
    if requested is None:
        return lender.max_tenure_months, "policy"
    if requested > lender.max_tenure_months:
        notes.append(
            f"Requested tenure {requested} months is more than {lender.name}'s max {lender.max_tenure_months}: "
            f"eligibility is calculated at {lender.max_tenure_months} months"
        )
        return lender.max_tenure_months, "policy"
    if requested < lender.min_tenure_months:
        notes.append(
            f"Requested tenure {requested} months is less than {lender.name}'s min {lender.min_tenure_months}: "
            f"eligibility is calculated at {lender.min_tenure_months} months"
        )
        return lender.min_tenure_months, "policy"
    return requested, "table"


def _lender_result(
    lender: LenderPolicy,
    book: PolicyBook,
    profile: dict,
    cibil: dict,
    loan: dict,
    income: dict,
    obligations: dict,
    common_reasons: list[str],
) -> dict:
    reasons: list[str] = []
    notes: list[str] = []

    pincode = profile.get("pincode")
    region = book.region_of(pincode)
    serviceable = book.serviceable(lender.id, pincode) if pincode else None
    if not pincode:
        reasons.append("Pincode not entered: serviceability cannot be checked")

    employment_type = profile.get("employment_type")
    if employment_type is None:
        reasons.append("Employment type not entered")
    elif employment_type not in lender.employment_types:
        reasons.append(
            f"Employment type {EMPLOYMENT_TYPES.get(employment_type, employment_type)} is not accepted by {lender.name}"
        )

    foir, multiplier = dec(lender.foir), dec(lender.multiplier)
    category, company_policy = None, "base"
    company_name = profile.get("company")
    company = book.find_company(company_name)
    if not company_name:
        reasons.append("Company not entered: its category is needed")
    else:
        shown = company.name if company else company_name
        listed = company.categories.get(lender.id) if company else None
        if listed is not None:
            policy = lender.company_categories[listed]
            foir, multiplier = dec(policy.foir), dec(policy.multiplier)
            category, company_policy = listed, "category"
        elif lender.unlisted_company.accepted:
            foir = dec(lender.unlisted_company.foir)
            multiplier = dec(lender.unlisted_company.multiplier)
            company_policy = "unlisted"
            notes.append(
                f"'{shown}' is not in {lender.name}'s company list: its unlisted-company policy applies "
                f"(FOIR {_pct(foir)}, multiplier {_number(multiplier)})"
            )
        else:
            company_policy = "unlisted"
            reasons.append(
                f"'{shown}' is not in {lender.name}'s company list and {lender.name} does not accept unlisted companies"
            )

    score = cibil.get("score")
    if score is None:
        reasons.append("CIBIL score not entered")
    elif score < lender.min_cibil_score:
        reasons.append(f"CIBIL score {score} is below {lender.name}'s minimum {lender.min_cibil_score}")

    enquiries_90d = (cibil.get("enquiries") or {}).get("d90")
    if enquiries_90d is None:
        reasons.append("Enquiries in the last 90 days not entered")
    elif enquiries_90d > lender.max_enquiries_90d:
        reasons.append(
            f"{enquiries_90d} enquiries in the last 90 days: more than {lender.name}'s limit of "
            f"{lender.max_enquiries_90d}"
        )

    reasons.extend(common_reasons)

    tenure, tenure_source = _calculation_tenure(lender, loan.get("tenure_months"), notes)
    per_lakh = emi(LAKH, lender.roi, tenure)
    obligations_total = obligations["total"]
    bt_amount = obligations["bt_amount"]
    net = income["net"]
    income_considered = foir_eligibility = multiplier_eligibility = computed = None
    breakdown: list[dict] = []
    if net is not None:
        other_total = Decimal(0)
        for other in income["others"]:
            pct = dec(getattr(lender.income_consideration_pct, other["key"]))
            considered = other["monthly"] * pct / 100
            other_total += considered
            breakdown.append(
                {
                    "type": other["type"],
                    "label": other["label"],
                    "agreement": other["agreement"],
                    "frequency": other["frequency"],
                    "monthly_amount": money(other["monthly"]),
                    "consideration_pct": float(pct),
                    "considered": money(considered),
                }
            )
        income_considered = net + other_total
        headroom = income_considered * foir - obligations_total
        foir_eligibility = max(headroom, Decimal(0)) / per_lakh * LAKH
        multiplier_eligibility = income_considered * multiplier
        # The sheet's =MIN(FOIR eligibility, multiplier eligibility), capped at the lender's maximum.
        computed = min(foir_eligibility, multiplier_eligibility, dec(lender.max_amount))
        if headroom <= 0:
            reasons.append(
                f"Existing obligations {inr(obligations_total)} leave no room within FOIR {_pct(foir)} of "
                f"{inr(income_considered)} ({inr(income_considered * foir)})"
            )
        elif computed < max(dec(lender.min_amount), MIN_LOAN_AMOUNT):
            minimum = max(dec(lender.min_amount), MIN_LOAN_AMOUNT)
            reasons.append(f"Eligible amount {inr(computed)} is below {lender.name}'s minimum loan {inr(minimum)}")
        if bt_amount > 0 and computed < bt_amount:
            reasons.append(f"Eligible amount {inr(computed)} does not cover the balance transfer of {inr(bt_amount)}")

    for bt in obligations["details"]["bt"]:
        if same_lender(bt["lender"], lender.name):
            notes.append(
                f"{_tradeline_name(bt['index'], bt)} is with {lender.name} itself: a lender cannot take over its "
                "own loan by balance transfer (a top-up instead)"
            )

    if serviceable is False:
        status = "not_serviceable"
        reasons.insert(0, f"Pincode {pincode} is not serviceable by {lender.name}")
    elif reasons:
        status = "not_eligible"
    else:
        status = "eligible"
    eligible = computed if status == "eligible" and computed is not None else Decimal(0)
    monthly_emi = emi(eligible, lender.roi, lender.max_tenure_months) if eligible > 0 else Decimal(0)
    calculation_emi = emi(eligible, lender.roi, tenure) if eligible > 0 else Decimal(0)

    requested_amount = loan.get("amount")
    covers_requested = None
    if status == "eligible" and requested_amount is not None:
        covers_requested = eligible >= dec(requested_amount)
        if not covers_requested:
            notes.append(f"{inr(eligible)} is less than the requested {inr(requested_amount)}")

    return {
        "lender": lender.name,
        "lender_id": lender.id,
        "status": status,
        "status_label": STATUS_LABELS[status],
        "reasons": reasons,
        "notes": notes,
        "eligible_amount": money(eligible),
        "computed_amount": money(computed),
        "tenure_months": lender.max_tenure_months,
        "roi": lender.roi,
        "emi": money(monthly_emi),
        "calculation_tenure_months": tenure,
        "emi_at_calculation_tenure": money(calculation_emi),
        "per_lakh_emi": money(per_lakh),
        "foir_eligibility": money(foir_eligibility),
        "multiplier_eligibility": money(multiplier_eligibility),
        "income_considered": money(income_considered),
        "other_income_considered": breakdown,
        "obligations": money(obligations_total),
        "foir": float(foir),
        "multiplier": float(multiplier),
        "company_category": category,
        "company_policy": company_policy,
        "max_amount": lender.max_amount,
        "min_amount": lender.min_amount,
        "bt_amount": money(bt_amount),
        "covers_bt": (computed >= bt_amount) if computed is not None and bt_amount > 0 else None,
        "covers_requested": covers_requested,
        "serviceable": serviceable,
        "region": region.name if region else None,
        "sources": {
            "income": "table",
            "obligations": "table",
            "bt_amount": "table",
            "pincode": "table",
            "company_category": "table",
            "foir": "policy",
            "multiplier": "policy",
            "roi": "policy",
            "tenure_months": "policy",
            "max_amount": "policy",
            "calculation_tenure_months": tenure_source,
            "per_lakh_emi": "formula",
            "foir_eligibility": "formula",
            "multiplier_eligibility": "formula",
            "eligible_amount": "formula",
            "emi": "formula",
        },
        "label": book.label,
    }


def _best_lender(results: list[dict], loan: dict, bt_amount: Decimal) -> tuple[dict | None, str | None]:
    """Lowest ROI among the eligible lenders that cover the need (requested amount, BT); else the
    highest eligible amount."""
    eligible = [r for r in results if r["status"] == "eligible" and (r["eligible_amount"] or 0) > 0]
    if not eligible:
        return None, None
    requested = loan.get("amount")
    need = max(dec(requested) if requested is not None else Decimal(0), bt_amount)
    if need > 0:
        covering = [r for r in eligible if dec(r["eligible_amount"]) >= need]
        if covering:
            best = min(covering, key=lambda r: (r["roi"], -r["eligible_amount"], r["emi"], r["lender"]))
            return best, f"lowest ROI among the lenders that cover {inr(need)}"
    best = max(eligible, key=lambda r: (r["eligible_amount"], -r["roi"], r["lender"]))
    return best, "highest eligible amount"


def calculate(
    inputs: dict[str, Any],
    *,
    verified_income: dict[str, Any] | None = None,
    bank_emis: list[dict[str, Any]] | None = None,
    book: PolicyBook | None = None,
) -> dict[str, Any]:
    """Eligibility of one applicant at every lender of `book` (default: the shipped SAMPLE data).

    `inputs` is {profile, cibil, loan} with the API's ids (see app/routers/eligibility.py);
    `verified_income` is {amount, source} from the file check; `bank_emis` are the loan EMIs the
    file check found in the bank statement ({amount, payee, lender, months_seen, months_total,
    unverified}). Returns the calculation with money rounded to the paisa for display.
    """
    book = book or load_policy_book()
    profile = inputs.get("profile") or {}
    cibil = inputs.get("cibil") or {}
    loan = inputs.get("loan") or {}
    notes: list[str] = []
    with localcontext() as ctx:
        ctx.prec = PRECISION
        income = _income(profile, verified_income, notes)
        obligations = _obligations(list(cibil.get("tradelines") or []), list(bank_emis or []), notes)
        common_reasons = []
        if income["net"] is None:
            common_reasons.append("Net monthly income not entered")
        common_reasons.extend(obligations["incomplete"])
        results = [
            _lender_result(lender, book, profile, cibil, loan, income, obligations, common_reasons)
            for lender in book.lenders
        ]
        best, why = _best_lender(results, loan, obligations["bt_amount"])
        other_monthly = sum((o["monthly"] for o in income["others"]), Decimal(0))

    disclaimers = [
        "Indicative — the lender decides: the final eligibility, amount, ROI and tenure are the lender's decision.",
        "Calculated with fixed formulas in the backend (per-lakh EMI, FOIR and multiplier eligibility, EMI as "
        "Excel PMT); no AI model decides any number.",
    ]
    if book.sample:
        disclaimers.insert(
            1,
            "Sample policy — replace with your lender grid: the lender policies, pincode lists and company "
            "categories used here are SAMPLE data, not any lender's real grid.",
        )
    if income["source"] == "entered":
        disclaimers.append("Net income as entered: not verified against the documents.")

    return {
        "sample": book.sample,
        "policy_label": book.label,
        "label": INDICATIVE_LABEL,
        "income_considered": money(income["net"]),
        "income": {
            "net_salary": money(income["net"]),
            "net_salary_source": income["source"],
            "net_salary_source_label": income["source_label"],
            "entered_net_income": money(income["entered"]),
            "verified_net_income": money(income["verified"]),
            "other_income": [
                {
                    "type": o["type"],
                    "label": o["label"],
                    "agreement": o["agreement"],
                    "frequency": o["frequency"],
                    "amount": money(o["amount"]),
                    "monthly_amount": money(o["monthly"]),
                }
                for o in income["others"]
            ],
            "other_income_monthly": money(other_monthly),
        },
        "obligations": money(obligations["total"]),
        "obligation_details": obligations["details"],
        "bt_amount": money(obligations["bt_amount"]),
        "requested": {"amount": money(loan.get("amount")), "tenure_months": loan.get("tenure_months")},
        "per_lender": results,
        "best_lender": best["lender"] if best else None,
        "best_lender_id": best["lender_id"] if best else None,
        "best_lender_reason": why,
        "notes": notes,
        "disclaimers": disclaimers,
    }
