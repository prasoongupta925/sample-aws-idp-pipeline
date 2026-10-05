"""The lender policy workbook: upload, storage, retention and use in the calculation
(app/lender_policy.py, app/routers/lender_policy.py, the sheet grid of app/eligibility.py).

No AWS: a fake table and a fake S3. The workbook is the real policy sheet's copy
(tests/fixtures/policy_workbook.xlsx: lender terms only) or a small synthetic one; applicants
and companies are synthetic.
"""

import datetime as dt
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import eligibility as el
from app import lender_policy, reference_data
from app.caller import Caller, require_admin
from app.config import get_config
from app.policy_workbook import parse_policy_workbook
from app.routers import lender_policy as router_module
from tests.test_eligibility_engine import example
from tests.test_policy_workbook import FIXTURE, grid_rows, rules_rows, workbook
from tests.test_reference_data import FakeTable, csv_bytes

BUCKET = "doc-bucket-test"
XLSX = lender_policy.XLSX_CONTENT_TYPE
NOW = dt.datetime(2026, 10, 5, 10, 0, tzinfo=dt.UTC)
ADMIN = Caller(sub="admin-sub", username="asha.verma", groups=("admin",))


class FakeS3:
    def __init__(self):
        self.objects: dict[tuple[str, str], dict] = {}

    def put_object(self, Bucket, Key, Body, ContentType=None):
        self.objects[(Bucket, Key)] = {"Body": bytes(Body), "ContentType": ContentType}

    def get_object(self, Bucket, Key):
        import io

        return {"Body": io.BytesIO(self.objects[(Bucket, Key)]["Body"])}

    def delete_object(self, Bucket, Key):
        self.objects.pop((Bucket, Key), None)

    def generate_presigned_url(self, operation, Params, ExpiresIn):
        return f"https://s3.example/{Params['Bucket']}/{Params['Key']}?cd={Params.get('ResponseContentDisposition')}"

    def names(self) -> list[str]:
        return sorted(k for _, k in self.objects)


@pytest.fixture
def store(monkeypatch):
    table, s3 = FakeTable(), FakeS3()
    monkeypatch.setattr(lender_policy, "get_table", lambda: table)
    monkeypatch.setattr(reference_data, "get_table", lambda: table)
    monkeypatch.setattr(lender_policy, "get_s3_client", lambda: s3)
    monkeypatch.setattr(lender_policy, "get_s3_presign_client", lambda: s3)
    monkeypatch.setattr(get_config(), "document_storage_bucket_name", BUCKET)
    monkeypatch.setattr(get_config(), "retention_days", 7)
    clock = {"now": NOW}
    monkeypatch.setattr(router_module, "_now", lambda: clock["now"])
    lender_policy.reset_cache()
    reference_data.reset_cache()
    yield table, s3, clock
    lender_policy.reset_cache()
    reference_data.reset_cache()


def make_client(admin: bool = True) -> TestClient:
    app = FastAPI()
    app.include_router(router_module.router)
    if admin:
        app.dependency_overrides[require_admin] = lambda: ADMIN
    return TestClient(app)


@pytest.fixture
def client():
    return make_client()


def real_bytes() -> bytes:
    return FIXTURE.read_bytes()


def post(client, data: bytes, *, filename="Policy.xlsx", preview=False, content_type=XLSX):
    params = {"filename": filename, "preview": str(preview).lower()}
    return client.post(
        "/eligibility/lender-policy", params=params, content=data, headers={"content-type": content_type}
    )


# ------------------------------------------------------------------ admin only
ROUTES = [
    ("get", "/eligibility/lender-policy"),
    ("post", "/eligibility/lender-policy"),
    ("get", "/eligibility/lender-policy/download"),
    ("delete", "/eligibility/lender-policy"),
    ("post", "/eligibility/lender-policy/company-list"),
    ("delete", "/eligibility/lender-policy/company-list"),
]


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_every_route_needs_a_signed_in_user(store, method, path):
    # No request context: no caller, so require_admin refuses before anything is read.
    response = getattr(make_client(admin=False), method)(path)
    assert response.status_code == 403
    assert store[0].items == {} and store[1].objects == {}


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_every_route_is_admin_only(store, method, path):
    app = FastAPI()
    app.include_router(router_module.router)
    handler = Caller(sub="h", username="rohan", groups=("handler",))
    app.dependency_overrides[router_module.require_admin] = lambda: require_admin(handler)
    response = getattr(TestClient(app), method)(path)
    assert response.status_code == 403
    assert response.json()["detail"] == "Only admins can do this"


