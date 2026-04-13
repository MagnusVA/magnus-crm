# Phase 3 — Core Reporting Queries

**Goal:** Implement all 7 reporting query files + 4 shared utility files in `convex/reporting/`. After this phase, every report page has its backend data source — Team Performance, Revenue (metrics + trend), Pipeline Health (distribution + aging), Lead & Conversion, Activity Feed (paginated + summary), and Form Response Analytics.

**Prerequisite:** Phase 1 complete — aggregate instances registered and backfilled, `periodBucketing.ts` exists.

**Runs in PARALLEL with:** Phase 2 (Mutation Integration — different files) and Phase 4 (Report Shell — frontend routes). Phase 3 reads from aggregates; Phase 2 writes to mutations; Phase 4 creates UI scaffolding. Zero shared files.

**Skills to invoke:**
- `convex-performance-audit` — verify aggregate query costs (document reads per query) are within Convex limits

> **Critical path:** Phase 3 is on the critical path (Phase 1 → Phase 3 → Phase 5 → Phase 6). Queries must be complete before Phase 5 can build report pages.

**Acceptance Criteria:**
1. `getTeamPerformanceMetrics(startDate, endDate)` returns per-closer KPIs (booked, canceled, no-shows, showed, show-up rate) split by `new`/`follow_up`, plus team totals and per-closer revenue/close rate.
2. `getRevenueMetrics(startDate, endDate)` returns total revenue, per-closer breakdown with revenue percentage, deal count, and average deal size.
3. `getRevenueDetails(startDate, endDate)` returns top 10 deals and deal size distribution (5 buckets).
4. `getRevenueTrend(startDate, endDate, granularity)` returns period-bucketed revenue and deal count at day/week/month granularity.
5. `getPipelineDistribution()` returns opportunity count per status via the `opportunityByStatus` aggregate.
6. `getPipelineAging()` returns aging by active status, pipeline velocity (avg days to close), and stale opportunities list.
7. `getLeadConversionMetrics(startDate, endDate)` returns new lead count, total conversions, conversion rate, and per-closer conversion breakdown.
8. `getActivityFeed(startDate, endDate, filters)` returns paginated domain events with actor name enrichment, capped at 100 events.
9. `getActivitySummary(startDate, endDate)` returns event counts by source, entity type, and actor.
10. `getFieldCatalog()` returns all form fields for the tenant. `getAnswerDistribution(fieldKey)` returns answer frequency distribution.
11. All queries enforce `requireTenantUser(ctx, ["tenant_master", "tenant_admin"])` — closers get access denied.
12. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (shared helpers) ──────────────────────────────────────────────────┐
                                                                      ├── 3B (team performance — uses helpers + meetingsByStatus + paymentSums)
                                                                      ├── 3C (revenue — uses helpers + paymentSums + periodBucketing)
                                                                      ├── 3D (pipeline health — uses opportunityByStatus)
                                                                      ├── 3E (lead & conversion — uses helpers + leadTimeline + customerConversions)
                                                                      ├── 3F (activity feed + event labels — uses domainEvents indexes)
                                                                      └── 3G (form response analytics + outcome derivation — uses meetingFormResponses indexes)
