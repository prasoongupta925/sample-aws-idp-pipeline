"""Bundled ready-made brand rule sets (Smart Solutions / Loan Sarathi).

checklists.json ships the default salaried PL checklist followed by the 22
brand rule sets converted from ready-made/checklists/checklists.json with
convert_checklists.convert_ready_made. These tests load the bundle, pin the
mapping rules on a small inline sample of the research format and, when the
research file is on this machine, check that the bundle is up to date.
"""

import copy
import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import convert_checklists as cc  # noqa: E402
import engine  # noqa: E402
from test_filecheck_engine import amit, rahul, sneha  # noqa: E402

EN = '–'

# <repo>/../smartdial-idp-pitch/ready-made/checklists/checklists.json
READY_MADE_PATH = os.environ.get('READY_MADE_CHECKLISTS') or os.path.join(
    HERE, '..', '..', '..', '..', 'smartdial-idp-pitch', 'ready-made',
    'checklists', 'checklists.json',
)

BRAND_IDS = [
    'ss_pl_sal', 'ss_pl_se', 'ss_bl_se', 'ss_hl_sal', 'ss_hl_se',
    'ss_lap_sal', 'ss_lap_se', 'ss_cl_sal', 'ss_cl_se', 'ss_el_stu_cosal',
    'ss_el_stu_cose', 'ls_pl_sal', 'ls_pl_se', 'ls_bl_se', 'ls_hl_sal',
    'ls_hl_se', 'ls_lap_sal', 'ls_lap_se', 'ls_el_stu_cosal', 'ls_el_stu_cose',
    'ls_cl_sal', 'ls_cl_se',
]


@pytest.fixture(scope='module')
def catalog():
    return engine.load_catalog()


def _items(checklist):
    return {i['id']: i for i in checklist['items']}


def _rows(applicant):
    return {r['item_id']: r for r in applicant['checklist']}


def _kinds(reasons):
    return [r.split(f' {EN} ', 1)[0] for r in reasons]


# ------------------------------------------------------------------ bundle
def test_bundle_has_default_then_brand_rule_sets(catalog):
    assert engine.validate_catalog(catalog) == []
    assert catalog['default_checklist'] == 'salaried_personal_loan'
    assert [c['id'] for c in catalog['checklists']] == [
        'salaried_personal_loan', *BRAND_IDS]
    listed = engine.list_checklists(catalog)
    names = {c['id']: c['name'] for c in listed['checklists']}
    assert names['ss_pl_sal'] == 'Smart Solutions - Personal Loan - Salaried'
    assert names['ls_el_stu_cose'] == (
        'Loan Sarathi - Education Loan - Student (self-employed co-applicant)')


def test_every_brand_rule_set_needs_a_person_before_ready(catalog):
    """Each brand list has blockers the rules cannot verify (e.g. PAN format,
    DOB), so none of them can say READY on machine checks alone."""
    for cid in BRAND_IDS:
        cl = engine.get_checklist(catalog, cid)
        items = cl['items']
        assert any(i['rule']['kind'] != 'manual' for i in items), cid
        assert all(
            i['doc_types'] == [] for i in items if i['rule']['kind'] == 'manual'
        ), cid
        assert any(
            i['rule']['kind'] == 'manual' and i['required'] for i in items
        ), cid
        a = engine.run_file_check(rahul(), cl)['applicants'][0]
        assert a['verdict'] == 'NOT READY', cid
        assert 'REVIEW' in _kinds(a['reasons']), cid