# ------------------------------------------------------------------ preview / save / download
def test_preview_reads_the_real_sheet_and_saves_nothing(store, client):
    table, s3, _ = store
    response = post(client, real_bytes(), preview=True)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["preview"] is True and body["current"] is None
    assert [b["lender_id"] for b in body["banks"]] == [
        "hdfc_bank",
        "icici_bank",
        "axis_bank",
        "bandhan_bank",
        "indusind_bank",
    ]
    assert {b["lender_id"]: b["new"] for b in body["banks"]}["bandhan_bank"] is True
    assert {b["lender_id"]: b["new"] for b in body["banks"]}["hdfc_bank"] is False
    assert body["effective_date"] == "2026-07-01"
    assert [c["label"] for c in body["categories"]][:2] == ["CAT A+", "CAT A"]
    assert (
        "4 rows share slab 35,000 for HDFC Bank with different ROI; the first is used, please check" in body["warnings"]
    )
    hdfc = body["banks"][0]
    assert hdfc["slabs"][0]["values"]["roi"]["CAT_A+"] == {"value": 0.13, "cell": "C4"}
    assert hdfc["rules"]["plbt_max_loans"] == 3
    assert table.items == {} and s3.objects == {}


def test_save_keeps_the_original_bytes_and_the_parsed_policy(store, client):
    table, s3, _ = store
    data = real_bytes()
    response = post(client, data, filename="Policy.xlsx")
    assert response.status_code == 200, response.text
    current = response.json()["current"]
    assert current["filename"] == "Policy.xlsx"
    assert current["effective_date"] == "2026-07-01"
    assert current["reupload_by"] is None and current["expires_at"] is None
    assert current["size"] == len(data)
    header = table.items[("APP#LENDERPOLICY", "CURRENT")]
    assert "expires_at" not in header  # no TTL: kept until replaced
    upload_id = header["upload_id"]
    original = s3.objects[(BUCKET, f"lender-policy/{upload_id}/original.xlsx")]
    assert original["Body"] == data and original["ContentType"] == XLSX
    assert (BUCKET, f"lender-policy/{upload_id}/policy.json") in s3.objects
    # Nothing under projects/: an upload there would start document processing.
    assert all(k.startswith("lender-policy/") for k in s3.names())

    status = client.get("/eligibility/lender-policy").json()
    assert status["current"]["sha256"] == current["sha256"]
    assert status["retention_days"] == 7
    assert status["current"]["banks"][-1] == "Indusind Bank"


def test_download_gives_a_link_to_the_original(store, client):
    assert client.get("/eligibility/lender-policy/download").status_code == 404
    post(client, real_bytes(), filename='My "Policy".xlsx')
    body = client.get("/eligibility/lender-policy/download").json()
    upload_id = store[0].items[("APP#LENDERPOLICY", "CURRENT")]["upload_id"]
    assert f"lender-policy/{upload_id}/original.xlsx" in body["url"]
    assert 'filename="My _Policy_.xlsx"' in body["url"]
    assert body["filename"] == 'My "Policy".xlsx'


def test_a_new_upload_replaces_the_previous_one(store, client):
    _, s3, _ = store
    post(client, real_bytes())
    first = sorted(s3.names())
    small = workbook(sheet1=grid_rows(), sheet2=rules_rows())
    assert post(client, small, filename="small.xlsx").status_code == 200
    assert not set(first) & set(s3.names())
    assert len(s3.names()) == 2
    assert client.get("/eligibility/lender-policy").json()["current"]["filename"] == "small.xlsx"


def test_the_policy_is_kept_after_the_retention_period(store, client):
    # Lender terms, not client data: kept until a new upload replaces it (the 7-day rule is for client data).
    table, _, clock = store
    post(client, real_bytes())
    clock["now"] = NOW + dt.timedelta(days=60)
    lender_policy.reset_cache()
    current = client.get("/eligibility/lender-policy").json()["current"]
    assert current is not None and current["reupload_by"] is None
    assert lender_policy.load(clock["now"]) is not None
    assert client.get("/eligibility/lender-policy/download").status_code == 200


def test_delete(store, client):
    _, s3, _ = store
    post(client, real_bytes())
    assert client.delete("/eligibility/lender-policy").json() == {"deleted": True}
    assert s3.objects == {}
    assert client.get("/eligibility/lender-policy").json()["current"] is None
    assert client.delete("/eligibility/lender-policy").json() == {"deleted": False}


