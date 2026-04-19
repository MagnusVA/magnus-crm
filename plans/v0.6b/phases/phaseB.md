# Phase B — Team Report Completion

**Goal:** Rebuild the Team Performance report so it (a) stops misreporting review-flagged meetings as attendance failures, (b) surfaces the four commercial KPIs the backend already computes and the UI silently drops, (c) adds the Tier 2 derived-outcome KPIs (Lost Deals, Rebook Rate, Meeting Outcome Distribution, Actions per Closer), and (d) adds a Tier 3 Meeting Time subsection (On-Time Start Rate, Avg Late Start, Overran Rate, Avg Overrun, Avg Actual Duration, Schedule Adherence, Manually Corrected Count). Read-side only — no schema change, no write change.

**Prerequisite:** None. Phase B consumes data that is already being written (`meetings.startedAt`, `meetings.lateStartDurationMs`, `meetings.exceededScheduledDurationMs`, `meetings.startedAtSource`, `meetings.stoppedAtSource`, `paymentRecords.amountMinor`, `opportunities.status`, etc.) and existing aggregates (`meetingsByStatus` already keys `"meeting_overran"` as a distinct status — no aggregate change needed).

**Runs in PARALLEL with:** Phase A, Phase C, Phase D, Phase E, Phase F, Phase H. Phase G may land earlier or later — Phase B does **not** depend on Phase G's origin fields, but once Phase G ships, the team performance response gains one secondary column ("Admin-logged revenue") that is *layered on top* (handled in Phase G's reporting consumer step, not here).

**Skills to invoke:**
- `convex-performance-audit` — Phase B extends `getTeamPerformanceMetrics` with a second meeting scan. Verify document-read count stays within budget at current volume; re-verify if any tenant exceeds 1,000 meetings/month.
- `shadcn` — new table columns, new summary cards, Meeting Outcome Distribution chart (uses `components/ui/chart.tsx` Recharts wrapper + `PieChart`).
- `web-design-guidelines` — expanded 10-column table needs horizontal scroll on mobile, keyboard-navigable column headers; new chart needs accessible legend.
- `frontend-design` — balance information density: don't turn the team table into an unreadable wall of numbers. Split into two visual groups (attendance | commercial) with a thin vertical divider.
- `vercel-react-best-practices` — summary cards and charts must not re-render on every `useQuery` tick; memoize derivations.

**Acceptance Criteria:**
1. `meeting_overran` no longer contributes to `noShows` in the per-closer metrics returned by `getTeamPerformanceMetrics` — verified by writing a test fixture with one `meeting_overran` and one `no_show` meeting for the same closer and asserting `noShows === 1`, not `2`.
2. `meeting_overran` is excluded from the show-up-rate denominator — verified by the same fixture asserting `showUpRate === callsShowed / (bookedCalls − canceledCalls − reviewRequiredCalls)`.
3. The per-closer response exposes `reviewRequiredCalls` (the count of `meeting_overran` meetings) as a first-class field on both `newCalls` and `followUpCalls`.
4. The `CloserPerformanceTable` renders a new `Review Required` column between `No Shows` and `Showed`.
5. The `CloserPerformanceTable` renders four additional columns on the right: `Sales`, `Cash Collected`, `Close Rate`, `Avg Deal` — and footer totals for each.
6. The `TeamKpiSummaryCards` renders three new cards — **Lost Deals**, **Rebook Rate**, **Actions per Closer (daily avg)** — in addition to the existing four.
7. A new **Meeting Outcome Distribution** chart (pie) renders below the tables using the `byOutcome` rollup from the new `getTeamOutcomeMix` query.
8. A new **Meeting Time** subsection renders below the existing tables with 7 KPIs (On-Time Start Rate, Avg Late Start, Overran Rate, Avg Overrun, Avg Actual Duration, Schedule Adherence, Manually Corrected Count) — all derived from the `meetingTime` block extended onto `getTeamPerformanceMetrics`.
9. Truncation banner ("Only showing first 2,000 meetings — narrow the date range for full data") displays when the outcome-mix or meeting-time scan hits its `.take(2000)` bound.
10. Numbers cross-check against a hand-computed January + February 2026 sample within 5% tolerance (manual QA — see `TESTING.MD`).
11. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
B1 (teamPerformance.ts: split + meetingTime block — backend) ──┐
                                                                ├── B4 (CloserPerformanceTable columns — frontend; needs B1)
                                                                │
B2 (teamOutcomes.ts new query — backend) ──────────────────────┤── B5 (TeamKpiSummaryCards + OutcomeDistribution chart — frontend; needs B1+B2+B3)
                                                                │
B3 (actionsPerCloser — backend: domainEvents scan) ────────────┘── B6 (MeetingTime subsection — frontend; needs B1)
```

**Optimal execution:**
1. **Backend stream (parallel):** Start B1, B2, B3 simultaneously. They touch three different backend files (`teamPerformance.ts`, `teamOutcomes.ts` new file, `teamActions.ts` new file) with zero shared state.
2. **Frontend stream (parallel after backend):** Once B1 lands, B4 and B6 can start (they need the extended `getTeamPerformanceMetrics` response). B5 needs B1, B2, and B3 (renders all three response shapes).
3. All three frontend subphases touch different files and can ship in parallel as backend merges.

**Estimated time:** 3 days (solo); 1.5 days with backend + frontend parallel; ~1 day with 3 agents (backend split across B1/B2/B3 + frontend split across B4/B5/B6).

---

## Subphases

### B1 — `teamPerformance.ts`: Split `meeting_overran` + Extend with `meetingTime`

**Type:** Backend (query handler refactor + extension)
**Parallelizable:** Yes — only edits `convex/reporting/teamPerformance.ts`. No other phase modifies this file.

**What:** (a) Stop merging `meeting_overran` into `noShows` at lines 160-162. (b) Expose `reviewRequiredCalls` as a first-class response field. (c) Remove `meeting_overran` from the show-up-rate denominator. (d) Add a second pass through the meeting set that computes per-closer meeting-time metrics (`meetingTime` block) and a `teamMeetingTime` roll-up.

**Why:** The merge at `:160-163` conflates two semantically different concepts — "closer didn't show up" vs "system can't confirm attendance, review required." This is the most visible data-quality bug in v0.6 reporting (it pushes show-up rate artificially low for tenants that use the overran sweep). The `meetingTime` block unlocks Phase B.4 KPIs (Tier 3 from v0.6 design) without requiring a second Convex subscription.

**Where:**
- `convex/reporting/teamPerformance.ts` (modify)

**How:**

**Step 1: Surface `meeting_overran` as a distinct classification field.**

Current code (`:140-170`) computes `bookedCalls`, `canceledCalls`, `noShows`, `callsShowed`, `showUpRate` per classification (`new` / `follow_up`). The new response shape surfaces `reviewRequiredCalls` alongside.

```typescript
// Path: convex/reporting/teamPerformance.ts

