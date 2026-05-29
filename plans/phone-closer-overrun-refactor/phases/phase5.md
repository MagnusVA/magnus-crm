# Phase 5 - Data Cleanup: Erase Legacy Lifecycle State

**Goal:** Repair production data so source rows, denormalized projections, aggregate tables/components, scheduled functions, and review rows contain no `meeting_overran`, no `in_progress`, no Start/End timing artifacts, and no `meetingReviews` data. This phase is the hard gate before schema narrow.

**Prerequisite:** Phases 1-4 are deployed. The app no longer produces new legacy lifecycle state and no active UI/report path depends on review or timing data.

**Runs in PARALLEL with:** Nothing. This phase mutates production data and must run sequentially with explicit verification between commands.

**Skills to invoke:**
- `convex-migration-helper` - required for the production cleanup, dry runs, batched execution, resume safety, and widen -> narrow gate.
- `convex-performance-audit` - use if cleanup/audit queries are slow, hit transaction limits, or show aggregate drift.

**Docs and references to read first:**
- `plans/phone-closer-overrun-refactor/phone-closer-overrun-refactor-design.md` Sections 8, 10.3, 10.5, 13, and 14.
- `.agents/skills/convex-migration-helper/SKILL.md`.
- `.agents/skills/convex-migration-helper/references/migrations-component.md`.
- `.agents/skills/convex-migration-helper/references/migration-patterns.md`.
- `convex/_generated/ai/guidelines.md` for internal functions, validators, and bounded reads.
- Existing migration setup: `convex/migrations.ts`, `convex/convex.config.ts`, `convex/reporting/writeHooks.ts`, `convex/operations/meetingStats.ts`, `convex/operations/projections.ts`, `convex/lib/opportunityMeetingRefs.ts`, and `convex/lib/opportunitySearch.ts`.

**Deploy / backfill / manual operations:**
- **Deploy required:** Yes. Deploy temporary migration/audit code before running cleanup.
- **Backfill or migration required:** Yes. Run `@convex-dev/migrations` dry runs first, then production migrations, then verification queries.
- **Manual operations:** All production cleanup commands use `--prod` because the only test tenant is on production. Do not run Phase 6 until every audit returns zero legacy rows and no aggregate mismatches.

**Acceptance Criteria:**
1. Dry runs pass for each migration step before any production mutation is committed.
2. All pending scheduled functions for `checkMeetingAttendance` are canceled or have run against the no-op shim.
3. Every meeting has legacy timing/overrun fields removed or set to undefined where allowed by the widened schema.
4. Every `meeting_overran` or `in_progress` meeting/opportunity is repaired using evidence precedence: payment -> cancel -> no-show -> follow-up -> lost -> scheduled.
5. `meetingReviews` has zero rows.
6. `opportunitySearch.status`, `meetings.opportunityStatus`, `operationsMeetingDailyStats.meetingStatus`, `operationsMeetingDailyStats.opportunityStatus`, and `operationsQualificationRows.opportunityStatus` contain no legacy literals.
7. Meeting/opportunity aggregate components, tenant stats, operations stats, and qualification/search projections are rebuilt or verified consistent.
8. Audit query `countLegacyLifecycleRows` returns all zeros in production.
9. Audit query `compareLifecycleAggregates` reports no mismatches in production.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
5A (migration/audit scaffolding) --> 5B (strip fields + cancel jobs)
                                  \-> 5C (repair source rows)
                                  \-> 5D (refresh projections/aggregates)
                                  \-> 5E (delete reviews/events)

