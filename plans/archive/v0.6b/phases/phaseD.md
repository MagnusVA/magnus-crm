# Phase D — Review Operations Report

**Goal:** Ship a new admin-only report at `/workspace/reports/reviews` that exposes **review analytics** (backlog count, resolution mix, reviewer workload, manual-time correction rate, dispute rate, disputed revenue, closer-response mix) without disturbing the existing operational inbox at `/workspace/reviews`. Adds one small schema index (`by_tenantId_and_resolvedAt`) so resolution analytics can be filtered by `resolvedAt` without scanning all historical rows.

**Prerequisite:** The `meetingReviews` table exists (lives in `convex/schema.ts:514-573`) and has `resolvedAt`, `resolvedByUserId`, `resolutionAction`, `timesSetByUserId`, `closerResponse` fields (all currently written). No other phase blocks Phase D.

**Runs in PARALLEL with:** Phase A, Phase B, Phase C, Phase E, Phase F, Phase G (back-end subphases), Phase H. Phase D modifies `convex/schema.ts` (index-only addition) — coordination required if Phase G lands the schema widen in the same deploy; both are additive and do not conflict.

**Skills to invoke:**
- `convex-performance-audit` — new query does two capped scans (`meetingReviews` pending + `meetingReviews` resolved-in-range) plus one `paymentRecords` scan for disputed revenue. Verify read budget stays within limits.
- `shadcn` — `Card`, `Table`, `Chart`, `Progress`, `Badge` primitives for the 8 panels.
- `web-design-guidelines` — reviewer workload table needs keyboard-sortable columns; disputed-revenue card needs currency ARIA announcement.
- `frontend-design` — balance 8 sub-panels with clear visual grouping (backlog / resolution mix / workload / closer response / dispute & revenue).

**Acceptance Criteria:**
1. `convex/schema.ts` adds an index on `meetingReviews`: `by_tenantId_and_resolvedAt` (fields: `["tenantId", "resolvedAt"]`). `npx convex dev` accepts the new index without errors.
2. `/workspace/reports/reviews` is mounted and gated by the existing `requireRole(["tenant_master","tenant_admin"])` at `app/workspace/reports/layout.tsx`.
3. The page clearly separates **current backlog** (as-of-now queue metric — not date-range filtered) from **resolution analytics** (filtered by `resolvedAt` inside the selected date range) in both UI labels and tooltips.
4. Backlog card shows `pendingCount` capped at 2,000 with a truncation banner when exceeded.
5. Resolution mix chart renders all 6 `resolutionAction` values: `log_payment`, `schedule_follow_up`, `mark_no_show`, `mark_lost`, `acknowledged`, `disputed`.
6. Reviewer workload table renders one row per `resolvedByUserId` with columns: Reviewer, Resolved Count, Avg Resolve Latency.
7. Cards for: Manual-Time Correction Rate, Dispute Rate, Disputed Revenue (sum of `paymentRecords.amountMinor WHERE status === "disputed" AND recordedAt in range`), Avg Resolve Latency.
8. Closer Response Mix chart renders `forgot_to_press`, `did_not_attend`, `no_response` (reviews without a closer response).
9. Operational inbox `/workspace/reviews` is **unchanged** — no modifications to `convex/reviews/queries.ts` or `app/workspace/reviews/*`.
10. Navigating to the route as a `closer` redirects (inherited layout behavior).
11. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
D1 (schema index — backend) ────────────────┐
                                             │
                                             ├── D2 (reviewsReporting.ts — backend; depends on D1)
                                             │
                                             └── D3 (route shell — frontend; can build with stubs before D2)
                                                 │
                                                 ├── D4 (backlog + resolution mix + workload — frontend; depends on D2)
                                                 │
                                                 └── D5 (dispute / revenue / closer response — frontend; depends on D2)
```

**Optimal execution:**
1. **Schema first (serial):** D1 must deploy before D2's query compiles (the query uses the new index).
2. **Backend (after D1):** D2 creates the single reporting query.
3. **Frontend shell (parallel with D1/D2):** D3 creates the route tree + page client with stub data shapes.
4. **Frontend sections (parallel, after D2):** D4 and D5 can ship in parallel once the query lands.

**Estimated time:** 2 days (solo); 1 day with backend + frontend parallel; ~0.75 day with 2 frontend agents + 1 backend.

---

## Subphases

### D1 — Schema Index: `meetingReviews.by_tenantId_and_resolvedAt`

**Type:** Backend (schema modification — index-only addition)
**Parallelizable:** No — must deploy before D2. But independent of all other Phase D subphases and of all other phases (Phase G adds *fields* to different tables; no conflict).

**What:** Add a single index to `meetingReviews`: `by_tenantId_and_resolvedAt` with fields `["tenantId", "resolvedAt"]`.

**Why:** Phase D's `getReviewReportingMetrics` filters resolved reviews by `resolvedAt in [startDate, endDate)`. `meetingReviews` currently only indexes by `(tenantId, status, createdAt)` — filtering by `resolvedAt` post-scan would require pulling every review the tenant has ever created. At 6+ months of operation, that exceeds the query bound.

**Where:**
- `convex/schema.ts` (modify — `meetingReviews` table, line 514-573)

**How:**

**Step 1: Add the index definition.**

```typescript
// Path: convex/schema.ts