# ------------------------------------------------------------------ golden
def test_ss_pl_sal_demo_applicants(catalog):
    """Research file expected_outcomes for SS-PL-SAL: all NOT READY; Sneha
    fails SS-PL-03/04 + X07/X08, Amit fails X03, and SS-PL-02 (address proof)
    needs a person for everyone."""
    cl = engine.get_checklist(catalog, 'ss_pl_sal')

    r = engine.run_file_check(rahul(), cl)['applicants'][0]
    assert r['verdict'] == 'NOT READY'
    assert set(_kinds(r['reasons'])) == {'REVIEW'}
    assert r['missing_items'] == [] and r['mismatches'] == []
    rows = _rows(r)
    assert rows['ss_pl_02']['status'] == 'REVIEW'
    assert rows['ss_pl_02']['item'] == 'Address Proof (Passport/Utility Bill)'
    for iid in ('ss_pl_01', 'ss_pl_03', 'ss_pl_04'):
        assert rows[iid]['status'] == 'PRESENT', iid
    assert all(c['status'] != 'MISMATCH' for c in r['consistency'])

    s = engine.run_file_check(sneha(), cl)['applicants'][0]
    assert s['verdict'] == 'NOT READY'
    assert s['missing_items'] == [
        'Salary slip: Jun 2026', 'Bank statement: Mar 2026, Apr 2026, May 2026']
    assert [m.split(':')[0] for m in s['mismatches']] == [
        'Declared net salary vs salary slips',
        'Declared net salary vs bank credits',
    ]
    assert 'gross appears declared as net' in s['mismatches'][0]  # X10

    a = engine.run_file_check(amit(), cl)['applicants'][0]
    assert a['verdict'] == 'NOT READY'
    assert a['missing_items'] == []
    assert [m.split(':')[0] for m in a['mismatches']] == ['PAN']


def test_ls_pl_sal_needs_employment_proof(catalog):
    cl = engine.get_checklist(catalog, 'ls_pl_sal')
    a = engine.run_file_check(rahul(), cl)['applicants'][0]
    assert a['verdict'] == 'NOT READY'
    assert (
        'Employment Proof: Company ID Card / Appointment Letter'
        in a['manual_review']
    )
    assert a['missing_items'] == [] and a['mismatches'] == []


# ------------------------------------------------------------------ mapping
SAMPLE = {
    'schema_version': '1.0.0',
    'captured': '2026-09-27',
    'doc_types': {'identity_proof': {}, 'address_proof': {}},
    'parameters': {'income_tolerance_pct': {'value': 7}},
    'cross_checks': [
        {'check_id': 'X02', 'name': 'PAN format', 'severity': 'blocker'},
        {'check_id': 'X12', 'name': 'EMI debits', 'severity': 'warning'},
    ],
    'checklists': [
        {
            'checklist_id': 'XX-PL-SAL',
            'brand_name': 'Example DSA',
            'product': 'Personal Loan',
            'product_key': 'personal_loan',
            'applicant_type': 'salaried',
            'source_url': 'https://example.invalid/pl',
            'documents': [
                {'rule_id': 'XX-01', 'label': 'Identity proof',
                 'doc_type': 'identity_proof', 'min_count': 1, 'period': None,
                 'applies_to': 'both', 'required': True, 'severity': 'blocker'},
                {'rule_id': 'XX-02', 'label': 'Address proof',
                 'doc_type': 'address_proof', 'min_count': 1, 'period': None,
                 'applies_to': 'both', 'required': True, 'severity': 'blocker'},
                {'rule_id': 'XX-03', 'label': 'Last 3 months salary slips',
                 'doc_type': 'salary_slip', 'min_count': 3,
                 'period': {'unit': 'month', 'length': 3},
                 'applies_to': 'salaried', 'required': True,
                 'severity': 'blocker'},
                {'rule_id': 'XX-04', 'label': 'Last 6 months bank statement',
                 'doc_type': 'bank_statement', 'min_count': 1,
                 'period': {'unit': 'month', 'length': 6},
                 'applies_to': 'both', 'required': True, 'severity': 'blocker'},
                {'rule_id': 'XX-05', 'label': 'Last 2 years ITR',
                 'doc_type': 'itr', 'min_count': 2,
                 'period': {'unit': 'fy', 'length': 2},
                 'applies_to': 'salaried', 'required': True,
                 'severity': 'warning'},
                {'rule_id': 'XX-06', 'label': 'Co-applicant KYC',
                 'doc_type': 'kyc', 'min_count': 1, 'period': None,
                 'applies_to': 'co_applicant', 'required': True,
                 'severity': 'blocker'},
                {'rule_id': 'XX-07', 'label': 'Collateral papers',
                 'doc_type': 'collateral_documents', 'min_count': 1,
                 'period': None,
                 'applies_to': 'conditional(loan.amount > 750000)',
                 'required': False, 'severity': 'warning'},
            ],
            'checks': [
                {'check_id': 'XX-E01', 'kind': 'eligibility',
                 'verbatim': 'Minimum income 25,000/month',
                 'severity': 'blocker'},
                {'check_id': 'XX-E02', 'kind': 'eligibility',
                 'verbatim': 'Credit score 750+', 'severity': 'warning'},
            ],
            'cross_check_ids': ['X01', 'X02', 'X03', 'X06', 'X10', 'X11', 'X12'],
        }
    ],
}