5B + 5C + 5D + 5E complete --> 5F (production runbook + verification gate)
```

**Optimal execution:**
1. Implement 5A first and deploy temporary code.
2. Dry-run 5B-5E individually in production.
3. Run cleanup in this order: strip/cancel -> repair linked meetings -> repair standalone opportunities -> refresh projections/aggregates -> delete reviews.
4. Run 5F audits. Repeat repair/refresh until every count is zero and aggregate comparisons pass.

**Estimated time:** 1-2 days implementation, plus a controlled production cleanup window.

---

## Subphases

### 5A - Add Migration and Audit Scaffolding

**Type:** Backend / Migration
**Parallelizable:** No - all cleanup steps depend on scaffolding.

**What:** Add temporary migration definitions, shared repair helpers, and audit queries.

**Why:** The cleanup needs repeatable dry runs, resumable batches, and a hard verification gate before schema narrow.

**Where:**
- `convex/migrations/eraseLegacyLifecycleState.ts` (create)
- `convex/migrations/legacyLifecycleRepair.ts` (create if helpers are split)
- `convex/audits/legacyLifecycle.ts` (create; temporary)
- `convex/migrations.ts` (modify only if adding named runner exports)

**How:**

**Step 1: Define legacy status predicates.**

```typescript
// Path: convex/migrations/legacyLifecycleRepair.ts
import type { Doc } from "../_generated/dataModel";

export function isLegacyOpportunityStatus(
  status: Doc<"opportunities">["status"],
): boolean {
  return status === "meeting_overran" || status === "in_progress";
}

export function isLegacyMeetingStatus(
  status: Doc<"meetings">["status"],
): boolean {
  return status === "meeting_overran" || status === "in_progress";
}
```

**Step 2: Add audit query skeleton.**

```typescript
// Path: convex/audits/legacyLifecycle.ts
import { query } from "../_generated/server";

export const countLegacyLifecycleRows = query({
  args: {},
  handler: async (ctx) => {
    const counts = {
      meetings: 0,
      opportunities: 0,
      opportunitySearch: 0,
      meetingOpportunityStatus: 0,
      operationsMeetingDailyStatsMeetingStatus: 0,
      operationsMeetingDailyStatsOpportunityStatus: 0,
      operationsQualificationRows: 0,
      meetingReviews: 0,
      scheduledAttendanceChecks: 0,
    };

    for await (const row of ctx.db.query("meetings")) {
      if (row.status === "in_progress" || row.status === "meeting_overran") {
        counts.meetings++;
      }
      if (
        row.opportunityStatus === "in_progress" ||
        row.opportunityStatus === "meeting_overran"
      ) {
        counts.meetingOpportunityStatus++;
      }
    }

    // Repeat for opportunities, opportunitySearch, operations stats,
    // qualification rows, and meetingReviews. Keep this temporary and delete
    // in Phase 6.
    return counts;
  },
});
```

**Step 3: Add aggregate comparison audit.**

```typescript
// Path: convex/audits/legacyLifecycle.ts
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  meetingsByStatus,
  opportunityByStatus,
} from "../reporting/aggregates";

const FINAL_OPPORTUNITY_STATUSES = [
  "qualified_pending",
  "scheduled",
  "payment_received",
  "follow_up_scheduled",
  "reschedule_link_sent",
  "lost",
  "canceled",
  "no_show",
] as const;

const FINAL_MEETING_STATUSES = [
  "scheduled",
  "completed",
  "canceled",
  "no_show",
] as const;

const CALL_CLASSIFICATIONS = ["new", "follow_up"] as const;

async function countMeetingsByStatusAcrossClosers(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    status: (typeof FINAL_MEETING_STATUSES)[number];
  },
): Promise<number> {
  const closers = await ctx.db
    .query("users")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId))
    .take(100)
    .then((users) => users.filter((user) => user.role === "closer"));

  const countQueries = closers.flatMap((closer) =>
    CALL_CLASSIFICATIONS.map((classification) => ({
      namespace: args.tenantId,
      bounds: { prefix: [closer._id, classification, args.status] },
    })),
  );

  const counts =
    countQueries.length > 0
      ? await meetingsByStatus.countBatch(ctx, countQueries)
      : [];

  return counts.reduce((sum, count) => sum + count, 0);
}

