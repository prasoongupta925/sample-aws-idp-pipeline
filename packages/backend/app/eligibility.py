"""Loan eligibility per lender for the CIBIL page: deterministic maths, never a model.

Implements the client's "Cibil Page Function" sheet (Data Entry, CAM, Eligibility)
for every lender of the policy file:

    calculation tenure     = the lender's calculation tenure (From Policy; its max tenure when
                             the policy sets none), or the requested tenure when that is shorter
                             (raised to the lender's min tenure), so the EMI fits the FOIR at
                             the tenure the customer takes
    per-lakh EMI           = EMI(1,00,000, ROI / 12, calculation tenure)
    FOIR eligibility       = (income x FOIR - obligations) / per-lakh EMI x 1,00,000
    multiplier eligibility = income x multiplier
    eligible amount        = min(FOIR eligibility, multiplier eligibility, lender max amount)
                             (the sheet's MIN: exact, rounded to the paisa only for display)
    EMI                    = EMI(eligible amount, ROI / 12, lender max tenure), as the sheet
                             shows it (also given over the calculation tenure)

where EMI(P, r, n) = P r (1 + r)^n / ((1 + r)^n - 1), Excel's PMT. The sheet's worked
example (income 98,000, FOIR 0.70, multiplier 21, obligations 15,000; ICICI Bank at 11%
with a calculation tenure of 60 months and a max tenure of 72) gives a per-lakh EMI of
2,174.24, FOIR eligibility 24,65,226.61 and multiplier eligibility 20,58,000, so ICICI
Bank offers 20,58,000 (EMI 39,172.13 over its max 72 months); HDFC Bank's cap gives
15,00,000 (EMI 33,366.67 over 60 months at 12%).

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

A lender may instead price a listed company's FOIR by a grid of net monthly salary slabs and
company categories (`foir_grid`, HDFC Bank's SAMPLE one), as the sheet's
=INDEX(grid, MATCH(salary, slab_starts, 1), MATCH(category, categories, 0)) does: the row is
the largest slab start at or below the net monthly salary (verified, else entered; other
income is not part of it), the column the company's category, matched exactly. A salary
below the first slab start is below the lender's minimum income, and a category the grid has
no column for gets no FOIR: either makes the lender "not_eligible" (the category's own FOIR is
kept for `computed_amount`). The slab and category that set the FOIR are noted ("FOIR 65% ·
slab 50,000–74,999 · CAT A · From Policy"); the multiplier still comes from the category.

A bank of the client's policy workbook (SheetGrid, built from the stored workbook by sheet_lenders)
is priced by its cells and its rules instead: the slab is the highest slab start at or below the net
monthly salary (below the lowest: not eligible, with the bank's minimum); the category is the
company's with that bank, CAT U when the company is not in its list (and the note says so); ROI,
FOIR, multiplier, Maximum Funding and both tenures are the cells of that slab and category; the
per-lakh EMI is at the Tenure for Eligibility Calculation whatever tenure is requested, the EMI at
the Maximum Tenure. Its second-sheet rules apply: the multiplier method (income x multiplier, or
(income - obligations) x multiplier); the bonus formula (the bonus of the last N years x share / D
months, a yearly bonus counting for each year), the incentive frequencies it accepts (counted in
full), its rental-income share (none where NA); a co-applicant's net salary added in full only
when the co-applicant's employer meets its rule ("Listed Company": in the bank's company list;
"All Companies except proprietor and partnership"); a gold loan's obligation as a share of its
outstanding a month where given (else its EMI: "gold loan: bank rule not given"); at most PLBT
personal loans and CCBT credit cards (none where NA) marked BT. The HL deviation is shown, never
used. What the sheet does not give (minimum CIBIL, maximum enquiries, employment types, processing
fee, the pension share, the minimum loan) is the sample policy's, labelled "Sample: not in your
policy sheet". `policy_sheet.lines` gives every value and rule used with its cell, for Details.

Parameter sources follow the sheet's legend: "policy" (From Policy: the lender policy),
"formula" (Formula Calculation) and "table" (From Table: the data entered or read from the
documents, and the company and pincode lists).

Money is kept exact (Decimal, 34 digits) through the maths and rounded to the paisa
(half up) only in the output. Every lender policy, pincode list and company category in
app/data is SAMPLE data, labelled "sample policy — replace with your lender grid" wherever
it is shown, and every result is indicative: the lender decides.

Standard library only. This file ships twice, each copy with the same data/ folder, and the
copies must stay byte-identical (the backend and the Lambda test suites both compare them):

- packages/backend/app/eligibility.py: the eligibility API (app/routers/eligibility.py);
- packages/lambda/file-check-mcp/eligibility.py: the chat's loan_eligibility tool.

The backend image and the Lambda asset are packaged from different folders, so the module
is copied instead of imported across packages.
"""

import datetime as _dt
import json
import math
import re
from collections.abc import Callable, Collection
from dataclasses import MISSING, dataclass, field, fields, replace
from decimal import ROUND_HALF_UP, Decimal, localcontext
from functools import lru_cache
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).resolve().parent / "data"
POLICY_FILE = "lender_policies.json"
PINCODE_FILE = "pincodes.json"
COMPANY_FILE = "companies.json"

SAMPLE_LABEL = "sample policy — replace with your lender grid"
INDICATIVE_LABEL = "indicative — the lender decides"
# The client's policy workbook (app/policy_workbook.py): what it gives, and the sample values it lacks.
SHEET_SOURCE_LABEL = "From Policy (your sheet)"
NOT_IN_SHEET_LABEL = "Sample: not in your policy sheet"

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
    "gold": "Gold Loan",
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


def _annuity(r: Decimal, n: int) -> Decimal:
    """Present value of 1 a month for n months at `r` a month: (1 − (1 + r)^−n) ÷ r; n at 0."""
    if r == 0:
        return Decimal(n)
    return (1 - (1 + r) ** -n) / r


def apr(principal: Any, roi_pct: Any, months: int, fee: Any = 0) -> Decimal:
    """Annual percentage rate, percent (unrounded): 12 × 100 × r, where r is the monthly rate at which
    the EMIs repay what the borrower gets, principal − fee: (P − fee) = EMI × (1 − (1 + r)^−n) ÷ r
    (the RBI Key Fact Statement's IRR, annualised by 12). The ROI itself when there is no fee."""
    n = int(months)
    with localcontext() as ctx:
        ctx.prec = PRECISION
        p, charge = dec(principal), dec(fee)
        if p <= 0:
            raise ValueError("principal must be positive")
        if not 0 <= charge < p:
            raise ValueError("fee must be at least 0 and less than the principal")
        if charge == 0:
            return dec(roi_pct)
        payment = emi(p, roi_pct, n)
        net = p - charge
        # The annuity factor falls as r rises: bisect between the ROI's rate and a rate high enough.
        low, high = dec(roi_pct) / Decimal(1200), Decimal(1)
        while payment * _annuity(high, n) > net:
            high *= 2
        for _ in range(200):
            mid = (low + high) / 2
            if payment * _annuity(mid, n) > net:
                low = mid
            else:
                high = mid
            if high - low < Decimal("1e-15"):
                break
        return (low + high) / 2 * 1200


def total_cost(principal: Any, roi_pct: Any, months: int, fee: Any = 0) -> Decimal:
    """Total interest plus fees over the tenure (unrounded): EMI × n − P + fee."""
    with localcontext() as ctx:
        ctx.prec = PRECISION
        return emi(principal, roi_pct, months) * int(months) - dec(principal) + dec(fee)


def percent(value: Any) -> float | None:
    """Display rounding of a percent rate: to 2 decimals, half up."""
    if value is None:
        return None
    return float(dec(value).quantize(PAISA, rounding=ROUND_HALF_UP))


def money(value: Any) -> float | None:
    """Display rounding: to the paisa, half up."""
    if value is None:
        return None
    return float(dec(value).quantize(PAISA, rounding=ROUND_HALF_UP))


def _grouped(digits: str) -> str:
    """Indian digit grouping of whole rupees: '2058000' -> '20,58,000'."""
    if len(digits) <= 3:
        return digits
    head, tail = digits[:-3], digits[-3:]
    return ",".join(re.findall(r"\d{1,2}", head[::-1]))[::-1] + f",{tail}"


def inr(value: Any) -> str:
    """Indian digit grouping for messages: 2058000 -> Rs 20,58,000 (paise only when not zero)."""
    if value is None:
        return "–"
    d = dec(value).quantize(PAISA, rounding=ROUND_HALF_UP)
    sign = "-" if d < 0 else ""
    whole, _, frac = f"{abs(d):.2f}".partition(".")
    return f"{sign}₹{_grouped(whole)}" + (f".{frac}" if frac != "00" else "")


def _pct(fraction: Decimal) -> str:
    value = (fraction * 100).normalize()
    return f"{value:f}%"


def _number(value: Decimal) -> str:
    return f"{value.normalize():f}"


# ------------------------------------------------------------------ SAMPLE data files
# Frozen records, every field checked when one is made: a bad value is a ValueError naming
# where it is ("PolicyFile: lenders[1]: roi: must be at most 60") and a file with an unknown
# key is refused. model_validate / model_dump / model_copy work as in pydantic, which the
# file-check Lambda does not have.
Check = Callable[[Any, str], Any]


