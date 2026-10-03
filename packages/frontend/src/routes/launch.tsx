import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useAwsClient } from '../hooks/useAwsClient';
import {
  describeLaunchError,
  takeLaunchParams,
  type CrmLaunchOpenResult,
} from '../lib/crmLaunch';

/**
 * The page the Smart Dial CRM opens (docs/crm-launch-link.md):
 * /launch#lead=..&exp=..&sig=.. with the parameters in the fragment, which no
 * server sees. The user is already signed in here (CognitoAuth comes back to
 * this URL after the sign-in). The backend checks the signature, the expiry
 * and that the link was not used before, then returns the lead's project
 * (made if needed).
 */
export const Route = createFileRoute('/launch')({
  component: LaunchPage,
});

export function LaunchView({
  error,
  message,
}: {
  error: unknown;
  message: string | null;
}) {
  const { t } = useTranslation();
  if (error == null) {
    return (
      <div
        className="flex items-center justify-center gap-2 py-24 text-sm text-[var(--color-text-muted)]"
        role="status"
        data-testid="launch-opening"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        {t('crmLaunch.opening')}
      </div>
    );
  }
  return (
    <div
      className="mx-auto mt-16 max-w-lg space-y-3 rounded-xl border border-red-200 bg-red-50 p-5 dark:border-red-800/50 dark:bg-red-900/20"
      role="alert"
      data-testid="launch-error"
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-300">
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        {t('crmLaunch.failed')}
      </p>
      <p className="text-sm text-red-700 dark:text-red-300">{message}</p>
      <Link to="/" className="text-sm font-medium text-[var(--color-accent)]">
        {t('crmLaunch.goHome')}
      </Link>
    </div>
  );
}

function LaunchPage() {
  const { t } = useTranslation();
  const { fetchApi } = useAwsClient();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  // A link works once: never send it twice (StrictMode runs effects twice).
  const sentRef = useRef(false);

  useEffect(() => {
    if (sentRef.current) return;
    sentRef.current = true;
    // Read once, then out of the address bar (the name and phone with it).
    const link = takeLaunchParams();
    if ('problem' in link) {
      setError(new Error(t(`crmLaunch.errors.${link.problem}`)));
      return;
    }
    fetchApi<CrmLaunchOpenResult>('crm-launch/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: link.params }),
    })
      .then((result) =>
        // replace: the used link (with its signature) leaves the history
        navigate({
          to: '/projects/$projectId',
          params: { projectId: result.project_id },
          replace: true,
        }),
      )
      .catch((e) => setError(e ?? new Error('failed')));
  }, [fetchApi, navigate, t]);

  return (
    <LaunchView
      error={error}
      message={error == null ? null : describeLaunchError(t, error)}
    />
  );
}
