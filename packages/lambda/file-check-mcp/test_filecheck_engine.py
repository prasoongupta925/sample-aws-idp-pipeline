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


def _debits(rows):
    """(date, narration, amount, category, channel) -> recurring_debits facts."""
    return [
        {'date': d, 'amount': a, 'narration': n, 'channel': ch, 'category': c}
        for d, n, a, c, ch in rows
    ]


_MON = ['MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG']
# Rahul's obligation debits, as printed on the synthetic statement (Mar-Aug 2026)
RAHUL_CC = [9300, 13100, 13900, 10700, 9000, 11900]
RAHUL_ELEC = [1700, 2226, 2569, 2328, 1174, 1696]
RAHUL_EMI = ('ACH DR/MULSHI AUTO FINANCE/CAR LOAN EMI', 8200, 'loan_emi', 'ACH')


def rahul_debits(emi=True):
    rows = []
    for i, m in enumerate(range(3, 9)):
        ym = f'2026-0{m}'
        rows += [
            (f'{ym}-03', f'NEFT DR/RENT {_MON[i]}26/VASANT JOSHI', 18000, 'rent', 'other'),
            (f'{ym}-07', 'ACH DR/SIP/SAMPLE ASSET MGMT MF', 5000, 'investment', 'ACH'),
            (f'{ym}-11', 'BILLPAY/DR/ELECTRICITY BILL', RAHUL_ELEC[i], 'utility', 'other'),
            (f'{ym}-16', 'CC PAYMENT/SAHYADRI UCB CREDIT CARD', RAHUL_CC[i], 'credit_card', 'other'),
            (f'{ym}-25', 'BILLPAY/DR/MOBILE & BROADBAND', 1299, 'utility', 'other'),
        ]
        if emi:
            rows.append((f'{ym}-05', RAHUL_EMI[0], RAHUL_EMI[1], RAHUL_EMI[2], RAHUL_EMI[3]))
        if m == 5:
            rows.append(('2026-05-18', 'NEFT DR/HEALTH INSURANCE PREMIUM', 14500, 'insurance', 'other'))
    return _debits(sorted(rows))


RAHUL_DECLARED = [{'lender': 'Mulshi Auto Finance Ltd (sample)', 'loan_type': 'Car loan', 'amount': 8200}]


def rahul(pid='p1'):
    n, pan = 'Rahul Vijay Deshmukh', 'BQXPD4821K'
    emp = 'Konkan Softworks Pvt Ltd'
    mon = _MON
    docs = [
        _doc(pid, 'r', '01_loan_application_form.pdf', 'loan_application',
             applicant_name=n, pan=pan, masked_aadhaar_last4='7304',
             employer=emp, declared_net_salary=82500, loan_amount=600000,
             loan_tenure_months=48, product='Personal Loan (PL)',
             declared_existing_emis=list(RAHUL_DECLARED),
             declared_total_existing_emi=8200),
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
            for m in range(3, 9)],
        recurring_debits=rahul_debits()))
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
             employer=emp, declared_net_salary=65000, loan_amount=400000,
             loan_tenure_months=36, declared_existing_emis=[],
             declared_total_existing_emi=0),
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
                 for m, t in ((6, 'JUN'), (7, 'JUL'), (8, 'AUG'))],
             recurring_debits=sneha_debits()),
    ]
    return docs


def sneha_debits():
    rows = []
    for m, t, elec, cc in ((6, 'JUN', 1267, 8200), (7, 'JUL', 1282, 5200), (8, 'AUG', 1370, 6500)):
        ym = f'2026-0{m}'
        rows += [
            (f'{ym}-04', f'NEFT DR/RENT {t}26/SUNITA GOKHALE', 12000, 'rent', 'other'),
            (f'{ym}-10', 'BILLPAY/DR/ELECTRICITY BILL', elec, 'utility', 'other'),
            (f'{ym}-12', 'ACH DR/SIP/SAMPLE ASSET MGMT MF', 3000, 'investment', 'ACH'),
            (f'{ym}-15', 'UPI/DR/METRO CARD RECHARGE', 500, 'utility', 'UPI'),
            (f'{ym}-17', 'CC PAYMENT/SAHYADRI UCB CREDIT CARD', cc, 'credit_card', 'other'),
            (f'{ym}-26', 'BILLPAY/DR/MOBILE BILL', 499, 'utility', 'other'),
        ]
    return _debits(sorted(rows))


AMIT_EMI = ('ACH DR/INDRAYANI MOTOR FIN/TW LOAN EMI', 3450, 'loan_emi', 'ACH')


