"""Tests for the lender policy workbook parser (app/policy_workbook.py).

The fixture tests/fixtures/policy_workbook.xlsx is the client's Policy.xlsx with the author fields
in docProps blanked: it holds policy numbers only. The other workbooks are built here, by hand.
"""

import io
import json
import zipfile
from pathlib import Path

import pytest

from app.policy_workbook import (
    MAX_FILE_BYTES,
    PolicyWorkbook,
    PolicyWorkbookError,
    category_text,
    grouped,
    lender_id_for,
    parse_policy_workbook,
)

FIXTURE = Path(__file__).parent / "fixtures" / "policy_workbook.xlsx"


@pytest.fixture(scope="module")
def real():
    return parse_policy_workbook(FIXTURE.read_bytes(), "Policy.xlsx")


# ------------------------------------------------------------------ the real sheet
def test_real_banks_and_ids(real):
    assert [(b.lender_id, b.name) for b in real.banks] == [
        ("hdfc_bank", "HDFC Bank"),
        ("icici_bank", "ICICI Bank"),
        ("axis_bank", "Axis Bank"),
        ("bandhan_bank", "Bandhan Bank"),
        ("indusind_bank", "Indusind Bank"),
    ]
    for bank in real.banks:
        assert [s.start for s in bank.slabs] == [25000, 35000, 50000, 80000]
        assert bank.min_income == 25000


def test_real_categories_keep_the_clients_labels(real):
    assert [c.code for c in real.categories] == ["CAT_A+", "CAT_A", "CAT_B", "CAT_C", "CAT_D", "CAT_G", "CAT_U"]
    assert [c.label for c in real.categories] == ["CAT A+", "CAT A", "CAT B", "CAT C", "CAT D", "CAT G", "CAT U"]
    assert real.category_code("CAT A+") == "CAT_A+"
    assert real.category_code("cat b") == "CAT_B"
    assert real.category_code("CAT_U") == "CAT_U"
    assert real.category_code("Super CAT A") is None


def test_real_values_and_cells(real):
    hdfc = real.bank("hdfc_bank")
    first = hdfc.slabs[0]
    assert first.values["roi"]["CAT_A+"].value == 0.13
    assert (first.values["roi"]["CAT_U"].value, first.values["roi"]["CAT_U"].cell) == (0.16, "I4")
    # HDFC's CAT_A FOIR at the 25,000 slab is the formula =J4-5%.
    assert (first.values["foir"]["CAT_A"].value, first.values["foir"]["CAT_A"].cell) == (0.45, "K4")
    assert first.values["foir"]["CAT_B"].value == 0.5
    assert first.values["multiplier"]["CAT_B"].value == 20
    assert first.values["max_funding"]["CAT_B"].value == 10_000_000
    assert first.values["max_tenure_months"]["CAT_B"].value == 84
    assert first.values["calculation_tenure_months"]["CAT_B"].value == 72
    # The first of the four 35,000 rows (row 5) is used.
    slab = hdfc.slab_for(40000)
    assert (slab.start, slab.row, slab.values["roi"]["CAT_A+"].value) == (35000, 5, 0.125)
    assert slab.values["roi"]["CAT_B"].value == 0.135
    bandhan = real.bank("bandhan_bank").slabs[-1]
    assert bandhan.values["max_funding"]["CAT_C"].value == 2_500_000
    assert bandhan.values["max_tenure_months"]["CAT_C"].value == 60
    assert bandhan.values["calculation_tenure_months"]["CAT_C"].value == 60
    assert real.bank("axis_bank").slabs[2].values["roi"]["CAT_B"].value == 0.12


def test_real_slab_lookup(real):
    axis = real.bank("axis_bank")
    assert axis.slab_for(24999) is None
    assert axis.slab_for(25000).start == 25000
    assert axis.slab_for(60000).start == 50000
    assert axis.slab_for(1_000_000).start == 80000


def test_real_warnings(real):
    assert "4 rows share slab 35,000 for HDFC Bank with different ROI; the first is used, please check" in real.warnings
    for name in ("ICICI Bank", "Axis Bank", "Bandhan Bank", "Indusind Bank"):
        assert f"4 rows share slab 35,000 for {name} with the same values; one is used" in real.warnings
    assert len(real.warnings) == 5
    assert sum("'Quartery' is read as Quarterly" in n for n in real.notes) == 3


