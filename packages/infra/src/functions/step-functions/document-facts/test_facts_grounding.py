"""Unit tests for grounding.py with the interfaces section 12 raw misreads (synthetic data only).

Run: python -m pytest -q   (from this folder)
"""
import os
import sys

os.environ['BACKEND_TABLE_NAME'] = 'test-table'
os.environ['AWS_DEFAULT_REGION'] = 'ap-south-1'
os.environ['AWS_REGION'] = 'ap-south-1'
os.environ['AWS_ACCESS_KEY_ID'] = 'testing'
os.environ['AWS_SECRET_ACCESS_KEY'] = 'testing'

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', '..')))
sys.path.insert(0, HERE)

from grounding import PAN_RE, ground_fields, inr, lev, unverified_numbers  # noqa: E402
from normalize import normalise_fields  # noqa: E402

IDENTITY_TEXT = (
    'IDENTITY DETAILS - SELF DECLARATION\n'
    'Full name\nRahul Vijay Deshmukh\n'
    'PAN\nBQXPD4821K\n'
    'Aadhaar (masked)\nXXXX-XXXX-7304\n'
)

SLIP_TEXT = (
    'Salary Slip - Page 1\nVarad Logistics\n'
    'Salary slip for the month of August 2026\n'
    'Employee name\nAmit Suresh Patil\nPAN\nDMVPP5928L\n'
    'Gross Earnings\n80,000\nNET PAY (take-home)\n₹71,200\n'
)

FORM16_TEXT = (
    'FORM-16 / ITR SUMMARY FY 2025-26 (AY 2026-27)\n'
    'Employee\nRahul Vijay Deshmukh\nPAN of the employee\nBQXPD4821K\n'
    'Employer\nKonkan Softworks Pvt Ltd\n1. Gross salary\n11,40,000\n'
)

BANK_TEXT = (
    'STATEMENT OF ACCOUNT\nAccount holder\nRAHUL VIJAY DESHMUKH\n'
    'Period: 01-Mar-2026 to 31-Aug-2026\n'
    'Reference PAN on file: BQXPD4821K\n'
    '01-Mar-2026\nNEFT CR/SAL KONKAN SOFTWORKS/MAR26\n\n82,500.00\n'
)


def test_lev_and_inr():
    assert lev('BQXPD4821K', 'BQXP4821K') == 1
    assert lev('DMVPP5926L', 'DMVPP5928L') == 1
    assert lev('', 'abc') == 3
    assert inr(600000) == '₹6,00,000'
    assert inr(1140000) == '₹11,40,000'
    assert inr(82500.5) == '₹82,500.50'
    assert inr(-950) == '-₹950'
    assert inr(None) == '–'
    assert PAN_RE.findall('pan BQXPD4821K and bqxpd4821k') == ['BQXPD4821K']


def test_pan_missing_letter_is_corrected_with_note():
    fields = normalise_fields({'doc_type': 'identity_details', 'pan': 'BQXP4821K',
                               'masked_aadhaar_last4': '7304', 'applicant_name': 'Rahul Vijay Deshmukh'})
    out, notes = ground_fields(fields, IDENTITY_TEXT)
    assert out['pan'] == 'BQXPD4821K'
    assert any('PAN corrected' in n and 'BQXPD4821K' in n for n in notes)
    assert fields['pan'] == 'BQXP4821K', 'input dict must not be mutated'


def test_pan_extra_letter_is_corrected():
    fields = normalise_fields({'doc_type': 'salary_slip', 'pan': 'DMVPPS5928L',
                               'gross_salary': 80000, 'net_salary': 71200})
    out, notes = ground_fields(fields, SLIP_TEXT)
    assert out['pan'] == 'DMVPP5928L'
    assert len(notes) == 1


def test_pan_filled_when_absent_and_single_pan_in_text():
    out, notes = ground_fields(normalise_fields({'doc_type': 'form16_itr'}), FORM16_TEXT)
    assert out['pan'] == 'BQXPD4821K'
    assert notes == ["PAN filled from text layer: 'BQXPD4821K'"]


def test_pan_not_filled_on_bank_statement():
    out, notes = ground_fields(normalise_fields({'doc_type': 'bank_statement'}), BANK_TEXT)
    assert out['pan'] is None
    assert not any('PAN' in n for n in notes)


def test_pan_not_filled_when_text_has_two_pans():
    text = IDENTITY_TEXT + 'Co-applicant PAN\nCKRPK7314M\n'
    out, _ = ground_fields(normalise_fields({'doc_type': 'identity_details'}), text)
    assert out['pan'] is None