def amit_debits(emi=True):
    elec = [2061, 2102, 2727, 2707, 1730, 1652]
    cc = [8100, 10400, 5400, 10400, 9700, 7800]
    rows = []
    for i, m in enumerate(range(3, 9)):
        ym = f'2026-0{m}'
        rows += [
            (f'{ym}-06', 'NEFT DR/SAMPLE NAGAR CHS/MAINTENANCE', 3200, 'other', 'other'),
            (f'{ym}-10', 'ACH DR/RD INSTALMENT/SAHYADRI UCB', 5000, 'investment', 'ACH'),
            (f'{ym}-12', 'BILLPAY/DR/ELECTRICITY BILL', elec[i], 'utility', 'other'),
            (f'{ym}-18', 'CC PAYMENT/SAHYADRI UCB CREDIT CARD', cc[i], 'credit_card', 'other'),
            (f'{ym}-26', 'BILLPAY/DR/MOBILE & DTH', 799, 'utility', 'other'),
        ]
        if emi:
            rows.append((f'{ym}-05', AMIT_EMI[0], AMIT_EMI[1], AMIT_EMI[2], AMIT_EMI[3]))
        if m == 6:
            rows.append(('2026-06-09', 'NEFT DR/SAMPLE VIDYALAYA/SCHOOL FEES', 18500, 'other', 'other'))
    return _debits(sorted(rows))


def amit(pid='p1'):
    n = 'Amit Suresh Patil'
    mon = _MON
    docs = [
        _doc(pid, 'a', '01_loan_application_form.pdf', 'loan_application',
             applicant_name='Amit S. Patil', pan='DMVPP5926L',
             masked_aadhaar_last4='2619', employer='Varad Logistics LLP',
             declared_net_salary=71200, loan_amount=500000,
             loan_tenure_months=36,
             declared_existing_emis=[{'lender': 'Indrayani Motor Finance Ltd (sample)',
                                      'loan_type': 'Two-wheeler loan', 'amount': 3450}],
             declared_total_existing_emi=3450),
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
            for m in range(3, 9)],
        recurring_debits=amit_debits()))
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
    assert a['needs_review'] == []
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
    assert a['foir'] is None and a['needs_review'] == []
    assert a['obligations']['totals']['loan_emis'] == 3450  # summary is always there


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
        'consistency_checks', 'foir',
    }
    assert cl['foir']['value'] == 0.7 and cl['foir']['hard_limit'] is False
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


# ------------------------------------------------------------------ obligations & FOIR
LABEL = "indicative — the lender's policy decides"


def _applicant(facts, checklist):
    return engine.run_file_check(facts, checklist)['applicants'][0]


def _set_fields(facts, doc_type, **fields):
    out = copy.deepcopy(facts)
    for f in out:
        if f['doc_type'] == doc_type:
            f['fields'].update(fields)
    return out


def _payees(rows):
    return [(r['payee'], r['amount'], r['day_of_month']) for r in rows]


def test_rahul_obligations_summary_matches_ground_truth(pl):
    a = _applicant(rahul(), pl)
    o = a['obligations']
    assert o['available'] is True and o['declared_available'] is True
    assert o['unavailable_reasons'] == []
    assert o['statement_months'] == [f'2026-0{m}' for m in range(3, 9)]
    (emi,) = o['fixed_loan_emis']
    assert emi['payee'] == 'MULSHI AUTO FINANCE / CAR LOAN EMI'
    assert (emi['amount'], emi['day_of_month'], emi['channel']) == (8200, 5, 'ACH')
    assert (emi['months_seen'], emi['months_total'], emi['fixed']) == (6, 6, True)
    assert emi['declared'] is True
    assert emi['declared_lender'] == 'Mulshi Auto Finance Ltd (sample)'
    assert emi['documents'] == ['06_bank_statement_2026-03_to_2026-08.pdf']
    assert [e['month'] for e in emi['evidence']] == o['statement_months']
    assert emi['evidence'][0] == {
        'document_name': '06_bank_statement_2026-03_to_2026-08.pdf',
        'date': '2026-03-05', 'month': '2026-03', 'amount': 8200,
        'narration': 'ACH DR/MULSHI AUTO FINANCE/CAR LOAN EMI'}
    # README Q4: rent 3rd, SIP 7th, mobile & broadband 25th -> fixed ₹32,499
    assert _payees(o['other_fixed_debits']) == [
        ('RENT / VASANT JOSHI', 18000, 3),
        ('SIP / SAMPLE ASSET MGMT MF', 5000, 7),
        ('MOBILE & BROADBAND', 1299, 25),
    ]
    assert o['totals'] == {'loan_emis': 8200, 'other_fixed': 24299,
                           'fixed_monthly': 32499, 'variable_monthly_average': 13265.5}
    variable = {v['category']: v for v in o['variable_debits']}
    cc, elec = variable['credit_card'], variable['utility']
    assert (cc['amount'], cc['min_amount'], cc['max_amount']) == (11316.67, 9000, 13900)
    assert elec['payee'] == 'ELECTRICITY BILL' and elec['amount'] == 1948.83
    (one_off,) = o['one_off_debits']
    assert (one_off['payee'], one_off['amount'], one_off['months']) == (
        'HEALTH INSURANCE PREMIUM', 14500, ['2026-05'])
    (dec,) = o['declared_emis']
    assert dec['status'] == 'matched' and dec['months_matched'] == 6
    assert dec['bank_amount'] == 8200 and dec['day_of_month'] == 5
    assert o['undeclared_loan_debits'] == []
    assert o['foir_emi_total'] == 8200
    assert o['foir_emi_basis'] == 'bank debits and declared EMIs'
    assert 'Only loan EMIs count toward FOIR' in o['notes'][-1]


