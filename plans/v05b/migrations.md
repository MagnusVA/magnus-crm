# v0.5b Migration Runbook (Phases 2-6)

This runbook assumes the code through **Phase 6** is ready locally and that you
are preparing the production rollout.

Phase 6 is a **schema-narrowing deploy gate**, not a blind "deploy now" step.
Only deploy it to production after the preflight validation in this file passes
against the current production data.

## Short answer

The safe production path for Phase 6 is:

1. capture fresh production snapshots for the narrowed tables
2. validate that no documents still depend on the pre-Phase-6 shapes
3. run the local typecheck
4. run a Convex deploy dry run, then the real production deploy
5. re-run the audits and keep after snapshots as evidence

Phases **3** and **4** remain **code-only**. Phase **6** is the convergence
point where the earlier data migrations must already be true in production.

If the preflight finds any of the following, **stop and do not deploy Phase 6**:

- a tenant missing its `tenantCalendlyConnections` row
- any `paymentRecords` row missing `amountMinor`
- any document still carrying a field the narrowed schema removes

The rest of this file is the **full canonical Phase 2-6 runbook** so you have:

- the complete migration list in one place
- the exact `npx convex run` commands
- the direct-read `npx convex data` snapshot commands for before/after evidence
- the audit commands to verify the rollout

## What Changes In Phases 2-6

### Phase 2 — Backfill + Cleanup

These are the one-shot data migrations that populate the fields and tables added in Phase 1:

- backfill `meetingFormResponses` and `eventTypeFieldCatalog` from retained `rawWebhookEvents`
- backfill `leads.status`
- backfill `users.isActive`
- backfill `meetings.assignedCloserId`
- backfill `paymentRecords.amountMinor`
- backfill `paymentRecords.contextType`
- backfill `customers.totalPaidMinor`, `totalPaymentCount`, and `paymentCurrency`
- backfill `followUps.type`
- seed `tenantStats`
- deduplicate `eventTypeConfigs`
- audit for orphaned tenant rows, orphaned user references, and mixed currencies

### Phase 3 — Backend Mutation Updates

No standalone migration commands. This phase makes new writes keep the new model correct:

- mutations now emit `domainEvents`
- lifecycle and attribution fields are written during status changes
- `amountMinor` is dual-written for payments
- tenant stats are maintained going forward
- users are soft-deleted instead of hard-deleted

### Phase 4 — Backend Query Rewrites

No standalone migration commands. This phase switches reads to:

- use the new indexes
- read `tenantStats`
- read `amountMinor`
- read `meetings.assignedCloserId`
- rely on `users.isActive` and required lead status semantics

### Phase 5 — OAuth State Extraction

This introduced one one-shot backfill during the Phase 5 rollout:

- backfill `tenantCalendlyConnections` from the legacy OAuth fields still present on `tenants`

That backfill is what lets the new Phase 5 readers and writers stop depending on fallback reads from `tenants`, and it is the last data step before Phase 6 schema narrowing.

### Phase 6 — Schema Narrow

This phase removes the migration-era allowances after the earlier backfills are
already complete:

- `leads.status` is required
- `users.isActive` is required
- `meetings.assignedCloserId` is required
- `followUps.type` is required
- `paymentRecords.contextType` is required
- `paymentRecords.amount` is removed from the schema
- legacy Calendly OAuth fields are removed from `tenants`
- `leads.customFields` is hardened to `Record<string, string>`

## Preflight

### 1. Prepare the CLI identity for admin-gated migration functions

Most Phase 2 entrypoints in [`convex/admin/migrations.ts`](/Users/nimbus/dev/ptdom-crm/convex/admin/migrations.ts) require a CLI identity whose `organization_id` matches `SYSTEM_ADMIN_ORG_ID`.

```bash
export SYSTEM_ADMIN_ORG_ID="<your-system-admin-workos-org-id>"
export ADMIN_IDENTITY='{"subject":"migration-runner","organization_id":"'"$SYSTEM_ADMIN_ORG_ID"'"}'
```

### 2. Resolve the tenant id

The current production footprint is one active test tenant, so a manual lookup is fine:

```bash
npx convex data tenants --prod --limit 20 --format pretty
export TENANT_ID="<copy-the-active-tenant-_id>"
```

## Before / After Snapshot Commands

These are the direct database reads to preserve evidence before and after the migration run. With the current data footprint, `--limit 2000` is enough to capture the full contents of each relevant table.

### Before snapshots

```bash
mkdir -p .tmp/v05b-migrations/before .tmp/v05b-migrations/after

for table in \
  tenants \
  tenantCalendlyConnections \
  users \
  leads \
  opportunities \
  meetings \
  paymentRecords \
  customers \
  followUps \
  eventTypeConfigs \
  rawWebhookEvents \
  meetingFormResponses \
  eventTypeFieldCatalog \
  tenantStats
do
  npx convex data "$table" --prod --limit 2000 --order asc --format jsonArray \
    > ".tmp/v05b-migrations/before/${table}.json"
done
```

