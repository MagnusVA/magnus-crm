# Phase 2 — Backend: Replace Blanket Overran Guards

**Goal:** Replace the 8 existing blanket `meeting_overran` throw-guards across 5 closer files with a single shared `assertOverranReviewStillPending(...)` helper so that (a) closers can take real outcome actions while the review is `pending`, (b) follow-up actions succeed without transitioning the opportunity, and (c) the backend hard-rejects any action once the review is `resolved`. After this phase, the closer-side mutations accept `meeting_overran` traffic but only while the linked review is still pending; the opportunity status stays `meeting_overran` for follow-up records; and webhook pipeline guards remain unchanged.

**Prerequisite:**
- **Phase 1 complete and deployed** (`npx convex dev` succeeded, `convex/_generated/*` regenerated with the expanded `MEETING_VALID_TRANSITIONS.meeting_overran`).
- `convex/_generated/api.ts` must already include `api.reviews.queries.getReviewDetail` / similar review-lookup access (present from v1 — no action required).

**Runs in PARALLEL with:** Phase 3 (Fathom Link & Disputed Resolution) — Phase 3 touches `meetingActions.ts::saveFathomLink` (new export), `reviews/mutations.ts::resolveReview`, `reviews/queries.ts`, new file `convex/lib/paymentHelpers.ts`, and refactors `convex/closer/payments.ts`. Phase 2 touches `meetingActions.ts::markAsLost`, `noShowActions.ts`, `followUpMutations.ts`, `followUp.ts`, `payments.ts`, and new file `convex/lib/overranReviewGuards.ts`. **Shared files are `meetingActions.ts` and `payments.ts`**:
- `meetingActions.ts`: 2B modifies the existing `markAsLost` handler, 3A appends `saveFathomLink`.
- `payments.ts`: 2F modifies `logPayment`, 3B extracts `syncCustomerPaymentSummary`.
Different code regions of the same files; handle with care (see parallelization strategy for merge guidance).

**Skills to invoke:**
- `convex-setup-auth` — The shared guard reads `meetingReviews` via `ctx.db.query(...)` inside mutation/action context. Confirm tenant-scoping pattern (`review.tenantId === tenantId`) matches the existing `requireTenantUser` pattern used elsewhere in `convex/`.
- `convex-performance-audit` — The shared guard adds a bounded lookup across the opportunity's newest meetings using existing indexes (`by_opportunityId_and_scheduledAt` on `meetings`, `by_meetingId` on `meetingReviews`). Confirm this remains acceptable latency for meeting-detail actions.

