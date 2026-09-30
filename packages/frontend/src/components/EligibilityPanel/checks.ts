import type { TFunction } from 'i18next';
import type { CompanyCheck, PincodeCheck } from '../../types/eligibility';
import { formatFoir } from '../../lib/eligibility';

// "Check availability" and "Check category" per lender, as the backend's
// SAMPLE pincode and company lists answer them
// (GET .../eligibility/pincodes/{pincode}, GET .../eligibility/companies).

/** One lender's answer to "Check availability" / "Check category". */
export interface PolicyCheckRow {
  lender: string;
  /** true: serviceable / listed; false: not; null: neither (e.g. unlisted but accepted). */
  ok: boolean | null;
  /** e.g. "Serviceable" or "CAT A · FOIR 70%, multiplier 21". */
  text: string;
}

export interface PolicyCheck {
  /** The pincode or company the rows are for. */
  value: string;
  rows: PolicyCheckRow[];
  /** e.g. "Vasai-Virar (Palghar district) · 4 of 5 lenders". */
  summary?: string | null;
  /** Listed companies the name may mean ("Check category" only). */
  suggestions?: string[];
  loading?: boolean;
  error?: string | null;
}

export function pincodeCheckRows(
  t: TFunction,
  check: PincodeCheck,
): PolicyCheck {
  const served = check.lenders.filter((l) => l.serviceable).length;
  return {
    value: check.pincode,
    summary: [
      check.region ?? t('eligibility.profile.noRegion'),
      t('eligibility.profile.servedBy', {
        count: check.lenders.length,
        served,
      }),
    ].join(' · '),
    rows: check.lenders.map((l) => ({
      lender: l.lender,
      ok: l.serviceable,
      text: l.serviceable
        ? t('eligibility.profile.serviceable')
        : t('eligibility.profile.notServiceable'),
    })),
  };
}

function terms(
  t: TFunction,
  foir: number | null,
  multiplier: number | null,
): string {
  return foir !== null && multiplier !== null
    ? t('eligibility.profile.categoryTerms', {
        foir: formatFoir(foir),
        multiplier,
      })
    : '';
}

/**
 * The company's category per lender with the FOIR and multiplier it gives;
 * an unlisted company gets the lender's unlisted-company policy, or none.
 */
export function companyCheckRows(
  t: TFunction,
  check: CompanyCheck,
): PolicyCheck {
  return {
    value: check.query,
    summary: check.match
      ? t('eligibility.profile.companyMatch', { name: check.match.name })
      : t('eligibility.profile.companyNoMatch'),
    suggestions: check.suggestions,
    rows: check.categories.map((c) => {
      const detail = terms(t, c.foir, c.multiplier);
      if (c.listed && c.category) {
        return {
          lender: c.lender,
          ok: true,
          text: detail ? `${c.category} · ${detail}` : c.category,
        };
      }
      return c.accepted
        ? {
            lender: c.lender,
            ok: null,
            text: detail
              ? `${t('eligibility.profile.unlistedAccepted')} · ${detail}`
              : t('eligibility.profile.unlistedAccepted'),
          }
        : {
            lender: c.lender,
            ok: false,
            text: t('eligibility.profile.unlistedRejected'),
          };
    }),
  };
}
