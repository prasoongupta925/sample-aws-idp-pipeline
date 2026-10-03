"""Credit bureau providers: a consent-based credit report pull for the CIBIL page.

A provider pulls an applicant's credit report with the applicant's consent and returns it
normalized: the fields the credit-report reader writes for an uploaded credit report (the
document-facts step, doc_type credit_report), so the CIBIL page reads a pulled report exactly
like an uploaded one (app/routers/bureau.py):

    applicant_name, pan, bureau (CIBIL / Experian / Equifax / CRIF, else None),
    report_date (YYYY-MM-DD), credit_score (300-900; None: no credit history),
    enquiries_30d / enquiries_60d / enquiries_90d / enquiries_120d (cumulative counts),
    enquiries [{date, lender, purpose}],
    tradelines [{loan_type, lender, sanction_amount, outstanding, emi, status, account_last4,
                 overdue, emis_paid, emis_pending, open_date, last_payment_date}]

loan_type is one of the reader's TRADELINE_LOAN_TYPES (personal_loan, car_loan, credit_card ...),
status one of active, closed, written_off, settled, other; dates are YYYY-MM-DD; only the last 4
characters of an account number are kept.

Providers (config bureau_provider: env BUREAU_PROVIDER, set from CDK context bureauProvider):
- none (default): no bureau is connected. The CIBIL page reads the uploaded credit report, or
  the user types the report's values.
- mock: SAMPLE reports for the three demo applicants (Rahul Vijay Deshmukh, Sneha Anil
  Kulkarni, Amit Suresh Patil), with the accounts and enquiries of their synthetic credit report
  PDFs, dated the day of the pull. Any other PAN, or a date of birth that is not the applicant's,
  has no record. No bureau is called.

A paid consent-based API is plugged in as one more provider: docs/bureau-providers.md.
"""

import datetime as dt
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Literal

from app.config import get_config

ProviderName = Literal["none", "mock"]
ConsentMethod = Literal["otp", "signed_form", "recorded_call"]
CONSENT_METHODS: dict[str, str] = {
    "otp": "OTP sent to the applicant's mobile",
    "signed_form": "Signed consent form",
    "recorded_call": "Recorded call",
}
# The fields of a normalized report (as the credit-report reader writes them).
REPORT_FIELDS = (
    "applicant_name",
    "pan",
    "bureau",
    "report_date",
    "credit_score",
    "enquiries_30d",
    "enquiries_60d",
    "enquiries_90d",
    "enquiries_120d",
    "enquiries",
    "tradelines",
)
ENQUIRY_WINDOW_DAYS = {"enquiries_30d": 30, "enquiries_60d": 60, "enquiries_90d": 90, "enquiries_120d": 120}
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
NOT_CONNECTED = (
    "No credit bureau is connected: upload the applicant's credit report with the loan file, or type its "
    "values. An admin can connect a consent-based bureau API (docs/bureau-providers.md)."
)


@dataclass(frozen=True)
class Consent:
    """The applicant's consent to one pull, as the DSA user recorded it (logged before the pull)."""

    consent_id: str
    method: ConsentMethod
    purpose: str
    recorded_at: dt.datetime
    recorded_by: str
    reference: str | None = None


class BureauError(Exception):
    """The bureau could not answer (the caller reports 502)."""


class BureauNotConfiguredError(BureauError):
    """No bureau is connected (the caller reports 503)."""


class BureauProvider(ABC):
    """A credit bureau the CIBIL page can pull a report from."""

    name: str = ""
    label: str = ""
    # True when the reports are synthetic (the page labels them SAMPLE).
    sample: bool = False

    @property
    def enabled(self) -> bool:
        return True

    @property
    def detail(self) -> str | None:
        """Why a pull is not possible (shown next to the disabled button)."""
        return None

    @abstractmethod
    def fetch_report(
        self, consent: Consent, pan: str, name: str | None, dob: dt.date | None, mobile: str | None
    ) -> dict[str, Any] | None:
        """The applicant's normalized credit report (module docstring); None when the bureau holds no
        record for them (no hit: a PAN it does not know, or a person new to credit). Raises BureauError
        when the bureau cannot answer. `pan` is a full PAN in upper case; `mobile` 10 digits."""


