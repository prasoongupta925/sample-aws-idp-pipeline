// @vitest-environment node
import {
  NOT_READY_RESULT,
  SNEHA_NOT_READY_RESULT,
} from '../components/FileCheckPanel/fixtures';
import type { FileCheckResult } from '../types/fileCheck';
import {
  effectiveStatus,
  formatLinkExpiry,
  isCustomerUpload,
  itemsFromFileCheck,
  needsPassword,
  parseCreatedUploadLink,
  parseUploadLink,
  parseUploadLinks,
  requestItems,
  requestedItemLabel,
  smsShareUrl,
  uploadLinkMessage,
  uploadLinkUrl,
  whatsappShareUrl,
  type UploadLink,
} from './uploadLinks';
import { uploadItemName } from '../data/customerUpload';

const TOKEN = 'A'.repeat(20) + '_-' + 'b'.repeat(21); // 43 characters

const LINK = {
  link_id: 'ul_abc123',
  status: 'active',
  items: [
    { code: 'PAN_COPY' },
    { code: 'BANK_STATEMENT', note: 'Mar-May 2026' },
  ],
  language: 'en',
  dsa_name: 'Asha Verma Loans',
  created_at: '2026-10-03T08:00:00+00:00',
  created_by: 'staff1',
  expires_at: '2026-10-06T08:00:00+00:00',
  file_count: 2,
  max_files: 20,
  consented_at: null,
  closed_at: null,
};

describe('parseUploadLink', () => {
  it('keeps the API fields and drops malformed items', () => {
    const link = parseUploadLink({
      ...LINK,
      items: [...LINK.items, { code: 'bad code' }, null, { code: 'OTHER' }],
    });
    expect(link?.items).toEqual([
      { code: 'PAN_COPY' },
      { code: 'BANK_STATEMENT', note: 'Mar-May 2026' },
      { code: 'OTHER' },
    ]);
    expect(link?.file_count).toBe(2);
    expect(link?.consented_at).toBeNull();
  });

  it('rejects a link without an id and falls back to English', () => {
    expect(parseUploadLink({ ...LINK, link_id: '' })).toBeNull();
    expect(parseUploadLink(null)).toBeNull();
    expect(parseUploadLink({ ...LINK, language: 'fr' })?.language).toBe('en');
  });

  it('sorts a list newest first and never keeps a token', () => {
    const list = parseUploadLinks([
      LINK,
      {
        ...LINK,
        link_id: 'ul_new',
        created_at: '2026-10-03T09:00:00+00:00',
        token: TOKEN,
      },
      'junk',
    ]);
    expect(list.map((l) => l.link_id)).toEqual(['ul_new', 'ul_abc123']);
    expect(JSON.stringify(list)).not.toContain(TOKEN);
    expect(parseUploadLinks({})).toEqual([]);
  });

  it('needs a well-formed token in the create response', () => {
    expect(parseCreatedUploadLink({ ...LINK, token: TOKEN }).token).toBe(TOKEN);
    expect(() => parseCreatedUploadLink(LINK)).toThrow();
    expect(() => parseCreatedUploadLink({ ...LINK, token: 'short' })).toThrow();
    expect(() =>
      parseCreatedUploadLink({ ...LINK, token: `${TOKEN.slice(1)}/` }),
    ).toThrow();
  });
});

describe('effectiveStatus', () => {
  const link = parseUploadLink(LINK) as UploadLink;
  it('shows an active link past its expiry as expired', () => {
    expect(effectiveStatus(link, Date.parse('2026-10-05T00:00:00Z'))).toBe(
      'active',
    );
    expect(effectiveStatus(link, Date.parse('2026-10-06T08:00:00Z'))).toBe(
      'expired',
    );
    expect(effectiveStatus({ ...link, status: 'submitted' }, 0)).toBe(
      'submitted',
    );
  });
});

describe('uploadLinkUrl', () => {
  it('puts the token in the fragment, never in the path or query', () => {
    const url = uploadLinkUrl(TOKEN, 'https://app.example.com/');
    expect(url).toBe(`https://app.example.com/u#${TOKEN}`);
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/u');
    expect(parsed.search).toBe('');
    expect(parsed.hash).toBe(`#${TOKEN}`);
  });
});

