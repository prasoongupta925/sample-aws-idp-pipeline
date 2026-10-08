// @vitest-environment node
// "Before you check": sorting the backend's refusals (app/eligibility.py's
// sentences, from precheckFixtures: the engine's own answers) into fields,
// lines and tab counts, and when a background check may run.
import {
  ENGINE_ANSWERS,
  engineAnswer,
  type EngineScenario,
} from '../components/EligibilityPanel/precheckFixtures';
import { NOT_READY_FILE_CHECK } from '../components/EligibilityPanel/fixtures';
import {
  bankRefusals,
  emptyInputs,
  emptyTradeline,
  fieldElementId,
  missingReasonField,
  inputsKey,
  parseCalculateResponse,
  precheckBlock,
  precheckClear,
  precheckKey,
  precheckKeyOf,
  precheckSummary,
  precheckTabCounts,
  reasonField,
  reasonWithoutBank,
  refusalsByField,
  setCibil,
  setEnquiries,
  setLoan,
  setProfile,
  stillNeeded,
} from './eligibility';
import type { EligibilityInputs, StillNeeded } from '../types/eligibility';

const result = (
  scenario: EngineScenario,
  extra: Record<string, unknown> = {},
) => parseCalculateResponse(engineAnswer(scenario, extra), 'Applicant');

/** A form with everything a bank checks filled (nothing still needed). */
function filled(): EligibilityInputs {
  let inputs = setProfile(emptyInputs(), {
    pincode: '401202',
    company: 'Synthetic Cat B Works Pvt Ltd',
    employment_type: 'private_limited',
    net_income: 60000,
  });
  inputs = setCibil(inputs, { score: 690 });
  return setEnquiries(inputs, { d30: 5, d60: 6, d90: 6, d120: 7 });
}

const NONE: StillNeeded[] = [];

describe('reasonField: the field a refusal comes from', () => {
  it('maps every refusal of the engine to a field or "Still needed"', () => {
    const unmapped = Object.values(ENGINE_ANSWERS)
      .flatMap((answer) => answer.per_lender.flatMap((r) => r.reasons))
      .filter((r) => reasonField(r) === null && missingReasonField(r) === null);
    expect(unmapped).toEqual([]);
  });

  it.each([
    ['Pincode 401202 is not serviceable by Axis Bank', 'pincode'],
    [
      'Employment type Partnership/Proprietorship is not accepted by HDFC Bank',
      'employment_type',
    ],
    [
      'HDFC Bank does not lend to CAT U (unlisted) companies (Sheet1, slab 60,000, CAT_U is NA, cell I8)',
      'company',
    ],
    [
      "'Unheard Of Traders Pvt Ltd' is not in Bajaj Finance's company list and Bajaj Finance does not accept unlisted companies",
      'company',
    ],
    [
      "HDFC Bank's policy sheet has no category for a company not in its list",
      'company',
    ],
    [
      "HDFC Bank's FOIR grid has no FOIR for CAT C (it covers CAT A, CAT B)",
      'company',
    ],
    [
      "Not eligible: income ₹20,000 is below HDFC Bank's minimum ₹25,000 (From Policy (your sheet))",
      'net_income',
    ],
    [
      "Net monthly salary ₹20,000 is below HDFC Bank's minimum income of ₹25,000 (the first slab of its FOIR grid)",
      'net_income',
    ],
    [
      'HDFC Bank needs CIBIL >= 710: the score is 690 (Sheet2, HDFC Bank, Cibil Score "710", cell B2)',
      'score',
    ],
    ["CIBIL score 690 is below Bajaj Finance's minimum 700", 'score'],
    ['CIBIL -1: no credit history, and HDFC Bank needs CIBIL >= 750', 'score'],
    // A sheet bank's rule the sheet does not give: the sample policy's, marked.
    [
      "CIBIL score 690 is below HDFC Bank's minimum 750 (Sample: not in your policy sheet)",
      'score',
    ],
    [
      'CIBIL -1: no credit history, and Bandhan Bank needs CIBIL >= 750 (Sample: not in your policy sheet)',
      'score',
    ],
    [
      "9 enquiries in the last 90 days: more than ICICI Bank's limit of 5 (Sample: not in your policy sheet)",
      'enquiries',
    ],
    [
      'Employment type Defence is not accepted by Axis Bank (Sample: not in your policy sheet)',
      'employment_type',
    ],
    [
      '6 enquiries in the last 60 days: more than HDFC Bank\'s limit of 5 (Sheet2, HDFC Bank, Enquiries "Last 60 days 5", cell D2)',
      'enquiries',
    ],
    [
      "1 enquiry in the last 30 days: more than X Bank's limit of 0",
      'enquiries',
    ],
    [
      '10 enquiries in the last 120 days already: more than Indusind Bank\'s limit of 9 in 270 days (Sheet2, Indusind Bank, Enquiries "Last 270 days 9", cell D6)',
      'enquiries',
    ],
    [
      'Existing obligations ₹59,000 leave no room within FOIR 60% of ₹60,000 (₹36,000)',
      'tradelines',
    ],
    [
      '1 credit card marked BT: HDFC Bank does not take over credit cards (Sheet2, HDFC Bank, CCBT "NA", cell W2)',
      'tradelines',
    ],
    [
      '3 personal loans marked BT: HDFC Bank takes over at most 2 personal loans (Sheet2, HDFC Bank, PLBT "2", cell V2)',
      'tradelines',
    ],
    [
      'Eligible amount ₹2,00,000 does not cover the balance transfer of ₹3,00,000',
      'tradelines',
    ],
    [
      'Outstanding not entered for Tradeline 2 (Gold Co, Gold Loan): HDFC Bank counts 1% of a gold loan\'s outstanding a month (Sheet2, HDFC Bank, Gold Loan "0.01", cell AA2)',
      'tradelines',
    ],
  ])('%s -> %s', (reason, field) => {
    expect(reasonField(reason)).toBe(field);
    expect(missingReasonField(reason)).toBeNull();
  });

  it('leaves a refusal no single field causes to the Lenders tab', () => {
    expect(
      reasonField(
        "Eligible amount ₹40,000 is below HDFC Bank's minimum loan ₹50,000",
      ),
    ).toBeNull();
    expect(
      reasonField(
        "Eligible amount ₹48,530.17 is below HDFC Bank's minimum loan ₹50,000 (Sample: not in your policy sheet)",
      ),
    ).toBeNull();
    expect(
      reasonField("HDFC Bank's policy sheet has no ROI for slab 25,000, CAT_B"),
    ).toBeNull();
  });
});

