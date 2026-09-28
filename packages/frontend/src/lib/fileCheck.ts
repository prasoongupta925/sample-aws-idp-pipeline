// Display helpers for the File Check panel. Nothing here decides a verdict:
// statuses and verdicts are mapped to colours / icons / CSV cells only.
import type {
  FileCheckChecklistSummary,
  FileCheckResult,
  FileCheckSkippedDocument,
} from '../types/fileCheck';

/** Plan B's salaried personal-loan checklist (the engine's shipped default). */
export const SALARIED_PERSONAL_LOAN_ID = 'salaried_personal_loan';

export type VerdictTone = 'ready' | 'notReady' | 'review' | 'unknown';
export type StatusTone = 'ok' | 'bad' | 'review' | 'info' | 'muted';

/** 'not_ready' / 'Needs-Review' -> 'NOT READY' / 'NEEDS REVIEW'. */
export function normalizeStatus(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

const REVIEW_STATUSES = new Set([
  'REVIEW',
  'NEEDS REVIEW',
  'MANUAL',
  'MANUAL REVIEW',
]);

export function verdictTone(verdict: unknown): VerdictTone {
  const v = normalizeStatus(verdict);
  if (v === 'READY') return 'ready';
  if (v === 'NOT READY') return 'notReady';
  if (REVIEW_STATUSES.has(v)) return 'review';
  return 'unknown';
}

/** Checklist item status (PRESENT / MISSING / REVIEW) -> tone. */
export function itemTone(status: unknown, required = true): StatusTone {
  const s = normalizeStatus(status);
  if (s === 'PRESENT' || s === 'OK') return 'ok';
  if (REVIEW_STATUSES.has(s)) return 'review';
  if (s === 'MISSING') return required ? 'bad' : 'muted';
  return 'info';
}

/** Consistency status (OK / MISMATCH / INFO / N/A) -> tone. */
export function consistencyTone(status: unknown): StatusTone {
  const s = normalizeStatus(status);
  if (s === 'OK') return 'ok';
  if (s === 'MISMATCH') return 'bad';
  if (REVIEW_STATUSES.has(s)) return 'review';
  if (s === 'N/A' || s === 'NA') return 'muted';
  return 'info';
}

/** Engine reason lines start with 'MISSING –', 'MISMATCH –', 'REVIEW –', 'PENDING –'. */
export function reasonTone(reason: string): StatusTone {
  const head = normalizeStatus(reason.split(/\s[–—-]\s|:/)[0]);
  if (head === 'MISSING' || head === 'MISMATCH') return 'bad';
  if (REVIEW_STATUSES.has(head)) return 'review';
  return 'info';
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toSummary(value: unknown): FileCheckChecklistSummary | null {
  if (typeof value === 'string') {
    return str(value) ? { id: value.trim(), name: value.trim() } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const id = str(o.id) ?? str(o.checklist_id);
  if (!id) return null;
  return {
    id,
    name: str(o.name) ?? str(o.label) ?? id,
    product: str(o.product),
    applicant_type: str(o.applicant_type),
    description: str(o.description),
  };
}

/**
 * Accepts either a bare list of checklists or the engine's list_checklists
 * object ({default_checklist, checklists}) or an {items} wrapper.
 */
export function normalizeChecklists(raw: unknown): {
  checklists: FileCheckChecklistSummary[];
  defaultId: string | null;
} {
  let list: unknown[] = [];
  let defaultId: string | null = null;
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.checklists)) list = o.checklists;
    else if (Array.isArray(o.items)) list = o.items;
    defaultId = str(o.default_checklist) ?? str(o.default_checklist_id);
  }
  const seen = new Set<string>();
  const checklists: FileCheckChecklistSummary[] = [];
  for (const entry of list) {
    const summary = toSummary(entry);
    if (summary && !seen.has(summary.id)) {
      seen.add(summary.id);
      checklists.push(summary);
    }
  }
  if (defaultId && !seen.has(defaultId)) defaultId = null;
  return { checklists, defaultId };
}

/**
 * The checklist the panel selects first: the API's default (the deployment's
 * configured default), else the salaried personal-loan checklist, else the
 * first salaried personal-loan product, else the first checklist.
 */
export function pickDefaultChecklistId(
  checklists: FileCheckChecklistSummary[],
  apiDefault?: string | null,
): string {
  if (apiDefault && checklists.some((c) => c.id === apiDefault)) {
    return apiDefault;
  }
  const byId = checklists.find((c) => c.id === SALARIED_PERSONAL_LOAN_ID);
  if (byId) return byId.id;
  const byProduct = checklists.find(
    (c) => c.product === 'personal_loan' && c.applicant_type === 'salaried',
  );
  return byProduct?.id ?? checklists[0]?.id ?? '';
}

const MONTH_ABBR = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** '2026-07' -> 'Jul 2026' (the engine's month wording). */
export function formatYearMonth(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym.trim());
  if (!m) return ym;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? `${MONTH_ABBR[month - 1]} ${m[1]}` : ym;
}

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

