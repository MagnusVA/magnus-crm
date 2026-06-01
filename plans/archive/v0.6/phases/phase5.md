# Phase 5 — Frontend: Report Pages

**Goal:** Build all 5 report pages with reactive data, charts, tables, interactive date controls, and empty states. After this phase, admins can navigate to each report, select date ranges, and see live-updating KPIs, charts, and activity data.

**Prerequisite:** Phase 3 complete (all reporting queries available). Phase 4 complete (report shell, skeletons, date controls, sidebar nav exist).

**Runs in PARALLEL with:** Nothing directly — this phase consumes the outputs of Phase 3 (queries) and Phase 4 (shell). However, individual subphases (5A-5E) can run in parallel with each other since each report page lives in its own route directory.

**Skills to invoke:**
- `frontend-design` — production-grade report page layouts, data visualization, responsive design
- `shadcn` — chart components (via recharts), table variants, card compositions
- `vercel-react-best-practices` — React.memo for chart components, avoiding re-renders on date change
- `vercel-composition-patterns` — composing report sections (shared KPI cards, chart wrappers)
- `web-design-guidelines` — WCAG compliance on charts (color contrast, screen reader labels), table accessibility

> **Critical path:** Phase 5 is on the critical path (Phase 1 → Phase 3 → Phase 5 → Phase 6).

**Acceptance Criteria:**
1. Team Performance page shows per-closer KPI tables split by "New Calls" and "Follow-Up Calls", with 4 summary cards (Total Booked, Show-Up Rate, Cash Collected, Close Rate) and a team total row.
2. Revenue page shows a trend line chart (with granularity toggle), per-closer revenue table with percentages, deal size distribution bar chart, and top 10 deals list.
3. Pipeline Health page shows a status distribution donut chart, aging-by-status table, velocity metric card, and stale opportunities list.
4. Leads & Conversions page shows KPI cards (new leads, conversions, conversion rate), per-closer conversion table, and a Form Insights section with field selector and answer distribution bar chart.
5. Activity Feed page shows summary cards (by source), filter controls (entity type, event type, actor), and a paginated event list with human-readable labels and "load more" functionality.
6. All date range selections trigger reactive `useQuery` re-fetches — data updates without page reload.
7. Empty date ranges show styled empty states ("No data for this period"), not blank pages or errors.
8. Closers with zero data show 0 values, not errors. Rates show "—" instead of NaN.
9. All charts use `accessibilityLayer` and OKLCH chart colors from CSS custom properties.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
5A (Team Performance page) ──────────────────────────────────────────┐
                                                                     │
5B (Revenue page) ───────────────────────────────────────────────────┤
                                                                     │
5C (Pipeline Health page) ───────────────────────────────────────────┤── All independent. Different route dirs.
                                                                     │
5D (Leads & Conversions page) ───────────────────────────────────────┤
                                                                     │
5E (Activity Feed page) ─────────────────────────────────────────────┘
```

**Optimal execution:**
1. Start **5A**, **5B**, **5C**, **5D**, **5E** all in parallel. Each creates files only in its own `app/workspace/reports/{section}/_components/` directory. Zero file overlap.

**Estimated time:** 5.5-6.5 days

---

## Subphases

### 5A — Team Performance Page

**Type:** Full-Stack (frontend consuming Phase 3 queries)
**Parallelizable:** Yes — touches only `app/workspace/reports/team/`. No overlap with 5B-5E.

**What:** Build the Team Performance page client component with: 4 KPI summary cards, two per-closer performance tables (one for "New Calls", one for "Follow-Up Calls"), date range controls, and team total rows.

**Why:** This is the primary report — the direct Excel replacement. It's the page admins will visit most often. The two-table layout matches the Excel's "New Calls" vs "Follow Up Calls" split that users are already familiar with.

**Where:**
- `app/workspace/reports/team/page.tsx` (modify — replace placeholder)
- `app/workspace/reports/team/_components/team-report-page-client.tsx` (new)
- `app/workspace/reports/team/_components/team-kpi-summary-cards.tsx` (new)
- `app/workspace/reports/team/_components/closer-performance-table.tsx` (new)

**How:**

**Step 1: Update page.tsx to import the client component**

```tsx
// Path: app/workspace/reports/team/page.tsx
import { TeamReportPageClient } from "./_components/team-report-page-client";

