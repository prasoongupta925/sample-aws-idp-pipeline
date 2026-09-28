"""Converse tool schema for loan-file facts extraction (Amazon Nova 2 Lite).

Port of the Plan B lean-file-check TOOL_SCHEMA, plus financial_year.
Plain (non-nullable) JSON types only: Nova tool use degrades badly with
["string", "null"] unions. A missing field is simply omitted by the model.
"""

DOC_TYPES = [
    'loan_application',
    'identity_details',
    'salary_slip',
    'bank_statement',
    'form16_itr',
    'other',
]

TOOL_NAME = 'record_loan_document'
TOOL_DESCRIPTION = 'Record the structured fields of one loan-file document.'

_NUM = {'type': 'number'}
_STR = {'type': 'string'}

TOOL_SCHEMA = {
    'type': 'object',
    'properties': {
        'doc_type': {
            'type': 'string',
            'enum': DOC_TYPES,
            'description': 'loan_application = loan application form; identity_details = identity / KYC '
                           'details sheet; salary_slip = monthly payslip; bank_statement = bank account '
                           'statement; form16_itr = Form-16 or ITR summary; other = anything else',
        },
        'applicant_name': {**_STR, 'description': 'Applicant / employee / account-holder full name exactly as printed'},
        'pan': {**_STR, 'description': 'PAN exactly as printed (10 chars), omit if not on the document'},
        'masked_aadhaar_last4': {**_STR, 'description': 'Last 4 digits of the masked Aadhaar, omit if absent'},
        'employer': {**_STR, 'description': 'Employer name exactly as printed; omit on bank statements'},
        'month': {**_STR, 'description': 'Salary slips only: pay month as YYYY-MM'},
        'gross_salary': {**_NUM, 'description': 'Salary slip: gross earnings for the month. Form-16: gross annual salary'},
        'net_salary': {**_NUM, 'description': 'Salary slip: net pay (take-home) for the month'},
        'statement_from': {**_STR, 'description': 'Bank statement period start as YYYY-MM-DD'},
        'statement_to': {**_STR, 'description': 'Bank statement period end as YYYY-MM-DD'},
        'salary_credits': {
            'type': 'array',
            'description': 'Bank statement: EVERY salary credit row (narration contains SAL / SALARY), one per month',
            'items': {
                'type': 'object',
                'properties': {
                    'date': {'type': 'string', 'description': 'YYYY-MM-DD'},
                    'amount': {'type': 'number'},
                    'narration': {'type': 'string'},
                },
                'required': ['date', 'amount', 'narration'],
            },
        },
        'declared_net_salary': {**_NUM, 'description': 'Loan application: net monthly (take-home) salary declared'},
        'loan_amount': {**_NUM, 'description': 'Loan application: loan amount requested'},
        'product': {**_STR, 'description': 'Loan application: loan product, e.g. Personal Loan'},
        'financial_year': {**_STR, 'description': 'Form-16 / ITR only: financial year as YYYY-YY, e.g. 2025-26'},
    },
    'required': ['doc_type'],
}

# Amount fields that are grounded against the printed numbers of the document.
NUMERIC_FIELDS = ('gross_salary', 'net_salary', 'declared_net_salary', 'loan_amount')

# Canonical field order of a normalised facts record (includes doc_type).
FIELD_NAMES = list(TOOL_SCHEMA['properties'])
