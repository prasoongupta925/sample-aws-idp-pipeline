// POST .../eligibility/calculate answers of the backend's own engine
// (app/eligibility.py with tests/fixtures/policy_workbook_v2.xlsx and the
// synthetic applicants of tests/test_lender_policy.py), cut to what the
// "Before you check" box reads: each bank's status, reasons and notes, and
// the policy sheet's "Conditions to confirm". Generated on 8 Oct 2026: the
// reasons are the backend's sentences, word for word.

/** Each sheet bank's "Conditions to confirm" (scenario "clear"). */
const CONDITIONS: Record<string, string[]> = {
  hdfc_bank: [
    'Check the bank statement: no bounce in the last 3 months (cell F2)',
    'Work from home: HR Confirmation Required (cell E2)',
    'PF deduction: Required (cell G2)',
    'Bachelor accommodation: Not Funding (cell H2)',
    'Director / doctor profile: Funding (cell I2)',
    'Consultant profile: Funding (cell J2)',
    'Grade 4 employees: Not Funding (cell K2)',
    'Contract employees: Not Funding (cell L2)',
    'Permanent address proof: Required (cell M2)',
    "Co-applicant's home loan: Obligate (cell N2)",
    'Co-applicant income: Consider (cell O2)',
    'Guarantor obligation: Consider (cell P2)',
    'Trading in the bank statement: Not Funding (cell Q2)',
    'Verification: Home and Office (cell R2)',
    'Top-up: Yes (cell T2)',
    'Recent funding: 3 months Ok (cell Z2)',
  ],
  icici_bank: [
    'Check the bank statement: no bounce in the last 6 months (cell F3)',
    'PF deduction: Required (cell G3)',
    'Bachelor accommodation: Not Funding (cell H3)',
    'Director / doctor profile: Funding (cell I3)',
    'Consultant profile: Funding (cell J3)',
    'Grade 4 employees: Not Funding (cell K3)',
    'Contract employees: Not Funding (cell L3)',
    'Permanent address proof: Required (cell M3)',
    "Co-applicant's home loan: Obligate (cell N3)",
    'Co-applicant income: Consider (cell O3)',
    'Guarantor obligation: Consider (cell P3)',
    'Trading in the bank statement: Not Funding (cell Q3)',
    'Verification: Home and Office (cell R3)',
    'Top-up: Yes (cell T3)',
    'Recent funding: 3 months Ok (cell Z3)',
  ],
  axis_bank: [
    'Check the bank statement: no bounce in the last 4 months (cell F4)',
    'PF deduction: Required (cell G4)',
    'Bachelor accommodation: Not Funding (cell H4)',
    'Director / doctor profile: Funding (cell I4)',
    'Consultant profile: Not Funding (cell J4)',
    'Grade 4 employees: Funding (cell K4)',
    'Contract employees: Not Funding (cell L4)',
    'Permanent address proof: Required (cell M4)',
    "Co-applicant's home loan: Obligate (cell N4)",
    'Co-applicant income: Consider (cell O4)',
    'Guarantor obligation: Not Consider (cell P4)',
    'Trading in the bank statement: Not Funding (cell Q4)',
    'Verification: Home (cell R4)',
    'OVD (officially verified document): Required (cell S4)',
    'Top-up: Yes (cell T4)',
    'Recent funding: 6 Months (cell Z4)',
  ],
  bandhan_bank: [
    'Check the bank statement: no bounce in the last 2 months (cell F5)',
    'Work from home: HR Confirmation Required (cell E5)',
    'PF deduction: Required (cell G5)',
    'Bachelor accommodation: Not Funding (cell H5)',
    'Director / doctor profile: Not Funding (cell I5)',
    'Consultant profile: Not Funding (cell J5)',
    'Grade 4 employees: Funding (cell K5)',
    'Contract employees: Not Funding (cell L5)',
    'Permanent address proof: Required (cell M5)',
    "Co-applicant's home loan: Not obligate (cell N5)",
    'Co-applicant income: Not Consider (cell O5)',
    'Guarantor obligation: Not Consider (cell P5)',
    'Trading in the bank statement: Not Funding (cell Q5)',
    'Verification: Office (cell R5)',
    'OVD (officially verified document): Required (cell S5)',
    'Recent funding: 4 Months (cell Z5)',
  ],
  indusind_bank: [
    'Check the credit report: at most 9 enquiries in the last 270 days (0 enquiries in the last 120 days entered) (cell D6)',
    'Check the bank statement: no bounce in the last 3 months (cell F6)',
    'Work from home: HR Confirmation Required (cell E6)',
    'Bachelor accommodation: Funding (cell H6)',
    'Director / doctor profile: Not Funding (cell I6)',
    'Consultant profile: Funding (cell J6)',
    'Grade 4 employees: Funding (cell K6)',
    'Contract employees: Not Funding (cell L6)',
    "Co-applicant's home loan: Not obligate (cell N6)",
    'Co-applicant income: Not Consider (cell O6)',
    'Guarantor obligation: Not Consider (cell P6)',
    'Trading in the bank statement: Funding (cell Q6)',
    'Verification: Home (cell R6)',
    'Recent funding: 3 months Ok (cell Z6)',
  ],
};

