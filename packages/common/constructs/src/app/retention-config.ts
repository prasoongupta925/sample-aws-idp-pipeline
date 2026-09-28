import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/**
 * Maximum number of days client data (documents, derived analysis, chat
 * sessions, artifacts) and logs are kept. Override with
 * `-c retentionDays=<n>`.
 */
export const DEFAULT_RETENTION_DAYS = 7;

/**
 * CloudWatch Logs retention steps in ascending order (INFINITE excluded).
 */
const LOG_RETENTION_STEPS: RetentionDays[] = [
  RetentionDays.ONE_DAY,
  RetentionDays.THREE_DAYS,
  RetentionDays.FIVE_DAYS,
  RetentionDays.ONE_WEEK,
  RetentionDays.TWO_WEEKS,
  RetentionDays.ONE_MONTH,
  RetentionDays.TWO_MONTHS,
  RetentionDays.THREE_MONTHS,
  RetentionDays.FOUR_MONTHS,
  RetentionDays.FIVE_MONTHS,
  RetentionDays.SIX_MONTHS,
  RetentionDays.ONE_YEAR,
  RetentionDays.THIRTEEN_MONTHS,
  RetentionDays.EIGHTEEN_MONTHS,
  RetentionDays.TWO_YEARS,
  RetentionDays.THREE_YEARS,
  RetentionDays.FIVE_YEARS,
  RetentionDays.SIX_YEARS,
  RetentionDays.SEVEN_YEARS,
  RetentionDays.EIGHT_YEARS,
  RetentionDays.NINE_YEARS,
  RetentionDays.TEN_YEARS,
];

/**
 * Retention in days from CDK context `retentionDays` (default 7).
 * Throws when the value is not an integer >= 1.
 */
export function getRetentionDays(scope: Construct): number {
  const value: unknown = scope.node.tryGetContext('retentionDays');
  if (value === undefined || value === null || String(value).trim() === '') {
    return DEFAULT_RETENTION_DAYS;
  }
  const days = Number(String(value).trim());
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(
      `Invalid CDK context retentionDays=${String(value)}: ` +
        'expected an integer >= 1 (e.g. -c retentionDays=7).',
    );
  }
  return days;
}

/**
 * The largest CloudWatch Logs retention that does not exceed `days`
 * (minimum ONE_DAY).
 */
export function toLogRetention(days: number): RetentionDays {
  let retention = RetentionDays.ONE_DAY;
  for (const step of LOG_RETENTION_STEPS) {
    if (step <= days) {
      retention = step;
    }
  }
  return retention;
}
