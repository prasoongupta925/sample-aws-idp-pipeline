import type { TFunction } from 'i18next';
import { apiErrorDetail } from './apiError';
import { apiErrorStatus } from './fileCheck';

/** App roles (Cognito groups); the backend enforces them (app/caller.py). */
export const ROLES = ['admin', 'handler', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export interface PoolUser {
  username: string;
  email: string | null;
  given_name: string | null;
  family_name: string | null;
  status: string;
  enabled: boolean;
  created_at: string | null;
  role: Role | null;
}

export interface PoolUserList {
  users: PoolUser[];
  truncated: boolean;
}

export interface InviteInput {
  email: string;
  given_name: string;
  family_name: string;
  role: Role;
}

export type UserAction = 'disable' | 'enable' | 'reset';

const str = (v: unknown): string | null =>
  typeof v === 'string' && v ? v : null;

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

export function parsePoolUser(raw: unknown): PoolUser | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const username = str(o.username);
  if (!username) return null;
  return {
    username,
    email: str(o.email),
    given_name: str(o.given_name),
    family_name: str(o.family_name),
    status: str(o.status) ?? 'UNKNOWN',
    enabled: o.enabled !== false,
    created_at: str(o.created_at),
    role: isRole(o.role) ? o.role : null,
  };
}

export function parsePoolUserList(raw: unknown): PoolUserList {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const users = Array.isArray(o.users)
    ? o.users.map(parsePoolUser).filter((u): u is PoolUser => u !== null)
    : [];
  return { users, truncated: o.truncated === true };
}

export function displayName(user: PoolUser): string {
  return [user.given_name, user.family_name].filter(Boolean).join(' ');
}

/** Light check before sending; the backend validates the email itself. */
export function inviteProblem(input: InviteInput): 'email' | 'name' | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) return 'email';
  if (!input.given_name.trim() || !input.family_name.trim()) return 'name';
  return null;
}

/** Localized reason a users request failed (the API's detail where it says more). */
export function describeUsersError(t: TFunction, error: unknown): string {
  const status = apiErrorStatus(error);
  const detail = apiErrorDetail(error);
  if (status === null) {
    return error instanceof Error ? error.message : String(error);
  }
  if (status === 403) return t('adminUsers.errors.forbidden');
  if (detail && [400, 404, 409, 422, 429].includes(status)) return detail;
  const message = t('adminUsers.errors.status', { status });
  return detail ? `${message} (${detail})` : message;
}