export const compareLifecycleAggregates = query({
  args: {},
  handler: async (ctx) => {
    const mismatches: Array<{
      tenantId: Id<"tenants">;
      kind: string;
      status: string;
      sourceCount: number;
      aggregateCount: number;
    }> = [];

    const tenants = await ctx.db.query("tenants").take(100);
    for (const tenant of tenants) {
      for (const status of FINAL_OPPORTUNITY_STATUSES) {
        let sourceCount = 0;
        for await (const opportunity of ctx.db
          .query("opportunities")
          .withIndex("by_tenantId_and_status", (q) =>
            q.eq("tenantId", tenant._id).eq("status", status),
          )) {
          sourceCount += 1;
        }

        const aggregateCount = await opportunityByStatus.count(ctx, {
          namespace: tenant._id,
          bounds: { prefix: [status] },
        });

        if (sourceCount !== aggregateCount) {
          mismatches.push({
            tenantId: tenant._id,
            kind: "opportunityByStatus",
            status,
            sourceCount,
            aggregateCount,
          });
        }
      }

      for (const status of FINAL_MEETING_STATUSES) {
        let sourceCount = 0;
        for await (const meeting of ctx.db
          .query("meetings")
          .withIndex("by_tenantId_and_status_and_scheduledAt", (q) =>
            q.eq("tenantId", tenant._id).eq("status", status),
          )) {
          sourceCount += 1;
        }

        const aggregateCount = await countMeetingsByStatusAcrossClosers(ctx, {
          tenantId: tenant._id,
          status,
        });

        if (sourceCount !== aggregateCount) {
          mismatches.push({
            tenantId: tenant._id,
            kind: "meetingsByStatus",
            status,
            sourceCount,
            aggregateCount,
          });
        }
      }
    }

    return {
      ok: mismatches.length === 0,
      mismatches,
    };
  },
});
```

The important requirement is that the audit performs a real source-vs-aggregate
comparison before Phase 6. If the implementation branch changes aggregate key
shape, update the helper to match the current `convex/reporting/aggregates.ts`.

**Key implementation notes:**
- These audit functions are temporary. Delete them in Phase 6 after narrow succeeds.
- If public `query` is used for CLI convenience, return counts only and delete immediately in Phase 6. Do not expose row data.
- Do not use unbounded `.collect()` in production audits. `for await` is acceptable for controlled one-off audits on the known small production tenant, but prefer component/audited helpers where available.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/migrations/eraseLegacyLifecycleState.ts` | Create | Migration definitions |
| `convex/migrations/legacyLifecycleRepair.ts` | Create | Evidence/repair helpers |
| `convex/audits/legacyLifecycle.ts` | Create | Temporary production verification queries |
| `convex/migrations.ts` | Modify / verify | Runner exists; add named runner only if needed |

---

### 5B - Strip Legacy Fields and Cancel Queued Attendance Checks

**Type:** Migration
**Parallelizable:** No - run before source status repair.

**What:** Remove timing/overrun fields from meetings and cancel any queued attendance checks referenced by `attendanceCheckId`.

**Why:** These fields cannot remain before schema narrow, and queued jobs must not reference deleted functions.

**Where:**
- `convex/migrations/eraseLegacyLifecycleState.ts` (modify)

**How:**

**Step 1: Define the field-strip migration.**

```typescript
// Path: convex/migrations/eraseLegacyLifecycleState.ts
import { migrations } from "../migrations";

export const stripLegacyLifecycleFields = migrations.define({
  table: "meetings",
  batchSize: 50,
  migrateOne: async (ctx, meeting) => {
    if (meeting.attendanceCheckId) {
      try {
        await ctx.scheduler.cancel(meeting.attendanceCheckId);
      } catch {
        // The job may already have run or been canceled. Continue cleanup.
      }
    }

    return {
      attendanceCheckId: undefined,
      reviewId: undefined,
      overranDetectedAt: undefined,
      startedAt: undefined,
      startedAtSource: undefined,
      stoppedAt: undefined,
      stoppedAtSource: undefined,
      lateStartDurationMs: undefined,
      overranDurationMs: undefined,
      exceededScheduledDurationMs: undefined,
      noShowWaitDurationMs: undefined,
    };
  },
});
```

