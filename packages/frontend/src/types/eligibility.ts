// Mirrors packages/backend/app/routers/eligibility.py
// (prefix /projects/{project_id}/eligibility):
//   GET  .../lenders              SAMPLE lender policies and the form's choices
//   GET  .../pincodes/{pincode}   "Check availability": the lenders serving a pincode
//   GET  .../companies?name=      "Check category": a company's category per lender
//   GET  .../inputs?applicant=    saved inputs, else a draft pre-filled from the file check
//   PUT  .../inputs               save an applicant's inputs (deleted by TTL after 7 days)
//   POST .../calculate            eligibility at every lender (app/eligibility.py)
//   POST .../login                record a login request, notify the CRM webhook
// Every number is the backend's (fixed formulas, never a model); the UI shows
// them as returned. Every lender policy, pincode list and company category is
// SAMPLE data. Choices are sent and returned as ids (private_limited, bt).

// ------------------------------------------------------------------ profile

export type HouseOwnership = 'owned' | 'rented';

/** The client's "Employement Type" list. */
export type EmploymentType =
  | 'defence'
  | 'government'
  | 'grade_4'
  | 'llp'
  | 'merchant_navy'
  | 'partnership_proprietorship'
  | 'private_limited'
  | 'public_limited';

export type OtherIncomeType = 'rented' | 'bonus' | 'incentive' | 'pension';

export type IncomeFrequency =
  | 'yearly'
  | 'half_yearly'
  | 'quarterly'
  | 'monthly';

/** Rent agreement of a rented income. */
export type RentAgreement = 'notary' | 'registered';

export interface OtherIncome {
  /** Row key in the form; never sent. */
  key?: string;
  type: OtherIncomeType;
  /** Rupees per `frequency` (rented income and pension: per month). */
  amount: number | null;
  /** Bonus and incentive (without it the backend counts yearly). */
  frequency?: IncomeFrequency | null;
  /** Rented income only (without it the backend counts notary). */
  agreement?: RentAgreement | null;
}

export interface EligibilityProfile {
  /** ABCDE1234F, or the masked PAN of a pre-fill (XXXXXX234F). */
  pan: string | null;
  /** Name as per PAN */
  name: string | null;
  mobile: string | null;
  /** YYYY-MM-DD */
  dob: string | null;
  house_ownership: HouseOwnership | null;
  pincode: string | null;
  current_address: string | null;
  permanent_address: string | null;
  company: string | null;
  employment_type: EmploymentType | null;
  /** Net monthly salary; a salary the file check verified is used instead. */
  net_income: number | null;
  other_income: OtherIncome[];
}

// ------------------------------------------------------------------ CIBIL

export type LoanType =
  | 'personal'
  | 'home'
  | 'mortgage'
  | 'car'
  | 'education'
  | 'application'
  | 'consumer'
  | 'credit_card';

/**
 * What happens to an existing loan: BT (the new lender takes over the
 * outstanding; its EMI is not an obligation), Obligate (it keeps running:
 * its EMI is an obligation) or Close (closed before disbursal).
 */
export type TradelineAction = 'bt' | 'obligate' | 'close';

/** The bureau's account status; the adverse ones are reported as notes. */
export type TradelineStatus =
  | 'active'
  | 'closed'
  | 'settled'
  | 'written_off'
  | 'suit_filed'
  | 'wilful_default'
  | 'restructured';

/** Who filled a tradeline: by hand, a bureau pull, or the bank statement (pre-fill). */
export type TradelineSource = 'manual' | 'bureau' | 'bank_statement';

export interface Tradeline {
  /** Row key in the form; never sent. */
  key?: string;
  loan_type: LoanType | null;
  lender: string | null;
  sanction_amount: number | null;
  /** Needed for BT: the balance-transfer amount. */
  outstanding: number | null;
  /** Monthly EMI; needed for Obligate. */
  emi: number | null;
  status: TradelineStatus | null;
  account_number?: string | null;
  overdue?: number | null;
  emis_paid?: number | null;
  emis_pending?: number | null;
  /** YYYY-MM-DD */
  open_date?: string | null;
  /** YYYY-MM-DD */
  last_payment_date?: string | null;
  action: TradelineAction;
  /** Kept as received (a bureau pull or the pre-fill sets it); default manual. */
  source?: TradelineSource | null;
}

/** Cumulative enquiries in the last 30 / 60 / 90 / 120 days. */
export interface CibilEnquiries {
  d30: number | null;
  d60: number | null;
  d90: number | null;
  d120: number | null;
}

/** Who filled the CIBIL block: manual now, bureau when a CIBIL pull fills it. */
export type CibilSource = 'manual' | 'bureau';

