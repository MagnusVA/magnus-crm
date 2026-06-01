# Phase 3 — Backend: Closer Context Submission

**Goal:** Enable closers to provide context on flagged meetings ("I forgot to press start" or "I didn't attend") and schedule follow-ups on flagged meetings. After this phase, closers can respond to system-created reviews and take the only self-service action available to them (scheduling a follow-up). The meeting detail query is also enriched with review data for frontend consumption.

**Prerequisite:** Phase 2 complete (`checkMeetingAttendance` deployed and functional, `convex/closer/meetingOverrun.ts` created).

**Runs in PARALLEL with:** Phase 4 (Admin Review Resolution) — Phase 3 adds to `convex/closer/meetingOverrun.ts` (closer mutations) while Phase 4 refactors `convex/reviews/queries.ts` and `convex/reviews/mutations.ts` (admin operations). Zero shared files.

> **Critical path:** Phase 3 is on the critical path for the frontend closer experience (Phase 5 depends on these mutations).

**Skills to invoke:**
- None — pure Convex backend work. Refer to `convex/_generated/ai/guidelines.md`.

**Acceptance Criteria:**
1. `respondToOverranReview({ reviewId, closerResponse: "forgot_to_press", closerNote, closerStatedOutcome, estimatedMeetingDurationMinutes })` updates the review with the closer's context, sets `closerRespondedAt`, and emits a domain event.
2. `respondToOverranReview({ reviewId, closerResponse: "did_not_attend", closerNote })` updates the review with just the note and response type (no stated outcome or duration).
3. `respondToOverranReview` rejects if: (a) review not found, (b) not the closer's review, (c) review already resolved, (d) closer already responded, (e) note is empty, (f) "forgot_to_press" without stated outcome or duration, (g) duration < 1 or > 480.
4. `scheduleFollowUpFromOverran({ opportunityId, note })` transitions the opportunity from `meeting_overran` → `follow_up_scheduled`, creates a `followUps` record, and emits a domain event.
5. `scheduleFollowUpFromOverran` rejects if: (a) opportunity not found, (b) not the closer's opportunity, (c) opportunity not in `meeting_overran` status, (d) note is empty.
6. `getMeetingDetail` returns `meetingReview` data when the meeting has a `reviewId`.
7. All mutations enforce `requireTenantUser(ctx, ["closer"])` — only closers can respond or schedule follow-ups.
8. Domain events include the `reviewId`, `closerResponse`, and `closerStatedOutcome` in metadata.
9. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (respondToOverranReview mutation) ─────────────────────┐
                                                           │
3B (scheduleFollowUpFromOverran mutation) ────────────────┤  (all independent)
                                                           │
3C (Meeting detail query enrichment) ─────────────────────┘
```

**Optimal execution:**
1. Start 3A, 3B, and 3C all in parallel:
   - 3A and 3B both add to `convex/closer/meetingOverrun.ts` — if done by the same developer, write them sequentially in the same file. If by different developers, one commits first.
   - 3C modifies `convex/closer/meetingDetail.ts` — completely independent.

**Estimated time:** 0.5–1 day

---

## Subphases

### 3A — Closer Context Response: `respondToOverranReview`

**Type:** Backend
**Parallelizable:** Yes — adds a new exported mutation to `convex/closer/meetingOverrun.ts`. Can run in parallel with 3C.

**What:** Create the `respondToOverranReview` public mutation that allows a closer to provide context on a flagged meeting. This mutation UPDATES the existing review (created by the scheduler in Phase 2) — it does not create a new one.

**Why:** After the system flags a meeting, the closer needs a way to explain what happened: either "I forgot to press start" (I actually attended) or "I didn't attend" (confirming the system's detection). This context is critical for the admin to make an informed resolution decision. Without this mutation, the admin has no closer input.

**Where:**
- `convex/closer/meetingOverrun.ts` (modify — add export)

**How:**

**Step 1: Add validators at the top of the file**

```typescript
// Path: convex/closer/meetingOverrun.ts — add after imports

import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

const closerResponseValidator = v.union(
  v.literal("forgot_to_press"),
  v.literal("did_not_attend"),
);

