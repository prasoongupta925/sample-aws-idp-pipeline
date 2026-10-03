import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import {
  Camera,
  CheckCircle2,
  FileUp,
  Loader2,
  Lock,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { useRuntimeConfig } from '../../hooks/useRuntimeConfig';
import { ApiError } from '../../lib/apiError';
import {
  createPublicClient,
  customerContentType,
  isEncryptedPdf,
  isPdf,
  needsPassword,
  putWithProgress,
  rejectFile,
  takeLinkToken,
  type PublicClient,
  type PublicFile,
  type PublicLink,
} from '../../lib/customerUploadPublic';
import { formatLinkExpiry, requestedItemLabel } from '../../lib/uploadLinks';
import type { UploadLinkLanguage } from '../../data/customerUpload';
import {
  CONSENT_VERSION,
  PAGE_LANGUAGE_NAMES,
  pageText,
  type CustomerPageText,
} from '../../data/customerUploadPage';

type T = (
  key: keyof CustomerPageText,
  vars?: Record<string, string | number>,
) => string;

const MB = 2 ** 20;

/** A file picked on this page, until the server lists it. */
export interface LocalFile {
  key: string;
  name: string;
  state: 'checking' | 'uploading' | 'failed' | 'rejected';
  progress: number;
  reason?: keyof CustomerPageText;
}

export type Phase =
  | { kind: 'loading' }
  | { kind: 'noLink' }
  | { kind: 'invalid' }
  | { kind: 'error' }
  | { kind: 'ready'; link: PublicLink }
  | { kind: 'submitted'; count: number; dsa: string };

const isNotFound = (err: unknown) =>
  err instanceof ApiError && err.status === 404;

/**
 * The customer's page of an upload link (/u#<token>), outside the signed-in
 * app: who asks for what, the DPDP consent, then the upload (camera or files,
 * progress, PDF passwords) and Submit. Everything it shows comes from the
 * token's link; every 404 shows one "link does not work" page.
 *
 * main.tsx reads the token from the fragment (takeLinkToken, which also takes
 * it out of the address bar) before anything renders; here it lives in
 * memory only. Opening the link again in the same tab only changes the
 * fragment (no page load): that new token is taken the same way.
 */
export default function CustomerUploadPage({
  initialToken,
}: {
  initialToken: string | null;
}) {
  const { apis } = useRuntimeConfig();
  const backendUrl = typeof apis?.Backend === 'string' ? apis.Backend : '';
  const [token, setToken] = useState(initialToken);
  useEffect(() => {
    const onHashChange = () => {
      const next = takeLinkToken();
      if (next) setToken(next);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  const client = useMemo(
    () => (token && backendUrl ? createPublicClient(backendUrl, token) : null),
    [token, backendUrl],
  );
  // A new token starts the page over (key), with nothing of the old link.
  return <CustomerUploadFlow key={token ?? ''} client={client} />;
}

/** The page's state and calls; `client` null means no usable token. */
export function CustomerUploadFlow({
  client,
}: {
  client: PublicClient | null;
}) {
  const [phase, setPhase] = useState<Phase>(
    client ? { kind: 'loading' } : { kind: 'noLink' },
  );
  const [language, setLanguage] = useState<UploadLinkLanguage | null>(null);
  const [locals, setLocals] = useState<LocalFile[]>([]);
  // Document ids whose PUT finished here: "Received" even while the
  // pipeline has not picked them up yet.
  const [sent, setSent] = useState<Set<string>>(() => new Set());
  const busy = locals.some(
    (f) => f.state === 'checking' || f.state === 'uploading',
  );

  const fail = useCallback((err: unknown) => {
    setPhase(isNotFound(err) ? { kind: 'invalid' } : { kind: 'error' });
  }, []);

  const load = useCallback(async () => {
    if (!client) return;
    try {
      const link = await client.get();
      setPhase({ kind: 'ready', link });
      setLanguage((l) => l ?? link.language);
    } catch (err) {
      fail(err);
    }
  }, [client, fail]);

  useEffect(() => {
    void load();
  }, [load]);

  const lang: UploadLinkLanguage =
    language ?? (phase.kind === 'ready' ? phase.link.language : 'en');
  const t: T = useCallback((key, vars) => pageText(lang, key, vars), [lang]);

  const consent = useCallback(async (): Promise<'ok' | 'reload' | 'failed'> => {
    if (!client) return 'failed';
    try {
      await client.consent(lang, CONSENT_VERSION);
      await load();
      return 'ok';
    } catch (err) {
      if (isNotFound(err)) fail(err);
      if (err instanceof ApiError && err.status === 409) return 'reload';
      return 'failed';
    }
  }, [client, lang, load, fail]);

  const patch = (key: string, change: Partial<LocalFile>) =>
    setLocals((all) =>
      all.map((f) => (f.key === key ? { ...f, ...change } : f)),
    );

  const addFiles = useCallback(
    async (files: File[]) => {
      if (!client || phase.kind !== 'ready') return;
      const { link } = phase;
      let slots = Math.max(link.max_files - link.file_count, 0);
      const batch = files.map((file, i) => ({
        file,
        key: `${Date.now()}-${i}-${file.name}`,
      }));
      setLocals((all) => [
        ...all,
        ...batch.map(
          ({ file, key }): LocalFile => ({
            key,
            name: file.name,
            state: 'checking',
            progress: 0,
          }),
        ),
      ]);
      // One at a time: phones on slow networks do better than in parallel.
      for (const { file, key } of batch) {
        const rejection = rejectFile(file, link.max_file_bytes);
        if (rejection || slots <= 0) {
          patch(key, {
            state: 'rejected',
            reason: rejection
              ? rejection === 'type'
                ? 'rejectType'
                : 'rejectSize'
              : 'rejectCount',
          });
          continue;
        }
        const contentType = customerContentType(file) as string;
        let documentId: string;
        let uploadUrl: string;
        try {
          const encrypted = isPdf(file) && (await isEncryptedPdf(file));
          const ticket = await client.createFile({
            file_name: file.name,
            content_type: contentType,
            file_size: file.size,
            encrypted,
          });
          documentId = ticket.document_id;
          uploadUrl = ticket.upload_url;
          slots -= 1;
        } catch (err) {
          if (isNotFound(err)) {
            fail(err);
            return;
          }
          const full = err instanceof ApiError && err.status === 409;
          if (full) slots = 0;
          patch(key, {
            state: 'rejected',
            reason: full ? 'rejectCount' : 'rejectServer',
          });
          continue;
        }
        patch(key, { state: 'uploading', progress: 0 });
        try {
          await putWithProgress(uploadUrl, file, contentType, (progress) =>
            patch(key, { progress }),
          );
          setSent((s) => new Set(s).add(documentId));
          setLocals((all) => all.filter((f) => f.key !== key));
        } catch {
          patch(key, { state: 'failed' });
        }
      }
      await load();
    },
    [client, phase, load, fail],
  );

  const unlock = useCallback(
    async (documentId: string, password: string): Promise<UnlockState> => {
      if (!client) return { kind: 'failed' };
      try {
        const result = await client.unlock(documentId, password);
        if (result.status === 'unlocked') {
          setSent((s) => new Set(s).add(documentId));
          await load();
          return { kind: 'unlocked' };
        }
        return { kind: 'wrong', left: result.attemptsLeft };
      } catch (err) {
        if (isNotFound(err)) {
          // The link closed (load then shows it) or the file went away.
          await load();
          return { kind: 'failed' };
        }
        if (err instanceof ApiError && err.status === 429) {
          return { kind: 'tooMany' };
        }
        return { kind: 'failed' };
      }
    },
    [client, load],
  );

  const submit = useCallback(async (): Promise<boolean> => {
    if (!client || phase.kind !== 'ready') return false;
    try {
      const count = await client.submit();
      setPhase({ kind: 'submitted', count, dsa: phase.link.dsa_name });
      return true;
    } catch (err) {
      if (isNotFound(err)) fail(err);
      return false;
    }
  }, [client, phase, fail]);

  return (
    <PageShell
      t={t}
      language={lang}
      onLanguage={phase.kind === 'loading' ? undefined : setLanguage}
    >
      {phase.kind === 'loading' && <LoadingView t={t} />}
      {phase.kind === 'noLink' && <NoLinkView t={t} />}
      {phase.kind === 'invalid' && <InvalidView t={t} />}
      {phase.kind === 'error' && (
        <ErrorView
          t={t}
          onRetry={() => {
            setPhase({ kind: 'loading' });
            void load();
          }}
        />
      )}
      {phase.kind === 'submitted' && (
        <SubmittedView t={t} count={phase.count} dsa={phase.dsa} />
      )}
      {phase.kind === 'ready' && (
        <>
          <RequestSummary t={t} link={phase.link} language={lang} />
          {phase.link.consented ? (
            <UploadView
              t={t}
              link={phase.link}
              locals={locals}
              sent={sent}
              busy={busy}
              onFiles={addFiles}
              onUnlock={unlock}
              onSubmit={submit}
            />
          ) : (
            <ConsentView t={t} dsa={phase.link.dsa_name} onAgree={consent} />
          )}
        </>
      )}
    </PageShell>
  );
}

const CARD =
  'rounded-2xl border border-black/10 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-slate-900';
const PRIMARY =
  'w-full rounded-xl bg-blue-600 px-4 py-3 text-base font-semibold text-white hover:bg-blue-700 disabled:opacity-50';

export function PageShell({
  t,
  language,
  onLanguage,
  children,
}: {
  t: T;
  language: UploadLinkLanguage;
  onLanguage?: (l: UploadLinkLanguage) => void;
  children: React.ReactNode;
}) {
  const selectId = useId();
  return (
    <div
      lang={language}
      className="min-h-screen bg-slate-50 text-slate-800 dark:bg-slate-950 dark:text-slate-100"
    >
      <main className="mx-auto w-full max-w-md space-y-4 px-4 py-6">
        <header className="flex items-center justify-between gap-3">
          <h1 className="flex items-center gap-2 text-lg font-bold">
            <ShieldCheck className="h-5 w-5 text-blue-600" aria-hidden="true" />
            {t('title')}
          </h1>
          {onLanguage && (
            <>
              <label htmlFor={selectId} className="sr-only">
                Language / भाषा
              </label>
              <select
                id={selectId}
                value={language}
                onChange={(e) =>
                  onLanguage(e.target.value as UploadLinkLanguage)
                }
                className="rounded-lg border border-black/10 bg-white px-2 py-1.5 text-sm dark:border-white/10 dark:bg-slate-900"
              >
                {(Object.keys(PAGE_LANGUAGE_NAMES) as UploadLinkLanguage[]).map(
                  (l) => (
                    <option key={l} value={l}>
                      {PAGE_LANGUAGE_NAMES[l]}
                    </option>
                  ),
                )}
              </select>
            </>
          )}
        </header>
        {children}
      </main>
    </div>
  );
}

export function LoadingView({ t }: { t: T }) {
  return (
    <p role="status" className={`${CARD} flex items-center gap-2 text-sm`}>
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      {t('loading')}
    </p>
  );
}

export function NoLinkView({ t }: { t: T }) {
  return (
    <section className={CARD} role="alert">
      <h2 className="mb-1 flex items-center gap-2 font-semibold">
        <XCircle className="h-5 w-5 text-amber-600" aria-hidden="true" />
        {t('reopenTitle')}
      </h2>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        {t('reopenBody')}
      </p>
    </section>
  );
}

export function InvalidView({ t }: { t: T }) {
  return (
    <section className={CARD} role="alert">
      <h2 className="mb-1 flex items-center gap-2 font-semibold">
        <XCircle className="h-5 w-5 text-red-600" aria-hidden="true" />
        {t('invalidTitle')}
      </h2>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        {t('invalidBody')}
      </p>
    </section>
  );
}

export function ErrorView({ t, onRetry }: { t: T; onRetry: () => void }) {
  return (
    <section className={`${CARD} space-y-3`} role="alert">
      <p className="text-sm">{t('errorBody')}</p>
      <button type="button" className={PRIMARY} onClick={onRetry}>
        {t('retry')}
      </button>
    </section>
  );
}

export function SubmittedView({
  t,
  count,
  dsa,
}: {
  t: T;
  count: number;
  dsa: string;
}) {
  return (
    <section className={`${CARD} text-center`} role="status">
      <CheckCircle2
        className="mx-auto mb-2 h-10 w-10 text-green-600"
        aria-hidden="true"
      />
      <h2 className="text-lg font-semibold">{t('submittedTitle')}</h2>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        {t('submittedBody', { count, dsa })}
      </p>
    </section>
  );
}

export function RequestSummary({
  t,
  link,
  language,
}: {
  t: T;
  link: PublicLink;
  language: UploadLinkLanguage;
}) {
  return (
    <section className={CARD} aria-label={t('requestedList')}>
      <p className="text-sm font-medium">
        {t('requestedBy', { dsa: link.dsa_name })}
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
        {link.items.map((item, i) => (
          <li key={`${item.code}-${i}`}>
            {requestedItemLabel(item, language)}
          </li>
        ))}
      </ul>
      {link.expires_at && (
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          {t('validTill', {
            date: formatLinkExpiry(link.expires_at, language),
          })}
        </p>
      )}
    </section>
  );
}

export function ConsentView({
  t,
  dsa,
  onAgree,
}: {
  t: T;
  dsa: string;
  onAgree: () => Promise<'ok' | 'reload' | 'failed'>;
}) {
  const checkId = useId();
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<keyof CustomerPageText | null>(null);

  const agree = async (e: FormEvent) => {
    e.preventDefault();
    if (!checked || saving) return;
    setSaving(true);
    setError(null);
    const result = await onAgree();
    setSaving(false);
    if (result === 'reload') setError('consentReload');
    else if (result === 'failed') setError('errorBody');
  };

  return (
    <form className={`${CARD} space-y-3`} onSubmit={agree}>
      <h2 className="font-semibold">{t('consentTitle')}</h2>
      <ul className="space-y-2 text-sm text-slate-700 dark:text-slate-200">
        <li>{t('consentPurpose', { dsa })}</li>
        <li>{t('consentWho', { dsa })}</li>
        <li>{t('consentDeletion')}</li>
        <li>{t('consentWithdraw', { dsa })}</li>
      </ul>
      <div className="flex items-start gap-3 rounded-xl bg-slate-50 p-3 dark:bg-white/5">
        <input
          id={checkId}
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          className="mt-1 h-5 w-5 shrink-0"
        />
        <label htmlFor={checkId} className="text-sm">
          {t('consentCheckbox', { dsa })}
        </label>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t(error)}
        </p>
      )}
      <button type="submit" className={PRIMARY} disabled={!checked || saving}>
        {saving ? (
          <Loader2
            className="mx-auto h-5 w-5 animate-spin"
            aria-hidden="true"
          />
        ) : (
          t('consentContinue')
        )}
      </button>
    </form>
  );
}

export type UnlockState =
  | { kind: 'unlocked' }
  | { kind: 'wrong'; left: number }
  | { kind: 'tooMany' }
  | { kind: 'failed' };

export function UploadView({
  t,
  link,
  locals,
  sent,
  busy,
  onFiles,
  onUnlock,
  onSubmit,
}: {
  t: T;
  link: PublicLink;
  locals: LocalFile[];
  sent: Set<string>;
  busy: boolean;
  onFiles: (files: File[]) => void;
  onUnlock: (documentId: string, password: string) => Promise<UnlockState>;
  onSubmit: () => Promise<boolean>;
}) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);
  const left = Math.max(link.max_files - link.file_count, 0);
  const locked = link.files.some(needsPassword);
  const received = link.files.length > 0;

  const picked = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    // Clear it, so the same file can be picked again after a failure.
    e.target.value = '';
    if (files.length) onFiles(files);
  };

  const submit = async () => {
    setSubmitting(true);
    setSubmitFailed(false);
    const ok = await onSubmit();
    setSubmitting(false);
    if (!ok) setSubmitFailed(true);
  };

  return (
    <>
      <section className={`${CARD} space-y-3`}>
        <h2 className="font-semibold">{t('uploadTitle')}</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t('limits', {
            mb: Math.round(link.max_file_bytes / MB),
            max: link.max_files,
          })}
        </p>
        {/* Camera: phones open the rear camera; desktops show a file picker. */}
        <input
          ref={cameraRef}
          type="file"
          accept="image/*,application/pdf"
          capture="environment"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={picked}
          data-testid="camera-input"
        />
        <input
          ref={filesRef}
          type="file"
          accept="image/*,application/pdf"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={picked}
          data-testid="files-input"
        />
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className="flex flex-col items-center gap-1 rounded-xl border border-blue-600/30 bg-blue-50 px-3 py-4 text-sm font-semibold text-blue-700 disabled:opacity-50 dark:bg-blue-500/10 dark:text-blue-300"
            onClick={() => cameraRef.current?.click()}
            disabled={left === 0 || submitting}
          >
            <Camera className="h-6 w-6" aria-hidden="true" />
            {t('takePhoto')}
          </button>
          <button
            type="button"
            className="flex flex-col items-center gap-1 rounded-xl border border-blue-600/30 bg-blue-50 px-3 py-4 text-sm font-semibold text-blue-700 disabled:opacity-50 dark:bg-blue-500/10 dark:text-blue-300"
            onClick={() => filesRef.current?.click()}
            disabled={left === 0 || submitting}
          >
            <FileUp className="h-6 w-6" aria-hidden="true" />
            {t('chooseFiles')}
          </button>
        </div>
        <p
          className="text-xs text-slate-500 dark:text-slate-400"
          aria-live="polite"
        >
          {left > 0 ? t('filesLeft', { count: left }) : t('noSlotsLeft')}
        </p>
        <ul className="space-y-2" aria-live="polite">
          {locals.map((f) => (
            <LocalFileRow
              key={f.key}
              t={t}
              file={f}
              maxMb={Math.round(link.max_file_bytes / MB)}
            />
          ))}
          {link.files.map((f) => (
            <ServerFileRow
              key={f.document_id}
              t={t}
              file={f}
              sent={sent.has(f.document_id)}
              onUnlock={onUnlock}
            />
          ))}
        </ul>
      </section>
      <section className={`${CARD} space-y-2`}>
        {locked && (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            {t('submitPasswordWarning')}
          </p>
        )}
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t('submitHint')}
        </p>
        {submitFailed && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {t('submitFailed')}
          </p>
        )}
        <button
          type="button"
          className={PRIMARY}
          onClick={submit}
          disabled={!received || busy || submitting}
        >
          {submitting ? t('submitting') : t('submit')}
        </button>
      </section>
    </>
  );
}