interface Row {
  lender: string;
  lender_id: string;
  status: string;
  reasons: string[];
  notes?: string[];
  /** Priced by the policy sheet: its "Conditions to confirm" (default: the bank's). */
  sheet?: boolean | string[];
}

const STATUS_LABELS: Record<string, string> = {
  eligible: 'Eligible',
  not_serviceable: 'Not serviceable',
  not_eligible: 'Not eligible',
};

function row({ sheet, notes = [], ...r }: Row): Record<string, unknown> {
  return {
    ...r,
    status_label: STATUS_LABELS[r.status],
    notes,
    policy_sheet: sheet
      ? {
          label: 'From Policy (your sheet)',
          bank: r.lender,
          lines: [],
          conditions: sheet === true ? CONDITIONS[r.lender_id] : sheet,
        }
      : null,
  };
}

export const ENGINE_ANSWERS = {
  cibil_enquiries: {
    per_lender: [
      row({
        lender: 'HDFC Bank',
        lender_id: 'hdfc_bank',
        status: 'not_eligible',
        reasons: [
          'HDFC Bank needs CIBIL >= 710: the score is 690 (Sheet2, HDFC Bank, Cibil Score "710", cell B2)',
          '6 enquiries in the last 60 days: more than HDFC Bank\'s limit of 5 (Sheet2, HDFC Bank, Enquiries "Last 60 days 5", cell D2)',
        ],
        sheet: true,
      }),
      row({
        lender: 'ICICI Bank',
        lender_id: 'icici_bank',
        status: 'not_eligible',
        reasons: [
          'ICICI Bank needs CIBIL >= 720: the score is 690 (Sheet2, ICICI Bank, Cibil Score "720", cell B3)',
          '5 enquiries in the last 30 days: more than ICICI Bank\'s limit of 4 (Sheet2, ICICI Bank, Enquiries "last 30 days 4", cell D3)',
        ],
        sheet: true,
      }),
      row({
        lender: 'Axis Bank',
        lender_id: 'axis_bank',
        status: 'not_serviceable',
        reasons: [
          'Pincode 401202 is not serviceable by Axis Bank',
          'Axis Bank needs CIBIL >= 750: the score is 690 (Sheet2, Axis Bank, Cibil Score "750", cell B4)',
        ],
        sheet: true,
      }),
      row({
        lender: 'Bajaj Finance',
        lender_id: 'bajaj_finance',
        status: 'not_eligible',
        reasons: ["CIBIL score 690 is below Bajaj Finance's minimum 700"],
        notes: [
          "'Synthetic Cat B Works Pvt Ltd' is not in Bajaj Finance's company list: its unlisted-company policy applies (FOIR 55%, multiplier 12)",
        ],
      }),
      row({
        lender: 'Tata Capital',
        lender_id: 'tata_capital',
        status: 'not_eligible',
        reasons: [
          "CIBIL score 690 is below Tata Capital's minimum 725",
          "6 enquiries in the last 90 days: more than Tata Capital's limit of 4",
        ],
        notes: [
          "'Synthetic Cat B Works Pvt Ltd' is not in Tata Capital's company list: its unlisted-company policy applies (FOIR 50%, multiplier 10)",
          'Tata Capital calculates eligibility at 60 months (its calculation tenure), not at the requested 72',
        ],
      }),
      row({
        lender: 'Bandhan Bank',
        lender_id: 'bandhan_bank',
        status: 'not_eligible',
        reasons: [
          'Bandhan Bank needs CIBIL >= 700: the score is 690 (Sheet2, Bandhan Bank, Cibil Score "700", cell B5)',
        ],
        notes: [
          'No pincode list covers Bandhan Bank: serviceability not checked',
          'Bandhan Bank calculates eligibility at 60 months (Tenure for Eligibility Calculation, cell AN29), not at the requested 72; the EMI is shown at its Maximum Tenure of 60 months',
        ],
        sheet: true,
      }),
      row({
        lender: 'Indusind Bank',
        lender_id: 'indusind_bank',
        status: 'not_eligible',
        reasons: [
          'Indusind Bank needs CIBIL >= 725: the score is 690 (Sheet2, Indusind Bank, Cibil Score "725", cell B6)',
        ],
        notes: [
          'No pincode list covers Indusind Bank: serviceability not checked',
        ],
        sheet: [
          'Check the credit report: at most 9 enquiries in the last 270 days (7 enquiries in the last 120 days entered) (cell D6)',
          'Check the bank statement: no bounce in the last 3 months (cell F6)',
          'Work from home: HR Confirmation Required (cell E6)',
          'Bachelor accommodation: Funding (cell H6)',
          'Director / doctor profile: Not Funding (cell I6)',
          'Consultant profile: Funding (cell J6)',
          'Grade 4 employees: Funding (cell K6)',
          'Contract employees: Not Funding (cell L6)',
          "Co-applicant's home loan: Not obligate (cell N6)",
          'Co-applicant income: Not Consider (cell O6)',
          'Guarantor obligation: Not Consider (cell P6)',
          'Trading in the bank statement: Funding (cell Q6)',
          'Verification: Home (cell R6)',
          'Recent funding: 3 months Ok (cell Z6)',
        ],
      }),
    ],
    notes: [] as string[],
  },
  cat_u: {
    per_lender: [
      row({
        lender: 'HDFC Bank',
        lender_id: 'hdfc_bank',
        status: 'not_eligible',
        reasons: [
          'HDFC Bank does not lend to CAT U (unlisted) companies (Sheet1, slab 60,000, CAT_U is NA, cell I8)',
        ],
        notes: [
          "CAT_U: 'Unheard Of Traders Pvt Ltd' is not in HDFC Bank's company list, so CAT U applies",
        ],
      }),
      row({
        lender: 'ICICI Bank',
        lender_id: 'icici_bank',
        status: 'eligible',
        reasons: [],
        notes: [
          "CAT_U: 'Unheard Of Traders Pvt Ltd' is not in ICICI Bank's company list, so CAT U applies",
        ],
        sheet: true,
      }),
      row({
        lender: 'Axis Bank',
        lender_id: 'axis_bank',
        status: 'not_serviceable',
        reasons: ['Pincode 401202 is not serviceable by Axis Bank'],
        notes: [
          "CAT_U: 'Unheard Of Traders Pvt Ltd' is not in Axis Bank's company list, so CAT U applies",
        ],
        sheet: true,
      }),
      row({
        lender: 'Bajaj Finance',
        lender_id: 'bajaj_finance',
        status: 'eligible',
        reasons: [],
        notes: [
          "'Unheard Of Traders Pvt Ltd' is not in Bajaj Finance's company list: its unlisted-company policy applies (FOIR 55%, multiplier 12)",
        ],
      }),
      row({
        lender: 'Tata Capital',
        lender_id: 'tata_capital',
        status: 'eligible',
        reasons: [],
        notes: [
          "'Unheard Of Traders Pvt Ltd' is not in Tata Capital's company list: its unlisted-company policy applies (FOIR 50%, multiplier 10)",
          'Tata Capital calculates eligibility at 60 months (its calculation tenure), not at the requested 72',
        ],
      }),
      row({
        lender: 'Bandhan Bank',
        lender_id: 'bandhan_bank',
        status: 'not_eligible',
        reasons: [
          'Bandhan Bank does not lend to CAT U (unlisted) companies (Sheet1, slab 60,000, CAT_U is NA, cell I29)',
        ],
        notes: [
          'No pincode list covers Bandhan Bank: serviceability not checked',
          "CAT_U: 'Unheard Of Traders Pvt Ltd' is not in Bandhan Bank's company list, so CAT U applies",
          "Requested tenure 72 months is more than Bandhan Bank's max 60: the EMI is shown at 60 months and eligibility is calculated at 60 months",
        ],
      }),
      row({
        lender: 'Indusind Bank',
        lender_id: 'indusind_bank',
        status: 'eligible',
        reasons: [],
        notes: [
          'No pincode list covers Indusind Bank: serviceability not checked',
          "CAT_U: 'Unheard Of Traders Pvt Ltd' is not in Indusind Bank's company list, so CAT U applies",
        ],
        sheet: [
          'Check the credit report: at most 9 enquiries in the last 270 days (3 enquiries in the last 120 days entered) (cell D6)',
          'Check the bank statement: no bounce in the last 3 months (cell F6)',
          'Work from home: HR Confirmation Required (cell E6)',
          'Bachelor accommodation: Funding (cell H6)',
          'Director / doctor profile: Not Funding (cell I6)',
          'Consultant profile: Funding (cell J6)',
          'Grade 4 employees: Funding (cell K6)',
          'Contract employees: Not Funding (cell L6)',
          "Co-applicant's home loan: Not obligate (cell N6)",
          'Co-applicant income: Not Consider (cell O6)',
          'Guarantor obligation: Not Consider (cell P6)',
          'Trading in the bank statement: Funding (cell Q6)',
          'Verification: Home (cell R6)',
          'Recent funding: 3 months Ok (cell Z6)',
        ],
      }),
    ],
    notes: [] as string[],
  },
  missing: {
    per_lender: [
      row({
        lender: 'HDFC Bank',
        lender_id: 'hdfc_bank',
        status: 'not_eligible',
        reasons: [
          'Pincode not entered: serviceability cannot be checked',
          'Employment type not entered',
          'Company not entered: its category is needed',
          'Enquiries in the last 60 days not entered',
          'Net monthly income not entered',
        ],
      }),
      row({
        lender: 'ICICI Bank',
        lender_id: 'icici_bank',
        status: 'not_eligible',
        reasons: [
          'Pincode not entered: serviceability cannot be checked',
          'Employment type not entered',
          'Company not entered: its category is needed',
          'Enquiries in the last 30 days not entered',
          'Net monthly income not entered',
        ],
      }),
      row({
        lender: 'Axis Bank',
        lender_id: 'axis_bank',
        status: 'not_eligible',
        reasons: [
          'Pincode not entered: serviceability cannot be checked',
          'Employment type not entered',
          'Company not entered: its category is needed',
          'Enquiries in the last 30 days not entered',
          'Net monthly income not entered',
        ],
      }),
      row({
        lender: 'Bajaj Finance',
        lender_id: 'bajaj_finance',
        status: 'not_eligible',
        reasons: [
          'Pincode not entered: serviceability cannot be checked',
          'Employment type not entered',
          'Company not entered: its category is needed',
          'Enquiries in the last 90 days not entered',
          'Net monthly income not entered',
        ],
      }),
      row({
        lender: 'Tata Capital',
        lender_id: 'tata_capital',
        status: 'not_eligible',
        reasons: [
          'Pincode not entered: serviceability cannot be checked',
          'Employment type not entered',
          'Company not entered: its category is needed',
          'Enquiries in the last 90 days not entered',
          'Net monthly income not entered',
        ],
      }),
      row({
        lender: 'Bandhan Bank',
        lender_id: 'bandhan_bank',
        status: 'not_eligible',
        reasons: [
          'Pincode not entered: serviceability cannot be checked',
          'Employment type not entered',
          'Company not entered: its category is needed',
          'Enquiries in the last 90 days not entered',
          'Net monthly income not entered',
        ],
      }),
      row({
        lender: 'Indusind Bank',
        lender_id: 'indusind_bank',
        status: 'not_eligible',
        reasons: [
          'Pincode not entered: serviceability cannot be checked',
          'Employment type not entered',
          'Company not entered: its category is needed',
          'Enquiries in the last 270 days not entered',
          'Net monthly income not entered',
        ],
      }),
    ],
    notes: [] as string[],
  },
  incomplete_loans: {
    per_lender: [
      row({
        lender: 'HDFC Bank',
        lender_id: 'hdfc_bank',
        status: 'not_eligible',
        reasons: [
          'EMI not entered for Tradeline 2 (Sample Bank Card, Credit Card) marked Obligate: enter the monthly amount the lender counts for the card (often 5% of the outstanding)',
          'Outstanding not entered for Tradeline 3 (Sample Finance, Personal Loan) marked BT: the balance-transfer amount is unknown',
        ],
        sheet: true,
      }),
      row({
        lender: 'ICICI Bank',
        lender_id: 'icici_bank',
        status: 'not_eligible',
        reasons: [
          'EMI not entered for Tradeline 2 (Sample Bank Card, Credit Card) marked Obligate: enter the monthly amount the lender counts for the card (often 5% of the outstanding)',
          'Outstanding not entered for Tradeline 3 (Sample Finance, Personal Loan) marked BT: the balance-transfer amount is unknown',
        ],
        sheet: true,
      }),
      row({
        lender: 'Axis Bank',
        lender_id: 'axis_bank',
        status: 'not_serviceable',
        reasons: [
          'Pincode 401202 is not serviceable by Axis Bank',
          'EMI not entered for Tradeline 2 (Sample Bank Card, Credit Card) marked Obligate: enter the monthly amount the lender counts for the card (often 5% of the outstanding)',
          'Outstanding not entered for Tradeline 3 (Sample Finance, Personal Loan) marked BT: the balance-transfer amount is unknown',
        ],
        sheet: true,
      }),
      row({
        lender: 'Bajaj Finance',
        lender_id: 'bajaj_finance',
        status: 'not_eligible',
        reasons: [
          'EMI not entered for Tradeline 2 (Sample Bank Card, Credit Card) marked Obligate: enter the monthly amount the lender counts for the card (often 5% of the outstanding)',
          'Outstanding not entered for Tradeline 3 (Sample Finance, Personal Loan) marked BT: the balance-transfer amount is unknown',
        ],
        notes: [
          "'Synthetic Cat B Works Pvt Ltd' is not in Bajaj Finance's company list: its unlisted-company policy applies (FOIR 55%, multiplier 12)",
        ],
      }),
      row({
        lender: 'Tata Capital',
        lender_id: 'tata_capital',
        status: 'not_eligible',
        reasons: [
          'EMI not entered for Tradeline 2 (Sample Bank Card, Credit Card) marked Obligate: enter the monthly amount the lender counts for the card (often 5% of the outstanding)',
          'Outstanding not entered for Tradeline 3 (Sample Finance, Personal Loan) marked BT: the balance-transfer amount is unknown',
        ],
        notes: [
          "'Synthetic Cat B Works Pvt Ltd' is not in Tata Capital's company list: its unlisted-company policy applies (FOIR 50%, multiplier 10)",
          'Tata Capital calculates eligibility at 60 months (its calculation tenure), not at the requested 72',
        ],
      }),
      row({
        lender: 'Bandhan Bank',
        lender_id: 'bandhan_bank',
        status: 'not_eligible',
        reasons: [
          'EMI not entered for Tradeline 2 (Sample Bank Card, Credit Card) marked Obligate: enter the monthly amount the lender counts for the card (often 5% of the outstanding)',
          'Outstanding not entered for Tradeline 3 (Sample Finance, Personal Loan) marked BT: the balance-transfer amount is unknown',
        ],
        notes: [
          'No pincode list covers Bandhan Bank: serviceability not checked',
          'Bandhan Bank calculates eligibility at 60 months (Tenure for Eligibility Calculation, cell AN29), not at the requested 72; the EMI is shown at its Maximum Tenure of 60 months',
        ],
        sheet: true,
      }),
      row({
        lender: 'Indusind Bank',
        lender_id: 'indusind_bank',
        status: 'not_eligible',
        reasons: [
          'EMI not entered for Tradeline 2 (Sample Bank Card, Credit Card) marked Obligate: enter the monthly amount the lender counts for the card (often 5% of the outstanding)',
          'Outstanding not entered for Tradeline 3 (Sample Finance, Personal Loan) marked BT: the balance-transfer amount is unknown',
        ],
        notes: [
          'No pincode list covers Indusind Bank: serviceability not checked',
        ],
        sheet: true,
      }),
    ],
    notes: [] as string[],
  },
  clear: {
    per_lender: [
      row({
        lender: 'HDFC Bank',
        lender_id: 'hdfc_bank',
        status: 'eligible',
        reasons: [],
        sheet: true,
      }),
      row({
        lender: 'ICICI Bank',
        lender_id: 'icici_bank',
        status: 'eligible',
        reasons: [],
        sheet: true,
      }),
      row({
        lender: 'Axis Bank',
        lender_id: 'axis_bank',
        status: 'not_serviceable',
        reasons: ['Pincode 401202 is not serviceable by Axis Bank'],
        sheet: true,
      }),
      row({
        lender: 'Bajaj Finance',
        lender_id: 'bajaj_finance',
        status: 'eligible',
        reasons: [],
        notes: [
          "'Synthetic Cat B Works Pvt Ltd' is not in Bajaj Finance's company list: its unlisted-company policy applies (FOIR 55%, multiplier 12)",
        ],
      }),
      row({
        lender: 'Tata Capital',
        lender_id: 'tata_capital',
        status: 'eligible',
        reasons: [],
        notes: [
          "'Synthetic Cat B Works Pvt Ltd' is not in Tata Capital's company list: its unlisted-company policy applies (FOIR 50%, multiplier 10)",
          'Tata Capital calculates eligibility at 60 months (its calculation tenure), not at the requested 72',
        ],
      }),
      row({
        lender: 'Bandhan Bank',
        lender_id: 'bandhan_bank',
        status: 'eligible',
        reasons: [],
        notes: [
          'No pincode list covers Bandhan Bank: serviceability not checked',
          'Bandhan Bank calculates eligibility at 60 months (Tenure for Eligibility Calculation, cell AN29), not at the requested 72; the EMI is shown at its Maximum Tenure of 60 months',
        ],
        sheet: true,
      }),
      row({
        lender: 'Indusind Bank',
        lender_id: 'indusind_bank',
        status: 'eligible',
        reasons: [],
        notes: [
          'No pincode list covers Indusind Bank: serviceability not checked',
        ],
        sheet: true,
      }),
    ],
    notes: [] as string[],
  },
  low_income: {
    per_lender: [
      row({
        lender: 'HDFC Bank',
        lender_id: 'hdfc_bank',
        status: 'not_eligible',
        reasons: [
          "Not eligible: income ₹20,000 is below HDFC Bank's minimum ₹25,000 (From Policy (your sheet))",
        ],
      }),
      row({
        lender: 'ICICI Bank',
        lender_id: 'icici_bank',
        status: 'not_eligible',
        reasons: [
          "Not eligible: income ₹20,000 is below ICICI Bank's minimum ₹25,000 (From Policy (your sheet))",
        ],
      }),
      row({
        lender: 'Axis Bank',
        lender_id: 'axis_bank',
        status: 'not_serviceable',
        reasons: [
          'Pincode 401202 is not serviceable by Axis Bank',
          "Not eligible: income ₹20,000 is below Axis Bank's minimum ₹25,000 (From Policy (your sheet))",
        ],
      }),
      row({
        lender: 'Bajaj Finance',
        lender_id: 'bajaj_finance',
        status: 'eligible',
        reasons: [],
        notes: [
          "'Synthetic Cat B Works Pvt Ltd' is not in Bajaj Finance's company list: its unlisted-company policy applies (FOIR 55%, multiplier 12)",
          '₹2,40,000 is less than the requested ₹5,00,000',
        ],
      }),
      row({
        lender: 'Tata Capital',
        lender_id: 'tata_capital',
        status: 'eligible',
        reasons: [],
        notes: [
          "'Synthetic Cat B Works Pvt Ltd' is not in Tata Capital's company list: its unlisted-company policy applies (FOIR 50%, multiplier 10)",
          'Tata Capital calculates eligibility at 60 months (its calculation tenure), not at the requested 72',
          '₹2,00,000 is less than the requested ₹5,00,000',
        ],
      }),
      row({
        lender: 'Bandhan Bank',
        lender_id: 'bandhan_bank',
        status: 'not_eligible',
        reasons: [
          "Not eligible: income ₹20,000 is below Bandhan Bank's minimum ₹25,000 (From Policy (your sheet))",
        ],
        notes: [
          'No pincode list covers Bandhan Bank: serviceability not checked',
          "Requested tenure 72 months is more than Bandhan Bank's max 60: the EMI is shown at 60 months and eligibility is calculated at 60 months",
        ],
      }),
      row({
        lender: 'Indusind Bank',
        lender_id: 'indusind_bank',
        status: 'not_eligible',
        reasons: [
          "Not eligible: income ₹20,000 is below Indusind Bank's minimum ₹25,000 (From Policy (your sheet))",
        ],
        notes: [
          'No pincode list covers Indusind Bank: serviceability not checked',
        ],
      }),
    ],
    notes: [] as string[],
  },
  no_room: {
    per_lender: [
      row({
        lender: 'HDFC Bank',
        lender_id: 'hdfc_bank',
        status: 'not_eligible',
        reasons: [
          'Existing obligations ₹59,000 leave no room within FOIR 60% of ₹60,000 (₹36,000)',
        ],
        sheet: true,
      }),
      row({
        lender: 'ICICI Bank',
        lender_id: 'icici_bank',
        status: 'not_eligible',
        reasons: [
          'Existing obligations ₹59,000 leave no room within FOIR 60% of ₹60,000 (₹36,000)',
        ],
        sheet: true,
      }),
      row({
        lender: 'Axis Bank',
        lender_id: 'axis_bank',
        status: 'not_serviceable',
        reasons: [
          'Pincode 401202 is not serviceable by Axis Bank',
          'Existing obligations ₹59,000 leave no room within FOIR 60% of ₹60,000 (₹36,000)',
        ],
        sheet: true,
      }),
      row({
        lender: 'Bajaj Finance',
        lender_id: 'bajaj_finance',
        status: 'not_eligible',
        reasons: [
          'Existing obligations ₹59,000 leave no room within FOIR 55% of ₹60,000 (₹33,000)',
        ],
        notes: [
          "'Synthetic Cat B Works Pvt Ltd' is not in Bajaj Finance's company list: its unlisted-company policy applies (FOIR 55%, multiplier 12)",
        ],
      }),
      row({
        lender: 'Tata Capital',
        lender_id: 'tata_capital',
        status: 'not_eligible',
        reasons: [
          'Existing obligations ₹59,000 leave no room within FOIR 50% of ₹60,000 (₹30,000)',
        ],
        notes: [
          "'Synthetic Cat B Works Pvt Ltd' is not in Tata Capital's company list: its unlisted-company policy applies (FOIR 50%, multiplier 10)",
          'Tata Capital calculates eligibility at 60 months (its calculation tenure), not at the requested 72',
        ],
      }),
      row({
        lender: 'Bandhan Bank',
        lender_id: 'bandhan_bank',
        status: 'not_eligible',
        reasons: [
          'Existing obligations ₹59,000 leave no room within FOIR 60% of ₹60,000 (₹36,000)',
        ],
        notes: [
          'No pincode list covers Bandhan Bank: serviceability not checked',
          'Bandhan Bank calculates eligibility at 60 months (Tenure for Eligibility Calculation, cell AN29), not at the requested 72; the EMI is shown at its Maximum Tenure of 60 months',
        ],
        sheet: true,
      }),
      row({
        lender: 'Indusind Bank',
        lender_id: 'indusind_bank',
        status: 'not_eligible',
        reasons: [
          'Existing obligations ₹59,000 leave no room within FOIR 60% of ₹60,000 (₹36,000)',
        ],
        notes: [
          'No pincode list covers Indusind Bank: serviceability not checked',
        ],
        sheet: true,
      }),
    ],
    notes: [] as string[],
  },
  bt_limits: {
    per_lender: [
      row({
        lender: 'HDFC Bank',
        lender_id: 'hdfc_bank',
        status: 'not_eligible',
        reasons: [
          '1 credit card marked BT: HDFC Bank does not take over credit cards (Sheet2, HDFC Bank, CCBT "NA", cell W2)',
        ],
        sheet: true,
      }),
      row({
        lender: 'ICICI Bank',
        lender_id: 'icici_bank',
        status: 'not_eligible',
        reasons: [
          '1 credit card marked BT: ICICI Bank does not take over credit cards (Sheet2, ICICI Bank, CCBT "NA", cell W3)',
        ],
        sheet: true,
      }),
      row({
        lender: 'Axis Bank',
        lender_id: 'axis_bank',
        status: 'not_serviceable',
        reasons: ['Pincode 401202 is not serviceable by Axis Bank'],
        sheet: true,
      }),
      row({
        lender: 'Bajaj Finance',
        lender_id: 'bajaj_finance',
        status: 'eligible',
        reasons: [],
        notes: [
          "'Synthetic Cat B Works Pvt Ltd' is not in Bajaj Finance's company list: its unlisted-company policy applies (FOIR 55%, multiplier 12)",
        ],
      }),
      row({
        lender: 'Tata Capital',
        lender_id: 'tata_capital',
        status: 'eligible',
        reasons: [],
        notes: [
          "'Synthetic Cat B Works Pvt Ltd' is not in Tata Capital's company list: its unlisted-company policy applies (FOIR 50%, multiplier 10)",
          'Tata Capital calculates eligibility at 60 months (its calculation tenure), not at the requested 72',
        ],
      }),
      row({
        lender: 'Bandhan Bank',
        lender_id: 'bandhan_bank',
        status: 'not_eligible',
        reasons: [
          '1 credit card marked BT: Bandhan Bank does not take over credit cards (Sheet2, Bandhan Bank, CCBT "NA", cell W5)',
        ],
        notes: [
          'No pincode list covers Bandhan Bank: serviceability not checked',
          'Bandhan Bank calculates eligibility at 60 months (Tenure for Eligibility Calculation, cell AN29), not at the requested 72; the EMI is shown at its Maximum Tenure of 60 months',
        ],
        sheet: true,
      }),
      row({
        lender: 'Indusind Bank',
        lender_id: 'indusind_bank',
        status: 'not_eligible',
        reasons: [
          '1 credit card marked BT: Indusind Bank does not take over credit cards (Sheet2, Indusind Bank, CCBT "NA", cell W6)',
        ],
        notes: [
          'No pincode list covers Indusind Bank: serviceability not checked',
        ],
        sheet: true,
      }),
    ],
    notes: [] as string[],
  },
  sample_only: {
    per_lender: [
      row({
        lender: 'HDFC Bank',
        lender_id: 'hdfc_bank',
        status: 'not_eligible',
        reasons: [
          'Employment type Partnership/Proprietorship is not accepted by HDFC Bank',
          'CIBIL -1: no credit history, and HDFC Bank needs CIBIL >= 750',
        ],
        notes: [
          "FOIR 70% · slab 75,000–99,999 · CAT A · From Policy (SAMPLE: confirm with Smart Solutions' HDFC grid)",
        ],
      }),
      row({
        lender: 'ICICI Bank',
        lender_id: 'icici_bank',
        status: 'not_eligible',
        reasons: [
          'CIBIL -1: no credit history, and ICICI Bank needs CIBIL >= 725',
        ],
      }),
      row({
        lender: 'Axis Bank',
        lender_id: 'axis_bank',
        status: 'not_serviceable',
        reasons: [
          'Pincode 401202 is not serviceable by Axis Bank',
          'Employment type Partnership/Proprietorship is not accepted by Axis Bank',
          'CIBIL -1: no credit history, and Axis Bank needs CIBIL >= 750',
        ],
      }),
      row({
        lender: 'Bajaj Finance',
        lender_id: 'bajaj_finance',
        status: 'not_eligible',
        reasons: [
          'CIBIL -1: no credit history, and Bajaj Finance needs CIBIL >= 700',
        ],
      }),
      row({
        lender: 'Tata Capital',
        lender_id: 'tata_capital',
        status: 'not_eligible',
        reasons: [
          'CIBIL -1: no credit history, and Tata Capital needs CIBIL >= 725',
        ],
      }),
    ],
    notes: [] as string[],
  },
  gold: {
    per_lender: [
      row({
        lender: 'HDFC Bank',
        lender_id: 'hdfc_bank',
        status: 'not_eligible',
        reasons: [
          'Outstanding not entered for Tradeline 2 (Gold Co, Gold Loan): HDFC Bank counts 1% of a gold loan\'s outstanding a month (Sheet2, HDFC Bank, Gold Loan "0.01", cell AA2)',
        ],
        sheet: true,
      }),
      row({
        lender: 'ICICI Bank',
        lender_id: 'icici_bank',
        status: 'not_eligible',
        reasons: [
          'Outstanding not entered for Tradeline 2 (Gold Co, Gold Loan): ICICI Bank counts 1% of a gold loan\'s outstanding a month (Sheet2, ICICI Bank, Gold Loan "0.01", cell AA3)',
        ],
        sheet: true,
      }),
      row({
        lender: 'Axis Bank',
        lender_id: 'axis_bank',
        status: 'not_serviceable',
        reasons: ['Pincode 401202 is not serviceable by Axis Bank'],
        notes: [
          'Tradeline 2 (Gold Co, Gold Loan) is counted at its EMI ₹1,500 (gold loan: bank rule not given (Sheet2, Axis Bank, Gold Loan "NA", cell AA4))',
        ],
        sheet: true,
      }),
      row({
        lender: 'Bajaj Finance',
        lender_id: 'bajaj_finance',
        status: 'eligible',
        reasons: [],
        notes: [
          "'Synthetic Cat B Works Pvt Ltd' is not in Bajaj Finance's company list: its unlisted-company policy applies (FOIR 55%, multiplier 12)",
        ],
      }),
      row({
        lender: 'Tata Capital',
        lender_id: 'tata_capital',
        status: 'eligible',
        reasons: [],
        notes: [
          "'Synthetic Cat B Works Pvt Ltd' is not in Tata Capital's company list: its unlisted-company policy applies (FOIR 50%, multiplier 10)",
          'Tata Capital calculates eligibility at 60 months (its calculation tenure), not at the requested 72',
        ],
      }),
      row({
        lender: 'Bandhan Bank',
        lender_id: 'bandhan_bank',
        status: 'eligible',
        reasons: [],
        notes: [
          'No pincode list covers Bandhan Bank: serviceability not checked',
          'Bandhan Bank calculates eligibility at 60 months (Tenure for Eligibility Calculation, cell AN29), not at the requested 72; the EMI is shown at its Maximum Tenure of 60 months',
          'Tradeline 2 (Gold Co, Gold Loan) is counted at its EMI ₹1,500 (gold loan: bank rule not given (Sheet2, Bandhan Bank, Gold Loan "NA", cell AA5))',
        ],
        sheet: true,
      }),
      row({
        lender: 'Indusind Bank',
        lender_id: 'indusind_bank',
        status: 'not_eligible',
        reasons: [
          'Outstanding not entered for Tradeline 2 (Gold Co, Gold Loan): Indusind Bank counts 1% of a gold loan\'s outstanding a month (Sheet2, Indusind Bank, Gold Loan "0.01", cell AA6)',
        ],
        notes: [
          'No pincode list covers Indusind Bank: serviceability not checked',
        ],
        sheet: true,
      }),
    ],
    notes: [] as string[],
  },
  // Employment type Grade 4 (the CAT B applicant of cat_b_book). The sheet has
  // no employment types, so its banks refuse by the sample policy's, marked
  // "(Sample: not in your policy sheet)"; Bajaj Finance has no sheet.
  grade_4: {
    per_lender: [
      row({
        lender: 'HDFC Bank',
        lender_id: 'hdfc_bank',
        status: 'not_eligible',
        reasons: [
          'Employment type Grade 4 is not accepted by HDFC Bank (Sample: not in your policy sheet)',
        ],
        sheet: true,
      }),
      row({
        lender: 'ICICI Bank',
        lender_id: 'icici_bank',
        status: 'not_eligible',
        reasons: [
          'Employment type Grade 4 is not accepted by ICICI Bank (Sample: not in your policy sheet)',
        ],
        sheet: true,
      }),
      row({
        lender: 'Axis Bank',
        lender_id: 'axis_bank',
        status: 'not_serviceable',
        reasons: [
          'Pincode 401202 is not serviceable by Axis Bank',
          'Employment type Grade 4 is not accepted by Axis Bank (Sample: not in your policy sheet)',
        ],
        sheet: true,
      }),
      row({
        lender: 'Bajaj Finance',
        lender_id: 'bajaj_finance',
        status: 'not_eligible',
        reasons: ['Employment type Grade 4 is not accepted by Bajaj Finance'],
        notes: [
          "'Synthetic Cat B Works Pvt Ltd' is not in Bajaj Finance's company list: its unlisted-company policy applies (FOIR 55%, multiplier 12)",
        ],
      }),
      row({
        lender: 'Tata Capital',
        lender_id: 'tata_capital',
        status: 'eligible',
        reasons: [],
        notes: [
          "'Synthetic Cat B Works Pvt Ltd' is not in Tata Capital's company list: its unlisted-company policy applies (FOIR 50%, multiplier 10)",
          'Tata Capital calculates eligibility at 60 months (its calculation tenure), not at the requested 72',
        ],
      }),
      row({
        lender: 'Bandhan Bank',
        lender_id: 'bandhan_bank',
        status: 'not_eligible',
        reasons: [
          'Employment type Grade 4 is not accepted by Bandhan Bank (Sample: not in your policy sheet)',
        ],
        notes: [
          'No pincode list covers Bandhan Bank: serviceability not checked',
          'Bandhan Bank calculates eligibility at 60 months (Tenure for Eligibility Calculation, cell AN29), not at the requested 72; the EMI is shown at its Maximum Tenure of 60 months',
        ],
        sheet: true,
      }),
      row({
        lender: 'Indusind Bank',
        lender_id: 'indusind_bank',
        status: 'not_eligible',
        reasons: [
          'Employment type Grade 4 is not accepted by Indusind Bank (Sample: not in your policy sheet)',
        ],
        notes: [
          'No pincode list covers Indusind Bank: serviceability not checked',
        ],
        sheet: [
          'Check the credit report: at most 9 enquiries in the last 270 days (3 enquiries in the last 120 days entered) (cell D6)',
          'Check the bank statement: no bounce in the last 3 months (cell F6)',
          'Work from home: HR Confirmation Required (cell E6)',
          'Bachelor accommodation: Funding (cell H6)',
          'Director / doctor profile: Not Funding (cell I6)',
          'Consultant profile: Funding (cell J6)',
          'Grade 4 employees: Funding (cell K6)',
          'Contract employees: Not Funding (cell L6)',
          "Co-applicant's home loan: Not obligate (cell N6)",
          'Co-applicant income: Not Consider (cell O6)',
          'Guarantor obligation: Not Consider (cell P6)',
          'Trading in the bank statement: Funding (cell Q6)',
          'Verification: Home (cell R6)',
          'Recent funding: 3 months Ok (cell Z6)',
        ],
      }),
    ],
    notes: [] as string[],
  },
};

export type EngineScenario = keyof typeof ENGINE_ANSWERS;

/** A scenario's calculate answer, raw as the API sends it. */
export function engineAnswer(
  scenario: EngineScenario,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    applicant: 'Synthetic Applicant',
    sample: true,
    per_lender: ENGINE_ANSWERS[scenario].per_lender,
    notes: ENGINE_ANSWERS[scenario].notes,
    suggestion: { need: null, banks: [], declined: [] },
    file_check: null,
    disclaimers: [],
    ...extra,
  };
}
