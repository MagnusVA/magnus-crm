# Phase 4 - Reporting Simplification

**Goal:** Remove review-required and meeting-time reporting concepts, standardize show rate to `completed / (booked - canceled)`, and delete reporting/UI surfaces that depend on `meeting_overran`, `in_progress`, or actual-duration fields.

**Prerequisite:** Phase 2 backend no longer produces new legacy states. Phase 3 removes the operational review inbox or coordinates nav ownership before this phase edits shared shell/report links.

**Runs in PARALLEL with:** Phase 3 can overlap after file ownership is split. Phase 5 must wait until Phase 4 no longer reads legacy reporting buckets.

**Skills to invoke:**
- `convex-performance-audit` - reporting queries and aggregate read paths must remain bounded and indexed.
- `frontend-design` - keep remaining report pages clean after removing cards/columns/routes.
- `next-best-practices` - route deletion and App Router page/client boundaries.
- `web-design-guidelines` - accessibility pass after table columns/cards are removed.

**Docs and references to read first:**
- `plans/phone-closer-overrun-refactor/phone-closer-overrun-refactor-design.md` Sections 7, 10.3, 10.5, 11, and 16.
- `convex/_generated/ai/guidelines.md` for bounded Convex reads and avoiding `.filter()` database filtering.
- `node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md`.
- `node_modules/next/dist/docs/01-app/02-guides/analytics.md`.
- `.docs/posthog/nextjs-setup.md` and `.docs/posthog/posthog-convex.md`.
- Current reporting files: `convex/reporting/teamPerformance.ts`, `convex/reporting/pipelineHealth.ts`, `convex/dashboard/overviewOperations.ts`, `convex/operations/meetingStats.ts`, `convex/operations/phoneSales.ts`, `convex/reporting/teamOutcomes.ts`, `convex/reporting/lib/outcomeDerivation.ts`, `convex/reporting/lib/eventLabels.ts`, `convex/reporting/activityFeed.ts`, and report route trees under `app/workspace/reports/**`.

**Deploy / backfill / manual operations:**
- **Deploy required:** Yes. Deploy before Phase 5 cleanup so reports no longer depend on legacy buckets.
- **Backfill or migration required:** No direct data migration in this phase. Aggregate/projection recomputation happens in Phase 5 after source rows are repaired.
- **Manual operations:** PostHog funnel reconfiguration is manual and external: re-anchor funnels that used `meeting_started` after the code deploy.

**Acceptance Criteria:**
1. Every show-rate reporting surface uses `completed / (booked - canceled)` with `no_show` in the denominator and no `reviewRequired` subtraction.
2. `meeting_overran` and `in_progress` are removed from report calculations, chart buckets, filters, labels, and table columns.
3. `/workspace/reports/meeting-time/**` and `/workspace/reports/reviews/**` are deleted.
4. Backend modules `convex/reporting/meetingTime.ts` and `convex/reporting/reviewsReporting.ts` are deleted or no longer referenced by generated APIs before Phase 6.
5. Pipeline/team report UI no longer renders Pending Overran Reviews, Meeting Time, or Review Required cards/columns.
6. PostHog `meeting_started` and `meeting_overran_context_submitted` captures are removed from code, and a docs note records the required PostHog console changes.
7. Reporting queries remain bounded and do not add unindexed `.filter()` scans.
8. A grep for `reviewRequired`, `meetingTime`, `meeting_overran`, and `in_progress` in reporting/UI paths returns only migration-window schema/status config references scheduled for Phase 6.
9. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (canonical reporting formulas) --------\
                                           +--> 4E (verification + deploy)
4B (delete report routes/modules) --------+
                                           |
4C (filters/charts/status buckets) -------+
                                           |
