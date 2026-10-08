// Helpers for the Eligibility & lenders panel (projects/{id}/eligibility).
// The eligibility maths is done by the backend (app/eligibility.py): nothing
// here computes an amount, a FOIR or an EMI. These functions build the
// requests, check the responses and format the backend's numbers with Indian
// digit grouping.
import type {
  CheckSource,
  CibilEnquiries,
  CibilSource,
  CibilSources,
  CompanyCategory,
  CompanyCheck,
  CountedObligation,
  DocumentRef,
  DocumentRows,
  EligibilityCalculateRequest,
  EligibilityCibil,
  EligibilityFileCheck,
  EligibilityIncome,
  EligibilityInputs,
  EligibilityInputsRequest,
  EligibilityInputsResponse,
  EligibilityLoan,
  EligibilityLoginResponse,
  EligibilityPrefill,
  EligibilityProfile,
  EligibilityResult,
  EligibilitySuggestion,
  SuggestedBank,
  DeclinedBank,
  EmploymentType,
  FieldSource,
  FieldSources,
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
  PolicySheetTerms,
  PrefillField,
  ProcessingFeePolicy,
  RentAgreement,
  SourcedField,
  StillNeeded,
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

export const HOUSE_OWNERSHIP: readonly HouseOwnership[] = [
  'owned',
  'rented',
  'parental',
  'company_provided',
];

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
  'credit_report',
  'bank_statement',
];

const CIBIL_SOURCES: readonly CibilSource[] = [
  'manual',
  'bureau',
  'credit_report',
];

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

/** A CIBIL score typed as text: digits, or -1 (no credit history). */
export function parseScore(text: string): number | null {
  const s = text.replace(/[,\s]/g, '');
  if (!s) return null;
  return /^-?\d+$/.test(s) ? Number(s) : Number.NaN;
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

/** An APR, always a percent (12.67 -> '12.67%', 0.5 -> '0.5%'); null -> '–'. */
export function formatApr(value: number | null | undefined): string {
  const n = finite(value);
  return n === null ? '–' : `${INDIAN_NUMBER.format(n)}%`;
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
    has_running_home_loan: null,
  };
}

// Row keys keep a row's inputs in place when a row above it is removed.
let rowSeq = 0;

export function rowKey(): string {
  rowSeq += 1;
  return `row-${rowSeq}`;
}

const ENDED_STATUSES = new Set(['closed', 'settled', 'written_off']);

/**
 * A Home Loan in the obligations that keeps running (not closed, settled or
 * written off; marked Obligate): what the backend uses when "Running home
 * loan" is left to the obligations.
 */
export function homeLoanInObligations(tradelines: Tradeline[]): boolean {
  return tradelines.some(
    (t) =>
      t.loan_type === 'home' &&
      !ENDED_STATUSES.has(t.status ?? '') &&
      t.action === 'obligate',
  );
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
    has_running_home_loan: bool(o.has_running_home_loan),
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

export const PREFILL_FIELDS: readonly PrefillField[] = [
  'name',
  'pan',
  'mobile',
  'dob',
  'house_ownership',
  'pincode',
  'current_address',
  'permanent_address',
  'company',
  'employment_type',
  'net_income',
  'other_income',
  'loan_amount',
  'tenure_months',
  'score',
  'enquiries',
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
    credit_report: text(o.credit_report),
    documents: finite(o.documents) ?? 0,
  };
}

/** The fields of GET .../inputs `sources` that hold one value each. */
export const SOURCED_FIELDS: readonly SourcedField[] = PREFILL_FIELDS.filter(
  (f): f is SourcedField => f !== 'other_income' && f !== 'tradelines',
);

function documentRef(raw: unknown): DocumentRef | null {
  const o = obj(raw);
  const file = text(o.file);
  if (!file) return null;
  const page = finite(o.page);
  return {
    document_id: text(o.document_id),
    file,
    page: page !== null && Number.isInteger(page) && page > 0 ? page : null,
    doc_type: text(o.doc_type),
  };
}

/** One entry of GET .../inputs `sources` (or a row source); null when it is not one. */
export function parseFieldSource(raw: unknown): FieldSource | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = obj(raw);
  if (o.source !== 'document' && o.source !== 'table') return null;
  return {
    source: o.source,
    value: o.value ?? null,
    documents: Array.isArray(o.documents)
      ? o.documents.map(documentRef).filter((d): d is DocumentRef => d !== null)
      : [],
    detail: text(o.detail),
    unverified: o.unverified === true,
  };
}

function rowSources(raw: unknown): (FieldSource | null)[] {
  return Array.isArray(raw) ? raw.map(parseFieldSource) : [];
}

/** `document_rows`: each source's value as a row of the form, with its `document`. */
function documentRows<T extends OtherIncome | Tradeline>(
  raw: unknown,
  normalize: (row: unknown) => T | null,
): T[] {
  return rowSources(raw).flatMap((source) => {
    const row = source ? normalize(source.value) : null;
    return row && source ? [{ ...row, document: source }] : [];
  });
}

const STILL_NEEDED_TABS: Record<string, StillNeeded['tab']> = {
  score: 'cibil',
  enquiries: 'cibil',
  tradelines: 'cibil',
};

/** GET .../inputs `still_needed` (the API's list for the inputs it returned). */
function parseStillNeeded(raw: unknown): StillNeeded[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): StillNeeded[] => {
    const o = obj(item);
    const field = text(o.field);
    if (!field) return [];
    const [head, n] = field.split('.');
    const number = Number(n);
    return [
      {
        field,
        required: o.required === true,
        fromDocuments: o.from_documents === true,
        tab: STILL_NEEDED_TABS[head] ?? 'profile',
        ...(head === 'tradelines' && Number.isInteger(number)
          ? { loan: { number, lender: null, loanType: null } }
          : {}),
      },
    ];
  });
}

/** expires_at as ISO: an ISO string or epoch seconds (the DynamoDB TTL). */
export function expiresAtIso(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString();
  }
  const s = text(value);
  return s && !Number.isNaN(Date.parse(s)) ? s : null;
}

/**
 * GET / PUT .../inputs: the inputs to edit, which fields the documents filled
 * and what the documents give each field. Each row of the inputs gets its
 * `document` (row_sources) and the CIBIL block its `sources` (never sent).
 */
