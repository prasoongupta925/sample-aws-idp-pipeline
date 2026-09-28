"""Deterministic loan-file check engine (no LLM, stdlib only).

Generalises the Plan B lean-file-check checks.py: the same reasons, tolerances
and helpers, driven by a checklist from checklists.json instead of a fixed
salaried personal-loan list. Only this code decides READY / NOT READY; the
chat model reports the result.

Inputs are FACTS# data dicts (one per analysed document) and, optionally, the
project's DOC# data dicts so that pending / failed / unsupported documents can
be reported. See the shared interfaces, sections 4 and 5.
"""

import json
import os
import re
from collections import Counter
from datetime import date, datetime, timezone
from statistics import median

ENGINE_VERSION = '1.0'

DOC_TYPES = [
    'loan_application',
    'identity_details',
    'salary_slip',
    'bank_statement',
    'form16_itr',
    'other',
]

# Fixed consistency-check registry (Plan B checks.py semantics).
CHECK_IDS = [
    'pan',
    'aadhaar_last4',
    'applicant_name',
    'employer',
    'employer_vs_bank_credits',
    'declared_vs_slip_net',
    'declared_vs_bank_credits',
    'slip_net_vs_bank_credits',
    'form16_vs_slip_gross',
]

CHECK_NAMES = {
    'pan': 'PAN',
    'aadhaar_last4': 'Aadhaar (masked)',
    'applicant_name': 'Applicant name',
    'employer': 'Employer',
    'employer_vs_bank_credits': 'Employer vs bank salary credits',
    'declared_vs_slip_net': 'Declared net salary vs salary slips',
    'declared_vs_bank_credits': 'Declared net salary vs bank credits',
    'slip_net_vs_bank_credits': 'Salary slips vs bank credits',
    'form16_vs_slip_gross': 'Form-16 gross vs 12 × slip gross',
}

RULE_KINDS = {'present', 'monthly', 'period', 'manual'}

DEFAULT_TOLERANCE_PCT = 5
DEFAULT_FORM16_TOLERANCE_PCT = 10

MONTH_ABBR = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

# Nouns used in item details so the default checklist keeps Plan B wording.
_DOC_NOUNS = {
    'loan_application': 'loan application',
    'identity_details': 'identity details',
    'salary_slip': 'salary slips',
    'bank_statement': 'bank statement',
    'form16_itr': 'Form-16 / ITR',
    'other': 'documents',
}

UNSUPPORTED_FILE_TYPES = {
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv',
    'text/tab-separated-values',
}
# Fallback when a DOC# item carries no usable MIME type.
UNSUPPORTED_EXTENSIONS = ('.xlsx', '.xls', '.csv', '.tsv')
UNSUPPORTED_REASON = (
    'spreadsheet documents are not read by the file check; '
    'upload the statement as PDF'
)

ASSISTANT_INSTRUCTIONS = (
    "Report overall_verdict and each applicant's verdict, reasons, checklist "
    'and consistency exactly as returned. Do not re-compute, soften or add '
    'findings. Letters and artifacts must list exactly missing_items and '
    'mismatches.'
)

_ID_RE = re.compile(r'^[a-z0-9_]+$')
_YM_RE = re.compile(r'^\d{4}-\d{2}$')
_MONTHS = {m.lower(): i for i, m in enumerate(MONTH_ABBR, 1)}

DEFAULT_CATALOG_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), 'checklists.json'
)


# ------------------------------------------------------------------ helpers
def to_date(v):
    """Parse '01-Jun-2026', '2026-06-01', '01/06/2026', '01-06-2026' -> date."""
    if not v:
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    s = str(v).strip()
    for fmt in (
        '%Y-%m-%d',
        '%d-%b-%Y',
        '%d-%B-%Y',
        '%d/%m/%Y',
        '%d-%m-%Y',
        '%d %b %Y',
        '%d %B %Y',
    ):
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
        month = int(m.group(2))
        return (int(m.group(1)), month) if 1 <= month <= 12 else None
    m = re.search(r'([a-z]{3})[a-z]*[\s\-/,]*(\d{4})', s)
    if m and m.group(1) in _MONTHS:
        return int(m.group(2)), _MONTHS[m.group(1)]
    d = to_date(v)
    return (d.year, d.month) if d else None


def ym_add(ym, delta):
    y, m = ym
    idx = y * 12 + (m - 1) + delta
    return idx // 12, idx % 12 + 1


def ym_label(ym) -> str:
    return f'{MONTH_ABBR[ym[1] - 1]} {ym[0]}'


def ym_str(ym) -> str:
    return f'{ym[0]:04d}-{ym[1]:02d}'


def month_span(a, b):
    out, cur = [], a
    while cur <= b and len(out) < 60:
        out.append(cur)
        cur = ym_add(cur, 1)
    return out


def name_tokens(name) -> list:
    s = re.sub(r'[^a-z ]', ' ', str(name or '').lower())
    return [
        t
        for t in s.split()
        if t not in {'mr', 'mrs', 'ms', 'dr', 'shri', 'smt'}
    ]