export interface EligibilityCibil {
  score: number | null;
  enquiries: CibilEnquiries;
  tradelines: Tradeline[];
  /** Kept as received; default manual. */
  source?: CibilSource | null;
  /** YYYY-MM-DD of the bureau report, when a pull fills it. */
  report_date?: string | null;
}

export interface EligibilityLoan {
  amount: number | null;
  tenure_months: number | null;
}

export interface EligibilityInputs {
  profile: EligibilityProfile;
  cibil: EligibilityCibil;
  loan: EligibilityLoan;
}

/** PUT .../inputs (the API forbids other fields). */
export interface EligibilityInputsRequest extends EligibilityInputs {
  /** PAN (preferred) or name as the file check shows it; the same value finds the inputs again. */
  applicant: string;
}

/**
 * Fields a draft took from the documents: name, pan, company,
 * employment_type, net_income, dob, loan_amount, tenure_months, tradelines.
 */
export type PrefillField =
  | 'name'
  | 'pan'
  | 'company'
  | 'employment_type'
  | 'net_income'
  | 'dob'
  | 'loan_amount'
  | 'tenure_months'
  | 'tradelines';

/** How a draft was pre-filled from the file check (GET .../inputs). */
export interface EligibilityPrefill {
  available: boolean;
  detail: string | null;
  /** e.g. "verified: salary slips, median net pay" */
  income_source: string | null;
  suggested_tradelines: number;
  documents: number;
}

/** GET / PUT .../inputs (normalized by lib/eligibility.parseInputsResponse). */
export interface EligibilityInputsResponse {
  applicant: string;
  inputs: EligibilityInputs;
  /** Fields the draft took from the applicant's documents. */
  fromDocuments: PrefillField[];
  prefill: EligibilityPrefill | null;
  /** The inputs were saved (else a draft, pre-filled when possible). */
  saved: boolean;
  /** When the saved inputs are deleted (DynamoDB TTL), ISO. */
  expiresAt: string | null;
  notes: string[];
}

// ------------------------------------------------------------------ lenders

/** A lender's policy for companies missing from its category list. */
export interface UnlistedCompanyPolicy {
  accepted: boolean;
  foir: number | null;
  multiplier: number | null;
}

/**
 * A SAMPLE lender policy (GET .../lenders, app/data/lender_policies.json);
 * every value is shown as returned.
 */
export interface LenderPolicy {
  id: string;
  name: string;
  product: string | null;
  /** Annual rate, percent (11.0). */
  roi: number | null;
  min_tenure_months: number | null;
  max_tenure_months: number | null;
  /** Base FOIR, a fraction of the monthly income (0.7). */
  foir: number | null;
  multiplier: number | null;
  min_amount: number | null;
  max_amount: number | null;
  min_cibil_score: number | null;
  max_enquiries_90d: number | null;
  employment_types: string[];
  /** Category name -> the FOIR and multiplier it gives. */
  company_categories: Record<
    string,
    { foir: number | null; multiplier: number | null }
  >;
  unlisted_company: UnlistedCompanyPolicy | null;
  serviceable_regions: string[];
}

export interface LendersResponse {
  sample: boolean;
  label: string | null;
  lenders: LenderPolicy[];
  disclaimers: string[];
}

/** GET .../pincodes/{pincode} */
export interface PincodeCheck {
  pincode: string;
  /** The SAMPLE region the pincode is in, if any. */
  region: string | null;
  lenders: { lender_id: string; lender: string; serviceable: boolean }[];
  sample: boolean;
}

/** One lender's answer in GET .../companies?name= */
export interface CompanyCategory {
  lender_id: string;
  lender: string;
  /** null when the company is not in this lender's list. */
  category: string | null;
  listed: boolean;
  /** Listed, or unlisted and the lender takes unlisted companies. */
  accepted: boolean;
  foir: number | null;
  multiplier: number | null;
}

/** GET .../companies?name= */
export interface CompanyCheck {
  query: string;
  /** The listed company the name is (legal suffixes ignored), if any. */
  match: { name: string; employment_type: string | null } | null;
  categories: CompanyCategory[];
  /** Listed companies whose name contains the query. */
  suggestions: string[];
  sample: boolean;
}

// ------------------------------------------------------------------ calculate
// app/eligibility.calculate: money is rounded to the paisa, the ROI is a
// percent (11.0), FOIR a fraction (0.7).

export type LenderStatus = 'eligible' | 'not_serviceable' | 'not_eligible';

/** The sheet's legend: policy (From Policy), formula (Formula Calculation), table (From Table). */
export type ParameterSource = 'policy' | 'formula' | 'table';

/** Parameter -> where its value came from (ids as above). */
export type ParameterSources = Record<string, string>;

