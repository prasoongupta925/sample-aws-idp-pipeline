// @vitest-environment node
// "Before you check": the box, and the panel checking the inputs on screen in
// the background with the real useEligibility hook (the API mocked). The DOM
// comes from ../../test/jsdom (the stock jsdom environment cannot start in
// this workspace); it must be imported before react-dom.
import '../../test/jsdom';
import { Profiler, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '../../i18n/locales/en.json';
import EligibilityPanel from '.';
import BeforeYouCheck, { type BeforeYouCheckProps } from './BeforeYouCheck';
import { RefusalHints } from './fields';
import { ENGINE_ANSWERS, engineAnswer } from './precheckFixtures';
import { LENDERS_RESPONSE, NOT_READY_FILE_CHECK } from './fixtures';
import { useEligibility } from '../../hooks/useEligibility';
import {
  emptyInputs,
  parseCalculateResponse,
  precheckSummary,
  refusalsByField,
  setCibil,
  stillNeeded,
} from '../../lib/eligibility';

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  });
  window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noop = () => undefined;

/** An element's text as read: a space between elements, none inside a text run. */
function text(node: Node | null | undefined): string {
  const walk = (n: Node): string =>
    [...n.childNodes]
      .map((c) =>
        c.nodeType === Node.TEXT_NODE ? (c.textContent ?? '') : ` ${walk(c)} `,
      )
      .join('');
  return node ? walk(node).replace(/\s+/g, ' ').trim() : '';
}

// ------------------------------------------------------------------ the box
describe('BeforeYouCheck', () => {
  function box(props: Partial<BeforeYouCheckProps>): string {
    return plain(
      <BeforeYouCheck
        summary={precheckSummary(null, [])}
        checking={false}
        outdated={false}
        waiting={null}
        tab="profile"
        onGo={noop}
        onOpenFileCheck={noop}
        {...props}
      />,
    );
  }
  /** The text an element renders. */
  function plain(element: ReactNode): string {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>{element}</I18nextProvider>,
    );
    return html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }
  const answer = (scenario: keyof typeof ENGINE_ANSWERS, extra = {}) =>
    parseCalculateResponse(engineAnswer(scenario, extra), 'Applicant');

  it('lists what is still needed, the banks that say no, the file and what to confirm', () => {
    const inputs = setCibil(emptyInputs(), { score: 690 });
    const summary = precheckSummary(
      answer('cat_u', {
        file_check: NOT_READY_FILE_CHECK,
        notes: [
          "Loan EMI ₹6,677 to 'BAJAJ FIN' in the bank statement matches no tradeline: it is counted as an obligation; add it as a tradeline (or mark that loan Close) to confirm",
        ],
      }),
      stillNeeded(inputs),
    );
    const shown = box({ summary, tab: 'cibil' });
    expect(shown).toContain(
      'Before you check Fill 5 more details to see which banks can lend.',
    );
    expect(shown).toContain(
      'Still needed: Pincode (Profile) Company (Profile) Employment type (Profile) Net income (Profile) Enquiries (90 days)',
    );
    expect(shown).toContain(
      'Banks that will say no: HDFC Bank, Bandhan Bank: Does not lend to CAT U (unlisted) companies Company',
    );
    expect(shown).toContain(
      'Axis Bank: Pincode 401202 is not serviceable Pincode',
    );
    expect(shown).toContain(
      "File not ready (5 open issues): Open File check MISSING – Last 3 months' salary slips",
    );
    expect(shown).toContain('+3 more in File check');
    expect(shown).toContain(
      "To confirm: Loan EMI ₹6,677 to 'BAJAJ FIN' in the bank statement matches no tradeline",
    );
    // ICICI 15 and IndusInd 14 (Bajaj Finance and Tata Capital have no sheet).
    expect(shown).toContain(
      "29 conditions from your policy sheet (ICICI Bank, Indusind Bank): see each bank's Details on the Lenders tab after Check eligibility.",
    );
  });

  it("marks a sample rule as not the sheet's, in the box and under the field", () => {
    // The engine's Grade 4 answer (the sheet gives no employment types).
    const summary = precheckSummary(answer('grade_4'), []);
    const shown = box({ summary });
    expect(shown).toContain(
      'Banks that will say no: HDFC Bank, ICICI Bank, Axis Bank, Bandhan Bank, Indusind Bank: Employment type Grade 4 is not accepted (Sample: not in your policy sheet) Employment type',
    );
    expect(shown).toContain(
      'Bajaj Finance: Employment type Grade 4 is not accepted Employment type',
    );
    expect(
      plain(
        <RefusalHints
          refusals={refusalsByField(summary.refusals).employment_type}
        />,
      ),
    ).toBe(
      'HDFC Bank, ICICI Bank, Axis Bank, Bandhan Bank, Indusind Bank: Employment type Grade 4 is not accepted (Sample: not in your policy sheet) Bajaj Finance: Employment type Grade 4 is not accepted',
    );
  });

  it('is one line when nothing stops a bank', () => {
    const clear = answer('clear');
    clear.per_lender = clear.per_lender.filter((r) => r.lender !== 'Axis Bank');
    const shown = box({ summary: precheckSummary(clear, []) });
    expect(shown).toBe(
      'Nothing blocking so far: all 6 banks can lend. 61 conditions to confirm on the Lenders tab',
    );
    // Still clear while the next check runs (no flicker on each edit).
    expect(
      box({
        summary: precheckSummary(clear, []),
        outdated: true,
        checking: true,
      }),
    ).toContain('Nothing blocking so far');
    // An answer no check will replace (a value in red) is not.
    expect(
      box({
        summary: precheckSummary(clear, []),
        outdated: true,
        waiting: 'invalid',
      }),
    ).toBe(
      'Before you check 6 of 6 banks can lend so far. Not updated yet: fix the fields marked in red.',
    );
  });

  it('says why nothing is checked yet', () => {
    expect(box({})).toBe(
      'Before you check Fill the details to see which banks can lend.',
    );
    expect(box({ checking: true })).toBe(
      'Before you check Checking the banks…',
    );
    expect(box({ waiting: 'invalid' })).toBe(
      'Before you check Fix the fields marked in red to check the banks again.',
    );
  });
});

