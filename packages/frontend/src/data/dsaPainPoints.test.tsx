// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '../i18n/locales/en.json';
import DsaPainPointsPanel from '../components/DsaPainPointsPanel';
import {
  DSA_PAIN_POINTS,
  PAIN_POINTS_BY_ID,
  painPointForFinding,
} from './dsaPainPoints';

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  });
});

const HABILE_POSTS = new Set([
  'https://www.habilelabs.io/blog/nbfc-dpdp-compliance-by-2027',
  'https://www.habilelabs.io/blog/dpdp-compliance-for-nbfc-what-rule-6-actually-requires',
  'https://www.habilelabs.io/blog/document-management-system-for-nbfcs',
  'https://www.habilelabs.io/blog/document-intelligence-for-nbfcs-2026-trends',
]);

describe('DSA pain points', () => {
  it('has 6 to 8 complete cards from the Habile Labs posts', () => {
    expect(DSA_PAIN_POINTS.length).toBeGreaterThanOrEqual(6);
    expect(DSA_PAIN_POINTS.length).toBeLessThanOrEqual(8);
    expect(new Set(DSA_PAIN_POINTS.map((p) => p.id)).size).toBe(
      DSA_PAIN_POINTS.length,
    );
    for (const p of DSA_PAIN_POINTS) {
      for (const field of [
        p.title,
        p.tag,
        p.quote,
        p.sourceTitle,
        p.forDsa,
        p.feature,
      ]) {
        expect(field.trim().length).toBeGreaterThan(0);
      }
      expect(HABILE_POSTS.has(p.sourceUrl)).toBe(true);
      expect(['file-check', 'ask', 'obligations', 'retention']).toContain(
        p.showMe,
      );
      // A short line from the post, not a paragraph.
      expect(p.quote.length).toBeLessThanOrEqual(120);
      expect(PAIN_POINTS_BY_ID[p.id]).toBe(p);
    }
    // Every post of the series is used, and every "Show me" target.
    expect(new Set(DSA_PAIN_POINTS.map((p) => p.sourceUrl))).toEqual(
      HABILE_POSTS,
    );
    expect(new Set(DSA_PAIN_POINTS.map((p) => p.showMe))).toEqual(
      new Set(['file-check', 'ask', 'obligations', 'retention']),
    );
  });

  it('uses the corrected DPDP wording and makes no compliance claim', () => {
    const all = DSA_PAIN_POINTS.map((p) =>
      [p.title, p.forDsa, p.feature, p.correction ?? ''].join(' '),
    ).join(' ');
    expect(all).toContain('13 May 2027');
    expect(all).toMatch(/masking as one example safeguard/);
    expect(all).toMatch(/Rule 3 sets what the notice to the customer/);
    expect(all).not.toMatch(/DPDP[- ]compliant|guarantee|never leaves India/i);
    // Masking is never presented as mandatory.
    expect(all).not.toMatch(/masking is (required|mandatory)/i);
  });

  it('maps findings to cards', () => {
    expect(
      painPointForFinding({ kind: 'item', status: 'MISSING', required: true }),
    ).toBe('incomplete-files');
    expect(
      painPointForFinding({ kind: 'item', status: 'MISSING', required: false }),
    ).toBeNull();
    expect(painPointForFinding({ kind: 'item', status: 'PRESENT' })).toBeNull();
    expect(painPointForFinding({ kind: 'item', status: 'REVIEW' })).toBe(
      'manual-verification',
    );
    expect(
      painPointForFinding({
        kind: 'consistency',
        checkId: 'declared_vs_bank_credits',
        status: 'MISMATCH',
      }),
    ).toBe('manual-verification');
    expect(
      painPointForFinding({
        kind: 'consistency',
        checkId: 'declared_emis_vs_bank_debits',
        status: 'REVIEW',
      }),
    ).toBe('bank-statement-structuring');
    expect(
      painPointForFinding({
        kind: 'consistency',
        checkId: 'foir',
        status: 'MISMATCH',
      }),
    ).toBe('bank-statement-structuring');
    expect(
      painPointForFinding({
        kind: 'consistency',
        checkId: 'pan',
        status: 'OK',
      }),
    ).toBeNull();
    expect(
      painPointForFinding({
        kind: 'consistency',
        checkId: 'unknown_check',
        status: 'MISMATCH',
      }),
    ).toBeNull();
  });
});

describe('DsaPainPointsPanel', () => {
  it('renders every card with its quote, source and "Show me" button', () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <DsaPainPointsPanel
          onClose={() => undefined}
          onShowMe={() => undefined}
          focusId="bank-statement-structuring"
        />
      </I18nextProvider>,
    );
    expect(html.match(/data-card="/g)).toHaveLength(DSA_PAIN_POINTS.length);
    expect(html).toContain('Why DSAs need this');
    expect(html).toContain(
      '“Flag incomplete document sets before they reach underwriting.”',
    );
    expect(html).toContain(
      'href="https://www.habilelabs.io/blog/document-intelligence-for-nbfcs-2026-trends" target="_blank" rel="noopener noreferrer"',
    );
    expect(html).toContain('Show me obligations &amp; FOIR');
    expect(html).toContain('Show me Ask');
    expect(html).toContain('Show me the 7-day retention');
    expect(html).toContain('Show me the file check');
    expect(html).toContain('Said more precisely');
    // The card a finding's tag pointed to is highlighted.
    const focused = html.slice(
      html.indexOf('data-card="bank-statement-structuring"'),
    );
    expect(focused.slice(0, 200)).toContain('ring-2');
    const other = html.slice(html.indexOf('data-card="incomplete-files"'));
    expect(other.slice(0, 200)).not.toContain('ring-2');
  });
});