/** 600000 -> '₹6,00,000' (Indian digit grouping); null -> '–'. */
export function formatInr(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? INR.format(value)
    : '–';
}

// ------------------------------------------------------------------ CSV

export type FindingSection = 'Checklist' | 'Consistency' | 'Not checked';

export interface FileCheckFinding {
  applicant: string;
  verdict: string;
  checklist: string;
  section: FindingSection;
  item: string;
  status: string;
  detail: string;
  documents: string[];
}

export const CSV_HEADERS = [
  'Applicant',
  'Verdict',
  'Checklist',
  'Section',
  'Item',
  'Status',
  'Detail',
  'Documents',
] as const;

const SKIPPED_GROUPS: {
  key:
    | 'pending_documents'
    | 'failed_documents'
    | 'no_facts_documents'
    | 'unsupported_documents'
    | 'unassigned_documents';
  status: string;
}[] = [
  { key: 'pending_documents', status: 'PENDING' },
  { key: 'failed_documents', status: 'FAILED' },
  { key: 'no_facts_documents', status: 'NO FACTS' },
  { key: 'unsupported_documents', status: 'UNSUPPORTED' },
  { key: 'unassigned_documents', status: 'UNASSIGNED' },
];

export interface SkippedDocumentRow {
  status: string;
  document: FileCheckSkippedDocument;
}

/** Project documents the engine did not evaluate, in a fixed order. */
export function skippedDocuments(
  result: FileCheckResult,
): SkippedDocumentRow[] {
  return SKIPPED_GROUPS.flatMap(({ key, status }) =>
    (result[key] ?? []).map((document) => ({ status, document })),
  );
}

function skippedDetail({ status, document }: SkippedDocumentRow): string {
  if (document.reason) return document.reason;
  if (status === 'PENDING') {
    return `still being analysed${document.status ? ` (${document.status})` : ''}`;
  }
  if (status === 'FAILED') return 'document analysis failed';
  if (status === 'UNASSIGNED') {
    return `could not be matched to an applicant${document.doc_type ? ` (${document.doc_type})` : ''}`;
  }
  return '';
}

/** One finding per checklist item, consistency check and unchecked document. */
export function fileCheckFindings(result: FileCheckResult): FileCheckFinding[] {
  const checklist = result.checklist?.name || result.checklist?.id || '';
  const findings: FileCheckFinding[] = [];
  for (const a of result.applicants ?? []) {
    for (const row of a.checklist ?? []) {
      findings.push({
        applicant: a.applicant,
        verdict: a.verdict,
        checklist,
        section: 'Checklist',
        item: row.required === false ? `${row.item} (optional)` : row.item,
        status: row.status,
        detail: row.detail,
        documents: row.documents ?? [],
      });
    }
    for (const row of a.consistency ?? []) {
      findings.push({
        applicant: a.applicant,
        verdict: a.verdict,
        checklist,
        section: 'Consistency',
        item: row.check,
        status: row.status,
        detail: row.detail,
        documents: row.documents ?? [],
      });
    }
  }
  for (const skipped of skippedDocuments(result)) {
    const name =
      skipped.document.document_name || skipped.document.document_id || '';
    findings.push({
      applicant: '',
      verdict: '',
      checklist,
      section: 'Not checked',
      item: name,
      status: skipped.status,
      detail: skippedDetail(skipped),
      documents: name ? [name] : [],
    });
  }
  return findings;
}

/**
 * One CSV cell: RFC 4180 quoting, plus a leading apostrophe on values Excel
 * would run as a formula (document names come from user uploads).
 */
export function csvCell(value: unknown): string {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Lets Excel detect UTF-8, so ₹ and Devanagari names survive. */
const BOM = '\uFEFF';

/** Excel-friendly CSV: UTF-8 BOM, CRLF line endings, one row per finding. */
export function buildFileCheckCsv(result: FileCheckResult): string {
  const rows: unknown[][] = [
    [...CSV_HEADERS],
    ...fileCheckFindings(result).map((f) => [
      f.applicant,
      f.verdict,
      f.checklist,
      f.section,
      f.item,
      f.status,
      f.detail,
      f.documents.join('; '),
    ]),
  ];
  return BOM + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function fileCheckCsvFileName(
  result: FileCheckResult,
  applicant?: string,
): string {
  const parts = [
    'file-check',
    slug(result.checklist?.id || result.checklist?.name || ''),
    slug(applicant || ''),
    slug(result.as_of || ''),
  ].filter(Boolean);
  return `${parts.join('_')}.csv`;
}

/** Save text as a file in the browser (no server round trip). */
export function downloadTextFile(
  filename: string,
  content: string,
  mimeType = 'text/csv;charset=utf-8',
): void {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** 'API error: 503' (useAwsClient.fetchApi) -> 503. */
export function apiErrorStatus(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const m = /API error:\s*(\d{3})/.exec(message);
  return m ? Number(m[1]) : null;
}