describe('itemsFromFileCheck', () => {
  it("preselects the verdict's missing required items with their months", () => {
    expect(itemsFromFileCheck(SNEHA_NOT_READY_RESULT)).toEqual([
      { code: 'SALARY_SLIP', note: 'Jun 2026' },
      { code: 'BANK_STATEMENT', note: 'Mar-May 2026' },
      { code: 'FORM16_ITR' },
    ]);
  });

  it('skips optional and REVIEW rows', () => {
    // NOT_READY_RESULT: address proof is REVIEW, Form-16 is optional.
    expect(itemsFromFileCheck(NOT_READY_RESULT)).toEqual([
      { code: 'SALARY_SLIP', note: 'Jun-Jul 2026' },
    ]);
  });

  it('skips READY applicants and asks for unknown items as OTHER', () => {
    const base = SNEHA_NOT_READY_RESULT.applicants[0];
    const result: FileCheckResult = {
      ...SNEHA_NOT_READY_RESULT,
      checklist: { id: 'custom_list' },
      applicants: [
        { ...base, verdict: 'READY' },
        {
          ...base,
          missing_items: [],
          checklist: [
            {
              item_id: 'rent_agreement',
              item: 'Rent agreement',
              required: true,
              status: 'MISSING',
              ok: false,
              detail: '',
              documents: [],
            },
          ],
        },
      ],
    };
    expect(itemsFromFileCheck(result)).toEqual([
      { code: 'OTHER', note: 'Rent agreement' },
    ]);
    expect(itemsFromFileCheck(null)).toEqual([]);
  });
});

describe('requestItems', () => {
  it('drops bad codes, empty OTHER and duplicates, and caps notes', () => {
    const items = requestItems([
      { code: 'PAN_COPY' },
      { code: 'PAN_COPY', note: '  ' },
      { code: 'OTHER', note: '' },
      { code: 'OTHER', note: 'Rent\u0007 agreement' },
      { code: 'lower' },
      { code: 'BANK_STATEMENT', note: 'x'.repeat(200) },
    ]);
    expect(items).toEqual([
      { code: 'PAN_COPY' },
      { code: 'OTHER', note: 'Rent agreement' },
      { code: 'BANK_STATEMENT', note: 'x'.repeat(120) },
    ]);
  });

  it('keeps at most 20 items', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      code: 'OTHER',
      note: `doc ${i}`,
    }));
    expect(requestItems(many)).toHaveLength(20);
  });
});

describe('message', () => {
  const link = parseUploadLink(LINK) as UploadLink;
  const url = uploadLinkUrl(TOKEN, 'https://app.example.com');

  it('names the items in the link language', () => {
    expect(
      requestedItemLabel({ code: 'OTHER', note: 'Rent agreement' }, 'hi'),
    ).toBe('Rent agreement');
    expect(uploadItemName('PAN_COPY', 'mr')).toBe('PAN कार्डची प्रत');
    expect(uploadItemName('NOT_A_CODE', 'en')).toBe('other document');
  });

  it('fills the English message with the DSA, items, link and expiry (IST)', () => {
    const text = uploadLinkMessage(link, url);
    expect(text).toContain('Asha Verma Loans');
    expect(text).toContain('PAN card copy, bank statement (Mar-May 2026)');
    expect(text).toContain(url);
    expect(text).toContain(formatLinkExpiry(LINK.expires_at, 'en'));
    expect(formatLinkExpiry(LINK.expires_at, 'en')).toMatch(/6 Oct/);
    expect(text).not.toMatch(/\{\{/);
  });

  it('has Hindi and Marathi messages', () => {
    expect(uploadLinkMessage({ ...link, language: 'hi' }, url)).toContain(
      'PAN card की copy',
    );
    expect(uploadLinkMessage({ ...link, language: 'mr' }, url)).toContain(
      'PAN कार्डची प्रत',
    );
    expect(uploadLinkMessage({ ...link, dsa_name: '' }, url)).toContain(
      'your loan advisor',
    );
  });

  it('encodes the share URLs', () => {
    const text = 'Hi & bye #1 https://x/u#tok';
    expect(whatsappShareUrl(text)).toBe(
      `https://wa.me/?text=${encodeURIComponent(text)}`,
    );
    expect(smsShareUrl(text)).toBe(`sms:?&body=${encodeURIComponent(text)}`);
    expect(whatsappShareUrl(text)).not.toContain('#');
  });
});

describe('document flags', () => {
  it('spots customer uploads and locked PDFs', () => {
    expect(isCustomerUpload({ source: 'customer_link' })).toBe(true);
    expect(isCustomerUpload({ source: null })).toBe(false);
    expect(needsPassword({ status: 'password_required' })).toBe(true);
    expect(needsPassword({ status: 'uploaded', locked: true })).toBe(true);
    expect(needsPassword({ status: 'completed', locked: false })).toBe(false);
  });
});