**Step 2: Dry-run, then run.**

```bash
# Path: shell
npx convex run --prod migrations:run '{"fn":"migrations/eraseLegacyLifecycleState:stripLegacyLifecycleFields","dryRun":true}'
npx convex run --prod migrations:run '{"fn":"migrations/eraseLegacyLifecycleState:stripLegacyLifecycleFields"}'
npx convex run --prod --component migrations lib:getStatus --watch
```

**Key implementation notes:**
- Do not remove `completedAt`; it is preserved and redefined.
- Keep Fathom fields.
- If scheduler cancellation throws for a missing job, keep migrating. The target state is "no pending references," verified later.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/migrations/eraseLegacyLifecycleState.ts` | Modify | Strip fields and cancel scheduled jobs |

---

### 5C - Repair Meeting and Opportunity Source Rows

**Type:** Migration
**Parallelizable:** No - must run after 5B and before projections/aggregates refresh.

**What:** Repair legacy meeting/opportunity statuses using concrete downstream evidence.

**Why:** Schema narrow will fail unless source rows no longer contain legacy status literals.

**Where:**
- `convex/migrations/legacyLifecycleRepair.ts` (modify)
- `convex/migrations/eraseLegacyLifecycleState.ts` (modify)
- `convex/lib/opportunityActivity.ts` (use)
- `convex/reporting/writeHooks.ts` (use)
- `convex/lib/opportunityMeetingRefs.ts` (use)

**How:**

**Step 1: Implement evidence precedence.**

```typescript
// Path: convex/migrations/legacyLifecycleRepair.ts
import type { Doc } from "../_generated/dataModel";

type RepairDecision = {
  opportunityPatch: Partial<Doc<"opportunities">>;
  meetingPatch: Partial<Doc<"meetings">>;
};

