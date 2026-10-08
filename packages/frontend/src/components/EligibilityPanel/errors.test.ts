// @vitest-environment node
// A 422 of POST .../eligibility/calculate (FastAPI's detail [{loc, msg}]):
// the form field it refused, so the "Before you check" box can name it.
import { ApiError } from '../../lib/apiError';
import { invalidInput } from './errors';

const refused = (loc: unknown[], msg: string) =>
  new ApiError(422, [{ type: 'value_error', loc, msg, input: 'typed value' }]);

describe('invalidInput: the field a 422 refused', () => {
  it.each<[unknown[], string, string | null, string | null]>([
    [
      ['body', 'inputs', 'profile', 'pincode'],
      'Value error, must be a 6-digit pincode',
      'pincode',
      'must be a 6-digit pincode',
    ],
    [
      ['body', 'inputs', 'profile', 'company'],
      'String should have at most 200 characters',
      'company',
      null,
    ],
    [
      ['body', 'inputs', 'profile', 'other_income', 0, 'amount'],
      'Input should be greater than or equal to 0',
      'other_income.1',
      null,
    ],
    [
      ['body', 'inputs', 'cibil', 'score'],
      'Value error, must be 300 to 900, or -1 / 0 for no credit history',
      'score',
      'must be 300 to 900, or -1 / 0 for no credit history',
    ],
    [
      ['body', 'inputs', 'cibil', 'enquiries'],
      'Value error, enquiries are cumulative: d30 (5) cannot be more than d60 (2)',
      'enquiries',
      'enquiries are cumulative: d30 (5) cannot be more than d60 (2)',
    ],
    [
      ['body', 'inputs', 'cibil', 'enquiries', 'd30'],
      'Input should be less than or equal to 999',
      'enquiries.d30',
      null,
    ],
    [
      ['body', 'inputs', 'cibil', 'tradelines', 1, 'emi'],
      'Input should be a finite number',
      'tradelines.2.emi',
      null,
    ],
    [
      ['body', 'inputs', 'cibil', 'tradelines', 2],
      'Value error, last_payment_date is before open_date',
      'tradelines.3',
      'last_payment_date is before open_date',
    ],
    [
      ['body', 'inputs', 'loan', 'amount'],
      'Input should be less than or equal to 1000000000',
      'loan_amount',
      null,
    ],
    [
      ['body', 'inputs', 'loan', 'tenure_months'],
      'Input should be greater than or equal to 1',
      'tenure_months',
      null,
    ],
    [
      ['body', 'applicant'],
      'String should have at most 200 characters',
      null,
      null,
    ],
  ])('%j -> %s', (loc, msg, field, message) => {
    expect(invalidInput(refused(loc, msg))).toEqual({ field, message });
  });

  it('is null for any other error, and names nothing without a detail', () => {
    expect(invalidInput(new ApiError(503))).toBeNull();
    expect(invalidInput(new Error('Failed to fetch'))).toBeNull();
    expect(invalidInput(new ApiError(422))).toEqual({
      field: null,
      message: null,
    });
    expect(invalidInput(new ApiError(422, 'Unprocessable'))).toEqual({
      field: null,
      message: null,
    });
  });
});
