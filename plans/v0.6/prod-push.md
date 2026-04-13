# v0.6 Reporting Production Push Strategy

**Status:** Ready for execution
**Date:** 2026-04-13
**Scope:** Production rollout for reporting Phases 1-5, assuming implementation is complete and only the deployment/backfill/release sequence remains.

## Goal

Ship v0.6 reporting to production without leaving historical reporting data incomplete or causing aggregate drift.

This rollout is mostly an **additive deploy + historical backfill + verification**. It is **not** a widen-migrate-narrow schema migration because the new `meetings` fields are optional and the reporting aggregates are derived state. The only real production risk is publishing before the historical data and aggregate state are reconciled.

---

## Executive Summary

You **do need backfills in production** unless you have already run and verified them on the production deployment.

**Must run on prod:**
- `reporting/backfill:backfillMeetingClassification`
- `reporting/backfill:backfillMeetingsAggregate`
- `reporting/backfill:backfillPaymentsAggregate`
- `reporting/backfill:backfillOpportunitiesAggregate`
- `reporting/backfill:backfillLeadsAggregate`
- `reporting/backfill:backfillCustomersAggregate`

**Do not need historical backfill for correctness:**
- `stoppedAt`
- `lateStartDurationMs`
- `lateStartReason`
- `overranDurationMs`

Those time-tracking fields are optional and only become meaningful for meetings handled after the feature ships.

**Should already be done from v0.5b, not re-backfilled as part of this push unless verification fails:**
- `meetingFormResponses`
- `eventTypeFieldCatalog`
- `domainEvents`

For those datasets, the production task is to **verify prerequisites are intact** and confirm the new live write path is working after release.

---

## Why Backfills Are Required

### 1. Historical meetings need `callClassification`

Reporting splits metrics into `new` vs `follow_up`, and that dimension is stored on `meetings.callClassification`. Existing production meetings predate this field, so they must be classified before reports are trusted.

### 2. Aggregate component state starts empty

The 5 reporting aggregates are separate derived data structures. Deploying the component registration does not automatically backfill old rows from `meetings`, `paymentRecords`, `opportunities`, `leads`, or `customers`.

### 3. Ordering matters

Run `backfillMeetingClassification` **before** `backfillMeetingsAggregate`.

Reason: `backfillMeetingsAggregate` uses `insertIfDoesNotExist`. If a meeting is inserted into the aggregate before its final `callClassification` is set, re-running that backfill will not repair the sort key. If classification changes after aggregate insertion, you need a repair path that calls `replace()` on the affected docs, not another idempotent insert backfill.

---

## Pre-Deploy Checks

Complete these before touching production:

1. Confirm v0.5b prerequisites are already true in prod:
   - historical `meetingFormResponses` backfill completed
   - `eventTypeFieldCatalog` populated
   - `domainEvents` emission sites are already live
2. Run local verification:
   - `pnpm tsc --noEmit`
   - `pnpm build`
3. Confirm the production branch includes all Phase 1-5 code:
   - aggregate component registration
   - reporting queries
   - report routes/UI
   - live `meetingFormResponses` insertion in `convex/pipeline/inviteeCreated.ts`
   - aggregate write hooks across all relevant mutations
4. Choose a low-traffic release window, even though the production dataset is small.

Given the current scale in the plan, the historical backfills are small enough to run online.

---

## Recommended Rollout Order

### Step 1. Deploy Convex backend first

Deploy the backend code that includes:
- schema additions
- aggregate component registrations
- reporting functions
- write hooks
- backfill functions
- verification query

Suggested command:

```bash
npx convex deploy
```

Do **not** expose the reporting UI yet if your frontend deploy is separate. Backend-first is safer because the old UI does not depend on reporting, while the new UI depends on the backend being complete.

### Step 2. Run the required historical backfills

Run these immediately after the Convex deploy:

