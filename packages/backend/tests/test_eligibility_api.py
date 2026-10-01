"""Tests for the eligibility API (app/routers/eligibility.py), no AWS calls.

The router is mounted on a test app (the integrator adds it to app.main). One stateful fake
DynamoDB table backs the project, its webhook settings, the documents' facts and the
eligibility items. The file-check Lambda runs in-process on the synthetic applicants of
test_file_check (the real engine), and the webhook delivery Lambda is stubbed, or run
in-process for the end-to-end test (signature, payload, delivery log). Synthetic data only.
"""

import copy
import datetime as dt
import json
import re
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError, ConnectionClosedError
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.routers.eligibility as elig
from app.config import get_config
from app.webhook_security import verify_signature
from tests.test_file_check import FakeTable as FileCheckTable
from tests.test_file_check import (
    HandlerLambda,
    canned_lambda,
    fc_index,
    project_items,
    rahul_with_obligations,
    sneha,
)
from tests.test_integrations import KEY_ARN, FakeKms, InProcessLambda, _load_webhook_lambda, sealed

eligibility_app = FastAPI()
eligibility_app.include_router(elig.router)
client = TestClient(eligibility_app)

HEADERS = {"x-user-id": "dsa-user"}
PROJECT_ID = "proj_demo"
BASE = f"/projects/{PROJECT_ID}/eligibility"
FILE_CHECK_FUNCTION = "idp-v2-file-check-mcp"
WEBHOOK_FUNCTION = "idp-v2-webhook-delivery"
CRM_URL = "https://crm.example.com/hooks/idp?token=abc"
NOW = dt.datetime(2026, 9, 30, 10, 0, tzinfo=dt.UTC)
WEEK = 7 * 86400
RAHUL, RAHUL_PAN = "Rahul Vijay Deshmukh", "BQXPD4821K"
SNEHA, SNEHA_PAN = "Sneha Anil Kulkarni", "CKRPK7314M"
SAMPLE = "sample policy — replace with your lender grid"

META = {
    "PK": f"PROJ#{PROJECT_ID}",
    "SK": "META",
    "data": {"project_id": PROJECT_ID, "name": "Demo", "description": "", "status": "active", "language": "en"},
    "created_at": "2026-09-28T00:00:00+00:00",
    "updated_at": "2026-09-28T00:00:00+00:00",
}


# ------------------------------------------------------------------ fakes
def _matches(condition, item) -> bool:
    expr = condition.get_expression()
    op, values = expr["operator"], expr["values"]
    if op == "AND":
        return _matches(values[0], item) and _matches(values[1], item)
    value = item.get(values[0].name)
    if op == "=":
        return value == values[1]
    if op == "begins_with":
        return isinstance(value, str) and value.startswith(values[1])
    if op == "BETWEEN":
        return value is not None and values[1] <= value <= values[2]
    raise AssertionError(f"unsupported key condition {op}")


class FakeTable:
    """(PK, SK) items: get / put / delete, key-condition queries, SET updates with attribute_exists."""

    def __init__(self, items=()):
        self.items = {(i["PK"], i["SK"]): copy.deepcopy(i) for i in items}
        self.puts = []
        self.updates = []
        self.fail_put_prefix = None

    def get_item(self, Key, ConsistentRead=None, ProjectionExpression=None):
        item = self.items.get((Key["PK"], Key["SK"]))
        if item is None:
            return {}
        item = copy.deepcopy(item)
        if ProjectionExpression:
            names = [n.strip() for n in ProjectionExpression.split(",")]
            item = {n: item[n] for n in names if n in item}
        return {"Item": item}

    def put_item(self, Item):
        if self.fail_put_prefix and Item["SK"].startswith(self.fail_put_prefix):
            raise ClientError({"Error": {"Code": "ProvisionedThroughputExceededException"}}, "PutItem")
        self.puts.append(copy.deepcopy(Item))
        self.items[(Item["PK"], Item["SK"])] = copy.deepcopy(Item)

    def update_item(self, Key, UpdateExpression, ConditionExpression=None, ExpressionAttributeValues=None):
        self.updates.append(UpdateExpression)
        item = self.items.get((Key["PK"], Key["SK"]))
        if ConditionExpression == "attribute_exists(PK)" and item is None:
            raise ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")
        match = re.fullmatch(r"SET (\w+) = (:\w+)", UpdateExpression)
        assert match, UpdateExpression
        item[match.group(1)] = ExpressionAttributeValues[match.group(2)]

    def delete_item(self, Key):
        self.items.pop((Key["PK"], Key["SK"]), None)

    def query(self, KeyConditionExpression, **kwargs):
        rows = sorted((i for i in self.items.values() if _matches(KeyConditionExpression, i)), key=lambda i: i["SK"])
        return {"Items": copy.deepcopy(rows)}

    def of(self, prefix):
        return [i for (_, sk), i in sorted(self.items.items()) if sk.startswith(prefix)]


# ------------------------------------------------------------------ fixtures
@pytest.fixture(autouse=True)
def _reset_login_limits():
    elig.reset_login_limits()
    yield
    elig.reset_login_limits()


