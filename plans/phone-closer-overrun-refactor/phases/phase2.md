# Phase 2 - Backend: Stop Producing Overran, Timing, and In-Progress Data

**Goal:** Remove every backend path that creates new `meeting_overran`, `in_progress`, attendance-check, or actual-duration data, while preserving temporary compatibility for existing queued jobs and legacy rows. After this phase, new meetings remain `scheduled` until a webhook or direct outcome resolves them.

**Prerequisite:** Phase 1 deployed. `scheduled` is a valid source state for opportunity and meeting outcomes. Schema is still wide and legacy rows may still exist.

**Runs in PARALLEL with:** Phase 3 can start only after 2B-2D expose stable outcome mutation contracts. Phase 4 backend reporting cleanup can start after 2A and 2C prove no new legacy rows are produced.

**Skills to invoke:**
- `convex-migration-helper` - preserve widen -> migrate -> narrow sequencing and keep the scheduler shim until queued jobs are gone.
- `convex-performance-audit` - use for aggregate/write-hook changes around direct scheduled outcomes.

**Docs and references to read first:**
- `plans/phone-closer-overrun-refactor/phone-closer-overrun-refactor-design.md` Sections 5, 8.3, 11, 13, and 14.
- `convex/_generated/ai/guidelines.md` for public/internal function validators, bounded indexed reads, and scheduler usage.
- `.agents/skills/convex-migration-helper/references/migration-patterns.md` for widen-window compatibility.
- `convex/lib/outcomeEligibility.ts` from Phase 1.
- Current backend files: `convex/pipeline/inviteeCreated.ts`, `convex/crons.ts`, `convex/closer/meetingOverrun.ts`, `convex/closer/meetingActions.ts`, `convex/closer/payments.ts`, `convex/closer/noShowActions.ts`, `convex/closer/followUpMutations.ts`, `convex/admin/meetingActions.ts`, `convex/pipeline/inviteeCanceled.ts`, `convex/pipeline/inviteeNoShow.ts`, `convex/opportunities/createManual.ts`, `convex/opportunities/detailQuery.ts`, `convex/opportunities/staleness.ts`, and `convex/sideDeals/deleteEmptyOpportunity.ts`.

**Deploy / backfill / manual operations:**
- **Deploy required:** Yes. This is the main backend behavior deploy.
- **Backfill or migration required:** No data backfill in this phase. Do not delete or rewrite existing production rows yet.
- **Manual operations:** After deploy, inspect `_scheduled_functions` for pending `checkMeetingAttendance` jobs. Leave the no-op shim in place until Phase 5 cancels/clears them.

**Acceptance Criteria:**
1. New `invitee.created` processing inserts meetings without scheduling attendance checks and without writing `attendanceCheckId`.
2. `sweep-stale-scheduled-meetings` is no longer registered in `convex/crons.ts`.
3. `checkMeetingAttendance` exists only as a temporary no-op shim, never writing `meeting_overran` or `meetingReviews`.
4. `startMeeting`, `stopMeeting`, and `adminResolveMeeting` no longer transition records into `in_progress` or write actual timing fields.
5. Payment, follow-up, no-show, and lost mutations can resolve a scheduled meeting directly and complete/update the linked meeting through one shared helper.
6. Backend outcome mutations enforce tenant, role, ownership, scheduled state, closer lead window, and admin bypass server-side.
7. Pipeline cancel/no-show handlers no longer ignore `meeting_overran` opportunities and no longer cancel new attendance checks.
8. Manual side deals are created and handled as `scheduled`, not `in_progress`.
9. A grep shows no remaining production write path for `status: "in_progress"` or `status: "meeting_overran"` outside migration/testing/legacy-shim code.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (scheduler shutoff + shim) -------------\
                                            +--> 2F (backend verification + deploy)
2B (completion helper) --> 2C outcomes -----+
                     \--> 2D follow-up/admin contracts

