"""Grounding of model-extracted fields against the document's machine text (pure, no AWS).

Port of Plan B lean-file-check extract._lev / inr / ground_fields: the model can
mis-read single characters of IDs (PAN) or drop/add a digit of an amount. When
the document has a machine text layer (PDF text, OCR, BDA, text file), the exact
characters printed there win.
"""
import re

from tool_schema import NUMERIC_FIELDS

PAN_RE = re.compile(r'\b[A-Z]{5}\d{4}[A-Z]\b')
AADHAAR_MASKED_RE = re.compile(r'XXXX[- ]XXXX[- ](\d{4})')
NUMBER_RE = re.compile(r'\d[\d,]*(?:\.\d+)?')

# Below this many characters the text is not a usable text layer.
MIN_TEXT_CHARS = 50


def lev(a: str, b: str) -> int:
    """Levenshtein edit distance."""
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def inr(v) -> str:
    """Indian digit grouping: 600000 -> ₹6,00,000."""
    if v is None:
        return '–'
    neg, v = v < 0, abs(v)
    whole, frac = divmod(round(v * 100), 100)
    s = str(int(whole))
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        head = ','.join(re.findall(r'\d{1,2}', head[::-1]))[::-1]  # groups of 2 from the right
        s = f'{head},{tail}'
    return f"{'-' if neg else ''}₹{s}" + (f'.{frac:02d}' if frac else '')


def _has_text_layer(text) -> bool:
    return bool(text) and len(text.strip()) >= MIN_TEXT_CHARS


def printed_numbers(text: str) -> set:
    """Every number printed in the text, as float ('11,40,000' -> 1140000.0)."""
    return {float(x.replace(',', '')) for x in NUMBER_RE.findall(text or '')}


def ground_fields(fields: dict, text: str) -> tuple:
    """Correct IDs and amounts from the machine text. Returns (fields, audit notes).

    A no-op when the text has fewer than 50 characters.
    """
    notes = []
    if not _has_text_layer(text):
        return fields, notes
    f = dict(fields)
    pans = sorted(set(PAN_RE.findall(text)))
    if f.get('pan') and pans and f['pan'] not in pans:
        best = min(pans, key=lambda p: lev(p, f['pan']))
        notes.append(f"PAN corrected from text layer: model read '{f['pan']}', document text says '{best}'")
        f['pan'] = best
    elif not f.get('pan') and len(pans) == 1 and f.get('doc_type') != 'bank_statement':
        notes.append(f"PAN filled from text layer: '{pans[0]}'")
        f['pan'] = pans[0]
    aad = sorted(set(AADHAAR_MASKED_RE.findall(text)))
    if f.get('masked_aadhaar_last4') and aad and f['masked_aadhaar_last4'] not in aad:
        notes.append(f"Aadhaar last-4 corrected from text layer: '{f['masked_aadhaar_last4']}' -> '{aad[0]}'")
        f['masked_aadhaar_last4'] = aad[0]
    # amounts: Indian grouping (11,40,000) sometimes gets a digit dropped/added by the model
    printed = printed_numbers(text)

    def fix(v, label):
        if not isinstance(v, (int, float)) or isinstance(v, bool) or v in printed:
            return v
        for c in (v / 10, v * 10, v / 100, v * 100):
            if c in printed:
                notes.append(f'{label} corrected from text layer: model read {inr(v)}, document text says {inr(c)}')
                return c
        return v

    for k in NUMERIC_FIELDS:
        f[k] = fix(f.get(k), k)
    f['salary_credits'] = [{**c, 'amount': fix(c.get('amount'), f"salary credit {c.get('date')}")}
                           for c in f.get('salary_credits') or [] if isinstance(c, dict)]
    return f, notes


def unverified_numbers(fields: dict, text: str) -> list:
    """Names of numeric fields whose value is not among the printed numbers.

    Salary credits are reported as 'salary_credits[i].amount'. Returns [] when
    the text has fewer than 50 characters (nothing to verify against).
    """
    if not _has_text_layer(text):
        return []
    printed = printed_numbers(text)
    out = []
    for k in NUMERIC_FIELDS:
        v = fields.get(k)
        if v is not None and v not in printed:
            out.append(k)
    for i, c in enumerate(fields.get('salary_credits') or []):
        v = c.get('amount') if isinstance(c, dict) else None
        if v is not None and v not in printed:
            out.append(f'salary_credits[{i}].amount')
    return out