export function parseInputsResponse(
  raw: unknown,
  applicant: string,
): EligibilityInputsResponse {
  const o = obj(raw);
  const raws = o.inputs && typeof o.inputs === 'object' ? o.inputs : null;
  if (!raws || typeof o.saved !== 'boolean') {
    throw new Error('unexpected response from the eligibility inputs API');
  }
  const fields = strings(o.from_documents);
  const sources: FieldSources = {};
  for (const [key, value] of Object.entries(obj(o.sources))) {
    const source = parseFieldSource(value);
    if (
      source &&
      (key === 'report' || SOURCED_FIELDS.includes(key as SourcedField))
    ) {
      sources[key as SourcedField | 'report'] = source;
    }
  }
  const rows = obj(o.document_rows);
  const documents: DocumentRows = {
    other_income: documentRows(rows.other_income, normalizeOtherIncome),
    tradelines: documentRows(rows.tradelines, normalizeTradeline),
  };

  // Each row of the inputs gets the document row it is (null: typed by hand).
  const inputs = normalizeInputs(raws);
  const row = obj(o.row_sources);
  const incomeSources = rowSources(row.other_income);
  const tradelineSources = rowSources(row.tradelines);
  inputs.profile.other_income = inputs.profile.other_income.map((r, i) =>
    incomeSources[i] ? { ...r, document: incomeSources[i] } : r,
  );
  inputs.cibil.tradelines = inputs.cibil.tradelines.map((r, i) =>
    tradelineSources[i] ? { ...r, document: tradelineSources[i] } : r,
  );
  const cibil: CibilSources = {};
  for (const key of ['score', 'enquiries', 'report'] as const) {
    if (sources[key]) cibil[key] = sources[key];
  }
  if (documents.tradelines.length > 0) cibil.tradelines = documents.tradelines;
  if (Object.keys(cibil).length > 0) inputs.cibil.sources = cibil;
  return {
    applicant: text(o.applicant) ?? applicant,
    inputs,
    fromDocuments: PREFILL_FIELDS.filter((f) => fields.includes(f)),
    prefill: prefill(o.prefill),
    sources,
    documentRows: documents,
    stillNeeded: parseStillNeeded(o.still_needed),
    saved: o.saved,
    expiresAt: expiresAtIso(o.expires_at),
    notes: strings(o.notes),
  };
}

// ------------------------------------------------------------------ document values
// What the documents give a field is shown with it while the field holds that
// value; typed values always win (nothing here overwrites one).

/** A field's value in the inputs (enquiries: the four windows). */
export function fieldValue(
  inputs: EligibilityInputs,
  field: SourcedField,
): unknown {
  if (field === 'loan_amount') return inputs.loan.amount;
  if (field === 'tenure_months') return inputs.loan.tenure_months;
  if (field === 'score') return inputs.cibil.score;
  if (field === 'enquiries') return inputs.cibil.enquiries;
  return inputs.profile[field];
}

function present(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'number') return Number.isFinite(value);
  return value !== null && value !== undefined;
}

