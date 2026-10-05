"""Read the client's lender policy workbook (Policy.xlsx) into per-bank policies.

The workbook has two sheets:

- Sheet1, the grid: row 2 the parameter names (ROI, FOIR, Multiplier, Maximum Funding, Maximum
  Tenure, Tenure for Eligibility Calculation), each spanning one column per company category; row 3
  the categories (CAT_A+ .. CAT_U); then one row per bank and net-salary slab start.
- Sheet2, the per-bank rules: HL Deviation, Multiplier method, CCBT, PLBT, App BT, Gold Loan, Bonus
  Calculation, Incentive, Rental Income, Co-Applicant Salary.

Only the standard library is used (zipfile + ElementTree), so the Lambda needs no new dependency.
Formulas are never executed: the value Excel cached with the formula is used, and when there is
none, only a simple "<cell> + x%" / "<cell> - x%" formula is worked out. Anything else is a warning.
Macro workbooks are refused.
"""

from __future__ import annotations

import datetime as _dt
import io
import re
import zipfile
from dataclasses import asdict, dataclass, field
from posixpath import dirname, join, normpath
from typing import Any
from xml.etree import ElementTree

MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_UNZIPPED_BYTES = 40 * 1024 * 1024
MAX_PARTS = 300

_NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}
_R_ID = f"{{{_NS['r']}}}id"
_M = f"{{{_NS['m']}}}"

# Sheet1 header text (lower case, single spaces) -> parameter key.
PARAMETERS: dict[str, str] = {
    "roi": "roi",
    "foir": "foir",
    "multiplier": "multiplier",
    "maximum funding": "max_funding",
    "maximum tenure": "max_tenure_months",
    "tenure for eligibility calculation": "calculation_tenure_months",
}
PARAMETER_LABELS: dict[str, str] = {
    "roi": "ROI",
    "foir": "FOIR",
    "multiplier": "Multiplier",
    "max_funding": "Maximum Funding",
    "max_tenure_months": "Maximum Tenure",
    "calculation_tenure_months": "Tenure for Eligibility Calculation",
}

# The sheet's bank names -> the app's lender ids.
BANK_IDS: dict[str, str] = {
    "hdfc bank": "hdfc_bank",
    "icici bank": "icici_bank",
    "axis bank": "axis_bank",
    "bandhan bank": "bandhan_bank",
    "indusind bank": "indusind_bank",
}

INCENTIVE_FREQUENCIES = ("monthly", "quarterly", "half_yearly", "yearly")
_INCENTIVE_WORDS = {
    "monthly": "monthly",
    "quarterly": "quarterly",
    "half yearly": "half_yearly",
    "half-yearly": "half_yearly",
    "halfyearly": "half_yearly",
    "yearly": "yearly",
    "annual": "yearly",
    "annually": "yearly",
}
_INCENTIVE_TYPOS = {"quartery": "quarterly", "quaterly": "quarterly"}

MULTIPLIER_METHODS = {
    "salary-obligation*multiplier": "net_of_obligations",
    "(salary-obligation)*multiplier": "net_of_obligations",
    "salary*multiplier": "salary",
}
CO_APPLICANT_RULES = {
    "listed company": "listed_company",
    "all companies except proprietor and partnership": "all_except_proprietorship_partnership",
}


class PolicyWorkbookError(ValueError):
    """The file cannot be read as a lender policy workbook."""


@dataclass
class Category:
    code: str  # as in the sheet: "CAT_A+"
    label: str  # as the app shows it: "CAT A+"


@dataclass
class Value:
    value: float | None
    cell: str  # "E5" on Sheet1


@dataclass
class Slab:
    start: int
    row: int
    # parameter key -> category code -> value
    values: dict[str, dict[str, Value]]


@dataclass
class Bonus:
    years: int
    share: float  # 0.7 = 70%
    divisor: int  # months the counted bonus is spread over


