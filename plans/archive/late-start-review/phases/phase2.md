# Phase 2 — Backend: Automatic Attendance Detection

**Goal:** Implement the scheduler-based system that automatically detects when a closer doesn't attend a meeting. After this phase, every meeting created via the Calendly webhook pipeline has an attendance check scheduled for 1 minute after its scheduled end time. If the closer never interacted with the meeting (status still `scheduled`), the system flags it as `meeting_overran`, creates a review record, and transitions both the meeting and opportunity. Normal meeting flows (start, cancel, no-show) cancel the attendance check. Calendly webhooks arriving after a meeting is flagged are silently ignored.

**Prerequisite:** Phase 1 complete (schema deployed with `meeting_overran` status, `attendanceCheckId` field, `overranDetectedAt` field, `meetingReviews` table refactored).

**Runs in PARALLEL with:** Nothing directly. Phase 3 and Phase 4 can begin once Phase 2's core detection function (2A) is committed, since they touch different files. However, Phase 2 must fully complete before Phase 5 (frontend) can test the overran flow end-to-end.

> **Critical path:** This phase is on the critical path (Phase 1 → Phase 2 → Phase 3 → Phase 4). Start immediately after Phase 1's deploy succeeds.

**Skills to invoke:**
- None — pure Convex backend work. Refer to `convex/_generated/ai/guidelines.md` for Convex patterns.

**Acceptance Criteria:**
1. A meeting created via any of the 3 creation paths in `inviteeCreated.ts` has an `attendanceCheckId` field set to a valid `_scheduled_functions` ID.
2. When the scheduled function fires and `meeting.status === "scheduled"` AND `opportunity.status === "scheduled"`, a `meetingReviews` record is created with `category: "meeting_overran"`, `status: "pending"`, and `createdAt` set.
3. When the scheduled function fires and `meeting.status === "scheduled"`, the meeting transitions to `meeting_overran` with `overranDetectedAt` set and `reviewId` linked.
4. When the scheduled function fires and `meeting.status === "scheduled"`, the opportunity transitions to `meeting_overran` with `updatedAt` set.
5. When the scheduled function fires and `meeting.status !== "scheduled"` (e.g., `in_progress`, `completed`, `canceled`), it is a no-op — no records created, no transitions.
6. When the scheduled function fires and `opportunity.status !== "scheduled"` (e.g., another meeting already moved the opportunity), the meeting transition still occurs but the opportunity is NOT overridden.
7. `startMeeting` cancels the attendance check via `ctx.scheduler.cancel(meeting.attendanceCheckId)`.
8. `inviteeCanceled` processing cancels the attendance check and silently returns when `opportunity.status === "meeting_overran"`.
9. `inviteeNoShow` processing cancels the attendance check and silently returns when `opportunity.status === "meeting_overran"`.
10. `adminResolveMeeting` (backdate flow) cancels the attendance check.
11. Two domain events are emitted when a meeting is flagged: `meeting.overran_detected` and `opportunity.status_changed` (from `scheduled` to `meeting_overran`).
12. Reporting aggregates (`replaceMeetingAggregate`, `replaceOpportunityAggregate`) are called for both meeting and opportunity transitions.
13. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (Core detection function) ─────────────────────────────────────────┐
                                                                       │
2B (Pipeline hooks — 3 creation paths) ──────────────────────────────┤
                                                                       │
2A + 2B complete ─────┬── 2C (Attendance check cancellation)          │
                      │                                                │
                      └── 2D (Webhook isolation guards)                │
                                                                       │
2C + 2D complete ─────────────────────────────────────────────────────┘
```

**Optimal execution:**
1. Start 2A and 2B in parallel (2A creates `convex/closer/meetingOverrun.ts`, 2B modifies `convex/pipeline/inviteeCreated.ts` — no file overlap). Note: 2B imports the internal function from 2A, so technically 2B should start after 2A is committed, or both can be in the same commit.
2. Once 2A and 2B are committed → start 2C and 2D in parallel (2C touches `meetingActions.ts`, `inviteeCanceled.ts`, `inviteeNoShow.ts`, `admin/meetingActions.ts`; 2D touches `inviteeCanceled.ts`, `inviteeNoShow.ts`). Note: 2C and 2D both touch `inviteeCanceled.ts` and `inviteeNoShow.ts` — if done by the same developer, combine into a single pass per file. If by different developers, one should go first.

**Estimated time:** 1 day

---

## Subphases

### 2A — Core Detection Function: `checkMeetingAttendance`

**Type:** Backend
**Parallelizable:** Yes — creates a new file `convex/closer/meetingOverrun.ts`. No overlap with 2B.

**What:** Create the `checkMeetingAttendance` internal mutation in a new file `convex/closer/meetingOverrun.ts`. This is the scheduled function target that fires ~1 minute after a meeting's scheduled end time and flags unattended meetings.

**Why:** This is the heart of the entire feature. Without this function, no meetings are ever flagged and the review pipeline has nothing to process. It must be an `internalMutation` (not action) because it only reads/writes the Convex database and needs atomicity — the review creation, meeting patch, and opportunity patch must all succeed or fail together.

**Where:**
- `convex/closer/meetingOverrun.ts` (new)

**How:**

**Step 1: Create the new file with the `checkMeetingAttendance` function**

```typescript
// Path: convex/closer/meetingOverrun.ts
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import {
  replaceMeetingAggregate,
  replaceOpportunityAggregate,
} from "../reporting/writeHooks";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";

