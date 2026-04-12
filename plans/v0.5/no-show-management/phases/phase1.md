# Phase 1 — Schema & Status Transitions

**Goal:** Add all foundational schema fields and status transition configuration required by the No-Show Management feature. After this phase, the `meetings` table supports no-show tracking fields (`startedAt`, `noShowMarkedAt`, `noShowWaitDurationMs`, `noShowReason`, `noShowNote`, `noShowSource`, `rescheduledFromMeetingId`), the opportunity status union includes `reschedule_link_sent`, the `startMeeting` mutation records `startedAt`, and the Calendly no-show webhook populates `noShowSource`/`noShowMarkedAt`.

**Prerequisite:** Features A (Follow-Up & Rescheduling Overhaul), E (Identity Resolution), F, G (UTM Tracking), H (Closer Unavailability), I (Meeting Detail Enhancements) complete. v0.4 deployed.

**Runs in PARALLEL with:** Nothing — all subsequent phases (2-5) depend on Phase 1 schema and transition config.

> **Critical path:** This phase is on the critical path (Phase 1 -> Phase 2 -> Phase 3 -> Phase 4 -> Phase 5). Start as early as possible after the prerequisite completes.

**Skills to invoke:**
- None — this phase is pure schema, config, and backend mutation changes. No UI, no browser verification needed.

**Acceptance Criteria:**
1. `npx convex dev` deploys successfully with the updated schema (7 new optional fields on `meetings`, `reschedule_link_sent` literal on `opportunities`).
2. Existing meetings with `undefined` for all new fields remain valid (no migration needed).
3. `OPPORTUNITY_STATUSES` array in `convex/lib/statusTransitions.ts` includes `"reschedule_link_sent"` and the `OpportunityStatus` type reflects it.
4. `VALID_TRANSITIONS` allows `in_progress -> no_show`, `no_show -> reschedule_link_sent`, `no_show -> scheduled`, `canceled -> scheduled`, and `reschedule_link_sent -> scheduled`.
5. Calling `startMeeting` on a `"scheduled"` meeting patches `startedAt: Date.now()` alongside `status: "in_progress"`.
6. When `invitee_no_show.created` webhook fires, the meeting patch includes `noShowSource: "calendly_webhook"` and `noShowMarkedAt: Date.now()`.
7. `OPPORTUNITY_STATUSES` in `lib/status-config.ts` includes `"reschedule_link_sent"` with a blue visual theme, and `PIPELINE_DISPLAY_ORDER` includes it.
8. The `opportunityStatusConfig` record is exhaustive — TypeScript errors if `reschedule_link_sent` is missing.
9. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (Schema changes) ──────────────────────────────────────────┐
                                                               ├── 1B (Status transitions)
                                                               ├── 1C (startMeeting update)
                                                               ├── 1D (inviteeNoShow update)
                                                               └── 1E (Frontend status config)
```

**Optimal execution:**
1. Start **1A** first — it must complete and deploy before any other subphase (all others depend on generated types from the schema).
2. Once 1A is done, start **1B**, **1C**, **1D**, and **1E** all in parallel (they touch different files with no overlap).

**Estimated time:** 1 day

---

## Subphases

### 1A — Schema Changes (meetings + opportunities)

**Type:** Backend
**Parallelizable:** No — must complete first. All other subphases depend on the generated types from this schema deployment.

**What:** Add 7 optional fields to the `meetings` table (`startedAt`, `noShowMarkedAt`, `noShowWaitDurationMs`, `noShowReason`, `noShowNote`, `noShowSource`, `rescheduledFromMeetingId`) and add `reschedule_link_sent` to the `opportunities.status` union.

**Why:** Every subsequent phase imports types from `convex/_generated/dataModel`. Without the new fields, TypeScript compilation fails for the mutation changes in 1C/1D. Without `reschedule_link_sent` in the opportunity status union, the transition config in 1B and frontend config in 1E will not type-check.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Add `reschedule_link_sent` to the opportunity status union**

Before:

```typescript
// Path: convex/schema.ts
  opportunities: defineTable({
    // ... existing fields ...
    status: v.union(
      v.literal("scheduled"),
      v.literal("in_progress"),
      v.literal("payment_received"),
      v.literal("follow_up_scheduled"),
      v.literal("lost"),
      v.literal("canceled"),
      v.literal("no_show"),
    ),
    // ... rest of table ...
```

After:

```typescript
// Path: convex/schema.ts
  opportunities: defineTable({
    // ... existing fields ...
    status: v.union(
      v.literal("scheduled"),
      v.literal("in_progress"),
      v.literal("payment_received"),
      v.literal("follow_up_scheduled"),
      v.literal("reschedule_link_sent"), // Feature B: Reschedule link sent to lead, awaiting their booking
      v.literal("lost"),
      v.literal("canceled"),
      v.literal("no_show"),
    ),
    // ... rest of table ...
```

**Step 2: Add no-show tracking fields to the `meetings` table**

Add the following 7 fields after the existing `reassignedFromCloserId` field (end of the Feature H block), before the closing `})` and index chain. All fields are `v.optional()` for backward compatibility with existing documents.

Before:

```typescript
// Path: convex/schema.ts
    // === Feature H: Closer Unavailability & Redistribution ===
    // Denormalized source closer for the most recent reassignment.
    // Undefined means the meeting has never been reassigned.
    reassignedFromCloserId: v.optional(v.id("users")),
    // === End Feature H ===
  })
    .index("by_opportunityId", ["opportunityId"])
    .index("by_tenantId_and_scheduledAt", ["tenantId", "scheduledAt"])
    .index("by_tenantId_and_calendlyEventUri", ["tenantId", "calendlyEventUri"]),
