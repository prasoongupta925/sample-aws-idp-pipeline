import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  FileUp,
  Loader2,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { useAwsClient } from '../../hooks/useAwsClient';
import { useIsAdmin } from '../../hooks/useIsAdmin';
import { apiErrorDetail } from '../../lib/apiError';
import { formatFoir, formatRupees } from '../../lib/eligibility';
import { apiErrorStatus } from '../../lib/fileCheck';
import { describeEligibilityError } from './errors';
import { BUTTON_CLASS, PRIMARY_CLASS } from './fields';

// "Lender policy (Excel)": the client's policy workbook, one for the whole
// app, for admins only (packages/backend/app/routers/lender_policy.py). A
// chosen .xlsx is first read and shown (?preview=true), then saved; the
// original file comes back through a 5-minute link. Every project's
// eligibility calculation uses the saved policy for its banks.

type FetchApi = <T>(url: string, init?: RequestInit) => Promise<T>;

export const LENDER_POLICY_PATH = 'eligibility/lender-policy';
const DEFAULT_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 7;
/** The API's limit on the file name. */
const MAX_NAME = 200;
const XLSX_ACCEPT =
  '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The sheet's parameters (Sheet1 row 2), in its order. */
export const POLICY_PARAMETERS = [
  'roi',
  'foir',
  'multiplier',
  'max_funding',
  'max_tenure_months',
  'calculation_tenure_months',
] as const;

/** The stored policy, as the "Current policy" line shows it. */
export interface PolicyStatus {
  filename: string | null;
  /** ISO. */
  uploaded_at: string | null;
  /** When it is deleted (ISO): re-upload needed by then. */
  expires_at: string | null;
  /** The API's wording of that day ("12 Oct 2026"). */
  reupload_by: string | null;
  /** The workbook's date (Sheet2!SGQ1), ISO. */
  effective_date: string | null;
  banks: string[];
  warnings: string[];
}

export interface LenderPolicyInfo {
  /** null: none stored, the sample policies apply. */
  current: PolicyStatus | null;
  retention_days: number;
  max_upload_bytes: number;
}

export interface PolicyCell {
  value: number | null;
  /** The Sheet1 cell it was read from ("E5"). */
  cell: string;
}

export interface PolicySlab {
  /** Net monthly salary slab start, rupees. */
  start: number;
  /** Parameter -> category code -> value (ROI and FOIR as fractions). */
  values: Record<string, Record<string, PolicyCell>>;
}

/** One Sheet2 cell of a bank, as the sheet writes it. */
export interface PolicyRule {
  header: string;
  text: string;
  cell: string;
}

export interface PolicyBank {
  lender_id: string;
  name: string;
  /** Not one of the app's sample lenders: the policy adds it. */
  new: boolean;
  slabs: PolicySlab[];
  rules: PolicyRule[];
}

export interface PolicyCategory {
  /** As the sheet writes it: "CAT_A+". */
  code: string;
  /** As the app shows it: "CAT A+". */
  label: string;
}

/** The workbook as the API read it (a preview, or what a save stored). */
export interface PolicyPreview {
  filename: string | null;
  preview: boolean;
  effective_date: string | null;
  categories: PolicyCategory[];
  /** [parameter key, the sheet's name], in the sheet's order. */
  parameters: [string, string][];
  banks: PolicyBank[];
  /** What to check in the file (duplicate slabs, unknown text ...). */
  warnings: string[];
  notes: string[];
  /** After a save: the stored policy. */
  current: PolicyStatus | null;
}

/** A chosen file, read once: Save sends exactly what was shown. */
export interface PolicyFile {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
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

function policyStatus(value: unknown): PolicyStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = obj(value);
  return {
    filename: text(o.filename),
    uploaded_at: text(o.uploaded_at),
    expires_at: text(o.expires_at),
    reupload_by: text(o.reupload_by),
    effective_date: text(o.effective_date),
    banks: strings(o.banks),
    warnings: strings(o.warnings),
  };
}