// BEFORE (lines ~145–170):
const buildClassificationMetrics = (classification: CallClassification) => {
  const countsForClassification = closerCounts[classification];
  const bookedCalls = MEETING_STATUSES.reduce(
    (sum, status) => sum + countsForClassification[status],
    0,
  );
  const canceledCalls = countsForClassification.canceled;
  const callsShowed =
    countsForClassification.completed + countsForClassification.in_progress;
  const showRateDenominator = bookedCalls - canceledCalls;

  return {
    bookedCalls,
    canceledCalls,
    noShows:
      countsForClassification.no_show +
      countsForClassification.meeting_overran, // <-- bug
    callsShowed,
    showUpRate: toRate(callsShowed, showRateDenominator),
  };
};

// AFTER:
const buildClassificationMetrics = (classification: CallClassification) => {
  const countsForClassification = closerCounts[classification];
  const bookedCalls = MEETING_STATUSES.reduce(
    (sum, status) => sum + countsForClassification[status],
    0,
  );
  const canceledCalls = countsForClassification.canceled;
  const noShows = countsForClassification.no_show;
  const reviewRequiredCalls = countsForClassification.meeting_overran;
  const callsShowed =
    countsForClassification.completed + countsForClassification.in_progress;

  // Attendance-ambiguous meetings (meeting_overran) are neither "showed" nor
  // "did not show" until a review resolves them. Exclude from both numerator
  // and denominator of show-up rate. See §5.2 in plans/v0.6b/v0-6b-design.md.
  const confirmedAttendanceDenominator =
    bookedCalls - canceledCalls - reviewRequiredCalls;

  return {
    bookedCalls,
    canceledCalls,
    noShows,
    reviewRequiredCalls, // v0.6b — surfaced as its own field
    callsShowed,
    confirmedAttendanceDenominator, // exposed so the UI can show "{callsShowed} of {N} eligible"
    showUpRate: toRate(callsShowed, confirmedAttendanceDenominator),
  };
};
```

**Step 2: Update the team roll-up.**

The existing `teamTotals` reducer (around `:186-220`) sums across closers. Add `reviewRequiredCalls` to both `new` and `follow_up` rolls, and update `overallShowUpRate` to use the new denominator.

```typescript
// Path: convex/reporting/teamPerformance.ts

// Inside the team totals reducer:
const teamTotals = closerResults.reduce(
  (acc, closer) => ({
    newBookedCalls: acc.newBookedCalls + closer.newCalls.bookedCalls,
    newCanceled: acc.newCanceled + closer.newCalls.canceledCalls,
    newNoShows: acc.newNoShows + closer.newCalls.noShows,
    newReviewRequired: acc.newReviewRequired + closer.newCalls.reviewRequiredCalls, // NEW
    newShowed: acc.newShowed + closer.newCalls.callsShowed,

    followUpBookedCalls: acc.followUpBookedCalls + closer.followUpCalls.bookedCalls,
    followUpCanceled: acc.followUpCanceled + closer.followUpCalls.canceledCalls,
    followUpNoShows: acc.followUpNoShows + closer.followUpCalls.noShows,
    followUpReviewRequired:                                                         // NEW
      acc.followUpReviewRequired + closer.followUpCalls.reviewRequiredCalls,
    followUpShowed: acc.followUpShowed + closer.followUpCalls.callsShowed,

    totalSales: acc.totalSales + closer.sales,
    totalRevenueMinor: acc.totalRevenueMinor + closer.cashCollectedMinor,
  }),
  {
    newBookedCalls: 0, newCanceled: 0, newNoShows: 0, newReviewRequired: 0, newShowed: 0,
    followUpBookedCalls: 0, followUpCanceled: 0, followUpNoShows: 0,
    followUpReviewRequired: 0, followUpShowed: 0,
    totalSales: 0, totalRevenueMinor: 0,
  },
);

// Derived overall rates:
const totalBooked = teamTotals.newBookedCalls + teamTotals.followUpBookedCalls;
const totalCanceled = teamTotals.newCanceled + teamTotals.followUpCanceled;
const totalReviewRequired =
  teamTotals.newReviewRequired + teamTotals.followUpReviewRequired;
const totalShowed = teamTotals.newShowed + teamTotals.followUpShowed;
const overallConfirmedDenominator =
  totalBooked - totalCanceled - totalReviewRequired;

return {
  closers: closerResults,
  teamTotals: {
    ...teamTotals,
    overallShowUpRate: toRate(totalShowed, overallConfirmedDenominator),
    overallCloseRate: toRate(teamTotals.totalSales, totalShowed),
    overallConfirmedDenominator,
    totalReviewRequired, // surfaced for the KPI header
  },
  meetingTime: teamMeetingTime,    // from Step 4 below
  isPaymentDataTruncated,          // existing flag preserved
  isMeetingTimeTruncated,          // from Step 4 below
};
```

**Step 3: Plumb per-closer meeting-time scan.**

After the existing per-closer classification loop completes, add a second pass that scans meetings whose `startedAt`/`stoppedAt` falls in the date range. Use the existing `by_tenantId_and_scheduledAt` index with `.take(2000)` as the safety bound (same pattern Phase C uses for `getMeetingTimeMetrics`).

```typescript
// Path: convex/reporting/teamPerformance.ts

// NEW — v0.6b meeting-time scan. Runs after the main classification loop.
//       Shares the same date range → no extra subscription cost.

type CloserMeetingTimeMetrics = {
  startedMeetingsCount: number;
  onTimeStartCount: number;
  lateStartCount: number;
  totalLateStartMs: number;
  completedWithDurationCount: number;
  overranCount: number;
  totalOverrunMs: number;
  totalActualDurationMs: number;
  scheduleAdherentCount: number;
  manuallyCorrectedCount: number;
};

const emptyMeetingTime = (): CloserMeetingTimeMetrics => ({
  startedMeetingsCount: 0,
  onTimeStartCount: 0,
  lateStartCount: 0,
  totalLateStartMs: 0,
  completedWithDurationCount: 0,
  overranCount: 0,
  totalOverrunMs: 0,
  totalActualDurationMs: 0,
  scheduleAdherentCount: 0,
  manuallyCorrectedCount: 0,
});

const meetingsInRange = await ctx.db
  .query("meetings")
  .withIndex("by_tenantId_and_scheduledAt", (q) =>
    q
      .eq("tenantId", tenantId)
      .gte("scheduledAt", startDate)
      .lt("scheduledAt", endDate),
  )
  .take(2000);

const isMeetingTimeTruncated = meetingsInRange.length >= 2000;
const perCloserMeetingTime = new Map<Id<"users">, CloserMeetingTimeMetrics>();

