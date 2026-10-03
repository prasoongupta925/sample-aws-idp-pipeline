// @vitest-environment node
// (Rendered to static markup: the workspace's jsdom install cannot start.)
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '../../i18n/locales/en.json';
import EligibilityPanel from '.';
import EmiCalculator, {
  aprOf,
  balanceTransfer,
  convertTenure,
  emiOf,
  emiPlan,
  emiStartOf,
  parseRate,
  roundRupees,
  tenureMonths,
  validFee,
  yearlySchedule,
} from './EmiCalculator';
import { WORKED_EXAMPLE_RESPONSE } from './fixtures';
import { formatRupees, parseCalculateResponse } from '../../lib/eligibility';
import { newDraft, type EligibilityState } from '../../hooks/useEligibility';

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  });
});

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

/** The text of the element with this data-testid (its first tag's content). */
function byTestId(html: string, id: string): string {
  const match = html.match(
    new RegExp(`data-testid="${id}"[^>]*>([\\s\\S]*?)</`),
  );
  if (!match) throw new Error(`${id} not rendered`);
  return plain(match[1]);
}

const CRORE = 10_000_000;
const RESULT = parseCalculateResponse(
  WORKED_EXAMPLE_RESPONSE,
  'Sneha Anil Kulkarni',
);

describe('EMI maths', () => {
  it('reproduces 1,00,00,000 at 16% for 30 years', () => {
    const plan = emiPlan(CRORE, 16, 360);

    expect(plan.emi).toBe(134476);
    expect(plan.totalInterest).toBe(38411252);
    expect(plan.totalPayable).toBe(48411252);
    expect([plan.principalPct, plan.interestPct]).toEqual([21, 79]);
    expect(
      [plan.emi, plan.totalInterest, plan.totalPayable].map(formatRupees),
    ).toEqual(['₹1,34,476', '₹3,84,11,252', '₹4,84,11,252']);
  });

  it('is Excel PMT, as the eligibility sheet and the chat tool', () => {
    // The sheet's ICICI Bank EMI and per-lakh EMI (the backend's 39,172.13 and 2,174.24).
    expect(emiOf(2058000, 11, 72)).toBeCloseTo(39172.134583, 5);
    expect(emiOf(100000, 11, 60)).toBeCloseTo(2174.242307, 5);
    expect(emiPlan(2058000, 11, 72).emi).toBe(39172);
  });

  it('builds the yearly amortisation the chat tool gives', () => {
    const rows = yearlySchedule(CRORE, 16, 360);

    expect(rows).toHaveLength(30);
    expect(rows[0]).toEqual({
      year: 1,
      months: 12,
      opening: 10000000,
      principalPaid: 14760,
      interestPaid: 1598949,
      closing: 9985240,
    });
    expect(rows[29].closing).toBe(0);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].opening).toBe(rows[i - 1].closing);
    }
    const principal = rows.reduce((sum, r) => sum + r.principalPaid, 0);
    const interest = rows.reduce((sum, r) => sum + r.interestPaid, 0);
    expect(Math.abs(principal - CRORE)).toBeLessThanOrEqual(30);
    expect(Math.abs(interest - 38411252)).toBeLessThanOrEqual(30);
  });

  it('ends with a part year', () => {
    const rows = yearlySchedule(2058000, 11, 30);

    expect(rows.map((r) => r.months)).toEqual([12, 12, 6]);
    expect(rows[2].closing).toBe(0);
  });

  it('divides the amount evenly at 0%', () => {
    const plan = emiPlan(120000, 0, 12);

    expect([plan.emi, plan.totalInterest, plan.totalPayable]).toEqual([
      10000, 0, 120000,
    ]);
    expect([plan.principalPct, plan.interestPct]).toEqual([100, 0]);
  });

  it('compares a balance transfer over the remaining tenure', () => {
    const bt = balanceTransfer(500000, 14, 36, 11);

    expect([
      bt.currentEmi,
      bt.newEmi,
      bt.monthlySaving,
      bt.totalSaving,
    ]).toEqual(
      [17089, 16369, 719, 25900], // 719.44 a month x 36, from the unrounded EMIs
    );
    const dearer = balanceTransfer(500000, 11, 36, 14);
    expect([dearer.monthlySaving, dearer.totalSaving]).toEqual([-719, -25900]);
    expect(bt.currentTotalInterest - bt.newTotalInterest).toBe(25900);
  });

  it('rounds halves away from zero, never to -0', () => {
    expect([roundRupees(0.5), roundRupees(-0.5), roundRupees(2.4)]).toEqual([
      1, -1, 2,
    ]);
    expect(Object.is(roundRupees(-0.2), 0)).toBe(true);
  });
});

