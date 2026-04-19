# Phase C — Meeting-Time Audit Report

**Goal:** Ship a new admin-only report at `/workspace/reports/meeting-time` that reads every time-tracking field the product writes today (`startedAt`, `stoppedAt`, `startedAtSource`, `stoppedAtSource`, `lateStartDurationMs`, `exceededScheduledDurationMs`, `noShowSource`, `fathomLink`) and renders aggregate KPIs, source-split visualisations, two histograms (late-start, overrun), and a Fathom-compliance panel. Read-side only — no schema change, no new writes.

**Prerequisite:** None. All backing fields are already populated in production. Phase C ships independently of every other v0.6b phase.

**Runs in PARALLEL with:** Phase A, Phase B, Phase D, Phase E, Phase F, Phase G, Phase H. Touches only new files under `convex/reporting/` and a new route tree under `app/workspace/reports/meeting-time/` — zero file overlap with any other phase.

**Skills to invoke:**
- `convex-performance-audit` — new query is a bounded scan; verify read budget after shipping.
- `shadcn` — `Card`, `Table`, `Chart` primitives + new bar chart for source split and histograms.
- `frontend-design` — visual hierarchy across 8 KPI cards, 3 source-split breakdowns, 2 histograms, 1 Fathom panel.
- `web-design-guidelines` — chart legends must be keyboard-navigable; aria-labels on bucketed histograms; color-blind-safe palette from `--chart-*` tokens.
- `next-best-practices` — three-layer page pattern (page.tsx thin RSC → `*-page-client.tsx` client component → auth in layout).

**Acceptance Criteria:**
1. `/workspace/reports/meeting-time` is mounted and gated by `requireRole(["tenant_master","tenant_admin"])` (Phase H swaps this to `reports:view`).
2. Navigating to the route as a `closer` redirects to `/workspace/closer` (inherits existing layout gate).
3. Navigating to the route as an unauthenticated user redirects to `/sign-in`.
4. The page renders 8 summary KPI cards: **On-Time Start Rate, Avg Late Start, Overran Rate, Avg Overrun, Avg Actual Duration, Schedule Adherence, Manually Corrected Count, Fathom Compliance Rate**.
5. The page renders 3 source-split bar charts: **Start Source** (`closer` / `admin_manual` / `none`), **Stop Source** (`closer` / `closer_no_show` / `admin_manual` / `system` / `none`), **No-Show Source** (`closer` / `calendly_webhook` / `none`).
6. The page renders 2 histograms with fixed buckets `0 / 1-5 / 6-15 / 16-30 / 30+` (minutes): **Late-Start Histogram** and **Overrun Histogram**.
7. The Fathom Compliance panel explains the denominator ("Evidence required = completed + flagged meetings") and renders the percentage + raw counts.
8. Truncation banner displays when the scan hits the 2,000-meeting bound.
9. Empty state renders cleanly when no meetings match the selected range (no `NaN%`, no broken charts).
10. `axe-core` / WCAG AA audit passes on every section (manual QA — see `TESTING.MD`).
11. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
C1 (meetingTime.ts backend query — backend) ───────────────┐
                                                            │
                                                            ├── C3 (summary cards + source split — frontend; depends on C1)
                                                            │
C2 (route shell + page.tsx + layout auth — frontend) ──────┤── C4 (histograms — frontend; depends on C1)
                                                            │
                                                            └── C5 (Fathom compliance panel — frontend; depends on C1)
```

**Optimal execution:**
1. **Backend (sole):** C1 is the single backend subphase — start immediately.
2. **Frontend shell (parallel with backend):** C2 creates the route tree, layout, and skeleton. Can proceed with mock data until C1 lands.
3. **Frontend sections (parallel, after backend):** C3, C4, C5 each own different components. Fully parallelizable once C1 ships — each can be built by a different agent.

**Estimated time:** 2 days (solo); 1 day with backend + frontend parallel; ~0.75 day with 3 frontend agents + 1 backend.

---

## Subphases

### C1 — `meetingTime.ts`: Audit Query (NEW)

**Type:** Backend (new query, new file)
**Parallelizable:** Yes — new file; no conflicts.

**What:** Create `convex/reporting/meetingTime.ts` exporting `getMeetingTimeMetrics`. Single query returning an object with the 7 computed KPIs, 3 source-count objects, 2 histogram bucket objects, and the Fathom compliance rate.

**Why:** Meeting-time data is written at 4+ mutation sites but has zero reporting consumers today. The audit report's denominator contract is specific enough (evidence required = completed OR meeting_overran; actual duration = startedAt + stoppedAt both set) that hoisting derivations into the query avoids an explosion of per-chart math in React.

**Where:**
- `convex/reporting/meetingTime.ts` (new)

**How:**

**Step 1: Define types and constants.**

```typescript
// Path: convex/reporting/meetingTime.ts