// ------------------------------------------------------------------ the panel
const APPLICANT = 'Synthetic Applicant';
const BASE = 'projects/p1/eligibility';

/** Saved inputs of the engine's scenario "cibil_enquiries" (CIBIL 690). */
const SAVED = {
  applicant: APPLICANT,
  saved: true,
  from_documents: [],
  prefill: null,
  notes: [],
  expires_at: '2026-10-15T10:00:00+00:00',
  inputs: {
    profile: {
      pan: null,
      name: APPLICANT,
      pincode: '401202',
      company: 'Synthetic Cat B Works Pvt Ltd',
      employment_type: 'private_limited',
      net_income: 60000,
      other_income: [],
    },
    cibil: {
      score: 690,
      enquiries: { d30: 5, d60: 6, d90: 6, d120: 7 },
      tradelines: [
        {
          loan_type: 'personal',
          lender: 'Mulshi Auto Finance',
          emi: 5000,
          status: 'active',
          action: 'obligate',
        },
      ],
    },
    loan: { amount: 500000, tenure_months: 72 },
  },
};

const EMPTY = {
  ...SAVED,
  saved: false,
  inputs: { profile: {}, cibil: { enquiries: {}, tradelines: [] }, loan: {} },
};

/** Every bank of the scenario "clear" but Axis Bank (its pincodes): all lend. */
function allLend() {
  return engineAnswer('clear', {
    per_lender: ENGINE_ANSWERS.clear.per_lender.filter(
      (r) => r.lender_id !== 'axis_bank',
    ),
    file_check: { ...NOT_READY_FILE_CHECK, verdict: 'READY', ready: true },
  });
}