for (const m of meetingsInRange) {
  // Only completed + meeting_overran have useful time data. no_show/canceled/scheduled
  // either have no timing or have timing that should not be mixed into performance KPIs.
  if (m.status !== "completed" && m.status !== "meeting_overran") continue;

  const closerId = m.assignedCloserId;
  const mt = perCloserMeetingTime.get(closerId) ?? emptyMeetingTime();

  if (m.startedAt !== undefined) {
    mt.startedMeetingsCount++;
    const lateMs = m.lateStartDurationMs ?? 0;
    if (lateMs === 0) mt.onTimeStartCount++;
    else {
      mt.lateStartCount++;
      mt.totalLateStartMs += lateMs;
    }
  }

  if (m.startedAt !== undefined && m.stoppedAt !== undefined) {
    mt.completedWithDurationCount++;
    const actualMs = m.stoppedAt - m.startedAt;
    mt.totalActualDurationMs += actualMs;
    const overrunMs = m.exceededScheduledDurationMs ?? 0;
    if (overrunMs > 0) {
      mt.overranCount++;
      mt.totalOverrunMs += overrunMs;
    }
    const lateMs = m.lateStartDurationMs ?? 0;
    if (lateMs === 0 && overrunMs === 0) mt.scheduleAdherentCount++;
  }

  if (
    m.startedAtSource === "admin_manual" ||
    m.stoppedAtSource === "admin_manual"
  ) {
    mt.manuallyCorrectedCount++;
  }

  perCloserMeetingTime.set(closerId, mt);
}

// Attach meetingTime to each closer result and compute team totals.
const closerResultsWithMeetingTime = closerResults.map((closer) => ({
  ...closer,
  meetingTime: perCloserMeetingTime.get(closer.closerId) ?? emptyMeetingTime(),
}));

const teamMeetingTime = Array.from(perCloserMeetingTime.values()).reduce(
  (acc, mt) => ({
    startedMeetingsCount: acc.startedMeetingsCount + mt.startedMeetingsCount,
    onTimeStartCount: acc.onTimeStartCount + mt.onTimeStartCount,
    lateStartCount: acc.lateStartCount + mt.lateStartCount,
    totalLateStartMs: acc.totalLateStartMs + mt.totalLateStartMs,
    completedWithDurationCount:
      acc.completedWithDurationCount + mt.completedWithDurationCount,
    overranCount: acc.overranCount + mt.overranCount,
    totalOverrunMs: acc.totalOverrunMs + mt.totalOverrunMs,
    totalActualDurationMs:
      acc.totalActualDurationMs + mt.totalActualDurationMs,
    scheduleAdherentCount:
      acc.scheduleAdherentCount + mt.scheduleAdherentCount,
    manuallyCorrectedCount:
      acc.manuallyCorrectedCount + mt.manuallyCorrectedCount,
  }),
  emptyMeetingTime(),
);
```

**Step 4: Expose aggregates as KPI-ready ratios (compute at query time).**

```typescript
// Path: convex/reporting/teamPerformance.ts

// Helper — compute ratio-form KPIs at query time; undefined when denominator is 0.
// Rationale: storing rates would invite drift; computing is cheap (≤ 2000 meetings).
function meetingTimeKpis(mt: CloserMeetingTimeMetrics) {
  return {
    ...mt,
    onTimeStartRate:
      mt.startedMeetingsCount > 0
        ? mt.onTimeStartCount / mt.startedMeetingsCount
        : null,
    avgLateStartMs:
      mt.lateStartCount > 0 ? mt.totalLateStartMs / mt.lateStartCount : null,
    overranRate:
      mt.completedWithDurationCount > 0
        ? mt.overranCount / mt.completedWithDurationCount
        : null,
    avgOverrunMs: mt.overranCount > 0 ? mt.totalOverrunMs / mt.overranCount : null,
    avgActualDurationMs:
      mt.completedWithDurationCount > 0
        ? mt.totalActualDurationMs / mt.completedWithDurationCount
        : null,
    scheduleAdherenceRate:
      mt.completedWithDurationCount > 0
        ? mt.scheduleAdherentCount / mt.completedWithDurationCount
        : null,
  };
}

return {
  closers: closerResultsWithMeetingTime.map((c) => ({
    ...c,
    meetingTime: meetingTimeKpis(c.meetingTime),
  })),
  teamTotals: { /* as in Step 2 */ },
  teamMeetingTime: meetingTimeKpis(teamMeetingTime),
  isPaymentDataTruncated,
  isMeetingTimeTruncated,
};
```

**Key implementation notes:**
- **Do not** modify the `MEETING_STATUSES` array or `CallClassification` type — they are correctly keyed by status including `meeting_overran`. The bug was in the reducer, not the classification.
- `confirmedAttendanceDenominator` is surfaced on each classification so the frontend can write `"{callsShowed} of {denominator} eligible"` directly without recomputing.
- Use `Id<"users">` typed keys for the per-closer map — not strings — to preserve referential integrity.
- The meeting-time scan uses `.take(2000)` — same bound as the Phase C audit. At current volume (~200 meetings/month) a full-year range returns ~2,400 and hits truncation only at >10 months. Document the bound as the contract; Phase C reporting uses the same value.
- `avgLateStartMs` is divided by `lateStartCount` (not `startedMeetingsCount`) because averaging zeros into "on-time" meetings gives a meaningless blended number. Same for `avgOverrunMs`.
- **Do not** mutate the existing `closerResults` shape — prefer `.map` to attach `meetingTime`. This keeps the diff small and `pnpm tsc` happy on the existing `closers` return type.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/teamPerformance.ts` | Modify | Split `meeting_overran`; add `reviewRequiredCalls`; add meeting-time scan + KPIs |

---

### B2 — `teamOutcomes.ts`: Derived-Outcome Mix per Closer (NEW)

**Type:** Backend (new query, new file)
**Parallelizable:** Yes — new file; no conflicts.

**What:** Create `convex/reporting/teamOutcomes.ts` exporting `getTeamOutcomeMix` — a query that scans completed + `meeting_overran` + `canceled` + `no_show` meetings in a date range, derives the call outcome via `deriveCallOutcome`, and rolls up counts per closer and team-wide.

**Why:** Tier 2 KPIs in v0.6 design (`Lost Deals`, `Rebook Rate`, `Meeting Outcome Distribution`) require an outcome classification that depends on join state (opportunity status, payment existence, reschedule chain) — cannot be derived from `meetingsByStatus` alone. `deriveCallOutcome` already exists in `convex/reporting/lib/outcomeDerivation.ts:18-80` and returns `"sold" | "lost" | "no_show" | "canceled" | "rescheduled" | "dq" | "follow_up" | "in_progress" | "scheduled"`. No consumer today — Phase B2 adds the first.

**Where:**
- `convex/reporting/teamOutcomes.ts` (new)

**How:**

**Step 1: Create the query file with scoped imports.**