/** Text as compared: spacing collapsed, case ignored. */
function folded(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function sameValue(field: SourcedField, a: unknown, b: unknown): boolean {
  if (!present(a) || !present(b)) return false;
  if (field === 'enquiries') {
    const x = obj(a);
    const y = obj(b);
    return (['d30', 'd60', 'd90', 'd120'] as const).every(
      (w) => (finite(x[w]) ?? null) === (finite(y[w]) ?? null),
    );
  }
  if (typeof a === 'number' || typeof b === 'number') return a === b;
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (field === 'pan') {
    const x = a.replace(/\s/g, '').toUpperCase();
    const y = b.replace(/\s/g, '').toUpperCase();
    // A masked PAN is the same PAN when its last 4 are.
    return isMaskedPan(x) || isMaskedPan(y)
      ? x.slice(-4) === y.slice(-4)
      : x === y;
  }
  if (field === 'mobile') {
    const digits = (s: string) => s.replace(/\D/g, '').slice(-10);
    return digits(a) === digits(b);
  }
  return folded(a) === folded(b);
}

/** `source` while `value` is the documents' value; null once typed over (or none). */
export function sourceFor(
  field: SourcedField,
  value: unknown,
  source: FieldSource | null | undefined,
): FieldSource | null {
  return source && sameValue(field, value, source.value) ? source : null;
}

/** `source` when the documents give a value other than `value` (an empty one too), else null. */
export function otherSourceFor(
  field: SourcedField,
  value: unknown,
  source: FieldSource | null | undefined,
): FieldSource | null {
  if (!source || !present(source.value)) return null;
  return sameValue(field, value, source.value) ? null : source;
}

/** The field's source while it holds the documents' value; null once typed over (or none). */
export function sourceOf(
  inputs: EligibilityInputs,
  sources: FieldSources | null | undefined,
  field: SourcedField,
): FieldSource | null {
  return sourceFor(field, fieldValue(inputs, field), sources?.[field]);
}

/** The documents' value of a field the inputs hold something else in (else null). */
export function otherDocumentValue(
  inputs: EligibilityInputs,
  sources: FieldSources | null | undefined,
  field: SourcedField,
): FieldSource | null {
  return otherSourceFor(field, fieldValue(inputs, field), sources?.[field]);
}

/** The CIBIL block alone as inputs, for the helpers that take inputs. */
export function cibilInputs(cibil: EligibilityCibil): EligibilityInputs {
  return {
    profile: emptyProfile(),
    cibil,
    loan: { amount: null, tenure_months: null },
  };
}

/** The CIBIL block's sources as FieldSources (score, enquiries, report). */
export function cibilFieldSources(cibil: EligibilityCibil): FieldSources {
  const { score, enquiries, report } = cibil.sources ?? {};
  return {
    ...(score ? { score } : {}),
    ...(enquiries ? { enquiries } : {}),
    ...(report ? { report } : {}),
  };
}

const TRADELINE_DATA = [
  'loan_type',
  'lender',
  'sanction_amount',
  'outstanding',
  'emi',
  'status',
  'account_number',
  'overdue',
  'emis_paid',
  'emis_pending',
  'open_date',
  'last_payment_date',
] as const;

/**
 * A row still holds what its document gives (a tradeline's BT / Obligate /
 * Close is the user's choice, not the document's).
 */
export function rowFromDocument(row: OtherIncome | Tradeline): boolean {
  const value = row.document ? obj(row.document.value) : null;
  if (!value) return false;
  const same = (a: unknown, b: unknown) =>
    (a ?? null) === (b ?? null) ||
    (typeof a === 'string' && typeof b === 'string' && folded(a) === folded(b));
  if ('type' in row) {
    return (['type', 'amount', 'frequency', 'agreement'] as const).every((k) =>
      same(row[k], value[k]),
    );
  }
  return TRADELINE_DATA.every((k) => same(row[k], value[k]));
}

function sourceKey(source: FieldSource): string {
  return JSON.stringify([
    source.value,
    source.documents.map((d) => [d.document_id, d.file, d.page]),
  ]);
}

/** The documents' rows that no row of the inputs came from (saved inputs typed otherwise). */
export function documentRowsMissing<T extends OtherIncome | Tradeline>(
  rows: readonly T[],
  documentRowsOf: readonly T[] | null | undefined,
): T[] {
  const used = new Set(
    rows.flatMap((r) => (r.document ? [sourceKey(r.document)] : [])),
  );
  return (documentRowsOf ?? []).filter(
    (r) => r.document && !used.has(sourceKey(r.document)),
  );
}

/** A document's row as a new row of the inputs (its own key; its document kept). */
export function rowOfDocument<T extends OtherIncome | Tradeline>(row: T): T {
  return { ...row, key: rowKey() };
}

export function addOtherIncomeRow(
  inputs: EligibilityInputs,
  row: OtherIncome,
): EligibilityInputs {
  if (inputs.profile.other_income.length >= MAX_OTHER_INCOME) return inputs;
  return setProfile(inputs, {
    other_income: [...inputs.profile.other_income, rowOfDocument(row)],
  });
}

export function addTradelineRow(
  inputs: EligibilityInputs,
  row: Tradeline,
): EligibilityInputs {
  if (inputs.cibil.tradelines.length >= MAX_TRADELINES) return inputs;
  return setCibil(inputs, {
    tradelines: [...inputs.cibil.tradelines, rowOfDocument(row)],
  });
}

/** The value of one field set (the documents' value for "Use" and the fill below). */
export function setFieldValue(
  inputs: EligibilityInputs,
  field: SourcedField,
  value: unknown,
): EligibilityInputs {
  if (field === 'loan_amount' || field === 'tenure_months') {
    const n = finite(value);
    return setLoan(
      inputs,
      field === 'loan_amount' ? { amount: n } : { tenure_months: n },
    );
  }
  if (field === 'score') return setCibil(inputs, { score: finite(value) });
  if (field === 'enquiries') {
    const e = obj(value);
    return setCibil(inputs, {
      enquiries: {
        d30: finite(e.d30),
        d60: finite(e.d60),
        d90: finite(e.d90),
        d120: finite(e.d120),
      },
    });
  }
  return setProfile(inputs, {
    [field]: field === 'net_income' ? finite(value) : value,
  } as Partial<EligibilityProfile>);
}

function blank(inputs: EligibilityInputs, field: SourcedField): boolean {
  if (field === 'enquiries') {
    // Taken whole: the windows add up only as the report gives them.
    return Object.values(inputs.cibil.enquiries).every((v) => !present(v));
  }
  return !present(fieldValue(inputs, field));
}

/** The fields that are empty and a document fills ("Fill from the documents"). */
export function fillableFields(
  inputs: EligibilityInputs,
  sources: FieldSources | null | undefined,
): SourcedField[] {
  return SOURCED_FIELDS.filter(
    (f) => present(sources?.[f]?.value) && blank(inputs, f),
  );
}

/**
 * Every empty field a document fills, filled; typed values are kept. The CIBIL
 * block becomes the credit report's once its score or enquiries come from it.
 */
export function fillFromDocuments(
  inputs: EligibilityInputs,
  sources: FieldSources | null | undefined,
): EligibilityInputs {
  let next = inputs;
  const fields = fillableFields(inputs, sources);
  for (const field of fields) {
    next = setFieldValue(next, field, sources?.[field]?.value);
  }
  const report = sources?.report;
  if (
    report &&
    (fields.includes('score') || fields.includes('enquiries')) &&
    (next.cibil.source ?? 'manual') === 'manual'
  ) {
    const date = typeof report.value === 'string' ? report.value : null;
    next = setCibil(next, {
      source: 'credit_report',
      ...(date ? { report_date: date } : {}),
    });
  }
  return next;
}

// "Still needed before Check eligibility", in the order of the sheet:
// app/routers/eligibility.py NEEDED_FIELDS (required: every lender's check needs it).
const NEEDED_FIELDS: readonly {
  field: string;
  required: boolean;
  tab: StillNeeded['tab'];
}[] = [
  { field: 'pan', required: false, tab: 'profile' },
  { field: 'name', required: false, tab: 'profile' },
  { field: 'mobile', required: false, tab: 'profile' },
  { field: 'dob', required: false, tab: 'profile' },
  { field: 'house_ownership', required: false, tab: 'profile' },
  { field: 'pincode', required: true, tab: 'profile' },
  { field: 'current_address', required: false, tab: 'profile' },
  { field: 'permanent_address', required: false, tab: 'profile' },
  { field: 'company', required: true, tab: 'profile' },
  { field: 'employment_type', required: true, tab: 'profile' },
  { field: 'net_income', required: true, tab: 'profile' },
  { field: 'loan_amount', required: false, tab: 'profile' },
  { field: 'tenure_months', required: false, tab: 'profile' },
  { field: 'score', required: true, tab: 'cibil' },
  { field: 'enquiries.d30', required: false, tab: 'cibil' },
  { field: 'enquiries.d60', required: false, tab: 'cibil' },
  { field: 'enquiries.d90', required: true, tab: 'cibil' },
  { field: 'enquiries.d120', required: false, tab: 'cibil' },
];

/**
 * The fields still empty (no document filled them and nobody typed them),
 * then the loans a lender cannot count yet (Obligate without an EMI, BT
 * without the outstanding); `fromDocuments` when a document holds a value.
 */
export function stillNeeded(
  inputs: EligibilityInputs,
  sources?: FieldSources | null,
  tab?: StillNeeded['tab'],
): StillNeeded[] {
  const out: StillNeeded[] = [];
  for (const { field, required, tab: on } of NEEDED_FIELDS) {
    if (tab && on !== tab) continue;
    const [name, window] = field.split('.') as [
      SourcedField,
      keyof CibilEnquiries | undefined,
    ];
    const value = fieldValue(inputs, name);
    const documented = sources?.[name]?.value;
    const held = window ? present(obj(value)[window]) : present(value);
    if (held) continue;
    out.push({
      field,
      required,
      tab: on,
      fromDocuments: window
        ? present(obj(documented)[window])
        : present(documented),
    });
  }
  if (tab === 'profile') return out;
  inputs.cibil.tradelines.forEach((row, i) => {
    if (row.status === 'closed') return;
    const key =
      row.action === 'obligate' && !present(row.emi)
        ? 'emi'
        : row.action === 'bt' && !present(row.outstanding)
          ? 'outstanding'
          : null;
    if (!key) return;
    out.push({
      field: `tradelines.${i + 1}.${key}`,
      required: true,
      tab: 'cibil',
      fromDocuments: present(obj(row.document?.value)[key]),
      loan: { number: i + 1, lender: row.lender, loanType: row.loan_type },
    });
  });
  return out;
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
      has_running_home_loan: p.has_running_home_loan ?? null,
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

/**
 * What a background check's answer depends on: the applicant, the request
 * body without the fields app/eligibility.py never reads (name, mobile, date
 * of birth, addresses, house ownership, the credit report's source and date),
 * so typing them does not check the banks again, and `policy`, a number the
 * panel moves on when the policy sheet or the company list changes (or on
 * Reload), so the same inputs are checked again then.
 */
export function precheckKey(
  applicant: string,
  inputs: EligibilityInputs,
  policy = 0,
): string {
  const { profile: p, cibil: c, loan } = inputsBody(inputs);
  return JSON.stringify({
    applicant,
    policy,
    // A full PAN finds the applicant's file check (verified salary, bank EMIs).
    pan: p.pan,
    pincode: p.pincode,
    company: p.company,
    employment_type: p.employment_type,
    net_income: p.net_income,
    other_income: p.other_income,
    has_running_home_loan: p.has_running_home_loan,
    score: c.score,
    enquiries: c.enquiries,
    tradelines: c.tradelines,
    loan,
  });
}

/**
 * The precheckKey of the inputs a result was calculated with, from its
 * inputsKey (the request body as JSON) and the policy number then; null
 * without one.
 */
export function precheckKeyOf(
  applicant: string,
  resultKey: string | null,
  policy = 0,
): string | null {
  if (!resultKey) return null;
  try {
    return precheckKey(
      applicant,
      JSON.parse(resultKey) as EligibilityInputs,
      policy,
    );
  } catch {
    return null;
  }
}

const MAX_ENQUIRIES = 999;
const MAX_INSTALMENTS = 600;
const MAX_TENURE_MONTHS = 480;

/** A date input's value the API takes: YYYY-MM-DD from 1900 to today. */
function pastDateLooksValid(value: string, now: Date): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    value >= '1900-01-01' &&
    !isFutureDate(value, now)
  );
}

