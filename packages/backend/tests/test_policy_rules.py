"""The policy workbook's per-bank rules (Sheet2) in the engine, on the real sheet (the fixture copy):
the multiplier method, bonus, incentive, rental income, co-applicant salary, gold loan, BT limits,
HL deviation and the "How it is calculated" lines. Synthetic applicants only."""

from decimal import Decimal

import pytest

from app import eligibility as el
from tests.test_eligibility_engine import tradeline
from tests.test_lender_policy import applicant, at, calculation_book, store  # noqa: F401 (fixture)

pytestmark = pytest.mark.usefixtures("store")


def run(inputs):
    book, _ = calculation_book()
    return el.calculate(inputs, book=book)


def with_others(*others, **kw):
    inputs = applicant(**kw)
    inputs["profile"]["other_income"] = list(others)
    return inputs


def considered(result, lender_id, kind):
    return next(o["considered"] for o in at(result, lender_id)["other_income_considered"] if o["type"] == kind)


def every_text(row):
    return " | ".join(row["notes"] + row["reasons"] + row["policy_sheet"]["lines"])


class TestMultiplierMethod:
    def test_hdfc_nets_obligations_icici_does_not(self):
        result = run(applicant(net=60000, emi=5000))
        hdfc, icici = at(result, "hdfc_bank"), at(result, "icici_bank")
        assert hdfc["multiplier_method"] == "net_of_obligations"
        assert icici["multiplier_method"] == "salary"
        assert Decimal(str(hdfc["multiplier_eligibility"])) == Decimal(55000) * Decimal(str(hdfc["multiplier"]))
        assert Decimal(str(icici["multiplier_eligibility"])) == Decimal(60000) * Decimal(str(icici["multiplier"]))
        assert any("(income − obligations) × multiplier" in line for line in hdfc["policy_sheet"]["lines"])


class TestIncomeExtras:
    def test_bonus_per_bank_formula(self):
        result = run(with_others({"type": "bonus", "frequency": "yearly", "amount": 120000}))
        # 10,000 a month: HDFC 2 years x 70% / 24 = 70%; ICICI 1 x 70% / 12 = 70%; Axis 1 x 70% / 24 = 35%.
        assert considered(result, "hdfc_bank", "bonus") == pytest.approx(7000)
        assert considered(result, "icici_bank", "bonus") == pytest.approx(7000)
        assert considered(result, "axis_bank", "bonus") == pytest.approx(3500)
        assert considered(result, "bandhan_bank", "bonus") == 0
        assert "Bandhan Bank counts no bonus" in every_text(at(result, "bandhan_bank"))
        assert "Bonus Calculation" in every_text(at(result, "hdfc_bank"))

    def test_incentive_only_for_accepted_frequencies(self):
        result = run(with_others({"type": "incentive", "frequency": "monthly", "amount": 4000}))
        assert considered(result, "hdfc_bank", "incentive") == pytest.approx(4000)
        assert considered(result, "icici_bank", "incentive") == 0
        assert "counts quarterly incentive only" in every_text(at(result, "icici_bank"))
        quarterly = run(with_others({"type": "incentive", "frequency": "quarterly", "amount": 12000}))
        assert considered(quarterly, "icici_bank", "incentive") == pytest.approx(4000)

    def test_rental_share_or_none(self):
        result = run(with_others({"type": "rented", "frequency": "monthly", "amount": 10000}))
        assert considered(result, "hdfc_bank", "rented") == pytest.approx(5000)
        assert considered(result, "icici_bank", "rented") == pytest.approx(4000)
        assert considered(result, "indusind_bank", "rented") == pytest.approx(6000)
        assert considered(result, "axis_bank", "rented") == 0
        assert "Axis Bank counts no rental income" in every_text(at(result, "axis_bank"))