// BEFORE (lines 563–573 — existing meetingReviews indexes):
meetingReviews: defineTable({
  // ... existing fields (lines 514-561) unchanged ...
})
  .index("by_tenantId_and_status_and_createdAt", [
    "tenantId",
    "status",
    "createdAt",
  ])
  .index("by_meetingId", ["meetingId"])
  .index("by_tenantId_and_closerId_and_createdAt", [
    "tenantId",
    "closerId",
    "createdAt",
  ]),

// AFTER (v0.6b — add single index):
meetingReviews: defineTable({
  // ... existing fields (lines 514-561) unchanged ...
})
  .index("by_tenantId_and_status_and_createdAt", [
    "tenantId",
    "status",
    "createdAt",
  ])
  .index("by_meetingId", ["meetingId"])
  .index("by_tenantId_and_closerId_and_createdAt", [
    "tenantId",
    "closerId",
    "createdAt",
  ])
  // v0.6b — Phase D: filter resolution analytics by resolvedAt in range.
  // `resolvedAt` is optional (null for pending rows). Convex indexes accept
  // optional fields; rows with undefined resolvedAt are simply not present
  // in this index range queries, which is what we want.
  .index("by_tenantId_and_resolvedAt", ["tenantId", "resolvedAt"]),
```

**Step 2: Deploy and verify.**

```bash
npx convex dev
```

Verify in the Convex dashboard that the new index exists on `meetingReviews`.

**Step 3: Cross-check existing queries.**

Run `rg -n 'meetingReviews' convex` to confirm no existing query accidentally references the new index name (name collision would fail the TypeScript type-check). Expected: no matches for the new string.

**Key implementation notes:**
- The new index is additive — no existing query changes, no backfill required.
- `resolvedAt` is `v.optional(v.number())` — the index handles undefined by omission (Convex semantics).
- This is the **only** schema change in Phase D. The origin/creator fields in `paymentRecords` / `followUps` belong to Phase G.
- **Do not** add a composite index on `(tenantId, resolutionAction, resolvedAt)`. At current volume the post-scan rollup is cheap and a second index is unnecessary.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add `by_tenantId_and_resolvedAt` to `meetingReviews`; no field changes |

---

### D2 — `reviewsReporting.ts`: Analytics Query (NEW)

**Type:** Backend (new query, new file)
**Parallelizable:** Depends on D1 (schema index deployed). Independent of D3/D4/D5.

**What:** Create `convex/reporting/reviewsReporting.ts` exporting `getReviewReportingMetrics`. One query that returns: current backlog shape, resolution-mix counts, reviewer workload table, dispute rate + disputed revenue, avg resolve latency, closer response mix.

**Why:** The operational inbox at `convex/reviews/queries.ts` caps at 50/100 rows by design — correct for an inbox UI, wrong for reporting. A dedicated analytics query decouples the two consumers so the inbox can keep its tight bounds while reports see the full picture.

**Where:**
- `convex/reporting/reviewsReporting.ts` (new)

**How:**

**Step 1: Define constants and types.**

```typescript
// Path: convex/reporting/reviewsReporting.ts

import { v } from "convex/values";
import { query } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireTenantUser } from "../requireTenantUser";
import { assertValidDateRange, getUserDisplayName } from "./lib/helpers";

const MAX_PENDING = 2001;
const MAX_RESOLVED = 2001;
const MAX_DISPUTED_PAYMENTS = 2000;

type ResolutionAction =
  | "log_payment"
  | "schedule_follow_up"
  | "mark_no_show"
  | "mark_lost"
  | "acknowledged"
  | "disputed";

type CloserResponse = "forgot_to_press" | "did_not_attend";

const RESOLUTION_ACTIONS = [
  "log_payment",
  "schedule_follow_up",
  "mark_no_show",
  "mark_lost",
  "acknowledged",
  "disputed",
] as const satisfies ReadonlyArray<ResolutionAction>;

function emptyResolutionMix(): Record<ResolutionAction, number> {
  return {
    log_payment: 0,
    schedule_follow_up: 0,
    mark_no_show: 0,
    mark_lost: 0,
    acknowledged: 0,
    disputed: 0,
  };
}
```

**Step 2: Define and export the query.**

```typescript
// Path: convex/reporting/reviewsReporting.ts