@pytest.fixture
def table(monkeypatch):
    """The project exists; no file check and no webhook delivery configured; the clock is NOW."""
    fake = FakeTable([META])
    for target in (
        "app.routers.eligibility.get_table",
        "app.ddb.projects.get_table",
        "app.ddb.webhooks.get_table",
        "app.ddb.facts.get_table",
    ):
        monkeypatch.setattr(target, lambda: fake)
    monkeypatch.setattr(elig, "_now", lambda: NOW)
    config = get_config()
    monkeypatch.setattr(config, "retention_days", 7)
    monkeypatch.setattr(config, "file_check_function_name", "")
    monkeypatch.setattr(config, "webhook_function_name", "")
    return fake


@pytest.fixture
def documents(table, monkeypatch):
    """Sneha and Rahul (with loan EMIs) analysed; the real file-check engine answers in-process."""
    facts = sneha() + rahul_with_obligations()
    for item in project_items(facts):
        if item["SK"] != "META":
            table.items[(item["PK"], item["SK"])] = item
    monkeypatch.setattr(fc_index, "_table", FileCheckTable(project_items(facts)))
    monkeypatch.setattr(get_config(), "file_check_function_name", FILE_CHECK_FUNCTION)
    stub = HandlerLambda()
    with patch("app.file_check.get_file_check_lambda_client", return_value=stub):
        yield stub


@pytest.fixture
def webhook(table, monkeypatch):
    """The project's CRM webhook is enabled (URL and encrypted secret) and its Lambda configured."""
    meta = table.items[(f"PROJ#{PROJECT_ID}", "META")]
    meta.update(webhook_url=CRM_URL, webhook_enabled=True, webhook_secret_enc=sealed("s" * 43))
    monkeypatch.setattr(get_config(), "webhook_function_name", WEBHOOK_FUNCTION)
    return meta


def use_webhook_lambda(stub):
    return patch("app.webhook_delivery.get_webhook_lambda_client", return_value=stub)


def example(**changes):
    """The client sheet's worked example as a request body (synthetic applicant, Vasai West pincode)."""
    body = {
        "profile": {
            "name": RAHUL,
            "pincode": "401202",
            "company": "Konkan Softworks Pvt Ltd",
            "employment_type": "private_limited",
            "net_income": 98000,
        },
        "cibil": {
            "score": 765,
            "enquiries": {"d30": 0, "d60": 1, "d90": 2, "d120": 3},
            "tradelines": [
                {
                    "loan_type": "personal",
                    "lender": "Sahyadri Finance (sample)",
                    "outstanding": 250000,
                    "emi": 15000,
                    "status": "active",
                    "action": "obligate",
                }
            ],
        },
        "loan": {"amount": 1500000, "tenure_months": 60},
    }
    for path, value in changes.items():
        section, _, field = path.partition("__")
        body[section][field] = value
    return body


def save(applicant=RAHUL, body=None):
    return client.put(f"{BASE}/inputs", headers=HEADERS, json={"applicant": applicant, **(body or example())})


def calculate(applicant=RAHUL, inputs=None):
    body = {"applicant": applicant}
    if inputs is not None:
        body["inputs"] = inputs
    return client.post(f"{BASE}/calculate", headers=HEADERS, json=body)


def login(lender="icici_bank", applicant=RAHUL):
    return client.post(f"{BASE}/login", headers=HEADERS, json={"applicant": applicant, "lender": lender})


def at(result, lender_id):
    return next(r for r in result["per_lender"] if r["lender_id"] == lender_id)