def test_ready_made_mapping_rules():
    assert cc.is_ready_made(SAMPLE)
    catalog, warnings = cc.convert(copy.deepcopy(SAMPLE))
    assert warnings == []
    assert engine.validate_catalog(catalog) == []
    assert catalog['default_checklist'] == 'xx_pl_sal'
    cl = catalog['checklists'][0]
    assert cl['name'] == 'Example DSA - Personal Loan - Salaried'
    assert cl['product'] == 'personal_loan'
    assert cl['tolerance_pct'] == 7
    items = _items(cl)
    assert list(items) == [
        'xx_01', 'xx_02', 'xx_03', 'xx_04', 'xx_05', 'xx_06', 'xx_07',
        'xx_e01', 'xx_e02', 'x02', 'x12',
    ]
    assert items['xx_01'] == {
        'id': 'xx_01', 'label': 'Identity proof',
        'doc_types': ['identity_details'], 'required': True,
        'rule': {'kind': 'present'},
    }
    manual = {'kind': 'manual'}
    # Address proof variants cannot be told apart from PAN / Aadhaar
    assert items['xx_02']['rule'] == manual and items['xx_02']['required']
    assert items['xx_03']['rule'] == {
        'kind': 'monthly', 'months': 3, 'field': 'month'}
    assert items['xx_03']['missing_label'] == 'Salary slip'
    assert items['xx_04']['rule']['kind'] == 'period'
    assert items['xx_04']['rule']['months'] == 6
    # ITR for 2 FYs: two documents; severity warning never blocks
    assert items['xx_05']['doc_types'] == ['form16_itr']
    assert items['xx_05']['rule'] == {'kind': 'present', 'min_count': 2}
    assert items['xx_05']['required'] is False
    # Co-applicant documents need a person (the engine has no roles)
    assert items['xx_06']['rule'] == manual and items['xx_06']['required']
    assert items['xx_07']['rule'] == manual
    assert items['xx_07']['required'] is False
    assert items['xx_07']['label'] == (
        'Collateral papers (only if loan.amount > 750000)')
    assert items['xx_e01']['label'] == (
        'Eligibility: Minimum income 25,000/month')
    assert items['xx_e01']['required'] is True
    assert items['xx_e02']['required'] is False
    assert items['x02']['label'] == 'Cross-check: PAN format'
    assert items['x02']['required'] is True
    assert items['x12']['required'] is False
    # X01/X03/X06 map to engine checks; X10/X11 are covered elsewhere.
    # Slips + Form-16/ITR add the INFO-only Form-16 gross check.
    assert cl['consistency_checks'] == [
        'pan', 'applicant_name', 'employer', 'employer_vs_bank_credits',
        'form16_vs_slip_gross',
    ]


def test_ready_made_unknown_applies_to_warns():
    data = copy.deepcopy(SAMPLE)
    data['checklists'][0]['documents'][0]['applies_to'] = 'self_employed'
    catalog, warnings = cc.convert(data)
    assert warnings == ["checklist XX-PL-SAL: XX-01 applies to 'self_employed'"]
    item = _items(catalog['checklists'][0])['xx_01']
    assert item['rule'] == {'kind': 'manual'} and item['required'] is False


def test_generic_shapes_are_not_ready_made():
    assert not cc.is_ready_made({'checklists': [{'name': 'X', 'docs': []}]})
    assert not cc.is_ready_made([{'name': 'X'}])


# ------------------------------------------------------------------ freshness
@pytest.mark.skipif(
    not os.path.exists(READY_MADE_PATH),
    reason='ready-made research file not on this machine',
)
def test_bundle_matches_research_file(catalog):
    with open(READY_MADE_PATH, encoding='utf-8') as fh:
        data = json.load(fh)
    converted, warnings = cc.convert(data)
    assert warnings == []
    assert converted['checklists'] == catalog['checklists'][1:], (
        'checklists.json is stale; regenerate it (see convert_checklists.py)'
    )