function wholeIn(value: number | null | undefined, min: number, max: number) {
  return (
    value === null ||
    value === undefined ||
    (Number.isInteger(value) && value >= min && value <= max)
  );
}

/**
 * Why the inputs on screen cannot be checked in the background: 'invalid' (a
 * value the API refuses with 422, which the form marks in red), 'empty'
 * (nothing a bank checks is filled yet), else null.
 */
export function precheckBlock(
  inputs: EligibilityInputs,
  now: Date = new Date(),
): 'invalid' | 'empty' | null {
  const p = inputs.profile;
  const c = inputs.cibil;
  const invalid =
    countInvalidNumbers(inputs) > 0 ||
    (!!p.pan?.trim() && !panLooksValid(p.pan) && !isMaskedPan(p.pan)) ||
    (!!p.mobile?.trim() && !mobileLooksValid(p.mobile)) ||
    (!!p.pincode?.trim() && !pincodeLooksValid(p.pincode)) ||
    (!!p.dob && !pastDateLooksValid(p.dob, now)) ||
    (c.score !== null && !scoreLooksValid(c.score)) ||
    enquiriesOutOfOrder(c.enquiries) !== null ||
    !Object.values(c.enquiries).every((n) => wholeIn(n, 0, MAX_ENQUIRIES)) ||
    !wholeIn(inputs.loan.tenure_months, 1, MAX_TENURE_MONTHS) ||
    (!!c.report_date && !pastDateLooksValid(c.report_date, now)) ||
    c.tradelines.some(
      (row) =>
        (!!row.account_number?.trim() &&
          !accountNumberLooksValid(row.account_number)) ||
        (!!row.open_date && !pastDateLooksValid(row.open_date, now)) ||
        (!!row.last_payment_date &&
          !pastDateLooksValid(row.last_payment_date, now)) ||
        (!!row.open_date &&
          !!row.last_payment_date &&
          row.last_payment_date < row.open_date) ||
        !wholeIn(row.emis_paid, 0, MAX_INSTALMENTS) ||
        !wholeIn(row.emis_pending, 0, MAX_INSTALMENTS),
    );
  if (invalid) return 'invalid';
  const checked = [
    p.pincode,
    p.company,
    p.employment_type,
    p.net_income,
    c.score,
    ...Object.values(c.enquiries),
  ];
  return checked.some(present) ? null : 'empty';
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

/** CIBIL scores run from 300 to 900; -1 and 0 are the bureau's "no credit history". */
export function scoreLooksValid(score: number): boolean {
  return (
    Number.isInteger(score) &&
    (NO_HISTORY_SCORES.includes(score) || (score >= 300 && score <= 900))
  );
}

/** The scores a credit report gives an applicant with no credit history (new to credit). */
export const NO_HISTORY_SCORES = [-1, 0];

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

/** A processing fee policy {pct, min_amount?, max_amount?}; null without a pct. */
function processingFeePolicy(raw: unknown): ProcessingFeePolicy | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = obj(raw);
  const pct = finite(o.pct);
  if (pct === null) return null;
  return {
    pct,
    min_amount: finite(o.min_amount),
    max_amount: finite(o.max_amount),
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
    processing_fee: finite(o.processing_fee),
    processing_fee_policy: processingFeePolicy(o.processing_fee_policy),
    apr: finite(o.apr),
    total_interest: finite(o.total_interest),
    total_cost: finite(o.total_cost),
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
    policy_sheet: policySheet(o.policy_sheet),
  };
}

/** A lender row's `policy_sheet`; null when the sample policy priced it. */
function policySheet(raw: unknown): PolicySheetTerms | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = obj(raw);
  const label = text(o.label);
  if (!label) return null;
  return {
    label,
    bank: text(o.bank) ?? '',
    slab_start: finite(o.slab_start),
    category: text(o.category),
    company_unlisted: o.company_unlisted === true,
    lines: strings(o.lines),
    conditions: strings(o.conditions),
    hl_deviation: finite(o.hl_deviation),
    hl_deviation_applied: o.hl_deviation_applied === true,
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

function rows(raw: unknown): Record<string, unknown>[] {
  return Array.isArray(raw) ? raw.map(obj) : [];
}

/** The "Suggested banks" box; a malformed row is dropped. */
function suggestion(raw: unknown): EligibilitySuggestion {
  const o = obj(raw);
  const banks: SuggestedBank[] = [];
  for (const b of rows(o.banks)) {
    const lender = text(b.lender);
    const lenderId = text(b.lender_id);
    const amount = finite(b.eligible_amount);
    const roi = finite(b.roi);
    const emi = finite(b.emi);
    const tenure = finite(b.tenure_months);
    if (!lender || !lenderId || amount === null || roi === null) continue;
    if (emi === null || tenure === null) continue;
    banks.push({
      lender,
      lender_id: lenderId,
      eligible_amount: amount,
      roi,
      emi,
      tenure_months: tenure,
      covers_need: b.covers_need === true,
      why: text(b.why) ?? '',
    });
  }
  const declined: DeclinedBank[] = [];
  for (const d of rows(o.declined)) {
    const lender = text(d.lender);
    const lenderId = text(d.lender_id);
    if (!lender || !lenderId) continue;
    declined.push({
      lender,
      lender_id: lenderId,
      reason: text(d.reason) ?? '',
      not_offered: d.not_offered === true,
    });
  }
  return { need: finite(o.need), banks, declined };
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
  const check = obj(o.file_check);
  const fileCheck: EligibilityFileCheck | null =
    o.file_check && typeof o.file_check === 'object'
      ? {
          used: check.used === true,
          detail: text(check.detail),
          verdict: text(check.verdict),
          ready: bool(check.ready),
          issues: strings(check.issues),
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
    suggestion: suggestion(o.suggestion),
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
    file_ready: bool(o.file_ready),
    open_issues: finite(o.open_issues) ?? 0,
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
    processing_fee: processingFeePolicy(o.processing_fee),
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
      .map((row): PincodeLenderCheck | null => {
        const r = obj(row);
        const lender = text(r.lender);
        return lender
          ? {
              lender_id: text(r.lender_id) ?? lender,
              lender,
              serviceable: r.serviceable === true,
              source: checkSource(r.source),
            }
          : null;
      })
      .filter((r): r is PincodeLenderCheck => r !== null),
    sample: o.sample !== false,
  };
}

type PincodeLenderCheck = PincodeCheck['lenders'][number];

function checkSource(value: unknown): CheckSource {
  return value === 'dsa_list' ? 'dsa_list' : 'sample';
}

function foirRange(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [low, high] = value.map(finite);
  return low !== null && high !== null && low < high ? [low, high] : null;
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
          foir_range: foirRange(r.foir_range),
          source: checkSource(r.source),
        };
      })
      .filter((r): r is CompanyCategory => r !== null),
    suggestions: strings(o.suggestions),
    sample: o.sample !== false,
  };
}