4D (PostHog + docs/manual note) ----------/
```

**Optimal execution:**
1. Start 4A first because it defines the new reporting DTO shapes.
2. Run 4B and 4C in parallel after 4A determines removed fields.
3. Run 4D anytime after deleted captures are known.
4. Run 4E once all report routes compile and manual PostHog notes are documented.

**Estimated time:** 1.5-3 days

---

## Subphases

### 4A - Standardize Backend Reporting Formulas

**Type:** Backend
**Parallelizable:** No - DTO shape changes drive frontend cleanup.

**What:** Remove `reviewRequired` and meeting-time metrics from reporting queries and standardize show-rate math.

**Why:** The old reporting layer had multiple show-rate definitions because `meeting_overran` was neither completed nor no-show. With overran removed, one formula must be used everywhere.

**Where:**
- `convex/reporting/teamPerformance.ts` (modify)
- `convex/reporting/pipelineHealth.ts` (modify)
- `convex/dashboard/overviewOperations.ts` (modify)
- `convex/operations/meetingStats.ts` (modify)
- `convex/operations/phoneSales.ts` (modify)
- `convex/reporting/teamOutcomes.ts` (modify)

**How:**

**Step 1: Add a local helper where report math is repeated.**

```typescript
// Path: convex/reporting/teamPerformance.ts
function computeShowUpRate(args: {
  booked: number;
  completed: number;
  canceled: number;
}): number | null {
  const denominator = args.booked - args.canceled;
  if (denominator <= 0) return null;
  return args.completed / denominator;
}
```

Use the same formula in pipeline and operations reports. If a shared helper already exists in reporting libs by implementation time, use that instead of duplicating.

**Step 2: Remove review-required buckets.**

```typescript
// Path: convex/reporting/teamPerformance.ts
const bookedCalls =
  counts.scheduled + counts.completed + counts.canceled + counts.no_show;
const completedCalls = counts.completed;
const canceledCalls = counts.canceled;

const showUpRate = computeShowUpRate({
  booked: bookedCalls,
  completed: completedCalls,
  canceled: canceledCalls,
});

return {
  bookedCalls,
  completedCalls,
  canceledCalls,
  noShowCalls: counts.no_show,
  showUpRate,
  // Removed: reviewRequiredCalls, meetingTime, totalActualDurationMs.
};
```

**Step 3: Remove pending-review scans.**

```typescript
// Path: convex/reporting/pipelineHealth.ts
// Delete any query shaped like:
// ctx.db.query("meetingReviews")
//   .withIndex("by_tenantId_and_status_and_createdAt", ...)
//
// Pipeline health no longer reports pending overran review backlog.
```

**Key implementation notes:**
- Do not use `.collect().length` for counts. Preserve aggregate/table-count patterns that already exist.
- If removing a DTO field breaks a frontend table, remove the matching column in 4B/4C rather than keeping a fake zero.
- `no_show` stays in the denominator.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/teamPerformance.ts` | Modify | Canonical show rate; remove meeting time/review required |
| `convex/reporting/pipelineHealth.ts` | Modify | Remove pending-review scan and reviewRequired |
| `convex/dashboard/overviewOperations.ts` | Modify | Drop legacy meeting status interpretation |
| `convex/operations/meetingStats.ts` | Modify | Drop legacy buckets from query results |
| `convex/operations/phoneSales.ts` | Modify | Drop legacy status filters/buckets |
| `convex/reporting/teamOutcomes.ts` | Modify | Drop in-progress bucket |

---

### 4B - Delete Review and Meeting-Time Report Surfaces

**Type:** Full-Stack
**Parallelizable:** Yes - after 4A DTO removals are clear.

**What:** Remove report routes and backend modules that exist only for review/time tracking.

**Why:** These surfaces directly depend on `meetingReviews`, `startedAt`, `stoppedAt`, overrun durations, and review-required concepts that will disappear in Phase 6.

**Where:**
- `app/workspace/reports/meeting-time/**` (delete)
- `app/workspace/reports/reviews/**` (delete)
- `convex/reporting/meetingTime.ts` (delete)
- `convex/reporting/reviewsReporting.ts` (delete)
- `app/workspace/reports/pipeline/_components/pending-overran-reviews-card.tsx` (delete)
- `app/workspace/reports/team/_components/meeting-time-summary.tsx` (delete)
- `app/workspace/reports/team/_components/closer-performance-table.tsx` (modify)
- `app/workspace/reports/team/_components/team-report-page-client.tsx` (modify)
- `app/workspace/reports/pipeline/_components/pipeline-report-page-client.tsx` (modify)