export const unstable_instant = false;

export default function TeamPerformancePage() {
  return <TeamReportPageClient />;
}
```

**Step 2: Create the page client component**

```tsx
// Path: app/workspace/reports/team/_components/team-report-page-client.tsx
"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { startOfMonth, endOfMonth } from "date-fns";
import { usePageTitle } from "@/hooks/use-page-title";
import { ReportDateControls } from "../../_components/report-date-controls";
import { TeamKpiSummaryCards } from "./team-kpi-summary-cards";
import { CloserPerformanceTable } from "./closer-performance-table";
import { TeamReportSkeleton } from "./team-report-skeleton";

export function TeamReportPageClient() {
  usePageTitle("Team Performance — Reports");

  const now = new Date();
  const [dateRange, setDateRange] = useState({
    startDate: startOfMonth(now).getTime(),
    endDate: endOfMonth(now).getTime(),
  });

  const metrics = useQuery(
    api.reporting.teamPerformance.getTeamPerformanceMetrics,
    dateRange,
  );

  if (metrics === undefined) return <TeamReportSkeleton />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Team Performance</h1>
        <p className="text-sm text-muted-foreground">
          Per-closer KPIs split by new and follow-up calls
        </p>
      </div>

      <ReportDateControls value={dateRange} onChange={setDateRange} />

      <TeamKpiSummaryCards totals={metrics.teamTotals} />

      <div className="space-y-8">
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
      </div>
    </div>
  );
}
```

**Step 3: Create KPI summary cards**

Build 4 cards: Total Booked, Show-Up Rate, Cash Collected, Close Rate. Use shadcn `Card` + lucide icons. Format currency as `$X,XXX`, rates as `XX.X%`.

```tsx
// Path: app/workspace/reports/team/_components/team-kpi-summary-cards.tsx
// See design §8.1 for the full component code. Key points:
// - Cards use PhoneIcon, PercentIcon, DollarSignIcon, TrendingUpIcon
// - Values are computed from teamTotals (aggregated from closerResults)
// - Subtitles show breakdown (e.g., "123 new, 45 follow-up")
```

**Step 4: Create the closer performance table**

Build a table with columns: Closer, Booked, Canceled, No Shows, Showed, Show-Up Rate. Add a team total footer row. Accept a `callType` prop to select "new" or "follow_up" data from each closer.

```tsx
// Path: app/workspace/reports/team/_components/closer-performance-table.tsx
// See design §8.1 for the full component code. Key points:
// - Uses shadcn Table, TableHeader, TableBody, TableFooter
// - Show-up rate shows "—" when denominator is 0 (not "NaN" or "0%")
// - Team total row is bold, computed from teamTotals prop
// - Numbers are right-aligned
```

**Key implementation notes:**
- `metrics === undefined` means the query is loading (show skeleton). `metrics` will never be `null` because the query always returns an object.
- Date range defaults to "This Month" — `startOfMonth(now)` to `endOfMonth(now)`.
- The two performance tables share the same `CloserPerformanceTable` component with different `callType` props — DRY.
- Division by zero protection: show-up rate and close rate show "—" when the denominator is 0.
- Revenue is displayed as `$X,XXX` (dollar amount, not cents). Convert `cashCollectedMinor / 100`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/team/page.tsx` | Modify | Replace placeholder with client component import |
| `app/workspace/reports/team/_components/team-report-page-client.tsx` | Create | Page client with date range + query subscription |
| `app/workspace/reports/team/_components/team-kpi-summary-cards.tsx` | Create | 4 KPI summary cards |
| `app/workspace/reports/team/_components/closer-performance-table.tsx` | Create | Per-closer table with new/follow-up split |

---

### 5B — Revenue Page

**Type:** Full-Stack
**Parallelizable:** Yes — touches only `app/workspace/reports/revenue/`. No overlap with 5A, 5C-5E.

**What:** Build the Revenue page with: trend line chart (with granularity toggle), per-closer revenue table with percentages, deal size distribution bar chart, and top 10 deals list.

