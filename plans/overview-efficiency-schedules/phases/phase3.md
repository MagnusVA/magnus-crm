# Phase 3 — Efficient Overview Efficiency Builders

**Status:** Code complete; browser/production evidence pending (2026-06-01)
**Goal:** Refactor overview backend builders so Lead Gen, Top Qualifiers, and Top DM Closers can rank by per-hour efficiency while keeping first-paint reads bounded. After this phase, `getOverviewDashboard` returns top-5 efficiency rows with raw counts and scheduled-hour context.

**Prerequisite:** Phase 1 complete. Phase 2 can run concurrently but is not required for backend calculations.

**Runs in PARALLEL with:** Phase 2 after Phase 1. Phase 3 owns `convex/dashboard/**`, schedule-hour helpers, and shared backend row builders.

**Skills to invoke:**
- `convex-performance-audit` — preserve indexed reads, bounded caps, aggregate usage, and small return payloads.
- `convex-migration-helper` — only if implementation introduces a new persisted aggregate/backfill; not expected for MVP.
- `vercel-react-best-practices` — keep one dashboard subscription and avoid payload growth.

**Acceptance Criteria:**
1. `convex/workSchedules/rangeHours.ts` computes scheduled hours from weekly schedule rows for every business date in the selected range.
2. The helper uses Sunday-first weekday lookup indirectly through `weekdayForBusinessDate()`.
3. Lead Gen overview ranks top workers by `leadsPerHour`, then submissions, then display name.
4. Existing Lead Gen Ops reports and exports keep their current sort order.
5. Top Qualifiers use unique Slack-qualified opportunities as the primary numerator and avoid raw event count as the ranked metric.
6. Slack qualifier ranking uses existing Slack aggregate components where practical and keeps raw-event detail bounded.
7. Top DM Closers keep the existing bounded `meetings.by_tenantId_and_createdAt` scan for MVP.
8. Scheduled zero-activity actors can be included by shared builders for expanded use.
9. No new per-day schedule bucket table, cron, action, or data backfill is introduced.
10. `pnpm tsc --noEmit` passes without errors.

**Verification:** `pnpm tsc --noEmit` passed on 2026-06-01. Targeted ESLint for Phase 3 touched files passed on 2026-06-01. Convex schema/function generation passed with `npx convex dev --once` on 2026-06-01. No new schedule bucket, cron, action, aggregate, or backfill was introduced.

---

## Subphase Dependency Graph

```
3A (range-hours helper) ─────┬── 3B (Lead Gen efficiency rows) ───────┐
                             ├── 3C (Slack aggregate rows) ───────────┤
                             ├── 3D (DM closer booked rows) ──────────┤── 3E (top-5 overview wiring)
                             └── 3F (shared efficiency sort/types) ───┘
```

**Optimal execution:**
1. Start 3A and 3F first; all row builders need schedule-hour and sort helpers.
2. Run 3B, 3C, and 3D in parallel because they touch separate overview sections.
3. Finish with 3E, wiring the shared builders into `getOverviewDashboard`.

**Estimated time:** 2-3 days

---

## Subphases

### 3A — Range Scheduled-Hours Helpers

**Type:** Backend  
**Parallelizable:** No — all efficiency builders depend on this denominator helper.

**What:** Create shared read-time helpers that sum weekly scheduled hours over the selected business-date range.

**Why:** The design explicitly avoids per-day schedule bucket tables. Denominators must include zero-output scheduled days and must not depend on activity rows.

**Where:**
- `convex/workSchedules/rangeHours.ts` (create)
- `convex/leadGen/schedules.ts` (modify only if reusing the helper is clean)

**How:**

**Step 1: Build business date expansion.**

