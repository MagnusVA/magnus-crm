# Phase 6 - Schema Narrow

**Goal:** Remove legacy lifecycle statuses, fields, tables, functions, and temporary migration code so the deployed schema and generated types behave as if `meeting_overran`, `in_progress`, Start/End timing, and `meetingReviews` never existed.

**Prerequisite:** Phase 5 production verification is complete. `countLegacyLifecycleRows` returns all zeros, `compareLifecycleAggregates` returns no mismatches, `meetingReviews` has zero rows, and `_scheduled_functions` has no pending `checkMeetingAttendance` jobs.

**Runs in PARALLEL with:** Nothing. This is the final narrow and must be one coordinated deploy.

**Skills to invoke:**
- `convex-migration-helper` - verify the narrow follows widen -> migrate -> narrow and does not run before data-at-rest is clean.
- `next-best-practices` - route/type cleanup if any App Router references remain.
- `convex-performance-audit` - use only if final aggregate verification finds drift.

**Docs and references to read first:**
- `plans/phone-closer-overrun-refactor/phone-closer-overrun-refactor-design.md` Sections 9, 10, 11, 12, and 14.
- `.agents/skills/convex-migration-helper/SKILL.md` and `.agents/skills/convex-migration-helper/references/migration-patterns.md`.
- `convex/_generated/ai/guidelines.md` for schema validators and generated API/type constraints.
- `node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md` for final route cleanup.
- Phase 5 audit output and migration component status.

**Deploy / backfill / manual operations:**
- **Deploy required:** Yes. This is the final schema/code narrow deploy.
- **Backfill or migration required:** No new backfill in this phase. If deploy fails due to schema validation, stop and return to Phase 5 repair.
- **Manual operations:** Run Phase 5 audits immediately before deploy and after deploy. Delete temporary migration/audit code only in this phase.

**Acceptance Criteria:**
1. `convex/schema.ts` no longer contains `meetingReviews`, `meeting_overran`, or meeting `in_progress` literals.
2. `opportunities.status`, `opportunitySearch.status`, `meetings.opportunityStatus`, `operationsMeetingDailyStats.opportunityStatus`, and `operationsQualificationRows.opportunityStatus` validators no longer include `in_progress` or `meeting_overran`.
3. `meetings` schema no longer includes `startedAt`, `startedAtSource`, `stoppedAt`, `stoppedAtSource`, `lateStartDurationMs`, `overranDurationMs`, `exceededScheduledDurationMs`, `attendanceCheckId`, `overranDetectedAt`, `reviewId`, or `noShowWaitDurationMs`.
4. `meetings.completedAt`, Fathom fields, and no-show operational fields are preserved.
5. Temporary migration/audit files from Phase 5 and the `checkMeetingAttendance` shim are deleted.
6. Generated API/types contain no `reviews` module and no `meetingReviews` references.
7. Repo-wide grep shows no active code reference to `meeting_overran`, `in_progress`, `meetingReviews`, `startedAt`, `stoppedAt`, `attendanceCheckId`, `reviewId`, or deleted review routes except unrelated variable names or historical plan docs.
8. Production deploy succeeds without Convex schema validation errors.
9. Post-deploy production audits still return clean state.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
6A (pre-narrow verification) --> 6B (schema + validators)
                                  |-> 6C (delete backend legacy modules)
                                  |-> 6D (delete frontend/status remnants)
                                  \-> 6E (delete temp migration/audit code)