// ------------------------------------------------------------------ before you check
// The panel checks the inputs on screen in the background (POST .../calculate
// with the inputs: calculated, never saved) and says what would stop a bank
// before Check eligibility is clicked. The reasons are app/eligibility.py's
// sentences; these helpers only sort them: the fields still empty, each with
// the banks it blocks, then the banks that will say no, one line per cause.

/** A form field a bank's refusal comes from. */
export type PrecheckField =
  | 'pincode'
  | 'company'
  | 'employment_type'
  | 'net_income'
  | 'score'
  | 'enquiries'
  | 'tradelines';

/** The tab each field is on. */
export const PRECHECK_FIELD_TAB: Record<PrecheckField, StillNeeded['tab']> = {
  pincode: 'profile',
  company: 'profile',
  employment_type: 'profile',
  net_income: 'profile',
  score: 'cibil',
  enquiries: 'cibil',
  tradelines: 'cibil',
};

/** app/eligibility.py NOT_IN_SHEET_LABEL: a sheet bank's rule its sheet does not give. */
const SAMPLE_MARK = 'Sample: not in your policy sheet';

/** How a refusal reads in "Banks that will say no". */
interface Cause {
  field: PrecheckField | null;
  /** The banks whose refusals have the same key share a line. */
  key: string;
  /** The line's words before and after the banks. */
  before: string;
  after: string;
  /** The bank's own number in the line, e.g. its minimum ("750"). */
  value: string | null;
  /** The sentence without its policy-sheet reference. */
  text: string;
}

type CauseRule = {
  pattern: RegExp;
  /** `mark`: " (Sample: not in your policy sheet)" or "". */
  read: (m: RegExpExecArray, mark: string) => Omit<Cause, 'text'>;
};

const enquiriesText = (n: string) =>
  `${n} ${n === '1' ? 'enquiry' : 'enquiries'}`;

