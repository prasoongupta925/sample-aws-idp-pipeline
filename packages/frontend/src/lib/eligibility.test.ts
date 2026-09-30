// @vitest-environment node
import {
  addOtherIncome,
  addTradeline,
  calculateRequestBody,
  eligibilityApplicant,
  emptyInputs,
  enquiriesOutOfOrder,
  formatFoir,
  formatIndianNumber,
  formatRoi,
  formatRupees,
  inputsKey,
  inputsRequestBody,
  isFutureDate,
  isMaskedPan,
  lenderTone,
  localToday,
  mobileLooksValid,
  normalizeInputs,
  parseAmount,
  parseCalculateResponse,
  parseCount,
  parseInputsResponse,
  parseLenders,
  parseLoginResponse,
  removeTradeline,
  roiPercent,
  setTradelineAction,
  updateOtherIncome,
  updateTradeline,
  webhookOutcome,
} from './eligibility';
import {
  LENDERS_RESPONSE,
  LOGIN_NOTIFIED,
  LOGIN_NO_WEBHOOK,
  LOGIN_WEBHOOK_FAILED,
  PREFILLED_INPUTS_RESPONSE,
  SAVED_INPUTS_RESPONSE,
  WORKED_EXAMPLE_RESPONSE,
} from '../components/EligibilityPanel/fixtures';

const SNEHA = 'Sneha Anil Kulkarni';

describe('Indian number formatting', () => {
  it('groups rupees in lakhs and crores', () => {
    expect(formatRupees(2058000)).toBe('₹20,58,000');
    expect(formatRupees(1500000)).toBe('₹15,00,000');
    expect(formatRupees(98000)).toBe('₹98,000');
    expect(formatRupees(12345678)).toBe('₹1,23,45,678');
    expect(formatRupees(0)).toBe('₹0');
    expect(formatRupees(null)).toBe('–');
    expect(formatRupees(Number.NaN)).toBe('–');
  });

  it('shows paise only when there are any, rounded to 2 places', () => {
    expect(formatRupees(39172.13458345223)).toBe('₹39,172.13');
    expect(formatRupees(33366.67152735264)).toBe('₹33,366.67');
    expect(formatRupees(2174.242307264313)).toBe('₹2,174.24');
    expect(formatRupees(2465226.6134698153)).toBe('₹24,65,226.61');
    expect(formatIndianNumber(2465226.6134698153)).toBe('24,65,226.61');
    expect(formatIndianNumber(2058000)).toBe('20,58,000');
    expect(formatIndianNumber(null)).toBe('');
  });

  it('always shows both paise digits of an amount with paise', () => {
    expect(formatRupees(39172.1)).toBe('₹39,172.10');
    expect(formatRupees(2465226.6)).toBe('₹24,65,226.60');
    expect(formatRupees(1775331.11)).toBe('₹17,75,331.11');
    expect(formatRupees(0.5)).toBe('₹0.50');
    // Paise that round away are not shown.
    expect(formatRupees(39172.004)).toBe('₹39,172');
    expect(formatIndianNumber(98000.5)).toBe('98,000.50');
    expect(formatIndianNumber(98000)).toBe('98,000');
  });

  it('reads typed amounts with or without grouping and the rupee sign', () => {
    expect(parseAmount('20,58,000')).toBe(2058000);
    expect(parseAmount('₹ 98,000')).toBe(98000);
    expect(parseAmount('Rs. 15000')).toBe(15000);
    expect(parseAmount('1,00,000.50')).toBe(100000.5);
    expect(parseAmount('  ')).toBeNull();
    expect(parseAmount('12abc')).toBeNaN();
    expect(parseAmount('-500')).toBeNaN();
    expect(parseCount('60')).toBe(60);
    expect(parseCount('6.5')).toBeNaN();
    expect(parseCount('')).toBeNull();
  });

  it('shows the ROI as a percent whether sent as 11 or 0.11', () => {
    expect(formatRoi(11)).toBe('11%');
    expect(formatRoi(0.11)).toBe('11%');
    expect(formatRoi(10.75)).toBe('10.75%');
    expect(formatRoi(null)).toBe('–');
    expect(roiPercent(0.12)).toBe(12);
  });

  it('shows a FOIR (a fraction in the API) as a percent, 100% included', () => {
    expect(formatFoir(0.7)).toBe('70%');
    expect(formatFoir(0.655)).toBe('65.5%');
    expect(formatFoir(1)).toBe('100%');
    expect(formatFoir(null)).toBe('–');
  });
});

