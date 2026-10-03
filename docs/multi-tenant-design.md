# Multi-tenant SaaS design

Status: design only. No code implements this yet. Written 2026-10-03 against the live code (branch
`lean`).

## 1. Goal

- **One tenant per DSA.** A tenant is one loan DSA firm. Each DSA sees only its own projects,
  documents, applicants, lists, grids, settings and usage.
- **Sold per user inside the CRM.** The DSA buys seats in the Smart Dial CRM. The CRM creates the
  tenant and its users in this app, and keeps the bill. This app enforces the seat count and
  reports usage per user back to the CRM.
- The rules that apply today still apply, per tenant. Nothing is kept longer than 7 days (a
  tenant may choose fewer, never more). The app uses AWS-billed services in ap-south-1 only, with
  synthetic data in demos. Consent, erasure and audit work per tenant.
- **Pooled model.** Every tenant shares the same stacks, with a tenant partition key everywhere.
  A large DSA could later get its own stack (silo model) from the same code. That stack would
  hold a single tenant.

## 2. Today: one tenant, and what has to change

| Area | Today | Why it matters |
|---|---|---|
| Sign-in | One Cognito user pool, shared with the voice bot. The identity pool gives the browser IAM credentials. The HTTP API uses an IAM (SigV4) authorizer. | Every signed-in user can call every route. |
| Caller identity | The web app sends the Cognito username in `x-user-id`. It is an audit label, not verified. | It can never be used for access. |
| Project list | `GSI1PK = "PROJECTS"`. Every user sees every project. | This is the main leak to close. |
| DynamoDB (one table) | `PROJ#{p}` with `META`, `DOC#`, `FACTS#`, `ELIG#`, `LOGINREQ#`, `REFDATA#`, `FCASK#`, `FCCONF#`, `WHDLV#`, `ERASE#`, `DATASET#`, `BUREAUPULL#`. Also `DOC#{d}` / `WEB#{d}` -> `WF#{w}`, `WF#{w}` -> `STEP`, `SEG#`, `ART#{a}`, `USERSUB#{sub}`. GSI1: `PROJECTS`, `PROJ#{p}#DOC`, `USR#{u}#ART`, `STEP#ANALYSIS_STATUS`. GSI2: `USR#{u}#PROJ#{p}#ART`. | Keys carry a project or a user, never a tenant. |
| S3 | Documents under `projects/{p}/documents/{d}/...`. Chat sessions under `sessions/{u}/{p}/session_{s}/...`. Agents and artifacts under `{u}/{p}/agents/...`. Prompts and built-in agents under `__prompts/...` (one set for all). | Prefixes carry no tenant. |
| LanceDB | S3 Express directory bucket, one table per project id, a lock table in DynamoDB. | Table names carry no tenant. |
| Pipeline | The EventBridge upload rule matches `projects/*/documents/*/*/*`. Step Functions, document facts, the file check, webhook delivery, the retention sweeper, the LanceDB service, and the AgentCore agent (which reads S3 with its own role). | Each one must carry the tenant. |
| Settings | Webhook URL and secret per project (META). Reference lists per project (`REFDATA#`, 7-day TTL). Lender policies are a SAMPLE file in the image. The bureau provider is one setting for the whole stack. | DSA-level settings belong to the tenant. |
| Usage | The Ask ledger `FCASK#` per project (tokens and cost) drives the Ask cap. | Nothing is metered per user yet. |

## 3. The tenant claim in Cognito

**Recommendation: an immutable custom attribute `custom:tenant_id`, and roles as groups.**

- `custom:tenant_id` (string, `mutable: false`) holds an opaque id such as `ten_7Qx2...`, never the
  DSA's name. Only the server sets it, through `AdminCreateUser` when the CRM provisions a user.
  Leave it out of the app client's write attributes, so a user can never change their own
  tenant.
- Roles are Cognito groups: `admin`, `handler` and `viewer` (the admin users page of batch 3).
  Groups are not used for the tenant: a user can be in several groups, and the tenant must be
  exactly one.
- One person who works for two DSAs gets two accounts (two email addresses).
- The voice bot shares the pool, so its users get the attribute too, and the bot's data paths get
  the same tenant prefix.
- Adding a custom attribute to an existing pool is allowed (attributes can be added, never changed
  or removed). Try the CloudFormation update on a copy of the pool first: replacing the pool would
  lose every user of the app and the voice bot.

### How the backend learns the tenant

Today the backend never sees a token: the browser signs requests with identity-pool credentials,
and API Gateway checks the signature.

- **Option A (recommended): a JWT authorizer.** Put the HTTP API routes behind a JWT authorizer on
  the user pool, and have the web app send the ID token (or an access token) as `Authorization:
  Bearer`. API Gateway verifies the token. The backend reads `sub`, `custom:tenant_id` and
  `cognito:groups` from `requestContext.authorizer.jwt.claims`. Custom attributes are in the ID
  token as they are. To add the tenant to the access token, use a pre-token-generation trigger
  (the pool already runs the Plus feature plan).
