import { createFileRoute, useNavigate } from '@tanstack/react-router';
import CreditReportGuide from '../../components/CreditReportGuide';
import {
  CREDIT_REPORT_HELP_PATH,
  parseGuideLang,
  type GuideLang,
} from '../../data/creditReportGuide';

/**
 * "How to get your free credit report" (English, Hindi, Marathi; ?lang=hi or
 * ?lang=mr). Link to it with creditReportHelpHref (data/creditReportGuide).
 */
export const Route = createFileRoute('/help/credit-report')({
  validateSearch: (search: Record<string, unknown>): { lang?: GuideLang } =>
    search.lang === undefined ? {} : { lang: parseGuideLang(search.lang) },
  component: CreditReportHelpPage,
});

function CreditReportHelpPage() {
  const { lang } = Route.useSearch();
  const navigate = useNavigate({ from: CREDIT_REPORT_HELP_PATH });
  return (
    <div className="bento-page max-sm:fixed max-sm:inset-0 max-sm:z-40 max-sm:bg-slate-100 max-sm:px-4 dark:max-sm:bg-slate-950">
      <CreditReportGuide
        lang={lang ?? 'en'}
        onLangChange={(next) =>
          navigate({
            search: next === 'en' ? {} : { lang: next },
            replace: true,
          })
        }
      />
    </div>
  );
}