```

**Optimal execution:**
1. Start **3A** first (shared helpers — imported by 3B, 3C, 3E).
2. After 3A → start **3B**, **3C**, **3D**, **3E**, **3F**, **3G** all in parallel (each creates a separate file, no shared imports beyond 3A and Phase 1 aggregates).

**Estimated time:** 3-4 days

---

## Subphases

### 3A — Shared Helpers

**Type:** Backend
**Parallelizable:** No — must complete first. Subphases 3B, 3C, 3E import from these helpers.

**What:** Create `convex/reporting/lib/helpers.ts` with `getActiveClosers()` and `makeDateBounds()` — shared utilities used by multiple reporting queries.

**Why:** Every per-closer report needs to fetch the active closer list, and every date-range query needs bounds objects in the aggregate API format. Centralizing avoids duplication across 4+ query files.

**Where:**
- `convex/reporting/lib/helpers.ts` (new)

**How:**

**Step 1: Create the helpers file**

```typescript
// Path: convex/reporting/lib/helpers.ts
import type { QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";

/**
 * Fetch all active closers for a tenant.
 * Used by Team Performance, Revenue, and Lead & Conversion reports.
 */
export async function getActiveClosers(ctx: QueryCtx, tenantId: Id<"tenants">) {
  const closers = [];
  for await (const user of ctx.db
    .query("users")
    .withIndex("by_tenantId_and_isActive", (q) =>
      q.eq("tenantId", tenantId).eq("isActive", true),
    )) {
    if (user.role === "closer") {
      closers.push(user);
    }
  }
  return closers;
}

/**
 * Create aggregate-compatible date bounds from start/end timestamps.
 * Used for the `bounds` parameter in aggregate .count() and .sum() calls.
 */
export function makeDateBounds(startDate: number, endDate: number) {
  return {
    lower: { key: startDate, inclusive: true as const },
    upper: { key: endDate, inclusive: false as const },
  };
}
```

**Key implementation notes:**
- `getActiveClosers` filters by both `isActive === true` AND `role === "closer"`. The index provides `tenantId + isActive`; the role filter is done in-memory (small result set — typically < 20 users).
- `makeDateBounds` uses inclusive lower / exclusive upper — standard half-open interval semantics. This matches the design's date range contract.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/lib/helpers.ts` | Create | getActiveClosers + makeDateBounds |

---

### 3B — Team Performance Query

**Type:** Backend
**Parallelizable:** Yes — after 3A. Touches only `convex/reporting/teamPerformance.ts` (new file).

**What:** Implement `getTeamPerformanceMetrics` — the core report query that replaces the monthly Excel sheet. Per-closer KPIs split by new/follow-up classification, with team totals. Cost: ~96 O(log n) aggregate lookups for 8 closers.

**Why:** This is the Tier 1 report — the primary deliverable that replaces the manual Excel workflow. It provides the 9 Excel-replacement KPIs (booked calls, cancellations, no-shows, calls showed, show-up rate, sales, cash collected, close rate, avg deal size) for each closer, split by new vs follow-up.

**Where:**
- `convex/reporting/teamPerformance.ts` (new)

**How:**

**Step 1: Create the query**

```typescript
// Path: convex/reporting/teamPerformance.ts
import { query } from "../_generated/server";
import { v } from "convex/values";
import { requireTenantUser } from "../requireTenantUser";
import { meetingsByStatus, paymentSums } from "./aggregates";
import { getActiveClosers, makeDateBounds } from "./lib/helpers";

const MEETING_STATUSES = ["scheduled", "in_progress", "completed", "canceled", "no_show"] as const;

export const getTeamPerformanceMetrics = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, { startDate, endDate }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const closers = await getActiveClosers(ctx, tenantId);
    const dateBounds = makeDateBounds(startDate, endDate);

    const closerResults = await Promise.all(
      closers.map(async (closer) => {
        const kpis: Record<string, any> = {};

        for (const classification of ["new", "follow_up"] as const) {
          const statusCounts: Record<string, number> = {};
          let booked = 0;

          // One O(log n) call per status — 5 statuses × 2 classifications = 10 per closer
          await Promise.all(
            MEETING_STATUSES.map(async (status) => {
              const count = await meetingsByStatus.count(ctx, {
                namespace: tenantId,
                prefix: [closer._id, classification, status],
                bounds: dateBounds,
              });
              statusCounts[status] = count;
              booked += count;
            }),
          );

          const showed = (statusCounts["completed"] ?? 0) + (statusCounts["in_progress"] ?? 0);
          const canceled = statusCounts["canceled"] ?? 0;
          const noShows = statusCounts["no_show"] ?? 0;
          const denominator = booked - canceled;

          kpis[classification] = {
            bookedCalls: booked,
            canceledCalls: canceled,
            noShows,
            callsShowed: showed,
            showUpRate: denominator > 0 ? showed / denominator : 0,
          };
        }

        // Payment metrics per closer (not split by classification)
        const [revenue, dealCount] = await Promise.all([
          paymentSums.sum(ctx, {
            namespace: tenantId,
            prefix: [closer._id],
            bounds: dateBounds,
          }),
          paymentSums.count(ctx, {
            namespace: tenantId,
            prefix: [closer._id],
            bounds: dateBounds,
          }),
        ]);

        const totalShowed = kpis["new"].callsShowed + kpis["follow_up"].callsShowed;

        return {
          closerId: closer._id,
          closerName: closer.fullName ?? closer.email,
          newCalls: kpis["new"],
          followUpCalls: kpis["follow_up"],
          sales: dealCount,
          cashCollectedMinor: revenue,
          closeRate: totalShowed > 0 ? dealCount / totalShowed : 0,
          avgCashCollectedMinor: dealCount > 0 ? revenue / dealCount : 0,
        };
      }),
    );

    // Team totals
    const teamTotals = closerResults.reduce(
      (acc, r) => ({
        newBookedCalls: acc.newBookedCalls + r.newCalls.bookedCalls,
        newShowed: acc.newShowed + r.newCalls.callsShowed,
        newCanceled: acc.newCanceled + r.newCalls.canceledCalls,
        newNoShows: acc.newNoShows + r.newCalls.noShows,
        followUpBookedCalls: acc.followUpBookedCalls + r.followUpCalls.bookedCalls,
        followUpShowed: acc.followUpShowed + r.followUpCalls.callsShowed,
        followUpCanceled: acc.followUpCanceled + r.followUpCalls.canceledCalls,
        followUpNoShows: acc.followUpNoShows + r.followUpCalls.noShows,
        totalSales: acc.totalSales + r.sales,
        totalRevenue: acc.totalRevenue + r.cashCollectedMinor,
      }),
      {
        newBookedCalls: 0, newShowed: 0, newCanceled: 0, newNoShows: 0,
        followUpBookedCalls: 0, followUpShowed: 0, followUpCanceled: 0, followUpNoShows: 0,
        totalSales: 0, totalRevenue: 0,
      },
    );

    return { closers: closerResults, teamTotals };
  },
});
```

**Key implementation notes:**
- **Query cost:** 8 closers × 2 classifications × 5 statuses = 80 aggregate lookups + 8×2 payment lookups = 96 total O(log n) calls. Each call reads ~2 documents from the aggregate tree → ~192 document reads. Well within the 16,384 limit.
- Show-up rate denominator is `booked - canceled` (not just `booked`), matching the Excel formula.
- `closerName` falls back to `email` when `fullName` is null (for recently invited closers who haven't set their name).
- Revenue and close rate are NOT split by classification (deferred to Tier 5).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/teamPerformance.ts` | Create | Core team performance query — 96 aggregate lookups |

---

### 3C — Revenue Queries

**Type:** Backend
**Parallelizable:** Yes — after 3A. Touches only `convex/reporting/revenue.ts` and `convex/reporting/revenueTrend.ts` (new files).

**What:** Implement 3 revenue queries: `getRevenueMetrics` (aggregate totals + per-closer breakdown), `getRevenueDetails` (top deals + distribution), `getRevenueTrend` (period-bucketed line chart data).

**Why:** Revenue reporting is the second most important report (after Team Performance). The trend chart provides visual pattern recognition that the Excel cannot. Deal size distribution helps identify pricing patterns.

**Where:**
- `convex/reporting/revenue.ts` (new)
- `convex/reporting/revenueTrend.ts` (new)

**How:**

**Step 1: Create revenue metrics query**

```typescript
// Path: convex/reporting/revenue.ts
import { query } from "../_generated/server";
import { v } from "convex/values";
import { requireTenantUser } from "../requireTenantUser";
import { paymentSums } from "./aggregates";
import { getActiveClosers, makeDateBounds } from "./lib/helpers";

export const getRevenueMetrics = query({
  args: { startDate: v.number(), endDate: v.number() },
  handler: async (ctx, { startDate, endDate }) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    const closers = await getActiveClosers(ctx, tenantId);
    const dateBounds = makeDateBounds(startDate, endDate);

    const byCloser = await Promise.all(
      closers.map(async (closer) => {
        const [revenue, deals] = await Promise.all([
          paymentSums.sum(ctx, { namespace: tenantId, prefix: [closer._id], bounds: dateBounds }),
          paymentSums.count(ctx, { namespace: tenantId, prefix: [closer._id], bounds: dateBounds }),
        ]);
        return {
          closerId: closer._id,
          closerName: closer.fullName ?? closer.email,
          revenueMinor: revenue,
          dealCount: deals,
          avgDealMinor: deals > 0 ? revenue / deals : 0,
        };
      }),
    );

    const totalRevenue = byCloser.reduce((sum, c) => sum + c.revenueMinor, 0);
    const totalDeals = byCloser.reduce((sum, c) => sum + c.dealCount, 0);

    return {
      totalRevenueMinor: totalRevenue,
      totalDeals,
      avgDealMinor: totalDeals > 0 ? totalRevenue / totalDeals : 0,
      byCloser: byCloser.map((c) => ({
        ...c,
        revenuePercent: totalRevenue > 0 ? (c.revenueMinor / totalRevenue) * 100 : 0,
      })),
    };
  },
});

export const getRevenueDetails = query({
  args: { startDate: v.number(), endDate: v.number() },
  handler: async (ctx, { startDate, endDate }) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    // Bounded scan of payment records in range
    const payments = [];
    for await (const payment of ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId_and_recordedAt", (q) =>
        q.eq("tenantId", tenantId).gte("recordedAt", startDate).lt("recordedAt", endDate),
      )) {
      if (payment.status !== "disputed") payments.push(payment);
    }

    // Top 10 deals
    const topDeals = payments
      .sort((a, b) => b.amountMinor - a.amountMinor)
      .slice(0, 10);

    const closerIds = [...new Set(topDeals.map((p) => p.closerId))];
    const closerMap = new Map(
      await Promise.all(
        closerIds.map(async (id) => [id, await ctx.db.get(id)] as const),
      ),
    );

    // Deal size distribution (5 buckets)
    const buckets = { under500: 0, to2k: 0, to5k: 0, to10k: 0, over10k: 0 };
    for (const p of payments) {
      const dollars = p.amountMinor / 100;
      if (dollars < 500) buckets.under500++;
      else if (dollars < 2000) buckets.to2k++;
      else if (dollars < 5000) buckets.to5k++;
      else if (dollars < 10000) buckets.to10k++;
      else buckets.over10k++;
    }

    return {
      topDeals: topDeals.map((p) => ({
        amountMinor: p.amountMinor,
        closerName: closerMap.get(p.closerId)?.fullName ?? "Unknown",
        recordedAt: p.recordedAt,
      })),
      dealSizeDistribution: buckets,
    };
  },
});
```

**Step 2: Create revenue trend query**

```typescript
// Path: convex/reporting/revenueTrend.ts
import { query } from "../_generated/server";
import { v } from "convex/values";
import { requireTenantUser } from "../requireTenantUser";
import { paymentSums } from "./aggregates";
import { getPeriodsInRange } from "./lib/periodBucketing";

