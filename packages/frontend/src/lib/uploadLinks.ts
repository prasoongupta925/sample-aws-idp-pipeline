// Staff side of the customer upload links: parsing the API's links, the
// items preselected from the File Check verdict, the link URL and the
// ready-made WhatsApp / SMS message. The token is only in memory: the API
// returns it once (POST), it goes into the URL fragment and nowhere else.
import type { FileCheckResult } from '../types/fileCheck';
import {
  UPLOAD_ITEM_CODES,
  UPLOAD_LINK_MAX_ITEMS,
  UPLOAD_LINK_MAX_NOTE,
  UPLOAD_LINK_MESSAGES,
  uploadItemName,
  type UploadLinkLanguage,
} from '../data/customerUpload';
import { normalizeStatus } from './fileCheck';
import { reminderItems, smsMonthPhrase } from './reminder';

export type UploadLinkStatus = 'active' | 'submitted' | 'revoked' | 'expired';

export interface RequestedItem {
  code: string;
  note?: string;
}

export interface UploadLink {
  link_id: string;
  status: UploadLinkStatus | string;
  items: RequestedItem[];
  language: UploadLinkLanguage;
  dsa_name: string;
  created_at: string;
  created_by?: string | null;
  expires_at: string;
  file_count: number;
  max_files: number;
  consented_at?: string | null;
  closed_at?: string | null;
}

export interface CreatedUploadLink extends UploadLink {
  token: string;
}

export interface UploadLinkCreate {
  items: RequestedItem[];
  expires_in_hours: number;
  language: UploadLinkLanguage;
}

const LANGS: UploadLinkLanguage[] = ['en', 'hi', 'mr'];
const CODE_RE = /^[A-Z0-9_]{1,40}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

function parseItems(raw: unknown): RequestedItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((i) => {
    const code = str((i as RequestedItem | null)?.code);
    if (!CODE_RE.test(code)) return [];
    const note = str((i as RequestedItem).note).trim();
    return [note ? { code, note } : { code }];
  });
}

/** One link of the API (never a token), or null when malformed. */
export function parseUploadLink(raw: unknown): UploadLink | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const linkId = str(r.link_id);
  if (!linkId) return null;
  const language = LANGS.includes(r.language as UploadLinkLanguage)
    ? (r.language as UploadLinkLanguage)
    : 'en';
  return {
    link_id: linkId,
    status: str(r.status) || 'active',
    items: parseItems(r.items),
    language,
    dsa_name: str(r.dsa_name),
    created_at: str(r.created_at),
    created_by: str(r.created_by) || null,
    expires_at: str(r.expires_at),
    file_count: num(r.file_count),
    max_files: num(r.max_files),
    consented_at: str(r.consented_at) || null,
    closed_at: str(r.closed_at) || null,
  };
}

