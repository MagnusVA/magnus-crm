# Phase 2 — Meeting Time Tracking + Mutation Integration + Form Response Pipeline

**Goal:** Build the `stopMeeting` and `setLateStartReason` mutations with late-start detection, hook all 5 aggregate instances into every relevant mutation across the codebase (34 touch points across ~10 files), wire live `meetingFormResponses` insertion into the pipeline, and add the "End Meeting" button + late-start prompt to the closer UI.

**Prerequisite:** Phase 1 complete — schema deployed (meetings has `callClassification`, `stoppedAt`, `lateStartDurationMs`, `lateStartReason`, `overranDurationMs`), all 5 aggregate instances registered and backfilled, `npx convex dev` succeeds.

**Runs in PARALLEL with:** Phase 3 (Core Reporting Queries — different files) and Phase 4 (Report Shell — frontend routes). Phase 2 writes to mutations; Phase 3 reads from aggregates; Phase 4 creates report routes. Zero shared files.

**Skills to invoke:**
- `convex-performance-audit` — after aggregate hooks are deployed, verify query costs and function limits are not exceeded
- `shadcn` — for the late-start dialog components (Dialog, Form, Textarea)

> **Critical path:** Phase 2B (aggregate hooks) is the highest-risk subphase (34 touch points across 10 files). A missed hook causes aggregate drift. Phase 2 is NOT on the critical path for Phase 5 delivery, but must complete before Phase 6 QA.

**Acceptance Criteria:**
1. `startMeeting` mutation returns `lateStartDurationMs` in its response. If the meeting starts after `scheduledAt`, `lateStartDurationMs > 0`.
2. `setLateStartReason` mutation stores a free-text reason on an in-progress meeting that was started late. Throws if meeting was not late or not in-progress.
3. `stopMeeting` mutation transitions a meeting from `in_progress` to `completed`, sets `stoppedAt` and `completedAt`, computes `overranDurationMs`, emits a `meeting.stopped` domain event, and updates the `meetingsByStatus` aggregate via `replace()`.
4. The "End Meeting" button appears on the meeting detail page when `status === "in_progress"` and shows overrun toast when applicable.
5. The late-start dialog appears after `startMeeting` when `lateStartDurationMs > 0`, allowing the closer to optionally record a reason.
6. All 15 `meetingsByStatus` aggregate hook points are active — every mutation that changes meeting `status`, `assignedCloserId`, or inserts a meeting calls `insert()` or `replace()`.
7. All 15 `opportunityByStatus` aggregate hook points are active.
8. Both `paymentSums` hook points are active. Both `leadTimeline` and `customerConversions` hook points are active.
9. Live webhook bookings (post-Phase 2F) insert `meetingFormResponses` rows and upsert `eventTypeFieldCatalog` entries.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (meeting mutations — meetingActions.ts) ─────────────────────────────┐
                                                                        ├── 2F (frontend — End Meeting + Late Start)
