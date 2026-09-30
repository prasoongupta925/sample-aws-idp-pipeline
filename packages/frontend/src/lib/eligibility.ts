// Helpers for the Eligibility & lenders panel (projects/{id}/eligibility).
// The eligibility maths is done by the backend (app/eligibility.py): nothing
// here computes an amount, a FOIR or an EMI. These functions build the
// requests, check the responses and format the backend's numbers with Indian
// digit grouping.
import type {
  CibilEnquiries,
  CibilSource,
  CompanyCategory,
  CompanyCheck,
  CountedObligation,
  EligibilityCalculateRequest,
  EligibilityCibil,
  EligibilityIncome,
  EligibilityInputs,
  EligibilityInputsRequest,
  EligibilityInputsResponse,
  EligibilityLoan,
  EligibilityLoginResponse,
  EligibilityPrefill,
  EligibilityProfile,
  EligibilityResult,
  EmploymentType,
  HouseOwnership,
  IncomeFrequency,
  LenderEligibility,
  LenderPolicy,
  LendersResponse,
  LoanType,
  LoginDelivery,
  OtherIncome,
  OtherIncomeConsidered,
  OtherIncomeType,
  PincodeCheck,
  PrefillField,
  RentAgreement,
  Tradeline,
  TradelineAction,
  TradelineSource,
  TradelineStatus,
} from '../types/eligibility';

// ------------------------------------------------------------------ options
// The ids of app/routers/eligibility.py (the API also takes the labels).

export const EMPLOYMENT_TYPES: readonly EmploymentType[] = [
  'defence',
  'government',
  'grade_4',
  'llp',
  'merchant_navy',
  'partnership_proprietorship',
  'private_limited',
  'public_limited',
];

export const HOUSE_OWNERSHIP: readonly HouseOwnership[] = ['owned', 'rented'];

export const OTHER_INCOME_TYPES: readonly OtherIncomeType[] = [
  'rented',
  'bonus',
  'incentive',
  'pension',
];

export const INCOME_FREQUENCIES: readonly IncomeFrequency[] = [
  'yearly',
  'half_yearly',
  'quarterly',
  'monthly',
];

export const RENT_AGREEMENTS: readonly RentAgreement[] = [
  'notary',
  'registered',
];

export const LOAN_TYPES: readonly LoanType[] = [
  'personal',
  'home',
  'mortgage',
  'car',
  'education',
  'application',
  'consumer',
  'credit_card',
];

export const TRADELINE_ACTIONS: readonly TradelineAction[] = [
  'bt',
  'obligate',
  'close',
];

export const TRADELINE_STATUSES: readonly TradelineStatus[] = [
  'active',
  'closed',
  'settled',
  'written_off',
  'suit_filed',
  'wilful_default',
  'restructured',
];

const TRADELINE_SOURCES: readonly TradelineSource[] = [
  'manual',
  'bureau',
  'bank_statement',
];

const CIBIL_SOURCES: readonly CibilSource[] = ['manual', 'bureau'];

// The API's limits (Field max_length / le), so a row is not refused.
export const MAX_OTHER_INCOME = 10;
export const MAX_TRADELINES = 50;

/** Other income rows that carry a frequency (bonus, incentive). */
export function incomeHasFrequency(type: OtherIncomeType): boolean {
  return type === 'bonus' || type === 'incentive';
}

// ------------------------------------------------------------------ numbers

const INDIAN_NUMBER = new Intl.NumberFormat('en-IN', {
  maximumFractionDigits: 2,
});

// Money: whole rupees without decimals, else always both paise digits
// (₹39,172.10, never ₹39,172.1).
const INDIAN_WHOLE = new Intl.NumberFormat('en-IN', {
  maximumFractionDigits: 0,
});
const INDIAN_PAISE = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const INR_WHOLE = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
const INR_PAISE = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** An amount with no paise left once rounded to the paisa (39172.004 -> true). */
function wholeRupees(n: number): boolean {
  return Math.round(n * 100) % 100 === 0;
}

/** 2058000 -> '20,58,000'; 98000.5 -> '98,000.50' (Indian digit grouping). */
export function formatIndianNumber(value: number | null | undefined): string {
  const n = finite(value);
  if (n === null) return '';
  return (wholeRupees(n) ? INDIAN_WHOLE : INDIAN_PAISE).format(n);
}

