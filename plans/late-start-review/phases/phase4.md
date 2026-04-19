# Phase 4 — Backend: Admin Review Resolution

**Goal:** Provide admins with a complete backend for viewing and resolving meeting reviews. After this phase, admins can list pending/resolved reviews with enriched data, view individual review details with full context, get a count of pending reviews (for the sidebar badge), and resolve reviews with specific outcomes (log payment, schedule follow-up, mark no-show, mark lost, acknowledge). The resolution correctly handles false-positive corrections, opportunity status transitions, meeting status updates, tenant stats, and domain events.

**Prerequisite:** Phase 1 complete (schema deployed). Phase 2 complete (reviews are being created by the scheduler). Phase 3 is NOT required — admin resolution works independently of whether the closer has responded.

**Runs in PARALLEL with:** Phase 3 (Closer Context Submission). Phase 3 touches `convex/closer/meetingOverrun.ts` and `convex/closer/meetingDetail.ts`. Phase 4 touches `convex/reviews/queries.ts` and `convex/reviews/mutations.ts`. Zero shared files.

**Skills to invoke:**
- None — pure Convex backend work. Refer to `convex/_generated/ai/guidelines.md`.

**Acceptance Criteria:**
1. `listPendingReviews({ statusFilter: "pending" })` returns up to 50 reviews enriched with meeting time, lead name/email, closer name, and current opportunity status. Results are ordered by `createdAt` descending (newest first).
2. `listPendingReviews({ statusFilter: "resolved" })` returns resolved reviews with the same enrichment.
3. `listPendingReviews()` with no filter defaults to `"pending"`.
4. `getReviewDetail({ reviewId })` returns the full review document plus meeting, opportunity, lead, closer name/email, and resolver name (if resolved).
5. `getPendingReviewCount()` returns `{ count: N }` where N is the number of pending reviews (capped at 100 via `.take(100).length`).
6. `resolveReview({ reviewId, resolutionAction: "log_payment", paymentData: {...} })` marks the review resolved, transitions the opportunity to `payment_received`, creates a payment record via `createPaymentRecord`, and if `closerResponse === "forgot_to_press"`, transitions the meeting to `completed`.
7. `resolveReview({ reviewId, resolutionAction: "schedule_follow_up" })` marks the review resolved, transitions the opportunity to `follow_up_scheduled`, creates a manual reminder via `createManualReminder`, and if `closerResponse === "forgot_to_press"`, transitions the meeting to `completed`.
8. `resolveReview({ reviewId, resolutionAction: "mark_no_show" })` marks the review resolved, transitions the opportunity to `no_show`. Meeting transitions to `completed` only if `closerResponse === "forgot_to_press"`.
9. `resolveReview({ reviewId, resolutionAction: "mark_lost" })` marks the review resolved, transitions the opportunity to `lost`. Meeting transitions to `completed` only if `closerResponse === "forgot_to_press"`.
10. `resolveReview({ reviewId, resolutionAction: "acknowledged" })` marks the review resolved with NO opportunity or meeting status changes.
11. When the opportunity has already moved on (e.g., closer scheduled a follow-up, `opportunity.status !== "meeting_overran"`), `resolveReview` skips the opportunity transition but still resolves the review.
12. `resolveReview` rejects if: (a) review not found, (b) review already resolved, (c) `log_payment` without `paymentData`.
13. All queries/mutations enforce `requireTenantUser(ctx, ["tenant_master", "tenant_admin"])`.
14. Domain events are emitted for every resolution with `resolutionAction` and `closerResponse` in metadata.
15. Tenant stats are updated correctly (active opportunity count, lost deals count).
16. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (listPendingReviews query) ────────────────────────────────────────┐
                                                                       │
4B (getReviewDetail query) ───────────────────────────────────────────┤  (all independent)
                                                                       │
4C (getPendingReviewCount query) ─────────────────────────────────────┤
                                                                       │
