"""Engine tests on the synthetic golden fixtures (interfaces section 12)."""

import copy
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import engine  # noqa: E402

EN = '–'  # EN DASH separator used in reasons


# ------------------------------------------------------------------ fixtures
def _doc(pid, prefix, name, doc_type, **fields):
    return {
        'schema_version': 1,
        'document_id': f'{prefix}-{name[:2]}',
        'project_id': pid,
        'workflow_id': f'wf-{prefix}-{name[:2]}',
        'document_name': name,
        'doc_type': doc_type,
        'fields': fields,
        'grounding': {
            'grounded': True,
            'text_chars': 1200,
            'notes': [],
            'unverified_fields': [],
            'truncated': False,
        },
        'status': 'completed',
        'extracted_at': '2026-09-27T00:00:00Z',
    }


def rahul(pid='p1'):
    n, pan = 'Rahul Vijay Deshmukh', 'BQXPD4821K'
    emp = 'Konkan Softworks Pvt Ltd'
    mon = ['MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG']
    docs = [
        _doc(pid, 'r', '01_loan_application_form.pdf', 'loan_application',
             applicant_name=n, pan=pan, masked_aadhaar_last4='7304',
             employer=emp, declared_net_salary=82500, loan_amount=600000,
             product='Personal Loan (PL)'),
        _doc(pid, 'r', '02_identity_details_self_declaration.pdf',
             'identity_details', applicant_name=n, pan=pan,
             masked_aadhaar_last4='7304'),
    ]
    for i, (m, tag) in enumerate([('06', 'jun'), ('07', 'jul'), ('08', 'aug')]):
        docs.append(_doc(
            pid, 'r', f'0{i + 3}_salary_slip_2026-{m}_{tag}.pdf', 'salary_slip',
            applicant_name=n, pan=pan, employer=emp, month=f'2026-{m}',
            gross_salary=95000, net_salary=82500))
    docs.append(_doc(
        pid, 'r', '06_bank_statement_2026-03_to_2026-08.pdf', 'bank_statement',
        applicant_name='RAHUL VIJAY DESHMUKH', statement_from='2026-03-01',
        statement_to='2026-08-31',
        salary_credits=[
            {'date': f'2026-0{m}-01', 'amount': 82500,
             'narration': f'NEFT CR/SAL KONKAN SOFTWORKS/{mon[m - 3]}26'}
            for m in range(3, 9)]))
    docs.append(_doc(
        pid, 'r', '07_form16_itr_summary_FY2025-26.pdf', 'form16_itr',
        applicant_name=n, pan=pan, employer=emp, gross_salary=1140000,
        financial_year='2025-26'))
    return docs


def sneha(pid='p1'):
    n, pan, emp = 'Sneha Anil Kulkarni', 'CKRPK7314M', 'Deccan Retail Pvt Ltd'
    docs = [
        _doc(pid, 's', '01_loan_application_form.pdf', 'loan_application',
             applicant_name=n, pan=pan, masked_aadhaar_last4='5518',
             employer=emp, declared_net_salary=65000, loan_amount=400000),
        _doc(pid, 's', '02_identity_details_self_declaration.pdf',
             'identity_details', applicant_name=n, pan=pan,
             masked_aadhaar_last4='5518'),
        _doc(pid, 's', '03_salary_slip_2026-07_jul.pdf', 'salary_slip',
             applicant_name=n, pan=pan, employer=emp, month='2026-07',
             gross_salary=65000, net_salary=58000),
        _doc(pid, 's', '04_salary_slip_2026-08_aug.pdf', 'salary_slip',
             applicant_name=n, pan=pan, employer=emp, month='2026-08',
             gross_salary=65000, net_salary=58000),
        _doc(pid, 's', '05_bank_statement_2026-06_to_2026-08.pdf',
             'bank_statement', applicant_name='SNEHA ANIL KULKARNI',
             statement_from='2026-06-01', statement_to='2026-08-31',
             salary_credits=[
                 {'date': f'2026-0{m}-01', 'amount': 58000,
                  'narration': f'NEFT CR/SAL DECCAN RETAIL PVT LTD/{t}26'}
                 for m, t in ((6, 'JUN'), (7, 'JUL'), (8, 'AUG'))]),
    ]
    return docs


