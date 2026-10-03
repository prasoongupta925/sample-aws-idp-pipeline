// @vitest-environment node
import i18next, { type TFunction } from 'i18next';
import en from '../i18n/locales/en.json';
import { ApiError } from './apiError';
import {
  describeLaunchError,
  isAdmin,
  launchParams,
  launchReturnTo,
  parseCrmLaunchSettings,
  safeLaunchReturn,
  takeLaunchParams,
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

describe('the launch link parameters', () => {
  it('reads them from the fragment, never from the query', () => {
    expect(launchParams('#lead=L&exp=1&sig=ab', '')).toEqual({
      params: 'lead=L&exp=1&sig=ab',
    });
    // the old ?query form puts the name and phone in server logs: refused
    expect(launchParams('', '?lead=L&name=Asha%20Verma&exp=1&sig=ab')).toEqual({
      problem: 'queryForm',
    });
    expect(launchParams('', '')).toEqual({ problem: 'missing' });
    expect(launchParams('#', '?')).toEqual({ problem: 'missing' });
  });

  it('takes the fragment out of the address bar once read', () => {
    const calls: unknown[][] = [];
    const state = { __TSR_index: 3 };
    const history = {
      state,
      replaceState: (...args: unknown[]) => {
        calls.push(args);
      },
    };
    const fragment = '#lead=L&name=Asha%20Verma&exp=1&sig=ab';
    expect(
      takeLaunchParams(
        { hash: fragment, pathname: '/launch', search: '' },
        history,
      ),
    ).toEqual({ params: fragment.slice(1) });
    // Same entry and router state, no fragment (name and phone) left.
    expect(calls).toEqual([[state, '', '/launch']]);

    calls.length = 0;
    expect(
      takeLaunchParams(
        { hash: '', pathname: '/launch', search: '?lead=L' },
        history,
      ),
    ).toEqual({ problem: 'queryForm' });
    expect(calls).toEqual([]);
  });

  it('explains both problems', () => {
    expect(t('crmLaunch.errors.missing')).toContain('CRM');
    expect(t('crmLaunch.errors.queryForm')).toContain('#');
  });
});

describe('coming back to a launch link after sign-in', () => {
  it('keeps the launch fragment only', () => {
    expect(launchReturnTo('/launch', '#lead=L&exp=1&sig=ab')).toBe(
      '/launch#lead=L&exp=1&sig=ab',
    );
    expect(launchReturnTo('/launch', '')).toBeUndefined();
    expect(launchReturnTo('/launch', '#')).toBeUndefined();
    expect(launchReturnTo('/launch', '?lead=L')).toBeUndefined();
    expect(launchReturnTo('/projects/p1', '#x=1')).toBeUndefined();
  });

  it('accepts only same-origin launch paths from the OIDC state', () => {
    expect(safeLaunchReturn({ returnTo: '/launch#lead=L' })).toBe(
      '/launch#lead=L',
    );
    for (const bad of [
      '//evil.example/launch#x',
      'https://evil.example/launch#x',
      '/launch.evil#x',
      '/launchx#x',
      '/launch?lead=L',
      '/settings',
      42,
    ]) {
      expect(safeLaunchReturn({ returnTo: bad })).toBeNull();
    }
    expect(safeLaunchReturn(undefined)).toBeNull();
    expect(safeLaunchReturn('/launch#x')).toBeNull();
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