def test_real_effective_date(real):
    assert (real.effective_date, real.effective_date_cell) == ("2026-07-01", "Sheet2!SGQ1")


def test_real_sheet2_rules(real):
    def rules(lender_id):
        return real.bank(lender_id).rules

    hdfc, icici, axis, bandhan, indus = (
        rules(i) for i in ("hdfc_bank", "icici_bank", "axis_bank", "bandhan_bank", "indusind_bank")
    )
    assert [r.multiplier_method for r in (hdfc, icici, axis, bandhan, indus)] == [
        "net_of_obligations",
        "salary",
        "salary",
        "salary",
        "net_of_obligations",
    ]
    assert [r.hl_deviation for r in (hdfc, icici, axis, bandhan, indus)] == [0.05, 0.05, None, None, 0.05]
    assert [r.ccbt_max_cards for r in (hdfc, icici, axis, bandhan, indus)] == [0, 0, 5, 0, 0]
    assert [r.plbt_max_loans for r in (hdfc, icici, axis, bandhan, indus)] == [3, 3, 4, 3, 2]
    assert [r.app_bt for r in (hdfc, icici, axis, bandhan, indus)] == [None] * 5
    assert [r.gold_loan_monthly_pct for r in (hdfc, icici, axis, bandhan, indus)] == [0.01, 0.01, None, None, 0.01]
    assert (hdfc.bonus.years, hdfc.bonus.share, hdfc.bonus.divisor) == (2, 0.7, 24)
    assert (icici.bonus.years, icici.bonus.divisor) == (1, 12)
    assert (axis.bonus.years, axis.bonus.divisor) == (1, 24)
    assert bandhan.bonus is None and indus.bonus is None
    assert hdfc.incentive_frequencies == ["monthly", "quarterly", "half_yearly", "yearly"]
    assert bandhan.incentive_frequencies == ["monthly", "quarterly", "half_yearly", "yearly"]
    assert icici.incentive_frequencies == axis.incentive_frequencies == indus.incentive_frequencies == ["quarterly"]
    assert [r.rental_income_share for r in (hdfc, icici, axis, bandhan, indus)] == [0.5, 0.4, None, 0.55, 0.6]
    assert [r.co_applicant_rule for r in (hdfc, icici, axis, bandhan, indus)] == [
        "listed_company",
        "all_except_proprietorship_partnership",
        "listed_company",
        "listed_company",
        "all_except_proprietorship_partnership",
    ]
    assert hdfc.raw["Bonus Calculation"] == {"text": "Last 2 years *70% / 24", "cell": "I3"}
    assert axis.raw["CCBT"] == {"text": "Maximum 5 cards BT", "cell": "E5"}


def test_real_to_json_round_trips(real):
    data = json.loads(json.dumps(real.to_json()))
    assert data["effective_date"] == "2026-07-01"
    assert data["banks"][0]["slabs"][0]["values"]["foir"]["CAT_A"] == {
        "value": 0.45,
        "cell": "K4",
        "not_offered": False,
    }


def test_fixture_has_no_author():
    with zipfile.ZipFile(FIXTURE) as z:
        core = z.read("docProps/core.xml").decode()
    assert "<dc:creator></dc:creator>" in core and "<cp:lastModifiedBy></cp:lastModifiedBy>" in core


# ------------------------------------------------------------------ the client's corrected sheet (5 Oct)
# tests/fixtures/policy_workbook_v2.xlsx: the corrected "Policy .xlsx", author fields blanked.
FIXTURE_V2 = Path(__file__).parent / "fixtures" / "policy_workbook_v2.xlsx"
NOT_OFFERING_CAT_U = ("hdfc_bank", "bandhan_bank")  # in this sheet, the other banks price CAT_U


@pytest.fixture(scope="module")
def v2():
    return parse_policy_workbook(FIXTURE_V2.read_bytes(), "Policy .xlsx")


def test_v2_slabs(v2):
    assert [b.lender_id for b in v2.banks] == ["hdfc_bank", "icici_bank", "axis_bank", "bandhan_bank", "indusind_bank"]
    for bank in v2.banks:
        assert [s.start for s in bank.slabs] == [25000, 35000, 40000, 50000, 60000, 70000, 80000]


