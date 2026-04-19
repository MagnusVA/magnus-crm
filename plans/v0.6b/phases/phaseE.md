# Phase E — Reminder Outcome Funnel

**Goal:** Ship a new admin-only report at `/workspace/reports/reminders` that reads `followUps.completionOutcome` (5 values) across `type === "manual_reminder"` rows and renders: a created → completed → outcome funnel, per-closer conversion table, chain-length histogram, and (after Phase G ships) a reminder-driven revenue card. Adds one schema index (`by_tenantId_and_createdAt`) so the funnel can filter reminders by creation date without scanning historical rows.

**Prerequisite:** The `followUps` table exists with `completionOutcome` + `reason` + `type` + `status` (all currently written). No other phase blocks Phase E's shipping path — but Phase G's `origin` field on `paymentRecords` unlocks the "Reminder-Driven Revenue" card (handled in Phase G's reporting consumer step; until Phase G lands, the card renders "Pending Phase G" placeholder — see §8.5 in design).

**Runs in PARALLEL with:** Phase A, Phase B, Phase C, Phase D, Phase F, Phase G (backend subphases), Phase H. Phase E modifies `convex/schema.ts` (index-only addition) — atomic with Phase D's index (both additive; co-deploy safe).

**Skills to invoke:**
- `convex-performance-audit` — funnel query does one bounded scan of `followUps`.
- `shadcn` — `Card`, `Table`, `Chart` (funnel bar + histogram) primitives.
- `web-design-guidelines` — chart legend keyboard-nav; per-closer table sortable headers accessibly labelled.
- `frontend-design` — funnel visualization should read left-to-right; per-closer table parks at the bottom (not the top) to match admin workflow.

**Acceptance Criteria:**
1. `convex/schema.ts` adds one index on `followUps`: `by_tenantId_and_createdAt` (fields: `["tenantId", "createdAt"]`). `npx convex dev` accepts the new index without errors.
2. `/workspace/reports/reminders` is mounted, gated by the existing layout `requireRole(["tenant_master","tenant_admin"])`.
3. The page renders a **Reminder Funnel** visualization: Created → Completed → Outcome breakdown (5 outcomes) with exact counts on each node.
4. The page renders **Reminder Outcome Card Grid** — one card per outcome key showing count + percentage of completed reminders.
5. The page renders **Per-Closer Reminder Conversion Table**: Closer, Created, Completed, Completion %, Payment Received Count.
6. The page renders **Reminder Chain-Length Histogram**: group manual_reminders by `opportunityId`, bucket counts `1 / 2 / 3 / 4 / 5+`.
7. The page renders **Reminder-Driven Revenue Card** as a placeholder with text "Pending Phase G — requires durable origin on `paymentRecords`" until Phase G ships. (After Phase G lands, the card is upgraded — that upgrade is a Phase G reporting-consumer step, not in Phase E.)
8. Truncation banner displays when the scan hits `.take(2000)` (≥ 2 years of current volume).
9. Empty state renders cleanly when there are no manual reminders in range.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
E1 (schema index — backend) ────────────────┐
                                             │
                                             ├── E2 (remindersReporting.ts — backend; depends on E1)
                                             │
                                             └── E3 (route shell — frontend; can use stub data)
                                                 │
                                                 ├── E4 (funnel + outcome cards — frontend; depends on E2)
                                                 │
                                                 └── E5 (per-closer table + chain histogram + Phase-G placeholder — frontend; depends on E2)
```

**Optimal execution:**
1. **Schema first (serial):** E1 must deploy before E2.
2. **Backend (after E1):** E2 creates the single reporting query.
3. **Frontend shell (parallel with backend):** E3 can build against mocks while E1/E2 are in flight.
4. **Frontend sections (parallel, after E2):** E4 and E5 split cleanly and ship in parallel.

**Estimated time:** 2 days (solo); 1 day with backend + frontend parallel; 0.75 day with 2 frontend agents + 1 backend.

---

## Subphases

### E1 — Schema Index: `followUps.by_tenantId_and_createdAt`

**Type:** Backend (schema modification — index-only addition)
**Parallelizable:** No — must deploy before E2. Independent of other phases (Phase G adds fields to `followUps`; Phase E adds only an index — no conflict).

**What:** Add one index to the `followUps` table: `by_tenantId_and_createdAt` with fields `["tenantId", "createdAt"]`.

**Why:** `followUps` today has 8 indexes but none supports efficient range filtering on `(tenantId, createdAt)`. Phase E's query filters reminders by `createdAt in [startDate, endDate)` — without the index, Convex must scan all `followUps` for the tenant across all time. At 6+ months of reminder volume this exceeds the 2000-row bound pointlessly.

**Where:**
- `convex/schema.ts` (modify — `followUps` table, lines 711-778)

**How:**

**Step 1: Add the index definition.**

```typescript
// Path: convex/schema.ts

// BEFORE (lines 753–778 — existing followUps indexes):
followUps: defineTable({
  // ... existing fields (lines 711-752) unchanged ...
})
  .index("by_tenantId", ["tenantId"])
  .index("by_opportunityId", ["opportunityId"])
  .index("by_tenantId_and_closerId", ["tenantId", "closerId"])
  .index(
    "by_tenantId_and_closerId_and_status",
    ["tenantId", "closerId", "status"],
  )
  .index("by_tenantId_and_leadId_and_createdAt", [
    "tenantId",
    "leadId",
    "createdAt",
  ])
  .index("by_tenantId_and_closerId_and_type_and_status_reminderScheduledAt", [
    "tenantId",
    "closerId",
    "type",
    "status",
    "reminderScheduledAt",
  ])
  .index("by_tenantId_and_status_and_createdAt", [
    "tenantId",
    "status",
    "createdAt",
  ])
  .index("by_opportunityId_and_status", ["opportunityId", "status"]),

// AFTER (v0.6b — add one index):
followUps: defineTable({
  // ... existing fields (lines 711-752) unchanged ...
})
  // ... existing 8 indexes unchanged ...
  // v0.6b — Phase E: filter reminder funnel by createdAt in range.
  // This is a pure index addition — does not collide with Phase G's
  // createSource-based index (added in phaseG.md).
  .index("by_tenantId_and_createdAt", ["tenantId", "createdAt"]),
```

**Step 2: Deploy and verify.**

```bash
npx convex dev
```

Confirm the new index appears on the `followUps` table in the Convex dashboard.

**Step 3: Cross-check for accidental name collision.**

Run `rg -n 'by_tenantId_and_createdAt' convex` to confirm only the schema and (post-merge) `remindersReporting.ts` reference the new index. Phase G adds a different index `by_tenantId_and_createdSource_and_createdAt` — distinct name, no conflict.

**Key implementation notes:**
- Pure additive change. No existing index removed/renamed.
- `createdAt` is a `v.number()` non-optional field on every `followUps` row — no sparse-index weirdness.
- Phase G later adds `by_tenantId_and_createdSource_and_createdAt` to the same table. The two indexes are independent. If Phase G's schema deploy lands first, E1 still applies cleanly. If E1 ships first, Phase G still applies cleanly.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add `by_tenantId_and_createdAt` to `followUps` |

---

### E2 — `remindersReporting.ts`: Funnel Query (NEW)

**Type:** Backend (new query, new file)
**Parallelizable:** Depends on E1. Independent of E3/E4/E5.

**What:** Create `convex/reporting/remindersReporting.ts` exporting `getReminderOutcomeFunnel`. One query that returns: total created, total completed, completion rate, outcome mix, per-closer rollup, chain-length histogram.

**Why:** Today `followUps.completionOutcome` is written at 3 places but read by zero reports. The funnel is the canonical view of reminder effectiveness — missing it means admins cannot attribute payments back to reminder activity.

**Where:**
- `convex/reporting/remindersReporting.ts` (new)

**How:**

**Step 1: Define types.**

```typescript
// Path: convex/reporting/remindersReporting.ts

import { v } from "convex/values";
import { query } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireTenantUser } from "../requireTenantUser";
import { assertValidDateRange, getActiveClosers, getUserDisplayName } from "./lib/helpers";