export const getReviewReportingMetrics = query({
  args: { startDate: v.number(), endDate: v.number() },
  handler: async (ctx, { startDate, endDate }) => {
    assertValidDateRange(startDate, endDate);

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    // === 1. Current backlog (as-of-now queue; NOT date-range-filtered) ===
    // Uses existing by_tenantId_and_status_and_createdAt index; status = "pending".
    const pendingReviews = await ctx.db
      .query("meetingReviews")
      .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", "pending"),
      )
      .take(MAX_PENDING);

    const backlog = {
      pendingCount: Math.min(pendingReviews.length, MAX_PENDING - 1),
      isTruncated: pendingReviews.length >= MAX_PENDING,
      measuredAt: Date.now(),
    };

    // === 2. Resolution analytics cohort (resolved within selected range) ===
    // Uses the new by_tenantId_and_resolvedAt index added in D1.
    const resolvedReviews = await ctx.db
      .query("meetingReviews")
      .withIndex("by_tenantId_and_resolvedAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("resolvedAt", startDate)
          .lt("resolvedAt", endDate),
      )
      .take(MAX_RESOLVED);

    const isResolvedRangeTruncated = resolvedReviews.length >= MAX_RESOLVED;
    const scannedResolved = resolvedReviews.slice(0, MAX_RESOLVED - 1);
    const resolvedCount = scannedResolved.length;

    const resolutionMix = emptyResolutionMix();
    const closerResponseMix: Record<CloserResponse | "no_response", number> = {
      forgot_to_press: 0,
      did_not_attend: 0,
      no_response: 0,
    };
    let manualTimeCorrectionCount = 0;
    let totalResolveLatencyMs = 0;
    let latencySampleCount = 0;
    const reviewerMap = new Map<Id<"users">, { resolved: number; totalLatencyMs: number }>();
    let unclassifiedResolved = 0;

    for (const r of scannedResolved) {
      if (r.resolutionAction && RESOLUTION_ACTIONS.includes(r.resolutionAction)) {
        resolutionMix[r.resolutionAction]++;
      } else {
        // Defensive: in theory impossible (see §16.4 of design), but count defensively.
        unclassifiedResolved++;
      }
      if (r.timesSetByUserId) manualTimeCorrectionCount++;
      if (r.resolvedAt !== undefined) {
        const latencyMs = r.resolvedAt - r.createdAt;
        totalResolveLatencyMs += latencyMs;
        latencySampleCount++;
        if (r.resolvedByUserId) {
          const prev = reviewerMap.get(r.resolvedByUserId) ?? { resolved: 0, totalLatencyMs: 0 };
          reviewerMap.set(r.resolvedByUserId, {
            resolved: prev.resolved + 1,
            totalLatencyMs: prev.totalLatencyMs + latencyMs,
          });
        }
      }
      if (r.closerResponse) {
        closerResponseMix[r.closerResponse]++;
      } else {
        closerResponseMix.no_response++;
      }
    }

    // === 3. Hydrate reviewer names ===
    const reviewerUserIds = Array.from(reviewerMap.keys());
    const reviewers = await Promise.all(
      reviewerUserIds.map(async (userId) => {
        const user = await ctx.db.get(userId);
        const stats = reviewerMap.get(userId)!;
        return {
          userId,
          reviewerName: user ? getUserDisplayName(user) : "Unknown admin",
          resolved: stats.resolved,
          avgLatencyMs: stats.totalLatencyMs / stats.resolved,
        };
      }),
    );
    reviewers.sort((a, b) => b.resolved - a.resolved);

    // === 4. Disputed revenue (sum of paymentRecords with status="disputed" recordedAt in range) ===
    // Use by_tenantId_and_status_and_recordedAt (existing index) for efficient status-filtered range.
    const disputedPayments = await ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId_and_status_and_recordedAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("status", "disputed")
          .gte("recordedAt", startDate)
          .lt("recordedAt", endDate),
      )
      .take(MAX_DISPUTED_PAYMENTS);

    const isDisputedRevenueTruncated = disputedPayments.length >= MAX_DISPUTED_PAYMENTS;
    const disputedRevenueMinor = disputedPayments.reduce(
      (sum, p) => sum + p.amountMinor,
      0,
    );
    const disputedPaymentsCount = disputedPayments.length;

    return {
      backlog,
      resolvedCount,
      unclassifiedResolved,
      resolutionMix,
      manualTimeCorrectionCount,
      manualTimeCorrectionRate:
        resolvedCount > 0 ? manualTimeCorrectionCount / resolvedCount : null,
      avgResolveLatencyMs:
        latencySampleCount > 0 ? totalResolveLatencyMs / latencySampleCount : null,
      closerResponseMix,
      disputeRate:
        resolvedCount > 0 ? resolutionMix.disputed / resolvedCount : null,
      disputedRevenueMinor,
      disputedPaymentsCount,
      isResolvedRangeTruncated,
      isDisputedRevenueTruncated,
      reviewerWorkload: reviewers,
    };
  },
});
```

**Key implementation notes:**
- **Two separate concepts:** `backlog` (as-of-now, not range-filtered) vs `resolvedCount` etc. (filtered by `resolvedAt`). The response object keeps them in distinct sub-shapes so UI labels can't conflate them.
- `MAX_PENDING = 2001` vs `pendingCount = min(len, 2000)`: We take one row beyond the cap so we can detect truncation (`length >= 2001` → `isTruncated = true`) without introducing an extra count query.
- `unclassifiedResolved` is zero in practice (every resolve path currently sets `resolutionAction`). Defensive counter preserves information if a future `resolveReview` variant is added that forgets to set it.
- Latency sample count `latencySampleCount` is tracked separately from `resolvedCount` because some rows might have `resolvedAt = undefined` defensively (in theory impossible; belt-and-braces).
- Disputed revenue uses the **existing** `by_tenantId_and_status_and_recordedAt` index — confirmed in the audit. No new index needed for the payment scan.
- Returning `disputedPaymentsCount` alongside `disputedRevenueMinor` gives the frontend "sum + count" for a card like `"$X across Y disputes."`.
- `reviewers` are sorted descending by resolved count so the table header row reads "most active reviewer first."
- `resolvedReviews.slice(0, MAX_RESOLVED - 1)` deliberately drops the probe row so `resolvedCount` is clamped to 2,000, consistent with the backlog capping.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/reviewsReporting.ts` | Create | Single analytics query; operational inbox untouched |

