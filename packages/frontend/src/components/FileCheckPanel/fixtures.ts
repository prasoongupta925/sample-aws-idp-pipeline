// Synthetic file-check responses (shape of engine.run_file_check) for tests.
import type { FileCheckResult } from '../../types/fileCheck';

export const NOT_READY_RESULT: FileCheckResult = {
  project_id: 'proj_demo',
  engine_version: '1.0',
  as_of: '2026-09-28',
  checklist: {
    id: 'salaried_personal_loan',
    name: 'Personal Loan - Salaried',
  },
  overall_verdict: 'NOT READY',
  summary: '1 applicant: Amit Suresh Patil NOT READY (3 issues)',
  applicants: [
    {
      applicant: 'Amit Suresh Patil',
      pan: 'ABCPP1234K',
      verdict: 'NOT READY',
      reference_month: '2026-08',
      reference_month_label: 'Aug 2026',
      documents: [
        {
          document_id: 'd1',
          document_name: 'application.pdf',
          doc_type: 'loan_application',
          grounded: true,
          grounding_notes: [],
          unverified_fields: [],
        },
        {
          document_id: 'd2',
          document_name: 'slip_aug.pdf',
          doc_type: 'salary_slip',
          grounded: false,
          grounding_notes: [],
          unverified_fields: ['net_salary'],
        },
      ],
      checklist: [
        {
          item_id: 'application',
          item: 'Loan application form',
          required: true,
          status: 'PRESENT',
          ok: true,
          detail: 'application.pdf',
          documents: ['application.pdf'],
        },
        {
          item_id: 'salary_slips',
          item: 'Salary slips (last 3 months)',
          required: true,
          status: 'MISSING',
          ok: false,
          detail:
            'missing Jun 2026, Jul 2026 slip(s); found: Aug 2026 (slip_aug.pdf)',
          documents: ['slip_aug.pdf'],
          required_months: ['2026-06', '2026-07', '2026-08'],
          missing_months: ['2026-06', '2026-07'],
        },
        {
          item_id: 'address_proof',
          item: 'Address proof',
          required: true,
          status: 'REVIEW',
          ok: null,
          detail: 'cannot be verified automatically; review manually',
          documents: [],
        },
        {
          item_id: 'form16',
          item: 'Form-16 / ITR',
          required: false,
          status: 'MISSING',
          ok: false,
          detail: 'not found in the file',
          documents: [],
        },
      ],
      consistency: [
        {
          check_id: 'pan',
          check: 'PAN',
          status: 'OK',
          detail: 'ABCPP1234K on all 2 documents that carry a PAN',
          documents: ['application.pdf', 'slip_aug.pdf'],
        },
        {
          check_id: 'declared_vs_slip_net',
          check: 'Declared net salary vs salary slips',
          status: 'MISMATCH',
          detail:
            'declared ₹72,000 [application.pdf] vs slip net ₹55,000 [slip_aug.pdf] – 23.6% apart',
          documents: ['application.pdf', 'slip_aug.pdf'],
        },
      ],
      income: {
        declared_net: 72000,
        slip_net: 55000,
        slip_gross: 72000,
        bank_salary_credit: null,
        form16_gross: null,
        slip_gross_x12: 864000,
        bank_credits: [],
      },
      reasons: [
        'MISSING – Salary slips (last 3 months): missing Jun 2026, Jul 2026 slip(s); found: Aug 2026 (slip_aug.pdf)',
        'REVIEW – Address proof: cannot be verified automatically; review manually',
        'MISMATCH – Declared net salary vs salary slips: declared ₹72,000 [application.pdf] vs slip net ₹55,000 [slip_aug.pdf] – 23.6% apart',
      ],
      missing_items: ['Salary slips: Jun 2026, Jul 2026'],
      mismatches: [
        'Declared net salary vs salary slips: declared ₹72,000 [application.pdf] vs slip net ₹55,000 [slip_aug.pdf] – 23.6% apart',
      ],
      manual_review: ['Address proof'],
    },
  ],
  pending_documents: [],
  failed_documents: [],
  no_facts_documents: [],
  unsupported_documents: [
    {
      document_id: 'd9',
      document_name: 'statement.xlsx',
      file_type:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      reason:
        'spreadsheet documents are not read by the file check; upload the statement as PDF',
    },
  ],
  unassigned_documents: [],
};

const EMI_DETAIL =
  "declared ₹8,200 Mulshi Auto Finance Ltd (sample) (Car loan) [01_loan_application_form.pdf] = ACH debit ₹8,200 'MULSHI AUTO FINANCE / CAR LOAN EMI' on the 5th in 6 of 6 months (Mar 2026 – Aug 2026) [06_bank_statement.pdf]; undeclared loan debit: NACH debit ₹6,500 'KESARI FINSERV / PERSONAL LOAN EMI' on the 10th in 6 of 6 months (Mar 2026 – Aug 2026) [06_bank_statement.pdf]; not on the application [01_loan_application_form.pdf]";

/** READY with a REVIEW finding (engine test_undeclared_emi_is_needs_review_not_blocking). */
export const READY_WITH_REVIEW_RESULT: FileCheckResult = {
  project_id: 'proj_demo',
  engine_version: '1.0',
  as_of: '2026-09-28',
  checklist: {
    id: 'salaried_personal_loan',
    name: 'Personal Loan - Salaried',
  },
  overall_verdict: 'READY',
  summary: '1 applicant: Rahul Vijay Deshmukh READY (1 to review)',
  applicants: [
    {
      applicant: 'Rahul Vijay Deshmukh',
      pan: 'BQXPD4821K',
      verdict: 'READY',
      reference_month: '2026-08',
      reference_month_label: 'Aug 2026',
      documents: [],
      checklist: [
        {
          item_id: 'application',
          item: 'Loan application form',
          required: true,
          status: 'PRESENT',
          ok: true,
          detail: '01_loan_application_form.pdf',
          documents: ['01_loan_application_form.pdf'],
        },
      ],
      consistency: [
        {
          check_id: 'declared_emis_vs_bank_debits',
          check: 'Declared EMIs vs bank debits',
          status: 'REVIEW',
          detail: EMI_DETAIL,
          documents: ['01_loan_application_form.pdf', '06_bank_statement.pdf'],
        },
      ],
      income: {
        declared_net: 82500,
        slip_net: 82500,
        bank_salary_credit: 82500,
        bank_credits: [],
      },
      reasons: [],
      missing_items: [],
      mismatches: [],
      needs_review: [`Declared EMIs vs bank debits: ${EMI_DETAIL}`],
      manual_review: [],
      obligations: { available: true, declared_available: true },
      foir: {
        label: "indicative — the lender's policy decides",
        foir_limit_pct: 70,
        net_monthly_income: 82500,
        income_source: 'salary slips, median net pay',
        existing_emis: 14700,
        existing_emi_ratio_pct: 17.8,
        max_new_emi: 43050,
        status: 'OK',
      },
    },
  ],
  pending_documents: [],
  failed_documents: [],
  no_facts_documents: [],
  unsupported_documents: [],
  unassigned_documents: [],
};