describe('missingReasonField: refusals that only say a field is empty', () => {
  it.each([
    ['Pincode not entered: serviceability cannot be checked', 'pincode'],
    ['Employment type not entered', 'employment_type'],
    ['Company not entered: its category is needed', 'company'],
    ['CIBIL score not entered', 'score'],
    ['Enquiries in the last 270 days not entered', 'enquiries'],
    ['Net monthly income not entered', 'net_income'],
    [
      'EMI not entered for Tradeline 2 (Sample Bank Card, Credit Card) marked Obligate: enter the monthly amount the lender counts for the card (often 5% of the outstanding)',
      'tradelines.2.emi',
    ],
    [
      'Outstanding not entered for Tradeline 3 (Sample Finance, Personal Loan) marked BT: the balance-transfer amount is unknown',
      'tradelines.3.outstanding',
    ],
  ])('%s -> %s', (reason, field) => {
    expect(missingReasonField(reason)).toBe(field);
  });
});

describe('reasonWithoutBank: one line for the banks that give it', () => {
  it.each([
    [
      'HDFC Bank needs CIBIL >= 710: the score is 690 (Sheet2, HDFC Bank, Cibil Score "710", cell B2)',
      'HDFC Bank',
      'Needs CIBIL >= 710: the score is 690',
    ],
    [
      'HDFC Bank does not lend to CAT U (unlisted) companies (Sheet1, slab 60,000, CAT_U is NA, cell I8)',
      'HDFC Bank',
      'Does not lend to CAT U (unlisted) companies',
    ],
    [
      'Pincode 401202 is not serviceable by Axis Bank',
      'Axis Bank',
      'Pincode 401202 is not serviceable',
    ],
    [
      '6 enquiries in the last 60 days: more than HDFC Bank\'s limit of 5 (Sheet2, HDFC Bank, Enquiries "Last 60 days 5", cell D2)',
      'HDFC Bank',
      "6 enquiries in the last 60 days: more than the bank's limit of 5",
    ],
    [
      "Not eligible: income ₹20,000 is below HDFC Bank's minimum ₹25,000 (From Policy (your sheet))",
      'HDFC Bank',
      "Income ₹20,000 is below the bank's minimum ₹25,000",
    ],
    // A rule the sheet does not give is the sample policy's: its mark stays.
    [
      'Employment type Partnership/Proprietorship is not accepted by HDFC Bank (Sample: not in your policy sheet)',
      'HDFC Bank',
      'Employment type Partnership/Proprietorship is not accepted (Sample: not in your policy sheet)',
    ],
    [
      "CIBIL score 690 is below HDFC Bank's minimum 750 (Sample: not in your policy sheet)",
      'HDFC Bank',
      "CIBIL score 690 is below the bank's minimum 750 (Sample: not in your policy sheet)",
    ],
    [
      'CIBIL -1: no credit history, and Bandhan Bank needs CIBIL >= 750 (Sample: not in your policy sheet)',
      'Bandhan Bank',
      'CIBIL -1: no credit history, and the bank needs CIBIL >= 750 (Sample: not in your policy sheet)',
    ],
    [
      "9 enquiries in the last 90 days: more than ICICI Bank's limit of 5 (Sample: not in your policy sheet)",
      'ICICI Bank',
      "9 enquiries in the last 90 days: more than the bank's limit of 5 (Sample: not in your policy sheet)",
    ],
    [
      "Eligible amount ₹48,530.17 is below HDFC Bank's minimum loan ₹50,000 (Sample: not in your policy sheet)",
      'HDFC Bank',
      "Eligible amount ₹48,530.17 is below the bank's minimum loan ₹50,000 (Sample: not in your policy sheet)",
    ],
    [
      "'Unheard Of Traders Pvt Ltd' is not in Bajaj Finance's company list and Bajaj Finance does not accept unlisted companies",
      'Bajaj Finance',
      "'Unheard Of Traders Pvt Ltd' is not in the bank's company list and the bank does not accept unlisted companies",
    ],
    [
      "HDFC Bank's policy sheet has no category for a company not in its list",
      'HDFC Bank',
      "The bank's policy sheet has no category for a company not in its list",
    ],
    // What explains the number stays.
    [
      'Existing obligations ₹59,000 leave no room within FOIR 60% of ₹60,000 (₹36,000)',
      'HDFC Bank',
      'Existing obligations ₹59,000 leave no room within FOIR 60% of ₹60,000 (₹36,000)',
    ],
    [
      "Net monthly salary ₹20,000 is below HDFC Bank's minimum income of ₹25,000 (the first slab of its FOIR grid)",
      'HDFC Bank',
      "Net monthly salary ₹20,000 is below the bank's minimum income of ₹25,000 (the first slab of its FOIR grid)",
    ],
  ])('%s', (reason, bank, line) => {
    expect(reasonWithoutBank(reason, [bank])).toBe(line);
  });

  it('matches the bank in any case (the sheet may spell it otherwise)', () => {
    expect(
      reasonWithoutBank(
        'IndusInd Bank needs CIBIL >= 725: the score is 690 (Sheet2, Indusind Bank, Cibil Score "725", cell B6)',
        ['Indusind Bank'],
      ),
    ).toBe('Needs CIBIL >= 725: the score is 690');
  });
});