/**
 * Scheduled function that fires ~1 minute after a meeting's scheduled end time.
 * If the meeting status is still "scheduled" (no closer activity whatsoever),
 * it's flagged as "meeting overran" — meaning the closer did not attend.
 *
 * Idempotent: if the meeting has already transitioned to any other status
 * (in_progress, completed, canceled, no_show, meeting_overran), this is a no-op.
 */
export const checkMeetingAttendance = internalMutation({
  args: { meetingId: v.id("meetings") },
  handler: async (ctx, { meetingId }) => {
    const meeting = await ctx.db.get(meetingId);
    if (!meeting) {
      console.log("[MeetingOverrun] meeting not found, skipping", { meetingId });
      return;
    }

    // ── Idempotent guard ──────────────────────────────────────────────
    // Only flag meetings that are STILL "scheduled" — meaning the closer
    // never started, never cancelled, never did anything.
    if (meeting.status !== "scheduled") {
      console.log("[MeetingOverrun] meeting already handled, skipping", {
        meetingId,
        currentStatus: meeting.status,
      });
      return;
    }

    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (!opportunity) {
      console.error("[MeetingOverrun] opportunity not found", {
        meetingId,
        opportunityId: meeting.opportunityId,
      });
      return;
    }

    // ── Guard: opportunity should still be "scheduled" ────────────────
    // If the opportunity has already moved on (e.g., a different meeting
    // on the same opportunity triggered a status change), flag the meeting
    // but don't override the opportunity.
    const shouldTransitionOpportunity = opportunity.status === "scheduled";

    if (!shouldTransitionOpportunity) {
      console.log("[MeetingOverrun] opportunity already transitioned, flagging meeting only", {
        meetingId,
        opportunityStatus: opportunity.status,
      });
    }

    const now = Date.now();

    console.log("[MeetingOverrun] closer did not attend — flagging", {
      meetingId,
      closerId: meeting.assignedCloserId,
      tenantId: meeting.tenantId,
      shouldTransitionOpportunity,
    });

    // ── Create review record ──────────────────────────────────────────
    const reviewId = await ctx.db.insert("meetingReviews", {
      tenantId: meeting.tenantId,
      meetingId,
      opportunityId: opportunity._id,
      closerId: meeting.assignedCloserId,
      category: "meeting_overran",
      status: "pending",
      createdAt: now,
    });

    // ── Transition meeting → meeting_overran ──────────────────────────
    const oldMeeting = meeting;
    await ctx.db.patch(meetingId, {
      status: "meeting_overran",
      overranDetectedAt: now,
      reviewId,
    });
    await replaceMeetingAggregate(ctx, oldMeeting, meetingId);

    // ── Transition opportunity → meeting_overran (if still scheduled) ─
    if (shouldTransitionOpportunity) {
      const oldOpportunity = opportunity;
      await ctx.db.patch(opportunity._id, {
        status: "meeting_overran",
        updatedAt: now,
      });
      await replaceOpportunityAggregate(ctx, oldOpportunity, opportunity._id);
      await updateOpportunityMeetingRefs(ctx, opportunity._id);
    }

    // ── Domain events ─────────────────────────────────────────────────
    await emitDomainEvent(ctx, {
      tenantId: meeting.tenantId,
      entityType: "meeting",
      entityId: meetingId,
      eventType: "meeting.overran_detected",
      source: "system",
      occurredAt: now,
      metadata: {
        reviewId,
        scheduledAt: meeting.scheduledAt,
        durationMinutes: meeting.durationMinutes,
      },
    });

    if (shouldTransitionOpportunity) {
      await emitDomainEvent(ctx, {
        tenantId: meeting.tenantId,
        entityType: "opportunity",
        entityId: opportunity._id,
        eventType: "opportunity.status_changed",
        source: "system",
        fromStatus: "scheduled",
        toStatus: "meeting_overran",
        occurredAt: now,
        metadata: { reviewId, trigger: "attendance_check" },
      });
    }

    console.log("[MeetingOverrun] review created, statuses updated", {
      meetingId,
      reviewId,
      opportunityTransitioned: shouldTransitionOpportunity,
    });
  },
});
```

**Key implementation notes:**
- Uses `internalMutation` — not callable from the client. Only the Convex scheduler invokes this function.
- The function is fully idempotent: if the meeting has any status other than `scheduled`, it returns immediately. This handles race conditions where the scheduler fires at the same moment as `startMeeting` or a webhook.
- The opportunity guard (`opportunity.status === "scheduled"`) prevents overriding an opportunity that already transitioned via another meeting. The meeting is still flagged regardless — it preserves the truth about this specific meeting.
- `replaceMeetingAggregate` and `replaceOpportunityAggregate` maintain the reporting aggregate tables. They must be called with the OLD document before the patch.
- `updateOpportunityMeetingRefs` recalculates the denormalized `latestMeetingId/At` and `nextMeetingId/At` on the opportunity.
- Domain event source is `"system"` (not `"scheduler"`) because `DomainEventSource` type only includes `"closer" | "admin" | "pipeline" | "system"`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/meetingOverrun.ts` | Create | `checkMeetingAttendance` internalMutation |