```typescript
// Path: convex/workSchedules/rangeHours.ts
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { addBusinessDays } from "../reporting/lib/hondurasBusinessTime";
import { type Weekday, weekdayForBusinessDate } from "../lib/workSchedule";

export function businessDatesInInclusiveRange(args: {
  startBusinessDate: string;
  endBusinessDateInclusive: string;
}) {
  const days: string[] = [];
  for (
    let day = args.startBusinessDate;
    day <= args.endBusinessDateInclusive;
    day = addBusinessDays(day, 1)
  ) {
    days.push(day);
  }
  return days;
}

function sumHoursForWeekdayRows(
  rows: Array<{ weekday: Weekday; scheduledHours: number }>,
  businessDates: string[],
) {
  const byWeekday = new Map(rows.map((row) => [row.weekday, row.scheduledHours]));
  return businessDates.reduce((sum, dayKey) => {
    const weekday = weekdayForBusinessDate(dayKey);
    return sum + (byWeekday.get(weekday) ?? 0);
  }, 0);
}
```

**Step 2: Add actor-specific loaders.**

```typescript
// Path: convex/workSchedules/rangeHours.ts
export async function loadDmCloserScheduledHoursForRange(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    dmCloserIds: Id<"dmClosers">[];
    startBusinessDate: string;
    endBusinessDateInclusive: string;
  },
) {
  const businessDates = businessDatesInInclusiveRange(args);
  const result = new Map<Id<"dmClosers">, number>();

  for (const dmCloserId of args.dmCloserIds) {
    const rows = await ctx.db
      .query("dmCloserSchedules")
      .withIndex("by_tenantId_and_dmCloserId", (q) =>
        q.eq("tenantId", args.tenantId).eq("dmCloserId", dmCloserId),
      )
      .take(7);
    result.set(dmCloserId, sumHoursForWeekdayRows(rows, businessDates));
  }

  return result;
}
```

**Key implementation notes:**
- `args.dmCloserIds`, `slackUserIds`, and `workerIds` are already registry-capped.
- Each actor schedule read is capped at seven rows.
- Do not write schedule-hour snapshots for Slack/DM in MVP.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/workSchedules/rangeHours.ts` | Create | Shared denominator helpers |
| `convex/leadGen/schedules.ts` | Modify | Optional helper reuse only |

### 3B — Lead Gen Efficiency Rows

**Type:** Backend  
**Parallelizable:** Yes — independent of Slack and DM builder work after 3A/3F.

**What:** Build dashboard-specific Lead Gen rows sorted by `leadsPerHour` while preserving existing Lead Gen report behavior.

**Why:** Current `buildWorkerPerformanceRows()` calculates `leadsPerHour` but sorts by submissions. The dashboard needs efficiency sort; exports do not.

**Where:**
- `convex/dashboard/overviewLeaderboardBuilders.ts` (create)
- `convex/dashboard/overviewLeadGen.ts` (modify)
- `convex/leadGen/reportBuilders.ts` (read/avoid broad refactor)

**How:**

**Step 1: Build candidates as activity workers plus scheduled workers.**

```typescript
// Path: convex/dashboard/overviewLeaderboardBuilders.ts
const candidateWorkerIds = new Set<Id<"leadGenWorkers">>();
for (const row of dailyRows) candidateWorkerIds.add(row.workerId);
for (const schedule of scheduleRows) candidateWorkerIds.add(schedule.workerId);
if (includeAllCandidates) {
  for (const worker of tenantWorkers) candidateWorkerIds.add(worker._id);
}
```

**Step 2: Sort with nullable efficiency.**

```typescript
// Path: convex/dashboard/overviewLeadGen.ts
const rows = await buildLeadGenEfficiencyRows(ctx, {
  tenantId,
  range,
  includeAllCandidates: false,
});

return {
  data: {
    ...summary,
    topWorkers: rows.slice(0, TOP_OVERVIEW_WORKER_LIMIT),
  },
  isEmpty: rows.length === 0,
};
```

**Key implementation notes:**
- Existing reports should keep using `buildWorkerPerformanceRows()` and its quantity-first sort.
- Only the dashboard builder should apply efficiency-first sorting.
- Do not mutate `leadGenDailyStats.scheduledHours`; use current schedule rows for the overview denominator.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/dashboard/overviewLeaderboardBuilders.ts` | Create | Shared efficiency rows |
| `convex/dashboard/overviewLeadGen.ts` | Modify | Use efficiency rows for overview |

