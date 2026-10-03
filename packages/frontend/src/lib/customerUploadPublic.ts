// Customer side of the upload links (/u#<token>): no login. The token sits
// in the URL fragment (browsers never send it) and goes only into the
// X-Upload-Token header of the backend's /public/upload-link calls. Calls
// send no cookies and no referrer. The files go straight to S3 through the
// presigned PUT the backend returns for each one.
import { ApiError, errorDetailFromBody } from './apiError';
import { isUploadToken, type RequestedItem } from './uploadLinks';
import {
  UPLOAD_LINK_MAX_FILE_MB,
  UPLOAD_LINK_MAX_FILES,
  type UploadLinkLanguage,
} from '../data/customerUpload';

export const PUBLIC_UPLOAD_PATH = 'public/upload-link';
export const DOC_PASSWORD_REQUIRED = 'password_required';
const LANGS: UploadLinkLanguage[] = ['en', 'hi', 'mr'];

export interface PublicFile {
  document_id: string;
  file_name: string;
  status: string;
  locked: boolean;
}

export interface PublicLink {
  dsa_name: string;
  items: RequestedItem[];
  language: UploadLinkLanguage;
  expires_at: string;
  consented: boolean;
  consent_version: string;
  file_count: number;
  max_files: number;
  max_file_bytes: number;
  files: PublicFile[];
}

export interface PublicFileTicket {
  document_id: string;
  upload_url: string;
  status: string;
}

export type UnlockResult =
  | { status: 'unlocked' }
  | { status: 'wrong_password'; attemptsLeft: number };