# ------------------------------------------------------------------ project, header, ids
class TestProjectAndValidation:
    @pytest.mark.parametrize(
        ("method", "path", "body"),
        [
            ("GET", "/lenders", None),
            ("GET", "/pincodes/401202", None),
            ("GET", "/companies?name=Konkan", None),
            ("GET", f"/inputs?applicant={RAHUL}", None),
            ("PUT", "/inputs", {"applicant": RAHUL, **example()}),
            ("POST", "/calculate", {"applicant": RAHUL, "inputs": example()}),
            ("POST", "/login", {"applicant": RAHUL, "lender": "icici_bank"}),
        ],
    )
    def test_unknown_project_is_404(self, table, method, path, body):
        response = client.request(method, f"/projects/proj_missing/eligibility{path}", headers=HEADERS, json=body)

        assert response.status_code == 404
        assert response.json() == {"detail": "Project not found"}
        assert table.puts == []

    def test_user_header_is_required(self, table):
        assert client.get(f"{BASE}/lenders").status_code == 422

    def test_invalid_project_id_is_422(self, table):
        assert client.get("/projects/bad%20id/eligibility/lenders", headers=HEADERS).status_code == 422

    @pytest.mark.parametrize("applicant", ["a*b", "../x", "a/b", "x[1]", "tab\there"])
    def test_applicant_is_validated_like_an_id(self, table, applicant):
        responses = [
            client.get(f"{BASE}/inputs", headers=HEADERS, params={"applicant": applicant}),
            save(applicant),
            calculate(applicant, example()),
            login("icici_bank", applicant),
        ]

        assert [r.status_code for r in responses] == [400] * 4
        assert {r.json()["detail"] for r in responses} == {"Invalid applicant"}
        assert table.puts == []

    def test_a_blank_applicant_is_refused(self, table):
        responses = [
            client.get(f"{BASE}/inputs", headers=HEADERS, params={"applicant": "  "}),
            save("  "),
            calculate("  ", example()),
            login("icici_bank", "  "),
        ]

        # The query parameter is checked by the router (400), the bodies by their schema (422).
        assert [r.status_code for r in responses] == [400, 422, 422, 422]
        assert table.puts == []

    @pytest.mark.parametrize(
        ("changes", "field"),
        [
            ({"profile__pan": "ABCD1234F"}, "pan"),
            ({"profile__pincode": "01234"}, "pincode"),
            ({"profile__mobile": "12345"}, "mobile"),
            ({"profile__dob": "2999-01-01"}, "dob"),
            ({"profile__employment_type": "sole trader"}, "employment_type"),
            ({"profile__net_income": -5}, "net_income"),
            ({"profile__nickname": "x"}, "nickname"),
            ({"cibil__score": 950}, "score"),
            ({"cibil__enquiries": {"d30": 5, "d60": 2}}, "enquiries"),
            ({"cibil__tradelines": [{"emi": 100, "action": "sell"}]}, "action"),
            ({"cibil__tradelines": [{"emi": 100, "open_date": "2026-05-01", "last_payment_date": "2026-01-01"}]}, "0"),
            ({"loan__tenure_months": 0}, "tenure_months"),
        ],
    )
    def test_body_is_validated(self, table, changes, field):
        response = save(body=example(**changes))

        assert response.status_code == 422
        assert any(field in [str(p) for p in err["loc"]] for err in response.json()["detail"]), response.json()
        assert table.of("ELIG#") == []

    @pytest.mark.parametrize(
        ("section", "field", "value"),
        [
            ("profile", "net_income", float("nan")),
            ("loan", "amount", float("inf")),
            ("cibil", "score", float("nan")),
            ("loan", "tenure_months", float("-inf")),
        ],
    )
    def test_not_a_number_is_refused(self, table, section, field, value):
        """json.loads accepts NaN and Infinity; they are a 422 (whose error renders as JSON), not a 500."""
        body = example()
        body[section][field] = value
        response = client.put(
            f"{BASE}/inputs",
            headers={**HEADERS, "content-type": "application/json"},
            content=json.dumps({"applicant": RAHUL, **body}),
        )

        assert response.status_code == 422
        assert response.json()["detail"][0]["loc"] == ["body", section, field]
        assert table.of("ELIG#") == []

    def test_labels_are_accepted_and_stored_as_ids(self, table):
        body = example(
            profile__employment_type="Private Limited",
            profile__house_ownership="Owned",
            profile__pan="bqxpd 4821k",
            profile__mobile="+91 98200 12345",
            profile__other_income=[{"type": "Rented Income", "agreement": "Registered", "amount": 12000}],
            cibil__tradelines=[
                {
                    "loan_type": "Personal Loan",
                    "lender": "Sample Bank",
                    "emi": 15000,
                    "status": "Active",
                    "action": "BT",
                }
            ],
        )

        response = save(body=body)

        assert response.status_code == 200
        profile, (tradeline,) = response.json()["inputs"]["profile"], response.json()["inputs"]["cibil"]["tradelines"]
        assert (profile["employment_type"], profile["house_ownership"]) == ("private_limited", "owned")
        assert (profile["pan"], profile["mobile"]) == (RAHUL_PAN, "9820012345")
        assert profile["other_income"] == [
            {"type": "rented", "amount": 12000.0, "frequency": None, "agreement": "registered"}
        ]
        assert (tradeline["loan_type"], tradeline["status"], tradeline["action"]) == ("personal", "active", "bt")


