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
from tool_schema import FIELD_NAMES  # noqa: E402


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
    assert out['salary_credits'] == []
    assert all(out[k] is None for k in FIELD_NAMES if k not in ('doc_type', 'salary_credits'))
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