6B + 6C + 6D + 6E complete --> 6F (final deploy + post-deploy audit)
```

**Optimal execution:**
1. Run 6A immediately before edits and again before deploy.
2. Make schema/validator changes in 6B first; generated type errors then reveal remaining references.
3. Delete backend modules in 6C and frontend/status remnants in 6D.
4. Delete migration/audit/shim code in 6E only after references are gone.
5. Run 6F final deploy and post-deploy audit.

**Estimated time:** 1-2 days

---

## Subphases

### 6A - Pre-Narrow Verification Gate

**Type:** Manual / Release Gate
**Parallelizable:** No - this gate determines whether narrowing is legal.

**What:** Re-run Phase 5 hard checks immediately before editing schema.

**Why:** Convex deploy will reject narrowed schema if even one production document still contains a removed field or literal.

**Where:**
- Production Convex CLI
- `convex/audits/legacyLifecycle.ts` from Phase 5

**How:**

**Step 1: Run production audits.**

```bash
# Path: shell
npx convex run --prod audits/legacyLifecycle:countLegacyLifecycleRows
npx convex run --prod audits/legacyLifecycle:compareLifecycleAggregates
npx convex data --prod meetingReviews --limit 1
npx convex data --prod _scheduled_functions --limit 50
npx convex run --prod --component migrations lib:getStatus
```

**Step 2: Decide go/no-go.**

Proceed only if:

- All legacy counters are zero.
- Aggregate comparison is clean.
- No `meetingReviews` rows exist.
- No pending `checkMeetingAttendance` scheduled functions exist.
- No migration is still running.

**Key implementation notes:**
- Do not "try the deploy and see" if audits are dirty. Repair in Phase 5 first.
- Keep command output in release notes/PR evidence.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| Production Convex data | Verify | Hard gate before schema edits |

---

### 6B - Narrow Schema and Shared Validators

**Type:** Backend / Schema
**Parallelizable:** No - generated types from this change reveal all remaining references.

**What:** Remove legacy table, fields, and status literals from schema and reusable validators.

**Why:** This is the durable product contract: the app can no longer store the removed lifecycle.

**Where:**
- `convex/schema.ts` (modify)
- `convex/opportunities/validators.ts` (modify)
- `convex/lib/statusTransitions.ts` (modify)
- `lib/status-config.ts` (modify)
- Other validator/status source files found by TypeScript/grep (modify)

**How:**

**Step 1: Narrow opportunity statuses.**

```typescript
// Path: convex/schema.ts
status: v.union(
  v.literal("qualified_pending"),
  v.literal("scheduled"),
  v.literal("payment_received"),
  v.literal("follow_up_scheduled"),
  v.literal("reschedule_link_sent"),
  v.literal("lost"),
  v.literal("canceled"),
  v.literal("no_show"),
),
```

Apply the same removal wherever `opportunityStatusValidator` is defined or copied:

- `opportunities.status`
- `opportunitySearch.status`
- `meetings.opportunityStatus`
- `operationsMeetingDailyStats.opportunityStatus`
- `operationsQualificationRows.opportunityStatus`

**Step 2: Narrow meeting statuses and fields.**

```typescript
// Path: convex/schema.ts
status: v.union(
  v.literal("scheduled"),
  v.literal("completed"),
  v.literal("canceled"),
  v.literal("no_show"),
),
completedAt: v.optional(v.number()),
fathomLink: v.optional(v.string()),
fathomLinkSavedAt: v.optional(v.number()),
noShowMarkedAt: v.optional(v.number()),
noShowReason: v.optional(
  v.union(
    v.literal("no_response"),
    v.literal("late_cancel"),
    v.literal("technical_issues"),
    v.literal("other"),
  ),
),
noShowNote: v.optional(v.string()),
noShowMarkedByUserId: v.optional(v.id("users")),
noShowSource: v.optional(
  v.union(v.literal("closer"), v.literal("calendly_webhook")),
),
```

Remove:

- `startedAt`
- `startedAtSource`
- `stoppedAt`
- `stoppedAtSource`
- `lateStartDurationMs`
- `overranDurationMs`
- `exceededScheduledDurationMs`
- `attendanceCheckId`
- `overranDetectedAt`
- `reviewId`
- `noShowWaitDurationMs`

**Step 3: Delete the `meetingReviews` table.**

```typescript
// Path: convex/schema.ts
// Delete the entire meetingReviews: defineTable({ ... }) block and indexes.
```

**Step 4: Narrow transition/status configs.**

```typescript
// Path: convex/lib/statusTransitions.ts
export const OPPORTUNITY_STATUSES = [
  "qualified_pending",
  "scheduled",
  "payment_received",
  "follow_up_scheduled",
  "reschedule_link_sent",
  "lost",
  "canceled",
  "no_show",
] as const;