class NoBureau(BureauProvider):
    """Setting none (or an unknown setting): no pull is possible."""

    name = "none"
    label = "No bureau connected"

    def __init__(self, unknown: str | None = None) -> None:
        self.unknown = unknown

    @property
    def enabled(self) -> bool:
        return False

    @property
    def detail(self) -> str | None:
        if self.unknown:
            return f"Unknown bureau provider {self.unknown!r} (expected none or mock): {NOT_CONNECTED}"
        return NOT_CONNECTED

    def fetch_report(self, consent, pan, name, dob, mobile):
        raise BureauNotConfiguredError(self.detail)


def _enquiry(date: str, lender: str, purpose: str) -> dict[str, str]:
    return {"date": date, "lender": lender, "purpose": purpose}


def _tradeline(loan_type: str, lender: str, last4: str, status: str, opened: str, last_paid: str, **amounts):
    row = {
        "loan_type": loan_type,
        "lender": lender,
        "sanction_amount": None,
        "outstanding": None,
        "emi": None,
        "status": status,
        "account_last4": last4,
        "overdue": 0.0,
        "emis_paid": None,
        "emis_pending": None,
        "open_date": opened,
        "last_payment_date": last_paid,
    }
    row.update(amounts)
    return row


_CARD_ISSUER = "Sahyadri Urban Co-op Bank"

# The demo applicants' SAMPLE reports, by PAN: the accounts and enquiries of their synthetic
# credit report PDFs (demo-docs/make_docs.py), dated as on those PDFs. MockBureau moves every
# date to the day of the pull, so the enquiry counts stay those of the PDFs.
MOCK_REPORTS: dict[str, dict[str, Any]] = {
    "BQXPD4821K": {
        "applicant_name": "Rahul Vijay Deshmukh",
        "dob": "1992-02-14",
        "report_date": "2026-09-18",
        "credit_score": 771.0,
        "enquiries": [
            _enquiry("2026-08-02", "Konkan Finserv Ltd (sample)", "Credit card"),
            _enquiry("2026-06-14", "Godavari Credit Ltd (sample)", "Personal loan"),
            _enquiry("2025-11-11", "Pavana Capital Ltd (sample)", "Two-wheeler loan"),
        ],
        "tradelines": [
            _tradeline(
                "car_loan",
                "Mulshi Auto Finance Ltd (sample)",
                "4512",
                "active",
                "2022-07-10",
                "2026-09-05",
                sanction_amount=450000.0,
                outstanding=165127.0,
                emi=8200.0,
                emis_paid=50,
                emis_pending=22,
            ),
            _tradeline(
                "credit_card",
                _CARD_ISSUER,
                "7731",
                "active",
                "2019-03-14",
                "2026-08-16",
                sanction_amount=150000.0,
                outstanding=12400.0,
            ),
        ],
    },
    "CKRPK7314M": {
        "applicant_name": "Sneha Anil Kulkarni",
        "dob": "1995-08-23",
        "report_date": "2026-09-19",
        "credit_score": 712.0,
        "enquiries": [
            _enquiry("2026-09-05", "Konkan Finserv Ltd (sample)", "Personal loan"),
            _enquiry("2026-08-28", "Godavari Credit Ltd (sample)", "Personal loan"),
            _enquiry("2026-08-02", "Pavana Capital Ltd (sample)", "Personal loan"),
            _enquiry("2026-08-01", "Deccan Consumer Finance Ltd (sample)", "Consumer loan"),
            _enquiry("2026-07-10", "Konkan Finserv Ltd (sample)", "Personal loan"),
            _enquiry("2026-06-25", "Pavana Capital Ltd (sample)", "Personal loan"),
            _enquiry("2026-05-30", "Godavari Credit Ltd (sample)", "Personal loan"),
            _enquiry("2025-11-14", _CARD_ISSUER, "Credit card"),
        ],
        "tradelines": [
            _tradeline(
                "credit_card",
                _CARD_ISSUER,
                "8843",
                "active",
                "2021-06-05",
                "2026-08-17",
                sanction_amount=75000.0,
                outstanding=6900.0,
            ),
            _tradeline(
                "consumer_loan",
                "Deccan Consumer Finance Ltd (sample)",
                "6127",
                "closed",
                "2024-01-18",
                "2025-01-10",
                sanction_amount=45000.0,
                outstanding=0.0,
                emis_paid=12,
                emis_pending=0,
            ),
        ],
    },
    # The identity sheet's PAN: the application's DMVPP5926L (a typo planted in the demo file) has no record.
    "DMVPP5928L": {
        "applicant_name": "Amit Suresh Patil",
        "dob": "1989-11-05",
        "report_date": "2026-09-21",
        "credit_score": 748.0,
        "enquiries": [
            _enquiry("2026-06-30", "Konkan Finserv Ltd (sample)", "Personal loan"),
            _enquiry("2024-11-12", "Indrayani Motor Finance Ltd (sample)", "Two-wheeler loan"),
        ],
        "tradelines": [
            _tradeline(
                "car_loan",
                "Indrayani Motor Finance Ltd (sample)",
                "2981",
                "active",
                "2024-11-20",
                "2026-09-05",
                sanction_amount=95000.0,
                outstanding=43191.0,
                emi=3450.0,
                emis_paid=22,
                emis_pending=14,
            ),
            _tradeline(
                "credit_card",
                _CARD_ISSUER,
                "0264",
                "active",
                "2018-08-22",
                "2026-08-18",
                sanction_amount=100000.0,
                outstanding=7800.0,
            ),
        ],
    },
}


