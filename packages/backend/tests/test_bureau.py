"""Tests for the credit bureau providers (app/bureau.py) and the pull API (app/routers/bureau.py), no AWS calls.

The bureau and eligibility routers are mounted on a test app over the stateful fake DynamoDB table
of test_eligibility_api. Synthetic data only: the mock provider's demo applicants.
"""

import datetime as dt

import pytest
from botocore.exceptions import ClientError
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.routers.bureau as bureau_router
import app.routers.eligibility as elig
from app import bureau
from app.config import get_config
from tests.test_eligibility_api import META, FakeTable

bureau_app = FastAPI()
bureau_app.include_router(elig.router)
bureau_app.include_router(bureau_router.router)
client = TestClient(bureau_app)

HEADERS = {"x-user-id": "asha.verma"}
PROJECT_ID = "proj_demo"
BASE = f"/projects/{PROJECT_ID}/eligibility/bureau"
# 20:00 UTC is 01:30 the next day in India: the report is dated the Indian day.
NOW = dt.datetime(2026, 10, 2, 20, 0, tzinfo=dt.UTC)
TODAY_IST = "2026-10-03"
RAHUL, RAHUL_PAN = "Rahul Vijay Deshmukh", "BQXPD4821K"
SNEHA_PAN = "CKRPK7314M"
AMIT_PAN, AMIT_APPLICATION_PAN = "DMVPP5928L", "DMVPP5926L"
CONSENT = {"given": True, "method": "otp", "reference": "OTP-2026-1042"}


@pytest.fixture(autouse=True)
def _reset_pull_limits():
    bureau_router.reset_pull_limits()
    yield
    bureau_router.reset_pull_limits()


@pytest.fixture
def table(monkeypatch):
    """The project exists; provider none (the default); the clock is NOW."""
    fake = FakeTable([META])
    for target in (
        "app.routers.bureau.get_table",
        "app.routers.eligibility.get_table",
        "app.ddb.projects.get_table",
        "app.ddb.webhooks.get_table",
        "app.ddb.facts.get_table",
        "app.reference_data.get_table",
        "app.lender_policy.get_table",
    ):
        monkeypatch.setattr(target, lambda: fake)
    monkeypatch.setattr(bureau_router, "_now", lambda: NOW)
    monkeypatch.setattr(elig, "_now", lambda: NOW)
    config = get_config()
    monkeypatch.setattr(config, "retention_days", 7)
    monkeypatch.setattr(config, "bureau_provider", "none")
    monkeypatch.setattr(config, "file_check_function_name", "")
    monkeypatch.setattr(config, "webhook_function_name", "")
    return fake


@pytest.fixture
def mock_bureau(table, monkeypatch):
    monkeypatch.setattr(get_config(), "bureau_provider", "mock")
    return table


def pull(applicant=RAHUL_PAN, consent=None, **profile):
    body = {"applicant": applicant, "consent": consent or CONSENT, **profile}
    return client.post(f"{BASE}/fetch", headers=HEADERS, json=body)


def consent_at(when: dt.datetime) -> bureau.Consent:
    return bureau.Consent(consent_id="c1", method="otp", purpose="test", recorded_at=when, recorded_by="asha.verma")


def pulls(table):
    return table.of(bureau_router.PULL_SK_PREFIX)


