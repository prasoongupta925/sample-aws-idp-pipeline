// Mirrors the pydantic models of packages/backend/app/routers/file_check.py
// (GET /projects/{project_id}/checklists, POST /projects/{project_id}/file-check),
// which return the deterministic engine's output
// (packages/lambda/file-check-mcp/engine.py). The UI only renders these values:
// the verdict is decided by the engine.
//
// GET uses response_model_exclude_none (unset fields are absent); POST
// serializes unset optional fields as null. Hence `?: T | null`.

/**
 * The backend currently returns READY or NOT READY; NEEDS REVIEW is rendered
 * (amber) if the API ever returns it.
 */
export type FileCheckVerdict = 'READY' | 'NOT READY' | 'NEEDS REVIEW';

// ------------------------------------------------------------------ checklists

export interface ChecklistRule {
  kind: 'present' | 'monthly' | 'period' | 'manual';
  months?: number | null;
  field?: string | null;
  from_field?: string | null;
  to_field?: string | null;
  min_count?: number | null;
}

export interface ChecklistItem {
  id: string;
  label: string;
  required: boolean;
  doc_types: string[];
  rule: ChecklistRule;
}

export interface Checklist {
  id: string;
  name: string;
  product?: string | null;
  applicant_type?: string | null;
  description?: string | null;
  items: ChecklistItem[];
  consistency_checks: string[];
  /** The checklist's indicative FOIR policy, if any (value, hard_limit, basis, source). */
  foir?: Record<string, unknown> | null;
}

export interface ChecklistCatalog {
  default_checklist: string;
  checklists: Checklist[];
}

/** What the checklist dropdown needs from a Checklist. */
export type FileCheckChecklistSummary = Pick<
  Checklist,
  'id' | 'name' | 'product' | 'applicant_type' | 'description'
>;

// ------------------------------------------------------------------ file check

export interface FileCheckRequest {
  /** ^[a-z0-9_]+$, max 64; default: the catalog's default_checklist. */
  checklist_id?: string;
  /** Full name or PAN, 1..200 characters; default: every applicant. */
  applicant?: string;
  /** YYYY-MM the "last N months" rules end at. */
  reference_month?: string;
}

export interface ChecklistRef {
  id: string;
  name?: string | null;
}

export interface ApplicantDocument {
  document_id?: string | null;
  document_name: string;
  /** loan_application, identity_details, salary_slip, bank_statement, form16_itr or other */
  doc_type: string;
  grounded?: boolean | null;
  grounding_notes: string[];
  unverified_fields: string[];
}

export interface ChecklistItemResult {
  item_id: string;
  item: string;
  required: boolean;
  status: 'PRESENT' | 'MISSING' | 'REVIEW';
  /** null for REVIEW (manual) items */
  ok: boolean | null;
  /** Human-readable finding citing document names and months. */
  detail: string;
  documents: string[];
  /** monthly / period items: YYYY-MM needed */
  required_months?: string[] | null;
  /** monthly / period items: YYYY-MM missing */
  missing_months?: string[] | null;
}

export interface ConsistencyResult {
  check_id: string;
  check: string;
  /**
   * MISMATCH makes the verdict NOT READY; REVIEW is a finding a person must
   * look at (listed in needs_review) that does not change the verdict.
   */
  status: 'OK' | 'MISMATCH' | 'REVIEW' | 'N/A' | 'INFO';
  detail: string;
  documents: string[];
}

export interface BankCredit {
  document_name: string;
  date?: string | null;
  amount: number;
}

export interface IncomeSummary {
  declared_net?: number | null;
  slip_net?: number | null;
  slip_gross?: number | null;
  bank_salary_credit?: number | null;
  form16_gross?: number | null;
  slip_gross_x12?: number | null;
  bank_credits: BankCredit[];
}

export interface ApplicantResult {
  applicant: string;
  pan?: string | null;
  verdict: FileCheckVerdict;
  reference_month?: string | null;
  reference_month_label?: string | null;
  documents: ApplicantDocument[];
  checklist: ChecklistItemResult[];
  consistency: ConsistencyResult[];
  income: IncomeSummary;
  /** Every reason for NOT READY, in order (MISSING / MISMATCH / REVIEW / PENDING). */
  reasons: string[];
  missing_items: string[];
  mismatches: string[];
  /**
   * Consistency findings with status REVIEW ('check: detail'); reported, the
   * verdict is unchanged. Absent from backends older than the obligations checks.
   */
  needs_review?: string[];
  /** Items a person must verify (not decided by the rules). */
  manual_review: string[];
  /** Existing obligations from the bank statement and the application, if computed. */
  obligations?: Record<string, unknown> | null;
  /** Indicative FOIR, if the checklist enables it; the lender's policy decides. */
  foir?: FileCheckFoir | null;
}

/**
 * The engine's indicative FOIR block (router type: dict[str, Any]). Only the
 * fields the panel shows are listed; each is checked before use.
 */
export interface FileCheckFoir {
  /** "indicative — the lender's policy decides" */
  label?: string | null;
  foir_limit_pct?: number | null;
  hard_limit?: boolean | null;
  net_monthly_income?: number | null;
  income_source?: string | null;
  income_verified?: boolean | null;
  existing_emis?: number | null;
  existing_emis_basis?: string | null;
  existing_emi_ratio_pct?: number | null;
  max_new_emi?: number | null;
  within_limit?: boolean | null;
  status?: string | null;
  detail?: string | null;
  [key: string]: unknown;
}

export interface PendingDocument {
  document_id?: string | null;
  document_name?: string | null;
  status?: string | null;
}

export interface FailedDocument {
  document_id?: string | null;
  document_name?: string | null;
}

export interface NoFactsDocument {
  document_id?: string | null;
  document_name?: string | null;
  reason: string;
}

export interface UnsupportedDocument {
  document_id?: string | null;
  document_name?: string | null;
  file_type?: string | null;
  reason: string;
}

export interface UnassignedDocument {
  document_id?: string | null;
  document_name?: string | null;
  doc_type: string;
}

/** Any project document the engine did not evaluate. */
export type FileCheckSkippedDocument = PendingDocument &
  Partial<NoFactsDocument & UnsupportedDocument & UnassignedDocument>;

export interface FileCheckResult {
  project_id?: string | null;
  engine_version: string;
  /** YYYY-MM-DD */
  as_of: string;
  checklist: ChecklistRef;
  overall_verdict: FileCheckVerdict;
  summary: string;
  applicants: ApplicantResult[];
  pending_documents: PendingDocument[];
  failed_documents: FailedDocument[];
  no_facts_documents: NoFactsDocument[];
  unsupported_documents: UnsupportedDocument[];
  unassigned_documents: UnassignedDocument[];
}

// Names used by the panel components.
export type FileCheckApplicant = ApplicantResult;
export type FileCheckItemRow = ChecklistItemResult;
export type FileCheckConsistencyRow = ConsistencyResult;
export type FileCheckIncome = IncomeSummary;
