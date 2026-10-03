# Credit bureau providers

The CIBIL tab of the Eligibility panel has a **Fetch credit report** button. It pulls the applicant's
credit report from a bureau, with the applicant's consent, and fills the tab's CIBIL block (score,
enquiries and loans) exactly as an uploaded credit report PDF does. No real bureau is connected yet.
This page explains what exists today and how to plug in a paid, consent-based bureau API later.

## What exists today

| Piece | Where |
|---|---|
| Provider interface `BureauProvider`, providers `none` and `mock`, the normalized report | `packages/backend/app/bureau.py` |
| API: `GET /projects/{id}/eligibility/bureau`, `POST /projects/{id}/eligibility/bureau/fetch` | `packages/backend/app/routers/bureau.py` |
| The button, the consent box and the result on the CIBIL tab | `packages/frontend/src/components/EligibilityPanel/BureauFetch.tsx` |
| The setting (CDK context `bureauProvider` -> env `BUREAU_PROVIDER`) | `packages/common/constructs/src/app/bureau-config.ts` |

The setting chooses the provider:

- `none` (default): no bureau is connected. The button is shown disabled, with the reason: upload
  the applicant's credit report PDF, or type the values.
- `mock`: SAMPLE reports for the three demo applicants (Rahul Vijay Deshmukh `BQXPD4821K`, Sneha
  Anil Kulkarni `CKRPK7314M`, Amit Suresh Patil `DMVPP5928L`). They have the same accounts and
  enquiries as their synthetic credit report PDFs, and are dated the day of the pull. Any other
  PAN, or a date of birth that is not the applicant's, returns "no record". Amit's application
  form carries the PAN typo `DMVPP5926L`, so a pull with that PAN shows the no-record path. No
  bureau is called. The tab labels these reports SAMPLE.

To deploy the demo with the mock bureau:

```bash
deploy/lean/deploy.sh --context bureauProvider=mock
```

Once this code is live, switching the setting only changes the backend function's environment, so a
hotswap deploy is enough (`--hotswap --context bureauProvider=mock`). Deploy without the flag to
switch back to `none`.

## How a pull works

