"""Converse tool schema for loan-file facts extraction (Amazon Nova 2 Lite).

Port of the Plan B lean-file-check TOOL_SCHEMA, plus financial_year.
Plain (non-nullable) JSON types only: Nova tool use degrades badly with
["string", "null"] unions. A missing field is simply omitted by the model.

Obligations (FOIR input): bank statements carry recurring_debits (loan EMIs,
rent, SIP, insurance, utility bills, credit-card payments; one entry per
transaction) and loan applications carry declared_existing_emis /
declared_total_existing_emi. Records extracted before these fields existed
simply lack the keys; the file-check engine reports that as NEEDS REVIEW.
"""

DOC_TYPES = [
    'loan_application',
    'identity_details',
    'salary_slip',
    'bank_statement',
    'form16_itr',
    'other',
]

# Payment channel of a bank debit and what the debit pays for.
DEBIT_CHANNELS = ['ACH', 'NACH', 'ECS', 'SI', 'UPI', 'other']
DEBIT_CATEGORIES = ['loan_emi', 'rent', 'investment', 'utility', 'credit_card', 'insurance', 'other']

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
        'recurring_debits': {
            'type': 'array',
            'description': 'Bank statement: EVERY debit row that pays a loan EMI, rent, SIP / mutual fund / RD, '
                           'insurance premium, utility / phone / broadband / electricity bill or credit-card '
                           'bill, one entry per transaction in every month (include one-off premiums). '
                           'Skip groceries, shopping, fuel, restaurants, medical stores, ATM withdrawals and credits',
            'items': {
                'type': 'object',
                'properties': {
                    'date': {'type': 'string', 'description': 'YYYY-MM-DD'},
                    'amount': {'type': 'number', 'description': 'Withdrawal amount of this row'},
                    'narration': {'type': 'string', 'description': 'Narration exactly as printed'},
                    'channel': {'type': 'string', 'enum': DEBIT_CHANNELS,
                                'description': 'ACH / NACH / ECS / SI (standing instruction) / UPI, else other'},
                    'category': {'type': 'string', 'enum': DEBIT_CATEGORIES,
                                 'description': 'loan_emi = repayment of a loan (EMI); investment = SIP, mutual '
                                                'fund, RD; utility = electricity, phone, broadband, DTH bills; '
                                                'credit_card = credit-card bill payment (not an EMI)'},
                },
                'required': ['date', 'amount', 'narration', 'category'],
            },
        },
        'declared_net_salary': {**_NUM, 'description': 'Loan application: net monthly (take-home) salary declared'},
        'declared_existing_emis': {
            'type': 'array',
            'description': 'Loan application: every existing loan the applicant declared (existing obligations '
                           'section), one entry per loan. A credit card that is not an EMI is not a loan. '
                           'Empty when none is declared',
            'items': {
                'type': 'object',
                'properties': {
                    'lender': {'type': 'string', 'description': 'Lender name exactly as printed'},
                    'loan_type': {'type': 'string', 'description': 'Facility, e.g. Car loan'},
                    'amount': {'type': 'number', 'description': 'Monthly EMI'},
                },
                'required': ['amount'],
            },
        },
        'declared_total_existing_emi': {**_NUM, 'description': 'Loan application: total existing monthly EMI '
                                                               'declared (0 when none is declared)'},
        'loan_amount': {**_NUM, 'description': 'Loan application: loan amount requested'},
        'loan_tenure_months': {**_NUM, 'description': 'Loan application: requested tenure in months'},
        'product': {**_STR, 'description': 'Loan application: loan product, e.g. Personal Loan'},
        'financial_year': {**_STR, 'description': 'Form-16 / ITR only: financial year as YYYY-YY, e.g. 2025-26'},
    },
    'required': ['doc_type'],
}

# Amount fields that are grounded against the printed numbers of the document.
NUMERIC_FIELDS = ('gross_salary', 'net_salary', 'declared_net_salary', 'declared_total_existing_emi',
                  'loan_amount', 'loan_tenure_months')

# List fields: always present in a normalised record, [] when empty.
LIST_FIELDS = ('salary_credits', 'recurring_debits', 'declared_existing_emis')

# Canonical field order of a normalised facts record (includes doc_type).
FIELD_NAMES = list(TOOL_SCHEMA['properties'])
