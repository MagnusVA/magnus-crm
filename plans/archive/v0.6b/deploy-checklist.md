# v0.6b Production Pass Checklist

**Status:** Operational runbook
**Applies to:** production cutover for v0.6b reporting completion + raw-webhook fresh start
**Last updated:** 2026-04-19

## Goal

Deploy the v0.6b code, then rebuild production runtime data from preserved `rawWebhookEvents` so that **only meetings whose Calendly `payload.scheduled_event.start_time` is on or after `2026-04-20T00:00:00.000Z`** exist after cutover.

This is a **fresh-start** rollout. It intentionally does **not** preserve older runtime CRM state.

---

## Hard Rules

1. Use the exact UTC cutoff:

```text
2026-04-20T00:00:00.000Z
```

2. The cutoff is applied to **`payload.scheduled_event.start_time`**, not webhook receipt time and not local midnight.
3. Do **not** use `admin/tenantsMutations:deleteTenantRuntimeDataBatch` for this pass. That path deletes `rawWebhookEvents`, which are the replay source.
4. Do **not** run `reporting/backfill:backfillPaymentOrigin` or `reporting/backfill:backfillFollowUpOrigin` in production as part of this pass. Those backfills are for legacy in-place migration, not the fresh-start strategy.
5. Do **not** run the destructive rebuild until the preview step shows the expected April 20, 2026+ meetings.
6. Run the same pass in the dev deployment first with the exact same cutoff and verify the preview/rebuild output before touching production.
7. The replay entrypoints are tenant-agnostic. They automatically resolve the only target tenant and hard-fail if the environment contains multiple candidate tenants.

---

## Expected Post-Cutover State

### Preserved

- `tenants`
- `users`
- `calendlyOrgMembers`
- `rawWebhookEvents`
- `eventTypeConfigs`
- `tenantCalendlyConnections`

### Reset, Then Rebuilt From Raw Webhooks

- `leads`
- `leadIdentifiers`
- `opportunities`
- `meetings`
- `meetingFormResponses`
- `eventTypeFieldCatalog`
- pipeline-generated `domainEvents`
- `tenantStats`
- reporting aggregate namespaces for:
  - `meetingsByStatus`
  - `paymentSums`
  - `opportunityByStatus`
  - `leadTimeline`
  - `customerConversions`

### Reset And Intentionally Left Empty Until New Post-Cutover Activity

- `leadMergeHistory`
- `followUps`
- `paymentRecords`
- `customers`
- `meetingReviews`
- `meetingReassignments`
- `meetingComments`
- non-webhook/manual `domainEvents`

**Important:** raw webhook replay restores booking/cancel/no-show state only. It does **not** recreate admin-entered or closer-entered artifacts like payments, follow-ups, review resolutions, customer conversions, or comments.

---

## Preflight

### 1. Local code validation

Run this from the repo root before production:

```bash
pnpm exec convex codegen
pnpm tsc --noEmit
pnpm build
git diff --check
```

All four must pass.

### 2. Prepare the admin CLI identity

The replay functions are admin-gated. Use a CLI identity whose `organization_id` matches `SYSTEM_ADMIN_ORG_ID`.

```bash
export SYSTEM_ADMIN_ORG_ID="<system-admin-workos-org-id>"
export ADMIN_IDENTITY='{"subject":"migration-runner","organization_id":"'"$SYSTEM_ADMIN_ORG_ID"'"}'
export CUTOVER_ISO="2026-04-20T00:00:00.000Z"
```

### 3. Confirm the environment really has one target tenant

The replay entrypoints no longer accept `tenantId`. They auto-resolve the tenant and will fail if the environment does not match the single-tenant assumption.

Use this direct read as a sanity check before the destructive pass:

```bash
npx convex data tenants --prod --limit 20 --format pretty
```

You should see exactly one CRM tenant that you intend to keep operating on after cutover.

### 4. Capture before snapshots

This pass is destructive. Save the before state before doing anything else.

```bash
npx convex data rawWebhookEvents --prod --limit 5000 --format pretty
npx convex data leads --prod --limit 5000 --format pretty
npx convex data opportunities --prod --limit 5000 --format pretty
npx convex data meetings --prod --limit 5000 --format pretty
npx convex data paymentRecords --prod --limit 5000 --format pretty
npx convex data followUps --prod --limit 5000 --format pretty
npx convex data customers --prod --limit 5000 --format pretty
```

### 5. Confirm there is replayable raw data

At minimum, production must contain `invitee.created` raw webhook rows for meetings scheduled on or after April 20, 2026 UTC. If it does not, stop here.

---

## Deploy

### Standard production path

Production normally deploys by merging to `main`, which triggers the Vercel build that runs Convex deploy as part of the production build.

Monitor the production build and confirm:

- Convex schema deploy succeeds
- the new `rawWebhookEvents.by_tenantId_and_receivedAt` index is created
- the new `admin/rawWebhookReplay:*` functions are present
- Next.js build succeeds

### Manual backend-only fallback

Use only if the standard Vercel flow is intentionally bypassed:

```bash
npx convex deploy --typecheck disable
```

Do not run a manual production Convex deploy casually. Standard path is still merge-to-main.

---

## Preview The Fresh Start

Run the preview first. This is required.

```bash
npx convex run admin/rawWebhookReplay:previewFreshStartFromRawWebhooks \
  "{\"scheduledStartCutoffIso\":\"$CUTOVER_ISO\"}" \
  --prod \
  --typecheck disable \
  --codegen disable \
  --identity "$ADMIN_IDENTITY"
```

### Required preview checks