# ------------------------------------------------------------------ lenders and lookups
class TestLendersAndLookups:
    def test_lenders_are_the_sample_policies(self, table):
        response = client.get(f"{BASE}/lenders", headers=HEADERS)

        assert response.status_code == 200
        body = response.json()
        assert (body["sample"], body["label"]) == (True, SAMPLE)
        assert [lender["id"] for lender in body["lenders"]] == [
            "hdfc_bank",
            "icici_bank",
            "axis_bank",
            "bajaj_finance",
            "tata_capital",
        ]
        icici = body["lenders"][1]
        assert (icici["name"], icici["roi"], icici["max_tenure_months"], icici["max_amount"]) == (
            "ICICI Bank",
            11.0,
            72,
            4000000.0,
        )
        assert icici["company_categories"]["CAT A"] == {"foir": 0.7, "multiplier": 21.0}
        assert (icici["sample"], icici["label"]) == (True, SAMPLE)
        assert "Vasai-Virar (Palghar district)" in icici["serviceable_regions"]
        assert set(icici["income_consideration_pct"]) == {
            "rented_notary",
            "rented_registered",
            "bonus",
            "incentive",
            "pension",
        }
        assert [o["id"] for o in body["options"]["tradeline_actions"]] == ["bt", "obligate", "close"]
        assert any(SAMPLE in d for d in body["disclaimers"])

    def test_check_availability(self, table):
        body = client.get(f"{BASE}/pincodes/401202", headers=HEADERS).json()

        assert body["region"] == "Vasai-Virar (Palghar district)"
        assert {lender["lender_id"]: lender["serviceable"] for lender in body["lenders"]} == {
            "hdfc_bank": True,
            "icici_bank": True,
            "axis_bank": False,
            "bajaj_finance": True,
            "tata_capital": True,
        }
        assert (body["serviceable_by"], body["sample"], body["label"]) == (4, True, SAMPLE)
        outside = client.get(f"{BASE}/pincodes/560001", headers=HEADERS).json()
        assert (outside["region"], outside["serviceable_by"]) == (None, 0)

    @pytest.mark.parametrize("pincode", ["01234", "4012020", "40120a"])
    def test_invalid_pincode_is_422(self, table, pincode):
        assert client.get(f"{BASE}/pincodes/{pincode}", headers=HEADERS).status_code == 422

    def test_check_category_of_a_listed_company(self, table):
        body = client.get(f"{BASE}/companies", headers=HEADERS, params={"name": "varad logistics"}).json()

        assert body["match"] == {
            "name": "Varad Logistics LLP",
            "aliases": ["Varad Logistics"],
            "employment_type": "llp",
            "synthetic": True,
        }
        by_lender = {c["lender_id"]: c for c in body["categories"]}
        assert by_lender["icici_bank"] == {
            "lender_id": "icici_bank",
            "lender": "ICICI Bank",
            "category": "CAT C",
            "listed": True,
            "accepted": True,
            "foir": 0.55,
            "multiplier": 14.0,
        }
        assert (by_lender["hdfc_bank"]["listed"], by_lender["hdfc_bank"]["accepted"]) == (False, False)
        assert (body["sample"], body["label"]) == (True, SAMPLE)

    def test_check_category_of_an_unlisted_company(self, table):
        body = client.get(f"{BASE}/companies", headers=HEADERS, params={"name": "Sample Traders"}).json()

        assert body["match"] is None
        assert body["suggestions"] == []
        by_lender = {c["lender_id"]: c for c in body["categories"]}
        assert by_lender["icici_bank"]["category"] is None
        assert (by_lender["icici_bank"]["accepted"], by_lender["icici_bank"]["foir"]) == (True, 0.5)
        assert by_lender["axis_bank"]["accepted"] is False

    def test_check_category_suggests_names(self, table):
        body = client.get(f"{BASE}/companies", headers=HEADERS, params={"name": "tata"}).json()

        assert body["match"] is None
        assert body["suggestions"][:3] == ["Tata Consultancy Services Ltd", "Tata Motors Ltd", "Tata Steel Ltd"]


