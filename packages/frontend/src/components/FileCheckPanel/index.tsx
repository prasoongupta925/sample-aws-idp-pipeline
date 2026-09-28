import { useEffect, useId, useMemo, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  ClipboardCheck,
  Download,
  Loader2,
  Play,
  RefreshCw,
  X,
} from 'lucide-react';
import type { FileCheckState } from '../../hooks/useFileCheck';
import {
  apiErrorStatus,
  buildFileCheckCsv,
  downloadTextFile,
  fileCheckCsvFileName,
  fileCheckFindings,
} from '../../lib/fileCheck';
import VerdictCard from './VerdictCard';

const CONTROL_CLASS =
  'w-full px-2.5 py-1.5 text-xs border border-black/10 dark:border-[#3b4264] rounded-lg bg-white/40 dark:bg-[#0d1117] text-[#0f172a] dark:text-[#f1f5f9] placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent disabled:opacity-60';

// Status codes of packages/backend/app/routers/file_check.py.
function describeError(t: TFunction, error: unknown): string {
  const status = apiErrorStatus(error);
  if (status === 400) return t('fileCheck.errors.unknownChecklist');
  if (status === 404) return t('fileCheck.errors.notFound');
  if (status === 503) return t('fileCheck.errors.notConfigured');
  if (status === 502 || status === 504) {
    return t('fileCheck.errors.unavailable', { status });
  }
  if (status !== null && status >= 400 && status < 500) {
    return t('fileCheck.errors.rejected', { status });
  }
  return error instanceof Error ? error.message : String(error);
}

interface FileCheckPanelProps {
  state: FileCheckState;
  onClose: () => void;
}

