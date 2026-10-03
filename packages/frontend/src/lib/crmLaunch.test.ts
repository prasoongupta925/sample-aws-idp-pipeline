// @vitest-environment node
import i18next, { type TFunction } from 'i18next';
import en from '../i18n/locales/en.json';
import { ApiError } from './apiError';
import {
  describeLaunchError,
  isAdmin,
  launchReturnTo,
  parseCrmLaunchSettings,
  safeLaunchReturn,
  userGroups,
} from './crmLaunch';

let t: TFunction;

beforeAll(async () => {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  });
  t = i18n.t;
});

describe('roles from the ID token', () => {
  it('reads cognito:groups', () => {
    expect(userGroups({ 'cognito:groups': ['admin', 3, 'viewer'] })).toEqual([
      'admin',
      'viewer',
    ]);
    expect(isAdmin({ 'cognito:groups': ['admin'] })).toBe(true);
    expect(isAdmin({ 'cognito:groups': ['handler'] })).toBe(false);
    expect(isAdmin({ 'cognito:groups': 'admin' })).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
  });
});

describe('coming back to a launch link after sign-in', () => {
  it('keeps the launch query only', () => {
    expect(launchReturnTo('/launch', '?lead=L&exp=1&sig=ab')).toBe(
      '/launch?lead=L&exp=1&sig=ab',
    );
    expect(launchReturnTo('/launch', '')).toBeUndefined();
    expect(launchReturnTo('/launch', '?')).toBeUndefined();
    expect(launchReturnTo('/projects/p1', '?x=1')).toBeUndefined();
  });

  it('accepts only same-origin launch paths from the OIDC state', () => {
    expect(safeLaunchReturn({ returnTo: '/launch?lead=L' })).toBe(
      '/launch?lead=L',
    );
    for (const bad of [
      '//evil.example/launch?x',
      'https://evil.example/launch?x',
      '/launch.evil?x',
      '/launchx?x',
      '/settings',
      42,
    ]) {
      expect(safeLaunchReturn({ returnTo: bad })).toBeNull();
    }
    expect(safeLaunchReturn(undefined)).toBeNull();
    expect(safeLaunchReturn('/launch?x')).toBeNull();
  });
});

describe('settings and errors', () => {
  it('parses the settings defensively', () => {
    expect(
      parseCrmLaunchSettings({ secret_set: true, rotated_at: 'x' }),
    ).toEqual({
      secret_set: true,
      rotated_at: 'x',
      rotated_by: null,
      max_lifetime_s: 300,
    });
    expect(parseCrmLaunchSettings(null).secret_set).toBe(false);
  });

  it('shows the reason of a refused link', () => {
    expect(
      describeLaunchError(
        t,
        new ApiError(
          400,
          'This launch link was already used; open it again from the CRM',
        ),
      ),
    ).toBe('This launch link was already used; open it again from the CRM');
    expect(describeLaunchError(t, new ApiError(409, 'x'))).toContain(
      'not set up yet',
    );
    expect(describeLaunchError(t, new ApiError(403, 'x'))).toContain('Sign in');
    expect(describeLaunchError(t, new ApiError(502, 'kms'))).toBe(
      'The request was rejected (HTTP 502). (kms)',
    );
    expect(describeLaunchError(t, new Error('offline'))).toBe('offline');
  });
});
