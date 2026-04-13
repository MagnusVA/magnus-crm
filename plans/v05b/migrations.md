# v0.5b Migration Runbook (Phases 2-5)

This runbook assumes the code through **Phase 5** has already been deployed.

## Short answer

Because you already ran the Phase 2 migrations when Phase 2 shipped, the only **new** post-deploy migration introduced after that is **Phase 5A**:

```bash
npx convex run migrations/backfillTenantCalendlyConnections:backfillTenantCalendlyConnections '{}' --prod
```

Phases **3** and **4** are **code-only**. They do not add standalone post-deploy backfill commands.

The rest of this file is the **full canonical Phase 2-5 runbook** so you have:

- the complete migration list in one place
- the exact `npx convex run` commands
- the direct-read `npx convex data` snapshot commands for before/after evidence
- the audit commands to verify the rollout

## What Changes In Phases 2-5

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

This adds one new post-deploy migration:

- backfill `tenantCalendlyConnections` from the legacy OAuth fields still present on `tenants`

That backfill is what lets the new Phase 5 readers and writers stop depending on fallback reads from `tenants`, and it is the last data step before Phase 6 schema narrowing.

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

Because Phase 2 was already deployed and run in your environment, the minimum post-Phase-5 run is:

```bash
npx convex run migrations/backfillTenantCalendlyConnections:backfillTenantCalendlyConnections '{}' --prod
```

Then run the verification block:

```bash
npx convex run admin/migrations:auditOrphanedTenantRows '{}' --prod --identity "$ADMIN_IDENTITY"
npx convex run admin/migrations:auditOrphanedUserRefs '{}' --prod --identity "$ADMIN_IDENTITY"
npx convex run admin/migrations:auditPaymentCurrencies '{}' --prod --identity "$ADMIN_IDENTITY"
```

If you want a full reconciliation pass, the complete ordered list is below. The Phase 2 mutating functions are written to be safe to re-run.

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
- `paymentRecords.amountMinor`: derive from legacy `amount`
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

### Phase 5A — Calendly connection backfill

```bash
npx convex run migrations/backfillTenantCalendlyConnections:backfillTenantCalendlyConnections '{}' --prod
```

What it changes:

- copies legacy OAuth/webhook state from `tenants` into `tenantCalendlyConnections`
- maps `calendlyOrgUri -> calendlyOrganizationUri`
- maps `calendlyOwnerUri -> calendlyUserUri`
- maps `webhookSigningKey -> calendlyWebhookSigningKey`
- derives `connectionStatus`

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
- orphan and currency audits return clean results

## Notes

- For **your current environment**, the Phase 2 commands are primarily a **reference and reconciliation** set because you already ran them.
- The only **new** migration introduced after that earlier run is `backfillTenantCalendlyConnections`.
- Keep the `.tmp/v05b-migrations/before` and `.tmp/v05b-migrations/after` snapshots until Phase 6 schema narrowing is complete.
