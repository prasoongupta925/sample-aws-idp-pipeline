import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Link2,
} from 'lucide-react';
import { copyText, type CopyOutcome } from '../lib/clipboard';
import {
  describeLaunchError,
  parseCrmLaunchSettings,
  type CrmLaunchSettings as Settings,
} from '../lib/crmLaunch';

const SECTION_CLASS =
  'space-y-3 rounded-xl border border-black/[0.08] bg-white/30 p-4 dark:border-white/[0.08] dark:bg-white/[0.03]';
const BUTTON_CLASS =
  'inline-flex items-center gap-1.5 rounded-lg border border-black/10 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-white/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:text-slate-200 dark:hover:bg-white/10';
const PRIMARY_CLASS =
  'inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50';

function formatAt(iso: string | null): string {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
    : (iso ?? '–');
}

export interface CrmLaunchSecretPanelProps {
  settings: Settings;
  secret: string | null;
  busy: boolean;
  confirming: boolean;
  error: unknown;
  onGenerate: () => void;
  onAskConfirm: () => void;
  onCancelConfirm: () => void;
  onDismissSecret: () => void;
}

/** Status of the launch secret, the rotate flow and the new secret (shown once). */
export function CrmLaunchSecretPanel({
  settings,
  secret,
  busy,
  confirming,
  error,
  onGenerate,
  onAskConfirm,
  onCancelConfirm,
  onDismissSecret,
}: CrmLaunchSecretPanelProps) {
  const { t } = useTranslation();
  const secretId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [copy, setCopy] = useState<CopyOutcome | null>(null);

  useEffect(() => {
    setCopy(null);
    if (secret) inputRef.current?.focus();
  }, [secret]);

  return (
    <div className={SECTION_CLASS} data-testid="crm-launch-secret">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound
          className="h-4 w-4 text-slate-500 dark:text-slate-400"
          aria-hidden="true"
        />
        <h4 className="text-sm font-medium text-slate-700 dark:text-slate-200">
          {t('crmLaunch.settings.secretTitle')}
        </h4>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            settings.secret_set
              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
              : 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300'
          }`}
        >
          {settings.secret_set
            ? t('crmLaunch.settings.set')
            : t('crmLaunch.settings.notSet')}
        </span>
      </div>
      {settings.secret_set && settings.rotated_at && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t('crmLaunch.settings.rotatedAt', {
            at: formatAt(settings.rotated_at),
            by: settings.rotated_by ?? '–',
          })}
        </p>
      )}

      {secret ? (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700/50 dark:bg-amber-900/20"
        >
          <p className="flex items-start gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            {t('crmLaunch.settings.once')}
          </p>
          <label htmlFor={secretId} className="sr-only">
            {t('crmLaunch.settings.secretTitle')}
          </label>
          <div className="flex gap-2">
            <input
              id={secretId}
              ref={inputRef}
              readOnly
              value={secret}
              onFocus={(e) => e.currentTarget.select()}
              spellCheck={false}
              autoComplete="off"
              className="bento-form-input min-w-0 flex-1 font-mono text-xs"
            />
            <button
              type="button"
              onClick={async () =>
                setCopy(await copyText(secret, inputRef.current))
              }
              className={PRIMARY_CLASS}
            >
              {copy === 'copied' ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copy === 'copied' ? t('common.copied') : t('common.copy')}
            </button>
          </div>
          {copy === 'manual' && (
            <p className="text-xs text-amber-800 dark:text-amber-300">
              {t('crmLaunch.settings.copyManual')}
            </p>
          )}
          <button
            type="button"
            onClick={onDismissSecret}
            className={BUTTON_CLASS}
          >
            {t('crmLaunch.settings.done')}
          </button>
        </div>
      ) : confirming ? (
        <div
          role="alertdialog"
          aria-label={t('crmLaunch.settings.rotate')}
          className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700/50 dark:bg-amber-900/20 dark:text-amber-200"
        >
          <p>{t('crmLaunch.settings.confirmRotate')}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onGenerate}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-1 disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('crmLaunch.settings.rotate')}
            </button>
            <button
              type="button"
              onClick={onCancelConfirm}
              disabled={busy}
              className={BUTTON_CLASS}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={settings.secret_set ? onAskConfirm : onGenerate}
          disabled={busy}
          className={BUTTON_CLASS}
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {settings.secret_set
            ? t('crmLaunch.settings.rotate')
            : t('crmLaunch.settings.generate')}
        </button>
      )}

      {error != null && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {t('crmLaunch.settings.rotateFailed', {
            message: describeLaunchError(t, error),
          })}
        </p>
      )}
    </div>
  );
}

interface CrmLaunchSettingsProps {
  fetchApi: <T>(url: string, init?: RequestInit) => Promise<T>;
}

/** Settings → Integrations (admins): the CRM launch link secret. */
export default function CrmLaunchSettings({
  fetchApi,
}: CrmLaunchSettingsProps) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      setSettings(
        parseCrmLaunchSettings(await fetchApi('integrations/crm-launch')),
      );
    } catch (e) {
      setLoadError(e);
    }
  }, [fetchApi]);

  useEffect(() => {
    void load();
  }, [load]);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await fetchApi<{ secret: string }>(
        'integrations/crm-launch/secret',
        { method: 'POST' },
      );
      setSecret(result.secret);
      setConfirming(false);
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const minutes = Math.round((settings?.max_lifetime_s ?? 300) / 60);

  return (
    <div className="space-y-4" data-testid="crm-launch-settings">
      <div className="flex items-center gap-2">
        <Link2 className="h-4 w-4 text-[var(--color-accent)]" />
        <h3
          className="text-base font-semibold"
          style={{ color: 'var(--color-text-primary)' }}
        >
          {t('crmLaunch.settings.title')}
        </h3>
      </div>
      <p className="text-sm text-[var(--color-text-muted)]">
        {t('crmLaunch.settings.intro', { minutes })}
      </p>
      {loadError != null && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t('crmLaunch.settings.loadFailed', {
            message: describeLaunchError(t, loadError),
          })}
        </p>
      )}
      {settings && (
        <CrmLaunchSecretPanel
          settings={settings}
          secret={secret}
          busy={busy}
          confirming={confirming}
          error={error}
          onGenerate={generate}
          onAskConfirm={() => setConfirming(true)}
          onCancelConfirm={() => setConfirming(false)}
          onDismissSecret={() => setSecret(null)}
        />
      )}
    </div>
  );
}