4D (resolveReview mutation) ──────────────────────────────────────────┘
```

**Optimal execution:**
1. Start 4A, 4B, 4C, and 4D all in parallel — they are all separate functions in the same two files (`convex/reviews/queries.ts` for 4A-4C, `convex/reviews/mutations.ts` for 4D). If a single developer is working on both files, do queries first (4A-4C), then mutation (4D). No cross-file dependencies.

**Estimated time:** 1 day

---

## Subphases

### 4A — Refactor `listPendingReviews` Query

**Type:** Backend
**Parallelizable:** Yes — modifies `convex/reviews/queries.ts`. Independent of 4D.

**What:** Refactor the existing `listPendingReviews` query to remove the `evidence_uploaded` status handling and evidence URL fetching. Simplify the enrichment to match the new review schema.

**Why:** The WIP query handles two statuses (`"pending"` and `"evidence_uploaded"`), merging results from two separate index queries using a Map. The new schema only has two statuses (`"pending"` and `"resolved"`), and the query is the data source for the admin review list page.

**Where:**
- `convex/reviews/queries.ts` (modify)

**How:**

**Step 1: Replace the listPendingReviews implementation**

The existing implementation queries for both `"pending"` and `"evidence_uploaded"` statuses using two separate index queries, merges them with a Map, and sorts. Replace with a single query:

```typescript
// Path: convex/reviews/queries.ts

export const listPendingReviews = query({
  args: {
    statusFilter: v.optional(
      v.union(v.literal("pending"), v.literal("resolved")),
    ),
  },
  handler: async (ctx, { statusFilter }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const targetStatus = statusFilter ?? "pending";

    const reviews = await ctx.db
      .query("meetingReviews")
      .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", targetStatus),
      )
      .order("desc")
      .take(50);

    // ── Enrich with related data ──────────────────────────────────────
    const enriched = await Promise.all(
      reviews.map(async (review) => {
        const [meeting, closer] = await Promise.all([
          ctx.db.get(review.meetingId),
          ctx.db.get(review.closerId),
        ]);
        const opportunity = meeting
          ? await ctx.db.get(meeting.opportunityId)
          : null;
        const lead = opportunity
          ? await ctx.db.get(opportunity.leadId)
          : null;

        return {
          ...review,
          meetingScheduledAt: meeting?.scheduledAt,
          meetingDurationMinutes: meeting?.durationMinutes,
          leadName: lead?.fullName ?? lead?.email ?? "Unknown",
          leadEmail: lead?.email,
          closerName: closer?.fullName ?? closer?.email ?? "Unknown",
          opportunityStatus: opportunity?.status,
        };
      }),
    );

    return enriched;
  },
});
```

**Key implementation notes:**
- The old query used a Map-based merge of two index queries (pending + evidence_uploaded). The new query is a single indexed query — much simpler and more efficient.
- Results are ordered by `createdAt` descending (newest flagged meetings first) via `.order("desc")` on the index which includes `createdAt` as the last field.
- The enrichment fetches meeting → opportunity → lead in sequence (not parallelizable since each depends on the previous). The closer is fetched in parallel with the meeting.
- `.take(50)` bounds the result set. The admin review pipeline doesn't need pagination for MVP (see non-goals: no bulk resolution).
- The enriched result includes `opportunityStatus` so the admin can see if the closer already acted (e.g., `follow_up_scheduled`).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reviews/queries.ts` | Modify | Replace listPendingReviews with simplified single-query implementation |

---

### 4B — Refactor `getReviewDetail` Query

**Type:** Backend
**Parallelizable:** Yes — modifies `convex/reviews/queries.ts`. Coordinate with 4A (same file).

**What:** Refactor the existing `getReviewDetail` query to remove evidence URL fetching and simplify the return shape.

**Why:** The admin review detail page needs the full review context: system detection info, closer response, meeting details, lead info, and resolver info. The evidence fields are removed from the design, so the URL fetching code must go.

**Where:**
- `convex/reviews/queries.ts` (modify)

**How:**

**Step 1: Replace the getReviewDetail implementation**

```typescript
// Path: convex/reviews/queries.ts

export const getReviewDetail = query({
  args: { reviewId: v.id("meetingReviews") },
  handler: async (ctx, { reviewId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const review = await ctx.db.get(reviewId);
    if (!review || review.tenantId !== tenantId) return null;

    const [meeting, closer, resolver] = await Promise.all([
      ctx.db.get(review.meetingId),
      ctx.db.get(review.closerId),
      review.resolvedByUserId
        ? ctx.db.get(review.resolvedByUserId)
        : null,
    ]);
    if (!meeting) return null;

    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (!opportunity) return null;

    const lead = await ctx.db.get(opportunity.leadId);

    return {
      review,
      meeting,
      opportunity,
      lead,
      closerName: closer?.fullName ?? closer?.email ?? "Unknown",
      closerEmail: closer?.email ?? "Unknown",
      resolverName: resolver?.fullName ?? resolver?.email ?? null,
    };
  },
});
```