describe('bankRefusals: "Banks that will say no"', () => {
  it('puts the banks that do not lend to the category on one line', () => {
    const refusals = bankRefusals(result('cat_u'), NONE);
    expect(refusals).toEqual([
      {
        text: 'Does not lend to CAT U (unlisted) companies',
        lenders: ['HDFC Bank', 'Bandhan Bank'],
        sentences: [
          'HDFC Bank does not lend to CAT U (unlisted) companies (Sheet1, slab 60,000, CAT_U is NA, cell I8)',
          'Bandhan Bank does not lend to CAT U (unlisted) companies (Sheet1, slab 60,000, CAT_U is NA, cell I29)',
        ],
        field: 'company',
      },
      {
        text: 'Pincode 401202 is not serviceable',
        lenders: ['Axis Bank'],
        sentences: ['Pincode 401202 is not serviceable by Axis Bank'],
        field: 'pincode',
      },
    ]);
  });

  it('keeps each bank its own minimum', () => {
    const lines = bankRefusals(result('cibil_enquiries'), NONE).map(
      (r) => `${r.lenders.join(', ')}: ${r.text} [${r.field}]`,
    );
    expect(lines).toEqual([
      'HDFC Bank: Needs CIBIL >= 710: the score is 690 [score]',
      "HDFC Bank: 6 enquiries in the last 60 days: more than the bank's limit of 5 [enquiries]",
      'ICICI Bank: Needs CIBIL >= 720: the score is 690 [score]',
      "ICICI Bank: 5 enquiries in the last 30 days: more than the bank's limit of 4 [enquiries]",
      'Axis Bank: Pincode 401202 is not serviceable [pincode]',
      'Axis Bank: Needs CIBIL >= 750: the score is 690 [score]',
      "Bajaj Finance: CIBIL score 690 is below the bank's minimum 700 [score]",
      "Tata Capital: CIBIL score 690 is below the bank's minimum 725 [score]",
      "Tata Capital: 6 enquiries in the last 90 days: more than the bank's limit of 4 [enquiries]",
      'Bandhan Bank: Needs CIBIL >= 700: the score is 690 [score]',
      'Indusind Bank: Needs CIBIL >= 725: the score is 690 [score]',
    ]);
  });

  it("never shows a sample rule as the sheet's, nor on a line with a bank without that mark", () => {
    // The engine's Grade 4 answer: the sheet gives no employment types, so the
    // 5 sheet banks refuse by the sample policy's (the sheet itself says
    // "Grade 4 employees: Funding" for Axis, Bandhan and IndusInd).
    const refusals = bankRefusals(result('grade_4'), NONE);
    expect(
      refusals.map((r) => `${r.lenders.join(', ')}: ${r.text} [${r.field}]`),
    ).toEqual([
      'HDFC Bank, ICICI Bank, Axis Bank, Bandhan Bank, Indusind Bank: Employment type Grade 4 is not accepted (Sample: not in your policy sheet) [employment_type]',
      'Axis Bank: Pincode 401202 is not serviceable [pincode]',
      'Bajaj Finance: Employment type Grade 4 is not accepted [employment_type]',
    ]);
    expect(refusals[0].sentences).toHaveLength(5);
    expect(refusals[2].sentences).toEqual([
      'Employment type Grade 4 is not accepted by Bajaj Finance',
    ]);
    // The hint under Employment type: the same two lines, the mark kept.
    expect(
      refusalsByField(refusals).employment_type?.map((r) => r.text),
    ).toEqual([
      'Employment type Grade 4 is not accepted (Sample: not in your policy sheet)',
      'Employment type Grade 4 is not accepted',
    ]);
    expect(precheckTabCounts(precheckSummary(result('grade_4'), NONE))).toEqual(
      { profile: 3, cibil: 0, lenders: 0 },
    );
  });

  it('groups the same refusal of many banks', () => {
    const noRoom = bankRefusals(result('no_room'), NONE);
    expect(noRoom.map((r) => [r.lenders.length, r.text])).toEqual([
      [
        5,
        'Existing obligations ₹59,000 leave no room within FOIR 60% of ₹60,000 (₹36,000)',
      ],
      [1, 'Pincode 401202 is not serviceable'],
      [
        1,
        'Existing obligations ₹59,000 leave no room within FOIR 55% of ₹60,000 (₹33,000)',
      ],
      [
        1,
        'Existing obligations ₹59,000 leave no room within FOIR 50% of ₹60,000 (₹30,000)',
      ],
    ]);
    const bt = bankRefusals(result('bt_limits'), NONE);
    expect(bt[0]).toMatchObject({
      text: '1 credit card marked BT: the bank does not take over credit cards',
      lenders: ['HDFC Bank', 'ICICI Bank', 'Bandhan Bank', 'Indusind Bank'],
      field: 'tradelines',
    });
    expect(bt[0].sentences).toHaveLength(4);
    const low = bankRefusals(result('low_income'), NONE);
    expect(low[0]).toMatchObject({
      text: "Income ₹20,000 is below the bank's minimum ₹25,000",
      lenders: [
        'HDFC Bank',
        'ICICI Bank',
        'Axis Bank',
        'Bandhan Bank',
        'Indusind Bank',
      ],
      field: 'net_income',
    });
  });

  it('leaves the empty fields to "Still needed" when it lists them', () => {
    const answer = result('missing');
    const needed = stillNeeded(setCibil(emptyInputs(), { score: 765 }));
    expect(bankRefusals(answer, needed)).toEqual([]);
    // Without that list (another API's), they show, one line each.
    const all = bankRefusals(answer, NONE);
    expect(all[0]).toMatchObject({
      text: 'Pincode not entered: serviceability cannot be checked',
      field: 'pincode',
    });
    expect(all[0].lenders).toHaveLength(7);
  });

  it('leaves a loan without its EMI or outstanding to "Still needed"', () => {
    const inputs = setCibil(filled(), {
      tradelines: [
        { ...emptyTradeline(), emi: 5000 },
        { ...emptyTradeline(), loan_type: 'credit_card', action: 'obligate' },
        { ...emptyTradeline(), action: 'bt', emi: 4000 },
      ],
    });
    const needed = stillNeeded(inputs);
    expect(needed.map((n) => n.field)).toEqual([
      'pan',
      'name',
      'mobile',
      'dob',
      'house_ownership',
      'current_address',
      'permanent_address',
      'loan_amount',
      'tenure_months',
      'tradelines.2.emi',
      'tradelines.3.outstanding',
    ]);
    expect(
      bankRefusals(result('incomplete_loans'), needed).map((r) => r.text),
    ).toEqual(['Pincode 401202 is not serviceable']);
  });

  it('ignores the banks that can lend and works without a result', () => {
    expect(bankRefusals(null, NONE)).toEqual([]);
    expect(bankRefusals(result('clear'), NONE).map((r) => r.lenders)).toEqual([
      ['Axis Bank'],
    ]);
  });

  it('sorts the refusals by field for the hints', () => {
    const byField = refusalsByField(bankRefusals(result('cat_u'), NONE));
    expect(Object.keys(byField)).toEqual(['company', 'pincode']);
    expect(byField.company?.[0].lenders).toEqual(['HDFC Bank', 'Bandhan Bank']);
  });
});

