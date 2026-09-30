import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FileCheck2, FlaskConical, Scale } from 'lucide-react';
import {
  formatIndianNumber,
  parseAmount,
  parseCount,
} from '../../lib/eligibility';

// Form controls of the Eligibility & lenders panel (the File Check panel's look).

export const CONTROL_CLASS =
  'w-full px-2.5 py-1.5 text-xs border border-black/10 dark:border-[#3b4264] rounded-lg bg-white/40 dark:bg-[#0d1117] text-[#0f172a] dark:text-[#f1f5f9] placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:opacity-60 read-only:bg-slate-100/70 dark:read-only:bg-white/[0.04] aria-[invalid=true]:border-red-400 dark:aria-[invalid=true]:border-red-500/70';

export const LABEL_CLASS =
  'flex flex-wrap items-center gap-1 text-[11px] font-semibold text-slate-600 dark:text-slate-300';

export const SECTION_CLASS =
  'space-y-2.5 rounded-xl border border-white/50 bg-white/20 p-3 dark:border-white/[0.08] dark:bg-white/[0.02]';

export const BUTTON_CLASS =
  'inline-flex items-center gap-1 rounded-lg border border-black/10 px-2.5 py-1.5 text-[11px] font-medium text-slate-700 transition-colors hover:bg-white/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:text-slate-200 dark:hover:bg-white/10';

export const PRIMARY_CLASS =
  'inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60';

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
      {children}
    </h4>
  );
}

/** "from documents": the value was read from the applicant's documents. */
export function FromDocumentsBadge() {
  const { t } = useTranslation();
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-px text-[9px] font-semibold normal-case tracking-normal text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-900/30 dark:text-emerald-300"
      title={t('eligibility.fromDocumentsHint')}
      data-testid="from-documents"
    >
      <FileCheck2 className="h-2.5 w-2.5" aria-hidden="true" />
      {t('eligibility.fromDocuments')}
    </span>
  );
}

/** "Sample policy — replace with your lender grid", next to anything from the policies. */
export function SamplePolicyTag({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full border border-amber-300 bg-amber-50 px-1.5 py-px text-[9px] font-semibold text-amber-800 dark:border-amber-700/60 dark:bg-amber-900/30 dark:text-amber-300 ${className}`}
      data-testid="sample-policy"
    >
      <FlaskConical className="h-2.5 w-2.5" aria-hidden="true" />
      {t('eligibility.samplePolicy')}
    </span>
  );
}

/** "Indicative: the lender decides", next to every eligibility result. */
export function IndicativeTag({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full border border-slate-300 bg-slate-50 px-1.5 py-px text-[9px] font-semibold text-slate-700 dark:border-white/15 dark:bg-white/10 dark:text-slate-200 ${className}`}
      data-testid="indicative"
    >
      <Scale className="h-2.5 w-2.5" aria-hidden="true" />
      {t('eligibility.indicative')}
    </span>
  );
}

interface FieldProps {
  label: ReactNode;
  /** Renders the control with the ids the label and messages use. */
  children: (ids: { id: string; describedBy: string | undefined }) => ReactNode;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
}

/** Label, control, then the hint or the error the control is described by. */
export function Field({ label, children, hint, error, className }: FieldProps) {
  const id = useId();
  const messageId = useId();
  const message = error || hint;
  return (
    <div className={`min-w-0 space-y-1 ${className ?? ''}`}>
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
      </label>
      {children({ id, describedBy: message ? messageId : undefined })}
      {message && (
        <p
          id={messageId}
          className={`text-[10px] leading-snug ${
            error
              ? 'text-red-600 dark:text-red-400'
              : 'text-slate-500 dark:text-slate-400'
          }`}
        >
          {message}
        </p>
      )}
    </div>
  );
}

interface NumberInputProps {
  id: string;
  value: number | null;
  /** The typed number; null when blank; NaN when it is not a number. */
  onChange: (value: number | null) => void;
  kind?: 'amount' | 'count';
  describedBy?: string;
  /** Shows a rupee sign in front (amounts). */
  rupees?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Set by the field when the value is out of range. */
  invalid?: boolean;
  testId?: string;
}