def enquiry_counts(enquiries: list[dict[str, Any]], report_date: dt.date) -> dict[str, int]:
    """Cumulative enquiries dated within 30 / 60 / 90 / 120 days before the report date."""
    ages = [(report_date - dt.date.fromisoformat(e["date"])).days for e in enquiries]
    return {key: sum(1 for age in ages if 0 <= age <= days) for key, days in ENQUIRY_WINDOW_DAYS.items()}


class MockBureau(BureauProvider):
    """Setting mock: the demo applicants' SAMPLE reports, as of the day of the pull (no bureau is called)."""

    name = "mock"
    label = "Mock bureau (SAMPLE reports for the demo applicants)"
    sample = True

    def fetch_report(self, consent, pan, name, dob, mobile):
        record = MOCK_REPORTS.get(pan)
        # A bureau matches the person on PAN and date of birth (the name loosely: the page compares it).
        if record is None or (dob is not None and dob.isoformat() != record["dob"]):
            return None
        printed = dt.date.fromisoformat(record["report_date"])
        today = consent.recorded_at.astimezone(IST).date()
        shift = today - printed

        def moved(value: str | None) -> str | None:
            return (dt.date.fromisoformat(value) + shift).isoformat() if value else None

        enquiries = [{**e, "date": moved(e["date"])} for e in record["enquiries"]]
        return {
            "applicant_name": record["applicant_name"],
            "pan": pan,
            "bureau": None,
            "report_date": today.isoformat(),
            "credit_score": record["credit_score"],
            **enquiry_counts(enquiries, today),
            "enquiries": enquiries,
            "tradelines": [
                {**t, "open_date": moved(t["open_date"]), "last_payment_date": moved(t["last_payment_date"])}
                for t in record["tradelines"]
            ],
        }


PROVIDERS: dict[str, type[BureauProvider]] = {"none": NoBureau, "mock": MockBureau}


def get_provider(setting: str | None = None) -> BureauProvider:
    """The configured provider (`setting`, default config bureau_provider); an unknown name connects none."""
    key = (get_config().bureau_provider if setting is None else setting).strip().lower() or "none"
    provider = PROVIDERS.get(key)
    if provider is None:
        print(f"bureau: unknown provider setting {key[:40]!r}: no bureau connected")
        return NoBureau(unknown=key[:40])
    return provider()


def normalized(report: Any) -> dict[str, Any]:
    """A provider's report with the normalized fields only (lists default to [])."""
    report = report if isinstance(report, dict) else {}
    out = {key: report.get(key) for key in REPORT_FIELDS}
    for key in ("enquiries", "tradelines"):
        if not isinstance(out[key], list):
            out[key] = []
    return out
