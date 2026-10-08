import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  CircleX,
  Download,
  FileUp,
  Loader2,
  MapPin,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useAwsClient } from '../../hooks/useAwsClient';
import { ApiError, apiErrorDetail } from '../../lib/apiError';
import {
  apiErrorStatus,
  downloadTextFile,
  formatInr,
} from '../../lib/fileCheck';
import { describeEligibilityError } from './errors';
import { BUTTON_CLASS, SECTION_CLASS, SectionTitle } from './fields';
import LenderPolicyPanel from './LenderPolicy';

// "Nearest branch" of each lender at the applicant's pincode, as
// GET .../eligibility/branches answers it (packages/backend/app/branches.py):
// public open data (India Post pincode directory, RBI's bank branch list),
// SAMPLE rows for the NBFCs, or the DSA's own lists, which come first and are
// uploaded here as CSV (.../eligibility/reference-data). Distances are pincode
// centre to pincode centre, so "about N km"; nothing is worked out here.

type FetchApi = <T>(url: string, init?: RequestInit) => Promise<T>;

export type BranchSource = 'dsa_list' | 'public_data' | 'sample';

export type ReferenceKind =
  | 'pincode_serviceability'
  | 'lender_branches'
  | 'company_categories'
  | 'lender_grid';

export const REFERENCE_KINDS: readonly ReferenceKind[] = [
  'pincode_serviceability',
  'lender_branches',
  'company_categories',
  'lender_grid',
];

/** The API's limit on lenders per request. */
export const MAX_LENDERS = 20;
const DEFAULT_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 7;
const PINCODE_RE = /^[1-9][0-9]{5}$/;

export interface BranchOut {
  name: string;
  address: string | null;
  city: string | null;
  district: string | null;
  state: string | null;
  pincode: string;
  /** Banks only. */
  ifsc: string | null;
  /** About: pincode centre to pincode centre. */
  distance_km: number | null;
  /** Rougher: the directory has no exact location for one of the two pincodes. */
  approximate: boolean;
}

export interface LenderBranches {
  lender: string;
  /** null: no list has this lender. */
  serviceable: boolean | null;
  /** dsa_list when any of the answer came from the DSA's lists. */
  source: BranchSource;
  serviceable_source: BranchSource | null;
  branches_source: BranchSource | null;
  /** Nearest first, at most 3. */
  branches: BranchOut[];
  /** The SAMPLE label of made-up rows. */
  label: string | null;
  notes: string[];
}

export interface BranchPlace {
  office: string | null;
  district: string | null;
  state: string | null;
  /** At its district's centre: distances are rougher. */
  approximate: boolean;
}

export interface DataSource {
  name: string;
  licence: string | null;
  url: string | null;
}

export interface BranchesAnswer {
  pincode: string;
  /** null: the pincode is not in the India Post directory. */
  place: BranchPlace | null;
  lenders: LenderBranches[];
  sources: DataSource[];
  notes: string[];
}

export interface ReferenceList {
  kind: ReferenceKind;
  columns: string[];
  optional_columns: string[];
  uploaded: boolean;
  filename: string | null;
  rows: number;
  lenders: string[];
  /** When the list is deleted (ISO); null for a company list, kept until a new upload replaces it. */
  expires_at: string | null;
  /** Upload answer only. */
  duplicates: number | null;
  notes: string[];
  /** Checked but not saved (?preview=true). */
  preview: boolean;
  /** lender_grid upload or preview answer: the file's lender policies. */
  grid: GridLender[] | null;
  /** lender_grid: the API's template CSV (the sample HDFC grid). */
  template: string | null;
}

/** One lender's policy as an uploaded lender grid gives it. */
export interface GridLender {
  lender_id: string;
  lender: string;
  roi: number;
  roi_max: number | null;
  min_cibil_score: number;
  max_enquiries_90d: number;
  min_tenure_months: number;
  max_tenure_months: number;
  min_amount: number;
  max_amount: number;
  /** Percent of the loan, with optional rupee bounds; null: no fee. */
  processing_fee: {
    pct: number;
    min_amount: number | null;
    max_amount: number | null;
  } | null;
  /** Per category: FOIR outside the grid's slabs and multiplier. */
  categories: Record<string, { foir: number; multiplier: number }>;
  /** Net monthly salary slab starts (rupees); empty: no FOIR grid. */
  slab_starts: number[];
  /** Per category, one FOIR (fraction) per slab. */
  foir_grid: Record<string, number[]>;
}

export interface ReferenceLists {
  lists: ReferenceList[];
  retention_days: number;
  max_upload_bytes: number;
}

// ------------------------------------------------------------------ parsing

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && !!v.trim())
    : [];
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function branchSource(value: unknown): BranchSource | null {
  return value === 'dsa_list' || value === 'public_data' || value === 'sample'
    ? value
    : null;
}

function referenceKind(value: unknown): ReferenceKind | null {
  return REFERENCE_KINDS.find((k) => k === value) ?? null;
}

function branchOut(value: unknown): BranchOut | null {
  const o = obj(value);
  const name = text(o.name);
  const pincode = text(o.pincode);
  if (!name || !pincode) return null;
  return {
    name,
    address: text(o.address),
    city: text(o.city),
    district: text(o.district),
    state: text(o.state),
    pincode,
    ifsc: text(o.ifsc),
    distance_km: finite(o.distance_km),
    approximate: o.approximate === true,
  };
}

function lenderBranches(value: unknown): LenderBranches | null {
  const o = obj(value);
  const lender = text(o.lender);
  if (!lender) return null;
  const branches = Array.isArray(o.branches)
    ? o.branches.map(branchOut).filter((b): b is BranchOut => b !== null)
    : [];
  return {
    lender,
    serviceable: typeof o.serviceable === 'boolean' ? o.serviceable : null,
    source: branchSource(o.source) ?? 'public_data',
    serviceable_source: branchSource(o.serviceable_source),
    branches_source: branchSource(o.branches_source),
    branches,
    label: text(o.label),
    notes: strings(o.notes),
  };
}

