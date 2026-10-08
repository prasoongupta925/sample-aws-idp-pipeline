// @vitest-environment node
// "Before you check": the box, and the panel checking the inputs on screen in
// the background with the real useEligibility hook (the API mocked). The DOM
// comes from ../../test/jsdom (the stock jsdom environment cannot start in
// this workspace); it must be imported before react-dom.
import '../../test/jsdom';
import { Profiler, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
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
import type { FetchApiOptions } from '../../hooks/useAwsClient';
import { ApiError } from '../../lib/apiError';
import {
  emptyInputs,
  parseCalculateResponse,
  precheckKey,
  precheckKeyInputs,
  precheckSummary,
  refusalsByField,
  setCibil,
  setEnquiries,
  setProfile,
  stillNeeded,
} from '../../lib/eligibility';
import type { EligibilityInputs } from '../../types/eligibility';

// The Lenders tab's branch finder, as a button that says a policy sheet or a
// company list was saved (its own tests cover when it does).
vi.mock('./BranchFinder', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ onPolicyChanged }: { onPolicyChanged?: () => void }) =>
      createElement(
        'button',
        {
          type: 'button',
          onClick: onPolicyChanged,
          'data-testid': 'policy-changed',
        },
        'A new company list was saved',
      ),
  };
});

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

