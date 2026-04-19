# Phase 1 — Foundation: Schema, Status Renames & WIP Cleanup

**Goal:** Refactor the database schema to replace the WIP late-start review system with the new scheduler-based "meeting overran" detection model. Rename `pending_review` → `meeting_overran` across the entire codebase (~34 files), remove deprecated WIP files and fields, rename `overranDurationMs` → `exceededScheduledDurationMs`, and deploy the new schema. After this phase, the data model is ready for all subsequent backend and frontend phases.

**Prerequisite:** v0.6 schema deployed. Current branch with WIP late-start dialog and schema additions available (these are being refactored, not reverted).

**Runs in PARALLEL with:** Nothing — all subsequent phases depend on this. This is the critical foundation.

> **Critical path:** This phase is on the critical path (Phase 1 → Phase 2 → Phase 3 → Phase 4 for backend; Phase 1 → Phase 5 → Phase 6 for frontend). Start immediately.

**Skills to invoke:**
- `convex-migration-helper` — although no data migration is needed (1 test tenant, no production data in affected fields), the `overranDurationMs` → `exceededScheduledDurationMs` rename affects production data and needs the widen-migrate-narrow pattern or direct rename with acceptance of data loss.

**Acceptance Criteria:**
1. `convex/schema.ts` contains the refactored `meetingReviews` table with `category: v.literal("meeting_overran")`, optional `closerResponse`, optional `closerNote`, status union `pending | resolved`, and all new fields per the design spec.
2. `convex/schema.ts` `meetings` table contains `meeting_overran` in the status union, `attendanceCheckId`, `overranDetectedAt` fields, and does NOT contain `closer_no_show`, `startedOutsideWindow`, `lateStartCategory`, `lateStartNote`, `estimatedMeetingDurationMinutes`, `effectiveStartedAt`, or `overranDurationMs`.
3. `convex/schema.ts` `opportunities` table contains `meeting_overran` in the status union and does NOT contain `pending_review`.
4. Zero references to `"pending_review"` exist in any `.ts` or `.tsx` file (verified via codebase-wide search).
5. Zero references to `"closer_no_show"` exist in any `.ts` or `.tsx` file.
6. Zero references to `overranDurationMs` exist in any `.ts` or `.tsx` file — all replaced with `exceededScheduledDurationMs`.
7. `convex/closer/lateStartReview.ts` has been deleted.
8. `app/workspace/closer/meetings/_components/late-start-reason-dialog.tsx` has been deleted.
9. `convex/lib/statusTransitions.ts` contains `meeting_overran` in both `OPPORTUNITY_STATUSES` and `MEETING_STATUSES`, with correct transition rules.
10. `lib/status-config.ts` contains `meeting_overran` entries for both opportunity and meeting status configs, with amber styling, and `PIPELINE_DISPLAY_ORDER` includes `meeting_overran` after `in_progress`.
11. `npx convex dev` deploys the schema without errors.
12. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (Schema refactoring) ───────────────────────────────────┐
                                                            ├── 1C (Backend status renames)
1B (Status transitions & shared libs) ────────────────────┤
                                                            ├── 1D (Frontend/shared status renames)
                                                            │
                                                            └── 1E (WIP removal + field rename)
                                                                     │
1C + 1D + 1E complete ──────────────────────────────────────────────┘
                                                                     │
                                                              1F (Deploy & verify)
```

**Optimal execution:**
1. Start 1A and 1B in parallel (1A touches `convex/schema.ts`, 1B touches `convex/lib/statusTransitions.ts`, `convex/lib/permissions.ts`, `convex/lib/tenantStatsHelper.ts` — no file overlap).
2. Once 1A and 1B complete → start 1C, 1D, and 1E all in parallel (they touch different file sets with no overlap).
3. Once 1C, 1D, and 1E complete → run 1F (deploy + verify).

**Estimated time:** 1–2 days

---

## Subphases

### 1A — Schema Refactoring

**Type:** Backend
**Parallelizable:** Yes — touches only `convex/schema.ts`. Can run in parallel with 1B.

**What:** Refactor the `meetingReviews` table definition, modify the `meetings` table (add/remove/rename fields, update status union), and modify the `opportunities` table status union in `convex/schema.ts`.

**Why:** Every subsequent phase imports types from `convex/_generated/dataModel`. Without the correct schema, TypeScript compilation fails and the new fields/statuses are unavailable. The schema is the single source of truth.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Refactor the `meetingReviews` table**

Replace the entire `meetingReviews` table definition. The existing WIP schema uses `lateStartCategory` (required), `closerNote` (required), `minutesPastWindow` (required), evidence fields, and a 3-status union. The new schema uses `category: v.literal("meeting_overran")`, optional closer fields, and a 2-status union.

```typescript
// Path: convex/schema.ts — Replace the meetingReviews table definition

