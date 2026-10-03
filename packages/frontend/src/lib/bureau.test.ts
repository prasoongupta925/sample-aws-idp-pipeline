// @vitest-environment node
import type { EligibilityInputs } from '../types/eligibility';
import {
  NO_CONSENT,
  applyBureauCibil,
  bureauPath,
  bureauPullBody,
  cibilHasData,
  consentReferenceLooksValid,
  fetchBureauStatus,
  parseBureauPull,
  parseBureauStatus,
  pullBureauReport,
  pullPan,
} from './bureau';
import { emptyInputs, inputsBody, normalizeInputs } from './eligibility';
import { RAHUL_PULL_RESPONSE } from '../components/EligibilityPanel/bureauFixtures';

const RAHUL_PAN = 'BQXPD4821K';

function withProfile(
  profile: Partial<EligibilityInputs['profile']>,
): EligibilityInputs {
  const inputs = emptyInputs();
  return { ...inputs, profile: { ...inputs.profile, ...profile } };
}

describe('bureau status and pull answers', () => {
  it('reads the provider; anything unexpected is no bureau', () => {
    expect(
      parseBureauStatus({
        provider: 'mock',
        enabled: true,
        sample: true,
        label: 'Mock bureau',
        detail: null,
      }),
    ).toEqual({
      provider: 'mock',
      enabled: true,
      sample: true,
      label: 'Mock bureau',
      detail: null,
    });
    expect(parseBureauStatus('oops')).toEqual({
      provider: 'none',
      enabled: false,
      sample: false,
      label: null,
      detail: null,
    });
    expect(
      parseBureauStatus({ provider: 'mock', enabled: 'yes' }).enabled,
    ).toBe(false);
  });

  it('reads the CIBIL block of a found report like saved inputs', () => {
    const pull = parseBureauPull(RAHUL_PULL_RESPONSE);
    expect(pull.found).toBe(true);
    expect(pull.consentId).toBe('3f2a9c1e5b7d4e8fa0b1c2d3e4f50617');
    expect(pull.nameOnReport).toBe('Rahul Vijay Deshmukh');
    expect(pull.notes).toHaveLength(1);
    const cibil = pull.cibil;
    expect(cibil?.score).toBe(771);
    expect(cibil?.source).toBe('bureau');
    expect(cibil?.report_date).toBe('2026-10-03');
    expect(cibil?.enquiries).toEqual({ d30: 0, d60: 1, d90: 1, d120: 2 });
    expect(
      cibil?.tradelines.map((t) => [t.loan_type, t.action, t.source]),
    ).toEqual([
      ['car', 'obligate', 'bureau'],
      ['credit_card', 'obligate', 'bureau'],
    ]);
    // Exactly what saving the form sends back.
    if (!cibil) throw new Error('no CIBIL block');
    const inputs = applyBureauCibil(emptyInputs(), cibil);
    expect(inputsBody(inputs).cibil).toEqual(
      inputsBody(normalizeInputs({ cibil: RAHUL_PULL_RESPONSE.cibil })).cibil,
    );
  });

  it('reads a no-hit answer', () => {
    const pull = parseBureauPull({
      found: false,
      provider: 'mock',
      consent_id: 'abc',
      cibil: null,
      notes: ['The bureau has no record for PAN XXXXXX926L'],
    });
    expect([pull.found, pull.cibil, pull.notes]).toEqual([
      false,
      null,
      ['The bureau has no record for PAN XXXXXX926L'],
    ]);
    expect(parseBureauPull({ found: true }).found).toBe(false);
  });
});