/** 2058000 -> '₹20,58,000'; 39172.1345 -> '₹39,172.13'; 39172.1 -> '₹39,172.10'; null -> '–'. */
export function formatRupees(value: number | null | undefined): string {
  const n = finite(value);
  if (n === null) return '–';
  return (wholeRupees(n) ? INR_WHOLE : INR_PAISE).format(n);
}

/**
 * A typed amount: '20,58,000', '₹ 98,000' or '98000.50' -> the number; blank
 * -> null; anything else -> NaN (the field shows it is not a number).
 */
export function parseAmount(text: string): number | null {
  const s = text.replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');
  if (!s) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return Number.NaN;
  return Number(s);
}

/** A typed whole number ('12'); blank -> null; else NaN. */
export function parseCount(text: string): number | null {
  const s = text.replace(/[,\s]/g, '');
  if (!s) return null;
  return /^\d+$/.test(s) ? Number(s) : Number.NaN;
}

/** The ROI as a percentage: 11 (the API's percent) or 0.11 (a fraction) -> 11. */
export function roiPercent(value: number | null | undefined): number | null {
  const n = finite(value);
  if (n === null) return null;
  const pct = n > 0 && n < 1 ? n * 100 : n;
  return Math.round(pct * 1e6) / 1e6;
}

/** 11 or 0.11 -> '11%'; 10.75 -> '10.75%'; null -> '–'. */
export function formatRoi(value: number | null | undefined): string {
  const pct = roiPercent(value);
  return pct === null ? '–' : `${INDIAN_NUMBER.format(pct)}%`;
}

/** A FOIR (always a fraction in the API: 0.7) as '70%'; 1 -> '100%'. */
export function formatFoir(value: number | null | undefined): string {
  const n = finite(value);
  if (n === null) return '–';
  return `${INDIAN_NUMBER.format(Math.round(n * 100 * 1e6) / 1e6)}%`;
}

// ------------------------------------------------------------------ inputs

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  if (typeof value !== 'string') return null;
  const v = value
    .trim()
    .toLowerCase()
    .replace(/[\s/-]+/g, '_') as T;
  return allowed.includes(v) ? v : null;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && !!v.trim())
    : [];
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function emptyProfile(): EligibilityProfile {
  return {
    pan: null,
    name: null,
    mobile: null,
    dob: null,
    house_ownership: null,
    pincode: null,
    current_address: null,
    permanent_address: null,
    company: null,
    employment_type: null,
    net_income: null,
    other_income: [],
  };
}

// Row keys keep a row's inputs in place when a row above it is removed.
let rowSeq = 0;

export function rowKey(): string {
  rowSeq += 1;
  return `row-${rowSeq}`;
}

export function emptyTradeline(): Tradeline {
  return {
    key: rowKey(),
    loan_type: 'personal',
    lender: null,
    sanction_amount: null,
    outstanding: null,
    emi: null,
    status: 'active',
    action: 'obligate',
    source: 'manual',
  };
}

export function emptyOtherIncome(type: OtherIncomeType = 'bonus'): OtherIncome {
  return {
    key: rowKey(),
    type,
    amount: null,
    frequency: incomeHasFrequency(type) ? 'yearly' : null,
    agreement: type === 'rented' ? 'registered' : null,
  };
}

export function emptyInputs(): EligibilityInputs {
  return {
    profile: emptyProfile(),
    cibil: {
      score: null,
      enquiries: { d30: null, d60: null, d90: null, d120: null },
      tradelines: [],
    },
    loan: { amount: null, tenure_months: null },
  };
}

function normalizeOtherIncome(raw: unknown): OtherIncome | null {
  const o = obj(raw);
  const type = oneOf(o.type, OTHER_INCOME_TYPES);
  if (!type) return null;
  return {
    key: rowKey(),
    type,
    amount: finite(o.amount),
    frequency: incomeHasFrequency(type)
      ? oneOf(o.frequency, INCOME_FREQUENCIES)
      : null,
    agreement: type === 'rented' ? oneOf(o.agreement, RENT_AGREEMENTS) : null,
  };
}