/** GET eligibility/lender-policy. */
export function parseLenderPolicy(raw: unknown): LenderPolicyInfo {
  const o = obj(raw);
  if (!('current' in o)) {
    throw new Error('unexpected response from the lender policy API');
  }
  return {
    current: policyStatus(o.current),
    retention_days: finite(o.retention_days) ?? DEFAULT_RETENTION_DAYS,
    max_upload_bytes: finite(o.max_upload_bytes) ?? DEFAULT_MAX_UPLOAD_BYTES,
  };
}

function policySlab(value: unknown): PolicySlab | null {
  const o = obj(value);
  const start = finite(o.start);
  if (start === null) return null;
  const values: PolicySlab['values'] = {};
  for (const [parameter, column] of Object.entries(obj(o.values))) {
    const cells: Record<string, PolicyCell> = {};
    for (const [code, raw] of Object.entries(obj(column))) {
      const c = obj(raw);
      cells[code] = { value: finite(c.value), cell: text(c.cell) ?? '' };
    }
    values[parameter] = cells;
  }
  return { start, values };
}

function policyRules(value: unknown): PolicyRule[] {
  return Object.entries(obj(obj(value).raw)).flatMap(([header, raw]) => {
    const r = obj(raw);
    const name = header.trim();
    return name
      ? [
          {
            header: name,
            text: typeof r.text === 'string' ? r.text.trim() : '',
            cell: text(r.cell) ?? '',
          },
        ]
      : [];
  });
}

function policyBank(value: unknown): PolicyBank | null {
  const o = obj(value);
  const lenderId = text(o.lender_id);
  const name = text(o.name);
  if (!lenderId || !name) return null;
  return {
    lender_id: lenderId,
    name,
    new: o.new === true,
    slabs: (Array.isArray(o.slabs) ? o.slabs : [])
      .map(policySlab)
      .filter((s): s is PolicySlab => s !== null)
      .sort((a, b) => a.start - b.start),
    rules: policyRules(o.rules),
  };
}

/** POST eligibility/lender-policy[?preview=true]. */
export function parsePolicyPreview(raw: unknown): PolicyPreview {
  const o = obj(raw);
  if (!Array.isArray(o.banks)) {
    throw new Error('unexpected response from the policy upload');
  }
  const parameters = Object.entries(obj(o.parameters)).map(
    ([key, label]): [string, string] => [key, text(label) ?? key],
  );
  return {
    filename: text(o.filename),
    preview: o.preview === true,
    effective_date: text(o.effective_date),
    categories: (Array.isArray(o.categories) ? o.categories : []).flatMap(
      (c) => {
        const r = obj(c);
        const code = text(r.code);
        return code ? [{ code, label: text(r.label) ?? code }] : [];
      },
    ),
    parameters: parameters.length
      ? parameters
      : POLICY_PARAMETERS.map((key): [string, string] => [key, key]),
    banks: o.banks.map(policyBank).filter((b): b is PolicyBank => b !== null),
    warnings: strings(o.warnings),
    notes: strings(o.notes),
    current: policyStatus(o.current),
  };
}

// ------------------------------------------------------------------ requests

/**
 * The name the API is given: no folder or control characters, at most 200
 * characters, its extension kept (the API accepts .xlsx names only).
 */
export function uploadName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (base.length <= MAX_NAME) return base;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 && base.length - dot <= 10 ? base.slice(dot) : '';
  return `${base.slice(0, MAX_NAME - ext.length).trimEnd()}${ext}`;
}

export async function fetchLenderPolicy(
  fetchApi: FetchApi,
): Promise<LenderPolicyInfo> {
  return parseLenderPolicy(await fetchApi<unknown>(LENDER_POLICY_PATH));
}

export async function readPolicyFile(file: File): Promise<PolicyFile> {
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/**
 * POST the workbook's bytes as they are (application/octet-stream). With
 * `preview` the API only reads and shows it; without, it is saved as the
 * app's policy.
 */
export async function uploadLenderPolicy(
  fetchApi: FetchApi,
  file: PolicyFile,
  preview: boolean,
): Promise<PolicyPreview> {
  const name = uploadName(file.name);
  const query = [
    name && `filename=${encodeURIComponent(name)}`,
    preview && 'preview=true',
  ]
    .filter(Boolean)
    .join('&');
  const raw = await fetchApi<unknown>(
    query ? `${LENDER_POLICY_PATH}?${query}` : LENDER_POLICY_PATH,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file.bytes,
    },
  );
  return parsePolicyPreview(raw);
}