import { v } from "convex/values";
import { query } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { requireTenantUser } from "../requireTenantUser";
import { assertValidDateRange } from "./lib/helpers";

const MAX_MEETINGS_SCAN = 2000;

/**
 * Histogram bucket keys (minutes). Aligned with v0.6 design — do not change
 * without updating the frontend chart's x-axis labels.
 */
const HISTOGRAM_BUCKETS = ["0", "1-5", "6-15", "16-30", "30+"] as const;
type HistogramBucket = (typeof HISTOGRAM_BUCKETS)[number];

type BucketCounts = Record<HistogramBucket, number>;

function emptyBuckets(): BucketCounts {
  return { "0": 0, "1-5": 0, "6-15": 0, "16-30": 0, "30+": 0 };
}

/**
 * Assigns a duration in milliseconds to its minute-based histogram bucket.
 * - `0` = strictly 0 ms (on time / no overrun)
 * - `1-5` = 1 to 5 minutes inclusive
 * - `6-15` = 6 to 15 minutes inclusive
 * - `16-30` = 16 to 30 minutes inclusive
 * - `30+` = anything over 30 minutes
 *
 * Inputs are truncated to integer minutes before bucketing (avoids off-by-59s boundary jitter).
 */
function bucketFor(durationMs: number): HistogramBucket {
  const minutes = Math.floor(durationMs / 60_000);
  if (minutes <= 0) return "0";
  if (minutes <= 5) return "1-5";
  if (minutes <= 15) return "6-15";
  if (minutes <= 30) return "16-30";
  return "30+";
}
```

**Step 2: Define the source-count shapes.**

```typescript
// Path: convex/reporting/meetingTime.ts

type StartedAtSource = "closer" | "admin_manual" | "none";
type StoppedAtSource = "closer" | "closer_no_show" | "admin_manual" | "system" | "none";
type NoShowSource = "closer" | "calendly_webhook" | "none";

type SourceCounts<K extends string> = Record<K, number>;

function emptyStartedSource(): SourceCounts<StartedAtSource> {
  return { closer: 0, admin_manual: 0, none: 0 };
}
function emptyStoppedSource(): SourceCounts<StoppedAtSource> {
  return { closer: 0, closer_no_show: 0, admin_manual: 0, system: 0, none: 0 };
}
function emptyNoShowSource(): SourceCounts<NoShowSource> {
  return { closer: 0, calendly_webhook: 0, none: 0 };
}
```

**Step 3: Define and export the query.**

```typescript
// Path: convex/reporting/meetingTime.ts