**Key implementation notes:**
- The return includes the full `review`, `meeting`, `opportunity`, and `lead` documents. The frontend can extract whatever fields it needs.
- `closerName` and `closerEmail` are denormalized for display convenience — the frontend shouldn't have to do another query for the closer's name.
- `resolverName` is null when the review hasn't been resolved yet.
- Returns `null` if the review, meeting, or opportunity doesn't exist — the frontend handles this as a "not found" state.
- The REMOVED evidence fields (`evidenceUrl`, `paymentEvidenceUrl`, `evidenceFileMeta`) are no longer fetched or returned.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reviews/queries.ts` | Modify | Replace getReviewDetail with simplified implementation |

---

### 4C — New `getPendingReviewCount` Query

**Type:** Backend
**Parallelizable:** Yes — adds a new export to `convex/reviews/queries.ts`. Coordinate with 4A and 4B (same file).

**What:** Create a new `getPendingReviewCount` query that returns the count of pending reviews for the tenant. This powers the sidebar badge in the admin navigation.

**Why:** The admin sidebar needs a reactive count of pending reviews to display as a badge on the "Reviews" nav item. Without this query, the badge can't show the count. The query uses `.take(100).length` instead of counting all documents — this is bounded and efficient.

**Where:**
- `convex/reviews/queries.ts` (modify — add export)

**How:**

**Step 1: Add the `getPendingReviewCount` query**

```typescript
// Path: convex/reviews/queries.ts — add after getReviewDetail

/**
 * Returns the count of pending reviews for the tenant.
 * Used by the admin sidebar badge. Capped at 100 to bound the query.
 */
export const getPendingReviewCount = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const pending = await ctx.db
      .query("meetingReviews")
      .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", "pending"),
      )
      .take(100);

    return { count: pending.length };
  },
});
```

**Key implementation notes:**
- `.take(100)` bounds the query. The frontend displays "99+" when count >= 100 — we never need to know the exact count above 99.
- This query is used as a real-time subscription (`useQuery`) in the admin sidebar, so it must be lightweight. The index `by_tenantId_and_status_and_createdAt` with `eq("status", "pending")` efficiently filters to only pending reviews.
- The query only fires for admin roles — the nav item itself is admin-only, and the `requireTenantUser` guard enforces this.
- Returns `{ count: N }` (object, not bare number) for consistency with the codebase pattern and to allow future extension (e.g., adding `hasUrgent: boolean`).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reviews/queries.ts` | Modify | Add `getPendingReviewCount` query |

---

### 4D — Refactor `resolveReview` Mutation

**Type:** Backend
**Parallelizable:** Yes — modifies `convex/reviews/mutations.ts`. No overlap with queries file.

**What:** Refactor the existing `resolveReview` mutation to remove evidence validation, replace `evidence_not_uploaded` with `acknowledged`, add opportunity status drift handling, implement false-positive meeting correction, and maintain tenant stats and domain events.

**Why:** This is the admin's primary action for processing flagged meetings. The mutation must handle 5 resolution actions, correctly transition opportunities and meetings, create payment records and follow-up reminders, and maintain data consistency — all within a single atomic transaction. Without it, flagged meetings are stuck in `meeting_overran` forever.

**Where:**
- `convex/reviews/mutations.ts` (modify)

**How:**

**Step 1: Update imports**

```typescript
// Path: convex/reviews/mutations.ts — update imports

import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { emitDomainEvent } from "../lib/domainEvents";
import { validateTransition } from "../lib/statusTransitions";
import {
  isActiveOpportunityStatus,
  updateTenantStats,
} from "../lib/tenantStatsHelper";
import {
  replaceMeetingAggregate,
  replaceOpportunityAggregate,
} from "../reporting/writeHooks";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";
import { createPaymentRecord, createManualReminder } from "../lib/outcomeHelpers";
```

**Step 2: Replace the `resolveReview` mutation**