# ------------------------------------------------------------------ inputs
class TestInputs:
    def test_put_stores_the_inputs_for_seven_days(self, table, capsys):
        response = save()

        assert response.status_code == 200
        body = response.json()
        assert body["saved"] is True
        assert body["created_at"] == body["updated_at"] == "2026-09-30T10:00:00.000000+00:00"
        assert body["expires_at"] == "2026-10-07T10:00:00.000000+00:00"
        (item,) = table.of("ELIG#")
        assert item["expires_at"] == int(NOW.timestamp()) + WEEK
        assert item["applicant"] == RAHUL
        assert item["inputs"]["profile"]["net_income"] == Decimal("98000.0")
        # The key holds no personal data.
        assert re.fullmatch(r"ELIG#[0-9a-f]{40}", item["SK"])
        assert "Rahul" not in item["SK"]
        assert "Rahul" not in capsys.readouterr().out

    def test_get_returns_the_saved_inputs(self, table):
        save()

        body = client.get(f"{BASE}/inputs", headers=HEADERS, params={"applicant": RAHUL}).json()

        assert body["saved"] is True
        assert body["prefill"] is None and body["from_documents"] == []
        assert body["inputs"]["profile"]["company"] == "Konkan Softworks Pvt Ltd"
        assert body["inputs"]["cibil"]["tradelines"][0]["action"] == "obligate"
        assert body["expires_at"] == "2026-10-07T10:00:00.000000+00:00"

    def test_a_later_save_does_not_extend_the_expiry(self, table, monkeypatch):
        save()
        later = NOW + dt.timedelta(days=5)
        monkeypatch.setattr(elig, "_now", lambda: later)

        body = save(body=example(profile__net_income=99000)).json()

        assert body["created_at"] == "2026-09-30T10:00:00.000000+00:00"
        assert body["updated_at"] == "2026-10-05T10:00:00.000000+00:00"
        assert body["expires_at"] == "2026-10-07T10:00:00.000000+00:00"
        (item,) = table.of("ELIG#")
        assert item["expires_at"] == int(NOW.timestamp()) + WEEK
        assert item["inputs"]["profile"]["net_income"] == Decimal("99000.0")

    def test_expired_inputs_are_gone_even_before_ttl_removes_them(self, table, monkeypatch):
        save()
        after = NOW + dt.timedelta(days=7, seconds=1)
        monkeypatch.setattr(elig, "_now", lambda: after)

        body = client.get(f"{BASE}/inputs", headers=HEADERS, params={"applicant": RAHUL}).json()
        assert body["saved"] is False
        assert body["inputs"]["profile"]["name"] is None
        assert calculate().status_code == 404

        saved = save().json()  # a new save starts a new retention period
        assert saved["created_at"] == "2026-10-07T10:00:01.000000+00:00"
        assert table.of("ELIG#")[0]["expires_at"] == int(after.timestamp()) + WEEK

    def test_the_retention_period_is_configurable(self, table, monkeypatch):
        monkeypatch.setattr(get_config(), "retention_days", 3)

        save()

        assert table.of("ELIG#")[0]["expires_at"] == int(NOW.timestamp()) + 3 * 86400

    def test_the_same_applicant_is_found_by_pan_or_name_in_any_case_and_spacing(self, table):
        save(RAHUL_PAN)
        save("  rahul   vijay DESHMUKH ")

        assert len(table.of("ELIG#")) == 2  # one per identifier
        for applicant in ("bqxpd 4821k", RAHUL_PAN, RAHUL, "RAHUL VIJAY DESHMUKH"):
            body = client.get(f"{BASE}/inputs", headers=HEADERS, params={"applicant": applicant}).json()
            assert body["saved"] is True, applicant

    def test_draft_without_the_file_check(self, table):
        body = client.get(f"{BASE}/inputs", headers=HEADERS, params={"applicant": RAHUL}).json()

        assert body["saved"] is False
        assert body["prefill"]["available"] is False
        assert body["prefill"]["detail"] == "Not pre-filled: the file check is not configured"
        assert body["from_documents"] == []
        assert body["inputs"]["profile"]["name"] is None
        assert body["label"] == SAMPLE
        assert table.puts == []  # nothing is saved by GET

    def test_draft_prefilled_from_the_documents(self, documents, table, capsys):
        body = client.get(f"{BASE}/inputs", headers=HEADERS, params={"applicant": SNEHA_PAN}).json()

        assert body["saved"] is False
        profile = body["inputs"]["profile"]
        assert (profile["name"], profile["pan"]) == (SNEHA, "XXXXXX314M")
        assert (profile["company"], profile["employment_type"]) == ("Deccan Retail Pvt Ltd", "private_limited")
        assert profile["net_income"] == 58000.0  # verified, not the declared 65,000
        assert body["inputs"]["loan"] == {"amount": 400000.0, "tenure_months": None}
        assert body["inputs"]["cibil"]["tradelines"] == []
        assert body["from_documents"] == ["name", "pan", "company", "employment_type", "net_income", "loan_amount"]
        prefill = body["prefill"]
        assert prefill["available"] is True
        assert (prefill["verified_net_income"], prefill["income_source"]) == (
            58000.0,
            "verified: salary slips, median net pay",
        )
        assert (prefill["dob"], prefill["documents"]) == (None, 5)
        assert SNEHA_PAN not in json.dumps(body["inputs"]) + json.dumps(prefill)  # only the masked PAN
        logs = capsys.readouterr().out
        assert "Sneha" not in logs and SNEHA_PAN not in logs
        assert table.puts == []

    def test_draft_suggests_the_bank_statements_loan_emis_as_tradelines(self, documents):
        body = client.get(f"{BASE}/inputs", headers=HEADERS, params={"applicant": RAHUL}).json()

        (tradeline,) = body["inputs"]["cibil"]["tradelines"]
        assert tradeline["loan_type"] == "car"
        assert tradeline["lender"] == "Mulshi Auto Finance Ltd (sample)"
        assert (tradeline["emi"], tradeline["action"], tradeline["source"]) == (8200.0, "obligate", "bank_statement")
        assert body["inputs"]["loan"]["tenure_months"] == 48
        assert "tradelines" in body["from_documents"] and "tenure_months" in body["from_documents"]
        assert body["prefill"]["suggested_tradelines"] == 1
        assert any("from the bank statement were added as tradelines" in n for n in body["notes"])

    def test_draft_needs_one_matching_applicant(self, table, monkeypatch):
        monkeypatch.setattr(get_config(), "file_check_function_name", FILE_CHECK_FUNCTION)
        two = {"applicants": [{"applicant": "A One"}, {"applicant": "A Two"}], "pending_documents": []}
        with patch("app.file_check.get_file_check_lambda_client", return_value=canned_lambda(two)):
            body = client.get(f"{BASE}/inputs", headers=HEADERS, params={"applicant": "A"}).json()

        assert body["prefill"]["available"] is False
        assert body["prefill"]["detail"] == "Not pre-filled: 2 applicants in the documents match: use the PAN"

    def test_draft_when_the_file_check_fails(self, table, monkeypatch):
        monkeypatch.setattr(get_config(), "file_check_function_name", FILE_CHECK_FUNCTION)
        failing = canned_lambda({"errorMessage": "boom"}, function_error="Unhandled")
        with patch("app.file_check.get_file_check_lambda_client", return_value=failing):
            response = client.get(f"{BASE}/inputs", headers=HEADERS, params={"applicant": RAHUL})

        assert response.status_code == 200
        assert response.json()["prefill"]["detail"] == "Not pre-filled: the file check failed"