describe('inputs', () => {
  it('reads a draft: the fields the documents filled, a masked PAN', () => {
    const parsed = parseInputsResponse(PREFILLED_INPUTS_RESPONSE, SNEHA);
    expect(parsed.saved).toBe(false);
    expect(parsed.fromDocuments).toEqual([
      'name',
      'pan',
      'company',
      'employment_type',
      'net_income',
    ]);
    expect(parsed.prefill).toMatchObject({
      available: true,
      income_source: 'verified: salary slips, median net pay',
    });
    expect(parsed.inputs.profile).toMatchObject({
      name: SNEHA,
      pan: 'XXXXXX314M',
      company: 'Konkan Softworks Pvt Ltd',
      employment_type: 'private_limited',
      net_income: 98000,
    });
    expect(isMaskedPan(parsed.inputs.profile.pan)).toBe(true);
    expect(isMaskedPan('ABCDE1234F')).toBe(false);
  });

  it('reads saved inputs and when they are deleted', () => {
    const parsed = parseInputsResponse(SAVED_INPUTS_RESPONSE, SNEHA);
    expect(parsed.saved).toBe(true);
    expect(parsed.applicant).toBe('CKRPK7314M');
    expect(parsed.expiresAt).toBe('2026-10-07T10:00:00.000000+00:00');
    expect(parsed.inputs.cibil.tradelines.map((r) => r.action)).toEqual([
      'obligate',
      'close',
    ]);
    expect(parsed.inputs.profile.other_income).toMatchObject([
      { type: 'bonus', frequency: 'yearly', agreement: null, amount: 60000 },
      {
        type: 'rented',
        agreement: 'registered',
        frequency: null,
        amount: 12000,
      },
    ]);
  });

  it('rejects a response that is not the contract', () => {
    expect(() => parseInputsResponse({ detail: 'x' }, SNEHA)).toThrow();
    expect(() => parseInputsResponse(null, SNEHA)).toThrow();
  });

  it('builds the PUT body: trimmed text, no row keys, NaN typing as null', () => {
    let inputs = normalizeInputs(SAVED_INPUTS_RESPONSE.inputs);
    inputs = updateTradeline(inputs, 0, { lender: '  Axis Bank ', emi: NaN });
    const body = inputsRequestBody('CKRPK7314M', inputs);
    expect(Object.keys(body)).toEqual([
      'applicant',
      'profile',
      'cibil',
      'loan',
    ]);
    expect(body.applicant).toBe('CKRPK7314M');
    expect(body.cibil.tradelines[0]).toEqual({
      loan_type: 'personal',
      lender: 'Axis Bank',
      sanction_amount: 600000,
      outstanding: 410000,
      emi: null,
      status: 'active',
      action: 'obligate',
      account_number: 'PL00001234',
      emis_paid: 14,
      emis_pending: 34,
      open_date: '2025-07-05',
      last_payment_date: '2026-09-05',
    });
    // Optional details that are empty are left out.
    expect(body.cibil.tradelines[1]).toEqual({
      loan_type: 'credit_card',
      lender: 'Kotak Mahindra Bank',
      sanction_amount: 150000,
      outstanding: 18000,
      emi: 0,
      status: 'active',
      action: 'close',
    });
    expect(JSON.stringify(body)).not.toContain('"key"');
    expect(body.profile.pan).toBe('XXXXXX314M');
  });

  it('keeps the source of a bureau pull or a bank-statement suggestion', () => {
    const inputs = normalizeInputs({
      cibil: {
        source: 'bureau',
        report_date: '2026-09-29',
        tradelines: [
          {
            loan_type: 'car',
            emi: 8200,
            action: 'obligate',
            source: 'bank_statement',
          },
        ],
      },
    });
    const body = inputsRequestBody(SNEHA, inputs);
    expect(body.cibil.source).toBe('bureau');
    expect(body.cibil.report_date).toBe('2026-09-29');
    expect(body.cibil.tradelines[0].source).toBe('bank_statement');
    // Manual is the API's default and is not sent.
    const manual = inputsRequestBody(SNEHA, addTradeline(emptyInputs()));
    expect(manual.cibil).not.toHaveProperty('source');
    expect(manual.cibil.tradelines[0]).not.toHaveProperty('source');
  });

  it('asks the API by PAN when the verdict has one, else by name', () => {
    expect(
      eligibilityApplicant({ applicant: SNEHA, pan: ' ckrpk7314m ' }),
    ).toEqual({ id: 'CKRPK7314M', name: SNEHA, pan: 'CKRPK7314M' });
    expect(eligibilityApplicant({ applicant: SNEHA, pan: null })).toEqual({
      id: SNEHA,
      name: SNEHA,
      pan: null,
    });
  });

  it('dates are checked against the local day', () => {
    const now = new Date(2026, 8, 30, 23, 30);
    expect(localToday(now)).toBe('2026-09-30');
    expect(isFutureDate('2026-09-30', now)).toBe(false);
    expect(isFutureDate('2026-10-01', now)).toBe(true);
    expect(isFutureDate(null, now)).toBe(false);
  });

  it('checks the formats the API checks', () => {
    expect(mobileLooksValid('+91 98200 12345')).toBe(true);
    expect(mobileLooksValid('09820012345')).toBe(true);
    expect(mobileLooksValid('12345')).toBe(false);
    expect(enquiriesOutOfOrder({ d30: 1, d60: 2, d90: 3, d120: 4 })).toBeNull();
    expect(enquiriesOutOfOrder({ d30: 3, d60: null, d90: 2, d120: 4 })).toEqual(
      ['d30', 'd90'],
    );
  });
});