---

### D3 — Route Shell, Page, Skeleton

**Type:** Frontend (new route tree)
**Parallelizable:** Yes — new files under new route. Independent of D1/D2/D4/D5.

**What:** Create the three-layer Next.js page shell and skeleton. Sets up `useQuery` subscription against the (not-yet-implemented during early D3) `getReviewReportingMetrics`. Stub helper components so TypeScript compiles.

**Where:**
- `app/workspace/reports/reviews/page.tsx` (new)
- `app/workspace/reports/reviews/loading.tsx` (new)
- `app/workspace/reports/reviews/_components/reviews-report-page-client.tsx` (new)
- `app/workspace/reports/reviews/_components/reviews-report-skeleton.tsx` (new)

**How:**

**Step 1: Thin RSC page.**

```tsx
// Path: app/workspace/reports/reviews/page.tsx

import { ReviewsReportPageClient } from "./_components/reviews-report-page-client";

export const unstable_instant = false;

export default function ReviewsReportPage() {
  return <ReviewsReportPageClient />;
}
```

**Step 2: Route-level loading skeleton.**

```tsx
// Path: app/workspace/reports/reviews/loading.tsx

import { ReviewsReportSkeleton } from "./_components/reviews-report-skeleton";

export default function ReviewsReportLoading() {
  return <ReviewsReportSkeleton />;
}
```

**Step 3: Client shell.**

```tsx
// Path: app/workspace/reports/reviews/_components/reviews-report-page-client.tsx
"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { ReportDateControls, type DateRange } from "../../_components/report-date-controls";
import { usePageTitle } from "@/hooks/use-page-title";

import { ReviewBacklogCard } from "./review-backlog-card";
import { ResolutionMixChart } from "./resolution-mix-chart";
import { ReviewerWorkloadTable } from "./reviewer-workload-table";
import { ManualTimeCorrectionRateCard } from "./manual-time-correction-rate-card";
import { DisputeRateCard } from "./dispute-rate-card";
import { DisputedRevenueCard } from "./disputed-revenue-card";
import { AvgResolveLatencyCard } from "./avg-resolve-latency-card";
import { CloserResponseMixChart } from "./closer-response-mix-chart";
import { ReviewsReportSkeleton } from "./reviews-report-skeleton";

function defaultDateRange(): DateRange {
  const now = new Date();
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + 1);
  const start = new Date(end);
  start.setDate(start.getDate() - 31);
  return { startDate: start.getTime(), endDate: end.getTime() };
}

export function ReviewsReportPageClient() {
  usePageTitle("Review Ops");
  const [dateRange, setDateRange] = useState<DateRange>(defaultDateRange);
  const data = useQuery(api.reporting.reviewsReporting.getReviewReportingMetrics, dateRange);

  if (!data) return <ReviewsReportSkeleton />;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Review Ops</h1>
        <p className="text-sm text-muted-foreground">
          Backlog, resolution mix, reviewer workload, dispute rate, and closer-response signals for
          overran-meeting reviews.
        </p>
      </header>

      <ReportDateControls value={dateRange} onChange={setDateRange} />

      {/* === Current backlog — NOT date-range filtered === */}
      <section aria-labelledby="backlog-header">
        <h2 id="backlog-header" className="mb-3 text-lg font-medium">
          Current Backlog
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Measured as of now — not affected by the date range above.
        </p>
        <ReviewBacklogCard backlog={data.backlog} />
      </section>

      {/* === Resolution analytics — filtered by resolvedAt in range === */}
      <section aria-labelledby="resolution-header">
        <h2 id="resolution-header" className="mb-3 text-lg font-medium">
          Resolution Analytics
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Reviews resolved within the selected date range.
        </p>

        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <ManualTimeCorrectionRateCard
            rate={data.manualTimeCorrectionRate}
            count={data.manualTimeCorrectionCount}
            resolvedCount={data.resolvedCount}
          />
          <DisputeRateCard
            rate={data.disputeRate}
            count={data.resolutionMix.disputed}
            resolvedCount={data.resolvedCount}
          />
          <DisputedRevenueCard
            amountMinor={data.disputedRevenueMinor}
            count={data.disputedPaymentsCount}
            isTruncated={data.isDisputedRevenueTruncated}
          />
          <AvgResolveLatencyCard latencyMs={data.avgResolveLatencyMs} />
        </div>

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ResolutionMixChart
            resolutionMix={data.resolutionMix}
            resolvedCount={data.resolvedCount}
            unclassified={data.unclassifiedResolved}
            isTruncated={data.isResolvedRangeTruncated}
          />
          <CloserResponseMixChart closerResponseMix={data.closerResponseMix} />
        </div>

        <div className="mt-6">
          <ReviewerWorkloadTable reviewers={data.reviewerWorkload} />
        </div>
      </section>
    </div>
  );
}
```

