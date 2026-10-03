// @vitest-environment node
// (Rendered to static markup: the workspace's jsdom install cannot start.
// Effects do not run, so each state is rendered through BureauFetchView and
// the requests are tested in lib/bureau.test.ts.)
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18next, { type TFunction } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '../../i18n/locales/en.json';
import { ApiError } from '../../lib/apiError';
import {
  NO_CONSENT,
  parseBureauPull,
  type BureauConsent,
  type BureauStatus,
} from '../../lib/bureau';
import {
  emptyInputs,
  inputsKey,
  parseInputsResponse,
} from '../../lib/eligibility';
import { newDraft, type EligibilityState } from '../../hooks/useEligibility';
import type { EligibilityInputs } from '../../types/eligibility';
import EligibilityPanel from '.';
import { BureauFetchView, describeBureauError } from './BureauFetch';
import { RAHUL_PULL_RESPONSE } from './bureauFixtures';
import { SAVED_INPUTS_RESPONSE } from './fixtures';

vi.mock('../../hooks/useAwsClient', () => ({
  useAwsClient: () => ({ fetchApi: async () => undefined }),
}));

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  });
});

const t: TFunction = ((key: string, options?: Record<string, unknown>) =>
  i18n.t(key, options)) as TFunction;

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>{node}</I18nextProvider>,
  );
}