2E (pipeline + side-deal cleanup) ---------/
```

**Optimal execution:**
1. Start 2A first so no new attendance checks are created.
2. Implement 2B before 2C/2D; all outcome mutations use the same completion helper.
3. Run 2E in parallel with 2C/2D after 2A is underway because it touches separate pipeline/side-deal files.
4. Finish with 2F grep, type-check, deploy, and scheduled-function inspection.

**Estimated time:** 2-4 days

---

## Subphases

### 2A - Remove Attendance Scheduling and Add the No-Op Shim

**Type:** Backend
**Parallelizable:** No - this should land before deleting any referenced overrun functions.

**What:** Stop scheduling attendance checks, remove the stale-meeting cron, and keep `checkMeetingAttendance` as a temporary no-op for any already queued jobs.

**Why:** Deleting the function before queued `_scheduled_functions` drain can create runtime failures. The product behavior must stop immediately, but scheduler compatibility must remain until Phase 5 verification.

**Where:**
- `convex/pipeline/inviteeCreated.ts` (modify)
- `convex/crons.ts` (modify)
- `convex/closer/meetingOverrun.ts` (modify; temporary shim)
- `convex/closer/meetingOverrunSweep.ts` (delete after cron deploy, or leave unreferenced until Phase 6 if safer)
- `convex/lib/attendanceChecks.ts` (preserve until Phase 5/6 if still imported for cancellation)

**How:**

**Step 1: Remove imports and calls from `inviteeCreated`.**

```typescript
// Path: convex/pipeline/inviteeCreated.ts
// Remove:
// import {
//   getMeetingAttendanceCheckTimestamp,
//   scheduleMeetingAttendanceCheck,
// } from "../lib/attendanceChecks";

const meetingId = await ctx.db.insert("meetings", {
  tenantId,
  opportunityId,
  assignedCloserId,
  calendlyEventUri,
  calendlyInviteeUri,
  scheduledAt,
  durationMinutes,
  status: "scheduled",
  createdAt: now,
  // Do not write attendanceCheckId.
});
await insertMeetingAggregate(ctx, meetingId);
await updateOpportunityMeetingRefs(ctx, opportunityId);
```

Apply the same deletion at all three current meeting insert sites in `inviteeCreated.ts`: UTM relink, B4 heuristic reschedule, and default flow.

**Step 2: Remove the stale cron registration.**

```typescript
// Path: convex/crons.ts
// Delete this registration:
// crons.interval(
//   "sweep-stale-scheduled-meetings",
//   { minutes: 5 },
//   internal.closer.meetingOverrunSweep.sweepStaleMeetings,
//   {},
// );
```

**Step 3: Replace attendance check behavior with a safe no-op.**

```typescript
// Path: convex/closer/meetingOverrun.ts
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

export const checkMeetingAttendance = internalMutation({
  args: { meetingId: v.id("meetings") },
  handler: async (_ctx, _args) => {
    // Temporary scheduler-safety shim. Overrun detection is removed.
    // Delete in Phase 6 after Phase 5 verifies zero pending scheduled jobs.
    return null;
  },
});
```

**Key implementation notes:**
- Do not keep old `checkMeetingAttendance` branches below the shim. They insert `meetingReviews` and write `meeting_overran`.
- If TypeScript references `respondToOverranReview` or `scheduleFollowUpFromOverran`, keep them only until Phase 3/4 removes callers, then delete in Phase 6.
- Deployment order matters: cron removal and no-op shim can deploy before Phase 5 cleanup.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/inviteeCreated.ts` | Modify | Remove all attendance-check scheduling and `attendanceCheckId` patches |
| `convex/crons.ts` | Modify | Remove stale scheduled meeting sweep |
| `convex/closer/meetingOverrun.ts` | Modify | Temporary no-op `checkMeetingAttendance` shim |
| `convex/closer/meetingOverrunSweep.ts` | Delete / defer delete | Must not be referenced by cron after deploy |

---

### 2B - Add One Shared Meeting Completion Helper

**Type:** Backend
**Parallelizable:** No - 2C and 2D depend on this helper.

**What:** Create a helper that completes a meeting for a direct outcome, syncs meeting aggregates, and refreshes opportunity meeting refs.

**Why:** Direct outcomes now end the operational meeting lifecycle. Raw-patching meeting status in every mutation would drift aggregates and denormalized refs.

**Where:**
- `convex/lib/meetingOutcomeCompletion.ts` (create)
- `convex/reporting/writeHooks.ts` (use existing exports)
- `convex/lib/opportunityMeetingRefs.ts` (use existing export)

**How:**

**Step 1: Create the helper.**