def _invalid(where: str, problem: str) -> ValueError:
    return ValueError(f"{where}: {problem}")


def _real(*, gt: float | None = None, ge: float | None = None, le: float | None = None) -> Check:
    def check(value: Any, where: str) -> float:
        if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
            raise _invalid(where, "must be a number")
        if gt is not None and value <= gt:
            raise _invalid(where, f"must be more than {gt:g}")
        if ge is not None and value < ge:
            raise _invalid(where, f"must be at least {ge:g}")
        if le is not None and value > le:
            raise _invalid(where, f"must be at most {le:g}")
        return float(value)

    return check


def _whole(*, ge: int | None = None, le: int | None = None) -> Check:
    def check(value: Any, where: str) -> int:
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        if isinstance(value, bool) or not isinstance(value, int):
            raise _invalid(where, "must be a whole number")
        if ge is not None and value < ge:
            raise _invalid(where, f"must be at least {ge}")
        if le is not None and value > le:
            raise _invalid(where, f"must be at most {le}")
        return value

    return check


def _text(*, pattern: str | None = None, min_length: int = 0, max_length: int | None = None) -> Check:
    def check(value: Any, where: str) -> str:
        if not isinstance(value, str):
            raise _invalid(where, "must be a string")
        if len(value) < min_length:
            raise _invalid(where, f"must have at least {min_length} character(s)")
        if max_length is not None and len(value) > max_length:
            raise _invalid(where, f"must have at most {max_length} characters")
        if pattern is not None and not re.fullmatch(pattern, value):
            raise _invalid(where, f"must match {pattern}")
        return value

    return check


def _flag(value: Any, where: str) -> bool:
    if not isinstance(value, bool):
        raise _invalid(where, "must be true or false")
    return value


def _optional(check: Check) -> Check:
    return lambda value, where: None if value is None else check(value, where)


def _items(check: Check, *, min_length: int = 0, length: int | None = None) -> Check:
    def items(value: Any, where: str) -> tuple:
        if not isinstance(value, list | tuple):
            raise _invalid(where, "must be a list")
        if length is not None and len(value) != length:
            raise _invalid(where, f"must have {length} items")
        if len(value) < min_length:
            raise _invalid(where, f"must have at least {min_length} item(s)")
        return tuple(check(v, f"{where}[{i}]") for i, v in enumerate(value))

    return items


def _mapping(check: Check) -> Check:
    def mapping(value: Any, where: str) -> dict:
        if not isinstance(value, dict) or not all(isinstance(k, str) for k in value):
            raise _invalid(where, "must be an object")
        return {k: check(v, f"{where}.{k}") for k, v in value.items()}

    return mapping


def _record(model: type["_Data"]) -> Check:
    return lambda value, where: model.model_validate(value, where=where)


def _spec(check: Check, default: Any = MISSING) -> Any:
    """A record field: how its value is checked, and its default when a file leaves it out."""
    return field(default=default, metadata={"check": check})


def _dump(value: Any, mode: str) -> Any:
    if isinstance(value, _Data):
        return value.model_dump(mode=mode)
    if isinstance(value, list | tuple):
        items = [_dump(v, mode) for v in value]
        return items if mode == "json" else tuple(items)
    if isinstance(value, dict):
        return {k: _dump(v, mode) for k, v in value.items()}
    return value


class _Data:
    """Base of the records below (frozen dataclasses whose fields are `_spec`s)."""

    def __post_init__(self) -> None:
        for spec in fields(self):
            object.__setattr__(self, spec.name, spec.metadata["check"](getattr(self, spec.name), spec.name))
        self._consistent()

    def _consistent(self) -> None:
        """Rules across fields (none by default); raise ValueError."""

    @classmethod
    def model_validate(cls, data: Any, *, where: str = "") -> Any:
        """The record of `data`, a dict as read from JSON (a record is returned as it is)."""
        if isinstance(data, cls):
            return data
        where = where or cls.__name__
        if not isinstance(data, dict):
            raise _invalid(where, "must be an object")
        names = [spec.name for spec in fields(cls)]
        unknown = sorted(str(key) for key in data if key not in names)
        if unknown:
            raise _invalid(where, f"unknown field(s) {', '.join(unknown)}")
        missing = [
            spec.name
            for spec in fields(cls)
            if spec.default is MISSING and spec.default_factory is MISSING and spec.name not in data
        ]
        if missing:
            raise _invalid(where, f"missing field(s) {', '.join(missing)}")
        try:
            return cls(**data)
        except ValueError as e:
            raise _invalid(where, str(e)) from None

    def model_dump(self, *, exclude: Collection[str] = (), mode: str = "python") -> dict[str, Any]:
        """The record as plain values: dicts, and tuples (lists in mode "json")."""
        return {spec.name: _dump(getattr(self, spec.name), mode) for spec in fields(self) if spec.name not in exclude}

    def model_copy(self, *, update: dict[str, Any] | None = None) -> Any:
        return replace(self, **(update or {}))


@dataclass(frozen=True, kw_only=True)
class CategoryPolicy(_Data):
    foir: float = _spec(_real(gt=0, le=1))
    multiplier: float = _spec(_real(gt=0, le=100))


@dataclass(frozen=True, kw_only=True)
class UnlistedCompanyPolicy(_Data):
    accepted: bool = _spec(_flag)
    foir: float | None = _spec(_optional(_real(gt=0, le=1)), None)
    multiplier: float | None = _spec(_optional(_real(gt=0, le=100)), None)

    def _consistent(self) -> None:
        if self.accepted and (self.foir is None or self.multiplier is None):
            raise ValueError("an accepted unlisted company needs foir and multiplier")


@dataclass(frozen=True, kw_only=True)
class IncomeConsideration(_Data):
    """Percent of each other income (normalised to a month) the lender counts."""

    rented_notary: float = _spec(_real(ge=0, le=100))
    rented_registered: float = _spec(_real(ge=0, le=100))
    bonus: float = _spec(_real(ge=0, le=100))
    incentive: float = _spec(_real(ge=0, le=100))
    pension: float = _spec(_real(ge=0, le=100))


@dataclass(frozen=True, kw_only=True)
class ProcessingFee(_Data):
    """The lender's processing fee: `pct` percent of the loan, at least `min_amount` and at most
    `max_amount` rupees when set (never more than the loan)."""

    pct: float = _spec(_real(ge=0, le=10))
    min_amount: float | None = _spec(_optional(_real(ge=0)), None)
    max_amount: float | None = _spec(_optional(_real(gt=0)), None)

    def _consistent(self) -> None:
        if self.min_amount is not None and self.max_amount is not None and self.min_amount > self.max_amount:
            raise ValueError("min_amount is more than max_amount")

    def amount(self, principal: Any) -> Decimal:
        """The fee on `principal` rupees, unrounded."""
        p = dec(principal)
        fee = p * dec(self.pct) / 100
        if self.min_amount is not None:
            fee = max(fee, dec(self.min_amount))
        if self.max_amount is not None:
            fee = min(fee, dec(self.max_amount))
        return min(fee, p)


@dataclass(frozen=True, kw_only=True)
class FoirGrid(_Data):
    """FOIR by net monthly salary slab (rows) and company category (columns): one FOIR per slab
    in each category's list, the slabs starting at `slab_starts` (rupees a month)."""

    label: str | None = _spec(_optional(_text()), None)
    slab_starts: tuple[int, ...] = _spec(_items(_whole(ge=1), min_length=1))
    categories: dict[str, tuple[float, ...]] = _spec(_mapping(_items(_real(gt=0, le=1))))

    def _consistent(self) -> None:
        if list(self.slab_starts) != sorted(set(self.slab_starts)):
            raise ValueError("slab_starts must increase")
        if not self.categories:
            raise ValueError("a FOIR grid needs at least one category")
        for name, column in self.categories.items():
            if len(column) != len(self.slab_starts):
                raise ValueError(f"{name} needs one FOIR per slab ({len(self.slab_starts)})")

    def slab(self, salary: Any) -> int | None:
        """MATCH(salary, slab_starts, 1): the index of the largest slab start at or below `salary`;
        None below the first."""
        below = [i for i, start in enumerate(self.slab_starts) if start <= dec(salary)]
        return below[-1] if below else None

    def slab_text(self, index: int) -> str:
        """'50,000–74,999'; the last slab '1,00,000 and above'."""
        start = _grouped(str(self.slab_starts[index]))
        if index + 1 == len(self.slab_starts):
            return f"{start} and above"
        return f"{start}–{_grouped(str(self.slab_starts[index + 1] - 1))}"


# The policy workbook's second sheet: one row of rules per bank (rule -> its column).
SHEET_RULES = {
    "hl_deviation": "HL Deviation",
    "multiplier_method": "Multiplier",
    "ccbt": "CCBT",
    "plbt": "PLBT",
    "app_bt": "App BT",
    "gold_loan": "Gold Loan",
    "bonus": "Bonus Calculation",
    "incentive": "Incentive",
    "rental_income": "Rental Income",
    "co_applicant": "Co-Applicant Salary",
}
MULTIPLIER_METHODS = {"salary": "income × multiplier", "net_of_obligations": "(income − obligations) × multiplier"}
CO_APPLICANT_RULES = {
    "listed_company": "Listed Company",
    "all_except_proprietorship_partnership": "All Companies except proprietor and partnership",
}