def test_v2_na_is_not_offered_and_not_a_warning(v2):
    assert len(v2.warnings) < 10
    assert not any("is not a number" in m or "CAT_U" in m for m in v2.warnings)
    for bank in v2.banks:
        closed = [s.not_offered("CAT_U") for s in bank.slabs]
        assert closed == [bank.lender_id in NOT_OFFERING_CAT_U] * 7, bank.name
        assert not any(s.not_offered("CAT_B") for s in bank.slabs)
    hdfc = v2.bank("hdfc_bank").slabs[0].values["roi"]["CAT_U"]
    assert (hdfc.value, hdfc.cell, hdfc.not_offered) == (None, "I4", True)
    cat_u = [n for n in v2.notes if n.startswith("CAT U (unlisted)")]
    assert cat_u == [
        "CAT U (unlisted): HDFC Bank does not lend to this category",
        "CAT U (unlisted): Bandhan Bank does not lend to this category",
    ]


def test_v2_unknown_sheet2_columns_are_one_warning(v2):
    unknown = [m for m in v2.warnings if "not known" in m and "columns" in m]
    assert len(unknown) == 1 and unknown[0].startswith("Sheet2: 20 columns are not known")
    assert [r.rules.hl_deviation for r in v2.banks] == [0.05, 0.05, None, None, 0.05]


def test_v2_not_offered_round_trips(v2):
    back = PolicyWorkbook.from_json(json.loads(json.dumps(v2.to_json())))
    assert back.bank("hdfc_bank").slabs[3].not_offered("CAT_U")
    assert not back.bank("icici_bank").slabs[3].not_offered("CAT_U")


def test_v2_fixture_has_no_author():
    with zipfile.ZipFile(FIXTURE_V2) as z:
        core = z.read("docProps/core.xml").decode()
    assert "<dc:creator></dc:creator>" in core and "<cp:lastModifiedBy></cp:lastModifiedBy>" in core


def test_na_forms_and_category_text():
    overrides = {(4, "D"): "N/A", (4, "F"): "-", (4, "H"): " na ", (4, "J"): None, (4, "L"): "n.a.", (4, "N"): "NA"}
    w = parse_policy_workbook(workbook(grid_rows(overrides=overrides)))
    assert w.warnings == []
    first, second = w.bank("test_bank").slabs
    assert first.not_offered("CAT_B") and not first.not_offered("CAT_A") and not second.not_offered("CAT_B")
    assert w.notes.count("CAT B: Test Bank does not lend to this category at the slabs 25,000") == 1
    assert category_text("CAT_U") == "CAT U (unlisted)" and category_text("CAT_B") == "CAT B"


# ------------------------------------------------------------------ synthetic workbooks
PARAMS = ["ROI", "FOIR", "Multiplier", "Maximum Funding", "Maximum Tenure", "Tenure for Eligibility Calculation"]
CATS = ["CAT_A", "CAT_B"]
DEFAULTS = {
    "ROI": 0.12,
    "FOIR": 0.6,
    "Multiplier": 20,
    "Maximum Funding": 1000000,
    "Maximum Tenure": 60,
    "Tenure for Eligibility Calculation": 48,
}
RULE_HEADERS = [
    "Banks",
    "HL Deviation",
    "Multiplier",
    "CCBT",
    "PLBT",
    "App BT",
    "Gold Loan",
    "Bonus Calculation",
    "Incentive",
    "Rental Income",
    "Co-Applicant Salary",
]
RULE_ROW = ["Test Bank", "NA", "Salary * Multiplier", "NA", 3, "NA", "NA", "NA", "Monthly", 0.5, "Listed Company"]


def col(n: int) -> str:
    out = ""
    while n:
        n, r = divmod(n - 1, 26)
        out = chr(65 + r) + out
    return out


def cell_xml(ref: str, value) -> str:
    """value: a number, a string, None, or ("f", formula, cached-or-None[, shared-attrs])."""
    if value is None:
        return ""
    if isinstance(value, tuple):
        _, formula, cached, *attrs = value
        f = (
            f"<f {attrs[0]}>{formula}</f>"
            if attrs and formula
            else (f"<f {attrs[0]}/>" if attrs else f"<f>{formula}</f>")
        )
        v = "" if cached is None else f"<v>{cached}</v>"
        return f'<c r="{ref}">{f}{v}</c>'
    if isinstance(value, str):
        return f'<c r="{ref}" t="inlineStr"><is><t>{value}</t></is></c>'
    return f'<c r="{ref}"><v>{value}</v></c>'