def amit(pid='p1'):
    n = 'Amit Suresh Patil'
    mon = ['MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG']
    docs = [
        _doc(pid, 'a', '01_loan_application_form.pdf', 'loan_application',
             applicant_name='Amit S. Patil', pan='DMVPP5926L',
             masked_aadhaar_last4='2619', employer='Varad Logistics LLP',
             declared_net_salary=71200, loan_amount=500000),
        _doc(pid, 'a', '02_identity_details_self_declaration.pdf',
             'identity_details', applicant_name=n, pan='DMVPP5928L',
             masked_aadhaar_last4='2619'),
    ]
    for i, (m, tag) in enumerate([('06', 'jun'), ('07', 'jul'), ('08', 'aug')]):
        docs.append(_doc(
            pid, 'a', f'0{i + 3}_salary_slip_2026-{m}_{tag}.pdf', 'salary_slip',
            applicant_name=n, pan='DMVPP5928L', employer='Varad Logistics',
            month=f'2026-{m}', gross_salary=80000, net_salary=71200))
    docs.append(_doc(
        pid, 'a', '06_bank_statement_2026-03_to_2026-08.pdf', 'bank_statement',
        applicant_name='AMIT SURESH PATIL', statement_from='2026-03-01',
        statement_to='2026-08-31',
        salary_credits=[
            {'date': f'2026-0{m}-01', 'amount': 71200,
             'narration': f'NEFT CR/SAL VARAD LOGISTICS LLP/{mon[m - 3]}26'}
            for m in range(3, 9)]))
    docs.append(_doc(
        pid, 'a', '07_form16_itr_summary_FY2025-26.pdf', 'form16_itr',
        applicant_name=n, pan='DMVPP5928L', employer='Varad Logistics LLP',
        gross_salary=960000, financial_year='2025-26'))
    return docs


def doc_items(facts, status='completed', file_type='application/pdf'):
    """DOC# data for a list of facts."""
    return [
        {
            'document_id': f['document_id'],
            'project_id': f['project_id'],
            'name': f['document_name'],
            'file_type': file_type,
            'file_size': 1000,
            'status': status,
            's3_key': f"projects/p1/documents/{f['document_id']}/x.pdf",
        }
        for f in facts
    ]


@pytest.fixture(scope='module')
def catalog():
    return engine.load_catalog()


@pytest.fixture(scope='module')
def pl(catalog):
    return engine.get_checklist(catalog)


def _by_id(rows, key):
    return {r[key]: r for r in rows}


# ------------------------------------------------------------------ golden
def test_rahul_ready(pl):
    res = engine.run_file_check(rahul(), pl, as_of='2026-09-27')
    assert res['overall_verdict'] == 'READY'
    assert len(res['applicants']) == 1
    a = res['applicants'][0]
    assert a['applicant'] == 'Rahul Vijay Deshmukh'
    assert a['pan'] == 'BQXPD4821K'
    assert a['verdict'] == 'READY'
    assert a['reference_month'] == '2026-08'
    assert a['reference_month_label'] == 'Aug 2026'
    assert all(r['status'] == 'PRESENT' for r in a['checklist'])
    assert {r['status'] for r in a['consistency']} == {'OK'}
    ids = [r['check_id'] for r in a['consistency']]
    assert ids == engine.CHECK_IDS
    assert a['missing_items'] == [] and a['mismatches'] == []
    assert a['reasons'] == []
    slips = _by_id(a['checklist'], 'item_id')['salary_slips']
    assert slips['required_months'] == ['2026-06', '2026-07', '2026-08']
    assert slips['missing_months'] == []
    bank = _by_id(a['checklist'], 'item_id')['bank_statement']
    assert bank['required_months'][0] == '2026-03'
    assert a['income']['declared_net'] == 82500
    assert a['income']['slip_gross_x12'] == 1140000
    assert len(a['income']['bank_credits']) == 6
    assert res['summary'] == '1 applicant: Rahul Vijay Deshmukh READY'
    assert res['engine_version'] == '1.0'
    assert res['as_of'] == '2026-09-27'
    assert res['project_id'] == 'p1'
    assert res['checklist'] == {
        'id': 'salaried_personal_loan',
        'name': 'Personal Loan - Salaried',
    }
    assert res['assistant_instructions'].startswith('Report overall_verdict')


