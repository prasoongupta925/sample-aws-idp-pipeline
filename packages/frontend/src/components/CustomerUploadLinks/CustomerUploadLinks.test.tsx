// @vitest-environment node
// (Rendered to static markup: the workspace's jsdom install cannot start.
// Hooks run once: callbacks are real, effects do not run.)
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '../../i18n/locales/en.json';
import RequestDocumentsModal, { itemRows } from './RequestDocumentsModal';
import UnlockPdfModal from './UnlockPdfModal';
import { unlockDocument, useUploadLinks } from '../../hooks/useUploadLinks';
import { ApiError } from '../../lib/apiError';
import { SNEHA_NOT_READY_RESULT } from '../FileCheckPanel/fixtures';
import { UPLOAD_ITEM_CODES } from '../../data/customerUpload';

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  });
});

const noop = () => undefined;
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(noop);
});
afterEach(() => {
  vi.restoreAllMocks();
});

interface Call {
  url: string;
  init?: RequestInit;
}

function fakeApi(...replies: unknown[]) {
  const calls: Call[] = [];
  const fetchApi = async <T,>(url: string, init?: RequestInit): Promise<T> => {
    calls.push({ url, init });
    const reply = replies.length > 1 ? replies.shift() : replies[0];
    if (reply instanceof Error) throw reply;
    return reply as T;
  };
  return { calls, fetchApi };
}

function hookOnce<T>(useHook: () => T): T {
  let value: T | undefined;
  function Probe() {
    value = useHook();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return value as T;
}

const TOKEN = 'k'.repeat(43);
const LINK = {
  link_id: 'ul_1',
  status: 'active',
  items: [{ code: 'PAN_COPY' }],
  language: 'hi',
  dsa_name: 'Rohan Iyer Finserv',
  created_at: '2026-10-03T08:00:00+00:00',
  expires_at: '2026-10-06T08:00:00+00:00',
  file_count: 0,
  max_files: 20,
};

const CHECKED = /<input[^>]*type="checkbox"[^>]*checked=""/g;

const render = (el: ReactElement) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{el}</I18nextProvider>);

describe('RequestDocumentsModal', () => {
  it("ticks the File Check's missing items and offers every other code", () => {
    const html = render(
      <RequestDocumentsModal
        isOpen
        onClose={noop}
        fetchApi={fakeApi([]).fetchApi}
        projectId="p1"
        fileCheckResult={SNEHA_NOT_READY_RESULT}
        origin="https://app.example.com"
      />,
    );
    expect(html).toContain(en.uploadLinks.title);
    const checked = html.match(CHECKED) ?? [];
    expect(checked).toHaveLength(3);
    expect(html).toContain('salary slip (Jun 2026)');
    expect(html).toContain('bank statement (Mar-May 2026)');
    expect(html).toContain('Create link for 3 documents');
    // 72 hours is preselected; at most 7 days is offered.
    expect(html).toMatch(/<option value="72" selected="">3 days<\/option>/);
    expect(html).toContain('<option value="168">7 days</option>');
    expect(html).not.toContain('value="192"');
    expect(html).toContain('हिन्दी');
    expect(html).toContain('मराठी');
  });

  it('ticks nothing without a File Check run', () => {
    const html = render(
      <RequestDocumentsModal
        isOpen
        onClose={noop}
        fetchApi={fakeApi([]).fetchApi}
        projectId="p1"
      />,
    );
    expect(html.match(CHECKED)).toBeNull();
    expect(html).toContain(en.uploadLinks.noPreselect);
    expect(html).toMatch(/data-testid="create-upload-link"[^>]*disabled/);
  });

  it('renders nothing when closed', () => {
    const html = render(
      <RequestDocumentsModal
        isOpen={false}
        onClose={noop}
        fetchApi={fakeApi([]).fetchApi}
        projectId="p1"
      />,
    );
    expect(html).toBe('');
  });

  it('lists each code once after the preselected rows', () => {
    const rows = itemRows([
      { code: 'PAN_COPY' },
      { code: 'OTHER', note: 'Rent' },
    ]);
    expect(rows.filter((r) => r.code === 'PAN_COPY')).toHaveLength(1);
    // The preselected OTHER keeps its note; a free OTHER row stays offered.
    expect(rows.filter((r) => r.code === 'OTHER')).toHaveLength(2);
    expect(rows).toHaveLength(UPLOAD_ITEM_CODES.length + 1);
  });
});