export async function deriveMeetingRepair(ctx: MutationCtx, args: {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities"> | null;
  now: number;
}): Promise<RepairDecision> {
  const { meeting, opportunity, now } = args;

  const payment = await ctx.db
    .query("paymentRecords")
    .withIndex("by_opportunityId_and_recordedAt", (q) =>
      q.eq("opportunityId", meeting.opportunityId),
    )
    .order("desc")
    .first();

  if (payment) {
    return {
      opportunityPatch: {
        status: "payment_received",
        paymentReceivedAt: payment.recordedAt,
        updatedAt: now,
      },
      meetingPatch: {
        status: "completed",
        completedAt: payment.recordedAt,
      },
    };
  }

  if (meeting.canceledAt || opportunity?.canceledAt) {
    return {
      opportunityPatch: { status: "canceled", updatedAt: now },
      meetingPatch: { status: "canceled", completedAt: undefined },
    };
  }

  if (meeting.noShowMarkedAt || opportunity?.noShowAt) {
    const noShowAt = meeting.noShowMarkedAt ?? opportunity?.noShowAt ?? now;
    return {
      opportunityPatch: { status: "no_show", noShowAt, updatedAt: now },
      meetingPatch: { status: "no_show", completedAt: noShowAt },
    };
  }

  // Follow-up and lost checks go here, then fallback to scheduled.
  return {
    opportunityPatch: { status: "scheduled", updatedAt: now },
    meetingPatch: { status: "scheduled", completedAt: undefined },
  };
}
```

**Step 2: Apply repair atomically per meeting.**

```typescript
// Path: convex/migrations/eraseLegacyLifecycleState.ts
export const repairLegacyLifecycleMeetings = migrations.define({
  table: "meetings",
  batchSize: 25,
  migrateOne: async (ctx, meeting) => {
    const opportunity = await ctx.db.get(meeting.opportunityId);
    const hasLegacyMeeting = isLegacyMeetingStatus(meeting.status);
    const hasLegacyOpportunity =
      opportunity !== null && isLegacyOpportunityStatus(opportunity.status);

    if (!hasLegacyMeeting && !hasLegacyOpportunity) return;

    const now = Date.now();
    const repair = await deriveMeetingRepair(ctx, {
      meeting,
      opportunity,
      now,
    });

    const oldMeeting = meeting;
    if (opportunity) {
      await patchOpportunityLifecycle(ctx, opportunity._id, repair.opportunityPatch);
    }
    await ctx.db.patch(meeting._id, repair.meetingPatch);
    await replaceMeetingAggregate(ctx, oldMeeting, meeting._id);
    if (opportunity) {
      await updateOpportunityMeetingRefs(ctx, opportunity._id);
    }
  },
});
```

**Step 3: Repair standalone legacy opportunities.**

```typescript
// Path: convex/migrations/eraseLegacyLifecycleState.ts
export const repairStandaloneLegacyOpportunities = migrations.define({
  table: "opportunities",
  batchSize: 25,
  migrateOne: async (ctx, opportunity) => {
    if (!isLegacyOpportunityStatus(opportunity.status)) return;

    const linkedMeeting = await ctx.db
      .query("meetings")
      .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunity._id))
      .order("desc")
      .first();

    if (linkedMeeting) return; // handled by meeting pass

    const now = Date.now();
    await patchOpportunityLifecycle(ctx, opportunity._id, {
      status: "scheduled",
      updatedAt: now,
    });
  },
});
```

**Key implementation notes:**
- Payment is strongest evidence. Do not overwrite payment-received rows with no-show/lost/cancel evidence.
- Review responses are not evidence.
- If a completed meeting is linked to an `in_progress` opportunity, repair the opportunity too; the source-status audit must return zero.
- Use `patchOpportunityLifecycle`, `replaceMeetingAggregate`, and `updateOpportunityMeetingRefs` so projections and aggregate components stay in sync where possible.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/migrations/legacyLifecycleRepair.ts` | Modify | Evidence precedence helpers |
| `convex/migrations/eraseLegacyLifecycleState.ts` | Modify | Repair meeting/opportunity migrations |

---

### 5D - Refresh Projections, Operations Stats, and Aggregates

**Type:** Migration
**Parallelizable:** No - run after source rows are repaired.

**What:** Refresh denormalized status projections and aggregate counts that may still hold legacy statuses.

**Why:** Phase 6 removes legacy literals from projection tables too, not just `meetings` and `opportunities`.

**Where:**
- `convex/migrations/eraseLegacyLifecycleState.ts` (modify)
- `convex/lib/opportunitySearch.ts` (use)
- `convex/operations/projections.ts` (use)
- `convex/operations/meetingStats.ts` (use)
- `convex/reporting/writeHooks.ts` (use)

**How:**

**Step 1: Refresh opportunity-derived projections.**

```typescript
// Path: convex/migrations/eraseLegacyLifecycleState.ts
export const refreshStatusProjections = migrations.define({
  table: "opportunities",
  batchSize: 50,
  migrateOne: async (ctx, opportunity) => {
    await upsertOpportunitySearchProjection(ctx, opportunity._id);
    await updateOpportunityMeetingRefs(ctx, opportunity._id);

    const slackEvent = await ctx.db
      .query("slackQualificationEvents")
      .withIndex("by_tenantId_and_opportunityId", (q) =>
        q.eq("tenantId", opportunity.tenantId).eq("opportunityId", opportunity._id),
      )
      .first();
    if (slackEvent) {
      await rebuildQualificationRow(ctx, slackEvent._id);
    }
  },
});
```

**Step 2: Refresh operations meeting stats for affected meetings.**