```

After:

```typescript
// Path: convex/schema.ts
    // === Feature H: Closer Unavailability & Redistribution ===
    // Denormalized source closer for the most recent reassignment.
    // Undefined means the meeting has never been reassigned.
    reassignedFromCloserId: v.optional(v.id("users")),
    // === End Feature H ===

    // === Feature B: Meeting Start Time ===
    // When the closer clicked "Start Meeting". Used to compute no-show wait duration.
    // Set by the startMeeting mutation. Undefined for meetings started before Feature B
    // or for webhook-driven no-shows where the meeting was never started in the CRM.
    startedAt: v.optional(v.number()),
    // === End Feature B: Meeting Start Time ===

    // === Feature B: No-Show Tracking ===
    // When the no-show was recorded (by closer or webhook handler).
    noShowMarkedAt: v.optional(v.number()),

    // How long the closer waited before marking no-show (ms).
    // Computed server-side as noShowMarkedAt - startedAt.
    // Undefined for webhook-driven no-shows or if startedAt is missing.
    noShowWaitDurationMs: v.optional(v.number()),

    // Structured reason for the no-show.
    noShowReason: v.optional(
      v.union(
        v.literal("no_response"),      // Lead didn't show, no communication
        v.literal("late_cancel"),      // Lead communicated they can't make it
        v.literal("technical_issues"), // Technical problems prevented meeting
        v.literal("other"),            // Other reason (see noShowNote)
      ),
    ),

    // Free-text note from the closer explaining the no-show.
    noShowNote: v.optional(v.string()),

    // Who created the no-show record.
    noShowSource: v.optional(
      v.union(
        v.literal("closer"),           // Closer marked in-app (primary path)
        v.literal("calendly_webhook"), // Calendly invitee_no_show.created webhook (rare)
      ),
    ),
    // === End Feature B: No-Show Tracking ===

    // === Feature B: Reschedule Chain ===
    // Links this meeting back to the no-show meeting it reschedules.
    // Set by:
    //   (B3) Pipeline UTM routing when utm_medium === "noshow_resched"
    //   (B4) Pipeline heuristic when auto-detecting an organic reschedule
    // Undefined for first-contact meetings and non-reschedule follow-ups.
    rescheduledFromMeetingId: v.optional(v.id("meetings")),
    // === End Feature B: Reschedule Chain ===
  })
    .index("by_opportunityId", ["opportunityId"])
    .index("by_tenantId_and_scheduledAt", ["tenantId", "scheduledAt"])
    .index("by_tenantId_and_calendlyEventUri", ["tenantId", "calendlyEventUri"]),