def sheet_xml(rows: dict[int, dict[str, object]]) -> str:
    body = "".join(
        f'<row r="{r}">' + "".join(cell_xml(f"{c}{r}", v) for c, v in cells.items()) + "</row>"
        for r, cells in sorted(rows.items())
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/'
        f'spreadsheetml/2006/main"><sheetData>{body}</sheetData></worksheet>'
    )


def grid_rows(banks=(("Test Bank", (25000, 50000)),), overrides=None):
    """Sheet1: the header rows plus one row per (bank, slab). overrides: {(row, col): value}."""
    rows: dict[int, dict[str, object]] = {2: {"A": "Type", "B": "ROI"}, 3: {"A": "Category", "B": "Salary"}}
    n = 3
    for p in PARAMS:
        for c in CATS:
            rows[2][col(n)] = p
            rows[3][col(n)] = c
            n += 1
    r = 4
    for name, slabs in banks:
        for start in slabs:
            rows[r] = {"A": name, "B": start}
            n = 3
            for p in PARAMS:
                for _ in CATS:
                    rows[r][col(n)] = DEFAULTS[p]
                    n += 1
            r += 1
    for (row, c), value in (overrides or {}).items():
        rows.setdefault(row, {})[c] = value
    return rows


def rules_rows(*bank_rows, extra=None):
    rows = {2: {col(i + 2): h for i, h in enumerate(RULE_HEADERS)}}
    for k, values in enumerate(bank_rows or (RULE_ROW,)):
        rows[3 + k] = {col(i + 2): v for i, v in enumerate(values)}
    rows.update(extra or {})
    return rows


def workbook(sheet1=None, sheet2=None, extra_parts=None, content_types_extra="") -> bytes:
    sheets = [("Sheet1", sheet1 if sheet1 is not None else grid_rows())]
    if sheet2 is not False:
        sheets.append(("Sheet2", sheet2 if sheet2 is not None else rules_rows()))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/'
            f'package/2006/content-types">{content_types_extra}</Types>',
        )
        z.writestr(
            "xl/workbook.xml",
            (
                '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
                + "".join(f'<sheet name="{n}" sheetId="{i + 1}" r:id="rId{i + 1}"/>' for i, (n, _) in enumerate(sheets))
                + "</sheets></workbook>"
            ),
        )
        z.writestr(
            "xl/_rels/workbook.xml.rels",
            (
                '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                + "".join(
                    f'<Relationship Id="rId{i + 1}" Type="worksheet" Target="worksheets/sheet{i + 1}.xml"/>'
                    for i in range(len(sheets))
                )
                + "</Relationships>"
            ),
        )
        for i, (_, rows) in enumerate(sheets):
            if f"xl/worksheets/sheet{i + 1}.xml" in (extra_parts or {}):
                continue
            z.writestr(f"xl/worksheets/sheet{i + 1}.xml", sheet_xml(rows))
        for name, data in (extra_parts or {}).items():
            z.writestr(name, data)
    return buf.getvalue()


def refused(data: bytes, filename: str = "policy.xlsx") -> str:
    with pytest.raises(PolicyWorkbookError) as info:
        parse_policy_workbook(data, filename)
    return str(info.value)


def test_synthetic_minimal_workbook():
    w = parse_policy_workbook(workbook())
    assert w.warnings == []
    bank = w.bank("test_bank")
    assert [s.start for s in bank.slabs] == [25000, 50000]
    assert bank.slabs[1].values["foir"]["CAT_B"].value == 0.6
    assert bank.rules.incentive_frequencies == ["monthly"]
    assert any("not one of the app's known banks" in n for n in w.notes)
    assert w.effective_date is None


def test_formulas_without_saved_values_are_worked_out():
    # C4 = 0.12; D4 = C4+0.5% (no value saved); C5 = C4-1% via a shared formula child.
    overrides = {
        (4, "D"): ("f", "C4+0.5%", None),
        (4, "E"): ("f", "C4+0.01", None, 't="shared" si="0" ref="E4:E5"'),
        (5, "E"): ("f", None, None, 't="shared" si="0"'),
    }
    w = parse_policy_workbook(workbook(grid_rows(overrides=overrides)))
    first, second = w.bank("test_bank").slabs
    assert first.values["roi"]["CAT_B"].value == 0.125
    assert first.values["foir"]["CAT_A"].value == 0.13  # E4 = C4+0.01
    assert second.values["foir"]["CAT_A"].value == 0.13  # E5 = C5+0.01 (shared, moved one row)
    assert w.warnings == []


