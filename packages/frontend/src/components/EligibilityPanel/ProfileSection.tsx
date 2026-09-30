import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Building2,
  CircleAlert,
  CircleCheck,
  CircleX,
  Loader2,
  MapPin,
  Plus,
  Trash2,
} from 'lucide-react';
import type {
  EligibilityInputs,
  EligibilityProfile,
  HouseOwnership,
  OtherIncome,
  PrefillField,
} from '../../types/eligibility';
import type { PrefillValues } from '../../hooks/useEligibility';
import {
  EMPLOYMENT_TYPES,
  HOUSE_OWNERSHIP,
  INCOME_FREQUENCIES,
  MAX_OTHER_INCOME,
  OTHER_INCOME_TYPES,
  RENT_AGREEMENTS,
  addOtherIncome,
  incomeHasFrequency,
  isFutureDate,
  localToday,
  isMaskedPan,
  mobileLooksValid,
  panLooksValid,
  pincodeLooksValid,
  removeOtherIncome,
  setLoan,
  setProfile,
  updateOtherIncome,
} from '../../lib/eligibility';
import type { PolicyCheck } from './checks';
import {
  BUTTON_CLASS,
  CONTROL_CLASS,
  Field,
  FromDocumentsBadge,
  NumberInput,
  SECTION_CLASS,
  SamplePolicyTag,
  SectionTitle,
  Segmented,
} from './fields';

type Edit = (update: (inputs: EligibilityInputs) => EligibilityInputs) => void;