const closerStatedOutcomeValidator = v.union(
  v.literal("sale_made"),
  v.literal("follow_up_needed"),
  v.literal("lead_not_interested"),
  v.literal("lead_no_show"),
  v.literal("other"),
);
```

**Step 2: Add the `respondToOverranReview` mutation**

```typescript
// Path: convex/closer/meetingOverrun.ts — add after checkMeetingAttendance

/**
 * Closer provides context on a flagged meeting.
 * Updates the existing review record (created by the scheduler).
 *
 * Two responses:
 * - "forgot_to_press": Closer claims they actually attended. Requires stated outcome + estimated duration.
 * - "did_not_attend": Closer confirms non-attendance. Requires only a note.
 */
export const respondToOverranReview = mutation({
  args: {
    reviewId: v.id("meetingReviews"),
    closerResponse: closerResponseValidator,
    closerNote: v.string(),
    closerStatedOutcome: v.optional(closerStatedOutcomeValidator),
    estimatedMeetingDurationMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const {
      reviewId,
      closerResponse,
      closerNote,
      closerStatedOutcome,
      estimatedMeetingDurationMinutes,
    } = args;
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    // ── Load and validate review ──────────────────────────────────────
    const review = await ctx.db.get(reviewId);
    if (!review || review.tenantId !== tenantId) {
      throw new Error("Review not found");
    }
    if (review.closerId !== userId) {
      throw new Error("Not your review");
    }
    if (review.status === "resolved") {
      throw new Error("Review already resolved");
    }
    if (review.closerResponse) {
      throw new Error("You have already responded to this review");
    }

    // ── Validate note ─────────────────────────────────────────────────
    const trimmedNote = closerNote.trim();
    if (!trimmedNote) {
      throw new Error("A note describing what happened is required");
    }

    // ── Validate "forgot_to_press" specific fields ────────────────────
    if (closerResponse === "forgot_to_press") {
      if (!closerStatedOutcome) {
        throw new Error(
          "Stated outcome is required when claiming you forgot to press start",
        );
      }
      if (
        !estimatedMeetingDurationMinutes ||
        estimatedMeetingDurationMinutes < 1 ||
        estimatedMeetingDurationMinutes > 480
      ) {
        throw new Error(
          "Estimated meeting duration must be between 1 and 480 minutes",
        );
      }
    }

    const now = Date.now();

    // ── Update review with closer's context ───────────────────────────
    await ctx.db.patch(reviewId, {
      closerResponse,
      closerNote: trimmedNote,
      closerStatedOutcome:
        closerResponse === "forgot_to_press" ? closerStatedOutcome : undefined,
      estimatedMeetingDurationMinutes:
        closerResponse === "forgot_to_press"
          ? estimatedMeetingDurationMinutes
          : undefined,
      closerRespondedAt: now,
    });

    // ── Domain event ──────────────────────────────────────────────────
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "meeting",
      entityId: review.meetingId,
      eventType: "meeting.overran_closer_responded",
      source: "closer",
      actorUserId: userId,
      occurredAt: now,
      metadata: {
        reviewId,
        closerResponse,
        closerStatedOutcome,
      },
    });

    console.log("[MeetingOverrun] closer responded", {
      reviewId,
      closerResponse,
    });

    return { success: true };
  },
});
```

**Key implementation notes:**
- The mutation UPDATES the existing review — it does not create a new one. `review.createdAt` is when the system detected non-attendance; `review.closerRespondedAt` is when the closer acknowledged it. This preserves the full audit trail.
- `closerStatedOutcome` and `estimatedMeetingDurationMinutes` are only stored for `"forgot_to_press"` responses. For `"did_not_attend"`, these fields are explicitly set to `undefined` (not omitted) to prevent stale data if the closer somehow calls the mutation twice (guarded by the `review.closerResponse` check, but defense-in-depth).
- The `review.closerResponse` idempotency guard prevents double-submission. The frontend should also disable the submit button after first call, but the backend is authoritative.
- Duration cap of 480 minutes (8 hours) is a sanity check — no legitimate meeting lasts longer than 8 hours.
- The mutation does NOT change meeting or opportunity status. Only the admin can do that (Phase 4). The closer is just providing context.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/meetingOverrun.ts` | Modify | Add `respondToOverranReview` mutation + validators |

---

### 3B — Closer Follow-Up: `scheduleFollowUpFromOverran`