```

**Step 3: Deploy and verify**

```bash
npx convex dev
```

Confirm the Convex dashboard shows the updated `meetings` table with the new optional fields and the updated `opportunities.status` union.

**Key implementation notes:**
- All 7 new fields are `v.optional()` — existing meetings have `undefined` for every new field, so no data migration is needed.
- No new indexes are required in Phase 1. The `rescheduledFromMeetingId` field is only read by-ID lookup (`ctx.db.get`), not queried. If Phase 5 needs a reverse lookup ("find meetings rescheduled from X"), an index can be added then.
- The `noShowReason` union uses the 4 values from the design: `no_response`, `late_cancel`, `technical_issues`, `other`. These are the choices shown in the Phase 2 dialog.
- `noShowWaitDurationMs` is computed server-side (`noShowMarkedAt - startedAt`) by the `markNoShow` mutation in Phase 2. It is NOT set in Phase 1 — Phase 1 only adds the schema field.
- The `reschedule_link_sent` literal is placed after `follow_up_scheduled` in the union for logical grouping (both are "awaiting next action" statuses).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add 7 optional fields to `meetings`, add `reschedule_link_sent` to `opportunities.status` union |

---

### 1B — Status Transitions Config

**Type:** Backend
**Parallelizable:** Yes — depends only on 1A (schema types). No overlap with 1C, 1D, or 1E.

**What:** Update `convex/lib/statusTransitions.ts` to add `reschedule_link_sent` to `OPPORTUNITY_STATUSES` and update `VALID_TRANSITIONS` with new transition paths for `in_progress`, `no_show`, `canceled`, and the new `reschedule_link_sent` status.

**Why:** The `validateTransition()` function is called by every status-changing mutation (including the Phase 2 `markNoShow` and Phase 3 `createNoShowRescheduleLink`). Without these transition rules, those mutations will reject valid status changes. The `in_progress -> no_show` transition is needed immediately for the closer-initiated no-show flow.

**Where:**
- `convex/lib/statusTransitions.ts` (modify)

**How:**

**Step 1: Add `reschedule_link_sent` to `OPPORTUNITY_STATUSES` and update `VALID_TRANSITIONS`**

Before (entire file):

```typescript
// Path: convex/lib/statusTransitions.ts
export const OPPORTUNITY_STATUSES = [
  "scheduled",
  "in_progress",
  "payment_received",
  "follow_up_scheduled",
  "lost",
  "canceled",
  "no_show",
] as const;

export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export const MEETING_STATUSES = [
  "scheduled",
  "in_progress",
  "completed",
  "canceled",
  "no_show",
] as const;

export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const VALID_TRANSITIONS: Record<
  OpportunityStatus,
  OpportunityStatus[]
> = {
  scheduled: ["in_progress", "canceled", "no_show"],
  in_progress: ["payment_received", "follow_up_scheduled", "lost"],
  canceled: ["follow_up_scheduled"],
  no_show: ["follow_up_scheduled"],
  follow_up_scheduled: ["scheduled"],
  payment_received: [],
  lost: [],
};

export function validateTransition(
  from: OpportunityStatus,
  to: OpportunityStatus,
): boolean {
  const valid = VALID_TRANSITIONS[from].includes(to);
  if (!valid) {
    console.warn("[StatusTransition] Invalid transition rejected", { from, to, allowedTargets: VALID_TRANSITIONS[from] });
  } else {
    console.log("[StatusTransition] Transition validated", { from, to });
  }
  return valid;
}
```

After (entire file):

```typescript
// Path: convex/lib/statusTransitions.ts
export const OPPORTUNITY_STATUSES = [
  "scheduled",
  "in_progress",
  "payment_received",
  "follow_up_scheduled",
  "reschedule_link_sent", // Feature B: Reschedule link sent to lead, awaiting their booking
  "lost",
  "canceled",
  "no_show",
] as const;

export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export const MEETING_STATUSES = [
  "scheduled",
  "in_progress",
  "completed",
  "canceled",
  "no_show",
] as const;

export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const VALID_TRANSITIONS: Record<
  OpportunityStatus,
  OpportunityStatus[]
> = {
  scheduled: ["in_progress", "canceled", "no_show"],
  in_progress: ["payment_received", "follow_up_scheduled", "lost", "no_show"], // Feature B: + "no_show" (closer-initiated primary path)
  canceled: ["follow_up_scheduled", "scheduled"],          // Feature B: + "scheduled" (B4 heuristic rebooking)
  no_show: ["follow_up_scheduled", "reschedule_link_sent", "scheduled"], // Feature B: + "reschedule_link_sent" (B3) + "scheduled" (B4 heuristic)
  reschedule_link_sent: ["scheduled"],                     // Feature B: Lead books via the scheduling link -> scheduled
  follow_up_scheduled: ["scheduled"],
  payment_received: [],
  lost: [],
};