@dataclass(frozen=True, kw_only=True)
class SheetBonus(_Data):
    """The bonus counted a month: the bonus of the last `years` years x `share`, divided by `divisor`."""

    years: int = _spec(_whole(ge=1, le=10))
    share: float = _spec(_real(gt=0, le=1))
    divisor: int = _spec(_whole(ge=1, le=240))


@dataclass(frozen=True, kw_only=True)
class SheetRules(_Data):
    """A bank's row of the policy workbook's second sheet; `cells` and `texts` give, per rule (a
    SHEET_RULES key), the cell it came from and its text as the sheet shows it."""

    sheet: str = _spec(_text(min_length=1, max_length=100), "Sheet2")
    # Stored and shown, never used: its meaning is to be confirmed with the client.
    hl_deviation: float | None = _spec(_optional(_real(ge=0, le=1)), None)
    multiplier_method: str | None = _spec(_optional(_text(pattern="|".join(MULTIPLIER_METHODS))), None)
    # Credit cards a balance transfer may take over (0: none); personal loans (None: not given).
    ccbt_max_cards: int = _spec(_whole(ge=0, le=100), 0)
    plbt_max_loans: int | None = _spec(_optional(_whole(ge=0, le=100)), None)
    app_bt: str | None = _spec(_optional(_text(max_length=200)), None)
    # A gold loan's obligation: this fraction of its outstanding a month (None: the EMI, as for any loan).
    gold_loan_monthly_pct: float | None = _spec(_optional(_real(gt=0, le=0.2)), None)
    bonus: SheetBonus | None = _spec(_optional(_record(SheetBonus)), None)
    incentive_frequencies: tuple[str, ...] = _spec(_items(_text(pattern="|".join(INCOME_FREQUENCIES))), ())
    rental_income_share: float | None = _spec(_optional(_real(ge=0, le=1)), None)
    co_applicant_rule: str | None = _spec(_optional(_text(pattern="|".join(CO_APPLICANT_RULES))), None)
    cells: dict[str, str] = _spec(_mapping(_text(max_length=12)))
    texts: dict[str, str] = _spec(_mapping(_text(max_length=200)))

    def _consistent(self) -> None:
        unknown = sorted(set(self.cells) - set(SHEET_RULES)) + sorted(set(self.texts) - set(SHEET_RULES))
        if unknown:
            raise ValueError(f"unknown rules {unknown}")


SHEET_PARAMETERS = {
    "roi": "ROI",
    "foir": "FOIR",
    "multiplier": "Multiplier",
    "max_funding": "Maximum Funding",
    "max_tenure_months": "Maximum Tenure",
    "calculation_tenure_months": "Tenure for Eligibility Calculation",
}


@dataclass(frozen=True, kw_only=True)
class SheetGrid(_Data):
    """A lender's terms from the client's policy workbook (app/policy_workbook.py): per net monthly
    salary slab (rows, starting at `slab_starts`) and company category (`categories`, as the app
    shows them; `codes` as the sheet writes them), the value of each SHEET_PARAMETERS key and the
    cell it came from. Values are as in the sheet: ROI and FOIR as fractions (0.13 = 13%)."""

    label: str = _spec(_text(min_length=1))
    bank: str = _spec(_text(min_length=1, max_length=100))
    sheet: str = _spec(_text(min_length=1, max_length=100), "Sheet1")
    slab_starts: tuple[int, ...] = _spec(_items(_whole(ge=0), min_length=1))
    categories: tuple[str, ...] = _spec(_items(_text(min_length=1, max_length=40), min_length=1))
    codes: tuple[str, ...] = _spec(_items(_text(min_length=1, max_length=40), min_length=1))
    unlisted_category: str | None = _spec(_optional(_text()), None)
    values: dict[str, dict[str, tuple[float | None, ...]]] = _spec(_mapping(_mapping(_items(_optional(_real(ge=0))))))
    cells: dict[str, dict[str, tuple[str, ...]]] = _spec(_mapping(_mapping(_items(_text(max_length=12)))))
    # Per category, per slab: the sheet has NA / blank there, so the bank does not lend to it.
    not_offered: dict[str, tuple[bool, ...]] = field(default_factory=dict, metadata={"check": _mapping(_items(_flag))})
    # The bank's rules of the second sheet; None: the sheet has no row for the bank.
    rules: SheetRules | None = _spec(_optional(_record(SheetRules)), None)

    def _consistent(self) -> None:
        if list(self.slab_starts) != sorted(set(self.slab_starts)):
            raise ValueError("slab_starts must increase")
        if len(self.codes) != len(self.categories):
            raise ValueError("one code per category")
        if self.unlisted_category is not None and self.unlisted_category not in self.categories:
            raise ValueError("unlisted_category is not one of the categories")
        for category, flags in self.not_offered.items():
            if category not in self.categories or len(flags) != len(self.slab_starts):
                raise ValueError("not_offered needs a known category and one flag per slab")
        for key in SHEET_PARAMETERS:
            for table in (self.values, self.cells):
                column = table.get(key)
                if column is None or set(column) != set(self.categories):
                    raise ValueError(f"{key} needs one column per category")
                if any(len(v) != len(self.slab_starts) for v in column.values()):
                    raise ValueError(f"{key} needs one value per slab")

    def slab(self, salary: Any) -> int | None:
        """The index of the highest slab start at or below `salary`; None below the first."""
        below = [i for i, start in enumerate(self.slab_starts) if start <= dec(salary)]
        return below[-1] if below else None

    def code(self, category: str) -> str:
        return self.codes[self.categories.index(category)]


@dataclass(frozen=True, kw_only=True)
class LenderPolicy(_Data):
    id: str = _spec(_text(pattern=r"[a-z0-9_]{1,64}"))
    name: str = _spec(_text(min_length=1, max_length=100))
    product: str | None = _spec(_optional(_text()), None)
    roi: float = _spec(_real(ge=0, le=60))  # annual rate of interest, percent (the from-rate of a range)
    # The top of the lender's ROI range, shown with roi; the calculation uses roi.
    roi_max: float | None = _spec(_optional(_real(ge=0, le=60)), None)
    foir: float = _spec(_real(gt=0, le=1))
    multiplier: float = _spec(_real(gt=0, le=100))
    # The FOIR of a listed company by net salary slab and category, instead of its category's FOIR.
    foir_grid: FoirGrid | None = _spec(_optional(_record(FoirGrid)), None)
    min_tenure_months: int = _spec(_whole(ge=1, le=480), 1)
    max_tenure_months: int = _spec(_whole(ge=1, le=480))
    # The sheet's "Tenure Calculation" (From Policy): the per-lakh EMI's tenure; the max tenure if not set.
    calculation_tenure_months: int | None = _spec(_optional(_whole(ge=1, le=480)), None)
    min_amount: float = _spec(_real(ge=0), 0.0)
    max_amount: float = _spec(_real(gt=0))
    min_cibil_score: int = _spec(_whole(ge=300, le=900))
    max_enquiries_90d: int = _spec(_whole(ge=0))
    employment_types: tuple[str, ...] = _spec(_items(_text()))
    company_categories: dict[str, CategoryPolicy] = _spec(_mapping(_record(CategoryPolicy)))
    unlisted_company: UnlistedCompanyPolicy = _spec(_record(UnlistedCompanyPolicy))
    income_consideration_pct: IncomeConsideration = _spec(_record(IncomeConsideration))
    # Counted in the APR and the total cost; none when not set.
    processing_fee: ProcessingFee | None = _spec(_optional(_record(ProcessingFee)), None)
    # The client's policy workbook: ROI, FOIR, multiplier, maximum funding and tenures by slab and
    # category, used instead of the fields above (which then only hold its first slab's values).
    sheet: SheetGrid | None = _spec(_optional(_record(SheetGrid)), None)

    def _consistent(self) -> None:
        if self.sheet is not None:
            unknown = [c for c in self.sheet.categories if c not in self.company_categories]
            if unknown:
                raise ValueError(f"sheet categories {unknown} are not company categories")
        unknown = [t for t in self.employment_types if t not in EMPLOYMENT_TYPES]
        if unknown:
            raise ValueError(f"unknown employment types {unknown}")
        if self.min_tenure_months > self.max_tenure_months:
            raise ValueError("min_tenure_months is more than max_tenure_months")
        if not self.min_tenure_months <= self.calculation_tenure <= self.max_tenure_months:
            raise ValueError("calculation_tenure_months is outside min_tenure_months to max_tenure_months")
        if self.min_amount > self.max_amount:
            raise ValueError("min_amount is more than max_amount")
        if self.roi_max is not None and self.roi_max < self.roi:
            raise ValueError("roi_max is less than roi")
        if self.foir_grid is not None:
            # The multiplier of a grid category comes from its company category.
            unknown = [c for c in self.foir_grid.categories if c not in self.company_categories]
            if unknown:
                raise ValueError(f"foir_grid categories {unknown} are not company categories")

    @property
    def calculation_tenure(self) -> int:
        """The per-lakh EMI's tenure by policy: calculation_tenure_months, else the max tenure."""
        return self.calculation_tenure_months or self.max_tenure_months