// BEFORE (WIP schema):
meetingReviews: defineTable({
  tenantId: v.id("tenants"),
  meetingId: v.id("meetings"),
  opportunityId: v.id("opportunities"),
  closerId: v.id("users"),
  lateStartCategory: v.union(
    v.literal("forgot_to_press"),
    v.literal("closer_no_show"),
    v.literal("previous_meeting_overran"),
  ),
  closerNote: v.string(),
  closerStatedOutcome: v.optional(
    v.union(
      v.literal("sale_made"),
      v.literal("follow_up_needed"),
      v.literal("lead_not_interested"),
      v.literal("lead_no_show"),
      v.literal("other"),
    ),
  ),
  minutesPastWindow: v.number(),
  evidenceFileId: v.optional(v.id("_storage")),
  paymentEvidenceFileId: v.optional(v.id("_storage")),
  status: v.union(
    v.literal("pending"),
    v.literal("evidence_uploaded"),
    v.literal("resolved"),
  ),
  resolvedAt: v.optional(v.number()),
  resolvedByUserId: v.optional(v.id("users")),
  resolutionAction: v.optional(
    v.union(
      v.literal("log_payment"),
      v.literal("schedule_follow_up"),
      v.literal("mark_no_show"),
      v.literal("mark_lost"),
      v.literal("evidence_not_uploaded"),
    ),
  ),
  resolutionNote: v.optional(v.string()),
  createdAt: v.number(),
})
  .index("by_tenantId_and_status_and_createdAt", ["tenantId", "status", "createdAt"])
  .index("by_meetingId", ["meetingId"])
  .index("by_tenantId_and_closerId_and_createdAt", ["tenantId", "closerId", "createdAt"]),