const MAX_FOLLOWUPS_SCAN = 2000;

type CompletionOutcome =
  | "payment_received"
  | "lost"
  | "no_response_rescheduled"
  | "no_response_given_up"
  | "no_response_close_only";

const COMPLETION_OUTCOMES = [
  "payment_received",
  "lost",
  "no_response_rescheduled",
  "no_response_given_up",
  "no_response_close_only",
] as const satisfies ReadonlyArray<CompletionOutcome>;

type OutcomeMix = Record<CompletionOutcome, number>;

function emptyOutcomeMix(): OutcomeMix {
  return {
    payment_received: 0,
    lost: 0,
    no_response_rescheduled: 0,
    no_response_given_up: 0,
    no_response_close_only: 0,
  };
}

type PerCloserBucket = OutcomeMix & {
  created: number;
  completed: number;
};

function emptyPerCloserBucket(): PerCloserBucket {
  return { created: 0, completed: 0, ...emptyOutcomeMix() };
}

type ChainBucket = "1" | "2" | "3" | "4" | "5+";
const CHAIN_BUCKETS: readonly ChainBucket[] = ["1", "2", "3", "4", "5+"];

function bucketChainLength(n: number): ChainBucket {
  if (n <= 1) return "1";
  if (n === 2) return "2";
  if (n === 3) return "3";
  if (n === 4) return "4";
  return "5+";
}
```

**Step 2: Query handler.**

```typescript
// Path: convex/reporting/remindersReporting.ts

