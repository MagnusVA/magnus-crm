# Phase 9 — Reporting UI + Dashboard + Activity Feed (Frontend)

**Goal:** Land the last frontend surface: every report, the workspace dashboard stats row, and the activity-feed event rows must consume Phase 5's four-way commissionable-×-{final,deposit} split, the new `programId` / `paymentType` / `revenueSlice` filter axes, and the enriched payment-event metadata. After Phase 9 merges, no surface in the app speaks the old single-`revenueLogged` / single-`provider` / single-`closerId` vocabulary, and the grep sweep over the entire codebase returns clean.

Three shared filter components created, six report components rewritten or extended, two dashboard components refreshed, three activity-feed components refreshed, one verification pass:

1. **Three shared filter components** at `app/workspace/reports/_components/`:
   - `report-program-filter.tsx` — wraps `<Select>` bound to `api.tenantPrograms.queries.listPrograms`; one "All Programs" sentinel, one entry per active program plus an "Archived" group (reporting shows archived programs for historical slices per design §2.6).
   - `report-payment-type-filter.tsx` — wraps `<Select>` with four literal entries (`pif` / `split` / `monthly` / `deposit`) plus "All Payment Types" sentinel.
   - `report-revenue-slice-filter.tsx` — wraps `<Select>` with three entries (`all` / `commissionable` / `non_commissionable`) plus a descriptive tooltip.
