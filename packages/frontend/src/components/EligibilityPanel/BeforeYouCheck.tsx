import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
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
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import {
  PRECHECK_FIELD_TAB,
  precheckClear,
  type NeededField,
  type PrecheckSummary,
} from '../../lib/eligibility';
import { invalidInput } from './errors';
import { RefusalLine, fieldLabel, stillNeededLabel } from './fields';

type Tab = 'profile' | 'cibil' | 'lenders';

/** File-check issues shown before "+N more in File check". */
const SHOWN_ISSUES = 2;
/** Refusal lines shown before "Show all N". */
export const SHOWN_REFUSALS = 5;

const LINK_CLASS =
  'rounded font-medium text-indigo-700 underline decoration-indigo-300 underline-offset-2 hover:decoration-indigo-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-300';

const SMALL_BUTTON_CLASS =
  'inline-flex flex-shrink-0 items-center gap-0.5 rounded px-1 text-[10px] font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500';

export interface BeforeYouCheckProps {
  summary: PrecheckSummary;
  /** A background check (or Check eligibility) is on its way. */
  checking: boolean;
  /** The result shown is for other inputs (no check runs for these yet). */
  outdated: boolean;
  /** Why no check runs: a value in red, or nothing a bank checks filled yet. */
  waiting: 'invalid' | 'empty' | null;
  /** The answer shown is Check eligibility's own: each bank's Details are on the Lenders tab. */
  checked?: boolean;
  /** The background check of the inputs on screen failed. */
  failed?: boolean;
  /** Why it failed (the request's error): a 422 names the field. */
  error?: unknown;
  /** Checks the same inputs again (after a failure). */
  onRetry?: () => void;
  /**
   * A field below was typed in a moment ago: the box keeps the height it had
   * before, so the field (and a button pressed right after) does not move
   * while what the box says changes.
   */
  holdHeight?: boolean;
  /** The tab shown: fields of the other tabs are named with their tab. */
  tab: Tab;
  /** Moves to a field: a still-needed field ("score", "tradelines.2.emi") or a refusal's. */
  onGo: (tab: 'profile' | 'cibil', field: string) => void;
  /** Opens the File Check panel (its open issues). */
  onOpenFileCheck?: () => void;
}

/** "ICICI Bank", "ICICI Bank and Bajaj Finance", "HDFC Bank, ICICI Bank and Bajaj Finance". */
function namesText(t: TFunction, names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return t('eligibility.precheck.and', {
    list: names.slice(0, -1).join(', '),
    last: names[names.length - 1],
  });
}

/**
 * What an empty field blocks: "all 7 banks need it. ICICI Bank and Bajaj
 * Finance need only this."; null without an answer that names it (one for
 * other inputs; a field a fresh answer does not ask for is not listed).
 */
function blocks(
  t: TFunction,
  item: NeededField,
  total: number | null,
): string | null {
  const { banks, only } = item;
  if (banks === null || total === null || banks.length === 0) return null;
  const all = banks.length === total;
  if (only.length === banks.length) {
    return all
      ? t('eligibility.precheck.neededOnlyAll', { count: total })
      : t('eligibility.precheck.neededOnly', {
          count: only.length,
          banks: namesText(t, only),
        });
  }
  const need = all
    ? t('eligibility.precheck.neededByAll', { count: total })
    : t('eligibility.precheck.neededBy', {
        count: banks.length,
        banks: namesText(t, banks),
      });
  if (only.length === 0) return need;
  return `${need} ${t('eligibility.precheck.neededOnly', {
    count: only.length,
    banks: namesText(t, only),
  })}`;
}