def test_correct_pan_is_kept():
    out, notes = ground_fields(normalise_fields({'doc_type': 'identity_details', 'pan': 'BQXPD4821K'}),
                               IDENTITY_TEXT)
    assert out['pan'] == 'BQXPD4821K'
    assert notes == []


def test_aadhaar_corrected():
    out, notes = ground_fields(
        normalise_fields({'doc_type': 'identity_details', 'pan': 'BQXPD4821K', 'masked_aadhaar_last4': '7340'}),
        IDENTITY_TEXT)
    assert out['masked_aadhaar_last4'] == '7304'
    assert any('Aadhaar last-4 corrected' in n for n in notes)


def test_form16_gross_extra_zero_is_corrected():
    fields = normalise_fields({'doc_type': 'form16_itr', 'pan': 'BQXPD4821K', 'gross_salary': 11400000,
                               'financial_year': 'FY 2025-26', 'product': 'null'})
    assert fields['product'] is None
    out, notes = ground_fields(fields, FORM16_TEXT)
    assert out['gross_salary'] == 1140000.0
    assert any('gross_salary corrected' in n and '₹11,40,000' in n for n in notes)


def test_amount_divided_and_salary_credit_fixed():
    fields = normalise_fields({'doc_type': 'bank_statement', 'salary_credits': [
        {'date': '01-Mar-2026', 'amount': 8250, 'narration': 'NEFT CR/SAL KONKAN SOFTWORKS/MAR26'}]})
    out, notes = ground_fields(fields, BANK_TEXT)
    assert out['salary_credits'][0]['amount'] == 82500.0
    assert out['salary_credits'][0]['narration'] == 'NEFT CR/SAL KONKAN SOFTWORKS/MAR26'
    assert any('salary credit 2026-03-01 corrected' in n for n in notes)


def test_unknown_amount_left_unchanged():
    fields = normalise_fields({'doc_type': 'salary_slip', 'net_salary': 12345})
    out, _ = ground_fields(fields, SLIP_TEXT)
    assert out['net_salary'] == 12345.0


def test_noop_when_text_shorter_than_50_chars():
    fields = normalise_fields({'doc_type': 'identity_details', 'pan': 'BQXP4821K', 'gross_salary': 11400000})
    out, notes = ground_fields(fields, 'PAN BQXPD4821K 11,40,000')
    assert out is fields
    assert notes == []
    assert ground_fields(fields, '')[1] == []
    assert ground_fields(fields, None)[1] == []


def test_unverified_numbers():
    fields = normalise_fields({'doc_type': 'salary_slip', 'gross_salary': 80000, 'net_salary': 70000})
    assert unverified_numbers(fields, SLIP_TEXT) == ['net_salary']
    assert unverified_numbers(normalise_fields({'doc_type': 'salary_slip', 'gross_salary': 80000,
                                                'net_salary': 71200}), SLIP_TEXT) == []
    assert unverified_numbers(fields, 'Net pay 70,000') == []


def test_unverified_salary_credit():
    fields = normalise_fields({'doc_type': 'bank_statement', 'salary_credits': [
        {'date': '2026-03-01', 'amount': 82500, 'narration': 'x'},
        {'date': '2026-04-01', 'amount': 99999, 'narration': 'y'}]})
    assert unverified_numbers(fields, BANK_TEXT) == ['salary_credits[1].amount']


# --------------------------------------------------------------------------- #
# obligations: recurring debits and declared EMIs (synthetic demo text)
# --------------------------------------------------------------------------- #
RAHUL_BANK_TEXT = (
    'STATEMENT OF ACCOUNT\nAccount holder RAHUL VIJAY DESHMUKH\nPeriod: 01-Mar-2026 to 31-Aug-2026\n'
    '01-Mar-2026 NEFT CR/SAL KONKAN SOFTWORKS/MAR26 SAHYN7438010963 82,500.00 2,01,142.35\n'
    '03-Mar-2026 NEFT DR/RENT MAR26/VASANT JOSHI SAHYN7467648334 18,000.00 1,83,142.35\n'
    '05-Mar-2026 ACH DR/MULSHI AUTO FINANCE/CAR LOAN EMI ACH11261866 8,200.00 1,74,942.35\n'
    '07-Mar-2026 ACH DR/SIP/SAMPLE ASSET MGMT MF ACH89348362 5,000.00 1,69,942.35\n'
    '25-Mar-2026 BILLPAY/DR/MOBILE & BROADBAND BP756664639 1,299.00 1,44,602.35\n'
)

RAHUL_APP_TEXT = (
    'PERSONAL LOAN APPLICATION FORM\nLoan amount requested ₹6,00,000 (Rupees Six Lakh Only) Tenure 48 months\n'
    'Full name Rahul Vijay Deshmukh PAN BQXPD4821K Net monthly salary ₹82,500\n'
    '4. EXISTING OBLIGATIONS (AS DECLARED BY APPLICANT)\n'
    'Mulshi Auto Finance Ltd (sample) Car loan ₹8,200 22 months\nTotal existing EMI ₹8,200\n'
)