def test_saved_value_wins_and_other_formulas_are_not_executed():
    overrides = {
        (4, "D"): ("f", "SUM(C4:C9)", 0.131),
        (4, "E"): ("f", "INDIRECT(&quot;A1&quot;)", None),
    }
    w = parse_policy_workbook(workbook(grid_rows(overrides=overrides)))
    first = w.bank("test_bank").slabs[0]
    assert first.values["roi"]["CAT_B"].value == 0.131
    assert first.values["foir"]["CAT_A"].value is None
    assert any("E4" in m and "not worked out" in m for m in w.warnings)


def test_out_of_range_and_text_values_warn():
    overrides = {(4, "C"): 13, (4, "E"): "sixty", (4, "K"): 60.5, (5, "D"): None}
    w = parse_policy_workbook(workbook(grid_rows(overrides=overrides)))
    joined = "\n".join(w.warnings)
    assert (
        "C4 (Test Bank, slab 25,000, ROI CAT_A) = 13 is outside the expected range (looks like a percentage" in joined
    )
    assert "E4 (Test Bank, slab 25,000, FOIR CAT_A) is not a number ('sixty')" in joined
    assert "K4" in joined and "Maximum Tenure" in joined  # 60.5 months is not whole
    # A blank cell is not a warning: the bank does not lend to CAT_B at that slab.
    assert "D5" not in joined
    assert w.bank("test_bank").slabs[1].not_offered("CAT_B")
    assert "CAT B: Test Bank does not lend to this category at the slabs 50,000" in w.notes
    assert any("Test Bank, slab 50,000, CAT_B: some cells are NA but FOIR" in m for m in w.warnings)
    assert w.bank("test_bank").slabs[0].values["roi"]["CAT_A"].value is None


def test_duplicate_slabs_with_different_values():
    rows = grid_rows(banks=(("Test Bank", (25000, 35000, 35000)),), overrides={(6, "E"): 0.55, (6, "C"): 0.11})
    w = parse_policy_workbook(workbook(rows))
    assert (
        "2 rows share slab 35,000 for Test Bank with different ROI and FOIR; the first is used, please check"
        in w.warnings
    )
    slab = w.bank("test_bank").slab_for(40000)
    assert (slab.row, slab.values["roi"]["CAT_A"].value) == (5, 0.12)


def test_unsorted_slabs_are_sorted():
    w = parse_policy_workbook(workbook(grid_rows(banks=(("Test Bank", (50000, 25000)),))))
    assert [s.start for s in w.bank("test_bank").slabs] == [25000, 50000]
    assert any("not in increasing order" in n for n in w.notes)


def test_calculation_tenure_longer_than_max_warns():
    overrides = {(4, col(3 + 10)): 72}  # Tenure for Eligibility Calculation, CAT_A, row 4
    w = parse_policy_workbook(workbook(grid_rows(overrides=overrides)))
    assert any("eligibility tenure (72 months) is longer than the maximum tenure (60 months)" in m for m in w.warnings)


def test_unknown_sheet2_text_warns():
    row = [
        "Test Bank",
        "about 5",
        "Salary + Bonus",
        "two cards",
        "three",
        "Yes",
        "NA",
        "Last year bonus",
        "Monthly/Fortnightly",
        1.5,
        "Any company",
    ]
    w = parse_policy_workbook(workbook(sheet2=rules_rows(row)))
    joined = "\n".join(w.warnings)
    for ref, text in (
        ("C3", "about 5"),
        ("D3", "Salary + Bonus"),
        ("E3", "two cards"),
        ("F3", "three"),
        ("I3", "Last year bonus"),
        ("K3", "1.5"),
        ("L3", "Any company"),
    ):
        assert f"Sheet2 {ref}" in joined and repr(text) in joined, ref
    assert "App BT 'Yes': its meaning is not known" in joined
    assert "incentive frequency 'Fortnightly' is not understood" in joined
    rules = w.bank("test_bank").rules
    assert rules.multiplier_method is None and rules.incentive_frequencies == ["monthly"]
    assert rules.app_bt == "Yes" and rules.rental_income_share is None


