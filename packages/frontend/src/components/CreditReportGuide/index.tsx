import { ExternalLink } from 'lucide-react';
import {
  CREDIT_BUREAUS,
  CREDIT_REPORT_GUIDE,
  GUIDE_LANGS,
  GUIDE_LANG_NAMES,
  type GuideLang,
} from '../../data/creditReportGuide';

const SECTION_TITLE =
  'text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400';

interface CreditReportGuideProps {
  lang: GuideLang;
  onLangChange: (lang: GuideLang) => void;
}

/**
 * "How to get your free credit report" in English, Hindi or Marathi. No
 * router, auth or app-language dependency (its text is in
 * data/creditReportGuide), so a page without the app shell can show it too.
 */
export default function CreditReportGuide({
  lang,
  onLangChange,
}: CreditReportGuideProps) {
  const guide = CREDIT_REPORT_GUIDE[lang];
  return (
    <article
      lang={lang}
      className="mx-auto flex w-full max-w-2xl flex-col gap-5 pb-8 text-slate-800 dark:text-slate-200"
      data-testid="credit-report-guide"
    >
      <div
        role="group"
        aria-label={guide.languageLabel}
        className="flex w-fit gap-1 rounded-xl bg-slate-200/70 p-1 dark:bg-white/[0.06]"
      >
        {GUIDE_LANGS.map((code) => (
          <button
            key={code}
            type="button"
            lang={code}
            aria-pressed={code === lang}
            onClick={() => onLangChange(code)}
            className={`min-h-10 rounded-lg px-3 text-sm font-medium ${
              code === lang
                ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
            }`}
          >
            {GUIDE_LANG_NAMES[code]}
          </button>
        ))}
      </div>

      <header className="flex flex-col gap-2">
        {/* Inline size: the app's .card h1 rule (3rem) wins over classes. */}
        <h1
          className="font-semibold text-slate-900 dark:text-slate-100"
          style={{ fontSize: '1.5rem', lineHeight: 1.3, margin: 0 }}
        >
          {guide.title}
        </h1>
        <p className="text-base leading-relaxed">{guide.intro}</p>
      </header>

      <section className="rounded-2xl border border-blue-200 bg-blue-50/70 p-4 dark:border-blue-400/20 dark:bg-blue-400/[0.06]">
        <h2 className={SECTION_TITLE}>{guide.factsTitle}</h2>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed">
          {guide.facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className={SECTION_TITLE}>{guide.stepsTitle}</h2>
        <ol className="mt-2 list-decimal space-y-2 pl-5 leading-relaxed">
          {guide.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>

      <section>
        <h2 className={SECTION_TITLE}>{guide.bureausTitle}</h2>
        <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {CREDIT_BUREAUS.map((bureau) => (
            <li key={bureau.site}>
              <a
                href={bureau.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-h-12 items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white/80 px-3 py-2 hover:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:hover:border-blue-400/40"
              >
                <span>
                  <span className="block font-medium text-slate-900 dark:text-slate-100">
                    {bureau.name}
                  </span>
                  <span className="block text-sm text-blue-700 dark:text-blue-300">
                    {bureau.site}
                  </span>
                </span>
                <ExternalLink
                  className="h-4 w-4 flex-shrink-0 text-slate-400"
                  aria-hidden="true"
                />
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-400/20 dark:bg-amber-400/[0.06]">
        <h2 className={SECTION_TITLE}>{guide.cautionsTitle}</h2>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed">
          {guide.cautions.map((caution) => (
            <li key={caution}>{caution}</li>
          ))}
        </ul>
      </section>
    </article>
  );
}