# ------------------------------------------------------------------ providers
class TestProviders:
    def test_the_setting_chooses_the_provider(self, monkeypatch):
        monkeypatch.setattr(get_config(), "bureau_provider", "none")
        assert isinstance(bureau.get_provider(), bureau.NoBureau)
        assert isinstance(bureau.get_provider(" Mock "), bureau.MockBureau)
        assert isinstance(bureau.get_provider(""), bureau.NoBureau)

    def test_none_cannot_pull_and_says_why(self):
        provider = bureau.get_provider("none")
        assert (provider.enabled, provider.sample) == (False, False)
        assert "upload the applicant's credit report" in provider.detail
        with pytest.raises(bureau.BureauNotConfiguredError):
            provider.fetch_report(consent_at(NOW), RAHUL_PAN, RAHUL, None, None)

    def test_an_unknown_setting_connects_no_bureau(self):
        provider = bureau.get_provider("cibil-live")
        assert provider.enabled is False
        assert "Unknown bureau provider 'cibil-live'" in provider.detail

    @pytest.mark.parametrize("when", [NOW, dt.datetime(2027, 3, 1, 6, 0, tzinfo=dt.UTC)])
    @pytest.mark.parametrize(
        ("pan", "counts"),
        [(RAHUL_PAN, (0, 1, 1, 2)), (SNEHA_PAN, (2, 4, 6, 7)), (AMIT_PAN, (0, 0, 1, 1))],
    )
    def test_mock_reports_are_dated_the_day_of_the_pull_with_the_pdfs_enquiries(self, when, pan, counts):
        report = bureau.MockBureau().fetch_report(consent_at(when), pan, None, None, None)
        today = when.astimezone(bureau.IST).date()
        assert report["report_date"] == today.isoformat()
        assert tuple(report[k] for k in bureau.ENQUIRY_WINDOW_DAYS) == counts
        dates = [e["date"] for e in report["enquiries"]] + [
            d for t in report["tradelines"] for d in (t["open_date"], t["last_payment_date"])
        ]
        assert max(dates) <= today.isoformat()
        assert set(report) == set(bureau.REPORT_FIELDS)

    def test_mock_report_of_rahul_matches_his_sample_credit_report(self):
        report = bureau.MockBureau().fetch_report(consent_at(NOW), RAHUL_PAN, RAHUL, None, None)
        assert (report["applicant_name"], report["pan"], report["credit_score"]) == (RAHUL, RAHUL_PAN, 771.0)
        car, card = report["tradelines"]
        assert (car["loan_type"], car["emi"], car["outstanding"], car["account_last4"]) == (
            "car_loan",
            8200.0,
            165127.0,
            "4512",
        )
        assert (car["emis_paid"], car["emis_pending"], car["status"]) == (50, 22, "active")
        assert (card["loan_type"], card["emi"], card["outstanding"]) == ("credit_card", None, 12400.0)
        # Every date moved by the same days: the car loan's last EMI is 13 days before the report, as printed.
        assert dt.date.fromisoformat(report["report_date"]) - dt.date.fromisoformat(car["last_payment_date"]) == (
            dt.timedelta(days=13)
        )

    def test_mock_has_no_record_for_other_pans_or_another_date_of_birth(self):
        mock = bureau.MockBureau()
        assert mock.fetch_report(consent_at(NOW), "ABCDE1234F", None, None, None) is None
        # The PAN on Amit's application has a typo (the identity sheet's is right).
        assert mock.fetch_report(consent_at(NOW), AMIT_APPLICATION_PAN, "Amit S. Patil", None, None) is None
        assert mock.fetch_report(consent_at(NOW), AMIT_PAN, None, dt.date(1989, 11, 6), None) is None
        assert mock.fetch_report(consent_at(NOW), AMIT_PAN, None, dt.date(1989, 11, 5), "9000000103") is not None

    def test_normalized_keeps_the_readers_fields_only(self):
        out = bureau.normalized({"credit_score": 700, "tradelines": "none", "raw_xml": "<x/>"})
        assert set(out) == set(bureau.REPORT_FIELDS)
        assert (out["credit_score"], out["tradelines"], out["enquiries"]) == (700, [], [])
        assert bureau.normalized(None)["tradelines"] == []


# ------------------------------------------------------------------ status
class TestStatus:
    def test_none_by_default_with_the_reason(self, table):
        body = client.get(BASE, headers=HEADERS).json()
        assert (body["provider"], body["enabled"], body["sample"]) == ("none", False, False)
        assert "No credit bureau is connected" in body["detail"]
        assert [m["id"] for m in body["consent_methods"]] == ["otp", "signed_form", "recorded_call"]

    def test_mock_can_pull_sample_reports(self, mock_bureau):
        body = client.get(BASE, headers=HEADERS).json()
        assert (body["provider"], body["enabled"], body["sample"], body["detail"]) == ("mock", True, True, None)

    def test_unknown_project(self, table):
        assert client.get("/projects/proj_other/eligibility/bureau", headers=HEADERS).status_code == 404


