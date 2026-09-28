// @vitest-environment node
// (Rendered to static markup: the workspace's jsdom install cannot start.)
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '../../i18n/locales/en.json';
import VerdictCard from './VerdictCard';
import { NOT_READY_RESULT, READY_WITH_REVIEW_RESULT } from './fixtures';
import type { FileCheckResult } from '../../types/fileCheck';

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  });
});

function renderCard(result: FileCheckResult): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <VerdictCard result={result} />
    </I18nextProvider>,
  );
}

/** Opening tag of the verdict banner. */
function bannerTag(html: string): string {
  const m = /<section aria-label="Verdict"[^>]*>/.exec(html);
  if (!m) throw new Error('verdict banner not rendered');
  return m[0];
}

/** Markup of the banner section (up to its closing tag). */
function banner(html: string): string {
  const start = html.indexOf('<section aria-label="Verdict"');
  return html.slice(start, html.indexOf('</section>', start));
}

/** Markup of the finding row whose label is `label`. */
function row(html: string, label: string): string {
  const found = html
    .split('<li')
    .find((chunk) => chunk.includes(`>${label}</span>`));
  if (!found) throw new Error(`row ${label} not rendered`);
  return found.slice(0, found.indexOf('</li>'));
}

describe('VerdictCard', () => {
  it('renders a NOT READY verdict with per-item findings', () => {
    const html = renderCard(NOT_READY_RESULT);

    expect(bannerTag(html)).toContain('data-verdict="notReady"');
    expect(banner(html)).toContain('>NOT READY<');
    expect(banner(html)).toContain('>Amit Suresh Patil<');
    expect(banner(html)).toContain('Personal Loan - Salaried');

    // Item row: label, the engine's detail line and the missing months.
    const slips = row(html, 'Salary slips (last 3 months)');
    expect(slips).toContain('data-tone="bad"');
    expect(slips).toContain(
      'missing Jun 2026, Jul 2026 slip(s); found: Aug 2026 (slip_aug.pdf)',
    );
    expect(slips).toContain('>Jun 2026<');
    expect(slips).toContain('>Jul 2026<');

    // REVIEW items are flagged for a person.
    const review = row(html, 'Address proof');
    expect(review).toContain('data-tone="review"');
    expect(review).toContain('Needs a person');

    // A missing optional item is muted, not a blocker.
    const optional = row(html, 'Form-16 / ITR');
    expect(optional).toContain('data-tone="muted"');
    expect(optional).toContain('>optional<');

    // Consistency: declared vs actual with both numbers.
    const income = row(html, 'Declared net salary vs salary slips');
    expect(income).toContain('data-tone="bad"');
    expect(income).toContain('₹72,000');
    expect(income).toContain('₹55,000');
    expect(row(html, 'PAN')).toContain('data-tone="ok"');

    // Reasons summary and the document the engine could not read.
    expect(html).toContain('Issues to fix (3)');
    const skipped = row(html, 'statement.xlsx');
    expect(skipped).toContain('Not supported');
    expect(skipped).toContain('upload the statement as PDF');
  });

  it('shows the API verdict verbatim instead of deriving it', () => {
    const applicant = NOT_READY_RESULT.applicants[0];
    // Every row looks fine, but the engine said NOT READY (e.g. a document
    // is still being analysed): the UI must show NOT READY.
    const allPresent = renderCard({
      ...NOT_READY_RESULT,
      overall_verdict: 'NOT READY',
      applicants: [
        {
          ...applicant,
          checklist: [applicant.checklist[0]],
          consistency: [applicant.consistency[0]],
          reasons: [],
        },
      ],
      unsupported_documents: [],
    });
    expect(bannerTag(allPresent)).toContain('data-verdict="notReady"');
    expect(banner(allPresent)).toContain('>NOT READY<');

    // Rows have a MISSING item, but the engine said READY: show READY.
    const html = renderCard({ ...NOT_READY_RESULT, overall_verdict: 'READY' });
    expect(bannerTag(html)).toContain('data-verdict="ready"');
    expect(banner(html)).toContain('>READY<');
    expect(banner(html)).not.toContain('NOT READY');
  });

  it('flags REVIEW findings on a READY verdict without changing it', () => {
    const html = renderCard(READY_WITH_REVIEW_RESULT);

    // The verdict stays the engine's READY; the banner says a person must look.
    expect(bannerTag(html)).toContain('data-verdict="ready"');
    expect(banner(html)).toContain('>READY<');
    expect(banner(html)).toContain('1 finding needs a person');
    expect(banner(html)).toContain('a person should look at the flagged');
    expect(banner(html)).not.toContain('present and consistent');

    // The needs_review list and the REVIEW consistency row.
    expect(html).toContain('Needs a person (1) – does not change the verdict');
    const emi = row(html, 'Declared EMIs vs bank debits');
    expect(emi).toContain('data-tone="review"');
    expect(emi).toContain('Needs a person');
    expect(emi).toContain('undeclared loan debit: NACH debit ₹6,500');

    // FOIR numbers exactly as the engine returned them, labelled indicative.
    expect(html).toContain('FOIR (indicative)');
    expect(html).toContain('₹14,700');
    expect(html).toContain('17.8%');
    expect(html).toContain('Max new EMI at FOIR 70% (indicative)');
    expect(html).toContain('₹43,050');
    expect(html).toContain('Indicative – the lender&#x27;s policy decides.');
  });

  it('renders no FOIR block when the engine did not compute one', () => {
    const html = renderCard({
      ...READY_WITH_REVIEW_RESULT,
      applicants: [
        {
          ...READY_WITH_REVIEW_RESULT.applicants[0],
          needs_review: [],
          foir: { status: 'REVIEW', detail: 'not computed: no income' },
        },
      ],
    });
    expect(html).not.toContain('FOIR (indicative)');
    expect(banner(html)).not.toContain('needs a person');
    expect(banner(html)).toContain('present and consistent');
  });

  it('shows the engine summary for an empty project', () => {
    const html = renderCard({
      ...NOT_READY_RESULT,
      summary: 'No analysed documents found in this project',
      applicants: [],
      unsupported_documents: [],
    });
    expect(banner(html)).toContain('>NOT READY<');
    expect(banner(html)).toContain(
      'No analysed documents found in this project',
    );
    expect(banner(html)).not.toContain('Fix the issues below');
  });

  it('renders NEEDS REVIEW in the review tone', () => {
    const html = renderCard({
      ...NOT_READY_RESULT,
      overall_verdict: 'NEEDS REVIEW',
    });
    expect(bannerTag(html)).toContain('data-verdict="review"');
    expect(banner(html)).toContain('>NEEDS REVIEW<');
    expect(banner(html)).toContain('A person must review');
  });
});