@dataclass(frozen=True, kw_only=True)
class PolicyFile(_Data):
    sample: bool = _spec(_flag)
    label: str | None = _spec(_optional(_text()), None)
    version: str = _spec(_text())
    note: str | None = _spec(_optional(_text()), None)
    lenders: tuple[LenderPolicy, ...] = _spec(_items(_record(LenderPolicy), min_length=1))


@dataclass(frozen=True, kw_only=True)
class Region(_Data):
    id: str = _spec(_text(pattern=r"[a-z0-9_]{1,64}"))
    name: str = _spec(_text())
    ranges: tuple[tuple[int, int], ...] = _spec(_items(_items(_whole(), length=2), min_length=1))

    def _consistent(self) -> None:
        for low, high in self.ranges:
            if not 100000 <= low <= high <= 999999:
                raise ValueError(f"bad pincode range {low}-{high}")

    def contains(self, pincode: int) -> bool:
        return any(low <= pincode <= high for low, high in self.ranges)


@dataclass(frozen=True, kw_only=True)
class PincodeFile(_Data):
    sample: bool = _spec(_flag)
    label: str | None = _spec(_optional(_text()), None)
    version: str = _spec(_text())
    note: str | None = _spec(_optional(_text()), None)
    regions: tuple[Region, ...] = _spec(_items(_record(Region), min_length=1))
    lenders: dict[str, tuple[str, ...]] = _spec(_mapping(_items(_text())))


@dataclass(frozen=True, kw_only=True)
class Company(_Data):
    name: str = _spec(_text(min_length=1, max_length=200))
    aliases: tuple[str, ...] = _spec(_items(_text()), ())
    employment_type: str | None = _spec(_optional(_text()), None)
    synthetic: bool = _spec(_flag, False)
    categories: dict[str, str] = _spec(_mapping(_text()))


@dataclass(frozen=True, kw_only=True)
class CompanyFile(_Data):
    sample: bool = _spec(_flag)
    label: str | None = _spec(_optional(_text()), None)
    version: str = _spec(_text())
    note: str | None = _spec(_optional(_text()), None)
    companies: tuple[Company, ...] = _spec(_items(_record(Company)))


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

    def label_of(self, lender_id: str) -> str | None:
        """The label of one lender's policy (the book's; a book with uploaded grids has its own)."""
        return self.label

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


def _read(name: str, model: type[_Data]) -> Any:
    return model.model_validate(json.loads((DATA_DIR / name).read_text(encoding="utf-8")))


@lru_cache(maxsize=1)
def load_policy_book() -> PolicyBook:
    """The shipped SAMPLE policies, pincodes and companies (validated once)."""
    return PolicyBook(
        _read(POLICY_FILE, PolicyFile),
        _read(PINCODE_FILE, PincodeFile),
        _read(COMPANY_FILE, CompanyFile),
    )


# ------------------------------------------------------------------ the client's policy workbook
# The workbook as app/policy_workbook.py reads it (PolicyWorkbook.to_json(): categories, banks with
# their slabs, values and cells, and their Sheet2 rules), turned into each bank's LenderPolicy here so
# that the eligibility API and the chat's tool build the same policies from the same stored JSON.
# A bank the SAMPLE book has keeps what the sheet does not give (minimum CIBIL, maximum enquiries,
# employment types, processing fee, the pension share) from its sample policy; a new bank (Bandhan
# Bank, Indusind Bank) gets them from SHEET_TEMPLATE_LENDER's, without a processing fee. Every such
# value is labelled NOT_IN_SHEET_LABEL where it is shown.
SHEET_TEMPLATE_LENDER = "hdfc_bank"
SHEET_UNLISTED_CODE = "CAT_U"


def _sheet_first(values: list[float | None], default: float, *, le: float | None = None) -> float:
    """The first positive value (within `le`), else `default`: a placeholder for the policy's flat
    fields, which the sheet's grid replaces in every calculation."""
    for v in values:
        if v is not None and v > 0 and (le is None or v <= le):
            return float(v)
    return default


def _sheet_rules(workbook: dict, rules: dict | None) -> SheetRules | None:
    if not rules:
        return None
    cited = {k: v for k, v in (rules.get("cells") or {}).items() if k in SHEET_RULES and isinstance(v, dict)}
    bonus = rules.get("bonus")
    app_bt = rules.get("app_bt")
    return SheetRules(
        sheet=str(workbook.get("rules_sheet") or "Sheet2")[:100],
        hl_deviation=rules.get("hl_deviation"),
        multiplier_method=rules.get("multiplier_method"),
        ccbt_max_cards=int(rules.get("ccbt_max_cards") or 0),
        plbt_max_loans=rules.get("plbt_max_loans"),
        app_bt=str(app_bt)[:200] if app_bt else None,
        gold_loan_monthly_pct=rules.get("gold_loan_monthly_pct"),
        bonus=SheetBonus.model_validate(bonus, where="bonus") if bonus else None,
        incentive_frequencies=tuple(rules.get("incentive_frequencies") or ()),
        rental_income_share=rules.get("rental_income_share"),
        co_applicant_rule=rules.get("co_applicant_rule"),
        cells={k: str(v.get("cell") or "")[:12] for k, v in cited.items()},
        texts={k: str(v.get("text") or "")[:200] for k, v in cited.items()},
    )


def sheet_grid(workbook: dict, bank: dict) -> SheetGrid:
    """The bank's grid (and rules) as the engine takes it."""
    categories = workbook.get("categories") or []
    labels = [str(c["label"]) for c in categories]
    codes = [str(c["code"]) for c in categories]
    values: dict[str, dict[str, list]] = {}
    cells: dict[str, dict[str, list]] = {}
    not_offered = {label: [False] * len(bank.get("slabs") or []) for label in labels}
    for key in SHEET_PARAMETERS:
        values[key] = {label: [] for label in labels}
        cells[key] = {label: [] for label in labels}
        for index, slab in enumerate(bank.get("slabs") or []):
            column = (slab.get("values") or {}).get(key) or {}
            for code, label in zip(codes, labels, strict=True):
                v = column.get(code)
                values[key][label].append(v.get("value") if v else None)
                cells[key][label].append(str(v.get("cell") or "") if v else "")
                if v and v.get("not_offered"):
                    not_offered[label][index] = True
    unlisted = next((str(c["label"]) for c in categories if c["code"] == SHEET_UNLISTED_CODE), None)
    return SheetGrid(
        label=SHEET_SOURCE_LABEL,
        bank=str(bank["name"]),
        sheet=str(workbook.get("grid_sheet") or "Sheet1"),
        slab_starts=tuple(int(s["start"]) for s in bank.get("slabs") or []),
        categories=tuple(labels),
        codes=tuple(codes),
        unlisted_category=unlisted,
        values=values,
        cells=cells,
        not_offered={label: flags for label, flags in not_offered.items() if any(flags)},
        rules=_sheet_rules(workbook, bank.get("rules")),
    )


