"""The "Suggested banks" box (calculate()["suggestion"]): the eligible banks ranked as the best lender
is picked, and the banks that say no with one line each. Synthetic applicants; the real policy sheet
is the fixture copy."""

import gzip
import json
from decimal import Decimal

import pytest

from app import eligibility as el
from app import lender_policy
from app.policy_workbook import parse_policy_workbook
from tests.test_lender_policy import NOW, applicant, at, calculation_book, real_bytes, store  # noqa: F401


def row(lender_id, *, status="eligible", amount=0.0, roi=10.0, emi=1000.0, reasons=(), sheet=None):
    return {
        "lender": lender_id.replace("_", " ").title(),
        "lender_id": lender_id,
        "status": status,
        "status_label": status,
        "reasons": list(reasons),
        "eligible_amount": amount,
        "roi": roi,
        "emi": emi,
        "tenure_months": 60,
        "label": None,
        "policy_sheet": sheet,
    }


def suggest(rows, amount=None, bt=0):
    return el._suggestion(rows, {"amount": amount}, Decimal(bt))


class TestRanking:
    def test_covering_banks_by_lowest_roi_then_the_rest_by_amount(self):
        rows = [
            row("a", amount=600000, roi=12),
            row("b", amount=900000, roi=11),
            row("c", amount=400000, roi=9),
            row("d", amount=450000, roi=10),
        ]
        s = suggest(rows, amount=500000)
        assert [b["lender_id"] for b in s["banks"]] == ["b", "a", "d", "c"]
        assert [b["covers_need"] for b in s["banks"]] == [True, True, False, False]
        assert s["banks"][0]["why"] == "Lowest ROI (11%) that covers ₹5,00,000"
        assert s["banks"][1]["why"] == "Covers ₹5,00,000 at 12%"
        assert s["banks"][2]["why"] == "Up to ₹4,50,000: less than the ₹5,00,000 needed"
        assert s["need"] == 500000

    def test_none_covers_highest_amount_first(self):
        s = suggest([row("a", amount=200000, roi=9), row("b", amount=300000, roi=14)], amount=1000000)
        assert [b["lender_id"] for b in s["banks"]] == ["b", "a"]
        assert not any(b["covers_need"] for b in s["banks"])

    def test_no_amount_requested_highest_amount_first(self):
        s = suggest([row("a", amount=200000, roi=9), row("b", amount=300000, roi=14)])
        assert [b["lender_id"] for b in s["banks"]] == ["b", "a"]
        assert s["banks"][0]["why"] == "Highest eligible amount, at 14%"
        assert s["need"] is None

    def test_the_bt_amount_is_the_need_when_larger(self):
        s = suggest([row("a", amount=300000, roi=9), row("b", amount=700000, roi=14)], amount=100000, bt=600000)
        assert [b["lender_id"] for b in s["banks"]] == ["b", "a"]
        assert s["need"] == 600000

    @pytest.mark.parametrize("amount", [None, 500000, 5000000])
    def test_the_first_bank_is_the_best_lender(self, amount):
        rows = [row("a", amount=600000, roi=12), row("b", amount=900000, roi=11), row("c", amount=400000, roi=9)]
        best, _ = el._best_lender(rows, {"amount": amount}, Decimal(0))
        assert suggest(rows, amount=amount)["banks"][0]["lender_id"] == best["lender_id"]


class TestDeclined:
    def test_one_line_reason_with_a_count_of_the_others(self):
        rows = [
            row("a", status="not_eligible", reasons=["Not eligible: income ₹20,000 is below A's minimum ₹25,000"]),
            row("b", status="not_eligible", reasons=["CIBIL 640 is below 700", "Too many enquiries"]),
            row("c", status="not_serviceable", reasons=["Pincode 400001 is not serviceable by C"]),
        ]
        declined = {d["lender_id"]: d for d in suggest(rows)["declined"]}
        assert declined["a"]["reason"] == "income ₹20,000 is below A's minimum ₹25,000"
        assert declined["b"]["reason"] == "CIBIL 640 is below 700 (+1 more in Details)"
        assert declined["c"]["status"] == "not_serviceable"

    def test_an_unlisted_company_is_named(self):
        sheet = {"company_unlisted": True, "category_code": "CAT_U"}
        rows = [row("axis_bank", status="not_eligible", reasons=["Eligible amount ₹10,000 is below"], sheet=sheet)]
        assert suggest(rows)["declined"][0]["reason"].startswith("CAT_U: company not in Axis Bank's list; ")

    def test_an_eligible_bank_with_nothing_to_lend_is_declined(self):
        s = suggest([row("a", amount=0)])
        assert s["banks"] == [] and s["declined"][0]["lender_id"] == "a"


@pytest.mark.usefixtures("store")
class TestWithThePolicySheet:
    def run(self, **kw):
        book, _ = calculation_book()
        return el.calculate(applicant(**kw), book=book)

    def test_every_lender_is_suggested_or_declined_and_the_first_is_best(self):
        result = self.run()
        s = result["suggestion"]
        ids = [b["lender_id"] for b in s["banks"]] + [d["lender_id"] for d in s["declined"]]
        assert sorted(ids) == sorted(r["lender_id"] for r in result["per_lender"])
        assert s["banks"] and s["banks"][0]["lender"] == result["best_lender"]
        for bank in s["banks"]:
            r = at(result, bank["lender_id"])
            assert (bank["eligible_amount"], bank["roi"], bank["emi"]) == (r["eligible_amount"], r["roi"], r["emi"])
            assert bank["tenure_months"] == r["tenure_months"]

    def test_income_below_every_slab(self):
        s = self.run(net=20000, emi=0)["suggestion"]
        reasons = {d["lender_id"]: d["reason"] for d in s["declined"]}
        assert reasons["hdfc_bank"].startswith("income ₹20,000 is below HDFC Bank's minimum ₹25,000")

    def test_an_unlisted_company_is_cat_u_and_flagged(self):
        result = self.run(company="Nowhere Listed Traders")
        sheet = at(result, "axis_bank")["policy_sheet"]
        assert sheet["company_unlisted"] is True and sheet["category_code"] == "CAT_U"


def test_the_header_carries_the_parsed_policy_for_the_chat(store):  # noqa: F811 (the fixture)
    table, _, _ = store
    data = real_bytes()
    workbook = parse_policy_workbook(data, "Policy.xlsx")
    lender_policy.save(data, "Policy.xlsx", workbook, NOW)
    item = table.get_item(Key=lender_policy.HEADER_KEY)["Item"]
    packed = item[lender_policy.HEADER_POLICY_ATTRIBUTE]
    assert len(packed) < lender_policy.MAX_HEADER_POLICY_BYTES
    assert json.loads(gzip.decompress(packed)) == json.loads(json.dumps(workbook.to_json()))