### 3C — Slack Qualifier Aggregate Rows

**Type:** Backend  
**Parallelizable:** Yes — independent after 3A/3F.

**What:** Build qualifier rows using unique Slack-qualified opportunities as numerator and scheduled hours as denominator.

**Why:** Raw event count inflates duplicate/unlinked activity. Existing aggregate components already count Slack-qualified opportunities by user and submitted time.

**Where:**
- `convex/dashboard/overviewLeaderboardBuilders.ts` (modify)
- `convex/dashboard/overviewSlack.ts` (modify)
- `convex/reporting/aggregates.ts` (read)
- `convex/reporting/lib/slackQualificationBreakdown.ts` (modify only if needed)

**How:**

**Step 1: Count aggregate numerator per candidate.**

```typescript
// Path: convex/dashboard/overviewLeaderboardBuilders.ts
import { slackQualificationsByUser } from "../reporting/aggregates";

async function countSlackQualifiedForUser(ctx: QueryCtx, args: {
  tenantId: Id<"tenants">;
  slackUserId: string;
  start: number;
  end: number;
}) {
  return await slackQualificationsByUser.count(ctx, {
    namespace: args.tenantId,
    bounds: {
      lower: { key: [args.slackUserId, args.start], inclusive: true },
      upper: { key: [args.slackUserId, args.end], inclusive: false },
    },
  });
}
```

**Step 2: Preserve bounded raw-event context.**

```typescript
// Path: convex/dashboard/overviewSlack.ts
// Keep existing truncation behavior for event-level secondary context.
// Do not slice top 5 by raw event count before aggregate/schedule enrichment.
```

**Key implementation notes:**
- Aggregate counts are the primary ranked metric.
- Raw event detail can supply `booked`, `total`, or ratio context only if bounded and marked truncated.
- If aggregate verification fails in production, fall back to bounded ledger behavior and keep the section capped/partial.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/dashboard/overviewLeaderboardBuilders.ts` | Modify | Qualifier rows |
| `convex/dashboard/overviewSlack.ts` | Modify | Use shared builder |
| `convex/reporting/lib/slackQualificationBreakdown.ts` | Modify | Only if needed to avoid early slicing |

### 3D — DM Closer Booked Rows

**Type:** Backend  
**Parallelizable:** Yes — independent after 3A/3F.

**What:** Build DM closer rows with booked calls per scheduled hour.

**Why:** Existing Top DM Closers card already scans bookings by `createdAt` and excludes follow-ups. MVP should preserve that behavior and add the denominator.

**Where:**
- `convex/dashboard/overviewLeaderboardBuilders.ts` (modify)
- `convex/dashboard/overviewOperations.ts` (modify)

**How:**

**Step 1: Keep existing bounded scan.**

```typescript
// Path: convex/dashboard/overviewOperations.ts
const meetings = await ctx.db
  .query("meetings")
  .withIndex("by_tenantId_and_createdAt", (q) =>
    q
      .eq("tenantId", tenantId)
      .gte("createdAt", range.slackWindowStart)
      .lt("createdAt", range.slackWindowEnd),
  )
  .take(TOP_DM_CLOSER_BOOKING_LIMIT + 1);
```

**Step 2: Union activity and scheduled candidates.**

```typescript
// Path: convex/dashboard/overviewLeaderboardBuilders.ts
const candidateDmCloserIds = new Set<Id<"dmClosers">>();
for (const dmCloserId of byDmCloser.keys()) candidateDmCloserIds.add(dmCloserId);
for (const schedule of dmCloserSchedules) candidateDmCloserIds.add(schedule.dmCloserId);
if (includeAllCandidates) {
  for (const closer of dmClosers) candidateDmCloserIds.add(closer._id);
}
```

**Key implementation notes:**
- Do not use `operationsMeetingDailyStats`; it is scheduled-call-day oriented, not booking-created-day oriented.
- Do not add a DM closer aggregate in MVP unless the bounded scan is measured as a real issue.
- Legacy rows with missing `callClassification` still count as new bookings unless explicitly `"follow_up"`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/dashboard/overviewLeaderboardBuilders.ts` | Modify | DM closer rows |
| `convex/dashboard/overviewOperations.ts` | Modify | Use shared builder |