```typescript
// Path: convex/migrations/eraseLegacyLifecycleState.ts
export const refreshMeetingOperationsStats = migrations.define({
  table: "meetings",
  batchSize: 50,
  migrateOne: async (ctx, meeting) => {
    const opportunity = await ctx.db.get(meeting.opportunityId);
    const nextMeeting = {
      ...meeting,
      opportunityStatus: opportunity?.status,
    };

    if (meeting.opportunityStatus !== opportunity?.status) {
      await ctx.db.patch(meeting._id, {
        opportunityStatus: opportunity?.status,
      });
    }

    await replaceOperationsMeetingStats(ctx, meeting, nextMeeting);
  },
});
```

**Step 3: Verify component aggregates.**

If aggregate components expose rebuild/backfill helpers in the implementation branch, run them. Otherwise compare source counts to aggregate reads and repair via existing write hooks where possible.

```bash
# Path: shell
npx convex run --prod audits/legacyLifecycle:compareLifecycleAggregates
```

**Key implementation notes:**
- Projection cleanup is part of the Phase 6 gate. Leaving one legacy `opportunityStatus` projection can block schema deploy.
- If `operationsMeetingDailyStats` has legacy rows that cannot be replaced through write hooks, add a targeted migration that deletes/re-buckets those rows after source repair.
- Keep batch size conservative if OCC conflicts appear.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/migrations/eraseLegacyLifecycleState.ts` | Modify | Projection/aggregate refresh migrations |

---

### 5E - Delete Meeting Reviews and Legacy Domain Event Effects

**Type:** Migration
**Parallelizable:** No - run after source repair so no code needs reviews.

**What:** Delete all `meetingReviews` rows and remove/ignore overran/start/end event effects that feed reports.

**Why:** Phase 6 deletes the `meetingReviews` table. Rows must be gone before schema narrow.

**Where:**
- `convex/migrations/eraseLegacyLifecycleState.ts` (modify)
- `convex/reporting/activityFeed.ts` (already cleaned in Phase 4; verify)

**How:**

**Step 1: Delete review rows.**

```typescript
// Path: convex/migrations/eraseLegacyLifecycleState.ts
export const deleteMeetingReviews = migrations.define({
  table: "meetingReviews",
  batchSize: 50,
  migrateOne: async (ctx, row) => {
    await ctx.db.delete(row._id);
  },
});
```

**Step 2: Decide event retention.**

Do not delete domain events unless product explicitly wants historical audit removal. The design requires deleting/ignoring event effects where they feed activity/reporting. If domain events are retained, Phase 4/6 code must not label or bucket them.

```typescript
// Path: convex/reporting/activityFeed.ts
// Event rendering should not include review_resolved_* or meeting.overran_* labels.
```

**Key implementation notes:**
- Review rows are never used as repair evidence.
- If `meeting.reviewId` was stripped in 5B, review deletion can run independently.
- If raw webhook replay utilities also delete `meetingReviews`, update them in Phase 6 after the table is removed.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/migrations/eraseLegacyLifecycleState.ts` | Modify | Delete meetingReviews rows |
| `convex/reporting/activityFeed.ts` | Verify | No review/overran event effects |

---

### 5F - Production Runbook and Verification Gate

**Type:** Manual / Migration / Release Gate
**Parallelizable:** No - run sequentially in production.

**What:** Execute the production cleanup safely and produce the go/no-go evidence for Phase 6.

**Why:** Phase 6 schema narrow must not be attempted until Convex data-at-rest is clean.

**Where:**
- Production Convex deployment
- `convex/audits/legacyLifecycle.ts`
- `@convex-dev/migrations` component status

**How:**

**Step 1: Deploy temporary migration/audit code.**

```bash
# Path: shell
pnpm tsc --noEmit
npx convex deploy
```

**Step 2: Dry-run every migration in order.**