function FileName({ name }: { name: string }) {
  return <span className="min-w-0 flex-1 truncate text-sm">{name}</span>;
}

export function LocalFileRow({
  t,
  file,
  maxMb,
}: {
  t: T;
  file: LocalFile;
  maxMb: number;
}) {
  const bad = file.state === 'failed' || file.state === 'rejected';
  return (
    <li className="rounded-xl border border-black/10 p-3 dark:border-white/10">
      <div className="flex items-center gap-2">
        {bad ? (
          <XCircle
            className="h-4 w-4 shrink-0 text-red-600"
            aria-hidden="true"
          />
        ) : (
          <Loader2
            className="h-4 w-4 shrink-0 animate-spin"
            aria-hidden="true"
          />
        )}
        <FileName name={file.name} />
      </div>
      {file.state === 'uploading' && (
        <>
          <progress
            className="mt-2 h-2 w-full"
            max={100}
            value={file.progress}
            aria-label={file.name}
          />
          <p className="text-xs">
            {t('statusUploading', { percent: file.progress })}
          </p>
        </>
      )}
      {file.state === 'checking' && (
        <p className="mt-1 text-xs">{t('statusChecking')}</p>
      )}
      {bad && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">
          {file.state === 'failed'
            ? t('statusFailed')
            : t(file.reason ?? 'rejectServer', { mb: maxMb })}
        </p>
      )}
    </li>
  );
}