2B (aggregate hooks — pipeline/*.ts) ──────────────────────────────────┘
                                                                        
2C (aggregate hooks — closer/noShow, followUp, payments) ──────────────┘

2D (aggregate hooks — customers + unavailability + lib sync) ──────────┘

2E (form response pipeline — lib/ + pipeline/inviteeCreated.ts) ────────┘
```

**Optimal execution:**
1. Start **2A**, **2C**, **2D** all in parallel (different files: `meetingActions.ts` vs `noShowActions.ts`/`followUpMutations.ts`/`payments.ts` vs `customers/`/`unavailability/`).
2. Start **2B** and **2E** in sequence — both modify `pipeline/inviteeCreated.ts`. Do **2E first** (smaller change — form response writer), then **2B** (aggregate hooks in pipeline files).
3. After 2A completes → start **2F** (frontend depends on `stopMeeting` + `setLateStartReason` mutations existing).

**Note on file conflict:** 2B and 2E both modify `convex/pipeline/inviteeCreated.ts`. Run them sequentially (2E → 2B) or have the same developer handle both.

**Estimated time:** 3.5-4.5 days

---

## Subphases

### 2A — Meeting Time Tracking Mutations

**Type:** Backend
**Parallelizable:** Yes — touches only `convex/closer/meetingActions.ts`. No overlap with 2B-2E.

**What:** Enhance `startMeeting` with late-start duration computation. Add `setLateStartReason` and `stopMeeting` mutations. All three in `convex/closer/meetingActions.ts`.

**Why:** `stopMeeting` is the core action for meeting time tracking (Tier 3 KPIs). Late-start detection feeds into schedule adherence analytics. Without `stopMeeting`, meetings have no explicit end event and no overrun data.

**Where:**
- `convex/closer/meetingActions.ts` (modify)

**How:**

**Step 1: Enhance `startMeeting` — add late-start computation**

Find the existing `startMeeting` mutation. After the `status: "in_progress"` patch, add `lateStartDurationMs` computation:

```typescript
// Path: convex/closer/meetingActions.ts — inside startMeeting handler
// BEFORE the existing ctx.db.patch call, compute late-start duration:

const now = Date.now();
const lateStartDurationMs = Math.max(0, now - meeting.scheduledAt);

// MODIFY the existing patch to include the new field:
await ctx.db.patch(meetingId, {
  status: "in_progress",
  startedAt: now,
  lateStartDurationMs,
});

// ADD to the return value:
return {
  meetingJoinUrl: meeting.meetingJoinUrl ?? null,
  lateStartDurationMs, // NEW: frontend uses this to show late-start prompt
};
```

Also add the `meetingsByStatus` aggregate hook (this is one of the 15 touch points):

```typescript
// Path: convex/closer/meetingActions.ts — inside startMeeting handler
import { meetingsByStatus, opportunityByStatus } from "../reporting/aggregates";

// BEFORE the patch — capture old doc for aggregate replace
const oldMeetingDoc = await ctx.db.get(meetingId);

// ... existing patch ...

// AFTER the patch — replace in aggregate
const newMeetingDoc = await ctx.db.get(meetingId);
await meetingsByStatus.replace(ctx, oldMeetingDoc!, newMeetingDoc!);

// Also replace opportunity aggregate (status changes to in_progress)
const oldOppDoc = await ctx.db.get(meeting.opportunityId);
// ... existing opportunity status patch ...
const newOppDoc = await ctx.db.get(meeting.opportunityId);
await opportunityByStatus.replace(ctx, oldOppDoc!, newOppDoc!);
```

**Step 2: Add `setLateStartReason` mutation**

```typescript
// Path: convex/closer/meetingActions.ts
export const setLateStartReason = mutation({
  args: {
    meetingId: v.id("meetings"),
    reason: v.string(),
  },
  handler: async (ctx, { meetingId, reason }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);
    const { meeting, opportunity } = await loadMeetingContext(ctx, meetingId, tenantId);

    if (opportunity.assignedCloserId !== userId) {
      throw new Error("Not your meeting");
    }
    if (meeting.status !== "in_progress") {
      throw new Error("Meeting must be in progress to set late start reason");
    }
    if (!meeting.lateStartDurationMs || meeting.lateStartDurationMs === 0) {
      throw new Error("Meeting was not started late");
    }

    await ctx.db.patch(meetingId, { lateStartReason: reason.trim() });
    // No aggregate hook needed — lateStartReason is not in any sort key
  },
});
```

**Step 3: Add `stopMeeting` mutation**

```typescript
// Path: convex/closer/meetingActions.ts
export const stopMeeting = mutation({
  args: { meetingId: v.id("meetings") },
  handler: async (ctx, { meetingId }) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const { meeting, opportunity } = await loadMeetingContext(ctx, meetingId, tenantId);

    // Authorization: closers can only stop their own meetings
    if (role === "closer" && opportunity.assignedCloserId !== userId) {
      throw new Error("Not your meeting");
    }

    if (meeting.status !== "in_progress") {
      throw new Error(`Cannot stop a meeting with status "${meeting.status}"`);
    }

    const now = Date.now();
    const scheduledEndMs = meeting.scheduledAt + meeting.durationMinutes * 60 * 1000;
    const overranDurationMs = Math.max(0, now - scheduledEndMs);

    // Aggregate: capture old doc before patch
    const oldDoc = await ctx.db.get(meetingId);

    await ctx.db.patch(meetingId, {
      status: "completed",
      stoppedAt: now,
      completedAt: now,
      overranDurationMs,
    });

    // Aggregate: update after patch
    const newDoc = await ctx.db.get(meetingId);
    await meetingsByStatus.replace(ctx, oldDoc!, newDoc!);

    // Update denormalized refs
    await updateOpportunityMeetingRefs(ctx, opportunity._id);

    // Domain event
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "meeting",
      entityId: meetingId,
      eventType: "meeting.stopped",
      source: role === "closer" ? "closer" : "admin",
      actorUserId: userId,
      fromStatus: "in_progress",
      toStatus: "completed",
      occurredAt: now,
      metadata: {
        overranDurationMs,
        actualDurationMs: meeting.startedAt ? now - meeting.startedAt : undefined,
      },
    });

    return {
      overranDurationMs,
      wasOverran: overranDurationMs > 0,
    };
  },
});
```

**Key implementation notes:**
- `stopMeeting` does NOT touch opportunity status — it stays `in_progress` until the closer decides the outcome (payment, follow-up, lost).
- Both `stoppedAt` and `completedAt` are set for backward compatibility.
- Returns `wasOverran` so the frontend can show an immediate overrun toast.
- Admins can stop any meeting in their tenant (supervisor override). Closers can only stop their own.
- The `startMeeting` aggregate hooks (both `meetingsByStatus` and `opportunityByStatus`) cover 2 of the 34 total touch points.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/meetingActions.ts` | Modify | Enhance startMeeting + add stopMeeting + setLateStartReason + aggregate hooks |

---

### 2B — Aggregate Hooks: Pipeline Files

**Type:** Backend
**Parallelizable:** Partially — must run after 2E (both touch `inviteeCreated.ts`). Independent of 2C, 2D.

**What:** Add aggregate `insert()` and `replace()` calls to all mutation touch points in `convex/pipeline/inviteeCreated.ts`, `convex/pipeline/inviteeCanceled.ts`, and `convex/pipeline/inviteeNoShow.ts`.

**Why:** The pipeline processes every Calendly webhook and is the primary source of meeting/opportunity/lead creation and status changes. Without these hooks, the aggregates drift for every webhook event.

**Where:**
- `convex/pipeline/inviteeCreated.ts` (modify)
- `convex/pipeline/inviteeCanceled.ts` (modify)
- `convex/pipeline/inviteeNoShow.ts` (modify)

**How:**

**Step 1: Add imports to all 3 pipeline files**

```typescript
// Path: convex/pipeline/inviteeCreated.ts (and similar for inviteeCanceled.ts, inviteeNoShow.ts)
import {
  meetingsByStatus,
  opportunityByStatus,
  leadTimeline,
} from "../reporting/aggregates";
```

**Step 2: Hook `inviteeCreated.ts` — 3 meeting inserts + 2 opportunity changes + 1 lead insert**

The design identifies these touch points in `inviteeCreated.ts`:

| Line ~ | Function | Aggregate | Operation |
|---|---|---|---|
| ~1169 | process | meetingsByStatus | `insert` (UTM-linked reactivation meeting) |
| ~1421 | process | meetingsByStatus | `insert` (heuristic reschedule meeting) |
| ~1623 | process | meetingsByStatus | `insert` (new opportunity meeting) |
| ~1554 | process | opportunityByStatus | `insert` (new opportunity) |
| ~1059 | process (Flow 1) | opportunityByStatus | `replace` (status change) |
| ~1509 | process (Flow 3) | opportunityByStatus | `replace` (status change) |
| ~523 | resolveLeadIdentity | leadTimeline | `insert` (new lead) |

For each **meeting insert**:
```typescript
// After: const meetingId = await ctx.db.insert("meetings", { ... });
const meetingDoc = await ctx.db.get(meetingId);
await meetingsByStatus.insert(ctx, meetingDoc!);
```

For each **opportunity insert**:
```typescript
// After: const opportunityId = await ctx.db.insert("opportunities", { ... });
const oppDoc = await ctx.db.get(opportunityId);
await opportunityByStatus.insert(ctx, oppDoc!);
```

For each **opportunity replace**:
```typescript
// BEFORE: const oldOppDoc = await ctx.db.get(opportunityId);  // reuse existing loaded doc
// AFTER ctx.db.patch:
const newOppDoc = await ctx.db.get(opportunityId);
await opportunityByStatus.replace(ctx, oldOppDoc!, newOppDoc!);
```

For the **lead insert**:
```typescript
// After: const leadId = await ctx.db.insert("leads", { ... });
const leadDoc = await ctx.db.get(leadId);
await leadTimeline.insert(ctx, leadDoc!);
```

**Step 3: Hook `inviteeCanceled.ts` — 1 meeting replace + 1 opportunity replace**

```typescript
// Path: convex/pipeline/inviteeCanceled.ts
import { meetingsByStatus, opportunityByStatus } from "../reporting/aggregates";

// ~91: meeting status → canceled
// Capture old doc before patch
const oldMeetingDoc = meeting; // already loaded
await ctx.db.patch(meetingId, { status: "canceled", canceledAt: now });
const newMeetingDoc = await ctx.db.get(meetingId);
await meetingsByStatus.replace(ctx, oldMeetingDoc, newMeetingDoc!);

// ~143: opportunity status change
const oldOppDoc = opportunity; // already loaded
// ... existing patch ...
const newOppDoc = await ctx.db.get(opportunityId);
await opportunityByStatus.replace(ctx, oldOppDoc, newOppDoc!);
```

**Step 4: Hook `inviteeNoShow.ts` — 3 meeting replaces + 2 opportunity replaces**

```typescript
// Path: convex/pipeline/inviteeNoShow.ts
import { meetingsByStatus, opportunityByStatus } from "../reporting/aggregates";

// ~85: meeting → no_show (webhook)
// ~201: meeting → no_show (rescheduled canceled)
// ~201: revert: no_show → scheduled
// Pattern is the same for each:
const oldMeetingDoc = meeting; // already loaded
await ctx.db.patch(meetingId, { status: newStatus, ... });
const newMeetingDoc = await ctx.db.get(meetingId);
await meetingsByStatus.replace(ctx, oldMeetingDoc, newMeetingDoc!);

// Opportunity replaces at ~116 and ~229
const oldOppDoc = opportunity;
// ... existing patch ...
const newOppDoc = await ctx.db.get(opportunityId);
await opportunityByStatus.replace(ctx, oldOppDoc, newOppDoc!);
```

**Key implementation notes:**
- In most cases, the document is already loaded earlier in the function for validation (e.g., `const meeting = await ctx.db.get(meetingId)`). Reuse that as `oldDoc` to avoid a redundant `.get()` call.
- `inviteeCreated.ts` is a 49KB file — work carefully to identify the exact insertion points. Use the line numbers from the design as guides.
- The `callClassification` field must be set on new meetings inserted by the pipeline. At the 3 meeting insert points, add `callClassification: isFirstMeetingOnOpportunity ? "new" : "follow_up"`. (The logic to determine this is in the surrounding pipeline code.)
- Total touch points in this subphase: 7 (meetingsByStatus) + 4 (opportunityByStatus) + 1 (leadTimeline) = **12 hooks**.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/inviteeCreated.ts` | Modify | +6 aggregate hooks (3 meeting insert, 2 opp replace, 1 lead insert) + callClassification on inserts |
| `convex/pipeline/inviteeCanceled.ts` | Modify | +2 aggregate hooks (1 meeting replace, 1 opp replace) |
| `convex/pipeline/inviteeNoShow.ts` | Modify | +4 aggregate hooks (3 meeting replace, 2 opp replace) |

---

### 2C — Aggregate Hooks: Closer Files

**Type:** Backend
**Parallelizable:** Yes — touches `noShowActions.ts`, `followUpMutations.ts`, `payments.ts`. No overlap with 2A (`meetingActions.ts`), 2B (`pipeline/*`), or 2D (`customers/*`, `unavailability/*`).

**What:** Add aggregate hooks to 3 closer files: `noShowActions.ts` (2 meeting + 2 opportunity hooks), `followUpMutations.ts` (3 opportunity hooks), `payments.ts` (1 payment insert + 1 opportunity replace).

**Why:** Closer-initiated actions (mark no-show, transition to follow-up, log payment) are the second most common mutation category after pipeline processing. Missing hooks here would undercount no-shows, follow-ups, and payments in reports.

**Where:**
- `convex/closer/noShowActions.ts` (modify)
- `convex/closer/followUpMutations.ts` (modify)
- `convex/closer/payments.ts` (modify)

**How:**

**Step 1: Hook `noShowActions.ts` — 2 meeting replaces + 2 opportunity replaces**

```typescript
// Path: convex/closer/noShowActions.ts
import { meetingsByStatus, opportunityByStatus } from "../reporting/aggregates";

// ~71: markNoShow — meeting → no_show
const oldMeetingDoc = meeting; // already loaded for validation
await ctx.db.patch(meetingId, { status: "no_show", ... });
const newMeetingDoc = await ctx.db.get(meetingId);
await meetingsByStatus.replace(ctx, oldMeetingDoc, newMeetingDoc!);

// ~81: markNoShow — opportunity status change
const oldOppDoc = opportunity;
// ... existing patch ...
const newOppDoc = await ctx.db.get(opportunityId);
await opportunityByStatus.replace(ctx, oldOppDoc, newOppDoc!);

// ~217: createNoShowRescheduleLink — opportunity status change
const oldOppDoc2 = opportunity;
// ... existing patch ...
const newOppDoc2 = await ctx.db.get(opportunityId);
await opportunityByStatus.replace(ctx, oldOppDoc2, newOppDoc2!);
```

**Step 2: Hook `followUpMutations.ts` — 3 opportunity replaces**

```typescript
// Path: convex/closer/followUpMutations.ts
import { opportunityByStatus } from "../reporting/aggregates";

// ~84: transitionToFollowUp — opportunity status → follow_up_scheduled
const oldOppDoc = opportunity;
// ... existing patch ...
const newOppDoc = await ctx.db.get(opportunityId);
await opportunityByStatus.replace(ctx, oldOppDoc, newOppDoc!);

// ~268: scheduleFollowUpPublic — opportunity status change
// ~336: createManualReminderFollowUpPublic — opportunity status change
// Same pattern for each
```

**Step 3: Hook `payments.ts` — 1 payment insert + 1 opportunity replace**

```typescript
// Path: convex/closer/payments.ts
import { paymentSums, opportunityByStatus } from "../reporting/aggregates";

// ~146: logPayment — insert payment record
const paymentId = await ctx.db.insert("paymentRecords", { ... });
const paymentDoc = await ctx.db.get(paymentId);
await paymentSums.insert(ctx, paymentDoc!);

// ~165: logPayment — opportunity status → payment_received
const oldOppDoc = opportunity;
// ... existing patch ...
const newOppDoc = await ctx.db.get(opportunityId);
await opportunityByStatus.replace(ctx, oldOppDoc, newOppDoc!);
```

**Key implementation notes:**
- Total touch points in this subphase: 2 (meetingsByStatus) + 5 (opportunityByStatus) + 1 (paymentSums) = **8 hooks**.
- `followUpMutations.ts` has 3 public mutations — all modify opportunity status. Only `opportunityByStatus` is relevant.
- `payments.ts` is the only closer file that touches `paymentSums`. The `logPayment` mutation is the primary user-initiated payment recording flow.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/noShowActions.ts` | Modify | +4 aggregate hooks (2 meeting, 2 opportunity) |
| `convex/closer/followUpMutations.ts` | Modify | +3 aggregate hooks (opportunity replaces) |
| `convex/closer/payments.ts` | Modify | +2 aggregate hooks (1 payment insert, 1 opportunity replace) |

---

### 2D — Aggregate Hooks: Customers + Unavailability + Lib Sync

**Type:** Backend
**Parallelizable:** Yes — touches files in `convex/customers/`, `convex/unavailability/`, `convex/lib/`. No overlap with 2A-2C.

**What:** Add aggregate hooks to `customers/mutations.ts` (1 payment insert), `customers/conversion.ts` (1 customer insert), `unavailability/redistribution.ts` (5 hooks for meeting reassignment + cancellation), and `lib/syncOpportunityMeetingsAssignedCloser.ts` (1 bulk meeting replace loop).

**Why:** Customer conversion and payment recording are lower-frequency but high-value events — a missed hook means revenue and conversion counts drift. Redistribution hooks matter because meeting reassignment changes the `assignedCloserId` (which is in the `meetingsByStatus` sort key) and meeting cancellation changes status.

**Where:**
- `convex/customers/mutations.ts` (modify)
- `convex/customers/conversion.ts` (modify)
- `convex/unavailability/redistribution.ts` (modify)
- `convex/lib/syncOpportunityMeetingsAssignedCloser.ts` (modify)

**How:**

**Step 1: Hook `customers/mutations.ts` — 1 payment insert**

```typescript
// Path: convex/customers/mutations.ts
import { paymentSums } from "../reporting/aggregates";

// ~169: recordCustomerPayment — insert payment record
const paymentId = await ctx.db.insert("paymentRecords", { ... });
const paymentDoc = await ctx.db.get(paymentId);
await paymentSums.insert(ctx, paymentDoc!);
```

**Step 2: Hook `customers/conversion.ts` — 1 customer insert**

```typescript
// Path: convex/customers/conversion.ts
import { customerConversions } from "../reporting/aggregates";

// ~89: executeConversion — insert new customer
const customerId = await ctx.db.insert("customers", { ... });
const customerDoc = await ctx.db.get(customerId);
await customerConversions.insert(ctx, customerDoc!);
```

**Step 3: Hook `unavailability/redistribution.ts` — 5 hooks**

```typescript
// Path: convex/unavailability/redistribution.ts
import { meetingsByStatus, opportunityByStatus } from "../reporting/aggregates";

// ~405: manuallyResolveMeeting — meeting → canceled
const oldMeetingDoc = meeting;
await ctx.db.patch(meetingId, { status: "canceled", ... });
const newMeetingDoc = await ctx.db.get(meetingId);
await meetingsByStatus.replace(ctx, oldMeetingDoc, newMeetingDoc!);

// ~241: autoDistributeMeetings — meeting closerId reassignment
const oldMeetingDoc2 = meeting;
await ctx.db.patch(meetingId, { assignedCloserId: newCloserId, ... });
const newMeetingDoc2 = await ctx.db.get(meetingId);
await meetingsByStatus.replace(ctx, oldMeetingDoc2, newMeetingDoc2!);

// ~370: manuallyResolveMeeting — meeting closerId reassignment
// Same pattern

// ~232, ~361: opportunity reassignment (closerId changes)
const oldOppDoc = opportunity;
// ... patch ...
const newOppDoc = await ctx.db.get(opportunityId);
await opportunityByStatus.replace(ctx, oldOppDoc, newOppDoc!);
```

**Step 4: Hook `lib/syncOpportunityMeetingsAssignedCloser.ts` — bulk replace loop**

```typescript
// Path: convex/lib/syncOpportunityMeetingsAssignedCloser.ts
import { meetingsByStatus } from "../reporting/aggregates";

// ~18: This function loops over all meetings on an opportunity and syncs assignedCloserId.
// Inside the loop, for each meeting that changes:
for (const meeting of meetings) {
  if (meeting.assignedCloserId !== newCloserId) {
    const oldDoc = meeting;
    await ctx.db.patch(meeting._id, { assignedCloserId: newCloserId });
    const newDoc = await ctx.db.get(meeting._id);
    await meetingsByStatus.replace(ctx, oldDoc, newDoc!);
  }
}
```

**Key implementation notes:**
- Total touch points: 4 (meetingsByStatus) + 2 (opportunityByStatus) + 1 (paymentSums) + 1 (customerConversions) = **8 hooks**.
- `syncOpportunityMeetingsAssignedCloser` is a bulk operation — it replaces in a loop. At current scale (avg 2-3 meetings per opportunity), this is fine. At 10x, consider batching.
- `redistribution.ts` has 5 touch points — the most complex file in this subphase. Map each code path carefully.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/customers/mutations.ts` | Modify | +1 paymentSums insert hook |
| `convex/customers/conversion.ts` | Modify | +1 customerConversions insert hook |
| `convex/unavailability/redistribution.ts` | Modify | +5 aggregate hooks (3 meeting, 2 opportunity) |
| `convex/lib/syncOpportunityMeetingsAssignedCloser.ts` | Modify | +1 meetingsByStatus replace in loop |

---

### 2E — Form Response Pipeline Integration

**Type:** Backend
**Parallelizable:** Partially — touches `convex/lib/meetingFormResponseWriter.ts` (new, but see note) and `convex/pipeline/inviteeCreated.ts`. Must run BEFORE 2B (which also modifies `inviteeCreated.ts`), or be combined with 2B by the same developer.

**What:** Extract the shared `syncMeetingFormResponses` helper and wire it into the 3 meeting-insert code paths in `inviteeCreated.ts` so live bookings (not just backfilled ones) create `meetingFormResponses` rows.

**Why:** Without this, the Form Insights report on the Leads & Conversions page only shows historical (backfilled) data. New bookings would have no form response records, making the analytics stale.

**Where:**
- `convex/lib/meetingFormResponseWriter.ts` (new — or modify existing `convex/lib/meetingFormResponses.ts`)
- `convex/pipeline/inviteeCreated.ts` (modify)

**How:**

**Step 1: Check existing form response handling**

The codebase already has `convex/lib/meetingFormResponses.ts` with `writeMeetingFormResponses` and related helpers imported in `inviteeCreated.ts`. Check if the live pipeline already calls this function. If it does, this subphase may be a verification step rather than new code.

If the live pipeline does NOT call `writeMeetingFormResponses` at the 3 meeting-insert points:

**Step 2: Ensure shared helper exists**

```typescript
// Path: convex/lib/meetingFormResponseWriter.ts (or add to existing meetingFormResponses.ts)
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

interface FormResponseWriterParams {
  ctx: MutationCtx;
  tenantId: Id<"tenants">;
  meetingId: Id<"meetings">;
  opportunityId: Id<"opportunities">;
  leadId: Id<"leads">;
  eventTypeConfigId: Id<"eventTypeConfigs">;
  questionsAndAnswers: Array<{ question: string; answer: string }>;
  capturedAt: number;
}

export async function syncMeetingFormResponses(
  params: FormResponseWriterParams,
): Promise<void> {
  const {
    ctx, tenantId, meetingId, opportunityId, leadId,
    eventTypeConfigId, questionsAndAnswers, capturedAt,
  } = params;

  for (const qa of questionsAndAnswers) {
    const fieldKey = deriveFieldKey(qa.question);

    // Upsert eventTypeFieldCatalog
    const existing = await ctx.db
      .query("eventTypeFieldCatalog")
      .withIndex("by_tenantId_and_fieldKey", (q) =>
        q.eq("tenantId", tenantId).eq("fieldKey", fieldKey),
      )
      .first();

    let fieldCatalogId: Id<"eventTypeFieldCatalog">;
    if (existing) {
      await ctx.db.patch(existing._id, { lastSeenAt: capturedAt });
      fieldCatalogId = existing._id;
    } else {
      fieldCatalogId = await ctx.db.insert("eventTypeFieldCatalog", {
        tenantId,
        eventTypeConfigId,
        fieldKey,
        currentLabel: qa.question,
        firstSeenAt: capturedAt,
        lastSeenAt: capturedAt,
      });
    }

    await ctx.db.insert("meetingFormResponses", {
      tenantId,
      meetingId,
      opportunityId,
      leadId,
      eventTypeConfigId,
      fieldCatalogId,
      fieldKey,
      questionLabelSnapshot: qa.question,
      answerText: qa.answer,
      capturedAt,
    });
  }
}

function deriveFieldKey(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}
```

**Step 3: Wire into pipeline at 3 meeting-insert points**

```typescript
// Path: convex/pipeline/inviteeCreated.ts — at each meeting insert point (~1169, ~1421, ~1623)
// After: const meetingId = await ctx.db.insert("meetings", { ... });

const questionsAndAnswers = extractQuestionsAndAnswers(rawEvent);
if (questionsAndAnswers.length > 0) {
  await syncMeetingFormResponses({
    ctx,
    tenantId,
    meetingId,
    opportunityId,
    leadId,
    eventTypeConfigId: effectiveConfigId,
    questionsAndAnswers,
    capturedAt: now,
  });
}
```

**Key implementation notes:**
- Check if `writeMeetingFormResponses` already exists and is called. If so, this subphase is a verification step. The design says "the live pipeline does NOT yet insert during new bookings" but the codebase exploration shows the import already exists.
- The `deriveFieldKey` function must produce stable keys — same question text always → same key. Lowercase + alphanumeric only.
- `extractQuestionsAndAnswers` already exists in the pipeline code — reuse it.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/meetingFormResponseWriter.ts` | Create (or verify existing) | Shared form response writer |
| `convex/pipeline/inviteeCreated.ts` | Modify | Wire form response writer at 3 meeting-insert points |

---

### 2F — Frontend: End Meeting Button + Late Start Dialog

**Type:** Frontend
**Parallelizable:** No — depends on 2A (stopMeeting and setLateStartReason mutations must exist).

**What:** Add "End Meeting" button to meeting detail page (shown when `status === "in_progress"`). Add non-blocking late-start dialog that appears after `startMeeting` when `lateStartDurationMs > 0`.

**Why:** Without the "End Meeting" button, meetings have no explicit end event. The late-start dialog captures schedule adherence data that feeds Tier 3 reporting KPIs.

**Where:**
- `app/workspace/closer/meetings/[id]/_components/meeting-action-buttons.tsx` (modify)
- `app/workspace/closer/meetings/[id]/_components/late-start-dialog.tsx` (new)

**How:**

**Step 1: Add End Meeting button**

```tsx
// Path: app/workspace/closer/meetings/[id]/_components/meeting-action-buttons.tsx
"use client";

import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useState } from "react";
import type { Id } from "@/convex/_generated/dataModel";

function EndMeetingButton({ meetingId }: { meetingId: Id<"meetings"> }) {
  const stopMeeting = useMutation(api.closer.meetingActions.stopMeeting);
  const [isPending, setIsPending] = useState(false);

  const handleEndMeeting = async () => {
    setIsPending(true);
    try {
      const result = await stopMeeting({ meetingId });
      if (result.wasOverran) {
        const mins = Math.round(result.overranDurationMs / 60000);
        toast.warning(`Meeting ran ${mins} min over scheduled time`);
      } else {
        toast.success("Meeting completed");
      }
    } catch (err) {
      toast.error("Failed to end meeting");
    } finally {
      setIsPending(false);
    }
  };

  return (
    <Button variant="outline" onClick={handleEndMeeting} disabled={isPending}>
      End Meeting
    </Button>
  );
}
```

This button should be rendered conditionally: `{meeting.status === "in_progress" && <EndMeetingButton meetingId={meeting._id} />}`.

**Step 2: Add Late Start Dialog**

```tsx
// Path: app/workspace/closer/meetings/[id]/_components/late-start-dialog.tsx
"use client";

import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Id } from "@/convex/_generated/dataModel";

const lateStartSchema = z.object({
  reason: z.string().min(1, "Please provide a reason").max(500),
});

export function LateStartDialog({
  open,
  onOpenChange,
  meetingId,
  lateMinutes,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: Id<"meetings">;
  lateMinutes: number;
}) {
  const setReason = useMutation(api.closer.meetingActions.setLateStartReason);
  const form = useForm({
    resolver: standardSchemaResolver(lateStartSchema),
    defaultValues: { reason: "" },
  });

  const onSubmit = async (values: z.infer<typeof lateStartSchema>) => {
    await setReason({ meetingId, reason: values.reason });
    onOpenChange(false);
    toast.success("Late start reason recorded");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Meeting started {lateMinutes} min late</DialogTitle>
          <DialogDescription>
            Would you like to add a reason? This helps with schedule tracking.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      placeholder="e.g., Previous meeting ran over"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter className="mt-4">
              <Button variant="ghost" type="button" onClick={() => onOpenChange(false)}>
                Skip
              </Button>
              <Button type="submit">Save Reason</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
```

**Step 3: Wire into existing meeting detail page**

In the existing meeting detail page client component, modify the `startMeeting` handler to capture the response and show the dialog:

```tsx
// In the existing start meeting handler:
const result = await startMeeting({ meetingId });
if (result.lateStartDurationMs > 0) {
  setLateStartOpen(true);
  setLateMinutes(Math.round(result.lateStartDurationMs / 60000));
}
```

**Key implementation notes:**
- The late-start dialog is NON-BLOCKING — it appears after the meeting URL is already opened. Clicking "Skip" dismisses it without saving.
- The dialog uses the standard RHF + Zod + `standardSchemaResolver` pattern (see AGENTS.md Form Patterns section).
- The "End Meeting" button replaces itself with a "Meeting Completed" state indicator after the mutation succeeds.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/[id]/_components/meeting-action-buttons.tsx` | Modify | Add EndMeetingButton, wire late-start dialog trigger |
| `app/workspace/closer/meetings/[id]/_components/late-start-dialog.tsx` | Create | Non-blocking late-start reason dialog |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/closer/meetingActions.ts` | Modify | 2A |
| `convex/pipeline/inviteeCreated.ts` | Modify | 2B, 2E |
| `convex/pipeline/inviteeCanceled.ts` | Modify | 2B |
| `convex/pipeline/inviteeNoShow.ts` | Modify | 2B |
| `convex/closer/noShowActions.ts` | Modify | 2C |
| `convex/closer/followUpMutations.ts` | Modify | 2C |
| `convex/closer/payments.ts` | Modify | 2C |
| `convex/customers/mutations.ts` | Modify | 2D |
| `convex/customers/conversion.ts` | Modify | 2D |
| `convex/unavailability/redistribution.ts` | Modify | 2D |
| `convex/lib/syncOpportunityMeetingsAssignedCloser.ts` | Modify | 2D |
| `convex/lib/meetingFormResponseWriter.ts` | Create (or verify) | 2E |
| `app/workspace/closer/meetings/[id]/_components/meeting-action-buttons.tsx` | Modify | 2F |
| `app/workspace/closer/meetings/[id]/_components/late-start-dialog.tsx` | Create | 2F |