export const getRevenueTrend = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
    granularity: v.union(v.literal("day"), v.literal("week"), v.literal("month")),
  },
  handler: async (ctx, { startDate, endDate, granularity }) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    const periods = getPeriodsInRange(startDate, endDate, granularity);

    const trend = await Promise.all(
      periods.map(async (period) => {
        const bounds = {
          lower: { key: period.start, inclusive: true as const },
          upper: { key: period.end, inclusive: false as const },
        };
        const [revenue, deals] = await Promise.all([
          paymentSums.sum(ctx, { namespace: tenantId, bounds }),
          paymentSums.count(ctx, { namespace: tenantId, bounds }),
        ]);
        return { periodKey: period.key, revenueMinor: revenue, dealCount: deals };
      }),
    );

    return { trend };
  },
});
```

**Key implementation notes:**
- `getRevenueDetails` uses a bounded index scan (not aggregate) because it needs individual payment records for top deals and distribution bucketing. At ~50-150 payments per month, this is well within limits.
- Revenue trend shows zero for periods with no deals (design decision: continuous line, not gaps).
- The `paymentSums` aggregate excludes disputed payments via `sumValue` — no additional filtering needed in queries.
- Period bucketing is capped at 90 periods (from `periodBucketing.ts`). A 1-year monthly range = 12 periods × 2 aggregate calls = 24 calls. Safe.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/revenue.ts` | Create | Revenue metrics + details queries |
| `convex/reporting/revenueTrend.ts` | Create | Period-bucketed revenue trend |