- **Option B: keep IAM.** Map `custom:tenant_id` to a principal tag of the identity pool role
  session ("attributes for access control"). The backend then reads the caller's identity from
  the request context, and looks the tenant up in the `USERSUB#{sub}` item, which the
  post-authentication trigger fills. It works, but has more moving parts.

Either way, a single FastAPI dependency `current_caller()` returns `(sub, tenant_id, role)` from
the verified context. Every router uses it. `x-user-id` stays an audit label only. The AgentCore
runtime is called from the browser too, so it needs the tenant from a verified source as well: its
inbound JWT authorization with the same user pool, or calls that go through the backend only. The
search and data MCP tools then take the tenant from the agent's context, never from the model.

### Tenant registry

`TENANT#{t}` / `META` holds the name, the status (`active`, `suspended`), the seats bought, the
CRM's account id and the creation time. It is account data with no applicant data in it. It lives
as long as the DSA is a customer, so it is outside the 7-day rule (owner to confirm, see section 9).

## 4. The partition key in every path

Rules:

1. Every key, prefix and table name starts with the tenant.
2. The tenant comes from the verified claim, never from a path, body, query or header.
3. One module (`app/tenancy.py`) builds every key, so a route cannot forget the tenant. A lint
   test fails on any `"PROJ#"` literal outside that module.
4. Tests check every route: another tenant's ids answer 404 (not 403, which would reveal that the
   id exists).

### DynamoDB (one shared table)

| Today | Multi-tenant |
|---|---|
| `PROJ#{p}` / `META`, `DOC#…`, `FACTS#…`, `ELIG#…` (every SK) | `TEN#{t}#PROJ#{p}` / same SKs |
| `GSI1PK = PROJECTS` | `GSI1PK = TEN#{t}#PROJECTS` |
| `GSI1PK = PROJ#{p}#DOC` | `TEN#{t}#PROJ#{p}#DOC` |
| `DOC#{d}` / `WEB#{d}` -> `WF#{w}` | `TEN#{t}#DOC#{d}` / `TEN#{t}#WEB#{d}` |
| `WF#{w}` / `STEP`, `SEG#{n}` | `TEN#{t}#WF#{w}` |
| `ART#{a}`; GSI1 `USR#{u}#ART`; GSI2 `USR#{u}#PROJ#{p}#ART` | `TEN#{t}#ART#{a}`; `TEN#{t}#USR#{u}#ART`; `TEN#{t}#USR#{u}#PROJ#{p}#ART` |
| `USERSUB#{sub}` / `META` | unchanged (global), plus `tenant_id` |
| GSI1 `STEP#ANALYSIS_STATUS` (system scan) | unchanged; the items carry `tenant_id` |
| (new) | `TENANT#{t}` / `META`, `SETTINGS`, `REFDATA#{kind}…`, `GRID#{lender}…`, `METER#{day}#…` |

Ids stay nanoids, unique on their own. The prefix is defence in depth. It also lets a later phase
give per-tenant Lambdas IAM conditions on `dynamodb:LeadingKeys`, starting with `TEN#{t}#`.

### S3

| Bucket | Today | Multi-tenant |
|---|---|---|
| Documents | `projects/{p}/documents/{d}/...` | `tenants/{t}/projects/{p}/documents/{d}/...` |
| Sessions | `sessions/{u}/{p}/session_{s}/...` | `tenants/{t}/sessions/{u}/{p}/session_{s}/...` |
| Agents and artifacts | `{u}/{p}/agents/...` | `tenants/{t}/{u}/{p}/agents/...` |
| Prompts | `__prompts/...` | `__prompts/...` as defaults, plus `tenants/{t}/__prompts/...` overrides |

- The upload rule's wildcard becomes `tenants/*/projects/*/documents/*/*/*`. The trigger reads the
  tenant from the key and puts it in the workflow input. Every workflow Lambda takes the tenant
  from its input and checks that each key it touches starts with it.
- The backend's presigned-URL checks (project prefix, artifact prefix) include the tenant.
- The 7-day lifecycle rules stay bucket-wide: one rule covers every tenant.

### LanceDB

- The table name becomes `{t}__{p}` (or one database path per tenant, `tenants/{t}/`). Every
  action of the LanceDB service takes the tenant and the project and builds the name itself. The
  search tool passes the verified tenant from the agent.
- The nightly optimize and the erase optimize run per tenant.

### Everything else

- Step Functions execution names and every log line carry the tenant id (never applicant data).
- Webhook secrets: keep one KMS key and add the encryption context `{"tenant": t}`, so one
  tenant's ciphertext cannot be decrypted as another's. The delivery Lambda passes the context.
  This is cheaper than one key per tenant.
- The retention sweeper loops over tenants with the same per-tenant rules (retention may be lower
  than 7 days for a tenant).

## 5. Per-tenant settings, lists and grids

`TENANT#{t}` / `SETTINGS`:

- `retention_days` from 1 to 7 (default 7, never above 7);
- the CRM webhook: URL and encrypted secret. Today they are per project; they become the tenant
  default, with an optional project override;
- the CRM launch-link secret (batch 3 section 2);
- the credit bureau: provider name and the ARN of its Secrets Manager secret
  (`docs/bureau-providers.md`). Every DSA has its own bureau contract;
