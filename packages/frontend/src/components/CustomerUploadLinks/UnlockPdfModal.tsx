import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, X } from 'lucide-react';
import { useModal } from '../../hooks/useModal';
import { unlockDocument, type UnlockOutcome } from '../../hooks/useUploadLinks';

type FetchApi = <T>(url: string, init?: RequestInit) => Promise<T>;

interface UnlockPdfModalProps {
  /** The locked document; null closes the dialog. */
  document: { document_id: string; name: string } | null;
  projectId: string;
  fetchApi: FetchApi;
  onClose: () => void;
  /** After a successful unlock (refresh the list: the pipeline starts). */
  onUnlocked?: () => void;
}

/**
 * Staff enter the password of a customer's protected PDF (the customer
 * skipped it). The password lives only in this form's state and is cleared
 * after every attempt; the server keeps only the unlocked copy.
 */
export default function UnlockPdfModal({
  document,
  projectId,
  fetchApi,
  onClose,
  onUnlocked,
}: UnlockPdfModalProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<UnlockOutcome | null>(null);
  const isOpen = document !== null;

  useEffect(() => {
    setPassword('');
    setOutcome(null);
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 50);
  }, [isOpen, document?.document_id]);

  const { handleBackdropClick } = useModal({
    isOpen,
    onClose,
    disableClose: busy,
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!document || !password || busy) return;
    setBusy(true);
    const result = await unlockDocument(
      fetchApi,
      projectId,
      document.document_id,
      password,
    );
    setPassword('');
    setBusy(false);
    setOutcome(result);
    if (result === 'unlocked') {
      onUnlocked?.();
      onClose();
    }
  };

  if (!document) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/55 backdrop-blur-md dark:bg-black/65"
      onClick={handleBackdropClick}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={submit}
        data-testid="unlock-pdf-modal"
        className="relative w-full max-w-sm space-y-3 rounded-2xl border border-amber-500/30 bg-white p-5 shadow-2xl dark:bg-slate-900"
      >
        <div className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-amber-600" aria-hidden="true" />
          <h2
            id={titleId}
            className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800 dark:text-slate-100"
          >
            {t('uploadLinks.unlock.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={t('common.close')}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50 dark:hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p
          className="truncate text-xs text-slate-600 dark:text-slate-300"
          title={document.name}
        >
          {document.name}
        </p>
        <p className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">
          {t('uploadLinks.unlock.hint')}
        </p>
        <div>
          <label
            htmlFor={inputId}
            className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400"
          >
            {t('uploadLinks.unlock.password')}
          </label>
          <input
            id={inputId}
            ref={inputRef}
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={128}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm dark:border-white/10 dark:bg-white/5 dark:text-slate-100"
          />
        </div>
        <p role="alert" className="text-[11px] text-red-600 dark:text-red-400">
          {outcome === 'wrong_password'
            ? t('uploadLinks.unlock.wrong')
            : outcome === 'failed'
              ? t('uploadLinks.unlock.failed')
              : ''}
        </p>
        <button
          type="submit"
          disabled={!password || busy}
          className="w-full rounded-lg bg-amber-600 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {busy ? t('uploadLinks.unlock.busy') : t('uploadLinks.unlock.submit')}
        </button>
      </form>
    </div>
  );
}