describe('precheckSummary: the box', () => {
  /** "clear" without Axis Bank (its pincode list does not serve 401202). */
  const allLend = () => {
    const answer = engineAnswer('clear');
    return parseCalculateResponse(
      {
        ...answer,
        per_lender: ENGINE_ANSWERS.clear.per_lender.filter(
          (r) => r.lender_id !== 'axis_bank',
        ),
      },
      'Applicant',
    );
  };

  it('is clear when nothing stops a bank, and counts the conditions', () => {
    const summary = precheckSummary(allLend(), stillNeeded(filled()));
    expect(summary).toMatchObject({
      needed: [],
      refusals: [],
      fileIssues: [],
      warnings: [],
      eligible: 6,
      total: 6,
      // HDFC 16, ICICI 15, Bandhan 16, IndusInd 14 (Bajaj and Tata: none).
      conditions: 61,
      conditionBanks: [
        'HDFC Bank',
        'ICICI Bank',
        'Bandhan Bank',
        'Indusind Bank',
      ],
    });
    expect(precheckClear(summary)).toBe(true);
  });

  it('lists the required fields only, of every tab', () => {
    const inputs = setProfile(filled(), { pincode: null });
    const summary = precheckSummary(
      null,
      stillNeeded(setCibil(inputs, { score: null })),
    );
    expect(summary.needed.map((n) => [n.field, n.tab])).toEqual([
      ['pincode', 'profile'],
      ['score', 'cibil'],
    ]);
    expect(summary).toMatchObject({ eligible: null, total: null });
    expect(precheckClear(summary)).toBe(false);
  });

  it("gives the file check's open issues when the file is NOT READY", () => {
    const notReady = precheckSummary(
      result('clear', { file_check: NOT_READY_FILE_CHECK }),
      NONE,
    );
    expect(notReady.fileIssues).toEqual(NOT_READY_FILE_CHECK.issues);
    const ready = precheckSummary(
      result('clear', {
        file_check: { ...NOT_READY_FILE_CHECK, verdict: 'READY', ready: true },
      }),
      NONE,
    );
    expect(ready.fileIssues).toEqual([]);
    const unused = precheckSummary(
      result('clear', { file_check: { ...NOT_READY_FILE_CHECK, used: false } }),
      NONE,
    );
    expect(unused.fileIssues).toEqual([]);
  });

  it('warns of overdues and bank EMIs that match no loan, once each', () => {
    const overdue =
      'Tradeline 1 (Axis Bank, Personal Loan) has an overdue of ₹4,500: lenders usually decline a file with overdues until they are cleared';
    const unmatched =
      "Loan EMI ₹6,677 to 'BAJAJ FIN' in the bank statement matches no tradeline: it is counted as an obligation; add it as a tradeline (or mark that loan Close) to confirm";
    const summary = precheckSummary(
      result('clear', {
        notes: [
          overdue,
          'Running home loan found in the obligations: Tradeline 2 (Home Loan)',
          unmatched,
          unmatched,
        ],
      }),
      NONE,
    );
    expect(summary.warnings).toEqual([overdue, unmatched]);
  });

  it('counts the open items per tab', () => {
    const inputs = setProfile(filled(), { company: null });
    const summary = precheckSummary(
      result('cibil_enquiries', {
        notes: [
          "Tradeline 1 (Axis Bank, Personal Loan) is 'Written off' on the bureau report: lenders usually decline such files",
        ],
      }),
      stillNeeded(inputs),
    );
    // Profile: the company and the pincode refusal; CIBIL: 7 score and 3
    // enquiry refusals and the warning.
    expect(precheckTabCounts(summary)).toEqual({
      profile: 2,
      cibil: 11,
      lenders: 0,
    });
    const unmapped = precheckSummary(
      result('clear', {
        per_lender: [
          {
            lender: 'HDFC Bank',
            lender_id: 'hdfc_bank',
            status: 'not_eligible',
            reasons: [
              "Eligible amount ₹40,000 is below HDFC Bank's minimum loan ₹50,000",
            ],
          },
        ],
      }),
      NONE,
    );
    expect(precheckTabCounts(unmapped)).toEqual({
      profile: 0,
      cibil: 0,
      lenders: 1,
    });
  });
});