def sheet_lender(workbook: dict, bank: dict, book: PolicyBook) -> LenderPolicy:
    """The bank's LenderPolicy: the sheet's grid, and from its sample policy what the sheet lacks."""
    grid = sheet_grid(workbook, bank)
    base = book.lender(bank["lender_id"])
    template = base or book.lender(SHEET_TEMPLATE_LENDER) or book.lenders[0]
    every = {key: [v for column in grid.values[key].values() for v in column] for key in grid.values}
    rois = [v * 100 for v in every["roi"] if v is not None and 0 < v * 100 <= 60]
    funding = max((v for v in every["max_funding"] if v), default=0) or template.max_amount
    max_tenure = int(max((v for v in every["max_tenure_months"] if v and v <= 480), default=0)) or (
        template.max_tenure_months
    )
    tenure = int(_sheet_first(every["calculation_tenure_months"], max_tenure, le=max_tenure))
    categories = {
        label: CategoryPolicy(
            foir=_sheet_first(grid.values["foir"][label], 0.5, le=1),
            multiplier=_sheet_first(grid.values["multiplier"][label], 10, le=100),
        )
        for label in grid.categories
    }
    unlisted = (
        UnlistedCompanyPolicy(
            accepted=True,
            foir=categories[grid.unlisted_category].foir,
            multiplier=categories[grid.unlisted_category].multiplier,
        )
        if grid.unlisted_category
        else UnlistedCompanyPolicy(accepted=False)
    )
    first = categories[grid.categories[0]]
    return LenderPolicy(
        id=str(bank["lender_id"]),
        name=base.name if base else str(bank["name"]),
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


def sheet_lenders(workbook: dict, book: PolicyBook) -> tuple[dict[str, LenderPolicy], list[str]]:
    """Per lender id, the bank's policy from the workbook (its to_json()); and the banks that could
    not be used, and why (their sample policy applies)."""
    out: dict[str, LenderPolicy] = {}
    problems: list[str] = []
    for bank in workbook.get("banks") or []:
        name = str(bank.get("name") or bank.get("lender_id") or "a bank")
        if not bank.get("slabs"):
            problems.append(f"{name}: no slab rows, so its sample policy is used")
            continue
        try:
            out[str(bank["lender_id"])] = sheet_lender(workbook, bank, book)
        except (ValueError, KeyError, TypeError) as e:
            problems.append(f"{name} cannot be used ({e}): its sample policy is used")
    return out, problems


def sheet_source_name(filename: str | None, uploaded_at: str) -> str:
    """'From Policy (your sheet) (Policy.xlsx, uploaded 05 Oct 2026)'."""
    try:
        uploaded = _dt.datetime.fromisoformat(uploaded_at).strftime("%d %b %Y")
    except ValueError:
        uploaded = uploaded_at
    detail = f"{filename}, uploaded {uploaded}" if filename else f"uploaded {uploaded}"
    return f"{SHEET_SOURCE_LABEL} ({detail})"


def sheet_note(names: Collection[str], source_name: str) -> str:
    """The calculation's note naming the banks the policy sheet priced."""
    return f"Policy of {', '.join(sorted(names))}: {source_name}"


class SheetBook:
    """A policy book with the policy workbook's banks (sheet_lenders), as calculate() takes a book: a
    bank the sheet has is priced by it and labelled SHEET_SOURCE_LABEL; a bank only the sheet has
    (not in the book) comes after the book's lenders, with no pincode list (serviceability not
    checked). Everything else is the book's. (The eligibility API's reference_data.CalculationBook
    does the same, with the DSA's uploaded lists on top.)"""

    def __init__(self, book: PolicyBook, policies: dict[str, LenderPolicy]):
        self._book = book
        self.policies = policies

    def __getattr__(self, name: str) -> Any:
        return getattr(self._book, name)

    @property
    def lenders(self) -> tuple[LenderPolicy, ...]:
        known = self._book.lenders
        ids = {lender.id for lender in known}
        return (
            *(self.policies.get(lender.id, lender) for lender in known),
            *(p for lender_id, p in self.policies.items() if lender_id not in ids),
        )

    def lender(self, id_or_name: str | None) -> LenderPolicy | None:
        key = _enum_key(id_or_name or "")
        return next((p for p in self.lenders if key and key in (p.id, _enum_key(p.name))), None)

    def label_of(self, lender_id: str) -> str | None:
        return SHEET_SOURCE_LABEL if lender_id in self.policies else self._book.label_of(lender_id)

    def serviceable(self, lender_id: str, pincode: str) -> bool | None:
        """None: a bank only the policy workbook has (no pincode list: not checked)."""
        return self._book.serviceable(lender_id, pincode) if self._book.lender(lender_id) else None


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
def _maybe_dec(value: Any) -> Decimal | None:
    return None if value is None else dec(value)


def _count(n: int, noun: str) -> str:
    return f"{n} {noun}" + ("" if n == 1 else "s")


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
    """The obligations of every lender: the total counts a gold loan at its EMI (where entered); a
    lender with a gold loan rule counts it its own way (`gold`, see _lender_obligations)."""
    counted, bt_rows, closed, not_counted, incomplete, gold = [], [], [], [], [], []
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
        elif tradeline.get("emi") is None and tradeline.get("loan_type") == "gold":
            gold.append({"name": name, "emi": None, "outstanding": _maybe_dec(tradeline.get("outstanding"))})
            not_counted.append({**row, "note": "EMI not entered: a lender's gold loan rule may count it instead"})
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
            if tradeline.get("loan_type") == "gold":
                outstanding = _maybe_dec(tradeline.get("outstanding"))
                gold.append({"name": name, "emi": dec(tradeline["emi"]), "outstanding": outstanding})

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
        "gold": gold,
        "details": {
            "counted": counted,
            "bt": bt_rows,
            "closed": closed,
            "not_counted": not_counted,
            "bank_statement_emis": bank_rows,
        },
    }


def category_text(sheet: SheetGrid, category: str) -> str:
    """'CAT U (unlisted)' for the sheet's unlisted category, else the category as shown."""
    return f"{category} (unlisted)" if category == sheet.unlisted_category else category


def not_offered_reason(sheet: SheetGrid, category: str, slab: int) -> str:
    """'HDFC Bank does not lend to CAT U (unlisted) companies (Sheet1, slab 60,000, CAT_U is NA, cell I8)'."""
    cell = next(
        (sheet.cells[key][category][slab] for key in SHEET_PARAMETERS if sheet.values[key][category][slab] is None),
        "",
    )
    where = f"{sheet.sheet}, slab {_grouped(str(sheet.slab_starts[slab]))}, {sheet.code(category)} is NA"
    return (
        f"{sheet.bank} does not lend to {category_text(sheet, category)} companies"
        f" ({where}{f', cell {cell}' if cell else ''})"
    )


def _sheet_terms(
    lender: LenderPolicy,
    category: str | None,
    company: str | None,
    salary: Decimal | None,
    reasons: list[str],
    notes: list[str],
) -> tuple[LenderPolicy, dict | None, dict | None]:
    """The lender's terms from its policy sheet at this net monthly salary and company category:
    the lender with the sheet's ROI, maximum funding and tenures, and what was used (slab, category,
    each value with its cell); else the lender unchanged and None, with why it is not eligible.
    The third item: the category and slab the bank does not lend to (NA in the sheet), else None.

    A company not in the lender's company list, or with a category the sheet has no column for,
    gets the sheet's unlisted category (CAT U)."""
    sheet = lender.sheet
    if salary is None:
        return lender, None, None
    slab = sheet.slab(salary)
    if slab is None:
        reasons.append(
            f"Not eligible: income {inr(salary)} is below {sheet.bank}'s minimum {inr(sheet.slab_starts[0])} "
            f"({sheet.label})"
        )
        return lender, None, None
    if category not in sheet.categories:
        if sheet.unlisted_category is None:
            reasons.append(f"{sheet.bank}'s policy sheet has no category for a company not in its list")
            return lender, None, None
        unlisted = category is None and bool(company)
        if category is not None:
            notes.append(
                f"{category} is not a category of {sheet.bank}'s policy sheet: {sheet.unlisted_category} applies"
            )
        elif company:
            notes.append(
                f"{sheet.code(sheet.unlisted_category)}: '{company}' is not in {sheet.bank}'s company list, "
                f"so {sheet.unlisted_category} applies"
            )
        category = sheet.unlisted_category
    else:
        unlisted = False
    code = sheet.code(category)
    start = sheet.slab_starts[slab]
    if sheet.not_offered.get(category, ())[slab : slab + 1] == (True,):
        reasons.insert(0, not_offered_reason(sheet, category, slab))
        closed = {"bank": sheet.bank, "category": category, "category_code": code, "slab_start": start}
        return lender, None, closed
    values: dict[str, dict] = {}
    for key, name in SHEET_PARAMETERS.items():
        value, cell = sheet.values[key][category][slab], sheet.cells[key][category][slab]
        if value is None or (key != "foir" and key != "roi" and value <= 0):
            reasons.append(f"{sheet.bank}'s policy sheet has no {name} for slab {_grouped(str(start))}, {code}")
            return lender, None, None
        if key in ("roi", "foir"):
            text = f"{_number(dec(value) * 100)}%"
        elif key == "max_funding":
            text = inr(value)
        elif key.endswith("_months"):
            text = f"{_number(dec(value))} months"
        else:
            text = _number(dec(value))
        values[key] = {
            "value": value,
            "cell": cell,
            "text": f"{name} {text} ({sheet.sheet}, {sheet.bank}, slab {_grouped(str(start))}, {code}, cell {cell})",
        }
    max_tenure = int(values["max_tenure_months"]["value"])
    tenure = int(values["calculation_tenure_months"]["value"])
    if tenure > max_tenure:
        notes.append(
            f"{sheet.bank}'s calculation tenure {tenure} months is more than its maximum tenure {max_tenure}: "
            f"{max_tenure} months is used"
        )
        tenure = max_tenure
    funding = float(values["max_funding"]["value"])
    updated = lender.model_copy(
        update={
            "roi": float(dec(values["roi"]["value"]) * 100),
            "roi_max": None,
            "max_amount": funding,
            "min_amount": min(lender.min_amount, funding),
            "max_tenure_months": max_tenure,
            "calculation_tenure_months": tenure,
            "min_tenure_months": min(lender.min_tenure_months, tenure),
        }
    )
    terms = {
        "label": sheet.label,
        "bank": sheet.bank,
        "slab_start": start,
        "category": category,
        "category_code": code,
        # The company is not in the bank's company list, so the unlisted category (CAT U) applies.
        "company_unlisted": unlisted,
        "values": values,
    }
    return updated, terms, None


def _rule_ref(sheet: SheetGrid, kind: str) -> str:
    """Where a rule is on the second sheet: '(Sheet2, HDFC Bank, Bonus Calculation "Last 2 years *70% / 24",
    cell I3)'."""
    rules = sheet.rules
    text = (rules.texts.get(kind) or "").strip() if rules else ""
    cell = rules.cells.get(kind) if rules else None
    parts = [rules.sheet if rules else "Sheet2", sheet.bank, SHEET_RULES[kind] + (f' "{text}"' if text else "")]
    return "(" + ", ".join([*parts, *([f"cell {cell}"] if cell else [])]) + ")"


