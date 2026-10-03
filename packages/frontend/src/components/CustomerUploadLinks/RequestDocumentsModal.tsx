import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  Copy,
  Link2,
  MessageCircle,
  MessageSquare,
  X,
} from 'lucide-react';
import { useModal } from '../../hooks/useModal';
import { useUploadLinks } from '../../hooks/useUploadLinks';
import type { FileCheckResult } from '../../types/fileCheck';
import {
  UPLOAD_ITEM_CODES,
  UPLOAD_LINK_DEFAULT_HOURS,
  UPLOAD_LINK_EXPIRY_HOURS,
  UPLOAD_LINK_LANGUAGES,
  UPLOAD_LINK_MAX_FILES,
  UPLOAD_LINK_MAX_FILE_MB,
  UPLOAD_LINK_MAX_NOTE,
  type UploadLinkLanguage,
} from '../../data/customerUpload';
import {
  effectiveStatus,
  itemsFromFileCheck,
  requestItems,
  requestedItemLabel,
  smsShareUrl,
  uploadLinkMessage,
  uploadLinkUrl,
  whatsappShareUrl,
  type CreatedUploadLink,
  type RequestedItem,
  type UploadLink,
} from '../../lib/uploadLinks';
import { copyText } from '../../lib/clipboard';
import { apiErrorDetail } from '../../lib/apiError';

type FetchApi = <T>(url: string, init?: RequestInit) => Promise<T>;

interface ItemRow {
  key: string;
  code: string;
  note: string;
  /** From the File Check verdict. */
  fromCheck: boolean;
}

/** The picker's rows: the verdict's missing items first, then every other code once. */
export function itemRows(preselected: RequestedItem[]): ItemRow[] {
  const rows: ItemRow[] = preselected.map((i, n) => ({
    key: `check-${n}`,
    code: i.code,
    note: i.note ?? '',
    fromCheck: true,
  }));
  for (const code of UPLOAD_ITEM_CODES) {
    if (code !== 'OTHER' && rows.some((r) => r.code === code)) continue;
    rows.push({ key: `code-${code}`, code, note: '', fromCheck: false });
  }
  return rows;
}

const STATUS_STYLES: Record<string, string> = {
  active:
    'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400',
  submitted: 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400',
  revoked: 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-400',
  expired:
    'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400',
};

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      });
}

interface RequestDocumentsModalProps {
  isOpen: boolean;
  onClose: () => void;
  fetchApi: FetchApi;
  projectId: string;
  /** The last File Check run: its missing items are preselected. */
  fileCheckResult?: FileCheckResult | null;
  /** Where the customer page lives (window.location.origin). */
  origin?: string;
}

/**
 * "Request documents from customer": creates an upload link (the customer
 * needs no login), shows it once with a ready-made WhatsApp / SMS message,
 * and lists the project's links with revoke.
 */
