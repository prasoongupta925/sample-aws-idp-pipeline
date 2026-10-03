import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { creditReportHelpHref } from '../../data/creditReportGuide';

/**
 * Link to "How to get your free credit report" in a new tab (the eligibility
 * page keeps its state). A plain link: it also renders without a router.
 */
export default function CreditReportHelpLink() {
  const { t } = useTranslation();
  return (
    <a
      href={creditReportHelpHref()}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex w-fit items-center gap-1 text-[11px] font-medium text-blue-700 underline-offset-2 hover:underline dark:text-blue-300"
      data-testid="credit-report-help-link"
    >
      {t('creditGuide.link')}
      <ExternalLink className="h-3 w-3" aria-hidden="true" />
    </a>
  );
}