def test_sneha_not_ready(pl):
    res = engine.run_file_check(sneha(), pl)
    assert res['overall_verdict'] == 'NOT READY'
    a = res['applicants'][0]
    assert a['verdict'] == 'NOT READY'
    assert a['reference_month'] == '2026-08'
    assert len(a['reasons']) == 5
    items = _by_id(a['checklist'], 'item_id')
    assert items['salary_slips']['status'] == 'MISSING'
    assert items['salary_slips']['missing_months'] == ['2026-06']
    assert items['bank_statement']['status'] == 'MISSING'
    assert items['bank_statement']['missing_months'] == [
        '2026-03', '2026-04', '2026-05']
    assert items['form16_itr']['status'] == 'MISSING'
    assert items['loan_application']['status'] == 'PRESENT'
    assert a['missing_items'] == [
        'Salary slip: Jun 2026',
        'Bank statement: Mar 2026, Apr 2026, May 2026',
        'Form-16 / ITR (latest FY)',
    ]
    checks = _by_id(a['consistency'], 'check_id')
    assert checks['declared_vs_slip_net']['status'] == 'MISMATCH'
    assert 'gross appears declared as net' in checks['declared_vs_slip_net']['detail']
    assert checks['declared_vs_bank_credits']['status'] == 'MISMATCH'
    assert checks['slip_net_vs_bank_credits']['status'] == 'OK'
    assert all(r.startswith(('MISSING – ', 'MISMATCH – ')) for r in a['reasons'])
    assert a['reasons'][0].startswith(
        "MISSING – Last 3 months' salary slips: missing Jun 2026 slip(s)"
    )
    assert len(a['mismatches']) == 2
    assert a['mismatches'][0].startswith('Declared net salary vs salary slips: ')
    assert res['summary'] == '1 applicant: Sneha Anil Kulkarni NOT READY (5 issues)'


def test_amit_pan_mismatch_one_group(pl):
    res = engine.run_file_check(amit(), pl)
    assert len(res['applicants']) == 1
    a = res['applicants'][0]
    assert len(a['documents']) == 7
    assert a['applicant'] == 'Amit Suresh Patil'
    assert a['pan'] == 'DMVPP5928L'
    assert a['verdict'] == 'NOT READY'
    assert all(r['status'] == 'PRESENT' for r in a['checklist'])
    bad = [c for c in a['consistency'] if c['status'] == 'MISMATCH']
    assert [c['check_id'] for c in bad] == ['pan']
    assert 'DMVPP5926L on 01_loan_application_form.pdf' in bad[0]['detail']
    assert 'differs at character 9' in bad[0]['detail']
    checks = _by_id(a['consistency'], 'check_id')
    assert checks['applicant_name']['status'] == 'OK'
    assert 'acceptable variants' in checks['applicant_name']['detail']
    assert checks['employer']['status'] == 'OK'
    assert 'acceptable variants' in checks['employer']['detail']
    assert len(a['reasons']) == 1
    assert a['reasons'][0].startswith(f'MISMATCH {EN} PAN: ')
    assert a['missing_items'] == []


def test_two_applicants_in_one_project(pl):
    res = engine.run_file_check(rahul() + sneha(), pl)
    names = [a['applicant'] for a in res['applicants']]
    assert sorted(names) == ['Rahul Vijay Deshmukh', 'Sneha Anil Kulkarni']
    by = {a['applicant']: a for a in res['applicants']}
    assert by['Rahul Vijay Deshmukh']['verdict'] == 'READY'
    assert by['Sneha Anil Kulkarni']['verdict'] == 'NOT READY'
    # bank statements (no PAN) joined by name
    r_docs = [d['document_name'] for d in by['Rahul Vijay Deshmukh']['documents']]
    s_docs = [d['document_name'] for d in by['Sneha Anil Kulkarni']['documents']]
    assert '06_bank_statement_2026-03_to_2026-08.pdf' in r_docs
    assert '05_bank_statement_2026-06_to_2026-08.pdf' in s_docs
    assert len(r_docs) == 7 and len(s_docs) == 5
    assert res['overall_verdict'] == 'NOT READY'
    assert res['unassigned_documents'] == []
    assert res['summary'].startswith('2 applicants: ')
    assert 'Rahul Vijay Deshmukh READY' in res['summary']
    assert 'Sneha Anil Kulkarni NOT READY (5 issues)' in res['summary']