/** Overlays the right-hand side panel, like the artifact viewer. */
export default function FileCheckPanel({
  state,
  onClose,
}: FileCheckPanelProps) {
  const { t } = useTranslation();
  const checklistFieldId = useId();
  const applicantFieldId = useId();
  const {
    checklists,
    checklistsLoaded,
    checklistsLoading,
    checklistsError,
    loadChecklists,
    checklistId,
    setChecklistId,
    applicant,
    setApplicant,
    knownApplicants,
    result,
    resultApplicant,
    lastRunAt,
    running,
    error,
    runCheck,
  } = state;

  useEffect(() => {
    if (!checklistsLoaded && !checklistsLoading && !checklistsError) {
      loadChecklists();
    }
  }, [checklistsLoaded, checklistsLoading, checklistsError, loadChecklists]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const selected = checklists.find((c) => c.id === checklistId);
  const findings = useMemo(
    () => (result ? fileCheckFindings(result) : []),
    [result],
  );
  const resultChecklistId = result?.checklist?.id;
  const stale =
    !!result &&
    !!resultChecklistId &&
    !!checklistId &&
    resultChecklistId !== checklistId;
  const showApplicantSelect =
    knownApplicants.length > 1 &&
    (!applicant || knownApplicants.includes(applicant));

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!running) runCheck();
  };

  const handleDownload = () => {
    if (!result) return;
    downloadTextFile(
      fileCheckCsvFileName(result, resultApplicant),
      buildFileCheckCsv(result),
    );
  };

  return (
    <div
      className="artifact-viewer-container absolute inset-0 z-10 flex flex-col border border-white/60 dark:border-indigo-500/20 rounded-xl overflow-hidden animate-fade-in"
      role="region"
      aria-label={t('fileCheck.title')}
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-black/[0.08] dark:border-white/[0.08] bg-transparent dark:bg-white/[0.05] flex-shrink-0">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex-shrink-0">
          <ClipboardCheck className="w-4 h-4 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200 truncate">
            {t('fileCheck.title')}
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
            {t('fileCheck.subtitle')}
          </p>
        </div>
        <button
          type="button"
          onClick={handleDownload}
          disabled={!result || findings.length === 0}
          className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:text-slate-800 dark:text-slate-300 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/10 transition-colors disabled:opacity-40 disabled:pointer-events-none flex-shrink-0"
          title={t('fileCheck.downloadCsv')}
        >
          <Download className="w-4 h-4" />
          <span className="hidden sm:inline">CSV</span>
        </button>
        <button
          type="button"
          onClick={onClose}
          className="p-2 rounded-lg text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors flex-shrink-0"
          title={t('common.close', 'Close')}
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Controls */}
      <form
        onSubmit={handleSubmit}
        className="px-4 py-3 space-y-2.5 border-b border-black/[0.08] dark:border-white/[0.08] flex-shrink-0"
      >
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <label
              htmlFor={checklistFieldId}
              className="text-[11px] font-semibold text-slate-600 dark:text-slate-300"
            >
              {t('fileCheck.checklist')}
            </label>
            {checklistsLoading && (
              <Loader2 className="h-3 w-3 animate-spin text-slate-400" />
            )}
          </div>
          <select
            id={checklistFieldId}
            value={checklistId}
            onChange={(e) => setChecklistId(e.target.value)}
            disabled={checklists.length === 0 || running}
            className={CONTROL_CLASS}
          >
            {checklists.length === 0 && (
              <option value="">
                {checklistsLoading
                  ? t('fileCheck.loadingChecklists')
                  : t('fileCheck.defaultChecklist')}
              </option>
            )}
            {checklists.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {selected?.description && (
            <p className="text-[10px] leading-snug text-slate-500 dark:text-slate-400">
              {selected.description}
            </p>
          )}
          {checklistsError != null && (
            <div className="flex items-start gap-2 text-[11px] text-red-600 dark:text-red-400">
              <span className="flex-1 break-words">
                {t('fileCheck.checklistsFailed', {
                  message: describeError(t, checklistsError),
                })}
              </span>
              <button
                type="button"
                onClick={() => loadChecklists()}
                className="flex items-center gap-1 flex-shrink-0 font-medium hover:underline"
              >
                <RefreshCw className="h-3 w-3" />
                {t('fileCheck.retry')}
              </button>
            </div>
          )}
        </div>

        <div className="space-y-1">
          <label
            htmlFor={applicantFieldId}
            className="text-[11px] font-semibold text-slate-600 dark:text-slate-300"
          >
            {t('fileCheck.applicant')}{' '}
            <span className="font-normal text-slate-400">
              {t('fileCheck.applicantOptional')}
            </span>
          </label>
          {showApplicantSelect ? (
            <select
              id={applicantFieldId}
              value={applicant}
              onChange={(e) => setApplicant(e.target.value)}
              disabled={running}
              className={CONTROL_CLASS}
            >
              <option value="">{t('fileCheck.allApplicants')}</option>
              {knownApplicants.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={applicantFieldId}
              type="text"
              value={applicant}
              onChange={(e) => setApplicant(e.target.value)}
              disabled={running}
              placeholder={t('fileCheck.applicantPlaceholder')}
              maxLength={200}
              autoComplete="off"
              className={CONTROL_CLASS}
            />
          )}
        </div>

        <button
          type="submit"
          disabled={running}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500 shadow-sm transition-colors disabled:opacity-70 disabled:cursor-wait"
        >
          {running ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Play className="h-4 w-4" />
          )}
          {running ? t('fileCheck.running') : t('fileCheck.run')}
        </button>
      </form>

      {/* Result */}
      <div className="flex-1 overflow-y-auto min-h-0 px-4 py-3 space-y-3">
        {error != null && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-300"
          >
            <p className="font-semibold">{t('fileCheck.runFailed')}</p>
            <p className="mt-0.5 break-words">{describeError(t, error)}</p>
          </div>
        )}

        {stale && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-300">
            {t('fileCheck.staleResult', {
              name: result?.checklist?.name || resultChecklistId,
            })}
          </p>
        )}

        {result ? (
          <div
            className={running ? 'opacity-60 transition-opacity' : undefined}
            aria-busy={running}
          >
            <VerdictCard result={result} lastRunAt={lastRunAt} />
          </div>
        ) : running ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-xs text-slate-500">
            <Loader2 className="h-6 w-6 animate-spin text-emerald-500" />
            {t('fileCheck.running')}
          </div>
        ) : (
          error == null && (
            <div className="flex flex-col items-center justify-center text-center gap-2 py-10 px-4">
              <ClipboardCheck className="h-8 w-8 text-slate-300 dark:text-slate-500" />
              <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
                {t('fileCheck.emptyTitle')}
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {t('fileCheck.emptyHint')}
              </p>
            </div>
          )
        )}
      </div>

      {/* Footer */}
      <p className="px-4 py-2 border-t border-black/[0.08] dark:border-white/[0.08] text-[10px] leading-snug text-slate-500 dark:text-slate-400 flex-shrink-0">
        {t('fileCheck.syntheticNote')}
      </p>
    </div>
  );
}
