import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleX,
  ClipboardList,
  FileWarning,
  ListChecks,
  Loader2,
  TriangleAlert,
} from 'lucide-react';
import type { StillNeeded } from '../../types/eligibility';
import {
  PRECHECK_FIELD_TAB,
  precheckClear,
  type PrecheckSummary,
} from '../../lib/eligibility';
import { RefusalLine, stillNeededLabel } from './fields';

type Tab = 'profile' | 'cibil' | 'lenders';

/** File-check issues shown before "+N more in File check". */
const SHOWN_ISSUES = 2;
/** Refusal lines shown before "Show all": the groups below stay in view. */
const SHOWN_REFUSALS = 4;

const LINK_CLASS =
  'rounded font-medium text-indigo-700 underline decoration-indigo-300 underline-offset-2 hover:decoration-indigo-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-300';

export interface BeforeYouCheckProps {
  summary: PrecheckSummary;
  /** A background check (or Check eligibility) is on its way. */
  checking: boolean;
  /** The result shown is for other inputs (no check runs for these yet). */
  outdated: boolean;
  /** Why no check runs: a value in red, or nothing a bank checks filled yet. */
  waiting: 'invalid' | 'empty' | null;
  /** The tab shown: fields of the other tabs are named with their tab. */
  tab: Tab;
  /** Moves to a field: a still-needed field ("score", "tradelines.2.emi") or a refusal's. */
  onGo: (tab: 'profile' | 'cibil', field: string) => void;
  /** Opens the File Check panel (its open issues). */
  onOpenFileCheck?: () => void;
}

/**
 * "Before you check": at the top of the Eligibility & lenders panel, on every
 * tab, what would stop a bank before Check eligibility is clicked: the
 * required fields still empty, the banks that will say no (the background
 * check of the inputs on screen), the file check's open issues and what to
 * confirm by hand. One line when nothing is in the way.
 */
