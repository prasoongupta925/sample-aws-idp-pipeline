// @vitest-environment node
// (Rendered to static markup: the workspace's jsdom install cannot start.)
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '../../i18n/locales/en.json';
import VerdictCard from './VerdictCard';
import ReminderDraft from './ReminderDraft';
import EraseApplicantDialog, {
  EraseResultCard,
  describeEraseError,
} from './EraseApplicant';
import {
  NOT_READY_RESULT,
  READY_OBLIGATIONS_RESULT,
  SNEHA_NOT_READY_RESULT,
  USAGE_RESULT,
} from './fixtures';
import { ApiError } from '../../lib/apiError';

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  });
});

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>{node}</I18nextProvider>,
  );
}

/** Text inside the first element marked data-testid=`id`, tags stripped. */
function textOf(html: string, id: string, tag = 'p'): string {
  const start = html.indexOf(`data-testid="${id}"`);
  if (start < 0) throw new Error(`${id} not rendered`);
  const open = html.indexOf('>', start) + 1;
  return html
    .slice(open, html.indexOf(`</${tag}>`, open))
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** Opening tag of the element marked data-testid=`id`. */
function tagOf(html: string, id: string): string {
  const at = html.indexOf(`data-testid="${id}"`);
  if (at < 0) throw new Error(`${id} not rendered`);
  const start = html.lastIndexOf('<', at);
  return html.slice(start, html.indexOf('>', at) + 1);
}

const noop = () => undefined;
const SNEHA = SNEHA_NOT_READY_RESULT.applicants[0];

describe('ReminderDraft', () => {
  it('shows the WhatsApp text read-only with its count and a Copy button', () => {
    const html = render(
      <ReminderDraft
        applicant={SNEHA}
        checklistId="salaried_personal_loan"
        product="personal_loan"
        onClose={noop}
        autoFocus={false}
      />,
    );
    const text = textOf(html, 'reminder-text', 'textarea');
    expect(text).toContain('Hi Sneha, a gentle reminder from {{dsa_name}}.');
    expect(text).toContain(
      'June 2026 salary slip, bank statement for March to May 2026, Form-16 or ITR (latest FY)',
    );
    expect(tagOf(html, 'reminder-text')).toContain('readOnly');
    expect(tagOf(html, 'reminder-text')).toContain('lang="en"');
    expect(textOf(html, 'reminder-count')).toBe(
      `${text.length} characters · WhatsApp body limit 1,024`,
    );
    expect(html).toContain('>Copy</button>');
    // The three languages, labelled in their own script.
    expect(html).toContain('<span lang="hi"');
    expect(html).toContain('>हिन्दी</span>');
    expect(html).toContain('>मराठी</span>');
    // The message picker offers what fits Sneha: no "one more document".
    expect(html).toContain('>Reminder</option>');
    expect(html).toContain('>Mismatch – ask to call</option>');
    expect(html).not.toContain('>One more document</option>');
    expect(html).toContain(
      'Fill in before sending: {{dsa_name}}, {{ref}}, {{upload_link}}, {{link_expiry}}.',
    );
  });

  it('counts SMS segments: Hindi is Unicode (70 / 67 per segment)', () => {
    const html = render(
      <ReminderDraft
        applicant={SNEHA}
        checklistId="salaried_personal_loan"
        onClose={noop}
        initialLanguage="hi"
        initialChannel="sms"
        autoFocus={false}
      />,
    );
    const text = textOf(html, 'reminder-text', 'textarea');
    expect(text).toContain('जून slip, मार्च-मई bank statement, Form-16');
    expect(tagOf(html, 'reminder-text')).toContain('lang="hi"');
    expect(textOf(html, 'reminder-count')).toBe(
      `${text.length} characters · ${Math.ceil(text.length / 67)} SMS segments · Unicode: 70 characters per SMS, 67 per segment when split`,
    );
  });

  it('says so when there is nothing to ask the applicant for', () => {
    const reviewOnly = {
      ...NOT_READY_RESULT.applicants[0],
      checklist: NOT_READY_RESULT.applicants[0].checklist.filter(
        (r) => r.status !== 'MISSING',
      ),
      consistency: [],
      missing_items: [],
      mismatches: [],
    };
    const html = render(
      <ReminderDraft applicant={reviewOnly} onClose={noop} autoFocus={false} />,
    );
    expect(html).toContain('Nothing to ask the applicant for');
    expect(html).not.toContain('data-testid="reminder-text"');
  });
});

describe('VerdictCard actions and usage', () => {
  it('offers a reminder only for NOT READY applicants', () => {
    const notReady = render(<VerdictCard result={SNEHA_NOT_READY_RESULT} />);
    expect(notReady).toMatch(
      /<button type="button" aria-expanded="false"[^>]*>.*?Draft reminder<\/button>/,
    );
    const ready = render(<VerdictCard result={READY_OBLIGATIONS_RESULT} />);
    expect(ready).not.toContain('Draft reminder');
  });

  it('shows "Erase applicant data" per applicant when erasing is wired', () => {
    expect(render(<VerdictCard result={NOT_READY_RESULT} />)).not.toContain(
      'Erase applicant data',
    );
    const html = render(
      <VerdictCard result={READY_OBLIGATIONS_RESULT} onEraseApplicant={noop} />,
    );
    expect(html.match(/Erase applicant data<\/button>/g)).toHaveLength(1);
  });

  it('shows tokens and $ per document and the applicant total', () => {
    const html = render(<VerdictCard result={USAGE_RESULT} />);
    expect(textOf(html, 'document-usage', 'span')).toBe(
      ' · 12,345 in / 678 out tokens · $0.0063',
    );
    expect(tagOf(html, 'document-usage')).toContain(
      'title="Model: global.amazon.nova-2-lite-v1:0"',
    );
    expect(html).toContain('usage not recorded');
    expect(textOf(html, 'usage-total')).toBe(
      'Reading this file cost $0.0063 for 1 document (12,345 in / 678 out tokens). Usage was not recorded for 1 more document.',
    );
    // Older backends: no usage, no usage line.
    const old = render(<VerdictCard result={NOT_READY_RESULT} />);
    expect(old).not.toContain('data-testid="usage-total"');
    expect(old).not.toContain('usage not recorded');
  });

  it('says when no document of the file has recorded usage', () => {
    const html = render(
      <VerdictCard
        result={{
          ...NOT_READY_RESULT,
          applicants: [
            {
              ...NOT_READY_RESULT.applicants[0],
              usage_total: {
                input_tokens: 0,
                output_tokens: 0,
                cost_usd: 0,
                documents_with_usage: 0,
                documents_total: 2,
              },
            },
          ],
        }}
      />,
    );
    expect(textOf(html, 'usage-total')).toBe(
      'Reading cost was not recorded for these documents (analysed before costs were recorded).',
    );
  });
});

describe('EraseApplicantDialog', () => {
  const dialog = (initialTyped: string, error: unknown = null) =>
    render(
      <EraseApplicantDialog
        applicant="Amit Suresh Patil"
        pan="XXXXXX234K"
        erasing={false}
        error={error}
        onCancel={noop}
        onConfirm={noop}
        initialTyped={initialTyped}
      />,
    );

  it('explains the permanent deletion inside the page', () => {
    const html = dialog('');
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('Erase Amit Suresh Patil&#x27;s data?');
    expect(html).toContain('permanently deletes every document');
    expect(html).toContain('This cannot be undone.');
    expect(html).toContain('PAN XXXXXX234K');
  });

  it('enables the button only for the exact name', () => {
    const button = (typed: string) =>
      tagOf(dialog(typed), 'erase-confirm-button');
    expect(button('')).toContain('disabled=""');
    expect(button('Amit')).toContain('disabled=""');
    expect(button('amit suresh patil')).toContain('disabled=""');
    expect(button('AMIT SURESH PATIL')).toContain('disabled=""');
    expect(button('Amit Suresh Patil')).not.toContain('disabled=""');
    expect(dialog('amit suresh patil')).toContain(
      'The name does not match yet.',
    );
    expect(tagOf(dialog('Amit'), 'erase-confirm-input')).toContain(
      'aria-invalid="true"',
    );
  });

  it('shows the API reason for a refused erase', () => {
    expect(dialog('Amit Suresh Patil', new ApiError(400))).toContain(
      'The name typed does not match the applicant&#x27;s name (HTTP 400).',
    );
    const t = i18n.getFixedT('en');
    expect(
      describeEraseError(
        t,
        new ApiError(409, '2 applicants match this name: erase by PAN instead'),
      ),
    ).toBe(
      'More than one applicant has this name (HTTP 409). (2 applicants match this name: erase by PAN instead)',
    );
    expect(describeEraseError(t, new ApiError(404))).toContain(
      'it may have been erased already',
    );
  });
});

describe('EraseResultCard', () => {
  it('lists what was deleted and what failed', () => {
    const html = render(
      <EraseResultCard
        result={{
          applicant: 'Amit Suresh Patil',
          documents_deleted: [
            { document_id: 'd1', name: 'application.pdf' },
            { document_id: 'd2', name: 'slip_aug.pdf' },
          ],
          failed: [
            {
              document_id: 'd3',
              name: 'form16.pdf',
              error:
                'document deleted, but its search-index (LanceDB) entries were not deleted',
            },
          ],
          erased_at: '2026-09-30T10:00:00+00:00',
        }}
        onDismiss={noop}
      />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('Amit Suresh Patil&#x27;s data was erased');
    expect(html).toContain('2 documents deleted');
    expect(html).toContain('>application.pdf</li>');
    expect(html).toContain('1 document could not be fully deleted:');
    expect(html).toContain(
      'form16.pdf – document deleted, but its search-index (LanceDB) entries were not deleted',
    );
    expect(html).toContain('Run the check again');
  });
});