export const getMeetingTimeMetrics = query({
  args: { startDate: v.number(), endDate: v.number() },
  handler: async (ctx, { startDate, endDate }) => {
    assertValidDateRange(startDate, endDate);

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    // Scan meetings by scheduledAt in range. Bounded at 2,000 meetings.
    // Same bound as Phase B's meeting-time scan — shared policy.
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

    // Accumulators.
    let startedMeetingsCount = 0;
    let onTimeStartCount = 0;
    let lateStartCount = 0;
    let totalLateStartMs = 0;
    let completedWithDurationCount = 0;
    let overranCount = 0;
    let totalOverrunMs = 0;
    let totalActualDurationMs = 0;
    let scheduleAdherentCount = 0;
    let manuallyCorrectedCount = 0;

    const startedAtSource = emptyStartedSource();
    const stoppedAtSource = emptyStoppedSource();
    const noShowSource = emptyNoShowSource();
    const lateStartHistogram = emptyBuckets();
    const overrunHistogram = emptyBuckets();

    let evidenceRequired = 0;
    let evidenceProvided = 0;

    for (const m of meetings) {
      // === Start-time metrics ===
      if (m.startedAt !== undefined) {
        startedMeetingsCount++;
        const lateMs = m.lateStartDurationMs ?? 0;
        if (lateMs === 0) {
          onTimeStartCount++;
          lateStartHistogram["0"]++;
        } else {
          lateStartCount++;
          totalLateStartMs += lateMs;
          lateStartHistogram[bucketFor(lateMs)]++;
        }
      }

      // === Stop-time metrics (requires both startedAt + stoppedAt) ===
      if (m.startedAt !== undefined && m.stoppedAt !== undefined) {
        completedWithDurationCount++;
        const actualMs = m.stoppedAt - m.startedAt;
        totalActualDurationMs += actualMs;
        const overrunMs = m.exceededScheduledDurationMs ?? 0;
        if (overrunMs > 0) {
          overranCount++;
          totalOverrunMs += overrunMs;
          overrunHistogram[bucketFor(overrunMs)]++;
        } else {
          overrunHistogram["0"]++;
        }
        const lateMs = m.lateStartDurationMs ?? 0;
        if (lateMs === 0 && overrunMs === 0) scheduleAdherentCount++;
      }

      // === Source counts ===
      const startKey: StartedAtSource = m.startedAtSource ?? "none";
      startedAtSource[startKey]++;

      const stopKey: StoppedAtSource = m.stoppedAtSource ?? "none";
      stoppedAtSource[stopKey]++;

      const nsKey: NoShowSource = m.noShowSource ?? "none";
      noShowSource[nsKey]++;

      // === Manual corrections (union of start + stop) ===
      if (m.startedAtSource === "admin_manual" || m.stoppedAtSource === "admin_manual") {
        manuallyCorrectedCount++;
      }

      // === Fathom compliance ===
      // Evidence required = meetings in "completed" or "meeting_overran" status.
      if (m.status === "completed" || m.status === "meeting_overran") {
        evidenceRequired++;
        if (m.fathomLink) evidenceProvided++;
      }
    }

    return {
      totals: {
        startedMeetingsCount,
        onTimeStartCount,
        lateStartCount,
        completedWithDurationCount,
        overranCount,
        manuallyCorrectedCount,
        onTimeStartRate:
          startedMeetingsCount > 0 ? onTimeStartCount / startedMeetingsCount : null,
        avgLateStartMs:
          lateStartCount > 0 ? totalLateStartMs / lateStartCount : null,
        overranRate:
          completedWithDurationCount > 0
            ? overranCount / completedWithDurationCount
            : null,
        avgOverrunMs:
          overranCount > 0 ? totalOverrunMs / overranCount : null,
        avgActualDurationMs:
          completedWithDurationCount > 0
            ? totalActualDurationMs / completedWithDurationCount
            : null,
        scheduleAdherenceRate:
          completedWithDurationCount > 0
            ? scheduleAdherentCount / completedWithDurationCount
            : null,
      },
      startedAtSource,
      stoppedAtSource,
      noShowSource,
      lateStartHistogram,
      overrunHistogram,
      fathomCompliance: {
        required: evidenceRequired,
        provided: evidenceProvided,
        rate: evidenceRequired > 0 ? evidenceProvided / evidenceRequired : null,
      },
      isTruncated,
    };
  },
});
```

**Key implementation notes:**
- **Bucket semantics:** `0 ms` → bucket `"0"`. `1-5 min` means `(0, 5] min`. This matches the UI histogram x-axis labels. Changing either side requires updating the other.
- `noShowSource = "none"` implicitly covers every meeting whose `noShowSource` is `undefined` — i.e., *every* non-no-show meeting plus any pre-Feature-B no-show. The chart renders this honestly as the dominant bar; hiding the "none" bucket would be misleading. If stakeholders prefer, the frontend can filter out `none` before rendering — kept at query level for raw auditability.
- `scheduleAdherentCount` only counts meetings where **both** `startedAt` and `stoppedAt` are known. Not-yet-ended meetings are not in the denominator.
- `isTruncated` is `true` when `meetings.length >= MAX_MEETINGS_SCAN` (strict), matching Phase B's convention. UI shows a sticky banner.
- Fathom compliance denominator is explicit in the response (`required`) so the UI can always say `"{provided} of {required} have Fathom link"` rather than computing a rate from a 0-count set.
- **Do not** filter by `status === "completed"` during the `withIndex` scan — the status-specific index (`by_tenantId_and_status_and_scheduledAt`) would require separate scans per status and lose symmetry with Phase B. The post-scan filters are cheap at ≤ 2,000 rows.
- Type the source enum keys explicitly (`StartedAtSource`, `StoppedAtSource`, `NoShowSource`) so TypeScript will catch any schema expansion (e.g., a future `admin_api_import` source) at compile time.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/meetingTime.ts` | Create | Single query — 8 KPIs + 3 source counts + 2 histograms + Fathom panel |

---

### C2 — Route Shell, Layout, Skeleton (NEW)

**Type:** Frontend (new route tree)
**Parallelizable:** Yes — new route under `app/workspace/reports/meeting-time/`. Zero file overlap.

**What:** Create the three-layer Next.js page (`page.tsx` thin RSC, `_components/meeting-time-report-page-client.tsx` client component, `loading.tsx` route skeleton). Inherits auth from the parent `app/workspace/reports/layout.tsx`. Adds a skeleton under `_components/meeting-time-report-skeleton.tsx` that mirrors the final layout.

**Why:** AGENTS.md establishes the three-layer page pattern for every workspace page (server component page.tsx, client component page-client.tsx, layout auth gate). Shipping the shell first means C3/C4/C5 can build section-level components in isolation against the empty shell while C1 is in flight.