# ------------------------------------------------------------------ fetch
class TestFetch:
    def test_rahul_gets_the_cibil_block_of_the_report_and_the_consent_is_logged(self, mock_bureau):
        response = pull(pan=RAHUL_PAN, name=RAHUL, dob="1992-02-14", mobile="+91 90000 00101")
        assert response.status_code == 200, response.text
        body = response.json()
        assert (body["found"], body["provider"], body["sample"], body["name_on_report"]) == (
            True,
            "mock",
            True,
            RAHUL,
        )
        cibil = body["cibil"]
        assert (cibil["score"], cibil["source"], cibil["report_date"]) == (771, "bureau", TODAY_IST)
        assert cibil["enquiries"] == {"d30": 0, "d60": 1, "d90": 1, "d120": 2}
        car, card = cibil["tradelines"]
        assert car == {
            "loan_type": "car",
            "lender": "Mulshi Auto Finance Ltd (sample)",
            "sanction_amount": 450000.0,
            "outstanding": 165127.0,
            "emi": 8200.0,
            "status": "active",
            "account_number": "XXXX4512",
            "overdue": 0.0,
            "emis_paid": 50,
            "emis_pending": 22,
            "open_date": "2022-07-25",
            "last_payment_date": "2026-09-20",
            "action": "obligate",
            "source": "bureau",
        }
        assert (card["loan_type"], card["emi"], card["action"], card["source"]) == (
            "credit_card",
            None,
            "obligate",
            "bureau",
        )
        assert body["notes"][0].startswith(f"SAMPLE report of the mock bureau (synthetic data) of {TODAY_IST}")

        (item,) = pulls(mock_bureau)
        assert item["SK"].startswith("BUREAUPULL#2026-10-02T20:00:00") and item["SK"].endswith(body["consent_id"])
        assert item["outcome"] == "fetched"
        assert (item["consent_method"], item["consent_reference"], item["consent_purpose"]) == (
            "otp",
            "OTP-2026-1042",
            "Loan eligibility assessment",
        )
        assert (item["requested_by"], item["provider"], item["pan_masked"]) == ("asha.verma", "mock", "XXXXXX821K")
        assert item["applicant_key"] == elig.applicant_key(RAHUL_PAN)
        assert item["expires_at"] == int(NOW.timestamp()) + 7 * 86400
        # No name, PAN, date of birth, mobile or report data in the log.
        assert set(item) == {
            "PK",
            "SK",
            "consent_id",
            "consent_method",
            "consent_purpose",
            "consent_reference",
            "requested_at",
            "requested_by",
            "provider",
            "applicant_key",
            "pan_masked",
            "outcome",
            "expires_at",
        }

    def test_the_block_saves_like_any_other_input(self, mock_bureau):
        cibil = pull(name=RAHUL).json()["cibil"]
        saved = client.put(
            f"/projects/{PROJECT_ID}/eligibility/inputs",
            headers=HEADERS,
            json={"applicant": RAHUL_PAN, "profile": {"name": RAHUL, "pan": RAHUL_PAN}, "cibil": cibil},
        )
        assert saved.status_code == 200, saved.text
        assert saved.json()["inputs"]["cibil"] == cibil

    def test_sneha_closed_loan_is_close(self, mock_bureau):
        cibil = pull(applicant="Sneha Anil Kulkarni", pan=SNEHA_PAN).json()["cibil"]
        assert cibil["enquiries"] == {"d30": 2, "d60": 4, "d90": 6, "d120": 7}
        assert [(t["loan_type"], t["status"], t["action"]) for t in cibil["tradelines"]] == [
            ("credit_card", "active", "obligate"),
            ("consumer", "closed", "close"),
        ]

    def test_no_record_answers_found_false(self, mock_bureau):
        response = pull(applicant="Amit S. Patil", pan=AMIT_APPLICATION_PAN)
        assert response.status_code == 200, response.text
        body = response.json()
        assert (body["found"], body["cibil"]) == (False, None)
        assert "no record for PAN XXXXXX926L" in body["notes"][0]
        assert pulls(mock_bureau)[0]["outcome"] == "no_record"

    def test_a_masked_pan_on_the_form_uses_the_applicants_pan(self, mock_bureau):
        response = pull(applicant=AMIT_PAN, pan="XXXXXX928L", name="Amit S. Patil")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["cibil"]["score"] == 748
        # "Amit S. Patil" is the same person as the report's "Amit Suresh Patil".
        assert not any("not 'Amit S. Patil'" in n for n in body["notes"])

    def test_a_name_that_is_not_the_reports_is_flagged(self, mock_bureau):
        notes = pull(name="Rohan Iyer").json()["notes"]
        assert any("in the name 'Rahul Vijay Deshmukh', not 'Rohan Iyer'" in n for n in notes)

    def test_no_bureau_connected(self, table):
        response = pull()
        assert response.status_code == 503
        assert "No credit bureau is connected" in response.json()["detail"]
        assert pulls(table) == []

    def test_consent_is_required(self, mock_bureau):
        response = pull(consent={**CONSENT, "given": False})
        assert response.status_code == 400
        assert "consent is needed" in response.json()["detail"]
        assert pull(consent={"given": True}).status_code == 422
        assert pull(consent={**CONSENT, "method": "whatsapp"}).status_code == 422
        assert pull(consent={**CONSENT, "reference": "otp 1234\nphone"}).status_code == 422
        assert pulls(mock_bureau) == []

    @pytest.mark.parametrize(
        ("applicant", "pan", "detail"),
        [
            (RAHUL, None, "needs the applicant's full PAN"),
            (RAHUL, "XXXXXX821K", "needs the applicant's full PAN"),
            (RAHUL_PAN, SNEHA_PAN, "Two PANs for one applicant (XXXXXX314M and XXXXXX821K)"),
            (RAHUL_PAN, "XXXXXX314M", "The PAN on the form (XXXXXX314M) is not the applicant's (XXXXXX821K)"),
        ],
    )
    def test_the_pan_must_be_the_applicants(self, mock_bureau, applicant, pan, detail):
        response = pull(applicant=applicant, pan=pan)
        assert response.status_code == 400
        assert detail in response.json()["detail"]
        assert pulls(mock_bureau) == []

    def test_unknown_project_and_bad_applicant(self, mock_bureau):
        assert (
            client.post(
                "/projects/proj_other/eligibility/bureau/fetch",
                headers=HEADERS,
                json={"applicant": RAHUL_PAN, "consent": CONSENT},
            ).status_code
            == 404
        )
        assert pull(applicant="../x").status_code == 400

    def test_one_pull_per_applicant_every_few_seconds(self, mock_bureau, monkeypatch):
        clock = [100.0]
        monkeypatch.setattr(bureau_router, "_monotonic", lambda: clock[0])
        assert pull().status_code == 200
        again = pull()
        assert again.status_code == 429
        assert again.headers["Retry-After"] == "10"
        assert pull(applicant=SNEHA_PAN).status_code == 200
        clock[0] += bureau_router.PULL_INTERVAL_S
        assert pull().status_code == 200
        assert len(pulls(mock_bureau)) == 3

    def test_no_pull_without_a_logged_consent(self, mock_bureau):
        mock_bureau.fail_put_prefix = bureau_router.PULL_SK_PREFIX
        response = pull()
        assert response.status_code == 502
        assert "consent could not be logged" in response.json()["detail"]
        # Nothing was pulled: a retry may go at once.
        mock_bureau.fail_put_prefix = None
        assert pull().status_code == 200

    def test_a_failing_bureau(self, mock_bureau, monkeypatch):
        def fail(self, consent, pan, name, dob, mobile):
            raise bureau.BureauError("timeout after 20 s")

        monkeypatch.setattr(bureau.MockBureau, "fetch_report", fail)
        response = pull()
        assert response.status_code == 502
        assert response.json()["detail"] == "The bureau pull failed: timeout after 20 s"
        assert pulls(mock_bureau)[0]["outcome"] == "failed"

    def test_a_provider_bug_is_a_502_without_its_message(self, mock_bureau, monkeypatch):
        def crash(self, consent, pan, name, dob, mobile):
            raise KeyError(pan)

        monkeypatch.setattr(bureau.MockBureau, "fetch_report", crash)
        response = pull()
        assert response.status_code == 502
        assert response.json()["detail"] == "The bureau pull failed (unexpected error)"
        assert RAHUL_PAN not in response.text
        assert pulls(mock_bureau)[0]["outcome"] == "failed"

    def test_the_outcome_not_logged_still_answers(self, mock_bureau, monkeypatch):
        def refuse(**kwargs):
            raise ClientError({"Error": {"Code": "ProvisionedThroughputExceededException"}}, "UpdateItem")

        monkeypatch.setattr(mock_bureau, "update_item", refuse)
        assert pull().status_code == 200
        assert pulls(mock_bureau)[0]["outcome"] == "requested"