function PolicyCheckResult({
  check,
  current,
  testId,
  onPick,
}: {
  check: PolicyCheck;
  /** The field's value now: an older check is marked as such. */
  current: string;
  testId: string;
  /** Picks a suggested company name. */
  onPick?: (value: string) => void;
}) {
  const { t } = useTranslation();
  const outdated = check.value.trim() !== current.trim();
  const suggestions = check.suggestions ?? [];
  return (
    <div
      role="status"
      className={`space-y-1 rounded-lg border border-white/50 bg-white/30 px-2 py-1.5 dark:border-white/[0.08] dark:bg-white/[0.03] ${
        outdated ? 'opacity-60' : ''
      }`}
      data-testid={testId}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500 dark:text-slate-400">
        <span className="font-semibold text-slate-600 dark:text-slate-300">
          {t('eligibility.profile.checkFor', { value: check.value })}
        </span>
        {check.summary && !check.loading && !check.error && (
          <span>{check.summary}</span>
        )}
        <SamplePolicyTag />
        {outdated && <span>{t('eligibility.profile.checkOutdated')}</span>}
      </div>
      {check.loading ? (
        <p className="flex items-center gap-1 text-[11px] text-slate-500">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          {t('eligibility.profile.checking')}
        </p>
      ) : check.error ? (
        <p className="break-words text-[11px] text-red-600 dark:text-red-400">
          {check.error}
        </p>
      ) : (
        <>
          <ul className="grid grid-cols-1 gap-x-3 gap-y-0.5 @md:grid-cols-2">
            {check.rows.map((row) => (
              <li
                key={row.lender}
                className="flex min-w-0 items-center gap-1 text-[11px]"
                data-ok={row.ok === null ? 'unknown' : String(row.ok)}
              >
                {row.ok === false ? (
                  <CircleX
                    className="h-3 w-3 flex-shrink-0 text-red-500"
                    aria-hidden="true"
                  />
                ) : row.ok ? (
                  <CircleCheck
                    className="h-3 w-3 flex-shrink-0 text-green-600"
                    aria-hidden="true"
                  />
                ) : (
                  <CircleAlert
                    className="h-3 w-3 flex-shrink-0 text-amber-500"
                    aria-hidden="true"
                  />
                )}
                <span className="flex-shrink-0 font-medium text-slate-700 dark:text-slate-200">
                  {row.lender}
                </span>
                <span className="min-w-0 truncate text-slate-500 dark:text-slate-400">
                  {row.text}
                </span>
              </li>
            ))}
          </ul>
          {suggestions.length > 0 && onPick && (
            <div className="flex flex-wrap items-center gap-1 pt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
              <span>{t('eligibility.profile.didYouMean')}</span>
              {suggestions.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => onPick(name)}
                  className="rounded-full border border-indigo-200 bg-indigo-50 px-1.5 py-px font-medium text-indigo-700 hover:bg-indigo-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-indigo-800/50 dark:bg-indigo-900/20 dark:text-indigo-300"
                >
                  {name}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface ProfileSectionProps {
  inputs: EligibilityInputs;
  onEdit: Edit;
  /** The documents' values of pre-filled fields (badge while unchanged). */
  prefill: PrefillValues;
  /** How the verified net income was taken, e.g. "verified: salary slips, median net pay". */
  incomeSource?: string | null;
  disabled?: boolean;
  pincodeCheck?: PolicyCheck | null;
  companyCheck?: PolicyCheck | null;
  onCheckPincode?: () => void;
  /** Checks the company typed, or the name given (a suggestion). */
  onCheckCompany?: (name?: string) => void;
}

/** Sheet 1 of the client's page: personal, employment, income and loan details. */
export default function ProfileSection({
  inputs,
  onEdit,
  prefill,
  incomeSource,
  disabled,
  pincodeCheck,
  companyCheck,
  onCheckPincode,
  onCheckCompany,
}: ProfileSectionProps) {
  const { t } = useTranslation();
  const groupName = useId();
  const p = inputs.profile;
  const patch = (next: Partial<EligibilityProfile>) =>
    onEdit((i) => setProfile(i, next));
  const current = (field: PrefillField): unknown =>
    field === 'loan_amount'
      ? inputs.loan.amount
      : field === 'tenure_months'
        ? inputs.loan.tenure_months
        : field === 'tradelines'
          ? undefined
          : p[field];
  const fromDocs = (field: PrefillField) =>
    prefill[field] !== undefined && prefill[field] === current(field);
  const label = (text: string, field?: PrefillField): ReactNode => (
    <>
      {text}
      {field && fromDocs(field) && <FromDocumentsBadge />}
    </>
  );

  const panMasked = isMaskedPan(p.pan);
  const panError =
    p.pan && !panMasked && !panLooksValid(p.pan)
      ? t('eligibility.profile.panInvalid')
      : null;
  const mobileError =
    p.mobile && !mobileLooksValid(p.mobile)
      ? t('eligibility.profile.mobileInvalid')
      : null;
  const pincodeError =
    p.pincode && !pincodeLooksValid(p.pincode)
      ? t('eligibility.profile.pincodeInvalid')
      : null;
  const dobError = isFutureDate(p.dob)
    ? t('eligibility.profile.dateInPast')
    : null;
  const sameAddress =
    !!p.current_address && p.current_address === p.permanent_address;
  const today = localToday();

  return (
    <div className="space-y-3">
      <section
        className={SECTION_CLASS}
        aria-label={t('eligibility.profile.personal')}
      >
        <SectionTitle>{t('eligibility.profile.personal')}</SectionTitle>
        <div className="grid grid-cols-1 gap-2 @md:grid-cols-2">
          <Field
            label={label(t('eligibility.profile.pan'), 'pan')}
            hint={panMasked ? t('eligibility.profile.panMasked') : undefined}
            error={panError}
          >
            {({ id, describedBy }) => (
              <input
                id={id}
                type="text"
                value={p.pan ?? ''}
                onChange={(e) => patch({ pan: e.target.value.toUpperCase() })}
                // A masked PAN stays as the documents gave it.
                readOnly={panMasked}
                maxLength={10}
                autoComplete="off"
                spellCheck={false}
                aria-describedby={describedBy}
                aria-invalid={panError ? true : undefined}
                disabled={disabled}
                className={`${CONTROL_CLASS} font-mono uppercase`}
                data-testid="profile-pan"
              />
            )}
          </Field>
          <Field label={label(t('eligibility.profile.name'), 'name')}>
            {({ id }) => (
              <input
                id={id}
                type="text"
                value={p.name ?? ''}
                onChange={(e) => patch({ name: e.target.value })}
                maxLength={200}
                autoComplete="off"
                disabled={disabled}
                className={CONTROL_CLASS}
                data-testid="profile-name"
              />
            )}
          </Field>
          <Field label={t('eligibility.profile.mobile')} error={mobileError}>
            {({ id, describedBy }) => (
              <input
                id={id}
                type="tel"
                inputMode="tel"
                value={p.mobile ?? ''}
                onChange={(e) => patch({ mobile: e.target.value })}
                maxLength={16}
                autoComplete="off"
                aria-describedby={describedBy}
                aria-invalid={mobileError ? true : undefined}
                disabled={disabled}
                className={CONTROL_CLASS}
              />
            )}
          </Field>
          <Field
            label={label(t('eligibility.profile.dob'), 'dob')}
            error={dobError}
          >
            {({ id, describedBy }) => (
              <input
                id={id}
                type="date"
                value={p.dob ?? ''}
                min="1900-01-01"
                max={today}
                onChange={(e) => patch({ dob: e.target.value || null })}
                aria-describedby={describedBy}
                aria-invalid={dobError ? true : undefined}
                disabled={disabled}
                className={CONTROL_CLASS}
              />
            )}
          </Field>
          <Segmented<HouseOwnership>
            name={`${groupName}-house`}
            legend={t('eligibility.profile.houseOwnership')}
            showLegend
            options={HOUSE_OWNERSHIP.map((value) => ({
              value,
              label: t(`eligibility.profile.house.${value}`),
            }))}
            value={p.house_ownership}
            onChange={(value) => patch({ house_ownership: value })}
            disabled={disabled}
            testId="house-ownership"
          />
          <Field
            label={
              <>
                <MapPin className="h-3 w-3" aria-hidden="true" />
                {t('eligibility.profile.pincode')}
              </>
            }
            error={pincodeError}
          >
            {({ id, describedBy }) => (
              <div className="flex gap-1.5">
                <input
                  id={id}
                  type="text"
                  inputMode="numeric"
                  value={p.pincode ?? ''}
                  onChange={(e) =>
                    patch({ pincode: e.target.value.replace(/\D/g, '') })
                  }
                  maxLength={6}
                  autoComplete="off"
                  aria-describedby={describedBy}
                  aria-invalid={pincodeError ? true : undefined}
                  disabled={disabled}
                  className={`${CONTROL_CLASS} tabular-nums`}
                  data-testid="profile-pincode"
                />
                {onCheckPincode && (
                  <button
                    type="button"
                    onClick={onCheckPincode}
                    disabled={
                      disabled ||
                      !p.pincode ||
                      !pincodeLooksValid(p.pincode) ||
                      pincodeCheck?.loading
                    }
                    className={`${BUTTON_CLASS} flex-shrink-0 whitespace-nowrap`}
                  >
                    {t('eligibility.profile.checkAvailability')}
                  </button>
                )}
              </div>
            )}
          </Field>
        </div>
        {pincodeCheck && (
          <PolicyCheckResult
            check={pincodeCheck}
            current={p.pincode ?? ''}
            testId="pincode-check"
          />
        )}
        <div className="grid grid-cols-1 gap-2 @md:grid-cols-2">
          <Field label={t('eligibility.profile.currentAddress')}>
            {({ id }) => (
              <textarea
                id={id}
                rows={2}
                value={p.current_address ?? ''}
                onChange={(e) => {
                  const value = e.target.value;
                  patch(
                    sameAddress
                      ? { current_address: value, permanent_address: value }
                      : { current_address: value },
                  );
                }}
                maxLength={300}
                disabled={disabled}
                className={`${CONTROL_CLASS} resize-y`}
              />
            )}
          </Field>
          <Field label={t('eligibility.profile.permanentAddress')}>
            {({ id }) => (
              <div className="space-y-1">
                <textarea
                  id={id}
                  rows={2}
                  value={p.permanent_address ?? ''}
                  onChange={(e) => patch({ permanent_address: e.target.value })}
                  maxLength={300}
                  readOnly={sameAddress}
                  disabled={disabled}
                  className={`${CONTROL_CLASS} resize-y`}
                />
                <label className="flex items-center gap-1.5 text-[10px] text-slate-600 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={sameAddress}
                    onChange={(e) =>
                      patch({
                        permanent_address: e.target.checked
                          ? p.current_address
                          : null,
                      })
                    }
                    disabled={disabled || !p.current_address}
                    className="h-3 w-3 rounded accent-indigo-600"
                  />
                  {t('eligibility.profile.sameAsCurrent')}
                </label>
              </div>
            )}
          </Field>
        </div>
      </section>

      <section
        className={SECTION_CLASS}
        aria-label={t('eligibility.profile.employment')}
      >
        <SectionTitle>{t('eligibility.profile.employment')}</SectionTitle>
        <div className="grid grid-cols-1 gap-2 @md:grid-cols-2">
          <Field
            label={
              <>
                <Building2 className="h-3 w-3" aria-hidden="true" />
                {label(t('eligibility.profile.company'), 'company')}
              </>
            }
          >
            {({ id }) => (
              <div className="flex gap-1.5">
                <input
                  id={id}
                  type="text"
                  value={p.company ?? ''}
                  onChange={(e) => patch({ company: e.target.value })}
                  maxLength={200}
                  autoComplete="off"
                  disabled={disabled}
                  className={CONTROL_CLASS}
                  data-testid="profile-company"
                />
                {onCheckCompany && (
                  <button
                    type="button"
                    onClick={() => onCheckCompany()}
                    disabled={
                      disabled || !p.company?.trim() || companyCheck?.loading
                    }
                    className={`${BUTTON_CLASS} flex-shrink-0 whitespace-nowrap`}
                  >
                    {t('eligibility.profile.checkCategory')}
                  </button>
                )}
              </div>
            )}
          </Field>
          <Field
            label={label(
              t('eligibility.profile.employmentType'),
              'employment_type',
            )}
          >
            {({ id }) => (
              <select
                id={id}
                value={p.employment_type ?? ''}
                onChange={(e) =>
                  patch({
                    employment_type: (e.target.value ||
                      null) as EligibilityProfile['employment_type'],
                  })
                }
                disabled={disabled}
                className={CONTROL_CLASS}
                data-testid="profile-employment-type"
              >
                <option value="">{t('eligibility.select')}</option>
                {EMPLOYMENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`eligibility.profile.employmentTypes.${type}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        {companyCheck && (
          <PolicyCheckResult
            check={companyCheck}
            current={p.company ?? ''}
            testId="company-check"
            onPick={
              onCheckCompany
                ? (name) => {
                    patch({ company: name });
                    onCheckCompany(name);
                  }
                : undefined
            }
          />
        )}
        <Field
          label={label(t('eligibility.profile.netIncome'), 'net_income')}
          hint={
            fromDocs('net_income')
              ? incomeSource
                ? t('eligibility.profile.netIncomeSource', {
                    source: incomeSource,
                  })
                : t('eligibility.profile.netIncomeFromDocuments')
              : t('eligibility.profile.netIncomeHint')
          }
          className="@md:w-1/2 @md:pr-1"
        >
          {({ id, describedBy }) => (
            <NumberInput
              id={id}
              value={p.net_income}
              onChange={(v) => patch({ net_income: v })}
              describedBy={describedBy}
              disabled={disabled}
              testId="profile-net-income"
            />
          )}
        </Field>
      </section>

      <OtherIncomeSection
        rows={p.other_income}
        onEdit={onEdit}
        disabled={disabled}
      />

      <section
        className={SECTION_CLASS}
        aria-label={t('eligibility.profile.loan')}
      >
        <SectionTitle>{t('eligibility.profile.loan')}</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          <Field
            label={label(t('eligibility.profile.loanAmount'), 'loan_amount')}
          >
            {({ id }) => (
              <NumberInput
                id={id}
                value={inputs.loan.amount}
                onChange={(v) => onEdit((i) => setLoan(i, { amount: v }))}
                disabled={disabled}
                testId="loan-amount"
              />
            )}
          </Field>
          <Field
            label={label(t('eligibility.profile.tenure'), 'tenure_months')}
            hint={t('eligibility.profile.tenureHint')}
          >
            {({ id, describedBy }) => (
              <NumberInput
                id={id}
                kind="count"
                value={inputs.loan.tenure_months}
                onChange={(v) =>
                  onEdit((i) => setLoan(i, { tenure_months: v }))
                }
                describedBy={describedBy}
                disabled={disabled}
                testId="loan-tenure"
              />
            )}
          </Field>
        </div>
      </section>
    </div>
  );
}

function OtherIncomeSection({
  rows,
  onEdit,
  disabled,
}: {
  rows: OtherIncome[];
  onEdit: Edit;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const patch = (index: number, next: Partial<OtherIncome>) =>
    onEdit((i) => updateOtherIncome(i, index, next));
  return (
    <section
      className={SECTION_CLASS}
      aria-label={t('eligibility.profile.otherIncome')}
    >
      <div className="flex items-center gap-2">
        <SectionTitle>{t('eligibility.profile.otherIncome')}</SectionTitle>
        <button
          type="button"
          onClick={() => onEdit((i) => addOtherIncome(i))}
          disabled={disabled || rows.length >= MAX_OTHER_INCOME}
          className={`${BUTTON_CLASS} ml-auto`}
        >
          <Plus className="h-3 w-3" aria-hidden="true" />
          {t('eligibility.profile.addOtherIncome')}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          {t('eligibility.profile.otherIncomeEmpty')}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((row, index) => {
            const typeLabel = t(`eligibility.profile.incomeTypes.${row.type}`);
            return (
              <li
                key={row.key ?? index}
                className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-1.5"
                data-testid="other-income"
              >
                <Field label={t('eligibility.profile.incomeType')}>
                  {({ id }) => (
                    <select
                      id={id}
                      value={row.type}
                      onChange={(e) =>
                        patch(index, {
                          type: e.target.value as OtherIncome['type'],
                        })
                      }
                      disabled={disabled}
                      className={CONTROL_CLASS}
                    >
                      {OTHER_INCOME_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {t(`eligibility.profile.incomeTypes.${type}`)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                {row.type === 'rented' ? (
                  <Field label={t('eligibility.profile.agreement')}>
                    {({ id }) => (
                      <select
                        id={id}
                        value={row.agreement ?? ''}
                        onChange={(e) =>
                          patch(index, {
                            agreement: (e.target.value ||
                              null) as OtherIncome['agreement'],
                          })
                        }
                        disabled={disabled}
                        className={CONTROL_CLASS}
                      >
                        <option value="">{t('eligibility.select')}</option>
                        {RENT_AGREEMENTS.map((a) => (
                          <option key={a} value={a}>
                            {t(`eligibility.profile.agreements.${a}`)}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                ) : incomeHasFrequency(row.type) ? (
                  <Field label={t('eligibility.profile.frequency')}>
                    {({ id }) => (
                      <select
                        id={id}
                        value={row.frequency ?? ''}
                        onChange={(e) =>
                          patch(index, {
                            frequency: (e.target.value ||
                              null) as OtherIncome['frequency'],
                          })
                        }
                        disabled={disabled}
                        className={CONTROL_CLASS}
                      >
                        <option value="">{t('eligibility.select')}</option>
                        {INCOME_FREQUENCIES.map((f) => (
                          <option key={f} value={f}>
                            {t(`eligibility.profile.frequencies.${f}`)}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                ) : (
                  <p className="pb-2 text-[10px] text-slate-400">
                    {t('eligibility.profile.perMonth')}
                  </p>
                )}
                <Field
                  label={
                    row.type === 'rented' || row.type === 'pension'
                      ? t('eligibility.profile.amountPerMonth')
                      : t('eligibility.profile.amount')
                  }
                >
                  {({ id }) => (
                    <NumberInput
                      id={id}
                      value={row.amount}
                      onChange={(v) => patch(index, { amount: v })}
                      disabled={disabled}
                    />
                  )}
                </Field>
                <button
                  type="button"
                  onClick={() => onEdit((i) => removeOtherIncome(i, index))}
                  disabled={disabled}
                  className="mb-0.5 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50 dark:hover:bg-red-900/20"
                  aria-label={t('eligibility.profile.removeOtherIncome', {
                    type: typeLabel,
                    number: index + 1,
                  })}
                  title={t('eligibility.profile.removeOtherIncome', {
                    type: typeLabel,
                    number: index + 1,
                  })}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-[10px] leading-snug text-slate-500 dark:text-slate-400">
        {t('eligibility.profile.otherIncomeNote')}
      </p>
    </section>
  );
}
