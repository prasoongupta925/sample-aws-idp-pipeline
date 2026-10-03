// @vitest-environment node
import {
  CREDIT_BUREAUS,
  CREDIT_REPORT_GUIDE,
  CREDIT_REPORT_HELP_PATH,
  GUIDE_LANGS,
  creditReportHelpHref,
  parseGuideLang,
  type CreditReportGuideText,
} from './creditReportGuide';

const MAIN_SITES = [
  'cibil.com',
  'experian.in',
  'equifax.co.in',
  'crifhighmark.com',
];

const texts = (guide: CreditReportGuideText): string[] =>
  Object.values(guide).flatMap((value) =>
    Array.isArray(value) ? value : [value],
  );

describe('free credit report guide', () => {
  it('links only the four bureaus’ main sites, over https', () => {
    expect(CREDIT_BUREAUS.map((b) => b.site)).toEqual(MAIN_SITES);
    for (const bureau of CREDIT_BUREAUS) {
      const url = new URL(bureau.url);
      expect(url.protocol).toBe('https:');
      expect(url.hostname).toBe(`www.${bureau.site}`);
      expect(url.pathname).toBe('/');
      expect(url.search + url.hash).toBe('');
    }
  });

  it.each(GUIDE_LANGS)('%s: no other address, link or menu path', (lang) => {
    for (const text of texts(CREDIT_REPORT_GUIDE[lang])) {
      expect(text).not.toMatch(/https?:|www\.|\.(com|in|org|net)\b/i);
      // Menu paths ("Products > Free report") change on the bureaus' sites.
      expect(text).not.toMatch(/[>›»→]/);
    }
  });

  it.each(GUIDE_LANGS)(
    '%s: says the report is free once a year from each bureau, and that the DSA cannot pull it',
    (lang) => {
      const guide = CREDIT_REPORT_GUIDE[lang];
      for (const name of [
        'TransUnion CIBIL',
        'Experian',
        'Equifax',
        'CRIF High Mark',
      ]) {
        expect(guide.facts[0]).toContain(name);
      }
      expect(guide.facts[2]).toContain('DSA');
      expect(guide.steps.some((step) => step.includes('PDF'))).toBe(true);
    },
  );

  it('has the same sections in English, Hindi and Marathi', () => {
    const shape = (guide: CreditReportGuideText) =>
      Object.entries(guide).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.length : typeof value,
      ]);
    expect(shape(CREDIT_REPORT_GUIDE.hi)).toEqual(
      shape(CREDIT_REPORT_GUIDE.en),
    );
    expect(shape(CREDIT_REPORT_GUIDE.mr)).toEqual(
      shape(CREDIT_REPORT_GUIDE.en),
    );
    // Hindi and Marathi are written in Devanagari.
    expect(CREDIT_REPORT_GUIDE.hi.title).toMatch(/[ऀ-ॿ]/);
    expect(CREDIT_REPORT_GUIDE.mr.title).toMatch(/[ऀ-ॿ]/);
    expect(CREDIT_REPORT_GUIDE.hi.title).not.toBe(CREDIT_REPORT_GUIDE.mr.title);
  });

  it('builds the link in a language and reads the language back', () => {
    expect(CREDIT_REPORT_HELP_PATH).toBe('/help/credit-report');
    expect(creditReportHelpHref()).toBe('/help/credit-report');
    expect(creditReportHelpHref('hi')).toBe('/help/credit-report?lang=hi');
    expect(creditReportHelpHref('mr')).toBe('/help/credit-report?lang=mr');
    expect(parseGuideLang('mr')).toBe('mr');
    expect(parseGuideLang('ko')).toBe('en');
    expect(parseGuideLang(undefined)).toBe('en');
    expect(parseGuideLang(['hi'])).toBe('en');
  });
});