### After snapshots

Run the same direct reads again after the migration commands complete:

```bash
for table in \
  tenants \
  tenantCalendlyConnections \
  users \
  leads \
  opportunities \
  meetings \
  paymentRecords \
  customers \
  followUps \
  eventTypeConfigs \
  rawWebhookEvents \
  meetingFormResponses \
  eventTypeFieldCatalog \
  tenantStats
do
  npx convex data "$table" --prod --limit 2000 --order asc --format jsonArray \
    > ".tmp/v05b-migrations/after/${table}.json"
done
```

### Quick spot-check reads

```bash
npx convex data meetingFormResponses --prod --limit 300 --format pretty
npx convex data tenantStats --prod --limit 20 --format pretty
npx convex data tenantCalendlyConnections --prod --limit 20 --format pretty
```

## Canonical Migration Command List

## What You Actually Need To Run Now

Because Phase 2 was already deployed and run in your environment, the current
production task is the **Phase 6 preflight + deploy** sequence:

```bash
pnpm exec tsc --noEmit
pnpm exec convex deploy --dry-run --typecheck enable
pnpm exec convex deploy --typecheck enable
```

Then run the verification block:

```bash
npx convex run admin/migrations:auditPhase6Readiness '{}' --prod --identity "$ADMIN_IDENTITY"
npx convex run admin/migrations:auditOrphanedTenantRows '{}' --prod --identity "$ADMIN_IDENTITY"
npx convex run admin/migrations:auditOrphanedUserRefs '{}' --prod --identity "$ADMIN_IDENTITY"
npx convex run admin/migrations:auditPaymentCurrencies '{}' --prod --identity "$ADMIN_IDENTITY"
```

Do **not** run the deploy commands above until the Phase 6 preflight validation
in the ordered runbook below succeeds.

If you want a full reconciliation pass, the complete ordered list is below. The
Phase 2 and Phase 5 mutating functions are written to be safe to re-run as
reconciliation commands if the Phase 6 preflight finds drift.

## Full Ordered Runbook

### Phase 2A — booking answers backfill

Run this first if you are ever re-running the full Phase 2 set.

```bash
npx convex run admin/migrations:backfillMeetingFormResponses "{\"tenantId\":\"$TENANT_ID\"}" --prod --identity "$ADMIN_IDENTITY"
```

What it changes:

- reads `rawWebhookEvents` of type `invitee.created`
- creates or updates `meetingFormResponses`
- creates or updates `eventTypeFieldCatalog`
- links responses back to meeting, opportunity, and lead records

### Phase 2B — simple field backfills

```bash
npx convex run admin/migrations:backfillLeadStatus '{}' --prod --identity "$ADMIN_IDENTITY"
npx convex run admin/migrations:backfillUserIsActive '{}' --prod --identity "$ADMIN_IDENTITY"
npx convex run admin/migrations:backfillPaymentAmountMinor '{}' --prod --identity "$ADMIN_IDENTITY"
npx convex run admin/migrations:backfillPaymentContextType '{}' --prod --identity "$ADMIN_IDENTITY"
npx convex run admin/migrations:backfillFollowUpType '{}' --prod --identity "$ADMIN_IDENTITY"
```

What they change:

- `leads.status`: fill missing values with `"active"`
- `users.isActive`: fill missing values with `true`
- `paymentRecords.amountMinor`: derive from legacy `amount` when older rows still exist
- `paymentRecords.contextType`: derive from linked `opportunityId` vs `customerId`
- `followUps.type`: infer `"scheduling_link"` vs `"manual_reminder"`

### Phase 2C — relationship / aggregate backfills

```bash
npx convex run admin/migrations:backfillMeetingCloserId '{}' --prod --identity "$ADMIN_IDENTITY"
npx convex run admin/migrations:backfillCustomerTotals '{}' --prod --identity "$ADMIN_IDENTITY"
```

What they change:

- `meetings.assignedCloserId`: copy from the parent opportunity
- `customers.totalPaidMinor`, `totalPaymentCount`, `paymentCurrency`: recompute from non-disputed payments

### Phase 2D — tenant stats seed

```bash
npx convex run admin/migrations:seedAllTenantStats '{}' --prod --identity "$ADMIN_IDENTITY"
```

What it changes:

- creates or updates one `tenantStats` row per active tenant
- recomputes the summary counters Phase 4 reads from

### Phase 2E — event type config dedupe

```bash
npx convex run admin/migrations:deduplicateAllEventTypeConfigs '{}' --prod --identity "$ADMIN_IDENTITY"
```