@dataclass
class BankRules:
    row: int
    hl_deviation: float | None = None
    multiplier_method: str | None = None  # "salary" | "net_of_obligations"
    ccbt_max_cards: int = 0  # 0: no credit-card balance transfer
    plbt_max_loans: int | None = None
    app_bt: str | None = None
    gold_loan_monthly_pct: float | None = None  # 0.01 = 1% of the outstanding a month
    bonus: Bonus | None = None
    incentive_frequencies: list[str] = field(default_factory=list)
    rental_income_share: float | None = None
    co_applicant_rule: str | None = None
    # Column header -> {"text": the cell as shown, "cell": "D3"}
    raw: dict[str, dict[str, str]] = field(default_factory=dict)
    # Rule (hl_deviation, multiplier_method, ccbt, plbt, app_bt, gold_loan, bonus, incentive,
    # rental_income, co_applicant) -> {"text", "cell"}: what the engine cites in "How it is calculated".
    cells: dict[str, dict[str, str]] = field(default_factory=dict)


@dataclass
class BankPolicy:
    lender_id: str
    name: str
    slabs: list[Slab]
    rules: BankRules | None = None

    def slab_for(self, income: float) -> Slab | None:
        """The slab with the highest start at or below `income`; None below the lowest."""
        below = [s for s in self.slabs if s.start <= income]
        return below[-1] if below else None

    @property
    def min_income(self) -> int:
        return self.slabs[0].start


