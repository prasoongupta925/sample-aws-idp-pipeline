// @vitest-environment node
// (Rendered to static markup: the workspace's jsdom install cannot start.)
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '../i18n/locales/en.json';
import SidePanel from './SidePanel';
import type { Document } from '../types/project';

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  });
});

const doc = (over: Partial<Document>): Document => ({
  document_id: 'd1',
  name: 'statement.pdf',
  file_type: 'application/pdf',
  file_size: 2048,
  status: 'completed',
  use_bda: false,
  started_at: '2026-10-03T08:00:00Z',
  ended_at: null,
  ...over,
});

const render = (documents: Document[], withActions = true) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <SidePanel
        documents={documents}
        onRequestFromCustomer={withActions ? () => undefined : undefined}
        onUnlockDocument={withActions ? () => undefined : undefined}
      />
    </I18nextProvider>,
  );

describe('SidePanel customer uploads', () => {
  it('offers "Request from customer" when wired', () => {
    expect(render([])).toContain(en.uploadLinks.button);
    expect(render([], false)).not.toContain(en.uploadLinks.button);
  });

  it('marks documents uploaded by the customer via a link', () => {
    const html = render([
      doc({ document_id: 'a', name: 'pan.jpg', source: 'customer_link' }),
      doc({ document_id: 'b', name: 'slip.pdf' }),
    ]);
    expect(html.match(/data-testid="doc-via-link"/g)).toHaveLength(1);
    expect(html).toContain(en.uploadLinks.viaLinkTitle);
  });

  it('shows a locked PDF as needing its password, with an unlock button', () => {
    const html = render([
      doc({
        status: 'password_required',
        locked: true,
        source: 'customer_link',
      }),
    ]);
    expect(html).toContain(en.uploadLinks.passwordRequired);
    expect(html).toContain(`aria-label="${en.uploadLinks.unlockButton}"`);
    const unlocked = render([doc({ status: 'completed' })]);
    expect(unlocked).not.toContain(en.uploadLinks.unlockButton);
  });
});