```typescript
// Path: convex/reporting/teamOutcomes.ts

import { v } from "convex/values";
import { query } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireTenantUser } from "../requireTenantUser";
import {
  deriveCallOutcome,
  type CallOutcome,
} from "./lib/outcomeDerivation";
import { assertValidDateRange, getActiveClosers, getUserDisplayName } from "./lib/helpers";

const MAX_MEETINGS_SCAN = 2000;

type CloserOutcomeCounts = Record<CallOutcome, number>;

const emptyOutcomeCounts = (): CloserOutcomeCounts => ({
  sold: 0,
  lost: 0,
  no_show: 0,
  canceled: 0,
  rescheduled: 0,
  dq: 0,
  follow_up: 0,
  in_progress: 0,
  scheduled: 0,
});

export const getTeamOutcomeMix = query({
  args: { startDate: v.number(), endDate: v.number() },
  handler: async (ctx, { startDate, endDate }) => {
    assertValidDateRange(startDate, endDate);

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    // Scan meetings that can have an outcome (exclude scheduled/in_progress).
    // The status filter is applied post-scan because the by_tenantId_and_scheduledAt
    // index is the one that supports the range; status filtering at index level would
    // require separate scans per status.
    const meetings = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("scheduledAt", startDate)
          .lt("scheduledAt", endDate),
      )
      .take(MAX_MEETINGS_SCAN);

    const isTruncated = meetings.length >= MAX_MEETINGS_SCAN;

    const closers = await getActiveClosers(ctx, tenantId);
    const perCloser = new Map<Id<"users">, CloserOutcomeCounts>();

    // Per-meeting derivation requires: opportunity (for status), payment existence, reschedule chain flag.
    // Batch these lookups by opportunityId to avoid N+1.
    const opportunityIds = Array.from(new Set(meetings.map((m) => m.opportunityId)));
    const opportunities = await Promise.all(
      opportunityIds.map((id) => ctx.db.get(id)),
    );
    const oppById = new Map<Id<"opportunities">, Doc<"opportunities">>();
    for (const opp of opportunities) {
      if (opp) oppById.set(opp._id, opp);
    }

    // hasPayment: scan paymentRecords for this range once, build opp→hasPayment map.
    const payments = await ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId_and_recordedAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("recordedAt", startDate)
          .lt("recordedAt", endDate),
      )
      .take(MAX_MEETINGS_SCAN);
    const oppHasPayment = new Set<Id<"opportunities">>();
    for (const p of payments) {
      // Only opportunity-contextual payments count for "sold" derivation.
      // Customer-flow payments belong to customers, not to the meeting that caused conversion.
      if (p.contextType === "opportunity" && p.opportunityId) {
        oppHasPayment.add(p.opportunityId);
      }
    }

    // isRescheduled: a meeting is "rescheduled" if there exists another meeting
    // with the same opportunityId and rescheduledFromMeetingId pointing here.
    // At the query level we detect this by scanning meetings for rescheduledFromMeetingId.
    const rescheduledFrom = new Set<Id<"meetings">>();
    for (const m of meetings) {
      if (m.rescheduledFromMeetingId) rescheduledFrom.add(m.rescheduledFromMeetingId);
    }

    for (const m of meetings) {
      const opp = oppById.get(m.opportunityId);
      if (!opp) continue; // defensive — orphan meeting
      const hasPayment = oppHasPayment.has(m.opportunityId);
      const isRescheduled = rescheduledFrom.has(m._id);

      const outcome = deriveCallOutcome(m, opp, hasPayment, isRescheduled);

      const counts = perCloser.get(m.assignedCloserId) ?? emptyOutcomeCounts();
      counts[outcome]++;
      perCloser.set(m.assignedCloserId, counts);
    }

    // Team roll-up.
    const teamOutcome = emptyOutcomeCounts();
    for (const counts of perCloser.values()) {
      for (const key of Object.keys(counts) as CallOutcome[]) {
        teamOutcome[key] += counts[key];
      }
    }

    // Derived KPIs — Lost Deals & Rebook Rate.
    // Rebook Rate = rescheduled / (canceled + no_show) — uses only the numerator+denominator
    // from teamOutcome. Null when denominator = 0.
    const rebookDenominator = teamOutcome.canceled + teamOutcome.no_show;
    const rebookRate =
      rebookDenominator > 0 ? teamOutcome.rescheduled / rebookDenominator : null;

    const closerOutcomes = closers.map((c) => ({
      closerId: c._id,
      closerName: getUserDisplayName(c),
      outcomes: perCloser.get(c._id) ?? emptyOutcomeCounts(),
    }));

    return {
      teamOutcome,
      closerOutcomes,
      derived: {
        lostDeals: teamOutcome.lost,
        rebookRate,
        rebookNumerator: teamOutcome.rescheduled,
        rebookDenominator,
      },
      isTruncated,
    };
  },
});
```

**Key implementation notes:**
- Scan bound: `MAX_MEETINGS_SCAN = 2000`. Sized for ~10× current annual volume. Surface `isTruncated` in response — UI shows "Narrow date range for full data" banner.
- `isRescheduled` is determined entirely within the scanned meeting set (no second scan). This loses the case where a meeting scheduled inside the range is rescheduled by a meeting booked *after* the range end. That's acceptable — the rebook metric is a within-range KPI.
- Do not mix customer-flow payments into the outcome-sold derivation. `deriveCallOutcome` treats `hasPayment=true` as "sold" — pollinating that with customer payments would incorrectly count repeat customer revenue as first-close sales.
- `dq` and `follow_up` are included in the counts but not highlighted in the response `derived` block — they exist so the pie chart can render the full distribution without holes.
- `deriveCallOutcome` has a known TODO (lines 48-62) to wire up DQ derivation. v0.6b is explicit that DQ is deferred to v0.7 — do not attempt to fix it here.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/teamOutcomes.ts` | Create | `getTeamOutcomeMix` query; derives Lost Deals + Rebook Rate |

---

### B3 — `teamActions.ts`: Actions-per-Closer-per-Day (NEW)

**Type:** Backend (new query, new file)
**Parallelizable:** Yes — new file; no conflicts.

**What:** Create `convex/reporting/teamActions.ts` exporting `getActionsPerCloserPerDay` — a query that scans `domainEvents` in the range, filters to `source === "closer"`, counts events per distinct `actorUserId`, and divides by the day span.

**Why:** Tier 2 KPI "Actions per Closer" promised in v0.6 design. `getActivitySummary` already returns an `actorBreakdown` but the calculation below is cleaner as a dedicated query so the KPI can be ordered independently from the activity page (and the feed can still truncate events at 2,000 rows without distorting this number).

**Where:**
- `convex/reporting/teamActions.ts` (new)

**How:**

**Step 1: Create the query.**

```typescript
// Path: convex/reporting/teamActions.ts

import { v } from "convex/values";
import { query } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireTenantUser } from "../requireTenantUser";
import { assertValidDateRange, getUserDisplayName } from "./lib/helpers";

const MAX_EVENTS_SCAN = 5000;
const DAY_MS = 86_400_000;