What it changes:

- collapses duplicate `eventTypeConfigs` by `(tenantId, calendlyEventTypeUri)`
- repoints `opportunities.eventTypeConfigId`
- repoints `meetingFormResponses.eventTypeConfigId`
- merges or moves related `eventTypeFieldCatalog` rows

### Phase 2F — audits

These do not mutate data. Run them after the backfills:

```bash
npx convex run admin/migrations:auditOrphanedTenantRows '{}' --prod --identity "$ADMIN_IDENTITY"
npx convex run admin/migrations:auditOrphanedUserRefs '{}' --prod --identity "$ADMIN_IDENTITY"
npx convex run admin/migrations:auditPaymentCurrencies '{}' --prod --identity "$ADMIN_IDENTITY"
```

What they verify:

- zero tenant-scoped rows whose `tenantId` no longer exists
- zero dangling user references across tenant, opportunity, meeting, payment, follow-up, and event tables
- one-currency-per-tenant payment model, or an explicit mixed-currency report to resolve

### Phase 3 — no standalone migration commands

No post-deploy `convex run` command is required here.

Operational expectation after deploy:

- new mutations populate lifecycle fields, attribution fields, and `domainEvents`
- new payments dual-write `amountMinor`
- new writes keep `tenantStats` current

### Phase 4 — no standalone migration commands

No post-deploy `convex run` command is required here.

Operational expectation after deploy:

- reads now depend on the Phase 2 backfills being complete
- dashboard reads `tenantStats`
- payment queries read `amountMinor`
- closer scheduling reads `meetings.assignedCloserId`

### Phase 5A — Calendly connection reconciliation

This is the one-shot recovery/backfill that ensures every tenant has exactly one
`tenantCalendlyConnections` row and repairs rows that were created empty while
legacy OAuth/webhook state still existed on `tenants`.

```bash
npx convex run admin/migrations:backfillTenantCalendlyConnections '{}' --prod --identity "$ADMIN_IDENTITY"
```

What it changes:

- creates a disconnected `tenantCalendlyConnections` row for any tenant missing one
- copies legacy OAuth/webhook fields from `tenants` into newly created rows
- repairs existing connection rows by filling only missing fields from legacy tenant data

### Phase 6A — production preflight validation

Capture fresh production snapshots for the tables affected by narrowing:

```bash
mkdir -p .tmp/v05b-phase6/preflight

for table in \
  tenants \
  tenantCalendlyConnections \
  users \
  leads \
  meetings \
  followUps \
  paymentRecords
do
  npx convex data "$table" --prod --limit 2000 --order asc --format jsonArray \
    > ".tmp/v05b-phase6/preflight/${table}.json"
done
```

Validate the narrowing prerequisites from those snapshots:

```bash
node <<'EOF'
const fs = require("fs");

const load = (name) =>
  JSON.parse(
    fs.readFileSync(`.tmp/v05b-phase6/preflight/${name}.json`, "utf8"),
  );

const tenants = load("tenants");
const connections = load("tenantCalendlyConnections");
const users = load("users");
const leads = load("leads");
const meetings = load("meetings");
const followUps = load("followUps");
const payments = load("paymentRecords");

const tenantConnectionIds = new Set(connections.map((row) => row.tenantId));
const missingConnections = tenants.filter(
  (tenant) => !tenantConnectionIds.has(tenant._id),
);

const legacyTenantFields = [
  "calendlyAccessToken",
  "calendlyRefreshToken",
  "calendlyTokenExpiresAt",
  "calendlyRefreshLockUntil",
  "lastTokenRefreshAt",
  "codeVerifier",
  "calendlyOrgUri",
  "calendlyOwnerUri",
  "calendlyWebhookUri",
  "webhookSigningKey",
  "webhookProvisioningStartedAt",
];

const hasField = (row, field) =>
  Object.prototype.hasOwnProperty.call(row, field) && row[field] !== undefined;

const report = {
  tenants_missing_connection_row: missingConnections.length,
  tenants_with_legacy_oauth_fields: tenants.filter((row) =>
    legacyTenantFields.some((field) => hasField(row, field)),
  ).length,
  leads_missing_status: leads.filter((row) => row.status === undefined).length,
  users_missing_isActive: users.filter((row) => row.isActive === undefined)
    .length,
  meetings_missing_assignedCloserId: meetings.filter(
    (row) => row.assignedCloserId === undefined,
  ).length,
  followUps_missing_type: followUps.filter((row) => row.type === undefined)
    .length,
  payments_missing_amountMinor: payments.filter(
    (row) => row.amountMinor === undefined,
  ).length,
  payments_missing_contextType: payments.filter(
    (row) => row.contextType === undefined,
  ).length,
  payments_with_legacy_amount_field: payments.filter((row) =>
    hasField(row, "amount"),
  ).length,
  leads_with_invalid_customFields: leads.filter((row) => {
    if (row.customFields === undefined) return false;
    if (
      typeof row.customFields !== "object" ||
      row.customFields === null ||
      Array.isArray(row.customFields)
    ) {
      return true;
    }
    return Object.values(row.customFields).some((value) => typeof value !== "string");
  }).length,
};

console.log(JSON.stringify(report, null, 2));

const failures = Object.entries(report).filter(([, count]) => count > 0);
if (failures.length > 0) {
  console.error("\\nPhase 6 preflight failed. Do not deploy until every count is 0.");
  process.exit(1);
}

console.log("\\nPhase 6 preflight passed.");
EOF
```

