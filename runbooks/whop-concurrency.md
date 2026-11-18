# Run Whop payment races on Convex

Use a fresh, disposable **dev** deployment with synthetic data. Never point the
runner at production, a shared dev deployment, or a deployment restored from
a backup. The production deployment name is `usable-guineapig-697`. The
runner rejects that substring in the requested, resolved and proof upload URLs.

## Create the deployment

1. Use Node 24 and install the checkout's locked dependencies with
   `pnpm install --frozen-lockfile`. Log in to the Convex CLI with your
   developer account.
2. In a development-only Convex project, create a dev deployment with an
   expiration. For example, run
   `npx convex deployment create dev/whop-race --type dev --expiration "in 7 days"`.
   Record the canonical deployment name from the output, such as
   `lively-jay-123`.
3. On that deployment, set the required variables from
   [convex/convex.config.ts](../convex/convex.config.ts) to synthetic values.
   Set `POSTHOG_PROJECT_TOKEN` to `disabled`. Use the test identity flags
   supplied by the runner. Leave external integrations disconnected.
4. Load this checkout's functions and schema with
   `npx convex dev --once --deployment <name>`. Check the target in the
   CLI output before proceeding.

## Seed the fixture

The testing helpers can inspect the tenant, users and booking results. They
cannot create the test tenant, enable Billing Ops, or create the fake event
type. In the isolated deployment's Data tab, add the following five documents.
Substitute the IDs assigned by Convex. Use only the values and email addresses
below. The runner checks the seed counts before it writes.

In `tenants`:

```json
{
  "companyName": "Whop race fixture",
  "contactEmail": "whop-race@example.com",
  "workosOrgId": "org_whop_race_fixture",
  "status": "active",
  "billingOpsEnabled": true,
  "businessDayAppliedVersion": 0,
  "inviteExpiresAt": 0,
  "createdBy": "whop-concurrency-run"
}
```

In `users`, add the owner and closer as separate documents:

```json
{
  "tenantId": "<tenant ID>",
  "workosUserId": "user_whop_race_owner",
  "email": "whop-owner@example.com",
  "role": "tenant_master",
  "isActive": true
}
```

```json
{
  "tenantId": "<tenant ID>",
  "workosUserId": "user_whop_race_closer",
  "email": "whop-closer@example.com",
  "role": "closer",
  "isActive": true,
  "calendlyUserUri": "https://api.calendly.com/users/whop-race-fixture"
}
```

In `tenantPrograms`:

```json
{
  "tenantId": "<tenant ID>",
  "name": "Race training",
  "normalizedName": "race training",
  "createdByUserId": "<owner ID>",
  "createdAt": 0,
  "updatedAt": 0
}
```

In `eventTypeConfigs`:

```json
{
  "tenantId": "<tenant ID>",
  "calendlyEventTypeUri": "https://api.calendly.com/event_types/whop-race-fixture",
  "displayName": "Race fixture booking",
  "bookingProgramId": "<program ID>",
  "bookingProgramName": "Race training",
  "bookingProgramMappingStatus": "mapped",
  "createdAt": 0
}
```

The runner injects synthetic Calendly receipts into the existing booking
mutation and uses a fake Whop sandbox key. It holds the sweep lease during
the run and stores canonical Whop reads directly. No external provider
account is needed. The signed HTTP route is
covered by the money-conservation test.

## Run and read the results

From the checkout, use the canonical dev deployment name:

```sh
node scripts/whop-concurrency-run.mjs \
  --deployment <name> \
  --i-understand-this-writes-test-rows \
  --rounds 3
```

The runner defaults to three rounds and accepts two to ten. Each round uses
fresh bookings and payment IDs. It submits each pair of mutations
concurrently through separate CLI processes. Convex decides the commit order.

| Race | Passing outcomes |
| --- | --- |
| Store vs meeting payment, reminder payment, side-deal payment or additional payment | The save commits first and Billing links its row, or the save prompts and the retry links its row. |
| Billing vs closer confirmation | One CRM payment counts. The second caller may receive a retry result, stale preview or a Whop conflict. |
| Two exclusions with one fingerprint | Both return the same correction ID. One applies and the other reports an already-applied request. The excluded payment stops counting. |
| Exclusion vs restore | A fresh exclusion fingerprint is unavailable while the row is disputed. The runner races that stale exclusion against the restore. The exclusion refuses and the restore puts one counting row back. |

The runner checks every test payment's active allocation and every deal's
cash, outcome and first-payment clock after each race. An unallocated Whop
fact is expected immediately after intake, before manual reconciliation, and
while its payment is excluded. Each completed round ends with exactly one
counting CRM payment per paid Whop fact.

A failure prints the input pair's outcome and exits nonzero. Review the dev
function logs for the failing pair. A prompted writer or stale refusal in the table is an expected
outcome when the subsequent database checks pass.

The runner attempts cleanup on success and failure. Cleanup uses
`testing/operationalData:resetOperationalData`, which deletes the isolated
deployment's tenant and seed documents as well as its operational rows. The
runner also clears the search projection and checks for proof files left in
storage. After the run, discard the disposable deployment in the Convex
dashboard. If cleanup fails or the process is interrupted, verify that the
deployment contains only synthetic data before discarding it.