export function validateTransition(
  from: OpportunityStatus,
  to: OpportunityStatus,
): boolean {
  const valid = VALID_TRANSITIONS[from].includes(to);
  if (!valid) {
    console.warn("[StatusTransition] Invalid transition rejected", { from, to, allowedTargets: VALID_TRANSITIONS[from] });
  } else {
    console.log("[StatusTransition] Transition validated", { from, to });
  }
  return valid;
}
```

**Key implementation notes:**
- The `VALID_TRANSITIONS` record is typed `Record<OpportunityStatus, OpportunityStatus[]>` — TypeScript will error if the new `reschedule_link_sent` key is missing after adding it to `OPPORTUNITY_STATUSES`. This guarantees exhaustiveness.
- Transition rationale (from design doc Section 4.3):
  - `in_progress -> no_show`: The PRIMARY no-show path. Closer starts the meeting, waits, then marks no-show.
  - `no_show -> reschedule_link_sent`: Closer sends a reschedule scheduling link (B3). The lead is responsible for booking.
  - `no_show -> follow_up_scheduled`: Closer creates a follow-up reminder (existing Feature A dialog).
  - `no_show -> scheduled`: Pipeline auto-detects an organic rebooking (B4 heuristic).
  - `reschedule_link_sent -> scheduled`: Lead books via the scheduling link.
  - `canceled -> scheduled`: Pipeline auto-detects a rebooking after a cancellation (B4 heuristic).
- `MEETING_STATUSES` is unchanged — meetings do not use `reschedule_link_sent` (it is an opportunity-level status only).
- `reschedule_link_sent` is placed after `follow_up_scheduled` in the array to match the schema union ordering.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/statusTransitions.ts` | Modify | Add `reschedule_link_sent` to `OPPORTUNITY_STATUSES`, update 3 existing transitions, add 1 new transition entry |

---

### 1C — `startMeeting` Mutation Update

**Type:** Backend
**Parallelizable:** Yes — depends only on 1A (schema types for `startedAt` field). No overlap with 1B, 1D, or 1E.

**What:** Update the `startMeeting` mutation handler in `convex/closer/meetingActions.ts` to record `startedAt: Date.now()` when patching the meeting to `in_progress`.

**Why:** The `startedAt` timestamp is the anchor for computing no-show wait duration. Phase 2's `markNoShow` mutation calculates `noShowWaitDurationMs = noShowMarkedAt - startedAt`. Without `startedAt`, the wait time shown in the no-show dialog (Phase 2) would be unavailable for meetings started after this deployment.

**Where:**
- `convex/closer/meetingActions.ts` (modify)

**How:**

**Step 1: Add `startedAt` to the meeting patch in `startMeeting`**

The change is a single-line addition to the existing `ctx.db.patch` call at line 100 of the file.

Before:

```typescript
// Path: convex/closer/meetingActions.ts
    console.log("[Closer:Meeting] startMeeting transitioning to in_progress", { meetingId, opportunityId: opportunity._id });
    await ctx.db.patch(opportunity._id, {
      status: "in_progress",
      updatedAt: Date.now(),
    });

    await ctx.db.patch(meetingId, { status: "in_progress" });
    await updateOpportunityMeetingRefs(ctx, opportunity._id);
```

After:

```typescript
// Path: convex/closer/meetingActions.ts
    console.log("[Closer:Meeting] startMeeting transitioning to in_progress", { meetingId, opportunityId: opportunity._id });
    await ctx.db.patch(opportunity._id, {
      status: "in_progress",
      updatedAt: Date.now(),
    });

    await ctx.db.patch(meetingId, {
      status: "in_progress",
      startedAt: Date.now(), // Feature B: Record when the closer actually started the meeting (for no-show wait time)
    });
    await updateOpportunityMeetingRefs(ctx, opportunity._id);
```