interface Sent {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

function api(inputs: unknown) {
  const sent: Sent[] = [];
  const fetchApi = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    sent.push({ url, method, body });
    await sleep(5);
    if (url === `${BASE}/lenders`) return LENDERS_RESPONSE;
    if (url.startsWith(`${BASE}/inputs?`)) return inputs;
    if (url === `${BASE}/calculate` && method === 'POST') {
      const score = body?.inputs?.cibil?.score;
      return score === 690
        ? engineAnswer('cibil_enquiries', { file_check: NOT_READY_FILE_CHECK })
        : allLend();
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  const calcs = () =>
    sent.filter((s) => s.url === `${BASE}/calculate` && s.method === 'POST');
  const saves = () => sent.filter((s) => s.method === 'PUT');
  return { fetchApi, sent, calcs, saves };
}

function Harness({
  fetchApi,
  onBack,
}: {
  fetchApi: ReturnType<typeof api>['fetchApi'];
  onBack: () => void;
}) {
  const state = useEligibility({
    fetchApi: fetchApi as unknown as <T>(
      url: string,
      init?: RequestInit,
    ) => Promise<T>,
    projectId: 'p1',
  });
  return (
    <EligibilityPanel
      state={state}
      applicant={APPLICANT}
      name={APPLICANT}
      onBack={onBack}
      onClose={noop}
    />
  );
}

/**
 * The panel on the real scheduler (not act()): a render loop yields between
 * renders instead of hanging the test, and the commits are counted.
 */
async function mount(inputs: unknown) {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  g.IS_REACT_ACT_ENVIRONMENT = false;
  const server = api(inputs);
  const onBack = vi.fn();
  const container = document.body.appendChild(document.createElement('div'));
  const errors: string[] = [];
  const root = createRoot(container, {
    onUncaughtError: (error) => {
      errors.push(String(error));
    },
  });
  let commits = 0;
  const page = (node: ReactNode) => (
    <I18nextProvider i18n={i18n}>
      <Profiler
        id="panel"
        onRender={() => {
          commits += 1;
        }}
      >
        {node}
      </Profiler>
    </I18nextProvider>
  );
  root.render(page(<Harness fetchApi={server.fetchApi} onBack={onBack} />));
  const q = (testId: string) =>
    container.querySelector(`[data-testid="${testId}"]`);
  await until(() => q('before-you-check') !== null);
  return {
    ...server,
    container,
    errors,
    onBack,
    q,
    commits: () => commits,
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
}

async function until(done: () => boolean, timeout = 8000) {
  const start = performance.now();
  while (!done()) {
    if (performance.now() - start > timeout) throw new Error('timed out');
    await sleep(20);
  }
}

/** Types into a text input as a user does (React reads the input event). */
function type(input: Element | null, value: string) {
  if (!(input instanceof HTMLInputElement)) throw new Error('no input');
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function tabButton(container: Element, name: string): HTMLButtonElement {
  const tab = [...container.querySelectorAll('[role="tab"]')].find((b) =>
    text(b).startsWith(
      `${['Profile', 'CIBIL', 'Lenders'].indexOf(name) + 1} ${name}`,
    ),
  );
  if (!(tab instanceof HTMLButtonElement)) throw new Error(`no tab ${name}`);
  return tab;
}

describe('EligibilityPanel: Before you check', () => {
  let panel: Awaited<ReturnType<typeof mount>> | null = null;
  afterEach(() => {
    panel?.unmount();
    panel = null;
  });

  it('checks the saved inputs as the panel opens, and never saves', async () => {
    panel = await mount(SAVED);
    const { q, calcs, saves, container } = panel;
    await until(() =>
      text(q('before-you-check')).includes('Banks that will say no'),
    );
    expect(calcs()).toHaveLength(1);
    expect(calcs()[0].body).toMatchObject({
      applicant: APPLICANT,
      inputs: { cibil: { score: 690 }, profile: { pincode: '401202' } },
    });
    expect(saves()).toEqual([]);
    const shown = text(q('before-you-check'));
    expect(shown).toContain('HDFC Bank: Needs CIBIL >= 710: the score is 690');
    expect(shown).toContain(
      "HDFC Bank: 6 enquiries in the last 60 days: more than the bank's limit of 5",
    );
    expect(shown).toContain('File not ready (5 open issues)');
    // 4 of the 11 refusals, then all of them on demand.
    const refusals = () => q('precheck-refusals')?.querySelectorAll('li');
    expect(refusals()).toHaveLength(4);
    expect(shown).not.toContain('Axis Bank: Pincode 401202 is not serviceable');
    const toggle = q('precheck-refusals-toggle') as HTMLButtonElement;
    expect(text(toggle)).toBe('Show all 11');
    toggle.click();
    await until(() => refusals()?.length === 11);
    expect(text(q('before-you-check'))).toContain(
      'Axis Bank: Pincode 401202 is not serviceable',
    );
    expect(text(toggle)).toBe('Show fewer');
    // Each tab counts what is in the way there.
    expect(text(q('tab-count-profile'))).toBe('1 1 item to look at');
    expect(text(q('tab-count-cibil'))).toBe('10 10 items to look at');
    expect(q('tab-count-lenders')).toBeNull();
    // The pincode's refusal under the pincode.
    expect(text(q('refusal-hints'))).toBe(
      'Axis Bank: Pincode 401202 is not serviceable',
    );
    // Check eligibility's own result is not touched: nothing calculated yet.
    tabButton(container, 'Lenders').click();
    await until(() =>
      text(container).includes('No eligibility calculated yet'),
    );
    expect(text(q('before-you-check'))).toContain('Banks that will say no');
    // "Open File check" goes back to File Check.
    const open = [...container.querySelectorAll('button')].find(
      (b) => text(b) === 'Open File check',
    );
    open?.click();
    expect(panel.onBack).toHaveBeenCalledTimes(1);
  });

  it('checks again once a second after the typing stops', async () => {
    panel = await mount(SAVED);
    const { q, calcs, saves, container } = panel;
    await until(
      () =>
        calcs().length === 1 &&
        text(q('before-you-check')).includes('Banks that will say no'),
    );
    tabButton(container, 'CIBIL').click();
    await until(() => q('cibil-score') !== null);
    // The CIBIL tab shows the score's refusals under it: 3 of the 7 banks.
    expect(text(q('refusal-hints'))).toBe(
      'HDFC Bank: Needs CIBIL >= 710: the score is 690 ICICI Bank: Needs CIBIL >= 720: the score is 690 Axis Bank: Needs CIBIL >= 750: the score is 690 +4 more in Before you check',
    );
    type(q('cibil-score'), '7');
    type(q('cibil-score'), '79');
    type(q('cibil-score'), '790');
    await sleep(600);
    expect(calcs()).toHaveLength(1);
    expect(text(q('precheck-checking'))).toBe('Checking the banks…');
    await until(() => calcs().length === 2);
    expect(calcs()[1].body).toMatchObject({
      inputs: { cibil: { score: 790 } },
    });
    await until(() =>
      text(q('before-you-check')).startsWith('Nothing blocking so far'),
    );
    expect(text(q('before-you-check'))).toBe(
      'Nothing blocking so far: all 6 banks can lend. 61 conditions to confirm on the Lenders tab',
    );
    expect(q('refusal-hints')).toBeNull();
    expect(q('tab-count-cibil')).toBeNull();

    // A field no bank reads: no check; the same inputs again: none either.
    tabButton(container, 'Profile').click();
    await until(() => q('profile-name') !== null);
    type(q('profile-name'), 'Synthetic Applicant Two');
    await sleep(1500);
    expect(calcs()).toHaveLength(2);
    expect(saves()).toEqual([]);
  });

  it('waits for something to check, and for the fields in red', async () => {
    panel = await mount(EMPTY);
    const { q, calcs, container } = panel;
    expect(text(q('before-you-check'))).toContain(
      'Fill 6 more details to see which banks can lend.',
    );
    // Half a pincode (in red): nothing is sent.
    type(q('profile-pincode'), '4110');
    await sleep(1300);
    expect(calcs()).toEqual([]);
    expect(text(q('before-you-check'))).toBe(
      'Before you check Fill 5 more details to see which banks can lend. Hide Still needed: Company Employment type Net income CIBIL score (CIBIL) Enquiries (90 days) (CIBIL)',
    );
    type(q('profile-pincode'), '411045');
    // The first check of the panel goes at once.
    await until(() => calcs().length === 1);
    await until(() => !text(q('before-you-check')).includes('Checking'));
    // The still-needed list moves to a field on another tab.
    const score = [
      ...container.querySelectorAll('[data-testid="precheck-needed"] button'),
    ].find((b) => text(b) === 'CIBIL score');
    (score as HTMLButtonElement).click();
    await until(() => q('cibil-score') !== null);
    expect(document.activeElement).toBe(q('cibil-score'));
  });

  it('keeps the explicit Check eligibility as it was, and uses its result', async () => {
    panel = await mount(SAVED);
    const { q, calcs, saves, container } = panel;
    await until(
      () =>
        calcs().length === 1 &&
        text(q('before-you-check')).includes('Banks that will say no'),
    );
    const check = [...container.querySelectorAll('button')].find(
      (b) => text(b) === 'Check eligibility',
    ) as HTMLButtonElement;
    check.click();
    await until(() => calcs().length === 2);
    await until(
      () => container.querySelector('[data-testid="lenders-table"]') !== null,
    );
    // The result is for the inputs on screen: no background check follows,
    // nor after a field no bank reads (the name) changes.
    await sleep(1500);
    expect(calcs()).toHaveLength(2);
    expect(text(q('before-you-check'))).toContain('Banks that will say no');
    tabButton(container, 'Profile').click();
    await until(() => q('profile-name') !== null);
    type(q('profile-name'), 'Synthetic Applicant Two');
    await sleep(1500);
    expect(calcs()).toHaveLength(2);
    expect(text(q('before-you-check'))).toContain('Banks that will say no');
    // A score typed: checked in the background; Check eligibility's result
    // shows meanwhile (it is the latest), not the older background one.
    tabButton(container, 'CIBIL').click();
    await until(() => q('cibil-score') !== null);
    type(q('cibil-score'), '790');
    expect(text(q('before-you-check'))).toContain('Banks that will say no');
    await until(() => calcs().length === 3);
    await until(() =>
      text(q('before-you-check')).startsWith('Nothing blocking so far'),
    );
    expect(saves()).toEqual([]);
  });

  it('settles: no render loop while the background check updates', async () => {
    panel = await mount(SAVED);
    const { q, calcs, commits, errors, container } = panel;
    // Loaded, checked and quiet for a second.
    let last = commits();
    let quietSince = performance.now();
    const start = performance.now();
    while (performance.now() - start < 10000) {
      await sleep(100);
      if (commits() !== last) {
        last = commits();
        quietSince = performance.now();
      } else if (
        calcs().length === 1 &&
        text(q('before-you-check')).includes('Banks that will say no') &&
        performance.now() - quietSince >= 1000
      ) {
        break;
      }
    }
    const settled = commits();
    expect(settled).toBeLessThan(40);
    await sleep(1500);
    expect(commits()).toBe(settled);
    expect(calcs()).toHaveLength(1);

    // An edit: one more check, then quiet again.
    tabButton(container, 'CIBIL').click();
    await until(() => q('cibil-score') !== null);
    type(q('cibil-score'), '790');
    await until(() =>
      text(q('before-you-check')).startsWith('Nothing blocking'),
    );
    const after = commits();
    expect(after - settled).toBeLessThan(25);
    await sleep(1500);
    expect(commits()).toBe(after);
    expect(calcs()).toHaveLength(2);
    expect(errors).toEqual([]);
  });
});