/** GET .../download: a 5-minute link to the original file, as uploaded. */
export async function fetchPolicyDownload(
  fetchApi: FetchApi,
): Promise<{ url: string; filename: string | null }> {
  const o = obj(await fetchApi<unknown>(`${LENDER_POLICY_PATH}/download`));
  const url = text(o.url);
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error('unexpected response from the policy download');
  }
  return { url, filename: text(o.filename) };
}

/** DELETE; true when a policy was removed. */
export async function removeLenderPolicy(fetchApi: FetchApi): Promise<boolean> {
  const raw = await fetchApi<unknown>(LENDER_POLICY_PATH, {
    method: 'DELETE',
  });
  return obj(raw).deleted === true;
}

/** Opens a download link; the link itself names the file and says "save it". */
export function startDownload(url: string, doc: Document = document): void {
  const link = doc.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  doc.body.appendChild(link);
  link.click();
  doc.body.removeChild(link);
}

/** Why a request failed: the API's reason for a refused file, else the usual wording. */
export function describePolicyError(t: TFunction, error: unknown): string {
  const status = apiErrorStatus(error);
  if (status === 403) return t('eligibility.lenderPolicy.adminOnly');
  const detail = apiErrorDetail(error);
  if (detail && (status === 400 || status === 413 || status === 415)) {
    return detail;
  }
  return describeEligibilityError(t, error);
}

// ------------------------------------------------------------------ wording

const DAY: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
};
const NUMBER = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