/** An element's text as one run (no space added between elements). */
function run(node: Element | null | undefined): string {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** The form of his 7 Oct check: all filled but the pincode (CIBIL 722, an unlisted employer). */
function sessionInputs(): EligibilityInputs {
  const inputs = setProfile(emptyInputs(), {
    company: 'Unheard Of Traders Pvt Ltd',
    employment_type: 'private_limited',
    net_income: 60000,
  });
  return setEnquiries(setCibil(inputs, { score: 722 }), {
    d30: 0,
    d60: 1,
    d90: 2,
    d120: 3,
  });
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
  const UNMATCHED =
    "Loan EMI ₹6,677 to 'BAJAJ FIN' in the bank statement matches no tradeline: it is counted as an obligation; add it as a tradeline (or mark that loan Close) to confirm";
  const OVERDUE =
    'Tradeline 1 (Axis Bank, Personal Loan) has an overdue of ₹4,500: lenders usually decline a file with overdues until they are cleared';

  it('leads with the next step and says what each empty field blocks (his 7 Oct check)', () => {
    const inputs = sessionInputs();
    const summary = precheckSummary(answer('session'), stillNeeded(inputs), {
      inputs,
    });
    const shown = box({ summary });
    expect(shown).toContain(
      'Before you check 0 of 7 banks can lend now. Enter the Pincode: ICICI Bank and Bajaj Finance need only that.',
    );
    expect(shown).toContain(
      'Still needed: Pincode : all 7 banks need it. ICICI Bank and Bajaj Finance need only this.',
    );
    // Nothing hidden behind "+1 more": the three banks on one line.
    expect(shown).toContain(
      'Banks that will say no: CIBIL 722 is below the minimum at Axis Bank (750), Tata Capital (725), Indusind Bank (725)',
    );
    expect(shown).toContain(
      'No loans to CAT U (unlisted) companies at HDFC Bank , Bandhan Bank',
    );
  });

  it('keeps "in the documents" on a field a document holds', () => {
    const inputs = sessionInputs();
    const sources = {
      pincode: {
        source: 'document' as const,
        value: '411045',
        documents: [],
        detail: null,
        unverified: false,
      },
    };
    const summary = precheckSummary(
      answer('session'),
      stillNeeded(inputs, sources),
      { inputs },
    );
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <BeforeYouCheck
          summary={summary}
          checking={false}
          outdated={false}
          waiting={null}
          tab="cibil"
          onGo={noop}
        />
      </I18nextProvider>,
    );
    expect(plain(<div dangerouslySetInnerHTML={{ __html: html }} />)).toContain(
      'Pincode (Profile) : all 7 banks need it. ICICI Bank and Bajaj Finance need only this. in the documents',
    );
    expect(html).toContain('data-testid="needed-in-documents"');
    expect(html).toContain(
      'title="A document holds a value for this field: use Fill from the documents, or Use under the field."',
    );
  });

  it('names more fields, all banks, and drops a field no bank asks for', () => {
    // The empty form: every bank waits for the same 5 fields only.
    const empty = setCibil(emptyInputs(), { score: 765 });
    const missing = precheckSummary(answer('missing'), stillNeeded(empty), {
      inputs: empty,
    });
    const shown = box({ summary: missing });
    expect(shown).toContain(
      '0 of 7 banks can lend now. Fill the 5 details below: all 7 banks need only those.',
    );
    expect(shown).toContain('Pincode : all 7 banks need it.');
    // A field the answer saw empty and no bank asks for (a salary the file
    // check verified): not still needed, and never "no bank needs it".
    const net = setProfile(sessionInputs(), {
      pincode: '401202',
      net_income: null,
    });
    const verified = precheckSummary(answer('cat_u'), stillNeeded(net), {
      inputs: net,
      answered: net,
    });
    expect(box({ summary: verified })).toBe(
      'Before you check 4 of 7 banks can lend now. Hide Banks that will say no: No loans to CAT U (unlisted) companies at HDFC Bank , Bandhan Bank Company Pincode 401202 is not serviceable by Axis Bank Pincode To check by hand (29)',
    );
    // An answer that saw it filled says nothing about it: listed, no words.
    const before = precheckSummary(answer('cat_u'), stillNeeded(net), {
      inputs: net,
      answered: setProfile(net, { net_income: 60000 }),
    });
    expect(box({ summary: before, outdated: true })).toContain(
      'Still needed: Net income Banks that will say no',
    );
    expect(box({ summary: before })).not.toContain('no bank needs it');
  });

  it('reaches the all-clear line when the only empty field is one no bank asks for (a verified salary)', () => {
    const clear = answer('clear');
    clear.per_lender = clear.per_lender.filter((r) => r.lender !== 'Axis Bank');
    const inputs = setProfile(sessionInputs(), {
      pincode: '401202',
      company: 'Synthetic Cat B Works Pvt Ltd',
      net_income: null,
    });
    // As the panel has it: the inputs the answer saw, from its key.
    const answered = precheckKeyInputs(precheckKey('Applicant', inputs));
    const summary = precheckSummary(clear, stillNeeded(inputs), {
      inputs,
      answered,
    });
    expect(box({ summary })).toBe(
      "Nothing blocking so far: all 6 banks can lend. 61 conditions to confirm after Check eligibility, in each bank's Details",
    );
  });

  it('keeps the order: fill now, upload, banks that will say no, likely refusals, then to check by hand (collapsed)', () => {
    const inputs = sessionInputs();
    const summary = precheckSummary(
      answer('session', {
        file_check: NOT_READY_FILE_CHECK,
        notes: [UNMATCHED, OVERDUE],
      }),
      stillNeeded(inputs),
      { inputs },
    );
    const shown = box({ summary, tab: 'cibil' });
    const at = (part: string) => {
      const i = shown.indexOf(part);
      expect(i, part).toBeGreaterThan(-1);
      return i;
    };
    expect(at('Still needed:')).toBeLessThan(at('File not ready'));
    expect(at('File not ready')).toBeLessThan(at('Banks that will say no'));
    expect(at('Banks that will say no')).toBeLessThan(at('Likely refusals:'));
    expect(at('Likely refusals:')).toBeLessThan(at('To check by hand (1)'));
    expect(shown).toContain(
      "File not ready (5 open issues): Open File check MISSING – Last 3 months' salary slips",
    );
    expect(shown).toContain('+3 more in File check');
    // Shown: an overdue is a likely refusal, not something to look up later.
    expect(shown).toContain(`Likely refusals: ${OVERDUE}`);
    // Collapsed: the bank EMI that matches no loan is behind "To check by hand".
    expect(shown).not.toContain('matches no tradeline');
  });

  it("marks a sample rule as not the sheet's, in the box and under the field", () => {
    // The engine's Grade 4 answer (the sheet gives no employment types).
    const summary = precheckSummary(answer('grade_4'), []);
    const shown = box({ summary });
    expect(shown).toContain(
      'Banks that will say no: Employment type Grade 4 is not accepted by HDFC Bank , ICICI Bank , Axis Bank , Bandhan Bank , Indusind Bank (Sample: not in your policy sheet) Employment type',
    );
    expect(shown).toContain(
      'Employment type Grade 4 is not accepted by Bajaj Finance Employment type',
    );
    expect(
      plain(
        <RefusalHints
          refusals={refusalsByField(summary.refusals).employment_type}
        />,
      ),
    ).toBe(
      'Employment type Grade 4 is not accepted by HDFC Bank , ICICI Bank , Axis Bank , Bandhan Bank , Indusind Bank (Sample: not in your policy sheet) Employment type Grade 4 is not accepted by Bajaj Finance',
    );
  });

  it('shows at most 5 refusal lines, then "Show all N"', () => {
    const rows = ENGINE_ANSWERS.cibil_enquiries.per_lender.map((row) =>
      row.lender_id === 'bandhan_bank'
        ? {
            ...row,
            reasons: [
              ...(row.reasons as string[]),
              'Employment type Grade 4 is not accepted by Bandhan Bank (Sample: not in your policy sheet)',
            ],
          }
        : row,
    );
    const summary = precheckSummary(answer('clear', { per_lender: rows }), []);
    expect(summary.refusals).toHaveLength(6);
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <BeforeYouCheck
          summary={summary}
          checking={false}
          outdated={false}
          waiting={null}
          tab="profile"
          onGo={noop}
        />
      </I18nextProvider>,
    );
    const group = html.slice(html.indexOf('data-testid="precheck-refusals"'));
    expect(group.match(/<li /g)).toHaveLength(5);
    expect(plain(<div dangerouslySetInnerHTML={{ __html: group }} />)).toMatch(
      /Show all 6$/,
    );
  });

  it('is one line when nothing stops a bank', () => {
    const clear = answer('clear');
    clear.per_lender = clear.per_lender.filter((r) => r.lender !== 'Axis Bank');
    const shown = box({ summary: precheckSummary(clear, []) });
    // Before Check eligibility: no Lenders tab to look at yet.
    expect(shown).toBe(
      "Nothing blocking so far: all 6 banks can lend. 61 conditions to confirm after Check eligibility, in each bank's Details",
    );
    // Check eligibility's own answer: its Details are on the Lenders tab.
    expect(box({ summary: precheckSummary(clear, []), checked: true })).toBe(
      "Nothing blocking so far: all 6 banks can lend. 61 conditions to confirm in each bank's Details on the Lenders tab",
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
      'Before you check 6 of 6 banks can lend now. Not updated yet: fix the fields marked in red.',
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

  it('says when the banks could not be checked, names a refused field, and keeps the last answer', () => {
    expect(box({ failed: true, error: new ApiError(503) })).toBe(
      'Before you check Could not check the banks just now. Try again',
    );
    const pincode = new ApiError(422, [
      {
        type: 'value_error',
        loc: ['body', 'inputs', 'profile', 'pincode'],
        msg: 'Value error, must be a 6-digit pincode',
        input: '4110',
      },
    ]);
    expect(box({ failed: true, error: pincode })).toBe(
      'Before you check Could not check the banks: Pincode was not accepted (must be a 6-digit pincode). Try again',
    );
    const emi = new ApiError(422, [
      {
        type: 'less_than_equal',
        loc: ['body', 'inputs', 'cibil', 'tradelines', 1, 'emi'],
        msg: 'Input should be less than or equal to 1000000000',
      },
    ]);
    expect(box({ failed: true, error: emi })).toContain(
      'Could not check the banks: EMI of loan 2 was not accepted.',
    );
    // The last good answer stays, marked as possibly out of date.
    const inputs = sessionInputs();
    const summary = precheckSummary(answer('session'), stillNeeded(inputs), {
      inputs,
    });
    const shown = box({ summary, outdated: true, failed: true });
    expect(shown).toContain(
      'Before you check 0 of 7 banks can lend now. Enter the Pincode: ICICI Bank and Bajaj Finance need only that. Try again',
    );
    expect(shown).toContain(
      'Could not check the banks just now. The answer below may be out of date.',
    );
    expect(shown).toContain('Banks that will say no');
  });
});

// ------------------------------------------------------------------ the box in the DOM
describe('BeforeYouCheck: what the box does', () => {
  function render(props: Partial<BeforeYouCheckProps>) {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    g.IS_REACT_ACT_ENVIRONMENT = false;
    const container = document.body.appendChild(document.createElement('div'));
    const root = createRoot(container);
    const draw = (more: Partial<BeforeYouCheckProps> = {}) =>
      flushSync(() =>
        root.render(
          <I18nextProvider i18n={i18n}>
            <BeforeYouCheck
              summary={precheckSummary(null, [])}
              checking={false}
              outdated={false}
              waiting={null}
              tab="profile"
              onGo={noop}
              {...props}
              {...more}
            />
          </I18nextProvider>,
        ),
      );
    draw();
    return {
      container,
      draw,
      q: (testId: string) =>
        container.querySelector(`[data-testid="${testId}"]`),
      unmount: () => {
        root.unmount();
        container.remove();
      },
    };
  }

  it('opens "To check by hand" on demand', async () => {
    const summary = precheckSummary(
      parseCalculateResponse(
        engineAnswer('session', {
          notes: [
            "Loan EMI ₹6,677 to 'BAJAJ FIN' in the bank statement matches no tradeline: it is counted as an obligation; add it as a tradeline (or mark that loan Close) to confirm",
          ],
        }),
        'Applicant',
      ),
      [],
    );
    const shown = render({ summary });
    const toggle = shown.q('precheck-confirm-toggle') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(run(shown.q('precheck-confirm'))).toBe('To check by hand (1)');
    toggle.click();
    await sleep(0);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(run(shown.q('precheck-confirm'))).toContain(
      "Loan EMI ₹6,677 to 'BAJAJ FIN' in the bank statement matches no tradeline",
    );
    shown.unmount();
  });

  it('shows an overdue and a written-off loan as likely refusals, open, with the refusals', () => {
    const overdue =
      'Tradeline 1 (Axis Bank, Personal Loan) has an overdue of ₹4,500: lenders usually decline a file with overdues until they are cleared';
    const writtenOff =
      "Tradeline 2 (Sample Finance, Personal Loan) is 'Written off' on the bureau report: lenders usually decline such files";
    const summary = precheckSummary(
      parseCalculateResponse(
        engineAnswer('session', { notes: [overdue, writtenOff] }),
        'Applicant',
      ),
      [],
    );
    const shown = render({ summary });
    // No toggle to open first: both lines are there.
    expect(run(shown.q('precheck-declines'))).toBe(
      `Likely refusals:${overdue}${writtenOff}`,
    );
    expect(shown.q('precheck-declines')?.querySelectorAll('li')).toHaveLength(
      2,
    );
    expect(
      shown.q('precheck-declines')?.querySelector('[aria-expanded]'),
    ).toBeNull();
    // Right after "Banks that will say no", and nothing left to check by hand.
    expect(shown.q('precheck-refusals')?.nextElementSibling).toBe(
      shown.q('precheck-declines'),
    );
    expect(shown.q('precheck-confirm')).toBeNull();
    shown.unmount();
  });

  it('tries again from the box', () => {
    const onRetry = vi.fn();
    const shown = render({ failed: true, error: new ApiError(504), onRetry });
    (shown.q('precheck-retry') as HTMLButtonElement).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    shown.unmount();
  });

  it('keeps its height while a field below is edited', () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ height: 120 } as DOMRect);
    const shown = render({});
    const element = () => shown.q('before-you-check') as HTMLElement;
    expect(element().style.height).toBe('');
    shown.draw({ holdHeight: true });
    expect(element().style.height).toBe('120px');
    // What it says changes (here: a long list of refusals): same height.
    shown.draw({
      holdHeight: true,
      summary: precheckSummary(
        parseCalculateResponse(engineAnswer('cibil_enquiries'), 'Applicant'),
        [],
      ),
    });
    expect(element().style.height).toBe('120px');
    expect(element().style.overflowY).toBe('auto');
    shown.draw({ holdHeight: false });
    expect(element().style.height).toBe('');
    rect.mockRestore();
    shown.unmount();
  });

  /** The box as tall as what it says: a change of its words changes its height. */
  function heightOfText() {
    return vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return { height: run(this).length } as DOMRect;
      });
  }
  const long = () =>
    precheckSummary(
      parseCalculateResponse(engineAnswer('cibil_enquiries'), 'Applicant'),
      [],
    );

  it('holds the height it had before the change that comes with the hold (the first keystroke)', () => {
    const rect = heightOfText();
    const shown = render({ summary: long() });
    const element = () => shown.q('before-you-check') as HTMLElement;
    const before = run(element()).length;
    // The first keystroke: its answer changes and the hold starts at once.
    shown.draw({ summary: precheckSummary(null, []), holdHeight: true });
    expect(run(element()).length).not.toBe(before);
    expect(element().style.height).toBe(`${before}px`);
    shown.draw({ summary: precheckSummary(null, []), holdHeight: false });
    expect(element().style.height).toBe('');
    rect.mockRestore();
    shown.unmount();
  });

  it('changes no height while a pointer button is down, until its click has landed', async () => {
    const rect = heightOfText();
    const shown = render({ summary: long() });
    const element = () => shown.q('before-you-check') as HTMLElement;
    const before = `${run(element()).length}px`;
    const button = document.body.appendChild(document.createElement('button'));
    button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    await sleep(0);
    // An answer arrives while the button is pressed: same height.
    shown.draw({ summary: precheckSummary(null, []) });
    expect(element().style.height).toBe(before);
    let atClick = '';
    button.addEventListener('click', () => {
      atClick = element().style.height;
    });
    button.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    button.click();
    expect(atClick).toBe(before);
    // Then the box takes the height of what it says.
    await sleep(20);
    expect(element().style.height).toBe('');
    button.remove();
    rect.mockRestore();
    shown.unmount();
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

/** His 7 Oct inputs: no pincode, an unlisted employer, CIBIL 722. */
const SESSION = {
  ...SAVED,
  inputs: {
    ...SAVED.inputs,
    profile: {
      ...SAVED.inputs.profile,
      pincode: null,
      company: 'Unheard Of Traders Pvt Ltd',
    },
    cibil: {
      ...SAVED.inputs.cibil,
      score: 722,
      enquiries: { d30: 0, d60: 1, d90: 2, d120: 3 },
    },
  },
};

/** GET .../pincodes/401202: who serves it (Check availability). */
const PINCODE_ANSWER = {
  pincode: '401202',
  region: 'Vasai-Virar (Palghar district)',
  lenders: [
    { lender: 'HDFC Bank', lender_id: 'hdfc_bank', serviceable: true },
    { lender: 'Axis Bank', lender_id: 'axis_bank', serviceable: false },
  ],
  sample: true,
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
  options: FetchApiOptions | undefined;
}

type Body = { inputs?: EligibilityInputs } | null;

/** The engine's answer to a form with details still empty: every bank names each one. */
function notEntered(body: Body): unknown {
  const p = body?.inputs?.profile;
  const c = body?.inputs?.cibil;
  const reasons = [
    !p?.pincode && 'Pincode not entered: serviceability cannot be checked',
    !p?.employment_type && 'Employment type not entered',
    !p?.company && 'Company not entered: its category is needed',
    c?.score == null && 'CIBIL score not entered',
    c?.enquiries?.d90 == null && 'Enquiries in the last 90 days not entered',
    p?.net_income == null && 'Net monthly income not entered',
  ].filter((reason): reason is string => !!reason);
  return engineAnswer('missing', {
    per_lender: ENGINE_ANSWERS.missing.per_lender.map((row) => ({
      ...row,
      reasons,
    })),
  });
}

/** The engine's answer to the inputs sent (the scenario they are). */
function engine(body: Body): unknown {
  const p = body?.inputs?.profile;
  if (!p?.pincode) return engineAnswer('session');
  if (p.company?.startsWith('Unheard')) return engineAnswer('cat_u');
  return body?.inputs?.cibil?.score === 690
    ? engineAnswer('cibil_enquiries', { file_check: NOT_READY_FILE_CHECK })
    : allLend();
}

function api(inputs: unknown, answer: (body: Body) => unknown = engine) {
  const sent: Sent[] = [];
  const fetchApi = vi.fn(
    async (url: string, init?: RequestInit, options?: FetchApiOptions) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      sent.push({ url, method, body, options });
      await sleep(5);
      if (url === `${BASE}/lenders`) return LENDERS_RESPONSE;
      if (url.startsWith(`${BASE}/inputs?`)) return inputs;
      if (url.startsWith(`${BASE}/pincodes/`)) return PINCODE_ANSWER;
      if (url === `${BASE}/calculate` && method === 'POST') return answer(body);
      throw new Error(`unexpected ${method} ${url}`);
    },
  );
  const calcs = () =>
    sent.filter((s) => s.url === `${BASE}/calculate` && s.method === 'POST');
  const saves = () => sent.filter((s) => s.method === 'PUT');
  const gets = (path: string) =>
    sent.filter(
      (s) => s.method === 'GET' && s.url.startsWith(`${BASE}/${path}`),
    );
  return { fetchApi, sent, calcs, saves, gets };
}

/** The project page: its eligibility state outlives the panel (closed with `open` false). */
function Harness({
  fetchApi,
  onBack,
  projectId,
  open = true,
}: {
  fetchApi: ReturnType<typeof api>['fetchApi'];
  onBack: () => void;
  projectId?: string;
  open?: boolean;
}) {
  const state = useEligibility({
    fetchApi: fetchApi as unknown as <T>(
      url: string,
      init?: RequestInit,
      options?: FetchApiOptions,
    ) => Promise<T>,
    projectId: 'p1',
  });
  if (!open) return null;
  return (
    <EligibilityPanel
      state={state}
      projectId={projectId}
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
async function mount(
  inputs: unknown,
  {
    answer,
    projectId,
  }: { answer?: (body: Body) => unknown; projectId?: string } = {},
) {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  g.IS_REACT_ACT_ENVIRONMENT = false;
  const server = api(inputs, answer);
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
  // The panel opened (or closed) on the same page.
  const setOpen = (open: boolean) =>
    root.render(
      page(
        <Harness
          fetchApi={server.fetchApi}
          onBack={onBack}
          projectId={projectId}
          open={open}
        />,
      ),
    );
  setOpen(true);
  const q = (testId: string) =>
    container.querySelector(`[data-testid="${testId}"]`);
  await until(() => q('before-you-check') !== null);
  return {
    ...server,
    container,
    errors,
    onBack,
    q,
    setOpen,
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
    vi.restoreAllMocks();
  });

  it('checks the saved inputs as the panel opens, once, and never saves', async () => {
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
    // Sent once: no aws4fetch retries for the background check.
    expect(calcs()[0].options).toEqual({ retries: 0 });
    expect(saves()).toEqual([]);
    const shown = text(q('before-you-check'));
    // One line per cause: the 7 banks' CIBIL refusals share one.
    expect(shown).toContain(
      'CIBIL 690 is below the minimum at HDFC Bank (710), ICICI Bank (720), Axis Bank (750), Bajaj Finance (700), Tata Capital (725), Bandhan Bank (700), Indusind Bank (725)',
    );
    expect(shown).toContain(
      '6 enquiries in the last 60 days: over the limit at HDFC Bank (5)',
    );
    expect(shown).toContain('File not ready (5 open issues)');
    // The documents to upload come before the banks that will say no.
    expect(shown.indexOf('File not ready')).toBeLessThan(
      shown.indexOf('Banks that will say no'),
    );
    // The 11 refusals are 5 lines: all shown.
    const lines = q('precheck-refusals')?.querySelectorAll('li');
    expect(lines).toHaveLength(5);
    expect(q('precheck-refusals-toggle')).toBeNull();
    expect(shown).toContain('Pincode 401202 is not serviceable by Axis Bank');
    // Each tab counts what is in the way there, white on amber-700 (5:1).
    expect(text(q('tab-count-profile'))).toBe('1 1 item to look at');
    expect(text(q('tab-count-cibil'))).toBe('4 4 items to look at');
    expect(q('tab-count-lenders')).toBeNull();
    const badge = q('tab-count-cibil') as HTMLElement;
    expect(badge.className).toContain('bg-amber-700');
    expect(badge.className).not.toMatch(/bg-amber-[56]00/);
    // The pincode's refusal under the pincode.
    expect(text(q('refusal-hints'))).toBe(
      'Pincode 401202 is not serviceable by Axis Bank',
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

  it('leads with the next step: the pincode is all ICICI Bank and Bajaj Finance need (his 7 Oct check)', async () => {
    panel = await mount(SESSION);
    const { q, calcs, container } = panel;
    await until(() => text(q('before-you-check')).includes('can lend now'));
    expect(text(q('before-you-check'))).toContain(
      'Before you check 0 of 7 banks can lend now. Enter the Pincode: ICICI Bank and Bajaj Finance need only that.',
    );
    const pincode = q('precheck-needed')?.querySelector(
      'li[data-field="pincode"]',
    );
    expect(run(pincode)).toBe(
      'Pincode: all 7 banks need it. ICICI Bank and Bajaj Finance need only this.',
    );
    expect(text(q('precheck-refusals'))).toContain(
      'CIBIL 722 is below the minimum at Axis Bank (750), Tata Capital (725), Indusind Bank (725)',
    );
    // The pincode entered: checked again, and nothing still needed.
    type(q('profile-pincode'), '401202');
    await until(() => calcs().length === 2);
    await until(() => q('precheck-needed') === null);
    expect(text(container)).not.toContain('need only that');
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
    // The CIBIL tab shows the score's refusals under it: one line, 7 banks.
    expect(text(q('refusal-hints'))).toBe(
      'CIBIL 690 is below the minimum at HDFC Bank (710), ICICI Bank (720), Axis Bank (750), Bajaj Finance (700), Tata Capital (725), Bandhan Bank (700), Indusind Bank (725)',
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
      "Nothing blocking so far: all 6 banks can lend. 61 conditions to confirm after Check eligibility, in each bank's Details",
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
    panel = await mount(EMPTY, { answer: notEntered });
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
    // Check eligibility keeps aws4fetch's retries.
    expect(calcs()[1].options).toBeUndefined();
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

  it('says when the banks could not be checked, keeps the last answer and tries the same inputs again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let down = false;
    panel = await mount(SAVED, {
      answer: (body) => {
        if (down) throw new ApiError(503);
        return engine(body);
      },
    });
    const { q, calcs, container } = panel;
    await until(() =>
      text(q('before-you-check')).includes('Banks that will say no'),
    );
    down = true;
    tabButton(container, 'CIBIL').click();
    await until(() => q('cibil-score') !== null);
    type(q('cibil-score'), '790');
    await until(() => q('precheck-retry') !== null);
    expect(calcs()).toHaveLength(2);
    expect(text(q('precheck-failed'))).toBe(
      'Could not check the banks just now. The answer below may be out of date.',
    );
    // The last answer stays, faded.
    expect(q('precheck-refusals')?.className).toContain('opacity-60');
    // Not tried again by itself.
    await sleep(1300);
    expect(calcs()).toHaveLength(2);
    down = false;
    (q('precheck-retry') as HTMLButtonElement).click();
    await until(() => calcs().length === 3);
    expect(calcs()[2].body).toEqual(calcs()[1].body);
    await until(() =>
      text(q('before-you-check')).startsWith('Nothing blocking so far'),
    );
    expect(q('precheck-failed')).toBeNull();
  });

  it('shows nothing the company causes while it is typed: on leaving the field, or after 2 s', async () => {
    panel = await mount(SAVED);
    const { q, calcs } = panel;
    await until(() =>
      text(q('before-you-check')).includes('Banks that will say no'),
    );
    const company = q('profile-company') as HTMLInputElement;
    company.focus();
    type(company, 'Unheard');
    const typedAt = performance.now();
    await until(() => calcs().length === 2);
    expect(calcs()[1].body).toMatchObject({
      inputs: { profile: { company: 'Unheard' } },
    });
    // The answer is in (the Axis pincode line), the company's line is not yet.
    await until(() =>
      text(q('before-you-check')).includes(
        'Pincode 401202 is not serviceable by Axis Bank',
      ),
    );
    expect(performance.now() - typedAt).toBeLessThan(1900);
    expect(text(q('before-you-check'))).not.toContain('CAT U');
    expect(text(q('before-you-check'))).not.toContain(
      'Nothing blocking so far',
    );
    // Leaving the field shows it.
    company.blur();
    await until(() => text(q('before-you-check')).includes('CAT U'));
    expect(text(q('before-you-check'))).toContain(
      'No loans to CAT U (unlisted) companies at HDFC Bank , Bandhan Bank',
    );
    // Typed again and left alone for 2 s: shown without leaving the field.
    company.focus();
    type(company, 'Unheard Of');
    await until(() => calcs().length === 3);
    await sleep(300);
    expect(text(q('before-you-check'))).not.toContain('CAT U');
    await until(() => text(q('before-you-check')).includes('CAT U'), 3000);
    expect(document.activeElement).toBe(company);
  });

  it('checks the same inputs again after Reload and after a new policy sheet or company list', async () => {
    panel = await mount(SAVED, { projectId: 'p1' });
    const { q, calcs, gets, container } = panel;
    await until(
      () =>
        calcs().length === 1 &&
        text(q('before-you-check')).includes('Banks that will say no'),
    );
    const reload = container.querySelector(
      'button[aria-label="Reload the saved inputs"]',
    ) as HTMLButtonElement;
    reload.click();
    await until(() => gets('inputs').length === 2);
    await until(() => calcs().length === 2);
    expect(calcs()[1].body).toEqual(calcs()[0].body);
    await until(() =>
      text(q('before-you-check')).includes('Banks that will say no'),
    );
    // The Lenders tab's branch finder: a company list saved.
    tabButton(container, 'Lenders').click();
    await until(() => q('policy-changed') !== null);
    const lenders = gets('lenders').length;
    (q('policy-changed') as HTMLButtonElement).click();
    await until(() => calcs().length === 3);
    expect(calcs()[2].body).toEqual(calcs()[0].body);
    expect(gets('lenders').length).toBe(lenders + 1);
  });

  it('keeps the box height while a field is typed in, until 2 s after the typing', async () => {
    panel = await mount(SAVED);
    const { q, calcs, container } = panel;
    await until(() =>
      text(q('before-you-check')).includes('Banks that will say no'),
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      height: 96,
    } as DOMRect);
    const box = () => q('before-you-check') as HTMLElement;
    tabButton(container, 'CIBIL').click();
    await until(() => q('cibil-score') !== null);
    expect(box().style.height).toBe('');
    const score = q('cibil-score') as HTMLInputElement;
    // Focus alone holds nothing.
    score.focus();
    await sleep(50);
    expect(box().style.height).toBe('');
    // Read before typing: the hold's 2 s start during the keystroke.
    const typedAt = performance.now();
    type(score, '790');
    await until(() => box().style.height === '96px');
    // Leaving the field does not end it: only the time does.
    score.blur();
    await sleep(50);
    expect(box().style.height).toBe('96px');
    // The answer changes from 5 refusal lines to one line: same height.
    await until(() => calcs().length === 2);
    await until(() => text(box()).startsWith('Nothing blocking so far'));
    expect(box().style.height).toBe('96px');
    // 2 s after the typing: the box takes its own height again.
    await until(() => box().style.height === '', 4000);
    expect(performance.now() - typedAt).toBeGreaterThan(1900);
  });

  it('keeps the box height through a click right after typing: focus moves to the button first', async () => {
    // The box as tall as what it says, from the first render.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return { height: run(this).length } as DOMRect;
      },
    );
    panel = await mount(SESSION);
    const { q, gets, container } = panel;
    await until(() => text(q('before-you-check')).includes('can lend now'));
    const box = () => q('before-you-check') as HTMLElement;
    const before = `${run(box()).length}px`;
    expect(box().style.height).toBe('');
    const pincode = q('profile-pincode') as HTMLInputElement;
    pincode.focus();
    await sleep(50);
    // Read before typing: the hold's 2 s start during the keystroke.
    const typedAt = performance.now();
    type(pincode, '401202');
    // "Still needed: Pincode" goes: the box keeps the height it had.
    await until(() => q('precheck-needed') === null);
    expect(box().style.height).toBe(before);
    // A mouse press on Check availability: focus moves to it before its click.
    const check = [...container.querySelectorAll('button')].find(
      (b) => text(b) === 'Check availability',
    ) as HTMLButtonElement;
    let atClick = '';
    check.addEventListener('click', () => {
      atClick = box().style.height;
    });
    check.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    check.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    check.focus();
    await sleep(50);
    expect(document.activeElement).toBe(check);
    expect(box().style.height).toBe(before);
    check.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    check.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    check.click();
    // The click lands with the box as it was, and checks the pincode.
    expect(atClick).toBe(before);
    await until(() => q('pincode-check') !== null);
    expect(gets('pincodes')).toHaveLength(1);
    expect(box().style.height).toBe(before);
    // 2 s after the typing: the box takes its own height again.
    await until(() => box().style.height === '', 4000);
    expect(performance.now() - typedAt).toBeGreaterThan(1900);
  });

  it('drops a field no bank asks for (a verified salary): clear, also while the next check runs', async () => {
    // Saved without a net income: the file check's verified salary is used.
    const verified = {
      ...SAVED,
      inputs: {
        ...SAVED.inputs,
        profile: { ...SAVED.inputs.profile, net_income: null },
        cibil: { ...SAVED.inputs.cibil, score: 790 },
      },
    };
    panel = await mount(verified, { answer: () => allLend() });
    const { q, calcs, container } = panel;
    await until(
      () =>
        calcs().length === 1 &&
        !text(q('before-you-check')).includes('Checking'),
    );
    expect(text(q('before-you-check'))).toBe(
      "Nothing blocking so far: all 6 banks can lend. 61 conditions to confirm after Check eligibility, in each bank's Details",
    );
    expect(q('tab-count-profile')).toBeNull();
    // Another score: checked again, and no "Still needed: Net income" meanwhile.
    tabButton(container, 'CIBIL').click();
    await until(() => q('cibil-score') !== null);
    type(q('cibil-score'), '795');
    const states = new Set<string | null | undefined>();
    while (calcs().length < 2) {
      states.add(q('before-you-check')?.getAttribute('data-state'));
      await sleep(20);
    }
    await until(() => !text(q('before-you-check')).includes('Checking'));
    states.add(q('before-you-check')?.getAttribute('data-state'));
    expect([...states]).toEqual(['clear']);
    expect(text(q('before-you-check'))).toMatch(/^Nothing blocking so far/);
  });

  it('keeps the policy number with the page: a result from before a new company list is checked again after the panel is reopened', async () => {
    panel = await mount(SAVED, { projectId: 'p1' });
    const { q, calcs, saves, container, setOpen } = panel;
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
    await until(() => q('lenders-table') !== null);
    // Closed and opened again: the result is for these inputs and lists.
    setOpen(false);
    await until(() => q('eligibility-panel') === null);
    setOpen(true);
    await until(() => q('before-you-check') !== null);
    await sleep(1300);
    expect(calcs()).toHaveLength(2);
    // A new company list on the Lenders tab: the same inputs checked again.
    tabButton(container, 'Lenders').click();
    await until(() => q('policy-changed') !== null);
    (q('policy-changed') as HTMLButtonElement).click();
    await until(() => calcs().length === 3);
    await until(() => !text(q('before-you-check')).includes('Checking'));
    // Closed and opened again: Check eligibility's result is from before
    // that list, so the inputs are checked again at once.
    setOpen(false);
    await until(() => q('eligibility-panel') === null);
    setOpen(true);
    await until(() => calcs().length === 4);
    expect(calcs()[3].body).toEqual(calcs()[0].body);
    expect(calcs()[3].options).toEqual({ retries: 0 });
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