/**
 * Amounts and counts typed as text: '20,58,000' is accepted, and amounts
 * are shown with Indian digit grouping once the field is left.
 */
export function NumberInput({
  id,
  value,
  onChange,
  kind = 'amount',
  describedBy,
  rupees = kind === 'amount',
  readOnly,
  disabled,
  placeholder,
  invalid,
  testId,
}: NumberInputProps) {
  const show = (n: number | null) =>
    n === null || Number.isNaN(n)
      ? ''
      : kind === 'amount'
        ? formatIndianNumber(n)
        : String(n);
  const { t } = useTranslation();
  const errorId = useId();
  const [text, setText] = useState(() => show(value));
  const [focused, setFocused] = useState(false);
  const parse = kind === 'amount' ? parseAmount : parseCount;
  const typedInvalid = Number.isNaN(parse(text) as number);
  const describedByIds =
    [describedBy, typedInvalid ? errorId : null].filter(Boolean).join(' ') ||
    undefined;

  // Show a new value from outside (a reload) unless the user is typing.
  useEffect(() => {
    if (!focused && !(value !== null && Number.isNaN(value))) {
      setText(show(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused]);

  return (
    <div>
      <div className="relative">
        {rupees && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400"
          >
            ₹
          </span>
        )}
        <input
          id={id}
          type="text"
          inputMode={kind === 'amount' ? 'decimal' : 'numeric'}
          autoComplete="off"
          value={text}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            const n = parse(text);
            if (n !== null && !Number.isNaN(n)) setText(show(n));
          }}
          onChange={(e) => {
            setText(e.target.value);
            onChange(parse(e.target.value));
          }}
          readOnly={readOnly}
          disabled={disabled}
          placeholder={placeholder}
          aria-describedby={describedByIds}
          aria-invalid={typedInvalid || invalid ? true : undefined}
          data-testid={testId}
          className={`${CONTROL_CLASS} tabular-nums ${rupees ? 'pl-6' : ''}`}
        />
      </div>
      {typedInvalid && (
        <p
          id={errorId}
          className="mt-0.5 text-[10px] leading-snug text-red-600 dark:text-red-400"
        >
          {kind === 'amount'
            ? t('eligibility.notAnAmount')
            : t('eligibility.notAWholeNumber')}
        </p>
      )}
    </div>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedProps<T extends string> {
  /** Radio group name, unique in the page. */
  name: string;
  legend: string;
  options: readonly SegmentOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  /** Shows the legend above the buttons (else it is for screen readers only). */
  showLegend?: boolean;
  disabled?: boolean;
  describedBy?: string;
  testId?: string;
}

/**
 * A segmented control: native radio buttons (arrow keys move between them)
 * drawn as one button bar. No hooks, so tests can call it directly.
 */
export function Segmented<T extends string>({
  name,
  legend,
  options,
  value,
  onChange,
  showLegend = false,
  disabled,
  describedBy,
  testId,
}: SegmentedProps<T>) {
  return (
    <fieldset
      className="min-w-0 space-y-1"
      aria-describedby={describedBy}
      data-testid={testId}
      disabled={disabled}
    >
      <legend className={showLegend ? LABEL_CLASS : 'sr-only'}>{legend}</legend>
      <div className="inline-flex max-w-full overflow-hidden rounded-lg border border-black/10 bg-white/40 dark:border-[#3b4264] dark:bg-[#0d1117]">
        {options.map((option) => (
          <label
            key={option.value}
            className="relative cursor-pointer border-r border-black/10 last:border-r-0 dark:border-[#3b4264]"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="peer sr-only"
            />
            <span className="block whitespace-nowrap px-2.5 py-1 text-[11px] font-semibold text-slate-600 transition-colors hover:bg-white/60 peer-checked:bg-indigo-600 peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-inset peer-focus-visible:ring-indigo-400 peer-disabled:cursor-not-allowed peer-disabled:opacity-60 dark:text-slate-300 dark:hover:bg-white/10 dark:peer-checked:bg-indigo-500">
              {option.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