describe('BT / Obligate / Close', () => {
  const inputs = normalizeInputs(SAVED_INPUTS_RESPONSE.inputs);
  const actions = (body: ReturnType<typeof calculateRequestBody>) =>
    body.inputs?.cibil.tradelines.map((r) => r.action);

  it('a toggle changes only its own loan in the calculate request', () => {
    expect(actions(calculateRequestBody(SNEHA, inputs))).toEqual([
      'obligate',
      'close',
    ]);
    const bt = setTradelineAction(inputs, 0, 'bt');
    expect(actions(calculateRequestBody(SNEHA, bt))).toEqual(['bt', 'close']);
    const both = setTradelineAction(bt, 1, 'obligate');
    expect(actions(calculateRequestBody(SNEHA, both))).toEqual([
      'bt',
      'obligate',
    ]);
    // The original inputs are not changed.
    expect(actions(calculateRequestBody(SNEHA, inputs))).toEqual([
      'obligate',
      'close',
    ]);
  });

  it('a toggle makes the result stale (the inputs key changes)', () => {
    const key = inputsKey(inputs);
    expect(inputsKey(setTradelineAction(inputs, 0, 'close'))).not.toBe(key);
    expect(inputsKey(setTradelineAction(inputs, 0, 'obligate'))).toBe(key);
  });

  it('adds loans as Obligate and removes by position', () => {
    const added = addTradeline(emptyInputs());
    expect(added.cibil.tradelines).toHaveLength(1);
    expect(added.cibil.tradelines[0]).toMatchObject({
      action: 'obligate',
      status: 'active',
      loan_type: 'personal',
    });
    const removed = removeTradeline(inputs, 0);
    expect(removed.cibil.tradelines.map((r) => r.lender)).toEqual([
      'Kotak Mahindra Bank',
    ]);
  });

  it('other income rows keep only their type’s own fields', () => {
    let i = addOtherIncome(emptyInputs(), 'rented');
    expect(i.profile.other_income[0]).toMatchObject({
      type: 'rented',
      agreement: 'registered',
      frequency: null,
    });
    i = updateOtherIncome(i, 0, { amount: 20000 });
    i = updateOtherIncome(i, 0, { type: 'incentive' });
    expect(i.profile.other_income[0]).toMatchObject({
      type: 'incentive',
      frequency: 'yearly',
      agreement: null,
      amount: 20000,
    });
    expect(inputsRequestBody(SNEHA, i).profile.other_income).toEqual([
      {
        type: 'incentive',
        amount: 20000,
        frequency: 'yearly',
        agreement: null,
      },
    ]);
  });
});