---

### 3D — Pipeline Health Queries

**Type:** Backend
**Parallelizable:** Yes — after 3A (but doesn't use helpers — only uses `opportunityByStatus` aggregate). Can start immediately after Phase 1.

**What:** Implement `getPipelineDistribution` (status counts via aggregate) and `getPipelineAging` (aging analysis, velocity, stale pipeline via supplementary scans).

**Why:** Pipeline Health gives admins a real-time view of opportunity distribution, aging, and throughput velocity. Stale pipeline identification helps prevent deals from falling through the cracks.

**Where:**
- `convex/reporting/pipelineHealth.ts` (new)

**How:**

**Step 1: Create both queries**

```typescript
// Path: convex/reporting/pipelineHealth.ts
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { opportunityByStatus } from "./aggregates";

const OPP_STATUSES = [
  "scheduled", "in_progress", "follow_up_scheduled",
  "reschedule_link_sent", "payment_received", "lost", "canceled", "no_show",
] as const;

export const getPipelineDistribution = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    const distribution = await Promise.all(
      OPP_STATUSES.map(async (status) => ({
        status,
        count: await opportunityByStatus.count(ctx, {
          namespace: tenantId,
          prefix: [status],
        }),
      })),
    );

    return { distribution };
  },
});

export const getPipelineAging = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    const now = Date.now();

    const activeStatuses = ["scheduled", "in_progress", "follow_up_scheduled", "reschedule_link_sent"];
    const agingByStatus: Record<string, { totalDays: number; count: number }> = {};
    const staleOpps: Array<{ id: string; status: string; ageDays: number }> = [];

    for (const status of activeStatuses) {
      let totalAge = 0;
      let count = 0;
      for await (const opp of ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_status", (q) =>
          q.eq("tenantId", tenantId).eq("status", status),
        )
        .take(200)) {
        const ageDays = (now - opp.createdAt) / (24 * 60 * 60 * 1000);
        totalAge += ageDays;
        count++;
        if (opp.nextMeetingAt === undefined ||
            opp.nextMeetingAt < now - 14 * 24 * 60 * 60 * 1000) {
          staleOpps.push({ id: opp._id, status, ageDays: Math.round(ageDays) });
        }
      }
      agingByStatus[status] = { totalDays: totalAge, count };
    }

    // Pipeline velocity: avg days to close for recently won opps (90 days)
    const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;
    let velocityTotal = 0;
    let velocityCount = 0;
    for await (const opp of ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", "payment_received").gte("createdAt", ninetyDaysAgo),
      )
      .take(200)) {
      if (opp.paymentReceivedAt) {
        velocityTotal += (opp.paymentReceivedAt - opp.createdAt) / (24 * 60 * 60 * 1000);
        velocityCount++;
      }
    }

    return {
      agingByStatus,
      velocityDays: velocityCount > 0 ? velocityTotal / velocityCount : null,
      staleOpps: staleOpps.slice(0, 20),
    };
  },
});
```

**Key implementation notes:**
- `getPipelineDistribution` uses 8 aggregate calls (one per status) — very efficient.
- `getPipelineAging` uses supplementary index scans because it needs per-document fields (`createdAt`, `nextMeetingAt`, `paymentReceivedAt`) that aren't in the aggregate sort key. At current scale (~213 active opportunities), these scans are safe.
- Stale threshold: opportunity's `nextMeetingAt` is `undefined` or more than 14 days in the past.
- Velocity is the avg days from opportunity creation to `paymentReceivedAt`, looking at the last 90 days of won deals.
- `.take(200)` bounds all scans — safe at 10x scale.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/pipelineHealth.ts` | Create | Pipeline distribution (aggregate) + aging/velocity (index scans) |

---

### 3E — Lead & Conversion Query

**Type:** Backend
**Parallelizable:** Yes — after 3A. Touches only `convex/reporting/leadConversion.ts` (new file).

**What:** Implement `getLeadConversionMetrics` — new leads count, total conversions, conversion rate, and per-closer conversion breakdown.

**Why:** Lead-to-customer conversion tracking is a key funnel metric. This report shows how many leads entered the system, how many converted, and which closers are most effective at conversion.

**Where:**
- `convex/reporting/leadConversion.ts` (new)

**How:**

**Step 1: Create the query**

```typescript
// Path: convex/reporting/leadConversion.ts
import { query } from "../_generated/server";
import { v } from "convex/values";
import { requireTenantUser } from "../requireTenantUser";
import { leadTimeline, customerConversions } from "./aggregates";
import { getActiveClosers, makeDateBounds } from "./lib/helpers";

export const getLeadConversionMetrics = query({
  args: { startDate: v.number(), endDate: v.number() },
  handler: async (ctx, { startDate, endDate }) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    const closers = await getActiveClosers(ctx, tenantId);
    const dateBounds = makeDateBounds(startDate, endDate);

    const newLeads = await leadTimeline.count(ctx, {
      namespace: tenantId,
      bounds: dateBounds,
    });

    const byCloser = await Promise.all(
      closers.map(async (closer) => {
        const conversions = await customerConversions.count(ctx, {
          namespace: tenantId,
          prefix: [closer._id],
          bounds: dateBounds,
        });
        return {
          closerId: closer._id,
          closerName: closer.fullName ?? closer.email,
          conversions,
        };
      }),
    );

    const totalConversions = byCloser.reduce((sum, c) => sum + c.conversions, 0);

    return {
      newLeads,
      totalConversions,
      conversionRate: newLeads > 0 ? totalConversions / newLeads : 0,
      byCloser,
    };
  },
});
```

**Key implementation notes:**
- `leadTimeline` uses `_creationTime` as sort key — this gives the count of leads created in the date range.
- `customerConversions` is scoped by `[convertedByUserId, convertedAt]` — prefix query by closer ID gets per-closer conversion count.
- Conversion rate = `totalConversions / newLeads` — this is a rough funnel metric (not all leads in a period convert within that period). Useful for trend comparison, not absolute measurement.
- Query cost: 1 (leads count) + 8×1 (per-closer conversions) = 9 aggregate lookups. Very efficient.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/leadConversion.ts` | Create | Lead count + conversion metrics + per-closer breakdown |