Confirm all of the following before proceeding:

- `targetTenant` is the tenant you intended to rebuild
- `scheduledStartCutoffIso` is exactly `2026-04-20T00:00:00.000Z`
- `inviteeCreatedIncluded > 0`
- `totalReplayEvents > 0`
- `sampleIncludedScheduledEvents` only show meetings on or after April 20, 2026 UTC
- `sampleSkippedPreCutoffScheduledEvents` only show meetings before April 20, 2026 UTC
- `relatedEventsIncluded` looks reasonable relative to the number of cancellations/no-shows you expect

### Stop conditions

Do **not** proceed to rebuild if:

- `inviteeCreatedIncluded === 0`
- the included samples contain any meeting before `2026-04-20T00:00:00.000Z`
- the skipped samples contain meetings that should have been included
- the preview output is otherwise inconsistent with expected production data

---

## Run The Destructive Rebuild

Only run this after the preview is correct.

```bash
npx convex run admin/rawWebhookReplay:rebuildFreshStartFromRawWebhooks \
  "{\"scheduledStartCutoffIso\":\"$CUTOVER_ISO\",\"confirmDestructiveReset\":true}" \
  --prod \
  --typecheck disable \
  --codegen disable \
  --identity "$ADMIN_IDENTITY"
```

### What this does

1. Deletes the current operational runtime data for the tenant.
2. Clears the tenant namespace in all 5 reporting aggregate components.
3. Preserves `rawWebhookEvents` and tenant/configuration tables.
4. Replays only these raw webhook types:
   - `invitee.created`
   - `invitee.canceled`
   - `invitee_no_show.created`
   - `invitee_no_show.deleted`
5. Includes only meetings whose `payload.scheduled_event.start_time >= 2026-04-20T00:00:00.000Z`.
6. Re-seeds `tenantStats`.

### During rebuild

Watch logs:

```bash
npx convex logs --prod --history 100
```

If the rebuild fails partway through, fix the cause and then rerun the **same** rebuild command with the **same** cutoff. The workflow is deterministic and safe to rerun with the same source data.

---

## Post-Rebuild Verification

### 1. Direct table verification

Run:

```bash
npx convex data meetings --prod --limit 5000 --format pretty
npx convex data opportunities --prod --limit 5000 --format pretty
npx convex data leads --prod --limit 5000 --format pretty
npx convex data paymentRecords --prod --limit 5000 --format pretty
npx convex data followUps --prod --limit 5000 --format pretty
npx convex data customers --prod --limit 5000 --format pretty
```

Confirm:

- all remaining meetings are scheduled on or after April 20, 2026 UTC
- opportunities/leads exist only for replayed post-cutoff meetings
- `paymentRecords` is empty or contains only truly post-cutover recreated data
- `followUps` is empty or contains only truly post-cutover recreated data
- `customers` is empty or contains only truly post-cutover recreated data

### 2. Aggregate verification

Run:

```bash
npx convex run reporting/verification:verifyBackfillCounts '{}' \
  --prod \
  --typecheck disable \
  --codegen disable
```

Confirm:

- `meetings.match === true`
- `opportunities.match === true`
- `leads.match === true`
- `paymentRecords.match === true`
- `customers.match === true`
- `meetings.unclassified === 0`

On this fresh-start pass, `paymentRecords.table` and `customers.table` may legitimately be `0` immediately after rebuild. That is fine as long as the aggregate counts also read `0`.

### 3. Application smoke test

As a tenant admin or tenant master:

1. Open `/workspace/reports/team`
2. Open `/workspace/reports/revenue`
3. Open `/workspace/reports/pipeline`
4. Open `/workspace/reports/activity`
5. Open `/workspace/reports/leads`

Expected:

- report pages load without runtime errors
- meeting/opportunity counts reflect the replayed post-cutoff set
- revenue-by-origin and reminder-driven-revenue surfaces may be empty immediately after cutover if no post-cutover payments exist yet

### 4. Real booking smoke test

Create one real or controlled booking whose Calendly scheduled start is **on or after** April 20, 2026 UTC and verify:

- a new `rawWebhookEvents` row is created
- pipeline creates/updates the matching lead, opportunity, and meeting
- the meeting appears in workspace UI
- relevant report counts move

---

## Explicitly Do Not Run

Do not run these as part of this production pass:

```bash
npx convex run reporting/backfill:backfillPaymentOrigin '{}'
npx convex run reporting/backfill:backfillFollowUpOrigin '{}'
npx convex run admin/tenantsMutations:deleteTenantRuntimeDataBatch '{"tenantId":"..."}'
```

These are the wrong tools for the fresh-start rollout.

---

## Go / No-Go

### Go only if all are true

- local validation passed
- dev dry run passed with the same cutoff
- production code deploy succeeded
- the auto-resolved `targetTenant` is correct
- preview output is correct
- destructive rebuild completed without error
- aggregate verification passed after rebuild
- all remaining meetings are on or after `2026-04-20T00:00:00.000Z`
- the app loads and the basic reports render
- one post-cutover booking succeeds end to end

### No-Go if any are true

- the tenant auto-resolution points at the wrong tenant or throws because the environment has more than one candidate tenant
- preview includes pre-cutoff meetings
- preview shows zero replayable `invitee.created` rows when you expected qualifying data
- rebuild errors and the cause is not understood
- aggregate verification shows stale mismatches after rebuild
- reports or workspace pages fail after rebuild
- new post-cutover bookings do not create runtime state correctly

If any no-go condition is hit, stop and diagnose before proceeding with any additional manual cleanup.