describe('APR and total cost', () => {
  it('counts a 2,000 fee on 1,00,000 at 12% for 12 months (hand-worked)', () => {
    // EMI 8,884.88 (1.01^12 = 1.126825); the borrower gets 98,000, so
    // (1 − (1 + r)^−12) ÷ r = 98,000 ÷ 8,884.88 = 11.0300: 1.30% a month gives
    // 11.0445 and 1.33% gives 11.0241, so r ≈ 1.321% and the APR ≈ 15.85%.
    const plan = emiPlan(100000, 12, 12, 2000);
    expect(plan.emi).toBe(8885);
    expect(plan.apr).toBe(15.85);
    // Interest 6,618.55 (12 × 8,884.88 − 1,00,000) + the 2,000 fee.
    expect(plan.totalInterest).toBe(6619);
    expect(plan.totalCost).toBe(8619);
    expect(plan.fee).toBe(2000);
  });

  it('solves the Key Fact Statement equation', () => {
    const r = (aprOf(100000, 12, 12, 2000) as number) / 1200;
    const repaid = (emiOf(100000, 12, 12) * (1 - Math.pow(1 + r, -12))) / r;
    expect(repaid).toBeCloseTo(98000, 4);
  });

  it('works at 0%: 1,20,000 over 12 months with a 1,200 fee', () => {
    // EMI 10,000; factor 11.88 ≈ 12 × (1 − 6.5 r) -> r ≈ 0.154% a month.
    const plan = emiPlan(120000, 0, 12, 1200);
    expect(plan.apr).toBe(1.86);
    expect(plan.totalCost).toBe(1200);
  });

  it('is the rate itself with no fee, as the backend', () => {
    expect(aprOf(2058000, 11, 72)).toBe(11);
    expect(emiPlan(2058000, 11, 72).apr).toBe(11);
    // The backend's ICICI Bank row: 2% fee = 41,160 -> APR 11.75%.
    expect(emiPlan(2058000, 11, 72, 41160).apr).toBe(11.75);
    expect(emiPlan(1500000, 12, 60, 22500).apr).toBe(12.67);
  });

  it('refuses a fee below 0 or not below the loan', () => {
    expect(aprOf(100000, 12, 12, -1)).toBeNull();
    expect(aprOf(100000, 12, 12, 100000)).toBeNull();
    expect(validFee(null, 100000)).toBe(0);
    expect(validFee(5000, 100000)).toBe(5000);
    expect(validFee(100000, 100000)).toBeNaN();
    expect(validFee(-5, 100000)).toBeNaN();
  });
});

describe('EMI inputs', () => {
  it.each([
    ['11', 11],
    ['10.49', 10.49],
    [' 8.875 % ', 8.875],
    ['', null],
  ])('reads the rate %j', (text, rate) => {
    expect(parseRate(text)).toBe(rate);
  });

  it.each(['eleven', '1.23456', '-1', '11.'])('refuses the rate %j', (text) => {
    expect(parseRate(text)).toBeNaN();
  });

  it.each([
    ['5', 'years', 60],
    ['2.5', 'years', 30],
    ['30', 'years', 360],
    ['18', 'months', 18],
    ['480', 'months', 480],
    ['', 'years', null],
  ] as const)('reads the tenure %j %s', (text, unit, months) => {
    expect(tenureMonths(text, unit)).toBe(months);
  });

  it.each([
    ['1.3', 'years'], // 15.6 months
    ['41', 'years'],
    ['0', 'months'],
    ['481', 'months'],
    ['12.5', 'months'],
  ] as const)('refuses the tenure %j %s', (text, unit) => {
    expect(tenureMonths(text, unit)).toBeNaN();
  });

  it('keeps the tenure when the unit changes', () => {
    expect(convertTenure('60', 'months', 'years')).toBe('5');
    expect(convertTenure('30', 'months', 'years')).toBe('2.5');
    expect(convertTenure('2.5', 'years', 'months')).toBe('30');
    expect(convertTenure('13', 'months', 'years')).toBe('13');
    expect(convertTenure('abc', 'years', 'months')).toBe('abc');
  });

  it("starts from the best lender's result", () => {
    expect(emiStartOf(RESULT)).toEqual({
      lender: 'ICICI Bank',
      amount: 2058000,
      ratePct: 11,
      months: 72,
      fee: 41160,
    });
    expect(emiStartOf(null)).toBeNull();
    expect(emiStartOf({ ...RESULT, best_lender: null })).toBeNull();
  });
});