/** "Enter the Pincode: ICICI Bank and Bajaj Finance need only that." */
function nextStepText(t: TFunction, summary: PrecheckSummary): string | null {
  const { next, total } = summary;
  if (!next || total === null) return null;
  const labels = next.fields.map((field) => {
    const item = summary.needed.find((i) => i.field === field);
    return item ? stillNeededLabel(t, item) : field;
  });
  const enter =
    labels.length === 1
      ? t('eligibility.precheck.enterOne', { field: labels[0] })
      : labels.length === 2
        ? t('eligibility.precheck.enterTwo', {
            first: labels[0],
            second: labels[1],
          })
        : t('eligibility.precheck.enterMany', { count: labels.length });
  const those = labels.length > 1 ? 'Those' : 'That';
  const who =
    next.banks.length === total
      ? t(`eligibility.precheck.allOnly${those}`, { count: total })
      : t(`eligibility.precheck.only${those}`, {
          count: next.banks.length,
          banks: namesText(t, next.banks),
        });
  return `${enter}: ${who}`;
}

/**
 * True while a pointer button is pressed, until the click it makes has
 * landed: the box changes no height meanwhile, so what is under the pointer
 * stays there. The effect depends on nothing.
 */
function usePointerPressed(): boolean {
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    let down = false;
    let release: ReturnType<typeof setTimeout> | undefined;
    const press = () => {
      clearTimeout(release);
      down = true;
      setPressed(true);
    };
    // The click follows the release in the same task: it lands first.
    const lift = () => {
      if (!down) return;
      down = false;
      clearTimeout(release);
      release = setTimeout(() => setPressed(false), 0);
    };
    // A release no pointerup told of (a scrollbar dragged): the next move does.
    const move = (e: PointerEvent) => {
      if (down && e.buttons === 0) lift();
    };
    document.addEventListener('pointerdown', press, true);
    document.addEventListener('pointerup', lift, true);
    document.addEventListener('pointercancel', lift, true);
    document.addEventListener('pointermove', move, true);
    window.addEventListener('blur', lift);
    return () => {
      clearTimeout(release);
      document.removeEventListener('pointerdown', press, true);
      document.removeEventListener('pointerup', lift, true);
      document.removeEventListener('pointercancel', lift, true);
      document.removeEventListener('pointermove', move, true);
      window.removeEventListener('blur', lift);
    };
  }, []);
  return pressed;
}

/** Why the background check failed: a 422 names the field refused. */
function failureText(t: TFunction, error: unknown): string {
  const invalid = invalidInput(error);
  if (!invalid) return t('eligibility.precheck.failed');
  const field = invalid.field ? fieldLabel(t, invalid.field) : null;
  if (!field) return t('eligibility.precheck.failedInput');
  return invalid.message
    ? t('eligibility.precheck.failedFieldWhy', { field, why: invalid.message })
    : t('eligibility.precheck.failedField', { field });
}

/**
 * "Before you check": at the top of the Eligibility & lenders panel, on every
 * tab, what would stop a bank before Check eligibility is clicked, in the
 * order to act on it: the fields still empty (each with the banks it blocks),
 * the file's open issues (documents to upload), the banks that will say no on
 * what is entered (one line per cause), the likely refusals (an overdue, a
 * written-off loan) and, collapsed, what to check by hand. One line when
 * nothing is in the way.
 */