def names_compatible(a, b) -> bool:
    """'Amit S. Patil' ~ 'Amit Suresh Patil' ~ 'AMIT SURESH PATIL'.

    Initials and a missing middle name are OK.
    """
    ta, tb = name_tokens(a), name_tokens(b)
    if not ta or not tb:
        return True
    if ta[0] != tb[0] or ta[-1] != tb[-1]:
        return False
    ma, mb = ta[1:-1], tb[1:-1]
    for x, y in zip(ma, mb):
        if not (
            x == y
            or (len(x) == 1 and y.startswith(x))
            or (len(y) == 1 and x.startswith(y))
        ):
            return False
    return True


_EMP_STOP = {
    'pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'co', 'company',
    'the', 'india', 'corp', 'corporation',
}


def employer_core(name) -> str:
    s = re.sub(r'[^a-z0-9 ]', ' ', str(name or '').lower())
    return ' '.join(t for t in s.split() if t not in _EMP_STOP)


def pct_diff(declared, actual) -> float:
    return abs(declared - actual) / declared if declared else 0.0


def inr(v) -> str:
    """Indian digit grouping: 600000 -> ₹6,00,000."""
    if v is None:
        return '–'
    neg, v = v < 0, abs(v)
    whole, frac = divmod(round(v * 100), 100)
    s = str(int(whole))
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        # groups of 2 from the right
        head = ','.join(re.findall(r'\d{1,2}', head[::-1]))[::-1]
        s = f'{head},{tail}'
    return f"{'-' if neg else ''}₹{s}" + (f'.{frac:02d}' if frac else '')


def lev(a: str, b: str) -> int:
    """Levenshtein distance."""
    a, b = a or '', b or ''
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(
                min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb))
            )
        prev = cur
    return prev[-1]


def _plural(n: int, word: str) -> str:
    return f'{n} {word}' if n == 1 else f'{n} {word}s'


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


# ------------------------------------------------------------------ catalog
def validate_catalog(catalog) -> list:
    """Return a list of human-readable errors (empty when the catalog is valid)."""
    errors = []
    if not isinstance(catalog, dict):
        return ['catalog must be a JSON object']
    if catalog.get('schema_version') != 1:
        errors.append('schema_version must be 1')
    checklists = catalog.get('checklists')
    if not isinstance(checklists, list) or not checklists:
        errors.append('checklists must be a non-empty list')
        checklists = []

    ids = []
    for ci, cl in enumerate(checklists):
        where = f'checklists[{ci}]'
        if not isinstance(cl, dict):
            errors.append(f'{where} must be an object')
            continue
        cid = cl.get('id')
        if not isinstance(cid, str) or not _ID_RE.match(cid):
            errors.append(f'{where}: id {cid!r} must match ^[a-z0-9_]+$')
        else:
            where = f'checklist {cid}'
            if cid in ids:
                errors.append(f'duplicate checklist id {cid!r}')
            ids.append(cid)
        if not isinstance(cl.get('name'), str) or not cl.get('name'):
            errors.append(f'{where}: name must be a non-empty string')
        for key in ('tolerance_pct', 'form16_tolerance_pct'):
            if key in cl and (not _is_number(cl[key]) or cl[key] < 0):
                errors.append(f'{where}: {key} must be a number >= 0')

        items = cl.get('items')
        if not isinstance(items, list):
            errors.append(f'{where}: items must be a list')
            items = []
        item_ids = []
        for ii, item in enumerate(items):
            iwhere = f'{where} items[{ii}]'
            if not isinstance(item, dict):
                errors.append(f'{iwhere} must be an object')
                continue
            iid = item.get('id')
            if not isinstance(iid, str) or not iid:
                errors.append(f'{iwhere}: id must be a non-empty string')
            else:
                iwhere = f'{where} item {iid}'
                if iid in item_ids:
                    errors.append(f'{where}: duplicate item id {iid!r}')
                item_ids.append(iid)
            if not isinstance(item.get('label'), str) or not item.get('label'):
                errors.append(f'{iwhere}: label must be a non-empty string')
            required = item.get('required', True)
            if not isinstance(required, bool):
                errors.append(f'{iwhere}: required must be true or false')
            rule = item.get('rule')
            if not isinstance(rule, dict):
                errors.append(f'{iwhere}: rule must be an object')
                rule = {}
            kind = rule.get('kind')
            if kind not in RULE_KINDS:
                errors.append(
                    f'{iwhere}: rule.kind {kind!r} must be one of '
                    + ', '.join(sorted(RULE_KINDS))
                )
            doc_types = item.get('doc_types', [])
            if not isinstance(doc_types, list):
                errors.append(f'{iwhere}: doc_types must be a list')
                doc_types = []
            bad = [t for t in doc_types if t not in DOC_TYPES]
            if bad:
                errors.append(
                    f'{iwhere}: unknown doc_types {bad}; '
                    f'allowed: {", ".join(DOC_TYPES)}'
                )
            if not doc_types and kind != 'manual':
                errors.append(f'{iwhere}: doc_types must not be empty')
            if kind in ('monthly', 'period'):
                months = rule.get('months')
                if not _is_int(months) or not 1 <= months <= 24:
                    errors.append(
                        f'{iwhere}: rule.months must be an integer 1..24'
                    )
                fields = (
                    ('field',)
                    if kind == 'monthly'
                    else ('from_field', 'to_field')
                )
                for fk in fields:
                    if fk in rule and not (
                        isinstance(rule[fk], str) and rule[fk]
                    ):
                        errors.append(
                            f'{iwhere}: rule.{fk} must be a non-empty string'
                        )
            if kind == 'present' and 'min_count' in rule:
                mc = rule['min_count']
                if not _is_int(mc) or mc < 1:
                    errors.append(
                        f'{iwhere}: rule.min_count must be an integer >= 1'
                    )

        checks = cl.get('consistency_checks', [])
        if not isinstance(checks, list):
            errors.append(f'{where}: consistency_checks must be a list')
        else:
            bad = [c for c in checks if c not in CHECK_IDS]
            if bad:
                errors.append(
                    f'{where}: unknown consistency_checks {bad}; '
                    f'allowed: {", ".join(CHECK_IDS)}'
                )

    default = catalog.get('default_checklist')
    if default not in ids:
        errors.append(
            f'default_checklist {default!r} is not a checklist id '
            f'({", ".join(ids) or "none"})'
        )
    return errors