**Where:**
- `app/workspace/reports/meeting-time/page.tsx` (new)
- `app/workspace/reports/meeting-time/loading.tsx` (new)
- `app/workspace/reports/meeting-time/_components/meeting-time-report-page-client.tsx` (new)
- `app/workspace/reports/meeting-time/_components/meeting-time-report-skeleton.tsx` (new)

**How:**

**Step 1: The thin RSC page wrapper.**

```tsx
// Path: app/workspace/reports/meeting-time/page.tsx

import { MeetingTimeReportPageClient } from "./_components/meeting-time-report-page-client";

export const unstable_instant = false;

export default function MeetingTimeReportPage() {
  return <MeetingTimeReportPageClient />;
}
```

**Step 2: Route-level loading skeleton.**

```tsx
// Path: app/workspace/reports/meeting-time/loading.tsx

import { MeetingTimeReportSkeleton } from "./_components/meeting-time-report-skeleton";

export default function MeetingTimeReportLoading() {
  return <MeetingTimeReportSkeleton />;
}
```

**Step 3: The client-component shell.**

```tsx
// Path: app/workspace/reports/meeting-time/_components/meeting-time-report-page-client.tsx
"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { ReportDateControls, type DateRange } from "../../_components/report-date-controls";
import { MeetingTimeSummaryCards } from "./meeting-time-summary-cards";
import { SourceSplitPanel } from "./source-split-panel";
import { LateStartHistogram } from "./late-start-histogram";
import { OverrunHistogram } from "./overrun-histogram";
import { FathomCompliancePanel } from "./fathom-compliance-panel";
import { MeetingTimeReportSkeleton } from "./meeting-time-report-skeleton";
import { usePageTitle } from "@/hooks/use-page-title";

/**
 * Default range: last 30 days (inclusive of today), interpreted in UTC.
 * `report-date-controls` accepts millis and treats endDate as exclusive upper.
 */
function defaultDateRange(): DateRange {
  const now = new Date();
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + 1); // tomorrow midnight → exclusive upper
  const start = new Date(end);
  start.setDate(start.getDate() - 31); // 30 days before tomorrow → 30 full days of data
  return { startDate: start.getTime(), endDate: end.getTime() };
}

export function MeetingTimeReportPageClient() {
  usePageTitle("Meeting Time Audit");
  const [dateRange, setDateRange] = useState<DateRange>(defaultDateRange);

  const data = useQuery(api.reporting.meetingTime.getMeetingTimeMetrics, dateRange);

  if (!data) return <MeetingTimeReportSkeleton />;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Meeting Time Audit</h1>
        <p className="text-sm text-muted-foreground">
          Attendance evidence, start/stop accuracy, late-start + overrun distribution, and Fathom compliance.
        </p>
      </header>

      <ReportDateControls value={dateRange} onChange={setDateRange} />

      {data.isTruncated && (
        <p className="rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm text-yellow-900 dark:border-yellow-900/50 dark:bg-yellow-950/30 dark:text-yellow-200">
          Only the first 2,000 meetings in this range are included. Narrow the date range for full data.
        </p>
      )}

      <MeetingTimeSummaryCards totals={data.totals} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <LateStartHistogram buckets={data.lateStartHistogram} />
        <OverrunHistogram buckets={data.overrunHistogram} />
      </div>

      <SourceSplitPanel
        startedAtSource={data.startedAtSource}
        stoppedAtSource={data.stoppedAtSource}
        noShowSource={data.noShowSource}
      />

      <FathomCompliancePanel compliance={data.fathomCompliance} />
    </div>
  );
}
```

**Step 4: Skeleton component.**

```tsx
// Path: app/workspace/reports/meeting-time/_components/meeting-time-report-skeleton.tsx

import { Skeleton } from "@/components/ui/skeleton";

export function MeetingTimeReportSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading meeting time audit">
      {/* Header skeleton */}
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
      </div>
      {/* Date controls skeleton */}
      <Skeleton className="h-10 w-72" />
      {/* Cards grid */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-8">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      {/* Histograms */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
      {/* Source splits */}
      <Skeleton className="h-60" />
      {/* Fathom compliance */}
      <Skeleton className="h-36" />
    </div>
  );
}
```