function validDate(iso: string | null): Date | null {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

/** "1 Jul 2026" for an ISO date, the same day in every time zone. */
export function isoDateText(iso: string | null): string | null {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  const date = m
    ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
    : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleDateString([], { ...DAY, timeZone: 'UTC' })
    : null;
}

/** The upload time, in the browser's time zone. */
export function uploadedText(iso: string | null): string | null {
  return (
    validDate(iso)?.toLocaleString([], {
      ...DAY,
      hour: '2-digit',
      minute: '2-digit',
    }) ?? null
  );
}

/** The day the stored policy is deleted: re-upload needed by then. */
export function reuploadByText(status: PolicyStatus): string | null {
  return (
    validDate(status.expires_at)?.toLocaleDateString([], DAY) ??
    status.reupload_by
  );
}

/** 10000000 -> '₹1 Cr', 5000000 -> '₹50 L'; under a lakh in rupees. */
export function shortRupees(value: number): string {
  const size = Math.abs(value);
  if (size >= 1e7) return `₹${NUMBER.format(value / 1e7)} Cr`;
  if (size >= 1e5) return `₹${NUMBER.format(value / 1e5)} L`;
  return formatRupees(value);
}

/** A sheet value as the table shows it; ROI and FOIR are fractions (0.135 -> '13.5%'). */
export function policyValueText(
  parameter: string,
  value: number | null,
): string {
  if (value === null) return '–';
  if (parameter === 'roi' || parameter === 'foir') return formatFoir(value);
  if (parameter === 'multiplier') return `${NUMBER.format(value)}×`;
  if (parameter === 'max_funding') return shortRupees(value);
  return NUMBER.format(value);
}

export interface ParameterRow {
  /** The slab start; null: the same values in every slab. */
  start: number | null;
  /** Per category (the table's columns): the value and its cells. */
  values: { value: number | null; cells: string[] }[];
}

/**
 * The rows of one parameter of a bank: one per slab, or one "All slabs" row
 * when every slab has the same values (usually maximum funding and tenures).
 */
export function parameterRows(
  bank: PolicyBank,
  parameter: string,
  categories: PolicyCategory[],
): ParameterRow[] {
  const rows: ParameterRow[] = bank.slabs.map((slab) => ({
    start: slab.start,
    values: categories.map((c) => {
      const cell = slab.values[parameter]?.[c.code];
      return {
        value: cell?.value ?? null,
        cells: cell?.cell ? [cell.cell] : [],
      };
    }),
  }));
  const [first] = rows;
  const same =
    rows.length > 1 &&
    rows.every((row) =>
      row.values.every((v, i) => v.value === first.values[i].value),
    );
  if (!same) return rows;
  return [
    {
      start: null,
      values: first.values.map((v, i) => ({
        value: v.value,
        cells: rows.flatMap((row) => row.values[i].cells),
      })),
    },
  ];
}

/** The lowest and highest ROI of a bank (fractions); null: none. */
export function roiRange(bank: PolicyBank): [number, number] | null {
  const rois = bank.slabs
    .flatMap((slab) => Object.values(slab.values.roi ?? {}))
    .map((c) => c.value)
    .filter((v): v is number => v !== null);
  return rois.length ? [Math.min(...rois), Math.max(...rois)] : null;
}

// ------------------------------------------------------------------ state

export type PolicyBusy = 'preview' | 'save' | 'download' | 'remove';

export type PolicyOutcome =
  | { ok: true; done: 'saved' | 'removed' }
  | { ok: false; error: string };

export interface LenderPolicyState {
  info: LenderPolicyInfo | null;
  loading: boolean;
  loadError: unknown;
  busy: PolicyBusy | null;
  /** A chosen file, read and shown, waiting for Save. */
  pending: { file: PolicyFile; preview: PolicyPreview } | null;
  /** The last save, removal or failure. */
  outcome: PolicyOutcome | null;
}

export const IDLE_POLICY_STATE: LenderPolicyState = {
  info: null,
  loading: false,
  loadError: null,
  busy: null,
  pending: null,
  outcome: null,
};

function useLenderPolicy(
  fetchApi: FetchApi,
  t: TFunction,
  onChanged?: () => void,
) {
  const [state, setState] = useState<LenderPolicyState>(IDLE_POLICY_STATE);
  const seq = useRef(0);
  const maxBytes = state.info?.max_upload_bytes ?? DEFAULT_MAX_UPLOAD_BYTES;

  const load = useCallback(async () => {
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true, loadError: null }));
    try {
      const info = await fetchLenderPolicy(fetchApi);
      if (n === seq.current) {
        setState((s) => ({ ...s, info, loading: false }));
      }
    } catch (err) {
      if (n !== seq.current) return;
      console.error('Failed to load the lender policy:', err);
      setState((s) => ({ ...s, loading: false, loadError: err }));
    }
  }, [fetchApi]);

  const fail = useCallback(
    (error: string) =>
      setState((s) => ({ ...s, busy: null, outcome: { ok: false, error } })),
    [],
  );

  /** Read the chosen file and show it; nothing is saved yet. */
  const choose = useCallback(
    async (file: File) => {
      if (file.size > maxBytes) {
        const mb = Math.floor(maxBytes / (1024 * 1024));
        setState((s) => ({
          ...s,
          pending: null,
          outcome: {
            ok: false,
            error: t('eligibility.lenderPolicy.tooLarge', { mb }),
          },
        }));
        return;
      }
      setState((s) => ({
        ...s,
        busy: 'preview',
        pending: null,
        outcome: null,
      }));
      try {
        const read = await readPolicyFile(file);
        const preview = await uploadLenderPolicy(fetchApi, read, true);
        setState((s) => ({
          ...s,
          busy: null,
          pending: { file: read, preview },
        }));
      } catch (err) {
        console.error('Failed to read the lender policy:', err);
        fail(describePolicyError(t, err));
      }
    },
    [fetchApi, t, maxBytes, fail],
  );

  /** Save the file shown: the app's one policy from now on. */
  const save = useCallback(async () => {
    const pending = state.pending;
    if (!pending) return;
    setState((s) => ({ ...s, busy: 'save', outcome: null }));
    try {
      const saved = await uploadLenderPolicy(fetchApi, pending.file, false);
      setState((s) => ({
        ...s,
        busy: null,
        pending: null,
        outcome: { ok: true, done: 'saved' },
        info:
          s.info && saved.current
            ? { ...s.info, current: saved.current }
            : s.info,
      }));
      if (!saved.current) void load();
      onChanged?.();
    } catch (err) {
      // The preview stays: Save can be tried again.
      console.error('Failed to save the lender policy:', err);
      fail(describePolicyError(t, err));
    }
  }, [fetchApi, t, state.pending, onChanged, load, fail]);

  const cancel = useCallback(() => {
    setState((s) => ({ ...s, pending: null, outcome: null }));
  }, []);

  const download = useCallback(async () => {
    setState((s) => ({ ...s, busy: 'download', outcome: null }));
    try {
      const link = await fetchPolicyDownload(fetchApi);
      startDownload(link.url);
      setState((s) => ({ ...s, busy: null }));
    } catch (err) {
      console.error('Failed to download the lender policy:', err);
      fail(
        t('eligibility.lenderPolicy.downloadFailed', {
          message: describePolicyError(t, err),
        }),
      );
    }
  }, [fetchApi, t, fail]);

  const remove = useCallback(async () => {
    setState((s) => ({ ...s, busy: 'remove', outcome: null, pending: null }));
    try {
      await removeLenderPolicy(fetchApi);
      setState((s) => ({
        ...s,
        busy: null,
        outcome: { ok: true, done: 'removed' },
        info: s.info ? { ...s.info, current: null } : s.info,
      }));
      onChanged?.();
    } catch (err) {
      console.error('Failed to remove the lender policy:', err);
      fail(
        t('eligibility.lenderPolicy.removeFailed', {
          message: describePolicyError(t, err),
        }),
      );
    }
  }, [fetchApi, t, onChanged, fail]);

  return { state, load, choose, save, cancel, download, remove };
}