export const getReminderOutcomeFunnel = query({
  args: { startDate: v.number(), endDate: v.number() },
  handler: async (ctx, { startDate, endDate }) => {
    assertValidDateRange(startDate, endDate);

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    // Scan followUps by createdAt in range using the new index from E1.
    const rows = await ctx.db
      .query("followUps")
      .withIndex("by_tenantId_and_createdAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("createdAt", startDate)
          .lt("createdAt", endDate),
      )
      .take(MAX_FOLLOWUPS_SCAN);

    const isTruncated = rows.length >= MAX_FOLLOWUPS_SCAN;
    // Filter to manual_reminder only — scheduling_link rows are a separate flow.
    const manualReminders = rows.filter((r) => r.type === "manual_reminder");

    // === Funnel counts ===
    const totalCreated = manualReminders.length;
    let totalCompleted = 0;
    const outcomeMix = emptyOutcomeMix();

    // === Per-closer bucket ===
    const perCloser = new Map<Id<"users">, PerCloserBucket>();

    // === Chain-length accumulator ===
    // A "chain" = the number of manual_reminder rows in the range for a given opportunityId.
    // This is a within-range approximation — a reminder that rescheduled before the range
    // end but its follow-up was created after the range end isn't counted. Documented
    // trade-off; at current volume the approximation is within 2% for a 30-day window.
    const chainByOpp = new Map<Id<"opportunities">, number>();

    for (const r of manualReminders) {
      // Per-closer bucket initialization
      const key = r.closerId;
      const bucket = perCloser.get(key) ?? emptyPerCloserBucket();
      bucket.created++;

      if (r.status === "completed") {
        totalCompleted++;
        bucket.completed++;
        if (r.completionOutcome && COMPLETION_OUTCOMES.includes(r.completionOutcome)) {
          outcomeMix[r.completionOutcome]++;
          bucket[r.completionOutcome]++;
        }
        // Reminders completed with undefined completionOutcome are legacy rows from pre-v0.6.
        // They count toward `totalCompleted` but not to any outcome bucket — the chart renders
        // a "Unclassified" hint in the UI via the delta between completed and sum of mix.
      }
      perCloser.set(key, bucket);

      // Chain length
      const prev = chainByOpp.get(r.opportunityId) ?? 0;
      chainByOpp.set(r.opportunityId, prev + 1);
    }

    // === Build chain histogram ===
    const chainLengthHistogram: Record<ChainBucket, number> = {
      "1": 0, "2": 0, "3": 0, "4": 0, "5+": 0,
    };
    for (const count of chainByOpp.values()) {
      chainLengthHistogram[bucketChainLength(count)]++;
    }

    // === Hydrate closer names ===
    const activeClosers = await getActiveClosers(ctx, tenantId);
    const closerMap = new Map<Id<"users">, Doc<"users">>();
    for (const c of activeClosers) closerMap.set(c._id, c);

    const perCloserArray = Array.from(perCloser.entries()).map(([userId, bucket]) => {
      const user = closerMap.get(userId);
      // Handles the "closer was deactivated mid-range" case: fall back to direct user lookup.
      return {
        closerId: userId,
        closerName: user ? getUserDisplayName(user) : null,
        ...bucket,
        completionRate: bucket.created > 0 ? bucket.completed / bucket.created : null,
      };
    });
    // Hydrate any missing closers via direct lookup (not in active list but in reminder set).
    await Promise.all(
      perCloserArray.map(async (row) => {
        if (row.closerName === null) {
          const user = await ctx.db.get(row.closerId);
          row.closerName = user ? getUserDisplayName(user) : "Removed closer";
        }
      }),
    );

    perCloserArray.sort((a, b) => b.created - a.created);

    return {
      totalCreated,
      totalCompleted,
      completionRate: totalCreated > 0 ? totalCompleted / totalCreated : null,
      outcomeMix,
      perCloser: perCloserArray,
      chainLengthHistogram,
      isTruncated,
    };
  },
});
```

**Key implementation notes:**
- **Only `manual_reminder` type is counted** — `scheduling_link` type follow-ups are a distinct workflow (no completion outcome field). Filter after the `withIndex` scan.
- **Chain approximation:** chains that span across the date range boundary are under-counted on the low side (edges). Documented at query-level and ok at current volume. If needed later, compute chains from a wider scan and filter to opportunities with at least one reminder in range — not v0.6b.
- **Completed without `completionOutcome`:** old rows may exist. Keep them in `totalCompleted` (they were completed, after all) but don't bucket them. The UI can derive `unclassifiedCompleted = totalCompleted - sum(outcomeMix)` if it wants to surface the gap.
- **Deactivated-closer fallback:** `getActiveClosers` returns only active closers. A reminder created by a now-deactivated closer would have `closerName === null`. Fallback pattern: direct `ctx.db.get` per row with missing name — bounded to the count of distinct closers in the reminder set (small).
- **Sort order:** `perCloser` is sorted descending by `created` so admin "who's running the most reminders" reads correctly.
- **Do not** filter by `status === "completed"` at the index level — we need rows in both states (counted as "created" regardless).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/remindersReporting.ts` | Create | Funnel query — filters manual_reminder type only |