def _sheet_tenure(lender: LenderPolicy, terms: dict, requested: int | None, notes: list[str]) -> tuple[int, str]:
    """A bank priced by its policy sheet calculates eligibility at the sheet's Tenure for Eligibility
    Calculation, whatever tenure is requested (the EMI is shown at its Maximum Tenure)."""
    tenure = lender.calculation_tenure
    if requested is not None and requested != tenure:
        cell = terms["values"]["calculation_tenure_months"]["cell"]
        notes.append(
            f"{terms['bank']} calculates eligibility at {tenure} months (Tenure for Eligibility Calculation, cell "
            f"{cell}), not at the requested {requested}; the EMI is shown at its Maximum Tenure of "
            f"{lender.max_tenure_months} months"
        )
    return tenure, "policy"


def _lender_obligations(
    lender: LenderPolicy, obligations: dict, reasons: list[str], notes: list[str], lines: list[str]
) -> Decimal:
    """The lender's monthly obligations: every lender's total, with each gold loan counted by the
    lender's gold loan rule (a share of its outstanding a month) where its policy sheet gives one,
    else at its EMI."""
    total = obligations["total"]
    sheet = lender.sheet
    rule = sheet.rules.gold_loan_monthly_pct if sheet is not None and sheet.rules is not None else None
    for gold in obligations["gold"]:
        if rule is not None:
            share = dec(rule)
            ref = _rule_ref(sheet, "gold_loan")
            if gold["outstanding"] is None:
                reasons.append(
                    f"Outstanding not entered for {gold['name']}: {sheet.bank} counts {_pct(share)} of a gold loan's "
                    f"outstanding a month {ref}"
                )
                continue
            counted = gold["outstanding"] * share
            total += counted - (gold["emi"] or 0)
            lines.append(
                f"{gold['name']}: {_pct(share)} of the outstanding {inr(gold['outstanding'])} = {inr(counted)} a "
                f"month is the obligation {ref}"
            )
            continue
        given = f" (gold loan: bank rule not given {_rule_ref(sheet, 'gold_loan')})" if sheet is not None else ""
        if gold["emi"] is None:
            reasons.append(f"EMI not entered for {gold['name']} marked Obligate{given}")
        elif sheet is not None:
            notes.append(f"{gold['name']} is counted at its EMI {inr(gold['emi'])}{given}")
    return total


def _bt_limits(lender: LenderPolicy, obligations: dict, reasons: list[str], notes: list[str], lines: list[str]) -> None:
    """The policy sheet's balance-transfer limits: at most PLBT personal loans, and credit cards only up
    to the CCBT number of cards (none where CCBT is NA)."""
    sheet = lender.sheet
    rules = sheet.rules
    rows = obligations["details"]["bt"]
    for loan_type, kind, noun in (("personal", "plbt", "personal loan"), ("credit_card", "ccbt", "credit card")):
        count = sum(1 for row in rows if row["loan_type"] == loan_type)
        if not count:
            continue
        ref = _rule_ref(sheet, kind)
        what = f"{_count(count, noun)} marked BT"
        limit = None if rules is None else (rules.plbt_max_loans if kind == "plbt" else rules.ccbt_max_cards)
        if limit is None:
            notes.append(f"{what}: {sheet.bank}'s policy sheet gives no {SHEET_RULES[kind]} limit {ref}")
        elif limit == 0 and kind == "ccbt":
            reasons.append(f"{what}: {sheet.bank} does not take over credit cards {ref}")
        elif count > limit:
            reasons.append(f"{what}: {sheet.bank} takes over at most {_count(limit, noun)} {ref}")
        else:
            lines.append(f"{what}: within {sheet.bank}'s limit of {_count(limit, noun)} {ref}")


def _income_share(lender: LenderPolicy, other: dict, lines: list[str], notes: list[str]) -> Decimal:
    """The percent of an other income (normalised to a month) the lender counts: its policy sheet's
    rule (bonus formula, incentive frequencies, rental share), else its sample policy's."""
    sample = dec(getattr(lender.income_consideration_pct, other["key"]))
    sheet = lender.sheet
    if sheet is None:
        return sample
    rules = sheet.rules
    kind = other["type"]
    label = f"{other['label']} (other income {other['index']})"
    if kind == "pension" or rules is None or kind not in ("bonus", "incentive", "rented"):
        lines.append(f"{label}: {_number(sample)}% counted ({NOT_IN_SHEET_LABEL})")
        return sample
    if kind == "bonus":
        ref = _rule_ref(sheet, "bonus")
        bonus = rules.bonus
        if bonus is None:
            notes.append(f"{label} not counted: {sheet.bank} counts no bonus {ref}")
            return Decimal(0)
        # The bonus of a year, for each of the last `years` years, x share / divisor months.
        pct = Decimal(12) * bonus.years * dec(bonus.share) / bonus.divisor * 100
        yearly = other["amount"] * 12 / MONTHS_PER_PERIOD[other["frequency"]]
        lines.append(
            f"{label} {inr(yearly)} a year: last {_count(bonus.years, 'year')} × {_pct(dec(bonus.share))} ÷ "
            f"{bonus.divisor} = {inr(other['monthly'] * pct / 100)} a month {ref}"
        )
        return pct
    if kind == "incentive":
        ref = _rule_ref(sheet, "incentive")
        paid = INCOME_FREQUENCIES[other["frequency"]].lower()
        if other["frequency"] in rules.incentive_frequencies:
            lines.append(f"{label} paid {paid}: counted in full {ref}")
            return Decimal(100)
        accepted = " and ".join(INCOME_FREQUENCIES[f].lower() for f in rules.incentive_frequencies) or "no"
        notes.append(f"{label} paid {paid} not counted: {sheet.bank} counts {accepted} incentive only {ref}")
        return Decimal(0)
    ref = _rule_ref(sheet, "rental_income")
    share = rules.rental_income_share
    if share is None:
        notes.append(f"{label} not counted: {sheet.bank} counts no rental income {ref}")
        return Decimal(0)
    lines.append(f"{label}: {_pct(dec(share))} counted {ref}")
    return dec(share) * 100


def _co_applicant_income(
    lender: LenderPolicy, book: PolicyBook, co_applicant: dict | None, lines: list[str], notes: list[str]
) -> tuple[Decimal, Decimal] | None:
    """(the co-applicant's net monthly salary, what the lender adds of it): all of it when the lender's
    policy sheet takes the co-applicant's employer ("Listed Company": in the bank's company list;
    "All Companies except proprietor and partnership"), else nothing, and why. None: none entered."""
    if not co_applicant or co_applicant.get("net_income") is None:
        return None
    amount = dec(co_applicant["net_income"])
    what = f"Co-applicant salary {inr(amount)}"
    sheet = lender.sheet
    if sheet is None:
        notes.append(f"{what} not added: {lender.name}'s sample policy has no co-applicant rule")
        return amount, Decimal(0)
    rule = sheet.rules.co_applicant_rule if sheet.rules is not None else None
    ref = _rule_ref(sheet, "co_applicant")
    if rule is None:
        notes.append(f"{what} not added: {sheet.bank}'s policy sheet gives no co-applicant rule {ref}")
        return amount, Decimal(0)
    if rule == "listed_company":
        name = co_applicant.get("company")
        if not name:
            notes.append(
                f"{what} not added: {sheet.bank} adds it only when the co-applicant works for a listed company; enter "
                f"the co-applicant's company {ref}"
            )
            return amount, Decimal(0)
        company = book.find_company(name)
        shown = company.name if company else name
        category = company.categories.get(lender.id) if company else None
        if category is None or category not in sheet.categories or category == sheet.unlisted_category:
            notes.append(
                f"{what} not added: '{shown}' is not in {sheet.bank}'s company list, and {sheet.bank} adds it only "
                f"for a listed company {ref}"
            )
            return amount, Decimal(0)
        lines.append(f"{what} added: '{shown}' is {category} in {sheet.bank}'s company list {ref}")
        return amount, amount
    employment = co_applicant.get("employment_type")
    if employment is None:
        notes.append(
            f"{what} not added: enter the co-applicant's employment type ({sheet.bank} adds it for every employer "
            f"except a proprietorship or partnership) {ref}"
        )
        return amount, Decimal(0)
    if employment == "partnership_proprietorship":
        notes.append(f"{what} not added: {sheet.bank} does not add it for a proprietorship or partnership {ref}")
        return amount, Decimal(0)
    lines.append(f"{what} added: a {EMPLOYMENT_TYPES.get(employment, employment)} employer {ref}")
    return amount, amount