def test_rahul_emi_matched_and_foir(pl):
    a = _applicant(rahul(), pl)
    checks = _by_id(a['consistency'], 'check_id')
    row = checks['declared_emis_vs_bank_debits']
    assert row['status'] == 'OK'
    assert row['check'] == 'Declared EMIs vs bank debits'
    assert row['detail'] == (
        'declared ₹8,200 Mulshi Auto Finance Ltd (sample) (Car loan) '
        '[01_loan_application_form.pdf] = ACH debit ₹8,200 '
        "'MULSHI AUTO FINANCE / CAR LOAN EMI' on the 5th in 6 of 6 months "
        '(Mar 2026 – Aug 2026) [06_bank_statement_2026-03_to_2026-08.pdf]')
    assert row['documents'] == ['01_loan_application_form.pdf',
                                '06_bank_statement_2026-03_to_2026-08.pdf']
    foir_row = checks['foir']
    assert foir_row['status'] == 'OK' and foir_row['check'] == 'FOIR (indicative)'
    assert '= 9.9%' in foir_row['detail']
    assert 'max new EMI is ₹49,550 (0.70 × ₹82,500 − ₹8,200)' in foir_row['detail']
    assert foir_row['detail'].endswith("Indicative — the lender's policy decides.")
    f = a['foir']
    assert f['label'] == LABEL and f['indicative'] is True
    assert (f['foir_limit'], f['foir_limit_pct'], f['hard_limit']) == (0.7, 70.0, False)
    assert f['net_monthly_income'] == 82500 and f['income_verified'] is True
    assert f['income_source'] == 'salary slips, median net pay'
    assert f['existing_emis'] == 8200
    assert f['existing_emi_ratio'] == 0.0994 and f['existing_emi_ratio_pct'] == 9.9
    assert f['max_new_emi'] == 49550  # 0.7 x 82,500 - 8,200
    assert f['within_limit'] is True and f['status'] == 'OK'
    assert 'Smart Solutions calculator' in f['limit_source']
    assert a['verdict'] == 'READY' and a['needs_review'] == []


def test_sneha_no_emis(pl):
    a = _applicant(sneha(), pl)
    row = _by_id(a['consistency'], 'check_id')['declared_emis_vs_bank_debits']
    assert row['status'] == 'OK'
    assert row['detail'] == (
        'no existing EMIs declared [01_loan_application_form.pdf] and no loan EMI '
        'debits in the bank statement (Jun 2026 – Aug 2026) '
        '[05_bank_statement_2026-06_to_2026-08.pdf]')
    o = a['obligations']
    assert o['fixed_loan_emis'] == [] and o['declared_emis'] == []
    assert o['foir_emi_total'] == 0
    # FOIR uses the verified ₹58,000, not the declared ₹65,000 (README Q2)
    f = a['foir']
    assert f['net_monthly_income'] == 58000 and f['existing_emi_ratio'] == 0
    assert f['max_new_emi'] == 40600 and f['status'] == 'OK'
    assert a['needs_review'] == []
    assert len(a['reasons']) == 5  # unchanged: obligations never add blockers


def test_amit_emi_matched(pl):
    a = _applicant(amit(), pl)
    checks = _by_id(a['consistency'], 'check_id')
    row = checks['declared_emis_vs_bank_debits']
    assert row['status'] == 'OK'
    assert 'declared ₹3,450 Indrayani Motor Finance Ltd (sample) (Two-wheeler loan)' in row['detail']
    assert "ACH debit ₹3,450 'INDRAYANI MOTOR FIN / TW LOAN EMI' on the 5th in 6 of 6 months" in row['detail']
    o = a['obligations']
    assert _payees(o['fixed_loan_emis']) == [('INDRAYANI MOTOR FIN / TW LOAN EMI', 3450, 5)]
    # an ACH recurring deposit is an investment, never a possible EMI
    fixed = {r['payee']: r['category'] for r in o['other_fixed_debits']}
    assert fixed['RD INSTALMENT / SAHYADRI UCB'] == 'investment'
    assert o['undeclared_loan_debits'] == []
    assert [r['payee'] for r in o['one_off_debits']] == ['SAMPLE VIDYALAYA / SCHOOL FEES']
    f = a['foir']
    assert (f['existing_emis'], f['net_monthly_income'], f['existing_emi_ratio_pct']) == (3450, 71200, 4.8)
    assert f['max_new_emi'] == 46390
    assert [m.split(':')[0] for m in a['mismatches']] == ['PAN']  # still only the PAN