**Key implementation notes:**
- `startedAt` uses `Date.now()` (epoch ms), consistent with `createdAt` and `updatedAt` across the codebase.
- `startedAt` is distinct from `scheduledAt` on purpose. `scheduledAt` is the Calendly-scheduled time; `startedAt` is when the closer actually clicked "Start Meeting". The closer may start early (5-min window allowed in non-production, see commit `e5d2b04`) or late. The wait duration should measure from the closer's actual start, not the scheduled slot.
- No changes to `args`, `handler` signature, or return value. The mutation's external contract is unchanged.
- Existing meetings already started before this deployment will have `startedAt: undefined`. This is handled gracefully in Phase 2 — the `markNoShow` mutation computes `noShowWaitDurationMs` only when `startedAt` is defined.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/meetingActions.ts` | Modify | Add `startedAt: Date.now()` to the meeting patch in `startMeeting` handler |

---

### 1D — `inviteeNoShow` Webhook Handler Update

**Type:** Backend
**Parallelizable:** Yes — depends only on 1A (schema types for `noShowSource`, `noShowMarkedAt`). No overlap with 1B, 1C, or 1E.

**What:** Update the `process` handler in `convex/pipeline/inviteeNoShow.ts` to include `noShowSource: "calendly_webhook"` and `noShowMarkedAt: Date.now()` when patching the meeting to `no_show` status.

**Why:** When the Calendly `invitee_no_show.created` webhook fires (rare secondary path), the system must record the source and timestamp for consistency with the closer-initiated path (Phase 2). This allows the UI to distinguish how a no-show was created and when, regardless of path.

**Where:**
- `convex/pipeline/inviteeNoShow.ts` (modify)

**How:**

**Step 1: Update the meeting status patch to include no-show tracking fields**

The change is in the `process` handler's conditional block at line 78-80.

Before:

```typescript
// Path: convex/pipeline/inviteeNoShow.ts
    if (meeting.status !== "no_show") {
      await ctx.db.patch(meeting._id, { status: "no_show" });
      await updateOpportunityMeetingRefs(ctx, meeting.opportunityId);
      console.log(`[Pipeline:no-show] Meeting status changed | ${meeting.status} -> no_show`);
    } else {
      console.log(`[Pipeline:no-show] Meeting already no_show, no change`);
    }
```

After:

```typescript
// Path: convex/pipeline/inviteeNoShow.ts
    if (meeting.status !== "no_show") {
      await ctx.db.patch(meeting._id, {
        status: "no_show",
        noShowSource: "calendly_webhook",  // Feature B: Mark webhook as the source
        noShowMarkedAt: Date.now(),        // Feature B: Record when the no-show was detected
        // noShowWaitDurationMs: undefined — unknown from webhook (no startedAt context)
        // noShowReason: undefined — webhook doesn't carry a reason
        // noShowNote: undefined — webhook doesn't carry a note
      });
      await updateOpportunityMeetingRefs(ctx, meeting.opportunityId);
      console.log(`[Pipeline:no-show] Meeting status changed | ${meeting.status} -> no_show (source=calendly_webhook)`);
    } else {
      console.log(`[Pipeline:no-show] Meeting already no_show, no change`);
    }
```

**Key implementation notes:**
- `noShowWaitDurationMs`, `noShowReason`, and `noShowNote` are intentionally left undefined for the webhook path. The webhook provides no context about why the lead didn't show or how long anyone waited. The comments document this explicitly for future readers.
- If the meeting was already marked `no_show` (e.g., the closer already marked it via Phase 2's primary path), the patch is skipped entirely. This prevents the webhook from overwriting the closer's more detailed no-show data (`noShowSource: "closer"`, reason, note, wait duration).
- The `revert` handler is unchanged — it only needs to restore `status: "scheduled"`. The no-show tracking fields (`noShowSource`, `noShowMarkedAt`, etc.) are left as-is on revert because they're optional and won't cause issues in the `"scheduled"` state. Clearing them could be added later if needed.
- The log message now includes `(source=calendly_webhook)` for observability.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/inviteeNoShow.ts` | Modify | Add `noShowSource` and `noShowMarkedAt` to the meeting patch in `process` handler |

---

### 1E — Frontend Status Config

**Type:** Frontend
**Parallelizable:** Yes — depends only on 1A (the `OpportunityStatus` type must include `reschedule_link_sent`). No overlap with 1B, 1C, or 1D.

**What:** Add `reschedule_link_sent` to the `OPPORTUNITY_STATUSES` array, the `opportunityStatusConfig` record, and the `PIPELINE_DISPLAY_ORDER` array in `lib/status-config.ts`. Use a sky-blue visual theme to distinguish it from the existing `scheduled` (blue) status.

**Why:** The `opportunityStatusConfig` record is typed `Record<OpportunityStatus, StatusVisualConfig>`. After 1B adds `reschedule_link_sent` to the backend `OpportunityStatus` type, the frontend type (which mirrors it) must also include the new status — otherwise TypeScript will error on the exhaustive record. Every pipeline view, badge, and status dot renders through this config, so the new status needs visual styling before any UI work in later phases.

**Where:**
- `lib/status-config.ts` (modify)

**How:**