**Why:** Revenue reporting provides the financial view that complements Team Performance. The trend chart enables visual pattern recognition (seasonality, growth). Deal size distribution helps pricing strategy.

**Where:**
- `app/workspace/reports/revenue/page.tsx` (modify)
- `app/workspace/reports/revenue/_components/revenue-report-page-client.tsx` (new)
- `app/workspace/reports/revenue/_components/revenue-trend-chart.tsx` (new)
- `app/workspace/reports/revenue/_components/closer-revenue-table.tsx` (new)
- `app/workspace/reports/revenue/_components/deal-size-distribution.tsx` (new)
- `app/workspace/reports/revenue/_components/top-deals-table.tsx` (new)

**How:**

**Step 1: Update page.tsx and create page client**

Follow the same three-layer pattern as 5A. The page client manages:
- `dateRange` state (default: this month)
- `granularity` state (default: "month")
- Three `useQuery` calls: `getRevenueMetrics`, `getRevenueDetails`, `getRevenueTrend`

**Step 2: Create revenue trend chart**

```tsx
// Path: app/workspace/reports/revenue/_components/revenue-trend-chart.tsx
// Uses recharts LineChart via shadcn ChartContainer + ChartTooltip
// See design §8.2 for the full implementation.
// Key points:
// - Uses ChartContainer with ChartConfig for theming (OKLCH colors)
// - XAxis shows periodKey, YAxis formats as "$Xk"
// - Dot-less line with strokeWidth={2}
// - accessibilityLayer on LineChart for screen readers
```

**Step 3: Create closer revenue table**

Table with columns: Closer, Revenue, % of Total, Deals, Avg Deal. Uses `revenuePercent` from the query response for the percentage column.

**Step 4: Create deal size distribution**

Bar chart with 5 buckets: <$500, $500-$2K, $2K-$5K, $5K-$10K, $10K+. Uses recharts `BarChart`.

**Step 5: Create top deals table**

Simple table showing the top 10 deals with amount, closer name, and date.