```bash
# Path: shell
npx convex run --prod migrations:run '{"fn":"migrations/eraseLegacyLifecycleState:stripLegacyLifecycleFields","dryRun":true}'
npx convex run --prod migrations:run '{"fn":"migrations/eraseLegacyLifecycleState:repairLegacyLifecycleMeetings","dryRun":true}'
npx convex run --prod migrations:run '{"fn":"migrations/eraseLegacyLifecycleState:repairStandaloneLegacyOpportunities","dryRun":true}'
npx convex run --prod migrations:run '{"fn":"migrations/eraseLegacyLifecycleState:refreshStatusProjections","dryRun":true}'
npx convex run --prod migrations:run '{"fn":"migrations/eraseLegacyLifecycleState:refreshMeetingOperationsStats","dryRun":true}'
npx convex run --prod migrations:run '{"fn":"migrations/eraseLegacyLifecycleState:deleteMeetingReviews","dryRun":true}'
```

**Step 3: Run migrations in order.**

```bash
# Path: shell
npx convex run --prod migrations:run '{"fn":"migrations/eraseLegacyLifecycleState:stripLegacyLifecycleFields"}'
npx convex run --prod migrations:run '{"fn":"migrations/eraseLegacyLifecycleState:repairLegacyLifecycleMeetings"}'
npx convex run --prod migrations:run '{"fn":"migrations/eraseLegacyLifecycleState:repairStandaloneLegacyOpportunities"}'
npx convex run --prod migrations:run '{"fn":"migrations/eraseLegacyLifecycleState:refreshStatusProjections"}'
npx convex run --prod migrations:run '{"fn":"migrations/eraseLegacyLifecycleState:refreshMeetingOperationsStats"}'
npx convex run --prod migrations:run '{"fn":"migrations/eraseLegacyLifecycleState:deleteMeetingReviews"}'
npx convex run --prod --component migrations lib:getStatus --watch
```

**Step 4: Verify hard gates.**

```bash
# Path: shell
npx convex run --prod audits/legacyLifecycle:countLegacyLifecycleRows
npx convex run --prod audits/legacyLifecycle:compareLifecycleAggregates
npx convex data --prod meetingReviews --limit 1
npx convex data --prod _scheduled_functions --limit 50
```

Expected:

- `countLegacyLifecycleRows` returns zeros for all legacy status/projection/review counters.
- `compareLifecycleAggregates` returns `ok: true`.
- `meetingReviews` returns no rows.
- `_scheduled_functions` has no pending `checkMeetingAttendance` references.

**Step 5: Repeat targeted repair if needed.**

If any counter is nonzero, do not proceed to Phase 6. Re-run the relevant migration, reduce batch size if needed, and re-run audits.

**Key implementation notes:**
- If a migration fails midway, re-running the same `migrations:run` resumes via the component.
- Keep a copy of command output in the implementation PR or release notes.
- Phase 6 is blocked until this subphase is green.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| Production Convex data | Migrate | Repair and cleanup |
| `convex/audits/legacyLifecycle.ts` | Run | Hard gate evidence |
| `@convex-dev/migrations` component state | Monitor | Resume/status tracking |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/migrations/eraseLegacyLifecycleState.ts` | Create | 5A-5E |
| `convex/migrations/legacyLifecycleRepair.ts` | Create | 5A, 5C |
| `convex/audits/legacyLifecycle.ts` | Create | 5A, 5F |
| `convex/migrations.ts` | Modify / verify | 5A |
| Production `meetings` | Migrate | 5B, 5C, 5D |
| Production `opportunities` | Migrate | 5C, 5D |
| Production `opportunitySearch` | Refresh | 5D |
| Production `operationsMeetingDailyStats` | Refresh / repair | 5D |
| Production `operationsQualificationRows` | Refresh | 5D |
| Production `meetingReviews` | Delete rows | 5E |
| Production `_scheduled_functions` | Cancel / verify | 5B, 5F |