```typescript
// Path: convex/lib/meetingOutcomeCompletion.ts
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { updateOpportunityMeetingRefs } from "./opportunityMeetingRefs";
import { validateMeetingTransition } from "./statusTransitions";
import { replaceMeetingAggregate } from "../reporting/writeHooks";

type TerminalMeetingStatus = "completed" | "no_show" | "canceled";

export async function completeMeetingForOutcome(
  ctx: MutationCtx,
  args: {
    meeting: Doc<"meetings">;
    opportunity: Doc<"opportunities">;
    toMeetingStatus: TerminalMeetingStatus;
    completedAt: number;
    extraMeetingPatch?: Partial<Doc<"meetings">>;
  },
): Promise<Doc<"meetings">> {
  const { meeting, opportunity, toMeetingStatus, completedAt } = args;

  if (meeting.opportunityId !== opportunity._id) {
    throw new Error("Meeting does not belong to opportunity");
  }
  if (!validateMeetingTransition(meeting.status, toMeetingStatus)) {
    throw new Error(
      `Cannot transition meeting from "${meeting.status}" to "${toMeetingStatus}"`,
    );
  }

  await ctx.db.patch(meeting._id, {
    status: toMeetingStatus,
    completedAt,
    ...args.extraMeetingPatch,
  });

  const nextMeeting = await replaceMeetingAggregate(ctx, meeting, meeting._id);
  await updateOpportunityMeetingRefs(ctx, opportunity._id);
  return nextMeeting;
}
```

**Step 2: Keep the helper timing-free.**

Do not allow callers to pass `startedAt`, `stoppedAt`, `lateStartDurationMs`, `exceededScheduledDurationMs`, `overranDurationMs`, `attendanceCheckId`, `overranDetectedAt`, `reviewId`, or `noShowWaitDurationMs`.

```typescript
// Path: convex/lib/meetingOutcomeCompletion.ts
const FORBIDDEN_TIMING_PATCH_KEYS = new Set([
  "startedAt",
  "startedAtSource",
  "stoppedAt",
  "stoppedAtSource",
  "lateStartDurationMs",
  "exceededScheduledDurationMs",
  "overranDurationMs",
  "attendanceCheckId",
  "overranDetectedAt",
  "reviewId",
  "noShowWaitDurationMs",
]);
```

If adding runtime validation for forbidden keys, keep it local and simple.

**Key implementation notes:**
- `replaceMeetingAggregate` internally syncs `meeting.opportunityStatus`; call it after the opportunity status mutation when possible.
- `completedAt` is operational resolution time, not actual call end time.
- Keep no-show metadata in `extraMeetingPatch`; keep timing fields out.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/meetingOutcomeCompletion.ts` | Create | Shared terminal meeting patch + aggregate/ref sync |

---

### 2C - Update Payment, No-Show, and Lost Outcome Mutations

**Type:** Backend
**Parallelizable:** Yes - depends on 2B but can run alongside 2D.

**What:** Make payment, no-show, and lost operate directly from scheduled meetings and complete the linked meeting.

**Why:** These are primary closer/admin outcomes. If they stay gated on `in_progress` or pending reviews, removing Start/End breaks the product.

**Where:**
- `convex/closer/payments.ts` (modify)
- `convex/closer/noShowActions.ts` (modify)
- `convex/closer/meetingActions.ts` (modify)
- `convex/admin/meetingActions.ts` (modify shared/admin wrappers as needed)

**How:**

**Step 1: Payment must assert eligibility and complete the meeting.**

```typescript
// Path: convex/closer/payments.ts
import { assertCanRecordMeetingOutcome } from "../lib/outcomeEligibility";
import { completeMeetingForOutcome } from "../lib/meetingOutcomeCompletion";
import { validateMeetingTransition, validateTransition } from "../lib/statusTransitions";

// After loading opportunity + meeting and before inserting payment:
const now = Date.now();
assertCanRecordMeetingOutcome({ meeting, opportunity, userId, role, now });

if (!validateTransition(opportunity.status, "payment_received")) {
  throw new Error(
    `Cannot log payment for opportunity with status "${opportunity.status}"`,
  );
}
if (!validateMeetingTransition(meeting.status, "completed")) {
  throw new Error(`Cannot complete meeting with status "${meeting.status}"`);
}

// Existing payment insert, aggregate, conversion, and tenant stats stay intact.
await patchOpportunityLifecycle(ctx, args.opportunityId, {
  status: "payment_received",
  paymentReceivedAt: now,
  updatedAt: now,
});