**Step 4: Skeleton.**

```tsx
// Path: app/workspace/reports/reviews/_components/reviews-report-skeleton.tsx

import { Skeleton } from "@/components/ui/skeleton";

export function ReviewsReportSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading review ops">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
      </div>
      <Skeleton className="h-10 w-72" />
      <Skeleton className="h-28" />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}
```

**Key implementation notes:**
- The **critical UX distinction** is separating backlog (as-of-now) from resolution analytics (date-filtered). The header + caption on each section carries this contract; tooltips in each card repeat it as needed.
- `usePageTitle("Review Ops")` — matches the recommendation in design §17, Open Q5: the report area is "Review Ops" to avoid collision with the operational inbox `"Reviews"`.
- The page client has **one** `useQuery` subscription (the query returns all panel data). Avoid adding per-panel subscriptions — wastes resources.
- Stub the 8 card/chart components as empty `export function X() { return null }` so TS compiles. Fill them in D4/D5.
- Do **not** import `reviews-page-client.tsx` from the operational inbox — it's a different module and shares no structure.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/reviews/page.tsx` | Create | Thin RSC |
| `app/workspace/reports/reviews/loading.tsx` | Create | Route skeleton |
| `app/workspace/reports/reviews/_components/reviews-report-page-client.tsx` | Create | Client shell with one `useQuery` |
| `app/workspace/reports/reviews/_components/reviews-report-skeleton.tsx` | Create | Matches final layout |

---

### D4 — Backlog + Resolution Mix + Workload (UI)

**Type:** Frontend (new components)
**Parallelizable:** Depends on D2. Independent of D3/D5.

**What:** Three components:
- `ReviewBacklogCard` — single big card with pending count + badge for truncation.
- `ResolutionMixChart` — stacked horizontal bar (all 6 action categories) + count legend.
- `ReviewerWorkloadTable` — sortable table (Reviewer name, Resolved Count, Avg Latency).

**Where:**
- `app/workspace/reports/reviews/_components/review-backlog-card.tsx` (new)
- `app/workspace/reports/reviews/_components/resolution-mix-chart.tsx` (new)
- `app/workspace/reports/reviews/_components/reviewer-workload-table.tsx` (new)

**How:**

**Step 1: `ReviewBacklogCard`.**

```tsx
// Path: app/workspace/reports/reviews/_components/review-backlog-card.tsx
"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { InboxIcon } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface ReviewBacklogCardProps {
  backlog: {
    pendingCount: number;
    isTruncated: boolean;
    measuredAt: number;
  };
}

export function ReviewBacklogCard({ backlog }: ReviewBacklogCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <InboxIcon className="h-4 w-4 text-muted-foreground" />
          <CardTitle>Pending Reviews</CardTitle>
          {backlog.isTruncated && (
            <Badge
              variant="secondary"
              className="ml-auto bg-yellow-100 text-yellow-900 dark:bg-yellow-900/30 dark:text-yellow-200"
            >
              Truncated
            </Badge>
          )}
        </div>
        <CardDescription>
          As-of-now queue length — not affected by the date range above.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-4xl font-bold tabular-nums">{backlog.pendingCount.toLocaleString()}</div>
        <p className="mt-1 text-xs text-muted-foreground">
          Measured {formatDistanceToNow(backlog.measuredAt, { addSuffix: true })}
          {backlog.isTruncated && ` • Only first 2,000 pending reviews counted`}
        </p>
      </CardContent>
    </Card>
  );
}
```

**Step 2: `ResolutionMixChart` — stacked horizontal bar.**