---

### 3F — Activity Feed + Event Labels

**Type:** Backend
**Parallelizable:** Yes — after 3A (but doesn't use helpers). Touches only new files in `convex/reporting/`.

**What:** Implement `getActivityFeed` (paginated domain events with actor enrichment + filters) and `getActivitySummary` (event counts by source/entity/actor). Create the `eventLabels.ts` map for human-readable event rendering.

**Why:** The Activity Feed is the CRM's "git log" — it gives admins visibility into who did what and when. The summary provides at-a-glance activity metrics. Event labels are needed by both the backend (optional) and the frontend (required for rendering).

**Where:**
- `convex/reporting/activityFeed.ts` (new)
- `convex/reporting/lib/eventLabels.ts` (new)

**How:**

**Step 1: Create the event labels map**

```typescript
// Path: convex/reporting/lib/eventLabels.ts

/**
 * Map of eventType → { verb, iconHint } for human-readable rendering.
 * The frontend uses these to render: [icon] [actor] [verb] [timestamp]
 */
export const EVENT_LABELS: Record<string, { verb: string; iconHint: string }> = {
  // Opportunity events
  "opportunity.created": { verb: "created opportunity", iconHint: "plus-circle" },
  "opportunity.status_changed": { verb: "changed opportunity status", iconHint: "arrow-right" },
  "opportunity.assigned": { verb: "assigned opportunity", iconHint: "user-plus" },

  // Meeting events
  "meeting.created": { verb: "booked meeting", iconHint: "calendar-plus" },
  "meeting.started": { verb: "started meeting", iconHint: "play" },
  "meeting.stopped": { verb: "ended meeting", iconHint: "square" },
  "meeting.canceled": { verb: "canceled meeting", iconHint: "calendar-x" },
  "meeting.no_show": { verb: "marked no-show", iconHint: "user-x" },
  "meeting.outcome_set": { verb: "set meeting outcome", iconHint: "check-circle" },

  // Payment events
  "payment.recorded": { verb: "recorded payment", iconHint: "dollar-sign" },
  "payment.verified": { verb: "verified payment", iconHint: "check" },

  // Lead events
  "lead.created": { verb: "created lead", iconHint: "user-plus" },
  "lead.merged": { verb: "merged lead", iconHint: "merge" },

  // Customer events
  "customer.converted": { verb: "converted to customer", iconHint: "star" },

  // Follow-up events
  "followUp.scheduled": { verb: "scheduled follow-up", iconHint: "calendar-clock" },
  "followUp.reschedule_link_sent": { verb: "sent reschedule link", iconHint: "link" },

  // User events
  "user.invited": { verb: "invited team member", iconHint: "mail" },
  "user.role_changed": { verb: "changed role", iconHint: "shield" },
  "user.deactivated": { verb: "deactivated user", iconHint: "user-minus" },
};

export function getEventLabel(eventType: string): { verb: string; iconHint: string } {
  return EVENT_LABELS[eventType] ?? { verb: eventType, iconHint: "activity" };
}
```

**Step 2: Create the activity feed queries**

```typescript
// Path: convex/reporting/activityFeed.ts
import { query } from "../_generated/server";
import { v } from "convex/values";
import { requireTenantUser } from "../requireTenantUser";
import type { Id } from "../_generated/dataModel";

export const getActivityFeed = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
    entityType: v.optional(v.string()),
    eventType: v.optional(v.string()),
    actorUserId: v.optional(v.id("users")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    const limit = Math.min(args.limit ?? 50, 100);

    // Use the most selective index available
    let q;
    if (args.actorUserId) {
      q = ctx.db
        .query("domainEvents")
        .withIndex("by_tenantId_and_actorUserId_and_occurredAt", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("actorUserId", args.actorUserId!)
            .gte("occurredAt", args.startDate)
            .lt("occurredAt", args.endDate),
        )
        .order("desc");
    } else if (args.eventType) {
      q = ctx.db
        .query("domainEvents")
        .withIndex("by_tenantId_and_eventType_and_occurredAt", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("eventType", args.eventType!)
            .gte("occurredAt", args.startDate)
            .lt("occurredAt", args.endDate),
        )
        .order("desc");
    } else {
      q = ctx.db
        .query("domainEvents")
        .withIndex("by_tenantId_and_occurredAt", (q) =>
          q
            .eq("tenantId", tenantId)
            .gte("occurredAt", args.startDate)
            .lt("occurredAt", args.endDate),
        )
        .order("desc");
    }

    const events = await q.take(limit);

    // Batch-enrich with actor names (deduplicated)
    const actorIds = [
      ...new Set(events.map((e) => e.actorUserId).filter(Boolean)),
    ] as Id<"users">[];
    const actors = new Map(
      await Promise.all(
        actorIds.map(async (id) => [id, await ctx.db.get(id)] as const),
      ),
    );

    return events.map((e) => ({
      ...e,
      actorName: e.actorUserId
        ? (actors.get(e.actorUserId)?.fullName ?? actors.get(e.actorUserId)?.email)
        : null,
      metadata: e.metadata ? JSON.parse(e.metadata as string) : null,
    }));
  },
});

export const getActivitySummary = query({
  args: { startDate: v.number(), endDate: v.number() },
  handler: async (ctx, { startDate, endDate }) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    const bySource: Record<string, number> = { closer: 0, admin: 0, pipeline: 0, system: 0 };
    const byEntity: Record<string, number> = {};
    const byActor: Record<string, number> = {};
    let total = 0;

    for await (const event of ctx.db
      .query("domainEvents")
      .withIndex("by_tenantId_and_occurredAt", (q) =>
        q.eq("tenantId", tenantId).gte("occurredAt", startDate).lt("occurredAt", endDate),
      )) {
      total++;
      if (total > 10000) break; // Safety cap for large date ranges
      bySource[event.source] = (bySource[event.source] ?? 0) + 1;
      byEntity[event.entityType] = (byEntity[event.entityType] ?? 0) + 1;
      if (event.actorUserId) {
        byActor[event.actorUserId as string] = (byActor[event.actorUserId as string] ?? 0) + 1;
      }
    }

    return {
      totalEvents: total,
      isTruncated: total > 10000,
      bySource,
      byEntity,
      byActor,
    };
  },
});
```

**Key implementation notes:**
- The feed query selects the most selective index based on which filters are provided (actor > eventType > date-only).
- Actor name enrichment is batch-deduplicated — if 30 events have 5 distinct actors, only 5 `.get()` calls are made.
- Summary scan caps at 10,000 events with `isTruncated` flag. At current volume (~1,000/month), this is never hit. At 10x, add a `domainEventCounts` aggregate.
- `metadata` is stored as a JSON string in `domainEvents` — parse it for the frontend.
- Event type filtering uses the `by_tenantId_and_eventType_and_occurredAt` index. Verify this index exists in `schema.ts`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/activityFeed.ts` | Create | Paginated feed + summary queries |
| `convex/reporting/lib/eventLabels.ts` | Create | ~20 event type → verb/icon mappings |

---

### 3G — Form Response Analytics + Outcome Derivation

**Type:** Backend
**Parallelizable:** Yes — after 3A. Touches only new files.

**What:** Implement `getFieldCatalog` (list form fields) and `getAnswerDistribution` (answer frequency for a selected field). Create the `outcomeDerivation.ts` helper for future Tier 2 supplementary queries.

**Why:** Form Response Analytics is the unique insight that can't be derived from the Excel. Answer distribution shows which Calendly form responses are most common, revealing patterns in lead qualification. Outcome derivation is a shared helper for any query that needs to classify a meeting's result.

**Where:**
- `convex/reporting/formResponseAnalytics.ts` (new)
- `convex/reporting/lib/outcomeDerivation.ts` (new)

**How:**

**Step 1: Create form response analytics queries**

```typescript
// Path: convex/reporting/formResponseAnalytics.ts
import { query } from "../_generated/server";
import { v } from "convex/values";
import { requireTenantUser } from "../requireTenantUser";

export const getFieldCatalog = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    const fields = await ctx.db
      .query("eventTypeFieldCatalog")
      .withIndex("by_tenantId_and_fieldKey", (q) => q.eq("tenantId", tenantId))
      .collect();

    return fields.map((f) => ({
      id: f._id,
      fieldKey: f.fieldKey,
      currentLabel: f.currentLabel,
      firstSeenAt: f.firstSeenAt,
      lastSeenAt: f.lastSeenAt,
    }));
  },
});

