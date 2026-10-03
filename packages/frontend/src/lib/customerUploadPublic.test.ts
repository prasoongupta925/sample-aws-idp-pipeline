// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  customerContentType,
  isCustomerUploadPath,
  isEncryptedPdf,
  needsPassword,
  parsePublicLink,
  putWithProgress,
  rejectFile,
  takeLinkToken,
  tokenFromHash,
} from './customerUploadPublic';
import { ApiError } from './apiError';
import {
  CONSENT_VERSION,
  CUSTOMER_PAGE_TEXT,
  pageText,
} from '../data/customerUploadPage';

const TOKEN = 'A'.repeat(20) + '-_' + 'b9'.repeat(10) + 'z';
const BACKEND = 'https://api.example.com/';

interface Sent {
  url: string;
  init: RequestInit;
}

function fakeFetch(...replies: Array<{ status: number; body?: unknown }>) {
  const sent: Sent[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    const reply =
      (replies.length > 1 ? replies.shift() : undefined) ?? replies[0];
    const text =
      reply.body === undefined
        ? ''
        : typeof reply.body === 'string'
          ? reply.body
          : JSON.stringify(reply.body);
    return new Response(text || null, { status: reply.status });
  }) as unknown as typeof fetch;
  return { sent, impl };
}

const LINK = {
  dsa_name: 'Verma Loan Services',
  items: [{ code: 'PAN_COPY' }, { code: 'BANK_STATEMENT', note: 'Jul-Sep' }],
  language: 'hi',
  expires_at: '2026-10-06T08:30:00+00:00',
  consented: false,
  consent_version: CONSENT_VERSION,
  file_count: 1,
  max_files: 20,
  max_file_bytes: 15 * 1024 * 1024,
  files: [
    {
      document_id: '11111111-2222-3333-4444-555555555555',
      file_name: 'statement.pdf',
      status: 'password_required',
      locked: true,
    },
  ],
};

describe('tokenFromHash', () => {
  it('takes a 43-character base64url token from the fragment', () => {
    expect(TOKEN).toHaveLength(43);
    expect(tokenFromHash(`#${TOKEN}`)).toBe(TOKEN);
  });
  it.each([
    '',
    '#',
    '#short',
    `#${TOKEN}x`,
    `#${TOKEN.slice(1)}=`,
    `#${TOKEN.slice(1)}/`,
  ])('refuses %j', (hash) => {
    expect(tokenFromHash(hash)).toBeNull();
  });
});

describe('isCustomerUploadPath', () => {
  it('is the /u page only', () => {
    expect(isCustomerUploadPath('/u')).toBe(true);
    expect(isCustomerUploadPath('/u/')).toBe(true);
    for (const path of ['/', '/upload', '/u/x', '/projects/u', '/U', '']) {
      expect(isCustomerUploadPath(path)).toBe(false);
    }
  });
});