```tsx
// Path: app/workspace/reports/reviews/_components/resolution-mix-chart.tsx
"use client";

import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis, Tooltip, Legend } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltipContent } from "@/components/ui/chart";

type ResolutionAction =
  | "log_payment"
  | "schedule_follow_up"
  | "mark_no_show"
  | "mark_lost"
  | "acknowledged"
  | "disputed";

const ACTION_LABELS: Record<ResolutionAction, string> = {
  log_payment: "Logged Payment",
  schedule_follow_up: "Scheduled Follow-Up",
  mark_no_show: "Marked No-Show",
  mark_lost: "Marked Lost",
  acknowledged: "Acknowledged",
  disputed: "Disputed",
};

const ACTION_COLORS: Record<ResolutionAction, string> = {
  log_payment: "var(--chart-1)",
  schedule_follow_up: "var(--chart-2)",
  mark_no_show: "var(--chart-3)",
  mark_lost: "var(--chart-4)",
  acknowledged: "var(--chart-5)",
  disputed: "var(--chart-6)",
};

interface ResolutionMixChartProps {
  resolutionMix: Record<ResolutionAction, number>;
  resolvedCount: number;
  unclassified: number;
  isTruncated: boolean;
}

export function ResolutionMixChart({
  resolutionMix,
  resolvedCount,
  unclassified,
  isTruncated,
}: ResolutionMixChartProps) {
  // Build a single-row stacked bar dataset.
  // recharts expects row-oriented data; each key becomes a stack segment.
  const data = [
    {
      category: "Total",
      ...resolutionMix,
    },
  ];
  const keys = Object.keys(ACTION_LABELS) as ResolutionAction[];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Resolution Mix</CardTitle>
        <CardDescription>
          {resolvedCount.toLocaleString()} review(s) resolved in range
          {unclassified > 0 && ` • ${unclassified} unclassified`}
          {isTruncated && ` • First 2,000 shown`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {resolvedCount === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No reviews resolved in selected range.
          </p>
        ) : (
          <ChartContainer
            config={Object.fromEntries(
              keys.map((key) => [key, { label: ACTION_LABELS[key], color: ACTION_COLORS[key] }]),
            )}
            className="h-40"
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} layout="vertical" stackOffset="expand">
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="category" hide />
                <Tooltip content={<ChartTooltipContent />} />
                <Legend />
                {keys.map((key) => (
                  <Bar
                    key={key}
                    dataKey={key}
                    stackId="resolution"
                    fill={ACTION_COLORS[key]}
                    name={ACTION_LABELS[key]}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
```

**Step 3: `ReviewerWorkloadTable` — client-side sortable.**