@pytest.mark.parametrize(
    ("filename", "content_type", "status", "words"),
    [
        ("Policy.xlsm", XLSX, 415, "Macro-enabled"),
        ("Policy.xls", XLSX, 415, "Only .xlsx"),
        ("Policy.csv", XLSX, 415, "Only .xlsx"),
        ("Policy.xlsx", "text/csv", 415, "Excel workbook"),
    ],
)
def test_only_xlsx_is_accepted(store, client, filename, content_type, status, words):
    response = post(client, real_bytes(), filename=filename, content_type=content_type)
    assert response.status_code == status
    assert words in response.json()["detail"]
    assert store[1].objects == {}


def test_a_file_that_is_not_a_workbook_is_refused(store, client):
    response = post(client, b"PK\x03\x04 not really a zip")
    assert response.status_code == 400
    assert response.json()["detail"].startswith("The workbook cannot be used")


def test_a_file_over_the_limit_is_refused(store, client):
    response = post(client, b"0" * (lender_policy.MAX_UPLOAD_BYTES + 1))
    assert response.status_code == 413


def test_multipart_upload(store, client):
    response = client.post(
        "/eligibility/lender-policy",
        params={"preview": "true"},
        files={"file": ("Policy.xlsx", real_bytes(), XLSX)},
    )
    assert response.status_code == 200, response.text
    assert response.json()["filename"] == "Policy.xlsx"


def test_storage_errors_are_502(store, client):
    store[0].fail = True
    assert post(client, real_bytes()).status_code == 502
    assert client.get("/eligibility/lender-policy").status_code == 502