class TestCoApplicant:
    def co(self, **fields):
        inputs = applicant()
        inputs["co_applicant"] = {"net_income": 30000, **fields}
        return run(inputs)

    def test_all_companies_rule(self):
        result = self.co(employment_type="private_limited")
        assert considered(result, "icici_bank", "co_applicant") == pytest.approx(30000)
        partnership = self.co(employment_type="partnership_proprietorship")
        assert considered(partnership, "icici_bank", "co_applicant") == 0
        assert "does not add it for a proprietorship or partnership" in every_text(at(partnership, "icici_bank"))

    def test_listed_company_rule(self):
        listed = self.co(company="Konkan Softworks Pvt Ltd", employment_type="private_limited")
        assert considered(listed, "hdfc_bank", "co_applicant") == pytest.approx(30000)
        unlisted = self.co(company="Unheard Of Traders Pvt Ltd", employment_type="private_limited")
        assert considered(unlisted, "hdfc_bank", "co_applicant") == 0
        assert "is not in HDFC Bank's company list" in every_text(at(unlisted, "hdfc_bank"))

    def test_raises_income_considered(self):
        base = at(run(applicant()), "icici_bank")["income_considered"]
        assert at(self.co(employment_type="government"), "icici_bank")["income_considered"] == base + 30000


class TestObligations:
    def test_gold_loan_one_percent_where_given(self):
        inputs = applicant(emi=5000)
        inputs["cibil"]["tradelines"].append(tradeline(loan_type="gold", outstanding=200000, emi=3000))
        result = run(inputs)
        assert at(result, "hdfc_bank")["obligations"] == pytest.approx(7000)  # 5,000 + 1% of 2,00,000
        assert at(result, "indusind_bank")["obligations"] == pytest.approx(7000)
        axis = at(result, "axis_bank")
        assert axis["obligations"] == pytest.approx(8000)  # its EMI
        assert "gold loan: bank rule not given" in every_text(axis)

    def test_bt_limits(self):
        inputs = applicant()
        inputs["cibil"]["tradelines"] = [
            tradeline(action="bt", outstanding=20000, emi=1000, lender=f"Lender {i}") for i in range(3)
        ]
        result = run(inputs)
        assert "Indusind Bank takes over at most 2 personal loans" in every_text(at(result, "indusind_bank"))
        assert not any("takes over at most" in r for r in at(result, "hdfc_bank")["reasons"])

    def test_credit_card_bt_only_axis(self):
        inputs = applicant()
        inputs["cibil"]["tradelines"].append(
            tradeline(loan_type="credit_card", action="bt", outstanding=20000, emi=1000)
        )
        result = run(inputs)
        assert any("does not take over credit cards" in r for r in at(result, "hdfc_bank")["reasons"])
        assert not any("credit card" in r for r in at(result, "axis_bank")["reasons"])
        assert "within Axis Bank's limit of 5 credit cards" in every_text(at(result, "axis_bank"))


class TestDetails:
    def test_lines_cite_cells_and_label_samples(self):
        hdfc = at(run(applicant()), "hdfc_bank")
        lines = hdfc["policy_sheet"]["lines"]
        assert lines[0].startswith("Net salary ₹60,000") and "CAT A (CAT_A)" in lines[0]
        assert any(
            line.startswith("FOIR ") and "(Sheet1, HDFC Bank, slab 50,000, CAT_A, cell " in line for line in lines
        )
        assert any(line.startswith("Minimum CIBIL score") and el.NOT_IN_SHEET_LABEL in line for line in lines)
        assert any(
            line.startswith("HL deviation 5% (Sheet2, HDFC Bank, HL Deviation")
            and line.endswith("raises the FOIR only with a running home loan (none here)")
            for line in lines
        )
        assert hdfc["policy_sheet"]["hl_deviation"] == pytest.approx(0.05)

    def test_hl_deviation_does_not_change_the_result_without_a_home_loan(self):
        book, _ = calculation_book()
        hdfc = book.lender("hdfc_bank")
        import dataclasses

        no_hl = dataclasses.replace(hdfc.sheet, rules=dataclasses.replace(hdfc.sheet.rules, hl_deviation=None))
        changed = el.SheetBook(book, {"hdfc_bank": dataclasses.replace(hdfc, sheet=no_hl)})
        a = at(el.calculate(applicant(), book=book), "hdfc_bank")
        b = at(el.calculate(applicant(), book=changed), "hdfc_bank")
        assert a["eligible_amount"] == b["eligible_amount"] and a["emi"] == b["emi"]

    def test_requested_tenure_is_not_the_calculation_tenure(self):
        hdfc = at(run(applicant(tenure=24)), "hdfc_bank")
        assert any("not at the requested 24" in n for n in hdfc["notes"])
