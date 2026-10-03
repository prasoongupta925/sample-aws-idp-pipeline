import type { TFunction } from 'i18next';
import { apiErrorDetail } from './apiError';
import { apiErrorStatus } from './fileCheck';

/** Page the Smart Dial CRM opens: /launch?lead=..&name=..&phone=..&exp=..&sig=.. */
export const LAUNCH_PATH = '/launch';

export interface CrmLaunchSettings {
  secret_set: boolean;
  rotated_at: string | null;
  rotated_by: string | null;
  max_lifetime_s: number;
}

export interface CrmLaunchOpenResult {
  project_id: string;
  created: boolean;
  crm_lead_id: string;
}

/** The Cognito groups of the signed-in user (ID token claim cognito:groups). */
export function userGroups(profile: unknown): string[] {
  const groups =
    profile && typeof profile === 'object'
      ? (profile as Record<string, unknown>)['cognito:groups']
      : undefined;
  return Array.isArray(groups)
    ? groups.filter((g): g is string => typeof g === 'string')
    : [];
}

/**
 * Only hides admin pages: the backend checks the groups itself (app/caller.py).
 */
export function isAdmin(profile: unknown): boolean {
  return userGroups(profile).includes('admin');
}

/**
 * Where to come back after the Cognito sign-in: the launch link (with its
 * query) when that is the page being opened, otherwise nothing (the app
 * starts on its home page as before).
 */
export function launchReturnTo(
  pathname: string,
  search: string,
): string | undefined {
  return pathname === LAUNCH_PATH && search.startsWith('?') && search.length > 1
    ? `${LAUNCH_PATH}${search}`
    : undefined;
}

/** The returnTo of the OIDC state if it is a launch link of this app, else null. */
export function safeLaunchReturn(state: unknown): string | null {
  const returnTo =
    state && typeof state === 'object'
      ? (state as Record<string, unknown>).returnTo
      : undefined;
  if (typeof returnTo !== 'string') return null;
  // Same-origin path only: "/launch?" exactly, never "//host" or "/launch.evil".
  return returnTo.startsWith(`${LAUNCH_PATH}?`) && returnTo.length <= 4096
    ? returnTo
    : null;
}

export function parseCrmLaunchSettings(raw: unknown): CrmLaunchSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  return {
    secret_set: o.secret_set === true,
    rotated_at: typeof o.rotated_at === 'string' ? o.rotated_at : null,
    rotated_by: typeof o.rotated_by === 'string' ? o.rotated_by : null,
    max_lifetime_s:
      typeof o.max_lifetime_s === 'number' ? o.max_lifetime_s : 300,
  };
}

/** Localized reason a launch link did not open (the API's detail where it says more). */
export function describeLaunchError(t: TFunction, error: unknown): string {
  const status = apiErrorStatus(error);
  const detail = apiErrorDetail(error);
  if (status === null) {
    return error instanceof Error ? error.message : String(error);
  }
  if (status === 400 && detail) return detail;
  if (status === 403) return t('crmLaunch.errors.forbidden');
  if (status === 409) return t('crmLaunch.errors.notSetUp');
  const message = t('crmLaunch.errors.status', { status });
  return detail ? `${message} (${detail})` : message;
}