- the Ask monthly cap, the enabled features and the seat count (from the CRM).

Lists and grids:

- Pincode serviceability, lender branches and company categories are uploaded per tenant. They use
  today's chunked `REFDATA#` format, under `TENANT#{t}`. A project may still override them.
- Lender grids (batch 3 section 5) are per tenant too: each DSA negotiates its own grids. The
  SAMPLE policy file in the image stays the default. An uploaded grid replaces it for that lender.
- Today lists expire after 7 days, so the DSA uploads them again every week. They hold lender,
  branch and company names only, no applicant data. Proposal: treat lists and grids as
  configuration, kept until replaced (owner to decide, section 9).

Within a tenant, the roles decide visibility. An `admin` sees every project and the settings. A
`handler` sees the projects they created or were assigned. A `viewer` has read-only access.

## 6. Per-user metering

- **Seats.** Active users can never exceed the seats bought: `AdminCreateUser`, or enabling a
  user, is refused once the seats are used up. Disabling a user frees a seat.
- **Meter events** (no applicant data in them): pages analysed, documents, file checks, Ask calls
  (tokens and cost, already recorded per project in `FCASK#`), agent chat tokens, voice minutes,
  bureau pulls (each pull is billed by the bureau), webhook deliveries, and storage (GB-days per
  tenant).
- **Storage of the meters.** One item per user, kind and day: `TENANT#{t}` / `METER#{yyyy-mm-dd}#{sub}#{kind}`,
  updated with an atomic `ADD`, with `expires_at` 7 days out.
- **Reporting.** A scheduled Lambda sends each tenant's per-user totals for yesterday to the CRM
  every day, as a signed webhook event `usage.daily` (the same signature scheme as every other
  delivery). The CRM keeps the bill, so this app never needs data older than 7 days.
- **Quotas.** The Ask cap moves from the project to the tenant, with an optional per-user cap.
  Bedrock quotas are shared across tenants, so the app throttles per tenant to keep one busy DSA
  from starving the others.
- **Cost per tenant.** Shared resources cannot carry a tenant tag, so the cost per tenant is
  estimated from the meters times the unit costs of `deploy/lean/COST.md`.

## 7. Migration of today's data

Today's data belongs to one DSA (the demo). The 7-day retention makes the migration small: most
data does not need to be copied, because it expires.

1. Create the tenant `ten_demo` in the registry. Set `custom:tenant_id` on every existing user of
   the pool with `AdminUpdateUserAttributes`, the voice bot's users included.
2. Deploy dual-read code. New writes go to tenant keys and prefixes only. Reads try the tenant key
   first, then the legacy key, for `ten_demo` only.
3. Copy the long-lived items once, with an idempotent script that has a dry-run mode: project
   `META` (with the webhook settings), custom agents, the `USERSUB#` items (adding the tenant),
   and the prompts. LanceDB tables of live projects are re-indexed under the new names
   (`deploy/lean/reindex.py`) or left to expire.
4. Drain the pipeline before the upload rule's prefix changes: no uploads for about 15 minutes,
   until no execution is running.
5. After 7 days the legacy documents, facts, sessions, artifacts, lists and eligibility items have
   expired (TTL, lifecycle rules and the sweeper). Remove the dual-read code, then the legacy
   upload rule.
6. Rollback: until step 5, the legacy read path is still there behind a flag, so the previous
   version can be redeployed.

## 8. Order of work

| # | Step | Size |
|---|---|---|
| 1 | Owner decisions (section 9) | S |
| 2 | Tenant claim: the custom attribute, role groups, tenant registry, and the CRM provisioning API (create a tenant, add, disable or enable a user, set seats; server to server, signed like the webhook) | M |
| 3 | Backend: `current_caller()` from the verified context, `app/tenancy.py` key builders, every `PROJ#` and GSI key through them, isolation tests on every router | L |
| 4 | Storage paths: S3 prefixes (presign checks, upload rule, workflow Lambdas, sweeper), LanceDB names | L |
| 5 | Agents: the verified tenant to AgentCore and to the search and data MCP tools | M |
| 6 | Tenant-level settings: webhook, launch link, bureau, lists and grids, retention | M |
| 7 | Metering, the daily `usage.daily` event, seat enforcement | M |
| 8 | Migration (section 7), cut-over, removal of the legacy reads after 7 days | M |
| 9 | Isolation and penetration test on a staging stack with two synthetic tenants, then the first paying DSA | M |

Steps 2 and 3 come first: until every route takes the tenant from a verified claim, no second DSA
can be onboarded.

## 9. Decisions for the owner

1. **JWT authorizer (option A) or IAM principal tags (option B).** A is recommended.
2. **Lists and grids**: configuration kept until replaced, or the 7-day rule as today. Keeping
   them is recommended: they hold no applicant data.
3. **Tenant registry and seats**: kept while the DSA is a customer. Needed, and it holds no
   applicant data.
4. **Meters**: 7 days in the app, with the CRM as the billing record (recommended), or a longer
   in-app history.
5. **One account per person per DSA**, or users shared across tenants (not recommended: it needs a
   tenant switcher and a much larger isolation test surface).