---

### 2B — Pipeline Hooks: Schedule Attendance Check on Meeting Creation

**Type:** Backend
**Parallelizable:** No — depends on 2A (imports the internal function reference). Should be committed with or after 2A.

**What:** Add attendance check scheduling to all 3 meeting creation paths in `convex/pipeline/inviteeCreated.ts`. After each meeting is inserted, schedule `checkMeetingAttendance` to fire 1 minute after the meeting's scheduled end time.

**Why:** The entire detection system depends on every meeting having an attendance check. Without this hook, meetings are created but never monitored. The 3 creation paths are: (1) UTM deterministic linking / reschedule from no-show/canceled, (2) heuristic auto-reschedule, (3) standard new/follow-up booking.

**Where:**
- `convex/pipeline/inviteeCreated.ts` (modify)

**How:**

**Step 1: Add import at the top of the file**

```typescript
// Path: convex/pipeline/inviteeCreated.ts — add to imports
import { internal } from "../_generated/api";
```

Note: `internal` may already be imported. Verify and add only if missing.

**Step 2: Add attendance check scheduling after each meeting creation**

The following block must be inserted after each `ctx.db.insert("meetings", ...)` call and its associated domain event emission. There are 3 locations.

```typescript
// Path: convex/pipeline/inviteeCreated.ts — insert after each meeting creation + domain event

// ── Schedule attendance check ──────────────────────────────────────
// Fires 1 minute after the meeting's scheduled end time.
// If the closer hasn't interacted with the meeting by then,
// it's flagged as "meeting overran" (closer didn't attend).
const meetingEndTimeMs = scheduledAt + durationMinutes * 60_000;
const checkDelayMs = Math.max(0, meetingEndTimeMs + 60_000 - Date.now());

const attendanceCheckId = await ctx.scheduler.runAfter(
  checkDelayMs,
  internal.closer.meetingOverrun.checkMeetingAttendance,
  { meetingId },
);

await ctx.db.patch(meetingId, { attendanceCheckId });

console.log("[Pipeline] inviteeCreated | attendance check scheduled", {
  meetingId,
  scheduledFireTime: new Date(Date.now() + checkDelayMs).toISOString(),
  durationMinutes,
});
```

**Location 1: UTM Deterministic Linking / Reschedule path (~line 1210 area)**

Insert after the existing `await emitDomainEvent(...)` that follows the meeting insert.

**Location 2: Heuristic Auto-Reschedule path (~line 1471 area)**

Insert after the existing `await emitDomainEvent(...)` that follows the meeting insert.

**Location 3: Standard New/Follow-up Booking path (~line 1685 area)**

Insert after the existing `await emitDomainEvent(...)` that follows the meeting insert.

**Step 3: Verify all 3 paths have the hook**

Search the file for `ctx.db.insert("meetings"` — there should be exactly 3 occurrences, and each should be followed by the attendance check scheduling block.