/** The project's links, newest first. */
export function parseUploadLinks(raw: unknown): UploadLink[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(parseUploadLink)
    .filter((l): l is UploadLink => l !== null)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** The POST response; throws without a well-formed token. */
export function parseCreatedUploadLink(raw: unknown): CreatedUploadLink {
  const link = parseUploadLink(raw);
  const token = str((raw as { token?: unknown } | null)?.token);
  if (!link || !TOKEN_RE.test(token)) {
    throw new Error('Malformed upload link response');
  }
  return { ...link, token };
}

/** An active link past its expiry is shown as expired (the API closes it lazily). */
export function effectiveStatus(link: UploadLink, now = Date.now()): string {
  if (link.status !== 'active') return link.status;
  const expires = Date.parse(link.expires_at);
  return Number.isFinite(expires) && expires <= now ? 'expired' : 'active';
}

/** The customer's page: the token sits in the fragment, which browsers never send. */
export function uploadLinkUrl(token: string, origin: string): string {
  return `${origin.replace(/\/+$/, '')}/u#${token}`;
}

const itemKey = (i: RequestedItem) => `${i.code}|${i.note ?? ''}`;

function capNote(note: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const n = note.replace(/[\x00-\x1f\x7f]/g, '').trim();
  return n ? n.slice(0, UPLOAD_LINK_MAX_NOTE) : undefined;
}

/**
 * The items to preselect: the missing required checklist items of every
 * applicant that is not READY (the same rows the reminder lists). Months go
 * into the note ("Mar-May 2026"); an item without a known code is OTHER with
 * the checklist's label.
 */
export function itemsFromFileCheck(
  result: FileCheckResult | null | undefined,
): RequestedItem[] {
  if (!result) return [];
  const out: RequestedItem[] = [];
  const seen = new Set<string>();
  const add = (item: RequestedItem) => {
    const key = itemKey(item);
    if (seen.has(key) || out.length >= UPLOAD_LINK_MAX_ITEMS) return;
    seen.add(key);
    out.push(item);
  };
  for (const applicant of result.applicants ?? []) {
    if (normalizeStatus(applicant.verdict) === 'READY') continue;
    for (const item of reminderItems(applicant, result.checklist?.id)) {
      if (item.months.length > 0 && item.noun) {
        const note = capNote(smsMonthPhrase(item.months, 'en', true));
        add({
          code: item.noun === 'salary_slip' ? 'SALARY_SLIP' : 'BANK_STATEMENT',
          ...(note ? { note } : {}),
        });
      } else if (item.docs.length > 0) {
        item.docs.forEach((code) => add({ code }));
      } else {
        const note = capNote(item.label);
        add({ code: 'OTHER', ...(note ? { note } : {}) });
      }
    }
  }
  return out;
}

/** Normalises the picked items for the API: known codes, capped notes, no duplicates. */
export function requestItems(items: RequestedItem[]): RequestedItem[] {
  const seen = new Set<string>();
  const out: RequestedItem[] = [];
  for (const i of items) {
    if (!CODE_RE.test(i.code)) continue;
    const note = capNote(i.note ?? '');
    // OTHER means nothing without a note.
    if (i.code === 'OTHER' && !note) continue;
    const item = note ? { code: i.code, note } : { code: i.code };
    if (seen.has(itemKey(item))) continue;
    seen.add(itemKey(item));
    out.push(item);
  }
  return out.slice(0, UPLOAD_LINK_MAX_ITEMS);
}

/** Is this code one the picker offers? */
export function isKnownItemCode(code: string): boolean {
  return (UPLOAD_ITEM_CODES as string[]).includes(code);
}

/** 'bank statement (Mar-May 2026)'; OTHER is its note. */
export function requestedItemLabel(
  item: RequestedItem,
  language: UploadLinkLanguage,
): string {
  if (item.code === 'OTHER' && item.note) return item.note;
  const name = uploadItemName(item.code, language);
  return item.note ? `${name} (${item.note})` : name;
}

const LOCALES: Record<UploadLinkLanguage, string> = {
  en: 'en-IN',
  hi: 'hi-IN',
  mr: 'mr-IN',
};

/** '5 Oct, 1:30 pm' in India time, in the link's language. */
export function formatLinkExpiry(
  iso: string,
  language: UploadLinkLanguage,
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(LOCALES[language], {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  }).format(d);
}

/** The ready-made message for WhatsApp / SMS, in the link's language. */
export function uploadLinkMessage(
  link: Pick<UploadLink, 'items' | 'language' | 'dsa_name' | 'expires_at'>,
  url: string,
): string {
  const values: Record<string, string> = {
    dsa_name: link.dsa_name || 'your loan advisor',
    documents: link.items
      .map((i) => requestedItemLabel(i, link.language))
      .join(', '),
    link: url,
    expiry: formatLinkExpiry(link.expires_at, link.language),
  };
  return UPLOAD_LINK_MESSAGES[link.language].replace(
    /\{\{(\w+)\}\}/g,
    (whole, key: string) => values[key] ?? whole,
  );
}

/** WhatsApp's share URL (the user picks the chat). */
export function whatsappShareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

/** An SMS draft (the phone's messaging app; `?&body=` works on Android and iOS). */
export function smsShareUrl(text: string): string {
  return `sms:?&body=${encodeURIComponent(text)}`;
}

/** Documents a customer uploaded through a link. */
export function isCustomerUpload(doc: { source?: string | null }): boolean {
  return doc.source === 'customer_link';
}

/** A customer's password-protected PDF waiting for its password. */
export function needsPassword(doc: {
  status?: string;
  locked?: boolean;
}): boolean {
  return doc.status === 'password_required' || doc.locked === true;
}