**Key implementation notes:**
- Three separate `useQuery` calls for three different queries. This allows independent loading — the trend chart can show data while details are still loading.
- Revenue amounts are stored in cents (`amountMinor`). Always divide by 100 for display.
- The granularity toggle uses `showGranularity={true}` on `ReportDateControls`.
- Charts use `accessibilityLayer` for screen reader compatibility.
- The revenue trend shows zero-value periods (no gaps) per design decision.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/revenue/page.tsx` | Modify | Replace placeholder |
| `app/workspace/reports/revenue/_components/revenue-report-page-client.tsx` | Create | Page client with 3 queries |
| `app/workspace/reports/revenue/_components/revenue-trend-chart.tsx` | Create | Line chart using recharts |
| `app/workspace/reports/revenue/_components/closer-revenue-table.tsx` | Create | Per-closer revenue breakdown |
| `app/workspace/reports/revenue/_components/deal-size-distribution.tsx` | Create | 5-bucket bar chart |
| `app/workspace/reports/revenue/_components/top-deals-table.tsx` | Create | Top 10 deals list |

---

### 5C — Pipeline Health Page

**Type:** Full-Stack
**Parallelizable:** Yes — touches only `app/workspace/reports/pipeline/`. No overlap.

**What:** Build the Pipeline Health page with: status distribution donut chart, aging-by-status table, pipeline velocity metric card, and stale opportunities list.

**Why:** Pipeline Health gives admins a real-time snapshot of deal distribution and throughput. The stale pipeline list is an actionable alert — deals that haven't progressed need attention.

**Where:**
- `app/workspace/reports/pipeline/page.tsx` (modify)
- `app/workspace/reports/pipeline/_components/pipeline-report-page-client.tsx` (new)
- `app/workspace/reports/pipeline/_components/status-distribution-chart.tsx` (new)
- `app/workspace/reports/pipeline/_components/pipeline-aging-table.tsx` (new)
- `app/workspace/reports/pipeline/_components/velocity-metric-card.tsx` (new)
- `app/workspace/reports/pipeline/_components/stale-pipeline-list.tsx` (new)

**How:**

**Step 1: Create page client**

The Pipeline Health page is unique — its queries (`getPipelineDistribution`, `getPipelineAging`) take no date range arguments. They reflect the current pipeline state.

```tsx
// The page client has two useQuery calls with no args (besides auth, handled by requireTenantUser):
const distribution = useQuery(api.reporting.pipelineHealth.getPipelineDistribution);
const aging = useQuery(api.reporting.pipelineHealth.getPipelineAging);
```

**Step 2: Create status distribution donut chart**

```tsx
// Path: app/workspace/reports/pipeline/_components/status-distribution-chart.tsx
// Uses recharts PieChart with innerRadius for donut appearance.
// See design §8.3 for full implementation.
// Key points:
// - Filter out statuses with count === 0
// - Use STATUS_COLORS map with OKLCH CSS custom properties
// - Include ChartLegend for status name labels
// - accessibilityLayer on PieChart
```

**Step 3: Create aging table**

Table showing active statuses (scheduled, in_progress, follow_up_scheduled, reschedule_link_sent) with: Status, Count, Avg Age (days). Computed from `agingByStatus` response.

**Step 4: Create velocity metric card**

Single card showing "Avg Days to Close" from `velocityDays`. Shows "—" if null (no recent closed deals).

**Step 5: Create stale pipeline list**

List of opportunities with no upcoming meeting or whose next meeting is 14+ days overdue. Shows opportunity ID, current status, and age in days.

**Key implementation notes:**
- No date range controls on this page — it shows current pipeline state.
- The donut chart dynamically builds `ChartConfig` from the data — statuses with 0 count are excluded.
- `formatStatus` converts snake_case to Title Case (e.g., `follow_up_scheduled` → "Follow Up Scheduled").
- Stale pipeline list is capped at 20 items (server-side `.slice(0, 20)`).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/pipeline/page.tsx` | Modify | Replace placeholder |
| `app/workspace/reports/pipeline/_components/pipeline-report-page-client.tsx` | Create | Page client with 2 queries (no date range) |
| `app/workspace/reports/pipeline/_components/status-distribution-chart.tsx` | Create | Donut chart for pipeline distribution |
| `app/workspace/reports/pipeline/_components/pipeline-aging-table.tsx` | Create | Aging table by active status |
| `app/workspace/reports/pipeline/_components/velocity-metric-card.tsx` | Create | Single KPI card |
| `app/workspace/reports/pipeline/_components/stale-pipeline-list.tsx` | Create | Actionable stale deal list |

---

### 5D — Leads & Conversions Page

**Type:** Full-Stack
**Parallelizable:** Yes — touches only `app/workspace/reports/leads/`. No overlap.

**What:** Build the Leads & Conversions page with: 3 KPI cards (new leads, conversions, conversion rate), per-closer conversion table, and Form Insights section (field selector + answer distribution chart).

**Why:** Lead-to-customer conversion tracking and form response analytics are unique CRM insights that don't exist in the Excel. The Form Insights section is the v0.5b payoff — it makes the `meetingFormResponses` data actually useful to admins.

**Where:**
- `app/workspace/reports/leads/page.tsx` (modify)
- `app/workspace/reports/leads/_components/leads-report-page-client.tsx` (new)
- `app/workspace/reports/leads/_components/conversion-kpi-cards.tsx` (new)
- `app/workspace/reports/leads/_components/conversion-by-closer-table.tsx` (new)
- `app/workspace/reports/leads/_components/form-response-analytics-section.tsx` (new)
- `app/workspace/reports/leads/_components/field-answer-distribution.tsx` (new)

**How:**

**Step 1: Create page client**

```tsx
// Path: app/workspace/reports/leads/_components/leads-report-page-client.tsx
// Manages dateRange state + useQuery for getLeadConversionMetrics
// The FormResponseAnalyticsSection is self-contained (manages its own queries)
```

**Step 2: Create conversion KPI cards**

3 cards: New Leads (count), Conversions (count), Conversion Rate (percentage). Simple layout using shadcn Card.

**Step 3: Create per-closer conversion table**

Table with columns: Closer, Conversions. Shows conversion count per closer from the query response.

**Step 4: Create Form Insights section**