```typescript
// Path: convex/reviews/mutations.ts

export const resolveReview = mutation({
  args: {
    reviewId: v.id("meetingReviews"),
    resolutionAction: v.union(
      v.literal("log_payment"),
      v.literal("schedule_follow_up"),
      v.literal("mark_no_show"),
      v.literal("mark_lost"),
      v.literal("acknowledged"),
    ),
    resolutionNote: v.optional(v.string()),
    paymentData: v.optional(
      v.object({
        amount: v.number(),
        currency: v.string(),
        provider: v.string(),
        referenceCode: v.optional(v.string()),
        proofFileId: v.optional(v.id("_storage")),
      }),
    ),
    lostReason: v.optional(v.string()),
    noShowReason: v.optional(
      v.union(
        v.literal("no_response"),
        v.literal("late_cancel"),
        v.literal("technical_issues"),
        v.literal("other"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const { userId, tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const review = await ctx.db.get(args.reviewId);
    if (!review || review.tenantId !== tenantId) {
      throw new Error("Review not found");
    }
    if (review.status === "resolved") {
      throw new Error("Review already resolved");
    }

    const meeting = await ctx.db.get(review.meetingId);
    if (!meeting) throw new Error("Meeting not found");
    const opportunity = await ctx.db.get(review.opportunityId);
    if (!opportunity) throw new Error("Opportunity not found");

    const now = Date.now();

    // ── Validate required fields per action ─────────────────────────
    if (args.resolutionAction === "log_payment" && !args.paymentData) {
      throw new Error("Payment data is required when logging a payment");
    }

    // ═══════════════════════════════════════════════════════════════════
    // "acknowledged" — no opportunity/meeting transition needed
    // ═══════════════════════════════════════════════════════════════════
    // Used when:
    // 1. Closer already scheduled a follow-up (opportunity is follow_up_scheduled)
    // 2. Admin accepts non-attendance as-is
    // 3. Admin just wants to note they've seen it
    if (args.resolutionAction === "acknowledged") {
      await ctx.db.patch(args.reviewId, {
        status: "resolved",
        resolvedAt: now,
        resolvedByUserId: userId,
        resolutionAction: "acknowledged",
        resolutionNote: args.resolutionNote?.trim() || undefined,
      });

      await emitDomainEvent(ctx, {
        tenantId,
        entityType: "meeting",
        entityId: review.meetingId,
        eventType: "meeting.overran_review_resolved",
        source: "admin",
        actorUserId: userId,
        occurredAt: now,
        metadata: {
          reviewId: args.reviewId,
          resolutionAction: "acknowledged",
          closerResponse: review.closerResponse,
        },
      });

      console.log("[Review] acknowledged", { reviewId: args.reviewId });
      return;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Outcome-based resolution — transitions opportunity to target status
    // ═══════════════════════════════════════════════════════════════════
    let targetOpportunityStatus: string;

    switch (args.resolutionAction) {
      case "log_payment":
        targetOpportunityStatus = "payment_received";
        break;
      case "schedule_follow_up":
        targetOpportunityStatus = "follow_up_scheduled";
        break;
      case "mark_no_show":
        targetOpportunityStatus = "no_show";
        break;
      case "mark_lost":
        targetOpportunityStatus = "lost";
        break;
    }

    // ── Opportunity transition (only if still meeting_overran) ────────
    // Closer may have already scheduled a follow-up → opportunity is
    // now follow_up_scheduled. Don't override it.
    if (opportunity.status === "meeting_overran") {
      if (
        !validateTransition(opportunity.status, targetOpportunityStatus)
      ) {
        throw new Error(
          `Cannot transition from "${opportunity.status}" to "${targetOpportunityStatus}"`,
        );
      }

      const oldOpportunity = opportunity;
      await ctx.db.patch(opportunity._id, {
        status: targetOpportunityStatus,
        updatedAt: now,
        ...(args.resolutionAction === "log_payment" && {
          paymentReceivedAt: now,
        }),
        ...(args.resolutionAction === "mark_lost" && {
          lostAt: now,
          lostByUserId: userId,
          lostReason: args.lostReason?.trim() || undefined,
        }),
        ...(args.resolutionAction === "mark_no_show" && {
          noShowAt: now,
        }),
      });
      await replaceOpportunityAggregate(ctx, oldOpportunity, opportunity._id);
    }

    // ── Meeting status: conditional on closer's response ─────────────
    // "forgot_to_press" = false positive → meeting transitions to completed
    // "did_not_attend" or no response = truth → meeting stays meeting_overran
    const isFalsePositiveCorrection =
      review.closerResponse === "forgot_to_press";
    if (isFalsePositiveCorrection && meeting.status === "meeting_overran") {
      const oldMeeting = meeting;
      await ctx.db.patch(review.meetingId, {
        status: "completed",
        completedAt: now,
      });
      await replaceMeetingAggregate(ctx, oldMeeting, review.meetingId);
    }

    // ── Outcome side effects (same transaction) ──────────────────────
    // IMPORTANT: Direct function calls, NOT ctx.runMutation.
    // ctx.runMutation creates a SEPARATE transaction — if it fails after
    // the outer patches, data is inconsistent. Direct calls share the
    // same atomic transaction.
    if (args.resolutionAction === "log_payment" && args.paymentData) {
      await createPaymentRecord(ctx, {
        tenantId,
        opportunityId: review.opportunityId,
        meetingId: review.meetingId,
        actorUserId: userId,
        amount: args.paymentData.amount,
        currency: args.paymentData.currency,
        provider: args.paymentData.provider,
        referenceCode: args.paymentData.referenceCode,
        proofFileId: args.paymentData.proofFileId,
      });
    } else if (args.resolutionAction === "schedule_follow_up") {
      await createManualReminder(ctx, {
        tenantId,
        opportunityId: review.opportunityId,
        actorUserId: userId,
        note:
          args.resolutionNote?.trim() ||
          "Scheduled via overran review resolution",
      });
    }

    // ── Tenant stats ─────────────────────────────────────────────────
    // Only update if opportunity actually transitioned (was meeting_overran)
    if (opportunity.status === "meeting_overran") {
      const fromActive = isActiveOpportunityStatus(opportunity.status);
      const toActive = isActiveOpportunityStatus(targetOpportunityStatus);
      const activeDelta =
        fromActive === toActive ? 0 : toActive ? 1 : -1;
      await updateTenantStats(ctx, tenantId, {
        ...(activeDelta !== 0
          ? { activeOpportunities: activeDelta }
          : {}),
        ...(args.resolutionAction === "mark_lost" && { lostDeals: 1 }),
        ...(args.resolutionAction === "log_payment" && { wonDeals: 1 }),
      });
    }

    // ── Mark review resolved ─────────────────────────────────────────
    await ctx.db.patch(args.reviewId, {
      status: "resolved",
      resolvedAt: now,
      resolvedByUserId: userId,
      resolutionAction: args.resolutionAction,
      resolutionNote: args.resolutionNote?.trim() || undefined,
    });

    // ── Update opportunity meeting refs ──────────────────────────────
    await updateOpportunityMeetingRefs(ctx, opportunity._id);

    // ── Domain event ─────────────────────────────────────────────────
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "meeting",
      entityId: review.meetingId,
      eventType: "meeting.overran_review_resolved",
      source: "admin",
      actorUserId: userId,
      occurredAt: now,
      metadata: {
        reviewId: args.reviewId,
        resolutionAction: args.resolutionAction,
        closerResponse: review.closerResponse,
        targetOpportunityStatus,
        opportunityActuallyTransitioned:
          opportunity.status === "meeting_overran",
      },
    });

    console.log("[Review] resolved", {
      reviewId: args.reviewId,
      action: args.resolutionAction,
      opportunityTransitioned: opportunity.status === "meeting_overran",
    });
  },
});
```

