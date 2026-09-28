"""Unit tests for normalize.py (synthetic data only, no AWS).

Run: python -m pytest -q   (from this folder)
"""
import os
import sys
from datetime import date

os.environ['BACKEND_TABLE_NAME'] = 'test-table'
os.environ['AWS_DEFAULT_REGION'] = 'ap-south-1'
os.environ['AWS_REGION'] = 'ap-south-1'
os.environ['AWS_ACCESS_KEY_ID'] = 'testing'
os.environ['AWS_SECRET_ACCESS_KEY'] = 'testing'

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', '..')))
sys.path.insert(0, HERE)

import pytest  # noqa: E402

from normalize import normalise_fields, normalise_fy, to_date, to_month, to_number  # noqa: E402
from normalize import normalise_category, normalise_channel  # noqa: E402
from tool_schema import FIELD_NAMES, LIST_FIELDS  # noqa: E402


def test_to_number():
    assert to_number('₹65,000.00') == 65000.0
    assert to_number('65000') == 65000.0
    assert to_number(65000) == 65000.0
    assert to_number(True) is None
    assert to_number(None) is None
    assert to_number('n/a') is None


def test_to_month():
    assert to_month('July 2026') == (2026, 7)
    assert to_month('Jul-2026') == (2026, 7)
    assert to_month('2026-07-01') == (2026, 7)
    assert to_month('2026-07') == (2026, 7)
    assert to_month('') is None


def test_to_date():
    assert to_date('01-Jun-2026') == date(2026, 6, 1)
    assert to_date('2026-06-01') == date(2026, 6, 1)
    assert to_date('01/06/2026') == date(2026, 6, 1)
    assert to_date('not a date') is None


def test_null_strings_and_bad_doc_type():
    out = normalise_fields({
        'doc_type': 'payslip',
        'applicant_name': 'null',
        'employer': 'N/A',
        'product': 'null',
        'loan_amount': '-',
        'month': 'none',
    })
    assert out['doc_type'] == 'other'
    assert out['applicant_name'] is None
    assert out['employer'] is None
    assert out['product'] is None
    assert out['loan_amount'] is None
    assert out['month'] is None


def test_every_field_present_and_empty_record():
    out = normalise_fields({})
    assert list(out) == FIELD_NAMES
    assert out['doc_type'] == 'other'
    assert all(out[k] == [] for k in LIST_FIELDS)
    assert all(out[k] is None for k in FIELD_NAMES if k != 'doc_type' and k not in LIST_FIELDS)
    assert normalise_fields(None)['doc_type'] == 'other'


def test_pan_aadhaar_month():
    out = normalise_fields({
        'doc_type': 'salary_slip',
        'pan': ' dmvpp 5928l ',
        'masked_aadhaar_last4': 'XXXX-XXXX-2619',
        'month': 'Aug 2026',
        'gross_salary': '₹80,000',
        'net_salary': 71200,
    })
    assert out['doc_type'] == 'salary_slip'
    assert out['pan'] == 'DMVPP5928L'
    assert out['masked_aadhaar_last4'] == '2619'
    assert out['month'] == '2026-08'
    assert out['gross_salary'] == 80000.0
    assert out['net_salary'] == 71200.0


@pytest.mark.parametrize('value', [
    'FY 2025-26', '2025-2026', '2025-26', '2025/26', 'AY 2026-27', 'A.Y. 2026-27',
    'Assessment Year 2026-2027', 'F.Y. 2025 – 26', 'FY 2025-26 (AY 2026-27)',
])
def test_financial_year(value):
    assert normalise_fy(value) == '2025-26'
    assert normalise_fields({'doc_type': 'form16_itr', 'financial_year': value})['financial_year'] == '2025-26'


@pytest.mark.parametrize('value', [None, '', 'null', '2025', '2025-27', 'FY', True])
def test_financial_year_invalid(value):
    assert normalise_fields({'doc_type': 'form16_itr', 'financial_year': value})['financial_year'] is None


def test_financial_year_century_rollover():
    assert normalise_fy('1999-00') == '1999-00'


def test_statement_period_and_salary_credits():
    out = normalise_fields({
        'doc_type': 'bank_statement',
        'statement_from': '01-Jun-2026',
        'statement_to': '31/08/2026',
        'salary_credits': [
            {'date': '01-Jun-2026', 'amount': '58,000.00', 'narration': 'NEFT CR/SAL DECCAN RETAIL PVT LTD/JUN26'},
            {'date': '2026-07-01', 'amount': 58000, 'narration': 'NEFT CR/SAL DECCAN RETAIL PVT LTD/JUL26'},
            {'date': 'sometime', 'amount': 'x', 'narration': 'odd'},
            'not a dict',
        ],
    })
    assert out['statement_from'] == '2026-06-01'
    assert out['statement_to'] == '2026-08-31'
    assert out['salary_credits'] == [
        {'date': '2026-06-01', 'amount': 58000.0, 'narration': 'NEFT CR/SAL DECCAN RETAIL PVT LTD/JUN26'},
        {'date': '2026-07-01', 'amount': 58000.0, 'narration': 'NEFT CR/SAL DECCAN RETAIL PVT LTD/JUL26'},
        {'date': 'sometime', 'amount': None, 'narration': 'odd'},
    ]


def test_unparseable_statement_date_is_kept():
    out = normalise_fields({'doc_type': 'bank_statement', 'statement_from': 'June 2026'})
    assert out['statement_from'] == 'June 2026'