1. The user ticks "The applicant has consented to this credit report pull", picks how the consent
   was taken (OTP to the applicant's mobile, signed consent form or recorded call), optionally
   types its reference, and clicks **Fetch credit report**.
2. The backend checks the provider is connected (503 if not), checks that consent is given (400),
   and works out the PAN: the form's full PAN, otherwise the applicant's own PAN. A masked or full
   PAN on the form that is not the applicant's is refused with 400.
3. **The consent is logged before the pull.** Without a stored consent there is no pull (502). The
   item is `PK = PROJ#{project}`, `SK = BUREAUPULL#{timestamp}#{consent_id}`. It holds the method,
   purpose, reference, the user who recorded the consent, the provider, the applicant key (the
   SHA-256 key the saved eligibility inputs use, not the PAN), the masked PAN (`XXXXXX821K`), the
   outcome (`requested`, then `fetched`, `no_record` or `failed`) and `expires_at` = now + the
   retention period (DynamoDB TTL, 7 days). It holds no name, date of birth, mobile or report data.
4. The provider's `fetch_report(consent, pan, name, dob, mobile)` returns the normalized report, or
   `None` (no record).
5. The backend reads the report into the CIBIL block the same way it reads an uploaded credit
   report. Active loans become Obligate and closed ones Close. Only the last 4 characters of an
   account number are kept, and values the page refuses are dropped, with a note. The block is
   marked `source: "bureau"` and carries the report date.
6. The page puts the block in the form (after asking, if the tab already holds values). **Nothing
   is saved** until the user saves the form. Saved inputs expire 7 days after the first save, like
   every other input.

The process allows one pull per applicant every 10 seconds (429 otherwise), so a double click
cannot pull, and pay for, a report twice. The applicant erase does not delete the consent log:
it holds no applicant data beyond the hashed key and the PAN's last 4 characters, and it expires
after 7 days.

## The interface

```python
class BureauProvider(ABC):
    name: str            # the setting's value, e.g. "acme"
    label: str           # shown in the API's status
    sample: bool = False # True only for synthetic reports

    def fetch_report(self, consent: Consent, pan: str, name: str | None,
                     dob: datetime.date | None, mobile: str | None) -> dict | None: ...
```

- `consent`: `consent_id`, `method` (`otp`, `signed_form`, `recorded_call`), `purpose`,
  `reference`, `recorded_at` (UTC) and `recorded_by` (the DSA user). Send what the vendor asks for,
  usually the consent id, the time and the purpose.
- `pan`: a full PAN in upper case, already checked to be the applicant's. `name`, `dob` (a date)
  and `mobile` (10 digits) come from the Profile tab when they are filled in.
- Return the **normalized report**: the fields the credit-report reader writes for an uploaded
  report (`packages/infra/src/functions/step-functions/document-facts`, `doc_type credit_report`).

| Field | Type | Notes |
|---|---|---|
| `applicant_name` | str | as the bureau holds it (the page notes a different name) |
| `pan` | str | |
| `bureau` | `CIBIL` / `Experian` / `Equifax` / `CRIF` / None | |
| `report_date` | `YYYY-MM-DD` | not in the future |
| `credit_score` | number 300-900, or None | None or <= 0 means no credit history |
| `enquiries_30d`, `_60d`, `_90d`, `_120d` | int | cumulative: 30d <= 60d <= 90d <= 120d |
| `enquiries` | `[{date, lender, purpose}]` | optional detail |
| `tradelines` | list, see below | at most 50 are read |

Each tradeline: `loan_type` (`personal_loan`, `home_loan`, `mortgage_loan`, `car_loan` (also
two-wheeler and auto loans), `education_loan`, `application_loan`, `consumer_loan`,
`credit_card` or `other`), `lender`, `sanction_amount` (a card's credit limit), `outstanding`,
`emi` (only when the bureau gives one), `status` (`active`, `closed`, `written_off`, `settled`,
`other`), `account_last4` (**never more than the last 4 characters**), `overdue`, `emis_paid`,
`emis_pending`, `open_date`, `last_payment_date`.

- Return `None` when the bureau has no record (no hit, or the identity did not match). The page
  says so and the CIBIL block is left unchanged.
- Raise `BureauError("...")` when the bureau cannot answer (timeout, 5xx, bad credentials). The
  API answers 502 with that message, so keep it short, and never put a PAN, a name or a raw
  response in it.

## Plugging in a paid consent-based API

1. **Pick the route to the data.** A DSA is not a credit institution. A bureau report usually
   reaches it either through a lender partner's API (the lender is the bureau member and pulls on
   its own account) or through a consent-based product that a credit information company, or a
   licensed aggregator, offers to non-members. India's four credit information companies are
   TransUnion CIBIL, Experian, Equifax and CRIF High Mark. Check with the vendor and your lender
   partners which route applies to you, and get legal sign-off on the consent wording and the
   purpose before going live.
2. **Write the provider.** Add `class AcmeBureau(BureauProvider)` (in `app/bureau.py`, or in its
   own module `app/bureau_acme.py`) and register it: `PROVIDERS["acme"] = AcmeBureau`. Map the
   vendor's answer to the normalized report above, and keep only what the table lists. Use the
   same vocabulary as the reader: a "Two-wheeler loan" is `car_loan`, "Open" or "Current" is
   `active`, "Written-off" is `written_off`, and the account number becomes its last 4 characters.
3. **Credentials.** Put the API key or client certificate in AWS Secrets Manager (one secret per
   DSA once the app is multi-tenant, see `docs/multi-tenant-design.md`). Allow the backend role
   `secretsmanager:GetSecretValue` on that secret only, in the `Backend` construct. Read the
   secret at call time. Never put it in an environment variable, a log line or the repository.
4. **Allow the setting.** Add `'acme'` to `BUREAU_PROVIDERS` in
   `packages/common/constructs/src/app/bureau-config.ts`, then deploy with
   `--context bureauProvider=acme`.
5. **Consent the vendor's way.** If the vendor needs its own consent step (for example an OTP it
   sends to the applicant's mobile and the app must verify before the pull), add that step to
   `BureauFetch.tsx`. Pass the vendor's consent id as the consent `reference`, so it is logged.
   Keep the existing rule: no logged consent, no pull.
6. **Network.** The API Gateway answers after 30 seconds, so give the vendor call a timeout of
   about 20 seconds. Do **not** retry a pull automatically: each pull may be billed and may count
   as an enquiry on the applicant's report. Raise `BureauError` and let the user try again.
7. **Data minimisation and retention.** Do not store the vendor's raw response (no S3 copy, no
   DynamoDB item, no log line). The normalized block is kept only when the user saves the form,
   and then for 7 days like every other input. Only a model the AWS account sells in ap-south-1
   may ever read report data. A bureau pull needs no model at all.
8. **Tests.** Unit-test the mapping with synthetic vendor responses (made-up names and PANs, as in
   `packages/backend/tests/test_bureau.py`): a full report, a no-hit, an identity mismatch, a
   timeout and a malformed answer. Never put a real report in a test.
9. **Go live.** Deploy to a test stack first, pull a report for a staff member who consented, and
   compare it with that person's own report. Then switch the demo or production setting.

## Status codes of `POST .../eligibility/bureau/fetch`

| Code | When |
|---|---|
| 200 | `found: true` with `cibil`, or `found: false` (no record) |
| 400 | consent not given, no full PAN, or a PAN that is not the applicant's |
| 404 | unknown project |
| 422 | malformed request (unknown consent method, bad reference, bad mobile or date) |
| 429 | the applicant's report was pulled in the last 10 seconds |
| 502 | the consent could not be logged (nothing was pulled), or the bureau failed |
| 503 | no bureau connected (provider `none`) |