---

### E3 — Route Shell, Page, Skeleton

**Type:** Frontend (new route tree)
**Parallelizable:** Yes — all new files. Independent of E1/E2/E4/E5.

**What:** Create the three-layer Next.js page + skeleton + page-client shell. Subscribes to `getReminderOutcomeFunnel` and renders section placeholders that E4/E5 fill.

**Where:**
- `app/workspace/reports/reminders/page.tsx` (new)
- `app/workspace/reports/reminders/loading.tsx` (new)
- `app/workspace/reports/reminders/_components/reminders-report-page-client.tsx` (new)
- `app/workspace/reports/reminders/_components/reminders-report-skeleton.tsx` (new)

**How:**

**Step 1: Thin RSC page.**

```tsx
// Path: app/workspace/reports/reminders/page.tsx

import { RemindersReportPageClient } from "./_components/reminders-report-page-client";

export const unstable_instant = false;

export default function RemindersReportPage() {
  return <RemindersReportPageClient />;
}
```

**Step 2: Route-level skeleton.**

```tsx
// Path: app/workspace/reports/reminders/loading.tsx

import { RemindersReportSkeleton } from "./_components/reminders-report-skeleton";

export default function RemindersReportLoading() {
  return <RemindersReportSkeleton />;
}
```

**Step 3: Client shell.**

```tsx
// Path: app/workspace/reports/reminders/_components/reminders-report-page-client.tsx
"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { ReportDateControls, type DateRange } from "../../_components/report-date-controls";
import { usePageTitle } from "@/hooks/use-page-title";

import { ReminderFunnelChart } from "./reminder-funnel-chart";
import { ReminderOutcomeCardGrid } from "./reminder-outcome-card-grid";
import { ReminderDrivenRevenueCard } from "./reminder-driven-revenue-card";
import { PerCloserReminderConversionTable } from "./per-closer-reminder-conversion-table";
import { ReminderChainLengthHistogram } from "./reminder-chain-length-histogram";
import { RemindersReportSkeleton } from "./reminders-report-skeleton";

function defaultDateRange(): DateRange {
  const now = new Date();
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + 1);
  const start = new Date(end);
  start.setDate(start.getDate() - 31);
  return { startDate: start.getTime(), endDate: end.getTime() };
}

export function RemindersReportPageClient() {
  usePageTitle("Reminders");
  const [dateRange, setDateRange] = useState<DateRange>(defaultDateRange);
  const data = useQuery(api.reporting.remindersReporting.getReminderOutcomeFunnel, dateRange);

  if (!data) return <RemindersReportSkeleton />;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Reminder Funnel</h1>
        <p className="text-sm text-muted-foreground">
          Manual-reminder lifecycle — creation, completion, and structured outcomes.
        </p>
      </header>

      <ReportDateControls value={dateRange} onChange={setDateRange} />

      {data.isTruncated && (
        <p className="rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm text-yellow-900 dark:border-yellow-900/50 dark:bg-yellow-950/30 dark:text-yellow-200">
          Only the first 2,000 follow-ups shown — narrow the date range for full data.
        </p>
      )}

      <ReminderFunnelChart
        totalCreated={data.totalCreated}
        totalCompleted={data.totalCompleted}
        completionRate={data.completionRate}
        outcomeMix={data.outcomeMix}
      />

      <ReminderOutcomeCardGrid
        outcomeMix={data.outcomeMix}
        totalCompleted={data.totalCompleted}
      />

      <ReminderDrivenRevenueCard />{/* Pending Phase G — see E5 */}

      <ReminderChainLengthHistogram histogram={data.chainLengthHistogram} />

      <PerCloserReminderConversionTable closers={data.perCloser} />
    </div>
  );
}
```