describe('precheckBlock: when the banks can be checked in the background', () => {
  it('waits for something a bank checks', () => {
    expect(precheckBlock(emptyInputs())).toBe('empty');
    // Name, mobile and loan amount: no bank rule reads them.
    const named = setLoan(
      setProfile(emptyInputs(), { name: 'Asha', mobile: '9820012345' }),
      { amount: 500000 },
    );
    expect(precheckBlock(named)).toBe('empty');
    expect(precheckBlock(setCibil(emptyInputs(), { score: 690 }))).toBeNull();
    expect(
      precheckBlock(setProfile(emptyInputs(), { pincode: '411045' })),
    ).toBeNull();
    expect(precheckBlock(setEnquiries(emptyInputs(), { d90: 2 }))).toBeNull();
    expect(precheckBlock(filled())).toBeNull();
  });

  it.each<[string, (i: EligibilityInputs) => EligibilityInputs]>([
    ['a pincode being typed', (i) => setProfile(i, { pincode: '4110' })],
    ['a PAN being typed', (i) => setProfile(i, { pan: 'ABCDE12' })],
    ['a short mobile number', (i) => setProfile(i, { mobile: '98200' })],
    ['a future date of birth', (i) => setProfile(i, { dob: '2999-01-01' })],
    [
      'an amount that is not a number',
      (i) => setProfile(i, { net_income: NaN }),
    ],
    ['a score out of range', (i) => setCibil(i, { score: 250 })],
    [
      'enquiries that do not add up',
      (i) => setEnquiries(i, { d30: 5, d60: 2 }),
    ],
    ['a tenure of 0 months', (i) => setLoan(i, { tenure_months: 0 })],
    [
      'a loan paid before it opened',
      (i) =>
        setCibil(i, {
          tradelines: [
            {
              ...emptyTradeline(),
              emi: 900,
              open_date: '2025-05-01',
              last_payment_date: '2025-01-01',
            },
          ],
        }),
    ],
  ])('waits while %s is in red', (_, change) => {
    expect(precheckBlock(change(filled()))).toBe('invalid');
  });

  it('takes the masked PAN of a pre-fill and no credit history', () => {
    expect(
      precheckBlock(
        setProfile(filled(), { pan: 'XXXXXX314M', dob: '1990-04-01' }),
      ),
    ).toBeNull();
    expect(precheckBlock(setCibil(filled(), { score: -1 }))).toBeNull();
  });
});