# ------------------------------------------------------------------ the report read as the CIBIL page reads it
class TestCibilBlock:
    def test_values_the_page_refuses_are_left_out_with_a_note(self):
        report = bureau.normalized(
            {
                "credit_score": 950,
                "report_date": "2026-09-30",
                "enquiries_30d": 3,
                "enquiries_60d": 1,
                "tradelines": [
                    {"loan_type": "personal_loan", "lender": "Sample Finance (sample)", "emi": 5000, "status": "Open"},
                    {"loan_type": "other"},
                    "not a tradeline",
                ],
            }
        )
        block, notes = bureau_router.cibil_block(report)
        assert (block.score, block.source, block.report_date) == (None, "bureau", dt.date(2026, 9, 30))
        assert block.enquiries.model_dump() == {"d30": None, "d60": None, "d90": None, "d120": None}
        assert [(t.loan_type, t.status, t.source) for t in block.tradelines] == [("personal", "active", "bureau")]
        assert notes == [
            "The report's enquiries do not add up over 30, 60, 90 and 120 days: enter them by hand",
            "2 account(s) of the report could not be read: add them by hand",
        ]

    def test_at_most_fifty_accounts(self):
        loan = {"loan_type": "personal_loan", "lender": "Sample Finance (sample)", "emi": 1000.0, "status": "active"}
        block, notes = bureau_router.cibil_block(bureau.normalized({"tradelines": [loan] * 52}))
        assert len(block.tradelines) == 50
        assert notes == ["The report lists 52 accounts: the first 50 are used"]
