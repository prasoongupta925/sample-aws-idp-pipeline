import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  CircleCheck,
  CloudDownload,
  FlaskConical,
  Info,
  Loader2,
  TriangleAlert,
} from 'lucide-react';
import type { EligibilityInputs } from '../../types/eligibility';
import { useAwsClient } from '../../hooks/useAwsClient';
import { apiErrorDetail } from '../../lib/apiError';
import { apiErrorStatus, maskPan } from '../../lib/fileCheck';
import {
  CONSENT_METHODS,
  NO_CONSENT,
  applyBureauCibil,
  bureauPullBody,
  cibilHasData,
  consentReferenceLooksValid,
  fetchBureauStatus,
  pullBureauReport,
  pullPan,
  type BureauConsent,
  type BureauPull,
  type BureauStatus,
  type ConsentMethod,
} from '../../lib/bureau';
import {
  CONTROL_CLASS,
  LABEL_CLASS,
  PRIMARY_CLASS,
  SECTION_CLASS,
  SectionTitle,
} from './fields';

type Edit = (update: (inputs: EligibilityInputs) => EligibilityInputs) => void;

/** A pull's answer, and when it came. */
export interface BureauResult {
  pull: BureauPull;
  at: Date;
}

// Status codes of packages/backend/app/routers/bureau.py: a localized
// message, then the API's reason when it gives one.
export function describeBureauError(t: TFunction, error: unknown): string {
  const status = apiErrorStatus(error);
  if (status === null) {
    return error instanceof Error ? error.message : String(error);
  }
  const detail = apiErrorDetail(error);
  let message: string;
  if (status === 503) message = t('bureau.errors.notConfigured');
  else if (status === 400 || status === 422) {
    message = t('bureau.errors.invalid');
  } else if (status === 404) message = t('bureau.errors.notFound');
  else if (status === 429) message = t('bureau.errors.tooMany');
  else if (status === 502 || status === 504) {
    message = t('bureau.errors.failed');
  } else message = t('bureau.errors.status', { status });
  return detail ? `${message} (${detail})` : message;
}

interface BureauFetchViewProps {
  /** null while the provider is being checked. */
  status: BureauStatus | null;
  statusError?: unknown;
  applicant: string;
  inputs: EligibilityInputs;
  consent: BureauConsent;
  onConsent: (patch: Partial<BureauConsent>) => void;
  pulling: boolean;
  error?: unknown;
  result?: BureauResult | null;
  onPull: () => void;
  disabled?: boolean;
}

/**
 * The CIBIL tab's "Fetch credit report": the consent, the button (disabled
 * with the reason when no bureau is connected) and the last pull's outcome.
 * No hooks but ids and translations, so tests render each state statically.
 */