def load_catalog(path=None) -> dict:
    """Load and validate checklists.json (default: next to this file)."""
    with open(path or DEFAULT_CATALOG_PATH, encoding='utf-8') as fh:
        catalog = json.load(fh)
    errors = validate_catalog(catalog)
    if errors:
        raise ValueError('invalid checklist catalog: ' + '; '.join(errors))
    return catalog


def get_checklist(catalog, checklist_id=None) -> dict:
    cid = checklist_id or catalog.get('default_checklist')
    for cl in catalog.get('checklists', []):
        if cl.get('id') == cid:
            return cl
    raise ValueError(f'Unknown checklist_id: {cid}')


def list_checklists(catalog) -> dict:
    return {
        'default_checklist': catalog.get('default_checklist'),
        'checklists': [
            {
                'id': cl['id'],
                'name': cl.get('name'),
                'product': cl.get('product'),
                'applicant_type': cl.get('applicant_type'),
                'description': cl.get('description'),
                'items': [
                    {
                        'id': it['id'],
                        'label': it.get('label'),
                        'required': _item_required(it),
                        'doc_types': list(it.get('doc_types', [])),
                        'rule': dict(it.get('rule', {})),
                    }
                    for it in cl.get('items', [])
                ],
                'consistency_checks': list(cl.get('consistency_checks', [])),
            }
            for cl in catalog.get('checklists', [])
        ],
    }


def _item_required(item) -> bool:
    # A manual item blocks READY only when the catalog says required: true
    # explicitly (a check the rules cannot verify, e.g. a document type the
    # facts step does not classify); by default it is review-only.
    if (item.get('rule') or {}).get('kind') == 'manual':
        return item.get('required') is True
    return item.get('required', True) is not False


# ------------------------------------------------------------------ documents
def _doc_type(doc) -> str:
    t = doc.get('doc_type') or (doc.get('fields') or {}).get('doc_type')
    return t if t in DOC_TYPES else 'other'


def _to_engine_doc(rec) -> dict:
    """FACTS# data (or any doc-like dict) -> engine doc."""
    return {
        'document_id': rec.get('document_id'),
        'document_name': rec.get('document_name') or rec.get('document_id') or '',
        'doc_type': _doc_type(rec),
        'fields': dict(rec.get('fields') or {}),
        'grounding': rec.get('grounding'),
    }


def _sort_key(doc):
    return (str(doc.get('document_name') or ''), str(doc.get('document_id') or ''))


def _norm_pan(v):
    s = re.sub(r'\s', '', str(v or '')).upper()
    return s or None


def _name_of(doc):
    n = doc['fields'].get('applicant_name')
    return n if n and name_tokens(n) else None


def _display_name(docs):
    id_names = [
        d['fields']['applicant_name']
        for d in docs
        if d['doc_type'] == 'identity_details' and d['fields'].get('applicant_name')
    ]
    if id_names:
        return id_names[0]
    names = [
        d['fields']['applicant_name']
        for d in docs
        if d['fields'].get('applicant_name')
    ]
    return max(names, key=len) if names else 'Unknown'


def _group_pan(docs):
    id_pans = [
        _norm_pan(d['fields'].get('pan'))
        for d in docs
        if d['doc_type'] == 'identity_details' and d['fields'].get('pan')
    ]
    if id_pans:
        return id_pans[0]
    pans = [_norm_pan(d['fields'].get('pan')) for d in docs if d['fields'].get('pan')]
    if not pans:
        return None
    counts = Counter(pans)
    best = max(counts.values())
    # ties: first in document_name order
    return next(p for p in pans if counts[p] == best)