def _with_undeclared_nach(facts, amount=6500):
    out = copy.deepcopy(facts)
    for f in out:
        if f['doc_type'] == 'bank_statement':
            f['fields']['recurring_debits'] += [
                {'date': f'2026-0{m}-10', 'amount': amount,
                 'narration': 'NACH DR/KESARI FINSERV/PERSONAL LOAN EMI',
                 'channel': 'NACH', 'category': 'loan_emi'}
                for m in range(3, 9)]
    return out


def test_undeclared_emi_is_needs_review_not_blocking(pl):
    res = engine.run_file_check(_with_undeclared_nach(rahul()), pl)
    a = res['applicants'][0]
    row = _by_id(a['consistency'], 'check_id')['declared_emis_vs_bank_debits']
    assert row['status'] == 'REVIEW'
    assert ("undeclared loan debit: NACH debit ₹6,500 'KESARI FINSERV / PERSONAL LOAN EMI' "
            'on the 10th in 6 of 6 months') in row['detail']
    assert 'not on the application [01_loan_application_form.pdf]' in row['detail']
    assert 'declared ₹8,200 Mulshi Auto Finance' in row['detail']  # the match is still cited
    (u,) = a['obligations']['undeclared_loan_debits']
    assert (u['kind'], u['amount'], u['declared']) == ('loan_emi', 6500, False)
    assert [r['amount'] for r in a['obligations']['fixed_loan_emis']] == [8200, 6500]
    # FOIR counts the undeclared EMI: 14,700 / 82,500 = 17.8 %
    assert a['foir']['existing_emis'] == 14700
    assert a['foir']['existing_emi_ratio_pct'] == 17.8
    assert a['foir']['max_new_emi'] == 43050
    assert a['needs_review'] == [f"Declared EMIs vs bank debits: {row['detail']}"]
    assert a['verdict'] == 'READY' and a['reasons'] == []
    assert res['overall_verdict'] == 'READY'
    assert res['summary'] == '1 applicant: Rahul Vijay Deshmukh READY (1 to review)'


def test_declared_emi_missing_from_bank(pl):
    facts = _set_fields(rahul(), 'bank_statement', recurring_debits=rahul_debits(emi=False))
    a = _applicant(facts, pl)
    row = _by_id(a['consistency'], 'check_id')['declared_emis_vs_bank_debits']
    assert row['status'] == 'REVIEW'
    assert row['detail'] == (
        'declared ₹8,200 Mulshi Auto Finance Ltd (sample) (Car loan) '
        '[01_loan_application_form.pdf] not found in the bank debits (Mar 2026 – Aug 2026) '
        '[06_bank_statement_2026-03_to_2026-08.pdf]; it may be paid from another account, '
        'so ask for that statement')
    (dec,) = a['obligations']['declared_emis']
    assert dec['status'] == 'not_found' and dec['months_matched'] == 0
    assert a['obligations']['fixed_loan_emis'] == []
    # conservative: the declared EMI still counts toward FOIR
    assert a['foir']['existing_emis'] == 8200 and a['foir']['status'] == 'OK'
    assert a['verdict'] == 'READY' and len(a['needs_review']) == 1


def test_emi_found_in_minority_of_months_is_partial(pl):
    debits = [d for d in rahul_debits() if not (
        d['narration'] == RAHUL_EMI[0] and d['date'] < '2026-07-01')]
    a = _applicant(_set_fields(rahul(), 'bank_statement', recurring_debits=debits), pl)
    row = _by_id(a['consistency'], 'check_id')['declared_emis_vs_bank_debits']
    assert row['status'] == 'REVIEW'
    assert 'found in only 2 of 6 months (Jul 2026 – Aug 2026)' in row['detail']
    assert a['obligations']['declared_emis'][0]['status'] == 'partial'
    assert a['foir']['existing_emis'] == 8200


def test_declared_amount_differs_from_bank(pl):
    facts = _set_fields(rahul(), 'loan_application', declared_existing_emis=[
        {'lender': 'Mulshi Auto Finance Ltd (sample)', 'loan_type': 'Car loan', 'amount': 9000}],
        declared_total_existing_emi=9000)
    a = _applicant(facts, pl)
    row = _by_id(a['consistency'], 'check_id')['declared_emis_vs_bank_debits']
    assert row['status'] == 'REVIEW'
    assert ("declared ₹9,000 Mulshi Auto Finance Ltd (sample) (Car loan) [01_loan_application_form.pdf] "
            "but the bank debits to 'MULSHI AUTO FINANCE / CAR LOAN EMI' are ₹8,200 (8.9% apart)"
            ) in row['detail']
    assert a['obligations']['declared_emis'][0]['status'] == 'amount_differs'
    assert a['obligations']['undeclared_loan_debits'] == []
    assert a['foir']['existing_emis'] == 8200  # what the bank actually debits