### 3E — Top-5 Overview Wiring

**Type:** Backend  
**Parallelizable:** No — depends on 3B-3D.

**What:** Wire shared builders into `getOverviewDashboard` section helpers and keep the initial payload top-5 only.

**Why:** The expanded leaderboard query in Phase 4 reuses the same builders with `includeAllCandidates: true`. The dashboard first paint should stay small.

**Where:**
- `convex/dashboard/overviewBuilders.ts` (read/avoid broad changes)
- `convex/dashboard/overviewLeadGen.ts` (modify)
- `convex/dashboard/overviewSlack.ts` (modify)
- `convex/dashboard/overviewOperations.ts` (modify)
- `convex/dashboard/overviewTypes.ts` (modify)

**How:**

```typescript
// Path: convex/dashboard/overviewSlack.ts
export async function getTopQualifiersOverviewSection(ctx, tenantId, range) {
  const rows = await buildQualifierEfficiencyRows(ctx, {
    tenantId,
    range,
    includeAllCandidates: false,
  });
  return {
    data: {
      totalQualified: rows.reduce((sum, row) => sum + row.uniqueOpportunityCount, 0),
      rows: rows.slice(0, 5),
    },
    isEmpty: rows.length === 0,
  };
}
```

**Key implementation notes:**
- Do not include expanded rows in `getOverviewDashboard`.
- Existing `resolveSection()` should continue isolating section errors.
- If one section hits a cap, other dashboard sections should still render.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/dashboard/overviewTypes.ts` | Modify | Add efficiency fields |
| `convex/dashboard/overviewLeadGen.ts` | Modify | Top 5 by efficiency |
| `convex/dashboard/overviewSlack.ts` | Modify | Top 5 by efficiency |
| `convex/dashboard/overviewOperations.ts` | Modify | Top 5 by efficiency |

### 3F — Efficiency Sort Helper

**Type:** Backend  
**Parallelizable:** Yes — can start after 3A.

**What:** Add one nullable efficiency comparator shared by all builders.

**Why:** Null-rate rows should sort below configured workers consistently across all leaderboards.

**Where:**
- `convex/dashboard/efficiencySort.ts` (create)

**How:**

```typescript
// Path: convex/dashboard/efficiencySort.ts
export function compareNullableEfficiency(args: {
  leftRate: number | null;
  rightRate: number | null;
  leftCount: number;
  rightCount: number;
  leftName: string;
  rightName: string;
}) {
  const leftHasRate = args.leftRate !== null;
  const rightHasRate = args.rightRate !== null;
  if (leftHasRate !== rightHasRate) return leftHasRate ? -1 : 1;
  if (args.leftRate !== args.rightRate) {
    return (args.rightRate ?? -1) - (args.leftRate ?? -1);
  }
  if (args.leftCount !== args.rightCount) return args.rightCount - args.leftCount;
  return args.leftName.localeCompare(args.rightName);
}
```

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/dashboard/efficiencySort.ts` | Create | Shared comparator |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/workSchedules/rangeHours.ts` | Create | 3A |
| `convex/leadGen/schedules.ts` | Modify | 3A optional |
| `convex/dashboard/overviewLeaderboardBuilders.ts` | Create | 3B, 3C, 3D |
| `convex/dashboard/efficiencySort.ts` | Create | 3F |
| `convex/dashboard/overviewLeadGen.ts` | Modify | 3B, 3E |
| `convex/dashboard/overviewSlack.ts` | Modify | 3C, 3E |
| `convex/dashboard/overviewOperations.ts` | Modify | 3D, 3E |
| `convex/dashboard/overviewTypes.ts` | Modify | 3E |