**Step 1: Add `reschedule_link_sent` to `OPPORTUNITY_STATUSES`**

Before:

```typescript
// Path: lib/status-config.ts
export const OPPORTUNITY_STATUSES = [
  "scheduled",
  "in_progress",
  "payment_received",
  "follow_up_scheduled",
  "lost",
  "canceled",
  "no_show",
] as const;
```

After:

```typescript
// Path: lib/status-config.ts
export const OPPORTUNITY_STATUSES = [
  "scheduled",
  "in_progress",
  "payment_received",
  "follow_up_scheduled",
  "reschedule_link_sent", // Feature B: Reschedule link sent, awaiting lead's booking
  "lost",
  "canceled",
  "no_show",
] as const;
```

**Step 2: Add `reschedule_link_sent` entry to `opportunityStatusConfig`**

Add the new entry after `no_show` (last in the record). Use a sky-blue theme (`sky-500`) to distinguish from `scheduled` (which uses `blue-500`).

Before:

```typescript
// Path: lib/status-config.ts
  no_show: {
    label: "No Show",
    badgeClass:
      "bg-orange-500/10 text-orange-700 border-orange-200 dark:text-orange-400 dark:border-orange-900",
    dotClass: "bg-orange-500",
    stripBg:
      "bg-orange-500/5 hover:bg-orange-500/10 border-orange-200/60 dark:border-orange-900/60",
  },
};
```

After:

```typescript
// Path: lib/status-config.ts
  no_show: {
    label: "No Show",
    badgeClass:
      "bg-orange-500/10 text-orange-700 border-orange-200 dark:text-orange-400 dark:border-orange-900",
    dotClass: "bg-orange-500",
    stripBg:
      "bg-orange-500/5 hover:bg-orange-500/10 border-orange-200/60 dark:border-orange-900/60",
  },
  reschedule_link_sent: {
    label: "Reschedule Sent",
    badgeClass:
      "bg-sky-500/10 text-sky-700 border-sky-200 dark:text-sky-400 dark:border-sky-900",
    dotClass: "bg-sky-500",
    stripBg:
      "bg-sky-500/5 hover:bg-sky-500/10 border-sky-200/60 dark:border-sky-900/60",
  },
};
```

**Step 3: Add `reschedule_link_sent` to `PIPELINE_DISPLAY_ORDER`**

Place it after `no_show` — logically, a reschedule sent is a progression from no-show (the closer took action).

Before:

```typescript
// Path: lib/status-config.ts
export const PIPELINE_DISPLAY_ORDER: OpportunityStatus[] = [
  "scheduled",
  "in_progress",
  "follow_up_scheduled",
  "payment_received",
  "lost",
  "canceled",
  "no_show",
];
```

After:

```typescript
// Path: lib/status-config.ts
export const PIPELINE_DISPLAY_ORDER: OpportunityStatus[] = [
  "scheduled",
  "in_progress",
  "follow_up_scheduled",
  "payment_received",
  "lost",
  "canceled",
  "no_show",
  "reschedule_link_sent", // Feature B: After no_show — closer sent a reschedule link
];
```

**Key implementation notes:**
- Sky-blue (`sky-500`) is deliberately chosen to differentiate from the existing `scheduled` status (`blue-500`). Both are "waiting" states, but `scheduled` = confirmed booking while `reschedule_link_sent` = link sent, no booking yet.
- The label is `"Reschedule Sent"` (not `"Reschedule Link Sent"`) for brevity in badge/pill contexts where horizontal space is limited.
- `PIPELINE_DISPLAY_ORDER` places `reschedule_link_sent` last because it is a rare, transitional status. It should not clutter the main pipeline columns. Admins scroll right to see it alongside `no_show`.
- The `OpportunityStatus` type exported from this file (`type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number]`) automatically includes `reschedule_link_sent` after the array update. Any `Record<OpportunityStatus, ...>` in the codebase will require the new key — TypeScript enforces exhaustiveness.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `lib/status-config.ts` | Modify | Add `reschedule_link_sent` to `OPPORTUNITY_STATUSES`, `opportunityStatusConfig`, and `PIPELINE_DISPLAY_ORDER` |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modify | 1A |
| `convex/lib/statusTransitions.ts` | Modify | 1B |
| `convex/closer/meetingActions.ts` | Modify | 1C |
| `convex/pipeline/inviteeNoShow.ts` | Modify | 1D |
| `lib/status-config.ts` | Modify | 1E |