// ------------------------------------------------------------------ view

const MUTED = 'text-[10px] text-slate-500 dark:text-slate-400';
const BOX =
  'rounded-lg border border-white/50 bg-white/30 px-2 py-1.5 dark:border-white/[0.08] dark:bg-white/[0.03]';
const WARN_BOX =
  'space-y-0.5 rounded-lg border border-amber-300 bg-amber-50 px-2 py-1.5 text-[10px] text-amber-900 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-200';
const NEW_BADGE =
  'ml-1 inline-flex rounded-full border border-indigo-200 bg-indigo-50 px-1.5 py-px text-[9px] font-semibold text-indigo-700 dark:border-indigo-800/60 dark:bg-indigo-900/30 dark:text-indigo-300';

function CurrentPolicy({ current }: { current: PolicyStatus | null }) {
  const { t } = useTranslation();
  if (!current) {
    return (
      <p
        className="text-[10px] text-slate-600 dark:text-slate-300"
        data-testid="policy-status"
      >
        {t('eligibility.lenderPolicy.none')}
      </p>
    );
  }
  const uploaded = uploadedText(current.uploaded_at);
  const effective = isoDateText(current.effective_date);
  const until = reuploadByText(current);
  const facts = [
    current.filename ?? t('eligibility.lenderPolicy.unnamed'),
    uploaded && t('eligibility.lenderPolicy.uploadedAt', { time: uploaded }),
    effective
      ? t('eligibility.lenderPolicy.effective', { date: effective })
      : t('eligibility.lenderPolicy.noEffective'),
  ].filter(Boolean);
  return (
    <div className="space-y-0.5" data-testid="policy-status">
      <p className="break-words text-[10px] text-slate-700 dark:text-slate-200">
        <span className="font-semibold">
          {t('eligibility.lenderPolicy.current')}
        </span>{' '}
        {facts.join(' · ')}
        {' · '}
        {until ? (
          <span className="font-medium text-amber-700 dark:text-amber-400">
            {t('eligibility.lenderPolicy.reuploadBy', { date: until })}
          </span>
        ) : (
          <span>{t('eligibility.lenderPolicy.keptUntilReplaced')}</span>
        )}
      </p>
      {current.banks.length > 0 && (
        <p className={MUTED}>
          {t('eligibility.lenderPolicy.banks', {
            banks: current.banks.join(', '),
          })}
        </p>
      )}
      {current.warnings.length > 0 && (
        <details className={MUTED}>
          <summary className="cursor-pointer select-none">
            {t('eligibility.lenderPolicy.toCheck', {
              count: current.warnings.length,
            })}
          </summary>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
            {current.warnings.map((w, i) => (
              <li key={i} className="break-words">
                {w}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function cellsHint(
  t: TFunction,
  parameter: string,
  value: ParameterRow['values'][number],
): string | undefined {
  if (!value.cells.length) return undefined;
  const where = t('eligibility.lenderPolicy.cells', {
    cells: value.cells.join(', '),
  });
  return parameter === 'max_funding' && value.value !== null
    ? `${formatRupees(value.value)} · ${where}`
    : where;
}

/** One bank: its grid (slab × category per parameter) and its Sheet2 rules, collapsed. */
function BankDetails({
  bank,
  categories,
  parameters,
}: {
  bank: PolicyBank;
  categories: PolicyCategory[];
  parameters: [string, string][];
}) {
  const { t } = useTranslation();
  const range = roiRange(bank);
  const first = bank.slabs[0];
  const facts = [
    first &&
      t('eligibility.lenderPolicy.slabs', {
        count: bank.slabs.length,
        from: formatRupees(first.start),
      }),
    range &&
      t('eligibility.lenderPolicy.roiRange', {
        from: formatFoir(range[0]),
        to: formatFoir(range[1]),
      }),
  ].filter(Boolean);
  return (
    <details className={`${BOX} text-[10px]`} data-lender={bank.lender_id}>
      <summary className="cursor-pointer select-none text-slate-700 dark:text-slate-200">
        <span className="font-semibold">{bank.name}</span>
        {bank.new && (
          <span
            className={NEW_BADGE}
            title={t('eligibility.lenderPolicy.newBankHint')}
          >
            {t('eligibility.lenderPolicy.newBank')}
          </span>
        )}
        {facts.length > 0 && (
          <span className="text-slate-500 dark:text-slate-400">
            {` · ${facts.join(' · ')}`}
          </span>
        )}
      </summary>
      <div className="mt-1 space-y-1.5 text-slate-700 dark:text-slate-200">
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-[10px]">
            <caption className="sr-only">
              {t('eligibility.lenderPolicy.caption', { bank: bank.name })}
            </caption>
            <thead>
              <tr>
                <th scope="col" className="pr-2 text-left font-medium">
                  {t('eligibility.lenderPolicy.salary')}
                </th>
                {categories.map((c) => (
                  <th
                    key={c.code}
                    scope="col"
                    className="whitespace-nowrap pr-2 text-right font-medium"
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            {parameters.map(([key, label]) => (
              <tbody key={key} data-parameter={key}>
                <tr>
                  <th
                    scope="rowgroup"
                    colSpan={categories.length + 1}
                    className="pt-1 text-left font-semibold text-slate-600 dark:text-slate-300"
                  >
                    {t(`eligibility.lenderPolicy.parameters.${key}`, {
                      defaultValue: label,
                    })}
                  </th>
                </tr>
                {parameterRows(bank, key, categories).map((row) => (
                  <tr key={row.start ?? 'all'}>
                    <th
                      scope="row"
                      className="whitespace-nowrap pr-2 text-left font-normal"
                    >
                      {row.start === null
                        ? t('eligibility.lenderPolicy.allSlabs')
                        : t('eligibility.lenderPolicy.slabFrom', {
                            amount: formatRupees(row.start),
                          })}
                    </th>
                    {row.values.map((v, i) => (
                      <td
                        key={categories[i].code}
                        className="whitespace-nowrap pr-2 text-right tabular-nums"
                        title={cellsHint(t, key, v)}
                      >
                        {policyValueText(key, v.value)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
        {bank.rules.length > 0 ? (
          <div>
            <p className="font-semibold text-slate-600 dark:text-slate-300">
              {t('eligibility.lenderPolicy.rules')}
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-2">
              {bank.rules.map((rule) => (
                <div key={rule.header} className="contents">
                  <dt className="text-slate-500 dark:text-slate-400">
                    {rule.header}
                  </dt>
                  <dd
                    className="break-words"
                    title={
                      rule.cell
                        ? t('eligibility.lenderPolicy.ruleCell', {
                            cell: rule.cell,
                          })
                        : undefined
                    }
                  >
                    {rule.text || '–'}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ) : (
          <p className={MUTED}>{t('eligibility.lenderPolicy.noRules')}</p>
        )}
      </div>
    </details>
  );
}

export interface PolicyPreviewViewProps {
  preview: PolicyPreview;
  /** The chosen file's name, when the API gives none. */
  filename?: string;
  busy: PolicyBusy | null;
  onSave: () => void;
  onCancel: () => void;
}

/** A read workbook before Save: its warnings, each bank collapsed, Save and Cancel. */
export function PolicyPreviewView({
  preview,
  filename,
  busy,
  onSave,
  onCancel,
}: PolicyPreviewViewProps) {
  const { t } = useTranslation();
  const effective = isoDateText(preview.effective_date);
  return (
    <div className="space-y-1.5" data-testid="policy-preview">
      <p className="break-words text-[11px] font-semibold text-slate-700 dark:text-slate-200">
        {t('eligibility.lenderPolicy.previewTitle', {
          file: preview.filename ?? filename ?? '',
          count: preview.banks.length,
        })}
        {` · ${
          effective
            ? t('eligibility.lenderPolicy.effective', { date: effective })
            : t('eligibility.lenderPolicy.noEffective')
        }`}
      </p>
      {preview.warnings.length > 0 ? (
        <div className={WARN_BOX} data-testid="policy-warnings">
          <p className="flex items-center gap-1 font-semibold">
            <AlertTriangle
              className="h-3 w-3 flex-shrink-0"
              aria-hidden="true"
            />
            {t('eligibility.lenderPolicy.warnings', {
              count: preview.warnings.length,
            })}
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            {preview.warnings.map((w, i) => (
              <li key={i} className="break-words">
                {w}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-[10px] text-green-700 dark:text-green-400">
          {t('eligibility.lenderPolicy.noWarnings')}
        </p>
      )}
      <div className="space-y-1">
        {preview.banks.map((bank) => (
          <BankDetails
            key={bank.lender_id}
            bank={bank}
            categories={preview.categories}
            parameters={preview.parameters}
          />
        ))}
      </div>
      {preview.notes.length > 0 && (
        <ul className={`space-y-0.5 ${MUTED}`} data-testid="policy-notes">
          {preview.notes.map((note, i) => (
            <li key={i} className="break-words">
              {note}
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={onSave}
          disabled={busy !== null}
          className={PRIMARY_CLASS}
        >
          {busy === 'save' && (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          )}
          {t('eligibility.lenderPolicy.save')}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy !== null}
          className={BUTTON_CLASS}
        >
          {t('eligibility.lenderPolicy.cancel')}
        </button>
      </div>
    </div>
  );
}

export interface LenderPolicyCardProps {
  open: boolean;
  onToggle: () => void;
  state: LenderPolicyState;
  onRetry: () => void;
  onChoose: (file: File) => void;
  onSave: () => void;
  onCancel: () => void;
  onDownload: () => void;
  onRemove: () => void;
}

/**
 * "Lender policy (Excel)": one card, closed at first. Its line says which
 * file is used and until when; open, it has the current policy, Choose /
 * Download original / Remove, and a chosen file's preview with Save.
 */
export function LenderPolicyCard({
  open,
  onToggle,
  state,
  onRetry,
  onChoose,
  onSave,
  onCancel,
  onDownload,
  onRemove,
}: LenderPolicyCardProps) {
  const { t } = useTranslation();
  const panelId = useId();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const { info, loading, loadError, busy, pending, outcome } = state;
  const current = info?.current ?? null;
  const until = current ? reuploadByText(current) : null;
  const file = current?.filename ?? t('eligibility.lenderPolicy.unnamed');
  const disabled = busy !== null || !info;
  const icon = (what: PolicyBusy, Icon: LucideIcon) =>
    busy === what ? (
      <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
    ) : (
      <Icon className="h-3 w-3" aria-hidden="true" />
    );
  return (
    <div
      className="space-y-1.5"
      data-testid="lender-policy"
      data-stored={String(!!current)}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex items-center gap-1 text-left text-[11px] font-medium text-indigo-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-300"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
        )}
        {t('eligibility.lenderPolicy.toggle')}
        {info && (
          <span className="font-normal text-slate-500 dark:text-slate-400">
            {` · ${
              !current
                ? t('eligibility.lenderPolicy.summaryNone')
                : until
                  ? t('eligibility.lenderPolicy.summary', { file, date: until })
                  : file
            }`}
          </span>
        )}
      </button>
      {open && (
        <div
          id={panelId}
          className={`space-y-1.5 ${BOX}`}
          aria-busy={loading || busy !== null}
        >
          <p className={MUTED}>
            {t('eligibility.lenderPolicy.intro', {
              days: info?.retention_days ?? DEFAULT_RETENTION_DAYS,
            })}
          </p>
          {loadError != null ? (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-2 text-[11px] text-red-600 dark:text-red-400"
            >
              <span className="break-words">
                {t('eligibility.lenderPolicy.loadFailed', {
                  message: describePolicyError(t, loadError),
                })}
              </span>
              <button type="button" onClick={onRetry} className={BUTTON_CLASS}>
                {t('eligibility.branches.retry')}
              </button>
            </div>
          ) : !info ? (
            <p
              role="status"
              className="flex items-center gap-1 text-[11px] text-slate-500"
            >
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              {t('eligibility.lenderPolicy.loading')}
            </p>
          ) : (
            <>
              <CurrentPolicy current={current} />
              <div className="flex flex-wrap items-center gap-1.5">
                <input
                  id={inputId}
                  ref={inputRef}
                  type="file"
                  accept={XLSX_ACCEPT}
                  className="hidden"
                  data-testid="policy-file"
                  onChange={(e) => {
                    const chosen = e.target.files?.[0];
                    e.target.value = '';
                    if (chosen) onChoose(chosen);
                  }}
                />
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  disabled={disabled}
                  className={BUTTON_CLASS}
                  aria-controls={inputId}
                >
                  {icon('preview', FileUp)}
                  {current
                    ? t('eligibility.lenderPolicy.replace')
                    : t('eligibility.lenderPolicy.choose')}
                </button>
                {current && (
                  <>
                    <button
                      type="button"
                      onClick={onDownload}
                      disabled={disabled}
                      className={BUTTON_CLASS}
                    >
                      {icon('download', Download)}
                      {t('eligibility.lenderPolicy.download')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (
                          window.confirm(
                            t('eligibility.lenderPolicy.removeConfirm'),
                          )
                        ) {
                          onRemove();
                        }
                      }}
                      disabled={disabled}
                      className={BUTTON_CLASS}
                    >
                      {icon('remove', Trash2)}
                      {t('eligibility.lenderPolicy.remove')}
                    </button>
                  </>
                )}
              </div>
              {outcome &&
                (outcome.ok ? (
                  <p
                    role="status"
                    className="text-[10px] text-green-700 dark:text-green-400"
                    data-testid="policy-outcome"
                  >
                    {outcome.done === 'saved'
                      ? t('eligibility.lenderPolicy.saved')
                      : t('eligibility.lenderPolicy.removed')}
                  </p>
                ) : (
                  <p
                    role="alert"
                    className="break-words text-[10px] text-red-600 dark:text-red-400"
                    data-testid="policy-error"
                  >
                    {outcome.error}
                  </p>
                ))}
              {pending && (
                <PolicyPreviewView
                  preview={pending.preview}
                  filename={pending.file.name}
                  busy={busy}
                  onSave={onSave}
                  onCancel={onCancel}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export interface LenderPolicyPanelProps {
  /** After a save or a removal: the banks' policies changed. */
  onChanged?: () => void;
}

function AdminLenderPolicy({ onChanged }: LenderPolicyPanelProps) {
  const { t } = useTranslation();
  const { fetchApi } = useAwsClient();
  const [open, setOpen] = useState(false);
  const policy = useLenderPolicy(fetchApi, t, onChanged);
  const { state, load } = policy;

  // Asked at once: the closed line shows until when the policy is kept.
  useEffect(() => {
    if (!state.info && !state.loading && state.loadError == null) {
      void load();
    }
  }, [state.info, state.loading, state.loadError, load]);

  return (
    <LenderPolicyCard
      open={open}
      onToggle={() => setOpen((o) => !o)}
      state={state}
      onRetry={load}
      onChoose={policy.choose}
      onSave={policy.save}
      onCancel={policy.cancel}
      onDownload={policy.download}
      onRemove={policy.remove}
    />
  );
}

/** "Lender policy (Excel)" for admins; nothing for anyone else (the API refuses them too). */
export default function LenderPolicyPanel(props: LenderPolicyPanelProps) {
  const admin = useIsAdmin();
  return admin ? <AdminLenderPolicy {...props} /> : null;
}