/** Text of an HTML fragment, tags stripped and entities decoded. */
function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The opening tag of the element with this data-testid. */
function tag(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  if (at < 0) throw new Error(`${testId} not rendered`);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

const noop = () => undefined;
const RAHUL_PAN = 'BQXPD4821K';
const NONE: BureauStatus = {
  provider: 'none',
  enabled: false,
  sample: false,
  label: 'No bureau connected',
  detail: 'No credit bureau is connected',
};
const MOCK: BureauStatus = {
  provider: 'mock',
  enabled: true,
  sample: true,
  label: 'Mock bureau',
  detail: null,
};
const CONSENTED: BureauConsent = { ...NO_CONSENT, given: true };

function view(
  props: Partial<Parameters<typeof BureauFetchView>[0]> = {},
): string {
  return render(
    <BureauFetchView
      status={MOCK}
      applicant={RAHUL_PAN}
      inputs={emptyInputs()}
      consent={NO_CONSENT}
      onConsent={noop}
      pulling={false}
      onPull={noop}
      {...props}
    />,
  );
}

function withPan(pan: string): EligibilityInputs {
  const inputs = emptyInputs();
  return { ...inputs, profile: { ...inputs.profile, pan } };
}

describe('Fetch credit report', () => {
  it('is disabled with the reason when no bureau is connected', () => {
    const html = view({ status: NONE, consent: CONSENTED });
    expect(tag(html, 'bureau-fetch')).toContain('data-provider="none"');
    expect(tag(html, 'bureau-pull')).toContain(' disabled=""');
    expect(tag(html, 'bureau-pull')).toContain('aria-describedby');
    expect(plain(html)).toContain('Fetch credit report');
    expect(plain(html)).toContain(
      'No credit bureau is connected, so a report cannot be fetched here.',
    );
    // No consent is asked for a pull that cannot happen.
    expect(html).not.toContain('data-testid="bureau-consent"');
    expect(html).not.toContain('data-testid="bureau-sample"');
  });

  it('says when the connection could not be checked', () => {
    const html = view({
      status: null,
      statusError: new ApiError(502, 'Bad gateway'),
    });
    expect(tag(html, 'bureau-pull')).toContain(' disabled=""');
    expect(plain(html)).toContain(
      'The credit bureau connection could not be checked: The credit bureau did not answer (Bad gateway)',
    );
  });

  it('shows no button while the connection is checked', () => {
    const html = view({ status: null });
    expect(html).not.toContain('data-testid="bureau-pull"');
    expect(plain(html)).toContain('Checking the credit bureau connection');
  });

  it('asks for the consent first (mock bureau: SAMPLE reports)', () => {
    const html = view();
    expect(html).toContain('data-testid="bureau-sample"');
    expect(plain(html)).toContain('SAMPLE reports');
    expect(tag(html, 'bureau-consent')).not.toContain(' checked=""');
    expect(tag(html, 'bureau-pull')).toContain(' disabled=""');
    expect(plain(html)).toContain('Tick the consent box to fetch the report.');
    expect(plain(html)).toContain('OTP to the applicant');
    expect(plain(html)).toContain('Signed consent form');
    expect(plain(html)).toContain('Recorded call');
    expect(plain(html)).toContain('PAN XXXXXX821K');
    expect(html).not.toContain(RAHUL_PAN);
  });

  it('pulls once the consent is ticked', () => {
    const html = view({ consent: CONSENTED });
    expect(tag(html, 'bureau-consent')).toContain(' checked=""');
    expect(tag(html, 'bureau-pull')).not.toContain(' disabled=""');
    expect(html).not.toContain('data-testid="bureau-reason"');
  });

  it('needs the applicant’s full PAN', () => {
    const missing = view({ applicant: 'Rahul', consent: CONSENTED });
    expect(tag(missing, 'bureau-pull')).toContain(' disabled=""');
    expect(plain(missing)).toContain(
      "A pull needs the applicant's full PAN: enter it on the Profile tab.",
    );
    const other = view({ inputs: withPan('CKRPK7314M'), consent: CONSENTED });
    expect(tag(other, 'bureau-pull')).toContain(' disabled=""');
    expect(plain(other)).toContain(
      "The PAN on the Profile tab is not this applicant's",
    );
    const typed = view({
      applicant: 'Rahul',
      inputs: withPan(RAHUL_PAN),
      consent: CONSENTED,
    });
    expect(tag(typed, 'bureau-pull')).not.toContain(' disabled=""');
  });

  it('refuses a consent reference the API would refuse', () => {
    const html = view({
      consent: { ...CONSENTED, reference: 'otp 1234, call me' },
    });
    expect(tag(html, 'bureau-pull')).toContain(' disabled=""');
    expect(html).toContain('aria-invalid="true"');
  });

  it('shows the pull in progress', () => {
    const html = view({ consent: CONSENTED, pulling: true });
    expect(tag(html, 'bureau-pull')).toContain(' disabled=""');
    expect(plain(html)).toContain('Fetching…');
  });

  it('shows the report fetched, the logged consent and the notes', () => {
    const html = view({
      result: {
        pull: parseBureauPull(RAHUL_PULL_RESPONSE),
        at: new Date(2026, 9, 3, 11, 5),
      },
    });
    expect(tag(html, 'bureau-result')).toContain('data-found="true"');
    expect(tag(html, 'bureau-result')).toContain('role="status"');
    const text = plain(html);
    expect(text).toMatch(/Report fetched at 11:05/);
    expect(text).toContain('Consent logged (3f2a9c1e).');
    expect(text).toContain('SAMPLE report of the mock bureau (synthetic data)');
  });

  it('says when the bureau has no record', () => {
    const html = view({
      result: {
        pull: parseBureauPull({
          found: false,
          provider: 'mock',
          consent_id: 'abcdef0123456789',
          notes: ['The bureau has no record for PAN XXXXXX926L'],
        }),
        at: new Date(2026, 9, 3, 11, 5),
      },
    });
    expect(tag(html, 'bureau-result')).toContain('data-found="false"');
    expect(plain(html)).toContain(
      'The bureau has no record for this applicant',
    );
    expect(plain(html)).toContain('Consent logged (abcdef01).');
  });

  it('shows why a pull failed', () => {
    const html = view({
      consent: CONSENTED,
      error: new ApiError(429, 'wait 7 s'),
    });
    expect(tag(html, 'bureau-error')).toContain('role="alert"');
    expect(plain(html)).toContain(
      'The report was just pulled: wait a few seconds (wait 7 s)',
    );
  });
});

describe('bureau errors', () => {
  it('names each API status', () => {
    expect(describeBureauError(t, new ApiError(503))).toBe(
      'No credit bureau is connected',
    );
    expect(describeBureauError(t, new ApiError(400, 'no consent'))).toBe(
      'The pull was refused (no consent)',
    );
    expect(describeBureauError(t, new ApiError(422))).toBe(
      'The pull was refused',
    );
    expect(describeBureauError(t, new ApiError(404))).toBe('Project not found');
    expect(describeBureauError(t, new ApiError(504))).toBe(
      'The credit bureau did not answer',
    );
    expect(describeBureauError(t, new ApiError(500))).toBe(
      'The pull failed (HTTP 500)',
    );
    expect(describeBureauError(t, new Error('offline'))).toBe('offline');
  });
});

describe('the CIBIL tab', () => {
  const state = (drafts: EligibilityState['drafts']): EligibilityState => ({
    lenders: null,
    lendersLoading: false,
    lendersError: null,
    loadLenders: async () => undefined,
    drafts,
    load: async () => undefined,
    edit: noop,
    save: async () => true,
    calculate: async () => null,
    login: async () => ({ kind: 'ignored' }),
    checkPincode: async () => {
      throw new Error('not used');
    },
    checkCompany: async () => {
      throw new Error('not used');
    },
    forget: noop,
  });

  it('starts with Fetch credit report in a project', () => {
    const parsed = parseInputsResponse(
      SAVED_INPUTS_RESPONSE,
      'Sneha Anil Kulkarni',
    );
    const draft = {
      ...newDraft('CKRPK7314M'),
      loaded: true,
      inputs: parsed.inputs,
      savedKey: inputsKey(parsed.inputs),
      saved: true,
    };
    const panel = (projectId?: string, tab: 'cibil' | 'profile' = 'cibil') =>
      render(
        <EligibilityPanel
          state={state({ CKRPK7314M: draft })}
          projectId={projectId}
          applicant="CKRPK7314M"
          name="Sneha Anil Kulkarni"
          pan="CKRPK7314M"
          onBack={noop}
          onClose={noop}
          initialTab={tab}
        />,
      );
    const html = panel('proj-1');
    expect(html).toContain('data-testid="bureau-fetch"');
    expect(html.indexOf('data-testid="bureau-fetch"')).toBeLessThan(
      html.indexOf('data-testid="bureau-note"'),
    );
    expect(panel(undefined)).not.toContain('data-testid="bureau-fetch"');
    expect(panel('proj-1', 'profile')).not.toContain(
      'data-testid="bureau-fetch"',
    );
  });
});