/** One other income as a lender counts it. */
export interface OtherIncomeConsidered {
  type: string;
  label: string | null;
  agreement: string | null;
  frequency: string | null;
  monthly_amount: number | null;
  consideration_pct: number | null;
  considered: number | null;
}

export interface LenderEligibility {
  lender: string;
  lender_id: string | null;
  /** eligible, not_serviceable or not_eligible (other values shown as sent). */
  status: string;
  status_label: string | null;
  /** Why the lender is not eligible / not serviceable (every reason). */
  reasons: string[];
  /** Remarks that do not change the status (e.g. tenure capped). */
  notes: string[];
  /** min(FOIR eligibility, multiplier eligibility, max amount), to the paisa; 0 unless eligible. */
  eligible_amount: number | null;
  /** What the formulas give, whatever the status. */
  computed_amount: number | null;
  /** The lender's max tenure: the EMI is shown at it. */
  tenure_months: number | null;
  /** The per-lakh EMI's tenure: requested, within the lender's limits. */
  calculation_tenure_months: number | null;
  roi: number | null;
  /** At the lender's max tenure; 0 unless eligible. */
  emi: number | null;
  /** The EMI over calculation_tenure_months; 0 unless eligible. */
  emi_at_calculation_tenure: number | null;
  per_lakh_emi: number | null;
  foir_eligibility: number | null;
  multiplier_eligibility: number | null;
  /** Net salary plus the other income at this lender's consideration %. */
  income_considered: number | null;
  other_income_considered: OtherIncomeConsidered[];
  obligations: number | null;
  foir: number | null;
  multiplier: number | null;
  company_category: string | null;
  /** category, unlisted, or base (no company entered). */
  company_policy: string | null;
  max_amount: number | null;
  min_amount: number | null;
  bt_amount: number | null;
  covers_bt: boolean | null;
  covers_requested: boolean | null;
  /** The pincode is serviceable; null when no pincode was entered. */
  serviceable: boolean | null;
  region: string | null;
  sources: ParameterSources;
}

/** POST .../calculate {applicant, inputs?}: inputs are calculated, not saved. */
export interface EligibilityCalculateRequest {
  applicant: string;
  inputs?: EligibilityInputs;
}

export interface EligibilityIncome {
  net_salary: number | null;
  /** verified (from the file check), entered, or null */
  net_salary_source: string | null;
  net_salary_source_label: string | null;
  entered_net_income: number | null;
  verified_net_income: number | null;
  other_income_monthly: number | null;
}

/** One obligation the calculation counted. */
export interface CountedObligation {
  /** 1-based tradeline number; null for a bank-statement EMI. */
  index: number | null;
  lender: string | null;
  loan_type: string | null;
  emi: number | null;
  /** tradeline or bank_statement */
  source: string | null;
  /** Why a bank-statement EMI was counted (it matches no tradeline). */
  flag: string | null;
}

export interface EligibilityResult {
  applicant: string;
  calculatedAt: string | null;
  /** Net monthly salary used (verified from the documents, else as entered). */
  income_considered: number | null;
  income: EligibilityIncome | null;
  /** Monthly obligations: EMIs of the loans marked Obligate and unmatched bank EMIs. */
  obligations: number | null;
  counted_obligations: CountedObligation[];
  bt_amount: number | null;
  per_lender: LenderEligibility[];
  best_lender: string | null;
  best_lender_reason: string | null;
  /** The policies are SAMPLE data. */
  sample: boolean;
  /** Whether the file check's verified figures were used, and why not. */
  file_check: { used: boolean; detail: string | null } | null;
  notes: string[];
  disclaimers: string[];
}

// ------------------------------------------------------------------ login

/** POST .../login {applicant, lender (id or name)} */
export interface EligibilityLoginRequest {
  applicant: string;
  lender: string;
}

/** The CRM webhook delivery made for a login. */
export interface LoginDelivery {
  delivery_id: string | null;
  /** delivered or failed */
  status: string;
  http_status: number | null;
  error: string | null;
}

/** delivered, failed, not_enabled, not_configured or skipped */
export type LoginWebhook =
  | 'delivered'
  | 'failed'
  | 'not_enabled'
  | 'not_configured'
  | 'skipped';

export interface EligibilityLoginResponse {
  /** "recorded" */
  status: string;
  lender: string | null;
  eligible_amount: number | null;
  emi: number | null;
  tenure_months: number | null;
  roi: number | null;
  requested_at: string | null;
  webhook: LoginWebhook | string;
  webhook_detail: string | null;
  /** The CRM webhook delivery; null when none was attempted. */
  delivery: LoginDelivery | null;
}