def _anonymous(pid='p1'):
    d = _doc(pid, 'x', '99_cover_letter.pdf', 'other', product='misc')
    d['document_id'] = 'x-anon'
    return d


def test_nameless_document_unassigned_with_two_groups(pl):
    res = engine.run_file_check(rahul() + sneha() + [_anonymous()], pl)
    assert res['unassigned_documents'] == [
        {
            'document_id': 'x-anon',
            'document_name': '99_cover_letter.pdf',
            'doc_type': 'other',
        }
    ]
    assert len(res['applicants']) == 2


def test_nameless_document_joins_single_group(pl):
    res = engine.run_file_check(rahul() + [_anonymous()], pl)
    assert res['unassigned_documents'] == []
    a = res['applicants'][0]
    assert '99_cover_letter.pdf' in [d['document_name'] for d in a['documents']]
    checks = _by_id(a['consistency'], 'check_id')
    assert checks['unclassified_documents']['status'] == 'INFO'
    assert a['verdict'] == 'READY'  # INFO never changes the verdict


def test_group_applicants_ordering():
    groups, unassigned = engine.group_applicants(list(reversed(rahul())))
    assert unassigned == []
    names = [d['document_name'] for d in groups[0]]
    assert names == sorted(names)


# ------------------------------------------------------------------ classification
def test_pending_documents_block_every_applicant(pl):
    facts = rahul() + sneha()
    docs = doc_items(facts)
    extra = {
        'document_id': 'r-new', 'project_id': 'p1',
        'name': '08_extra_slip.pdf', 'file_type': 'application/pdf',
        'status': 'processing',
    }
    res = engine.run_file_check(facts, pl, documents=docs + [extra])
    assert res['pending_documents'] == [
        {'document_id': 'r-new', 'document_name': '08_extra_slip.pdf',
         'status': 'processing'}
    ]
    assert res['overall_verdict'] == 'NOT READY'
    for a in res['applicants']:
        assert a['verdict'] == 'NOT READY'
        assert a['reasons'][0].startswith('PENDING – ')
        assert '1 document(s) still being analysed: 08_extra_slip.pdf' in a['reasons'][0]


def test_csv_is_unsupported_and_does_not_change_verdict(pl):
    facts = rahul()
    csv_doc = {
        'document_id': 'r-csv', 'project_id': 'p1', 'name': 'statement.csv',
        'file_type': 'text/csv', 'status': 'completed',
    }
    res = engine.run_file_check(facts, pl, documents=doc_items(facts) + [csv_doc])
    assert res['unsupported_documents'] == [
        {
            'document_id': 'r-csv',
            'document_name': 'statement.csv',
            'file_type': 'text/csv',
            'reason': engine.UNSUPPORTED_REASON,
        }
    ]
    assert res['overall_verdict'] == 'READY'


def test_spreadsheet_never_pending(pl):
    facts = rahul()
    xlsx = {
        'document_id': 'r-xlsx', 'project_id': 'p1', 'name': 'bank.xlsx',
        'file_type': ('application/vnd.openxmlformats-officedocument'
                      '.spreadsheetml.sheet'),
        'status': 'processing',
    }
    tsv = {
        'document_id': 'r-tsv', 'project_id': 'p1', 'name': 'credits.TSV',
        'file_type': '', 'status': 'completed',
    }
    res = engine.run_file_check(
        facts, pl, documents=doc_items(facts) + [xlsx, tsv])
    assert [d['document_id'] for d in res['unsupported_documents']] == [
        'r-xlsx', 'r-tsv']
    assert res['pending_documents'] == []
    assert res['overall_verdict'] == 'READY'


def test_completed_doc_without_facts_is_no_facts(pl):
    facts = rahul()
    docs = doc_items(facts)
    form16 = facts.pop()  # drop the Form-16 FACTS# item
    res = engine.run_file_check(facts, pl, documents=docs)
    assert [d['document_id'] for d in res['no_facts_documents']] == [
        form16['document_id']
    ]
    assert res['no_facts_documents'][0]['document_name'] == form16['document_name']
    a = res['applicants'][0]
    assert _by_id(a['checklist'], 'item_id')['form16_itr']['status'] == 'MISSING'
    assert res['overall_verdict'] == 'NOT READY'