If this check fails, do **not** deploy Phase 6. Repair the missing Phase 2 or
Phase 5 data state first, then rerun the preflight.

The server-side readiness audit should agree with the snapshot-based preflight:

```bash
npx convex run admin/migrations:auditPhase6Readiness '{}' --prod --identity "$ADMIN_IDENTITY"
```

If that audit reports missing `tenantCalendlyConnections`, rerun:

```bash
npx convex run admin/migrations:backfillTenantCalendlyConnections '{}' --prod --identity "$ADMIN_IDENTITY"
```

If that audit reports missing `meetings.assignedCloserId`, rerun:

```bash
npx convex run admin/migrations:backfillMeetingCloserId '{}' --prod --identity "$ADMIN_IDENTITY"
```

If it reports missing `paymentRecords.amountMinor`, rerun:

```bash
npx convex run admin/migrations:backfillPaymentAmountMinor '{}' --prod --identity "$ADMIN_IDENTITY"
```

### Phase 6B — production deploy

Once the preflight passes, run the narrowing deploy:

```bash
pnpm exec tsc --noEmit
pnpm exec convex deploy --dry-run --typecheck enable
pnpm exec convex deploy --typecheck enable
```

What this does:

- validates the narrowed schema and the generated Convex types against the repo
- dry-runs the deploy before touching production
- deploys the Phase 6 narrowed schema to the production deployment

### Phase 6C — post-deploy verification

Re-run the non-mutating audits and capture fresh after snapshots:

```bash
npx convex run admin/migrations:auditPhase6Readiness '{}' --prod --identity "$ADMIN_IDENTITY"
npx convex run admin/migrations:auditOrphanedTenantRows '{}' --prod --identity "$ADMIN_IDENTITY"
npx convex run admin/migrations:auditOrphanedUserRefs '{}' --prod --identity "$ADMIN_IDENTITY"
npx convex run admin/migrations:auditPaymentCurrencies '{}' --prod --identity "$ADMIN_IDENTITY"

mkdir -p .tmp/v05b-phase6/after

for table in \
  tenants \
  tenantCalendlyConnections \
  users \
  leads \
  meetings \
  followUps \
  paymentRecords
do
  npx convex data "$table" --prod --limit 2000 --order asc --format jsonArray \
    > ".tmp/v05b-phase6/after/${table}.json"
done
```

Keep both the preflight and after snapshots until the rollout is fully accepted.

## Verification Checklist

After the run, verify these outcomes from the CLI output plus the before/after table snapshots:

- `meetingFormResponses` contains historical rows sourced from retained `invitee.created` raw events
- every `leads` row has `status`
- every `users` row has `isActive`
- `paymentRecords` rows have `amountMinor` and `contextType`
- `meetings.assignedCloserId` is populated wherever the parent opportunity has a closer
- `customers` have recomputed payment totals
- `tenantStats` exists for the active tenant
- duplicate `eventTypeConfigs` are gone
- `tenantCalendlyConnections` has one row per tenant with copied OAuth state
- `tenants` no longer carry legacy OAuth fields in the live documents you
  checked during preflight
- `paymentRecords` no longer rely on legacy `amount` and every row has
  `amountMinor`
- the Phase 6 preflight validator prints zero failures before deploy
- `pnpm exec convex deploy --typecheck enable` succeeds
- orphan and currency audits return clean results

## Notes

- For **your current environment**, the Phase 2 commands are primarily a **reference and reconciliation** set because you already ran them.
- For the current repo state, the Phase 6 rollout is mainly a **validation +
  deploy** exercise, not a new one-shot backfill.
- If the Phase 6 preflight fails on missing `tenantCalendlyConnections` rows,
  missing `meetings.assignedCloserId`, or missing `paymentRecords.amountMinor`,
  run the corresponding reconciliation command first, then rerun the preflight.
- Keep the `.tmp/v05b-migrations/before`, `.tmp/v05b-migrations/after`,
  `.tmp/v05b-phase6/preflight`, and `.tmp/v05b-phase6/after` snapshots until
  Phase 6 is fully accepted in production.