```tsx
// Path: app/workspace/reports/reviews/_components/reviewer-workload-table.tsx
"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTableSort } from "@/hooks/use-table-sort";
import { ArrowUpDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ReviewerWorkloadRow {
  userId: string;
  reviewerName: string;
  resolved: number;
  avgLatencyMs: number;
}

function formatLatencyMs(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return `${hours}h ${minutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function ReviewerWorkloadTable({ reviewers }: { reviewers: ReviewerWorkloadRow[] }) {
  const { sorted, sortKey, sortDir, toggleSort } = useTableSort(reviewers, "resolved", "desc");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reviewer Workload</CardTitle>
        <CardDescription>
          Per admin — reviews resolved in range and average time from review creation to resolution.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No resolved reviews in range.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-auto p-0 font-medium"
                      onClick={() => toggleSort("reviewerName")}
                    >
                      Reviewer <ArrowUpDownIcon className="ml-1 h-3 w-3" />
                    </Button>
                  </TableHead>
                  <TableHead className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-auto p-0 font-medium"
                      onClick={() => toggleSort("resolved")}
                    >
                      Resolved <ArrowUpDownIcon className="ml-1 h-3 w-3" />
                    </Button>
                  </TableHead>
                  <TableHead className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-auto p-0 font-medium"
                      onClick={() => toggleSort("avgLatencyMs")}
                    >
                      Avg Resolve Latency <ArrowUpDownIcon className="ml-1 h-3 w-3" />
                    </Button>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((r) => (
                  <TableRow key={r.userId}>
                    <TableCell>{r.reviewerName}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.resolved}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatLatencyMs(r.avgLatencyMs)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

**Key implementation notes:**
- `useTableSort` hook is already established in the codebase — client-side sort preserves the `useQuery` subscription (no refetch on column click).
- `formatLatencyMs` avoids surprising units: < 1 h → minutes, < 24 h → h + m, else days + hours. Prevents "720h" readouts.
- `ResolutionMixChart` uses `stackOffset="expand"` so the single bar renders as a 100% horizontal split — easy to eyeball proportions.
- `ACTION_LABELS` / `ACTION_COLORS` are co-located with the chart — do not hoist to a shared module unless Phase E needs them (it doesn't).
- Backlog truncation badge uses a warning tone; not destructive — it's an informational cap, not an error.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/reviews/_components/review-backlog-card.tsx` | Create | Pending-count card with truncation badge |
| `app/workspace/reports/reviews/_components/resolution-mix-chart.tsx` | Create | Single-row stacked horizontal bar, 100% scale |
| `app/workspace/reports/reviews/_components/reviewer-workload-table.tsx` | Create | Sortable table using `useTableSort` |

---

### D5 — Dispute / Revenue / Closer Response (UI)

**Type:** Frontend (new components)
**Parallelizable:** Depends on D2. Independent of D3/D4.

**What:** Five components:
- `ManualTimeCorrectionRateCard` — rate + count + denominator.
- `DisputeRateCard` — rate + count + denominator.
- `DisputedRevenueCard` — currency amount + count + truncation flag.
- `AvgResolveLatencyCard` — duration with adaptive unit.
- `CloserResponseMixChart` — bar chart of `forgot_to_press` / `did_not_attend` / `no_response`.

**Where:**
- `app/workspace/reports/reviews/_components/manual-time-correction-rate-card.tsx` (new)
- `app/workspace/reports/reviews/_components/dispute-rate-card.tsx` (new)
- `app/workspace/reports/reviews/_components/disputed-revenue-card.tsx` (new)
- `app/workspace/reports/reviews/_components/avg-resolve-latency-card.tsx` (new)
- `app/workspace/reports/reviews/_components/closer-response-mix-chart.tsx` (new)

**How:**

**Step 1: Small KPI cards with shared shape.**

```tsx
// Path: app/workspace/reports/reviews/_components/manual-time-correction-rate-card.tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WrenchIcon } from "lucide-react";

interface Props {
  rate: number | null;
  count: number;
  resolvedCount: number;
}

export function ManualTimeCorrectionRateCard({ rate, count, resolvedCount }: Props) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <WrenchIcon className="h-3.5 w-3.5" />
          Manual Time Correction Rate
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-xl font-bold tabular-nums">
          {rate === null ? "—" : `${(rate * 100).toFixed(1)}%`}
        </div>
        <p className="text-xs text-muted-foreground">
          {count} of {resolvedCount} resolutions
        </p>
      </CardContent>
    </Card>
  );
}
```

```tsx
// Path: app/workspace/reports/reviews/_components/dispute-rate-card.tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CircleAlertIcon } from "lucide-react";

interface Props {
  rate: number | null;
  count: number;
  resolvedCount: number;
}

export function DisputeRateCard({ rate, count, resolvedCount }: Props) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <CircleAlertIcon className="h-3.5 w-3.5" />
          Dispute Rate
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-xl font-bold tabular-nums">
          {rate === null ? "—" : `${(rate * 100).toFixed(1)}%`}
        </div>
        <p className="text-xs text-muted-foreground">
          {count} disputed of {resolvedCount}
        </p>
      </CardContent>
    </Card>
  );
}
```

```tsx
// Path: app/workspace/reports/reviews/_components/disputed-revenue-card.tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DollarSignIcon } from "lucide-react";

interface Props {
  amountMinor: number;
  count: number;
  isTruncated: boolean;
}

function formatCurrency(minor: number): string {
  return `$${(minor / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function DisputedRevenueCard({ amountMinor, count, isTruncated }: Props) {
  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <DollarSignIcon className="h-3.5 w-3.5" />
            Disputed Revenue
          </CardTitle>
          {isTruncated && (
            <Badge
              variant="secondary"
              className="ml-auto text-[10px] bg-yellow-100 text-yellow-900 dark:bg-yellow-900/30 dark:text-yellow-200"
            >
              Truncated
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-xl font-bold tabular-nums" aria-label={`${count} disputes totaling ${formatCurrency(amountMinor)}`}>
          {formatCurrency(amountMinor)}
        </div>
        <p className="text-xs text-muted-foreground">
          {count} disputed payment(s) in range
        </p>
      </CardContent>
    </Card>
  );
}
```

```tsx
// Path: app/workspace/reports/reviews/_components/avg-resolve-latency-card.tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TimerIcon } from "lucide-react";

function formatLatencyMs(ms: number | null): string {
  if (ms === null) return "—";
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return `${hours}h ${minutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function AvgResolveLatencyCard({ latencyMs }: { latencyMs: number | null }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <TimerIcon className="h-3.5 w-3.5" />
          Avg Resolve Latency
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-xl font-bold tabular-nums">{formatLatencyMs(latencyMs)}</div>
        <p className="text-xs text-muted-foreground">From review creation</p>
      </CardContent>
    </Card>
  );
}
```

**Step 2: Closer-response mix chart.**

```tsx
// Path: app/workspace/reports/reviews/_components/closer-response-mix-chart.tsx
"use client";

import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid, Cell } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltipContent } from "@/components/ui/chart";

interface Props {
  closerResponseMix: {
    forgot_to_press: number;
    did_not_attend: number;
    no_response: number;
  };
}

const RESPONSE_META = [
  { key: "forgot_to_press", label: "Forgot to Press", color: "var(--chart-1)" },
  { key: "did_not_attend", label: "Did Not Attend", color: "var(--chart-3)" },
  { key: "no_response", label: "No Response", color: "var(--muted-foreground)" },
] as const;

export function CloserResponseMixChart({ closerResponseMix }: Props) {
  const data = RESPONSE_META.map((m) => ({
    key: m.key,
    label: m.label,
    count: closerResponseMix[m.key],
    fill: m.color,
  }));
  const total = data.reduce((s, d) => s + d.count, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Closer Response Mix</CardTitle>
        <CardDescription>
          How did closers classify the overran meeting at review creation? "No response" = closer
          hadn't clicked either option before resolution.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No review data in range.</p>
        ) : (
          <ChartContainer
            config={Object.fromEntries(
              RESPONSE_META.map((m) => [m.key, { label: m.label, color: m.color }]),
            )}
            className="h-48"
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 16 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
                <Tooltip content={<ChartTooltipContent />} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {data.map((d) => <Cell key={d.key} fill={d.fill} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
```

**Key implementation notes:**
- All 4 small cards are `size="sm"` — compact enough to fit 4-across on md screens. Content density matches the rest of the reports area.
- `DisputedRevenueCard` has an `aria-label` on the amount because screen readers otherwise read `$X,XXX.XX` without context — the label includes the count for full meaning.
- Currency formatting uses `toLocaleString` with 2 decimal places; avoids Intl edge cases.
- `closerResponseMix` chart uses a vertical bar with `Cell` overrides — simpler than the stacked horizontal bar used for resolution mix, appropriate for 3 categories.
- No new useQuery subscriptions; all derive from the existing `data` object in the page client.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/reviews/_components/manual-time-correction-rate-card.tsx` | Create | Rate KPI card |
| `app/workspace/reports/reviews/_components/dispute-rate-card.tsx` | Create | Rate KPI card |
| `app/workspace/reports/reviews/_components/disputed-revenue-card.tsx` | Create | Currency KPI card + truncation badge |
| `app/workspace/reports/reviews/_components/avg-resolve-latency-card.tsx` | Create | Duration KPI card |
| `app/workspace/reports/reviews/_components/closer-response-mix-chart.tsx` | Create | Vertical bar for 3 categories |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modify | D1 |
| `convex/reporting/reviewsReporting.ts` | Create | D2 |
| `app/workspace/reports/reviews/page.tsx` | Create | D3 |
| `app/workspace/reports/reviews/loading.tsx` | Create | D3 |
| `app/workspace/reports/reviews/_components/reviews-report-page-client.tsx` | Create | D3 |
| `app/workspace/reports/reviews/_components/reviews-report-skeleton.tsx` | Create | D3 |
| `app/workspace/reports/reviews/_components/review-backlog-card.tsx` | Create | D4 |
| `app/workspace/reports/reviews/_components/resolution-mix-chart.tsx` | Create | D4 |
| `app/workspace/reports/reviews/_components/reviewer-workload-table.tsx` | Create | D4 |
| `app/workspace/reports/reviews/_components/manual-time-correction-rate-card.tsx` | Create | D5 |
| `app/workspace/reports/reviews/_components/dispute-rate-card.tsx` | Create | D5 |
| `app/workspace/reports/reviews/_components/disputed-revenue-card.tsx` | Create | D5 |
| `app/workspace/reports/reviews/_components/avg-resolve-latency-card.tsx` | Create | D5 |
| `app/workspace/reports/reviews/_components/closer-response-mix-chart.tsx` | Create | D5 |

**Blast radius:**
- **Backend:** 1 schema modify (single index) + 1 new query file. No existing query changed, no existing index renamed/removed. **Operational inbox (`convex/reviews/queries.ts`) untouched.**
- **Frontend:** 12 new files under `/workspace/reports/reviews/`. Zero modifications outside the new tree.
- **Sidebar nav:** Adds one nav entry in Phase H (`/workspace/reports/reviews` — labelled "Review Ops" to disambiguate from the operational "Reviews" inbox nav entry).
- **Index deploy order:** D1 must deploy before D2 so the index is available at query compile time. Standard Convex schema-deploy flow handles this (`npx convex dev` atomic deploy).

**Rollback plan:**
- **D1 rollback:** Removing the index is a pure schema revert — any queries referencing it (only `getReviewReportingMetrics`) must be removed too.
- **D2 rollback:** Delete the query file; frontend then shows a permanently loading skeleton until the page tree is also reverted.
- **D3/D4/D5 rollback:** Delete the new route tree.
- Full rollback: revert `convex/schema.ts` + delete `convex/reporting/reviewsReporting.ts` + delete `app/workspace/reports/reviews/`.

**Critical naming note:** The route lives at `/workspace/reports/reviews`; the operational inbox lives at `/workspace/reviews`. Both are referenced in the workspace sidebar. Phase H labels the reports-nav entry as "Review Ops" to disambiguate from the operational "Reviews" entry — see Phase H nav additions.