def test_failed_and_skipped_and_orphan_facts(pl):
    facts = rahul()
    docs = doc_items(facts)
    docs[0]['status'] = 'failed'
    for f in facts:
        if f['document_id'] == docs[0]['document_id']:
            f['status'] = 'failed'
    facts[1] = {**facts[1], 'status': 'skipped', 'reason': 'no_text'}
    orphan = _doc('p1', 'z', 'zz_orphan.pdf', 'salary_slip',
                  applicant_name='Someone Else', pan='ZZZZZ9999Z')
    res = engine.run_file_check(facts + [orphan], pl, documents=docs)
    assert [d['document_id'] for d in res['failed_documents']] == [
        docs[0]['document_id']
    ]
    assert res['no_facts_documents'][0]['reason'] == 'facts skipped: no_text'
    assert len(res['applicants']) == 1  # the orphan FACTS# is ignored


def test_doc_name_wins_over_facts_name(pl):
    facts = rahul()
    docs = doc_items(facts)
    docs[0]['name'] = 'Application (scan).pdf'
    res = engine.run_file_check(facts, pl, documents=docs)
    names = [d['document_name'] for d in res['applicants'][0]['documents']]
    assert 'Application (scan).pdf' in names


# ------------------------------------------------------------------ options
def test_reference_month_override(pl):
    res = engine.run_file_check(rahul(), pl, reference_month='2026-07')
    a = res['applicants'][0]
    assert a['reference_month'] == '2026-07'
    slips = _by_id(a['checklist'], 'item_id')['salary_slips']
    assert slips['required_months'] == ['2026-05', '2026-06', '2026-07']
    assert slips['status'] == 'MISSING'
    assert slips['missing_months'] == ['2026-05']
    assert 'Salary slip: May 2026' in a['missing_items']
    # the statement still covers Mar-Aug (end = max(statement end, reference))
    bank = _by_id(a['checklist'], 'item_id')['bank_statement']
    assert bank['status'] == 'PRESENT'
    with pytest.raises(ValueError):
        engine.run_file_check(rahul(), pl, reference_month='2026-13')


def test_applicant_filter(pl):
    facts = rahul() + sneha()
    by_pan = engine.run_file_check(facts, pl, applicant='ckrpk 7314m')
    assert [a['applicant'] for a in by_pan['applicants']] == ['Sneha Anil Kulkarni']
    by_name = engine.run_file_check(facts, pl, applicant='Rahul V. Deshmukh')
    assert [a['applicant'] for a in by_name['applicants']] == ['Rahul Vijay Deshmukh']
    assert by_name['overall_verdict'] == 'READY'
    none = engine.run_file_check(facts, pl, applicant='Priya Sharma')
    assert none['applicants'] == []
    assert none['overall_verdict'] == 'NOT READY'
    assert none['summary'] == "No applicant matching 'Priya Sharma'"


def test_empty_project(pl):
    res = engine.run_file_check([], pl, documents=[])
    assert res['applicants'] == []
    assert res['overall_verdict'] == 'NOT READY'
    assert res['summary'] == 'No analysed documents found in this project'


def test_custom_checklist_two_months(pl):
    custom = copy.deepcopy(pl)
    custom['id'] = 'pl_two_slips'
    for it in custom['items']:
        if it['id'] == 'salary_slips':
            it['rule']['months'] = 2
    a = engine.run_file_check(sneha(), custom)['applicants'][0]
    slips = _by_id(a['checklist'], 'item_id')['salary_slips']
    assert slips['status'] == 'PRESENT'
    assert slips['detail'] == '2 of 2 present (Jul 2026 – Aug 2026)'
    assert len(a['reasons']) == 4


def test_manual_item_is_review_only(pl):
    custom = copy.deepcopy(pl)
    custom['items'].append(
        {
            'id': 'property_papers',
            'label': 'Property papers',
            'doc_types': [],
            'required': False,
            'rule': {'kind': 'manual'},
        }
    )
    assert engine.validate_catalog(
        {'schema_version': 1, 'default_checklist': custom['id'],
         'checklists': [custom]}) == []
    res = engine.run_file_check(rahul(), custom)
    a = res['applicants'][0]
    row = _by_id(a['checklist'], 'item_id')['property_papers']
    assert row['status'] == 'REVIEW'
    assert row['required'] is False
    assert a['manual_review'] == ['Property papers']
    assert a['verdict'] == 'READY'
    assert res['overall_verdict'] == 'READY'