export default function BeforeYouCheck({
  summary,
  checking,
  outdated,
  waiting,
  checked = false,
  failed = false,
  error,
  onRetry,
  holdHeight = false,
  tab,
  onGo,
  onOpenFileCheck,
}: BeforeYouCheckProps) {
  const { t } = useTranslation();
  const detailsId = useId();
  const byHandId = useId();
  const [open, setOpen] = useState(true);
  const [allRefusals, setAllRefusals] = useState(false);
  const [byHand, setByHand] = useState(false);
  const root = useRef<HTMLElement>(null);
  // The box at its last commit while nothing held it: its height, its words.
  const natural = useRef({ height: 0, text: '' });
  const [height, setHeight] = useState<number | null>(null);
  const pressed = usePointerPressed();
  const hold = holdHeight || pressed;

  // Measured after each commit while nothing holds the box (no state set).
  useLayoutEffect(() => {
    const box = root.current;
    if (box && !hold && height === null) {
      natural.current = {
        height: box.getBoundingClientRect().height,
        text: box.textContent ?? '',
      };
    }
  });
  // Held (a field below typed in, a pointer button down): the box keeps the
  // height it has, or had before its words changed with the hold (the first
  // keystroke); the new words scroll inside it, so nothing below moves.
  useLayoutEffect(() => {
    const box = root.current;
    if (!hold || !box) {
      setHeight(null);
      return;
    }
    const measured =
      box.textContent === natural.current.text
        ? box.getBoundingClientRect().height
        : natural.current.height;
    setHeight(measured > 0 ? measured : null);
  }, [hold]);
  const held =
    height === null ? undefined : { height, overflowY: 'auto' as const };

  const { needed, refusals, fileIssues, declines, warnings, eligible, total } =
    summary;
  const hasResult = eligible !== null && total !== null;
  // While the next check runs the last answer stays (no flicker on each edit);
  // an answer no check will replace (a value in red, a failure) is not "clear".
  const clear =
    hasResult && (!outdated || checking) && !failed && precheckClear(summary);
  const conditionBanks = summary.conditionBanks.join(', ');
  const failure = failed ? failureText(t, error) : null;

  // The first check of the panel: the line itself says so.
  const firstCheck = !clear && needed.length === 0 && !hasResult && checking;
  const line = clear
    ? eligible === total
      ? t('eligibility.precheck.allClearAll', { total })
      : t('eligibility.precheck.allClear', { eligible, total })
    : hasResult
      ? [
          t('eligibility.precheck.canLend', { eligible, total }),
          nextStepText(t, summary),
        ]
          .filter(Boolean)
          .join(' ')
      : needed.length > 0
        ? t('eligibility.precheck.fillFirst', { count: needed.length })
        : firstCheck
          ? t('eligibility.precheck.checking')
          : (failure ??
            (waiting === 'invalid'
              ? t('eligibility.precheck.fixFirst')
              : t('eligibility.precheck.start')));
  const status = failed ? (
    <button
      type="button"
      onClick={onRetry}
      className={`${SMALL_BUTTON_CLASS} border border-amber-300 bg-white/70 text-amber-900 hover:bg-white dark:border-amber-700/60 dark:bg-transparent dark:text-amber-200`}
      data-testid="precheck-retry"
    >
      <RefreshCw className="h-2.5 w-2.5" aria-hidden="true" />
      {t('eligibility.precheck.retry')}
    </button>
  ) : firstCheck ? null : checking ? (
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
  // A failure the line does not say already, and that the answer shown may be old.
  const alert =
    failure && failure !== line
      ? [failure, hasResult ? t('eligibility.precheck.mayBeOutdated') : null]
          .filter(Boolean)
          .join(' ')
      : null;

  if (clear) {
    return (
      <section
        ref={root}
        style={held}
        className="flex flex-shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-green-200/70 bg-green-50/70 px-4 py-1.5 text-[11px] text-green-800 dark:border-green-800/40 dark:bg-green-900/15 dark:text-green-300"
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
            {t(
              checked
                ? 'eligibility.precheck.conditionsShortChecked'
                : 'eligibility.precheck.conditionsShort',
              { count: summary.conditions },
            )}
          </span>
        )}
        {status && <span className="ml-auto">{status}</span>}
      </section>
    );
  }

  const groups = [needed, refusals, fileIssues, declines, warnings].some(
    (list) => list.length > 0,
  );
  // What the banks said for other inputs, no check on its way (a value in
  // red, a failure): shown faded. The still-needed fields are always the
  // inputs on screen; what each blocks is the answer's.
  const dimmed = outdated && !checking ? 'opacity-60' : undefined;
  const go = (item: NeededField) => onGo(item.tab, item.field);
  const shownRefusals = allRefusals
    ? refusals
    : refusals.slice(0, SHOWN_REFUSALS);
  const toCheck = warnings.length + summary.conditions;

  return (
    <section
      ref={root}
      style={held}
      className="flex-shrink-0 border-b border-amber-200/70 bg-amber-50/50 px-4 py-1.5 text-[11px] leading-snug text-slate-700 dark:border-amber-800/40 dark:bg-amber-900/10 dark:text-slate-200"
      aria-label={t('eligibility.precheck.label')}
      data-testid="before-you-check"
      data-state={failed ? 'failed' : groups ? 'open' : 'waiting'}
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
            className={`${SMALL_BUTTON_CLASS} text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200`}
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

      {alert && (
        <p
          role="alert"
          className="mt-0.5 break-words pl-5 text-red-700 dark:text-red-400"
          data-testid="precheck-failed"
        >
          {alert}
        </p>
      )}

      {groups && open && (
        <div
          id={detailsId}
          className="mt-1 max-h-44 space-y-1.5 overflow-y-auto pb-0.5"
        >
          {/* 1. Fill now: each empty field with the banks it blocks */}
          {needed.length > 0 && (
            <div data-testid="precheck-needed">
              <p className="inline-flex items-center gap-1 font-semibold text-amber-900 dark:text-amber-200">
                <ListChecks className="h-3 w-3" aria-hidden="true" />
                {t('eligibility.precheck.needed')}
              </p>
              <ul className="space-y-0.5 pl-4">
                {needed.map((item) => {
                  const what = blocks(t, item, total);
                  return (
                    <li
                      key={item.field}
                      className="break-words"
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
                        <span className="text-slate-500 dark:text-slate-400">
                          {' '}
                          ({t(`eligibility.tabs.${item.tab}`)})
                        </span>
                      )}
                      {what && (
                        <span className={dimmed} data-testid="needed-blocks">
                          : {what}
                        </span>
                      )}
                      {item.fromDocuments && (
                        <span
                          className="ml-1 whitespace-nowrap rounded-full border border-blue-200 bg-blue-50 px-1 text-[9px] font-semibold text-blue-700 dark:border-blue-800/60 dark:bg-blue-900/30 dark:text-blue-300"
                          title={t('eligibility.needed.inDocumentsHint')}
                          data-testid="needed-in-documents"
                        >
                          {t('eligibility.needed.inDocuments')}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* 2. Upload: the file check's open issues */}
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

          {/* 3. The banks that will say no on what is entered, one line per cause */}
          {refusals.length > 0 && (
            <div data-testid="precheck-refusals" className={dimmed}>
              <p className="font-semibold text-red-800 dark:text-red-300">
                {t('eligibility.precheck.refusals')}
              </p>
              <ul className="space-y-0.5">
                {shownRefusals.map((refusal) => {
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
                          className={`${SMALL_BUTTON_CLASS} ml-auto whitespace-nowrap text-indigo-700 hover:underline dark:text-indigo-300`}
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

          {/* 4. What lenders usually decline (an overdue, a written-off loan): shown */}
          {declines.length > 0 && (
            <div data-testid="precheck-declines" className={dimmed}>
              <p className="font-semibold text-red-800 dark:text-red-300">
                {t('eligibility.precheck.declines')}
              </p>
              <ul className="space-y-0.5">
                {declines.map((note) => (
                  <li key={note} className="flex items-start gap-1">
                    <TriangleAlert
                      className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-600 dark:text-amber-400"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 break-words">{note}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 5. To check by hand (bank EMIs that match no loan, the sheet's conditions): collapsed until asked for */}
          {toCheck > 0 && (
            <div data-testid="precheck-confirm" className={dimmed}>
              <button
                type="button"
                onClick={() => setByHand((v) => !v)}
                aria-expanded={byHand}
                aria-controls={byHandId}
                className="inline-flex items-center gap-0.5 rounded font-semibold text-slate-700 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-slate-200 dark:hover:text-white"
                data-testid="precheck-confirm-toggle"
              >
                {byHand ? (
                  <ChevronUp className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <ChevronDown className="h-3 w-3" aria-hidden="true" />
                )}
                {t('eligibility.precheck.toCheck', { count: toCheck })}
              </button>
              {byHand && (
                <ul id={byHandId} className="space-y-0.5">
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
                      {t(
                        checked
                          ? 'eligibility.precheck.conditionsChecked'
                          : 'eligibility.precheck.conditions',
                        { count: summary.conditions, banks: conditionBanks },
                      )}
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