**Key implementation notes:**
- `Math.max(0, ...)` handles the edge case where a webhook arrives late and the meeting's end time has already passed. In this case, `checkDelayMs` is 0, meaning the scheduler fires immediately. This is correct — the meeting's time has passed and the closer couldn't have attended.
- `ctx.scheduler.runAfter` is atomic with the rest of the mutation. If the mutation fails (e.g., transaction conflict), the scheduled function is never registered.
- The `attendanceCheckId` is stored on the meeting document for two purposes: (1) cancellation by `startMeeting` and other flows, (2) audit trail.
- The `internal.closer.meetingOverrun.checkMeetingAttendance` reference will only resolve after 2A is deployed. Deploy 2A and 2B together or 2A first.
- `scheduledAt` and `durationMinutes` are already available in scope at all 3 locations (they're extracted from the Calendly webhook payload).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/inviteeCreated.ts` | Modify | Add attendance check scheduling after all 3 meeting creation paths |

---

### 2C — Attendance Check Cancellation on Normal Meeting Flows

**Type:** Backend
**Parallelizable:** Yes — after 2A complete. Can run in parallel with 2D (but they share `inviteeCanceled.ts` and `inviteeNoShow.ts` — coordinate or combine).

**What:** Add `ctx.scheduler.cancel(meeting.attendanceCheckId)` to all normal meeting transition paths: `startMeeting`, `inviteeCanceled`, `inviteeNoShow`, and `adminResolveMeeting`.

**Why:** Cancellation is optional (the idempotent guard in `checkMeetingAttendance` handles stale invocations), but explicit cancellation prevents unnecessary scheduled function executions and keeps the `_scheduled_functions` table clean. It also eliminates log noise from no-op scheduled functions firing on already-handled meetings.

**Where:**
- `convex/closer/meetingActions.ts` (modify — `startMeeting` handler)
- `convex/pipeline/inviteeCanceled.ts` (modify — meeting cancellation handler)
- `convex/pipeline/inviteeNoShow.ts` (modify — no-show handler)
- `convex/admin/meetingActions.ts` (modify — `adminResolveMeeting` handler)

**How:**

**Step 1: Add cancellation to `startMeeting`**

```typescript
// Path: convex/closer/meetingActions.ts — inside startMeeting handler
// Insert AFTER the status validation (`if (meeting.status !== "scheduled")` check)
// and BEFORE the meeting patch to "in_progress":

// Cancel attendance check — closer is attending
if (meeting.attendanceCheckId) {
  await ctx.scheduler.cancel(meeting.attendanceCheckId);
}
```

**Step 2: Add cancellation to `inviteeCanceled`**

```typescript
// Path: convex/pipeline/inviteeCanceled.ts — inside the cancellation handler
// Insert BEFORE the meeting status patch to "canceled":

// Cancel attendance check — meeting is cancelled externally
if (meeting.attendanceCheckId) {
  await ctx.scheduler.cancel(meeting.attendanceCheckId);
}
```

**Step 3: Add cancellation to `inviteeNoShow`**

```typescript
// Path: convex/pipeline/inviteeNoShow.ts — inside the process handler
// Insert BEFORE the meeting status patch to "no_show":

// Cancel attendance check — no-show already handled by Calendly
if (meeting.attendanceCheckId) {
  await ctx.scheduler.cancel(meeting.attendanceCheckId);
}
```

**Step 4: Add cancellation to `adminResolveMeeting`**

```typescript
// Path: convex/admin/meetingActions.ts — inside adminResolveMeeting handler
// Insert BEFORE the meeting status patch:

// Cancel attendance check — admin is backdating the meeting
if (meeting.attendanceCheckId) {
  await ctx.scheduler.cancel(meeting.attendanceCheckId);
}
```

**Key implementation notes:**
- `ctx.scheduler.cancel()` is a no-op if the scheduled function has already fired. It's safe to call unconditionally.
- The `if (meeting.attendanceCheckId)` guard is needed because meetings created before this feature was deployed won't have the field set. Without the guard, `ctx.scheduler.cancel(undefined)` would throw.
- The cancellation must happen BEFORE the meeting status patch — if the cancellation fails (unlikely), the meeting still transitions and the idempotent guard handles the stale scheduler invocation.
- In `inviteeCanceled.ts` and `inviteeNoShow.ts`, there's also a `meeting_overran` guard (2D). The cancellation should be placed BEFORE the `meeting_overran` guard — if the meeting is already `meeting_overran`, the attendance check has already fired (no ID to cancel). But for normal flows (meeting still `scheduled`), cancellation happens first.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/meetingActions.ts` | Modify | Add attendance check cancellation to `startMeeting` |
| `convex/pipeline/inviteeCanceled.ts` | Modify | Add attendance check cancellation |
| `convex/pipeline/inviteeNoShow.ts` | Modify | Add attendance check cancellation |
| `convex/admin/meetingActions.ts` | Modify | Add attendance check cancellation to `adminResolveMeeting` |

---

### 2D — Webhook Isolation: Ignore Calendly Events for `meeting_overran`

**Type:** Backend
**Parallelizable:** Yes — after 2A complete. Shares files with 2C — combine in a single pass per file.

**What:** Update the existing `meeting_overran` guard in `inviteeCanceled.ts` and `inviteeNoShow.ts` to emit a domain event when ignoring webhooks for flagged meetings. The Phase 1 status renames (1C) already changed the guard from `pending_review` to `meeting_overran`. This subphase adds the domain event emission and log message update.

**Why:** Once a meeting is flagged as `meeting_overran`, the review system owns the resolution. External Calendly events (cancellation, no-show) must not interfere. The domain event provides audit trail for ignored webhooks — critical for compliance and debugging.

**Where:**
- `convex/pipeline/inviteeCanceled.ts` (modify)
- `convex/pipeline/inviteeNoShow.ts` (modify)

**How:**

**Step 1: Enhance the `meeting_overran` guard in `inviteeCanceled.ts`**

```typescript
// Path: convex/pipeline/inviteeCanceled.ts — enhance the existing meeting_overran guard

// The Phase 1 rename already changed this from "pending_review" to "meeting_overran".
// Now add the domain event emission:

if (opportunity?.status === "meeting_overran") {
  console.log("[Pipeline] inviteeCanceled | IGNORED — opportunity is meeting_overran", {
    opportunityId: opportunity._id,
    meetingId: meeting._id,
  });
  await emitDomainEvent(ctx, {
    tenantId: opportunity.tenantId,
    entityType: "meeting",
    entityId: meeting._id,
    eventType: "meeting.webhook_ignored_overran",
    source: "pipeline",
    occurredAt: Date.now(),
    metadata: { webhookEventType: "invitee.canceled" },
  });
  return;
}
```

**Step 2: Enhance the `meeting_overran` guard in `inviteeNoShow.ts`**

```typescript
// Path: convex/pipeline/inviteeNoShow.ts — enhance the existing meeting_overran guard

if (opportunity?.status === "meeting_overran") {
  console.log("[Pipeline] inviteeNoShow | IGNORED — opportunity is meeting_overran", {
    opportunityId: opportunity._id,
    meetingId: meeting._id,
  });
  await emitDomainEvent(ctx, {
    tenantId: opportunity.tenantId,
    entityType: "meeting",
    entityId: meeting._id,
    eventType: "meeting.webhook_ignored_overran",
    source: "pipeline",
    occurredAt: Date.now(),
    metadata: { webhookEventType: "invitee_no_show.created" },
  });
  return;
}
```

**Step 3: Ensure `emitDomainEvent` is imported**

Verify that `emitDomainEvent` is already imported in both files. If not, add:

```typescript
import { emitDomainEvent } from "../lib/domainEvents";
```

**Key implementation notes:**
- The guard checks `opportunity?.status` (with optional chaining) because the opportunity lookup may return null if the meeting is orphaned.
- The domain event type `"meeting.webhook_ignored_overran"` is a new event type. Domain events use free-form `eventType` strings — no schema change needed.
- The `metadata.webhookEventType` records which Calendly event was ignored — useful for debugging if an admin wonders why a cancellation wasn't processed.
- The `return` statement ensures no further processing happens — the webhook event is silently dropped after logging and audit.
- When combining with 2C (attendance check cancellation), the cancellation should come BEFORE this guard in the code flow, since if the meeting is `meeting_overran`, the attendance check has already fired.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/inviteeCanceled.ts` | Modify | Add domain event emission to meeting_overran guard |
| `convex/pipeline/inviteeNoShow.ts` | Modify | Add domain event emission to meeting_overran guard |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/closer/meetingOverrun.ts` | Create | 2A |
| `convex/pipeline/inviteeCreated.ts` | Modify | 2B |
| `convex/closer/meetingActions.ts` | Modify | 2C |
| `convex/pipeline/inviteeCanceled.ts` | Modify | 2C, 2D |
| `convex/pipeline/inviteeNoShow.ts` | Modify | 2C, 2D |
| `convex/admin/meetingActions.ts` | Modify | 2C |