function normalizeProfile(raw: unknown): EligibilityProfile {
  const o = obj(raw);
  return {
    pan: text(o.pan),
    name: text(o.name),
    mobile: text(o.mobile),
    dob: text(o.dob),
    house_ownership: oneOf(o.house_ownership, HOUSE_OWNERSHIP),
    pincode: text(o.pincode),
    current_address: text(o.current_address),
    permanent_address: text(o.permanent_address),
    company: text(o.company),
    employment_type: oneOf(o.employment_type, EMPLOYMENT_TYPES),
    net_income: finite(o.net_income),
    other_income: Array.isArray(o.other_income)
      ? o.other_income
          .map(normalizeOtherIncome)
          .filter((r): r is OtherIncome => r !== null)
      : [],
  };
}

function normalizeTradeline(raw: unknown): Tradeline {
  const o = obj(raw);
  const row: Tradeline = {
    key: rowKey(),
    loan_type: oneOf(o.loan_type, LOAN_TYPES),
    lender: text(o.lender),
    sanction_amount: finite(o.sanction_amount),
    outstanding: finite(o.outstanding),
    emi: finite(o.emi),
    status: oneOf(o.status, TRADELINE_STATUSES),
    action: oneOf(o.action, TRADELINE_ACTIONS) ?? 'obligate',
    source: oneOf(o.source, TRADELINE_SOURCES) ?? 'manual',
  };
  const account = text(o.account_number);
  if (account) row.account_number = account;
  for (const key of ['overdue', 'emis_paid', 'emis_pending'] as const) {
    const n = finite(o[key]);
    if (n !== null) row[key] = n;
  }
  for (const key of ['open_date', 'last_payment_date'] as const) {
    const d = text(o[key]);
    if (d) row[key] = d;
  }
  return row;
}

function normalizeCibil(raw: unknown): EligibilityCibil {
  const o = obj(raw);
  const e = obj(o.enquiries);
  const enquiries: CibilEnquiries = {
    d30: finite(e.d30),
    d60: finite(e.d60),
    d90: finite(e.d90),
    d120: finite(e.d120),
  };
  const cibil: EligibilityCibil = {
    score: finite(o.score),
    enquiries,
    tradelines: Array.isArray(o.tradelines)
      ? o.tradelines.map(normalizeTradeline)
      : [],
  };
  const source = oneOf(o.source, CIBIL_SOURCES);
  if (source && source !== 'manual') cibil.source = source;
  const reportDate = text(o.report_date);
  if (reportDate) cibil.report_date = reportDate;
  return cibil;
}

function normalizeLoan(raw: unknown): EligibilityLoan {
  const o = obj(raw);
  return {
    amount: finite(o.amount),
    tenure_months: finite(o.tenure_months),
  };
}

/** Any {profile, cibil, loan} object -> complete inputs (unknown values dropped). */
export function normalizeInputs(raw: unknown): EligibilityInputs {
  const o = obj(raw);
  return {
    profile: normalizeProfile(o.profile),
    cibil: normalizeCibil(o.cibil),
    loan: normalizeLoan(o.loan),
  };
}

const PREFILL_FIELDS: readonly PrefillField[] = [
  'name',
  'pan',
  'company',
  'employment_type',
  'net_income',
  'dob',
  'loan_amount',
  'tenure_months',
  'tradelines',
];

function prefill(raw: unknown): EligibilityPrefill | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = obj(raw);
  return {
    available: o.available === true,
    detail: text(o.detail),
    income_source: text(o.income_source),
    suggested_tradelines: finite(o.suggested_tradelines) ?? 0,
    documents: finite(o.documents) ?? 0,
  };
}

/** expires_at as ISO: an ISO string or epoch seconds (the DynamoDB TTL). */
export function expiresAtIso(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString();
  }
  const s = text(value);
  return s && !Number.isNaN(Date.parse(s)) ? s : null;
}