**Step 4: Skeleton.**

```tsx
// Path: app/workspace/reports/reminders/_components/reminders-report-skeleton.tsx

import { Skeleton } from "@/components/ui/skeleton";

export function RemindersReportSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading reminder funnel report">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
      </div>
      <Skeleton className="h-10 w-72" />
      <Skeleton className="h-60" />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-32" />
      <Skeleton className="h-60" />
      <Skeleton className="h-64" />
    </div>
  );
}
```

**Key implementation notes:**
- `usePageTitle("Reminders")` — matches the sidebar entry added in Phase H.
- Single `useQuery` subscription; all sections derive from `data`. Do not split across queries.
- Stub out the section components for C2-style parallel work.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/reminders/page.tsx` | Create | Thin RSC |
| `app/workspace/reports/reminders/loading.tsx` | Create | Skeleton route |
| `app/workspace/reports/reminders/_components/reminders-report-page-client.tsx` | Create | Client shell with 1 `useQuery` |
| `app/workspace/reports/reminders/_components/reminders-report-skeleton.tsx` | Create | Skeleton matching final layout |

---

### E4 — Funnel + Outcome Cards

**Type:** Frontend (new components)
**Parallelizable:** Depends on E2. Independent of E3/E5.

**What:** Two components:
- `ReminderFunnelChart` — visual funnel: `Created → Completed → Outcomes (5 buckets)`.
- `ReminderOutcomeCardGrid` — 5 small cards, one per outcome bucket.

**Where:**
- `app/workspace/reports/reminders/_components/reminder-funnel-chart.tsx` (new)
- `app/workspace/reports/reminders/_components/reminder-outcome-card-grid.tsx` (new)

**How:**

**Step 1: Funnel — three-stage render.**

```tsx
// Path: app/workspace/reports/reminders/_components/reminder-funnel-chart.tsx
"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowRightIcon } from "lucide-react";

type CompletionOutcome =
  | "payment_received"
  | "lost"
  | "no_response_rescheduled"
  | "no_response_given_up"
  | "no_response_close_only";

const OUTCOME_LABELS: Record<CompletionOutcome, string> = {
  payment_received: "Payment Received",
  lost: "Lost",
  no_response_rescheduled: "No Resp. → Rescheduled",
  no_response_given_up: "No Resp. → Given Up",
  no_response_close_only: "No Resp. → Close-Only",
};

const OUTCOME_COLORS: Record<CompletionOutcome, string> = {
  payment_received: "var(--chart-1)",
  lost: "var(--chart-2)",
  no_response_rescheduled: "var(--chart-3)",
  no_response_given_up: "var(--chart-4)",
  no_response_close_only: "var(--chart-5)",
};

interface ReminderFunnelChartProps {
  totalCreated: number;
  totalCompleted: number;
  completionRate: number | null;
  outcomeMix: Record<CompletionOutcome, number>;
}