**Key implementation notes:**
- `unstable_instant = false` — matches the PPR-ready architecture in AGENTS.md (§ RSC Architecture).
- Route inherits auth from `app/workspace/reports/layout.tsx` — nothing to add at the page level. Phase H will upgrade the layout check from `requireRole` to `requireWorkspaceUser()` + `hasPermission(access.crmUser.role, "reports:view")`; that change has no effect on the new route beyond the rest of `/workspace/reports/*`.
- `usePageTitle` hook (from `hooks/use-page-title`) sets the document title and restores on unmount.
- The client component imports each section component by filename — during C2, those files may not exist yet. **Create stub components** (`export function LateStartHistogram() { return null; }`) in C2 so TypeScript compiles, then fill them in C3/C4/C5. Alternative: comment out the imports during C2.
- Skeleton uses `Skeleton` from `components/ui/skeleton`. `role="status"` + `aria-label` makes it SR-friendly.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/meeting-time/page.tsx` | Create | Thin RSC wrapper |
| `app/workspace/reports/meeting-time/loading.tsx` | Create | Route-level skeleton |
| `app/workspace/reports/meeting-time/_components/meeting-time-report-page-client.tsx` | Create | Client shell with one `useQuery` subscription |
| `app/workspace/reports/meeting-time/_components/meeting-time-report-skeleton.tsx` | Create | Matches final layout dimensions |

---

### C3 — Summary Cards + Source-Split Panel (Frontend)

**Type:** Frontend (new components)
**Parallelizable:** Yes — depends only on C1 (response shape) and C2 (shell imports). Independent of C4/C5.

**What:** (a) `MeetingTimeSummaryCards` — 8-card grid rendering KPIs from `data.totals`. (b) `SourceSplitPanel` — three side-by-side bar charts rendering `startedAtSource`, `stoppedAtSource`, `noShowSource`.

**Why:** The summary-card grid is the top-of-page first paint — primary KPIs. The source-split panel surfaces the three-enum breakdown that today is invisible to admins and is the main audit signal for whether manual corrections are being used.

**Where:**
- `app/workspace/reports/meeting-time/_components/meeting-time-summary-cards.tsx` (new)
- `app/workspace/reports/meeting-time/_components/source-split-panel.tsx` (new)
- `app/workspace/reports/meeting-time/_components/source-split-chart.tsx` (new — reusable bar chart for a single source dimension)

**How:**

**Step 1: Summary cards.**

```tsx
// Path: app/workspace/reports/meeting-time/_components/meeting-time-summary-cards.tsx
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
  VideoIcon,
} from "lucide-react";

interface MeetingTimeSummaryCardsProps {
  totals: {
    startedMeetingsCount: number;
    onTimeStartCount: number;
    lateStartCount: number;
    completedWithDurationCount: number;
    overranCount: number;
    manuallyCorrectedCount: number;
    onTimeStartRate: number | null;
    avgLateStartMs: number | null;
    overranRate: number | null;
    avgOverrunMs: number | null;
    avgActualDurationMs: number | null;
    scheduleAdherenceRate: number | null;
  };
  fathomComplianceRate?: number | null; // passed via parent, sourced from fathomCompliance.rate
}

function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}
function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  const totalSec = Math.round(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export function MeetingTimeSummaryCards({
  totals,
  fathomComplianceRate,
}: MeetingTimeSummaryCardsProps) {
  const cards = [
    { icon: ClockIcon, label: "On-Time Start Rate", value: formatRate(totals.onTimeStartRate),
      caption: `${totals.onTimeStartCount} of ${totals.startedMeetingsCount}` },
    { icon: TimerIcon, label: "Avg Late Start", value: formatMs(totals.avgLateStartMs),
      caption: "When late" },
    { icon: TimerOffIcon, label: "Overran Rate", value: formatRate(totals.overranRate),
      caption: `${totals.overranCount} of ${totals.completedWithDurationCount}` },
    { icon: GaugeIcon, label: "Avg Overrun", value: formatMs(totals.avgOverrunMs),
      caption: "When overran" },
    { icon: CalendarClockIcon, label: "Avg Actual Duration", value: formatMs(totals.avgActualDurationMs),
      caption: "Completed meetings" },
    { icon: SlidersHorizontalIcon, label: "Schedule Adherence", value: formatRate(totals.scheduleAdherenceRate),
      caption: "On time AND not overran" },
    { icon: WrenchIcon, label: "Manually Corrected", value: String(totals.manuallyCorrectedCount),
      caption: "Admin-entered times" },
    { icon: VideoIcon, label: "Fathom Compliance", value: formatRate(fathomComplianceRate ?? null),
      caption: "Of evidence-required meetings" },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-8">
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
  );
}
```

Pass `fathomComplianceRate` from the parent:

```tsx
// In meeting-time-report-page-client.tsx:
<MeetingTimeSummaryCards
  totals={data.totals}
  fathomComplianceRate={data.fathomCompliance.rate}
/>
```

**Step 2: Reusable source-split bar chart.**

```tsx
// Path: app/workspace/reports/meeting-time/_components/source-split-chart.tsx
"use client";

import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis, Tooltip } from "recharts";
import { ChartContainer, ChartTooltipContent } from "@/components/ui/chart";