// app/eligibility.py's refusals, matched on the fixed words of each sentence
// (its policy-sheet reference removed), never on a bank's name. A sample rule
// keeps its mark and never shares a line with a rule of the sheet.
const CAUSES: readonly CauseRule[] = [
  // _lender_result: "Pincode 401202 is not serviceable by Axis Bank"
  {
    pattern: /^Pincode (\S+) is not serviceable by .+$/,
    read: (m) => ({
      field: 'pincode',
      key: `pincode ${m[1]}`,
      before: `Pincode ${m[1]} is not serviceable by `,
      after: '',
      value: null,
    }),
  },
  // "Employment type Grade 4 is not accepted by HDFC Bank (Sample: ...)"
  {
    pattern: /^Employment type (.+) is not accepted by .+$/,
    read: (m, mark) => ({
      field: 'employment_type',
      key: `employment ${m[1]}${mark}`,
      before: `Employment type ${m[1]} is not accepted by `,
      after: mark,
      value: null,
    }),
  },
  // not_offered_reason: "HDFC Bank does not lend to CAT U (unlisted) companies"
  {
    pattern: /^.+? does not lend to (.+) companies$/,
    read: (m) => ({
      field: 'company',
      key: `category ${m[1]}`,
      before: `No loans to ${m[1]} companies at `,
      after: '',
      value: null,
    }),
  },
  // "'X' is not in Bajaj Finance's company list and Bajaj Finance does not accept unlisted companies"
  {
    pattern:
      /^'(.+)' is not in .+ company list and .+ does not accept unlisted companies$/,
    read: (m) => ({
      field: 'company',
      key: `unlisted ${m[1]}`,
      before: `'${m[1]}' is not in the company list of `,
      after: ': unlisted companies are not accepted',
      value: null,
    }),
  },
  // _sheet_terms: "HDFC Bank's policy sheet has no category for a company not in its list"
  {
    pattern:
      /^.+'s policy sheet has no category for a company not in its list$/,
    read: () => ({
      field: 'company',
      key: 'no unlisted category',
      before:
        'No category for a company not in the list in the policy sheet of ',
      after: '',
      value: null,
    }),
  },
  // _grid_foir: "HDFC Bank's FOIR grid has no FOIR for CAT C (it covers CAT A, CAT B)"
  {
    pattern: /^.+'s FOIR grid has no FOIR for (.+?) \(it covers .+\)$/,
    read: (m) => ({
      field: 'company',
      key: `grid ${m[1]}`,
      before: `No FOIR for ${m[1]} in the FOIR grid of `,
      after: '',
      value: null,
    }),
  },
  // _sheet_terms: "Not eligible: income ₹20,000 is below HDFC Bank's minimum ₹25,000"
  {
    pattern: /^(?:Not eligible: )?income (\S+) is below .+'s minimum (\S+)$/i,
    read: (m) => ({
      field: 'net_income',
      key: `income ${m[1]}`,
      before: `Income ${m[1]} is below the minimum at `,
      after: '',
      value: m[2],
    }),
  },
  // _grid_foir: "Net monthly salary ₹20,000 is below X's minimum income of ₹25,000 (the first slab ...)"
  {
    pattern:
      /^Net monthly salary (\S+) is below .+'s minimum income of (\S+?)(?: \(.+\))?$/,
    read: (m) => ({
      field: 'net_income',
      key: `income ${m[1]}`,
      before: `Income ${m[1]} is below the minimum at `,
      after: '',
      value: m[2],
    }),
  },
  // _cibil_check, the sheet's rule: "HDFC Bank needs CIBIL >= 710: the score is 690"
  {
    pattern: /^.+ needs CIBIL >= (-?\d+): the score is (-?\d+)$/,
    read: (m, mark) => ({
      field: 'score',
      key: `score ${m[2]}${mark}`,
      before: `CIBIL ${m[2]} is below the minimum at `,
      after: mark,
      value: m[1],
    }),
  },
  // The sample policy's: "CIBIL score 690 is below Bajaj Finance's minimum 700"
  {
    pattern: /^CIBIL score (-?\d+) is below .+'s minimum (-?\d+)$/,
    read: (m, mark) => ({
      field: 'score',
      key: `score ${m[1]}${mark}`,
      before: `CIBIL ${m[1]} is below the minimum at `,
      after: mark,
      value: m[2],
    }),
  },
  // "CIBIL -1: no credit history, and Tata Capital needs CIBIL >= 725"
  {
    pattern:
      /^CIBIL (-?\d+): no credit history, and .+ needs CIBIL >= (-?\d+)$/,
    read: (m, mark) => ({
      field: 'score',
      key: `no history ${m[1]}${mark}`,
      before: `No credit history (CIBIL ${m[1]}): below the minimum at `,
      after: mark,
      value: m[2],
    }),
  },
  // _sheet_enquiries and the sample limit: "6 enquiries in the last 60 days: more than HDFC Bank's limit of 5"
  {
    pattern:
      /^(\d+) enquir(?:y|ies) in the last (\d+) days: more than .+'s limit of (\d+)$/,
    read: (m, mark) => ({
      field: 'enquiries',
      key: `enquiries ${m[2]} ${m[1]}${mark}`,
      before: `${enquiriesText(m[1])} in the last ${m[2]} days: over the limit at `,
      after: mark,
      value: m[3],
    }),
  },
  // "10 enquiries in the last 120 days already: more than Indusind Bank's limit of 9 in 270 days"
  {
    pattern:
      /^(\d+) enquir(?:y|ies) in the last (\d+) days already: more than .+'s limit of (\d+) in (\d+) days$/,
    read: (m, mark) => ({
      field: 'enquiries',
      key: `enquiries already ${m[2]} ${m[1]}${mark}`,
      before: `${enquiriesText(m[1])} in the last ${m[2]} days already: over the limit at `,
      after: mark,
      value: `${m[3]} in ${m[4]} days`,
    }),
  },
  // "Existing obligations ₹59,000 leave no room within FOIR 60% of ₹60,000 (₹36,000)"
  {
    pattern:
      /^Existing obligations (\S+) leave no room within FOIR (\S+) of \S+ \(\S+\)$/,
    read: (m) => ({
      field: 'tradelines',
      key: `no room ${m[1]}`,
      before: `Existing obligations ${m[1]} leave no room within the FOIR at `,
      after: '',
      value: m[2],
    }),
  },
  // _bt_limits: "1 credit card marked BT: HDFC Bank does not take over credit cards"
  {
    pattern:
      /^(\d+ credit cards?) marked BT: .+ does not take over credit cards$/,
    read: (m) => ({
      field: 'tradelines',
      key: `bt cards ${m[1]}`,
      before: `${m[1]} marked BT: credit cards are not taken over by `,
      after: '',
      value: null,
    }),
  },
  // "3 personal loans marked BT: HDFC Bank takes over at most 2 personal loans"
  {
    pattern:
      /^(\d+ (?:personal loans?|credit cards?)) marked BT: .+ takes over at most (\d+) \D+$/,
    read: (m) => ({
      field: 'tradelines',
      key: `bt most ${m[1]}`,
      before: `${m[1]} marked BT: over the limit at `,
      after: '',
      value: m[2],
    }),
  },
  // "Eligible amount ₹2,00,000 does not cover the balance transfer of ₹3,00,000"
  {
    pattern:
      /^Eligible amount (\S+) does not cover the balance transfer of (\S+)$/,
    read: (m) => ({
      field: 'tradelines',
      key: `bt cover ${m[2]}`,
      before: `The eligible amount does not cover the balance transfer of ${m[2]} at `,
      after: '',
      value: m[1],
    }),
  },
  // "Eligible amount ₹40,000 is below HDFC Bank's minimum loan ₹50,000": no single field.
  {
    pattern: /^Eligible amount (\S+) is below .+'s minimum loan (\S+)$/,
    read: (m, mark) => ({
      field: null,
      key: `minimum loan${mark}`,
      before: 'The eligible amount is below the minimum loan at ',
      after: mark,
      value: `${m[1]}, minimum ${m[2]}`,
    }),
  },
  // _sheet_terms: "HDFC Bank's policy sheet has no ROI for slab 25,000, CAT_B": the sheet's.
  {
    pattern: /^.+'s policy sheet has no (.+) for slab (\S+), (\S+)$/,
    read: (m) => ({
      field: null,
      key: `sheet ${m[1]} ${m[2]} ${m[3]}`,
      before: `The policy sheet has no ${m[1]} for slab ${m[2]}, ${m[3]} at `,
      after: '',
      value: null,
    }),
  },
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A trailing "(...)" of a sentence (nested parentheses kept together), else null. */
function trailingParenthesis(text: string): number | null {
  if (!text.endsWith(')')) return null;
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (text[i] === ')') depth += 1;
    else if (text[i] === '(') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return null;
}

/**
 * "(Sheet2, HDFC Bank, Cibil Score "710", cell B2)", "(From Policy (your sheet))".
 * Not "(Sample: not in your policy sheet)": that says the rule is the sample
 * policy's, not the sheet's, and stays.
 */
function isPolicyReference(inner: string, banks: readonly string[]): boolean {
  return (
    /\bcell [A-Z]{1,3}\d+\b/.test(inner) ||
    /\bis NA\b/.test(inner) ||
    /^From Policy\b/.test(inner) ||
    banks.some((bank) => inner.toLowerCase().includes(bank.toLowerCase()))
  );
}

function bankNames(banks: readonly (string | null | undefined)[]): string[] {
  return [
    ...new Set(
      banks.filter((b): b is string => !!b?.trim()).map((b) => b.trim()),
    ),
  ].sort((a, b) => b.length - a.length);
}

/** The sentence without its policy-sheet references, and its sample mark (" (Sample: ...)" or ""). */
function withoutReferences(
  reason: string,
  names: readonly string[],
): { text: string; mark: string } {
  let text = reason.trim();
  let mark = '';
  for (;;) {
    const open = trailingParenthesis(text);
    if (open === null) break;
    const inner = text.slice(open + 1, -1);
    if (inner === SAMPLE_MARK) mark = ` (${SAMPLE_MARK})`;
    else if (!isPolicyReference(inner, names)) break;
    text = text.slice(0, open).trimEnd();
  }
  return { text, mark };
}

/**
 * A refusal as one line of a bank list ("HDFC Bank, Bandhan Bank: ..."):
 * the backend's sentence without its policy-sheet reference (Details on the
 * Lenders tab keeps it) and without the bank's own name, so that the banks
 * refusing for the same reason share one line. "HDFC Bank needs CIBIL >= 710:
 * the score is 690 (Sheet2, ...)" -> "Needs CIBIL >= 710: the score is 690".
 * A sample rule keeps its "(Sample: not in your policy sheet)", so it never
 * reads as the sheet's nor shares a line with a bank that has no such mark.
 */
export function reasonWithoutBank(
  reason: string,
  banks: readonly (string | null | undefined)[],
): string {
  const names = bankNames(banks);
  const { text: plain, mark } = withoutReferences(
    reason.trim().replace(/^Not eligible: /, ''),
    names,
  );
  let text = plain;
  for (const bank of names) {
    const name = escapeRegExp(bank);
    const end = '(?![\\w])';
    text = text
      .replace(new RegExp(`^${name}'s `, 'i'), "the bank's ")
      .replace(new RegExp(`^${name}${end}\\s*`, 'i'), '')
      .replace(new RegExp(` by ${name}${end}`, 'gi'), '')
      .replace(new RegExp(`${name}'s${end}`, 'gi'), "the bank's")
      .replace(new RegExp(`${name}${end}`, 'gi'), 'the bank');
  }
  text = `${text.trim()}${mark}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** How a refusal reads in "Banks that will say no" (a sentence no rule knows: the bank, then the sentence). */
function causeOf(
  reason: string,
  banks: readonly (string | null | undefined)[],
): Cause {
  const names = bankNames(banks);
  const { text, mark } = withoutReferences(reason, names);
  for (const { pattern, read } of CAUSES) {
    const m = pattern.exec(text);
    if (m) return { ...read(m, mark), text };
  }
  const plain = reasonWithoutBank(reason, names);
  return {
    field: null,
    key: `text ${plain}`,
    before: '',
    after: `: ${plain}`,
    value: null,
    text,
  };
}

/** The field a bank's refusal comes from; null when no field is its cause. */
export function reasonField(reason: string): PrecheckField | null {
  return causeOf(reason, []).field;
}

// The refusals that only say a field is empty: "Still needed" lists those.
const MISSING_REASONS: readonly (readonly [RegExp, PrecheckField])[] = [
  [/^Pincode not entered\b/, 'pincode'],
  [/^Employment type not entered$/, 'employment_type'],
  [/^Company not entered\b/, 'company'],
  [/^CIBIL score not entered$/, 'score'],
  [/^Enquiries in the last \d+ days not entered$/, 'enquiries'],
  [/^Net monthly income not entered$/, 'net_income'],
  [/^EMI not entered for Tradeline \d+\b.* marked Obligate\b/, 'tradelines'],
  // A loan marked BT, and a gold loan its bank counts by the outstanding.
  [/^Outstanding not entered for Tradeline \d+\b/, 'tradelines'],
];

/**
 * A refusal that only says a field is empty ("CIBIL score not entered"): the
 * still-needed field it is, e.g. "score", "enquiries", "tradelines.2.emi"
 * (a field's prefix where the sentence names no window); else null.
 */
export function missingReasonField(reason: string): string | null {
  const field = MISSING_REASONS.find(([pattern]) => pattern.test(reason))?.[1];
  if (!field) return null;
  if (field !== 'tradelines') return field;
  const loan = /^(EMI|Outstanding) not entered for Tradeline (\d+)\b/.exec(
    reason,
  );
  return loan
    ? `tradelines.${loan[2]}.${loan[1] === 'EMI' ? 'emi' : 'outstanding'}`
    : field;
}

/**
 * Refused because no company is entered: the policy sheet then prices its
 * unlisted category (CAT U) by default, so its "does not lend to CAT U" (or
 * no value for CAT_U) is the empty company's, not the bank's answer.
 */
function byEmptyCompany(cause: Cause): boolean {
  return cause.field === 'company' || / for slab \S+, CAT_U$/.test(cause.text);
}

/** A bank in a line of "Banks that will say no", with its own number (its minimum, its limit...). */
export interface RefusingBank {
  name: string;
  value: string | null;
}

/** One line of "Banks that will say no": a cause and the banks that give it. */
export interface BankRefusal {
  /** The line as read, e.g. "CIBIL 690 is below the minimum at Axis Bank (750), Tata Capital (725)". */
  text: string;
  /** The words before and after the banks (text = before, the banks, after). */
  before: string;
  after: string;
  /** The banks, in the result's order, each with its own number. */
  banks: RefusingBank[];
  /** The banks' names. */
  lenders: string[];
  /** The backend's sentences, one per bank (shown on hover). */
  sentences: string[];
  /** The field it comes from; null: the Lenders tab's (no single field). */
  field: PrecheckField | null;
}

/** A field still empty that a bank needs, and what it blocks in the latest answer. */
export interface NeededField extends StillNeeded {
  /** The banks that ask for it; null: no answer yet. */
  banks: string[] | null;
  /** Of those, the banks nothing else stops: it is all they still need. */
  only: string[];
}

/** The most useful next step: the fewest empty fields that let the most banks lend. */
export interface PrecheckNextStep {
  /** The fields to fill (ids of `needed`), in its order. */
  fields: string[];
  /** The banks that need only those fields. */
  banks: string[];
}

export interface PrecheckOptions {
  /**
   * The inputs on screen. An empty field the answer names but the list of
   * still-needed fields does not (a gold loan's outstanding) is added while
   * it is empty here; one filled since (an answer for other inputs) is not.
   */
  inputs?: EligibilityInputs;
  /** A field being typed in: its refusals are not shown yet. */
  held?: PrecheckField | null;
}

/** Whether a field (a still-needed field's id) is empty in the inputs. */
function fieldEmpty(inputs: EligibilityInputs, field: string): boolean {
  const [head, n, key] = field.split('.');
  if (head === 'tradelines') {
    const row = inputs.cibil.tradelines[Number(n) - 1];
    return !!row && !present(key === 'emi' ? row.emi : row.outstanding);
  }
  if (head === 'enquiries') {
    const windows = inputs.cibil.enquiries;
    return n
      ? !present(windows[n as keyof CibilEnquiries])
      : !Object.values(windows).some(present);
  }
  return !present(fieldValue(inputs, head as SourcedField));
}

/** A still-needed field the list did not have (the answer names it). */
function answerNeeds(field: string, inputs?: EligibilityInputs): StillNeeded {
  const [head, n, key] = field.split('.');
  if (head === 'tradelines' && n && key) {
    const row = inputs?.cibil.tradelines[Number(n) - 1];
    return {
      field,
      required: true,
      tab: 'cibil',
      fromDocuments: present(obj(row?.document?.value)[key]),
      loan: {
        number: Number(n),
        lender: row?.lender ?? null,
        loanType: row?.loan_type ?? null,
      },
    };
  }
  return {
    field,
    required: true,
    tab: PRECHECK_FIELD_TAB[head as PrecheckField] ?? 'profile',
    fromDocuments: false,
  };
}

interface SortedReasons {
  needed: NeededField[];
  next: PrecheckNextStep | null;
  refusals: BankRefusal[];
  held: number;
}

/**
 * The reasons of every bank that is not eligible or does not serve the
 * pincode, sorted: a reason that says a field is empty (or comes from an
 * empty company) goes to that still-needed field, the others to one line per
 * cause, the line of most banks first.
 */
function sortReasons(
  result: EligibilityResult | null,
  needed: readonly StillNeeded[],
  { inputs, held = null }: PrecheckOptions,
): SortedReasons {
  const items: NeededField[] = needed
    .filter((item) => item.required)
    .map((item) => ({ ...item, banks: result ? [] : null, only: [] }));
  const itemFor = (field: string): NeededField | null => {
    const listed = items.find(
      (i) => i.field === field || i.field.startsWith(`${field}.`),
    );
    if (listed) return listed;
    if (inputs && !fieldEmpty(inputs, field)) return null;
    const item: NeededField = {
      ...answerNeeds(field, inputs),
      banks: [],
      only: [],
    };
    items.push(item);
    return item;
  };
  const lines = new Map<string, BankRefusal>();
  const heldKeys = new Set<string>();
  const steps = new Map<string, PrecheckNextStep>();

  for (const row of result?.per_lender ?? []) {
    const tone = lenderTone(row.status);
    if (tone !== 'notEligible' && tone !== 'notServiceable') continue;
    const names = [row.lender, row.policy_sheet?.bank];
    const noCompany = row.reasons.some(
      (r) => missingReasonField(r) === 'company',
    );
    const missing = new Set<NeededField>();
    let refused = false;
    for (const reason of row.reasons) {
      const cause = causeOf(reason, names);
      const empty =
        missingReasonField(reason) ??
        (noCompany && byEmptyCompany(cause) ? 'company' : null);
      if (empty) {
        // Not needed any more: an answer for other inputs.
        const item = itemFor(empty);
        if (item) missing.add(item);
        continue;
      }
      refused = true;
      if (held && cause.field === held) {
        heldKeys.add(cause.key);
        continue;
      }
      const line = lines.get(cause.key) ?? {
        text: '',
        before: cause.before,
        after: cause.after,
        banks: [],
        lenders: [],
        sentences: [],
        field: cause.field,
      };
      if (!line.lenders.includes(row.lender)) {
        line.lenders.push(row.lender);
        line.banks.push({ name: row.lender, value: cause.value });
      }
      if (!line.sentences.includes(reason)) line.sentences.push(reason);
      lines.set(cause.key, line);
    }
    for (const item of missing) item.banks?.push(row.lender);
    // Nothing but empty fields stops this bank: what it needs is the next step.
    if (refused || missing.size === 0) continue;
    if (missing.size === 1) {
      for (const item of missing) item.only.push(row.lender);
    }
    const fields = items.filter((i) => missing.has(i)).map((i) => i.field);
    const key = fields.join(' ');
    const step = steps.get(key) ?? { fields, banks: [] };
    step.banks.push(row.lender);
    steps.set(key, step);
  }

  const order = (field: string) => items.findIndex((i) => i.field === field);
  const next =
    [...steps.values()].sort(
      (a, b) =>
        a.fields.length - b.fields.length ||
        b.banks.length - a.banks.length ||
        order(a.fields[0]) - order(b.fields[0]),
    )[0] ?? null;
  const refusals = [...lines.values()]
    .map((line) => ({
      ...line,
      text: `${line.before}${line.banks
        .map((b) => (b.value === null ? b.name : `${b.name} (${b.value})`))
        .join(', ')}${line.after}`,
    }))
    .sort((a, b) => b.banks.length - a.banks.length);
  return { needed: items, next, refusals, held: heldKeys.size };
}

/**
 * "Banks that will say no": the reasons of every bank that is not eligible or
 * does not serve the pincode, the same cause of several banks on one line
 * (each bank with its own number), the line of most banks first. A reason
 * that only says a field is empty, or comes from an empty company, is left to
 * "Still needed".
 */
export function bankRefusals(
  result: EligibilityResult | null,
  needed: readonly StillNeeded[],
  options: PrecheckOptions = {},
): BankRefusal[] {
  return sortReasons(result, needed, options).refusals;
}

/** The refusals by the field they come from (the hints under the fields). */
export function refusalsByField(
  refusals: readonly BankRefusal[],
): Partial<Record<PrecheckField, BankRefusal[]>> {
  const out: Partial<Record<PrecheckField, BankRefusal[]>> = {};
  for (const refusal of refusals) {
    if (refusal.field) (out[refusal.field] ??= []).push(refusal);
  }
  return out;
}

// Notes of the calculation a lender would stop at: an overdue or a written-off
// loan, and a bank-statement EMI that matches no loan of the form.
const WARNING_NOTES = [/lenders usually decline/, /matches no tradeline/];

/** What the "Before you check" box shows. */
export interface PrecheckSummary {
  /** The fields still empty that a bank needs, on every tab, with what each blocks. */
  needed: NeededField[];
  /** The most useful next step; null: no bank waits for empty fields alone. */
  next: PrecheckNextStep | null;
  /** "Banks that will say no", one line per cause. */
  refusals: BankRefusal[];
  /** Lines not shown yet: the field they come from is being typed in. */
  held: number;
  /** The file check's open issues when it finds the file NOT READY. */
  fileIssues: string[];
  /** Notes a lender would stop at (overdues, bank EMIs that match no loan). */
  warnings: string[];
  /** The policy sheet's "Conditions to confirm" of the banks that can lend. */
  conditions: number;
  /** The banks those conditions are from. */
  conditionBanks: string[];
  /** Banks that can lend, of all banks; null without a result. */
  eligible: number | null;
  total: number | null;
}

/** The "Before you check" box of the inputs on screen and their latest result. */
export function precheckSummary(
  result: EligibilityResult | null,
  needed: readonly StillNeeded[],
  options: PrecheckOptions = {},
): PrecheckSummary {
  const sorted = sortReasons(result, needed, options);
  const check = result?.file_check;
  const lending = (result?.per_lender ?? []).filter(
    (row) => lenderTone(row.status) === 'eligible',
  );
  const withConditions = lending.filter(
    (row) => (row.policy_sheet?.conditions.length ?? 0) > 0,
  );
  return {
    ...sorted,
    fileIssues: check?.used && check.ready === false ? check.issues : [],
    warnings: [
      ...new Set(
        (result?.notes ?? []).filter((note) =>
          WARNING_NOTES.some((pattern) => pattern.test(note)),
        ),
      ),
    ],
    conditions: withConditions.reduce(
      (n, row) => n + (row.policy_sheet?.conditions.length ?? 0),
      0,
    ),
    conditionBanks: withConditions.map((row) => row.lender),
    eligible: result ? lending.length : null,
    total: result ? result.per_lender.length : null,
  };
}

/** Nothing in the box stops a bank: no field needed, no refusal (shown or not yet), no open issue or warning. */
export function precheckClear(summary: PrecheckSummary): boolean {
  return (
    summary.needed.length === 0 &&
    summary.refusals.length === 0 &&
    summary.held === 0 &&
    summary.fileIssues.length === 0 &&
    summary.warnings.length === 0
  );
}

/**
 * The open items of each tab (its badge): the fields still needed there and
 * the refusals its fields cause (the warnings are about the loans, on the
 * CIBIL tab); a refusal no field causes counts on the Lenders tab.
 */
export function precheckTabCounts(
  summary: PrecheckSummary,
): Record<StillNeeded['tab'] | 'lenders', number> {
  const counts = { profile: 0, cibil: 0, lenders: 0 };
  for (const item of summary.needed) counts[item.tab] += 1;
  for (const refusal of summary.refusals) {
    counts[refusal.field ? PRECHECK_FIELD_TAB[refusal.field] : 'lenders'] += 1;
  }
  counts.cibil += summary.warnings.length;
  return counts;
}

/**
 * The id of a field's control (ProfileSection and CibilSection build theirs
 * from the same prefix): "pincode", "score", "enquiries.d90",
 * "tradelines.2.emi"; "enquiries" is its first window and "tradelines" the
 * loans' section.
 */
export function fieldElementId(prefix: string, field: string): string {
  const [head, n, key] = field.split('.');
  if (head === 'enquiries') return `${prefix}-enquiries-${n ?? 'd30'}`;
  if (head === 'tradelines') {
    return n && key ? `${prefix}-loan-${n}-${key}` : `${prefix}-tradelines`;
  }
  return `${prefix}-${head}`;
}