/** GET / PUT .../inputs: the inputs to edit, and which fields the documents filled. */
export function parseInputsResponse(
  raw: unknown,
  applicant: string,
): EligibilityInputsResponse {
  const o = obj(raw);
  const inputs = o.inputs && typeof o.inputs === 'object' ? o.inputs : null;
  if (!inputs || typeof o.saved !== 'boolean') {
    throw new Error('unexpected response from the eligibility inputs API');
  }
  const fields = strings(o.from_documents);
  return {
    applicant: text(o.applicant) ?? applicant,
    inputs: normalizeInputs(inputs),
    fromDocuments: PREFILL_FIELDS.filter((f) => fields.includes(f)),
    prefill: prefill(o.prefill),
    saved: o.saved,
    expiresAt: expiresAtIso(o.expires_at),
    notes: strings(o.notes),
  };
}

function trimmed(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

/** Drops optional tradeline details that are empty (the API makes them optional). */
function tradelineBody(row: Tradeline): Tradeline {
  const body: Tradeline = {
    loan_type: row.loan_type,
    lender: trimmed(row.lender),
    sanction_amount: finite(row.sanction_amount),
    outstanding: finite(row.outstanding),
    emi: finite(row.emi),
    status: row.status,
    action: row.action,
  };
  const account = trimmed(row.account_number);
  if (account) body.account_number = account;
  for (const key of ['overdue', 'emis_paid', 'emis_pending'] as const) {
    const n = finite(row[key]);
    if (n !== null) body[key] = n;
  }
  for (const key of ['open_date', 'last_payment_date'] as const) {
    const d = trimmed(row[key]);
    if (d) body[key] = d;
  }
  // The pre-fill's bank-statement rows and a bureau pull's rows keep their source.
  if (row.source && row.source !== 'manual') body.source = row.source;
  return body;
}

/** The inputs as the API takes them: trimmed text, NaN (bad typing) as null. */
export function inputsBody(inputs: EligibilityInputs): EligibilityInputs {
  const p = inputs.profile;
  const c = inputs.cibil;
  const cibil: EligibilityCibil = {
    score: finite(c.score),
    enquiries: {
      d30: finite(c.enquiries.d30),
      d60: finite(c.enquiries.d60),
      d90: finite(c.enquiries.d90),
      d120: finite(c.enquiries.d120),
    },
    tradelines: c.tradelines.map(tradelineBody),
  };
  if (c.source && c.source !== 'manual') cibil.source = c.source;
  const reportDate = trimmed(c.report_date);
  if (reportDate) cibil.report_date = reportDate;
  return {
    profile: {
      pan: trimmed(p.pan)?.replace(/\s/g, '').toUpperCase() ?? null,
      name: trimmed(p.name),
      mobile: trimmed(p.mobile),
      dob: trimmed(p.dob),
      house_ownership: p.house_ownership,
      pincode: trimmed(p.pincode),
      current_address: trimmed(p.current_address),
      permanent_address: trimmed(p.permanent_address),
      company: trimmed(p.company),
      employment_type: p.employment_type,
      net_income: finite(p.net_income),
      other_income: p.other_income.map((r) => ({
        type: r.type,
        amount: finite(r.amount),
        frequency: incomeHasFrequency(r.type) ? (r.frequency ?? null) : null,
        agreement: r.type === 'rented' ? (r.agreement ?? null) : null,
      })),
    },
    cibil,
    loan: {
      amount: finite(inputs.loan.amount),
      tenure_months: finite(inputs.loan.tenure_months),
    },
  };
}

/** PUT .../inputs */
export function inputsRequestBody(
  applicant: string,
  inputs: EligibilityInputs,
): EligibilityInputsRequest {
  return { applicant, ...inputsBody(inputs) };
}

/** POST .../calculate: the inputs on screen (calculated, not saved). */
export function calculateRequestBody(
  applicant: string,
  inputs?: EligibilityInputs,
): EligibilityCalculateRequest {
  return inputs ? { applicant, inputs: inputsBody(inputs) } : { applicant };
}

/** Numbers typed that are not numbers (NaN): the form cannot be sent until they are fixed. */
export function countInvalidNumbers(inputs: EligibilityInputs): number {
  const values: (number | null | undefined)[] = [
    inputs.profile.net_income,
    ...inputs.profile.other_income.map((r) => r.amount),
    inputs.cibil.score,
    inputs.cibil.enquiries.d30,
    inputs.cibil.enquiries.d60,
    inputs.cibil.enquiries.d90,
    inputs.cibil.enquiries.d120,
    ...inputs.cibil.tradelines.flatMap((r) => [
      r.sanction_amount,
      r.outstanding,
      r.emi,
      r.overdue,
      r.emis_paid,
      r.emis_pending,
    ]),
    inputs.loan.amount,
    inputs.loan.tenure_months,
  ];
  return values.filter((v) => typeof v === 'number' && Number.isNaN(v)).length;
}

/** Same inputs, same key: tells whether a result is for the inputs on screen. */
export function inputsKey(inputs: EligibilityInputs): string {
  return JSON.stringify(inputsBody(inputs));
}

// ------------------------------------------------------------------ edits

export function setProfile(
  inputs: EligibilityInputs,
  patch: Partial<EligibilityProfile>,
): EligibilityInputs {
  return { ...inputs, profile: { ...inputs.profile, ...patch } };
}

export function setLoan(
  inputs: EligibilityInputs,
  patch: Partial<EligibilityLoan>,
): EligibilityInputs {
  return { ...inputs, loan: { ...inputs.loan, ...patch } };
}

export function setCibil(
  inputs: EligibilityInputs,
  patch: Partial<EligibilityCibil>,
): EligibilityInputs {
  return { ...inputs, cibil: { ...inputs.cibil, ...patch } };
}

export function setEnquiries(
  inputs: EligibilityInputs,
  patch: Partial<CibilEnquiries>,
): EligibilityInputs {
  return setCibil(inputs, {
    enquiries: { ...inputs.cibil.enquiries, ...patch },
  });
}

export function updateTradeline(
  inputs: EligibilityInputs,
  index: number,
  patch: Partial<Tradeline>,
): EligibilityInputs {
  return setCibil(inputs, {
    tradelines: inputs.cibil.tradelines.map((row, i) =>
      i === index ? { ...row, ...patch } : row,
    ),
  });
}

/** BT / Obligate / Close of one tradeline; the others are unchanged. */
export function setTradelineAction(
  inputs: EligibilityInputs,
  index: number,
  action: TradelineAction,
): EligibilityInputs {
  return updateTradeline(inputs, index, { action });
}

export function addTradeline(inputs: EligibilityInputs): EligibilityInputs {
  if (inputs.cibil.tradelines.length >= MAX_TRADELINES) return inputs;
  return setCibil(inputs, {
    tradelines: [...inputs.cibil.tradelines, emptyTradeline()],
  });
}

export function removeTradeline(
  inputs: EligibilityInputs,
  index: number,
): EligibilityInputs {
  return setCibil(inputs, {
    tradelines: inputs.cibil.tradelines.filter((_, i) => i !== index),
  });
}

export function updateOtherIncome(
  inputs: EligibilityInputs,
  index: number,
  patch: Partial<OtherIncome>,
): EligibilityInputs {
  return setProfile(inputs, {
    other_income: inputs.profile.other_income.map((row, i) => {
      if (i !== index) return row;
      if (patch.type && patch.type !== row.type) {
        // A new income type starts with that type's own fields.
        return {
          ...emptyOtherIncome(patch.type),
          key: row.key,
          amount: patch.amount !== undefined ? patch.amount : row.amount,
        };
      }
      return { ...row, ...patch };
    }),
  });
}

export function addOtherIncome(
  inputs: EligibilityInputs,
  type?: OtherIncomeType,
): EligibilityInputs {
  if (inputs.profile.other_income.length >= MAX_OTHER_INCOME) return inputs;
  const used = new Set(inputs.profile.other_income.map((r) => r.type));
  const next = type ?? OTHER_INCOME_TYPES.find((t) => !used.has(t)) ?? 'bonus';
  return setProfile(inputs, {
    other_income: [...inputs.profile.other_income, emptyOtherIncome(next)],
  });
}

export function removeOtherIncome(
  inputs: EligibilityInputs,
  index: number,
): EligibilityInputs {
  return setProfile(inputs, {
    other_income: inputs.profile.other_income.filter((_, i) => i !== index),
  });
}

// ------------------------------------------------------------------ checks
// Format hints only: the API validates the inputs (422 with the reason).

export function panLooksValid(pan: string): boolean {
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan.replace(/\s/g, '').toUpperCase());
}