def test_emi_amount_within_tolerance_and_day_shift_still_match(pl):
    debits = copy.deepcopy(rahul_debits())
    for d in debits:
        if d['narration'] == RAHUL_EMI[0] and d['date'].startswith('2026-04'):
            d['date'], d['amount'] = '2026-04-07', 8250  # holiday shift, 0.6 % more
    a = _applicant(_set_fields(rahul(), 'bank_statement', recurring_debits=debits), pl)
    assert _by_id(a['consistency'], 'check_id')['declared_emis_vs_bank_debits']['status'] == 'OK'


def test_sip_labelled_emi_by_the_model_is_not_an_emi(pl):
    debits = copy.deepcopy(rahul_debits())
    for d in debits:
        if 'SIP' in d['narration']:
            d['category'] = 'loan_emi'
    a = _applicant(_set_fields(rahul(), 'bank_statement', recurring_debits=debits), pl)
    assert a['obligations']['undeclared_loan_debits'] == []
    assert a['obligations']['totals']['loan_emis'] == 8200
    assert engine.debit_category('loan_emi', 'ACH DR/SIP/SAMPLE ASSET MGMT MF') == 'investment'
    assert engine.debit_category('other', 'NACH DR/KESARI FINSERV/PL EMI') == 'loan_emi'
    assert engine.debit_category('other', 'NEFT DR/HEALTH INSURANCE PREMIUM') == 'insurance'
    assert engine.debit_category('other', 'UPI/DR/GREENLEAF GROCERY MART') == 'other'
    assert engine.debit_channel('other', 'ACH DR/X') == 'ACH'
    assert engine.debit_channel('e-NACH', '') == 'NACH'


def test_recurring_auto_debit_without_category_is_possible_emi(pl):
    debits = rahul_debits() + [
        {'date': f'2026-0{m}-12', 'amount': 4100, 'narration': 'ECS DR/VAIBHAV CAPITAL',
         'channel': 'ECS', 'category': 'other'} for m in range(3, 9)]
    a = _applicant(_set_fields(rahul(), 'bank_statement', recurring_debits=debits), pl)
    (u,) = a['obligations']['undeclared_loan_debits']
    assert u['kind'] == 'possible_emi' and u['payee'] == 'VAIBHAV CAPITAL'
    row = _by_id(a['consistency'], 'check_id')['declared_emis_vs_bank_debits']
    assert row['status'] == 'REVIEW' and 'confirm whether it is a loan EMI' in row['detail']
    assert a['foir']['existing_emis'] == 8200  # not counted until a person confirms


def test_unverified_emi_amount_needs_review(pl):
    facts = rahul()
    for f in facts:
        if f['doc_type'] == 'bank_statement':
            idx = next(i for i, d in enumerate(f['fields']['recurring_debits'])
                       if d['narration'] == RAHUL_EMI[0])
            f['grounding']['unverified_fields'] = [f'recurring_debits[{idx}].amount']
    a = _applicant(facts, pl)
    row = _by_id(a['consistency'], 'check_id')['declared_emis_vs_bank_debits']
    assert row['status'] == 'REVIEW'
    assert "amount of 'MULSHI AUTO FINANCE / CAR LOAN EMI' not found in the document text" in row['detail']
    assert a['obligations']['fixed_loan_emis'][0]['unverified'] is True


def _strip_obligation_keys(facts):
    out = copy.deepcopy(facts)
    for f in out:
        for k in ('recurring_debits', 'declared_existing_emis', 'declared_total_existing_emi',
                  'loan_tenure_months'):
            f['fields'].pop(k, None)
    return out


def test_old_facts_without_obligations_are_needs_review_never_a_silent_pass(pl):
    res = engine.run_file_check(_strip_obligation_keys(rahul()), pl)
    a = res['applicants'][0]
    checks = _by_id(a['consistency'], 'check_id')
    emi, foir = checks['declared_emis_vs_bank_debits'], checks['foir']
    assert emi['status'] == 'REVIEW' and foir['status'] == 'REVIEW'
    assert emi['detail'].startswith('cannot be checked: debit details were not extracted from '
                                    '06_bank_statement_2026-03_to_2026-08.pdf')
    assert 're-run the analysis' in emi['detail']
    assert foir['detail'].startswith('not computed: existing EMIs unknown')
    o = a['obligations']
    assert o['available'] is False and o['declared_available'] is False
    assert len(o['unavailable_reasons']) == 2
    assert o['foir_emi_total'] is None and a['foir']['existing_emi_ratio'] is None
    assert len(a['needs_review']) == 2
    assert a['verdict'] == 'READY' and res['overall_verdict'] == 'READY'
    assert res['summary'] == '1 applicant: Rahul Vijay Deshmukh READY (2 to review)'


