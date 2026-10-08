// @vitest-environment node
// "Before you check": sorting the backend's refusals (app/eligibility.py's
// sentences, from precheckFixtures: the engine's own answers) into the fields
// still empty (with what each blocks), one line per cause and tab counts, and
// when a background check may run.
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
  precheckKeyInputs,
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
      .flatMap((answer) =>
        answer.per_lender.flatMap((r) => r.reasons as string[]),
      )
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
    // A gold loan its bank counts by the outstanding: an empty field too.
    [
      'Outstanding not entered for Tradeline 2 (Gold Co, Gold Loan): HDFC Bank counts 1% of a gold loan\'s outstanding a month (Sheet2, HDFC Bank, Gold Loan "0.01", cell AA2)',
      'tradelines.2.outstanding',
    ],
  ])('%s -> %s', (reason, field) => {
    expect(missingReasonField(reason)).toBe(field);
    expect(reasonField(reason)).toBeNull();
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

describe('bankRefusals: "Banks that will say no", one line per cause', () => {
  const lines = (scenario: EngineScenario, needed = NONE) =>
    bankRefusals(result(scenario), needed).map((r) => r.text);

  it('puts the banks that do not lend to the category on one line', () => {
    const refusals = bankRefusals(result('cat_u'), NONE);
    expect(refusals).toEqual([
      {
        text: 'No loans to CAT U (unlisted) companies at HDFC Bank, Bandhan Bank',
        before: 'No loans to CAT U (unlisted) companies at ',
        after: '',
        banks: [
          { name: 'HDFC Bank', value: null },
          { name: 'Bandhan Bank', value: null },
        ],
        lenders: ['HDFC Bank', 'Bandhan Bank'],
        sentences: [
          'HDFC Bank does not lend to CAT U (unlisted) companies (Sheet1, slab 60,000, CAT_U is NA, cell I8)',
          'Bandhan Bank does not lend to CAT U (unlisted) companies (Sheet1, slab 60,000, CAT_U is NA, cell I29)',
        ],
        field: 'company',
      },
      {
        text: 'Pincode 401202 is not serviceable by Axis Bank',
        before: 'Pincode 401202 is not serviceable by ',
        after: '',
        banks: [{ name: 'Axis Bank', value: null }],
        lenders: ['Axis Bank'],
        sentences: ['Pincode 401202 is not serviceable by Axis Bank'],
        field: 'pincode',
      },
    ]);
  });

  it('groups by cause, each bank with its own minimum: one CIBIL line, one line per enquiry rule', () => {
    // 11 sentences of 7 banks; the sheet's and the sample policy's minimums
    // are the same cause (CIBIL 690 too low).
    const refusals = bankRefusals(result('cibil_enquiries'), NONE);
    expect(refusals.map((r) => `${r.text} [${r.field}]`)).toEqual([
      'CIBIL 690 is below the minimum at HDFC Bank (710), ICICI Bank (720), Axis Bank (750), Bajaj Finance (700), Tata Capital (725), Bandhan Bank (700), Indusind Bank (725) [score]',
      '6 enquiries in the last 60 days: over the limit at HDFC Bank (5) [enquiries]',
      '5 enquiries in the last 30 days: over the limit at ICICI Bank (4) [enquiries]',
      'Pincode 401202 is not serviceable by Axis Bank [pincode]',
      '6 enquiries in the last 90 days: over the limit at Tata Capital (4) [enquiries]',
    ]);
    expect(refusals[0].sentences).toHaveLength(7);
    // His session: one line for the three banks, none hidden.
    expect(lines('session', stillNeeded(emptyInputs()))).toEqual([
      'CIBIL 722 is below the minimum at Axis Bank (750), Tata Capital (725), Indusind Bank (725)',
      'No loans to CAT U (unlisted) companies at HDFC Bank, Bandhan Bank',
    ]);
  });

  it('puts the banks of the same enquiry rule on one line, each with its limit', () => {
    const answer = parseCalculateResponse(
      engineAnswer('clear', {
        per_lender: [
          {
            lender: 'Bajaj Finance',
            lender_id: 'bajaj_finance',
            status: 'not_eligible',
            reasons: [
              "6 enquiries in the last 90 days: more than Bajaj Finance's limit of 5",
            ],
          },
          {
            lender: 'Tata Capital',
            lender_id: 'tata_capital',
            status: 'not_eligible',
            reasons: [
              "6 enquiries in the last 90 days: more than Tata Capital's limit of 4",
            ],
          },
          {
            lender: 'Indusind Bank',
            lender_id: 'indusind_bank',
            status: 'not_eligible',
            reasons: [
              '10 enquiries in the last 120 days already: more than Indusind Bank\'s limit of 9 in 270 days (Sheet2, Indusind Bank, Enquiries "Last 270 days 9", cell D6)',
            ],
          },
        ],
      }),
      'Applicant',
    );
    expect(bankRefusals(answer, NONE).map((r) => r.text)).toEqual([
      '6 enquiries in the last 90 days: over the limit at Bajaj Finance (5), Tata Capital (4)',
      '10 enquiries in the last 120 days already: over the limit at Indusind Bank (9 in 270 days)',
    ]);
  });

  it("never shows a sample rule as the sheet's, nor on a line with a bank without that mark", () => {
    // The engine's Grade 4 answer: the sheet gives no employment types, so the
    // 5 sheet banks refuse by the sample policy's (the sheet itself says
    // "Grade 4 employees: Funding" for Axis, Bandhan and IndusInd).
    const refusals = bankRefusals(result('grade_4'), NONE);
    expect(refusals.map((r) => `${r.text} [${r.field}]`)).toEqual([
      'Employment type Grade 4 is not accepted by HDFC Bank, ICICI Bank, Axis Bank, Bandhan Bank, Indusind Bank (Sample: not in your policy sheet) [employment_type]',
      'Pincode 401202 is not serviceable by Axis Bank [pincode]',
      'Employment type Grade 4 is not accepted by Bajaj Finance [employment_type]',
    ]);
    expect(refusals[0].sentences).toHaveLength(5);
    expect(refusals[2].sentences).toEqual([
      'Employment type Grade 4 is not accepted by Bajaj Finance',
    ]);
    // A sheet bank's CIBIL rule from the sample policy: its own line, marked.
    const answer = parseCalculateResponse(
      engineAnswer('clear', {
        per_lender: [
          {
            lender: 'HDFC Bank',
            lender_id: 'hdfc_bank',
            status: 'not_eligible',
            reasons: [
              "CIBIL score 690 is below HDFC Bank's minimum 750 (Sample: not in your policy sheet)",
            ],
          },
          {
            lender: 'ICICI Bank',
            lender_id: 'icici_bank',
            status: 'not_eligible',
            reasons: [
              'ICICI Bank needs CIBIL >= 720: the score is 690 (Sheet2, ICICI Bank, Cibil Score "720", cell B3)',
            ],
          },
        ],
      }),
      'Applicant',
    );
    expect(bankRefusals(answer, NONE).map((r) => r.text)).toEqual([
      'CIBIL 690 is below the minimum at HDFC Bank (750) (Sample: not in your policy sheet)',
      'CIBIL 690 is below the minimum at ICICI Bank (720)',
    ]);
    // The hint under Employment type: the same two lines, the mark kept.
    expect(
      refusalsByField(refusals).employment_type?.map((r) => r.text),
    ).toEqual([
      'Employment type Grade 4 is not accepted by HDFC Bank, ICICI Bank, Axis Bank, Bandhan Bank, Indusind Bank (Sample: not in your policy sheet)',
      'Employment type Grade 4 is not accepted by Bajaj Finance',
    ]);
    expect(precheckTabCounts(precheckSummary(result('grade_4'), NONE))).toEqual(
      { profile: 3, cibil: 0, lenders: 0 },
    );
  });

  it('groups the same cause of many banks, the line of most banks first', () => {
    expect(lines('no_room')).toEqual([
      'Existing obligations ₹59,000 leave no room within the FOIR at HDFC Bank (60%), ICICI Bank (60%), Axis Bank (60%), Bajaj Finance (55%), Tata Capital (50%), Bandhan Bank (60%), Indusind Bank (60%)',
      'Pincode 401202 is not serviceable by Axis Bank',
    ]);
    const bt = bankRefusals(result('bt_limits'), NONE);
    expect(bt[0]).toMatchObject({
      text: '1 credit card marked BT: credit cards are not taken over by HDFC Bank, ICICI Bank, Bandhan Bank, Indusind Bank',
      lenders: ['HDFC Bank', 'ICICI Bank', 'Bandhan Bank', 'Indusind Bank'],
      field: 'tradelines',
    });
    expect(bt[0].sentences).toHaveLength(4);
    expect(lines('low_income')[0]).toBe(
      'Income ₹20,000 is below the minimum at HDFC Bank (₹25,000), ICICI Bank (₹25,000), Axis Bank (₹25,000), Bandhan Bank (₹25,000), Indusind Bank (₹25,000)',
    );
    expect(lines('sample_only')).toEqual([
      'No credit history (CIBIL -1): below the minimum at HDFC Bank (750), ICICI Bank (725), Axis Bank (750), Bajaj Finance (700), Tata Capital (725)',
      'Employment type Partnership/Proprietorship is not accepted by HDFC Bank, Axis Bank',
      'Pincode 401202 is not serviceable by Axis Bank',
    ]);
  });

  it('keeps a sentence no rule knows, one line per sentence with its banks', () => {
    const answer = parseCalculateResponse(
      engineAnswer('clear', {
        per_lender: [
          {
            lender: 'HDFC Bank',
            lender_id: 'hdfc_bank',
            status: 'not_eligible',
            reasons: ['HDFC Bank asks for a new document (cell B9)'],
          },
          {
            lender: 'ICICI Bank',
            lender_id: 'icici_bank',
            status: 'not_eligible',
            reasons: ['ICICI Bank asks for a new document'],
          },
        ],
      }),
      'Applicant',
    );
    expect(bankRefusals(answer, NONE)).toMatchObject([
      {
        text: 'HDFC Bank, ICICI Bank: Asks for a new document',
        field: null,
      },
    ]);
  });

  it('leaves the empty fields to "Still needed", with or without its list', () => {
    const answer = result('missing');
    const needed = stillNeeded(setCibil(emptyInputs(), { score: 765 }));
    expect(bankRefusals(answer, needed)).toEqual([]);
    // Without that list (another API's) they are still needed fields, not refusals.
    expect(bankRefusals(answer, NONE)).toEqual([]);
    expect(precheckSummary(answer, NONE).needed.map((n) => n.field)).toEqual([
      'pincode',
      'employment_type',
      'company',
      'enquiries',
      'net_income',
    ]);
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
    expect(lines('incomplete_loans', needed)).toEqual([
      'Pincode 401202 is not serviceable by Axis Bank',
    ]);
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

describe('precheckSummary: what each empty field blocks', () => {
  it('says which banks need a field, which need only it, and the next step (his 7 Oct check)', () => {
    // The form of his session: everything but the pincode filled.
    const inputs = setCibil(setProfile(filled(), { pincode: null }), {
      score: 722,
    });
    const summary = precheckSummary(result('session'), stillNeeded(inputs), {
      inputs,
    });
    const all = [
      'HDFC Bank',
      'ICICI Bank',
      'Axis Bank',
      'Bajaj Finance',
      'Tata Capital',
      'Bandhan Bank',
      'Indusind Bank',
    ];
    expect(summary.needed).toEqual([
      {
        field: 'pincode',
        required: true,
        tab: 'profile',
        fromDocuments: false,
        banks: all,
        only: ['ICICI Bank', 'Bajaj Finance'],
      },
    ]);
    // Enter the pincode: ICICI Bank and Bajaj Finance need only that.
    expect(summary.next).toEqual({
      fields: ['pincode'],
      banks: ['ICICI Bank', 'Bajaj Finance'],
    });
    expect(summary).toMatchObject({ eligible: 0, total: 7 });
  });

  it('keeps "in the documents" for a field a document holds', () => {
    const inputs = setProfile(filled(), { pincode: null });
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
      result('session'),
      stillNeeded(inputs, sources),
      { inputs },
    );
    expect(summary.needed[0]).toMatchObject({
      field: 'pincode',
      fromDocuments: true,
    });
  });

  it('picks the fewest fields that let the most banks lend', () => {
    const answer = result('missing');
    const inputs = setCibil(emptyInputs(), { score: 765 });
    const summary = precheckSummary(answer, stillNeeded(inputs), { inputs });
    // Every bank waits for the same 5 fields, and for nothing else.
    expect(summary.next).toEqual({
      fields: [
        'pincode',
        'company',
        'employment_type',
        'net_income',
        'enquiries.d90',
      ],
      banks: [
        'HDFC Bank',
        'ICICI Bank',
        'Axis Bank',
        'Bajaj Finance',
        'Tata Capital',
        'Bandhan Bank',
        'Indusind Bank',
      ],
    });
    expect(summary.needed.every((n) => n.banks?.length === 7)).toBe(true);
    expect(summary.needed.every((n) => n.only.length === 0)).toBe(true);
    // The loans without an EMI or outstanding: 6 banks need only those two.
    const loans = setCibil(filled(), {
      tradelines: [
        { ...emptyTradeline(), emi: 5000 },
        { ...emptyTradeline(), loan_type: 'credit_card', action: 'obligate' },
        { ...emptyTradeline(), action: 'bt', emi: 4000 },
      ],
    });
    expect(
      precheckSummary(result('incomplete_loans'), stillNeeded(loans), {
        inputs: loans,
      }).next,
    ).toEqual({
      fields: ['tradelines.2.emi', 'tradelines.3.outstanding'],
      banks: [
        'HDFC Bank',
        'ICICI Bank',
        'Bajaj Finance',
        'Tata Capital',
        'Bandhan Bank',
        'Indusind Bank',
      ],
    });
  });

  it('has no consequences without an answer, and no next step when every bank also refuses', () => {
    const inputs = setProfile(filled(), { pincode: null });
    const none = precheckSummary(null, stillNeeded(inputs), { inputs });
    expect(none.needed).toMatchObject([
      { field: 'pincode', banks: null, only: [] },
    ]);
    expect(none.next).toBeNull();
    // cibil_enquiries with the pincode emptied on screen since: an answer for
    // other inputs names no empty pincode, and every bank refuses anyway.
    const old = precheckSummary(
      result('cibil_enquiries'),
      stillNeeded(inputs),
      {
        inputs,
      },
    );
    expect(old.needed).toMatchObject([
      { field: 'pincode', banks: [], only: [] },
    ]);
    expect(old.next).toBeNull();
  });

  it("adds an empty field the answer names but the list does not: a gold loan's outstanding", () => {
    const gold = setCibil(filled(), {
      tradelines: [
        { ...emptyTradeline(), emi: 5000 },
        {
          ...emptyTradeline(),
          loan_type: 'gold' as never,
          lender: 'Gold Co',
          emi: 1500,
        },
      ],
    });
    const summary = precheckSummary(result('gold'), stillNeeded(gold), {
      inputs: gold,
    });
    expect(summary.needed).toEqual([
      {
        field: 'tradelines.2.outstanding',
        required: true,
        tab: 'cibil',
        fromDocuments: false,
        loan: { number: 2, lender: 'Gold Co', loanType: 'gold' },
        banks: ['HDFC Bank', 'ICICI Bank', 'Indusind Bank'],
        only: ['HDFC Bank', 'ICICI Bank', 'Indusind Bank'],
      },
    ]);
    expect(summary.refusals.map((r) => r.text)).toEqual([
      'Pincode 401202 is not serviceable by Axis Bank',
    ]);
    expect(precheckTabCounts(summary)).toEqual({
      profile: 1,
      cibil: 1,
      lenders: 0,
    });
    // Typed since (the answer is for other inputs): not still needed.
    const typed = setCibil(gold, {
      tradelines: gold.cibil.tradelines.map((row, i) =>
        i === 1 ? { ...row, outstanding: 80000 } : row,
      ),
    });
    expect(
      precheckSummary(result('gold'), stillNeeded(typed), { inputs: typed })
        .needed,
    ).toEqual([]);
  });
});

describe('precheckSummary: an answer for other inputs', () => {
  const ALL = [
    'HDFC Bank',
    'ICICI Bank',
    'Axis Bank',
    'Bajaj Finance',
    'Tata Capital',
    'Bandhan Bank',
    'Indusind Bank',
  ];

  it('puts no bank in "needs only" nor the next step while a field it called empty has been filled since', () => {
    // The answer of the empty form (5 fields per bank); 4 of them typed since.
    const answer = result('missing');
    const typed = setProfile(setCibil(emptyInputs(), { score: 765 }), {
      pincode: '401202',
      company: 'Synthetic Cat B Works Pvt Ltd',
      employment_type: 'private_limited',
      net_income: 60000,
    });
    const summary = precheckSummary(answer, stillNeeded(typed), {
      inputs: typed,
    });
    // Every bank still asks for the enquiries; none of them is known to need
    // only that: each may refuse the pincode or the company typed.
    expect(summary.needed).toMatchObject([
      { field: 'enquiries.d90', banks: ALL, only: [] },
    ]);
    expect(summary.next).toBeNull();
    // Only the pincode typed since: not "all 7 banks need only those 4".
    const one = setProfile(setCibil(emptyInputs(), { score: 765 }), {
      pincode: '401202',
    });
    const partly = precheckSummary(answer, stillNeeded(one), { inputs: one });
    expect(partly.needed.map((n) => n.field)).toEqual([
      'company',
      'employment_type',
      'net_income',
      'enquiries.d90',
    ]);
    expect(partly.needed.every((n) => n.banks?.length === 7)).toBe(true);
    expect(partly.needed.every((n) => n.only.length === 0)).toBe(true);
    expect(partly.next).toBeNull();
    // The same answer for the inputs it was calculated with: all 7 need only those 5.
    const empty = setCibil(emptyInputs(), { score: 765 });
    expect(
      precheckSummary(answer, stillNeeded(empty), { inputs: empty }).next
        ?.banks,
    ).toEqual(ALL);
  });

  it('keeps the next step of the banks whose answer still holds', () => {
    // His 7 Oct answer, the score raised since: ICICI and Bajaj named the
    // pincode only, which is still empty, so they still need only that.
    const inputs = setCibil(
      setProfile(filled(), {
        pincode: null,
        company: 'Unheard Of Traders Pvt Ltd',
      }),
      { score: 790 },
    );
    const summary = precheckSummary(result('session'), stillNeeded(inputs), {
      inputs,
    });
    expect(summary.next).toEqual({
      fields: ['pincode'],
      banks: ['ICICI Bank', 'Bajaj Finance'],
    });
  });
});

describe('precheckSummary: a field no bank asks for', () => {
  /** Every bank but Axis (its pincodes) lends: none asks for the net income (the file check verified the salary). */
  const verifiedSalary = () =>
    parseCalculateResponse(
      engineAnswer('clear', {
        per_lender: ENGINE_ANSWERS.clear.per_lender.filter(
          (r) => r.lender_id !== 'axis_bank',
        ),
        income: {
          net_salary: 60000,
          net_salary_source: 'verified',
          entered_net_income: null,
          verified_net_income: 60000,
        },
      }),
      'Applicant',
    );

  it('is not "Still needed" when the answer saw it empty and no bank asked for it', () => {
    const inputs = setProfile(filled(), { net_income: null });
    const summary = precheckSummary(verifiedSalary(), stillNeeded(inputs), {
      inputs,
      answered: inputs,
    });
    expect(summary.needed).toEqual([]);
    expect(precheckClear(summary)).toBe(true);
    expect(precheckTabCounts(summary)).toEqual({
      profile: 0,
      cibil: 0,
      lenders: 0,
    });
    // The answer's inputs from its key, as the panel has them: the same.
    expect(
      precheckSummary(verifiedSalary(), stillNeeded(inputs), {
        inputs,
        answered: precheckKeyInputs(precheckKey('Applicant', inputs)),
      }).needed,
    ).toEqual([]);
  });

  it("stays listed when the answer saw it filled, or without the answer's inputs", () => {
    // Emptied since: that answer says nothing about it.
    const inputs = setProfile(filled(), { net_income: null });
    const filledThen = precheckSummary(verifiedSalary(), stillNeeded(inputs), {
      inputs,
      answered: filled(),
    });
    expect(filledThen.needed).toMatchObject([
      { field: 'net_income', banks: [], only: [] },
    ]);
    expect(precheckClear(filledThen)).toBe(false);
    expect(
      precheckSummary(verifiedSalary(), stillNeeded(inputs), { inputs }).needed,
    ).toMatchObject([{ field: 'net_income' }]);
    // No answer yet: nothing is known about any field.
    expect(
      precheckSummary(null, stillNeeded(inputs), { inputs, answered: inputs })
        .needed,
    ).toMatchObject([{ field: 'net_income', banks: null }]);
  });

  it('keeps a field the banks ask for', () => {
    // The empty form's answer names all five: each stays.
    const empty = setCibil(emptyInputs(), { score: 765 });
    expect(
      precheckSummary(result('missing'), stillNeeded(empty), {
        inputs: empty,
        answered: empty,
      }).needed.map((n) => n.field),
    ).toEqual([
      'pincode',
      'company',
      'employment_type',
      'net_income',
      'enquiries.d90',
    ]);
  });
});

describe('precheckSummary: a refusal of an empty company is "Still needed: Company"', () => {
  it('never shows "does not lend to CAT U" when no employer is entered', () => {
    const inputs = setProfile(filled(), { company: null });
    const summary = precheckSummary(result('no_company'), stillNeeded(inputs), {
      inputs,
    });
    expect(summary.refusals.map((r) => r.text)).toEqual([
      'Pincode 401202 is not serviceable by Axis Bank',
    ]);
    expect(summary.needed).toMatchObject([
      {
        field: 'company',
        banks: [
          'HDFC Bank',
          'ICICI Bank',
          'Axis Bank',
          'Bajaj Finance',
          'Tata Capital',
          'Bandhan Bank',
          'Indusind Bank',
        ],
        // HDFC and Bandhan too: their CAT U refusal is the empty company's.
        only: [
          'HDFC Bank',
          'ICICI Bank',
          'Bajaj Finance',
          'Tata Capital',
          'Bandhan Bank',
          'Indusind Bank',
        ],
      },
    ]);
    expect(summary.next?.fields).toEqual(['company']);
    expect(precheckTabCounts(summary)).toEqual({
      profile: 2,
      cibil: 0,
      lenders: 0,
    });
  });

  it("folds the sheet's missing CAT_U values too, but not a typed company's refusals", () => {
    const answer = parseCalculateResponse(
      engineAnswer('clear', {
        per_lender: [
          {
            lender: 'HDFC Bank',
            lender_id: 'hdfc_bank',
            status: 'not_eligible',
            reasons: [
              "HDFC Bank's policy sheet has no ROI for slab 25,000, CAT_U",
              'Company not entered: its category is needed',
            ],
          },
          {
            lender: 'ICICI Bank',
            lender_id: 'icici_bank',
            status: 'not_eligible',
            reasons: [
              "ICICI Bank's policy sheet has no category for a company not in its list",
              'Company not entered: its category is needed',
            ],
          },
        ],
      }),
      'Applicant',
    );
    const inputs = setProfile(filled(), { company: null });
    const summary = precheckSummary(answer, stillNeeded(inputs), { inputs });
    expect(summary.refusals).toEqual([]);
    expect(summary.needed[0].only).toEqual(['HDFC Bank', 'ICICI Bank']);
    // A company typed (unlisted): the same CAT U answer is the bank's.
    const typed = setProfile(filled(), {
      company: 'Unheard Of Traders Pvt Ltd',
    });
    expect(
      precheckSummary(result('cat_u'), stillNeeded(typed), { inputs: typed })
        .refusals[0].text,
    ).toBe('No loans to CAT U (unlisted) companies at HDFC Bank, Bandhan Bank');
  });
});

describe('precheckSummary: no alarms while typing', () => {
  it('holds the refusals of the field being typed in, and is not clear meanwhile', () => {
    const typed = setProfile(filled(), { company: 'Unheard Of Traders' });
    const needed = stillNeeded(typed);
    const shown = precheckSummary(result('cat_u'), needed, { inputs: typed });
    expect(shown.refusals.map((r) => r.field)).toEqual(['company', 'pincode']);
    const held = precheckSummary(result('cat_u'), needed, {
      inputs: typed,
      held: 'company',
    });
    expect(held.refusals.map((r) => r.field)).toEqual(['pincode']);
    expect(held.held).toBe(1);
    expect(precheckClear(held)).toBe(false);
    expect(precheckTabCounts(held)).toEqual({
      profile: 1,
      cibil: 0,
      lenders: 0,
    });
    // Another field held: nothing of the company's is.
    expect(
      precheckSummary(result('cat_u'), needed, {
        inputs: typed,
        held: 'score',
      }).refusals,
    ).toHaveLength(2);
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

  it('gives overdues and written-off loans as likely refusals, bank EMIs that match no loan to check by hand, once each', () => {
    const overdue =
      'Tradeline 1 (Axis Bank, Personal Loan) has an overdue of ₹4,500: lenders usually decline a file with overdues until they are cleared';
    const writtenOff =
      "Tradeline 2 (Sample Finance, Personal Loan) is 'Written off' on the bureau report: lenders usually decline such files";
    const unmatched =
      "Loan EMI ₹6,677 to 'BAJAJ FIN' in the bank statement matches no tradeline: it is counted as an obligation; add it as a tradeline (or mark that loan Close) to confirm";
    const summary = precheckSummary(
      result('clear', {
        notes: [
          overdue,
          'Running home loan found in the obligations: Tradeline 2 (Home Loan)',
          unmatched,
          writtenOff,
          unmatched,
          overdue,
        ],
      }),
      NONE,
    );
    expect(summary.declines).toEqual([overdue, writtenOff]);
    expect(summary.warnings).toEqual([unmatched]);
    expect(precheckTabCounts(summary).cibil).toBe(3);
    // A likely refusal alone: not clear.
    const declineOnly = precheckSummary(
      parseCalculateResponse(
        engineAnswer('clear', {
          per_lender: ENGINE_ANSWERS.clear.per_lender.filter(
            (r) => r.lender_id !== 'axis_bank',
          ),
          notes: [overdue],
        }),
        'Applicant',
      ),
      NONE,
    );
    expect(declineOnly).toMatchObject({ declines: [overdue], warnings: [] });
    expect(precheckClear(declineOnly)).toBe(false);
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
    // Profile: the company and the pincode line; CIBIL: one CIBIL line for
    // the 7 banks, 3 enquiry lines and the warning.
    expect(precheckTabCounts(summary)).toEqual({
      profile: 2,
      cibil: 5,
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
    // A new policy sheet or company list (or Reload): the same inputs again.
    expect(precheckKey('ABCDE1234F', filled(), 1)).not.toBe(base);
    expect(precheckKey('ABCDE1234F', filled(), 0)).toBe(base);
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
    // Calculated before the policy changed: not the key of the inputs now.
    expect(precheckKeyOf('ABCDE1234F', inputsKey(inputs), 2)).toBe(
      precheckKey('ABCDE1234F', inputs, 2),
    );
    expect(precheckKeyOf('ABCDE1234F', inputsKey(inputs), 1)).not.toBe(
      precheckKey('ABCDE1234F', inputs, 2),
    );
    expect(precheckKeyOf('ABCDE1234F', null)).toBeNull();
    expect(precheckKeyOf('ABCDE1234F', 'not json')).toBeNull();
  });
});

describe('precheckKeyInputs: what an answer saw', () => {
  it('gives back the inputs a key was made from, as far as a bank checks them', () => {
    const inputs = setCibil(
      setProfile(filled(), {
        pan: 'ABCDE1234F',
        name: 'Asha Verma',
        net_income: null,
        has_running_home_loan: false,
        other_income: [
          {
            key: 'r1',
            type: 'rented',
            amount: 12000,
            frequency: null,
            agreement: 'registered',
          },
        ],
      }),
      {
        tradelines: [
          {
            ...emptyTradeline(),
            lender: 'Axis Bank',
            emi: 15000,
            overdue: 4500,
            open_date: '2025-07-05',
            source: 'credit_report',
          },
          { ...emptyTradeline(), action: 'bt', outstanding: null },
        ],
      },
    );
    const key = precheckKey('ABCDE1234F', inputs, 3);
    const seen = precheckKeyInputs(key);
    expect(seen && precheckKey('ABCDE1234F', seen, 3)).toBe(key);
    expect(seen?.profile).toMatchObject({
      pan: 'ABCDE1234F',
      pincode: '401202',
      net_income: null,
      // Not in the key: no bank reads it.
      name: null,
    });
    expect(seen?.cibil.tradelines[1]).toMatchObject({
      action: 'bt',
      outstanding: null,
    });
    // Check eligibility's result: its key from its inputsKey.
    expect(
      precheckKeyInputs(precheckKeyOf('ABCDE1234F', inputsKey(inputs)))?.cibil
        .enquiries,
    ).toEqual(inputs.cibil.enquiries);
    expect(precheckKeyInputs(null)).toBeNull();
    expect(precheckKeyInputs('not json')).toBeNull();
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