/** 'XXXXXX314M': the masked PAN of a pre-fill (the API accepts it back). */
export function isMaskedPan(pan: string | null | undefined): boolean {
  return /^X{6}[0-9]{3}[A-Z]$/.test(
    String(pan ?? '')
      .replace(/\s/g, '')
      .toUpperCase(),
  );
}

export function mobileLooksValid(mobile: string): boolean {
  let digits = mobile.replace(/[\s-]/g, '');
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith('91')) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  return /^[6-9]\d{9}$/.test(digits);
}

export function pincodeLooksValid(pincode: string): boolean {
  return /^[1-9]\d{5}$/.test(pincode.trim());
}

/** CIBIL scores run from 300 to 900. */
export function scoreLooksValid(score: number): boolean {
  return Number.isInteger(score) && score >= 300 && score <= 900;
}

/** The API refuses enquiries that are not cumulative (d30 <= d60 <= d90 <= d120). */
export function enquiriesOutOfOrder(
  enquiries: CibilEnquiries,
): [keyof CibilEnquiries, keyof CibilEnquiries] | null {
  const known = (['d30', 'd60', 'd90', 'd120'] as const).filter(
    (k) => finite(enquiries[k]) !== null,
  );
  for (let i = 1; i < known.length; i += 1) {
    const a = enquiries[known[i - 1]] as number;
    const b = enquiries[known[i]] as number;
    if (a > b) return [known[i - 1], known[i]];
  }
  return null;
}