await completeMeetingForOutcome(ctx, {
  meeting,
  opportunity,
  toMeetingStatus: "completed",
  completedAt: now,
});
```

**Step 2: No-show must operate from scheduled and drop wait-time timing.**

```typescript
// Path: convex/closer/noShowActions.ts
const now = Date.now();
assertCanRecordMeetingOutcome({
  meeting,
  opportunity,
  userId,
  role: "closer",
  now,
});

await completeMeetingForOutcome(ctx, {
  meeting,
  opportunity,
  toMeetingStatus: "no_show",
  completedAt: now,
  extraMeetingPatch: {
    noShowMarkedAt: now,
    noShowReason: reason,
    noShowNote: normalizedNote,
    noShowMarkedByUserId: userId,
    noShowSource: "closer",
  },
});

await patchOpportunityLifecycle(ctx, opportunity._id, {
  status: "no_show",
  noShowAt: now,
  updatedAt: now,
});
```

Remove `stoppedAt`, `stoppedAtSource`, and `noShowWaitDurationMs` writes.

**Step 3: Lost should accept an optional meeting id.**

```typescript
// Path: convex/closer/meetingActions.ts
export const markAsLost = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.optional(v.id("meetings")),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { opportunityId, meetingId, reason }) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    const meeting = meetingId ? await ctx.db.get(meetingId) : null;
    const now = Date.now();
    if (meeting) {
      assertCanRecordMeetingOutcome({ meeting, opportunity, userId, role, now });
    }

    if (!validateTransition(opportunity.status, "lost")) {
      throw new Error(`Cannot mark as lost from status "${opportunity.status}"`);
    }

    await patchOpportunityLifecycle(ctx, opportunityId, {
      status: "lost",
      updatedAt: now,
      lostAt: now,
      lostByUserId: userId,
      lostReason: reason?.trim() || undefined,
    });

    if (meeting) {
      await completeMeetingForOutcome(ctx, {
        meeting,
        opportunity,
        toMeetingStatus: "completed",
        completedAt: now,
      });
    }
  },
});
```

**Key implementation notes:**
- Remove all `assertOverranReviewStillPending` imports from these files.
- Admin role support must be explicit. If a shared closer mutation accepts admin roles, preserve closer assignment checks only for `role === "closer"`.
- For side-deal paths with no meeting id, update the opportunity only; do not fabricate a meeting completion.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/payments.ts` | Modify | Scheduled payment + meeting completion |
| `convex/closer/noShowActions.ts` | Modify | Scheduled no-show + no timing fields |
| `convex/closer/meetingActions.ts` | Modify | Remove lifecycle writes; make lost meeting-aware |
| `convex/admin/meetingActions.ts` | Modify | Admin wrappers must pass meeting id or share helper |

---

### 2D - Update Follow-Up Contracts and Admin Direct Outcomes

**Type:** Backend
**Parallelizable:** Yes - depends on 2B and can run alongside 2C.

**What:** Add optional `meetingId` to follow-up confirmation paths so meeting-detail follow-ups complete the scheduled meeting; keep side-deal/reminder flows opportunity-only unless a meeting id is supplied.

**Why:** The current follow-up code deliberately avoids meeting status writes because End Meeting owned lifecycle completion. That contract is now reversed for meeting-driven outcomes.

**Where:**
- `convex/closer/followUpMutations.ts` (modify)
- `convex/admin/meetingActions.ts` (modify)

**How:**

**Step 1: Add `meetingId` to closer scheduling-link creation/confirmation where invoked from a meeting.**

```typescript
// Path: convex/closer/followUpMutations.ts
export const confirmFollowUpScheduled = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.optional(v.id("meetings")),
  },
  handler: async (ctx, { opportunityId, meetingId }) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, ["closer"]);
    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    const meeting = meetingId ? await ctx.db.get(meetingId) : null;
    const now = Date.now();
    if (meeting) {
      assertCanRecordMeetingOutcome({ meeting, opportunity, userId, role, now });
    }

    if (opportunity.status === "follow_up_scheduled") return;
    if (!validateTransition(opportunity.status, "follow_up_scheduled")) {
      throw new Error(
        `Cannot schedule follow-up from status "${opportunity.status}"`,
      );
    }

    await patchOpportunityLifecycle(ctx, opportunityId, {
      status: "follow_up_scheduled",
      updatedAt: now,
    });

    if (meeting) {
      await completeMeetingForOutcome(ctx, {
        meeting,
        opportunity,
        toMeetingStatus: "completed",
        completedAt: now,
      });
    }
  },
});
```