**How:**

**Step 1: Delete route trees and backend modules.**

```bash
# Path: shell
rm -r app/workspace/reports/meeting-time
rm -r app/workspace/reports/reviews
rm convex/reporting/meetingTime.ts
rm convex/reporting/reviewsReporting.ts
```

Use the normal file deletion mechanism in implementation.

**Step 2: Remove team report columns.**

```tsx
// Path: app/workspace/reports/team/_components/closer-performance-table.tsx
type CallsSummary = {
  bookedCalls: number;
  completedCalls: number;
  noShowCalls: number;
  canceledCalls: number;
  showUpRate: number | null;
  // Removed: reviewRequiredCalls.
};
```

**Step 3: Remove pipeline pending-review alert.**

```tsx
// Path: app/workspace/reports/pipeline/_components/pipeline-report-page-client.tsx
// Delete the alert/card that renders:
// "{stats.reviewRequired} meeting-overran rows are waiting for review"
```

**Key implementation notes:**
- Removing a route folder is not enough. Remove generated API references by deleting query imports and component callers.
- Keep surrounding loading/error boundaries intact.
- Preserve report nav order after removing routes; do not leave empty separators.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/meeting-time/**` | Delete | Meeting-time report removed |
| `app/workspace/reports/reviews/**` | Delete | Review report removed |
| `convex/reporting/meetingTime.ts` | Delete | Timing backend removed |
| `convex/reporting/reviewsReporting.ts` | Delete | Review backend removed |
| `app/workspace/reports/pipeline/_components/pending-overran-reviews-card.tsx` | Delete | Pending review card removed |
| `app/workspace/reports/team/_components/meeting-time-summary.tsx` | Delete | Meeting time summary removed |
| `app/workspace/reports/team/_components/closer-performance-table.tsx` | Modify | Remove Review Req. column |
| `app/workspace/reports/team/_components/team-report-page-client.tsx` | Modify | Remove review/time summary wiring |
| `app/workspace/reports/pipeline/_components/pipeline-report-page-client.tsx` | Modify | Remove reviewRequired alert/stat |

---

### 4C - Remove Legacy Buckets from Filters, Charts, and Labels

**Type:** Frontend / Backend
**Parallelizable:** Yes - can run with 4B.

**What:** Remove `meeting_overran` and `in_progress` from non-schema status configs, filters, charts, outcome derivation, event labels, and activity feed labels.

**Why:** Even after routes are deleted, remaining filters or charts can preserve impossible status values and break after schema narrow.

**Where:**
- `app/workspace/reports/pipeline/_components/status-distribution-chart.tsx` (modify)
- `app/workspace/reports/pipeline/_components/pipeline-aging-table.tsx` (modify)
- `app/workspace/_components/pipeline/pipeline-filters.tsx` (modify)
- `app/workspace/opportunities/_components/opportunity-filters.tsx` (modify)
- `app/workspace/opportunities/_components/opportunities-page-client.tsx` (modify)
- `app/workspace/operations/_components/operations-filter-bar.tsx` (modify)
- `app/workspace/operations/_components/qualification-filters.tsx` (modify)
- `app/workspace/operations/_components/qualification-tab.tsx` (modify)
- `app/workspace/reports/team/_components/meeting-outcome-distribution-chart.tsx` (modify)
- `app/workspace/closer/reminders/[followUpId]/_components/reminder-history-panel.tsx` (modify)
- `convex/reporting/lib/outcomeDerivation.ts` (modify)
- `convex/reporting/lib/eventLabels.ts` (modify)
- `convex/reporting/activityFeed.ts` (modify)

**How:**

**Step 1: Remove impossible filter options.**

```tsx
// Path: app/workspace/_components/pipeline/pipeline-filters.tsx
const STATUS_OPTIONS = [
  { value: "qualified_pending", label: "Qualified Pending" },
  { value: "scheduled", label: "Scheduled" },
  { value: "payment_received", label: "Payment Received" },
  { value: "follow_up_scheduled", label: "Follow-up Scheduled" },
  { value: "reschedule_link_sent", label: "Reschedule Link Sent" },
  { value: "lost", label: "Lost" },
  { value: "canceled", label: "Canceled" },
  { value: "no_show", label: "No-show" },
];
```

**Step 2: Remove derived in-progress outcomes.**

```typescript
// Path: convex/reporting/lib/outcomeDerivation.ts
export type DerivedOutcome =
  | "sold"
  | "lost"
  | "no_show"
  | "canceled"
  | "rescheduled"
  | "follow_up"
  | "scheduled";

export function deriveOutcome(args: {
  meeting?: Doc<"meetings"> | null;
  opportunity: Doc<"opportunities">;
}): DerivedOutcome {
  if (args.opportunity.status === "payment_received") return "sold";
  if (args.opportunity.status === "lost") return "lost";
  if (args.opportunity.status === "no_show") return "no_show";
  if (args.opportunity.status === "canceled") return "canceled";
  if (args.opportunity.status === "follow_up_scheduled") return "follow_up";
  return "scheduled";
}
```

**Step 3: Remove event labels for deleted review events.**

```typescript
// Path: convex/reporting/lib/eventLabels.ts
// Delete labels for:
// meeting.overran_detected
// meeting.overran_closer_responded
// meeting.overran_review_resolved
// meeting.webhook_ignored_overran
// meeting.started
// meeting.stopped
// review_resolved_*
```

**Key implementation notes:**
- `lib/status-config.ts` may still keep legacy literals until Phase 6 if generated types require them. Remove only UI choices that are safe while schema remains wide.
- Coordinate with Phase 6 to remove final type-level status config entries after data cleanup.
- Search both app and Convex paths; filters exist in several route-private components.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/pipeline/_components/status-distribution-chart.tsx` | Modify | Remove legacy colors/buckets |
| `app/workspace/reports/pipeline/_components/pipeline-aging-table.tsx` | Modify | Remove legacy status rows |
| `app/workspace/_components/pipeline/pipeline-filters.tsx` | Modify | Remove legacy filter options |
| `app/workspace/opportunities/_components/opportunity-filters.tsx` | Modify | Remove legacy tabs/options |
| `app/workspace/opportunities/_components/opportunities-page-client.tsx` | Modify | Remove legacy type union values |
| `app/workspace/operations/_components/operations-filter-bar.tsx` | Modify | Remove legacy filters |
| `app/workspace/operations/_components/qualification-filters.tsx` | Modify | Remove legacy filters |
| `app/workspace/operations/_components/qualification-tab.tsx` | Modify | Remove legacy unions |
| `app/workspace/reports/team/_components/meeting-outcome-distribution-chart.tsx` | Modify | Remove in-progress bucket |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-history-panel.tsx` | Modify | Remove legacy labels |
| `convex/reporting/lib/outcomeDerivation.ts` | Modify | Remove overran/in-progress derived outcome |
| `convex/reporting/lib/eventLabels.ts` | Modify | Remove review/overran labels |
| `convex/reporting/activityFeed.ts` | Modify | Remove review event buckets |

---

### 4D - Remove PostHog Lifecycle Events and Document Manual Funnel Work

**Type:** Frontend / Manual
**Parallelizable:** Yes - independent after Phase 3 removes action-bar capture.

**What:** Remove obsolete lifecycle captures and record the required PostHog console follow-up.

**Why:** Code no longer emits `meeting_started`; funnels using that event become stale unless explicitly re-anchored.

**Where:**
- `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` (verify)
- `app/workspace/closer/meetings/_components/meeting-overran-context-dialog.tsx` (deleted in Phase 3)
- `posthog-setup-report.md` or the repo's current PostHog setup/reporting note (modify/create if the file exists in implementation branch)

**How:**

**Step 1: Verify captures are gone.**

```bash
# Path: shell
rg -n 'meeting_started|meeting_overran_context_submitted' app convex lib components hooks
```

Expected: no active code matches.

**Step 2: Add a short PostHog note.**

```markdown
<!-- Path: posthog-setup-report.md -->
## Phone Closer Overrun Refactor

The app no longer emits `meeting_started` or
`meeting_overran_context_submitted`. Re-anchor Meeting -> Payment and Meeting
Churn funnels on outcome events such as `payment_logged`,
`payment.recorded`, `opportunity_marked_lost`, or the existing server-side
domain event exports used by analytics.

This is a manual PostHog console task; no new code event replaces
`meeting_started` in this MVP.
```

**Key implementation notes:**
- Do not add a replacement "joined meeting" event from the plain link. The design intentionally makes Join passive.
- If the PostHog docs file name has changed, update the current local PostHog report document instead of creating a duplicate.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `posthog-setup-report.md` or current PostHog setup note | Modify / Create | Manual funnel re-anchor instructions |
| `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` | Verify | No `meeting_started` capture |

---

### 4E - Reporting Verification and Deploy

**Type:** Manual / Release
**Parallelizable:** No - final gate.

**What:** Prove the app compiles without deleted reporting modules and deploy before Phase 5 cleanup.

**Why:** Phase 5 will repair aggregates and projections; reports must already stop expecting the old buckets.

**Where:**
- Shell / Convex CLI
- Browser report routes

**How:**

**Step 1: Grep for stale reporting references.**

```bash
# Path: shell
rg -n 'reviewRequired|meetingTime|meeting_overran|in_progress|meetingReviews|startedAt|stoppedAt' convex/reporting convex/operations convex/dashboard app/workspace/reports app/workspace/operations app/workspace/opportunities app/workspace/_components components/command-palette.tsx
```

Expected remaining matches must be intentional migration-window schema/status-config references or unrelated variables such as process start times, not report behavior.

**Step 2: Type-check and lint.**

```bash
# Path: shell
pnpm tsc --noEmit
pnpm lint
```

**Step 3: Deploy.**

```bash
# Path: shell
npx convex deploy
```

**Step 4: Browser smoke-check remaining report routes.**

Open:

- `/workspace/reports/pipeline`
- `/workspace/reports/team`
- `/workspace/operations`
- `/workspace/opportunities`

Confirm deleted routes are absent from nav and direct navigation to deleted routes returns the app's normal not-found behavior.

**Key implementation notes:**
- Do not repair aggregates manually here; Phase 5 owns repair/rebuild after source state changes.
- If a report still displays a zero "review required" tile, remove the tile. Do not keep dead UI.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| Convex / Next deployment | Deploy | Reporting code no longer depends on legacy concepts |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/reporting/teamPerformance.ts` | Modify | 4A |
| `convex/reporting/pipelineHealth.ts` | Modify | 4A |
| `convex/dashboard/overviewOperations.ts` | Modify | 4A |
| `convex/operations/meetingStats.ts` | Modify | 4A |
| `convex/operations/phoneSales.ts` | Modify | 4A |
| `convex/reporting/teamOutcomes.ts` | Modify | 4A |
| `app/workspace/reports/meeting-time/**` | Delete | 4B |
| `app/workspace/reports/reviews/**` | Delete | 4B |
| `convex/reporting/meetingTime.ts` | Delete | 4B |
| `convex/reporting/reviewsReporting.ts` | Delete | 4B |
| `app/workspace/reports/pipeline/_components/pending-overran-reviews-card.tsx` | Delete | 4B |
| `app/workspace/reports/team/_components/meeting-time-summary.tsx` | Delete | 4B |
| `app/workspace/reports/team/_components/closer-performance-table.tsx` | Modify | 4B |
| `app/workspace/reports/team/_components/team-report-page-client.tsx` | Modify | 4B |
| `app/workspace/reports/pipeline/_components/pipeline-report-page-client.tsx` | Modify | 4B |
| `convex/reporting/lib/outcomeDerivation.ts` | Modify | 4C |
| `convex/reporting/lib/eventLabels.ts` | Modify | 4C |
| `convex/reporting/activityFeed.ts` | Modify | 4C |
| Multiple report/filter/chart components | Modify | 4C |
| `posthog-setup-report.md` or current PostHog setup note | Modify / Create | 4D |