export function ServerFileRow({
  t,
  file,
  sent,
  onUnlock,
}: {
  t: T;
  file: PublicFile;
  sent: boolean;
  onUnlock: (documentId: string, password: string) => Promise<UnlockState>;
}) {
  const locked = needsPassword(file);
  // "uploading" is the record before its file arrived: a PUT that failed
  // in an earlier visit, unless it finished on this page.
  const missing = !locked && file.status === 'uploading' && !sent;
  return (
    <li className="rounded-xl border border-black/10 p-3 dark:border-white/10">
      <div className="flex items-center gap-2">
        {locked ? (
          <Lock
            className="h-4 w-4 shrink-0 text-amber-600"
            aria-hidden="true"
          />
        ) : missing ? (
          <XCircle
            className="h-4 w-4 shrink-0 text-red-600"
            aria-hidden="true"
          />
        ) : (
          <CheckCircle2
            className="h-4 w-4 shrink-0 text-green-600"
            aria-hidden="true"
          />
        )}
        <FileName name={file.file_name} />
        <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
          {locked
            ? t('statusPassword')
            : missing
              ? t('statusNotReceived')
              : t('statusReceived')}
        </span>
      </div>
      {locked && (
        <PasswordForm t={t} documentId={file.document_id} onUnlock={onUnlock} />
      )}
    </li>
  );
}