describe('results', () => {
  it('reads the worked example as sent', () => {
    const result = parseCalculateResponse(WORKED_EXAMPLE_RESPONSE, SNEHA);
    expect(result.best_lender).toBe('ICICI Bank');
    expect(result.income_considered).toBe(98000);
    expect(result.obligations).toBe(15000);
    expect(result.sample).toBe(true);
    const icici = result.per_lender[0];
    expect(icici).toMatchObject({
      lender: 'ICICI Bank',
      lender_id: 'icici_bank',
      status: 'eligible',
      eligible_amount: 2058000,
      tenure_months: 72,
      calculation_tenure_months: 60,
      roi: 11,
      foir: 0.7,
      multiplier: 21,
      multiplier_eligibility: 2058000,
    });
    expect(formatRupees(icici.per_lakh_emi)).toBe('₹2,174.24');
    expect(formatRupees(icici.foir_eligibility)).toBe('₹24,65,226.61');
    expect(formatRupees(icici.emi)).toBe('₹39,172.13');
    expect(result.per_lender.map((r) => lenderTone(r.status))).toEqual([
      'eligible',
      'eligible',
      'notServiceable',
      'notEligible',
    ]);
    expect(result.counted_obligations).toEqual([
      {
        index: 1,
        lender: 'Axis Bank',
        loan_type: 'personal',
        emi: 15000,
        source: 'tradeline',
        flag: null,
      },
    ]);
  });

  it('drops a best lender that is not in the list', () => {
    const result = parseCalculateResponse(
      { ...WORKED_EXAMPLE_RESPONSE, best_lender: 'Some Bank' },
      SNEHA,
    );
    expect(result.best_lender).toBeNull();
    expect(() => parseCalculateResponse({ error: 'x' }, SNEHA)).toThrow();
  });

  it('tells a notified CRM webhook from a failed one and from none', () => {
    const notified = parseLoginResponse(LOGIN_NOTIFIED);
    expect(notified.status).toBe('recorded');
    expect(webhookOutcome(notified)).toBe('notified');
    expect(notified.delivery?.http_status).toBe(200);
    expect(webhookOutcome(parseLoginResponse(LOGIN_NO_WEBHOOK))).toBe(
      'notSent',
    );
    expect(webhookOutcome(parseLoginResponse(LOGIN_WEBHOOK_FAILED))).toBe(
      'failed',
    );
    expect(() => parseLoginResponse({})).toThrow();
  });

  it('reads the lender policies', () => {
    const parsed = parseLenders(LENDERS_RESPONSE);
    expect(parsed.sample).toBe(true);
    expect(
      parsed.lenders.map((l) => [l.id, l.name, l.roi, l.max_tenure_months]),
    ).toEqual([
      ['hdfc_bank', 'HDFC Bank', 12, 60],
      ['icici_bank', 'ICICI Bank', 11, 72],
    ]);
    expect(parsed.lenders[1].unlisted_company).toEqual({
      accepted: true,
      foir: 0.5,
      multiplier: 10,
    });
    expect(() => parseLenders({})).toThrow();
  });
});