describe('takeLinkToken', () => {
  function fakeHistory(state: unknown = null, refuse = false) {
    const calls: Array<[unknown, string, string | undefined]> = [];
    const history = {
      state,
      replaceState(data: unknown, unused: string, url?: string | URL | null) {
        if (refuse) throw new Error('SecurityError');
        calls.push([data, unused, url == null ? undefined : String(url)]);
        history.state = data;
      },
    };
    return { history, calls };
  }
  const page = (hash: string, search = '') => ({
    hash,
    pathname: '/u',
    search,
  });

  it('reads the fragment and takes it out of the address bar', () => {
    const state = { other: 1 };
    const { history, calls } = fakeHistory(state);
    expect(takeLinkToken(page(`#${TOKEN}`, '?lang=hi'), history)).toBe(TOKEN);
    // Same entry, same state object (nothing added), URL without the fragment.
    expect(calls).toEqual([[state, '', '/u?lang=hi']]);
    expect(JSON.stringify(history.state)).not.toContain(TOKEN);
  });

  it('reads nothing but the fragment (not the history state)', () => {
    const { history, calls } = fakeHistory({ uploadLinkToken: TOKEN });
    expect(takeLinkToken(page(''), history)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('clears a malformed fragment too, and refuses it', () => {
    const { history, calls } = fakeHistory();
    expect(takeLinkToken(page('#short'), history)).toBeNull();
    expect(calls).toEqual([[null, '', '/u']]);
  });

  it('still works when the browser refuses replaceState', () => {
    const { history } = fakeHistory(null, true);
    expect(takeLinkToken(page(`#${TOKEN}`), history)).toBe(TOKEN);
  });

  it('never touches web storage', () => {
    const touched: string[] = [];
    const trap = (name: string) => ({
      configurable: true,
      get() {
        touched.push(name);
        return undefined;
      },
    });
    const names = ['localStorage', 'sessionStorage'] as const;
    const saved = names.map((name) =>
      Object.getOwnPropertyDescriptor(globalThis, name),
    );
    for (const name of names) {
      Object.defineProperty(globalThis, name, trap(name));
    }
    try {
      takeLinkToken(page(`#${TOKEN}`), fakeHistory().history);
    } finally {
      names.forEach((name, i) => {
        const original = saved[i];
        if (original) Object.defineProperty(globalThis, name, original);
        else Reflect.deleteProperty(globalThis, name);
      });
    }
    expect(touched).toEqual([]);
  });
});

describe('parsePublicLink', () => {
  it('keeps the fields the page uses', () => {
    const link = parsePublicLink(LINK);
    expect(link.dsa_name).toBe('Verma Loan Services');
    expect(link.language).toBe('hi');
    expect(link.items).toEqual(LINK.items);
    expect(link.files).toHaveLength(1);
    expect(needsPassword(link.files[0])).toBe(true);
  });
  it('defaults odd values and drops malformed entries', () => {
    const link = parsePublicLink({
      language: 'xx',
      items: [{ code: 'PAN_COPY' }, null, { note: 'x' }],
      files: [{ file_name: 'no-id.pdf' }, null],
      max_files: 'twenty',
    });
    expect(link.language).toBe('en');
    expect(link.items).toEqual([{ code: 'PAN_COPY' }]);
    expect(link.files).toEqual([]);
    expect(link.max_files).toBe(20);
    expect(link.max_file_bytes).toBe(15 * 1024 * 1024);
    expect(link.consented).toBe(false);
  });
  it('throws on a non-object', () => {
    expect(() => parsePublicLink(null)).toThrow();
  });
  it('asks for a password only for a locked file waiting for one', () => {
    const base = { document_id: 'd', file_name: 'a.pdf' };
    expect(
      needsPassword({ ...base, status: 'password_required', locked: false }),
    ).toBe(false);
    expect(needsPassword({ ...base, status: 'uploaded', locked: true })).toBe(
      false,
    );
  });
});

describe('customerContentType / rejectFile', () => {
  const MAX = 15 * 1024 * 1024;
  it('maps the customer types by extension when the browser gives none', () => {
    expect(customerContentType({ name: 'scan.PDF', type: '' })).toBe(
      'application/pdf',
    );
    expect(customerContentType({ name: 'photo.jpg', type: '' })).toBe(
      'image/jpeg',
    );
    expect(
      customerContentType({ name: 'photo.jpeg', type: 'image/pjpeg' }),
    ).toBe('image/pjpeg');
    expect(customerContentType({ name: 'p.webp', type: 'image/webp' })).toBe(
      'image/webp',
    );
    // A mismatched browser type is replaced by the extension's.
    expect(customerContentType({ name: 'p.png', type: 'image/jpeg' })).toBe(
      'image/png',
    );
  });
  it('refuses other types', () => {
    expect(
      customerContentType({ name: 'photo.heic', type: 'image/heic' }),
    ).toBeNull();
    expect(
      customerContentType({ name: 'noext', type: 'application/pdf' }),
    ).toBeNull();
    expect(rejectFile({ name: 'a.docx', type: '', size: 10 }, MAX)).toBe(
      'type',
    );
  });
  it('refuses empty and too large files', () => {
    expect(rejectFile({ name: 'a.pdf', type: '', size: 0 }, MAX)).toBe('size');
    expect(rejectFile({ name: 'a.pdf', type: '', size: MAX + 1 }, MAX)).toBe(
      'size',
    );
    expect(rejectFile({ name: 'a.pdf', type: '', size: MAX }, MAX)).toBeNull();
  });
});

describe('isEncryptedPdf', () => {
  const pdf = (body: string) => new Blob([body]);
  it('finds the Encrypt name in a small file', async () => {
    expect(
      await isEncryptedPdf(
        pdf('%PDF-1.7\ntrailer\n<< /Root 1 0 R /Encrypt 5 0 R >>\n%%EOF'),
      ),
    ).toBe(true);
    expect(
      await isEncryptedPdf(pdf('%PDF-1.7\n<</Encrypt<</Filter/Standard>>>>')),
    ).toBe(true);
  });
  it('ignores longer names and plain files', async () => {
    expect(
      await isEncryptedPdf(pdf('%PDF-1.7\n/EncryptMetadata false\n%%EOF')),
    ).toBe(false);
    expect(
      await isEncryptedPdf(pdf('%PDF-1.7\ntrailer << /Root 1 0 R >>\n%%EOF')),
    ).toBe(false);
  });
  it('reads the head and the tail of a large file, not the middle', async () => {
    const filler = 'x'.repeat(100 * 1024);
    expect(
      await isEncryptedPdf(
        pdf(`%PDF${filler}${filler}trailer<</Encrypt 9 0 R>>`),
      ),
    ).toBe(true);
    expect(
      await isEncryptedPdf(pdf(`%PDF /Encrypt 9 0 R${filler}${filler}%%EOF`)),
    ).toBe(true);
    expect(
      await isEncryptedPdf(pdf(`%PDF${filler}/Encrypt 9 0 R${filler}%%EOF`)),
    ).toBe(false);
  });
});

describe('createPublicClient', () => {
  it('GETs the link with the token header, no cookies and no referrer', async () => {
    const { sent, impl } = fakeFetch({ status: 200, body: LINK });
    const link = await createPublicClient(BACKEND, TOKEN, impl).get();
    expect(link.dsa_name).toBe('Verma Loan Services');
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://api.example.com/public/upload-link');
    expect(sent[0].init.method).toBe('GET');
    expect(sent[0].init.credentials).toBe('omit');
    expect(sent[0].init.referrerPolicy).toBe('no-referrer');
    expect(sent[0].init.cache).toBe('no-store');
    expect(
      (sent[0].init.headers as Record<string, string>)['X-Upload-Token'],
    ).toBe(TOKEN);
    // The token is never in the URL.
    expect(sent[0].url).not.toContain(TOKEN);
  });

  it('posts the consent with its text version', async () => {
    const { sent, impl } = fakeFetch({
      status: 200,
      body: { consented_at: 'now' },
    });
    await createPublicClient(BACKEND, TOKEN, impl).consent(
      'mr',
      CONSENT_VERSION,
    );
    expect(sent[0].url).toBe(
      'https://api.example.com/public/upload-link/consent',
    );
    expect(sent[0].init.method).toBe('POST');
    expect(JSON.parse(sent[0].init.body as string)).toEqual({
      accepted: true,
      language: 'mr',
      consent_version: CONSENT_VERSION,
    });
  });

  it('asks for a file ticket and checks it', async () => {
    const ticket = {
      document_id: 'doc-1',
      upload_url:
        'https://bucket.s3.ap-south-1.amazonaws.com/k?X-Amz-Signature=s',
      expires_in: 300,
      status: 'uploading',
    };
    const { sent, impl } = fakeFetch({ status: 200, body: ticket });
    const client = createPublicClient(BACKEND, TOKEN, impl);
    const request = {
      file_name: 'pan.jpg',
      content_type: 'image/jpeg',
      file_size: 1234,
      encrypted: false,
    };
    expect(await client.createFile(request)).toEqual({
      document_id: 'doc-1',
      upload_url: ticket.upload_url,
      status: 'uploading',
    });
    expect(JSON.parse(sent[0].init.body as string)).toEqual(request);

    const bad = fakeFetch({
      status: 200,
      body: { document_id: 'd', upload_url: 'http://x' },
    });
    await expect(
      createPublicClient(BACKEND, TOKEN, bad.impl).createFile(request),
    ).rejects.toThrow('Malformed upload ticket');
  });

  it('sends the password once and reads the unlock outcome', async () => {
    const { sent, impl } = fakeFetch(
      { status: 200, body: { status: 'wrong_password', attempts_left: 3 } },
      { status: 200, body: { status: 'unlocked' } },
    );
    const client = createPublicClient(BACKEND, TOKEN, impl);
    expect(await client.unlock('doc/1', 'secret-1')).toEqual({
      status: 'wrong_password',
      attemptsLeft: 3,
    });
    expect(await client.unlock('doc-1', 'secret-2')).toEqual({
      status: 'unlocked',
    });
    expect(sent[0].url).toBe(
      'https://api.example.com/public/upload-link/files/doc%2F1/unlock',
    );
    expect(JSON.parse(sent[1].init.body as string)).toEqual({
      password: 'secret-2',
    });
  });

  it('submits and returns the file count', async () => {
    const { sent, impl } = fakeFetch({
      status: 200,
      body: { status: 'submitted', file_count: 4 },
    });
    expect(await createPublicClient(BACKEND, TOKEN, impl).submit()).toBe(4);
    expect(sent[0].url).toBe(
      'https://api.example.com/public/upload-link/submit',
    );
    expect(sent[0].init.method).toBe('POST');
  });

  it('throws ApiError with the status and detail', async () => {
    const { impl } = fakeFetch({
      status: 404,
      body: { detail: 'This link is not valid any more.' },
    });
    const err = await createPublicClient(BACKEND, TOKEN, impl)
      .get()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).detail).toBe('This link is not valid any more.');
  });
});

describe('putWithProgress', () => {
  function fakeXhr(status: number, outcome: 'load' | 'error' = 'load') {
    const xhr = {
      upload: { onprogress: null as ((e: ProgressEvent) => void) | null },
      onload: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onabort: null as (() => void) | null,
      status: 0,
      opened: [] as string[],
      headers: {} as Record<string, string>,
      body: null as Blob | null,
      open(method: string, url: string) {
        this.opened = [method, url];
      },
      setRequestHeader(name: string, value: string) {
        this.headers[name] = value;
      },
      send(body: Blob) {
        this.body = body;
        this.upload.onprogress?.({
          lengthComputable: true,
          loaded: 5,
          total: 10,
        } as ProgressEvent);
        this.status = status;
        if (outcome === 'load') this.onload?.();
        else this.onerror?.();
      },
    };
    return xhr;
  }

  it('PUTs with the signed content type and reports progress', async () => {
    const xhr = fakeXhr(200);
    const progress: number[] = [];
    const file = new Blob(['x']);
    await putWithProgress(
      'https://s3/url',
      file,
      'image/jpeg',
      (p) => progress.push(p),
      () => xhr,
    );
    expect(xhr.opened).toEqual(['PUT', 'https://s3/url']);
    // Both are signed: the type, and If-None-Match (the URL works once).
    expect(xhr.headers).toEqual({
      'Content-Type': 'image/jpeg',
      'If-None-Match': '*',
    });
    expect(xhr.body).toBe(file);
    expect(progress).toEqual([50, 100]);
  });

  it('rejects on an S3 error or a network error', async () => {
    await expect(
      putWithProgress(
        'u',
        new Blob(['x']),
        'application/pdf',
        () => undefined,
        () => fakeXhr(403),
      ),
    ).rejects.toThrow('403');
    await expect(
      putWithProgress(
        'u',
        new Blob(['x']),
        'application/pdf',
        () => undefined,
        () => fakeXhr(0, 'error'),
      ),
    ).rejects.toThrow('network');
  });
});

describe('page text', () => {
  it('uses the backend consent version', () => {
    const backend = readFileSync(
      fileURLToPath(
        new URL('../../../backend/app/upload_links.py', import.meta.url),
      ),
      'utf8',
    );
    expect(backend).toContain(`CONSENT_VERSION = "${CONSENT_VERSION}"`);
  });

  it('has every string in hi and mr with the same placeholders as en', () => {
    const placeholders = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort();
    for (const lang of ['hi', 'mr'] as const) {
      for (const [key, en] of Object.entries(CUSTOMER_PAGE_TEXT.en)) {
        const text =
          CUSTOMER_PAGE_TEXT[lang][key as keyof typeof CUSTOMER_PAGE_TEXT.en];
        expect(text, `${lang}.${key}`).toBeTruthy();
        expect(placeholders(text), `${lang}.${key}`).toEqual(placeholders(en));
      }
    }
  });

  it('fills placeholders and leaves unknown ones', () => {
    expect(pageText('en', 'wrongPassword', { left: 2 })).toBe(
      'Wrong password. 2 tries left.',
    );
    expect(pageText('en', 'requestedBy')).toContain('{{dsa}}');
  });

  it('states the DPDP points in every language', () => {
    for (const lang of ['en', 'hi', 'mr'] as const) {
      const t = CUSTOMER_PAGE_TEXT[lang];
      expect(t.consentDeletion).toContain('7');
      for (const key of [
        'consentPurpose',
        'consentWho',
        'consentWithdraw',
      ] as const) {
        expect(t[key]).toContain('{{dsa}}');
      }
    }
  });
});