# --------------------------------------------------------------------------- #
# obligations (synthetic demo applicants)
# --------------------------------------------------------------------------- #
def test_channel_and_category_normalisation():
    assert normalise_channel('e-NACH') == 'NACH'
    assert normalise_channel('Standing Instruction') == 'SI'
    assert normalise_channel('ach') == 'ACH'
    assert normalise_channel('other', 'ACH DR/MULSHI AUTO FINANCE/CAR LOAN EMI') == 'ACH'
    assert normalise_channel(None, 'NACH DR/XYZ FINSERV/PL EMI') == 'NACH'
    assert normalise_channel('NEFT', 'NEFT DR/RENT MAR26/VASANT JOSHI') == 'other'
    assert normalise_channel(None, 'BILLPAY/DR/ELECTRICITY BILL') == 'other'
    assert normalise_category('Loan EMI') == 'loan_emi'
    assert normalise_category('EMI') == 'loan_emi'
    assert normalise_category('SIP') == 'investment'
    assert normalise_category('credit card') == 'credit_card'
    assert normalise_category('utility') == 'utility'
    assert normalise_category('groceries') == 'other'
    assert normalise_category(None) == 'other'


def test_recurring_debits_normalised():
    out = normalise_fields({
        'doc_type': 'bank_statement',
        'recurring_debits': [
            {'date': '05-Mar-2026', 'amount': '8,200.00', 'narration': 'ACH DR/MULSHI AUTO FINANCE/CAR LOAN EMI',
             'channel': 'ach', 'category': 'Loan EMI'},
            {'date': '2026-03-03', 'amount': -18000, 'narration': 'NEFT DR/RENT MAR26/VASANT JOSHI',
             'category': 'rent'},
            {'date': '07/03/2026', 'amount': 5000, 'narration': 'ACH DR/SIP/SAMPLE ASSET MGMT MF',
             'channel': 'other', 'category': 'SIP'},
            {'date': '2026-03-11', 'amount': 'n/a', 'narration': 'no amount', 'category': 'utility'},
            {'date': '2026-03-12', 'amount': 0, 'narration': 'zero', 'category': 'utility'},
            'not a dict',
        ],
    })
    assert out['recurring_debits'] == [
        {'date': '2026-03-05', 'amount': 8200.0, 'narration': 'ACH DR/MULSHI AUTO FINANCE/CAR LOAN EMI',
         'channel': 'ACH', 'category': 'loan_emi'},
        {'date': '2026-03-03', 'amount': 18000.0, 'narration': 'NEFT DR/RENT MAR26/VASANT JOSHI',
         'channel': 'other', 'category': 'rent'},
        {'date': '2026-03-07', 'amount': 5000.0, 'narration': 'ACH DR/SIP/SAMPLE ASSET MGMT MF',
         'channel': 'ACH', 'category': 'investment'},
    ]


def test_declared_emis_rahul_and_requested_loan():
    out = normalise_fields({
        'doc_type': 'loan_application',
        'declared_net_salary': '82,500',
        'declared_existing_emis': [
            {'lender': 'Mulshi Auto Finance Ltd (sample)', 'loan_type': 'Car loan', 'amount': '₹8,200'},
            {'lender': 'None declared', 'amount': 0},
            {'lender': 'n/a', 'loan_type': '-', 'amount': None},
        ],
        'declared_total_existing_emi': '₹8,200',
        'loan_amount': '6,00,000',
        'loan_tenure_months': '48',
    })
    assert out['declared_existing_emis'] == [
        {'lender': 'Mulshi Auto Finance Ltd (sample)', 'loan_type': 'Car loan', 'amount': 8200.0}]
    assert out['declared_total_existing_emi'] == 8200.0
    assert out['loan_amount'] == 600000.0
    assert out['loan_tenure_months'] == 48.0


def test_declared_none_sneha():
    out = normalise_fields({'doc_type': 'loan_application', 'declared_existing_emis': [],
                            'declared_total_existing_emi': 0, 'loan_amount': 400000, 'loan_tenure_months': 36})
    assert out['declared_existing_emis'] == []
    assert out['declared_total_existing_emi'] == 0.0
    assert out['loan_tenure_months'] == 36.0


def test_declared_emi_list_not_a_list_is_empty():
    out = normalise_fields({'doc_type': 'loan_application', 'declared_existing_emis': 'Car loan 8200',
                            'recurring_debits': {'amount': 1}})
    assert out['declared_existing_emis'] == [] and out['recurring_debits'] == []


def test_total_row_copied_as_a_loan_is_moved_to_the_total():
    # the model copies the table's 'Total existing EMI' row as one more loan
    out = normalise_fields({'doc_type': 'loan_application', 'declared_existing_emis': [
        {'lender': 'Mulshi Auto Finance Ltd (sample)', 'loan_type': 'Car loan', 'amount': 8200},
        {'lender': 'Total existing EMI', 'amount': 8200},
    ]})
    assert out['declared_existing_emis'] == [
        {'lender': 'Mulshi Auto Finance Ltd (sample)', 'loan_type': 'Car loan', 'amount': 8200.0}]
    assert out['declared_total_existing_emi'] == 8200.0
    # an explicit total wins over the copied row
    out = normalise_fields({'doc_type': 'loan_application', 'declared_total_existing_emi': 11650,
                            'declared_existing_emis': [{'lender': 'Grand total', 'amount': 9999}]})
    assert out['declared_existing_emis'] == [] and out['declared_total_existing_emi'] == 11650.0
    # a lender whose name merely contains 'total' is a loan
    out = normalise_fields({'doc_type': 'loan_application', 'declared_existing_emis': [
        {'lender': 'Subtotal Finance Ltd', 'amount': 3450}]})
    assert [e['amount'] for e in out['declared_existing_emis']] == [3450.0]