def _sheet_lines(
    lender: LenderPolicy, terms: dict, net: Decimal | None, method: str, rule_lines: list[str]
) -> list[str]:
    """Details' "How it is calculated" for a bank priced by its policy sheet: every value and rule
    used, each with its cell; the sample values the sheet lacks, labelled; the HL deviation, shown."""
    sheet = lender.sheet
    rules = sheet.rules
    start = _grouped(str(terms["slab_start"]))
    salary = f"Net salary {inr(net)}: " if net is not None else ""
    lines = [f"{salary}slab {start}, company category {terms['category']} ({terms['category_code']})"]
    lines += [terms["values"][key]["text"] for key in SHEET_PARAMETERS]
    lines.append(f"Multiplier eligibility = {MULTIPLIER_METHODS[method]} {_rule_ref(sheet, 'multiplier_method')}")
    lines += rule_lines
    lines.append(f"Minimum CIBIL score {lender.min_cibil_score} ({NOT_IN_SHEET_LABEL})")
    lines.append(f"Maximum enquiries in the last 90 days {lender.max_enquiries_90d} ({NOT_IN_SHEET_LABEL})")
    fee = lender.processing_fee
    if fee is not None:
        limits = "".join(
            f", {word} {inr(value)}"
            for word, value in (("at least", fee.min_amount), ("at most", fee.max_amount))
            if value is not None
        )
        lines.append(f"Processing fee {_number(dec(fee.pct))}% of the loan{limits} ({NOT_IN_SHEET_LABEL})")
    if rules is not None and rules.hl_deviation is not None:
        lines.append(
            f"HL deviation {_pct(dec(rules.hl_deviation))}: meaning to be confirmed with Smart Solutions "
            f"{_rule_ref(sheet, 'hl_deviation')}; it does not change the result"
        )
    if rules is not None and rules.app_bt:
        lines.append(f'App BT "{rules.app_bt}": meaning not known, not used {_rule_ref(sheet, "app_bt")}')
    return lines


def _calculation_tenure(lender: LenderPolicy, requested: int | None, notes: list[str]) -> tuple[int, str]:
    """The per-lakh EMI's tenure and its source: the lender's calculation tenure ("policy"), or the
    requested tenure when that is shorter ("table"), raised to the lender's min tenure ("policy")."""
    policy = lender.calculation_tenure
    if requested is None or requested == policy:
        return policy, "policy"
    if requested > lender.max_tenure_months:
        notes.append(
            f"Requested tenure {requested} months is more than {lender.name}'s max {lender.max_tenure_months}: "
            f"the EMI is shown at {lender.max_tenure_months} months and eligibility is calculated at {policy} months"
        )
        return policy, "policy"
    if requested > policy:
        notes.append(
            f"{lender.name} calculates eligibility at {policy} months (its calculation tenure), not at the "
            f"requested {requested}"
        )
        return policy, "policy"
    if requested < lender.min_tenure_months:
        notes.append(
            f"Requested tenure {requested} months is less than {lender.name}'s min {lender.min_tenure_months}: "
            f"eligibility is calculated at {lender.min_tenure_months} months"
        )
        return lender.min_tenure_months, "policy"
    return requested, "table"


def _grid_foir(
    lender: LenderPolicy, category: str, salary: Decimal, foir: Decimal, reasons: list[str], notes: list[str]
) -> Decimal:
    """The FOIR of the lender's grid for a listed company's category at this net monthly salary,
    noted with its slab; else `foir` (the category's own), with why the lender is not eligible."""
    grid = lender.foir_grid
    slab = grid.slab(salary)
    if slab is None:
        reasons.append(
            f"Net monthly salary {inr(salary)} is below {lender.name}'s minimum income of "
            f"{inr(grid.slab_starts[0])} (the first slab of its FOIR grid)"
        )
        return foir
    column = grid.categories.get(category)
    if column is None:
        reasons.append(f"{lender.name}'s FOIR grid has no FOIR for {category} (it covers {', '.join(grid.categories)})")
        return foir
    value = dec(column[slab])
    label = f" ({grid.label})" if grid.label else ""
    notes.append(f"FOIR {_pct(value)} · slab {grid.slab_text(slab)} · {category} · {SOURCE_LABELS['policy']}{label}")
    return value


def _lender_result(
    lender: LenderPolicy,
    book: PolicyBook,
    profile: dict,
    cibil: dict,
    loan: dict,
    income: dict,
    obligations: dict,
    common_reasons: list[str],
    co_applicant: dict | None = None,
) -> dict:
    reasons: list[str] = []
    notes: list[str] = []
    # A bank priced by the client's policy sheet: the rules it applied, each with its cell (Details), and
    # the sample values it uses where the sheet gives none, labelled.
    rule_lines: list[str] = []
    sample = f" ({NOT_IN_SHEET_LABEL})" if lender.sheet is not None else ""

    pincode = profile.get("pincode")
    region = book.region_of(pincode)
    serviceable = book.serviceable(lender.id, pincode) if pincode else None
    if not pincode:
        reasons.append("Pincode not entered: serviceability cannot be checked")
    elif serviceable is None:
        notes.append(f"No pincode list covers {lender.name}: serviceability not checked")

    employment_type = profile.get("employment_type")
    if employment_type is None:
        reasons.append("Employment type not entered")
    elif employment_type not in lender.employment_types:
        reasons.append(
            f"Employment type {EMPLOYMENT_TYPES.get(employment_type, employment_type)} is not accepted by "
            f"{lender.name}{sample}"
        )

    foir, multiplier = dec(lender.foir), dec(lender.multiplier)
    category, company_policy, listed = None, "base", None
    company_name = profile.get("company")
    company = book.find_company(company_name)
    if not company_name:
        reasons.append("Company not entered: its category is needed")
    else:
        shown = company.name if company else company_name
        listed = company.categories.get(lender.id) if company else None
        if listed is not None and lender.sheet is not None:
            # The sheet prices the category (_sheet_terms); one it does not have is unlisted there.
            category, company_policy = listed, "category"
        elif listed is not None:
            policy = lender.company_categories[listed]
            foir, multiplier = dec(policy.foir), dec(policy.multiplier)
            category, company_policy = listed, "category"
        elif lender.unlisted_company.accepted:
            foir = dec(lender.unlisted_company.foir)
            multiplier = dec(lender.unlisted_company.multiplier)
            company_policy = "unlisted"
            if lender.sheet is None:
                notes.append(
                    f"'{shown}' is not in {lender.name}'s company list: its unlisted-company policy applies "
                    f"(FOIR {_pct(foir)}, multiplier {_number(multiplier)})"
                )
        else:
            company_policy = "unlisted"
            reasons.append(
                f"'{shown}' is not in {lender.name}'s company list and {lender.name} does not accept unlisted companies"
            )
    if lender.foir_grid is not None and category is not None and income["net"] is not None:
        foir = _grid_foir(lender, category, income["net"], foir, reasons, notes)
    sheet_terms = not_offered = None
    if lender.sheet is not None:
        shown = (company.name if company else company_name) if company_name else None
        lender, sheet_terms, not_offered = _sheet_terms(lender, category, shown, income["net"], reasons, notes)
        if sheet_terms is not None:
            foir = dec(sheet_terms["values"]["foir"]["value"])
            multiplier = dec(sheet_terms["values"]["multiplier"]["value"])
            category = sheet_terms["category"]
            company_policy = "category" if company_policy == "category" and category == listed else "unlisted"

    score = cibil.get("score")
    if score is None:
        reasons.append("CIBIL score not entered")
    elif score < lender.min_cibil_score:
        reasons.append(f"CIBIL score {score} is below {lender.name}'s minimum {lender.min_cibil_score}{sample}")

    enquiries_90d = (cibil.get("enquiries") or {}).get("d90")
    if enquiries_90d is None:
        reasons.append("Enquiries in the last 90 days not entered")
    elif enquiries_90d > lender.max_enquiries_90d:
        reasons.append(
            f"{enquiries_90d} enquiries in the last 90 days: more than {lender.name}'s limit of "
            f"{lender.max_enquiries_90d}{sample}"
        )

    reasons.extend(common_reasons)

    if sheet_terms is not None:
        tenure, tenure_source = _sheet_tenure(lender, sheet_terms, loan.get("tenure_months"), notes)
    else:
        tenure, tenure_source = _calculation_tenure(lender, loan.get("tenure_months"), notes)
    per_lakh = emi(LAKH, lender.roi, tenure)
    rules = lender.sheet.rules if lender.sheet is not None else None
    method = "salary"
    if rules is not None and rules.multiplier_method is not None:
        method = rules.multiplier_method
    elif lender.sheet is not None:
        ref = _rule_ref(lender.sheet, "multiplier_method")
        notes.append(f"{lender.sheet.bank}'s policy sheet gives no multiplier method {ref}: income × multiplier")
    obligation_lines: list[str] = []
    obligations_total = _lender_obligations(lender, obligations, reasons, notes, obligation_lines)
    if lender.sheet is not None:
        _bt_limits(lender, obligations, reasons, notes, obligation_lines)
    bt_amount = obligations["bt_amount"]
    net = income["net"]
    income_considered = foir_eligibility = multiplier_eligibility = computed = None
    breakdown: list[dict] = []
    # A category the bank does not lend to: nothing to price (no ROI, EMI or eligibility from it).
    if net is not None and not_offered is None:
        other_total = Decimal(0)
        for other in income["others"]:
            pct = _income_share(lender, other, rule_lines, notes)
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
        co = _co_applicant_income(lender, book, co_applicant, rule_lines, notes)
        if co is not None:
            amount, added = co
            other_total += added
            breakdown.append(
                {
                    "type": "co_applicant",
                    "label": "Co-applicant salary",
                    "agreement": None,
                    "frequency": "monthly",
                    "monthly_amount": money(amount),
                    "consideration_pct": 100.0 if added else 0.0,
                    "considered": money(added),
                }
            )
        income_considered = net + other_total
        headroom = income_considered * foir - obligations_total
        foir_eligibility = max(headroom, Decimal(0)) / per_lakh * LAKH
        # The policy sheet's method: income x multiplier, or (income - obligations) x multiplier.
        base = income_considered - obligations_total if method == "net_of_obligations" else income_considered
        multiplier_eligibility = max(base, Decimal(0)) * multiplier
        # The sheet's =MIN(FOIR eligibility, multiplier eligibility), capped at the lender's maximum.
        computed = min(foir_eligibility, multiplier_eligibility, dec(lender.max_amount))
        if headroom <= 0:
            reasons.append(
                f"Existing obligations {inr(obligations_total)} leave no room within FOIR {_pct(foir)} of "
                f"{inr(income_considered)} ({inr(income_considered * foir)})"
            )
        elif computed < max(dec(lender.min_amount), MIN_LOAN_AMOUNT):
            minimum = max(dec(lender.min_amount), MIN_LOAN_AMOUNT)
            reasons.append(
                f"Eligible amount {inr(computed)} is below {lender.name}'s minimum loan {inr(minimum)}{sample}"
            )
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
    # APR and total cost of the offer: the eligible amount at the EMI column's tenure.
    fee = annual_rate = cost = None
    if eligible > 0:
        fee = lender.processing_fee.amount(eligible) if lender.processing_fee else Decimal(0)
        # A fee as large as the loan leaves the borrower nothing: no APR.
        annual_rate = apr(eligible, lender.roi, lender.max_tenure_months, fee) if fee < eligible else None
        cost = total_cost(eligible, lender.roi, lender.max_tenure_months, fee)

    requested_amount = loan.get("amount")
    covers_requested = None
    if status == "eligible" and requested_amount is not None:
        covers_requested = eligible >= dec(requested_amount)
        if not covers_requested:
            notes.append(f"{inr(eligible)} is less than the requested {inr(requested_amount)}")
    if sheet_terms is not None:
        sheet_terms = {
            **sheet_terms,
            "lines": _sheet_lines(lender, sheet_terms, net, method, rule_lines + obligation_lines),
            "hl_deviation": rules.hl_deviation if rules is not None else None,
        }

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
        "roi_max": lender.roi_max,
        "emi": money(monthly_emi),
        "calculation_tenure_months": tenure,
        "emi_at_calculation_tenure": money(calculation_emi),
        "per_lakh_emi": money(per_lakh),
        "processing_fee": money(fee),
        "processing_fee_policy": lender.processing_fee.model_dump() if lender.processing_fee else None,
        "apr": percent(annual_rate),
        "total_interest": money(cost - fee) if cost is not None else None,
        "total_cost": money(cost),
        "foir_eligibility": money(foir_eligibility),
        "multiplier_eligibility": money(multiplier_eligibility),
        "income_considered": money(income_considered),
        "other_income_considered": breakdown,
        "obligations": money(obligations_total),
        "foir": float(foir),
        "multiplier": float(multiplier),
        "multiplier_method": method,
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
            "processing_fee": "policy",
            "apr": "formula",
            "total_cost": "formula",
        },
        "label": book.label_of(lender.id),
        # The cells of the client's policy sheet this result used (slab, category, each value); null:
        # the lender has no sheet, or the sheet could not price this applicant (see reasons).
        "policy_sheet": sheet_terms,
        # The bank does not lend to this category at this slab (NA in its sheet): bank, category,
        # category_code, slab_start; null otherwise.
        "not_offered": not_offered,
    }