describe('precheckKey: what the answer depends on', () => {
  it('stays while fields no bank reads are typed', () => {
    const base = precheckKey('ABCDE1234F', filled());
    const typed = setProfile(filled(), {
      name: 'Asha Verma',
      mobile: '9820012345',
      dob: '1990-04-01',
      current_address: 'Flat 2, Pune',
      permanent_address: 'Flat 2, Pune',
      house_ownership: 'rented',
    });
    expect(precheckKey('ABCDE1234F', typed)).toBe(base);
    expect(
      precheckKey(
        'ABCDE1234F',
        setCibil(filled(), {
          source: 'credit_report',
          report_date: '2026-09-20',
        }),
      ),
    ).toBe(base);
  });

  it('changes with what a bank checks, and with the applicant', () => {
    const base = precheckKey('ABCDE1234F', filled());
    const changes: ((i: EligibilityInputs) => EligibilityInputs)[] = [
      (i) => setCibil(i, { score: 760 }),
      (i) => setEnquiries(i, { d90: 7 }),
      (i) => setProfile(i, { pincode: '411045' }),
      (i) => setProfile(i, { company: 'Konkan Softworks Pvt Ltd' }),
      (i) => setProfile(i, { employment_type: 'government' }),
      (i) => setProfile(i, { net_income: 61000 }),
      (i) => setProfile(i, { pan: 'ABCDE1234F' }),
      (i) => setProfile(i, { has_running_home_loan: true }),
      (i) => setLoan(i, { amount: 500000 }),
      (i) => setCibil(i, { tradelines: [{ ...emptyTradeline(), emi: 900 }] }),
    ];
    for (const change of changes) {
      expect(precheckKey('ABCDE1234F', change(filled()))).not.toBe(base);
    }
    expect(precheckKey('Asha Verma', filled())).not.toBe(base);
    // Spacing that the API trims is the same request.
    expect(
      precheckKey('ABCDE1234F', setProfile(filled(), { pincode: ' 401202 ' })),
    ).toBe(base);
  });
});