export function BureauFetchView({
  status,
  statusError,
  applicant,
  inputs,
  consent,
  onConsent,
  pulling,
  error,
  result,
  onPull,
  disabled,
}: BureauFetchViewProps) {
  const { t } = useTranslation();
  const baseId = useId();
  const reasonId = `${baseId}-reason`;
  const checking = status === null && statusError == null;
  const enabled = status?.enabled === true;
  const pan = pullPan(applicant, inputs);
  const referenceOk = consentReferenceLooksValid(consent.reference);
  const reason = checking
    ? null
    : !enabled
      ? statusError != null
        ? t('bureau.statusFailed', {
            message: describeBureauError(t, statusError),
          })
        : t('bureau.notConnected')
      : pan.problem === 'missing'
        ? t('bureau.needsPan')
        : pan.problem === 'mismatch'
          ? t('bureau.panMismatch')
          : !consent.given
            ? t('bureau.needsConsent')
            : !referenceOk
              ? t('bureau.referenceInvalid')
              : null;
  const canPull = enabled && !reason && !pulling && !disabled;
  const time = result?.at.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <section
      className={SECTION_CLASS}
      aria-label={t('bureau.title')}
      aria-busy={checking || pulling}
      data-testid="bureau-fetch"
      data-provider={status?.provider ?? ''}
    >
      <div className="flex flex-wrap items-center gap-2">
        <SectionTitle>{t('bureau.title')}</SectionTitle>
        {status?.sample && (
          <span
            className="inline-flex items-center gap-0.5 rounded-full border border-amber-300 bg-amber-50 px-1.5 py-px text-[9px] font-semibold text-amber-800 dark:border-amber-700/60 dark:bg-amber-900/30 dark:text-amber-300"
            title={t('bureau.sampleHint')}
            data-testid="bureau-sample"
          >
            <FlaskConical className="h-2.5 w-2.5" aria-hidden="true" />
            {t('bureau.sample')}
          </span>
        )}
      </div>

      {checking ? (
        <p className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          {t('bureau.loading')}
        </p>
      ) : enabled ? (
        <fieldset className="min-w-0 space-y-2" disabled={disabled || pulling}>
          <legend className="sr-only">{t('bureau.consentLegend')}</legend>
          <label className="flex items-start gap-1.5 text-[11px] leading-snug text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              checked={consent.given}
              onChange={(e) => onConsent({ given: e.target.checked })}
              className="mt-0.5 h-3 w-3 flex-shrink-0 rounded accent-indigo-600"
              data-testid="bureau-consent"
            />
            <span>
              {t('bureau.consent')}
              <span className="block text-[10px] text-slate-500 dark:text-slate-400">
                {t('bureau.consentHint')}
              </span>
            </span>
          </label>
          <div className="grid grid-cols-1 gap-2 @md:grid-cols-2">
            <div className="min-w-0 space-y-1">
              <label htmlFor={`${baseId}-method`} className={LABEL_CLASS}>
                {t('bureau.method')}
              </label>
              <select
                id={`${baseId}-method`}
                value={consent.method}
                onChange={(e) =>
                  onConsent({ method: e.target.value as ConsentMethod })
                }
                className={CONTROL_CLASS}
              >
                {CONSENT_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {t(`bureau.methods.${method}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-0 space-y-1">
              <label htmlFor={`${baseId}-reference`} className={LABEL_CLASS}>
                {t('bureau.reference')}
              </label>
              <input
                id={`${baseId}-reference`}
                type="text"
                value={consent.reference}
                onChange={(e) => onConsent({ reference: e.target.value })}
                placeholder={t('bureau.referencePlaceholder')}
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={referenceOk ? undefined : true}
                className={CONTROL_CLASS}
              />
            </div>
          </div>
        </fieldset>
      ) : null}

      {!checking && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onPull}
            disabled={!canPull}
            aria-describedby={reason ? reasonId : undefined}
            className={PRIMARY_CLASS}
            data-testid="bureau-pull"
          >
            {pulling ? (
              <Loader2
                className="h-3.5 w-3.5 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <CloudDownload className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {pulling ? t('bureau.fetching') : t('bureau.fetch')}
          </button>
          {enabled && pan.pan && (
            <span className="text-[10px] text-slate-500 dark:text-slate-400">
              {t('bureau.panUsed', { pan: maskPan(pan.pan) ?? '' })}
            </span>
          )}
        </div>
      )}
      {reason && (
        <p
          id={reasonId}
          className="flex items-start gap-1.5 text-[11px] leading-snug text-slate-600 dark:text-slate-300"
          data-testid="bureau-reason"
        >
          <Info className="mt-0.5 h-3 w-3 flex-shrink-0" aria-hidden="true" />
          {reason}
        </p>
      )}

      {error != null && !pulling && (
        <p
          role="alert"
          className="break-words text-[11px] text-red-600 dark:text-red-400"
          data-testid="bureau-error"
        >
          {describeBureauError(t, error)}
        </p>
      )}
      {result && !pulling && (
        <div
          role="status"
          className={`space-y-1 rounded-lg border px-2.5 py-1.5 text-[11px] leading-snug ${
            result.pull.found
              ? 'border-emerald-200 bg-emerald-50/70 text-emerald-900 dark:border-emerald-800/50 dark:bg-emerald-900/20 dark:text-emerald-200'
              : 'border-amber-200 bg-amber-50/70 text-amber-900 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-200'
          }`}
          data-testid="bureau-result"
          data-found={result.pull.found ? 'true' : 'false'}
        >
          <p className="flex items-start gap-1.5 font-medium">
            {result.pull.found ? (
              <CircleCheck
                className="mt-0.5 h-3 w-3 flex-shrink-0"
                aria-hidden="true"
              />
            ) : (
              <TriangleAlert
                className="mt-0.5 h-3 w-3 flex-shrink-0"
                aria-hidden="true"
              />
            )}
            {result.pull.found
              ? t('bureau.fetched', { time })
              : t('bureau.noRecord', { time })}{' '}
            {t('bureau.consentLogged', {
              id: result.pull.consentId.slice(0, 8),
            })}
          </p>
          {result.pull.notes.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5">
              {result.pull.notes.map((note, i) => (
                <li key={i} className="break-words">
                  {note}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

interface BureauFetchProps {
  projectId: string;
  /** What the API calls the applicant (the PAN when known). */
  applicant: string;
  inputs: EligibilityInputs;
  onEdit: Edit;
  disabled?: boolean;
}

/**
 * Loads the bureau provider, takes the consent and pulls the report; a found
 * report replaces the CIBIL block on screen (saved with the form). Mount it
 * with key={applicant}: the consent is per applicant and per pull.
 */
export default function BureauFetch({
  projectId,
  applicant,
  inputs,
  onEdit,
  disabled,
}: BureauFetchProps) {
  const { t } = useTranslation();
  const { fetchApi } = useAwsClient();
  const [status, setStatus] = useState<BureauStatus | null>(null);
  const [statusError, setStatusError] = useState<unknown>(null);
  const [consent, setConsent] = useState<BureauConsent>(NO_CONSENT);
  const [pulling, setPulling] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<BureauResult | null>(null);
  const live = useRef(true);
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    // Reloaded when the API client changes (token refresh): the last answer
    // stays on screen meanwhile.
    let current = true;
    fetchBureauStatus(fetchApi, projectId).then(
      (s) => {
        if (!current) return;
        setStatus(s);
        setStatusError(null);
      },
      (err) => {
        if (!current) return;
        console.error('Failed to check the credit bureau:', err);
        setStatusError(err);
      },
    );
    return () => {
      current = false;
    };
  }, [fetchApi, projectId]);

  const onConsent = useCallback(
    (patch: Partial<BureauConsent>) => setConsent((c) => ({ ...c, ...patch })),
    [],
  );

  const onPull = async () => {
    if (pulling) return;
    if (
      cibilHasData(inputsRef.current.cibil) &&
      !window.confirm(t('bureau.replaceConfirm'))
    ) {
      return;
    }
    setPulling(true);
    setError(null);
    try {
      const pull = await pullBureauReport(
        fetchApi,
        projectId,
        bureauPullBody(applicant, inputsRef.current, consent),
      );
      const cibil = pull.cibil;
      if (pull.found && cibil) onEdit((i) => applyBureauCibil(i, cibil));
      if (!live.current) return;
      setResult({ pull, at: new Date() });
      // The consent covers this pull only: the next one is consented again.
      setConsent((c) => ({ ...c, given: false, reference: '' }));
    } catch (err) {
      if (!live.current) return;
      console.error('Credit report pull failed:', err);
      setError(err);
    } finally {
      if (live.current) setPulling(false);
    }
  };

  return (
    <BureauFetchView
      status={status}
      statusError={statusError}
      applicant={applicant}
      inputs={inputs}
      consent={consent}
      onConsent={onConsent}
      pulling={pulling}
      error={error}
      result={result}
      onPull={onPull}
      disabled={disabled}
    />
  );
}