**Type:** Backend
**Parallelizable:** Yes — adds to `convex/closer/meetingOverrun.ts`. Can run in parallel with 3C. Coordinate with 3A if both modify the same file.

**What:** Create the `scheduleFollowUpFromOverran` public mutation that allows a closer to schedule a follow-up on a flagged meeting. This is the closer's ONLY self-service outcome action on `meeting_overran` opportunities.

**Why:** The most likely next step after a missed meeting is to reach out to the lead and reschedule. The closer shouldn't have to wait for the admin to do this — it's time-sensitive. However, all other outcome actions (payment, no-show, lost) require admin resolution because they have compliance implications.

**Where:**
- `convex/closer/meetingOverrun.ts` (modify — add export)

**How:**

**Step 1: Add imports for follow-up and stats**

```typescript
// Path: convex/closer/meetingOverrun.ts — add to imports (if not already present)
import { validateTransition } from "../lib/statusTransitions";
import {
  isActiveOpportunityStatus,
  updateTenantStats,
} from "../lib/tenantStatsHelper";
```

**Step 2: Add the `scheduleFollowUpFromOverran` mutation**

```typescript
// Path: convex/closer/meetingOverrun.ts — add after respondToOverranReview

/**
 * Closer schedules a follow-up on a flagged meeting.
 * This is the ONLY self-service outcome action available to closers on
 * meeting_overran opportunities. All other outcomes require admin resolution.
 *
 * Transitions: opportunity meeting_overran → follow_up_scheduled
 * Side effect: creates a followUps record for the admin to see
 */
export const scheduleFollowUpFromOverran = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    note: v.string(),
  },
  handler: async (ctx, { opportunityId, note }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const trimmedNote = note.trim();
    if (!trimmedNote) {
      throw new Error("A note describing the follow-up plan is required");
    }

    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }
    if (opportunity.assignedCloserId !== userId) {
      throw new Error("Not your opportunity");
    }
    if (opportunity.status !== "meeting_overran") {
      throw new Error(
        `Expected status "meeting_overran", got "${opportunity.status}"`,
      );
    }

    if (!validateTransition("meeting_overran", "follow_up_scheduled")) {
      throw new Error(
        "Invalid transition: meeting_overran → follow_up_scheduled",
      );
    }

    const now = Date.now();

    // ── Transition opportunity ────────────────────────────────────────
    const oldOpportunity = opportunity;
    await ctx.db.patch(opportunityId, {
      status: "follow_up_scheduled",
      updatedAt: now,
    });
    await replaceOpportunityAggregate(ctx, oldOpportunity, opportunityId);

    // ── Create follow-up record ───────────────────────────────────────
    // The admin needs to see what the closer planned, even when reviewing later.
    await ctx.db.insert("followUps", {
      tenantId,
      opportunityId,
      leadId: opportunity.leadId,
      closerId: userId,
      createdByUserId: userId,
      note: trimmedNote,
      contactMethod: "other",
      status: "pending",
      createdAt: now,
    });

    // ── Tenant stats ──────────────────────────────────────────────────
    // meeting_overran and follow_up_scheduled are both active — no delta needed.
    // But maintain consistency by checking:
    const fromActive = isActiveOpportunityStatus("meeting_overran");
    const toActive = isActiveOpportunityStatus("follow_up_scheduled");
    if (fromActive !== toActive) {
      await updateTenantStats(ctx, tenantId, {
        activeOpportunities: toActive ? 1 : -1,
      });
    }

    // ── Domain event ──────────────────────────────────────────────────
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: opportunityId,
      eventType: "opportunity.status_changed",
      source: "closer",
      actorUserId: userId,
      fromStatus: "meeting_overran",
      toStatus: "follow_up_scheduled",
      occurredAt: now,
      metadata: { reason: "follow_up_after_overran" },
    });

    console.log("[MeetingOverrun] follow-up scheduled", { opportunityId });

    return { success: true };
  },
});
```