export const getActionsPerCloserPerDay = query({
  args: { startDate: v.number(), endDate: v.number() },
  handler: async (ctx, { startDate, endDate }) => {
    assertValidDateRange(startDate, endDate);

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    // We only need closer-sourced events. by_tenantId_and_occurredAt is bounded;
    // filter source post-scan (no index on (tenantId, source, occurredAt)).
    const events = await ctx.db
      .query("domainEvents")
      .withIndex("by_tenantId_and_occurredAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("occurredAt", startDate)
          .lt("occurredAt", endDate),
      )
      .take(MAX_EVENTS_SCAN);

    const isTruncated = events.length >= MAX_EVENTS_SCAN;
    const closerActions = new Map<Id<"users">, number>();
    for (const e of events) {
      if (e.source !== "closer" || !e.actorUserId) continue;
      closerActions.set(e.actorUserId, (closerActions.get(e.actorUserId) ?? 0) + 1);
    }

    const distinctCloserActors = closerActions.size;
    const totalCloserActions = Array.from(closerActions.values()).reduce(
      (s, n) => s + n,
      0,
    );
    const daySpanDays = Math.max(1, Math.ceil((endDate - startDate) / DAY_MS));

    const actionsPerCloserPerDay =
      distinctCloserActors > 0
        ? totalCloserActions / distinctCloserActors / daySpanDays
        : null;

    // Hydrate names for the "Most Active Closer" KPI.
    const topEntries = Array.from(closerActions.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    const topUsers = await Promise.all(
      topEntries.map(async ([userId, count]) => {
        const user = await ctx.db.get(userId);
        return {
          userId,
          actorName: user ? getUserDisplayName(user) : "Unknown closer",
          count,
        };
      }),
    );

    return {
      totalCloserActions,
      distinctCloserActors,
      daySpanDays,
      actionsPerCloserPerDay,
      topCloserActors: topUsers,
      isTruncated,
    };
  },
});
```

**Key implementation notes:**
- `.take(5000)` — closer events per month can exceed meeting count (each meeting typically generates 3-5 closer events: created, started, stopped or no_show, payment). Size the bound at 5,000 to cover ~1 month of events for a 3-closer tenant.
- We **do not** add `source` to any index — it's a bounded post-scan filter. If volume grows past the 5k cap, add `by_tenantId_and_source_and_occurredAt` in a dedicated follow-up (not this phase).
- `daySpanDays` uses `Math.ceil` so the denominator is never 0 and partial-day ranges (e.g., "Today") return meaningful numbers. `Math.max(1, ...)` is belt-and-braces.
- `topCloserActors` is sized to 3 so the UI can render a compact "top 3" block. Larger leaderboards live on the Activity Feed page.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/teamActions.ts` | Create | `getActionsPerCloserPerDay` query + top-3 actor names |

---

### B4 — `CloserPerformanceTable`: Split + 4 Commercial Columns

**Type:** Frontend (component modification)
**Parallelizable:** Depends on B1. Independent of B2/B3/B5/B6.

**What:** Replace the current 6-column table with a 10-column table. New columns: `Review Required` (between `No Shows` and `Showed`); `Sales`, `Cash Collected`, `Close Rate`, `Avg Deal` (appended after `Show-Up Rate`).

**Why:** The backend already computes `sales`, `cashCollectedMinor`, `closeRate`, `avgCashCollectedMinor` per closer at `teamPerformance.ts:172-184`. These four are dropped by the UI, forcing admins to Excel-export for the commercial view. After B1 adds `reviewRequiredCalls`, the new column becomes available too.

**Where:**
- `app/workspace/reports/team/_components/closer-performance-table.tsx` (modify)

**How:**

**Step 1: Update the column headers + body cells + footer totals.**

```tsx
// Path: app/workspace/reports/team/_components/closer-performance-table.tsx

// BEFORE (lines ~110–157 — 6 columns):
<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Closer</TableHead>
      <TableHead className="text-right">Booked</TableHead>
      <TableHead className="text-right">Canceled</TableHead>
      <TableHead className="text-right">No Shows</TableHead>
      <TableHead className="text-right">Showed</TableHead>
      <TableHead className="text-right">Show-Up Rate</TableHead>
    </TableRow>
  </TableHeader>

// AFTER (v0.6b — 10 columns, grouped visually):
<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Closer</TableHead>
      {/* Attendance group */}
      <TableHead className="text-right">Booked</TableHead>
      <TableHead className="text-right">Canceled</TableHead>
      <TableHead className="text-right">No Shows</TableHead>
      <TableHead className="text-right" title="Meetings flagged for review (meeting_overran). Excluded from show-up rate until resolved.">
        Review Req.
      </TableHead>
      <TableHead className="text-right">Showed</TableHead>
      <TableHead className="text-right">Show-Up Rate</TableHead>
      {/* Commercial group (visual separator via border-l on first cell) */}
      <TableHead className="border-l text-right">Sales</TableHead>
      <TableHead className="text-right">Cash Collected</TableHead>
      <TableHead className="text-right">Close Rate</TableHead>
      <TableHead className="text-right">Avg Deal</TableHead>
    </TableRow>
  </TableHeader>
```

**Step 2: Update the row renderer.**

```tsx
// Path: app/workspace/reports/team/_components/closer-performance-table.tsx

// BEFORE: row body only shows attendance columns.
// AFTER: append commercial columns pulled from closer top-level (not classification).

<TableBody>
  {closers.map((closer) => {
    const calls = getCallMetrics(closer, callType);
    return (
      <TableRow key={closer.closerId}>
        <TableCell>{closer.closerName}</TableCell>
        <TableCell className="text-right">{calls.bookedCalls}</TableCell>
        <TableCell className="text-right">{calls.canceledCalls}</TableCell>
        <TableCell className="text-right">{calls.noShows}</TableCell>
        <TableCell className="text-right">{calls.reviewRequiredCalls}</TableCell>
        <TableCell className="text-right">{calls.callsShowed}</TableCell>
        <TableCell className="text-right">{formatRate(calls.showUpRate)}</TableCell>
        <TableCell className="border-l text-right">{closer.sales}</TableCell>
        <TableCell className="text-right">{formatCurrency(closer.cashCollectedMinor)}</TableCell>
        <TableCell className="text-right">{formatRate(closer.closeRate)}</TableCell>
        <TableCell className="text-right">
          {closer.avgCashCollectedMinor !== null
            ? formatCurrency(closer.avgCashCollectedMinor)
            : "—"}
        </TableCell>
      </TableRow>
    );
  })}
</TableBody>
```

**Step 3: Update the footer totals.**

`getTeamFooterData(teamTotals, callType)` lives alongside the component. Extend it to also return `reviewRequiredCalls` and the four commercial totals.

```tsx
// Path: app/workspace/reports/team/_components/closer-performance-table.tsx

function getTeamFooterData(
  teamTotals: TeamTotals,
  callType: "new" | "follow_up",
) {
  if (callType === "new") {
    return {
      bookedCalls: teamTotals.newBookedCalls,
      canceledCalls: teamTotals.newCanceled,
      noShows: teamTotals.newNoShows,
      reviewRequiredCalls: teamTotals.newReviewRequired, // NEW
      callsShowed: teamTotals.newShowed,
      showUpRate: toRate(
        teamTotals.newShowed,
        teamTotals.newBookedCalls
          - teamTotals.newCanceled
          - teamTotals.newReviewRequired,
      ),
    };
  }
  return {
    bookedCalls: teamTotals.followUpBookedCalls,
    canceledCalls: teamTotals.followUpCanceled,
    noShows: teamTotals.followUpNoShows,
    reviewRequiredCalls: teamTotals.followUpReviewRequired, // NEW
    callsShowed: teamTotals.followUpShowed,
    showUpRate: toRate(
      teamTotals.followUpShowed,
      teamTotals.followUpBookedCalls
        - teamTotals.followUpCanceled
        - teamTotals.followUpReviewRequired,
    ),
  };
}

// Commercial totals row for the footer.
function getCommercialTeamTotals(teamTotals: TeamTotals) {
  return {
    sales: teamTotals.totalSales,
    cashCollectedMinor: teamTotals.totalRevenueMinor,
    closeRate: teamTotals.overallCloseRate,
    avgCashCollectedMinor:
      teamTotals.totalSales > 0
        ? teamTotals.totalRevenueMinor / teamTotals.totalSales
        : null,
  };
}
```

Then the `<TableFooter>` renders all 10 total cells in the same order as the body.

**Step 4: Horizontal scroll on mobile.**

Wrap the existing `<Table>` in an overflow container so the 10-column table doesn't break the page on narrow viewports.

```tsx
<div className="overflow-x-auto">
  <Table>
    {/* ... headers/body/footer ... */}
  </Table>
</div>
```

**Key implementation notes:**
- Columns are grouped visually via a `border-l` on the first commercial column header + body cell. No explicit `<TableHeadGroup>` primitive exists in shadcn; this is the canonical pattern.
- `Review Req.` is abbreviated to fit column width; the full text lives in the `title` tooltip. If design system guidelines require a visible full label, swap to `Review` or `Flagged` — same field.
- `avgCashCollectedMinor` can be `null` if `sales === 0`. Render as `"—"` — not `$0.00` — to distinguish "no data" from "$0".
- `closeRate` uses the existing `formatRate` (percentage string). `avgCashCollectedMinor` uses `formatCurrency` (dollars + locale thousands separators).
- Accessibility: the table retains the semantic `<TableHeader>` / `<TableHeaderCell>` structure — no role overrides. Horizontal scroll is on the *container*, not the table, so screen readers linearize the table correctly.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/team/_components/closer-performance-table.tsx` | Modify | Add `Review Req.` + 4 commercial columns; wrap in overflow-x-auto |

---

### B5 — `TeamKpiSummaryCards` + `MeetingOutcomeDistribution` Chart

**Type:** Frontend (component extension + new chart component)
**Parallelizable:** Depends on B1 (teamTotals), B2 (outcome mix), B3 (actions-per-day). Independent of B4/B6.

**What:** (a) Extend `TeamKpiSummaryCards` to add three new cards — Lost Deals, Rebook Rate, Actions per Closer (daily avg) — in a second row below the existing 4. (b) Create `meeting-outcome-distribution-chart.tsx` rendering a pie chart from `teamOutcome`.

**Why:** Summary cards today cover attendance + commercial + close rate. Tier 2 KPIs (Lost Deals, Rebook Rate, Actions per Closer) are promised in v0.6 design but never rendered. The outcome distribution chart is the most requested Tier 2 visualization.

**Where:**
- `app/workspace/reports/team/_components/team-kpi-summary-cards.tsx` (modify — add 3 cards)
- `app/workspace/reports/team/_components/meeting-outcome-distribution-chart.tsx` (new)
- `app/workspace/reports/team/_components/team-report-page-client.tsx` (modify — subscribe to `getTeamOutcomeMix` + `getActionsPerCloserPerDay`, render new chart)

**How:**

**Step 1: Extend `TeamKpiSummaryCards` props and add the 3 new cards.**

```tsx
// Path: app/workspace/reports/team/_components/team-kpi-summary-cards.tsx

// BEFORE: 4 cards in a single grid row.
interface TeamKpiSummaryCardsProps {
  totals: TeamTotals;
}

// AFTER: 7 cards split into two rows.
interface TeamKpiSummaryCardsProps {
  totals: TeamTotals;
  derivedOutcomes: {
    lostDeals: number;
    rebookRate: number | null;
    rebookNumerator: number;
    rebookDenominator: number;
  };
  actionsPerCloser: {
    actionsPerCloserPerDay: number | null;
    distinctCloserActors: number;
    daySpanDays: number;
  };
}

export function TeamKpiSummaryCards({
  totals,
  derivedOutcomes,
  actionsPerCloser,
}: TeamKpiSummaryCardsProps) {
  return (
    <div className="space-y-4">
      {/* Existing 4 cards — unchanged */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {/* ... Total Booked / Show-Up Rate / Cash Collected / Close Rate ... */}
      </div>

      {/* NEW v0.6b row — Tier 2 derived KPIs */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card size="sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <TrendingDownIcon className="h-4 w-4" />
              Lost Deals
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{derivedOutcomes.lostDeals}</div>
            <p className="text-xs text-muted-foreground">In selected range</p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Repeat2Icon className="h-4 w-4" />
              Rebook Rate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {formatRate(derivedOutcomes.rebookRate)}
            </div>
            <p className="text-xs text-muted-foreground">
              {derivedOutcomes.rebookNumerator} rebook(s) of {derivedOutcomes.rebookDenominator} missed
            </p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <ActivityIcon className="h-4 w-4" />
              Actions / Closer / Day
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {actionsPerCloser.actionsPerCloserPerDay !== null
                ? actionsPerCloser.actionsPerCloserPerDay.toFixed(1)
                : "—"}
            </div>
            <p className="text-xs text-muted-foreground">
              {actionsPerCloser.distinctCloserActors} active closer(s),{" "}
              {actionsPerCloser.daySpanDays}d span
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
```

**Step 2: Create the Meeting Outcome Distribution chart.**

```tsx
// Path: app/workspace/reports/team/_components/meeting-outcome-distribution-chart.tsx
"use client";

import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ChartContainer, ChartTooltipContent } from "@/components/ui/chart";

type OutcomeKey =
  | "sold"
  | "lost"
  | "no_show"
  | "canceled"
  | "rescheduled"
  | "dq"
  | "follow_up"
  | "in_progress"
  | "scheduled";

// Map outcome keys to display labels (+ stable chart colors).
const OUTCOME_META: Record<OutcomeKey, { label: string; color: string }> = {
  sold: { label: "Sold", color: "var(--chart-1)" },
  lost: { label: "Lost", color: "var(--chart-2)" },
  no_show: { label: "No Show", color: "var(--chart-3)" },
  canceled: { label: "Canceled", color: "var(--chart-4)" },
  rescheduled: { label: "Rescheduled", color: "var(--chart-5)" },
  dq: { label: "Disqualified", color: "var(--muted-foreground)" },
  follow_up: { label: "Follow-Up", color: "var(--chart-6)" },
  in_progress: { label: "In Progress", color: "var(--chart-7)" },
  scheduled: { label: "Scheduled", color: "var(--chart-8)" },
};

interface MeetingOutcomeDistributionChartProps {
  outcomeMix: Record<OutcomeKey, number>;
  isTruncated: boolean;
}

export function MeetingOutcomeDistributionChart({
  outcomeMix,
  isTruncated,
}: MeetingOutcomeDistributionChartProps) {
  const data = (Object.keys(OUTCOME_META) as OutcomeKey[])
    .filter((key) => outcomeMix[key] > 0)
    .map((key) => ({
      name: OUTCOME_META[key].label,
      key,
      value: outcomeMix[key],
      fill: OUTCOME_META[key].color,
    }));

  const total = data.reduce((s, d) => s + d.value, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Meeting Outcome Distribution</CardTitle>
        <CardDescription>
          Derived via `deriveCallOutcome` across completed / overran / canceled / no-show meetings in range
          {isTruncated && " • Only first 2,000 meetings shown"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="text-sm text-muted-foreground">No outcomes in selected range.</p>
        ) : (
          <ChartContainer
            config={Object.fromEntries(
              (Object.keys(OUTCOME_META) as OutcomeKey[]).map((key) => [
                key,
                { label: OUTCOME_META[key].label, color: OUTCOME_META[key].color },
              ]),
            )}
            className="mx-auto aspect-square max-h-[320px]"
          >
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={110}
                  label={({ name, percent }) =>
                    `${name} ${((percent ?? 0) * 100).toFixed(0)}%`
                  }
                >
                  {data.map((entry) => (
                    <Cell key={entry.key} fill={entry.fill} />
                  ))}
                </Pie>
                <Tooltip content={<ChartTooltipContent />} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
```

**Step 3: Wire everything up in `team-report-page-client.tsx`.**

```tsx
// Path: app/workspace/reports/team/_components/team-report-page-client.tsx
"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { ReportDateControls } from "../../_components/report-date-controls";
import { TeamKpiSummaryCards } from "./team-kpi-summary-cards";
import { CloserPerformanceTable } from "./closer-performance-table";
import { MeetingOutcomeDistributionChart } from "./meeting-outcome-distribution-chart";
import { MeetingTimeSection } from "./meeting-time-section"; // from B6
import { TeamReportSkeleton } from "./team-report-skeleton";

export function TeamReportPageClient() {
  const [dateRange, setDateRange] = useState(/* default last-30-days */);

  const metrics = useQuery(api.reporting.teamPerformance.getTeamPerformanceMetrics, dateRange);
  const outcomeMix = useQuery(api.reporting.teamOutcomes.getTeamOutcomeMix, dateRange);
  const actionsPerCloser = useQuery(
    api.reporting.teamActions.getActionsPerCloserPerDay,
    dateRange,
  );

  if (!metrics || !outcomeMix || !actionsPerCloser) return <TeamReportSkeleton />;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Team Performance</h1>
        <p className="text-sm text-muted-foreground">
          Per-closer KPIs split by new and follow-up calls
        </p>
      </header>

      <ReportDateControls value={dateRange} onChange={setDateRange} />

      <TeamKpiSummaryCards
        totals={metrics.teamTotals}
        derivedOutcomes={outcomeMix.derived}
        actionsPerCloser={actionsPerCloser}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <MeetingOutcomeDistributionChart
          outcomeMix={outcomeMix.teamOutcome}
          isTruncated={outcomeMix.isTruncated}
        />
        {/* Reserve second grid slot for future chart (see Phase G revenue-by-origin) */}
      </div>

      <section>
        <h2 className="mb-4 text-lg font-medium">New Calls</h2>
        <CloserPerformanceTable
          closers={metrics.closers}
          callType="new"
          teamTotals={metrics.teamTotals}
        />
      </section>

      <section>
        <h2 className="mb-4 text-lg font-medium">Follow-Up Calls</h2>
        <CloserPerformanceTable
          closers={metrics.closers}
          callType="follow_up"
          teamTotals={metrics.teamTotals}
        />
      </section>

      {/* From B6 */}
      <MeetingTimeSection
        teamMeetingTime={metrics.teamMeetingTime}
        closers={metrics.closers}
        isTruncated={metrics.isMeetingTimeTruncated}
      />

      {(metrics.isPaymentDataTruncated
        || outcomeMix.isTruncated
        || metrics.isMeetingTimeTruncated
        || actionsPerCloser.isTruncated) && (
        <p className="text-sm text-muted-foreground">
          Note: one or more data sources hit the 2,000-row safety cap. Totals may be approximate —
          narrow the date range for full data.
        </p>
      )}
    </div>
  );
}
```

**Key implementation notes:**
- Three `useQuery` subscriptions — `getTeamPerformanceMetrics`, `getTeamOutcomeMix`, `getActionsPerCloserPerDay`. Each fires independently; the page shell uses `TeamReportSkeleton` until all three resolve. For a single-skeleton UX (match Phase C / D / E), wrap each card region in its own `<Suspense>` — deferred as polish, not blocking.
- `ChartContainer` from `components/ui/chart.tsx` is the project's shadcn/ui Recharts wrapper — provides CSS variables for `--chart-1` through `--chart-8`. Do not hand-pick hex colors.
- `ActivityIcon` / `TrendingDownIcon` / `Repeat2Icon` are lucide-react icons — already in `optimizePackageImports` per `next.config.ts`.
- The chart's `label` renderer uses the recharts `percent` argument — more readable than raw counts for a pie. Tooltip shows exact counts via `ChartTooltipContent`.
- Build a derived `EffectiveTimeWindow` in the page client so every query reuses the same range — critical to prevent dimension mismatch between the summary cards and the tables.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/team/_components/team-kpi-summary-cards.tsx` | Modify | Extend props; add 3 new cards in second row |
| `app/workspace/reports/team/_components/meeting-outcome-distribution-chart.tsx` | Create | Recharts pie wrapping `ChartContainer` |
| `app/workspace/reports/team/_components/team-report-page-client.tsx` | Modify | Add 2 new `useQuery`s; render chart + pass new props |

---

### B6 — Meeting Time Subsection (UI)

**Type:** Frontend (new component)
**Parallelizable:** Depends on B1 (`teamMeetingTime` + per-closer `meetingTime` blocks). Independent of B2/B3/B4/B5.

**What:** Render a standalone Meeting Time section at the bottom of the team report page. Section shows:
- 7 summary KPI cards (On-Time Start Rate, Avg Late Start, Overran Rate, Avg Overrun, Avg Actual Duration, Schedule Adherence, Manually Corrected Count)
- A secondary "Manually Corrected Count" column on a compact per-closer meeting-time table

**Why:** Tier 3 KPIs in v0.6 design live on the team page (primary admin surface). Phase C builds a full Meeting-Time Audit page with histograms and source-split charts — this section is the **minimal** complement that lives on the team page to surface the KPIs without forcing an admin to context-switch to a different report.

**Where:**
- `app/workspace/reports/team/_components/meeting-time-section.tsx` (new)
- `app/workspace/reports/team/_components/closer-meeting-time-table.tsx` (new, compact per-closer)
- `app/workspace/reports/team/_components/team-report-page-client.tsx` (modify — handled in B5)

**How:**

**Step 1: Create the section component.**

```tsx
// Path: app/workspace/reports/team/_components/meeting-time-section.tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ClockIcon,
  TimerIcon,
  TimerOffIcon,
  GaugeIcon,
  CalendarClockIcon,
  SlidersHorizontalIcon,
  WrenchIcon,
} from "lucide-react";
import { CloserMeetingTimeTable } from "./closer-meeting-time-table";

interface MeetingTimeSectionProps {
  teamMeetingTime: {
    onTimeStartRate: number | null;
    avgLateStartMs: number | null;
    overranRate: number | null;
    avgOverrunMs: number | null;
    avgActualDurationMs: number | null;
    scheduleAdherenceRate: number | null;
    manuallyCorrectedCount: number;
    startedMeetingsCount: number;
    completedWithDurationCount: number;
    overranCount: number;
  };
  closers: Array<{
    closerId: string;
    closerName: string;
    meetingTime: MeetingTimeSectionProps["teamMeetingTime"];
  }>;
  isTruncated: boolean;
}

function formatRate(rate: number | null): string {
  if (rate === null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  const totalSec = Math.round(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export function MeetingTimeSection({
  teamMeetingTime,
  closers,
  isTruncated,
}: MeetingTimeSectionProps) {
  const cards = [
    { icon: ClockIcon, label: "On-Time Start Rate", value: formatRate(teamMeetingTime.onTimeStartRate),
      caption: `${teamMeetingTime.startedMeetingsCount} started` },
    { icon: TimerIcon, label: "Avg Late Start", value: formatMs(teamMeetingTime.avgLateStartMs),
      caption: "(when late)" },
    { icon: TimerOffIcon, label: "Overran Rate", value: formatRate(teamMeetingTime.overranRate),
      caption: `${teamMeetingTime.overranCount} of ${teamMeetingTime.completedWithDurationCount}` },
    { icon: GaugeIcon, label: "Avg Overrun", value: formatMs(teamMeetingTime.avgOverrunMs),
      caption: "(when overran)" },
    { icon: CalendarClockIcon, label: "Avg Actual Duration", value: formatMs(teamMeetingTime.avgActualDurationMs),
      caption: "Across completed meetings" },
    { icon: SlidersHorizontalIcon, label: "Schedule Adherence", value: formatRate(teamMeetingTime.scheduleAdherenceRate),
      caption: "On time AND not overran" },
    { icon: WrenchIcon, label: "Manually Corrected", value: String(teamMeetingTime.manuallyCorrectedCount),
      caption: "Admin-entered times" },
  ];

  return (
    <section>
      <h2 className="mb-4 text-lg font-medium">Meeting Time</h2>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-7">
        {cards.map(({ icon: Icon, label, value, caption }) => (
          <Card key={label} size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Icon className="h-3.5 w-3.5" />
                {label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-bold tabular-nums">{value}</div>
              <p className="text-xs text-muted-foreground">{caption}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mt-4">
        <CloserMeetingTimeTable closers={closers} />
      </div>

      {isTruncated && (
        <p className="mt-2 text-xs text-muted-foreground">
          Only first 2,000 meetings included — narrow the date range for full data.
        </p>
      )}
    </section>
  );
}
```

**Step 2: Create the per-closer compact table.**

```tsx
// Path: app/workspace/reports/team/_components/closer-meeting-time-table.tsx
"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface CloserMeetingTimeTableProps {
  closers: Array<{
    closerId: string;
    closerName: string;
    meetingTime: {
      onTimeStartRate: number | null;
      avgLateStartMs: number | null;
      overranRate: number | null;
      avgOverrunMs: number | null;
      avgActualDurationMs: number | null;
      scheduleAdherenceRate: number | null;
      manuallyCorrectedCount: number;
    };
  }>;
}

function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}
function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  const totalSec = Math.round(ms / 1000);
  return `${Math.floor(totalSec / 60)}m ${(totalSec % 60).toString().padStart(2, "0")}s`;
}

export function CloserMeetingTimeTable({ closers }: CloserMeetingTimeTableProps) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Closer</TableHead>
            <TableHead className="text-right">On-Time</TableHead>
            <TableHead className="text-right">Avg Late</TableHead>
            <TableHead className="text-right">Overran Rate</TableHead>
            <TableHead className="text-right">Avg Overrun</TableHead>
            <TableHead className="text-right">Avg Duration</TableHead>
            <TableHead className="text-right">Schedule Adh.</TableHead>
            <TableHead className="text-right">Manual Corr.</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {closers.map((c) => (
            <TableRow key={c.closerId}>
              <TableCell>{c.closerName}</TableCell>
              <TableCell className="text-right">{formatRate(c.meetingTime.onTimeStartRate)}</TableCell>
              <TableCell className="text-right">{formatMs(c.meetingTime.avgLateStartMs)}</TableCell>
              <TableCell className="text-right">{formatRate(c.meetingTime.overranRate)}</TableCell>
              <TableCell className="text-right">{formatMs(c.meetingTime.avgOverrunMs)}</TableCell>
              <TableCell className="text-right">{formatMs(c.meetingTime.avgActualDurationMs)}</TableCell>
              <TableCell className="text-right">{formatRate(c.meetingTime.scheduleAdherenceRate)}</TableCell>
              <TableCell className="text-right">{c.meetingTime.manuallyCorrectedCount}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

**Key implementation notes:**
- 7-card grid on large screens, 4/2-column on smaller. Cards are `size="sm"` to keep the section compact — the full, histogram-rich view lives on the Meeting-Time Audit page (Phase C).
- `formatMs` returns `"Xm YYs"` — compact but unambiguous. Don't use `.toFixed(1)` minutes alone (admins want seconds).
- Manually Corrected is a raw count, not a rate — the rate version (Manual Correction Rate) is a Phase D / Phase C surface, not Phase B.
- `CloserMeetingTimeTable` is a separate file, not inlined, so Phase C can reuse it (or a close cousin) on the Meeting-Time Audit per-closer view.
- The section is placed *below* the existing New Calls / Follow-Up Calls tables so admins land on the attendance tables first (primary job). Meeting-time KPIs are secondary context.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/team/_components/meeting-time-section.tsx` | Create | 7 KPI cards + wraps CloserMeetingTimeTable |
| `app/workspace/reports/team/_components/closer-meeting-time-table.tsx` | Create | Compact per-closer meeting-time table |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/reporting/teamPerformance.ts` | Modify | B1 |
| `convex/reporting/teamOutcomes.ts` | Create | B2 |
| `convex/reporting/teamActions.ts` | Create | B3 |
| `app/workspace/reports/team/_components/closer-performance-table.tsx` | Modify | B4 |
| `app/workspace/reports/team/_components/team-kpi-summary-cards.tsx` | Modify | B5 |
| `app/workspace/reports/team/_components/meeting-outcome-distribution-chart.tsx` | Create | B5 |
| `app/workspace/reports/team/_components/team-report-page-client.tsx` | Modify | B5 |
| `app/workspace/reports/team/_components/meeting-time-section.tsx` | Create | B6 |
| `app/workspace/reports/team/_components/closer-meeting-time-table.tsx` | Create | B6 |

**Blast radius:**
- **Backend:** 3 files (1 modify, 2 new). `teamPerformance.ts` is already the single consumer file for the team page — modification is contained. 2 new files have no upstream consumers.
- **Frontend:** 6 files (3 modify, 3 new). All under `app/workspace/reports/team/_components/`. No shared component with other report pages is touched.
- **Zero schema change.** Zero write-path change. Zero aggregate change.
- **Existing call sites of `getTeamPerformanceMetrics`:** currently only `team-report-page-client.tsx`. Confirm via `rg -n 'getTeamPerformanceMetrics' app` before merging B1 so a forgotten consumer doesn't break on the shape change.

**Rollback plan:** All changes are additive. Each subphase reverts cleanly. If the meeting-time scan causes unexpected read pressure in production, gate Step 3 of B1 behind a `TEAM_REPORT_MEETING_TIME_ENABLED` boolean and ship the rest.