/** GET .../eligibility/branches. */
export function parseBranches(raw: unknown): BranchesAnswer {
  const o = obj(raw);
  if (!Array.isArray(o.lenders)) {
    throw new Error('unexpected response from the branch finder');
  }
  const place = o.place && typeof o.place === 'object' ? obj(o.place) : null;
  return {
    pincode: text(o.pincode) ?? '',
    place: place
      ? {
          office: text(place.office),
          district: text(place.district),
          state: text(place.state),
          approximate: place.approximate === true,
        }
      : null,
    lenders: o.lenders
      .map(lenderBranches)
      .filter((l): l is LenderBranches => l !== null),
    sources: (Array.isArray(o.sources) ? o.sources : [])
      .map((s) => {
        const r = obj(s);
        const name = text(r.name);
        return name
          ? { name, licence: text(r.licence), url: text(r.url) }
          : null;
      })
      .filter((s): s is DataSource => s !== null),
    notes: strings(o.notes),
  };
}

function numbers(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map(finite).filter((n): n is number => n !== null)
    : [];
}

function gridLender(value: unknown): GridLender | null {
  const o = obj(value);
  const lenderId = text(o.lender_id);
  const lender = text(o.lender);
  const roi = finite(o.roi);
  if (!lenderId || !lender || roi === null) return null;
  const fee = o.processing_fee ? obj(o.processing_fee) : null;
  const feePct = fee ? finite(fee.pct) : null;
  const categories: GridLender['categories'] = {};
  for (const [name, raw] of Object.entries(obj(o.categories))) {
    const c = obj(raw);
    const foir = finite(c.foir);
    const multiplier = finite(c.multiplier);
    if (foir !== null && multiplier !== null) {
      categories[name] = { foir, multiplier };
    }
  }
  const slabStarts = numbers(o.slab_starts);
  const foirGrid: GridLender['foir_grid'] = {};
  for (const [name, raw] of Object.entries(obj(o.foir_grid))) {
    const column = numbers(raw);
    if (column.length === slabStarts.length) foirGrid[name] = column;
  }
  return {
    lender_id: lenderId,
    lender,
    roi,
    roi_max: finite(o.roi_max),
    min_cibil_score: finite(o.min_cibil_score) ?? 0,
    max_enquiries_90d: finite(o.max_enquiries_90d) ?? 0,
    min_tenure_months: finite(o.min_tenure_months) ?? 0,
    max_tenure_months: finite(o.max_tenure_months) ?? 0,
    min_amount: finite(o.min_amount) ?? 0,
    max_amount: finite(o.max_amount) ?? 0,
    processing_fee:
      fee && feePct !== null
        ? {
            pct: feePct,
            min_amount: finite(fee.min_amount),
            max_amount: finite(fee.max_amount),
          }
        : null,
    categories,
    slab_starts: Object.keys(foirGrid).length ? slabStarts : [],
    foir_grid: foirGrid,
  };
}

function referenceList(value: unknown): ReferenceList | null {
  const o = obj(value);
  const kind = referenceKind(o.kind);
  if (!kind) return null;
  return {
    kind,
    columns: strings(o.columns),
    optional_columns: strings(o.optional_columns),
    uploaded: o.uploaded === true,
    filename: text(o.filename),
    rows: finite(o.rows) ?? 0,
    lenders: strings(o.lenders),
    expires_at: text(o.expires_at),
    duplicates: finite(o.duplicates),
    notes: strings(o.notes),
    preview: o.preview === true,
    grid: Array.isArray(o.grid)
      ? o.grid.map(gridLender).filter((g): g is GridLender => g !== null)
      : null,
    // As it is: the CSV's final line break is kept.
    template:
      typeof o.template === 'string' && o.template.trim() ? o.template : null,
  };
}

/** POST .../eligibility/reference-data: the list as saved. */
export function parseReferenceList(raw: unknown): ReferenceList {
  const list = referenceList(raw);
  if (!list) throw new Error('unexpected response from the list upload');
  return list;
}

/** GET .../eligibility/reference-data: each kind, uploaded or not. */
export function parseReferenceLists(raw: unknown): ReferenceLists {
  const o = obj(raw);
  if (!Array.isArray(o.lists)) {
    throw new Error('unexpected response from the lists API');
  }
  return {
    lists: o.lists
      .map(referenceList)
      .filter((l): l is ReferenceList => l !== null),
    retention_days: finite(o.retention_days) ?? DEFAULT_RETENTION_DAYS,
    max_upload_bytes: finite(o.max_upload_bytes) ?? DEFAULT_MAX_UPLOAD_BYTES,
  };
}

// ------------------------------------------------------------------ requests

/** The lenders to ask for: once each, in order, no commas (the separator). */
export function lenderQuery(lenders: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lenders) {
    const name = raw.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push(name);
    }
  }
  return out.slice(0, MAX_LENDERS);
}

/** GET path of the branch finder; null until the pincode has 6 digits and a lender is given. */
export function branchesPath(
  projectId: string,
  pincode: string | null | undefined,
  lenders: readonly string[],
): string | null {
  const value = (pincode ?? '').replace(/\s/g, '');
  const names = lenderQuery(lenders);
  if (!PINCODE_RE.test(value) || names.length === 0) return null;
  return `projects/${projectId}/eligibility/branches?pincode=${value}&lenders=${encodeURIComponent(names.join(','))}`;
}

export async function fetchBranches(
  fetchApi: FetchApi,
  path: string,
): Promise<BranchesAnswer> {
  return parseBranches(await fetchApi<unknown>(path));
}