**Key implementation notes:**
- The `followUps` table insert requires `leadId` and `closerId` fields. These are derived from the opportunity (`opportunity.leadId`) and the authenticated user (`userId`). Check the `followUps` table schema in `convex/schema.ts` to confirm all required fields — some fields like `schedulingLinkUrl` may be required. If so, use appropriate defaults or make the insert conditional.
- Both `meeting_overran` and `follow_up_scheduled` are in the `ACTIVE_OPPORTUNITY_STATUSES` set, so the tenant stats delta is 0. The explicit check is defense-in-depth.
- `replaceOpportunityAggregate` must be called with the OLD opportunity document before the patch.
- The mutation uses `validateTransition()` as an additional safety check. This should always pass since we defined `meeting_overran → follow_up_scheduled` in Phase 1, but calling it prevents bugs if the transition map is modified later.
- The follow-up `contactMethod` is set to `"other"` since this is a general follow-up plan, not a specific scheduling link or phone call.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/meetingOverrun.ts` | Modify | Add `scheduleFollowUpFromOverran` mutation |

---

### 3C — Meeting Detail Query Enrichment

**Type:** Backend
**Parallelizable:** Yes — modifies `convex/closer/meetingDetail.ts`. No overlap with 3A or 3B.

**What:** Enrich the `getMeetingDetail` query to include the `meetingReview` document when the meeting has a `reviewId`. Remove evidence URL fetching from the existing query (evidence upload is removed in the new design).

**Why:** The frontend meeting detail page needs the review data to render the "Meeting Overran" banner with the closer's response, stated outcome, and review status. Without this enrichment, the frontend has no way to know about the review or display the appropriate UI.

**Where:**
- `convex/closer/meetingDetail.ts` (modify)

**How:**

**Step 1: Simplify the review data loading**

The existing `getMeetingDetail` query already loads review data and evidence URLs. Replace the evidence URL logic with a simplified review load:

```typescript
// Path: convex/closer/meetingDetail.ts — inside getMeetingDetail handler

// BEFORE (existing WIP code):
let review = null;
let evidenceUrl = null;
let paymentEvidenceUrl = null;
let evidenceFileMeta = null;
if (meeting.reviewId) {
  review = await ctx.db.get(meeting.reviewId);
  if (review?.evidenceFileId) {
    evidenceUrl = await ctx.storage.getUrl(review.evidenceFileId);
    const meta = await ctx.db.system.get(review.evidenceFileId);
    evidenceFileMeta = meta ? { contentType: meta.contentType, size: meta.size } : null;
  }
  if (review?.paymentEvidenceFileId) {
    paymentEvidenceUrl = await ctx.storage.getUrl(review.paymentEvidenceFileId);
  }
}

// AFTER (v3.0 — simplified, no evidence):
let meetingReview = null;
if (meeting.reviewId) {
  meetingReview = await ctx.db.get(meeting.reviewId);
}
```

**Step 2: Update the return object**

```typescript
// Path: convex/closer/meetingDetail.ts — update return

// BEFORE:
return {
  review,
  evidenceUrl,
  paymentEvidenceUrl,
  evidenceFileMeta,
  // ... other fields
};

// AFTER:
return {
  meetingReview,  // Full review document (or null if no review)
  // ... other existing fields (meeting, opportunity, lead, closer, etc.)
  // REMOVE: evidenceUrl, paymentEvidenceUrl, evidenceFileMeta
};
```

**Step 3: Also update the admin meeting detail if it exists**

Check `convex/admin/meetingActions.ts` or similar admin queries that return meeting detail — apply the same simplification.

**Key implementation notes:**
- The return field is renamed from `review` to `meetingReview` for clarity — it's the `meetingReviews` table document, not a generic "review" concept.
- The full review document is returned (not a subset) because the frontend needs: `closerResponse`, `closerNote`, `closerStatedOutcome`, `estimatedMeetingDurationMinutes`, `closerRespondedAt`, `status`, `createdAt`, `resolvedAt`, `resolutionAction`, `resolutionNote`.
- Evidence-related fields (`evidenceUrl`, `paymentEvidenceUrl`, `evidenceFileMeta`) are removed from the return since evidence upload is dropped from the design.
- If the `getMeetingDetail` query is also used by admin pages (through a shared query or a separate admin variant), ensure both are updated consistently.
- The `meeting.reviewId` field may be `undefined` for meetings created before this feature — the `if` guard handles this gracefully.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/meetingDetail.ts` | Modify | Replace evidence URL loading with simplified review enrichment; rename return field to `meetingReview` |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/closer/meetingOverrun.ts` | Modify | 3A, 3B |
| `convex/closer/meetingDetail.ts` | Modify | 3C |