2. **Revenue report UI rewrite (9B):**
   - `revenue-report-page-client.tsx` adds `programId` / `paymentType` / `revenueSlice` state and feeds it into all three Convex queries; adds a filter bar under `<ReportDateControls>`; renders new KPI cards + two new breakdown sections.
   - `revenue-kpi-cards.tsx` NEW — four-card row: `Commissionable Final`, `Commissionable Deposits`, `Post-Conversion Final`, `Post-Conversion Deposits`; deal-count subtext; variant hints (`success` for commissionable, `default` for non-commissionable).
   - `revenue-by-program-section.tsx` NEW — table + micro-bars of `metrics.commissionable.byProgram` and `metrics.nonCommissionable.byProgram`, side-by-side when both non-empty.
   - `revenue-by-payment-type-section.tsx` NEW — 2×4 grid showing commissionable vs. non-commissionable for each payment type.
   - `revenue-trend-chart.tsx` rewritten — four series per period (commissionable-final, commissionable-deposit, non-commissionable-final, non-commissionable-deposit) with the commissionable-final emphasized as the primary line.
   - `revenue-by-origin-chart.tsx` modified — the `ORIGIN_META` keyspace expands to `COMMISSIONABLE_ORIGINS` (5 entries: closer_meeting, closer_reminder, admin_meeting, admin_reminder, admin_review_resolution); the stale `customer_flow` / `unknown` entries are removed (Phase 5 already scopes the backend `byOrigin` to commissionable origins only).
   - `top-deals-table.tsx` modified — adds `Program` and `Payment Type` columns between `Amount` and `Closer`; reads `deal.programName`, `deal.paymentType` from the enriched Phase-5 return shape; keeps commissionable-final only (deposits never appear here per Phase 5 acceptance #3).
3. **Reminders report UI (9C):**
   - `reminders-report-page-client.tsx` — adds `programId` / `paymentType` filter state; filter bar rendered next to `<ReportDateControls>`.
   - `reminder-driven-revenue-card.tsx` rewritten — the single "Revenue captured" block becomes a compact two-row split: line 1 shows `Final revenue` (`reminderDrivenFinalRevenueMinor`), line 2 shows `Deposits` (`reminderDrivenDepositRevenueMinor`); the original `reminderDrivenRevenueMinor` sum is retained in a small footer caption ("`Total ${sum}`") during the rollout window.
4. **Team report UI (9D):**
   - `team-report-page-client.tsx` — adds a new team-level `<PostConversionRevenueChip>` between the existing top-four card row and the "Lost Deals" row; passes through new `teamTotals.postConversionRevenueMinor` field.
   - `team-kpi-summary-cards.tsx` rewritten — the `Cash Collected` card gets a clarifying subtext `"Commissionable final only"`; adds a new card `Post-Conversion Revenue` using `teamTotals.postConversionRevenueMinor`; the existing `Admin-Logged` column label on the per-closer table changes to `Admin On Behalf` (matches Phase 5's `recordedByUserId !== attributedCloserId` semantic).
   - `closer-performance-table.tsx` — column header `"Cash Collected"` gains a tooltip via `title=` attribute: `"Commissionable-final payments attributed to this closer. Excludes deposits and post-conversion customer payments."`; column header `"Admin-Logged"` renamed to `"Admin On Behalf"`.
   - `team-report-types.ts` — the `TeamTotals` interface gains `postConversionRevenueMinor: number` (matches Phase 5's return-shape expansion).
5. **Dashboard stats row (9E):**
   - `stats-row.tsx` rewritten — replaces the single `Revenue` card with a responsive four-card cluster (`Revenue`, `Deposits`, `Post-Conv Revenue`, `Post-Conv Deposits`) while keeping `Total Closers`, `Active Opportunities`, `Meetings`, `Won Deals` intact; the grid breakpoint shifts from `lg:grid-cols-5` to `lg:grid-cols-4 xl:grid-cols-8` (four heading cards top row, four revenue cards second row on `xl`; stacks cleanly on mobile).
   - `dashboard-page-client.tsx` — the `StaticStats` inline interface picks up the four new fields from `getAdminDashboardStats`; the `PeriodStats` interface picks up the four new period-split fields from `getTimePeriodStats`.
6. **Activity feed (9F):**
   - `activity-event-row.tsx` — when `event.eventType` is one of `payment.recorded` / `payment.disputed` / `payment.verified`, render a compact badge row under the verb line: `<ProgramBadge>` + `<PaymentTypeBadge>` + `<CommissionableBadge>` (the last one reads `metadata.commissionable` and renders `Commissionable` or `Post-conversion`).
   - `activity-feed-filters.tsx` — adds two conditional filters that render only when `filters.entityType === "payment"`: `<ReportProgramFilter>` and `<ReportPaymentTypeFilter>`. No new "Commissionable" select — the combined `programId` × `paymentType` filter set is sufficient per design §6.6.
   - `activity-feed-page-client.tsx` — extends the `Filters` interface + `feedArgs` + `useEffect` reset-on-change tuple to include `programId` / `paymentType`.
7. **Verification pass (9G)** — grep sweep across the entire codebase for any remaining `closerId` on payment rows, `provider` on payment rows, `programType` on customers, `customer_flow` origin literal, `revenueLogged` single-field reads; `pnpm tsc --noEmit` + `pnpm lint` clean; full end-to-end smoke test walking every report, the dashboard, and the activity feed.

**Prerequisites:**

- **Phase 1 merged** — `tenantPrograms` table + `api.tenantPrograms.queries.listPrograms` returns active and archived programs on a single call. The 9A `<ReportProgramFilter>` calls it with `{ includeArchived: true }` so reporting can slice by archived programs.
- **Phase 2 merged** — `paymentRecords` has `programId` / `programName` / `paymentType` / `commissionable` / `attributedCloserId` / `recordedByUserId`; `tenantStats` includes the four split counters; and the new indexes (`by_tenantId_and_commissionable_and_recordedAt`, `by_tenantId_and_programId_and_recordedAt`, `by_tenantId_and_paymentType_and_recordedAt`) support the filter paths taken by `getRevenueMetrics` / `getRevenueDetails` / `getRevenueTrend` / `getReminderOutcomeFunnel`.
- **Phase 3 merged** — the shared backend helper layer (`split-counter` routing via `applyPaymentStatsDelta`, shared payment literals, conversion cleanup) is in place. Phase 9 does not bind to it directly, but the Phase 4/5 data it consumes depends on this spine being complete.
- **Phase 4 merged** — every payment write path routes through `applyPaymentStatsDelta` so the four split counters stay accurate. Without Phase 4, the dashboard 9E renders stale totals.
- **Phase 5 merged — HARD GATE.** Every report query, the dashboard stats query, and the activity-feed enrichment are owned by Phase 5. The entire Phase 9 frontend binds to Phase 5's return shapes. If Phase 5 lands with a shape bug, Phase 9 breaks on mount across the whole reporting surface. Run Phase 5's smoke test (`phase5.md` §Smoke Test) on a preview deployment *before* opening a Phase 9 PR.
- **Phase 6A merged** — NOT required. Phase 9 does not import `ProgramSelect`; the three shared filter components are independent (report filters have different UX: "All Programs" sentinel, archived-group rendering, smaller trigger width).
- **Phase 7 and Phase 8 are NOT prerequisites.** Phase 9 touches disjoint files from Phases 7 and 8 (the only shared file is the activity-feed row renderer, and that is owned by Phase 9). All three frontend phases can land in any order after Phase 5 merges.

**Runs in PARALLEL with:**

- **Phase 6 (6B–6E)** — Settings Programs UI. Zero shared files.
- **Phase 7 (7A–7E)** — Commissionable payment dialogs + admin reminder route. Zero shared files.
- **Phase 8 (8A–8G)** — Customer read-surface + payment display refreshes. Zero shared files.

**Runs SERIALLY with:**

- Nothing external to Phase 9.
- Internal serialization: 9A is a serial gate for 9B / 9C / 9F (those subphases import the three filter components). 9D / 9E do NOT depend on 9A (the team and dashboard surfaces are globally scoped — no per-program / per-paymentType filters on those). 9G runs last.

> **Critical path:** Phase 9 is the *deepest* frontend phase by rendering surface (KPI cards, bar charts, line charts, tables, activity-feed rows, filter bars), but each subphase is a leaf change against a stable Phase-5 return shape. The risk is consistency: if the revenue KPI card shows `commissionable.finalRevenueMinor` as "Revenue" and the dashboard shows the same minor as "Commissionable Final", users see a mismatch. **Vocabulary convergence is enforced by 9G's grep sweep** — every instance of "Revenue" in a KPI label must be accompanied by the semantic qualifier (commissionable-final), and every payment-event row in the activity feed must render the same three badges in the same order. Ship the six subphases together; do not split the PR across a release boundary.

**Skills to invoke:**

- `frontend-design` — apply to the four KPI cards in 9E and the revenue KPI cards in 9B. Cards must follow the existing `<StatsCard>` API (icon + label + value + subtext + variant); do not introduce a new card component. The four-card cluster on the dashboard needs to read as a single semantic unit — use `aria-describedby` to link subtext to the primary heading.
- `shadcn` — no new primitives. All Phase 9 work composes existing `<Select>`, `<Badge>`, `<Card>`, `<Table>`, `<ChartContainer>`, `<Alert>`, `<Popover>`. Verify in both light and dark themes.
- `vercel-react-best-practices` — Revenue trend chart now emits four series. Do NOT wrap the four `<Line>` components in `useMemo` — React 19's compiler handles this. Do NOT add `React.memo` to the new KPI card component — it's a leaf render.
- `vercel-react-view-transitions` — when a filter change swaps the dataset for the trend chart or the top deals table, Recharts already animates the transition. No additional view-transition wiring needed.
- `vercel-composition-patterns` — the three shared filter components at 9A are deliberately three components, not one generic `<ReportFilter>` with props. Composition > configuration: each caller imports the specific filter it needs; adding a new filter type does not widen a shared config surface.
- `web-design-guidelines` — verify: (a) every new filter select has a visible label (not placeholder-only) and `aria-label` when the label is visually compacted, (b) the four-card dashboard cluster has a group heading `"Revenue This Period"` with `role="group"` so screen readers speak the semantic grouping, (c) the activity-feed payment badges have `aria-label` like `"Program Launchpad, PIF, Commissionable"` so screen readers do not spell out three separate badges without context, (d) the revenue KPI cards' colors convey semantic hierarchy (commissionable = `success` variant; non-commissionable = `default` variant — never `warning` or `destructive` since non-commissionable is valid revenue, not an error).
- `convex-performance-audit` — the three report pages now make queries with filter args. Verify in Convex Insights after deploy: each `getRevenueMetrics` call with a `programId` filter should use the `by_tenantId_and_programId_and_recordedAt` index (Phase 2 gate); each `getReminderOutcomeFunnel` call with a `programId` filter should filter in-memory after the origin scan (the backend owns this decision per Phase 5). Phase 9 does not add new queries; it passes new args to existing ones.

**Acceptance Criteria:**

1. Three new files exist under `app/workspace/reports/_components/`: `report-program-filter.tsx`, `report-payment-type-filter.tsx`, `report-revenue-slice-filter.tsx`. Each exports a single React component with the props `{ value?: string, onChange: (next: string | undefined) => void, disabled?: boolean }` and an internal `"__all__"` sentinel for "no filter" (consistent with `activity-feed-filters.tsx`).
2. `<ReportProgramFilter>` subscribes to `api.tenantPrograms.queries.listPrograms({ includeArchived: true })` and renders three groups: `All Programs` sentinel, `Active` group (programs where `archivedAt === undefined`), `Archived` group (programs where `archivedAt !== undefined`). Archived entries render with a muted "(archived)" suffix. When `listPrograms` is loading, the trigger is disabled with a `<Spinner>` on the right side. When the list is empty (tenant has no programs, only possible during onboarding), the select is hidden entirely.
3. `<ReportPaymentTypeFilter>` renders five entries: `All Payment Types` sentinel, `PIF`, `Split`, `Monthly`, `Deposit`. Stateless; no Convex call.
4. `<ReportRevenueSliceFilter>` renders three selectable options: `All Revenue` sentinel, `Commissionable`, and `Post-Conversion`, plus a help icon that opens a `<Popover>` with the definition: `"Commissionable revenue is attributed to a closer (earned from a meeting, reminder, or review resolution). Post-conversion revenue is logged by admins against a customer after their deal closed and is not attributed to any closer."`.
5. `revenue-report-page-client.tsx` manages three new local state slots — `programId`, `paymentType`, `revenueSlice` — each typed `string | undefined`. It passes those as optional args to `api.reporting.revenue.getRevenueMetrics` / `getRevenueDetails` / `api.reporting.revenueTrend.getRevenueTrend` (the Phase 5 query signatures accept `{ startDate, endDate, programId?, paymentType?, revenueSlice? }` + `granularity` for trend). The filter bar renders between `<ReportDateControls>` and the grid of charts.
6. `revenue-kpi-cards.tsx` renders four `<StatsCard>` instances in a `grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4` layout:
   - **Commissionable Final** — value: `formatCurrency(metrics.commissionable.finalRevenueMinor / 100, "USD")`; subtext: `"${metrics.commissionable.totalDeals} deal${metrics.commissionable.totalDeals === 1 ? "" : "s"}"`; variant `"success"` when > 0, `"default"` otherwise; icon `DollarSignIcon`.
   - **Commissionable Deposits** — value: `formatCurrency(metrics.commissionable.depositRevenueMinor / 100, "USD")`; subtext: `"Deposits recorded in range"`; variant `"default"`; icon `HandCoinsIcon`.
   - **Post-Conversion Final** — value: `formatCurrency(metrics.nonCommissionable.finalRevenueMinor / 100, "USD")`; subtext: `"${metrics.nonCommissionable.totalDeals} customer payment${metrics.nonCommissionable.totalDeals === 1 ? "" : "s"}"`; variant `"default"`; icon `CoinsIcon`.
   - **Post-Conversion Deposits** — value: `formatCurrency(metrics.nonCommissionable.depositRevenueMinor / 100, "USD")`; subtext: `"Customer deposits recorded in range"`; variant `"default"`; icon `WalletIcon`.
7. `revenue-by-program-section.tsx` renders a single `<Card>` with a two-column layout: left column title "Commissionable revenue by program" (table of `metrics.commissionable.byProgram` sorted descending by `revenueMinor`); right column title "Post-conversion revenue by program" (table of `metrics.nonCommissionable.byProgram`). Each row shows `programName`, `revenueMinor` formatted, `dealCount`, and a small horizontal bar whose width is `(revenueMinor / maxRevenueInColumn) * 100%`. When a column is empty, the column shows a centered muted message (`"No commissionable revenue in this range"` / `"No post-conversion revenue in this range"`). When both are empty, the whole card renders a centered empty state with an icon.
8. `revenue-by-payment-type-section.tsx` renders a 4-column grid where each column is one payment type (`PIF`, `Split`, `Monthly`, `Deposit`). Each column shows two stacked cells: commissionable amount (top, `success` color bar) and non-commissionable amount (bottom, muted color bar). Amounts read from `metrics.byPaymentType.commissionable[type]` and `metrics.byPaymentType.nonCommissionable[type]`. When an entire payment type is zero across both slices, the column shows `"—"` in both cells (not hidden).
9. `revenue-trend-chart.tsx` rewritten to emit four `<Line>` components, one per series: `commissionableFinalDollars`, `commissionableDepositDollars`, `nonCommissionableFinalDollars`, `nonCommissionableDepositDollars` (derived inline by dividing each `Minor` value by 100). The primary line (commissionable-final) uses `--chart-1` and `strokeWidth={2.5}`; the three secondary lines use `--chart-2/3/4` with `strokeWidth={1.5}` and `strokeDasharray` for the two non-commissionable series so they visually group. Chart config labels match the KPI card labels exactly. `ChartTooltip` shows all four series on hover.
10. `revenue-by-origin-chart.tsx` — `ORIGIN_META` keyspace rewritten to match the Phase 5 `COMMISSIONABLE_ORIGINS`: `closer_meeting`, `closer_reminder`, `admin_meeting`, `admin_reminder`, `admin_review_resolution`. The `customer_flow` entry is deleted (non-commissionable origin is scoped out of `byOrigin` by Phase 5). The `unknown` entry is deleted (`legacy` payments never appear in the commissionable bucket by definition).
11. `top-deals-table.tsx` columns after rewrite, left-to-right: `#` → `Amount` → `Program` → `Payment Type` → `Closer` → `Date` → `Source`. `Program` renders `deal.programName ?? "—"`. `Payment Type` renders capitalized via `deal.paymentType.charAt(0).toUpperCase() + deal.paymentType.slice(1)`. `Closer` reads `deal.attributedCloserName` (Phase 5's rename from `closerName`). `Source` keeps the current `contextType` formatter.
12. `reminders-report-page-client.tsx` adds `programId` / `paymentType` state and passes them as optional args to `api.reporting.remindersReporting.getReminderOutcomeFunnel`. The filter bar renders next to `<ReportDateControls>` in a `flex flex-wrap items-center gap-2` row.
13. `reminder-driven-revenue-card.tsx` rewritten — the "Revenue captured" block becomes two sub-blocks side-by-side in a `grid grid-cols-2 gap-3` layout inside the same `rounded-2xl border bg-background/80 p-4` wrapper: left sub-block labeled `"Final Revenue"` showing `reminderDrivenFinalRevenueMinor`, right sub-block labeled `"Deposits"` showing `reminderDrivenDepositRevenueMinor`. The `paymentCount` subtext reads `"${reminderDrivenPaymentCount} payment${…} logged from the reminder flow. Total: ${formattedTotal}"` where `formattedTotal = reminderDrivenRevenueMinor / 100` (the rollout-compat sum).
14. `team-report-types.ts` — the `TeamTotals` interface gains `postConversionRevenueMinor: number`. No other fields change shape. The existing `totalRevenueMinor` keeps its name but its semantic is now **commissionable-final only** (Phase 5 acceptance #6); this semantic shift is documented in the interface's JSDoc.
15. `team-kpi-summary-cards.tsx` — the `Cash Collected` card gets a subtext addendum: `"Commissionable-final only"` in parenthesis below the primary subtext. The secondary row of cards (`Lost Deals` / `Rebook Rate` / `Actions / Closer / Day`) expands to a fourth card `Post-Conversion Revenue` showing `formatCompactCurrency(totals.postConversionRevenueMinor)`; the grid breakpoint changes from `xl:grid-cols-3` to `xl:grid-cols-4` for that row.
16. `closer-performance-table.tsx` — the `<TableHead>` for the `Cash Collected` column gains a `title` attribute: `"Commissionable-final payments attributed to this closer. Excludes deposits and post-conversion customer payments."`. The `Admin-Logged` column header is renamed to `Admin On Behalf` with a `title` attribute: `"Commissionable revenue logged by an admin on this closer's behalf (recorded by ≠ attributed closer)."`. No structural table changes.
17. `stats-row.tsx` rewritten — the single `Revenue` card is replaced with four cards in a second row below the four pipeline cards. The outer grid becomes:
    ```tsx
    <div className="flex flex-col gap-4" role="region" aria-labelledby="dashboard-stats-heading">
      <h2 id="dashboard-stats-heading" className="sr-only">Workspace dashboard stats</h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4" aria-label="Pipeline overview">
        {/* Total Closers, Active Opportunities, Meetings, Won Deals */}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="Revenue in period">
        {/* Revenue, Deposits, Post-Conv Revenue, Post-Conv Deposits */}
      </div>
    </div>
    ```
    Each revenue card uses `<StatsCard variant="success">` when value > 0; `default` otherwise. Subtext for each card uses the semantic qualifier and the selected period context (`Today`, `This week`, etc.); it does **not** invent payment-count fields that the Phase 5 backend does not return.
18. `dashboard-page-client.tsx` — the `StaticStats` inline interface gains `revenueLogged: number`, `depositsCollected: number`, `postConversionRevenueLogged: number`, `postConversionDepositsLogged: number`; the `PeriodStats` inline interface gains `closedWonInPeriod: number`, `depositsInPeriod: number`, `postConversionInPeriod: number`, `postConversionDepositsInPeriod: number`. The `revenueInPeriod` compat field stays on the interface (reads the sum) but is NOT used in the rendered UI.
19. `activity-event-row.tsx` — when `event.eventType` is `payment.recorded` | `payment.disputed` | `payment.verified` AND `event.metadata` is not null, render a badge row below the verb line:
    ```tsx
    <div className="mt-1 flex flex-wrap items-center gap-1.5" aria-label={`Program ${programName ?? "unknown"}, ${paymentType ?? "unknown"} payment, ${commissionable ? "commissionable" : "post-conversion"}`}>
      {programName && <Badge variant="outline" className="text-[11px]">{programName}</Badge>}
      {paymentType && <Badge variant="secondary" className="text-[11px]">{capitalize(paymentType)}</Badge>}
      <Badge variant={commissionable ? "default" : "outline"} className="text-[11px]">
        {commissionable ? "Commissionable" : "Post-conversion"}
      </Badge>
    </div>
    ```
    The badge row sits *between* the fromStatus/toStatus line and the timestamp. For non-payment events, the badge row is absent (no layout shift).
20. `activity-feed-filters.tsx` extends with two conditionally-rendered filters: `<ReportProgramFilter>` and `<ReportPaymentTypeFilter>`, each rendered only when `filters.entityType === "payment"`. The filters appear as the fourth and fifth `<Select>` in the row, after `Actor`. When the user changes `entityType` away from `"payment"`, the program/paymentType filters are automatically cleared (the parent's `onChange` receives `{ ...filters, programId: undefined, paymentType: undefined }`).
21. `activity-feed-page-client.tsx` — the `Filters` interface extends with `programId?: Id<"tenantPrograms">` and `paymentType?: "pif" | "split" | "monthly" | "deposit"`. The `feedArgs` object conditionally includes both. The `useEffect` reset-on-filter-change tuple extends to `[dateRange.startDate, dateRange.endDate, filters.entityType, filters.eventType, filters.actorUserId, filters.programId, filters.paymentType]`.
22. `pnpm tsc --noEmit` passes with zero errors. Grep confirms:
    - Zero references to `customer_flow` (origin literal) across `app/**`, `components/**`, `convex/**` (except `lib/paymentTypes.ts` backup comment if any).
    - Zero references to `ORIGIN_META.customer_flow` or `ORIGIN_META.unknown` across `app/**`.
    - Zero references to `totalRevenue` as a dashboard-read field in `app/workspace/_components/**` (the compat-returned field is not consumed by the new stats-row; rollout sanity only).
    - Zero references to `deal.closerName` on `top-deals-table.tsx` (Phase 5 renamed to `attributedCloserName`).
    - Every `payment.recorded` / `payment.disputed` / `payment.verified` check in `activity-event-row.tsx` gates on `event.metadata !== null` before reading `metadata.programName` etc.
23. `pnpm lint` passes with zero new warnings. No `eslint-disable` comments added.
24. Smoke test passes end-to-end (see §Smoke Test Script below).

---

## Subphase Dependency Graph

```
9A (3 shared filter components)  ──┐
                                    │
                                    ├─▶ 9B (Revenue report rewrite)    ──┐
                                    │                                    │
                                    ├─▶ 9C (Reminders report extension) ──┤
                                    │                                    ├─▶ 9G (verification pass)
                                    └─▶ 9F (Activity feed extension)    ──┤
                                                                         │
9D (Team report refresh)          ──────────────────────────────────────┤
                                                                         │
9E (Dashboard stats row rewrite)  ──────────────────────────────────────┘
```

**Edges explained:**

- **9A → 9B / 9C / 9F:** the three shared filter components are imported by these three subphases. 9A must land before 9B / 9C / 9F compile. 9A is a small PR (three tiny files); one developer writes it in 30–45 min.
- **9D and 9E are independent:** Team report and Dashboard stats do NOT compose the new filter components. They only bind to Phase 5's return shape extensions. Three parallel streams.
- **9G is serial last:** grep sweep + typecheck + lint + smoke test. Run after all code-touching subphases land.

**Optimal execution:**

1. **Ship 9A first** (1–2 hours). Three tiny files, no DB reads beyond the existing `listPrograms` query. Merge + tsc. This unblocks 9B / 9C / 9F.
2. **After 9A lands, start 9B + 9C + 9D + 9E + 9F in parallel.** Five independent streams across five different file clusters.
   - **9B is the largest** — revenue report rewrite: adds 3 new components (`revenue-kpi-cards`, `revenue-by-program-section`, `revenue-by-payment-type-section`), modifies 4 existing files (`revenue-report-page-client`, `revenue-trend-chart`, `revenue-by-origin-chart`, `top-deals-table`). Estimate half a day solo.
   - **9C is small** — reminders report: two files modified. Estimate 1–2 hours.
   - **9D is medium** — team report: four files, mostly label/subtext changes + one new card. Estimate 2 hours.
   - **9E is small** — dashboard: two files, one grid rewrite. Estimate 1–2 hours.
   - **9F is medium** — activity feed: three files, badge rendering + two new filters. Estimate 2 hours.
3. **After all five land, run 9G.** Grep + typecheck + lint + full end-to-end smoke test.

**Estimated time:** 2 days solo, 1 day with four parallel streams after 9A lands.

---

## Subphases

### 9A — Shared Report Filter Components (Program + Payment Type + Revenue Slice)

**Type:** Frontend (`"use client"`)
**Parallelizable:** No — serial gate for 9B / 9C / 9F.

**What:** Create three new components under `app/workspace/reports/_components/` that every filter-bearing report imports. Each component is a thin wrapper around shadcn's `<Select>` + `<SelectContent>` + `<SelectItem>` pattern, following the convention already established by `activity-feed-filters.tsx` (use a `"__all__"` sentinel internally, expose `value: string | undefined` externally).

**Why:** The three report pages (Revenue, Reminders, Activity Feed) all need the same "Program" / "Payment Type" / "Revenue Slice" filter triad. Duplicating the fetch + state + sentinel logic across three files invites drift (e.g., one caller uses `"none"` as the sentinel, another uses `""`, and now the backend sees inconsistent optional-arg handling). Composition > configuration: three small components, each imported where needed, each with a single responsibility.

**Where:**
- `app/workspace/reports/_components/report-program-filter.tsx` (new)
- `app/workspace/reports/_components/report-payment-type-filter.tsx` (new)
- `app/workspace/reports/_components/report-revenue-slice-filter.tsx` (new)

**How:**

**Step 1: `report-program-filter.tsx`**

```tsx
// Path: app/workspace/reports/_components/report-program-filter.tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";

const ALL_SENTINEL = "__all__";

interface ReportProgramFilterProps {
  value?: Id<"tenantPrograms">;
  onChange: (next: Id<"tenantPrograms"> | undefined) => void;
  disabled?: boolean;
}

/**
 * Shared "Program" filter used across Revenue, Reminders, and Activity Feed
 * reports. Fetches active + archived programs (reporting surfaces archived
 * programs per design §2.6 so historical slices remain accessible); caller
 * receives `undefined` when the user selects "All Programs".
 */
export function ReportProgramFilter({
  value,
  onChange,
  disabled,
}: ReportProgramFilterProps) {
  const programs = useQuery(api.tenantPrograms.queries.listPrograms, {
    includeArchived: true,
  });

  // Hide the filter entirely when the tenant has no programs (onboarding edge case).
  // The query loads tiny lists; the undefined state covers loading.
  if (programs !== undefined && programs.length === 0) {
    return null;
  }

  const isLoading = programs === undefined;
  const activePrograms = programs?.filter((p) => p.archivedAt === undefined) ?? [];
  const archivedPrograms = programs?.filter((p) => p.archivedAt !== undefined) ?? [];

  return (
    <Select
      value={value ?? ALL_SENTINEL}
      onValueChange={(next) => {
        if (next === ALL_SENTINEL) {
          onChange(undefined);
        } else {
          onChange(next as Id<"tenantPrograms">);
        }
      }}
      disabled={disabled || isLoading}
    >
      <SelectTrigger className="w-[200px]" aria-label="Filter by program">
        <SelectValue placeholder="Program" />
        {isLoading ? <Spinner className="ml-2 size-3" /> : null}
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Program</SelectLabel>
          <SelectItem value={ALL_SENTINEL}>All Programs</SelectItem>
        </SelectGroup>
        {activePrograms.length > 0 ? (
          <SelectGroup>
            <SelectLabel>Active</SelectLabel>
            {activePrograms.map((program) => (
              <SelectItem key={program._id} value={program._id}>
                {program.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}
        {archivedPrograms.length > 0 ? (
          <SelectGroup>
            <SelectLabel>Archived</SelectLabel>
            {archivedPrograms.map((program) => (
              <SelectItem key={program._id} value={program._id}>
                {program.name} <span className="ml-1 text-muted-foreground">(archived)</span>
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}
      </SelectContent>
    </Select>
  );
}
```

**Step 2: `report-payment-type-filter.tsx`**

```tsx
// Path: app/workspace/reports/_components/report-payment-type-filter.tsx
"use client";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ALL_SENTINEL = "__all__";

type PaymentType = "pif" | "split" | "monthly" | "deposit";

const PAYMENT_TYPE_OPTIONS: Array<{ value: PaymentType; label: string }> = [
  { value: "pif", label: "PIF (Paid in Full)" },
  { value: "split", label: "Split Payment" },
  { value: "monthly", label: "Monthly" },
  { value: "deposit", label: "Deposit" },
];

interface ReportPaymentTypeFilterProps {
  value?: PaymentType;
  onChange: (next: PaymentType | undefined) => void;
  disabled?: boolean;
}

/**
 * Shared "Payment Type" filter — stateless, four literal options. Used across
 * Revenue, Reminders, and Activity Feed reports.
 */
export function ReportPaymentTypeFilter({
  value,
  onChange,
  disabled,
}: ReportPaymentTypeFilterProps) {
  return (
    <Select
      value={value ?? ALL_SENTINEL}
      onValueChange={(next) => {
        if (next === ALL_SENTINEL) {
          onChange(undefined);
        } else {
          onChange(next as PaymentType);
        }
      }}
      disabled={disabled}
    >
      <SelectTrigger className="w-[180px]" aria-label="Filter by payment type">
        <SelectValue placeholder="Payment Type" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Payment Type</SelectLabel>
          <SelectItem value={ALL_SENTINEL}>All Payment Types</SelectItem>
          {PAYMENT_TYPE_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export type { PaymentType };
```

**Step 3: `report-revenue-slice-filter.tsx`**

```tsx
// Path: app/workspace/reports/_components/report-revenue-slice-filter.tsx
"use client";

import { InfoIcon } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

const ALL_SENTINEL = "__all__";

type RevenueSlice = "commissionable" | "non_commissionable";

interface ReportRevenueSliceFilterProps {
  value?: RevenueSlice;
  onChange: (next: RevenueSlice | undefined) => void;
  disabled?: boolean;
}

/**
 * Shared "Revenue Slice" filter — slices payments by attribution scope.
 * Commissionable payments are attributed to a closer (from meeting / reminder /
 * review-resolution flows). Post-conversion payments are logged by admins
 * against a customer after their deal closed and are not attributed.
 */
export function ReportRevenueSliceFilter({
  value,
  onChange,
  disabled,
}: ReportRevenueSliceFilterProps) {
  return (
    <div className="flex items-center gap-1">
      <Select
        value={value ?? ALL_SENTINEL}
        onValueChange={(next) => {
          if (next === ALL_SENTINEL) {
            onChange(undefined);
          } else {
            onChange(next as RevenueSlice);
          }
        }}
        disabled={disabled}
      >
        <SelectTrigger className="w-[200px]" aria-label="Filter by revenue slice">
          <SelectValue placeholder="Revenue Slice" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Revenue Slice</SelectLabel>
            <SelectItem value={ALL_SENTINEL}>All Revenue</SelectItem>
            <SelectItem value="commissionable">Commissionable</SelectItem>
            <SelectItem value="non_commissionable">Post-Conversion</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>

      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="What is revenue slice?"
          >
            <InfoIcon className="size-4 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 text-sm" align="start">
          <p>
            <strong>Commissionable</strong> revenue is attributed to a closer
            (earned from a meeting, reminder, or review-resolution flow).
          </p>
          <p className="mt-2">
            <strong>Post-Conversion</strong> revenue is logged by admins against
            a customer after their deal closed and is not attributed to any
            closer.
          </p>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export type { RevenueSlice };
```

**Acceptance for 9A:**

- All three files exist, export their components, and compile cleanly with `pnpm tsc --noEmit`.
- `<ReportProgramFilter>` renders a loading state (disabled select + spinner) while `listPrograms` resolves; renders null when the tenant has zero programs.
- `<ReportPaymentTypeFilter>` renders the four payment types in the order `PIF → Split → Monthly → Deposit`.
- `<ReportRevenueSliceFilter>` renders the help popover on icon click.
- Each component's `onChange` emits `undefined` when the user selects the `All …` sentinel.
- No Convex query is made unless `<ReportProgramFilter>` is mounted (the other two are stateless).

---

### 9B — Revenue Report UI Rewrite

**Type:** Frontend (`"use client"`)
**Parallelizable:** With 9C / 9D / 9E / 9F after 9A lands.

**What:** Rewire `revenue-report-page-client.tsx` to render the four-way split KPIs, two new breakdown sections, the four-series trend chart, and the updated top-deals + by-origin charts. Create three new components (`revenue-kpi-cards`, `revenue-by-program-section`, `revenue-by-payment-type-section`). Modify four existing components.

**Why:** Phase 5 reshaped the revenue backend from a single `{ totalRevenueMinor, byOrigin, byCloser, topDeals }` shape to a nested `{ commissionable: { finalRevenueMinor, depositRevenueMinor, byOrigin, byCloser, byProgram, totalDeals, avgDealMinor }, nonCommissionable: { finalRevenueMinor, depositRevenueMinor, byProgram, totalDeals }, byPaymentType: { commissionable, nonCommissionable }, isPaymentDataTruncated }`. The existing revenue report page is hard-wired to the old shape — every consumer breaks at tsc as soon as Phase 5 lands. This subphase is the frontend catch-up.

**Where:**
- `app/workspace/reports/revenue/_components/revenue-report-page-client.tsx` (modify)
- `app/workspace/reports/revenue/_components/revenue-kpi-cards.tsx` (new)
- `app/workspace/reports/revenue/_components/revenue-by-program-section.tsx` (new)
- `app/workspace/reports/revenue/_components/revenue-by-payment-type-section.tsx` (new)
- `app/workspace/reports/revenue/_components/revenue-trend-chart.tsx` (rewrite)
- `app/workspace/reports/revenue/_components/revenue-by-origin-chart.tsx` (modify — origin keys)
- `app/workspace/reports/revenue/_components/top-deals-table.tsx` (modify — two new columns)

**How:**

**Step 1: Rewrite `revenue-report-page-client.tsx`**

```tsx
// Path: app/workspace/reports/revenue/_components/revenue-report-page-client.tsx (AFTER)
"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { startOfMonth, endOfMonth } from "date-fns";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePageTitle } from "@/hooks/use-page-title";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ReportDateControls,
  type DateRange,
  type Granularity,
} from "../../_components/report-date-controls";
import { ReportProgramFilter } from "../../_components/report-program-filter";
import {
  ReportPaymentTypeFilter,
  type PaymentType,
} from "../../_components/report-payment-type-filter";
import {
  ReportRevenueSliceFilter,
  type RevenueSlice,
} from "../../_components/report-revenue-slice-filter";
import { RevenueReportSkeleton } from "./revenue-report-skeleton";
import { RevenueByOriginChart } from "./revenue-by-origin-chart";
import { RevenueTrendChart } from "./revenue-trend-chart";
import { RevenueKpiCards } from "./revenue-kpi-cards";
import { RevenueByProgramSection } from "./revenue-by-program-section";
import { RevenueByPaymentTypeSection } from "./revenue-by-payment-type-section";
import { CloserRevenueTable } from "./closer-revenue-table";
import { DealSizeDistribution } from "./deal-size-distribution";
import { TopDealsTable } from "./top-deals-table";

function getDefaultDateRange(): DateRange {
  const now = new Date();
  return {
    startDate: startOfMonth(now).getTime(),
    endDate: endOfMonth(now).getTime(),
  };
}

export function RevenueReportPageClient() {
  usePageTitle("Revenue");

  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange);
  const [granularity, setGranularity] = useState<Granularity>("month");

  // NEW — three filter states feeding into all three backend queries.
  const [programId, setProgramId] = useState<Id<"tenantPrograms"> | undefined>(
    undefined,
  );
  const [paymentType, setPaymentType] = useState<PaymentType | undefined>(
    undefined,
  );
  const [revenueSlice, setRevenueSlice] = useState<RevenueSlice | undefined>(
    undefined,
  );

  const queryArgs = {
    ...dateRange,
    ...(programId ? { programId } : {}),
    ...(paymentType ? { paymentType } : {}),
    ...(revenueSlice ? { revenueSlice } : {}),
  };

  const metrics = useQuery(api.reporting.revenue.getRevenueMetrics, queryArgs);
  const details = useQuery(api.reporting.revenue.getRevenueDetails, queryArgs);
  const trend = useQuery(api.reporting.revenueTrend.getRevenueTrend, {
    ...queryArgs,
    granularity,
  });

  const allLoading =
    metrics === undefined && details === undefined && trend === undefined;

  if (allLoading) {
    return <RevenueReportSkeleton />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Revenue</h1>
        <p className="text-sm text-muted-foreground">
          Revenue trends, per-closer breakdown, and deal analysis. Filter by
          program, payment type, or revenue slice to drill down.
        </p>
      </div>

      <ReportDateControls
        value={dateRange}
        onChange={setDateRange}
        showGranularity
        granularity={granularity}
        onGranularityChange={setGranularity}
      />

      {/* Filter bar — three new report-scoped filters */}
      <div
        className="flex flex-wrap items-center gap-2"
        aria-label="Revenue report filters"
      >
        <ReportProgramFilter value={programId} onChange={setProgramId} />
        <ReportPaymentTypeFilter
          value={paymentType}
          onChange={setPaymentType}
        />
        <ReportRevenueSliceFilter
          value={revenueSlice}
          onChange={setRevenueSlice}
        />
      </div>

      {/* KPI cards — four-way split */}
      {metrics !== undefined ? (
        <RevenueKpiCards metrics={metrics} />
      ) : (
        <Skeleton className="h-32 rounded-lg" />
      )}

      {/* Trend + byOrigin (unchanged layout, new series/keys internally) */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(20rem,0.9fr)]">
        {trend !== undefined ? (
          <RevenueTrendChart data={trend.trend} />
        ) : (
          <Skeleton className="h-[260px] rounded-lg" />
        )}

        {metrics !== undefined ? (
          <RevenueByOriginChart byOrigin={metrics.commissionable.byOrigin} />
        ) : (
          <Skeleton className="h-[260px] rounded-lg" />
        )}
      </div>

      {/* NEW — by-program + by-payment-type sections */}
      {metrics !== undefined ? (
        <>
          <RevenueByProgramSection metrics={metrics} />
          <RevenueByPaymentTypeSection metrics={metrics} />
        </>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {metrics !== undefined ? (
          <CloserRevenueTable
            byCloser={metrics.commissionable.byCloser}
            totalRevenueMinor={metrics.commissionable.finalRevenueMinor}
            totalDeals={metrics.commissionable.totalDeals}
            avgDealMinor={metrics.commissionable.avgDealMinor}
          />
        ) : (
          <Skeleton className="h-64 rounded-lg" />
        )}

        {details !== undefined ? (
          <DealSizeDistribution distribution={details.dealSizeDistribution} />
        ) : (
          <Skeleton className="h-64 rounded-lg" />
        )}
      </div>

      {details !== undefined ? (
        <TopDealsTable deals={details.topDeals} />
      ) : (
        <Skeleton className="h-48 rounded-lg" />
      )}
    </div>
  );
}
```

Key changes from the current file:
- Three new state slots feed all three queries.
- `<ReportProgramFilter>` / `<ReportPaymentTypeFilter>` / `<ReportRevenueSliceFilter>` live in a new filter-bar div.
- `<RevenueKpiCards>` renders at the top of the body.
- `<RevenueByProgramSection>` + `<RevenueByPaymentTypeSection>` render between the origin chart and the per-closer table.
- `<CloserRevenueTable>` now reads from `metrics.commissionable.byCloser` / `finalRevenueMinor` / `totalDeals` / `avgDealMinor` (nested under `commissionable`).
- `<RevenueByOriginChart>` reads from `metrics.commissionable.byOrigin` (was `metrics.byOrigin`).

**Step 2: Create `revenue-kpi-cards.tsx`**

```tsx
// Path: app/workspace/reports/revenue/_components/revenue-kpi-cards.tsx (new)
"use client";

import {
  CoinsIcon,
  DollarSignIcon,
  HandCoinsIcon,
  WalletIcon,
} from "lucide-react";
import { StatsCard } from "@/app/workspace/_components/stats-card";
import { formatCurrency } from "@/lib/format-currency";

interface RevenueKpiCardsProps {
  metrics: {
    commissionable: {
      finalRevenueMinor: number;
      depositRevenueMinor: number;
      totalDeals: number;
    };
    nonCommissionable: {
      finalRevenueMinor: number;
      depositRevenueMinor: number;
      totalDeals: number;
    };
  };
}

export function RevenueKpiCards({ metrics }: RevenueKpiCardsProps) {
  const { commissionable, nonCommissionable } = metrics;

  return (
    <div
      className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4"
      role="group"
      aria-label="Revenue KPIs for the selected date range"
    >
      <StatsCard
        icon={DollarSignIcon}
        label="Commissionable Final"
        value={formatCurrency(commissionable.finalRevenueMinor / 100, "USD")}
        subtext={`${commissionable.totalDeals} deal${commissionable.totalDeals === 1 ? "" : "s"}`}
        variant={commissionable.finalRevenueMinor > 0 ? "success" : "default"}
      />
      <StatsCard
        icon={HandCoinsIcon}
        label="Commissionable Deposits"
        value={formatCurrency(commissionable.depositRevenueMinor / 100, "USD")}
        subtext="Deposits recorded in range"
      />
      <StatsCard
        icon={CoinsIcon}
        label="Post-Conversion Final"
        value={formatCurrency(nonCommissionable.finalRevenueMinor / 100, "USD")}
        subtext={`${nonCommissionable.totalDeals} customer payment${nonCommissionable.totalDeals === 1 ? "" : "s"}`}
      />
      <StatsCard
        icon={WalletIcon}
        label="Post-Conversion Deposits"
        value={formatCurrency(
          nonCommissionable.depositRevenueMinor / 100,
          "USD",
        )}
        subtext="Customer deposits recorded in range"
      />
    </div>
  );
}
```

**Step 3: Create `revenue-by-program-section.tsx`**

```tsx
// Path: app/workspace/reports/revenue/_components/revenue-by-program-section.tsx (new)
"use client";

import { BarChart3Icon } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { formatCurrency } from "@/lib/format-currency";

interface RevenueByProgramSectionProps {
  metrics: {
    commissionable: {
      byProgram: Array<{
        programId: string;
        programName: string;
        revenueMinor: number;
        dealCount: number;
      }>;
    };
    nonCommissionable: {
      byProgram: Array<{
        programId: string;
        programName: string;
        revenueMinor: number;
        dealCount: number;
      }>;
    };
  };
}

function BreakdownColumn({
  title,
  rows,
  emptyMessage,
  accentColor,
}: {
  title: string;
  rows: RevenueByProgramSectionProps["metrics"]["commissionable"]["byProgram"];
  emptyMessage: string;
  accentColor: string;
}) {
  const sorted = [...rows].sort((a, b) => b.revenueMinor - a.revenueMinor);
  const maxRevenue = sorted.reduce(
    (max, row) => (row.revenueMinor > max ? row.revenueMinor : max),
    0,
  );

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">{title}</h3>
      {sorted.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {emptyMessage}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {sorted.map((row) => {
            const widthPct =
              maxRevenue > 0 ? (row.revenueMinor / maxRevenue) * 100 : 0;
            return (
              <div key={row.programId} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate font-medium">
                    {row.programName}
                  </span>
                  <div className="flex items-center gap-3 text-right tabular-nums">
                    <span>{formatCurrency(row.revenueMinor / 100, "USD")}</span>
                    <span className="text-xs text-muted-foreground">
                      {row.dealCount} deal{row.dealCount === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${widthPct}%`,
                      backgroundColor: accentColor,
                    }}
                    aria-hidden="true"
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function RevenueByProgramSection({
  metrics,
}: RevenueByProgramSectionProps) {
  const bothEmpty =
    metrics.commissionable.byProgram.length === 0 &&
    metrics.nonCommissionable.byProgram.length === 0;

  if (bothEmpty) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Revenue by Program</CardTitle>
          <CardDescription>
            Revenue split per program, commissionable and post-conversion.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Empty className="min-h-[180px] border-0">
            <EmptyMedia variant="icon">
              <BarChart3Icon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No revenue by program in this range</EmptyTitle>
              <EmptyDescription>
                Adjust the date range or filters to inspect program-level
                breakdowns.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue by Program</CardTitle>
        <CardDescription>
          Revenue split per program, commissionable and post-conversion.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <BreakdownColumn
            title="Commissionable"
            rows={metrics.commissionable.byProgram}
            emptyMessage="No commissionable revenue in this range"
            accentColor="var(--chart-1)"
          />
          <BreakdownColumn
            title="Post-Conversion"
            rows={metrics.nonCommissionable.byProgram}
            emptyMessage="No post-conversion revenue in this range"
            accentColor="var(--chart-4)"
          />
        </div>
      </CardContent>
    </Card>
  );
}
```

**Step 4: Create `revenue-by-payment-type-section.tsx`**

```tsx
// Path: app/workspace/reports/revenue/_components/revenue-by-payment-type-section.tsx (new)
"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatCurrency } from "@/lib/format-currency";

type PaymentTypeKey = "pif" | "split" | "monthly" | "deposit";

const PAYMENT_TYPE_LABELS: Record<PaymentTypeKey, string> = {
  pif: "PIF",
  split: "Split",
  monthly: "Monthly",
  deposit: "Deposit",
};

interface RevenueByPaymentTypeSectionProps {
  metrics: {
    byPaymentType: {
      commissionable: Record<PaymentTypeKey, number>;
      nonCommissionable: Record<PaymentTypeKey, number>;
    };
  };
}

export function RevenueByPaymentTypeSection({
  metrics,
}: RevenueByPaymentTypeSectionProps) {
  const { commissionable, nonCommissionable } = metrics.byPaymentType;

  // Compute max across both slices for bar scaling.
  const allValues = [
    ...Object.values(commissionable),
    ...Object.values(nonCommissionable),
  ];
  const maxValue = allValues.reduce(
    (max, v) => (v > max ? v : max),
    0,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue by Payment Type</CardTitle>
        <CardDescription>
          Commissionable versus post-conversion revenue, broken down by payment
          structure.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {(Object.keys(PAYMENT_TYPE_LABELS) as PaymentTypeKey[]).map((key) => {
            const commAmount = commissionable[key];
            const nonCommAmount = nonCommissionable[key];
            const commWidth =
              maxValue > 0 ? (commAmount / maxValue) * 100 : 0;
            const nonCommWidth =
              maxValue > 0 ? (nonCommAmount / maxValue) * 100 : 0;

            return (
              <div
                key={key}
                className="flex flex-col gap-3 rounded-lg border p-3"
              >
                <h3 className="text-sm font-medium">
                  {PAYMENT_TYPE_LABELS[key]}
                </h3>

                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Commissionable</span>
                    <span className="font-medium tabular-nums">
                      {commAmount > 0
                        ? formatCurrency(commAmount / 100, "USD")
                        : "\u2014"}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${commWidth}%`,
                        backgroundColor: "var(--chart-1)",
                      }}
                      aria-hidden="true"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Post-Conv</span>
                    <span className="font-medium tabular-nums">
                      {nonCommAmount > 0
                        ? formatCurrency(nonCommAmount / 100, "USD")
                        : "\u2014"}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${nonCommWidth}%`,
                        backgroundColor: "var(--chart-4)",
                      }}
                      aria-hidden="true"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
```

**Step 5: Rewrite `revenue-trend-chart.tsx`**

```tsx
// Path: app/workspace/reports/revenue/_components/revenue-trend-chart.tsx (AFTER)
"use client";

import { Line, LineChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface RevenueTrendChartProps {
  data: Array<{
    periodKey: string;
    commissionableFinalMinor: number;
    commissionableDepositMinor: number;
    nonCommissionableFinalMinor: number;
    nonCommissionableDepositMinor: number;
    commissionableFinalDealCount: number;
    nonCommissionableFinalDealCount: number;
  }>;
}

const chartConfig = {
  commissionableFinal: {
    label: "Commissionable Final",
    color: "var(--chart-1)",
  },
  commissionableDeposit: {
    label: "Commissionable Deposits",
    color: "var(--chart-2)",
  },
  nonCommissionableFinal: {
    label: "Post-Conv Final",
    color: "var(--chart-3)",
  },
  nonCommissionableDeposit: {
    label: "Post-Conv Deposits",
    color: "var(--chart-4)",
  },
} satisfies ChartConfig;

function formatYAxis(value: number): string {
  if (value >= 1000) {
    return `$${(value / 1000).toFixed(0)}k`;
  }
  return `$${value}`;
}

export function RevenueTrendChart({ data }: RevenueTrendChartProps) {
  const chartData = data.map((point) => ({
    ...point,
    commissionableFinal: point.commissionableFinalMinor / 100,
    commissionableDeposit: point.commissionableDepositMinor / 100,
    nonCommissionableFinal: point.nonCommissionableFinalMinor / 100,
    nonCommissionableDeposit: point.nonCommissionableDepositMinor / 100,
  }));

  const hasAnyData = chartData.some(
    (p) =>
      p.commissionableFinal > 0 ||
      p.commissionableDeposit > 0 ||
      p.nonCommissionableFinal > 0 ||
      p.nonCommissionableDeposit > 0,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue Trend</CardTitle>
      </CardHeader>
      <CardContent>
        {!hasAnyData ? (
          <div className="flex min-h-[260px] items-center justify-center">
            <p className="text-sm text-muted-foreground">
              No revenue data for this period
            </p>
          </div>
        ) : (
          <ChartContainer
            config={chartConfig}
            className="h-[260px] w-full aspect-auto"
          >
            <LineChart accessibilityLayer data={chartData}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="periodKey"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
              />
              <YAxis
                tickFormatter={formatYAxis}
                tickLine={false}
                axisLine={false}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value) =>
                      `$${Number(value).toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}`
                    }
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              {/* Primary series — commissionable final */}
              <Line
                type="monotone"
                dataKey="commissionableFinal"
                stroke="var(--color-commissionableFinal)"
                strokeWidth={2.5}
                dot={false}
              />
              {/* Secondary commissionable — deposits */}
              <Line
                type="monotone"
                dataKey="commissionableDeposit"
                stroke="var(--color-commissionableDeposit)"
                strokeWidth={1.5}
                dot={false}
              />
              {/* Post-conversion — dashed to visually group */}
              <Line
                type="monotone"
                dataKey="nonCommissionableFinal"
                stroke="var(--color-nonCommissionableFinal)"
                strokeWidth={1.5}
                strokeDasharray="4 4"
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="nonCommissionableDeposit"
                stroke="var(--color-nonCommissionableDeposit)"
                strokeWidth={1.5}
                strokeDasharray="4 4"
                dot={false}
              />
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
```

**Step 6: Modify `revenue-by-origin-chart.tsx` — rewrite `ORIGIN_META`**

```tsx
// Path: app/workspace/reports/revenue/_components/revenue-by-origin-chart.tsx (key changes only)

// REPLACE the current ORIGIN_META constant (lines 18-39) with:
const ORIGIN_META = {
  closer_meeting: {
    label: "Closer · Meeting",
    color: "var(--chart-1)",
  },
  closer_reminder: {
    label: "Closer · Reminder",
    color: "var(--chart-2)",
  },
  admin_meeting: {
    label: "Admin · Meeting",
    color: "var(--chart-3)",
  },
  admin_reminder: {
    label: "Admin · Reminder",
    color: "var(--chart-4)",
  },
  admin_review_resolution: {
    label: "Admin · Review Resolution",
    color: "var(--chart-5)",
  },
} as const;
```

The `customer_flow` entry (line 30-33) and the `unknown` entry (line 34-37) are **deleted**. Phase 5 scopes `metrics.commissionable.byOrigin` to the five `COMMISSIONABLE_ORIGINS` only — the non-commissionable origin and legacy bucket never appear in this chart's input.

The rest of the component body (`chartData`, `formatCurrency`, `RevenueByOriginChart`) is unchanged — it already derives chart data from `Object.entries(ORIGIN_META)` so it adapts to the new keyspace automatically.

**Step 7: Modify `top-deals-table.tsx` — add Program + Payment Type columns**

```tsx
// Path: app/workspace/reports/revenue/_components/top-deals-table.tsx (AFTER)
"use client";

import { format } from "date-fns";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface TopDealsTableProps {
  deals: Array<{
    paymentRecordId: string;
    amountMinor: number;
    currency: string;
    attributedCloserId: string | null;
    attributedCloserName: string | null;
    contextType: string;
    customerId: string | null;
    meetingId: string | null;
    opportunityId: string | null;
    originatingOpportunityId: string | null;
    programId: string;
    programName: string | null;
    paymentType: "pif" | "split" | "monthly" | "deposit";
    origin: string;
    recordedAt: number;
  }>;
}

function formatCurrency(minor: number): string {
  return `$${(minor / 100).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

function formatSource(contextType: string): string {
  if (!contextType) return "\u2014";
  return contextType.charAt(0).toUpperCase() + contextType.slice(1);
}

function formatPaymentType(pt: string): string {
  return pt.charAt(0).toUpperCase() + pt.slice(1);
}

export function TopDealsTable({ deals }: TopDealsTableProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top 10 Deals</CardTitle>
      </CardHeader>
      <CardContent>
        {deals.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No deals recorded in this period
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Program</TableHead>
                <TableHead>Payment Type</TableHead>
                <TableHead>Closer</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deals.map((deal, index) => (
                <TableRow key={deal.paymentRecordId}>
                  <TableCell>{index + 1}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(deal.amountMinor)}
                  </TableCell>
                  <TableCell>{deal.programName ?? "\u2014"}</TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="text-[11px]">
                      {formatPaymentType(deal.paymentType)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {deal.attributedCloserName ?? "\u2014"}
                  </TableCell>
                  <TableCell>
                    {format(deal.recordedAt, "MMM d, yyyy")}
                  </TableCell>
                  <TableCell>{formatSource(deal.contextType)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
```

Key changes from current file:
- Props interface widened to match the Phase 5 `topDeals` row shape (now 15 fields instead of 5).
- `closerName` → `attributedCloserName` (rename).
- Two new columns inserted between `Amount` and `Closer`: `Program` (plain text) and `Payment Type` (as a `<Badge>`).

**Acceptance for 9B:**

- `revenue-report-page-client.tsx` compiles with the three new state slots and passes them to all three queries.
- The filter bar renders above the chart grid with all three filters visible.
- The four KPI cards render in a 1/2/4 responsive grid at the top of the report body.
- The by-program and by-payment-type sections render between the by-origin chart and the per-closer table.
- The trend chart draws four lines (commissionable-final solid primary, commissionable-deposit solid thinner, the two non-commissionable dashed).
- The by-origin chart shows the 5 commissionable origins only (no `customer_flow`, no `unknown`).
- The top-deals table shows `Program` and `Payment Type` columns with correct data for each row.
- `pnpm tsc --noEmit` passes; no `any` / `unknown` widening introduced.

---

### 9C — Reminders Report Extension

**Type:** Frontend (`"use client"`)
**Parallelizable:** With 9B / 9D / 9E / 9F after 9A lands.

**What:** Add program + paymentType filter state to `reminders-report-page-client.tsx`, pass through to `getReminderOutcomeFunnel`, and rewrite `reminder-driven-revenue-card.tsx` to show the final-vs-deposit split.

**Why:** Phase 5 broadened `getReminderOutcomeFunnel` to accept optional `programId` / `paymentType` filters (reminder-revenue slice only), and split the old `reminderDrivenRevenueMinor` into `reminderDrivenFinalRevenueMinor` + `reminderDrivenDepositRevenueMinor` while keeping the compat sum. The UI needs to surface both the filters and the split.

**Where:**
- `app/workspace/reports/reminders/_components/reminders-report-page-client.tsx` (modify)
- `app/workspace/reports/reminders/_components/reminder-driven-revenue-card.tsx` (rewrite)

**How:**

**Step 1: Modify `reminders-report-page-client.tsx`**

Insert after the existing `useState<DateRange>` call:

```tsx
// Path: app/workspace/reports/reminders/_components/reminders-report-page-client.tsx
import type { Id } from "@/convex/_generated/dataModel";
import { ReportProgramFilter } from "../../_components/report-program-filter";
import {
  ReportPaymentTypeFilter,
  type PaymentType,
} from "../../_components/report-payment-type-filter";

// Inside the component body:
const [programId, setProgramId] = useState<Id<"tenantPrograms"> | undefined>(
  undefined,
);
const [paymentType, setPaymentType] = useState<PaymentType | undefined>(
  undefined,
);

const queryArgs = {
  ...dateRange,
  ...(programId ? { programId } : {}),
  ...(paymentType ? { paymentType } : {}),
};

const data = useQuery(
  api.reporting.remindersReporting.getReminderOutcomeFunnel,
  queryArgs,
);
```

Update the JSX to render the filter bar next to `<ReportDateControls>`:

```tsx
// Replace the existing <ReportDateControls /> block with:
<div className="flex flex-wrap items-center gap-2">
  <ReportDateControls value={dateRange} onChange={setDateRange} />
  <ReportProgramFilter value={programId} onChange={setProgramId} />
  <ReportPaymentTypeFilter value={paymentType} onChange={setPaymentType} />
</div>
```

**Step 2: Rewrite `reminder-driven-revenue-card.tsx`**

```tsx
// Path: app/workspace/reports/reminders/_components/reminder-driven-revenue-card.tsx (AFTER)
"use client";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  formatCount,
  OUTCOME_META,
  type ReminderReportData,
} from "./reminders-report-config";

interface ReminderDrivenRevenueCardProps {
  data: ReminderReportData;
}

function formatDollars(minor: number): string {
  return `$${(minor / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function ReminderDrivenRevenueCard({
  data,
}: ReminderDrivenRevenueCardProps) {
  const paymentReceivedCount = data.outcomeMix.payment_received;
  const finalRevenue = data.reminderDrivenFinalRevenueMinor ?? 0;
  const depositRevenue = data.reminderDrivenDepositRevenueMinor ?? 0;
  // rollout compat — sum kept on the backend return shape
  const totalRevenue = data.reminderDrivenRevenueMinor;

  return (
    <Card className="bg-linear-to-br from-card via-card to-muted/40">
      <CardHeader>
        <Badge variant="outline" className="w-fit">
          Live attribution
        </Badge>
        <CardTitle>Reminder-Driven Revenue</CardTitle>
        <CardDescription>
          Non-disputed payments recorded from reminder resolution in this range.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex h-full flex-col gap-4">
        {/* Final-vs-deposit split */}
        <div className="rounded-2xl border bg-background/80 p-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
                Final Revenue
              </span>
              <span className="text-2xl font-semibold tabular-nums">
                {formatDollars(finalRevenue)}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
                Deposits
              </span>
              <span className="text-2xl font-semibold tabular-nums">
                {formatDollars(depositRevenue)}
              </span>
            </div>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            {formatCount(data.reminderDrivenPaymentCount)} payment
            {data.reminderDrivenPaymentCount === 1 ? "" : "s"} logged from the
            reminder flow. Total:{" "}
            <span className="font-medium tabular-nums">
              {formatDollars(totalRevenue)}
            </span>
            .
            {data.isReminderRevenueTruncated
              ? " Results were capped at 2,000 payments."
              : ""}
          </p>
        </div>

        {/* Leading signal — existing payment_received count */}
        <div className="rounded-2xl border bg-background/80 p-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-[0.22em] text-muted-foreground">
              Leading signal
            </span>
            <div className="flex items-end justify-between gap-3">
              <span className="text-3xl font-semibold tabular-nums">
                {formatCount(paymentReceivedCount)}
              </span>
              <span
                className="h-2 w-14 rounded-full"
                style={{
                  backgroundColor: OUTCOME_META.payment_received.color,
                }}
              />
            </div>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            reminders already ended with a structured
            `payment_received` outcome in this range.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
```

Key changes from current file:
- The single "Revenue captured" block is replaced with a 2-column grid showing `Final Revenue` and `Deposits`.
- The paragraph below shows the `reminderDrivenRevenueMinor` sum as "Total" for cross-check.
- The "Leading signal" block is unchanged.

**Acceptance for 9C:**

- `reminders-report-page-client.tsx` feeds `programId` / `paymentType` into `getReminderOutcomeFunnel` args.
- The filter bar renders inline with `<ReportDateControls>` (no new row for just two extra selects).
- `reminder-driven-revenue-card.tsx` shows two independent revenue values (Final and Deposits) and includes the compat total in the caption.
- When the backend truncates the revenue scan, the caption surfaces the `"Results were capped at 2,000 payments."` notice.

---

### 9D — Team Report Refresh

**Type:** Frontend (`"use client"`)
**Parallelizable:** Fully independent after 9A lands (does not import the shared filters).

**What:** Extend `team-report-types.ts` with the new `postConversionRevenueMinor` field, add a new KPI card for Post-Conversion Revenue, clarify column semantics on the per-closer table, and rename `Admin-Logged` → `Admin On Behalf` consistently.

**Why:** Phase 5's team-performance rewrite shifted `cashCollectedMinor` to mean "commissionable-final only" (was: all non-disputed payments). The existing UI labels do not surface this semantic. Without the rename and the additional KPI card, users reading the report cannot tell whether deposits are included in "Cash Collected" or which payments count toward "Admin-Logged".

**Where:**
- `app/workspace/reports/team/_components/team-report-page-client.tsx` (modify — pass new field)
- `app/workspace/reports/team/_components/team-report-types.ts` (extend `TeamTotals`)
- `app/workspace/reports/team/_components/team-kpi-summary-cards.tsx` (add Post-Conversion card + subtext clarifier)
- `app/workspace/reports/team/_components/closer-performance-table.tsx` (column title tooltips + rename)

**How:**

**Step 1: Extend `team-report-types.ts`**

> **Implementation note (Window 5):** No manual change required. `TeamTotals`
> is defined as `TeamPerformanceMetrics["teamTotals"]`, which is itself
> `FunctionReturnType<typeof api.reporting.teamPerformance.getTeamPerformanceMetrics>`.
> Once Phase 5 adds `postConversionRevenueMinor` to the query's return
> shape, TypeScript propagates the field automatically. The snippet below is
> retained for reference to show the final shape you should see when
> hovering the type in your editor — do not hand-copy it into the file.

Add to the existing `TeamTotals` interface:

```ts
// Path: app/workspace/reports/team/_components/team-report-types.ts
export interface TeamTotals {
  // ... existing fields ...

  /**
   * Commissionable-final revenue only. Excludes deposits and post-conversion
   * customer payments. Changed semantic in Phase 5 (was: all non-disputed
   * payments).
   */
  totalRevenueMinor: number;

  // NEW — Phase 5 team-level additions
  /**
   * Sum of nonCommissionable.finalRevenueMinor across all closers — team-level
   * post-conversion revenue logged by admins from the Customer page.
   */
  postConversionRevenueMinor: number;

  // ... rest of existing fields ...
}
```

The JSDoc annotation on `totalRevenueMinor` is the semantic documentation. No other fields change.

**Step 2: Modify `team-kpi-summary-cards.tsx`**

Update the `Cash Collected` card to include a semantic clarifier:

```tsx
// Path: app/workspace/reports/team/_components/team-kpi-summary-cards.tsx (key changes)

// Inside the first row of cards — update the Cash Collected card's subtext:
<Card size="sm">
  <CardHeader>
    <div className="flex items-center justify-between">
      <CardTitle className="text-sm font-medium text-muted-foreground">
        Cash Collected
      </CardTitle>
      <DollarSignIcon className="size-4 text-muted-foreground" />
    </div>
  </CardHeader>
  <CardContent>
    <div className="text-2xl font-bold tabular-nums">
      {formatCompactCurrency(totals.totalRevenueMinor)}
    </div>
    <p className="text-xs text-muted-foreground">
      {totals.totalSales} deal{totals.totalSales === 1 ? "" : "s"}
    </p>
    <p className="text-[10px] italic text-muted-foreground/80">
      Commissionable-final only
    </p>
  </CardContent>
</Card>
```

Extend the second row of cards from 3 to 4 by adding a Post-Conversion Revenue card:

```tsx
// Update the second <div> wrapper from xl:grid-cols-3 to xl:grid-cols-4:
<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
  {/* Existing: Lost Deals */}
  {/* Existing: Rebook Rate */}
  {/* Existing: Actions / Closer / Day */}

  {/* NEW — Post-Conversion Revenue */}
  <Card size="sm">
    <CardHeader>
      <div className="flex items-center justify-between">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Post-Conversion Revenue
        </CardTitle>
        <CoinsIcon className="size-4 text-muted-foreground" />
      </div>
    </CardHeader>
    <CardContent>
      <div className="text-2xl font-bold tabular-nums">
        {formatCompactCurrency(totals.postConversionRevenueMinor)}
      </div>
      <p className="text-xs text-muted-foreground">
        Admin-logged customer payments in range
      </p>
      <p className="text-[10px] italic text-muted-foreground/80">
        Not attributed to any closer
      </p>
    </CardContent>
  </Card>
</div>
```

Add the `CoinsIcon` import at the top of the file (already used in 9B for the revenue KPI card, consistency).

**Step 3: Modify `closer-performance-table.tsx`**

Update the two column headers with tooltips + one rename:

```tsx
// Path: app/workspace/reports/team/_components/closer-performance-table.tsx (key changes)

// In the <TableHeader> block:
<TableHead
  className="text-right"
  title="Commissionable-final payments attributed to this closer. Excludes deposits and post-conversion customer payments."
>
  Cash Collected
</TableHead>
<TableHead
  className="text-right"
  title="Commissionable revenue logged by an admin on this closer's behalf (recorded by \u2260 attributed closer)."
>
  Admin On Behalf
</TableHead>
```

The rest of the table is unchanged — the data fields on `CloserData` (`cashCollectedMinor`, `adminLoggedRevenueMinor`) keep their names; Phase 5's semantic shift is rendered as tooltip text, not a data-field rename.

**Step 4: No changes to `team-report-page-client.tsx` body** beyond ensuring it passes `metrics.teamTotals` through to `<TeamKpiSummaryCards>` unchanged — the new `postConversionRevenueMinor` field is picked up by TypeScript via the widened interface automatically.

**Acceptance for 9D:**

- `team-report-types.ts` exports the extended `TeamTotals` with `postConversionRevenueMinor`.
- The second KPI row shows 4 cards (was 3).
- The `Cash Collected` card has the italic "Commissionable-final only" clarifier.
- The per-closer table shows `Admin On Behalf` (was `Admin-Logged`) with a tooltip on hover.
- `pnpm tsc --noEmit` passes — no consumer of `TeamTotals` breaks (the new field is additive).

---

### 9E — Dashboard Stats Row Rewrite

**Type:** Frontend (`"use client"`)
**Parallelizable:** Fully independent (does not import the shared filters — dashboard is globally scoped).

**What:** Rewrite `stats-row.tsx` so the single `Revenue` card is replaced by a four-card cluster — `Revenue`, `Deposits`, `Post-Conv Revenue`, `Post-Conv Deposits` — in a second row below the four pipeline cards. Extend the inline interfaces in `dashboard-page-client.tsx` to pick up the four new fields from `getAdminDashboardStats` and `getTimePeriodStats`.

**Why:** Phase 5 turned a single dashboard revenue number into a four-way split. The four new fields (`revenueLogged`, `depositsCollected`, `postConversionRevenueLogged`, `postConversionDepositsLogged`) each answer a different question: "How much commissionable final revenue did we collect?" vs. "How much in deposits?" vs. "How much did admins record post-conversion?" — all shown together lets users see at a glance whether the pipeline is healthy, paying deposits, or relying on admin write-ins.

**Where:**
- `app/workspace/_components/stats-row.tsx` (rewrite)
- `app/workspace/_components/dashboard-page-client.tsx` (interface extensions)

**How:**

**Step 1: Rewrite `stats-row.tsx`**

```tsx
// Path: app/workspace/_components/stats-row.tsx (AFTER)
"use client";

import { StatsCard } from "./stats-card";
import { formatCurrency } from "@/lib/format-currency";
import {
  UsersIcon,
  TrendingUpIcon,
  CalendarIcon,
  TrophyIcon,
  DollarSignIcon,
  HandCoinsIcon,
  CoinsIcon,
  WalletIcon,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/** All-time aggregate stats from tenantStats summary doc. */
interface StaticStats {
  totalClosers: number;
  unmatchedClosers: number;
  totalTeamMembers: number;
  activeOpportunities: number;
  totalOpportunities: number;
  // Phase 5 additions — lifetime revenue splits (read from tenantStats)
  revenueLogged: number;
  depositsCollected: number;
  postConversionRevenueLogged: number;
  postConversionDepositsLogged: number;
}

/** Time-period scoped stats from getTimePeriodStats. */
interface PeriodStats {
  newOpportunities: number;
  meetingsInPeriod: number;
  wonDealsInPeriod: number;
  // Phase 5 additions — four-way period revenue splits
  closedWonInPeriod: number;
  depositsInPeriod: number;
  postConversionInPeriod: number;
  postConversionDepositsInPeriod: number;
  paymentCountInPeriod: number;
  newCustomers: number;
  // compat — sum of the four splits (not rendered; kept for rollout)
  revenueInPeriod: number;
}

interface StatsRowProps {
  stats: StaticStats;
  periodStats: PeriodStats | null;
  periodLabel: string;
}

function PeriodStatCardSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="size-5 rounded" />
        </div>
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-12" />
        <Skeleton className="mt-2 h-3 w-28" />
      </CardContent>
    </Card>
  );
}

export function StatsRow({ stats, periodStats, periodLabel }: StatsRowProps) {
  const activePercent =
    stats.totalOpportunities > 0
      ? Math.round(
          (stats.activeOpportunities / stats.totalOpportunities) * 100,
        )
      : 0;

  return (
    <div
      className="flex flex-col gap-4"
      role="region"
      aria-labelledby="dashboard-stats-heading"
      aria-live="polite"
      aria-atomic="false"
    >
      <h2 id="dashboard-stats-heading" className="sr-only">
        Workspace dashboard stats
      </h2>

      {/* Row 1 — pipeline overview (4 cards, unchanged content) */}
      <div
        className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4"
        aria-label="Pipeline overview"
      >
        <StatsCard
          icon={UsersIcon}
          label="Total Closers"
          value={stats.totalClosers}
          subtext={
            stats.unmatchedClosers > 0
              ? `${stats.unmatchedClosers} unmatched`
              : "All matched"
          }
          variant={stats.unmatchedClosers > 0 ? "warning" : "default"}
        />

        <StatsCard
          icon={TrendingUpIcon}
          label="Active Opportunities"
          value={stats.activeOpportunities}
          subtext={`${activePercent}% of ${stats.totalOpportunities} total`}
        />

        {periodStats ? (
          <StatsCard
            icon={CalendarIcon}
            label="Meetings"
            value={periodStats.meetingsInPeriod}
            subtext={periodLabel}
          />
        ) : (
          <PeriodStatCardSkeleton />
        )}

        {periodStats ? (
          <StatsCard
            icon={TrophyIcon}
            label="Won Deals"
            value={periodStats.wonDealsInPeriod}
            subtext={periodLabel}
            variant={periodStats.wonDealsInPeriod > 0 ? "success" : "default"}
          />
        ) : (
          <PeriodStatCardSkeleton />
        )}
      </div>

      {/* Row 2 — four-way revenue split in period */}
      <div
        className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4"
        aria-label={`Revenue ${periodLabel.toLowerCase()}`}
      >
        {periodStats ? (
          <StatsCard
            icon={DollarSignIcon}
            label="Revenue"
            value={formatCurrency(periodStats.closedWonInPeriod, "USD")}
            subtext={`Commissionable final ${periodLabel.toLowerCase()}`}
            variant={periodStats.closedWonInPeriod > 0 ? "success" : "default"}
          />
        ) : (
          <PeriodStatCardSkeleton />
        )}

        {periodStats ? (
          <StatsCard
            icon={HandCoinsIcon}
            label="Deposits"
            value={formatCurrency(periodStats.depositsInPeriod, "USD")}
            subtext={`Deposits ${periodLabel.toLowerCase()}`}
          />
        ) : (
          <PeriodStatCardSkeleton />
        )}

        {periodStats ? (
          <StatsCard
            icon={CoinsIcon}
            label="Post-Conv Revenue"
            value={formatCurrency(periodStats.postConversionInPeriod, "USD")}
            subtext={`Admin-logged ${periodLabel.toLowerCase()}`}
          />
        ) : (
          <PeriodStatCardSkeleton />
        )}

        {periodStats ? (
          <StatsCard
            icon={WalletIcon}
            label="Post-Conv Deposits"
            value={formatCurrency(
              periodStats.postConversionDepositsInPeriod,
              "USD",
            )}
            subtext={`Customer deposits ${periodLabel.toLowerCase()}`}
          />
        ) : (
          <PeriodStatCardSkeleton />
        )}
      </div>
    </div>
  );
}
```

Key changes from current file:
- The `StaticStats` and `PeriodStats` interfaces gain the Phase 5 fields.
- The outer grid is flattened into a `flex flex-col gap-4` wrapper with two inner grids (pipeline overview, revenue split).
- The single `Revenue` card is replaced by a four-card row that reads the four new period fields.
- Icons chosen to visually distinguish commissionable (`DollarSignIcon`, `HandCoinsIcon`) from post-conversion (`CoinsIcon`, `WalletIcon`) and final (`DollarSignIcon`, `CoinsIcon`) from deposits (`HandCoinsIcon`, `WalletIcon`).

**Step 2: Extend inline interfaces in `dashboard-page-client.tsx`**

The interfaces in `stats-row.tsx` are the source of truth now (imported implicitly via the `StatsRow` props); `dashboard-page-client.tsx` does not need changes unless it defines its own local types. Per the current file (lines 102–104), it uses `stats: stats` directly without a local interface — TypeScript infers from Convex. No additional changes needed to `dashboard-page-client.tsx`.

However, if the dashboard loading check `if (!isAdmin || stats === undefined || !currentUser)` uses any inline property access on `stats`, confirm it still compiles after the return-shape change. The current check only reads `stats === undefined`, so no refactor required.

**Acceptance for 9E:**

- `stats-row.tsx` renders 8 cards total (4 pipeline + 4 revenue) in a stacked two-row layout.
- Each of the 4 revenue cards reads from a distinct `PeriodStats` field.
- The revenue card uses `variant="success"` when its value > 0; the other three default variants.
- Screen readers speak `"Pipeline overview"` for the first row and `"Revenue <period>"` for the second row (e.g., "Revenue today", "Revenue this week").
- `pnpm tsc --noEmit` passes — the expanded interfaces match the Phase 5 return shapes.

---

### 9F — Activity Feed Payment Event Badges + Filters

**Type:** Frontend (`"use client"`)
**Parallelizable:** With 9B / 9C / 9D / 9E after 9A lands.

**What:** Extend `activity-event-row.tsx` to render the program / paymentType / commissionable badge trio for payment events. Extend `activity-feed-filters.tsx` to include the shared program + paymentType filters (conditional on `entityType === "payment"`). Extend `activity-feed-page-client.tsx` to thread the new filter state through `feedArgs`.

**Why:** Phase 5 enriched `payment.recorded` / `payment.disputed` / `payment.verified` event metadata with `programName`, `paymentType`, `commissionable`, `attributedCloserId`, `originCategory`. Without a UI that renders these, the audit feed shows "Jane recorded a payment" with no further context — users cannot tell which program / payment type / commissionability slice the event belongs to without clicking through.

**Where:**
- `app/workspace/reports/activity/_components/activity-event-row.tsx` (modify)
- `app/workspace/reports/activity/_components/activity-feed-filters.tsx` (modify — add two conditional filters)
- `app/workspace/reports/activity/_components/activity-feed-page-client.tsx` (extend state + args)

**How:**

**Step 1: Modify `activity-event-row.tsx`**

Add badge imports and a rendering helper:

```tsx
// Path: app/workspace/reports/activity/_components/activity-event-row.tsx (key changes)
import { Badge } from "@/components/ui/badge";

const PAYMENT_EVENT_TYPES = new Set([
  "payment.recorded",
  "payment.disputed",
  "payment.verified",
]);

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
```

Inside the `ActivityEventRow` component, after the existing `legacyFromStatus` / `legacyToStatus` logic, add:

```tsx
// Extract payment-event metadata for the badge row (Phase 5 enrichment).
const isPaymentEvent = PAYMENT_EVENT_TYPES.has(event.eventType);
const programName =
  isPaymentEvent && typeof event.metadata?.programName === "string"
    ? event.metadata.programName
    : null;
const paymentType =
  isPaymentEvent && typeof event.metadata?.paymentType === "string"
    ? event.metadata.paymentType
    : null;
const commissionable =
  isPaymentEvent && typeof event.metadata?.commissionable === "boolean"
    ? event.metadata.commissionable
    : null;
```

Update the JSX inside `<div className="flex min-w-0 flex-1 flex-col gap-0.5">` — insert a badge row between the fromStatus/toStatus line and the timestamp:

```tsx
{isPaymentEvent && (programName || paymentType || commissionable !== null) ? (
  <div
    className="mt-1 flex flex-wrap items-center gap-1.5"
    aria-label={`Program ${programName ?? "unknown"}, ${paymentType ?? "unknown"} payment, ${commissionable === true ? "commissionable" : commissionable === false ? "post-conversion" : "unknown attribution"}`}
  >
    {programName && (
      <Badge variant="outline" className="text-[11px]">
        {programName}
      </Badge>
    )}
    {paymentType && (
      <Badge variant="secondary" className="text-[11px]">
        {capitalize(paymentType)}
      </Badge>
    )}
    {commissionable !== null && (
      <Badge
        variant={commissionable ? "default" : "outline"}
        className="text-[11px]"
      >
        {commissionable ? "Commissionable" : "Post-conversion"}
      </Badge>
    )}
  </div>
) : null}

<p className="text-xs text-muted-foreground">
  {formatDistanceToNow(event.occurredAt, { addSuffix: true })}
</p>
```

**Step 2: Modify `activity-feed-filters.tsx`**

Import the shared filters and update the props:

```tsx
// Path: app/workspace/reports/activity/_components/activity-feed-filters.tsx (key changes)
import type { Id } from "@/convex/_generated/dataModel";
import { ReportProgramFilter } from "../../_components/report-program-filter";
import {
  ReportPaymentTypeFilter,
  type PaymentType,
} from "../../_components/report-payment-type-filter";
```

Extend the `Filters` interface:

```tsx
interface Filters {
  entityType?: EntityType;
  eventType?: string;
  actorUserId?: string;
  // NEW — payment-specific filters
  programId?: Id<"tenantPrograms">;
  paymentType?: PaymentType;
}
```

Inside the component, after the existing three `<Select>` blocks, add:

```tsx
{/* Payment-specific filters — render only when filtering to payment entity */}
{filters.entityType === "payment" ? (
  <>
    <ReportProgramFilter
      value={filters.programId}
      onChange={(next) => {
        const nextFilters = { ...filters };
        if (next === undefined) {
          delete nextFilters.programId;
        } else {
          nextFilters.programId = next;
        }
        onChange(nextFilters);
      }}
    />
    <ReportPaymentTypeFilter
      value={filters.paymentType}
      onChange={(next) => {
        const nextFilters = { ...filters };
        if (next === undefined) {
          delete nextFilters.paymentType;
        } else {
          nextFilters.paymentType = next;
        }
        onChange(nextFilters);
      }}
    />
  </>
) : null}
```

Update the `entityType` `onValueChange` handler to clear payment-specific filters when entityType changes away from "payment":

```tsx
// Existing block — inside the Entity Type <Select> onValueChange:
onValueChange={(value) => {
  const next = { ...filters };
  if (value === "__all__") {
    delete next.entityType;
  } else {
    next.entityType = value as EntityType;
  }
  // NEW — clear payment-specific filters when leaving the payment scope
  if (next.entityType !== "payment") {
    delete next.programId;
    delete next.paymentType;
  }
  onChange(next);
}}
```

**Step 3: Extend `activity-feed-page-client.tsx`**

Update the `Filters` interface + `feedArgs` construction + `useEffect` dependency tuple:

```tsx
// Path: app/workspace/reports/activity/_components/activity-feed-page-client.tsx (key changes)
import type { Id } from "@/convex/_generated/dataModel";

type PaymentType = "pif" | "split" | "monthly" | "deposit";

interface Filters {
  entityType?: EntityType;
  eventType?: string;
  actorUserId?: string;
  programId?: Id<"tenantPrograms">;
  paymentType?: PaymentType;
}

// Inside the component:
useEffect(() => {
  setLimit(50);
}, [
  dateRange.startDate,
  dateRange.endDate,
  filters.entityType,
  filters.eventType,
  filters.actorUserId,
  filters.programId,
  filters.paymentType,
]);

// feedArgs now conditionally includes programId and paymentType:
const feedArgs = {
  ...dateRange,
  limit,
  ...(filters.entityType ? { entityType: filters.entityType } : {}),
  ...(filters.eventType ? { eventType: filters.eventType } : {}),
  ...(filters.actorUserId
    ? { actorUserId: filters.actorUserId as Id<"users"> }
    : {}),
  ...(filters.programId ? { programId: filters.programId } : {}),
  ...(filters.paymentType ? { paymentType: filters.paymentType } : {}),
};
```

Note: the backend `getActivityFeed` query must already accept these args as optional — Phase 5 is the hard gate for 9F. If the signature is not yet extended, stop and fix Phase 5 before proceeding; do not ship a UI-only filter shell that silently fails to filter server data.

**Acceptance for 9F:**

- `activity-event-row.tsx` renders three badges (`<program>`, `<paymentType>`, `Commissionable`/`Post-conversion`) under the verb line for the three payment event types only.
- Non-payment events show no badge row (no layout shift).
- `activity-feed-filters.tsx` shows the program + paymentType filters only when entityType is `"payment"`.
- Switching `entityType` away from `"payment"` clears both payment filters (prevents zombie state).
- `activity-feed-page-client.tsx` threads the new filter state through the query args and resets `limit` to 50 when either payment filter changes.
- `pnpm tsc --noEmit` passes.

---

### 9G — Verification Pass (Typecheck + Lint + Grep + Smoke Test)

**Type:** Frontend (verification only)
**Parallelizable:** No — runs last, after 9A–9F land.

**What:** Sweep the whole codebase for any remaining stale references to the pre-Phase-5 vocabulary (`closerId` on payment rows, `provider` field on payments, `customer_flow` origin literal, `programType` on customers, single-field `revenueLogged` reads), typecheck cleanly, lint cleanly, and walk the full seeded tenant through every report, the dashboard, and the activity feed.

**Why:** Phase 9 touches 13 files across 4 feature areas. Without a final verification pass, a single missed reference in (e.g.) a rarely-visited skeleton component or a debug console.log can ship a regression. The grep sweep is 30 seconds; the smoke test is 45 minutes; cheap insurance against a user-visible bug on release day.

**Where:** Whole-repo verification; no code edits unless a straggler turns up.

**How:**

**Step 1 — Grep sweeps:**

```bash
# Stale origin literal (replaced by admin_meeting / admin_reminder / admin_review_resolution)
rg "customer_flow" app/ components/ hooks/ lib/ convex/

# Stale provider field (dropped in Phase 2)
rg "\.provider\b" app/workspace/reports app/workspace/_components

# Stale customer field (dropped in Phase 2)
rg "\.programType\b" app/ components/ hooks/

# Stale payment attribution field (renamed in Phase 5)
rg "payment\.closerId\b|payment\.closerName\b" app/

# Stale dashboard read (replaced with the four-field split)
rg "stats\.totalRevenue\b" app/workspace/_components

# Stale top-deals field (renamed in Phase 5)
rg "deal\.closerName\b" app/workspace/reports

# Stale origin meta key (removed in 9B)
rg "ORIGIN_META\.(customer_flow|unknown)" app/

# Stale trend chart single-series prop
rg "revenueMinor: number" app/workspace/reports/revenue
```

All should return zero matches except inside `plans/` / `.docs/` / comment blocks. Any match is a missed consumer — fix before merging 9G.

**Step 2 — Typecheck + lint:**

```bash
pnpm tsc --noEmit
pnpm lint
```

Both must pass with zero errors and zero new warnings.

**Step 3 — Smoke test** (per `TESTING.MD`):

See §Smoke Test Script below.

**Acceptance for 9G:**

- All grep sweeps return clean.
- `pnpm tsc --noEmit` + `pnpm lint` pass.
- Smoke test passes end-to-end.
- Convex Insights spot-check: after the smoke test, verify the queries `getRevenueMetrics`, `getRevenueDetails`, `getRevenueTrend`, `getReminderOutcomeFunnel` each show a recent invocation with `programId` / `paymentType` / `revenueSlice` args in the Insights sample.

---

## Files Touched by Phase 9

| File | Subphase | Action |
|---|---|---|
| `app/workspace/reports/_components/report-program-filter.tsx` | 9A | Create |
| `app/workspace/reports/_components/report-payment-type-filter.tsx` | 9A | Create |
| `app/workspace/reports/_components/report-revenue-slice-filter.tsx` | 9A | Create |
| `app/workspace/reports/revenue/_components/revenue-report-page-client.tsx` | 9B | Modify |
| `app/workspace/reports/revenue/_components/revenue-kpi-cards.tsx` | 9B | Create |
| `app/workspace/reports/revenue/_components/revenue-by-program-section.tsx` | 9B | Create |
| `app/workspace/reports/revenue/_components/revenue-by-payment-type-section.tsx` | 9B | Create |
| `app/workspace/reports/revenue/_components/revenue-trend-chart.tsx` | 9B | Rewrite |
| `app/workspace/reports/revenue/_components/revenue-by-origin-chart.tsx` | 9B | Modify |
| `app/workspace/reports/revenue/_components/top-deals-table.tsx` | 9B | Modify |
| `app/workspace/reports/reminders/_components/reminders-report-page-client.tsx` | 9C | Modify |
| `app/workspace/reports/reminders/_components/reminder-driven-revenue-card.tsx` | 9C | Rewrite |
| `app/workspace/reports/team/_components/team-report-types.ts` | 9D | Extend |
| `app/workspace/reports/team/_components/team-kpi-summary-cards.tsx` | 9D | Modify |
| `app/workspace/reports/team/_components/closer-performance-table.tsx` | 9D | Modify (headers) |
| `app/workspace/_components/stats-row.tsx` | 9E | Rewrite |
| `app/workspace/reports/activity/_components/activity-event-row.tsx` | 9F | Modify |
| `app/workspace/reports/activity/_components/activity-feed-filters.tsx` | 9F | Modify |
| `app/workspace/reports/activity/_components/activity-feed-page-client.tsx` | 9F | Modify |

Five new files. No files deleted.

---

## Integration Points With Other Phases

| Consumer | Integration point | Provider |
|---|---|---|
| Revenue report queries (9B) | `{ startDate, endDate, programId?, paymentType?, revenueSlice? }` return shape with `commissionable` + `nonCommissionable` + `byPaymentType` + `isPaymentDataTruncated` | `convex/reporting/revenue.ts::getRevenueMetrics` / `getRevenueDetails` (Phase 5) |
| Revenue trend chart (9B) | four-series return with `commissionableFinalMinor` / `commissionableDepositMinor` / `nonCommissionableFinalMinor` / `nonCommissionableDepositMinor` per period | `convex/reporting/revenueTrend.ts::getRevenueTrend` (Phase 5) |
| Top deals table (9B) | row shape with `programName` / `paymentType` / `attributedCloserName` (instead of `closerName`) | `convex/reporting/revenue.ts::getRevenueDetails` `topDeals` (Phase 5) |
| Reminders report (9C) | `{ programId?, paymentType? }` filter acceptance + split return `reminderDrivenFinalRevenueMinor` / `reminderDrivenDepositRevenueMinor` + compat sum | `convex/reporting/remindersReporting.ts::getReminderOutcomeFunnel` (Phase 5) |
| Team report (9D) | `teamTotals.postConversionRevenueMinor` field + semantic shift of `totalRevenueMinor` to commissionable-final only | `convex/reporting/teamPerformance.ts::getTeamPerformanceMetrics` (Phase 5) |
| Dashboard stats row (9E) | lifetime `revenueLogged` / `depositsCollected` / `postConversionRevenueLogged` / `postConversionDepositsLogged` + period `closedWonInPeriod` / `depositsInPeriod` / `postConversionInPeriod` / `postConversionDepositsInPeriod` | `convex/dashboard/adminStats.ts::getAdminDashboardStats` / `getTimePeriodStats` (Phase 5) |
| Activity feed (9F) | `event.metadata` includes `programName` / `paymentType` / `commissionable` / `attributedCloserId` / `originCategory` for `payment.*` events | `convex/reporting/activityFeed.ts::getActivityFeed` (Phase 5) |
| `<ReportProgramFilter>` list source (9A) | `{ _id, name, archivedAt, ... }` shape from `listPrograms({ includeArchived: true })` | `convex/tenantPrograms/queries.ts::listPrograms` (Phase 1) |

---

## Edge Cases Handled

1. **Tenant with zero programs.** `<ReportProgramFilter>` renders null (the caller's filter bar simply collapses to 2 filters instead of 3). Cannot actually happen post-onboarding because Phase 1 guarantees an initial program seed, but the component is defensive.
2. **All-zero revenue in the selected range.** Every KPI card shows `$0.00` with the `default` variant (not `success`). The by-program and by-payment-type sections show their respective empty states. The trend chart shows the "No revenue data for this period" message when all four series are zero across all periods.
3. **Mixed-currency payments in a single range.** Phase 5 does not separate by currency in the aggregate queries (the Design doc Open Question #8 tracks this). The KPI cards format with `"USD"` — if a tenant ever accumulates non-USD payments, the dollar symbol is misleading. Deferred to v0.5.2 per Open Question #8. Phase 9 UI does not attempt multi-currency support.
4. **Archived program with historical revenue.** The program filter surfaces archived programs in the Archived group. Reports scoped to an archived program still return accurate historical slices (Phase 5 does not filter out archived programs on read). Payment write paths (Phases 4, 6, 7, 8) already prevent new writes against archived programs.
5. **Payment event with `metadata === null` (non-payment event or legacy row).** `activity-event-row.tsx` defensively checks `event.metadata !== null` before reading any metadata field; if any of the three metadata fields is missing, only the present badges render. `metadata === null` for a payment event should not happen post-Phase-5 (the parser writes all five fields), but the defense is cheap.
6. **Commissionable payment with `attributedCloserId === null`.** Can happen if the closer user was deleted after the payment was logged. The top-deals table shows `"—"` in the Closer column. The activity-feed row still renders the `Commissionable` badge (the flag is independent of whether the attributed user still exists).
7. **Revenue slice filter = `"non_commissionable"` + program filter set.** The backend returns `{ commissionable: {empty}, nonCommissionable: {filtered} }`. The revenue KPI cards render the first two as `$0` (with `default` variant) and the second two as filtered values. The by-origin chart renders empty. The trend chart shows two dashed series only. All UI degrades gracefully.
8. **Dashboard period = "today" and no payments yet logged.** All four revenue cards show `$0.00` with the `default` variant. The pipeline overview cards still show meaningful data. Screen readers speak "Revenue today" on the group heading so users know the zero state is scoped correctly.
9. **Activity feed filter combo: entityType = "meeting" + user sets programId.** The program filter is hidden when entityType != "payment" (9F acceptance #20). If a user manually URL-manipulates the filter state into this combination, the client still passes `programId` as a query arg but the backend ignores it for non-payment events (Phase 5 does not filter non-payment events by program). No crash; slight logical redundancy that the UI gate prevents in normal use.
10. **Trend chart with granularity = "day" over a 90-day range.** 90 data points × 4 series = 360 line nodes. Recharts handles this without perf issues. If the range extends to a year at daily granularity, consider switching to `granularity="week"` — the `<ReportDateControls>` already exposes the toggle.

---

## Follow-Up Notes (deferred out of Phase 9)

1. **URL-param-backed filter state.** All three report pages manage filter state via `useState`, so filters reset on page reload. Migrating to `?programId=...&paymentType=...` query params (via `useSearchParams` + `useRouter.replace`) would make report URLs shareable. Deferred to a post-v0.5.1 UX polish pass — touches all three report pages plus browser back/forward semantics, larger than the Phase 9 scope.
2. **Multi-currency totals.** Phase 5's KPIs sum all payments regardless of currency, producing a misleading `$` symbol when a tenant has multi-currency payments. Open Question #8 in the design doc tracks the proper fix (per-currency sub-totals, either user-selected pivot currency or per-currency columns). Deferred; no tenant is in a multi-currency state yet.
3. **Per-program color palette.** The revenue-by-program section renders each program's bar in the same color. A future polish could assign a stable hash-derived color per `programId` so users can scan across program bars in the trend chart, program section, and top-deals badges. Deferred; low impact at 1–3 programs per tenant.
4. **Activity feed "origin category" chip.** Phase 5 also exposes `metadata.originCategory` on payment events. The 9F badge row shows `Commissionable` / `Post-conversion` only. Adding a separate origin-category chip would let users distinguish sub-cases like "admin logged on closer's behalf" from other payment-event categories at a glance. Deferred; the `commissionable` flag already captures the most important bit for the typical audit use case.
5. **PostHog event metadata on filter changes.** Revenue / Reminders / Activity reports do not currently emit PostHog events when users change the program / paymentType / revenueSlice filters. Instrumenting these ("revenue_report_filter_changed" with the filter tuple) would help the product team understand report usage. Deferred to the analytics pass after v0.5.1 ships.
6. **Team report: deposit collected per closer.** Phase 5 exposes per-closer `cashCollectedMinor` (commissionable-final only). A per-closer `depositsCollectedMinor` field is not currently returned (only at team totals level, if added). If the product wants per-closer deposit visibility, Phase 5's return shape would need extending and the `closer-performance-table.tsx` would gain a column. Deferred; the team-level Deposits card in 9E and the commissionable-deposit card in 9B cover the aggregate view.
7. **Consolidate `formatDollars` / `formatCurrency` / `formatCompactCurrency`.** Phase 9 ships three nearly-identical currency formatters: `formatDollars` inside `reminder-driven-revenue-card.tsx`, `formatCurrency` imported from `@/lib/format-currency` used across the dashboard and revenue KPI cards, and `formatCompactCurrency` inside team-report-formatters. A unified `@/lib/format-currency` with `format`, `formatCompact`, and `formatMinor` exports would DRY this up. Deferred; three-caller duplication is a known smell but not a behavior bug.

---

## Smoke Test Script (full, per `TESTING.MD`)

**Setup:**

1. Seed a tenant with two active programs and one archived program:
   ```
   npx convex run testing/programs:seedTestProgram '{"tenantId":"<tenant>","name":"Launchpad","defaultCurrency":"USD"}'
   npx convex run testing/programs:seedTestProgram '{"tenantId":"<tenant>","name":"Accelerator","defaultCurrency":"USD"}'
   npx convex run testing/programs:seedTestProgram '{"tenantId":"<tenant>","name":"Legacy Program","defaultCurrency":"USD","archived":true}'
   ```
2. Book two Calendly test invitees; start + close the first meeting with a PIF ($3,000 Launchpad) as closer. Start + close the second meeting with a Split payment of $1,500 (Accelerator) as closer, then an admin-on-behalf deposit of $500 (Accelerator) on the same meeting.
3. Open the resulting customer (from the first invitee) and record a non-commissionable monthly of $500 (Launchpad) as admin, plus a non-commissionable deposit of $200 (Launchpad) as admin.
4. (Optional) Trigger one reminder that resolves with a payment ($800 Accelerator, PIF) to populate the reminder-revenue slice.

This yields 6 payments: 3 commissionable (PIF $3k, Split $1.5k, Deposit $500), 2 non-commissionable (Monthly $500, Deposit $200), 1 reminder-driven ($800 PIF). Two programs active, one archived.

**Walk-through:**

### 1. Dashboard — `/workspace`

- **Pipeline overview row (4 cards):** Total Closers, Active Opportunities, Meetings (this period), Won Deals (this period). Unchanged from before Phase 9.
- **Revenue row (4 cards):**
  - `Revenue`: `$4,500` (commissionable-final: $3k PIF + $1.5k Split), `variant="success"`, subtext "Commissionable final <period>".
  - `Deposits`: `$500` (commissionable-deposit).
  - `Post-Conv Revenue`: `$500` (non-commissionable-final: monthly).
  - `Post-Conv Deposits`: `$200`.
- **Reminder payment** not counted in dashboard "today" card unless recorded today; verify `revenueInPeriod` total = $4,500 + reminder if today, else $4,500.

### 2. Revenue Report — `/workspace/reports/revenue` (range = This Month)

- **KPI Cards:**
  - Commissionable Final: `$4,500` (3 deals).
  - Commissionable Deposits: `$500`.
  - Post-Conversion Final: `$500` (1 customer payment).
  - Post-Conversion Deposits: `$200`.
- **Trend chart:** four lines visible; commissionable-final (primary solid) hits $4,500 this month; commissionable-deposit dashes at $500; two non-commissionable dashed lines at $500 and $200.
- **By-origin chart:** 3 bars — `Closer · Meeting` (PIF $3k + Split $1.5k = $4.5k), `Admin · Meeting` (Deposit $500). No `Customer Flow`, no `Unknown`.
- **By-program:** Commissionable column: `Launchpad $3,000 (1 deal)`, `Accelerator $2,000 (2 deals)`. Post-conversion column: `Launchpad $700 (2 customer payments)`.
- **By-payment-type:** PIF column shows `$3,000` commissionable / `$0` post-conv; Split shows `$1,500` / `$0`; Monthly shows `$0` / `$500`; Deposit shows `$500` / `$200`.
- **Top-deals table:** 3 rows (commissionable-final only, deposits excluded per Phase 5 acceptance #3) showing `Program` + `Payment Type` columns.
- **Filter test:**
  - Select `Program: Launchpad` → KPIs: Final $3k / Deposits $0 / Post-Conv Final $500 / Post-Conv Deposits $200. Other charts scope to Launchpad only.
  - Select `Payment Type: Deposit` → KPIs: Final $0 (deposits never appear in final) / Deposits $500 commissionable / Post-Conv Final $0 / Post-Conv Deposits $200. Top-deals empty.
  - Select `Revenue Slice: Post-Conversion` → Commissionable KPIs both zero; Post-Conversion KPIs show the full customer payment totals. By-origin chart empty (no commissionable origins).

### 3. Reminders Report — `/workspace/reports/reminders` (range = This Month)

- **Reminder-Driven Revenue Card (only if reminder payment exists):**
  - Final Revenue: `$800`.
  - Deposits: `$0`.
  - Caption: `"1 payment logged from the reminder flow. Total: $800.00."`.
- **Filter test:**
  - Program filter shows Launchpad + Accelerator + Legacy Program (archived) groups.
  - Select `Program: Accelerator` → Final = $800 (the reminder).
  - Select `Payment Type: PIF` → Final = $800.
  - Select `Payment Type: Deposit` → Final = $0, Deposits = $0.

### 4. Team Report — `/workspace/reports/team` (range = This Month)

- **First KPI row (4 cards):** Total Booked, Show-Up Rate, `Cash Collected` ($4,500; italic "Commissionable-final only"), Close Rate.
- **Second KPI row (4 cards):** Lost Deals, Rebook Rate, Actions / Closer / Day, **NEW** `Post-Conversion Revenue` ($500; caption "Admin-logged customer payments in range"; italic "Not attributed to any closer").
- **Per-closer table:**
  - Header column `Cash Collected` has hover tooltip with the Phase 9D text.
  - Header column renamed to `Admin On Behalf` with hover tooltip.
  - Jane Closer row shows: Cash Collected `$4,500`, Admin On Behalf `$500` (the admin-on-behalf deposit).
  - Team Total footer: Cash Collected `$4,500`, Admin On Behalf `$500`.

### 5. Activity Feed — `/workspace/reports/activity` (range = This Month)

- Navigate to the feed; find any `payment.recorded` row.
- **Badge row visible** under the verb line: `Launchpad` + `PIF` + `Commissionable` (or `Accelerator` + `Split`, etc.).
- For non-commissionable rows (monthly customer payment), the third badge reads `Post-conversion` with outline variant.
- **Filter test:**
  - Select `Entity Type: Payment` → program + paymentType filters appear as the fourth and fifth selects.
  - Select `Program: Launchpad` → feed filters to Launchpad payment events only.
  - Select `Payment Type: PIF` → feed filters to PIF events only.
  - Change `Entity Type: Meeting` → program + paymentType filters disappear; feed re-filters to meeting events.
  - Change `Entity Type: Payment` back → program + paymentType filters are empty (cleared during entityType switch per 9F acceptance).

### 6. Post-deploy sanity:

- `npx convex data paymentRecords --limit 5` — every row has `programId`, `programName`, `paymentType`, `commissionable`, `attributedCloserId` (null for non-commissionable rows), `recordedByUserId`.
- `npx convex run reporting/revenue:getRevenueMetrics '{"startDate":<now-30d>,"endDate":<now>}'` — return shape matches Phase 5 acceptance #2.
- Convex Insights: each `getRevenueMetrics` / `getRevenueDetails` / `getRevenueTrend` call shows a bounded execution time (< 500ms) and bounded read count.

All six scenarios must pass without visual glitches, without NaN, without blank fields, and without references to the old vocabulary (no `Provider` label, no `customer_flow` label, no single `Revenue` card on the dashboard).

---

## Rollback Plan

Phase 9 is pure frontend display + filter logic. Rollback == revert the 19-file diff (5 new files delete; 14 modify/rewrite revert). Backend (Phases 1–5) stays deployed; the old reports re-appear with the old vocabulary but:

- **Revenue report** at the old file shape reads `metrics.totalRevenueMinor` / `metrics.byOrigin` — but the Phase 5 backend returns nested shapes. **Revert the revenue report client without reverting Phase 5 and the page crashes on mount.** The safe rollback is to revert both Phase 9 and Phase 5 together, or to hotfix the specific regression.
- **Dashboard stats row** at the old shape reads `periodStats.revenueInPeriod` — which the Phase 5 backend still returns as a rollout-compat field. Dashboard rollback works in isolation (old-shape reads a subset of new-shape).
- **Activity feed** at the old shape ignores `metadata` extensions. Rollback works in isolation.
- **Reminders report** at the old shape reads `data.reminderDrivenRevenueMinor` — Phase 5 keeps this field as a compat sum. Rollback works in isolation.
- **Team report** at the old shape reads `teamTotals.totalRevenueMinor` — which still exists post-Phase-5 but with a shifted semantic (commissionable-final only). Rollback renders stale labels ("Cash Collected" now = commissionable-final but UI does not say so) — semantically misleading but not broken.

**Recommended rollback strategy:** hotfix over revert when possible. The 19-file blast radius of a full revert exceeds the blast radius of surgical fixes. If the whole phase needs rolling back (e.g., a fundamental UX bug), roll back Phase 5 simultaneously to keep the reports consistent.

**Feature flag option:** the four new dashboard cards (9E) are the highest-risk surface — most-viewed page, most-scrutinized numbers. If confidence is low, gate the second revenue row on a GrowthBook flag `dashboard_v2_revenue_split` defaulting to `true` in internal, `false` in the single test tenant. (Not strictly recommended — Phase 9 is a leaf frontend change with no data migration — but available as an emergency brake.)

---

## Prerequisites — Recap Sign-off Checklist

Before opening a Phase 9 PR, confirm:

- [ ] Phase 1 deployed; `api.tenantPrograms.queries.listPrograms({ includeArchived: true })` returns active + archived programs for the target tenant.
- [ ] Phase 2 deployed; `paymentRecords` has `programId` / `programName` / `paymentType` / `commissionable` / `attributedCloserId` / `recordedByUserId`; three new indexes (`by_tenantId_and_commissionable_and_recordedAt`, `by_tenantId_and_programId_and_recordedAt`, `by_tenantId_and_paymentType_and_recordedAt`) present.
- [ ] Phase 3 deployed; `tenantStats` has the four split counters populated.
- [ ] Phase 4 deployed; every payment mutation routes through `applyPaymentStatsDelta` (invariant I5 upheld on the write path).
- [ ] **Phase 5 deployed AND smoke-tested** — the critical hard gate. Run Phase 5's smoke test script on the preview deployment before starting Phase 9 work. Any missing field or semantic drift in Phase 5's return shapes breaks Phase 9 on mount.
- [ ] `lib/format-currency.ts` exists and exports `formatCurrency(value: number, currency: string): string`. If it does not yet exist, add it as part of 9E — every KPI card in Phase 9 depends on it.
- [ ] PostHog analytics library is installed and initialized at the app root (no new PostHog events in Phase 9, but the existing ones must continue to fire — any regression in PostHog integration during the 19-file diff should be caught at 9G).
- [ ] (Optional) Phase 7 and Phase 8 can be deployed in parallel with Phase 9; none of their files intersect with the Phase 9 surface.

---

## Phase 9 Summary Table

| Subphase | Files | Complexity | Unblocks |
|---|---|---|---|
| 9A — Shared filters (Program + PaymentType + RevenueSlice) | 3 new | Small — 3 tiny components | 9B / 9C / 9F |
| 9B — Revenue report rewrite | 3 new + 4 rewrite | Large — KPI + 2 breakdowns + 4-series trend + 2 updated charts | 9G |
| 9C — Reminders report extension | 2 modify | Small — filter pass-through + card split | 9G |
| 9D — Team report refresh | 3 modify + 1 extend | Medium — new KPI card + column tooltips + type extension | 9G |
| 9E — Dashboard stats row rewrite | 2 modify (1 major) | Medium — grid restructure + 4 new cards | 9G |
| 9F — Activity feed badges + filters | 3 modify | Medium — badge row + conditional filters | 9G |
| 9G — Verification pass | 0 | Small — grep + typecheck + lint + smoke test | — |

**Total:** 5 new files, 14 modified/rewritten files; 6 parallel subphase streams after 9A gate; 1 day solo or 0.5 day with parallel execution.

After Phase 9 merges, every workspace surface speaks the new program / paymentType / commissionable / attributed-closer vocabulary, and the codebase-wide grep sweep confirms zero stragglers. The feature is complete.