**Step 2: Remove overran early returns from every follow-up path.**

```typescript
// Path: convex/closer/followUpMutations.ts
// Delete branches shaped like this:
// if (opportunity.status === "meeting_overran") {
//   await assertOverranReviewStillPending(ctx, opportunity._id);
//   return;
// }
```

**Step 3: Update admin follow-up/lost wrappers to accept `meetingId`.**

```typescript
// Path: convex/admin/meetingActions.ts
export const adminConfirmFollowUp = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.optional(v.id("meetings")),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId, role } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const opportunity = await ctx.db.get(args.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }
    const meeting = args.meetingId ? await ctx.db.get(args.meetingId) : null;
    const now = Date.now();
    if (meeting) {
      assertCanRecordMeetingOutcome({ meeting, opportunity, userId, role, now });
    }
    // Patch opportunity and complete meeting exactly like closer flow.
  },
});
```

**Key implementation notes:**
- `createSchedulingLinkFollowUp` may remain a two-step flow; only confirmation completes the meeting.
- Manual reminders can remain opportunity-only unless launched from a meeting detail page with a meeting id.
- Do not make reminder outcome APIs complete random latest meetings. Meeting completion requires an explicit meeting id.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/followUpMutations.ts` | Modify | Optional meeting id, no overran branches |
| `convex/admin/meetingActions.ts` | Modify | Admin follow-up/lost meeting-aware wrappers |

---

### 2E - Remove Pipeline, Admin Resolve, and Side-Deal Legacy Writers

**Type:** Backend
**Parallelizable:** Yes - independent of 2C/2D except shared transition maps.

**What:** Remove backend code that writes or depends on the old lifecycle outside primary outcome mutations.

**Why:** Even if meeting detail works, stale pipeline/admin/side-deal code could continue producing legacy states and block Phase 6.

**Where:**
- `convex/pipeline/inviteeCanceled.ts` (modify)
- `convex/pipeline/inviteeNoShow.ts` (modify)
- `convex/admin/meetingActions.ts` (modify)
- `convex/opportunities/createManual.ts` (modify)
- `convex/opportunities/detailQuery.ts` (modify)
- `convex/opportunities/staleness.ts` (modify)
- `convex/sideDeals/deleteEmptyOpportunity.ts` (modify)

**How:**

**Step 1: Remove overran ignore branches in cancel/no-show handlers.**

```typescript
// Path: convex/pipeline/inviteeCanceled.ts
// Delete the branch that logs "[Pipeline:invitee.canceled] IGNORED -
// opportunity is meeting_overran" and let normal cancel transition validation
// handle the event.
```

```typescript
// Path: convex/pipeline/inviteeNoShow.ts
// Delete the branch that logs "[Pipeline:no-show] IGNORED - opportunity is
// meeting_overran". No-show webhooks should resolve scheduled rows normally.
```

**Step 2: Delete the manual timing resolver.**

```typescript
// Path: convex/admin/meetingActions.ts
// Delete adminResolveMeeting entirely. It writes startedAt/stoppedAt and
// transitions opportunity -> in_progress, which this refactor removes.
```

**Step 3: Move manual side deals to `scheduled`.**

```typescript
// Path: convex/opportunities/createManual.ts
const opportunityId = await ctx.db.insert("opportunities", {
  tenantId,
  leadId,
  assignedCloserId,
  source: "side_deal",
  status: "scheduled",
  createdAt: now,
  updatedAt: now,
  latestActivityAt: now,
});

await emitDomainEvent(ctx, {
  tenantId,
  entityType: "opportunity",
  entityId: opportunityId,
  eventType: "opportunity.status_changed",
  source: "admin",
  actorUserId: userId,
  toStatus: "scheduled",
  occurredAt: now,
});
```

**Step 4: Update side-deal gates.**

```typescript
// Path: convex/opportunities/detailQuery.ts
const isActionableSideDeal =
  isSideDeal && opportunity.status === "scheduled";