def test_declared_only_foir_is_review(pl):
    facts = _strip_obligation_keys(rahul())
    facts = _set_fields(facts, 'loan_application', declared_existing_emis=list(RAHUL_DECLARED),
                        declared_total_existing_emi=8200)
    a = _applicant(facts, pl)
    f = a['foir']
    assert f['existing_emis'] == 8200 and f['max_new_emi'] == 49550
    assert f['existing_emis_basis'] == 'declared EMIs only (bank debits not available)'
    assert f['status'] == 'REVIEW' and 'computed on partial data' in f['detail']
    row = _by_id(a['consistency'], 'check_id')['declared_emis_vs_bank_debits']
    assert 'declared: ₹8,200 Mulshi Auto Finance Ltd (sample)' in row['detail']
    assert a['obligations']['declared_emis'][0]['status'] == 'not_checked'


def test_no_bank_statement_is_review(pl):
    facts = [f for f in rahul() if f['doc_type'] != 'bank_statement']
    a = _applicant(facts, pl)
    row = _by_id(a['consistency'], 'check_id')['declared_emis_vs_bank_debits']
    assert row['status'] == 'REVIEW'
    assert 'no bank statement in the file' in row['detail']
    assert a['verdict'] == 'NOT READY'  # because the statement item is MISSING
    assert 'Bank statement' in a['missing_items'][0]


def test_foir_over_limit_is_review_unless_hard_limit(pl):
    big = _with_undeclared_nach(rahul(), amount=52000)  # 60,200 / 82,500 = 73 %
    a = _applicant(big, pl)
    f = a['foir']
    assert f['existing_emi_ratio_pct'] == 73.0 and f['within_limit'] is False
    assert f['max_new_emi'] == 0 and f['status'] == 'REVIEW'
    assert f['detail'].startswith('existing EMIs exceed FOIR 70%: ')
    assert a['verdict'] == 'READY'  # indicative only
    assert any(n.startswith('FOIR (indicative): existing EMIs exceed') for n in a['needs_review'])

    hard = copy.deepcopy(pl)
    hard['foir'] = {**hard['foir'], 'hard_limit': True}
    a = _applicant(big, hard)
    assert a['foir']['status'] == 'MISMATCH'
    assert a['verdict'] == 'NOT READY'
    assert any(m.startswith('FOIR (indicative): existing EMIs exceed') for m in a['mismatches'])


def test_checklist_without_foir_block_uses_engine_default(pl):
    custom = copy.deepcopy(pl)
    del custom['foir']
    f = _applicant(rahul(), custom)['foir']
    assert f['foir_limit'] == 0.7 and f['limit_basis'] == 'DEMO-POLICY'
    assert f['limit_source'].startswith('engine default')


def test_declared_income_only_foir_is_review(pl):
    facts = [f for f in rahul() if f['doc_type'] != 'salary_slip']
    facts = _set_fields(facts, 'bank_statement', salary_credits=[])
    f = _applicant(facts, pl)['foir']
    assert f['income_source'] == 'declared on the loan application, not verified'
    assert f['income_verified'] is False and f['status'] == 'REVIEW'


def test_declared_total_only_and_total_mismatch(pl):
    facts = _set_fields(rahul(), 'loan_application', declared_existing_emis=[],
                        declared_total_existing_emi=8200)
    a = _applicant(facts, pl)
    (dec,) = a['obligations']['declared_emis']
    assert dec['lender'] is None and dec['status'] == 'matched'
    facts = _set_fields(rahul(), 'loan_application', declared_total_existing_emi=12000)
    row = _by_id(_applicant(facts, pl)['consistency'], 'check_id')['declared_emis_vs_bank_debits']
    assert row['status'] == 'REVIEW'
    assert 'declared total existing EMI ₹12,000 differs from the listed EMIs ₹8,200' in row['detail']


def test_duplicate_debits_across_overlapping_statements_count_once(pl):
    facts = rahul()
    stmt = next(f for f in facts if f['doc_type'] == 'bank_statement')
    copy_stmt = copy.deepcopy(stmt)
    copy_stmt['document_id'] = 'r-bank2'
    copy_stmt['document_name'] = '06b_bank_statement_copy.pdf'
    a = _applicant(facts + [copy_stmt], pl)
    (emi,) = a['obligations']['fixed_loan_emis']
    assert emi['count'] == 6 and a['foir']['existing_emis'] == 8200


def test_validate_catalog_foir_and_emi_tolerance():
    cat = _catalog_with(foir={'value': 1.5})
    assert any('foir.value' in e for e in engine.validate_catalog(cat))
    cat = _catalog_with(foir={'value': 0.5, 'hard_limit': 'yes'})
    assert any('foir.hard_limit' in e for e in engine.validate_catalog(cat))
    cat = _catalog_with(foir=0.7)
    assert any('foir must be an object' in e for e in engine.validate_catalog(cat))
    cat = _catalog_with(emi_tolerance_pct=-1)
    assert any('emi_tolerance_pct' in e for e in engine.validate_catalog(cat))
    assert engine.validate_catalog(_catalog_with(emi_tolerance_pct=3)) == []