interface SourceSplitChartProps {
  title: string;
  counts: Record<string, number>;
  labels: Record<string, string>;
  colorVariables: Record<string, string>; // e.g., { closer: "var(--chart-1)", admin_manual: "var(--chart-2)" }
}

export function SourceSplitChart({
  title,
  counts,
  labels,
  colorVariables,
}: SourceSplitChartProps) {
  const data = Object.keys(counts).map((key) => ({
    key,
    label: labels[key] ?? key,
    value: counts[key],
    fill: colorVariables[key] ?? "var(--muted-foreground)",
  }));
  const total = data.reduce((s, d) => s + d.value, 0);

  return (
    <div>
      <h3 className="mb-2 text-sm font-medium text-muted-foreground">{title}</h3>
      {total === 0 ? (
        <p className="text-xs text-muted-foreground">No data in range.</p>
      ) : (
        <ChartContainer
          config={Object.fromEntries(
            data.map((d) => [d.key, { label: d.label, color: d.fill }]),
          )}
          className="h-40"
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical">
              <XAxis type="number" hide />
              <YAxis
                type="category"
                dataKey="label"
                width={110}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip content={<ChartTooltipContent />} />
              <Bar dataKey="value" />
            </BarChart>
          </ResponsiveContainer>
        </ChartContainer>
      )}
    </div>
  );
}
```

**Step 3: Compose into `SourceSplitPanel`.**

```tsx
// Path: app/workspace/reports/meeting-time/_components/source-split-panel.tsx
"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SourceSplitChart } from "./source-split-chart";

interface SourceSplitPanelProps {
  startedAtSource: Record<string, number>;
  stoppedAtSource: Record<string, number>;
  noShowSource: Record<string, number>;
}