/** Today as a date input's value (YYYY-MM-DD, local time). */
export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A date input's value lies after today (the API wants past dates). */
export function isFutureDate(
  value: string | null | undefined,
  now: Date = new Date(),
): boolean {
  return !!value && value > localToday(now);
}

/** The API's account number format (letters, digits, space . / -; 30 at most). */
export function accountNumberLooksValid(value: string): boolean {
  return /^[A-Za-z0-9 ./-]{1,30}$/.test(value.trim());
}

// ------------------------------------------------------------------ applicant

/**
 * Who the eligibility API is asked about for an applicant of the verdict:
 * the PAN when the verdict has one (a name can match two applicants), else
 * the name; the same value finds the saved inputs again.
 */
export function eligibilityApplicant(applicant: {
  applicant: string;
  pan?: string | null;
}): { id: string; name: string; pan: string | null } {
  const pan = applicant.pan?.replace(/\s/g, '').toUpperCase() || null;
  return { id: pan ?? applicant.applicant, name: applicant.applicant, pan };
}

// ------------------------------------------------------------------ results

export type LenderTone =
  | 'eligible'
  | 'notServiceable'
  | 'notEligible'
  | 'unknown';

function statusKey(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

export function lenderTone(status: unknown): LenderTone {
  const s = statusKey(status);
  if (s === 'eligible') return 'eligible';
  if (s === 'not_serviceable') return 'notServiceable';
  if (s === 'not_eligible' || s === 'ineligible') return 'notEligible';
  return 'unknown';
}

function sources(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(value))) {
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

function otherIncomeConsidered(raw: unknown): OtherIncomeConsidered | null {
  const o = obj(raw);
  const type = text(o.type);
  if (!type) return null;
  return {
    type,
    label: text(o.label),
    agreement: text(o.agreement),
    frequency: text(o.frequency),
    monthly_amount: finite(o.monthly_amount),
    consideration_pct: finite(o.consideration_pct),
    considered: finite(o.considered),
  };
}

function lenderRow(raw: unknown): LenderEligibility | null {
  const o = obj(raw);
  const lender = text(o.lender) ?? text(o.name);
  if (!lender) return null;
  return {
    lender,
    lender_id: text(o.lender_id),
    status: text(o.status) ?? '',
    status_label: text(o.status_label),
    reasons: strings(o.reasons),
    notes: strings(o.notes),
    eligible_amount: finite(o.eligible_amount),
    computed_amount: finite(o.computed_amount),
    tenure_months: finite(o.tenure_months),
    calculation_tenure_months: finite(o.calculation_tenure_months),
    roi: finite(o.roi),
    emi: finite(o.emi),
    emi_at_calculation_tenure: finite(o.emi_at_calculation_tenure),
    per_lakh_emi: finite(o.per_lakh_emi),
    foir_eligibility: finite(o.foir_eligibility),
    multiplier_eligibility: finite(o.multiplier_eligibility),
    income_considered: finite(o.income_considered),
    other_income_considered: Array.isArray(o.other_income_considered)
      ? o.other_income_considered
          .map(otherIncomeConsidered)
          .filter((r): r is OtherIncomeConsidered => r !== null)
      : [],
    obligations: finite(o.obligations),
    foir: finite(o.foir),
    multiplier: finite(o.multiplier),
    company_category: text(o.company_category),
    company_policy: text(o.company_policy),
    max_amount: finite(o.max_amount),
    min_amount: finite(o.min_amount),
    bt_amount: finite(o.bt_amount),
    covers_bt: bool(o.covers_bt),
    covers_requested: bool(o.covers_requested),
    serviceable: bool(o.serviceable),
    region: text(o.region),
    sources: sources(o.sources),
  };
}

function income(raw: unknown): EligibilityIncome | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = obj(raw);
  return {
    net_salary: finite(o.net_salary),
    net_salary_source: text(o.net_salary_source),
    net_salary_source_label: text(o.net_salary_source_label),
    entered_net_income: finite(o.entered_net_income),
    verified_net_income: finite(o.verified_net_income),
    other_income_monthly: finite(o.other_income_monthly),
  };
}