export function ReminderFunnelChart({
  totalCreated,
  totalCompleted,
  completionRate,
  outcomeMix,
}: ReminderFunnelChartProps) {
  const unclassifiedCompleted = totalCompleted
    - (outcomeMix.payment_received
      + outcomeMix.lost
      + outcomeMix.no_response_rescheduled
      + outcomeMix.no_response_given_up
      + outcomeMix.no_response_close_only);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reminder Funnel</CardTitle>
        <CardDescription>
          Manual reminders flow from Created → Completed → Outcome. Unclassified completed reminders
          are legacy pre-v0.6 rows with no `completionOutcome`.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col items-stretch gap-4 md:flex-row md:items-center">
          {/* Created */}
          <div className="flex-1 rounded-md border bg-card p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Created</p>
            <p className="text-3xl font-bold tabular-nums">{totalCreated.toLocaleString()}</p>
          </div>
          <ArrowRightIcon className="hidden h-4 w-4 text-muted-foreground md:block" aria-hidden />

          {/* Completed */}
          <div className="flex-1 rounded-md border bg-card p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Completed ({completionRate === null ? "—" : `${(completionRate * 100).toFixed(1)}%`})
            </p>
            <p className="text-3xl font-bold tabular-nums">{totalCompleted.toLocaleString()}</p>
            {unclassifiedCompleted > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {unclassifiedCompleted} unclassified legacy row(s)
              </p>
            )}
          </div>
          <ArrowRightIcon className="hidden h-4 w-4 text-muted-foreground md:block" aria-hidden />

          {/* Outcomes */}
          <div className="flex-[2] rounded-md border bg-card p-4">
            <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Outcomes</p>
            <div className="flex flex-col gap-1 text-sm">
              {(Object.keys(OUTCOME_LABELS) as CompletionOutcome[]).map((key) => {
                const count = outcomeMix[key];
                const pct = totalCompleted > 0 ? ((count / totalCompleted) * 100).toFixed(1) : "0.0";
                return (
                  <div key={key} className="flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="inline-block h-3 w-3 rounded-full"
                        style={{ backgroundColor: OUTCOME_COLORS[key] }}
                      />
                      <span>{OUTCOME_LABELS[key]}</span>
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {count} ({pct}%)
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
```

**Step 2: Outcome card grid.**

```tsx
// Path: app/workspace/reports/reminders/_components/reminder-outcome-card-grid.tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DollarSignIcon,
  CircleXIcon,
  CalendarClockIcon,
  UserXIcon,
  PhoneCallIcon,
} from "lucide-react";

type CompletionOutcome =
  | "payment_received"
  | "lost"
  | "no_response_rescheduled"
  | "no_response_given_up"
  | "no_response_close_only";

const OUTCOME_META: Record<CompletionOutcome, { label: string; caption: string; icon: React.ComponentType<{ className?: string }> }> = {
  payment_received: { label: "Payment Received", caption: "Reminder converted to payment", icon: DollarSignIcon },
  lost: { label: "Lost", caption: "Closed-Lost after reminder", icon: CircleXIcon },
  no_response_rescheduled: { label: "No Resp. → Reschedule", caption: "Rescheduled after no reply", icon: CalendarClockIcon },
  no_response_given_up: { label: "No Resp. → Given Up", caption: "Abandoned after no reply", icon: UserXIcon },
  no_response_close_only: { label: "No Resp. → Close-Only", caption: "Closed without reschedule", icon: PhoneCallIcon },
};

interface Props {
  outcomeMix: Record<CompletionOutcome, number>;
  totalCompleted: number;
}

export function ReminderOutcomeCardGrid({ outcomeMix, totalCompleted }: Props) {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
      {(Object.keys(OUTCOME_META) as CompletionOutcome[]).map((key) => {
        const meta = OUTCOME_META[key];
        const count = outcomeMix[key];
        const pct = totalCompleted > 0 ? ((count / totalCompleted) * 100).toFixed(1) : "0.0";
        const Icon = meta.icon;
        return (
          <Card key={key} size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Icon className="h-3.5 w-3.5" />
                {meta.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-bold tabular-nums">{count}</div>
              <p className="text-xs text-muted-foreground">{pct}% of completed — {meta.caption}</p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
```

**Key implementation notes:**
- Funnel is a custom flex layout, not a recharts component — gives exact text/numeric control. Keeps mobile layout clean (stacks vertically with arrow icons hidden).
- `unclassifiedCompleted` is computed in the UI (not returned by the query) to keep the query response shape tight.
- Color swatches in the funnel use the same `OUTCOME_COLORS` map so the funnel ↔ card grid ↔ any future chart stay visually consistent.
- Card grid uses 5 columns on md+ (matches 5 outcomes); 2-col on mobile.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/reminders/_components/reminder-funnel-chart.tsx` | Create | 3-stage horizontal funnel |
| `app/workspace/reports/reminders/_components/reminder-outcome-card-grid.tsx` | Create | 5-card outcome grid |

---

### E5 — Per-Closer Table + Chain Histogram + Phase-G Placeholder

**Type:** Frontend (new components)
**Parallelizable:** Depends on E2. Independent of E3/E4.

**What:**
- `PerCloserReminderConversionTable` — sortable table: Closer, Created, Completed, Completion %, Payments.
- `ReminderChainLengthHistogram` — bar chart with fixed buckets `1 / 2 / 3 / 4 / 5+`.
- `ReminderDrivenRevenueCard` — placeholder card that switches on post-Phase-G to reading `data.reminderDrivenRevenueMinor`. For E5 we ship the placeholder only.

**Where:**
- `app/workspace/reports/reminders/_components/per-closer-reminder-conversion-table.tsx` (new)
- `app/workspace/reports/reminders/_components/reminder-chain-length-histogram.tsx` (new)
- `app/workspace/reports/reminders/_components/reminder-driven-revenue-card.tsx` (new)

**How:**

**Step 1: Per-closer conversion table.**

```tsx
// Path: app/workspace/reports/reminders/_components/per-closer-reminder-conversion-table.tsx
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
import { Button } from "@/components/ui/button";
import { ArrowUpDownIcon } from "lucide-react";

interface PerCloserRow {
  closerId: string;
  closerName: string | null;
  created: number;
  completed: number;
  completionRate: number | null;
  payment_received: number;
  lost: number;
  no_response_rescheduled: number;
  no_response_given_up: number;
  no_response_close_only: number;
}

function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

export function PerCloserReminderConversionTable({ closers }: { closers: PerCloserRow[] }) {
  const { sorted, sortKey, sortDir, toggleSort } = useTableSort(closers, "created", "desc");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Per-Closer Conversion</CardTitle>
        <CardDescription>
          Reminders created and completed by each closer in the selected range. Payments column
          counts reminder completions that flagged `payment_received`.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No reminders in range.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <Button variant="ghost" size="sm" className="h-auto p-0 font-medium" onClick={() => toggleSort("closerName")}>
                      Closer <ArrowUpDownIcon className="ml-1 h-3 w-3" />
                    </Button>
                  </TableHead>
                  <TableHead className="text-right">
                    <Button variant="ghost" size="sm" className="h-auto p-0 font-medium" onClick={() => toggleSort("created")}>
                      Created <ArrowUpDownIcon className="ml-1 h-3 w-3" />
                    </Button>
                  </TableHead>
                  <TableHead className="text-right">
                    <Button variant="ghost" size="sm" className="h-auto p-0 font-medium" onClick={() => toggleSort("completed")}>
                      Completed <ArrowUpDownIcon className="ml-1 h-3 w-3" />
                    </Button>
                  </TableHead>
                  <TableHead className="text-right">
                    <Button variant="ghost" size="sm" className="h-auto p-0 font-medium" onClick={() => toggleSort("completionRate")}>
                      Completion % <ArrowUpDownIcon className="ml-1 h-3 w-3" />
                    </Button>
                  </TableHead>
                  <TableHead className="text-right">
                    <Button variant="ghost" size="sm" className="h-auto p-0 font-medium" onClick={() => toggleSort("payment_received")}>
                      Payments <ArrowUpDownIcon className="ml-1 h-3 w-3" />
                    </Button>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((c) => (
                  <TableRow key={c.closerId}>
                    <TableCell>{c.closerName ?? "Removed closer"}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.created}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.completed}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatRate(c.completionRate)}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.payment_received}</TableCell>
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

**Step 2: Chain-length histogram.**

```tsx
// Path: app/workspace/reports/reminders/_components/reminder-chain-length-histogram.tsx
"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltipContent } from "@/components/ui/chart";

const CHAIN_ORDER = ["1", "2", "3", "4", "5+"] as const;

interface Props {
  histogram: Record<string, number>;
}

export function ReminderChainLengthHistogram({ histogram }: Props) {
  const data = CHAIN_ORDER.map((bucket) => ({
    bucket,
    count: histogram[bucket] ?? 0,
  }));
  const total = data.reduce((s, d) => s + d.count, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Chain Length Distribution</CardTitle>
        <CardDescription>
          How many manual reminders does each opportunity get? 1 = single reminder, 5+ = persistent chase.
          Chains that cross the date-range boundary are approximated.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No chain data in range.</p>
        ) : (
          <ChartContainer config={{ count: { label: "Opportunities", color: "var(--chart-1)" } }} className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 16 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="bucket"
                  tickLine={false}
                  axisLine={false}
                  label={{ value: "Reminders per opportunity", position: "insideBottom", offset: -4 }}
                />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
                <Tooltip content={<ChartTooltipContent />} />
                <Bar dataKey="count" fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
```

**Step 3: Phase-G placeholder card.**

```tsx
// Path: app/workspace/reports/reminders/_components/reminder-driven-revenue-card.tsx
"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LockIcon } from "lucide-react";

/**
 * Placeholder until Phase G (paymentRecords.origin) ships.
 * After Phase G:
 *   - Backend: `getReminderOutcomeFunnel` extends to return `reminderDrivenRevenueMinor`
 *     by joining paymentRecords with origin="closer_reminder" in the same date range.
 *   - Frontend: this card accepts `amountMinor` prop and renders currency + count.
 * That upgrade is Phase G's reporting-consumer step, not Phase E.
 */
export function ReminderDrivenRevenueCard() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>Reminder-Driven Revenue</CardTitle>
          <Badge variant="secondary" className="ml-auto bg-muted text-muted-foreground">
            <LockIcon className="mr-1 h-3 w-3" />
            Pending Phase G
          </Badge>
        </div>
        <CardDescription>
          Tracking reminder-originated payments requires durable `origin` on `paymentRecords`.
          See `plans/v0.6b/phases/phaseG.md` — this card switches on automatically once Phase G
          backfill completes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-lg italic text-muted-foreground">—</div>
      </CardContent>
    </Card>
  );
}
```

**Key implementation notes:**
- The placeholder card's empty state is intentional — seeing "—" with an explanation is a stronger UX signal than hiding the card (which would silently imply "no data" rather than "pending feature").
- When Phase G lands and the reporting-consumer step extends `getReminderOutcomeFunnel` to include `reminderDrivenRevenueMinor`, the placeholder is **replaced** — not modified — with a real card. That's why this component is isolated to its own file.
- `CHAIN_ORDER` is a const tuple for stable x-axis ordering (same pattern as Phase C histograms).
- The per-closer table's "Payments" column is `payment_received` directly — shorter, clearer, and useful before Phase G ships reminder-driven revenue.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/reminders/_components/per-closer-reminder-conversion-table.tsx` | Create | Sortable 5-column table |
| `app/workspace/reports/reminders/_components/reminder-chain-length-histogram.tsx` | Create | Bar chart with fixed 5 buckets |
| `app/workspace/reports/reminders/_components/reminder-driven-revenue-card.tsx` | Create | Phase-G placeholder |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modify | E1 |
| `convex/reporting/remindersReporting.ts` | Create | E2 |
| `app/workspace/reports/reminders/page.tsx` | Create | E3 |
| `app/workspace/reports/reminders/loading.tsx` | Create | E3 |
| `app/workspace/reports/reminders/_components/reminders-report-page-client.tsx` | Create | E3 |
| `app/workspace/reports/reminders/_components/reminders-report-skeleton.tsx` | Create | E3 |
| `app/workspace/reports/reminders/_components/reminder-funnel-chart.tsx` | Create | E4 |
| `app/workspace/reports/reminders/_components/reminder-outcome-card-grid.tsx` | Create | E4 |
| `app/workspace/reports/reminders/_components/per-closer-reminder-conversion-table.tsx` | Create | E5 |
| `app/workspace/reports/reminders/_components/reminder-chain-length-histogram.tsx` | Create | E5 |
| `app/workspace/reports/reminders/_components/reminder-driven-revenue-card.tsx` | Create | E5 |

**Blast radius:**
- **Backend:** 1 schema modify (1 index), 1 new query file. No existing query changed.
- **Frontend:** 9 new files under `/workspace/reports/reminders/`. Zero modifications outside the new tree.
- **Sidebar:** adds one nav entry (`/workspace/reports/reminders`) in Phase H.
- **Phase G coupling:** `ReminderDrivenRevenueCard` is a placeholder until Phase G backfill completes. Phase G's reporting-consumer step (Phase G, subphase G5) upgrades this card.

**Rollback plan:**
- **E1 rollback:** Remove index. Cannot revert while E2 is deployed — E2 references the index.
- **E2 rollback:** Delete query file. Page client shows permanent loading skeleton.
- **E3/E4/E5 rollback:** Delete the new route tree.
- Full rollback: revert `convex/schema.ts` + delete `convex/reporting/remindersReporting.ts` + delete `app/workspace/reports/reminders/`.