# ------------------------------------------------------------------ app-wide company list
def test_the_app_wide_company_list_takes_the_sheets_banks_and_categories(store, client):
    post(client, real_bytes())
    data = csv_bytes(
        "lender,company,category",
        "Bandhan Bank,Sahyadri Synthetics Pvt Ltd,CAT_B",
        "HDFC Bank,Sahyadri Synthetics Pvt Ltd,CAT A+",
    )
    response = client.post(
        "/eligibility/lender-policy/company-list",
        params={"filename": "companies.csv"},
        content=data,
        headers={"content-type": "text/csv"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["rows"] == 2
    assert ("APP#REFDATA", "REFDATA#company_categories") in store[0].items
    status = client.get("/eligibility/lender-policy").json()
    assert status["company_list"]["filename"] == "companies.csv"
    # Without the sheet, Bandhan Bank is not a lender of the app.
    client.delete("/eligibility/lender-policy")
    refused = client.post("/eligibility/lender-policy/company-list", content=data, headers={"content-type": "text/csv"})
    assert refused.status_code == 400
    assert client.delete("/eligibility/lender-policy/company-list").json() == {"deleted": True}


# ------------------------------------------------------------------ applied to the calculation
def stored_policy(data: bytes | None = None) -> lender_policy.StoredPolicy:
    data = data or real_bytes()
    return lender_policy.StoredPolicy(
        upload_id="u1",
        filename="Policy.xlsx",
        uploaded_at=NOW.isoformat(),
        expires_at=int(NOW.timestamp()) + 7 * 86400,
        size=len(data),
        sha256="x",
        workbook=parse_policy_workbook(data, "Policy.xlsx"),
    )


def calculation_book(companies=None, data: bytes | None = None):
    lists = reference_data.CalculationLists(None, companies, None, stored_policy(data))
    return reference_data.CalculationBook(el.load_policy_book(), lists), lists


def at(result, lender_id):
    return next(r for r in result["per_lender"] if r["lender_id"] == lender_id)


def applicant(net=60000, emi=5000, company="Konkan Softworks Pvt Ltd", tenure=72):
    inputs = example(
        profile__net_income=net, profile__company=company, loan={"amount": 500000, "tenure_months": tenure}
    )
    inputs["cibil"]["tradelines"][0]["emi"] = emi
    return inputs


def expected(net, obligations, roi, foir, multiplier, funding, tenure, method="salary"):
    per_lakh = el.emi(100000, Decimal(str(roi)) * 100, tenure)
    by_foir = (Decimal(net) * Decimal(str(foir)) - obligations) / per_lakh * 100000
    base = Decimal(net) - obligations if method == "net_of_obligations" else Decimal(net)
    return min(by_foir, base * Decimal(str(multiplier)), Decimal(str(funding)))


def test_the_sheet_prices_its_banks_and_the_others_keep_the_sample(store):
    book, lists = calculation_book()
    result = el.calculate(applicant(), book=book)
    ids = [r["lender_id"] for r in result["per_lender"]]
    assert {"bandhan_bank", "indusind_bank"} <= set(ids)
    hdfc = at(result, "hdfc_bank")
    # Konkan Softworks is CAT A with HDFC Bank in the sample company list; 60,000 is in the 50,000 slab.
    sheet = hdfc["policy_sheet"]
    assert sheet["slab_start"] == 50000 and sheet["category"] == "CAT A" and sheet["category_code"] == "CAT_A"
    workbook_bank = stored_policy().workbook.bank("hdfc_bank")
    cells = workbook_bank.slab_for(60000).values
    roi, foir = cells["roi"]["CAT_A"].value, cells["foir"]["CAT_A"].value
    assert hdfc["roi"] == pytest.approx(roi * 100)
    assert hdfc["foir"] == pytest.approx(foir)
    assert hdfc["label"] == lender_policy.SOURCE_LABEL
    want = expected(
        60000,
        5000,
        roi,
        foir,
        cells["multiplier"]["CAT_A"].value,
        cells["max_funding"]["CAT_A"].value,
        int(cells["calculation_tenure_months"]["CAT_A"].value),
        workbook_bank.rules.multiplier_method,
    )
    assert hdfc["multiplier_method"] == workbook_bank.rules.multiplier_method
    assert Decimal(str(hdfc["computed_amount"])) == want.quantize(Decimal("0.01"))
    assert sheet["values"]["foir"]["text"].startswith("FOIR ")
    assert "(Sheet1, HDFC Bank, slab 50,000, CAT_A, cell " in sheet["values"]["foir"]["text"]
    # Not in the sheet: the sample policy, with its sample label.
    bajaj = at(result, "bajaj_finance")
    assert bajaj["policy_sheet"] is None and bajaj["label"] == el.SAMPLE_LABEL
    assert any(n.startswith("Policy of ") and ": From Policy (your sheet) (Policy.xlsx" in n for n in lists.notes())


def test_a_company_not_in_the_list_is_cat_u(store):
    book, _ = calculation_book()
    result = el.calculate(applicant(company="Unheard Of Traders Pvt Ltd"), book=book)
    bandhan = at(result, "bandhan_bank")
    assert bandhan["policy_sheet"]["category"] == "CAT U"
    assert any(
        "CAT_U: 'Unheard Of Traders Pvt Ltd' is not in Bandhan Bank's company list" in n for n in bandhan["notes"]
    )
    assert bandhan["company_policy"] == "unlisted"


def test_income_below_the_first_slab_is_not_eligible(store):
    book, _ = calculation_book()
    result = el.calculate(applicant(net=20000, emi=0), book=book)
    hdfc = at(result, "hdfc_bank")
    assert hdfc["status"] == "not_eligible"
    assert (
        "Not eligible: income ₹20,000 is below HDFC Bank's minimum ₹25,000 (From Policy (your sheet))"
        in hdfc["reasons"]
    )


def test_the_uploaded_company_list_sets_the_sheet_category(store):
    rows = [["bandhan_bank", "Konkan Softworks Pvt Ltd", "CAT B"]]
    companies = reference_data.StoredList(
        kind="company_categories",
        upload_id="c1",
        filename="companies.csv",
        uploaded_at=NOW.isoformat(),
        expires_at=int(NOW.timestamp()) + 86400,
        rows=rows,
        lenders=["Bandhan Bank"],
    )
    book, _ = calculation_book(companies)
    bandhan = at(el.calculate(applicant(), book=book), "bandhan_bank")
    assert bandhan["policy_sheet"]["category"] == "CAT B"
    assert bandhan["company_policy"] == "category"


def test_a_bank_only_the_sheet_has_is_not_refused_for_serviceability(store):
    book, _ = calculation_book()
    indusind = at(el.calculate(applicant(), book=book), "indusind_bank")
    assert indusind["serviceable"] is None
    assert indusind["status"] != "not_serviceable"
    assert "No pincode list covers Indusind Bank: serviceability not checked" in indusind["notes"]


def test_the_calculation_lists_load_the_stored_policy(store, client):
    post(client, real_bytes())
    lists = reference_data.calculation_lists("proj_x", NOW)
    assert lists is not None and set(lists.sheet_policies()) == {
        "hdfc_bank",
        "icici_bank",
        "axis_bank",
        "bandhan_bank",
        "indusind_bank",
    }
    # Read back from S3 (not the cache) gives the same policies.
    lender_policy.reset_cache()
    again = reference_data.calculation_lists("proj_x", NOW)
    assert again.sheet_policies()["hdfc_bank"] == lists.sheet_policies()["hdfc_bank"]
    # Past expiry: the sample policies apply again.
    kept = reference_data.calculation_lists("proj_x", NOW + dt.timedelta(days=8))
    assert kept is not None and "hdfc_bank" in kept.sheet_policies()  # the sheet stays until replaced


def test_lender_policies_of_a_synthetic_sheet(store):
    data = workbook(sheet1=grid_rows(banks=(("HDFC Bank", (25000, 50000)),)), sheet2=rules_rows())
    policies, problems = lender_policy.lender_policies(parse_policy_workbook(data), el.load_policy_book())
    assert problems == []
    hdfc = policies["hdfc_bank"]
    assert hdfc.sheet.slab_starts == (25000, 50000)
    # This sheet has no CAT_U column: a company not in the bank's list is not priced.
    assert hdfc.sheet.unlisted_category is None and hdfc.unlisted_company.accepted is False
    # Kept from the sample policy: what the sheet does not give.
    sample = el.load_policy_book().lender("hdfc_bank")
    assert hdfc.min_cibil_score == sample.min_cibil_score
    assert hdfc.max_enquiries_90d == sample.max_enquiries_90d


# ------------------------------------------------------------------ through the eligibility API
def test_the_eligibility_api_uses_the_stored_policy(monkeypatch):
    from tests import test_eligibility_api as api

    table = api.FakeTable([api.META])
    for target in ("app.routers.eligibility.get_table", "app.reference_data.get_table", "app.lender_policy.get_table"):
        monkeypatch.setattr(target, lambda: table)
    monkeypatch.setattr("app.ddb.projects.get_table", lambda: table, raising=False)
    stored = stored_policy()
    monkeypatch.setattr(lender_policy, "load", lambda now: stored)
    reference_data.reset_cache()

    result = api.calculate(inputs=api.example())
    assert result.status_code == 200, result.text
    rows = {r["lender_id"]: r for r in result.json()["per_lender"]}
    assert {"bandhan_bank", "indusind_bank"} <= set(rows)
    assert rows["hdfc_bank"]["label"] == lender_policy.SOURCE_LABEL
    assert rows["hdfc_bank"]["policy_sheet"]["bank"] == "HDFC Bank"
    assert rows["tata_capital"]["policy_sheet"] is None

    lenders = api.client.get(f"{api.BASE}/lenders", headers=api.HEADERS)
    assert lenders.status_code == 200, lenders.text
    shown = {lender["id"]: lender for lender in lenders.json()["lenders"]}
    assert shown["bandhan_bank"]["label"] == lender_policy.SOURCE_LABEL
    assert "CAT A+" in shown["hdfc_bank"]["company_categories"]


def test_a_policy_without_ttl_is_kept_until_replaced():
    now = dt.datetime(2027, 1, 1, tzinfo=dt.UTC)
    assert not lender_policy._ttl_passed({"upload_id": "u1"}, now)
    assert lender_policy._ttl_passed({"upload_id": "u1", "expires_at": Decimal(int(now.timestamp()) - 1)}, now)
    assert not lender_policy._ttl_passed({"upload_id": "u1", "expires_at": Decimal(int(now.timestamp()) + 1)}, now)


# ------------------------------------------------------------------ the corrected sheet: NA = not offered
def v2_bytes() -> bytes:
    return (Path(__file__).parent / "fixtures" / "policy_workbook_v2.xlsx").read_bytes()


def test_a_category_the_bank_does_not_lend_to_is_not_eligible(store):
    book, _ = calculation_book(data=v2_bytes())
    result = el.calculate(applicant(company="Unheard Of Traders Pvt Ltd"), book=book)
    for lender_id, bank in (("hdfc_bank", "HDFC Bank"), ("bandhan_bank", "Bandhan Bank")):
        row = at(result, lender_id)
        assert row["status"] == "not_eligible"
        assert row["reasons"][0].startswith(f"{bank} does not lend to CAT U (unlisted) companies (Sheet1, slab 60,000")
        assert row["not_offered"] == {
            "bank": bank,
            "category": "CAT U",
            "category_code": "CAT_U",
            "slab_start": 60000,
        }
        assert row["policy_sheet"] is None
        assert row["eligible_amount"] == 0 and row["emi"] == 0
        assert row["foir_eligibility"] is None and row["computed_amount"] is None
        declined = next(d for d in result["suggestion"]["declined"] if d["lender_id"] == lender_id)
        assert declined["reason"].startswith(f"{bank} does not lend to CAT U (unlisted) companies")
    hdfc = at(result, "hdfc_bank")
    assert "cell I8" in hdfc["reasons"][0]  # ROI CAT_U of HDFC's 60,000 row
    # The banks whose sheet prices CAT U still do.
    icici = at(result, "icici_bank")
    assert icici["not_offered"] is None and icici["policy_sheet"]["category"] == "CAT U"


def test_a_listed_category_is_priced_as_before_on_the_corrected_sheet(store):
    book, _ = calculation_book(data=v2_bytes())
    result = el.calculate(applicant(), book=book)
    hdfc = at(result, "hdfc_bank")  # Konkan Softworks is CAT A with HDFC Bank
    assert hdfc["not_offered"] is None and hdfc["policy_sheet"]["slab_start"] == 60000
    assert hdfc["status"] == "eligible"
    # Bandhan Bank's company list does not have it: CAT U, which Bandhan Bank does not lend to.
    assert at(result, "bandhan_bank")["not_offered"]["category_code"] == "CAT_U"


# ------------------------------------------------------------------ the HL deviation: a running home loan
V2_BANKS = ("hdfc_bank", "icici_bank", "axis_bank", "bandhan_bank", "indusind_bank")
CAT_B_COMPANY = "Synthetic Cat B Works Pvt Ltd"


def cat_b_book():
    """The corrected sheet with a company list making CAT_B_COMPANY CAT B at every bank."""
    rows = [[lender_id, CAT_B_COMPANY, "CAT B"] for lender_id in V2_BANKS]
    companies = reference_data.StoredList(
        kind="company_categories",
        upload_id="c1",
        filename="companies.csv",
        uploaded_at=NOW.isoformat(),
        expires_at=int(NOW.timestamp()) + 86400,
        rows=rows,
        lenders=["HDFC Bank", "ICICI Bank", "Axis Bank", "Bandhan Bank", "Indusind Bank"],
    )
    return calculation_book(companies, data=v2_bytes())[0]


def home_loan_applicant(running=None, tradeline=None):
    inputs = applicant(net=60000, emi=5000, company=CAT_B_COMPANY)
    if running is not None:
        inputs["profile"]["has_running_home_loan"] = running
    if tradeline is not None:
        inputs["cibil"]["tradelines"].append(tradeline)
    return inputs


def foir_eligibility(row, foir):
    per_lakh = Decimal(str(row["per_lakh_emi"]))
    obligations = Decimal(str(row["obligations"]))
    want = (Decimal(str(row["income_considered"])) * Decimal(str(foir)) - obligations) / per_lakh * 100000
    return pytest.approx(float(want), abs=1)


def test_a_running_home_loan_raises_the_foir_by_the_hl_deviation(store):
    book = cat_b_book()
    without = {r["lender_id"]: r for r in el.calculate(home_loan_applicant(), book=book)["per_lender"]}
    result = el.calculate(home_loan_applicant(running=True), book=book)
    assert result["home_loan"] == {"running": True, "source": "entered", "loans": []}
    raised = {r["lender_id"]: r for r in result["per_lender"]}
    for lender_id in ("hdfc_bank", "icici_bank", "indusind_bank"):  # HL Deviation 0.05
        before, after = without[lender_id], raised[lender_id]
        assert before["foir"] == pytest.approx(0.6) and after["foir"] == pytest.approx(0.65)
        assert before["foir_eligibility"] == foir_eligibility(before, 0.6)
        assert after["foir_eligibility"] == foir_eligibility(after, 0.65)
        # +5 points of 60,000 = 3,000 more a month for EMIs.
        gain = Decimal(str(after["foir_eligibility"])) - Decimal(str(before["foir_eligibility"]))
        assert float(gain) == pytest.approx(3000 / after["per_lakh_emi"] * 100000, abs=1)
        assert after["policy_sheet"]["hl_deviation_applied"] is True
        assert before["policy_sheet"]["hl_deviation_applied"] is False
    hdfc = raised["hdfc_bank"]["policy_sheet"]["lines"]
    assert "FOIR 60% + 5% home-loan deviation = 65% (HDFC Bank, Sheet2, cell U2)" in hdfc
    assert not any("only with a running home loan" in line for line in hdfc)
    assert any(
        "only with a running home loan (none here)" in line for line in without["hdfc_bank"]["policy_sheet"]["lines"]
    )
    for lender_id in ("axis_bank", "bandhan_bank"):  # HL Deviation NA: unchanged
        assert raised[lender_id]["foir"] == without[lender_id]["foir"] == pytest.approx(0.6)
        assert raised[lender_id]["foir_eligibility"] == without[lender_id]["foir_eligibility"]
        assert raised[lender_id]["policy_sheet"]["hl_deviation_applied"] is False
        assert any(
            line.startswith("Running home loan: no HL deviation for ") and "FOIR stays 60%" in line
            for line in raised[lender_id]["policy_sheet"]["lines"]
        )


HOME_LOAN = {
    "loan_type": "home",
    "lender": "Synthetic Housing Finance",
    "outstanding": 2500000,
    "emi": 0,
    "status": "active",
    "action": "obligate",
}


def test_a_home_loan_in_the_obligations_is_found(store):
    book = cat_b_book()
    result = el.calculate(home_loan_applicant(tradeline=HOME_LOAN), book=book)
    assert result["home_loan"]["running"] is True and result["home_loan"]["source"] == "obligations"
    assert result["home_loan"]["loans"] == ["Tradeline 2 (Synthetic Housing Finance, Home Loan)"]
    assert at(result, "hdfc_bank")["foir"] == pytest.approx(0.65)
    assert any(n.startswith("Running home loan found in the obligations") for n in result["notes"])
    # Closed, taken over (BT) or closed before disbursal: not running.
    for change in ({"status": "closed"}, {"action": "close"}, {"action": "bt"}):
        ended = el.calculate(home_loan_applicant(tradeline={**HOME_LOAN, **change}), book=book)
        assert ended["home_loan"]["running"] is False, change
        assert at(ended, "hdfc_bank")["foir"] == pytest.approx(0.6)


def test_the_entered_answer_overrides_the_obligations(store):
    book = cat_b_book()
    result = el.calculate(home_loan_applicant(running=False, tradeline=HOME_LOAN), book=book)
    assert result["home_loan"] == {
        "running": False,
        "source": "entered",
        "loans": ["Tradeline 2 (Synthetic Housing Finance, Home Loan)"],
    }
    assert at(result, "hdfc_bank")["foir"] == pytest.approx(0.6)
    assert any(n.startswith("Running home loan set to No") for n in result["notes"])


def test_the_raised_foir_is_capped_at_100_percent(store):
    rule = ["HDFC Bank", 0.05, "Salary * Multiplier", "NA", 3, "NA", "NA", "NA", "Monthly", 0.5, "Listed Company"]
    sheet1 = grid_rows(banks=(("HDFC Bank", (25000, 50000)),), overrides={(4, "E"): 0.98, (5, "E"): 0.98})
    data = workbook(sheet1=sheet1, sheet2=rules_rows(rule))
    lists = reference_data.CalculationLists(None, None, None, stored_policy(data))
    book = reference_data.CalculationBook(el.load_policy_book(), lists)
    hdfc = at(el.calculate(applicant(net=60000, emi=0, tenure=48), book=book), "hdfc_bank")
    assert hdfc["foir"] == pytest.approx(0.98)
    inputs = applicant(net=60000, emi=0, tenure=48)
    inputs["profile"]["has_running_home_loan"] = True
    hdfc = at(el.calculate(inputs, book=book), "hdfc_bank")
    assert hdfc["foir"] == pytest.approx(1.0)
    assert (
        "FOIR 98% + 5% home-loan deviation = 100% (capped at 100%) (HDFC Bank, Sheet2, cell C3)"
        in (hdfc["policy_sheet"]["lines"])
    )


def test_lenders_without_a_sheet_ignore_the_home_loan(store):
    book = cat_b_book()
    before = at(el.calculate(home_loan_applicant(), book=book), "bajaj_finance")
    after = at(el.calculate(home_loan_applicant(running=True), book=book), "bajaj_finance")
    assert before["policy_sheet"] is None and after["foir"] == before["foir"]