def test_required_manual_item_blocks_ready(pl):
    custom = copy.deepcopy(pl)
    custom['items'].append(
        {
            'id': 'address_proof',
            'label': 'Address proof',
            'doc_types': [],
            'required': True,
            'rule': {'kind': 'manual'},
        }
    )
    res = engine.run_file_check(rahul(), custom)
    a = res['applicants'][0]
    row = _by_id(a['checklist'], 'item_id')['address_proof']
    assert row['status'] == 'REVIEW' and row['ok'] is None
    assert row['required'] is True
    assert a['manual_review'] == ['Address proof']
    assert a['verdict'] == 'NOT READY'
    assert res['overall_verdict'] == 'NOT READY'
    assert a['reasons'] == [
        f'REVIEW {EN} Address proof: cannot be verified automatically; '
        'review manually'
    ]
    # Not something to request from the applicant
    assert a['missing_items'] == [] and a['mismatches'] == []
    assert res['summary'] == (
        '1 applicant: Rahul Vijay Deshmukh NOT READY (1 issue)'
    )
    listed = engine.list_checklists(
        {'schema_version': 1, 'default_checklist': custom['id'],
         'checklists': [custom]})
    assert listed['checklists'][0]['items'][-1]['required'] is True
    # Without an explicit required: true a manual item stays review-only
    # (same rule as Plan B checks.py)
    del custom['items'][-1]['required']
    assert engine.run_file_check(rahul(), custom)['overall_verdict'] == 'READY'


def test_optional_item_missing_does_not_block(pl):
    custom = copy.deepcopy(pl)
    for it in custom['items']:
        if it['id'] == 'form16_itr':
            it['required'] = False
    facts = [f for f in rahul() if f['doc_type'] != 'form16_itr']
    a = engine.run_file_check(facts, custom)['applicants'][0]
    assert _by_id(a['checklist'], 'item_id')['form16_itr']['status'] == 'MISSING'
    assert a['missing_items'] == []
    assert a['verdict'] == 'READY'


def test_consistency_rows_limited_to_checklist(pl):
    custom = copy.deepcopy(pl)
    custom['consistency_checks'] = ['applicant_name']
    a = engine.run_file_check(amit(), custom)['applicants'][0]
    assert [c['check_id'] for c in a['consistency']] == ['applicant_name']
    assert a['verdict'] == 'READY'  # PAN check disabled


def test_tolerance_from_checklist(pl):
    custom = copy.deepcopy(pl)
    custom['tolerance_pct'] = 15
    a = engine.run_file_check(sneha(), custom)['applicants'][0]
    checks = _by_id(a['consistency'], 'check_id')
    assert checks['declared_vs_slip_net']['status'] == 'OK'  # 10.8 % apart


def test_no_declared_salary_adds_na(pl):
    facts = [f for f in rahul() if f['doc_type'] != 'loan_application']
    a = engine.run_file_check(facts, pl)['applicants'][0]
    checks = _by_id(a['consistency'], 'check_id')
    assert checks['declared_net_salary']['status'] == 'N/A'
    assert checks['declared_net_salary']['check'] == 'Declared net salary'
    assert a['missing_items'] == ['Loan application form']


# ------------------------------------------------------------------ catalog
def _catalog_with(**overrides):
    cat = copy.deepcopy(engine.load_catalog())
    cl = cat['checklists'][0]
    for k, v in overrides.items():
        cl[k] = v
    return cat