def _need(loan: dict, bt_amount: Decimal) -> Decimal:
    """What the loan must cover: the requested amount, and at least the balance transfer."""
    requested = loan.get("amount")
    return max(dec(requested) if requested is not None else Decimal(0), bt_amount)


def _ranked(results: list[dict], need: Decimal) -> tuple[list[dict], list[dict]]:
    """The eligible lenders in suggestion order, split into (those covering `need`, the others).

    Covering lenders: lowest ROI first (then the larger amount, the lower EMI, the name). The others
    (or all of them when there is no need): highest eligible amount first (then the lower ROI)."""
    eligible = [r for r in results if r["status"] == "eligible" and (r["eligible_amount"] or 0) > 0]
    covering = [r for r in eligible if need > 0 and dec(r["eligible_amount"]) >= need]
    rest = [r for r in eligible if r not in covering]
    covering.sort(key=lambda r: (r["roi"], -r["eligible_amount"], r["emi"], r["lender"]))
    rest.sort(key=lambda r: (-r["eligible_amount"], r["roi"], r["lender"]))
    return covering, rest


def _best_lender(results: list[dict], loan: dict, bt_amount: Decimal) -> tuple[dict | None, str | None]:
    """Lowest ROI among the eligible lenders that cover the need (requested amount, BT); else the
    highest eligible amount. The first of the suggestion's banks."""
    need = _need(loan, bt_amount)
    covering, rest = _ranked(results, need)
    if covering:
        return covering[0], f"lowest ROI among the lenders that cover {inr(need)}"
    if rest:
        return rest[0], "highest eligible amount"
    return None, None


def _pct_text(roi: float) -> str:
    return f"{_number(dec(roi))}%"


def _decline_reason(row: dict) -> str:
    """One line on why a lender says no: its first reason; a company not in the lender's list
    (CAT U by the policy sheet) is named first, and how many more reasons Details has."""
    reasons = list(row.get("reasons") or [])
    first = reasons[0] if reasons else row.get("status_label") or row["status"]
    if first.startswith("Not eligible: "):
        first = first[len("Not eligible: ") :]
    sheet = row.get("policy_sheet") or {}
    if sheet.get("company_unlisted"):
        first = f"{sheet['category_code']}: company not in {row['lender']}'s list; {first}"
    if len(reasons) > 1:
        first += f" (+{len(reasons) - 1} more in Details)"
    return first


def _suggestion(results: list[dict], loan: dict, bt_amount: Decimal) -> dict:
    """Which banks will sanction: the eligible banks ranked as _best_lender picks (the first is the
    best lender), each with its amount, ROI, EMI, tenure and one line on why; and the banks that say
    no, each with one line on why."""
    need = _need(loan, bt_amount)
    covering, rest = _ranked(results, need)
    banks = []
    for row in covering + rest:
        roi = _pct_text(row["roi"])
        if row in covering:
            why = (
                f"Lowest ROI ({roi}) that covers {inr(need)}" if row is covering[0] else f"Covers {inr(need)} at {roi}"
            )
        elif need > 0:
            why = f"Up to {inr(row['eligible_amount'])}: less than the {inr(need)} needed"
        elif row is rest[0]:
            why = f"Highest eligible amount, at {roi}"
        else:
            why = f"Eligible up to {inr(row['eligible_amount'])} at {roi}"
        banks.append(
            {
                "lender": row["lender"],
                "lender_id": row["lender_id"],
                "eligible_amount": row["eligible_amount"],
                "roi": row["roi"],
                "emi": row["emi"],
                "tenure_months": row["tenure_months"],
                "covers_need": row in covering,
                "label": row.get("label"),
                "why": why,
            }
        )
    shown = {b["lender_id"] for b in banks}
    declined = [
        {
            "lender": row["lender"],
            "lender_id": row["lender_id"],
            "status": row["status"],
            "label": row.get("label"),
            "reason": _decline_reason(row),
        }
        for row in results
        if row["lender_id"] not in shown
    ]
    return {"need": money(need) if need > 0 else None, "banks": banks, "declined": declined}


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
        co_applicant = inputs.get("co_applicant") or None
        results = [
            _lender_result(lender, book, profile, cibil, loan, income, obligations, common_reasons, co_applicant)
            for lender in book.lenders
        ]
        best, why = _best_lender(results, loan, obligations["bt_amount"])
        suggestion = _suggestion(results, loan, obligations["bt_amount"])
        other_monthly = sum((o["monthly"] for o in income["others"]), Decimal(0))

    disclaimers = [
        "Indicative — the lender decides: the final eligibility, amount, ROI and tenure are the lender's decision.",
        "Calculated with fixed formulas in the backend (per-lakh EMI, FOIR and multiplier eligibility, EMI as "
        "Excel PMT); no AI model decides any number.",
    ]
    sheet_banks = [r["lender"] for r in results if r["label"] == SHEET_SOURCE_LABEL]
    if book.sample and sheet_banks:
        disclaimers.insert(
            1,
            f"{SHEET_SOURCE_LABEL}: {', '.join(sheet_banks)}. Sample policy — replace with your lender grid: the "
            "other lenders' policies, the pincode lists and the company categories used here are SAMPLE data, "
            "unless you uploaded your own.",
        )
    elif book.sample:
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
            "co_applicant_net_income": money((co_applicant or {}).get("net_income")),
        },
        "obligations": money(obligations["total"]),
        "obligation_details": obligations["details"],
        "bt_amount": money(obligations["bt_amount"]),
        "requested": {"amount": money(loan.get("amount")), "tenure_months": loan.get("tenure_months")},
        "per_lender": results,
        "best_lender": best["lender"] if best else None,
        "best_lender_id": best["lender_id"] if best else None,
        "best_lender_reason": why,
        # "Suggested banks": the eligible banks ranked (the first is best_lender) and those saying no.
        "suggestion": suggestion,
        "notes": notes,
        "disclaimers": disclaimers,
    }