describe('useUploadLinks', () => {
  it('creates a link with a JSON body and returns its token once', async () => {
    const api = fakeApi({ ...LINK, token: TOKEN });
    const state = hookOnce(() =>
      useUploadLinks({ fetchApi: api.fetchApi, projectId: 'p1' }),
    );
    const created = await state.create({
      items: [{ code: 'PAN_COPY' }],
      expires_in_hours: 72,
      language: 'hi',
    });
    expect(created?.token).toBe(TOKEN);
    expect(api.calls[0].url).toBe('projects/p1/upload-links');
    expect(api.calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(api.calls[0].init?.body))).toEqual({
      items: [{ code: 'PAN_COPY' }],
      expires_in_hours: 72,
      language: 'hi',
    });
  });

  it('reports a failed create and a malformed reply', async () => {
    const failed = hookOnce(() =>
      useUploadLinks({
        fetchApi: fakeApi(new ApiError(422)).fetchApi,
        projectId: 'p1',
      }),
    );
    expect(
      await failed.create({ items: [], expires_in_hours: 72, language: 'en' }),
    ).toBeNull();
    const malformed = hookOnce(() =>
      useUploadLinks({ fetchApi: fakeApi(LINK).fetchApi, projectId: 'p1' }),
    );
    expect(
      await malformed.create({
        items: [{ code: 'PAN_COPY' }],
        expires_in_hours: 72,
        language: 'en',
      }),
    ).toBeNull();
  });

  it('revokes with DELETE on the link', async () => {
    const api = fakeApi({ ...LINK, status: 'revoked' });
    const state = hookOnce(() =>
      useUploadLinks({ fetchApi: api.fetchApi, projectId: 'p1' }),
    );
    expect(await state.revoke('ul_1')).toBe(true);
    expect(api.calls[0]).toMatchObject({
      url: 'projects/p1/upload-links/ul_1',
      init: { method: 'DELETE' },
    });
    const failing = hookOnce(() =>
      useUploadLinks({
        fetchApi: fakeApi(new ApiError(404)).fetchApi,
        projectId: 'p1',
      }),
    );
    expect(await failing.revoke('ul_1')).toBe(false);
  });
});

describe('unlockDocument', () => {
  it('posts the password once and maps the outcome', async () => {
    const api = fakeApi({ status: 'unlocked' });
    expect(await unlockDocument(api.fetchApi, 'p1', 'doc-1', 'pw-123')).toBe(
      'unlocked',
    );
    expect(api.calls[0].url).toBe('projects/p1/documents/doc-1/unlock');
    expect(JSON.parse(String(api.calls[0].init?.body))).toEqual({
      password: 'pw-123',
    });
    expect(
      await unlockDocument(fakeApi(new ApiError(400)).fetchApi, 'p1', 'd', 'x'),
    ).toBe('wrong_password');
    expect(
      await unlockDocument(fakeApi(new ApiError(502)).fetchApi, 'p1', 'd', 'x'),
    ).toBe('failed');
  });

  it('never logs the password', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(noop);
    const err = new ApiError(502, 'boom');
    await unlockDocument(fakeApi(err).fetchApi, 'p1', 'd', 'secret-pw');
    expect(JSON.stringify(spy.mock.calls)).not.toContain('secret-pw');
  });
});

describe('UnlockPdfModal', () => {
  it('asks for the password in a password field without autocomplete', () => {
    const html = render(
      <UnlockPdfModal
        document={{ document_id: 'd1', name: 'statement.pdf' }}
        projectId="p1"
        fetchApi={fakeApi({}).fetchApi}
        onClose={noop}
      />,
    );
    expect(html).toContain('statement.pdf');
    expect(html).toMatch(/type="password"[^>]*autoComplete="off"/i);
    expect(html).toContain(en.uploadLinks.unlock.title);
  });

  it('renders nothing without a document', () => {
    const html = render(
      <UnlockPdfModal
        document={null}
        projectId="p1"
        fetchApi={fakeApi({}).fetchApi}
        onClose={noop}
      />,
    );
    expect(html).toBe('');
  });
});
