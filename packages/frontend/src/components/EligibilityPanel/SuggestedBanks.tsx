import { useTranslation } from 'react-i18next';
import { CircleCheck, CircleX } from 'lucide-react';
import type { EligibilitySuggestion } from '../../types/eligibility';
import { formatRoi, formatRupees } from '../../lib/eligibility';

/**
 * "Suggested banks" at the top of the Lenders tab: the eligible banks in the
 * backend's order (covering the requested amount at the lowest ROI first,
 * else the highest amount), each with one line on why, and under them the
 * banks that say no, each with one reason. Every figure is the backend's.
 */
export default function SuggestedBanks({
  suggestion,
}: {
  suggestion: EligibilitySuggestion;
}) {
  const { t } = useTranslation();
  const { banks, declined } = suggestion;
  if (banks.length === 0 && declined.length === 0) return null;
  return (
    <section
      aria-labelledby="suggested-banks-title"
      className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2.5 dark:border-emerald-800/50 dark:bg-emerald-900/10"
      data-testid="suggested-banks"
    >
      <h3
        id="suggested-banks-title"
        className="text-xs font-semibold text-slate-800 dark:text-slate-100"
      >
        {t('eligibility.suggested.title')}
      </h3>
      {banks.length === 0 ? (
        <p className="text-[11px] text-slate-600 dark:text-slate-300">
          {t('eligibility.suggested.none')}
        </p>
      ) : (
        <ol className="space-y-1.5">
          {banks.map((bank, i) => (
            <li
              key={bank.lender_id}
              className="flex items-start gap-2 text-[11px] leading-snug"
              data-testid="suggested-bank"
            >
              <span
                className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-[10px] font-semibold text-white"
                aria-hidden="true"
              >
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-slate-800 dark:text-slate-100">
                  <span className="font-semibold">{bank.lender}</span>
                  {': '}
                  <span className="tabular-nums">
                    {t('eligibility.suggested.terms', {
                      amount: formatRupees(bank.eligible_amount),
                      roi: formatRoi(bank.roi),
                      emi: formatRupees(bank.emi),
                      months: bank.tenure_months,
                    })}
                  </span>
                </p>
                <p className="flex items-center gap-1 text-slate-600 dark:text-slate-300">
                  {bank.covers_need && (
                    <CircleCheck
                      className="h-3 w-3 shrink-0 text-emerald-600"
                      aria-hidden="true"
                    />
                  )}
                  <span className="break-words">{bank.why}</span>
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
      {declined.length > 0 && (
        <div className="border-t border-emerald-200/70 pt-1.5 dark:border-emerald-800/40">
          <p className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">
            {t('eligibility.suggested.declined')}
          </p>
          <ul className="mt-1 space-y-1">
            {declined.map((bank) => (
              <li
                key={bank.lender_id}
                className="flex items-start gap-1.5 text-[11px] leading-snug text-slate-600 dark:text-slate-300"
                data-testid="declined-bank"
              >
                <CircleX
                  className="mt-0.5 h-3 w-3 shrink-0 text-red-500"
                  aria-hidden="true"
                />
                <span className="min-w-0 break-words">
                  <span className="font-medium text-slate-800 dark:text-slate-100">
                    {bank.lender}
                  </span>
                  {bank.not_offered && (
                    <span
                      className="ml-1 rounded bg-slate-200 px-1 py-px text-[10px] font-medium text-slate-700 dark:bg-slate-700 dark:text-slate-200"
                      data-testid="not-offered"
                    >
                      {t('eligibility.suggested.notOffered')}
                    </span>
                  )}
                  {': '}
                  {bank.reason}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