```bash
npx convex run reporting/backfill:backfillMeetingClassification
npx convex run reporting/backfill:backfillMeetingsAggregate
npx convex run reporting/backfill:backfillPaymentsAggregate
npx convex run reporting/backfill:backfillOpportunitiesAggregate
npx convex run reporting/backfill:backfillLeadsAggregate
npx convex run reporting/backfill:backfillCustomersAggregate
```

Notes:
- `backfillMeetingClassification` must finish first.
- The 5 aggregate backfills can run after that in any order.
- Re-running an aggregate backfill after a transient failure is safe because `insertIfDoesNotExist` is idempotent.

### Step 3. Verify backfill integrity before frontend release

Use `reporting/verification:verifyBackfillCounts` from the Convex dashboard/internal functions view and confirm:
- `customers.match === true`
- `leads.match === true`
- `meetings.match === true`
- `opportunities.match === true`
- `paymentRecords.match === true`
- `meetings.unclassified === 0`

Also spot-check in the dashboard:
- several historical meetings now have `callClassification`
- at least one known payment is represented in reporting
- at least one known lead/customer tenant has aggregate counts

### Step 4. Deploy the frontend

After backend verification passes, deploy the Next.js app so admins can access the reports.

### Step 5. Run production smoke tests

Immediately after frontend deploy:

1. Open `/workspace/reports/team` as an admin.
2. Verify a historical date range loads real data.
3. Open Revenue, Pipeline, Activity, and Leads/Conversions reports.
4. Confirm a closer cannot access `/workspace/reports/*`.
5. Trigger one real or test booking and verify:
   - a meeting is created
   - reporting counts move
   - `meetingFormResponses` rows are written for the new booking

---

## Go/No-Go Criteria

Proceed with full release only if all of the following are true:

- Convex deploy succeeds without schema validation errors
- `backfillMeetingClassification` completes
- all 5 aggregate backfills complete
- `verifyBackfillCounts` shows all matches true
- `meetings.unclassified === 0`
- report pages render for the production tenant
- one live booking confirms the new pipeline writes form responses correctly

If any of those fail, stop the release and fix the backend before treating reporting as production-ready.

---

## What Does Not Need a Backfill

These fields can safely remain absent on old meetings:

- `stoppedAt`
- `lateStartDurationMs`
- `lateStartReason`
- `overranDurationMs`

Reason:
- they are optional in schema
- old meetings cannot be reconstructed with confidence
- Tier 3 time-tracking analytics are only correct from rollout forward unless you explicitly invent a historical reconstruction strategy

That is acceptable for this push. Document it as a reporting cutoff: time-tracking KPIs are trustworthy from the production release date forward.

---

## Recovery / Rollback Strategy

### If the frontend is wrong but backend is healthy

- keep the Convex deploy
- rollback only the frontend if needed
- fix UI issues and redeploy

### If aggregate counts are wrong

- identify the affected dataset
- fix the missing/broken write hook
- rerun the affected aggregate backfill if the problem is only “missing rows”

### If meeting classification logic is wrong

Do **not** assume rerunning `backfillMeetingsAggregate` will repair it.

Because the meetings aggregate backfill uses `insertIfDoesNotExist`, already-inserted rows keep their old key. If classification logic changes after aggregate population, the recovery should be:

1. fix classification logic
2. repair the stored `meetings.callClassification` values
3. run a dedicated aggregate repair that calls `meetingsByStatus.replace()` for affected meetings, or rebuild that aggregate instance deliberately

### If v0.5b prerequisites are missing in prod

Do not publish reporting as complete. Finish the missing v0.5b backfill first, especially:
- `meetingFormResponses`
- `eventTypeFieldCatalog`

Without those, Form Insights will look partially broken even if the rest of reporting is correct.

---

## Practical Recommendation

For this production push, treat the rollout as two gates:

### Gate A: Backend data correctness

- deploy Convex
- run classification backfill
- run aggregate backfills
- verify counts

### Gate B: User-visible release

- deploy frontend
- run smoke tests
- announce reporting availability only after one live booking validates the post-release write path

That is the safest production strategy for the current codebase and data model.