export function referenceDataPath(projectId: string): string {
  return `projects/${projectId}/eligibility/reference-data`;
}

/**
 * POST the file as it is (application/octet-stream, so its bytes reach the
 * API unchanged whatever its encoding); the API reads the CSV.
 */
export async function uploadReferenceList(
  fetchApi: FetchApi,
  projectId: string,
  kind: ReferenceKind,
  file: Blob & { name?: string },
  preview = false,
): Promise<ReferenceList> {
  const filename = (file.name ?? '')
    .replace(/[\\/]/g, ' ')
    .replace(/\p{Cc}/gu, ' ')
    .trim()
    .slice(0, 200);
  const query = `kind=${kind}${filename ? `&filename=${encodeURIComponent(filename)}` : ''}${preview ? '&preview=true' : ''}`;
  const raw = await fetchApi<unknown>(
    `${referenceDataPath(projectId)}?${query}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(await file.arrayBuffer()),
    },
  );
  return parseReferenceList(raw);
}

/** DELETE; true when a list was removed. */
export async function removeReferenceList(
  fetchApi: FetchApi,
  projectId: string,
  kind: ReferenceKind,
): Promise<boolean> {
  const raw = await fetchApi<unknown>(
    `${referenceDataPath(projectId)}/${kind}`,
    { method: 'DELETE' },
  );
  return obj(raw).deleted === true;
}

/**
 * A CSV to start from: the columns and one example row (synthetic). The
 * lender grid's is the API's (the sample HDFC grid) when it has been loaded.
 */
export function csvTemplate(
  kind: ReferenceKind,
  apiTemplate?: string | null,
): string {
  if (apiTemplate) return apiTemplate;
  const rows: Record<ReferenceKind, string[]> = {
    pincode_serviceability: [
      'lender,pincode,serviceable',
      'HDFC Bank,401202,yes',
      'HDFC Bank,401208,no',
    ],
    lender_branches: [
      'lender,branch,pincode,address,city,district,state,ifsc',
      'Bajaj Finance,Vasai West,401202,"Shop 4, Station Road",Vasai,Palghar,Maharashtra,',
    ],
    company_categories: [
      'lender,company,category',
      'HDFC Bank,Example Tech Private Limited,CAT A',
    ],
    // The full template comes from the API; without it, only the columns.
    lender_grid: ['lender,field,category,slab_from,value'],
  };
  return `${rows[kind].join('\r\n')}\r\n`;
}

// ------------------------------------------------------------------ wording

/**
 * "same pincode", "under 1 km" or "about N km" (centre to centre);
 * "roughly N km" when one of the two pincodes has no exact location.
 */
export function distanceText(
  t: TFunction,
  branch: BranchOut,
  pincode: string,
): string {
  const km = branch.distance_km;
  if (branch.pincode === pincode) return t('eligibility.branches.samePincode');
  if (km === null) return '';
  if (branch.approximate) {
    return km < 1
      ? t('eligibility.branches.roughNear')
      : t('eligibility.branches.roughKm', { km: Math.round(km) });
  }
  if (km < 1) return t('eligibility.branches.underOneKm');
  return t('eligibility.branches.aboutKm', { km: Math.round(km) });
}

function branchWhere(branch: BranchOut): string {
  return [branch.name, branch.city ?? branch.district]
    .filter((part): part is string => !!part)
    .join(', ');
}

/** "Nearest branch: Vasai West, Vasai (about 4 km)". */
export function nearestText(
  t: TFunction,
  branch: BranchOut,
  pincode: string,
): string {
  const distance = distanceText(t, branch, pincode);
  return distance
    ? t('eligibility.branches.nearest', {
        branch: branchWhere(branch),
        distance,
      })
    : t('eligibility.branches.nearestNoDistance', {
        branch: branchWhere(branch),
      });
}

/** The row problems of a refused upload (the API lists up to 20). */
export function uploadProblems(error: unknown): string[] {
  return error instanceof ApiError ? strings(obj(error.detail).errors) : [];
}

/** Why an upload failed: the API's own reason for a refused file. */
export function describeUploadError(t: TFunction, error: unknown): string {
  const status = apiErrorStatus(error);
  const detail = apiErrorDetail(error);
  if (detail && (status === 400 || status === 413 || status === 415)) {
    return detail;
  }
  return describeEligibilityError(t, error);
}

// ------------------------------------------------------------------ state

export interface BranchesState {
  loading: boolean;
  error: unknown;
  answer: BranchesAnswer | null;
}

interface Loaded extends BranchesState {
  /** The request (path and refresh count) this state is for. */
  key: string | null;
  /** The path the answer is for. */
  path: string | null;
}

/** The answer for `path`; a later request wins, a refresh keeps the old answer on screen. */
function useBranches(
  fetchApi: FetchApi,
  path: string | null,
  version: number,
): BranchesState {
  const key = path ? `${version}:${path}` : null;
  const [state, setState] = useState<Loaded>({
    key: null,
    path: null,
    loading: false,
    error: null,
    answer: null,
  });
  const seq = useRef(0);

  useEffect(() => {
    const n = ++seq.current;
    if (!path) return;
    setState((s) => ({
      key,
      path,
      loading: true,
      error: null,
      answer: s.path === path ? s.answer : null,
    }));
    fetchBranches(fetchApi, path).then(
      (answer) => {
        if (n === seq.current) {
          setState({ key, path, loading: false, error: null, answer });
        }
      },
      (error: unknown) => {
        if (n !== seq.current) return;
        console.error('Failed to find the nearest branches:', error);
        setState({ key, path, loading: false, error, answer: null });
      },
    );
  }, [fetchApi, path, key]);

  if (!path) return { loading: false, error: null, answer: null };
  if (state.key !== key) {
    // Not asked yet (first render, another pincode): loading.
    return {
      loading: true,
      error: null,
      answer: state.path === path ? state.answer : null,
    };
  }
  return state;
}

export type ListOutcome =
  | { kind: ReferenceKind; ok: true; list: ReferenceList | null }
  | { kind: ReferenceKind; ok: false; error: string; problems: string[] };

export interface ReferenceListsState {
  data: ReferenceLists | null;
  loading: boolean;
  loadError: unknown;
  /** The kind being uploaded or removed. */
  busy: ReferenceKind | null;
  /** The last upload or removal. */
  outcome: ListOutcome | null;
  /** A lender grid checked and shown, waiting for Save. */
  pending: { kind: ReferenceKind; file: File } | null;
}

/** Kinds checked and previewed before they are saved. */
export const PREVIEWED_KINDS: readonly ReferenceKind[] = ['lender_grid'];

/**
 * Kinds the eligibility calculation reads (the policy sheet, the company
 * list, the pincode list): saving or removing one changes the banks' answer.
 */
export const ELIGIBILITY_KINDS: readonly ReferenceKind[] = [
  'pincode_serviceability',
  'company_categories',
  'lender_grid',
];

/**
 * The DSA's lists: load, upload (a lender grid is previewed first), remove.
 * After a list is saved or removed: `onChanged` (the branches), and
 * `onPolicyChanged` when the calculation reads that kind.
 */
export function useReferenceLists(
  fetchApi: FetchApi,
  projectId: string,
  t: TFunction,
  onChanged: () => void,
  onPolicyChanged?: () => void,
) {
  const [state, setState] = useState<ReferenceListsState>({
    data: null,
    loading: false,
    loadError: null,
    busy: null,
    outcome: null,
    pending: null,
  });
  const seq = useRef(0);
  const projectRef = useRef(projectId);

  // The panel is reused across projects: start clean on a switch.
  useEffect(() => {
    if (projectRef.current === projectId) return;
    projectRef.current = projectId;
    seq.current += 1;
    setState({
      data: null,
      loading: false,
      loadError: null,
      busy: null,
      outcome: null,
      pending: null,
    });
  }, [projectId]);

  const load = useCallback(async () => {
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true, loadError: null }));
    try {
      const data = parseReferenceLists(
        await fetchApi<unknown>(referenceDataPath(projectId)),
      );
      if (n === seq.current) {
        setState((s) => ({ ...s, data, loading: false }));
      }
    } catch (err) {
      if (n !== seq.current) return;
      console.error('Failed to load the reference lists:', err);
      setState((s) => ({ ...s, loading: false, loadError: err }));
    }
  }, [fetchApi, projectId]);

  const send = useCallback(
    async (kind: ReferenceKind, file: File, preview: boolean) => {
      const max = state.data?.max_upload_bytes ?? DEFAULT_MAX_UPLOAD_BYTES;
      if (file.size > max) {
        const mb = Math.floor(max / (1024 * 1024));
        setState((s) => ({
          ...s,
          outcome: {
            kind,
            ok: false,
            error: t('eligibility.branches.lists.tooLarge', { mb }),
            problems: [],
          },
        }));
        return;
      }
      setState((s) => ({ ...s, busy: kind, outcome: null, pending: null }));
      try {
        const list = await uploadReferenceList(
          fetchApi,
          projectId,
          kind,
          file,
          preview,
        );
        setState((s) => ({
          ...s,
          busy: null,
          outcome: { kind, ok: true, list },
          pending: preview ? { kind, file } : null,
        }));
        if (preview) return;
        onChanged();
        if (ELIGIBILITY_KINDS.includes(kind)) onPolicyChanged?.();
        await load();
      } catch (err) {
        console.error('Failed to upload the list:', err);
        setState((s) => ({
          ...s,
          busy: null,
          outcome: {
            kind,
            ok: false,
            error: describeUploadError(t, err),
            problems: uploadProblems(err),
          },
        }));
      }
    },
    [fetchApi, projectId, t, onChanged, onPolicyChanged, load, state.data],
  );

  /** Upload a list; a lender grid is first only checked and shown (save() keeps it). */
  const upload = useCallback(
    (kind: ReferenceKind, file: File) =>
      send(kind, file, PREVIEWED_KINDS.includes(kind)),
    [send],
  );

  const save = useCallback(async () => {
    const pending = state.pending;
    if (pending) await send(pending.kind, pending.file, false);
  }, [send, state.pending]);

  const cancel = useCallback(() => {
    setState((s) => ({ ...s, pending: null, outcome: null }));
  }, []);

  const remove = useCallback(
    async (kind: ReferenceKind) => {
      setState((s) => ({ ...s, busy: kind, outcome: null, pending: null }));
      try {
        await removeReferenceList(fetchApi, projectId, kind);
        setState((s) => ({
          ...s,
          busy: null,
          outcome: { kind, ok: true, list: null },
        }));
        onChanged();
        if (ELIGIBILITY_KINDS.includes(kind)) onPolicyChanged?.();
        await load();
      } catch (err) {
        console.error('Failed to remove the list:', err);
        setState((s) => ({
          ...s,
          busy: null,
          outcome: {
            kind,
            ok: false,
            error: t('eligibility.branches.lists.removeFailed', {
              message: describeEligibilityError(t, err),
            }),
            problems: [],
          },
        }));
      }
    },
    [fetchApi, projectId, t, onChanged, onPolicyChanged, load],
  );

  return { state, load, upload, save, cancel, remove };
}

// ------------------------------------------------------------------ view

const BADGE_CLASS =
  'inline-flex items-center gap-0.5 whitespace-nowrap rounded-full border px-1.5 py-px text-[9px] font-semibold';

const SOURCE_BADGE: Record<BranchSource, string> = {
  dsa_list:
    'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-800/60 dark:bg-indigo-900/30 dark:text-indigo-300',
  public_data:
    'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800/60 dark:bg-sky-900/30 dark:text-sky-300',
  sample:
    'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700/60 dark:bg-amber-900/30 dark:text-amber-300',
};

export function ServiceableBadge({
  value,
  source,
}: {
  value: boolean | null;
  source: BranchSource | null;
}) {
  const { t } = useTranslation();
  const label =
    value === true
      ? t('eligibility.branches.serviceable')
      : value === false
        ? t('eligibility.branches.notServiceable')
        : t('eligibility.branches.serviceableUnknown');
  const tone =
    value === true
      ? 'border-green-200 bg-green-50 text-green-700 dark:border-green-800/50 dark:bg-green-900/30 dark:text-green-300'
      : value === false
        ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-800/50 dark:bg-red-900/30 dark:text-red-300'
        : 'border-slate-300 bg-slate-50 text-slate-600 dark:border-white/15 dark:bg-white/10 dark:text-slate-300';
  const Icon =
    value === true ? CircleCheck : value === false ? CircleX : CircleHelp;
  return (
    <span
      className={`${BADGE_CLASS} ${tone}`}
      data-testid="serviceable"
      data-serviceable={value === null ? 'unknown' : String(value)}
      title={
        source
          ? t(`eligibility.branches.serviceableHints.${source}`)
          : undefined
      }
    >
      <Icon className="h-2.5 w-2.5" aria-hidden="true" />
      {label}
      {source === 'sample' && ` · ${t('eligibility.branches.sampleList')}`}
    </span>
  );
}

export function BranchSourceBadge({
  source,
  label,
}: {
  source: BranchSource;
  /** The API's SAMPLE label, shown on hover. */
  label?: string | null;
}) {
  const { t } = useTranslation();
  return (
    <span
      className={`${BADGE_CLASS} ${SOURCE_BADGE[source]}`}
      data-testid="branch-source"
      data-source={source}
      title={label || t(`eligibility.branches.sourceHints.${source}`)}
    >
      {t(`eligibility.branches.sources.${source}`)}
    </span>
  );
}

function LenderRow({ row, pincode }: { row: LenderBranches; pincode: string }) {
  const { t } = useTranslation();
  const [nearest, ...others] = row.branches;
  return (
    <li
      className="min-w-0 space-y-0.5 rounded-lg border border-white/50 bg-white/30 px-2 py-1.5 dark:border-white/[0.08] dark:bg-white/[0.03]"
      data-lender={row.lender}
      data-source={row.source}
    >
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-0.5 text-[11px] font-semibold text-slate-700 dark:text-slate-200">
          {row.lender}
        </span>
        <ServiceableBadge
          value={row.serviceable}
          source={row.serviceable_source}
        />
        <BranchSourceBadge source={row.source} label={row.label} />
      </div>
      {nearest ? (
        <>
          <p
            className="break-words text-[11px] text-slate-700 dark:text-slate-200"
            data-testid="nearest-branch"
          >
            {nearestText(t, nearest, pincode)}
            {nearest.ifsc && (
              <span className="text-slate-500 dark:text-slate-400">
                {' · '}
                {t('eligibility.branches.ifsc', { ifsc: nearest.ifsc })}
              </span>
            )}
          </p>
          {nearest.address && (
            <p
              className="truncate text-[10px] text-slate-500 dark:text-slate-400"
              title={nearest.address}
            >
              {nearest.address}
            </p>
          )}
          {others.length > 0 && (
            <p className="break-words text-[10px] text-slate-500 dark:text-slate-400">
              {t('eligibility.branches.also', {
                branches: others
                  .map((b) => {
                    const distance = distanceText(t, b, pincode);
                    return distance ? `${b.name} (${distance})` : b.name;
                  })
                  .join(' · '),
              })}
            </p>
          )}
        </>
      ) : (
        row.notes.length === 0 && (
          <p className="text-[10px] text-slate-500 dark:text-slate-400">
            {t('eligibility.branches.noBranch')}
          </p>
        )
      )}
      {row.notes.map((note) => (
        <p
          key={note}
          className="break-words text-[10px] text-amber-700 dark:text-amber-400"
        >
          {note}
        </p>
      ))}
    </li>
  );
}

interface BranchResultsProps {
  /** Why nothing is asked yet ('pincode' or 'lenders'); null once asked. */
  waitingFor: 'pincode' | 'lenders' | null;
  state: BranchesState;
  onRefresh: () => void;
}

/** Each lender's serviceability and nearest branches, with the data's sources. */
export function BranchResults({
  waitingFor,
  state,
  onRefresh,
}: BranchResultsProps) {
  const { t } = useTranslation();
  const { answer, loading, error } = state;
  const place = answer?.place;
  const where = place
    ? [place.office, place.district, place.state].filter(Boolean).join(', ')
    : null;
  return (
    <div className="space-y-2" data-testid="branch-results" aria-busy={loading}>
      <div className="flex min-w-0 items-center gap-1.5">
        <MapPin
          className="h-3.5 w-3.5 flex-shrink-0 text-indigo-500"
          aria-hidden="true"
        />
        <SectionTitle>{t('eligibility.branches.title')}</SectionTitle>
        {answer && (
          <span
            className="min-w-0 flex-1 truncate text-[10px] text-slate-500 dark:text-slate-400"
            data-testid="branch-place"
          >
            {where
              ? t('eligibility.branches.place', {
                  pincode: answer.pincode,
                  place: where,
                })
              : answer.pincode}
            {place?.approximate &&
              ` · ${t('eligibility.branches.approximate')}`}
          </span>
        )}
        {!waitingFor && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className={`ml-auto flex-shrink-0 ${BUTTON_CLASS}`}
            aria-label={t('eligibility.branches.refresh')}
            title={t('eligibility.branches.refresh')}
          >
            <RefreshCw
              className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
          </button>
        )}
      </div>
      {waitingFor ? (
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          {waitingFor === 'pincode'
            ? t('eligibility.branches.enterPincode')
            : t('eligibility.branches.noLenders')}
        </p>
      ) : error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-[11px] text-red-600 dark:text-red-400"
        >
          <span className="break-words">
            {t('eligibility.branches.failed', {
              message: describeEligibilityError(t, error),
            })}
          </span>
          <button type="button" onClick={onRefresh} className={BUTTON_CLASS}>
            {t('eligibility.branches.retry')}
          </button>
        </div>
      ) : !answer ? (
        <p
          role="status"
          className="flex items-center gap-1 text-[11px] text-slate-500"
        >
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          {t('eligibility.branches.loading')}
        </p>
      ) : (
        <>
          {answer.notes.map((note) => (
            <p
              key={note}
              role="status"
              className="break-words text-[10px] text-amber-700 dark:text-amber-400"
            >
              {note}
            </p>
          ))}
          <ul className="grid grid-cols-1 gap-1.5 @lg:grid-cols-2">
            {answer.lenders.map((row) => (
              <LenderRow key={row.lender} row={row} pincode={answer.pincode} />
            ))}
          </ul>
          <p className="text-[10px] text-slate-500 dark:text-slate-400">
            {t('eligibility.branches.distanceNote')}
            {answer.lenders.some((l) =>
              l.branches.some((b) => b.approximate),
            ) && ` ${t('eligibility.branches.roughNote')}`}
          </p>
          {answer.sources.length > 0 && (
            <details className="text-[10px] text-slate-500 dark:text-slate-400">
              <summary className="cursor-pointer select-none">
                {t('eligibility.branches.dataSources', {
                  count: answer.sources.length,
                })}
              </summary>
              <ul
                className="mt-1 space-y-0.5 pl-3"
                data-testid="branch-sources"
              >
                {answer.sources.map((s) => (
                  <li key={s.name} className="break-words">
                    {s.url ? (
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-indigo-600 hover:underline dark:text-indigo-300"
                      >
                        {s.name}
                      </a>
                    ) : (
                      s.name
                    )}
                    {s.licence && ` · ${s.licence}`}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function expiresOn(iso: string | null): string | null {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleDateString([], {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : null;
}

/** 0.55 -> '55%'; 10.5 (already percent) -> '10.5%'. */
function percent(value: number, fraction: boolean): string {
  const n = fraction ? value * 100 : value;
  return `${Number(n.toFixed(2))}%`;
}

/** A lender grid's policies as the API read them, before Save. */
export function GridPreview({ grid }: { grid: GridLender[] }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2" data-testid="grid-preview">
      {grid.map((lender) => {
        const fee = lender.processing_fee;
        const categories = Object.keys(lender.categories);
        const roi =
          lender.roi_max !== null && lender.roi_max !== lender.roi
            ? `${percent(lender.roi, false)} – ${percent(lender.roi_max, false)}`
            : percent(lender.roi, false);
        const rules: [string, string][] = [
          [t('eligibility.branches.lists.grid.roi'), roi],
          [
            t('eligibility.branches.lists.grid.minCibil'),
            String(lender.min_cibil_score),
          ],
          [
            t('eligibility.branches.lists.grid.maxEnquiries'),
            String(lender.max_enquiries_90d),
          ],
          [
            t('eligibility.branches.lists.grid.tenure'),
            t('eligibility.branches.lists.grid.months', {
              from: lender.min_tenure_months,
              to: lender.max_tenure_months,
            }),
          ],
          [
            t('eligibility.branches.lists.grid.amount'),
            `${formatInr(lender.min_amount)} – ${formatInr(lender.max_amount)}`,
          ],
          [
            t('eligibility.branches.lists.grid.fee'),
            fee
              ? [
                  percent(fee.pct, false),
                  fee.min_amount !== null &&
                    t('eligibility.branches.lists.grid.feeMin', {
                      amount: formatInr(fee.min_amount),
                    }),
                  fee.max_amount !== null &&
                    t('eligibility.branches.lists.grid.feeMax', {
                      amount: formatInr(fee.max_amount),
                    }),
                ]
                  .filter(Boolean)
                  .join(', ')
              : t('eligibility.branches.lists.grid.noFee'),
          ],
        ];
        return (
          <div
            key={lender.lender_id}
            className="space-y-1 text-[10px] text-slate-700 dark:text-slate-200"
            data-lender={lender.lender_id}
          >
            <p className="font-semibold">{lender.lender}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-2">
              {rules.map(([name, value]) => (
                <div key={name} className="contents">
                  <dt className="text-slate-500 dark:text-slate-400">{name}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse text-[10px]">
                <caption className="sr-only">
                  {t('eligibility.branches.lists.grid.caption', {
                    lender: lender.lender,
                  })}
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className="pr-2 text-left font-medium">
                      {t('eligibility.branches.lists.grid.salary')}
                    </th>
                    {categories.map((c) => (
                      <th
                        key={c}
                        scope="col"
                        className="pr-2 text-right font-medium"
                      >
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row" className="pr-2 text-left font-normal">
                      {t('eligibility.branches.lists.grid.multiplier')}
                    </th>
                    {categories.map((c) => (
                      <td key={c} className="pr-2 text-right">
                        {`${lender.categories[c].multiplier}×`}
                      </td>
                    ))}
                  </tr>
                  {lender.slab_starts.map((start, i) => (
                    <tr key={start}>
                      <th scope="row" className="pr-2 text-left font-normal">
                        {t('eligibility.branches.lists.grid.slabFrom', {
                          amount: formatInr(start),
                        })}
                      </th>
                      {categories.map((c) => (
                        <td key={c} className="pr-2 text-right">
                          {lender.foir_grid[c]
                            ? percent(lender.foir_grid[c][i], true)
                            : percent(lender.categories[c].foir, true)}
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr>
                    <th scope="row" className="pr-2 text-left font-normal">
                      {lender.slab_starts.length
                        ? t('eligibility.branches.lists.grid.foirOutside')
                        : t('eligibility.branches.lists.grid.foir')}
                    </th>
                    {categories.map((c) => (
                      <td key={c} className="pr-2 text-right">
                        {percent(lender.categories[c].foir, true)}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ListRow({
  kind,
  list,
  busy,
  disabled,
  outcome,
  pending,
  onUpload,
  onSave,
  onCancel,
  onRemove,
}: {
  kind: ReferenceKind;
  list: ReferenceList | null;
  busy: boolean;
  disabled: boolean;
  outcome: ListOutcome | null;
  /** A previewed file is waiting for Save. */
  pending: boolean;
  onUpload: (kind: ReferenceKind, file: File) => void;
  onSave: () => void;
  onCancel: () => void;
  onRemove: (kind: ReferenceKind) => void;
}) {
  const { t } = useTranslation();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const label = t(`eligibility.branches.lists.kinds.${kind}.label`);
  const columns = list?.columns.join(', ');
  const optional = list?.optional_columns.join(', ');
  const until = expiresOn(list?.expires_at ?? null);
  // A company list holds no client data: stored without an expiry, kept until a new upload replaces it.
  const kept = kind === 'company_categories' && !list?.expires_at;
  return (
    <li
      className="space-y-1 rounded-lg border border-white/50 bg-white/30 px-2 py-1.5 dark:border-white/[0.08] dark:bg-white/[0.03]"
      data-kind={kind}
      data-uploaded={String(!!list?.uploaded)}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">
          {label}
        </span>
        <span className="flex-1" />
        <input
          id={inputId}
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) onUpload(kind, file);
          }}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          className={BUTTON_CLASS}
          aria-controls={inputId}
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          ) : (
            <FileUp className="h-3 w-3" aria-hidden="true" />
          )}
          {list?.uploaded
            ? t('eligibility.branches.lists.replace')
            : t('eligibility.branches.lists.upload')}
        </button>
        <button
          type="button"
          onClick={() =>
            downloadTextFile(
              `${kind}-template.csv`,
              csvTemplate(kind, list?.template),
            )
          }
          className={BUTTON_CLASS}
          title={t('eligibility.branches.lists.templateHint')}
        >
          <Download className="h-3 w-3" aria-hidden="true" />
          {t('eligibility.branches.lists.template')}
        </button>
        {list?.uploaded && (
          <button
            type="button"
            onClick={() => {
              if (
                window.confirm(
                  t('eligibility.branches.lists.removeConfirm', {
                    list: label,
                  }),
                )
              ) {
                onRemove(kind);
              }
            }}
            disabled={disabled}
            className={BUTTON_CLASS}
            aria-label={t('eligibility.branches.lists.removeLabel', {
              list: label,
            })}
          >
            <Trash2 className="h-3 w-3" aria-hidden="true" />
            {t('eligibility.branches.lists.remove')}
          </button>
        )}
      </div>
      <p className="text-[10px] text-slate-500 dark:text-slate-400">
        {t(`eligibility.branches.lists.kinds.${kind}.description`)}
      </p>
      {columns && (
        <p className="text-[10px] text-slate-500 dark:text-slate-400">
          {t('eligibility.branches.lists.columns', { columns })}
          {optional &&
            ` (${t('eligibility.branches.lists.optional', { columns: optional })})`}
        </p>
      )}
      <p
        className="text-[10px] text-slate-600 dark:text-slate-300"
        data-testid="list-status"
      >
        {list?.uploaded
          ? [
              list.filename,
              t('eligibility.branches.lists.rows', { count: list.rows }),
              until
                ? t('eligibility.branches.lists.deletedOn', { date: until })
                : kept && t('eligibility.branches.lists.keptUntilReplaced'),
            ]
              .filter(Boolean)
              .join(' · ')
          : t('eligibility.branches.lists.notUploaded')}
      </p>
      {outcome &&
        (outcome.ok ? (
          <div
            role="status"
            className="text-[10px] text-green-700 dark:text-green-400"
          >
            {outcome.list?.preview ? (
              <div className="space-y-1 text-slate-700 dark:text-slate-200">
                <p className="font-medium">
                  {t('eligibility.branches.lists.previewTitle', {
                    file: outcome.list.filename ?? '',
                    count: outcome.list.rows,
                  })}
                </p>
                {outcome.list.grid && <GridPreview grid={outcome.list.grid} />}
                {outcome.list.notes.map((note) => (
                  <p
                    key={note}
                    className="break-words text-amber-700 dark:text-amber-400"
                  >
                    {note}
                  </p>
                ))}
                {pending && (
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={onSave}
                      disabled={disabled}
                      className={BUTTON_CLASS}
                    >
                      {t('eligibility.branches.lists.save')}
                    </button>
                    <button
                      type="button"
                      onClick={onCancel}
                      disabled={disabled}
                      className={BUTTON_CLASS}
                    >
                      {t('eligibility.branches.lists.cancel')}
                    </button>
                  </div>
                )}
              </div>
            ) : outcome.list ? (
              <>
                <p>
                  {t('eligibility.branches.lists.saved', {
                    count: outcome.list.rows,
                  })}
                  {!!outcome.list.duplicates &&
                    ` · ${t('eligibility.branches.lists.duplicates', {
                      count: outcome.list.duplicates,
                    })}`}
                </p>
                {outcome.list.notes.map((note) => (
                  <p
                    key={note}
                    className="break-words text-amber-700 dark:text-amber-400"
                  >
                    {note}
                  </p>
                ))}
              </>
            ) : (
              <p>{t('eligibility.branches.lists.removed')}</p>
            )}
          </div>
        ) : (
          <div
            role="alert"
            className="text-[10px] text-red-600 dark:text-red-400"
            data-testid="list-error"
          >
            <p className="break-words">{outcome.error}</p>
            {outcome.problems.length > 0 && (
              <ul className="list-disc pl-4">
                {outcome.problems.map((problem) => (
                  <li key={problem} className="break-words">
                    {problem}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
    </li>
  );
}

interface ReferenceListsPanelProps {
  open: boolean;
  onToggle: () => void;
  state: ReferenceListsState;
  onRetry: () => void;
  onUpload: (kind: ReferenceKind, file: File) => void;
  onSave: () => void;
  onCancel: () => void;
  onRemove: (kind: ReferenceKind) => void;
}

/** "Your lists (CSV)": the DSA's own serviceability, branch and company lists. */
export function ReferenceListsPanel({
  open,
  onToggle,
  state,
  onRetry,
  onUpload,
  onSave,
  onCancel,
  onRemove,
}: ReferenceListsPanelProps) {
  const { t } = useTranslation();
  const panelId = useId();
  const { data, loading, loadError, busy, outcome, pending } = state;
  const uploaded = data?.lists.filter((l) => l.uploaded).length ?? 0;
  return (
    <div className="space-y-1.5" data-testid="reference-lists">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-300"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3 w-3" aria-hidden="true" />
        )}
        {t('eligibility.branches.lists.toggle')}
        {data && (
          <span className="font-normal text-slate-500 dark:text-slate-400">
            {` · ${t('eligibility.branches.lists.summary', {
              uploaded,
              count: REFERENCE_KINDS.length,
            })}`}
          </span>
        )}
      </button>
      {open && (
        <div id={panelId} className="space-y-1.5">
          <p className="text-[10px] text-slate-500 dark:text-slate-400">
            {t('eligibility.branches.lists.intro', {
              days: data?.retention_days ?? DEFAULT_RETENTION_DAYS,
            })}
          </p>
          {loadError ? (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-2 text-[11px] text-red-600 dark:text-red-400"
            >
              <span className="break-words">
                {t('eligibility.branches.lists.loadFailed', {
                  message: describeEligibilityError(t, loadError),
                })}
              </span>
              <button type="button" onClick={onRetry} className={BUTTON_CLASS}>
                {t('eligibility.branches.retry')}
              </button>
            </div>
          ) : !data && loading ? (
            <p
              role="status"
              className="flex items-center gap-1 text-[11px] text-slate-500"
            >
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              {t('eligibility.branches.lists.loading')}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {REFERENCE_KINDS.map((kind) => (
                <ListRow
                  key={kind}
                  kind={kind}
                  list={data?.lists.find((l) => l.kind === kind) ?? null}
                  busy={busy === kind}
                  disabled={busy !== null || !data}
                  outcome={outcome?.kind === kind ? outcome : null}
                  pending={pending?.kind === kind}
                  onUpload={onUpload}
                  onSave={onSave}
                  onCancel={onCancel}
                  onRemove={onRemove}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export interface BranchFinderProps {
  projectId: string;
  /** The applicant's pincode; nothing is asked until it has 6 digits. */
  pincode: string | undefined;
  /** The lenders to show (e.g. the eligible ones), in this order. */
  lenders: string[];
  /**
   * After a list the calculation reads (the DSA's policy sheet, company or
   * pincode list) is saved or removed, or an admin's lender policy workbook.
   */
  onPolicyChanged?: () => void;
}

/**
 * Per lender: "Nearest branch: <name>, <city> (about N km)", whether it serves
 * the pincode and where the answer came from (your list, public data or
 * SAMPLE); below, the DSA's own lists, which come first once uploaded, and
 * for admins the app's lender policy workbook.
 */
export default function BranchFinder({
  projectId,
  pincode,
  lenders,
  onPolicyChanged,
}: BranchFinderProps) {
  const { t } = useTranslation();
  const { fetchApi } = useAwsClient();
  const [version, setVersion] = useState(0);
  const [listsOpen, setListsOpen] = useState(false);
  const path = branchesPath(projectId, pincode, lenders);
  const waitingFor = path
    ? null
    : PINCODE_RE.test((pincode ?? '').replace(/\s/g, ''))
      ? 'lenders'
      : 'pincode';
  const branches = useBranches(fetchApi, path, version);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const lists = useReferenceLists(
    fetchApi,
    projectId,
    t,
    refresh,
    onPolicyChanged,
  );
  const { state: listsState, load: loadLists } = lists;

  // The lists load when the panel is first opened.
  useEffect(() => {
    if (
      listsOpen &&
      !listsState.data &&
      !listsState.loading &&
      listsState.loadError == null
    ) {
      loadLists();
    }
  }, [
    listsOpen,
    listsState.data,
    listsState.loading,
    listsState.loadError,
    loadLists,
  ]);

  return (
    <section
      className={SECTION_CLASS}
      aria-label={t('eligibility.branches.title')}
      data-testid="branch-finder"
    >
      <BranchResults
        waitingFor={waitingFor}
        state={branches}
        onRefresh={refresh}
      />
      <ReferenceListsPanel
        open={listsOpen}
        onToggle={() => setListsOpen((o) => !o)}
        state={listsState}
        onRetry={loadLists}
        onUpload={lists.upload}
        onSave={lists.save}
        onCancel={lists.cancel}
        onRemove={lists.remove}
      />
      <LenderPolicyPanel onChanged={onPolicyChanged} />
    </section>
  );
}