describe("precheckKeyOf: Check eligibility's result as an answer", () => {
  it('gives the key of the inputs the result was calculated with', () => {
    const inputs = setCibil(
      setProfile(filled(), {
        pan: ' abcde1234f ',
        company: '  Synthetic Cat B Works Pvt Ltd ',
        other_income: [
          {
            key: 'r1',
            type: 'rented',
            amount: 12000,
            frequency: null,
            agreement: 'registered',
          },
          {
            key: 'r2',
            type: 'bonus',
            amount: 60000,
            frequency: 'yearly',
            agreement: null,
          },
        ],
      }),
      {
        tradelines: [
          {
            ...emptyTradeline(),
            lender: ' Axis Bank ',
            emi: 15000,
            outstanding: 410000,
            account_number: 'PL00001234',
            open_date: '2025-07-05',
            source: 'credit_report',
          },
          { ...emptyTradeline(), action: 'bt', outstanding: 18000 },
        ],
      },
    );
    expect(precheckKeyOf('ABCDE1234F', inputsKey(inputs))).toBe(
      precheckKey('ABCDE1234F', inputs),
    );
    expect(precheckKeyOf('ABCDE1234F', null)).toBeNull();
    expect(precheckKeyOf('ABCDE1234F', 'not json')).toBeNull();
  });
});

describe('fieldElementId', () => {
  it.each([
    ['pincode', 'p-pincode'],
    ['net_income', 'p-net_income'],
    ['score', 'p-score'],
    ['enquiries.d90', 'p-enquiries-d90'],
    ['enquiries', 'p-enquiries-d30'],
    ['tradelines.2.emi', 'p-loan-2-emi'],
    ['tradelines', 'p-tradelines'],
  ])('%s -> %s', (field, id) => {
    expect(fieldElementId('p', field)).toBe(id);
  });
});