def test_assistant_instructions_mention_needs_review_and_foir_label(pl):
    text = engine.run_file_check(rahul(), pl)['assistant_instructions']
    assert 'needs_review' in text and LABEL in text


def test_mixed_old_and_new_statements_flag_the_old_one(pl):
    facts = rahul()
    old = copy.deepcopy(next(f for f in facts if f['doc_type'] == 'bank_statement'))
    old['document_id'], old['document_name'] = 'r-old', '05b_old_statement.pdf'
    old['fields'].pop('recurring_debits')
    a = _applicant(facts + [old], pl)
    row = _by_id(a['consistency'], 'check_id')['declared_emis_vs_bank_debits']
    assert row['status'] == 'REVIEW'
    assert 'debit details were not extracted from 05b_old_statement.pdf' in row['detail']
    assert 'declared ₹8,200 Mulshi Auto Finance' in row['detail']
    assert a['verdict'] == 'READY'


# ------------------------------------------------------------------ review fixes
def _stmt(facts):
    return next(f for f in facts if f['doc_type'] == 'bank_statement')


def _emi_row(a):
    return _by_id(a['consistency'], 'check_id')['declared_emis_vs_bank_debits']


def test_ground_truth_ratios_by_hand(pl):
    # README: Rahul 8,200 / 82,500 = 9.94 %, max at 70 % = 57,750 - 8,200 = 49,550;
    # Amit 3,450 / 71,200 = 4.85 %, max = 49,840 - 3,450 = 46,390;
    # Sneha 0 / 58,000, max = 40,600
    for facts, ratio, max_new in ((rahul(), 0.0994, 49550), (amit(), 0.0485, 46390),
                                  (sneha(), 0.0, 40600)):
        f = _applicant(facts, pl)['foir']
        assert (f['existing_emi_ratio'], f['max_new_emi'], f['status']) == (ratio, max_new, 'OK')
        assert f['label'] == LABEL


def test_credit_rows_listed_as_debits_are_ignored(pl):
    facts = rahul()
    _stmt(facts)['fields']['recurring_debits'] += [
        {'date': f'2026-0{m}-01', 'amount': 82500, 'category': 'other', 'channel': 'other',
         'narration': f'NEFT CR/SAL KONKAN SOFTWORKS/{_MON[m - 3]}26'} for m in range(3, 9)
    ] + [{'date': '2026-03-31', 'amount': 702.8, 'narration': 'INT CR/SAVINGS INTEREST',
          'category': 'other'},
         {'date': '2026-04-20', 'amount': 1500, 'narration': 'UPI/CR/FROM ROHAN KALE',
          'category': 'other'}]
    a = _applicant(facts, pl)
    o = a['obligations']
    assert o['totals'] == {'loan_emis': 8200, 'other_fixed': 24299,
                           'fixed_monthly': 32499, 'variable_monthly_average': 13265.5}
    assert '8 credit / balance rows listed as debits ignored' in o['notes']
    assert _emi_row(a)['status'] == 'OK' and a['foir']['status'] == 'OK'
    assert engine._is_credit_row('CC PAYMENT/SAHYADRI UCB CREDIT CARD') is False
    assert engine._is_credit_row('ACH DR/CR CARD EMI') is False


def test_total_row_in_declared_list_is_not_a_second_loan(pl):
    facts = _set_fields(rahul(), 'loan_application', declared_existing_emis=list(RAHUL_DECLARED) + [
        {'lender': 'Total existing EMI', 'loan_type': None, 'amount': 8200}])
    a = _applicant(facts, pl)
    assert [d['amount'] for d in a['obligations']['declared_emis']] == [8200]
    assert _emi_row(a)['status'] == 'OK'
    assert a['foir']['existing_emis'] == 8200 and a['needs_review'] == []
    # only the total row and no total field: the row is the total
    facts = _set_fields(rahul(), 'loan_application', declared_total_existing_emi=None,
                        declared_existing_emis=[{'lender': 'Total existing EMI', 'amount': 8200}])
    (dec,) = _applicant(facts, pl)['obligations']['declared_emis']
    assert dec['lender'] is None and dec['status'] == 'matched'


def test_statement_without_text_layer_amounts_are_unverified(pl):
    facts = rahul()
    _stmt(facts)['grounding']['grounded'] = False
    a = _applicant(facts, pl)
    assert _emi_row(a)['status'] == 'REVIEW'
    assert "amount of 'MULSHI AUTO FINANCE / CAR LOAN EMI' not found" in _emi_row(a)['detail']
    f = a['foir']
    assert f['status'] == 'REVIEW' and 'an EMI amount not verified' in f['detail']
    assert f['existing_emis'] == 8200 and a['verdict'] == 'READY'


