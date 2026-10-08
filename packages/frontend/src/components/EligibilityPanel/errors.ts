import type { TFunction } from 'i18next';
import { apiErrorDetail } from '../../lib/apiError';
import { apiErrorStatus } from '../../lib/fileCheck';

// Status codes of packages/backend/app/routers/eligibility.py: a localized
// message, then the API's reason (e.g. which input was rejected) when it
// gives one.
export function describeEligibilityError(t: TFunction, error: unknown): string {
  const status = apiErrorStatus(error);
  if (status === null) {
    return error instanceof Error ? error.message : String(error);
  }
  const detail = apiErrorDetail(error);
  let message: string;
  if (status === 404) message = t('eligibility.errors.notFound');
  else if (status === 400 || status === 422) {
    message = t('eligibility.errors.invalid');
  } else if (status === 409) message = t('eligibility.errors.conflict');
  else if (status === 429) message = t('eligibility.errors.tooMany');
  else if (status === 503) message = t('eligibility.errors.notConfigured');
  else if (status === 502 || status === 504) {
    message = t('eligibility.errors.unavailable', { status });
  } else {
    message = t('eligibility.errors.status', { status });
  }
  return detail ? `${message} (${detail})` : message;
}

/** The input a request was refused for (422) and why. */
export interface InvalidInput {
  /**
   * The form field: a still-needed field's id ("pincode", "enquiries.d30",
   * "tradelines.2.emi"), "enquiries", "tradelines.2", "other_income.1",
   * "report_date"; null when the answer names none.
   */
  field: string | null;
  /** The backend's own words ("must be a 6-digit pincode"); null otherwise. */
  message: string | null;
}

/** The form field of a FastAPI error location ["body", "inputs", "profile", "pincode"]. */
function formField(loc: unknown): string | null {
  if (!Array.isArray(loc)) return null;
  const path = loc.filter((part) => part !== 'body' && part !== 'inputs');
  const [section, name, index, key] = path;
  const nth = (n: unknown) => (typeof n === 'number' ? n + 1 : null);
  if (section === 'profile' && typeof name === 'string') {
    return name === 'other_income' && nth(index)
      ? `other_income.${nth(index)}`
      : name;
  }
  if (section === 'cibil' && name === 'enquiries') {
    return typeof index === 'string' ? `enquiries.${index}` : 'enquiries';
  }
  if (section === 'cibil' && name === 'tradelines' && nth(index)) {
    return typeof key === 'string'
      ? `tradelines.${nth(index)}.${key}`
      : `tradelines.${nth(index)}`;
  }
  if (section === 'cibil' && typeof name === 'string') return name;
  if (section === 'loan' && name === 'amount') return 'loan_amount';
  if (section === 'loan' && name === 'tenure_months') return name;
  return null;
}

/**
 * A 422 answer's first refused input (FastAPI detail [{loc, msg}]): the form
 * field and the backend's message when it is its own ("Value error, must be
 * a 6-digit pincode"); null for any other error.
 */
export function invalidInput(error: unknown): InvalidInput | null {
  if (apiErrorStatus(error) !== 422) return null;
  const detail = (error as { detail?: unknown } | null)?.detail;
  const first: unknown = Array.isArray(detail) ? detail[0] : null;
  if (!first || typeof first !== 'object') {
    return { field: null, message: null };
  }
  const { loc, msg } = first as { loc?: unknown; msg?: unknown };
  const own =
    typeof msg === 'string' ? /^Value error, (.+)$/s.exec(msg.trim()) : null;
  return { field: formField(loc), message: own ? own[1] : null };
}