export const getAnswerDistribution = query({
  args: {
    fieldKey: v.string(),
    startDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
  },
  handler: async (ctx, { fieldKey, startDate, endDate }) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    const responses: string[] = [];
    for await (const r of ctx.db
      .query("meetingFormResponses")
      .withIndex("by_tenantId_and_fieldKey", (q) =>
        q.eq("tenantId", tenantId).eq("fieldKey", fieldKey),
      )) {
      if (startDate && r.capturedAt < startDate) continue;
      if (endDate && r.capturedAt >= endDate) continue;
      responses.push(r.answerText);
    }

    // Group and count
    const freq: Record<string, number> = {};
    for (const answer of responses) {
      const normalized = answer.trim();
      freq[normalized] = (freq[normalized] ?? 0) + 1;
    }

    const distribution = Object.entries(freq)
      .map(([answer, count]) => ({
        answer,
        count,
        percent: responses.length > 0 ? (count / responses.length) * 100 : 0,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      fieldKey,
      totalResponses: responses.length,
      distinctAnswers: distribution.length,
      distribution,
    };
  },
});
```

**Step 2: Create outcome derivation helper**

```typescript
// Path: convex/reporting/lib/outcomeDerivation.ts
import type { Doc } from "../../_generated/dataModel";

export type CallOutcome =
  | "sold"
  | "lost"
  | "no_show"
  | "canceled"
  | "rescheduled"
  | "follow_up"
  | "dq"
  | "scheduled"
  | "in_progress";

/**
 * Derive the call outcome for a meeting.
 * Priority order: Sold > Lost > No show > Canceled > Rescheduled > DQ > Follow up > In progress > Scheduled
 */
export function deriveCallOutcome(
  meeting: Doc<"meetings">,
  opportunity: Doc<"opportunities">,
  hasPayment: boolean,
  isRescheduled: boolean,
): CallOutcome {
  if (hasPayment) return "sold";
  if (opportunity.status === "lost" && opportunity.latestMeetingId === meeting._id) return "lost";
  if (meeting.status === "no_show") return "no_show";
  if (meeting.status === "canceled") return "canceled";
  if (isRescheduled) return "rescheduled";
  if (meeting.meetingOutcome === "not_qualified") return "dq";
  if (opportunity.status === "follow_up_scheduled" && meeting.status === "completed") return "follow_up";
  if (meeting.status === "in_progress") return "in_progress";
  return "scheduled";
}
```

**Key implementation notes:**
- `getFieldCatalog` uses `.collect()` — safe because the catalog is small (typically < 20 fields per tenant).
- `getAnswerDistribution` does in-memory date filtering after the index scan. At scale, a composite index `by_tenantId_and_fieldKey_and_capturedAt` would be better, but at current volume this is fine.
- `deriveCallOutcome` has a strict priority order — "sold" always wins over other statuses. This matches business logic where a payment receipt is the definitive outcome.
- `outcomeDerivation.ts` is not consumed by any Phase 3 query yet — it's created now for Phase 5 frontend components that need client-side outcome display.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/formResponseAnalytics.ts` | Create | Field catalog + answer distribution queries |
| `convex/reporting/lib/outcomeDerivation.ts` | Create | Call outcome derivation helper |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/reporting/lib/helpers.ts` | Create | 3A |
| `convex/reporting/teamPerformance.ts` | Create | 3B |
| `convex/reporting/revenue.ts` | Create | 3C |
| `convex/reporting/revenueTrend.ts` | Create | 3C |
| `convex/reporting/pipelineHealth.ts` | Create | 3D |
| `convex/reporting/leadConversion.ts` | Create | 3E |
| `convex/reporting/activityFeed.ts` | Create | 3F |
| `convex/reporting/lib/eventLabels.ts` | Create | 3F |
| `convex/reporting/formResponseAnalytics.ts` | Create | 3G |
| `convex/reporting/lib/outcomeDerivation.ts` | Create | 3G |