describe('the PAN a pull uses', () => {
  it('takes the form PAN, else the applicant PAN', () => {
    expect(pullPan('Rahul', withProfile({ pan: 'bqxpd 4821k' }))).toEqual({
      pan: RAHUL_PAN,
      problem: null,
    });
    expect(pullPan(RAHUL_PAN, withProfile({ pan: 'XXXXXX821K' }))).toEqual({
      pan: RAHUL_PAN,
      problem: null,
    });
    expect(pullPan(RAHUL_PAN, emptyInputs()).pan).toBe(RAHUL_PAN);
  });

  it('needs a full PAN that is the applicant’s', () => {
    expect(pullPan('Rahul', withProfile({ pan: 'XXXXXX821K' })).problem).toBe(
      'missing',
    );
    expect(pullPan('Rahul', emptyInputs()).problem).toBe('missing');
    expect(pullPan(RAHUL_PAN, withProfile({ pan: 'CKRPK7314M' })).problem).toBe(
      'mismatch',
    );
    expect(pullPan(RAHUL_PAN, withProfile({ pan: 'XXXXXX314M' })).problem).toBe(
      'mismatch',
    );
  });
});

describe('the pull request', () => {
  it('sends the consent and the identity values the API accepts', () => {
    const inputs = withProfile({
      pan: 'XXXXXX821K',
      name: ' Rahul Vijay Deshmukh ',
      dob: '1992-02-14',
      mobile: '+91 90000 00101',
    });
    expect(
      bureauPullBody(RAHUL_PAN, inputs, {
        given: true,
        method: 'signed_form',
        reference: ' FORM-12 ',
      }),
    ).toEqual({
      applicant: RAHUL_PAN,
      consent: { given: true, method: 'signed_form', reference: 'FORM-12' },
      pan: 'XXXXXX821K',
      name: 'Rahul Vijay Deshmukh',
      dob: '1992-02-14',
      mobile: '+91 90000 00101',
    });
  });

  it('leaves out values the API would refuse', () => {
    const inputs = withProfile({
      pan: 'BQXPD4821',
      name: '  ',
      dob: '2999-01-01',
      mobile: '12345',
    });
    expect(
      bureauPullBody('Rahul', inputs, { ...NO_CONSENT, given: true }),
    ).toEqual({
      applicant: 'Rahul',
      consent: { given: true, method: 'otp' },
    });
  });

  it('checks the consent reference like the API', () => {
    expect(consentReferenceLooksValid('')).toBe(true);
    expect(consentReferenceLooksValid('OTP-2026/1042 #3')).toBe(true);
    expect(consentReferenceLooksValid('otp 1234, call me')).toBe(false);
    expect(consentReferenceLooksValid('x'.repeat(65))).toBe(false);
  });

  it('calls GET .../bureau and POST .../bureau/fetch', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const fetchApi = async <T>(url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return (
        url.endsWith('/fetch')
          ? RAHUL_PULL_RESPONSE
          : { provider: 'none', enabled: false }
      ) as T;
    };
    expect(bureauPath('proj_1')).toBe('projects/proj_1/eligibility/bureau');
    expect((await fetchBureauStatus(fetchApi, 'proj_1')).enabled).toBe(false);
    const body = {
      applicant: RAHUL_PAN,
      consent: { given: true, method: 'otp' },
    };
    expect((await pullBureauReport(fetchApi, 'proj_1', body)).found).toBe(true);
    expect(calls[0]).toEqual(['projects/proj_1/eligibility/bureau', undefined]);
    expect(calls[1][0]).toBe('projects/proj_1/eligibility/bureau/fetch');
    expect(calls[1][1]?.method).toBe('POST');
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual(body);
  });
});

describe('putting the report in the form', () => {
  it('replaces the whole CIBIL block and keeps what the documents give', () => {
    const before = emptyInputs();
    before.cibil = {
      score: 690,
      enquiries: { d30: 1, d60: 1, d90: 1, d120: 1 },
      tradelines: [],
      source: 'credit_report',
      report_date: '2026-05-01',
      sources: {},
    };
    expect(cibilHasData(before.cibil)).toBe(true);
    expect(cibilHasData(emptyInputs().cibil)).toBe(false);
    const report = parseBureauPull(RAHUL_PULL_RESPONSE).cibil;
    if (!report) throw new Error('no CIBIL block');
    const after = applyBureauCibil(before, { ...report, report_date: null });
    expect(after.cibil.score).toBe(771);
    expect(after.cibil.source).toBe('bureau');
    expect(after.cibil.report_date).toBeNull();
    expect(after.cibil.sources).toBe(before.cibil.sources);
    expect(after.profile).toBe(before.profile);
  });
});