@dataclass
class PolicyWorkbook:
    categories: list[Category]
    banks: list[BankPolicy]
    effective_date: str | None = None  # ISO date
    effective_date_cell: str | None = None
    grid_sheet: str = "Sheet1"
    rules_sheet: str | None = None
    warnings: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def bank(self, lender_id: str) -> BankPolicy | None:
        return next((b for b in self.banks if b.lender_id == lender_id), None)

    def category_code(self, name: str) -> str | None:
        """The sheet's code for 'CAT B', 'CAT_B' or 'cat b'."""
        key = _category_key(name)
        return next((c.code for c in self.categories if _category_key(c.code) == key), None)

    def to_json(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> PolicyWorkbook:
        """The workbook to_json() gave (as stored with an upload)."""

        def value(v: dict) -> Value:
            return Value(value=v.get("value"), cell=str(v.get("cell") or ""))

        def slab(s: dict) -> Slab:
            values = {k: {c: value(v) for c, v in col.items()} for k, col in (s.get("values") or {}).items()}
            return Slab(start=int(s["start"]), row=int(s["row"]), values=values)

        def rules(r: dict | None) -> BankRules | None:
            if r is None:
                return None
            bonus = r.get("bonus")
            return BankRules(
                **{k: v for k, v in r.items() if k != "bonus"},
                bonus=Bonus(**bonus) if bonus else None,
            )

        return cls(
            categories=[Category(**c) for c in data.get("categories") or []],
            banks=[
                BankPolicy(
                    lender_id=b["lender_id"],
                    name=b["name"],
                    slabs=[slab(s) for s in b.get("slabs") or []],
                    rules=rules(b.get("rules")),
                )
                for b in data.get("banks") or []
            ],
            effective_date=data.get("effective_date"),
            effective_date_cell=data.get("effective_date_cell"),
            grid_sheet=str(data.get("grid_sheet") or "Sheet1"),
            rules_sheet=data.get("rules_sheet"),
            warnings=list(data.get("warnings") or []),
            notes=list(data.get("notes") or []),
        )


# ---------------------------------------------------------------- reading the xlsx


def _column_number(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    return n


def _column_letters(n: int) -> str:
    out = ""
    while n:
        n, rem = divmod(n - 1, 26)
        out = chr(65 + rem) + out
    return out


_REF = re.compile(r"^(\$?)([A-Z]{1,3})(\$?)(\d+)$")


def _split_ref(ref: str) -> tuple[int, int]:
    m = _REF.match(ref)
    if not m:
        raise PolicyWorkbookError(f"bad cell reference {ref!r}")
    return _column_number(m.group(2)), int(m.group(4))


@dataclass
class _Cell:
    value: Any  # float, str, bool or None
    formula: str | None
    style: int


class _Sheet:
    def __init__(self, name: str, cells: dict[tuple[int, int], _Cell]):
        self.name = name
        self.cells = cells

    def get(self, col: int, row: int) -> _Cell | None:
        return self.cells.get((col, row))

    def rows(self) -> list[int]:
        return sorted({r for _, r in self.cells})

    def max_col(self, row: int) -> int:
        return max((c for c, r in self.cells if r == row), default=0)


def _safe_xml(data: bytes, part: str) -> ElementTree.Element:
    head = data[:4096].upper()
    if b"<!DOCTYPE" in head or b"<!ENTITY" in data.upper():
        raise PolicyWorkbookError(f"{part}: XML with a DOCTYPE or entities is not accepted")
    try:
        return ElementTree.fromstring(data)
    except ElementTree.ParseError as e:
        raise PolicyWorkbookError(f"{part}: not valid XML ({e})") from None


class _Package:
    def __init__(self, data: bytes):
        if len(data) > MAX_FILE_BYTES:
            raise PolicyWorkbookError(f"the file is larger than {MAX_FILE_BYTES // (1024 * 1024)} MB")
        try:
            self.zip = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile:
            raise PolicyWorkbookError("not an Excel .xlsx file") from None
        infos = self.zip.infolist()
        if len(infos) > MAX_PARTS or sum(i.file_size for i in infos) > MAX_UNZIPPED_BYTES:
            raise PolicyWorkbookError("the workbook is too large once unpacked")
        self.names = {i.filename for i in infos}
        if "[Content_Types].xml" not in self.names or "xl/workbook.xml" not in self.names:
            raise PolicyWorkbookError("not an Excel .xlsx file")
        types = self.zip.read("[Content_Types].xml").lower()
        if any(n.lower().endswith("vbaproject.bin") for n in self.names) or b"macroenabled" in types:
            raise PolicyWorkbookError("macro-enabled workbooks (.xlsm) are not accepted; save it as .xlsx")

    def xml(self, part: str) -> ElementTree.Element | None:
        if part not in self.names:
            return None
        return _safe_xml(self.zip.read(part), part)

    def rels(self, part: str) -> dict[str, str]:
        rels_part = join(dirname(part), "_rels", part.rsplit("/", 1)[-1] + ".rels")
        root = self.xml(rels_part)
        out: dict[str, str] = {}
        if root is None:
            return out
        for rel in root.findall("rel:Relationship", _NS):
            if rel.get("TargetMode") == "External":
                continue
            target = rel.get("Target", "")
            path = target.lstrip("/") if target.startswith("/") else normpath(join(dirname(part), target))
            out[rel.get("Id", "")] = path
        return out


def _text_of(node: ElementTree.Element | None) -> str:
    if node is None:
        return ""
    return "".join(t.text or "" for t in node.iter(_M + "t"))


def _shared_strings(pkg: _Package, workbook_rels: dict[str, str]) -> list[str]:
    path = next((p for p in workbook_rels.values() if p.endswith("sharedStrings.xml")), "xl/sharedStrings.xml")
    root = pkg.xml(path)
    if root is None:
        return []
    return [_text_of(si) for si in root.findall("m:si", _NS)]


_DATE_FORMAT_IDS = set(range(14, 23)) | {45, 46, 47}


def _date_styles(pkg: _Package, workbook_rels: dict[str, str]) -> set[int]:
    path = next((p for p in workbook_rels.values() if p.endswith("styles.xml")), "xl/styles.xml")
    root = pkg.xml(path)
    if root is None:
        return set()
    custom: dict[int, str] = {}
    fmts = root.find("m:numFmts", _NS)
    if fmts is not None:
        for f in fmts.findall("m:numFmt", _NS):
            custom[int(f.get("numFmtId", "0"))] = f.get("formatCode", "")
    out: set[int] = set()
    xfs = root.find("m:cellXfs", _NS)
    for index, xf in enumerate(xfs.findall("m:xf", _NS) if xfs is not None else []):
        fmt = int(xf.get("numFmtId", "0"))
        code = re.sub(r'"[^"]*"|\[[^\]]*\]', "", custom.get(fmt, "")).lower()
        if fmt in _DATE_FORMAT_IDS or (code and re.search(r"[dy]", code) and "m" in code):
            out.add(index)
    return out


def _shift_formula(text: str, d_col: int, d_row: int) -> str:
    """A shared formula's text moved by (d_col, d_row), relative references only."""

    def move(m: re.Match[str]) -> str:
        col_abs, col, row_abs, row = m.groups()
        c = _column_number(col) if col_abs else _column_number(col) + d_col
        r = int(row) if row_abs else int(row) + d_row
        return f"{col_abs}{_column_letters(c)}{row_abs}{r}"

    return re.sub(r"(\$?)([A-Z]{1,3})(\$?)(\d+)", move, text)


def _read_sheet(pkg: _Package, name: str, path: str, strings: list[str]) -> _Sheet:
    root = pkg.xml(path)
    if root is None:
        raise PolicyWorkbookError(f"{name}: the sheet's part is missing")
    cells: dict[tuple[int, int], _Cell] = {}
    shared: dict[str, tuple[str, int, int]] = {}  # si -> (text, col, row) of the master
    pending: list[tuple[tuple[int, int], str]] = []
    for c in root.iter(_M + "c"):
        ref = c.get("r")
        if not ref:
            continue
        col, row = _split_ref(ref)
        kind = c.get("t", "n")
        v = c.find("m:v", _NS)
        raw = v.text if v is not None else None
        value: Any = None
        if kind == "s" and raw is not None:
            index = int(raw)
            value = strings[index] if 0 <= index < len(strings) else None
        elif kind == "inlineStr":
            value = _text_of(c.find("m:is", _NS))
        elif kind in ("str", "e"):
            value = raw
        elif kind == "b":
            value = raw == "1" if raw is not None else None
        elif raw is not None:
            try:
                value = float(raw)
            except ValueError:
                value = raw
        f = c.find("m:f", _NS)
        formula = None
        if f is not None:
            formula = f.text
            if f.get("t") == "shared":
                si = f.get("si", "")
                if f.text:
                    shared[si] = (f.text, col, row)
                else:
                    pending.append(((col, row), si))
        cells[(col, row)] = _Cell(value, formula, int(c.get("s", "0")))
    for (col, row), si in pending:
        if si in shared:
            text, m_col, m_row = shared[si]
            cells[(col, row)].formula = _shift_formula(text, col - m_col, row - m_row)
    return _Sheet(name, cells)


def _read_workbook(data: bytes) -> tuple[dict[str, _Sheet], set[int], bool]:
    pkg = _Package(data)
    workbook = pkg.xml("xl/workbook.xml")
    assert workbook is not None
    wb_rels = pkg.rels("xl/workbook.xml")
    strings = _shared_strings(pkg, wb_rels)
    date_styles = _date_styles(pkg, wb_rels)
    pr = workbook.find("m:workbookPr", _NS)
    date1904 = pr is not None and pr.get("date1904") in ("1", "true")
    sheets: dict[str, _Sheet] = {}
    container = workbook.find("m:sheets", _NS)
    for sheet in container.findall("m:sheet", _NS) if container is not None else []:
        name = sheet.get("name", "")
        path = wb_rels.get(sheet.get(_R_ID, ""))
        if path:
            sheets[name] = _read_sheet(pkg, name, path, strings)
    return sheets, date_styles, date1904


# ---------------------------------------------------------------- values and formulas

_SIMPLE_FORMULA = re.compile(r"^\s*=?\s*\$?([A-Z]{1,3})\$?(\d+)\s*([+-])\s*(\d+(?:\.\d+)?)\s*(%?)\s*$")


def _clean(number: float) -> float:
    """0.14500000000000002 -> 0.145."""
    return round(number, 10)


def _number(sheet: _Sheet, col: int, row: int, depth: int = 0) -> tuple[float | None, str | None]:
    """The cell's number and, when it has none, why."""
    cell = sheet.get(col, row)
    if cell is None or cell.value is None and not cell.formula:
        return None, "is empty"
    if isinstance(cell.value, float):
        return _clean(cell.value), None
    if cell.value is None and cell.formula:
        m = _SIMPLE_FORMULA.match(cell.formula)
        if not m or depth > 50:
            return None, f"has the formula ={cell.formula} with no saved value (not worked out)"
        base, why = _number(sheet, _column_number(m.group(1)), int(m.group(2)), depth + 1)
        if base is None:
            return None, f"has the formula ={cell.formula}, but {m.group(1)}{m.group(2)} {why}"
        step = float(m.group(4)) / (100 if m.group(5) else 1)
        return _clean(base + step if m.group(3) == "+" else base - step), None
    return None, f"is not a number ({cell.value!r})"


def _text(cell: _Cell | None) -> str:
    if cell is None or cell.value is None:
        return ""
    if isinstance(cell.value, float):
        return f"{cell.value:g}"
    return str(cell.value).strip()


def _key(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


def _category_key(text: str) -> str:
    return re.sub(r"[\s_]+", "", text.strip().upper())


def _excel_date(serial: float, date1904: bool) -> _dt.date:
    epoch = _dt.date(1904, 1, 1) if date1904 else _dt.date(1899, 12, 30)
    return epoch + _dt.timedelta(days=int(serial))


def grouped(n: float) -> str:
    """Indian digit grouping: 100000 -> '1,00,000'."""
    digits = str(int(round(n)))
    if len(digits) <= 3:
        return digits
    head, tail = digits[:-3], digits[-3:]
    parts = []
    while len(head) > 2:
        parts.insert(0, head[-2:])
        head = head[:-2]
    if head:
        parts.insert(0, head)
    return ",".join(parts + [tail])


def lender_id_for(name: str) -> str:
    known = BANK_IDS.get(_key(name))
    if known:
        return known
    slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:64]
    return slug or "lender"


# ---------------------------------------------------------------- Sheet1

_RANGES: dict[str, tuple[float, float, bool]] = {
    # key: (exclusive low, inclusive high, whole number)
    "roi": (0, 0.6, False),
    "foir": (0, 1, False),
    "multiplier": (0, 100, False),
    "max_funding": (0, 1e9, False),
    "max_tenure_months": (0, 480, True),
    "calculation_tenure_months": (0, 480, True),
}


def _find_header_row(sheet: _Sheet) -> int:
    for row in sheet.rows()[:20]:
        found = {_key(_text(sheet.get(c, row))) for c in range(1, sheet.max_col(row) + 1)}
        if {"roi", "foir"} <= found:
            return row
    raise PolicyWorkbookError(f"{sheet.name}: no header row with ROI and FOIR")


def _parse_grid(sheet: _Sheet, out: PolicyWorkbook) -> list[BankPolicy]:
    header = _find_header_row(sheet)
    cat_row = header + 1
    columns: dict[str, dict[str, int]] = {}  # param -> category code -> column
    current: str | None = None
    unknown_headers: set[str] = set()
    # Column A is the bank, column B the salary slab start.
    for col in range(3, sheet.max_col(header) + 1):
        title = _text(sheet.get(col, header))
        if title:
            current = PARAMETERS.get(_key(title))
            if current is None and _key(title) not in ("salary", "type", "bank"):
                unknown_headers.add(title)
        code = _text(sheet.get(col, cat_row))
        if current and code:
            if code in columns.setdefault(current, {}):
                out.warnings.append(
                    f"{sheet.name}: {code} appears twice under {PARAMETER_LABELS[current]}; the first is used"
                )
                continue
            columns[current][code] = col
    for title in sorted(unknown_headers):
        out.warnings.append(f"{sheet.name}: column header {title!r} is not known and was skipped")
    missing = [PARAMETER_LABELS[p] for p in PARAMETER_LABELS if p not in columns]
    if missing:
        raise PolicyWorkbookError(f"{sheet.name}: missing the parameter columns {', '.join(missing)}")

    codes: list[str] = []
    for param in PARAMETER_LABELS:
        for code in columns[param]:
            if code not in codes:
                codes.append(code)
    for param in PARAMETER_LABELS:
        absent = [c for c in codes if c not in columns[param]]
        if absent:
            out.warnings.append(f"{sheet.name}: {PARAMETER_LABELS[param]} has no column for {', '.join(absent)}")
    out.categories = [Category(code=c, label=c.replace("_", " ").strip()) for c in codes]

    rows: dict[str, tuple[str, list[Slab]]] = {}
    for row in [r for r in sheet.rows() if r > cat_row]:
        name = _text(sheet.get(1, row))
        start_cell = sheet.get(2, row)
        if not name and (start_cell is None or start_cell.value is None):
            continue
        if not name:
            out.warnings.append(f"{sheet.name} row {row}: no bank name; the row is skipped")
            continue
        start, why = _number(sheet, 2, row)
        if start is None or start < 0:
            out.warnings.append(
                f"{sheet.name} B{row} ({name}): the salary slab {why or 'is negative'}; the row is skipped"
            )
            continue
        values: dict[str, dict[str, Value]] = {}
        for param, by_code in columns.items():
            low, high, whole = _RANGES[param]
            values[param] = {}
            for code, col in by_code.items():
                ref = f"{_column_letters(col)}{row}"
                number, why = _number(sheet, col, row)
                where = f"{sheet.name} {ref} ({name}, slab {grouped(start)}, {PARAMETER_LABELS[param]} {code})"
                if number is None:
                    out.warnings.append(f"{where} {why}")
                elif not low < number <= high or (whole and number != int(number)):
                    hint = (
                        " (looks like a percentage; use a fraction such as 0.13)"
                        if param in ("roi", "foir") and number > 1
                        else ""
                    )
                    out.warnings.append(f"{where} = {number:g} is outside the expected range{hint}; not used")
                    number = None
                values[param][code] = Value(int(number) if whole and number is not None else number, ref)
        lender_id = lender_id_for(name)
        rows.setdefault(lender_id, (name, []))[1].append(Slab(start=int(start), row=row, values=values))

    banks: list[BankPolicy] = []
    for lender_id, (name, slabs) in rows.items():
        if _key(name) not in BANK_IDS:
            out.notes.append(f"{name} is not one of the app's known banks; it is added as {lender_id}")
        by_start: dict[int, list[Slab]] = {}
        for slab in slabs:
            by_start.setdefault(slab.start, []).append(slab)
        if [s.start for s in slabs] != sorted(s.start for s in slabs):
            out.notes.append(f"{name}: the slab rows are not in increasing order; they are sorted")
        kept: list[Slab] = []
        for start in sorted(by_start):
            group = by_start[start]
            kept.append(group[0])
            if len(group) == 1:
                continue
            differ = [
                PARAMETER_LABELS[p]
                for p in PARAMETER_LABELS
                if any(_plain(s.values.get(p)) != _plain(group[0].values.get(p)) for s in group[1:])
            ]
            if differ:
                out.warnings.append(
                    f"{len(group)} rows share slab {grouped(start)} for {name} with different "
                    f"{' and '.join(differ)}; the first is used, please check"
                )
            else:
                out.warnings.append(
                    f"{len(group)} rows share slab {grouped(start)} for {name} with the same values; one is used"
                )
        banks.append(BankPolicy(lender_id=lender_id, name=name, slabs=kept))
        for slab in kept:
            calc = slab.values["calculation_tenure_months"]
            for code, value in calc.items():
                top = slab.values["max_tenure_months"].get(code)
                if value.value and top and top.value and value.value > top.value:
                    out.warnings.append(
                        f"{name}, slab {grouped(slab.start)}, {code}: the eligibility tenure "
                        f"({value.value} months) is longer than the maximum tenure ({top.value} months)"
                    )
    if not banks:
        raise PolicyWorkbookError(f"{sheet.name}: no bank rows under the headers")
    return banks


def _plain(values: dict[str, Value] | None) -> dict[str, float | None]:
    return {k: v.value for k, v in (values or {}).items()}


# ---------------------------------------------------------------- Sheet2

_RULE_COLUMNS = {
    "hl deviation": "hl_deviation",
    "multiplier": "multiplier_method",
    "ccbt": "ccbt",
    "plbt": "plbt",
    "app bt": "app_bt",
    "gold loan": "gold_loan",
    "bonus calculation": "bonus",
    "incentive": "incentive",
    "rental income": "rental_income",
    "co-applicant salary": "co_applicant",
    "co applicant salary": "co_applicant",
}
_NA = {"na", "n/a", "-", "nil", "none", ""}


def _is_na(cell: _Cell | None) -> bool:
    return _key(_text(cell)) in _NA


def _fraction(cell: _Cell | None) -> float | None:
    if cell is not None and isinstance(cell.value, float):
        return _clean(cell.value)
    try:
        text = _text(cell).rstrip("%").strip()
        number = float(text)
        return _clean(number / 100 if _text(cell).endswith("%") else number)
    except ValueError:
        return None


def _apply_rule(rules: BankRules, kind: str, cell: _Cell | None, where: str, out: PolicyWorkbook) -> None:
    text = _text(cell)

    def unknown(expected: str) -> None:
        out.warnings.append(f"{where}: {text!r} is not understood ({expected}); it is not used")

    if kind == "hl_deviation":
        if not _is_na(cell):
            value = _fraction(cell)
            if value is None or not 0 <= value <= 1:
                unknown("a fraction such as 0.05, or NA")
            else:
                rules.hl_deviation = value
    elif kind == "multiplier_method":
        method = MULTIPLIER_METHODS.get(re.sub(r"\s+", "", text.lower()))
        if method is None:
            unknown('"Salary * Multiplier" or "Salary - Obligation * Multiplier"')
        rules.multiplier_method = method
    elif kind == "ccbt":
        m = re.fullmatch(r"(?:maximum|max|upto|up to)?\s*(\d+)\s*cards?\s*(?:bt)?", _key(text))
        if m:
            rules.ccbt_max_cards = int(m.group(1))
        elif not _is_na(cell):
            unknown('"Maximum 5 cards BT" or NA')
    elif kind == "plbt":
        value = _fraction(cell)
        if value is not None and value >= 0 and value == int(value):
            rules.plbt_max_loans = int(value)
        elif not _is_na(cell):
            unknown("a whole number of loans, or NA")
    elif kind == "app_bt":
        if not _is_na(cell):
            rules.app_bt = text
            out.warnings.append(f"{where}: App BT {text!r}: its meaning is not known; it is shown but not used")
    elif kind == "gold_loan":
        if not _is_na(cell):
            value = _fraction(cell)
            if value is None or not 0 < value <= 0.2:
                unknown("a monthly fraction of the outstanding such as 0.01, or NA")
            else:
                rules.gold_loan_monthly_pct = value
    elif kind == "bonus":
        m = re.fullmatch(r"last\s*(\d+)\s*years?\s*\*\s*(\d+(?:\.\d+)?)\s*%\s*/\s*(\d+)", _key(text))
        if m and int(m.group(3)) > 0:
            rules.bonus = Bonus(years=int(m.group(1)), share=_clean(float(m.group(2)) / 100), divisor=int(m.group(3)))
        elif not _is_na(cell):
            unknown('"Last 2 years *70% / 24", or NA')
    elif kind == "incentive":
        if _is_na(cell):
            return
        found: list[str] = []
        for token in re.split(r"[/,;&]|\band\b", text, flags=re.IGNORECASE):
            word = _key(token.lower())
            if not word:
                continue
            if word in _INCENTIVE_TYPOS:
                fixed = _INCENTIVE_TYPOS[word]
                out.notes.append(f"{where}: {token.strip()!r} is read as {fixed.capitalize()}")
                word = fixed
            frequency = _INCENTIVE_WORDS.get(word)
            if frequency is None:
                out.warnings.append(f"{where}: incentive frequency {token.strip()!r} is not understood; it is not used")
            elif frequency not in found:
                found.append(frequency)
        rules.incentive_frequencies = [f for f in INCENTIVE_FREQUENCIES if f in found]
    elif kind == "rental_income":
        if not _is_na(cell):
            value = _fraction(cell)
            if value is None or not 0 <= value <= 1:
                unknown("a share such as 0.5, or NA")
            else:
                rules.rental_income_share = value
    elif kind == "co_applicant":
        rule = CO_APPLICANT_RULES.get(_key(text))
        if rule is None and not _is_na(cell):
            unknown('"Listed Company" or "All Companies except proprietor and partnership"')
        rules.co_applicant_rule = rule


def _parse_rules(sheet: _Sheet, banks: list[BankPolicy], out: PolicyWorkbook) -> None:
    header = None
    for row in sheet.rows()[:20]:
        texts = {_key(_text(sheet.get(c, row))) for c in range(1, sheet.max_col(row) + 1)}
        if texts & {"banks", "bank"}:
            header = row
            break
    if header is None:
        out.warnings.append(f"{sheet.name}: no header row with 'Banks'; the per-bank rules are not read")
        return
    bank_col = 0
    columns: dict[int, tuple[str, str]] = {}  # col -> (kind, header text)
    for col in range(1, sheet.max_col(header) + 1):
        title = _text(sheet.get(col, header))
        if _key(title) in ("banks", "bank"):
            bank_col = col
        elif title:
            kind = _RULE_COLUMNS.get(_key(title))
            if kind is None:
                out.warnings.append(f"{sheet.name}: column {title!r} is not known; it is not used")
            else:
                columns[col] = (kind, title)
    by_id = {b.lender_id: b for b in banks}
    for row in [r for r in sheet.rows() if r > header]:
        name = _text(sheet.get(bank_col, row))
        if not name:
            continue
        bank = by_id.get(lender_id_for(name))
        if bank is None:
            out.warnings.append(f"{sheet.name} row {row}: {name} has rules but no rows in the grid; skipped")
            continue
        if bank.rules is not None:
            out.warnings.append(f"{sheet.name} row {row}: a second row for {name}; the first is used")
            continue
        rules = BankRules(row=row)
        for col, (kind, title) in columns.items():
            ref = f"{_column_letters(col)}{row}"
            cell = sheet.get(col, row)
            rules.raw[title] = {"text": _text(cell) or "", "cell": ref}
            rules.cells.setdefault(kind, {"text": _text(cell)[:200], "cell": ref})
            _apply_rule(rules, kind, cell, f"{sheet.name} {ref} ({name}, {title})", out)
        bank.rules = rules
    for bank in banks:
        if bank.rules is None:
            out.warnings.append(f"{sheet.name}: no rules row for {bank.name}")


def _effective_date(sheets: list[_Sheet], date_styles: set[int], date1904: bool, out: PolicyWorkbook) -> None:
    for sheet in sheets:
        for (col, row), cell in sorted(sheet.cells.items(), key=lambda kv: (kv[0][1], kv[0][0])):
            if cell.style in date_styles and isinstance(cell.value, float) and 1 <= cell.value < 2958466:
                out.effective_date = _excel_date(cell.value, date1904).isoformat()
                out.effective_date_cell = f"{sheet.name}!{_column_letters(col)}{row}"
                return


# ---------------------------------------------------------------- entry point


def parse_policy_workbook(data: bytes, filename: str | None = None) -> PolicyWorkbook:
    """Parse the workbook's bytes. Raises PolicyWorkbookError when it cannot be used at all;
    everything else that looks wrong is in `warnings` (and harmless remarks in `notes`)."""
    if filename and not filename.lower().endswith(".xlsx"):
        if filename.lower().endswith((".xlsm", ".xlsb", ".xltm")):
            raise PolicyWorkbookError("macro-enabled workbooks (.xlsm) are not accepted; save it as .xlsx")
        raise PolicyWorkbookError("only .xlsx files are accepted")
    sheets, date_styles, date1904 = _read_workbook(data)
    if not sheets:
        raise PolicyWorkbookError("the workbook has no sheets")
    out = PolicyWorkbook(categories=[], banks=[])
    names = list(sheets)
    grid = sheets.get("Sheet1")
    if grid is None:
        grid = next((s for s in sheets.values() if _safe_header(s)), None)
        if grid is None:
            raise PolicyWorkbookError("no sheet with the ROI / FOIR grid")
        out.notes.append(f"the grid is read from the sheet {grid.name!r}")
    out.grid_sheet = grid.name
    out.banks = _parse_grid(grid, out)
    rules = sheets.get("Sheet2") or next((sheets[n] for n in names if sheets[n] is not grid), None)
    if rules is None:
        out.warnings.append("no second sheet with the per-bank rules")
    else:
        out.rules_sheet = rules.name
        _parse_rules(rules, out.banks, out)
    _effective_date([s for s in (rules, grid) if s is not None], date_styles, date1904, out)
    if out.effective_date is None:
        out.notes.append("no effective date found in the workbook")
    return out


def _safe_header(sheet: _Sheet) -> bool:
    try:
        _find_header_row(sheet)
        return True
    except PolicyWorkbookError:
        return False
