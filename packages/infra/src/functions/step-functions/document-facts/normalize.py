"""Normalisation of model-extracted loan-file fields (pure, no AWS).

Port of Plan B lean-file-check extract.to_number / to_date / to_month /
normalise_fields, plus financial_year normalisation (normalise_fy) and the
obligations lists (recurring_debits, declared_existing_emis).
"""
import re
from datetime import datetime

from tool_schema import DEBIT_CATEGORIES, DOC_TYPES, FIELD_NAMES, NUMERIC_FIELDS

_MONTHS = {m: i for i, m in enumerate(
    ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'], 1)}

_NULL_STRINGS = ('', 'null', 'none', 'n/a', 'na', '-', '–')

# '2025-26', '2025-2026', '2025/26', '2025 – 26'
_FY_RE = re.compile(r'(\d{4})\s*[-/–—]\s*(\d{4}|\d{2})(?!\d)')
# 'AY', 'A.Y.', 'A Y', 'ASSESSMENT YEAR' before the year pair
_AY_RE = re.compile(r'\bA\.?\s*Y\b|ASSESSMENT')

# Channel spelled by the model -> canonical channel.
_CHANNEL_ALIASES = {
    'ACH': 'ACH', 'NACH': 'NACH', 'ENACH': 'NACH', 'ECS': 'ECS', 'SI': 'SI',
    'STANDINGINSTRUCTION': 'SI', 'UPI': 'UPI', 'UPIAUTOPAY': 'UPI',
}
# Channel prefix of a narration, e.g. 'ACH DR/MULSHI AUTO FINANCE/CAR LOAN EMI'.
_NARRATION_CHANNEL_RE = re.compile(r'^\s*(E-?NACH|NACH|ACH|ECS|SI|UPI)\b', re.I)
# 'Total existing EMI' / 'Grand total' row of the application's obligations table.
_TOTAL_ROW_RE = re.compile(r'^\s*(?:grand\s+)?total\b', re.I)
_CATEGORY_ALIASES = {
    'emi': 'loan_emi', 'loan': 'loan_emi', 'loan_repayment': 'loan_emi', 'loanemi': 'loan_emi',
    'sip': 'investment', 'mutual_fund': 'investment', 'investments': 'investment', 'rd': 'investment',
    'utilities': 'utility', 'bill': 'utility', 'bills': 'utility',
    'creditcard': 'credit_card', 'credit_card_payment': 'credit_card', 'card': 'credit_card',
    'premium': 'insurance',
}


def to_number(v):
    """'₹65,000.00' / '65000' / 65000 -> 65000.0 ; None on failure."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = re.sub(r'[^\d.\-]', '', str(v))
    try:
        return float(s) if s not in ('', '.', '-') else None
    except ValueError:
        return None


def to_date(v):
    """Parse '01-Jun-2026', '2026-06-01', '01/06/2026', '01-06-2026' -> date."""
    if not v:
        return None
    s = str(v).strip()
    for fmt in ('%Y-%m-%d', '%d-%b-%Y', '%d-%B-%Y', '%d/%m/%Y', '%d-%m-%Y', '%d %b %Y', '%d %B %Y'):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


def to_month(v):
    """'2026-07' / 'July 2026' / 'Jul-2026' / '2026-07-01' -> (2026, 7)."""
    if not v:
        return None
    s = str(v).strip().lower()
    m = re.match(r'^(\d{4})-(\d{1,2})', s)
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.search(r'([a-z]{3})[a-z]*[\s\-/,]*(\d{4})', s)
    if m and m.group(1) in _MONTHS:
        return int(m.group(2)), _MONTHS[m.group(1)]
    d = to_date(v)
    return (d.year, d.month) if d else None


def normalise_fy(v):
    """Financial year -> 'YYYY-YY' or None.

    'FY 2025-26', '2025-2026', '2025-26', '2025/26' -> '2025-26'.
    An assessment year is one year after its financial year: 'AY 2026-27' -> '2025-26'.
    """
    if v is None or isinstance(v, bool):
        return None
    s = str(v).strip().upper()
    if not s:
        return None
    m = _FY_RE.search(s)
    if not m:
        return None
    start = int(m.group(1))
    end_s = m.group(2)
    if len(end_s) == 4:
        end = int(end_s)
    else:
        end = start // 100 * 100 + int(end_s)
        if end < start:  # century rollover, e.g. 1999-00
            end += 100
    if end != start + 1:
        return None
    if _AY_RE.search(s[:m.start()]):
        start -= 1
    return f'{start:04d}-{(start + 1) % 100:02d}'


def _clean_str(v):
    if v is None or isinstance(v, bool):
        return None
    s = str(v).strip()
    return None if s.lower() in _NULL_STRINGS else s


def normalise_channel(v, narration=None) -> str:
    """'e-NACH' -> 'NACH', 'Standing instruction' -> 'SI'; else the narration prefix; else 'other'."""
    key = re.sub(r'[^A-Z]', '', str(v or '').upper())
    if key in _CHANNEL_ALIASES:
        return _CHANNEL_ALIASES[key]
    m = _NARRATION_CHANNEL_RE.match(str(narration or ''))
    if m:
        return _CHANNEL_ALIASES[re.sub(r'[^A-Z]', '', m.group(1).upper())]
    return 'other'


def normalise_category(v) -> str:
    """'Loan EMI' -> 'loan_emi', 'SIP' -> 'investment'; unknown -> 'other'."""
    key = re.sub(r'[\s\-/]+', '_', str(v or '').strip().lower())
    key = _CATEGORY_ALIASES.get(key, key)
    return key if key in DEBIT_CATEGORIES else 'other'


def normalise_debits(items) -> list:
    """recurring_debits -> [{date, amount, narration, channel, category}].

    Amounts are positive (a debit printed as -8,200 is 8200). Entries that are
    not objects or carry no usable amount are dropped.
    """
    out = []
    for r in items if isinstance(items, list) else []:
        if not isinstance(r, dict):
            continue
        amount = to_number(r.get('amount'))
        if not amount:
            continue
        d = to_date(r.get('date'))
        narration = _clean_str(r.get('narration'))
        out.append({'date': d.isoformat() if d else _clean_str(r.get('date')),
                    'amount': abs(amount),
                    'narration': narration,
                    'channel': normalise_channel(r.get('channel'), narration),
                    'category': normalise_category(r.get('category'))})
    return out


def is_total_row(lender) -> bool:
    """'Total existing EMI' copied from the obligations table as if it were a loan."""
    return bool(_TOTAL_ROW_RE.match(str(lender or '')))


def normalise_declared_emis(items) -> list:
    """declared_existing_emis -> [{lender, loan_type, amount}].

    'None declared' / 0 rows are dropped. A 'Total ...' row is kept here and
    moved to declared_total_existing_emi by normalise_fields.
    """
    out = []
    for e in items if isinstance(items, list) else []:
        if not isinstance(e, dict):
            continue
        amount = to_number(e.get('amount'))
        if not amount:
            continue
        out.append({'lender': _clean_str(e.get('lender')),
                    'loan_type': _clean_str(e.get('loan_type')),
                    'amount': abs(amount)})
    return out


def normalise_fields(f: dict) -> dict:
    """Plan B normalise_fields + financial_year + obligations. Always returns every FIELD_NAMES key."""
    if not isinstance(f, dict):
        f = {}
    out = {k: f.get(k) for k in FIELD_NAMES}
    for k, v in out.items():
        if isinstance(v, str) and v.strip().lower() in _NULL_STRINGS:
            out[k] = None
    if out['doc_type'] not in DOC_TYPES:
        out['doc_type'] = 'other'
    for k in NUMERIC_FIELDS:
        out[k] = to_number(out[k])
    if out['pan']:
        out['pan'] = re.sub(r'\s', '', str(out['pan'])).upper()
    if out['masked_aadhaar_last4']:
        digits = re.sub(r'\D', '', str(out['masked_aadhaar_last4']))
        out['masked_aadhaar_last4'] = digits[-4:] or None
    ym = to_month(out['month'])
    out['month'] = f'{ym[0]:04d}-{ym[1]:02d}' if ym else None
    for k in ('statement_from', 'statement_to'):
        d = to_date(out[k])
        out[k] = d.isoformat() if d else out[k]
    credits = []
    for c in out.get('salary_credits') or []:
        if not isinstance(c, dict):
            continue
        d = to_date(c.get('date'))
        credits.append({'date': d.isoformat() if d else c.get('date'),
                        'amount': to_number(c.get('amount')),
                        'narration': c.get('narration')})
    out['salary_credits'] = credits
    out['recurring_debits'] = normalise_debits(out['recurring_debits'])
    declared = normalise_declared_emis(out['declared_existing_emis'])
    totals = [e['amount'] for e in declared if is_total_row(e['lender'])]
    out['declared_existing_emis'] = [e for e in declared if not is_total_row(e['lender'])]
    for k in ('declared_total_existing_emi', 'loan_tenure_months'):
        if out[k] is not None:
            out[k] = abs(out[k])
    if totals and out['declared_total_existing_emi'] is None:
        out['declared_total_existing_emi'] = max(totals)
    out['financial_year'] = normalise_fy(out['financial_year'])
    return out