export const MEETING_STATUSES = [
  "scheduled",
  "completed",
  "canceled",
  "no_show",
] as const;
```

**Key implementation notes:**
- `completedAt` stays, but never means actual end time.
- Do not remove no-show operational fields.
- Keep indexes unless their fields were deleted. Drop indexes that depend on deleted fields if any exist.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Remove legacy table, fields, literals |
| `convex/opportunities/validators.ts` | Modify | Remove legacy opportunity literals |
| `convex/lib/statusTransitions.ts` | Modify | Final transition maps and status arrays |
| `lib/status-config.ts` | Modify | Final UI status config |

---

### 6C - Delete Backend Legacy Modules and Imports

**Type:** Backend
**Parallelizable:** Yes - after 6B reveals generated type errors.

**What:** Delete remaining review/overrun/timing backend modules and imports now that schema no longer supports them.

**Why:** Any generated API reference to deleted tables or removed fields will fail after schema narrow.

**Where:**
- `convex/reviews/queries.ts` (delete)
- `convex/reviews/mutations.ts` (delete)
- `convex/closer/meetingOverrun.ts` (delete)
- `convex/closer/meetingOverrunSweep.ts` (delete if not already deleted)
- `convex/lib/overranReviewGuards.ts` (delete)
- `convex/lib/attendanceChecks.ts` (delete)
- `convex/reporting/meetingTime.ts` (delete if not already)
- `convex/reporting/reviewsReporting.ts` (delete if not already)
- `convex/admin/rawWebhookReplay.ts` (modify)
- `convex/testing/operationalData.ts` (modify)
- `convex/testing/e2e.ts` (modify)
- `convex/calendly/healthCheckMutations.ts` (verify unrelated `startedAt` variable remains okay)

**How:**

**Step 1: Delete modules that import `meetingReviews` or timing fields.**

```bash
# Path: shell
rm -r convex/reviews
rm convex/closer/meetingOverrun.ts
rm convex/closer/meetingOverrunSweep.ts
rm convex/lib/overranReviewGuards.ts
rm convex/lib/attendanceChecks.ts
```

Use normal file deletion in implementation.

**Step 2: Remove cleanup references from admin/testing utilities.**

```typescript
// Path: convex/admin/rawWebhookReplay.ts
// Remove deleteMeetingReviewsBatch and any deletedCounts.meetingReviews
// accounting. The table no longer exists.
```

```typescript
// Path: convex/testing/operationalData.ts
// Remove "meetingReviews" from table lists, count outputs, and reset helpers.
```

**Step 3: Remove timing output from E2E helpers.**

```typescript
// Path: convex/testing/e2e.ts
return {
  meetingId: meeting._id,
  status: meeting.status,
  scheduledAt: meeting.scheduledAt,
  completedAt: meeting.completedAt ?? null,
  // Removed: startedAt, stoppedAt.
};
```

**Key implementation notes:**
- Do not delete unrelated variables named `startedAt` used as local process timestamps.
- Generated API references disappear only after Convex regenerates. Run type-check after deleting files.
- If a backend module still imports `assertOverranReviewStillPending`, that module was missed in Phase 2/4 cleanup.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reviews/queries.ts` | Delete | Review API removed |
| `convex/reviews/mutations.ts` | Delete | Review API removed |
| `convex/closer/meetingOverrun.ts` | Delete | Shim no longer needed |
| `convex/closer/meetingOverrunSweep.ts` | Delete | Cron removed earlier |
| `convex/lib/overranReviewGuards.ts` | Delete | No overran reviews |
| `convex/lib/attendanceChecks.ts` | Delete | No attendance checks |
| `convex/admin/rawWebhookReplay.ts` | Modify | Remove meetingReviews cleanup |
| `convex/testing/operationalData.ts` | Modify | Remove meetingReviews table handling |
| `convex/testing/e2e.ts` | Modify | Remove timing fields |

---

### 6D - Delete Frontend and Status Remnants

**Type:** Frontend
**Parallelizable:** Yes - after 6B type changes are known.

**What:** Remove final UI/status references that TypeScript allowed during the migration window.

**Why:** Narrowed generated types cannot include deleted literals or table names.

**Where:**
- `lib/status-config.ts` (modify)
- `convex/opportunities/queries.ts` (modify)
- `convex/opportunities/listQueries.ts` (modify)
- `convex/closer/pipeline.ts` (modify)
- `convex/operations/phoneSales.ts` (modify)
- `convex/operations/qualifications.ts` (modify)
- `convex/operations/projections.ts` (modify)
- `convex/lib/opportunitySearch.ts` (modify)
- `convex/users/queries.ts` (modify)
- `convex/workos/userMutations.ts` (modify)
- Any app component found by grep (modify/delete)