// AFTER (v3.0 schema):
meetingReviews: defineTable({
  tenantId: v.id("tenants"),
  meetingId: v.id("meetings"),
  opportunityId: v.id("opportunities"),
  closerId: v.id("users"),

  // ── System Detection ────────────────────────────────────────────────
  category: v.literal("meeting_overran"),

  // ── Closer Response (optional) ──────────────────────────────────────
  closerResponse: v.optional(
    v.union(
      v.literal("forgot_to_press"),
      v.literal("did_not_attend"),
    ),
  ),
  closerNote: v.optional(v.string()),
  closerStatedOutcome: v.optional(
    v.union(
      v.literal("sale_made"),
      v.literal("follow_up_needed"),
      v.literal("lead_not_interested"),
      v.literal("lead_no_show"),
      v.literal("other"),
    ),
  ),
  estimatedMeetingDurationMinutes: v.optional(v.number()),
  closerRespondedAt: v.optional(v.number()),

  // ── Review Lifecycle ────────────────────────────────────────────────
  status: v.union(
    v.literal("pending"),
    v.literal("resolved"),
  ),

  // ── Resolution ──────────────────────────────────────────────────────
  resolvedAt: v.optional(v.number()),
  resolvedByUserId: v.optional(v.id("users")),
  resolutionAction: v.optional(
    v.union(
      v.literal("log_payment"),
      v.literal("schedule_follow_up"),
      v.literal("mark_no_show"),
      v.literal("mark_lost"),
      v.literal("acknowledged"),
    ),
  ),
  resolutionNote: v.optional(v.string()),

  createdAt: v.number(),
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
```

**Step 2: Modify the `meetings` table status union and fields**

```typescript
// Path: convex/schema.ts — meetings table modifications

// STATUS UNION — replace closer_no_show with meeting_overran:
status: v.union(
  v.literal("scheduled"),
  v.literal("in_progress"),
  v.literal("completed"),
  v.literal("canceled"),
  v.literal("no_show"),
  v.literal("meeting_overran"),  // NEW — replaces closer_no_show
),

// NEW FIELDS — add after existing fields:
attendanceCheckId: v.optional(v.id("_scheduled_functions")),
overranDetectedAt: v.optional(v.number()),

// RENAMED FIELD:
// overranDurationMs → exceededScheduledDurationMs
exceededScheduledDurationMs: v.optional(v.number()),

// REMOVED FIELDS (delete these lines entirely):
// startedOutsideWindow: v.optional(v.boolean()),         ← DELETE
// lateStartCategory: v.optional(v.union(...)),            ← DELETE
// lateStartNote: v.optional(v.string()),                  ← DELETE
// estimatedMeetingDurationMinutes: v.optional(v.number()),← DELETE
// effectiveStartedAt: v.optional(v.number()),             ← DELETE

// KEPT FIELDS (no change):
// lateStartDurationMs: v.optional(v.number()),  ← KEEP — time tracking for late-but-within-window starts
// reviewId: v.optional(v.id("meetingReviews")), ← KEEP — link to review record
```

**Step 3: Modify the `opportunities` table status union**

```typescript
// Path: convex/schema.ts — opportunities table, status field

// BEFORE:
status: v.union(
  v.literal("scheduled"),
  v.literal("in_progress"),
  v.literal("pending_review"),
  // ...
),

// AFTER:
status: v.union(
  v.literal("scheduled"),
  v.literal("in_progress"),
  v.literal("meeting_overran"),  // RENAMED from pending_review
  v.literal("payment_received"),
  v.literal("follow_up_scheduled"),
  v.literal("reschedule_link_sent"),
  v.literal("lost"),
  v.literal("canceled"),
  v.literal("no_show"),
),
```

**Key implementation notes:**
- The `meetingReviews` table indexes are unchanged — the same 3 indexes work for the new schema.
- `closerNote` changed from required (`v.string()`) to optional (`v.optional(v.string())`) — the closer may never respond.
- `minutesPastWindow` is removed entirely — the review is created by the scheduler which already knows the timing.
- `evidenceFileId` and `paymentEvidenceFileId` are removed — evidence upload is dropped from the design.
- `evidence_uploaded` status is removed — only `pending` and `resolved` remain.
- `evidence_not_uploaded` resolution action is replaced by `acknowledged`.
- The `reviewId` field on `meetings` is kept as-is — it now links to scheduler-created reviews instead of closer-created reviews.
- `lateStartDurationMs` on meetings is kept — it's a time-tracking metric for meetings started late but within the window, unrelated to the review system.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Refactor meetingReviews table, modify meetings fields + status union, modify opportunities status union |

---

### 1B — Status Transitions & Shared Libraries

**Type:** Backend
**Parallelizable:** Yes — touches `convex/lib/statusTransitions.ts`, `convex/lib/tenantStatsHelper.ts`. No overlap with 1A.

**What:** Update the status transition maps, meeting status arrays, and active opportunity status sets to use `meeting_overran` instead of `pending_review` / `closer_no_show`.

**Why:** All pipeline processing, closer mutations, and admin mutations use `validateTransition()` to guard status changes. If the transition map doesn't include `meeting_overran`, the scheduler's attendance check mutation will fail. The tenant stats helper determines which opportunities count as "active" — `meeting_overran` must be active (it's not terminal).

**Where:**
- `convex/lib/statusTransitions.ts` (modify)
- `convex/lib/tenantStatsHelper.ts` (modify)

**How:**

**Step 1: Update `statusTransitions.ts`**

```typescript
// Path: convex/lib/statusTransitions.ts

// OPPORTUNITY_STATUSES — rename pending_review → meeting_overran:
export const OPPORTUNITY_STATUSES = [
  "scheduled",
  "in_progress",
  "meeting_overran",       // RENAMED from pending_review
  "payment_received",
  "follow_up_scheduled",
  "reschedule_link_sent",
  "lost",
  "canceled",
  "no_show",
] as const;

// VALID_TRANSITIONS — rename key and update:
export const VALID_TRANSITIONS: Record<OpportunityStatus, OpportunityStatus[]> = {
  scheduled: ["in_progress", "meeting_overran", "canceled", "no_show"],  // MODIFIED: pending_review → meeting_overran
  in_progress: ["payment_received", "follow_up_scheduled", "no_show", "lost"],
  meeting_overran: ["follow_up_scheduled", "payment_received", "no_show", "lost"],  // RENAMED from pending_review
  canceled: ["follow_up_scheduled", "scheduled"],
  no_show: ["follow_up_scheduled", "reschedule_link_sent", "scheduled"],
  follow_up_scheduled: ["scheduled"],
  reschedule_link_sent: ["scheduled"],
  payment_received: [],
  lost: [],
};

// MEETING_STATUSES — remove closer_no_show, add meeting_overran:
export const MEETING_STATUSES = [
  "scheduled",
  "in_progress",
  "completed",
  "canceled",
  "no_show",
  "meeting_overran",    // NEW — replaces closer_no_show
] as const;

// MEETING VALID_TRANSITIONS — update:
// Add: scheduled → meeting_overran (scheduler detection)
// Add: meeting_overran → completed (admin corrects false positive)
// Remove: any transitions involving closer_no_show
```

**Step 2: Update `tenantStatsHelper.ts`**

```typescript
// Path: convex/lib/tenantStatsHelper.ts

// BEFORE:
export const ACTIVE_OPPORTUNITY_STATUSES = new Set([
  "scheduled",
  "in_progress",
  "pending_review",
  "follow_up_scheduled",
  "reschedule_link_sent",
] as const);

// AFTER:
export const ACTIVE_OPPORTUNITY_STATUSES = new Set([
  "scheduled",
  "in_progress",
  "meeting_overran",       // RENAMED from pending_review
  "follow_up_scheduled",
  "reschedule_link_sent",
] as const);
```

**Key implementation notes:**
- The `meeting_overran` opportunity status allows transitions to: `follow_up_scheduled` (closer or admin), `payment_received` (admin), `no_show` (admin), `lost` (admin). This matches the design exactly.
- `meeting_overran` is NOT terminal — it's an active status awaiting resolution.
- `scheduled → meeting_overran` is a new valid transition (triggered by the scheduler).
- For meeting transitions: `scheduled → meeting_overran` is the scheduler detection. `meeting_overran → completed` is the admin false-positive correction.
- `closer_no_show` is completely removed from meeting statuses — it's replaced by `meeting_overran`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/statusTransitions.ts` | Modify | Rename pending_review → meeting_overran in opportunity statuses/transitions, replace closer_no_show → meeting_overran in meeting statuses/transitions |
| `convex/lib/tenantStatsHelper.ts` | Modify | Rename pending_review → meeting_overran in ACTIVE_OPPORTUNITY_STATUSES |

---

### 1C — Backend Status Renames (Convex Files)

**Type:** Backend
**Parallelizable:** Yes — after 1A and 1B complete. Can run in parallel with 1D and 1E.

**What:** Rename all `"pending_review"` references to `"meeting_overran"` and all `"closer_no_show"` references to `"meeting_overran"` across all Convex backend files. This is a mechanical find-and-replace with verification.

**Why:** After the schema change (1A) and transition map update (1B), all code referencing the old status names will cause TypeScript errors. Every file must use the new names.

**Where:**
- `convex/pipeline/inviteeCanceled.ts` (modify)
- `convex/pipeline/inviteeNoShow.ts` (modify)
- `convex/reviews/mutations.ts` (modify)
- `convex/reviews/queries.ts` (modify)
- `convex/closer/dashboard.ts` (modify)
- `convex/closer/meetingActions.ts` (modify)
- `convex/closer/followUpMutations.ts` (modify)
- `convex/closer/followUp.ts` (modify)
- `convex/closer/noShowActions.ts` (modify)
- `convex/closer/payments.ts` (modify)
- `convex/closer/pipeline.ts` (modify)
- `convex/opportunities/queries.ts` (modify)
- `convex/workos/userMutations.ts` (modify)
- `convex/users/queries.ts` (modify)
- `convex/reporting/pipelineHealth.ts` (modify)
- `convex/reporting/lib/outcomeDerivation.ts` (modify)
- `convex/reporting/teamPerformance.ts` (modify)

**How:**

**Step 1: Rename `"pending_review"` → `"meeting_overran"` in all Convex files**

For each file listed below, perform the string replacement. Every occurrence is a status literal comparison, status filter, or status array entry.

```typescript
// Path: convex/pipeline/inviteeCanceled.ts
// BEFORE (line ~95):
if (opportunity?.status === "pending_review") {
// AFTER:
if (opportunity?.status === "meeting_overran") {

// Path: convex/pipeline/inviteeNoShow.ts
// BEFORE (line ~88):
if (opportunity?.status === "pending_review") {
// AFTER:
if (opportunity?.status === "meeting_overran") {

// Path: convex/reviews/mutations.ts
// BEFORE: opportunity.status !== "pending_review"
// AFTER: opportunity.status !== "meeting_overran"

// Path: convex/closer/dashboard.ts
// BEFORE (line ~7): "pending_review" in PIPELINE_STATUSES array
// AFTER: "meeting_overran"
// BEFORE (line ~97): pending_review: 0 in counts object
// AFTER: meeting_overran: 0

// Path: convex/closer/pipeline.ts
// BEFORE (line ~10): v.literal("pending_review")
// AFTER: v.literal("meeting_overran")

// Path: convex/closer/meetingActions.ts — any pending_review references
// Path: convex/closer/followUpMutations.ts
// BEFORE (line ~76): if (opportunity.status === "pending_review")
// AFTER: if (opportunity.status === "meeting_overran")

// Path: convex/closer/followUp.ts — pending_review references
// Path: convex/closer/noShowActions.ts — pending_review references
// Path: convex/closer/payments.ts — pending_review references

// Path: convex/opportunities/queries.ts
// BEFORE (line ~12): v.literal("pending_review")
// AFTER: v.literal("meeting_overran")

// Path: convex/workos/userMutations.ts
// BEFORE (line ~574): "pending_review" in activeStatuses array
// AFTER: "meeting_overran"

// Path: convex/users/queries.ts
// BEFORE (line ~104): "pending_review" in activeStatuses array
// AFTER: "meeting_overran"

// Path: convex/reporting/pipelineHealth.ts
// BEFORE (lines ~10, ~22): "pending_review" in status arrays
// AFTER: "meeting_overran"

// Path: convex/reporting/lib/outcomeDerivation.ts
// BEFORE (line ~53): if (opportunity.status === "pending_review")
// AFTER: if (opportunity.status === "meeting_overran")
```

**Step 2: Rename `"closer_no_show"` → `"meeting_overran"` in meeting status references**

```typescript
// Path: convex/reporting/lib/outcomeDerivation.ts
// BEFORE (line ~35):
if (meeting.status === "closer_no_show") {
  return "no_show";
}
// AFTER:
if (meeting.status === "meeting_overran") {
  return "no_show";
}

// Path: convex/reporting/teamPerformance.ts
// BEFORE (line ~19): "closer_no_show" in MEETING_STATUSES
// AFTER: "meeting_overran"
// BEFORE (line ~161): countsForClassification.closer_no_show
// AFTER: countsForClassification.meeting_overran
```

**Step 3: Verify with TypeScript compilation**

```bash
pnpm tsc --noEmit 2>&1 | grep -i "pending_review\|closer_no_show"
```

Should return zero matches.

**Key implementation notes:**
- The `convex/closer/followUpMutations.ts` `transitionToFollowUp` function currently BLOCKS when `opportunity.status === "pending_review"`. Change this to `"meeting_overran"`. The design allows closers to schedule follow-ups from `meeting_overran` status via the dedicated `scheduleFollowUpFromOverran` mutation (Phase 3), but the generic `transitionToFollowUp` should still block — only the dedicated mutation handles this transition.
- In `convex/reporting/teamPerformance.ts`, the `MEETING_STATUSES` array and the metrics calculation both reference `closer_no_show`. Both must be renamed to `meeting_overran`. The noShows metric now includes `meeting_overran` counts — this is semantically correct (closer didn't attend).
- In `convex/reporting/lib/outcomeDerivation.ts`, `meeting.status === "meeting_overran"` maps to CallOutcome `"no_show"` — the closer didn't attend, which is functionally a no-show from the reporting perspective.
- In `convex/reviews/queries.ts`, the existing query filters by both `"pending"` AND `"evidence_uploaded"` statuses. Since `"evidence_uploaded"` is being removed from the schema (1A), also remove the second query in `listPendingReviews` and `getPendingReviewCount` that queries for `evidence_uploaded`. This simplification will be fully completed in Phase 4 (4A, 4C), but the type errors from the status removal need to be fixed here to pass tsc.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/inviteeCanceled.ts` | Modify | `pending_review` → `meeting_overran` in guard |
| `convex/pipeline/inviteeNoShow.ts` | Modify | `pending_review` → `meeting_overran` in guard |
| `convex/reviews/mutations.ts` | Modify | `pending_review` → `meeting_overran` in guard; `evidence_not_uploaded` → remove (fix type error) |
| `convex/reviews/queries.ts` | Modify | Remove `evidence_uploaded` status queries (fix type error from schema change) |
| `convex/closer/dashboard.ts` | Modify | `pending_review` → `meeting_overran` in PIPELINE_STATUSES + counts |
| `convex/closer/meetingActions.ts` | Modify | `pending_review` → `meeting_overran` if referenced |
| `convex/closer/followUpMutations.ts` | Modify | `pending_review` → `meeting_overran` in guard |
| `convex/closer/followUp.ts` | Modify | `pending_review` → `meeting_overran` |
| `convex/closer/noShowActions.ts` | Modify | `pending_review` → `meeting_overran` |
| `convex/closer/payments.ts` | Modify | `pending_review` → `meeting_overran` |
| `convex/closer/pipeline.ts` | Modify | `pending_review` → `meeting_overran` in validator |
| `convex/opportunities/queries.ts` | Modify | `pending_review` → `meeting_overran` in validator |
| `convex/workos/userMutations.ts` | Modify | `pending_review` → `meeting_overran` in activeStatuses |
| `convex/users/queries.ts` | Modify | `pending_review` → `meeting_overran` in activeStatuses |
| `convex/reporting/pipelineHealth.ts` | Modify | `pending_review` → `meeting_overran` in both arrays |
| `convex/reporting/lib/outcomeDerivation.ts` | Modify | `pending_review` → `meeting_overran`, `closer_no_show` → `meeting_overran` |
| `convex/reporting/teamPerformance.ts` | Modify | `closer_no_show` → `meeting_overran` in MEETING_STATUSES + metrics |

---

### 1D — Frontend & Shared Status Renames

**Type:** Frontend
**Parallelizable:** Yes — after 1A and 1B complete. Can run in parallel with 1C and 1E.

**What:** Rename all `"pending_review"` references to `"meeting_overran"` and `"closer_no_show"` references to `"meeting_overran"` across all frontend and shared files. Update `lib/status-config.ts` with new styling entries and pipeline display order.

**Why:** The frontend status configuration drives all badge rendering, pipeline filters, chart colors, and display ordering. Without these updates, the UI shows incorrect labels for the new status and TypeScript compilation fails.

**Where:**
- `lib/status-config.ts` (modify)
- `app/workspace/pipeline/_components/pipeline-filters.tsx` (modify)
- `app/workspace/reports/pipeline/_components/status-distribution-chart.tsx` (modify)
- `app/workspace/reports/pipeline/_components/pipeline-aging-table.tsx` (modify)
- `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` (modify)

**How:**

**Step 1: Update `lib/status-config.ts`**

```typescript
// Path: lib/status-config.ts

// OPPORTUNITY STATUS CONFIG — rename pending_review entry:
// BEFORE:
pending_review: {
  label: "Pending Review",
  badgeClass: "bg-amber-500/10 text-amber-700 border-amber-200 dark:text-amber-400 dark:border-amber-900",
  dotClass: "bg-amber-500",
  stripBg: "bg-amber-500/5 hover:bg-amber-500/10 border-amber-200/60 dark:border-amber-900/60",
},

// AFTER:
meeting_overran: {
  label: "Meeting Overran",
  badgeClass: "bg-amber-500/10 text-amber-700 border-amber-200 dark:text-amber-400 dark:border-amber-900",
  dotClass: "bg-amber-500",
  stripBg: "bg-amber-500/5 hover:bg-amber-500/10 border-amber-200/60 dark:border-amber-900/60",
},

// MEETING STATUS CONFIG — remove closer_no_show, add meeting_overran:
// REMOVE:
closer_no_show: {
  label: "Closer No-Show",
  blockClass: "...",
  textClass: "...",
},
// ADD:
meeting_overran: {
  label: "Meeting Overran",
  blockClass: "bg-amber-500/10 border-amber-200 dark:border-amber-900",
  textClass: "text-amber-700 dark:text-amber-400",
},

// PIPELINE_DISPLAY_ORDER — rename:
export const PIPELINE_DISPLAY_ORDER: OpportunityStatus[] = [
  "scheduled",
  "in_progress",
  "meeting_overran",       // RENAMED from pending_review
  "follow_up_scheduled",
  "reschedule_link_sent",
  "payment_received",
  "lost",
  "canceled",
  "no_show",
];

// Update the OpportunityStatus type if defined here:
// Replace "pending_review" → "meeting_overran" in the type union
```

**Step 2: Update pipeline filters**

```typescript
// Path: app/workspace/pipeline/_components/pipeline-filters.tsx
// BEFORE: any "pending_review" filter option
// AFTER: "meeting_overran" with label "Meeting Overran"
```

**Step 3: Update report charts**

```typescript
// Path: app/workspace/reports/pipeline/_components/status-distribution-chart.tsx
// BEFORE (line ~24):
pending_review: "hsl(var(--warning, 45 93% 47%))",
// AFTER:
meeting_overran: "hsl(var(--warning, 45 93% 47%))",

// Path: app/workspace/reports/pipeline/_components/pipeline-aging-table.tsx
// BEFORE (line ~21):
"pending_review",
// AFTER:
"meeting_overran",
```

**Step 4: Update outcome action bar**

```typescript
// Path: app/workspace/closer/meetings/_components/outcome-action-bar.tsx
// Any reference to "pending_review" status → "meeting_overran"
// This component currently opens the late-start dialog when outside the window.
// The late-start dialog is being removed (1E) and replaced later (Phase 5).
// For now, remove the late-start dialog reference and leave a TODO comment.
```

**Key implementation notes:**
- The `OpportunityStatus` type may be derived from `lib/status-config.ts` or from the Convex schema types. Ensure the type union is consistent.
- The amber color scheme for `meeting_overran` is intentionally the same as the old `pending_review` — amber conveys "needs attention."
- Pipeline display order places `meeting_overran` right after `in_progress` — this is the natural flow (meeting was scheduled → closer didn't attend → needs resolution).
- The `outcome-action-bar.tsx` component currently references the `LateStartReasonDialog` component which is being removed in 1E. Replace the import and the `showLateStartDialog` state with a temporary placeholder that will be completed in Phase 5.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `lib/status-config.ts` | Modify | Rename pending_review → meeting_overran in opportunity config; remove closer_no_show + add meeting_overran in meeting config; update PIPELINE_DISPLAY_ORDER |
| `app/workspace/pipeline/_components/pipeline-filters.tsx` | Modify | Rename filter option |
| `app/workspace/reports/pipeline/_components/status-distribution-chart.tsx` | Modify | Rename STATUS_COLORS key |
| `app/workspace/reports/pipeline/_components/pipeline-aging-table.tsx` | Modify | Rename ACTIVE_STATUSES entry |
| `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` | Modify | Rename status references, remove late-start dialog reference |

---

### 1E — WIP File Removal & Field Rename

**Type:** Full-Stack
**Parallelizable:** Yes — after 1A and 1B complete. Can run in parallel with 1C and 1D.

**What:** Delete the WIP `convex/closer/lateStartReview.ts` and `app/workspace/closer/meetings/_components/late-start-reason-dialog.tsx` files. Rename `overranDurationMs` → `exceededScheduledDurationMs` in all references.

**Why:** The WIP files implement the old closer-triggered late-start flow which is being replaced by the scheduler-based system. They must be removed to avoid confusion and import errors. The field rename decouples "overran" (time tracking) from "meeting overran" (review concept).

**Where:**
- `convex/closer/lateStartReview.ts` (delete)
- `app/workspace/closer/meetings/_components/late-start-reason-dialog.tsx` (delete)
- `convex/closer/meetingActions.ts` (modify — field rename)
- `convex/admin/meetingActions.ts` (modify — field rename)

**How:**

**Step 1: Delete WIP files**

```bash
rm convex/closer/lateStartReview.ts
rm app/workspace/closer/meetings/_components/late-start-reason-dialog.tsx
```

**Step 2: Remove imports of deleted files**

Search for any files that import from the deleted files and remove those imports + usages:

```typescript
// Search for: import.*lateStartReview
// Search for: import.*late-start-reason-dialog
// Search for: api.closer.lateStartReview
```

In `app/workspace/closer/meetings/_components/outcome-action-bar.tsx`:
```typescript
// REMOVE this import:
import { LateStartReasonDialog } from "./late-start-reason-dialog";
// REMOVE any state: const [showLateStartDialog, setShowLateStartDialog] = useState(false);
// REMOVE the dialog JSX: <LateStartReasonDialog ... />
```

**Step 3: Rename `overranDurationMs` → `exceededScheduledDurationMs`**

```typescript
// Path: convex/closer/meetingActions.ts — inside stopMeeting handler
// BEFORE:
overranDurationMs: stoppedAt - scheduledEndMs,
// AFTER:
exceededScheduledDurationMs: stoppedAt - scheduledEndMs,

// Path: convex/admin/meetingActions.ts — inside adminResolveMeeting handler
// BEFORE:
overranDurationMs: ...
// AFTER:
exceededScheduledDurationMs: ...
```

**Key implementation notes:**
- After deleting `convex/closer/lateStartReview.ts`, the Convex function registry (`api.closer.lateStartReview.*`) ceases to exist. Any frontend code referencing these functions will fail. The outcome-action-bar is the only consumer — remove its references.
- The `overranDurationMs` → `exceededScheduledDurationMs` rename affects 2 backend files. Since there is 1 test tenant and this data is informational (not business-critical), direct rename is acceptable. If data preservation is desired, use widen-migrate-narrow: (1) add `exceededScheduledDurationMs` as optional, (2) run migration to copy values, (3) remove `overranDurationMs`.
- After file deletion, verify no dangling imports with: `pnpm tsc --noEmit`

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/lateStartReview.ts` | Delete | Entire WIP file removed |
| `app/workspace/closer/meetings/_components/late-start-reason-dialog.tsx` | Delete | Entire WIP dialog removed |
| `convex/closer/meetingActions.ts` | Modify | overranDurationMs → exceededScheduledDurationMs |
| `convex/admin/meetingActions.ts` | Modify | overranDurationMs → exceededScheduledDurationMs |
| `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` | Modify | Remove LateStartReasonDialog import + usage |

---

### 1F — Deploy & Verify

**Type:** Manual / Config
**Parallelizable:** No — must run after 1A, 1B, 1C, 1D, 1E all complete.

**What:** Deploy the updated schema to Convex, verify TypeScript compilation, and confirm the application runs correctly.

**Why:** Schema changes must be deployed before any new code that depends on the new field names, status values, or table structure. This is the quality gate before proceeding to implementation phases.

**Where:**
- No files created or modified — verification only.

**How:**

**Step 1: TypeScript compilation check**

```bash
pnpm tsc --noEmit
```

Must pass with zero errors.

**Step 2: Verify no stale references**

```bash
# No pending_review references
grep -r "pending_review" convex/ lib/ app/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v .next

# No closer_no_show references
grep -r "closer_no_show" convex/ lib/ app/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v .next

# No overranDurationMs references
grep -r "overranDurationMs" convex/ lib/ app/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v .next

# No lateStartReview imports
grep -r "lateStartReview\|late-start-reason-dialog" convex/ lib/ app/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v .next
```

All must return zero results.

**Step 3: Deploy schema**

```bash
npx convex dev
```

Verify: "Schema pushed successfully" with no errors.

**Step 4: Verify in Convex dashboard**

- Navigate to the Convex dashboard.
- Verify `meetingReviews` table shows the new schema (category, closerResponse, 2-status union).
- Verify `meetings` table shows `meeting_overran` in status union, no `closer_no_show`.
- Verify `opportunities` table shows `meeting_overran` in status union, no `pending_review`.

**Step 5: Verify application loads**

```bash
pnpm dev
```

Navigate to `/workspace` — the application should load without console errors. The pipeline strip should show "Meeting Overran" label (with 0 count).

**Key implementation notes:**
- If `npx convex dev` fails with schema validation errors, check that no existing documents violate the new schema. With 1 test tenant and no production usage of the late-start review system, there should be no conflicts.
- If any documents have `closer_no_show` meeting status or `pending_review` opportunity status in the database, they need manual cleanup in the Convex dashboard before the schema can be deployed.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| — | — | Verification only — no files modified |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modify | 1A |
| `convex/lib/statusTransitions.ts` | Modify | 1B |
| `convex/lib/tenantStatsHelper.ts` | Modify | 1B |
| `convex/pipeline/inviteeCanceled.ts` | Modify | 1C |
| `convex/pipeline/inviteeNoShow.ts` | Modify | 1C |
| `convex/reviews/mutations.ts` | Modify | 1C |
| `convex/reviews/queries.ts` | Modify | 1C |
| `convex/closer/dashboard.ts` | Modify | 1C |
| `convex/closer/meetingActions.ts` | Modify | 1C, 1E |
| `convex/closer/followUpMutations.ts` | Modify | 1C |
| `convex/closer/followUp.ts` | Modify | 1C |
| `convex/closer/noShowActions.ts` | Modify | 1C |
| `convex/closer/payments.ts` | Modify | 1C |
| `convex/closer/pipeline.ts` | Modify | 1C |
| `convex/opportunities/queries.ts` | Modify | 1C |
| `convex/workos/userMutations.ts` | Modify | 1C |
| `convex/users/queries.ts` | Modify | 1C |
| `convex/reporting/pipelineHealth.ts` | Modify | 1C |
| `convex/reporting/lib/outcomeDerivation.ts` | Modify | 1C |
| `convex/reporting/teamPerformance.ts` | Modify | 1C |
| `lib/status-config.ts` | Modify | 1D |
| `app/workspace/pipeline/_components/pipeline-filters.tsx` | Modify | 1D |
| `app/workspace/reports/pipeline/_components/status-distribution-chart.tsx` | Modify | 1D |
| `app/workspace/reports/pipeline/_components/pipeline-aging-table.tsx` | Modify | 1D |
| `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` | Modify | 1D, 1E |
| `convex/closer/lateStartReview.ts` | Delete | 1E |
| `app/workspace/closer/meetings/_components/late-start-reason-dialog.tsx` | Delete | 1E |
| `convex/admin/meetingActions.ts` | Modify | 1E |