def group_applicants(docs):
    """Group documents by applicant (deterministic union-find).

    Returns (groups, unassigned); both in document_name order.
    """
    docs = sorted((_to_engine_doc(d) for d in docs), key=_sort_key)
    keyed, loose = [], []
    for d in docs:
        has_key = _norm_pan(d['fields'].get('pan')) or _name_of(d)
        (keyed if has_key else loose).append(d)

    parent = list(range(len(keyed)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i, j):
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[max(ri, rj)] = min(ri, rj)

    for i in range(len(keyed)):
        for j in range(i + 1, len(keyed)):
            a, b = keyed[i], keyed[j]
            pa, pb = _norm_pan(a['fields'].get('pan')), _norm_pan(b['fields'].get('pan'))
            na, nb = _name_of(a), _name_of(b)
            names_ok = bool(na and nb and names_compatible(na, nb))
            if pa and pb:
                if pa == pb or (lev(pa, pb) <= 2 and names_ok):
                    union(i, j)
            elif names_ok:
                union(i, j)

    buckets = {}
    for i, d in enumerate(keyed):
        buckets.setdefault(find(i), []).append(d)
    groups = [buckets[k] for k in sorted(buckets)]
    unassigned = []
    if len(groups) == 1:
        groups[0] = sorted(groups[0] + loose, key=_sort_key)
    else:
        unassigned = loose
    return groups, unassigned


# ------------------------------------------------------------------ evaluation
def _parse_ym(v):
    """reference_month override 'YYYY-MM' -> (y, m); None when not given."""
    if v is None or v == '':
        return None
    if isinstance(v, tuple):
        return v
    ym = to_month(v) if isinstance(v, str) and _YM_RE.match(v.strip()) else None
    if not ym:
        raise ValueError(f'reference_month must be YYYY-MM, got {v!r}')
    return ym


def _item_docs(docs, item):
    types = set(item.get('doc_types') or [])
    return [d for d in docs if d['doc_type'] in types]


def _noun(item):
    types = item.get('doc_types') or []
    if len(types) == 1:
        return _DOC_NOUNS.get(types[0], 'documents')
    return 'documents'


def _reference_month(docs, items, override=None):
    ref = _parse_ym(override)
    if ref:
        return ref
    months = []
    for item in items:
        rule = item.get('rule') or {}
        if rule.get('kind') == 'monthly':
            fld = rule.get('field') or 'month'
            for d in _item_docs(docs, item):
                ym = to_month(d['fields'].get(fld))
                if ym:
                    months.append(ym)
    if months:
        return max(months)
    ends = []
    for item in items:
        rule = item.get('rule') or {}
        if rule.get('kind') == 'period':
            tf = rule.get('to_field') or 'statement_to'
            for d in _item_docs(docs, item):
                t = to_date(d['fields'].get(tf))
                if t:
                    ends.append((t.year, t.month))
    return max(ends) if ends else None


def _eval_present(item, docs):
    rule = item.get('rule') or {}
    min_count = rule.get('min_count', 1) or 1
    names = [d['document_name'] for d in docs]
    ok = len(docs) >= min_count
    if not docs:
        detail = 'not found in the file'
    elif ok:
        detail = ', '.join(names)
    else:
        detail = f'{len(docs)} of {min_count} found: ' + ', '.join(names)
    return {'ok': ok, 'detail': detail, 'documents': names}, None


def _eval_monthly(item, docs, ref):
    rule = item.get('rule') or {}
    months_n = rule.get('months')
    fld = rule.get('field') or 'month'
    noun = _noun(item)
    unit = 'slip(s)' if noun == 'salary slips' else 'document(s)'
    by_month = {}
    for d in docs:
        ym = to_month(d['fields'].get(fld))
        if ym:
            by_month.setdefault(ym, []).append(d['document_name'])
    names = [d['document_name'] for d in docs]
    if not ref:
        detail = (
            f'no {noun} found'
            if not docs
            else f'no {noun} with a readable {fld} found'
        )
        return (
            {'ok': False, 'detail': detail, 'documents': names if docs else []},
            ([], []),
        )
    need = [ym_add(ref, -i) for i in range(months_n - 1, -1, -1)]
    missing = [m for m in need if m not in by_month]
    found = (
        ', '.join(
            f"{ym_label(m)} ({', '.join(by_month[m])})" for m in sorted(by_month)
        )
        or 'none'
    )
    if not missing:
        detail = (
            f'{len(need)} of {months_n} present '
            f'({ym_label(need[0])} – {ym_label(need[-1])})'
        )
    else:
        detail = (
            f"missing {', '.join(ym_label(m) for m in missing)} {unit}; "
            f'found: {found}'
        )
    return {'ok': not missing, 'detail': detail, 'documents': names}, (need, missing)


def _eval_period(item, docs, ref):
    rule = item.get('rule') or {}
    months_n = rule.get('months')
    ff = rule.get('from_field') or 'statement_from'
    tf = rule.get('to_field') or 'statement_to'
    noun = _noun(item)
    covered_months, end = set(), None
    for d in docs:
        f, t = to_date(d['fields'].get(ff)), to_date(d['fields'].get(tf))
        if f and t:
            covered_months.update(month_span((f.year, f.month), (t.year, t.month)))
            end = max(end or (t.year, t.month), (t.year, t.month))
    names = [d['document_name'] for d in docs]
    if not (docs and end):
        detail = f'no {noun} (with a readable period) found'
        if ref:
            need = [ym_add(ref, -i) for i in range(months_n - 1, -1, -1)]
            return {'ok': False, 'detail': detail, 'documents': names}, (need, need)
        return {'ok': False, 'detail': detail, 'documents': names}, ([], [])
    end = max(end, ref) if ref else end
    need = [ym_add(end, -i) for i in range(months_n - 1, -1, -1)]
    missing = [m for m in need if m not in covered_months]
    covered = sorted(m for m in covered_months if m in need)
    files = ', '.join(names)
    if missing:
        detail = (
            f'covers {len(covered)} of {months_n} months '
            f'({ym_label(min(covered_months))} – {ym_label(max(covered_months))}); '
            f"missing {', '.join(ym_label(m) for m in missing)} [{files}]"
        )
    else:
        detail = (
            f'{months_n} of {months_n} months '
            f'({ym_label(need[0])} – {ym_label(need[-1])}) [{files}]'
        )
    return {'ok': not missing, 'detail': detail, 'documents': names}, (need, missing)


def _eval_manual(item, docs):
    names = [d['document_name'] for d in docs]
    detail = 'cannot be verified automatically; review manually'
    if names:
        detail += ' (related: ' + ', '.join(names) + ')'
    return {'ok': None, 'detail': detail, 'documents': names}, None


def _consistency(docs, checklist, tol, f16_tol):
    """Plan B consistency checks, limited to checklist.consistency_checks."""
    enabled = set(checklist.get('consistency_checks') or [])
    by_type = {}
    for d in docs:
        by_type.setdefault(d['doc_type'], []).append(d)
    rows, reasons, mismatches = [], [], []

    def add_check(check_id, status, detail, files=(), name=None):
        name = name or CHECK_NAMES.get(check_id, check_id)
        rows.append(
            {
                'check_id': check_id,
                'check': name,
                'status': status,
                'detail': detail,
                'documents': list(files),
            }
        )
        if status == 'MISMATCH':
            reasons.append(f'MISMATCH – {name}: {detail}')
            mismatches.append(f'{name}: {detail}')

    # PAN
    if 'pan' in enabled:
        pans = [
            (d['document_name'], _norm_pan(d['fields']['pan']))
            for d in docs
            if d['fields'].get('pan')
        ]
        distinct = sorted({p for _, p in pans})
        if not pans:
            add_check('pan', 'N/A', 'no PAN found on any document')
        elif len(distinct) == 1:
            add_check(
                'pan',
                'OK',
                f'{distinct[0]} on all {len(pans)} documents that carry a PAN',
                [f for f, _ in pans],
            )
        else:
            groups = {p: [f for f, q in pans if q == p] for p in distinct}
            parts = [
                f"{p} on {', '.join(fs)}"
                for p, fs in sorted(groups.items(), key=lambda kv: len(kv[1]))
            ]
            extra = ''
            if len(distinct) == 2 and len(distinct[0]) == len(distinct[1]):
                pos = [
                    i + 1
                    for i, (x, y) in enumerate(zip(*distinct))
                    if x != y
                ]
                extra = f" (differs at character {', '.join(map(str, pos))})"
            add_check(
                'pan', 'MISMATCH', '; '.join(parts) + extra, [f for f, _ in pans]
            )

    # Aadhaar (masked last 4)
    if 'aadhaar_last4' in enabled:
        aad = [
            (d['document_name'], str(d['fields']['masked_aadhaar_last4']))
            for d in docs
            if d['fields'].get('masked_aadhaar_last4')
        ]
        if aad:
            vals = sorted({a for _, a in aad})
            if len(vals) == 1:
                add_check(
                    'aadhaar_last4',
                    'OK',
                    f"XXXX-XXXX-{vals[0]} on {', '.join(f for f, _ in aad)}",
                    [f for f, _ in aad],
                )
            else:
                add_check(
                    'aadhaar_last4',
                    'MISMATCH',
                    '; '.join(f'XXXX-XXXX-{a} on {f}' for f, a in aad),
                    [f for f, _ in aad],
                )

    # Applicant name
    names = [
        (d['document_name'], d['fields']['applicant_name'])
        for d in docs
        if d['fields'].get('applicant_name')
    ]
    if 'applicant_name' in enabled and names:
        id_names = [
            d['fields']['applicant_name']
            for d in by_type.get('identity_details', [])
            if d['fields'].get('applicant_name')
        ]
        anchor = id_names[0] if id_names else max((n for _, n in names), key=len)
        bad = [(f, n) for f, n in names if not names_compatible(anchor, n)]
        variants = sorted({str(n).strip() for _, n in names})
        if bad:
            add_check(
                'applicant_name',
                'MISMATCH',
                f"'{anchor}' vs " + '; '.join(f"'{n}' on {f}" for f, n in bad),
                [f for f, _ in names],
            )
        else:
            note = (
                'identical'
                if len({' '.join(name_tokens(n)) for _, n in names}) == 1
                else 'acceptable variants: '
                + ' / '.join(f"'{v}'" for v in variants)
            )
            add_check(
                'applicant_name',
                'OK',
                f'{note} across {len(names)} documents',
                [f for f, _ in names],
            )

    # Employer (documents) + bank salary-credit narration
    stmts = by_type.get('bank_statement', [])
    slips = by_type.get('salary_slip', [])
    emps = [
        (d['document_name'], d['fields']['employer'])
        for d in docs
        if d['fields'].get('employer') and d['doc_type'] != 'bank_statement'
    ]
    credits = [
        (d['document_name'], c)
        for d in stmts
        for c in d['fields'].get('salary_credits') or []
        if isinstance(c, dict) and c.get('amount')
    ]
    if emps:
        cores = {employer_core(e) for _, e in emps}
        variants = sorted({str(e) for _, e in emps})
        if len(cores) > 1:
            if 'employer' in enabled:
                add_check(
                    'employer',
                    'MISMATCH',
                    '; '.join(f"'{e}' on {f}" for f, e in emps),
                    [f for f, _ in emps],
                )
        else:
            core = cores.pop()
            if 'employer' in enabled:
                note = (
                    f"'{variants[0]}'"
                    if len(variants) == 1
                    else 'acceptable variants: '
                    + ' / '.join(f"'{v}'" for v in variants)
                )
                add_check(
                    'employer',
                    'OK',
                    f'{note} across {len(emps)} documents',
                    [f for f, _ in emps],
                )
            if 'employer_vs_bank_credits' in enabled and credits:
                narr = sorted({c.get('narration') or '' for _, c in credits})
                ok = all(
                    set(core.split())
                    <= set(re.sub(r'[^a-z0-9 ]', ' ', n.lower()).split())
                    for n in narr
                )
                add_check(
                    'employer_vs_bank_credits',
                    'OK' if ok else 'MISMATCH',
                    (
                        'narration matches employer: '
                        if ok
                        else f"employer '{variants[0]}' not in narration: "
                    )
                    + '; '.join(f"'{n}'" for n in narr[:2])
                    + f' [{credits[0][0]}]',
                    [credits[0][0]],
                )

    # Income: declared (application) vs slips vs bank credits
    app = (by_type.get('loan_application') or [None])[0]
    declared = app['fields'].get('declared_net_salary') if app else None
    slip_net = [
        (d['document_name'], d['fields']['net_salary'])
        for d in slips
        if d['fields'].get('net_salary')
    ]
    slip_gross = [
        (d['document_name'], d['fields']['gross_salary'])
        for d in slips
        if d['fields'].get('gross_salary')
    ]
    net_med = median(v for _, v in slip_net) if slip_net else None
    gross_med = median(v for _, v in slip_gross) if slip_gross else None
    bank_med = median(c['amount'] for _, c in credits) if credits else None
    f16 = [
        (d['document_name'], d['fields']['gross_salary'])
        for d in by_type.get('form16_itr', [])
        if d['fields'].get('gross_salary')
    ]
    income = {
        'declared_net': declared,
        'slip_net': net_med,
        'slip_gross': gross_med,
        'bank_salary_credit': bank_med,
        'form16_gross': f16[0][1] if f16 else None,
        'slip_gross_x12': gross_med * 12 if gross_med else None,
        'bank_credits': [
            {'document_name': f, 'date': c.get('date'), 'amount': c['amount']}
            for f, c in credits
        ],
    }

    if 'declared_vs_slip_net' in enabled and declared and net_med:
        d = pct_diff(declared, net_med)
        status = 'MISMATCH' if d > tol else 'OK'
        detail = (
            f"declared {inr(declared)} [{app['document_name']}] vs slip net "
            f'{inr(net_med)} [{", ".join(f for f, _ in slip_net)}] – {d:.1%} apart'
        )
        if status == 'MISMATCH' and gross_med and pct_diff(declared, gross_med) <= 0.01:
            detail += (
                f'; declared amount equals slip GROSS {inr(gross_med)} '
                '→ gross appears declared as net'
            )
        add_check(
            'declared_vs_slip_net',
            status,
            detail,
            [app['document_name']] + [f for f, _ in slip_net],
        )
    if 'declared_vs_bank_credits' in enabled and declared and bank_med:
        d = pct_diff(declared, bank_med)
        dates = ', '.join(str(c.get('date')) for _, c in credits)
        detail = (
            f"declared {inr(declared)} [{app['document_name']}] vs bank salary "
            f'credits {inr(bank_med)} ({len(credits)} credits on {dates}) '
            f'[{credits[0][0]}] – {inr(abs(declared - bank_med))}/month, '
            f'{d:.1%} apart'
        )
        add_check(
            'declared_vs_bank_credits',
            'MISMATCH' if d > tol else 'OK',
            detail,
            [app['document_name'], credits[0][0]],
        )
    if 'slip_net_vs_bank_credits' in enabled and net_med and bank_med:
        d = pct_diff(net_med, bank_med)
        add_check(
            'slip_net_vs_bank_credits',
            'MISMATCH' if d > tol else 'OK',
            f'slip net {inr(net_med)} vs bank credit {inr(bank_med)} – '
            f'{d:.1%} apart',
            [f for f, _ in slip_net] + [credits[0][0]],
        )
    # Form-16 annual gross vs 12 x slip gross (informational only)
    if 'form16_vs_slip_gross' in enabled and f16 and gross_med:
        f16_file, f16_gross = f16[0]
        annual = gross_med * 12
        d = pct_diff(f16_gross, annual)
        add_check(
            'form16_vs_slip_gross',
            'OK' if d <= f16_tol else 'INFO',
            f'Form-16 annual gross {inr(f16_gross)} [{f16_file}] vs 12 × slip '
            f'gross {inr(gross_med)} = {inr(annual)} – {d:.1%} apart'
            + (' (reconciles)' if d <= f16_tol else ' (check increments / arrears)'),
            [f16_file] + [f for f, _ in slip_gross],
        )
    declared_checks = {'declared_vs_slip_net', 'declared_vs_bank_credits'}
    if not declared and enabled & declared_checks:
        add_check(
            'declared_net_salary',
            'N/A',
            'no declared net salary found (application missing or blank)',
            name='Declared net salary',
        )

    unknown = by_type.get('other', [])
    if unknown:
        rows.append(
            {
                'check_id': 'unclassified_documents',
                'check': 'Unclassified documents',
                'status': 'INFO',
                'detail': ', '.join(d['document_name'] for d in unknown),
                'documents': [d['document_name'] for d in unknown],
            }
        )
    return rows, reasons, mismatches, income


def _grounding_view(doc):
    g = doc.get('grounding')
    if isinstance(g, dict):
        return (
            g.get('grounded'),
            list(g.get('notes') or []),
            list(g.get('unverified_fields') or []),
        )
    if isinstance(g, list):
        return None, list(g), []
    return None, [], []


def evaluate_applicant(docs, checklist, reference_month=None) -> dict:
    """Apply one checklist to one applicant's documents (see interfaces s.4/5)."""
    docs = sorted((_to_engine_doc(d) for d in docs), key=_sort_key)
    items = checklist.get('items') or []
    tol = checklist.get('tolerance_pct', DEFAULT_TOLERANCE_PCT) / 100
    f16_tol = (
        checklist.get('form16_tolerance_pct', DEFAULT_FORM16_TOLERANCE_PCT) / 100
    )
    ref = _reference_month(docs, items, reference_month)

    rows, reasons, missing_items, manual_review = [], [], [], []
    for item in items:
        rule = item.get('rule') or {}
        kind = rule.get('kind')
        label = item.get('label') or item.get('id')
        required = _item_required(item)
        idocs = _item_docs(docs, item)
        months = None
        if kind == 'present':
            res, _ = _eval_present(item, idocs)
        elif kind == 'monthly':
            res, months = _eval_monthly(item, idocs, ref)
        elif kind == 'period':
            res, months = _eval_period(item, idocs, ref)
        else:
            res, _ = _eval_manual(item, idocs)
        if kind == 'manual':
            status = 'REVIEW'
            manual_review.append(label)
        else:
            status = 'PRESENT' if res['ok'] else 'MISSING'
        row = {
            'item_id': item.get('id'),
            'item': label,
            'required': required,
            'status': status,
            'ok': res['ok'],
            'detail': res['detail'],
            'documents': res['documents'],
        }
        if months is not None:
            row['required_months'] = [ym_str(m) for m in months[0]]
            row['missing_months'] = [ym_str(m) for m in months[1]]
        rows.append(row)
        if status == 'REVIEW' and required:
            reasons.append(f"REVIEW – {label}: {res['detail']}")
        if status == 'MISSING' and required:
            reasons.append(f"MISSING – {label}: {res['detail']}")
            missing = months[1] if months else []
            if missing:
                prefix = item.get('missing_label') or label
                missing_items.append(
                    f"{prefix}: {', '.join(ym_label(m) for m in missing)}"
                )
            else:
                missing_items.append(label)

    consistency, c_reasons, mismatches, income = _consistency(
        docs, checklist, tol, f16_tol
    )
    reasons.extend(c_reasons)

    ready = all(
        r['status'] == 'PRESENT' for r in rows if r['required']
    ) and not any(c['status'] == 'MISMATCH' for c in consistency)

    documents = []
    for d in docs:
        grounded, notes, unverified = _grounding_view(d)
        documents.append(
            {
                'document_id': d['document_id'],
                'document_name': d['document_name'],
                'doc_type': d['doc_type'],
                'grounded': grounded,
                'grounding_notes': notes,
                'unverified_fields': unverified,
            }
        )

    return {
        'applicant': _display_name(docs),
        'pan': _group_pan(docs),
        'verdict': 'READY' if ready else 'NOT READY',
        'reference_month': ym_str(ref) if ref else None,
        'reference_month_label': ym_label(ref) if ref else None,
        'documents': documents,
        'checklist': rows,
        'consistency': consistency,
        'income': income,
        'reasons': reasons,
        'missing_items': missing_items,
        'mismatches': mismatches,
        'manual_review': manual_review,
    }


# ------------------------------------------------------------------ file check
def _applicant_matches(group, applicant) -> bool:
    want_pan = _norm_pan(applicant)
    pans = {_norm_pan(d['fields'].get('pan')) for d in group if d['fields'].get('pan')}
    if want_pan and want_pan in pans:
        return True
    display = _display_name(group)
    return bool(
        name_tokens(applicant)
        and display != 'Unknown'
        and names_compatible(applicant, display)
    )


def _classify(facts, documents):
    """Split project items into engine docs and the reporting buckets."""
    pending, failed, no_facts, unsupported = [], [], [], []
    engine_docs = []
    if documents is None:
        for f in facts or []:
            if not isinstance(f, dict):
                continue
            if f.get('status', 'completed') == 'completed':
                engine_docs.append(_to_engine_doc(f))
            else:
                no_facts.append(
                    {
                        'document_id': f.get('document_id'),
                        'document_name': f.get('document_name') or f.get('document_id'),
                        'reason': _no_facts_reason(f),
                    }
                )
        return engine_docs, pending, failed, no_facts, unsupported

    facts_by_id = {
        f.get('document_id'): f for f in facts or [] if isinstance(f, dict)
    }
    docs = [d for d in documents if isinstance(d, dict)]
    for doc in sorted(
        docs, key=lambda d: (str(d.get('name') or ''), str(d.get('document_id') or ''))
    ):
        did = doc.get('document_id')
        fact = facts_by_id.get(did)
        name = doc.get('name') or (fact or {}).get('document_name') or did
        status = doc.get('status')
        file_type = str(doc.get('file_type') or '').split(';')[0].strip().lower()
        fact_ok = bool(fact) and fact.get('status') == 'completed'
        spreadsheet = file_type in UNSUPPORTED_FILE_TYPES or (
            file_type in ('', 'application/octet-stream')
            and str(name or '').lower().endswith(UNSUPPORTED_EXTENSIONS)
        )
        if spreadsheet:
            unsupported.append(
                {
                    'document_id': did,
                    'document_name': name,
                    'file_type': doc.get('file_type'),
                    'reason': UNSUPPORTED_REASON,
                }
            )
        elif status not in ('completed', 'failed'):
            pending.append({'document_id': did, 'document_name': name, 'status': status})
        elif status == 'failed' and not fact_ok:
            failed.append({'document_id': did, 'document_name': name})
        elif not fact_ok:
            no_facts.append(
                {
                    'document_id': did,
                    'document_name': name,
                    'reason': _no_facts_reason(fact),
                }
            )
        else:
            engine_docs.append(_to_engine_doc({**fact, 'document_name': name}))
    return engine_docs, pending, failed, no_facts, unsupported


def _no_facts_reason(fact):
    if not fact:
        return 'no facts extracted for this document yet'
    status = fact.get('status')
    if status == 'skipped':
        return f"facts skipped: {fact.get('reason') or 'no text'}"
    if status == 'failed':
        return 'facts extraction failed'
    return f'facts status {status}'


def _as_of(as_of):
    if isinstance(as_of, datetime):
        return as_of.date().isoformat()
    if isinstance(as_of, date):
        return as_of.isoformat()
    if as_of:
        return str(as_of)
    return datetime.now(timezone.utc).date().isoformat()


def run_file_check(
    facts,
    checklist,
    documents=None,
    reference_month=None,
    applicant=None,
    as_of=None,
    project_id=None,
) -> dict:
    """Full run_file_check response (interfaces section 5)."""
    engine_docs, pending, failed, no_facts, unsupported = _classify(facts, documents)
    groups, unassigned = group_applicants(engine_docs)
    if applicant:
        groups = [g for g in groups if _applicant_matches(g, applicant)]

    applicants = [evaluate_applicant(g, checklist, reference_month) for g in groups]
    if pending:
        names = ', '.join(p['document_name'] or p['document_id'] for p in pending)
        reason = (
            f'PENDING – {len(pending)} document(s) still being analysed: {names}'
        )
        for a in applicants:
            a['verdict'] = 'NOT READY'
            a['reasons'].insert(0, reason)

    overall = (
        'READY'
        if applicants
        and not pending
        and all(a['verdict'] == 'READY' for a in applicants)
        else 'NOT READY'
    )

    if applicants:
        parts = []
        for a in applicants:
            part = f"{a['applicant']} {a['verdict']}"
            if a['verdict'] != 'READY' and a['reasons']:
                part += f" ({_plural(len(a['reasons']), 'issue')})"
            parts.append(part)
        summary = f"{_plural(len(applicants), 'applicant')}: " + '; '.join(parts)
    elif applicant:
        summary = f"No applicant matching '{applicant}'"
    elif unassigned:
        summary = (
            'No applicant could be identified '
            f'({_plural(len(unassigned), "unassigned document")})'
        )
    else:
        summary = 'No analysed documents found in this project'

    if project_id is None:
        for src in list(documents or []) + list(facts or []):
            if isinstance(src, dict) and src.get('project_id'):
                project_id = src['project_id']
                break

    return {
        'project_id': project_id,
        'engine_version': ENGINE_VERSION,
        'as_of': _as_of(as_of),
        'checklist': {'id': checklist.get('id'), 'name': checklist.get('name')},
        'overall_verdict': overall,
        'summary': summary,
        'applicants': applicants,
        'pending_documents': pending,
        'failed_documents': failed,
        'no_facts_documents': no_facts,
        'unsupported_documents': unsupported,
        'unassigned_documents': [
            {
                'document_id': d['document_id'],
                'document_name': d['document_name'],
                'doc_type': d['doc_type'],
            }
            for d in unassigned
        ],
        'assistant_instructions': ASSISTANT_INSTRUCTIONS,
    }