# ------------------------------------------------------------------ calculate
class TestCalculate:
    def test_the_worked_example(self, table):
        response = calculate(inputs=example())

        assert response.status_code == 200
        body = response.json()
        icici, hdfc = at(body, "icici_bank"), at(body, "hdfc_bank")
        assert (icici["per_lakh_emi"], icici["foir_eligibility"], icici["multiplier_eligibility"]) == (
            2174.24,
            2465226.61,
            2058000.0,
        )
        assert (icici["eligible_amount"], icici["tenure_months"], icici["roi"], icici["emi"]) == (
            2058000.0,
            72,
            11.0,
            39172.13,
        )
        assert (hdfc["eligible_amount"], hdfc["tenure_months"], hdfc["roi"], hdfc["emi"]) == (
            1500000.0,
            60,
            12.0,
            33366.67,
        )
        assert at(body, "axis_bank")["status"] == "not_serviceable"
        assert (body["applicant"], body["income_considered"], body["obligations"]) == (RAHUL, 98000.0, 15000.0)
        assert body["best_lender"] == "ICICI Bank"
        assert body["file_check"] == {"used": False, "detail": "the file check is not configured", "applicant": None}
        assert body["notes"][0].startswith("File check not used (the file check is not configured)")
        assert (body["policy_label"], body["label"]) == (SAMPLE, "indicative — the lender decides")
        assert all(row["label"] == SAMPLE for row in body["per_lender"])
        assert table.of("ELIG#") == []  # calculating does not save

    def test_saved_inputs_are_used_when_none_are_sent(self, table):
        save()

        body = calculate().json()

        assert at(body, "icici_bank")["eligible_amount"] == 2058000.0

    def test_no_saved_inputs_is_404(self, table):
        response = calculate()

        assert response.status_code == 404
        assert "No saved eligibility inputs" in response.json()["detail"]

    def test_the_verified_salary_replaces_the_entered_one(self, documents):
        inputs = example(profile__name=SNEHA, profile__company="Deccan Retail Pvt Ltd", profile__net_income=65000)
        inputs["cibil"]["tradelines"] = []

        body = calculate(SNEHA, inputs).json()

        assert body["income_considered"] == 58000.0
        assert body["income"]["net_salary_source"] == "verified"
        assert body["file_check"] == {
            "used": True,
            "detail": "verified figures from the file check",
            "applicant": SNEHA,
        }
        assert any("Entered net income ₹65,000 differs from the verified ₹58,000" in n for n in body["notes"])
        assert at(body, "icici_bank")["multiplier_eligibility"] == 58000 * 18  # Deccan Retail: CAT B at ICICI
        (call,) = documents.calls
        assert json.loads(call["Payload"]) == {"project_id": PROJECT_ID, "applicant": SNEHA}

    def test_a_full_pan_in_the_profile_finds_the_applicant(self, documents):
        inputs = example(profile__pan=SNEHA_PAN, profile__name=None)

        body = calculate("sneha-file", inputs).json()

        assert body["file_check"]["used"] is True
        assert json.loads(documents.calls[0]["Payload"])["applicant"] == SNEHA_PAN

    def test_a_bank_statement_emi_is_counted_once(self, documents):
        inputs = example(profile__name=RAHUL, profile__net_income=82500)
        inputs["cibil"]["tradelines"] = []
        unmatched = calculate(RAHUL, inputs).json()

        inputs["cibil"]["tradelines"] = [
            {"loan_type": "car", "lender": "Mulshi Auto Finance", "emi": 8200, "action": "obligate"}
        ]
        matched = calculate(RAHUL, inputs).json()

        assert unmatched["obligations"] == matched["obligations"] == 8200.0
        (flagged,) = unmatched["obligation_details"]["counted"]
        assert flagged["source"] == "bank_statement" and "matches no tradeline" in flagged["flag"]
        assert matched["obligation_details"]["bank_statement_emis"][0]["matched_tradeline"] == 1
        assert [c["source"] for c in matched["obligation_details"]["counted"]] == ["tradeline"]

    def test_invalid_inputs_are_422(self, table):
        assert calculate(inputs=example(cibil__score=100)).status_code == 422