**How:**

**Step 1: Final grep and edit loop.**

```bash
# Path: shell
rg -n 'meeting_overran|in_progress|meetingReviews|startedAt|stoppedAt|attendanceCheckId|reviewId|noShowWaitDurationMs|overranDurationMs|exceededScheduledDurationMs|lateStartDurationMs' convex app components hooks lib --glob '!convex/_generated/**'
```

For each match:

- Delete if it references removed lifecycle behavior.
- Keep only unrelated local variables such as `const startedAt = Date.now()` in non-meeting contexts.
- Rename unrelated locals if the grep needs a clean signal for release review.

**Step 2: Narrow status config.**

```typescript
// Path: lib/status-config.ts
export const opportunityStatuses = [
  "qualified_pending",
  "scheduled",
  "payment_received",
  "follow_up_scheduled",
  "reschedule_link_sent",
  "lost",
  "canceled",
  "no_show",
] as const;

export const meetingStatuses = [
  "scheduled",
  "completed",
  "canceled",
  "no_show",
] as const;
```

**Step 3: Remove validators in query arg unions.**

```typescript
// Path: convex/opportunities/queries.ts
const opportunityStatusArg = v.union(
  v.literal("qualified_pending"),
  v.literal("scheduled"),
  v.literal("payment_received"),
  v.literal("follow_up_scheduled"),
  v.literal("reschedule_link_sent"),
  v.literal("lost"),
  v.literal("canceled"),
  v.literal("no_show"),
);
```

**Key implementation notes:**
- TypeScript should guide this subphase after schema generation.
- Avoid leaving dead branches like `if (status === "in_progress")`.
- Do not edit unrelated archived plans.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `lib/status-config.ts` | Modify | Final status labels/colors |
| `convex/opportunities/queries.ts` | Modify | Remove legacy validator literals |
| `convex/opportunities/listQueries.ts` | Modify | Remove legacy validator literals |
| `convex/closer/pipeline.ts` | Modify | Remove legacy validator literals |
| `convex/operations/phoneSales.ts` | Modify | Remove legacy validator literals |
| `convex/operations/qualifications.ts` | Modify | Remove legacy validator literals |
| `convex/operations/projections.ts` | Modify | Remove legacy projection branches |
| `convex/lib/opportunitySearch.ts` | Modify | Remove legacy projection literals |
| `convex/users/queries.ts` | Modify | Remove legacy buckets |
| `convex/workos/userMutations.ts` | Modify | Remove legacy buckets |

---

### 6E - Delete Temporary Migration and Audit Code

**Type:** Backend / Cleanup
**Parallelizable:** Yes - after Phase 5 evidence is captured.

**What:** Remove temporary cleanup migrations, audit queries, and any named runners used only for this refactor.

**Why:** After schema narrow, migration definitions that mention removed fields/tables will no longer type-check.

**Where:**
- `convex/migrations/eraseLegacyLifecycleState.ts` (delete)
- `convex/migrations/legacyLifecycleRepair.ts` (delete)
- `convex/audits/legacyLifecycle.ts` (delete)
- `convex/migrations.ts` (modify if runners/imports were added)

**How:**

**Step 1: Delete temporary files.**

```bash
# Path: shell
rm convex/migrations/eraseLegacyLifecycleState.ts
rm convex/migrations/legacyLifecycleRepair.ts
rm convex/audits/legacyLifecycle.ts
```

**Step 2: Remove runner exports if added.**

```typescript
// Path: convex/migrations.ts
export const run = migrations.runner();

// Remove any one-off runAll/runEraseLegacyLifecycleState exports if they were
// added only for Phase 5.
```