export function PasswordForm({
  t,
  documentId,
  onUnlock,
}: {
  t: T;
  documentId: string;
  onUnlock: (documentId: string, password: string) => Promise<UnlockState>;
}) {
  const inputId = useId();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<UnlockState | null>(null);
  const blocked = outcome?.kind === 'tooMany';

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy || blocked) return;
    const value = password;
    // The password stays only in this call: the field is cleared at once.
    setPassword('');
    setBusy(true);
    setOutcome(await onUnlock(documentId, value));
    setBusy(false);
  };

  return (
    <form className="mt-2 space-y-2" onSubmit={send}>
      <p className="text-xs text-slate-600 dark:text-slate-300">
        {t('passwordHint')}
      </p>
      <label htmlFor={inputId} className="block text-xs font-semibold">
        {t('passwordLabel')}
      </label>
      <div className="flex gap-2">
        <input
          id={inputId}
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={128}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy || blocked}
          className="min-w-0 flex-1 rounded-lg border border-black/10 px-3 py-2 text-base dark:border-white/10 dark:bg-white/5"
        />
        <button
          type="submit"
          disabled={!password || busy || blocked}
          className="shrink-0 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {busy ? t('unlocking') : t('unlock')}
        </button>
      </div>
      {outcome && outcome.kind !== 'unlocked' && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {outcome.kind === 'wrong'
            ? t('wrongPassword', { left: outcome.left })
            : outcome.kind === 'tooMany'
              ? t('tooManyAttempts')
              : t('unlockFailed')}
        </p>
      )}
    </form>
  );
}