return {
  permissions: {
    canRecordPayment: isActionableSideDeal,
    canMarkLost: isActionableSideDeal,
    canDeleteOpportunity: isActionableSideDeal && hasNoActivity,
  },
};
```

**Key implementation notes:**
- `scheduled` now means "actionable, not terminal" for side deals too.
- Preserve existing tenant/admin auth checks.
- Do not add a new active status for side deals in this MVP.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/inviteeCanceled.ts` | Modify | Remove overran ignore and attendance cancellation branch |
| `convex/pipeline/inviteeNoShow.ts` | Modify | Remove overran ignore and legacy branch |
| `convex/admin/meetingActions.ts` | Modify | Delete `adminResolveMeeting`; update admin wrappers |
| `convex/opportunities/createManual.ts` | Modify | Side deals start `scheduled` |
| `convex/opportunities/detailQuery.ts` | Modify | Side-deal actions gate on `scheduled` |
| `convex/opportunities/staleness.ts` | Modify | Stale side-deal nudges query `scheduled` |
| `convex/sideDeals/deleteEmptyOpportunity.ts` | Modify | Empty side deals deletable from `scheduled` |

---

### 2F - Backend Verification and Deploy

**Type:** Manual / Release
**Parallelizable:** No - final gate.

**What:** Prove no backend path can create new legacy lifecycle state, then deploy and inspect scheduler state.

**Why:** Phase 5 cleanup is only meaningful if the application has already stopped producing the data being cleaned.

**Where:**
- Shell / Convex CLI
- Production test tenant

**How:**

**Step 1: Grep for remaining forbidden writes.**

```bash
# Path: shell
rg -n 'status: "in_progress"|toStatus: "in_progress"|status: "meeting_overran"|toStatus: "meeting_overran"|ctx\\.db\\.insert\\("meetingReviews"' convex --glob '!convex/_generated/**'
```

Expected remaining matches are limited to deleted/deferred review modules, migration/audit code, comments, or temporary shim files that Phase 3-6 remove. No active pipeline or outcome mutation should write these statuses.

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

**Step 4: Inspect pending scheduled functions.**

```bash
# Path: shell
npx convex data --prod _scheduled_functions --limit 50
```

Expected: there may still be old jobs referencing `closer/meetingOverrun:checkMeetingAttendance`. They should be safe because the shim is deployed. Phase 5 cancels/verifies them.

**Step 5: Create a test meeting and verify no new attendance check is scheduled.**

Use the TESTING.MD Calendly helper flow, then inspect the inserted meeting:

```bash
# Path: shell
npx convex data --prod meetings --limit 20
```

The new meeting should have `status: "scheduled"` and no `attendanceCheckId`.

**Key implementation notes:**
- Do not run Phase 5 migrations before this deploy is in production.
- If any new `attendanceCheckId` appears after this deploy, stop and re-check all three `inviteeCreated.ts` insert sites.
- Keep the shim until Phase 6; deleting it here is unsafe.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| Convex deployment | Deploy | Backend stops producing legacy data |
| Production `_scheduled_functions` | Inspect | No mutation unless Phase 5 cleanup is running |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/pipeline/inviteeCreated.ts` | Modify | 2A |
| `convex/crons.ts` | Modify | 2A |
| `convex/closer/meetingOverrun.ts` | Modify | 2A |
| `convex/closer/meetingOverrunSweep.ts` | Delete / defer delete | 2A |
| `convex/lib/meetingOutcomeCompletion.ts` | Create | 2B |
| `convex/closer/payments.ts` | Modify | 2C |
| `convex/closer/noShowActions.ts` | Modify | 2C |
| `convex/closer/meetingActions.ts` | Modify | 2C |
| `convex/closer/followUpMutations.ts` | Modify | 2D |
| `convex/admin/meetingActions.ts` | Modify | 2C, 2D, 2E |
| `convex/pipeline/inviteeCanceled.ts` | Modify | 2E |
| `convex/pipeline/inviteeNoShow.ts` | Modify | 2E |
| `convex/opportunities/createManual.ts` | Modify | 2E |
| `convex/opportunities/detailQuery.ts` | Modify | 2E |
| `convex/opportunities/staleness.ts` | Modify | 2E |
| `convex/sideDeals/deleteEmptyOpportunity.ts` | Modify | 2E |