**Key implementation notes:**
- Keep `@convex-dev/migrations` installed and registered if other migrations use it.
- Do not delete unrelated existing migrations in `convex/migrations.ts`.
- Keep Phase 5 command output in docs/release notes before deleting audit functions.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/migrations/eraseLegacyLifecycleState.ts` | Delete | Temporary cleanup |
| `convex/migrations/legacyLifecycleRepair.ts` | Delete | Temporary cleanup |
| `convex/audits/legacyLifecycle.ts` | Delete | Temporary audit |
| `convex/migrations.ts` | Modify / preserve | Remove only one-off runner additions |

---

### 6F - Final Deploy and Post-Deploy Audit

**Type:** Manual / Release
**Parallelizable:** No - final gate.

**What:** Type-check, deploy the narrowed schema/code, and verify production remains clean.

**Why:** This completes the refactor and proves the deployed app no longer accepts the removed lifecycle.

**Where:**
- Shell
- Production Convex deployment
- Browser smoke routes

**How:**

**Step 1: Type-check and lint before deploy.**

```bash
# Path: shell
pnpm tsc --noEmit
pnpm lint
```

**Step 2: Run final grep.**

```bash
# Path: shell
rg -n 'meeting_overran|meetingReviews|attendanceCheckId|reviewId|noShowWaitDurationMs|overranDurationMs|exceededScheduledDurationMs|lateStartDurationMs' convex app components hooks lib --glob '!convex/_generated/**'
```

Expected: no active code matches.

For `in_progress`, either zero active code matches or only unrelated non-meeting text remains:

```bash
# Path: shell
rg -n 'in_progress|startedAt|stoppedAt' convex app components hooks lib --glob '!convex/_generated/**'
```

**Step 3: Deploy.**

```bash
# Path: shell
npx convex deploy
```

If deploy fails with schema validation, stop. Do not force. Return to Phase 5 repair/audits.

**Step 4: Post-deploy smoke check.**

```bash
# Path: shell
npx convex data --prod meetings --limit 10
npx convex data --prod opportunities --limit 10
npx convex logs --prod
```

Browser check:

- Closer scheduled meeting detail loads.
- Join link opens without mutation.
- Direct outcome resolves the meeting.
- Admin pipeline meeting page loads and direct scheduled actions work.
- Deleted review/meeting-time routes are absent.

**Key implementation notes:**
- `convex/_generated/**` will change as part of Convex codegen/deploy; do not hand-edit generated files.
- If a production row somehow receives a legacy value after Phase 5, the narrow deploy rejection is a signal Phase 2 did not fully stop writes.
- Keep the no-op shim deleted only after scheduled-function audit is clean.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| Convex deployment | Deploy | Final schema narrow |
| Production app | Verify | Post-deploy closer/admin smoke checks |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modify | 6B |
| `convex/opportunities/validators.ts` | Modify | 6B |
| `convex/lib/statusTransitions.ts` | Modify | 6B |
| `lib/status-config.ts` | Modify | 6B, 6D |
| `convex/reviews/queries.ts` | Delete | 6C |
| `convex/reviews/mutations.ts` | Delete | 6C |
| `convex/closer/meetingOverrun.ts` | Delete | 6C |
| `convex/closer/meetingOverrunSweep.ts` | Delete | 6C |
| `convex/lib/overranReviewGuards.ts` | Delete | 6C |
| `convex/lib/attendanceChecks.ts` | Delete | 6C |
| `convex/admin/rawWebhookReplay.ts` | Modify | 6C |
| `convex/testing/operationalData.ts` | Modify | 6C |
| `convex/testing/e2e.ts` | Modify | 6C |
| `convex/opportunities/queries.ts` | Modify | 6D |
| `convex/opportunities/listQueries.ts` | Modify | 6D |
| `convex/closer/pipeline.ts` | Modify | 6D |
| `convex/operations/phoneSales.ts` | Modify | 6D |
| `convex/operations/qualifications.ts` | Modify | 6D |
| `convex/operations/projections.ts` | Modify | 6D |
| `convex/lib/opportunitySearch.ts` | Modify | 6D |
| `convex/users/queries.ts` | Modify | 6D |
| `convex/workos/userMutations.ts` | Modify | 6D |
| `convex/migrations/eraseLegacyLifecycleState.ts` | Delete | 6E |
| `convex/migrations/legacyLifecycleRepair.ts` | Delete | 6E |
| `convex/audits/legacyLifecycle.ts` | Delete | 6E |
| `convex/migrations.ts` | Modify / preserve | 6E |