function counted(raw: unknown): CountedObligation[] {
  const list = obj(raw).counted;
  if (!Array.isArray(list)) return [];
  return list.map((row) => {
    const o = obj(row);
    return {
      index: finite(o.index),
      lender: text(o.lender),
      loan_type: text(o.loan_type),
      emi: finite(o.emi),
      source: text(o.source),
      flag: text(o.flag),
    };
  });
}

/** Validates POST .../calculate; throws on anything but the contract. */
export function parseCalculateResponse(
  raw: unknown,
  applicant: string,
): EligibilityResult {
  const o = obj(raw);
  if (!Array.isArray(o.per_lender)) {
    throw new Error('unexpected response from the eligibility service');
  }
  const perLender = o.per_lender
    .map(lenderRow)
    .filter((r): r is LenderEligibility => r !== null);
  const best = text(o.best_lender);
  const fileCheck =
    o.file_check && typeof o.file_check === 'object'
      ? {
          used: obj(o.file_check).used === true,
          detail: text(obj(o.file_check).detail),
        }
      : null;
  return {
    applicant: text(o.applicant) ?? applicant,
    calculatedAt: text(o.calculated_at),
    income_considered: finite(o.income_considered),
    income: income(o.income),
    obligations: finite(o.obligations),
    counted_obligations: counted(o.obligation_details),
    bt_amount: finite(o.bt_amount),
    per_lender: perLender,
    best_lender: best && perLender.some((r) => r.lender === best) ? best : null,
    best_lender_reason: text(o.best_lender_reason),
    // Shipped policies are SAMPLE data: only an explicit false says otherwise.
    sample: o.sample !== false,
    file_check: fileCheck,
    notes: strings(o.notes),
    disclaimers: strings(o.disclaimers),
  };
}

function delivery(raw: unknown): LoginDelivery | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = obj(raw);
  return {
    delivery_id: text(o.delivery_id),
    status: text(o.status) ?? 'failed',
    http_status: finite(o.http_status),
    error: text(o.error),
  };
}

/** POST .../login -> {status: recorded, webhook, delivery|null, ...}. */
export function parseLoginResponse(raw: unknown): EligibilityLoginResponse {
  const o = obj(raw);
  const status = text(o.status);
  if (!status) throw new Error('unexpected response from the login service');
  const d = delivery(o.delivery);
  return {
    status,
    lender: text(o.lender),
    eligible_amount: finite(o.eligible_amount),
    emi: finite(o.emi),
    tenure_months: finite(o.tenure_months),
    roi: finite(o.roi),
    requested_at: text(o.requested_at),
    webhook:
      text(o.webhook) ??
      (d
        ? statusKey(d.status) === 'delivered'
          ? 'delivered'
          : 'failed'
        : 'not_enabled'),
    webhook_detail: text(o.webhook_detail),
    delivery: d,
  };
}

