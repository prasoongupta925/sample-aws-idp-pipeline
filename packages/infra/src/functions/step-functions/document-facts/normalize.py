"""Normalisation of model-extracted loan-file fields (pure, no AWS).

Port of Plan B lean-file-check extract.to_number / to_date / to_month /
normalise_fields, plus financial_year normalisation (normalise_fy).
"""
import re
from datetime import datetime

from tool_schema import DOC_TYPES, FIELD_NAMES, NUMERIC_FIELDS

_MONTHS = {m: i for i, m in enumerate(
    ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'], 1)}

_NULL_STRINGS = ('', 'null', 'none', 'n/a', 'na', '-', '–')

# '2025-26', '2025-2026', '2025/26', '2025 – 26'
_FY_RE = re.compile(r'(\d{4})\s*[-/–—]\s*(\d{4}|\d{2})(?!\d)')
# 'AY', 'A.Y.', 'A Y', 'ASSESSMENT YEAR' before the year pair
_AY_RE = re.compile(r'\bA\.?\s*Y\b|ASSESSMENT')


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


def normalise_fields(f: dict) -> dict:
    """Plan B normalise_fields + financial_year. Always returns every FIELD_NAMES key."""
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
    out['financial_year'] = normalise_fy(out['financial_year'])
    return out