# ------------------------------------------------------------------ login
class TestLogin:
    def test_without_a_webhook_the_request_is_recorded_only(self, table, capsys):
        save()
        stub = MagicMock()
        with use_webhook_lambda(stub):
            response = login()

        assert response.status_code == 200
        body = response.json()
        assert body == {
            "status": "recorded",
            "applicant": RAHUL,
            "lender": "ICICI Bank",
            "lender_id": "icici_bank",
            "eligible_amount": 2058000.0,
            "emi": 39172.13,
            "tenure_months": 72,
            "roi": 11.0,
            "requested_at": "2026-09-30T10:00:00.000000+00:00",
            "webhook": "not_enabled",
            "webhook_detail": "the project's CRM webhook is not enabled",
            "delivery": None,
            "label": "indicative — the lender decides",
            "policy_label": SAMPLE,
        }
        stub.invoke.assert_not_called()
        (audit,) = table.of("LOGINREQ#")
        assert audit["SK"].startswith("LOGINREQ#2026-09-30T10:00:00.000000+00:00#")
        assert {k: v for k, v in audit.items() if k not in ("PK", "SK")} == {
            "lender_id": "icici_bank",
            "requested_at": "2026-09-30T10:00:00.000000+00:00",
            "webhook_status": "not_enabled",
            "expires_at": int(NOW.timestamp()) + WEEK,
        }
        logs = capsys.readouterr().out
        assert "Rahul" not in logs and "2058000" not in logs

    def test_with_the_webhook_enabled_the_crm_is_notified(self, table, webhook):
        save()
        stub = canned_lambda({"delivery_id": "d-1", "status": "delivered", "http_status": 202, "error": None})
        with use_webhook_lambda(stub):
            body = login("ICICI Bank").json()

        assert (body["webhook"], body["delivery"]) == (
            "delivered",
            {"delivery_id": "d-1", "status": "delivered", "http_status": 202, "error": None},
        )
        (call,) = stub.invoke.call_args_list
        assert call.kwargs["FunctionName"] == WEBHOOK_FUNCTION
        assert call.kwargs["InvocationType"] == "RequestResponse"
        assert json.loads(call.kwargs["Payload"]) == {
            "project_id": PROJECT_ID,
            "event": "file_login.requested",
            "login": {
                "applicant": RAHUL,
                "lender": "ICICI Bank",
                "eligible_amount": 2058000.0,
                "emi": 39172.13,
                "tenure_months": 72,
                "roi": 11.0,
                "note": f"indicative — the lender decides; {SAMPLE}",
            },
        }
        assert table.of("LOGINREQ#")[0]["webhook_status"] == "delivered"

    def test_a_crm_failure_is_a_failed_delivery_not_an_error(self, table, webhook):
        save()
        stub = canned_lambda({"delivery_id": "d-2", "status": "failed", "http_status": 503, "error": "HTTP 503"})
        with use_webhook_lambda(stub):
            response = login()

        assert response.status_code == 200
        assert (response.json()["status"], response.json()["webhook"]) == ("recorded", "failed")
        assert response.json()["delivery"]["error"] == "HTTP 503"

    @pytest.mark.parametrize(
        ("stub", "webhook_status", "delivery_error"),
        [
            (
                canned_lambda(),
                "failed",
                "invoke failed (AccessDeniedException)",
            ),
            (canned_lambda({"errorMessage": "x"}, function_error="Unhandled"), "failed", "function error (Unhandled)"),
            (canned_lambda(raw=b"not json"), "failed", "non-JSON response"),
            (
                canned_lambda({"status": "error", "error": "webhook failed: KeyError"}),
                "failed",
                "webhook failed: KeyError",
            ),
        ],
    )
    def test_lambda_problems_are_reported(self, table, webhook, stub, webhook_status, delivery_error):
        if delivery_error.startswith("invoke failed"):
            stub.invoke.side_effect = ClientError({"Error": {"Code": "AccessDeniedException"}}, "Invoke")
        save()
        with use_webhook_lambda(stub):
            body = login().json()

        assert body["status"] == "recorded"
        assert body["webhook"] == webhook_status
        assert body["delivery"] == {
            "delivery_id": None,
            "status": "failed",
            "http_status": None,
            "error": delivery_error,
        }

    def test_a_throttled_invoke_is_sent_once_more(self, table, webhook):
        save()
        stub = canned_lambda({"delivery_id": "d-4", "status": "delivered", "http_status": 200, "error": None})
        throttled = ClientError({"Error": {"Code": "TooManyRequestsException"}}, "Invoke")
        stub.invoke.side_effect = [throttled, stub.invoke.return_value]
        with use_webhook_lambda(stub):
            body = login().json()

        assert (body["webhook"], body["delivery"]["delivery_id"]) == ("delivered", "d-4")
        assert stub.invoke.call_count == 2
        assert table.of("LOGINREQ#")[0]["webhook_status"] == "delivered"

    def test_an_event_that_may_have_been_sent_is_never_sent_again(self, table, webhook):
        """The CRM must not get the login twice: a dropped connection is reported, not retried."""
        save()
        stub = canned_lambda({"delivery_id": "d-5", "status": "delivered", "http_status": 200, "error": None})
        dropped = ConnectionClosedError(endpoint_url="https://lambda.ap-south-1.amazonaws.com")
        stub.invoke.side_effect = [dropped, stub.invoke.return_value]
        with use_webhook_lambda(stub):
            body = login().json()

        assert (body["status"], body["webhook"]) == ("recorded", "failed")
        assert body["delivery"]["error"] == "invoke failed (ConnectionClosedError)"
        assert stub.invoke.call_count == 1
        assert table.of("LOGINREQ#")[0]["webhook_status"] == "failed"

    def test_skipped_by_the_lambda(self, table, webhook):
        save()
        with use_webhook_lambda(canned_lambda({"status": "skipped", "reason": "webhook disabled"})):
            body = login().json()

        assert (body["webhook"], body["webhook_detail"], body["delivery"]) == ("skipped", "webhook disabled", None)

    def test_delivery_not_configured(self, table, webhook, monkeypatch):
        monkeypatch.setattr(get_config(), "webhook_function_name", "")
        save()

        body = login().json()

        assert (body["webhook"], body["webhook_detail"]) == ("not_configured", "webhook delivery is not configured")

    def test_a_lender_that_is_not_eligible_is_refused(self, table, webhook):
        save()
        stub = MagicMock()
        with use_webhook_lambda(stub):
            response = login("axis_bank")

        assert response.status_code == 409
        assert response.json() == {
            "detail": "Axis Bank: Not serviceable: Pincode 401202 is not serviceable by Axis Bank"
        }
        stub.invoke.assert_not_called()
        assert table.of("LOGINREQ#") == []

    def test_unknown_lender_is_400(self, table):
        save()

        response = login("sample_bank")

        assert response.status_code == 400
        assert response.json()["detail"].startswith("Unknown lender (known: hdfc_bank, icici_bank")

    def test_saved_inputs_are_required(self, table):
        response = login()

        assert response.status_code == 404
        assert "save them (PUT .../inputs) first" in response.json()["detail"]

    def test_one_login_per_lender_every_ten_seconds(self, table, monkeypatch):
        clock = {"now": 1000.0}
        monkeypatch.setattr(elig, "_monotonic", lambda: clock["now"])
        save()

        assert login().status_code == 200
        clock["now"] += 3
        again = login()
        assert again.status_code == 429
        assert again.headers["retry-after"] == "7"
        assert login("hdfc_bank").status_code == 200  # another lender is not held back
        clock["now"] += 7
        assert login().status_code == 200
        assert len(table.of("LOGINREQ#")) == 3

    def test_an_unrecorded_request_sends_nothing(self, table, webhook):
        save()
        table.fail_put_prefix = "LOGINREQ#"
        stub = MagicMock()
        with use_webhook_lambda(stub):
            response = login()

        assert response.status_code == 502
        assert response.json() == {"detail": "The login request could not be recorded"}
        stub.invoke.assert_not_called()
        assert elig._running_logins == 0
        # Nothing was recorded, so a retry is not held back.
        table.fail_put_prefix = None
        with use_webhook_lambda(canned_lambda({"delivery_id": "d", "status": "delivered", "http_status": 200})):
            assert login().status_code == 200

    def test_a_pan_is_never_sent_to_the_crm(self, table, webhook):
        save(RAHUL_PAN, example(profile__name=None))
        stub = canned_lambda({"delivery_id": "d-3", "status": "delivered", "http_status": 200, "error": None})
        with use_webhook_lambda(stub):
            body = login(applicant=RAHUL_PAN).json()

        assert body["applicant"] == "XXXXXX821K"
        assert RAHUL_PAN not in stub.invoke.call_args.kwargs["Payload"].decode()

    def test_end_to_end_with_the_real_delivery_lambda(self, table, webhook, monkeypatch):
        """The Lambda decrypts the backend's secret, signs the login event and logs the delivery."""
        lam = _load_webhook_lambda()
        kms = FakeKms()
        monkeypatch.setattr(lam, "_table", table)
        monkeypatch.setattr(lam, "_kms_client", kms)
        monkeypatch.setattr(lam, "SECRET_KEY_ARN", KEY_ARN)
        monkeypatch.setattr(lam, "_resolve", lambda host, port, type=None: [(2, 1, 6, "", ("93.184.216.34", port))])
        sent = []

        def fake_post(target, addresses, body, headers, timeout_s=None):
            sent.append((target, body, headers))
            return 200

        monkeypatch.setattr(lam, "_post_once", fake_post)
        save()
        with use_webhook_lambda(InProcessLambda(lam)):
            body = login().json()

        assert (body["webhook"], body["delivery"]["status"], body["delivery"]["http_status"]) == (
            "delivered",
            "delivered",
            200,
        )
        ((target, raw, headers),) = sent
        assert (target.host, target.target) == ("crm.example.com", "/hooks/idp?token=abc")
        assert headers["X-SmartDial-Event"] == "file_login.requested"
        assert headers["X-SmartDial-Delivery"] == body["delivery"]["delivery_id"]
        assert verify_signature("s" * 43, headers["X-SmartDial-Signature"], raw)
        payload = json.loads(raw)
        assert (payload["event"], payload["project_id"], payload["document_id"]) == (
            "file_login.requested",
            PROJECT_ID,
            None,
        )
        assert payload["results"] == [
            {
                "applicant": RAHUL,
                "lender": "ICICI Bank",
                "eligible_amount": 2058000.0,
                "emi": 39172.13,
                "tenure_months": 72,
                "roi": 11.0,
                "note": f"indicative — the lender decides; {SAMPLE}",
            }
        ]
        (log_item,) = table.of("WHDLV#")
        assert (log_item["event"], log_item["applicant"], log_item["status"]) == (
            "file_login.requested",
            RAHUL,
            "delivered",
        )
        assert "document_id" not in log_item
        assert table.of("LOGINREQ#")[0]["webhook_status"] == "delivered"