export function SourceSplitPanel({
  startedAtSource,
  stoppedAtSource,
  noShowSource,
}: SourceSplitPanelProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Source Split</CardTitle>
        <CardDescription>
          Where did start, stop, and no-show timestamps come from? Admin-manual entries are the
          primary signal for how much manual correction the team does.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          <SourceSplitChart
            title="Start Source"
            counts={startedAtSource}
            labels={{ closer: "Closer", admin_manual: "Admin Manual", none: "Unset" }}
            colorVariables={{
              closer: "var(--chart-1)",
              admin_manual: "var(--chart-2)",
              none: "var(--muted-foreground)",
            }}
          />
          <SourceSplitChart
            title="Stop Source"
            counts={stoppedAtSource}
            labels={{
              closer: "Closer",
              closer_no_show: "Closer (no-show)",
              admin_manual: "Admin Manual",
              system: "System",
              none: "Unset",
            }}
            colorVariables={{
              closer: "var(--chart-1)",
              closer_no_show: "var(--chart-3)",
              admin_manual: "var(--chart-2)",
              system: "var(--chart-4)",
              none: "var(--muted-foreground)",
            }}
          />
          <SourceSplitChart
            title="No-Show Source"
            counts={noShowSource}
            labels={{
              closer: "Closer",
              calendly_webhook: "Calendly Webhook",
              none: "Not a no-show",
            }}
            colorVariables={{
              closer: "var(--chart-1)",
              calendly_webhook: "var(--chart-5)",
              none: "var(--muted-foreground)",
            }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
```

**Key implementation notes:**
- `SourceSplitChart` is deliberately generic (takes `counts`, `labels`, `colorVariables`) because the three dimensions have different enum vocabularies. A single shared component keeps the chart layout pixel-consistent.
- Vertical bar layout (`layout="vertical"`) lets long labels like "Calendly Webhook" render without truncation.
- `none` bucket uses `--muted-foreground` — signals "not applicable" visually.
- If a dimension has no data in the range, render a small muted empty state — don't draw an empty chart.
- The color mapping is stable across re-renders because keys are constants.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/meeting-time/_components/meeting-time-summary-cards.tsx` | Create | 8 KPI cards |
| `app/workspace/reports/meeting-time/_components/source-split-chart.tsx` | Create | Reusable vertical bar chart |
| `app/workspace/reports/meeting-time/_components/source-split-panel.tsx` | Create | Wraps 3 `SourceSplitChart` instances |

---

### C4 — Histograms (Late-Start + Overrun)

**Type:** Frontend (new components)
**Parallelizable:** Yes — depends on C1 + C2. Independent of C3/C5.

**What:** Two bar-chart histograms sharing layout and bucket keys. `LateStartHistogram` reads `data.lateStartHistogram`; `OverrunHistogram` reads `data.overrunHistogram`. Both use the fixed bucket set `0 / 1-5 / 6-15 / 16-30 / 30+` (minutes).

**Why:** Summary KPIs compress each distribution to a single average. The histograms reveal shape — e.g., "mostly on time but a long tail of 30+ overruns" vs "broadly distributed late starts." Essential for audit-style use.

**Where:**
- `app/workspace/reports/meeting-time/_components/histogram-chart.tsx` (new — reusable)
- `app/workspace/reports/meeting-time/_components/late-start-histogram.tsx` (new)
- `app/workspace/reports/meeting-time/_components/overrun-histogram.tsx` (new)

**How:**

**Step 1: Reusable histogram chart.**

```tsx
// Path: app/workspace/reports/meeting-time/_components/histogram-chart.tsx
"use client";

import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { ChartContainer, ChartTooltipContent } from "@/components/ui/chart";

const BUCKET_ORDER = ["0", "1-5", "6-15", "16-30", "30+"] as const;

interface HistogramChartProps {
  buckets: Record<string, number>;
  xAxisLabel?: string;
  color: string; // CSS var or hex
}

export function HistogramChart({ buckets, xAxisLabel, color }: HistogramChartProps) {
  const data = BUCKET_ORDER.map((bucket) => ({
    bucket,
    count: buckets[bucket] ?? 0,
  }));
  const total = data.reduce((s, d) => s + d.count, 0);

  if (total === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No data in range.</p>;
  }

  return (
    <ChartContainer
      config={{ count: { label: "Meetings", color } }}
      className="h-56"
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 16 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey="bucket"
            tickLine={false}
            axisLine={false}
            label={xAxisLabel ? { value: xAxisLabel, position: "insideBottom", offset: -4 } : undefined}
          />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
          <Tooltip content={<ChartTooltipContent />} />
          <Bar dataKey="count" fill={color} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartContainer>
  );
}
```

**Step 2: Two thin wrappers.**

```tsx
// Path: app/workspace/reports/meeting-time/_components/late-start-histogram.tsx
"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { HistogramChart } from "./histogram-chart";

export function LateStartHistogram({ buckets }: { buckets: Record<string, number> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Late Start Distribution</CardTitle>
        <CardDescription>
          Minutes past scheduled start. `0` = on time. Includes only meetings with a recorded `startedAt`.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <HistogramChart buckets={buckets} xAxisLabel="Minutes late" color="var(--chart-3)" />
      </CardContent>
    </Card>
  );
}
```

```tsx
// Path: app/workspace/reports/meeting-time/_components/overrun-histogram.tsx
"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { HistogramChart } from "./histogram-chart";

export function OverrunHistogram({ buckets }: { buckets: Record<string, number> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Overrun Distribution</CardTitle>
        <CardDescription>
          Minutes past scheduled duration. `0` = ended on or before scheduled end. Includes only meetings with recorded start + stop.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <HistogramChart buckets={buckets} xAxisLabel="Minutes over" color="var(--chart-2)" />
      </CardContent>
    </Card>
  );
}
```

**Key implementation notes:**
- `BUCKET_ORDER` is a const tuple, **not** derived from `Object.keys(buckets)`. Object key iteration in recharts would yield alphabetical order and ruin the x-axis.
- `allowDecimals={false}` on `YAxis` — meetings are integers.
- Radius `[4, 4, 0, 0]` gives top-rounded bars — matches the visual treatment of other charts in the app.
- Color variable differs per histogram so they're visually distinguishable when placed side by side.
- Empty state is inside `HistogramChart` (not in the wrapper cards) so the reusable chart handles it uniformly.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/meeting-time/_components/histogram-chart.tsx` | Create | Reusable bar chart with fixed 5-bucket x-axis |
| `app/workspace/reports/meeting-time/_components/late-start-histogram.tsx` | Create | Card-wrapped LateStartHistogram |
| `app/workspace/reports/meeting-time/_components/overrun-histogram.tsx` | Create | Card-wrapped OverrunHistogram |

---

### C5 — Fathom Compliance Panel

**Type:** Frontend (new component)
**Parallelizable:** Yes — depends on C1 + C2. Independent of C3/C4.

**What:** A full-width card showing Fathom compliance rate + counts + a short explanation of the denominator. Includes a small visual indicator (color-coded badge) based on compliance threshold.

**Why:** Fathom evidence is policy-critical — recordings are the ground truth for disputed meetings. Surfacing compliance separately (rather than burying it as one of 8 summary cards) is aligned with the design's intent to make audit surfaces first-class.

**Where:**
- `app/workspace/reports/meeting-time/_components/fathom-compliance-panel.tsx` (new)

**How:**

**Step 1: The panel.**

```tsx
// Path: app/workspace/reports/meeting-time/_components/fathom-compliance-panel.tsx
"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { VideoIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface FathomCompliancePanelProps {
  compliance: {
    required: number;
    provided: number;
    rate: number | null;
  };
}

// Thresholds are informational only. Tune here if the org adopts a formal SLA.
function thresholdTone(rate: number | null): { label: string; tone: string } {
  if (rate === null) return { label: "No data", tone: "bg-muted text-muted-foreground" };
  if (rate >= 0.9) return { label: "On policy", tone: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200" };
  if (rate >= 0.7) return { label: "Acceptable", tone: "bg-yellow-100 text-yellow-900 dark:bg-yellow-900/30 dark:text-yellow-200" };
  return { label: "Below target", tone: "bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-200" };
}

export function FathomCompliancePanel({ compliance }: FathomCompliancePanelProps) {
  const { required, provided, rate } = compliance;
  const pct = rate !== null ? Math.round(rate * 100) : 0;
  const threshold = thresholdTone(rate);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <VideoIcon className="h-4 w-4 text-muted-foreground" />
          <CardTitle>Fathom Compliance</CardTitle>
          <Badge className={cn("ml-auto", threshold.tone)}>{threshold.label}</Badge>
        </div>
        <CardDescription>
          Evidence required = meetings with status <code>completed</code> or <code>meeting_overran</code>.
          Evidence provided = meetings with a saved Fathom recording link at the time of this audit.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-end gap-4">
          <div>
            <div className="text-3xl font-bold tabular-nums">
              {rate !== null ? `${(rate * 100).toFixed(1)}%` : "—"}
            </div>
            <p className="text-xs text-muted-foreground">
              {provided} of {required} meetings have Fathom link
            </p>
          </div>
        </div>
        <Progress value={pct} aria-label={`Fathom compliance ${pct}%`} />
      </CardContent>
    </Card>
  );
}
```

**Key implementation notes:**
- Thresholds (90% / 70%) are informational. If the org later formalizes an SLA, parameterize via prop.
- `Progress` from `components/ui/progress.tsx` — shadcn primitive — provides accessible announcement + visual bar.
- When `required === 0`, render "—" for the rate and a neutral badge. Don't render a progress bar at 0% — it looks like poor performance; empty state is clearer.
- `aria-label` on `Progress` reads the numeric percentage for screen readers.
- Card width is full-row (no `grid` wrapper in the parent) — Fathom is a major policy metric, not a tiny stat.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/meeting-time/_components/fathom-compliance-panel.tsx` | Create | Progress + threshold badge + denominator explanation |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/reporting/meetingTime.ts` | Create | C1 |
| `app/workspace/reports/meeting-time/page.tsx` | Create | C2 |
| `app/workspace/reports/meeting-time/loading.tsx` | Create | C2 |
| `app/workspace/reports/meeting-time/_components/meeting-time-report-page-client.tsx` | Create | C2 |
| `app/workspace/reports/meeting-time/_components/meeting-time-report-skeleton.tsx` | Create | C2 |
| `app/workspace/reports/meeting-time/_components/meeting-time-summary-cards.tsx` | Create | C3 |
| `app/workspace/reports/meeting-time/_components/source-split-chart.tsx` | Create | C3 |
| `app/workspace/reports/meeting-time/_components/source-split-panel.tsx` | Create | C3 |
| `app/workspace/reports/meeting-time/_components/histogram-chart.tsx` | Create | C4 |
| `app/workspace/reports/meeting-time/_components/late-start-histogram.tsx` | Create | C4 |
| `app/workspace/reports/meeting-time/_components/overrun-histogram.tsx` | Create | C4 |
| `app/workspace/reports/meeting-time/_components/fathom-compliance-panel.tsx` | Create | C5 |

**Blast radius:**
- **Backend:** 1 new file. Does not touch any existing Convex function.
- **Frontend:** 11 new files, all under the new `/workspace/reports/meeting-time/` route. Zero file modifications outside the new tree.
- **Schema:** None.
- **Sidebar:** A new nav entry (link to `/workspace/reports/meeting-time`) is owned by Phase H — kept out of C2 so the three nav-only additions land together.
- **Existing `getTeamPerformanceMetrics`:** Phase B extends it with a `meetingTime` block. Phase C does **not** consume that block (has its own, richer query). If both merge, the team page surfaces the same 7 KPIs as a compressed strip and the meeting-time report is the deep-dive — consistent with design § 5.5 ("additional scan is bounded by the same range used for outcomes").

**Rollback plan:** Delete the 12 new files. Sidebar entry (Phase H) is independent. No backend or schema reverts.