export default function RequestDocumentsModal({
  isOpen,
  onClose,
  fetchApi,
  projectId,
  fileCheckResult,
  origin = typeof window !== 'undefined' ? window.location.origin : '',
}: RequestDocumentsModalProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const expiryId = useId();
  const linkInputId = useId();
  const messageId = useId();
  const linkRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const linksState = useUploadLinks({ fetchApi, projectId });
  const { load } = linksState;

  const preselected = useMemo(
    () => itemsFromFileCheck(fileCheckResult),
    [fileCheckResult],
  );
  const [rows, setRows] = useState<ItemRow[]>(() => itemRows(preselected));
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(rows.filter((r) => r.fromCheck).map((r) => r.key)),
  );
  const [hours, setHours] = useState(UPLOAD_LINK_DEFAULT_HOURS);
  const [language, setLanguage] = useState<UploadLinkLanguage>('en');
  const [created, setCreated] = useState<CreatedUploadLink | null>(null);
  const [copied, setCopied] = useState<'link' | 'message' | 'manual' | null>(
    null,
  );
  const [revokeError, setRevokeError] = useState(false);

  // A fresh form (and no token left in memory) every time it opens; a new
  // File Check result while it is open does not wipe a shown link.
  const wasOpen = useRef(false);
  useEffect(() => {
    const opened = isOpen && !wasOpen.current;
    wasOpen.current = isOpen;
    if (!opened) return;
    const fresh = itemRows(preselected);
    setRows(fresh);
    setChecked(new Set(fresh.filter((r) => r.fromCheck).map((r) => r.key)));
    setHours(UPLOAD_LINK_DEFAULT_HOURS);
    setLanguage('en');
    setCreated(null);
    setCopied(null);
    setRevokeError(false);
    load();
  }, [isOpen, preselected, load]);

  useEffect(() => {
    if (copied !== 'link' && copied !== 'message') return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const close = () => {
    setCreated(null);
    onClose();
  };
  const { handleBackdropClick } = useModal({
    isOpen,
    onClose: close,
    disableClose: linksState.creating,
  });

  const picked = requestItems(
    rows
      .filter((r) => checked.has(r.key))
      .map((r) => ({ code: r.code, note: r.note })),
  );
  const otherMissingNote = rows.some(
    (r) => r.code === 'OTHER' && checked.has(r.key) && !r.note.trim(),
  );

  const toggle = (key: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const setNote = (key: string, note: string) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, note } : r)));
    if (note.trim()) setChecked((prev) => new Set(prev).add(key));
  };

  const submit = async () => {
    if (picked.length === 0 || otherMissingNote) return;
    const link = await linksState.create({
      items: picked,
      expires_in_hours: hours,
      language,
    });
    if (link) setCreated(link);
  };

  const url = created ? uploadLinkUrl(created.token, origin) : '';
  const message = created ? uploadLinkMessage(created, url) : '';

  const copy = async (what: 'link' | 'message') => {
    const outcome = await copyText(
      what === 'link' ? url : message,
      what === 'link' ? linkRef.current : messageRef.current,
    );
    setCopied(outcome === 'copied' ? what : 'manual');
  };

  const revoke = async (link: UploadLink) => {
    setRevokeError(false);
    const ok = await linksState.revoke(link.link_id);
    if (!ok) setRevokeError(true);
    else if (created?.link_id === link.link_id) setCreated(null);
  };

  if (!isOpen) return null;

  const label =
    'block text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400';
  const button =
    'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-1';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-in fade-in duration-200 bg-black/55 dark:bg-black/65 backdrop-blur-md"
      onClick={handleBackdropClick}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="request-documents-modal"
        className="relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-emerald-500/30 bg-white shadow-2xl animate-in zoom-in-95 duration-200 dark:bg-slate-900"
      >
        <div className="flex items-center gap-2 border-b border-black/5 px-5 py-4 dark:border-white/10">
          <Link2
            className="h-4 w-4 text-emerald-600 dark:text-emerald-400"
            aria-hidden="true"
          />
          <h2
            id={titleId}
            className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800 dark:text-slate-100"
          >
            {t('uploadLinks.title')}
          </h2>
          <button
            type="button"
            onClick={close}
            disabled={linksState.creating}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50 dark:hover:bg-white/10 dark:hover:text-white"
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {!created ? (
            <>
              <p className="text-xs leading-snug text-slate-600 dark:text-slate-300">
                {t('uploadLinks.intro', {
                  files: UPLOAD_LINK_MAX_FILES,
                  mb: UPLOAD_LINK_MAX_FILE_MB,
                })}
              </p>
              <fieldset>
                <legend className={label}>{t('uploadLinks.items')}</legend>
                <p className="mb-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                  {preselected.length > 0
                    ? t('uploadLinks.preselected', {
                        count: preselected.length,
                      })
                    : t('uploadLinks.noPreselect')}
                </p>
                <ul className="space-y-1" data-testid="upload-link-items">
                  {rows.map((r) => (
                    <li key={r.key} className="flex items-center gap-2">
                      <input
                        id={`${titleId}-${r.key}`}
                        type="checkbox"
                        checked={checked.has(r.key)}
                        onChange={() => toggle(r.key)}
                        className="h-3.5 w-3.5 accent-emerald-600"
                      />
                      <label
                        htmlFor={`${titleId}-${r.key}`}
                        className="min-w-0 flex-1 truncate text-xs text-slate-700 dark:text-slate-200"
                      >
                        {r.code === 'OTHER' && !r.fromCheck
                          ? t('uploadLinks.other')
                          : requestedItemLabel(
                              { code: r.code, note: r.note || undefined },
                              'en',
                            )}
                        {r.fromCheck && (
                          <span className="ml-1.5 rounded bg-amber-50 px-1 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
                            {t('uploadLinks.missingTag')}
                          </span>
                        )}
                      </label>
                      {r.code === 'OTHER' && !r.fromCheck && (
                        <input
                          type="text"
                          value={r.note}
                          maxLength={UPLOAD_LINK_MAX_NOTE}
                          onChange={(e) => setNote(r.key, e.target.value)}
                          placeholder={t('uploadLinks.otherPlaceholder')}
                          aria-label={t('uploadLinks.otherPlaceholder')}
                          className="w-44 rounded-md border border-black/10 bg-white/60 px-2 py-1 text-xs dark:border-white/10 dark:bg-white/5 dark:text-slate-100"
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </fieldset>

              <div className="flex flex-wrap gap-4">
                <div>
                  <label htmlFor={expiryId} className={label}>
                    {t('uploadLinks.expiry')}
                  </label>
                  <select
                    id={expiryId}
                    value={hours}
                    onChange={(e) => setHours(Number(e.target.value))}
                    className="mt-1 rounded-lg border border-black/10 bg-white/60 px-2 py-1 text-xs text-slate-700 dark:border-white/10 dark:bg-[#0d1117] dark:text-slate-200"
                  >
                    {UPLOAD_LINK_EXPIRY_HOURS.map((h) => (
                      <option key={h} value={h}>
                        {h % 24 === 0
                          ? t('uploadLinks.days', { count: h / 24 })
                          : t('uploadLinks.hours', { count: h })}
                      </option>
                    ))}
                  </select>
                </div>
                <fieldset>
                  <legend className={label}>{t('uploadLinks.language')}</legend>
                  <div className="mt-1 flex gap-1">
                    {UPLOAD_LINK_LANGUAGES.map((l) => (
                      <label key={l.code}>
                        <input
                          type="radio"
                          name={`${titleId}-language`}
                          value={l.code}
                          checked={language === l.code}
                          onChange={() => setLanguage(l.code)}
                          className="peer sr-only"
                        />
                        <span
                          lang={l.code}
                          className="block cursor-pointer rounded-md border border-black/10 px-2 py-1 text-xs text-slate-600 peer-checked:border-emerald-600 peer-checked:bg-emerald-600 peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-500 dark:border-white/10 dark:text-slate-300"
                        >
                          {l.label}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>

              {otherMissingNote && (
                <p className="text-[11px] text-amber-700 dark:text-amber-400">
                  {t('uploadLinks.otherNeedsNote')}
                </p>
              )}
              <p
                role="alert"
                className="text-[11px] text-red-600 dark:text-red-400"
              >
                {linksState.createError
                  ? apiErrorDetail(linksState.createError) ||
                    t('uploadLinks.createFailed')
                  : ''}
              </p>
              <button
                type="button"
                onClick={submit}
                disabled={
                  linksState.creating || picked.length === 0 || otherMissingNote
                }
                data-testid="create-upload-link"
                className={`${button} bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50`}
              >
                <Link2 className="h-3.5 w-3.5" />
                {linksState.creating
                  ? t('uploadLinks.creating')
                  : t('uploadLinks.create', { count: picked.length })}
              </button>
            </>
          ) : (
            <section className="space-y-3" data-testid="upload-link-created">
              <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                {t('uploadLinks.created')}
              </p>
              <div>
                <label htmlFor={linkInputId} className={label}>
                  {t('uploadLinks.link')}
                </label>
                <div className="mt-1 flex gap-2">
                  <input
                    id={linkInputId}
                    ref={linkRef}
                    readOnly
                    value={url}
                    className="min-w-0 flex-1 rounded-lg border border-black/10 bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-700 dark:border-white/10 dark:bg-white/5 dark:text-slate-200"
                  />
                  <button
                    type="button"
                    onClick={() => copy('link')}
                    className={`${button} bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-white/10 dark:text-slate-200`}
                  >
                    {copied === 'link' ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    {copied === 'link' ? t('common.copied') : t('common.copy')}
                  </button>
                </div>
              </div>
              <div>
                <label htmlFor={messageId} className={label}>
                  {t('uploadLinks.message')}
                </label>
                <textarea
                  id={messageId}
                  ref={messageRef}
                  readOnly
                  rows={5}
                  lang={created.language}
                  value={message}
                  data-testid="upload-link-message"
                  className="mt-1 w-full resize-y rounded-lg border border-black/10 bg-slate-50 px-2 py-1.5 text-xs leading-relaxed text-slate-800 dark:border-white/10 dark:bg-white/5 dark:text-slate-100"
                />
                <div className="mt-1 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => copy('message')}
                    className={`${button} bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-white/10 dark:text-slate-200`}
                  >
                    {copied === 'message' ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    {copied === 'message'
                      ? t('common.copied')
                      : t('uploadLinks.copyMessage')}
                  </button>
                  <a
                    href={whatsappShareUrl(message)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`${button} bg-emerald-600 text-white hover:bg-emerald-700`}
                  >
                    <MessageCircle className="h-3.5 w-3.5" />
                    {t('uploadLinks.whatsapp')}
                  </a>
                  <a
                    href={smsShareUrl(message)}
                    className={`${button} bg-blue-600 text-white hover:bg-blue-700`}
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                    {t('uploadLinks.sms')}
                  </a>
                </div>
                <p
                  role="status"
                  className="mt-1 text-[11px] text-amber-700 dark:text-amber-400"
                >
                  {copied === 'manual' ? t('uploadLinks.copyManual') : ''}
                </p>
              </div>
              <p className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                {t('uploadLinks.shownOnce')}
              </p>
              <button
                type="button"
                onClick={() => setCreated(null)}
                className={`${button} bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-white/10 dark:text-slate-200`}
              >
                {t('uploadLinks.another')}
              </button>
            </section>
          )}

          <section aria-labelledby={`${titleId}-list`}>
            <h3 id={`${titleId}-list`} className={label}>
              {t('uploadLinks.listTitle')}
            </h3>
            {linksState.loadError ? (
              <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                {t('uploadLinks.loadFailed')}
              </p>
            ) : linksState.links.length === 0 ? (
              <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                {linksState.loading
                  ? t('common.loading')
                  : t('uploadLinks.none')}
              </p>
            ) : (
              <ul className="mt-1 space-y-1.5" data-testid="upload-link-list">
                {linksState.links.map((l) => {
                  const status = effectiveStatus(l);
                  return (
                    <li
                      key={l.link_id}
                      className="flex items-center gap-2 rounded-lg border border-black/5 px-2.5 py-1.5 dark:border-white/10"
                    >
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_STYLES[status] ?? STATUS_STYLES.revoked}`}
                      >
                        {t(`uploadLinks.status.${status}`, status)}
                      </span>
                      <div className="min-w-0 flex-1 text-[11px] text-slate-600 dark:text-slate-300">
                        <p
                          className="truncate"
                          title={l.items
                            .map((i) => requestedItemLabel(i, 'en'))
                            .join(', ')}
                        >
                          {l.items
                            .map((i) => requestedItemLabel(i, 'en'))
                            .join(', ')}
                        </p>
                        <p className="text-[10px] text-slate-400">
                          {t('uploadLinks.files', {
                            count: l.file_count,
                            max: l.max_files || UPLOAD_LINK_MAX_FILES,
                          })}
                          {' · '}
                          {status === 'active'
                            ? t('uploadLinks.expires', {
                                when: formatWhen(l.expires_at),
                              })
                            : formatWhen(l.closed_at || l.expires_at)}
                          {l.consented_at
                            ? ` · ${t('uploadLinks.consented')}`
                            : ''}
                        </p>
                      </div>
                      {status === 'active' && (
                        <button
                          type="button"
                          onClick={() => revoke(l)}
                          disabled={linksState.revoking === l.link_id}
                          className="rounded-md px-2 py-1 text-[11px] font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-900/20"
                        >
                          {t('uploadLinks.revoke')}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {revokeError && (
              <p
                role="alert"
                className="mt-1 text-[11px] text-red-600 dark:text-red-400"
              >
                {t('uploadLinks.revokeFailed')}
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