# ------------------------------------------------------------------ erase hook
def test_erase_applicant_eligibility_deletes_by_name_or_pan(table):
    save(RAHUL)
    save("rahul-file", example(profile__pan=RAHUL_PAN, profile__name="R V Deshmukh"))
    save(SNEHA, example(profile__name=SNEHA))

    deleted = elig.erase_applicant_eligibility(PROJECT_ID, [RAHUL, RAHUL_PAN])

    assert deleted == 2
    (left,) = table.of("ELIG#")
    assert left["applicant"] == SNEHA


def test_openapi_documents_the_eligibility_contract():
    schema = eligibility_app.openapi()
    paths = schema["paths"]

    assert set(paths) == {
        "/projects/{project_id}/eligibility/lenders",
        "/projects/{project_id}/eligibility/pincodes/{pincode}",
        "/projects/{project_id}/eligibility/companies",
        "/projects/{project_id}/eligibility/inputs",
        "/projects/{project_id}/eligibility/calculate",
        "/projects/{project_id}/eligibility/login",
    }
    assert set(paths["/projects/{project_id}/eligibility/inputs"]) == {"get", "put"}
    status = schema["components"]["schemas"]["LenderEligibility"]["properties"]["status"]
    assert status["enum"] == ["eligible", "not_serviceable", "not_eligible"]