def test_validate_catalog_errors():
    # A required manual item is valid (it blocks READY, see below)
    cat = _catalog_with()
    cat['checklists'][0]['items'].append(
        {'id': 'x', 'label': 'X', 'doc_types': [], 'required': True,
         'rule': {'kind': 'manual'}})
    assert engine.validate_catalog(cat) == []

    cat = _catalog_with()
    cat['checklists'][0]['items'].append(
        {'id': 'x', 'label': 'X', 'doc_types': [], 'required': 'yes',
         'rule': {'kind': 'manual'}})
    assert any('required must be true or false' in e
               for e in engine.validate_catalog(cat))

    cat = _catalog_with()
    cat['checklists'][0]['items'][0]['rule'] = {'kind': 'sometimes'}
    assert any("rule.kind 'sometimes'" in e for e in engine.validate_catalog(cat))

    cat = _catalog_with(consistency_checks=['pan', 'shoe_size'])
    assert any('shoe_size' in e for e in engine.validate_catalog(cat))

    cat = _catalog_with()
    cat['checklists'].append(copy.deepcopy(cat['checklists'][0]))
    assert any('duplicate checklist id' in e for e in engine.validate_catalog(cat))

    cat = _catalog_with()
    cat['checklists'][0]['items'].append(
        copy.deepcopy(cat['checklists'][0]['items'][0]))
    assert any('duplicate item id' in e for e in engine.validate_catalog(cat))

    cat = _catalog_with()
    cat['default_checklist'] = 'home_loan'
    assert any('default_checklist' in e for e in engine.validate_catalog(cat))

    cat = _catalog_with(id='Bad-Id')
    assert any('must match' in e for e in engine.validate_catalog(cat))

    cat = _catalog_with()
    cat['checklists'][0]['items'][2]['rule']['months'] = 25
    assert any('1..24' in e for e in engine.validate_catalog(cat))

    cat = _catalog_with()
    cat['checklists'][0]['items'][0]['doc_types'] = ['passport']
    assert any('unknown doc_types' in e for e in engine.validate_catalog(cat))

    cat = _catalog_with()
    cat['checklists'][0]['items'][0]['rule'] = {'kind': 'present', 'min_count': 0}
    assert any('min_count' in e for e in engine.validate_catalog(cat))

    cat = _catalog_with()
    cat['schema_version'] = 2
    assert any('schema_version' in e for e in engine.validate_catalog(cat))


def test_load_catalog_rejects_invalid(tmp_path):
    bad = _catalog_with()
    bad['default_checklist'] = 'nope'
    p = tmp_path / 'c.json'
    p.write_text(json.dumps(bad))
    with pytest.raises(ValueError, match='default_checklist'):
        engine.load_catalog(str(p))


def test_shipped_catalog_and_list_checklists(catalog):
    assert engine.validate_catalog(catalog) == []
    listed = engine.list_checklists(catalog)
    assert listed['default_checklist'] == 'salaried_personal_loan'
    cl = listed['checklists'][0]
    assert set(cl) == {
        'id', 'name', 'product', 'applicant_type', 'description', 'items',
        'consistency_checks',
    }
    assert [i['id'] for i in cl['items']] == [
        'loan_application', 'identity_details', 'salary_slips',
        'bank_statement', 'form16_itr',
    ]
    assert set(cl['items'][0]) == {'id', 'label', 'required', 'doc_types', 'rule'}
    assert cl['consistency_checks'] == engine.CHECK_IDS
    with pytest.raises(ValueError):
        engine.get_checklist(catalog, 'home_loan')
    assert engine.get_checklist(catalog)['id'] == 'salaried_personal_loan'


def test_response_json_serialises(pl):
    res = engine.run_file_check(rahul() + sneha() + amit('p1'), pl)
    text = json.dumps(res, ensure_ascii=False)
    assert '₹' in text and '–' in text
    assert json.loads(text)['overall_verdict'] == 'NOT READY'


# ------------------------------------------------------------------ helpers
def test_helpers():
    assert engine.to_month('July 2026') == (2026, 7)
    assert engine.to_month('Jul-2026') == (2026, 7)
    assert engine.to_month('2026-07-01') == (2026, 7)
    assert engine.inr(600000) == '₹6,00,000'
    assert engine.inr(1140000) == '₹11,40,000'
    assert engine.inr(None) == '–'
    assert engine.names_compatible('Amit S. Patil', 'AMIT SURESH PATIL')
    assert not engine.names_compatible('Amit Patil', 'Sneha Kulkarni')
    assert engine.employer_core('Varad Logistics LLP') == 'varad logistics'
    assert engine.lev('DMVPP5926L', 'DMVPP5928L') == 1
    assert engine.ym_label(engine.ym_add((2026, 1), -1)) == 'Dec 2025'
    assert engine.month_span((2026, 11), (2027, 2)) == [
        (2026, 11), (2026, 12), (2027, 1), (2027, 2)]