**Key implementation notes:**
- **False positive correction**: When `closerResponse === "forgot_to_press"`, the admin is validating the closer's claim that they actually attended. The meeting transitions from `meeting_overran` → `completed`. When `closerResponse === "did_not_attend"` or no response, the meeting stays `meeting_overran` — it's the truth about what happened.
- **Opportunity drift**: If the closer already scheduled a follow-up (`opportunity.status === "follow_up_scheduled"`), the admin's resolution doesn't override it. The review is still marked resolved, but no opportunity transition happens. The `acknowledged` action is the natural choice in this scenario.
- **Same-transaction helpers**: `createPaymentRecord` and `createManualReminder` are plain async functions (not `internalMutation`). They share the caller's transaction — if they fail, the entire mutation rolls back. This is critical for data consistency.
- **Tenant stats**: `wonDeals` is incremented for `log_payment` resolutions. `lostDeals` is incremented for `mark_lost`. Active opportunity count adjusts based on whether the source and target statuses are both active or not.
- **`noShowReason`** arg is accepted but not explicitly used in this implementation — it could be stored on the review's `resolutionNote` or on the opportunity. For MVP, the admin's `resolutionNote` captures any context.
- Remove any old evidence-related validation guards from the existing mutation (e.g., "previous_meeting_overran requires evidence unless using evidence_not_uploaded").

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reviews/mutations.ts` | Modify | Replace resolveReview with new implementation |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/reviews/queries.ts` | Modify | 4A, 4B, 4C |
| `convex/reviews/mutations.ts` | Modify | 4D |