def test_sheet2_other_spellings():
    row = [
        "TEST BANK",
        "5%",
        "(Salary - Obligation) * Multiplier",
        "Max 2 cards",
        1,
        "NA",
        "1%",
        "Last 3 years * 50% / 36",
        "Quarterly, Half-Yearly and Annual",
        "40%",
        "Listed company",
    ]
    w = parse_policy_workbook(workbook(sheet2=rules_rows(row)))
    r = w.bank("test_bank").rules
    assert (r.hl_deviation, r.multiplier_method, r.ccbt_max_cards, r.plbt_max_loans) == (
        0.05,
        "net_of_obligations",
        2,
        1,
    )
    assert r.gold_loan_monthly_pct == 0.01 and r.rental_income_share == 0.4
    assert (r.bonus.years, r.bonus.share, r.bonus.divisor) == (3, 0.5, 36)
    assert r.incentive_frequencies == ["quarterly", "half_yearly", "yearly"]
    assert r.co_applicant_rule == "listed_company"
    assert w.warnings == []


def test_rules_for_banks_missing_on_either_side():
    sheet2 = rules_rows(["Other Bank", *RULE_ROW[1:]])
    w = parse_policy_workbook(workbook(sheet2=sheet2))
    assert any("Other Bank has rules but no rows in the grid" in m for m in w.warnings)
    assert any("no rules row for Test Bank" in m for m in w.warnings)
    assert w.bank("test_bank").rules is None
    w = parse_policy_workbook(workbook(sheet2=False))
    assert "no second sheet with the per-bank rules" in w.warnings


def test_effective_date_from_a_date_styled_cell():
    styles = (
        '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>'
    )
    data = workbook(sheet2=rules_rows(extra={1: {"Z": 46204}}), extra_parts={"xl/styles.xml": styles})
    # Mark Z1 with style 1 (a date) by rewriting the cell.
    buf = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as zi, zipfile.ZipFile(buf, "w") as zo:
        for info in zi.infolist():
            part = zi.read(info.filename)
            if info.filename == "xl/worksheets/sheet2.xml":
                part = part.replace(b'<c r="Z1">', b'<c r="Z1" s="1">')
            if info.filename == "xl/_rels/workbook.xml.rels":
                part = part.replace(
                    b"</Relationships>", b'<Relationship Id="rId9" Type="styles" Target="styles.xml"/></Relationships>'
                )
            zo.writestr(info, part)
    w = parse_policy_workbook(buf.getvalue())
    assert (w.effective_date, w.effective_date_cell) == ("2026-07-01", "Sheet2!Z1")


@pytest.mark.parametrize("name", ["policy.xlsm", "Policy.XLSB"])
def test_macro_file_names_are_refused(name):
    assert "macro-enabled" in refused(workbook(), name)


def test_other_file_names_are_refused():
    assert refused(workbook(), "policy.csv") == "only .xlsx files are accepted"


def test_macro_content_is_refused_whatever_the_name():
    assert "macro-enabled" in refused(workbook(extra_parts={"xl/vbaProject.bin": b"\0"}))
    ct = '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/>'
    assert "macro-enabled" in refused(workbook(content_types_extra=ct))


def test_not_a_workbook_is_refused():
    assert refused(b"PK not really a zip") == "not an Excel .xlsx file"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("hello.txt", "hi")
    assert refused(buf.getvalue()) == "not an Excel .xlsx file"


def test_too_large_is_refused():
    assert "larger than" in refused(b"\0" * (MAX_FILE_BYTES + 1))


def test_xml_entities_are_refused():
    bomb = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><worksheet>&a;</worksheet>'
    assert "DOCTYPE" in refused(workbook(extra_parts={"xl/worksheets/sheet1.xml": bomb}))


def test_missing_parameter_columns_is_refused():
    rows = grid_rows()
    for c in list(rows[2]):
        if rows[2][c] == "Maximum Funding":
            rows[2][c] = "Something Else"
    message = refused(workbook(rows))
    assert "missing the parameter columns Maximum Funding" in message


def test_no_grid_is_refused():
    assert "Sheet1: no header row with ROI and FOIR" in refused(workbook({1: {"A": "hello"}}, sheet2=False))


def test_helpers():
    assert grouped(25000) == "25,000" and grouped(100000) == "1,00,000" and grouped(12345678) == "1,23,45,678"
    assert grouped(999) == "999"
    assert lender_id_for("Indusind Bank") == "indusind_bank"
    assert lender_id_for("  HDFC   bank ") == "hdfc_bank"
    assert lender_id_for("Kotak Mahindra Bank") == "kotak_mahindra_bank"