describe('EmiCalculator', () => {
  it('is one closed section at first', () => {
    const html = render(<EmiCalculator />);

    expect(html).toContain('aria-expanded="false"');
    expect(plain(html)).toBe('EMI and balance-transfer calculator');
  });

  it('shows the EMI, the split and the yearly schedule in Indian digits', () => {
    const html = render(
      <EmiCalculator
        initialOpen
        initialEmi={{ amount: CRORE, rate: '16', tenure: '30', unit: 'years' }}
      />,
    );

    expect(byTestId(html, 'emi-value')).toBe('₹1,34,476');
    expect(byTestId(html, 'emi-total-interest')).toBe('₹3,84,11,252');
    expect(byTestId(html, 'emi-total-payable')).toBe('₹4,84,11,252');
    const text = plain(html);
    expect(text).toContain('Principal 21% · ₹1,00,00,000');
    expect(text).toContain('Interest 79% · ₹3,84,11,252');
    expect(text).toContain('Yearly amortisation (30 years)');
    expect(html.match(/<tr class="border-t/g)).toHaveLength(30);
    expect(html).toContain('value="1,00,00,000"');
    expect(text).toContain('Indicative: the lender decides.');
  });

  it('shows the APR, the fee and the total cost', () => {
    const html = render(
      <EmiCalculator
        initialOpen
        initialEmi={{
          amount: 100000,
          rate: '12',
          tenure: '12',
          unit: 'months',
          fee: 2000,
        }}
      />,
    );

    expect(byTestId(html, 'emi-apr')).toBe('15.85%');
    expect(byTestId(html, 'emi-fee-value')).toBe('₹2,000');
    expect(byTestId(html, 'emi-total-cost')).toBe('₹8,619');
    expect(plain(html)).toContain('APR = 12 × r, where r solves P − fee');
  });

  it('shows the rate as the APR without a fee', () => {
    const html = render(
      <EmiCalculator
        initialOpen
        initialEmi={{ amount: CRORE, rate: '16', tenure: '30', unit: 'years' }}
      />,
    );
    expect(byTestId(html, 'emi-apr')).toBe('16%');
    expect(byTestId(html, 'emi-total-cost')).toBe('₹3,84,11,252');
  });

  it('says what is wrong with a fee', () => {
    const html = render(
      <EmiCalculator
        initialOpen
        initialEmi={{
          amount: 100000,
          rate: '12',
          tenure: '12',
          unit: 'months',
          fee: 100000,
        }}
      />,
    );
    expect(plain(html)).toContain(
      'Enter a fee of ₹0 or more, less than the loan amount.',
    );
    expect(html).not.toContain('data-testid="emi-result"');
  });

  it("offers the best lender's result", () => {
    const html = render(
      <EmiCalculator initialOpen start={emiStartOf(RESULT)} />,
    );

    expect(html).toContain('data-testid="emi-use-offer"');
    expect(plain(html)).toContain("Use ICICI Bank's result");
    expect(html).toContain(
      'title="Fill in ICICI Bank&#x27;s eligible amount, rate and tenure"',
    );
    expect(plain(html)).toContain(
      'Enter the loan amount, the rate and the tenure to see the EMI.',
    );
  });

  it('says what is wrong with a rate or a tenure', () => {
    const html = render(
      <EmiCalculator
        initialOpen
        initialEmi={{
          amount: 500000,
          rate: '75',
          tenure: '1.3',
          unit: 'years',
        }}
      />,
    );

    const text = plain(html);
    expect(text).toContain('Enter a rate from 0 to 60% a year, e.g. 10.5.');
    expect(text).toContain(
      'Enter 1 to 480 months (40 years) in whole months, e.g. 5 or 2.5 years.',
    );
    expect(html).not.toContain('data-testid="emi-result"');
  });

  it('shows the balance-transfer saving', () => {
    const html = render(
      <EmiCalculator
        initialOpen
        initialMode="bt"
        initialBt={{
          outstanding: 500000,
          currentRate: '14',
          newRate: '11',
          tenure: '36',
          unit: 'months',
        }}
      />,
    );

    expect(byTestId(html, 'bt-current-emi')).toBe('₹17,089');
    expect(byTestId(html, 'bt-new-emi')).toBe('₹16,369');
    expect(byTestId(html, 'bt-monthly')).toBe('₹719');
    expect(byTestId(html, 'bt-total')).toBe('₹25,900');
    const text = plain(html);
    expect(text).toContain('Monthly saving');
    expect(text).toContain('Total saving');
    expect(text).toContain("before the new lender's processing fee");
  });

  it('calls a higher new rate an extra cost', () => {
    const html = render(
      <EmiCalculator
        initialOpen
        initialMode="bt"
        initialBt={{
          outstanding: 500000,
          currentRate: '11',
          newRate: '14',
          tenure: '3',
          unit: 'years',
        }}
      />,
    );

    expect(plain(html)).toContain('Monthly extra cost ₹719');
    expect(plain(html)).toContain('Total extra cost ₹25,900');
  });

  it('is on the Lenders tab of the eligibility page', () => {
    const draft = {
      ...newDraft('Sneha Anil Kulkarni'),
      loaded: true,
      result: RESULT,
    };
    const state = {
      lenders: null,
      lendersLoading: false,
      lendersError: null,
      drafts: { 'Sneha Anil Kulkarni': draft },
    } as unknown as EligibilityState;
    const panel = (tab: 'profile' | 'lenders') =>
      render(
        <EligibilityPanel
          state={state}
          applicant="Sneha Anil Kulkarni"
          name="Sneha Anil Kulkarni"
          onBack={() => undefined}
          onClose={() => undefined}
          initialTab={tab}
        />,
      );

    expect(panel('lenders')).toContain('data-testid="emi-calculator"');
    expect(panel('profile')).not.toContain('data-testid="emi-calculator"');
  });
});