**Acceptance Criteria:**
1. A new file `convex/lib/overranReviewGuards.ts` exists and exports `assertOverranReviewStillPending(ctx, opportunityId)` (MutationCtx-compatible) and `assertOverranReviewStillPendingViaQuery(ctx, opportunityId)` (ActionCtx-compatible — uses `ctx.runQuery` against an `internalQuery`).
2. `markAsLost` on a `meeting_overran` opportunity with a **pending** review succeeds and transitions the opportunity to `lost`; `tenantStats.lostDeals` increments by 1; `tenantStats.activeOpportunities` decrements by 1.
3. `markAsLost` on a `meeting_overran` opportunity with a **resolved** review throws `"This meeting-overran review has already been resolved."` and makes no DB changes.
4. `markNoShow` on a `meeting_overran` **meeting** (status) with pending review transitions both the meeting and the opportunity to `no_show`, AND the meeting transition passes `validateMeetingTransition("meeting_overran", "no_show")` (confirming Phase 1's change is live).
5. `createSchedulingLinkFollowUp` on a `meeting_overran` opportunity with pending review creates the `followUps` row and returns `{ schedulingLinkUrl, followUpId }` — the opportunity status remains `meeting_overran` (no transition).
6. `confirmFollowUpScheduled` on a `meeting_overran` opportunity returns silently (no throw, no DB change) — the opportunity status remains `meeting_overran`.
7. `createManualReminderFollowUpPublic` on a `meeting_overran` opportunity with pending review inserts a `followUps` row with `type: "manual_reminder"` and `status: "pending"` — the opportunity status remains `meeting_overran`; NO `opportunity.status_changed` domain event is emitted.
8. `createFollowUp` action (`"use node"` file) on a `meeting_overran` opportunity with pending review successfully creates the Calendly scheduling link.
9. `logPayment` on a `meeting_overran` opportunity with pending review creates the `paymentRecords` row and transitions the opportunity to `payment_received`; auto-conversion runs normally; `tenantStats.wonDeals` / `totalRevenueMinor` increment.
10. Pipeline webhook handlers `inviteeNoShow.ts` and `inviteeCanceled.ts` are **unchanged** — they still log `[Pipeline:*] IGNORED - opportunity is meeting_overran` for `meeting_overran` opportunities.
11. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (lib/overranReviewGuards.ts — new shared helper) ──────────────┐
                                                                   ├── 2B (meetingActions.ts::markAsLost)
                                                                   ├── 2C (noShowActions.ts::markNoShow)
                                                                   ├── 2D (followUpMutations.ts — 4 guards)
                                                                   ├── 2E (followUp.ts action — 1 guard)
                                                                   └── 2F (payments.ts::logPayment)
```

**Optimal execution:**
1. **Start 2A alone.** The shared helper must exist as a typed, exported function before any consuming mutation / action can be authored against it. 2A is ~60 lines of new code in one new file.
2. Once 2A is merged (or at least has a stable interface), **start 2B, 2C, 2D, 2E, 2F in parallel** — each touches a different file. They import the same helper but otherwise have no shared state. Any of them can be reviewed, merged, and deployed independently.

**Estimated time:** 1.5 days (12 hours — 2 hours for 2A including tests, 1.5–2 hours each for 2B/2C/2E/2F, 3 hours for 2D because it modifies four guards in one file).

---

## Subphases

### 2A — New Shared Helper: `convex/lib/overranReviewGuards.ts`

**Type:** Backend (new module)
**Parallelizable:** No — must complete first. All other subphases (2B–2F) depend on the exported helper signature.

**What:** A new Convex helper module that exports two functions and one internal query:

- `assertOverranReviewStillPending(ctx, opportunityId)` — for `MutationCtx` / `QueryCtx` consumers (mutations and queries).
- `assertOverranReviewStillPendingViaQuery(ctx, opportunityId)` — for `ActionCtx` consumers (the `"use node"` action file, which cannot directly touch `ctx.db`).
- `getOverranReviewForOpportunity` — internal Convex query used by the action variant.

Each helper deterministically resolves the **latest linked meeting-overran review** for the opportunity by walking the newest meetings first, preferring `meeting.reviewId` and falling back to the `meetingReviews.by_meetingId` index when needed. If that review exists and its status is `resolved`, it throws `"This meeting-overran review has already been resolved."` — blocking repeat action after admin resolution. If the review is `pending` or absent, it returns silently (allowing the caller to proceed).

**Why:** The design decision (Section 5.1 of `overhaul-v2.md`) is to centralize the **pending-review gate** rather than delete the v1 `meeting_overran` checks outright. Deleting outright would let a closer keep re-acting on a flagged meeting forever after admin resolution; keeping the v1 guard prevents all pending-review action. The helper is the correct middle ground. Duplicating this logic across 8 call sites (6 mutations + 1 internal mutation + 1 action) invites drift — the helper eliminates it.

**Where:**
- `convex/lib/overranReviewGuards.ts` (new)

**How:**

**Step 1: Create the module with the internal query and mutation/query helper**

```typescript
// Path: convex/lib/overranReviewGuards.ts

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { internalQuery } from "../_generated/server";
import { api, internal } from "../_generated/api";

/**
 * Reads the latest linked meeting-overran review for the given opportunity.
 * Returns `null` if no review exists.
 *
 * Deterministic lookup strategy:
 * 1. Load meetings for the opportunity newest-first via
 *    `meetings.by_opportunityId_and_scheduledAt`.
 * 2. Prefer `meeting.reviewId` when present (fast path).
 * 3. Fall back to `meetingReviews.by_meetingId` for legacy rows that predate
 *    the direct `meeting.reviewId` linkage.
 */
async function findOverranReviewForOpportunity(
  ctx: QueryCtx | MutationCtx,
  opportunityId: Id<"opportunities">,
) {
  const meetings = await ctx.db
    .query("meetings")
    .withIndex("by_opportunityId_and_scheduledAt", (q) =>
      q.eq("opportunityId", opportunityId),
    )
    .order("desc")
    .take(20);

  for (const meeting of meetings) {
    if (meeting.reviewId) {
      const linkedReview = await ctx.db.get(meeting.reviewId);
      if (
        linkedReview &&
        linkedReview.category === "meeting_overran" &&
        linkedReview.opportunityId === opportunityId
      ) {
        return linkedReview;
      }
    }

    const fallbackReview = await ctx.db
      .query("meetingReviews")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", meeting._id))
      .first();
    if (
      fallbackReview &&
      fallbackReview.category === "meeting_overran" &&
      fallbackReview.opportunityId === opportunityId
    ) {
      return fallbackReview;
    }
  }
  return null;
}

/**
 * MutationCtx / QueryCtx variant of the pending-review guard.
 *
 * Call this at the top of any closer mutation that used to throw
 * "This opportunity is under meeting-overran review..." on a
 * `meeting_overran` opportunity. v2 behavior:
 *
 * - no review, or review.status === "pending": return silently, allow action
 * - review.status === "resolved": throw "review already resolved" error
 *
 * The caller must have already confirmed `opportunity.status === "meeting_overran"`
 * before calling. Calling on a non-overran opportunity is a no-op but wastes a query.
 */
export async function assertOverranReviewStillPending(
  ctx: MutationCtx | QueryCtx,
  opportunityId: Id<"opportunities">,
): Promise<void> {
  const review = await findOverranReviewForOpportunity(ctx, opportunityId);
  if (review && review.status === "resolved") {
    throw new Error("This meeting-overran review has already been resolved.");
  }
  // review is null OR review.status === "pending" → allow action.
}

/**
 * Internal query variant — used by actions (`"use node"` files) which cannot
 * access ctx.db directly. Returns `null` or the review document.
 *
 * Action caller pattern:
 *
 *   import { assertOverranReviewStillPendingViaQuery } from "../lib/overranReviewGuards";
 *   // ...
 *   await assertOverranReviewStillPendingViaQuery(ctx, opportunityId);
 *
 * Internally this wraps `ctx.runQuery(internal.lib.overranReviewGuards.getOverranReviewForOpportunity, ...)`
 * and throws on resolved.
 */
export const getOverranReviewForOpportunity = internalQuery({
  args: { opportunityId: v.id("opportunities") },
  handler: async (ctx, { opportunityId }) => {
    return await findOverranReviewForOpportunity(ctx, opportunityId);
  },
});

export async function assertOverranReviewStillPendingViaQuery(
  ctx: ActionCtx,
  opportunityId: Id<"opportunities">,
): Promise<void> {
  const review = await ctx.runQuery(
    internal.lib.overranReviewGuards.getOverranReviewForOpportunity,
    { opportunityId },
  );
  if (review && review.status === "resolved") {
    throw new Error("This meeting-overran review has already been resolved.");
  }
}
```

**Step 2: Verify import path resolution**

The file is at `convex/lib/overranReviewGuards.ts`. The `internal.lib.overranReviewGuards.getOverranReviewForOpportunity` reference depends on Convex auto-indexing the `lib/` directory into `internal.lib.*`. Run `npx convex dev` after saving this file to regenerate `api.ts` and confirm the internal export is picked up.

**Step 3: Add a short JSDoc at file top**

```typescript
/**
 * Pending-review guard helpers for closer actions on meeting_overran opportunities.
 *
 * v2 replaces the blanket v1 throw-guard with a nuanced gate:
 *   - review pending → allow action (closer can act while review is being reviewed)
 *   - review resolved → reject action (outcome is final after admin resolution)
 *
 * Called from:
 *   - convex/closer/meetingActions.ts::markAsLost
 *   - convex/closer/noShowActions.ts::markNoShow
 *   - convex/closer/followUpMutations.ts::createSchedulingLinkFollowUp / createManualReminderFollowUpPublic / transitionToFollowUp
 *   - convex/closer/followUp.ts::createFollowUp  (action variant)
 *   - convex/closer/payments.ts::logPayment
 *
 */
```

**Key implementation notes:**
- **Two variants are required** because `"use node"` action files (`convex/closer/followUp.ts`) cannot access `ctx.db` directly; they must use `ctx.runQuery(internal.*)`.
- **We reuse existing indexes only.** The helper reads `meetings.by_opportunityId_and_scheduledAt` and `meetingReviews.by_meetingId`, plus the direct `meeting.reviewId` pointer when present. No new index is added.
- **The lookup is deterministic.** We inspect the newest meetings first so the guard is tied to the latest review-linked meeting on the opportunity, not an arbitrary older meeting.
- **The guard returns silently when no review exists.** This covers the case where an opportunity reaches `meeting_overran` without a review (should not happen in v2, but defensively we allow the action rather than hard-throw).
- **Error message** is stable and user-surfaced — Phase 4's frontend has a fallback toast that shows this string verbatim if a stale client slips through.
- **Do NOT short-circuit on `opportunity.status !== "meeting_overran"`.** The caller is responsible for checking status before calling the helper. The helper does one job — review-state validation.
- **Don't add logging here.** Each caller already logs the action; adding helper-level logs double-logs without context.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/overranReviewGuards.ts` | Create | New shared helper (2 exports + 1 internalQuery) |

---

### 2B — `meetingActions.ts::markAsLost` — Replace Guard with Helper Call

**Type:** Backend (mutation modification)
**Parallelizable:** Yes — independent of 2C, 2D, 2E, 2F. Depends only on 2A (helper).

**What:** In `convex/closer/meetingActions.ts`, replace the v1 blanket `meeting_overran` guard in `markAsLost` (currently ~line 257) with a conditional call to `assertOverranReviewStillPending`. Update the `validateTransition` fallback error message to remove the stale `"in_progress"`-specific text (since `meeting_overran` is now also a valid source).

**Why:** The v1 guard blocks all `markAsLost` attempts on `meeting_overran` opportunities. In v2, a closer should be able to mark a flagged meeting's opportunity as lost while the review is pending; only after admin resolution does the outcome lock. `VALID_TRANSITIONS.meeting_overran` already includes `"lost"`, so once the pending-review gate passes, the existing `validateTransition` call succeeds without further changes.

**Where:**
- `convex/closer/meetingActions.ts` (modify)

**How:**

**Step 1: Add the helper import**

```typescript
// Path: convex/closer/meetingActions.ts — imports section (top of file)

// Add this line:
import { assertOverranReviewStillPending } from "../lib/overranReviewGuards";

// Existing imports remain unchanged:
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";
import { requireTenantUser } from "../requireTenantUser";
import { validateTransition } from "../lib/statusTransitions";
// ...
```

**Step 2: Locate the `markAsLost` handler (currently ~line 240–306) and replace the guard**

**BEFORE:**

```typescript
// Path: convex/closer/meetingActions.ts — markAsLost handler

// ... handler opens with requireTenantUser + opportunity validation ...

// Validate the transition
console.log("[Closer:Meeting] markAsLost current status", { currentStatus: opportunity.status });
if (opportunity.status === "meeting_overran") {
  throw new Error(
    "This opportunity is under meeting-overran review and cannot be resolved by the closer.",
  );
}
if (!validateTransition(opportunity.status, "lost")) {
  throw new Error(
    `Cannot mark as lost from status "${opportunity.status}". ` +
    `Only "in_progress" opportunities can be marked as lost.`
  );
}
```

**AFTER:**

```typescript
// Path: convex/closer/meetingActions.ts — markAsLost handler

// ... handler opens with requireTenantUser + opportunity validation ...

// v2: Allow meeting_overran while the review is pending.
// The helper throws if the review is already resolved.
console.log("[Closer:Meeting] markAsLost current status", { currentStatus: opportunity.status });
if (opportunity.status === "meeting_overran") {
  await assertOverranReviewStillPending(ctx, opportunity._id);
}

if (!validateTransition(opportunity.status, "lost")) {
  throw new Error(
    `Cannot mark as lost from status "${opportunity.status}"`,
  );
}
```

**Step 3: Leave the rest of the handler unchanged**

The `ctx.db.patch(opportunity._id, { status: "lost", ... })`, `updateTenantStats(..., { lostDeals: 1, activeOpportunities: -1 })`, `replaceOpportunityAggregate`, and domain event emission logic all remain as-is. They operate correctly on a `meeting_overran → lost` transition because the opportunity-level `VALID_TRANSITIONS` map already allows it and `isActiveOpportunityStatus("meeting_overran") === true`, so the `-1` delta is correct.

**Key implementation notes:**
- **Error-message change.** Removing `Only "in_progress" opportunities can be marked as lost.` because it is now false — `meeting_overran` can also transition to `lost`. Keep the error concise.
- **No change to `tenantStats` delta computation.** `isActiveOpportunityStatus("meeting_overran")` returns `true`, so a `meeting_overran → lost` transition correctly decrements `activeOpportunities` by 1, the same as `in_progress → lost`.
- **No change to domain event emission.** The emitted `opportunity.status_changed` event with `fromStatus: "meeting_overran"` provides accurate audit history.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/meetingActions.ts` | Modify | Import `assertOverranReviewStillPending`; replace blanket guard + update error message in `markAsLost` |

---

### 2C — `noShowActions.ts::markNoShow` — Replace Guard + Expand Meeting Status Check

**Type:** Backend (mutation modification)
**Parallelizable:** Yes — independent of 2B, 2D, 2E, 2F. Depends only on 2A.

**What:** Two edits in the same handler:
1. Expand the meeting status check from `!== "in_progress"` to allow both `"in_progress"` AND `"meeting_overran"`.
2. Replace the opportunity-level blanket guard with `assertOverranReviewStillPending`.

**Why:** In v2, a closer can mark a lead as no-show on a `meeting_overran` meeting. The meeting status transition (`meeting_overran → no_show`) was enabled in Phase 1. The meeting-level guard here still filters on `meeting.status === "in_progress"`; without widening it to accept `"meeting_overran"`, the mutation throws before reaching the opportunity-level logic.

**Where:**
- `convex/closer/noShowActions.ts` (modify)

**How:**

**Step 1: Add the helper import**

```typescript
// Path: convex/closer/noShowActions.ts — imports section

import { assertOverranReviewStillPending } from "../lib/overranReviewGuards";
```

**Step 2: Expand the meeting status check (~line 49–52)**

**BEFORE:**

```typescript
// Path: convex/closer/noShowActions.ts
if (meeting.status !== "in_progress") {
  throw new Error(
    `Can only mark no-show on in-progress meetings (current: "${meeting.status}")`,
  );
}
```

**AFTER:**

```typescript
// Path: convex/closer/noShowActions.ts
// v2: meeting_overran meetings can also be marked no-show while the review is pending.
if (meeting.status !== "in_progress" && meeting.status !== "meeting_overran") {
  throw new Error(
    `Can only mark no-show on in-progress or meeting-overran meetings (current: "${meeting.status}")`,
  );
}
```

**Step 3: Replace the opportunity-level guard (~line 62–66)**

**BEFORE:**

```typescript
if (opportunity.status === "meeting_overran") {
  throw new Error(
    "This opportunity is under meeting-overran review and cannot be resolved by the closer.",
  );
}
if (!validateTransition(opportunity.status, "no_show")) {
  throw new Error(
    `Cannot transition opportunity from "${opportunity.status}" to "no_show"`,
  );
}
```

**AFTER:**

```typescript
// v2: Allow meeting_overran while review is pending.
if (opportunity.status === "meeting_overran") {
  await assertOverranReviewStillPending(ctx, opportunity._id);
}
if (!validateTransition(opportunity.status, "no_show")) {
  throw new Error(
    `Cannot transition opportunity from "${opportunity.status}" to "no_show"`,
  );
}
```

**Step 4: Leave the rest of the handler unchanged**

The existing no-show reason/note handling, `waitDurationMs` computation (which gracefully handles `meeting.startedAt === undefined` — see Section 14.8 of `overhaul-v2.md`), tenant stats updates, and domain event emission all remain as-is. The handler already calls `validateMeetingTransition(meeting.status, "no_show")` further down (or equivalent), which now passes for `meeting_overran → no_show` thanks to Phase 1.

**Key implementation notes:**
- **The `MarkNoShowDialog` (Phase 4) passes `startedAt={meeting.startedAt}` — for an overran meeting this is `undefined`.** The existing handler computes `waitDurationMs` as `undefined` when `meeting.startedAt` is undefined (~line 76–78 of the current file). No code change needed for this — just confirmation that the edge case is already handled.
- **Do NOT add a meeting-level guard for review status.** The meeting-level check `meeting.status === "meeting_overran"` is sufficient — the opportunity-level `assertOverranReviewStillPending` already enforces the pending-review constraint.
- **Do NOT remove `validateTransition` or `validateMeetingTransition`.** They provide defense-in-depth against stale client submissions.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/noShowActions.ts` | Modify | Expand meeting status check + replace opportunity guard in `markNoShow` |

---

### 2D — `followUpMutations.ts` — Replace 4 Guards with Skip-Transition Logic

**Type:** Backend (mutations modification)
**Parallelizable:** Yes — independent of 2B, 2C, 2E, 2F. Depends only on 2A. **This is the largest subphase — 4 handlers in one file.**

**What:** Replace the blanket `meeting_overran` guards in four handlers inside `convex/closer/followUpMutations.ts`:
- `createSchedulingLinkFollowUp` (~line 185–189) — replace guard with pending-review check; no status transition (already deferred to `confirmFollowUpScheduled`).
- `confirmFollowUpScheduled` (~line 269–273) — replace guard with early-return on `meeting_overran`.
- `createManualReminderFollowUpPublic` (~line 329–333) — replace guard + wrap the status transition / aggregate update / tenant stats / domain event in `if (!isTerminalOverran)` so the follow-up record is created but the opportunity stays `meeting_overran`.
- `transitionToFollowUp` (internal mutation, ~line 75–79) — replace the throw with `assertOverranReviewStillPending` + early return (so the action file can call it without transitioning overran opportunities).

**Why:** The design decision (Section 5.4 of `overhaul-v2.md`) is that **follow-up actions on `meeting_overran` opportunities must NOT transition the opportunity status**. If we let the transition run, the opportunity moves to `follow_up_scheduled`, and the pipeline's UTM deterministic linking (~line 1041 of `convex/pipeline/inviteeCreated.ts`) would match that status and link the lead's next booking to the same dead opportunity. By keeping the status as `meeting_overran`, the UTM check fails → pipeline creates a new opportunity, which is the correct behavior for a functionally terminal status.

The scheduling link URL is still created (Calendly API call in Phase 2E), the `followUps` row is still inserted, the UI still shows the follow-up card (Phase 5). Only the opportunity transition is skipped.

**Where:**
- `convex/closer/followUpMutations.ts` (modify)

**How:**

**Step 1: Add the helper import**

```typescript
// Path: convex/closer/followUpMutations.ts — imports section
import { assertOverranReviewStillPending } from "../lib/overranReviewGuards";
```

**Step 2: Fix `createSchedulingLinkFollowUp` (~line 185–189)**

**BEFORE:**

```typescript
// Path: convex/closer/followUpMutations.ts — createSchedulingLinkFollowUp

if (opportunity.status === "meeting_overran") {
  throw new Error(
    "This opportunity is under meeting-overran review and cannot be resolved by the closer.",
  );
}
if (!validateTransition(opportunity.status, "follow_up_scheduled")) {
  throw new Error(
    `Cannot schedule follow-up from status "${opportunity.status}"`,
  );
}
```

**AFTER:**

```typescript
// Path: convex/closer/followUpMutations.ts — createSchedulingLinkFollowUp

// v2: Allow meeting_overran while review is pending. Status transition is
// deferred to confirmFollowUpScheduled anyway — which now early-returns for
// meeting_overran. The scheduling link URL is still generated and returned.
if (opportunity.status === "meeting_overran") {
  await assertOverranReviewStillPending(ctx, opportunity._id);
}
if (!validateTransition(opportunity.status, "follow_up_scheduled")) {
  throw new Error(
    `Cannot schedule follow-up from status "${opportunity.status}"`,
  );
}
```

The rest of `createSchedulingLinkFollowUp` (the `ctx.db.insert("followUps", ...)` call, the UTM-encoded scheduling-link URL builder, the `ctx.db.patch(followUpId, { schedulingLinkUrl })` call, the `emitDomainEvent(... "followUp.created" ...)` call) remains unchanged. Note that `validateTransition("meeting_overran", "follow_up_scheduled")` returns `true` per `VALID_TRANSITIONS.meeting_overran`, so the check passes — but the actual transition happens in `confirmFollowUpScheduled`, not here.

**Step 3: Fix `confirmFollowUpScheduled` (~line 269–273)**

**BEFORE:**

```typescript
// Path: convex/closer/followUpMutations.ts — confirmFollowUpScheduled

if (opportunity.status === "meeting_overran") {
  throw new Error(
    "This opportunity is under meeting-overran review and cannot be resolved by the closer.",
  );
}
// Already transitioned (e.g. user double-clicked Done) — silently succeed
if (opportunity.status === "follow_up_scheduled") {
  return;
}
if (!validateTransition(opportunity.status, "follow_up_scheduled")) {
  throw new Error(
    `Cannot schedule follow-up from status "${opportunity.status}"`,
  );
}
```

**AFTER:**

```typescript
// Path: convex/closer/followUpMutations.ts — confirmFollowUpScheduled

// v2: meeting_overran is functionally terminal. The scheduling link was created
// but the opportunity does NOT transition. When the lead books through the link,
// pipeline UTM deterministic linking fails to match (meeting_overran is not in
// its lookup set) and a NEW opportunity is created — which is correct.
if (opportunity.status === "meeting_overran") {
  await assertOverranReviewStillPending(ctx, opportunity._id);
  return;
}
// Already transitioned (e.g. user double-clicked Done) — silently succeed
if (opportunity.status === "follow_up_scheduled") {
  return;
}
if (!validateTransition(opportunity.status, "follow_up_scheduled")) {
  throw new Error(
    `Cannot schedule follow-up from status "${opportunity.status}"`,
  );
}
```

Critical: the `return` after `assertOverranReviewStillPending` is what skips the opportunity transition. If the helper throws (review resolved), the return never executes. If the helper allows, we exit the handler without patching `opportunity.status`.

**Step 4: Fix `createManualReminderFollowUpPublic` (~line 329–333)**

This is the **largest of the four edits** because the function currently **always** transitions the opportunity to `follow_up_scheduled`. In v2, the follow-up record is created either way, but the transition only fires for non-overran opportunities.

**BEFORE (simplified — full handler is ~lines 312–402):**

```typescript
export const createManualReminderFollowUpPublic = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    contactMethod: v.union(v.literal("call"), v.literal("text")),
    reminderScheduledAt: v.number(),
    reminderNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const opportunity = await ctx.db.get(args.opportunityId);
    // ... existence + tenant + ownership checks ...

    if (opportunity.status === "meeting_overran") {
      throw new Error(
        "This opportunity is under meeting-overran review and cannot be resolved by the closer.",
      );
    }
    if (!validateTransition(opportunity.status, "follow_up_scheduled")) {
      throw new Error(
        `Cannot schedule follow-up from status "${opportunity.status}"`,
      );
    }

    // ... reminder time validation, followUps insert ...

    // Always transitions opportunity
    await ctx.db.patch(args.opportunityId, {
      status: "follow_up_scheduled",
      updatedAt: now,
    });
    await replaceOpportunityAggregate(ctx, opportunity, args.opportunityId);
    await updateTenantStats(ctx, tenantId, {
      activeOpportunities: isActiveOpportunityStatus(opportunity.status) ? 0 : 1,
    });
    // domain events for both followUp.created and opportunity.status_changed

    return { followUpId };
  },
});
```

**AFTER:**

```typescript
export const createManualReminderFollowUpPublic = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    contactMethod: v.union(v.literal("call"), v.literal("text")),
    reminderScheduledAt: v.number(),
    reminderNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const opportunity = await ctx.db.get(args.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }
    if (opportunity.assignedCloserId !== userId) {
      throw new Error("Not your opportunity");
    }

    // v2: Allow meeting_overran while review is pending, but do NOT transition
    // the opportunity — it stays meeting_overran (functionally terminal).
    if (opportunity.status === "meeting_overran") {
      await assertOverranReviewStillPending(ctx, opportunity._id);
    }
    const isTerminalOverran = opportunity.status === "meeting_overran";

    if (!validateTransition(opportunity.status, "follow_up_scheduled")) {
      throw new Error(
        `Cannot schedule follow-up from status "${opportunity.status}"`,
      );
    }

    const now = Date.now();
    if (args.reminderScheduledAt <= now) {
      throw new Error("Reminder time must be in the future");
    }

    // Always insert the follow-up record (reminder lives regardless of opp status).
    const followUpId = await ctx.db.insert("followUps", {
      tenantId,
      opportunityId: args.opportunityId,
      leadId: opportunity.leadId,
      closerId: userId,
      type: "manual_reminder",
      contactMethod: args.contactMethod,
      reminderScheduledAt: args.reminderScheduledAt,
      reminderNote: args.reminderNote,
      reason: "closer_initiated",
      status: "pending",
      createdAt: now,
    });

    // v2: Skip opportunity transition for terminal meeting_overran opportunities.
    if (!isTerminalOverran) {
      await ctx.db.patch(args.opportunityId, {
        status: "follow_up_scheduled",
        updatedAt: now,
      });
      await replaceOpportunityAggregate(ctx, opportunity, args.opportunityId);
      await updateTenantStats(ctx, tenantId, {
        activeOpportunities: isActiveOpportunityStatus(opportunity.status) ? 0 : 1,
      });
      await emitDomainEvent(ctx, {
        tenantId,
        entityType: "opportunity",
        entityId: args.opportunityId,
        eventType: "opportunity.status_changed",
        source: "closer",
        actorUserId: userId,
        fromStatus: opportunity.status,
        toStatus: "follow_up_scheduled",
        occurredAt: now,
      });
    }

    // Emit followUp.created domain event ALWAYS — the reminder exists either way.
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "followUp",
      entityId: followUpId,
      eventType: "followUp.created",
      source: "closer",
      actorUserId: userId,
      toStatus: "pending",
      metadata: {
        type: "manual_reminder",
        opportunityId: args.opportunityId,
        terminalOverran: isTerminalOverran, // v2: audit signal that opportunity did NOT transition
      },
      occurredAt: now,
    });

    console.log("[Closer:FollowUp] manual reminder follow-up created", {
      followUpId,
      opportunityId: args.opportunityId,
      contactMethod: args.contactMethod,
      reminderScheduledAt: args.reminderScheduledAt,
      terminalOverran: isTerminalOverran,
    });

    return { followUpId };
  },
});
```

**Step 5: Fix `transitionToFollowUp` internal helper (~line 67–110)**

**BEFORE:**

```typescript
// Path: convex/closer/followUpMutations.ts — transitionToFollowUp

export const transitionToFollowUp = internalMutation({
  args: { opportunityId: v.id("opportunities") },
  handler: async (ctx, { opportunityId }) => {
    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity) throw new Error("Opportunity not found");

    if (opportunity.status === "meeting_overran") {
      throw new Error(
        "Meeting-overran opportunities require admin resolution before standard follow-up actions.",
      );
    }
    // ... validateTransition + ctx.db.patch + tenantStats + domain event ...
  },
});
```

**AFTER:**

```typescript
// Path: convex/closer/followUpMutations.ts — transitionToFollowUp

export const transitionToFollowUp = internalMutation({
  args: { opportunityId: v.id("opportunities") },
  handler: async (ctx, { opportunityId }) => {
    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity) throw new Error("Opportunity not found");

    // v2: meeting_overran opportunities do NOT transition on follow-up.
    // The action file creates the scheduling link; we skip the transition
    // so the pipeline treats the new booking as a fresh opportunity.
    if (opportunity.status === "meeting_overran") {
      await assertOverranReviewStillPending(ctx, opportunity._id);
      return;
    }
    // ... (rest of handler unchanged: validateTransition, patch, aggregates, stats, domain event)
  },
});
```

**Key implementation notes:**
- **`isTerminalOverran` is captured once, early.** The `opportunity.status` value is read BEFORE any patches so the flag is stable for the rest of the handler.
- **`followUp.created` domain event fires ALWAYS.** The reminder exists either way — audit-wise, we want the follow-up creation recorded even when the opportunity doesn't transition. The new `metadata.terminalOverran` boolean gives observers a clear signal.
- **`opportunity.status_changed` domain event fires ONLY in the non-terminal branch.** Emitting a spurious `opportunity.status_changed` event with `fromStatus === toStatus === "meeting_overran"` would pollute the audit log.
- **`validateTransition` still runs** even in the terminal-overran path. `VALID_TRANSITIONS.meeting_overran` allows `follow_up_scheduled`, so the check passes. Keeping the check in both branches provides defense-in-depth; the skip-transition logic is orthogonal to transition validity.
- **`confirmFollowUpScheduled` early-returns before hitting `validateTransition`.** Scheduling-link flow is a two-step dance; the API response from `createSchedulingLinkFollowUp` has already returned the URL to the UI. `confirmFollowUpScheduled` would normally transition the opportunity on "Done" click, but for overran we skip entirely.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/followUpMutations.ts` | Modify | 4 handlers: createSchedulingLinkFollowUp, confirmFollowUpScheduled, createManualReminderFollowUpPublic, transitionToFollowUp |

---

### 2E — `followUp.ts` (Action) — Replace Guard with `assertOverranReviewStillPendingViaQuery`

**Type:** Backend (action modification — `"use node"` file)
**Parallelizable:** Yes — independent of 2B, 2C, 2D, 2F. Depends only on 2A.

**What:** In `convex/closer/followUp.ts` (a `"use node"` action file that calls the Calendly API), replace the blanket `meeting_overran` guard (~line 103–107) with `assertOverranReviewStillPendingViaQuery` (the ActionCtx variant from 2A).

**Why:** `"use node"` files cannot call `ctx.db` directly — they must use `ctx.runQuery`. Without the action-variant guard, an action cannot perform the pending-review check. The Calendly scheduling link creation flow is: UI calls `api.closer.followUp.createFollowUp` (action) → action generates Calendly link URL → action calls `internal.closer.followUpMutations.createFollowUpRecord` (mutation) to write the DB row. Both the action entry and the downstream mutation need the guard.

**Where:**
- `convex/closer/followUp.ts` (modify)

**How:**

**Step 1: Add the helper import**

```typescript
// Path: convex/closer/followUp.ts — imports section
import { assertOverranReviewStillPendingViaQuery } from "../lib/overranReviewGuards";
```

**Step 2: Locate the guard (~line 103–107) and replace**

**BEFORE:**

```typescript
// Path: convex/closer/followUp.ts — createFollowUp action handler

// ... action preamble: auth, opportunity lookup ...

if (opportunity.status === "meeting_overran") {
  throw new Error(
    "This opportunity is under meeting-overran review and cannot be resolved by the closer.",
  );
}

// ... rest of action: Calendly API call + calling internalMutation ...
```

**AFTER:**

```typescript
// Path: convex/closer/followUp.ts — createFollowUp action handler

// ... action preamble: auth, opportunity lookup ...

// v2: Allow meeting_overran while review is pending. The action still creates
// the Calendly scheduling link; the downstream transitionToFollowUp internal
// mutation handles the skip-transition logic for terminal overran opportunities.
if (opportunity.status === "meeting_overran") {
  await assertOverranReviewStillPendingViaQuery(ctx, opportunityId);
}

// ... rest of action: Calendly API call + calling internalMutation ...
```

**Step 3: Confirm the downstream mutation chain is intact**

The action file calls `createFollowUpRecord` (internal mutation in `followUpMutations.ts`) to insert the `followUps` row, then calls `transitionToFollowUp` (also internal mutation in `followUpMutations.ts`). The `transitionToFollowUp` function now early-returns for `meeting_overran` (per 2D, Step 5) — which is exactly what we want. Nothing changes in this file beyond the guard.

**Key implementation notes:**
- **Two guards in the chain are fine.** The action calls `assertOverranReviewStillPendingViaQuery` (query-backed check). The downstream internal mutation `transitionToFollowUp` independently calls `assertOverranReviewStillPending`. Both exist because the action → mutation chain runs in separate transactions, and a `resolved` review could theoretically be created between the two checks. Duplication here is defense-in-depth, not waste.
- **The `"use node"` files CAN import from `"../lib/overranReviewGuards"`** — non-"use node" modules are safe to import. Only Node.js-specific imports (e.g., `fs`, `crypto.createHash(...)`) are restricted to `"use node"` files themselves.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/followUp.ts` | Modify | Import + replace guard in `createFollowUp` action |

---

### 2F — `payments.ts::logPayment` — Replace Guard + Update Error Message

**Type:** Backend (mutation modification)
**Parallelizable:** Yes — independent of 2B, 2C, 2D, 2E. Depends only on 2A.

**What:** In `convex/closer/payments.ts::logPayment`, replace the blanket `meeting_overran` guard (~line 124–128) with `assertOverranReviewStillPending`. Update the `validateTransition` fallback error message to remove the stale `"in_progress"`-specific text.

**Why:** The closer may have genuinely attended the meeting and received payment — the v1 guard punishes honest closers. In v2, the closer logs the payment; the admin verifies against bank/Stripe; if fraudulent, the admin disputes, which invalidates the payment in Phase 3. The existing `VALID_TRANSITIONS.meeting_overran` already includes `"payment_received"`, so once the helper passes, the transition succeeds.

**Where:**
- `convex/closer/payments.ts` (modify)

**How:**

**Step 1: Add the helper import**

```typescript
// Path: convex/closer/payments.ts — imports section
import { assertOverranReviewStillPending } from "../lib/overranReviewGuards";
```

**Step 2: Locate the guard (~line 124–128) and replace**

**BEFORE:**

```typescript
// Path: convex/closer/payments.ts — logPayment handler

// ... meeting validation + opportunity validation ...

if (opportunity.status === "meeting_overran") {
  throw new Error(
    "This opportunity is under meeting-overran review and cannot be resolved by the closer.",
  );
}

// Validate status transition
if (!validateTransition(opportunity.status, "payment_received")) {
  throw new Error(
    `Cannot log payment for opportunity with status "${opportunity.status}". ` +
      `Only "in_progress" opportunities can receive payments.`
  );
}
```

**AFTER:**

```typescript
// Path: convex/closer/payments.ts — logPayment handler

// ... meeting validation + opportunity validation ...

// v2: Allow meeting_overran while review is pending. The closer may have
// genuinely received payment. If admin later disputes, Phase 3's resolveReview
// marks the payment record "disputed" and reverses tenant stats.
if (opportunity.status === "meeting_overran") {
  await assertOverranReviewStillPending(ctx, opportunity._id);
}

// Validate status transition
if (!validateTransition(opportunity.status, "payment_received")) {
  throw new Error(
    `Cannot log payment for opportunity with status "${opportunity.status}"`,
  );
}
```

**Step 3: Leave the rest of the handler unchanged**

The amount validation (`> 0`), currency validation, provider normalization, `ctx.db.insert("paymentRecords", ...)` call, `insertPaymentAggregate`, `ctx.db.patch(opportunity._id, { status: "payment_received", ... })`, `replaceOpportunityAggregate`, `updateTenantStats({ activeOpportunities: ..., wonDeals: 1, totalPaymentRecords: 1, totalRevenueMinor: amountMinor })`, domain event emission, and the `executeConversion(...)` auto-conversion call all remain as-is.

**Important:** `isActiveOpportunityStatus("meeting_overran")` returns `true`, so the existing line:

```typescript
activeOpportunities: isActiveOpportunityStatus(opportunity.status) ? -1 : 0,
```

correctly produces `-1` for a `meeting_overran → payment_received` transition. Auto-conversion proceeds correctly because `executeConversion` does not read `opportunity.status` — it uses `leadId` and the known `winningOpportunityId`.

**Key implementation notes:**
- **Auto-conversion runs normally.** The `executeConversion(...)` call at the end of `logPayment` creates a `customers` row, patches the lead to `"converted"`, and backfills `customerId` on payment records. This is the same behavior as `in_progress → payment_received` — no v2 change needed here.
- **If admin later disputes:** Phase 3's `resolveReview::disputed` branch uses `convex/lib/paymentHelpers.ts::rollbackCustomerConversionIfEmpty` to reverse the customer insert if this was the only payment. See Phase 3 plan for details.
- **Error-message change.** Removing the stale `Only "in_progress" opportunities can receive payments.` sentence — it's now false.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/payments.ts` | Modify | Import + replace guard + update error message in `logPayment` |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/lib/overranReviewGuards.ts` | Create | 2A (shared guard helper — 2 exports + 1 internalQuery) |
| `convex/closer/meetingActions.ts` | Modify | 2B (markAsLost) |
| `convex/closer/noShowActions.ts` | Modify | 2C (markNoShow — meeting status check + opportunity guard) |
| `convex/closer/followUpMutations.ts` | Modify | 2D (4 handlers: createSchedulingLinkFollowUp, confirmFollowUpScheduled, createManualReminderFollowUpPublic, transitionToFollowUp) |
| `convex/closer/followUp.ts` | Modify | 2E (createFollowUp action — ActionCtx variant) |
| `convex/closer/payments.ts` | Modify | 2F (logPayment) |

**Post-phase state:** The 7 v1 blanket guards are gone. Closer mutations accept `meeting_overran` input while the review is pending, reject once the review is resolved. Follow-up actions create records without transitioning the opportunity. Webhook pipeline handlers (`inviteeNoShow.ts`, `inviteeCanceled.ts`) are unchanged — they correctly continue to ignore webhook events on `meeting_overran` opportunities. `pnpm tsc --noEmit` passes.

**Critical path:** 2A is on the critical path (every other 2* subphase depends on it). 2B–2F run in parallel — pick whichever is easiest to start after 2A merges.