This is a self-contained section with its own query state:

```tsx
// Path: app/workspace/reports/leads/_components/form-response-analytics-section.tsx
// See design §8.4 for full implementation.
// Key points:
// - Uses getFieldCatalog query to populate the field selector dropdown
// - On field selection, fires getAnswerDistribution query with fieldKey
// - Uses "skip" pattern: useQuery(api.reporting.formResponseAnalytics.getAnswerDistribution, 
//     selectedFieldKey ? { fieldKey: selectedFieldKey } : "skip")
// - Empty state: "No Calendly form fields have been captured yet."
```

**Step 5: Create answer distribution chart**

Bar chart showing answer → count for the selected form field. Sorted by frequency (most common first).

**Key implementation notes:**
- The Form Insights section is independent from the date range — field catalog is always global. Answer distribution can optionally filter by date if the date range props are passed through.
- The `"skip"` pattern for `useQuery` prevents firing the distribution query until a field is selected.
- Conversion rate is displayed as a percentage: `(totalConversions / newLeads * 100).toFixed(1)%`. Shows "—" if newLeads is 0.
- If the tenant has no form fields, show a contextual empty state (not an error).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/leads/page.tsx` | Modify | Replace placeholder |
| `app/workspace/reports/leads/_components/leads-report-page-client.tsx` | Create | Page client with date range + conversion query |
| `app/workspace/reports/leads/_components/conversion-kpi-cards.tsx` | Create | 3 KPI summary cards |
| `app/workspace/reports/leads/_components/conversion-by-closer-table.tsx` | Create | Per-closer conversion table |
| `app/workspace/reports/leads/_components/form-response-analytics-section.tsx` | Create | Self-contained form insights with field selector |
| `app/workspace/reports/leads/_components/field-answer-distribution.tsx` | Create | Answer frequency bar chart |

---

### 5E — Activity Feed Page

**Type:** Full-Stack
**Parallelizable:** Yes — touches only `app/workspace/reports/activity/`. No overlap.

**What:** Build the Activity Feed page with: summary cards (by source), filter controls (entity type, event type, actor), paginated event list with human-readable labels, and "load more" functionality.

**Why:** The Activity Feed is the CRM's audit trail — it shows admins who did what and when. This is critical for accountability and debugging. The summary cards provide at-a-glance activity metrics.

**Where:**
- `app/workspace/reports/activity/page.tsx` (modify)
- `app/workspace/reports/activity/_components/activity-feed-page-client.tsx` (new)
- `app/workspace/reports/activity/_components/activity-summary-cards.tsx` (new)
- `app/workspace/reports/activity/_components/activity-feed-filters.tsx` (new)
- `app/workspace/reports/activity/_components/activity-feed-list.tsx` (new)
- `app/workspace/reports/activity/_components/activity-event-row.tsx` (new)

**How:**

**Step 1: Create page client**

```tsx
// Path: app/workspace/reports/activity/_components/activity-feed-page-client.tsx
// See design §8.5 for full implementation.
// Key points:
// - dateRange state (default: this month)
// - filters state: { entityType?, eventType?, actorUserId? }
// - limit state: starts at 50, incremented by "Load More" (max 100)
// - Two useQuery calls: getActivitySummary (always) + getActivityFeed (with filters)
```

**Step 2: Create summary cards**

4 cards showing activity breakdown by source: Closer, Admin, Pipeline, System. Values from `summary.bySource`.

**Step 3: Create filter controls**

Row of Select dropdowns: Entity Type (meeting, opportunity, payment, lead, customer, user), Event Type (from EVENT_LABELS keys), Actor (from summary.byActor with name lookup). All optional — when none selected, shows all events.

**Step 4: Create feed list**

```tsx
// Renders a list of ActivityEventRow components
// "Load More" button at bottom when hasMore is true
// hasMore = feed.length === limit && limit < 100
```

**Step 5: Create event row**

```tsx
// Path: app/workspace/reports/activity/_components/activity-event-row.tsx
// See design §8.5 for full implementation.
// Key points:
// - Uses getEventLabel() from convex/reporting/lib/eventLabels
// - Icon resolved from iconHint → lucide-react icon component
// - Format: [icon] [actorName] [verb] [(fromStatus → toStatus)] [relative time]
// - Relative time via formatDistanceToNow from date-fns
```

**Key implementation notes:**
- The icon mapping from `iconHint` string to lucide component should be a local lookup (not dynamic import) — small fixed set of ~15 icons.
- `formatDistanceToNow` from date-fns provides human-readable relative timestamps ("2 hours ago", "yesterday").
- The "Load More" pattern: `limit` starts at 50, each click adds 50, hard cap at 100. The query re-fires with the new limit (Convex handles deduplication).
- `summary.isTruncated` shows a warning banner when the date range has > 10,000 events.
- Actor names in filter dropdown: resolve from `summary.byActor` keys (user IDs) via a separate user lookup. Or simplify by showing the closers from an existing list.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/activity/page.tsx` | Modify | Replace placeholder |
| `app/workspace/reports/activity/_components/activity-feed-page-client.tsx` | Create | Page client with filters + pagination |
| `app/workspace/reports/activity/_components/activity-summary-cards.tsx` | Create | 4 source breakdown cards |
| `app/workspace/reports/activity/_components/activity-feed-filters.tsx` | Create | Entity/event/actor filter dropdowns |
| `app/workspace/reports/activity/_components/activity-feed-list.tsx` | Create | Paginated event list with load more |
| `app/workspace/reports/activity/_components/activity-event-row.tsx` | Create | Single event row with icon + verb + time |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/reports/team/page.tsx` | Modify | 5A |
| `app/workspace/reports/team/_components/team-report-page-client.tsx` | Create | 5A |
| `app/workspace/reports/team/_components/team-kpi-summary-cards.tsx` | Create | 5A |
| `app/workspace/reports/team/_components/closer-performance-table.tsx` | Create | 5A |
| `app/workspace/reports/revenue/page.tsx` | Modify | 5B |
| `app/workspace/reports/revenue/_components/revenue-report-page-client.tsx` | Create | 5B |
| `app/workspace/reports/revenue/_components/revenue-trend-chart.tsx` | Create | 5B |
| `app/workspace/reports/revenue/_components/closer-revenue-table.tsx` | Create | 5B |
| `app/workspace/reports/revenue/_components/deal-size-distribution.tsx` | Create | 5B |
| `app/workspace/reports/revenue/_components/top-deals-table.tsx` | Create | 5B |
| `app/workspace/reports/pipeline/page.tsx` | Modify | 5C |
| `app/workspace/reports/pipeline/_components/pipeline-report-page-client.tsx` | Create | 5C |
| `app/workspace/reports/pipeline/_components/status-distribution-chart.tsx` | Create | 5C |
| `app/workspace/reports/pipeline/_components/pipeline-aging-table.tsx` | Create | 5C |
| `app/workspace/reports/pipeline/_components/velocity-metric-card.tsx` | Create | 5C |
| `app/workspace/reports/pipeline/_components/stale-pipeline-list.tsx` | Create | 5C |
| `app/workspace/reports/leads/page.tsx` | Modify | 5D |
| `app/workspace/reports/leads/_components/leads-report-page-client.tsx` | Create | 5D |
| `app/workspace/reports/leads/_components/conversion-kpi-cards.tsx` | Create | 5D |
| `app/workspace/reports/leads/_components/conversion-by-closer-table.tsx` | Create | 5D |
| `app/workspace/reports/leads/_components/form-response-analytics-section.tsx` | Create | 5D |
| `app/workspace/reports/leads/_components/field-answer-distribution.tsx` | Create | 5D |
| `app/workspace/reports/activity/page.tsx` | Modify | 5E |
| `app/workspace/reports/activity/_components/activity-feed-page-client.tsx` | Create | 5E |
| `app/workspace/reports/activity/_components/activity-summary-cards.tsx` | Create | 5E |
| `app/workspace/reports/activity/_components/activity-feed-filters.tsx` | Create | 5E |
| `app/workspace/reports/activity/_components/activity-feed-list.tsx` | Create | 5E |
| `app/workspace/reports/activity/_components/activity-event-row.tsx` | Create | 5E |