def test_unverified_counted_emi_makes_foir_review(pl):
    facts = rahul()
    stmt = _stmt(facts)
    idx = next(i for i, d in enumerate(stmt['fields']['recurring_debits'])
               if d['narration'] == RAHUL_EMI[0])
    stmt['grounding']['unverified_fields'] = [f'recurring_debits[{idx}].amount']
    f = _applicant(facts, pl)['foir']
    assert f['status'] == 'REVIEW' and f['max_new_emi'] == 49550


@pytest.mark.parametrize('flag, text', [
    ('truncated', 'document text truncated for extraction'),
    ('output_truncated', 'extraction output hit the token limit'),
])
def test_truncated_statement_is_review_not_ok(pl, flag, text):
    facts = rahul()
    _stmt(facts)['grounding'][flag] = True
    a = _applicant(facts, pl)
    row = _emi_row(a)
    assert row['status'] == 'REVIEW' and text in row['detail']
    assert a['foir']['status'] == 'REVIEW'
    assert 'bank debits missing or incomplete for 06_bank_statement' in a['foir']['detail']
    assert a['verdict'] == 'READY' and len(a['needs_review']) == 2


def test_empty_debit_list_is_review_not_a_silent_pass(pl):
    # the model returned no obligation debits at all for a statement that has
    # rent, SIP and bills: 'no EMIs' must not pass unchecked
    facts = _set_fields(sneha(), 'bank_statement', recurring_debits=[])
    a = _applicant(facts, pl)
    row = _emi_row(a)
    assert row['status'] == 'REVIEW'
    assert ('no obligation debits (EMI, rent, SIP, bills) were extracted from '
            '05_bank_statement_2026-06_to_2026-08.pdf') in row['detail']
    assert a['foir']['status'] == 'REVIEW' and a['foir']['max_new_emi'] == 40600
    assert len(a['reasons']) == 5  # verdict reasons unchanged


def test_possible_emi_not_counted_makes_foir_review(pl):
    debits = rahul_debits() + [
        {'date': f'2026-0{m}-12', 'amount': 4100, 'narration': 'ECS DR/VAIBHAV CAPITAL',
         'channel': 'ECS', 'category': 'other'} for m in range(3, 9)]
    f = _applicant(_set_fields(rahul(), 'bank_statement', recurring_debits=debits), pl)['foir']
    assert f['existing_emis'] == 8200 and f['status'] == 'REVIEW'
    # (8,200 + 4,100) / 82,500 = 14.9 %
    assert "1 possible EMI not counted (₹4,100 'VAIBHAV CAPITAL'; with it FOIR is 14.9%)" in f['detail']


def test_mixed_old_and_new_statements_make_foir_review(pl):
    facts = rahul()
    old = copy.deepcopy(_stmt(facts))
    old['document_id'], old['document_name'] = 'r-old', '05b_old_statement.pdf'
    old['fields'].pop('recurring_debits')
    f = _applicant(facts + [old], pl)['foir']
    assert f['status'] == 'REVIEW'
    assert 'bank debits missing or incomplete for 05b_old_statement.pdf' in f['detail']


def test_new_loan_first_seen_in_latest_month_counts_toward_foir(pl):
    new = [{'date': '2026-08-10', 'amount': 6500, 'channel': 'NACH', 'category': 'loan_emi',
            'narration': 'NACH DR/KESARI FINSERV/PERSONAL LOAN EMI'}]
    a = _applicant(_set_fields(rahul(), 'bank_statement', recurring_debits=rahul_debits() + new), pl)
    assert a['foir']['existing_emis'] == 14700
    assert _emi_row(a)['status'] == 'REVIEW' and 'undeclared loan debit' in _emi_row(a)['detail']
    # a single loan debit months before the end (closed / prepaid) is flagged, not counted
    old = [dict(new[0], date='2026-04-10')]
    a = _applicant(_set_fields(rahul(), 'bank_statement', recurring_debits=rahul_debits() + old), pl)
    assert a['foir']['existing_emis'] == 8200
    assert _emi_row(a)['status'] == 'REVIEW'


def test_hard_limit_that_cannot_be_computed_is_not_ready(pl):
    hard = copy.deepcopy(pl)
    hard['foir'] = {**hard['foir'], 'hard_limit': True}
    a = _applicant(rahul(), hard)
    assert a['foir']['status'] == 'OK' and a['verdict'] == 'READY'
    a = _applicant(_strip_obligation_keys(rahul()), hard)
    assert a['foir']['status'] == 'MISMATCH'
    assert 'hard limit' in a['foir']['detail']
    assert a['verdict'] == 'NOT READY'
    # the indicative (default) FOIR never blocks
    assert _applicant(_strip_obligation_keys(rahul()), pl)['verdict'] == 'READY'
