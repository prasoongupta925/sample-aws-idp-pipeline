// The CIBIL tab's "Fetch credit report": a consent-based pull through the
// backend's bureau provider (packages/backend/app/routers/bureau.py). The
// answer is the report's CIBIL block (source 'bureau'); it is put in the form
// like a typed value and saved with the form.
import type { EligibilityCibil, EligibilityInputs } from '../types/eligibility';
import {
  isFutureDate,
  isMaskedPan,
  mobileLooksValid,
  normalizeInputs,
  panLooksValid,
} from './eligibility';

export type ConsentMethod = 'otp' | 'signed_form' | 'recorded_call';

export const CONSENT_METHODS: readonly ConsentMethod[] = [
  'otp',
  'signed_form',
  'recorded_call',
];

export interface BureauStatus {
  /** none, mock (or a provider added later). */
  provider: string;
  /** A pull is possible. */
  enabled: boolean;
  /** The provider returns SAMPLE (synthetic) reports. */
  sample: boolean;
  label: string | null;
  /** Why a pull is not possible. */
  detail: string | null;
}

/** The consent the user records before a pull. */
export interface BureauConsent {
  given: boolean;
  method: ConsentMethod;
  /** OTP request id, form number or call id (optional). */
  reference: string;
}

export interface BureauPull {
  /** False: the bureau has no record for the applicant (no hit). */
  found: boolean;
  provider: string;
  sample: boolean;
  /** The logged consent. */
  consentId: string;
  requestedAt: string | null;
  /** The report's CIBIL block (source 'bureau'); null without a record. */
  cibil: EligibilityCibil | null;
  nameOnReport: string | null;
  notes: string[];
}

export const NO_CONSENT: BureauConsent = {
  given: false,
  method: 'otp',
  reference: '',
};

type FetchApi = <T>(url: string, init?: RequestInit) => Promise<T>;

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function bureauPath(projectId: string): string {
  return `projects/${projectId}/eligibility/bureau`;
}

/** GET .../bureau; anything unexpected reads as "no bureau". */
export function parseBureauStatus(raw: unknown): BureauStatus {
  const o = obj(raw);
  return {
    provider: text(o.provider) ?? 'none',
    enabled: o.enabled === true,
    sample: o.sample === true,
    label: text(o.label),
    detail: text(o.detail),
  };
}

export function parseBureauPull(raw: unknown): BureauPull {
  const o = obj(raw);
  const block = o.cibil && typeof o.cibil === 'object' ? o.cibil : null;
  return {
    found: o.found === true && block !== null,
    provider: text(o.provider) ?? 'none',
    sample: o.sample === true,
    consentId: text(o.consent_id) ?? '',
    requestedAt: text(o.requested_at),
    cibil: block ? normalizeInputs({ cibil: block }).cibil : null,
    nameOnReport: text(o.name_on_report),
    notes: Array.isArray(o.notes)
      ? o.notes.filter((n): n is string => typeof n === 'string' && !!n)
      : [],
  };
}

/** The API's reference format (letters, digits, space . _ / # : -; 64 at most). */
export function consentReferenceLooksValid(value: string): boolean {
  const v = value.trim();
  return v === '' || /^[A-Za-z0-9 ._/#:-]{1,64}$/.test(v);
}

export type PullPan =
  | { pan: string; problem: null }
  | { pan: null; problem: 'missing' | 'mismatch' };

/**
 * The full PAN a pull uses: the form's, else the applicant's (the API calls
 * the applicant by PAN when the verdict has one). The API refuses a form PAN,
 * full or masked, that is not the applicant's ('mismatch'), and a pull
 * without a full PAN ('missing').
 */
export function pullPan(applicant: string, inputs: EligibilityInputs): PullPan {
  const compact = (v: string | null | undefined) =>
    (v ?? '').replace(/\s/g, '').toUpperCase();
  const form = compact(inputs.profile.pan);
  const own = compact(applicant);
  const ownPan = panLooksValid(own) ? own : null;
  if (panLooksValid(form)) {
    return ownPan && ownPan !== form
      ? { pan: null, problem: 'mismatch' }
      : { pan: form, problem: null };
  }
  if (!ownPan) return { pan: null, problem: 'missing' };
  if (isMaskedPan(form) && form.slice(-4) !== ownPan.slice(-4)) {
    return { pan: null, problem: 'mismatch' };
  }
  return { pan: ownPan, problem: null };
}

/**
 * POST .../bureau/fetch body: the consent and the profile's identity values
 * (only those the API accepts: a value it would refuse is left out, so the
 * pull is not refused for a typo in an optional field).
 */
export function bureauPullBody(
  applicant: string,
  inputs: EligibilityInputs,
  consent: BureauConsent,
): Record<string, unknown> {
  const p = inputs.profile;
  const pan = (p.pan ?? '').replace(/\s/g, '').toUpperCase();
  const name = (p.name ?? '').trim();
  const mobile = (p.mobile ?? '').trim();
  const reference = consent.reference.trim();
  return {
    applicant,
    consent: {
      given: consent.given,
      method: consent.method,
      ...(reference ? { reference } : {}),
    },
    ...(panLooksValid(pan) || isMaskedPan(pan) ? { pan } : {}),
    ...(name ? { name: name.slice(0, 200) } : {}),
    ...(p.dob && !isFutureDate(p.dob) ? { dob: p.dob } : {}),
    ...(mobile && mobileLooksValid(mobile) ? { mobile } : {}),
  };
}

export async function fetchBureauStatus(
  fetchApi: FetchApi,
  projectId: string,
): Promise<BureauStatus> {
  return parseBureauStatus(await fetchApi<unknown>(bureauPath(projectId)));
}

export async function pullBureauReport(
  fetchApi: FetchApi,
  projectId: string,
  body: Record<string, unknown>,
): Promise<BureauPull> {
  const raw = await fetchApi<unknown>(`${bureauPath(projectId)}/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseBureauPull(raw);
}

/** The CIBIL block holds something a pull would replace. */
export function cibilHasData(cibil: EligibilityCibil): boolean {
  const e = cibil.enquiries;
  return (
    cibil.score !== null ||
    [e.d30, e.d60, e.d90, e.d120].some((n) => n !== null) ||
    cibil.tradelines.length > 0
  );
}

/**
 * The form with the bureau's CIBIL block in place of the old one (score,
 * enquiries, loans, source and report date); what the documents give stays
 * offered next to it.
 */
export function applyBureauCibil(
  inputs: EligibilityInputs,
  cibil: EligibilityCibil,
): EligibilityInputs {
  return {
    ...inputs,
    cibil: {
      score: cibil.score,
      enquiries: cibil.enquiries,
      tradelines: cibil.tradelines,
      source: cibil.source ?? 'bureau',
      report_date: cibil.report_date ?? null,
      sources: inputs.cibil.sources,
    },
  };
}