/** The token of the page URL's fragment (`#<token>`), else null. */
export function tokenFromHash(hash: string): string | null {
  const token = hash.replace(/^#/, '');
  return isUploadToken(token) ? token : null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

function parseItems(raw: unknown): RequestedItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((i) => {
    const code = str((i as RequestedItem | null)?.code);
    if (!code) return [];
    const note = str((i as RequestedItem).note).trim();
    return [note ? { code, note } : { code }];
  });
}

/** The GET response; throws when it is not a link. */
export function parsePublicLink(raw: unknown): PublicLink {
  if (!raw || typeof raw !== 'object') throw new Error('Malformed link');
  const r = raw as Record<string, unknown>;
  const files = Array.isArray(r.files)
    ? r.files.flatMap((f): PublicFile[] => {
        const file = (f ?? {}) as Record<string, unknown>;
        const id = str(file.document_id);
        if (!id) return [];
        return [
          {
            document_id: id,
            file_name: str(file.file_name),
            status: str(file.status),
            locked: file.locked === true,
          },
        ];
      })
    : [];
  return {
    dsa_name: str(r.dsa_name),
    items: parseItems(r.items),
    language: LANGS.includes(r.language as UploadLinkLanguage)
      ? (r.language as UploadLinkLanguage)
      : 'en',
    expires_at: str(r.expires_at),
    consented: r.consented === true,
    consent_version: str(r.consent_version),
    file_count: num(r.file_count),
    max_files: num(r.max_files) || UPLOAD_LINK_MAX_FILES,
    max_file_bytes: num(r.max_file_bytes) || UPLOAD_LINK_MAX_FILE_MB * 2 ** 20,
    files,
  };
}

/** A file waiting for its password (the page asks for it). */
export const needsPassword = (file: PublicFile): boolean =>
  file.locked && file.status === DOC_PASSWORD_REQUIRED;

// The backend's customer types (app/upload_links.py CUSTOMER_EXTENSIONS).
const CUSTOMER_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const extensionOf = (name: string): string =>
  name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';

/** Content type to declare (and send on the PUT); null when not accepted. */
export function customerContentType(
  file: Pick<File, 'name' | 'type'>,
): string | null {
  const expected = CUSTOMER_TYPES[extensionOf(file.name)];
  if (!expected) return null;
  // The browser's type when it matches the extension, else the extension's.
  const type = file.type.toLowerCase();
  if (
    type === expected ||
    (expected === 'image/jpeg' && type === 'image/pjpeg')
  )
    return type;
  return expected;
}

export type FileRejection = 'type' | 'size';

/** Why the page refuses a file before asking the backend, else null. */
export function rejectFile(
  file: Pick<File, 'name' | 'type' | 'size'>,
  maxBytes: number,
): FileRejection | null {
  if (customerContentType(file) === null) return 'type';
  if (file.size < 1 || file.size > maxBytes) return 'size';
  return null;
}

export const isPdf = (file: Pick<File, 'name'>): boolean =>
  extensionOf(file.name) === 'pdf';

// The check of type detection (encrypted_pdf.py): "/Encrypt" as a name in
// the first or last 64 KB (the trailer is never compressed).
const CHUNK_BYTES = 64 * 1024;
const ENCRYPT_NAME = /\/Encrypt(?=[\s/<[(0-9])/;

const latin1 = (bytes: ArrayBuffer): string =>
  new TextDecoder('latin1').decode(bytes);

/** True when the PDF names an Encrypt dictionary (it needs a password). */
export async function isEncryptedPdf(file: Blob): Promise<boolean> {
  if (file.size <= 2 * CHUNK_BYTES) {
    return ENCRYPT_NAME.test(latin1(await file.arrayBuffer()));
  }
  const head = await file.slice(0, CHUNK_BYTES).arrayBuffer();
  const tail = await file.slice(file.size - CHUNK_BYTES).arrayBuffer();
  return ENCRYPT_NAME.test(latin1(head)) || ENCRYPT_NAME.test(latin1(tail));
}

/** The backend's /public/upload-link calls with this link's token. */
export function createPublicClient(
  backendUrl: string,
  token: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
) {
  const base = `${backendUrl.replace(/\/+$/, '')}/${PUBLIC_UPLOAD_PATH}`;

  async function call(path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { 'X-Upload-Token': token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetchImpl(`${base}${path}`, {
      method: body === undefined && path === '' ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      throw new ApiError(response.status, errorDetailFromBody(text));
    }
    return text ? (JSON.parse(text) as unknown) : undefined;
  }

  return {
    async get(): Promise<PublicLink> {
      return parsePublicLink(await call(''));
    },
    async consent(
      language: UploadLinkLanguage,
      consentVersion: string,
    ): Promise<void> {
      await call('/consent', {
        accepted: true,
        language,
        consent_version: consentVersion,
      });
    },
    async createFile(request: {
      file_name: string;
      content_type: string;
      file_size: number;
      encrypted: boolean;
    }): Promise<PublicFileTicket> {
      const r = ((await call('/files', request)) ?? {}) as Record<
        string,
        unknown
      >;
      const ticket = {
        document_id: str(r.document_id),
        upload_url: str(r.upload_url),
        status: str(r.status),
      };
      if (!ticket.document_id || !ticket.upload_url.startsWith('https://')) {
        throw new Error('Malformed upload ticket');
      }
      return ticket;
    },
    async unlock(documentId: string, password: string): Promise<UnlockResult> {
      const r = ((await call(
        `/files/${encodeURIComponent(documentId)}/unlock`,
        { password },
      )) ?? {}) as Record<string, unknown>;
      if (r.status === 'wrong_password') {
        return { status: 'wrong_password', attemptsLeft: num(r.attempts_left) };
      }
      if (r.status === 'unlocked') return { status: 'unlocked' };
      throw new Error('Unexpected unlock status');
    },
    async submit(): Promise<number> {
      const r = ((await call('/submit', {})) ?? {}) as Record<string, unknown>;
      return num(r.file_count);
    },
  };
}

export type PublicClient = ReturnType<typeof createPublicClient>;

/** The part of XMLHttpRequest that putWithProgress uses (tests fake it). */
export type ProgressRequest = Pick<
  XMLHttpRequest,
  | 'onload'
  | 'onerror'
  | 'onabort'
  | 'status'
  | 'open'
  | 'setRequestHeader'
  | 'send'
> & { upload: Pick<XMLHttpRequestUpload, 'onprogress'> };

/**
 * PUT the file to its presigned URL with upload progress (0-100). fetch has
 * no upload progress, hence XMLHttpRequest. Content-Type must be the type
 * the URL was signed for; the browser sets Content-Length from the file.
 */
export function putWithProgress(
  url: string,
  file: Blob,
  contentType: string,
  onProgress: (percent: number) => void,
  makeRequest: () => ProgressRequest = () => new XMLHttpRequest(),
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = makeRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) {
        onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed (network)'));
    xhr.onabort = () => reject(new Error('Upload aborted'));
    xhr.send(file);
  });
}