/** Whether the CRM heard of the login: notified, failed, or not sent. */
export function webhookOutcome(
  response: Pick<EligibilityLoginResponse, 'webhook' | 'delivery'>,
): 'notified' | 'failed' | 'notSent' {
  const w = statusKey(response.webhook);
  if (w === 'delivered') return 'notified';
  if (w === 'failed') return 'failed';
  return 'notSent';
}

function policy(raw: unknown): LenderPolicy | null {
  const o = obj(raw);
  const name = text(o.name) ?? text(o.lender);
  if (!name) return null;
  const categories: LenderPolicy['company_categories'] = {};
  for (const [category, value] of Object.entries(obj(o.company_categories))) {
    const c = obj(value);
    categories[category] = {
      foir: finite(c.foir),
      multiplier: finite(c.multiplier),
    };
  }
  const unlisted =
    o.unlisted_company && typeof o.unlisted_company === 'object'
      ? obj(o.unlisted_company)
      : null;
  return {
    id: text(o.id) ?? text(o.lender_id) ?? name,
    name,
    product: text(o.product),
    roi: finite(o.roi),
    min_tenure_months: finite(o.min_tenure_months),
    max_tenure_months: finite(o.max_tenure_months),
    foir: finite(o.foir),
    multiplier: finite(o.multiplier),
    min_amount: finite(o.min_amount),
    max_amount: finite(o.max_amount),
    min_cibil_score: finite(o.min_cibil_score),
    max_enquiries_90d: finite(o.max_enquiries_90d),
    employment_types: strings(o.employment_types),
    company_categories: categories,
    unlisted_company: unlisted
      ? {
          accepted: unlisted.accepted === true,
          foir: finite(unlisted.foir),
          multiplier: finite(unlisted.multiplier),
        }
      : null,
    serviceable_regions: strings(o.serviceable_regions),
  };
}

/** GET .../lenders: {sample, label, lenders, disclaimers} (or a bare list). */
export function parseLenders(raw: unknown): LendersResponse {
  const o = obj(raw);
  const list = Array.isArray(raw) ? raw : o.lenders;
  if (!Array.isArray(list)) {
    throw new Error('unexpected response from the lenders API');
  }
  return {
    sample: o.sample !== false,
    label: text(o.label),
    lenders: list.map(policy).filter((p): p is LenderPolicy => p !== null),
    disclaimers: strings(o.disclaimers),
  };
}

/** GET .../pincodes/{pincode} ("Check availability"). */
export function parsePincodeCheck(raw: unknown, pincode: string): PincodeCheck {
  const o = obj(raw);
  if (!Array.isArray(o.lenders)) {
    throw new Error('unexpected response from the pincode check');
  }
  return {
    pincode: text(o.pincode) ?? pincode,
    region: text(o.region),
    lenders: o.lenders
      .map((row) => {
        const r = obj(row);
        const lender = text(r.lender);
        return lender
          ? {
              lender_id: text(r.lender_id) ?? lender,
              lender,
              serviceable: r.serviceable === true,
            }
          : null;
      })
      .filter(
        (r): r is { lender_id: string; lender: string; serviceable: boolean } =>
          r !== null,
      ),
    sample: o.sample !== false,
  };
}

/** GET .../companies?name= ("Check category"). */
export function parseCompanyCheck(raw: unknown, name: string): CompanyCheck {
  const o = obj(raw);
  if (!Array.isArray(o.categories)) {
    throw new Error('unexpected response from the company check');
  }
  const match = o.match && typeof o.match === 'object' ? obj(o.match) : null;
  return {
    query: text(o.query) ?? name,
    match:
      match && text(match.name)
        ? {
            name: text(match.name) as string,
            employment_type: text(match.employment_type),
          }
        : null,
    categories: o.categories
      .map((row): CompanyCategory | null => {
        const r = obj(row);
        const lender = text(r.lender);
        if (!lender) return null;
        return {
          lender_id: text(r.lender_id) ?? lender,
          lender,
          category: text(r.category),
          listed: r.listed === true,
          accepted: r.accepted === true,
          foir: finite(r.foir),
          multiplier: finite(r.multiplier),
        };
      })
      .filter((r): r is CompanyCategory => r !== null),
    suggestions: strings(o.suggestions),
    sample: o.sample !== false,
  };
}