def _debit(date, amount, narration, category, channel='other'):
    return {'date': date, 'amount': amount, 'narration': narration, 'channel': channel, 'category': category}


def test_recurring_debit_dropped_digit_is_corrected():
    fields = normalise_fields({'doc_type': 'bank_statement', 'recurring_debits': [
        _debit('2026-03-05', 820, 'ACH DR/MULSHI AUTO FINANCE/CAR LOAN EMI', 'loan_emi', 'ACH'),
        _debit('2026-03-03', 18000, 'NEFT DR/RENT MAR26/VASANT JOSHI', 'rent')]})
    out, notes = ground_fields(fields, RAHUL_BANK_TEXT)
    assert [d['amount'] for d in out['recurring_debits']] == [8200.0, 18000.0]
    assert notes == ['debit 2026-03-05 corrected from text layer: model read ₹820, document text says ₹8,200']
    assert unverified_numbers(out, RAHUL_BANK_TEXT) == []
    assert fields['recurring_debits'][0]['amount'] == 820.0, 'input dict must not be mutated'


def test_ungrounded_recurring_debit_is_marked_unverified():
    fields = normalise_fields({'doc_type': 'bank_statement', 'recurring_debits': [
        _debit('2026-03-05', 8200, 'ACH DR/MULSHI AUTO FINANCE/CAR LOAN EMI', 'loan_emi', 'ACH'),
        _debit('2026-03-10', 12345, 'NACH DR/UNKNOWN FINSERV/PL EMI', 'loan_emi', 'NACH')]})
    out, _ = ground_fields(fields, RAHUL_BANK_TEXT)
    assert out['recurring_debits'][1]['amount'] == 12345.0  # kept, but flagged
    assert unverified_numbers(out, RAHUL_BANK_TEXT) == ['recurring_debits[1].amount']


def test_declared_emi_and_requested_loan_grounded():
    fields = normalise_fields({
        'doc_type': 'loan_application', 'pan': 'BQXPD4821K', 'declared_net_salary': 82500,
        'declared_existing_emis': [{'lender': 'Mulshi Auto Finance Ltd (sample)', 'loan_type': 'Car loan',
                                    'amount': 82000}],
        'declared_total_existing_emi': 8200, 'loan_amount': 600000, 'loan_tenure_months': 48})
    out, notes = ground_fields(fields, RAHUL_APP_TEXT)
    assert out['declared_existing_emis'][0]['amount'] == 8200.0
    assert notes == ['declared EMI (Mulshi Auto Finance Ltd (sample)) corrected from text layer: '
                     'model read ₹82,000, document text says ₹8,200']
    assert unverified_numbers(out, RAHUL_APP_TEXT) == []


def test_ungrounded_declared_emi_and_tenure_are_unverified():
    fields = normalise_fields({
        'doc_type': 'loan_application',
        'declared_existing_emis': [{'lender': 'Mulshi Auto Finance Ltd (sample)', 'amount': 9100}],
        'declared_total_existing_emi': 9100, 'loan_tenure_months': 60})
    out, _ = ground_fields(fields, RAHUL_APP_TEXT)
    assert unverified_numbers(out, RAHUL_APP_TEXT) == [
        'declared_total_existing_emi', 'loan_tenure_months', 'declared_existing_emis[0].amount']


def test_declared_none_zero_total_is_grounded():
    text = RAHUL_APP_TEXT.replace('Mulshi Auto Finance Ltd (sample) Car loan ₹8,200 22 months\n'
                                  'Total existing EMI ₹8,200\n', 'None declared – ₹0 –\n')
    fields = normalise_fields({'doc_type': 'loan_application', 'pan': 'BQXPD4821K', 'declared_existing_emis': [],
                               'declared_total_existing_emi': 0})
    out, notes = ground_fields(fields, text)
    assert out['declared_total_existing_emi'] == 0.0 and notes == []
    assert unverified_numbers(out, text) == []


def test_old_record_without_obligation_keys_is_left_alone():
    old = {'doc_type': 'bank_statement', 'salary_credits': [
        {'date': '2026-03-01', 'amount': 82500, 'narration': 'NEFT CR/SAL KONKAN SOFTWORKS/MAR26'}]}
    out, _ = ground_fields(old, RAHUL_BANK_TEXT)
    assert 'recurring_debits' not in out and 'declared_existing_emis' not in out
    assert unverified_numbers(old, RAHUL_BANK_TEXT) == []
