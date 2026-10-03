import { Construct } from 'constructs';

/**
 * Credit bureau of the CIBIL page's "Fetch credit report"
 * (packages/backend/app/bureau.py): none (no bureau connected) or mock
 * (SAMPLE reports for the demo applicants; no bureau is called).
 */
export const BUREAU_PROVIDERS = ['none', 'mock'] as const;
export type BureauProvider = (typeof BUREAU_PROVIDERS)[number];

/**
 * Provider from CDK context `bureauProvider` (default none), e.g.
 * deploy/lean/deploy.sh --context bureauProvider=mock for the demo.
 * Throws when the value is not one of BUREAU_PROVIDERS.
 */
export function getBureauProvider(scope: Construct): BureauProvider {
  const value: unknown = scope.node.tryGetContext('bureauProvider');
  const name =
    value === undefined || value === null
      ? ''
      : String(value).trim().toLowerCase();
  if (name === '') return 'none';
  const known = BUREAU_PROVIDERS.find((p) => p === name);
  if (!known) {
    throw new Error(
      `Invalid CDK context bureauProvider=${String(value)}: ` +
        `expected one of ${BUREAU_PROVIDERS.join(', ')} (e.g. -c bureauProvider=mock).`,
    );
  }
  return known;
}