export default function BeforeYouCheck({
  summary,
  checking,
  outdated,
  waiting,
  tab,
  onGo,
  onOpenFileCheck,
}: BeforeYouCheckProps) {
  const { t } = useTranslation();
  const detailsId = useId();
  const [open, setOpen] = useState(true);
  const [allRefusals, setAllRefusals] = useState(false);
  const { needed, refusals, fileIssues, warnings, eligible, total } = summary;
  const hasResult = eligible !== null && total !== null;
  // While the next check runs the last answer stays (no flicker on each edit);
  // an answer no check will replace (a value in red) is not "clear".
  const clear = hasResult && (!outdated || checking) && precheckClear(summary);
  const conditionBanks = summary.conditionBanks.join(', ');

  // The first check of the panel: the line itself says so.
  const firstCheck = !clear && needed.length === 0 && !hasResult && checking;
  const line = clear
    ? eligible === total
      ? t('eligibility.precheck.allClearAll', { total })
      : t('eligibility.precheck.allClear', { eligible, total })
    : needed.length > 0
      ? t('eligibility.precheck.fillFirst', { count: needed.length })
      : hasResult
        ? t('eligibility.precheck.canLend', { eligible, total })
        : firstCheck
          ? t('eligibility.precheck.checking')
          : waiting === 'invalid'
            ? t('eligibility.precheck.fixFirst')
            : t('eligibility.precheck.start');
  const status = firstCheck ? null : checking ? (
    <span
      className="inline-flex flex-shrink-0 items-center gap-1 text-[10px] font-normal text-slate-500 dark:text-slate-400"
      data-testid="precheck-checking"
    >
      <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
      {t('eligibility.precheck.checking')}
    </span>
  ) : outdated && waiting === 'invalid' ? (
    <span className="flex-shrink-0 text-[10px] font-normal text-amber-700 dark:text-amber-400">
      {t('eligibility.precheck.notUpdated')}
    </span>
  ) : null;

  if (clear) {
    return (
      <div
        className="flex flex-shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-green-200/70 bg-green-50/70 px-4 py-1.5 text-[11px] text-green-800 dark:border-green-800/40 dark:bg-green-900/15 dark:text-green-300"
        role="region"
        aria-label={t('eligibility.precheck.label')}
        data-testid="before-you-check"
        data-state="clear"
      >
        <CircleCheck className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
        <span className="font-semibold" role="status">
          {line}
        </span>
        {summary.conditions > 0 && (
          <span
            className="text-green-700/80 dark:text-green-300/80"
            title={conditionBanks}
          >
            {t('eligibility.precheck.conditionsShort', {
              count: summary.conditions,
            })}
          </span>
        )}
        {status && <span className="ml-auto">{status}</span>}
      </div>
    );
  }

  const groups =
    needed.length + refusals.length + fileIssues.length + warnings.length > 0;
  // What the banks said for other inputs, no check on its way (a value in
  // red): shown faded. "Still needed" is always the inputs on screen.
  const dimmed = outdated && !checking ? 'opacity-60' : undefined;
  const go = (item: StillNeeded) => onGo(item.tab, item.field);

  return (
    <section
      className="flex-shrink-0 border-b border-amber-200/70 bg-amber-50/50 px-4 py-1.5 text-[11px] leading-snug text-slate-700 dark:border-amber-800/40 dark:bg-amber-900/10 dark:text-slate-200"
      aria-label={t('eligibility.precheck.label')}
      data-testid="before-you-check"
      data-state={groups ? 'open' : 'waiting'}
    >
      <div className="flex items-center gap-2">
        <ClipboardList
          className="h-3.5 w-3.5 flex-shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden="true"
        />
        <p className="min-w-0 flex-1">
          <span className="font-semibold text-slate-800 dark:text-slate-100">
            {t('eligibility.precheck.title')}
          </span>{' '}
          <span role="status">{line}</span>
        </p>
        {status}
        {groups && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={detailsId}
            className="inline-flex flex-shrink-0 items-center gap-0.5 rounded px-1 text-[10px] font-medium text-slate-500 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-slate-400 dark:hover:text-slate-200"
          >
            {open ? (
              <ChevronUp className="h-3 w-3" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-3 w-3" aria-hidden="true" />
            )}
            {open
              ? t('eligibility.precheck.hide')
              : t('eligibility.precheck.show')}
          </button>
        )}
      </div>

      {groups && open && (
        <div
          id={detailsId}
          className="mt-1 max-h-44 space-y-1.5 overflow-y-auto pb-0.5"
        >
          {needed.length > 0 && (
            <div
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
              data-testid="precheck-needed"
            >
              <span className="inline-flex items-center gap-1 font-semibold text-amber-900 dark:text-amber-200">
                <ListChecks className="h-3 w-3" aria-hidden="true" />
                {t('eligibility.precheck.needed')}
              </span>
              <ul className="contents">
                {needed.map((item) => (
                  <li
                    key={item.field}
                    className="inline-flex items-center gap-1"
                    data-field={item.field}
                  >
                    <button
                      type="button"
                      onClick={() => go(item)}
                      className={LINK_CLASS}
                    >
                      {stillNeededLabel(t, item)}
                    </button>
                    {item.tab !== tab && (
                      <span className="text-slate-400">
                        ({t(`eligibility.tabs.${item.tab}`)})
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {refusals.length > 0 && (
            <div data-testid="precheck-refusals" className={dimmed}>
              <p className="font-semibold text-red-800 dark:text-red-300">
                {t('eligibility.precheck.refusals')}
              </p>
              <ul className="space-y-0.5">
                {(allRefusals
                  ? refusals
                  : refusals.slice(0, SHOWN_REFUSALS)
                ).map((refusal) => {
                  const field = refusal.field;
                  return (
                    <li
                      key={refusal.text}
                      className="flex items-start gap-1"
                      data-field={field ?? undefined}
                    >
                      <CircleX
                        className="mt-0.5 h-3 w-3 flex-shrink-0 text-red-500"
                        aria-hidden="true"
                      />
                      <RefusalLine refusal={refusal} />
                      {field && (
                        <button
                          type="button"
                          onClick={() => onGo(PRECHECK_FIELD_TAB[field], field)}
                          className="ml-auto inline-flex flex-shrink-0 items-center gap-0.5 whitespace-nowrap rounded px-1 text-[10px] font-medium text-indigo-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-300"
                          aria-label={t('eligibility.precheck.goTo', {
                            field: t(`eligibility.precheck.fields.${field}`),
                          })}
                        >
                          {t(`eligibility.precheck.fields.${field}`)}
                          <ArrowRight
                            className="h-2.5 w-2.5"
                            aria-hidden="true"
                          />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {refusals.length > SHOWN_REFUSALS && (
                <button
                  type="button"
                  onClick={() => setAllRefusals((v) => !v)}
                  aria-expanded={allRefusals}
                  className={`${LINK_CLASS} ml-4 text-[10px]`}
                  data-testid="precheck-refusals-toggle"
                >
                  {allRefusals
                    ? t('eligibility.precheck.showFewer')
                    : t('eligibility.precheck.showAll', {
                        count: refusals.length,
                      })}
                </button>
              )}
            </div>
          )}

          {fileIssues.length > 0 && (
            <div data-testid="precheck-file" className={dimmed}>
              <div className="flex flex-wrap items-center gap-2">
                <p className="inline-flex items-center gap-1 font-semibold text-amber-900 dark:text-amber-200">
                  <FileWarning className="h-3 w-3" aria-hidden="true" />
                  {t('eligibility.precheck.fileNotReady', {
                    count: fileIssues.length,
                  })}
                </p>
                {onOpenFileCheck && (
                  <button
                    type="button"
                    onClick={onOpenFileCheck}
                    className={`${LINK_CLASS} text-[10px]`}
                  >
                    {t('eligibility.precheck.openFileCheck')}
                  </button>
                )}
              </div>
              <ul className="space-y-0.5 pl-4">
                {fileIssues.slice(0, SHOWN_ISSUES).map((issue, i) => (
                  <li key={i} className="list-disc break-words">
                    {issue}
                  </li>
                ))}
              </ul>
              {fileIssues.length > SHOWN_ISSUES && (
                <p className="pl-4 text-slate-500 dark:text-slate-400">
                  {t('eligibility.precheck.moreIssues', {
                    count: fileIssues.length - SHOWN_ISSUES,
                  })}
                </p>
              )}
            </div>
          )}

          {(warnings.length > 0 || summary.conditions > 0) && (
            <div data-testid="precheck-confirm" className={dimmed}>
              <p className="font-semibold text-slate-700 dark:text-slate-200">
                {t('eligibility.precheck.toConfirm')}
              </p>
              <ul className="space-y-0.5">
                {warnings.map((warning) => (
                  <li key={warning} className="flex items-start gap-1">
                    <TriangleAlert
                      className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-500"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 break-words">{warning}</span>
                  </li>
                ))}
                {summary.conditions > 0 && (
                  <li className="text-slate-500 dark:text-slate-400">
                    {t('eligibility.precheck.conditions', {
                      count: summary.conditions,
                      banks: conditionBanks,
                    })}
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
