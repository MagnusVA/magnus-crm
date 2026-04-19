# Phase 3 — Backend: Fathom Link & Disputed Resolution

**Goal:** Ship the three backend capabilities that make the v2 review loop correct: (1) a `saveFathomLink` mutation so closers and admins can record a Fathom recording URL on any meeting, (2) a `disputed` resolution action in `resolveReview` that reverts `meeting_overran`-derived outcomes (no-show, lost, payment_received, pending follow-ups) back to `meeting_overran` without deleting audit artifacts, and (3) `activeFollowUp` enrichment on review queries so the admin UI can correctly detect "closer already acted via a follow-up that did not transition the opportunity". After this phase, the backend end-to-end supports the full v2 flow; only the UI remains.

**Prerequisite:**
- **Phase 1 complete and deployed.** `meetings.fathomLink` / `fathomLinkSavedAt` fields exist and are typed; `meetingReviews.resolutionAction` union accepts `"disputed"`.
- **Phase 2 does NOT need to be complete** for Phase 3 to start — they touch different code regions of `meetingActions.ts` and have independent helper files. However, they **must both be complete before Phase 4/5 start** because the frontend relies on behaviors introduced in both.

**Runs in PARALLEL with:** Phase 2 (Backend — Replace Blanket Overran Guards). The shared files are:
- `convex/closer/meetingActions.ts`
  - Phase 2B modifies the existing `markAsLost` handler.
  - Phase 3A appends a new `saveFathomLink` export.
- `convex/closer/payments.ts`
  - Phase 2F modifies `logPayment`.
  - Phase 3B extracts `syncCustomerPaymentSummary`.

Coordinate the edits so 3A stays append-only in `meetingActions.ts`, while 2B remains a middle-of-file edit. In `payments.ts`, keep 3B's refactor at module scope and 2F's guard change inside `logPayment` so the changes merge cleanly.

**Skills to invoke:**
- `convex-setup-auth` — `saveFathomLink` follows the exact auth pattern from `updateMeetingNotes` (closer-or-admin role check, ownership check via `loadMeetingContext`). Confirm the pattern is applied verbatim.
- `convex-migration-helper` — The disputed flow reverses tenantStats and potentially deletes auto-converted customer records. Confirm that the sequence of writes (payment → stats → customer → lead) is idempotent-safe and that no intermediate state is observable externally (e.g., mid-rollback a lead shows `converted` while its customer row is deleted).
- `convex-performance-audit` — `listPendingReviews` currently does N+1 lookups across meetings/opportunities/closers/leads. Phase 3C adds one more per-review lookup for active follow-up. Confirm the added cost is acceptable (bounded to 1 extra indexed read per review, parallelized via `Promise.all`).

**Acceptance Criteria:**
1. A new mutation `api.closer.meetingActions.saveFathomLink` exists with args `{ meetingId: Id<"meetings">, fathomLink: string }` and succeeds when called by the meeting's assigned closer OR any tenant_master/tenant_admin in the meeting's tenant.
2. `saveFathomLink` rejects calls from a closer who is not the `assignedCloserId` of the meeting's opportunity with `"Not your meeting"`.
3. `saveFathomLink` rejects cross-tenant calls (e.g., tenant A admin attempting to save on tenant B meeting) with `"Meeting not found"`.
4. After `saveFathomLink({ meetingId, fathomLink: "https://fathom.video/call/abc" })`, `ctx.db.get(meetingId)` returns `meeting.fathomLink === "https://fathom.video/call/abc"` and `meeting.fathomLinkSavedAt` is a recent epoch millisecond.
5. A new file `convex/lib/paymentHelpers.ts` exports `syncCustomerPaymentSummary(ctx, customerId)`, `rollbackCustomerConversionIfEmpty(ctx, args)`, and `expirePendingFollowUpsForOpportunity(ctx, opportunityId)`. `convex/reporting/writeHooks.ts` also exports a concrete `deleteCustomerAggregate(ctx, customerId)` helper that the rollback flow uses. The existing `syncCustomerPaymentSummary` in `convex/closer/payments.ts` and `convex/lib/outcomeHelpers.ts` is refactored to import from the new central module.
6. `resolveReview` accepts `resolutionAction: "disputed"` and, when invoked after a closer-applied terminal outcome (`no_show` / `lost` / `payment_received`), reverts the opportunity to `meeting_overran` and the meeting (if meeting-level) to `meeting_overran`. For follow-up-only cases where the opportunity never left `meeting_overran`, it expires pending follow-ups and finalizes the review without inventing a status transition.
7. When `resolveReview({ resolutionAction: "disputed" })` is called on an opportunity whose previous status was `payment_received`, the linked `paymentRecords` row for this opportunity/meeting is patched to `status: "disputed"`, `statusChangedAt: now`; `tenantStats.wonDeals` decrements by 1, `tenantStats.totalPaymentRecords` decrements by 1, `tenantStats.totalRevenueMinor` decrements by `payment.amountMinor`.
8. When disputing a payment that auto-converted a customer AND that payment was the sole non-disputed payment for the customer AND `customer.winningOpportunityId === opportunity._id`: the customer row is deleted, the customer aggregate row is deleted, all `paymentRecords` previously linked to the customer have their `customerId` cleared, the lead is patched back to `status: "active"`, `tenantStats.totalCustomers` decrements by 1, `tenantStats.totalLeads` increments by 1 (re-activating the lead).
9. When disputing, all `followUps` rows where `opportunityId === opportunity._id` AND `status === "pending"` are patched to `status: "expired"`. Rows with status `booked` or `completed` are left untouched (audit preservation).
10. `resolveReview` rejects direct-override actions (`log_payment`, `schedule_follow_up`, `mark_no_show`, `mark_lost`) when the closer has already acted (opportunity.status !== "meeting_overran" OR an active follow-up exists on an overran opportunity) with error `"Direct override actions are only available before the closer has already acted."`. Only `acknowledged` and `disputed` are permitted in that state.
11. `api.reviews.queries.listPendingReviews` enriches each row with `activeFollowUp: { type, status, reminderScheduledAt? } | null` — the latest pending follow-up for the review's `opportunityId`, regardless of type.
12. `api.reviews.queries.getReviewDetail` includes the same `activeFollowUp` shape in its return object.
13. Every disputed transition emits exactly one `opportunity.status_changed` domain event with `fromStatus: <current>` and `toStatus: "meeting_overran"`, and one `meeting.overran_review_resolved` domain event with `metadata.resolutionAction: "disputed"`, `metadata.previousOpportunityStatus`, `metadata.previousMeetingStatus`, and `metadata.paymentDisputed: boolean`.
14. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (saveFathomLink mutation — meetingActions.ts) ────────────────────────────────┐
                                                                                  │
3B (lib/paymentHelpers.ts — new shared helpers) ──┬── 3D (resolveReview — disputed branch uses helpers)
                                                  │
3C (reviews/queries.ts — activeFollowUp enrichment) ──────────────────────────────┘

3A, 3B, 3C can all run in parallel. 3D depends on 3B AND 3C.
```

**Optimal execution:**
1. Start **3A, 3B, 3C in parallel** — they touch different files entirely. 3A adds a new mutation; 3B adds a new helper file; 3C modifies the reviews query file. No shared state.
2. Once **3B and 3C are both merged** (or at least stable), start **3D** — the `resolveReview` mutation modification imports from 3B and uses the `activeFollowUp` lookup logic that 3C now exposes on reviews.

**Estimated time:** 2 days (16 hours — 2 hours for 3A, 3 hours for 3B with 3 helpers, 2 hours for 3C, 7 hours for 3D because the disputed branch is the most complex logic in the entire v2 rollout, plus 2 hours for verification).

---

## Subphases

### 3A — New Mutation: `saveFathomLink` in `convex/closer/meetingActions.ts`

**Type:** Backend (new mutation)
**Parallelizable:** Yes — independent of 3B, 3C, 3D. Only shared file is `meetingActions.ts` but the edit is an **append** (new export), not a modification of `markAsLost`.

**What:** A new public `mutation` exported from `convex/closer/meetingActions.ts` called `saveFathomLink`. Takes `meetingId` and `fathomLink` as arguments. Authenticates via `requireTenantUser(ctx, ["closer", "tenant_master", "tenant_admin"])` (identical to `updateMeetingNotes`). Validates tenant + ownership. Trims the input, rejects empty strings, patches the meeting with `{ fathomLink, fathomLinkSavedAt: Date.now() }`.

**Why:** Phase 4 (`FathomLinkField` component) needs a server endpoint to persist the Fathom recording URL. The admin review pipeline (Phase 5) reads this URL to evaluate Fathom evidence. The mutation is a meeting attribute write — it has no dependency on whether the meeting has a review or what the review state is, because the field is general-purpose (applies to every meeting, not just flagged ones).

**Where:**
- `convex/closer/meetingActions.ts` (modify — append new export)

**How:**

**Step 1: Confirm the existing `updateMeetingNotes` pattern**

The existing `updateMeetingNotes` mutation (~line 46–69 of `meetingActions.ts`) is:

```typescript
// Path: convex/closer/meetingActions.ts — EXISTING, DO NOT MODIFY

export const updateMeetingNotes = mutation({
  args: {
    meetingId: v.id("meetings"),
    notes: v.string(),
  },
  handler: async (ctx, { meetingId, notes }) => {
    console.log("[Closer:Meeting] updateMeetingNotes called", { meetingId });
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    console.log("[Closer:Meeting] updateMeetingNotes auth check passed", { userId, role });
    const { opportunity } = await loadMeetingContext(ctx, meetingId, tenantId);

    // Closer authorization: only own meetings
    if (role === "closer" && opportunity.assignedCloserId !== userId) {
      throw new Error("Not your meeting");
    }

    await ctx.db.patch(meetingId, { notes });
    console.log("[Closer:Meeting] updateMeetingNotes completed", { meetingId });
  },
});
```

`saveFathomLink` mirrors this exactly, with three differences: (1) different field name, (2) timestamp alongside the value, (3) a trim + empty check on the input string.

**Step 2: Append the new mutation at the end of the file**

```typescript
// Path: convex/closer/meetingActions.ts — new export, append at end of file

/**
 * Save a Fathom recording link on a meeting.
 *
 * v2: The Fathom recording URL is the primary attendance artifact for any
 * meeting — not just flagged ones. Closers can save on own meetings;
 * admins can save on any meeting within their tenant. The mutation has no
 * status-based restrictions — it works on meetings in any state, at any
 * time in the meeting lifecycle (before, during, after, or post-review).
 */
export const saveFathomLink = mutation({
  args: {
    meetingId: v.id("meetings"),
    fathomLink: v.string(),
  },
  handler: async (ctx, { meetingId, fathomLink: rawLink }) => {
    console.log("[Closer:Meeting] saveFathomLink called", { meetingId });
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    console.log("[Closer:Meeting] saveFathomLink auth check passed", { userId, role });

    const { opportunity } = await loadMeetingContext(ctx, meetingId, tenantId);

    // Closer authorization: only own meetings
    if (role === "closer" && opportunity.assignedCloserId !== userId) {
      throw new Error("Not your meeting");
    }

    const trimmed = rawLink.trim();
    if (!trimmed) {
      throw new Error("Fathom link is required");
    }
    // No URL validation — the Fathom link is plain string evidence. See
    // Section 13.4 of overhaul-v2.md: the admin visually inspects the link.
    // Any further validation is a future Fathom API integration concern.

    const now = Date.now();
    await ctx.db.patch(meetingId, {
      fathomLink: trimmed,
      fathomLinkSavedAt: now,
    });

    console.log("[Closer:Meeting] saveFathomLink completed", {
      meetingId,
      fathomLinkSavedAt: now,
    });
  },
});
```

**Step 3: Verify `api.closer.meetingActions.saveFathomLink` is exposed**

After `npx convex dev` regenerates `api.d.ts`, the new mutation should be callable from the frontend as:

```typescript
// Frontend usage (Phase 4):
const saveFathomLink = useMutation(api.closer.meetingActions.saveFathomLink);
await saveFathomLink({ meetingId, fathomLink: "..." });
```

**Key implementation notes:**
- **Identical auth pattern to `updateMeetingNotes`.** The Fathom link is a meeting attribute, not a review artifact — closers and admins manage it the same way.
- **`loadMeetingContext` is the right helper.** It validates the meeting exists, belongs to the tenant, and loads the parent opportunity (needed for the closer ownership check).
- **`.trim()` + empty check is sufficient normalization.** The backend does not validate URL format — by design (Section 13.4 of overhaul-v2.md).
- **`fathomLinkSavedAt` is always updated on save.** Even re-saving the same URL refreshes the timestamp. This is acceptable — the UI can show "Last saved at 3:15 PM" and re-saves are expected to be rare.
- **No status-based restriction.** Even after a review is resolved, the closer / admin can still save/update the Fathom link (Section 14.2 of overhaul-v2.md — "Fathom Link Saved After Review Is Resolved"). Phase 5's review detail view will show the newly-saved link if the admin re-opens the page.
- **Idempotent.** Double-submit (via React Strict Mode, network retry, double-click) is safe — the second write overwrites the first with the same value + a slightly later timestamp.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/meetingActions.ts` | Modify | Append new `saveFathomLink` mutation |

---

### 3B — New Shared Helpers: `convex/lib/paymentHelpers.ts`

**Type:** Backend (new module + refactor)
**Parallelizable:** Yes — independent of 3A, 3C, 3D authoring, though 3D will import from this file.

**What:** Create `convex/lib/paymentHelpers.ts` with three exports:

1. **`syncCustomerPaymentSummary(ctx, customerId)`** — extracted from the existing duplicate copies in `convex/closer/payments.ts` (lines 19–40) and `convex/lib/outcomeHelpers.ts` (lines 28–51). Both call sites will be updated to import from the new central module.
2. **`rollbackCustomerConversionIfEmpty(ctx, { customerId, opportunityId })`** — new. Used by Phase 3D's `resolveReview::disputed` branch. If the disputed payment was the only non-disputed payment for the customer AND the customer's `winningOpportunityId === opportunityId`, deletes the customer record, deletes the customer aggregate row, clears `customerId` on all linked disputed payments, patches the lead back to `status: "active"`, and reverses `tenantStats.totalCustomers` / `totalLeads`.
3. **`expirePendingFollowUpsForOpportunity(ctx, opportunityId)`** — new. Used by Phase 3D's `resolveReview::disputed` branch. Marks all `followUps` rows with `opportunityId === <arg>` AND `status === "pending"` as `status: "expired"`. Does NOT touch rows with status `booked` or `completed` — those are preserved for audit.

**Why:** The disputed resolution flow touches payment summaries, customer conversions, and pending follow-ups. The logic is complex enough that inlining it in `resolveReview` would make that handler unreadable. Extracting to helpers (a) keeps `resolveReview` focused on orchestration, (b) makes each unit independently testable, (c) gives Phase 6's reporting reconciliation work a stable API to call later, and (d) eliminates the pre-existing duplication of `syncCustomerPaymentSummary` across two files.

**Where:**
- `convex/lib/paymentHelpers.ts` (new)
- `convex/closer/payments.ts` (modify — replace inline `syncCustomerPaymentSummary` with import)
- `convex/lib/outcomeHelpers.ts` (modify — replace inline `syncCustomerPaymentSummary` with import)
- `convex/reporting/writeHooks.ts` (modify — add `deleteCustomerAggregate`)

**How:**

**Step 1: Create the new helper module**

```typescript
// Path: convex/lib/paymentHelpers.ts

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { updateTenantStats } from "./tenantStatsHelper";
import { emitDomainEvent } from "./domainEvents";
import { deleteCustomerAggregate } from "../reporting/writeHooks";

/**
 * Recompute a customer's payment totals from all non-disputed payment records.
 *
 * Extracted from convex/closer/payments.ts and convex/lib/outcomeHelpers.ts
 * (both had the same implementation). Sum and count only include payments
 * where `status !== "disputed"`. Currency is set only when all non-disputed
 * payments share a single currency — otherwise undefined.
 */
export async function syncCustomerPaymentSummary(
  ctx: MutationCtx,
  customerId: Id<"customers">,
): Promise<void> {
  const payments = await ctx.db
    .query("paymentRecords")
    .withIndex("by_customerId", (q) => q.eq("customerId", customerId))
    .take(100);

  const nonDisputed = payments.filter((p) => p.status !== "disputed");
  const currencies = Array.from(new Set(nonDisputed.map((p) => p.currency)));

  await ctx.db.patch(customerId, {
    totalPaidMinor: nonDisputed.reduce((sum, p) => sum + p.amountMinor, 0),
    totalPaymentCount: nonDisputed.length,
    paymentCurrency: currencies.length === 1 ? currencies[0] : undefined,
  });
}

/**
 * Expire all pending follow-ups for an opportunity.
 *
 * Used by the dispute flow: when an admin disputes a review, any pending
 * scheduling-link or manual-reminder follow-up should stop acting as live
 * workflow. We mark them `expired` (not delete) so audit history is preserved.
 *
 * Rows already in `booked` or `completed` state are NOT touched — those
 * represent real downstream history (the lead did book; the reminder did fire)
 * and must remain as-is regardless of dispute.
 */
export async function expirePendingFollowUpsForOpportunity(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<number> {
  const pending = await ctx.db
    .query("followUps")
    .withIndex("by_opportunityId_and_status", (q) =>
      q.eq("opportunityId", opportunityId).eq("status", "pending"),
    )
    .take(50);

  const now = Date.now();
  for (const followUp of pending) {
    await ctx.db.patch(followUp._id, { status: "expired" });
    await emitDomainEvent(ctx, {
      tenantId: followUp.tenantId,
      entityType: "followUp",
      entityId: followUp._id,
      eventType: "followUp.expired",
      source: "admin",
      fromStatus: "pending",
      toStatus: "expired",
      reason: "review_disputed",
      occurredAt: now,
    });
  }

  return pending.length;
}

/**
 * Roll back a customer auto-conversion if the disputed payment left the
 * customer with zero non-disputed payments AND the disputed opportunity was
 * the winning opportunity.
 *
 * Steps (all in the same transaction):
 *   1. Load the customer.
 *   2. Recompute non-disputed payments across the customer.
 *   3. If non-disputed count > 0, just resync the summary and return.
 *   4. If non-disputed count === 0 AND customer.winningOpportunityId matches:
 *      a. Clear `customerId` on all payments previously linked to this customer
 *         (so the disputed payment is orphaned from the customer but still
 *         preserved as an audit record).
 *      b. Delete the customers row (ctx.db.delete(customerId)).
 *      c. Delete the customer aggregate row via reporting write hook (follow
 *         the existing conversion rollback pattern from Feature D).
 *      d. Patch the lead back to status: "active".
 *      e. Reverse tenantStats: { totalCustomers: -1, totalLeads: +1 }.
 *      f. Emit `customer.conversion_rolled_back` domain event.
 *   5. If non-disputed count === 0 BUT customer.winningOpportunityId does
 *      NOT match (e.g., the customer was converted via a different opp,
 *      this opp's payment was a secondary sale): keep the customer, just
 *      resync the summary.
 *
 * Returns `{ rolledBack: boolean, customerDeleted: boolean }`.
 */
export async function rollbackCustomerConversionIfEmpty(
  ctx: MutationCtx,
  args: {
    customerId: Id<"customers">;
    opportunityId: Id<"opportunities">;
    actorUserId: Id<"users">;
  },
): Promise<{ rolledBack: boolean }> {
  const customer = await ctx.db.get(args.customerId);
  if (!customer) {
    // Customer already gone — nothing to roll back.
    return { rolledBack: false };
  }

  const payments = await ctx.db
    .query("paymentRecords")
    .withIndex("by_customerId", (q) => q.eq("customerId", args.customerId))
    .take(100);

  const nonDisputed = payments.filter((p) => p.status !== "disputed");

  if (nonDisputed.length > 0) {
    // Customer still has live payments — keep the record, just resync.
    await syncCustomerPaymentSummary(ctx, args.customerId);
    return { rolledBack: false };
  }

  if (customer.winningOpportunityId !== args.opportunityId) {
    // The disputed opportunity was NOT the winning opp. This customer was
    // converted through a different opportunity. Keep the customer even
    // though this disputed payment contributed to its totals at some point;
    // syncing zeroes this opp's contribution out of totalPaidMinor.
    await syncCustomerPaymentSummary(ctx, args.customerId);
    return { rolledBack: false };
  }

  // Full rollback: this disputed opp was the winning opp AND there are no
  // other non-disputed payments. Delete the customer.
  const now = Date.now();

  // Step 4a: orphan the disputed payments from the customer.
  for (const payment of payments) {
    await ctx.db.patch(payment._id, { customerId: undefined });
  }

  // Step 4b: load lead for re-activation before we lose the reference
  const lead = await ctx.db.get(customer.leadId);

  // Step 4c: delete the reporting aggregate row using the new write-hook
  // companion introduced in this subphase.
  await deleteCustomerAggregate(ctx, customer._id);

  // Step 4d: delete customer row
  await ctx.db.delete(args.customerId);

  // Step 4e: patch lead back to active (only if it was converted).
  if (lead && lead.status === "converted") {
    await ctx.db.patch(lead._id, { status: "active", updatedAt: now });
    await emitDomainEvent(ctx, {
      tenantId: lead.tenantId,
      entityType: "lead",
      entityId: lead._id,
      eventType: "lead.status_changed",
      source: "admin",
      actorUserId: args.actorUserId,
      fromStatus: "converted",
      toStatus: "active",
      reason: "customer_conversion_rolled_back_via_dispute",
      occurredAt: now,
    });
  }

  // Step 4f: reverse tenant stats.
  await updateTenantStats(ctx, customer.tenantId, {
    totalCustomers: -1,
    totalLeads: lead?.status === "converted" ? 1 : 0,
  });

  await emitDomainEvent(ctx, {
    tenantId: customer.tenantId,
    entityType: "customer",
    entityId: args.customerId,
    eventType: "customer.conversion_rolled_back",
    source: "admin",
    actorUserId: args.actorUserId,
    fromStatus: "active",
    reason: "review_disputed",
    metadata: {
      leadId: customer.leadId,
      winningOpportunityId: args.opportunityId,
      paymentsOrphaned: payments.length,
    },
    occurredAt: now,
  });

  return { rolledBack: true };
}
```

**Step 2: Refactor `convex/closer/payments.ts` to import the shared `syncCustomerPaymentSummary`**

```typescript
// Path: convex/closer/payments.ts — imports section

// BEFORE:
// (inline definition of syncCustomerPaymentSummary at lines 19–40)

// AFTER:
import { syncCustomerPaymentSummary } from "../lib/paymentHelpers";
// DELETE the inline function definition (lines 19–40). Everything else in
// the file is unchanged. Callers at lines 237 and 255 continue to use
// `syncCustomerPaymentSummary(...)` — the imported version has the
// identical signature.
```

**Step 3: Refactor `convex/lib/outcomeHelpers.ts` the same way**

```typescript
// Path: convex/lib/outcomeHelpers.ts — imports section

// BEFORE:
// (inline definition of syncCustomerPaymentSummary at lines 28–51)

// AFTER:
import { syncCustomerPaymentSummary } from "./paymentHelpers";
// DELETE the inline function definition. Callers continue using the same name.
```

Note: `outcomeHelpers.ts` imports from a sibling inside `lib/`, so the path is `./paymentHelpers` (not `../lib/paymentHelpers`).

**Step 4: Add `deleteCustomerAggregate` to the reporting write hooks**

```typescript
// Path: convex/reporting/writeHooks.ts

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  customerConversions,
  leadTimeline,
  meetingsByStatus,
  opportunityByStatus,
  paymentSums,
} from "./aggregates";

export async function deleteCustomerAggregate(
  ctx: MutationCtx,
  customerId: Id<"customers">,
): Promise<void> {
  const customer = await ctx.db.get(customerId);
  if (!customer) {
    return;
  }
  await customerConversions.delete(ctx, customer);
}
```

**Key implementation notes:**
- **`rollbackCustomerConversionIfEmpty` is the most consequential helper in the whole v2 rollout.** It must correctly mirror the Feature D conversion flow in reverse. This subphase makes the reporting rollback concrete by adding `deleteCustomerAggregate(...)` alongside the existing insert-side write hook.
- **Lead re-activation is conditional.** If the lead is already in another state (`churned`, etc.) we do NOT blindly force it back to `active`. Only `converted → active` is reversed.
- **Pending follow-ups are expired via a separate helper** (`expirePendingFollowUpsForOpportunity`) — not inside `rollbackCustomerConversionIfEmpty`. The dispute orchestration in 3D calls both: one for follow-ups, one for customer rollback. This separation means a dispute on a non-payment flow (e.g., dispute on a `lost` or `no_show` outcome) only calls the follow-up expiration helper, not the customer rollback.
- **`syncCustomerPaymentSummary` deliberately filters `status !== "disputed"` already.** When the dispute flow marks a payment as disputed and THEN calls `syncCustomerPaymentSummary`, the disputed payment is excluded from totals. This is intentional.
- **Bound the `take(100)` on payment queries.** In practice, a customer has < 20 payments. 100 is defensive.
- **Domain events use `source: "admin"`** consistently in dispute flows because the review resolution is always initiated by a tenant_master/tenant_admin.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/paymentHelpers.ts` | Create | New helper module — 3 exports |
| `convex/closer/payments.ts` | Modify | Delete inline `syncCustomerPaymentSummary`; import from shared module |
| `convex/lib/outcomeHelpers.ts` | Modify | Delete inline `syncCustomerPaymentSummary`; import from shared module |
| `convex/reporting/writeHooks.ts` | Modify | Add `deleteCustomerAggregate` helper for rollback path |

---

### 3C — Review Queries: Add `activeFollowUp` Enrichment

**Type:** Backend (query modification)
**Parallelizable:** Yes — independent of 3A, 3B. 3D will consume the new field on the server side for the "closer already acted" check.

**What:** In `convex/reviews/queries.ts`, add an `activeFollowUp` field to the return shape of both `listPendingReviews` (row-level) and `getReviewDetail` (top-level). The new field is the **latest** pending `followUps` row for the review's `opportunityId`, or `null` if none exists.

**Why:** When an admin opens a review whose opportunity status is still `meeting_overran` but the closer has already created a scheduling-link or manual-reminder follow-up (which does NOT transition the opportunity — see Phase 2D), the admin UI must detect "closer already acted" and narrow the resolution actions to `acknowledged`/`disputed`. Without this enrichment, the UI has no way to know about the follow-up — the status is still `meeting_overran`, so the UI would incorrectly offer all direct-override actions.

**Where:**
- `convex/reviews/queries.ts` (modify)

**How:**

**Step 1: Add a helper to look up the active follow-up**

Place at the top of `convex/reviews/queries.ts`, under existing imports:

```typescript
// Path: convex/reviews/queries.ts — add near top

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

type ActiveFollowUpSummary = {
  _id: Id<"followUps">;
  type: "scheduling_link" | "manual_reminder";
  status: "pending"; // narrowed — we only return pending rows
  createdAt: number;
  reminderScheduledAt?: number;
};

async function loadActiveFollowUp(
  ctx: QueryCtx,
  opportunityId: Id<"opportunities">,
): Promise<ActiveFollowUpSummary | null> {
  const followUps = await ctx.db
    .query("followUps")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
    .take(20);

  const followUp =
    followUps
      .filter((candidate) => candidate.status === "pending")
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;

  if (!followUp) return null;

  return {
    _id: followUp._id,
    type: followUp.type,
    status: "pending" as const,
    createdAt: followUp.createdAt,
    reminderScheduledAt: followUp.reminderScheduledAt,
  };
}
```

**Step 2: Extend `listPendingReviews` to include `activeFollowUp` per row**

Modify the return-map block (currently lines 63–95):

```typescript
// Path: convex/reviews/queries.ts — listPendingReviews

// BEFORE (inside handler, after loading meetings/opportunities/closers/leads):
return reviews.map((review) => {
  // ... existing row assembly ...
  return {
    review,
    meeting,
    opportunity,
    // ...
    opportunityStatus: opportunity?.status ?? null,
  };
});

// AFTER: load active follow-ups in parallel (one per review).
const activeFollowUps = await Promise.all(
  reviews.map((review) => loadActiveFollowUp(ctx, review.opportunityId)),
);
const activeFollowUpByReviewId = new Map(
  reviews.map((review, idx) => [review._id, activeFollowUps[idx]] as const),
);

return reviews.map((review) => {
  const meeting = meetingById.get(review.meetingId) ?? null;
  const opportunity = opportunityById.get(review.opportunityId) ?? null;
  const lead =
    opportunity && leadById.has(opportunity.leadId)
      ? (leadById.get(opportunity.leadId) ?? null)
      : null;
  const closer = closerById.get(review.closerId) ?? null;

  return {
    review,
    meeting,
    opportunity,
    lead,
    closer,
    meetingScheduledAt: meeting?.scheduledAt ?? null,
    meetingDurationMinutes: meeting?.durationMinutes ?? null,
    leadName: lead?.fullName ?? lead?.email ?? "Unknown",
    leadEmail: lead?.email ?? null,
    closerName: closer?.fullName ?? closer?.email ?? "Unknown",
    closerEmail: closer?.email ?? null,
    opportunityStatus: opportunity?.status ?? null,
    // v2: surface active follow-up so the admin UI can detect
    // "closer already acted" even when opportunity is still meeting_overran.
    activeFollowUp: activeFollowUpByReviewId.get(review._id) ?? null,
  };
});
```

**Step 3: Extend `getReviewDetail` to include `activeFollowUp` at top level**

Modify the return block (currently lines 125–135):

```typescript
// Path: convex/reviews/queries.ts — getReviewDetail

// BEFORE (inside handler, after loading meeting/opportunity/closer/resolver/lead):
return {
  review,
  meeting,
  opportunity,
  // ...
  resolverName: resolver?.fullName ?? resolver?.email ?? null,
};

// AFTER:
const activeFollowUp = await loadActiveFollowUp(ctx, opportunity._id);

return {
  review,
  meeting,
  opportunity,
  lead,
  closer,
  resolver,
  closerName: closer?.fullName ?? closer?.email ?? "Unknown",
  closerEmail: closer?.email ?? null,
  resolverName: resolver?.fullName ?? resolver?.email ?? null,
  activeFollowUp,
};
```

**Key implementation notes:**
- **Uses the existing `by_opportunityId` index.** No new schema index required. We intentionally select the latest pending follow-up by `createdAt` in userland because the current status index does not encode recency.
- **Latest matters.** The design resolves this as "latest active follow-up", not an arbitrary pending row. We therefore sort the bounded result set by `createdAt` descending before selecting.
- **Parallelizes lookups with `Promise.all` for `listPendingReviews`.** If there are N pending reviews, we issue N parallel indexed queries. Bounded by the number of reviews fetched (typically ≤ 50 via `listReviewsByStatus`).
- **The returned `type` literal union narrows `followUps.type` to the two possible values.** Downstream admin UI in Phase 5 switches on this type for messaging.
- **Do NOT include booked/completed/expired follow-ups.** The UI is checking for **live** workflow. A `booked` follow-up has already resulted in a new opportunity (via pipeline), and a `completed` reminder has already been acted upon.
- **`reminderScheduledAt` is optional** — only present for `manual_reminder` type. Scheduling links don't have a reminder timestamp.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reviews/queries.ts` | Modify | Add `loadActiveFollowUp` helper + `activeFollowUp` enrichment to both queries |

---

### 3D — `resolveReview` — Add `disputed` Action + Closer-Already-Acted Gate

**Type:** Backend (mutation modification — the most complex subphase in the v2 rollout)
**Parallelizable:** No — must run AFTER 3B (imports from paymentHelpers) and AFTER 3C (uses the same active-follow-up lookup pattern server-side).

**What:** Modify `convex/reviews/mutations.ts::resolveReview` to:
1. Expand the `resolutionAction` union validator to include `v.literal("disputed")`.
2. Add a "closer already acted" detection block that throws when the admin tries to use a direct-override action (`log_payment`, `schedule_follow_up`, `mark_no_show`, `mark_lost`) while the closer has already acted (opportunity status moved away from `meeting_overran` OR an active follow-up exists on a still-overran opportunity).
3. Handle `disputed` as a new branch: revert the opportunity and meeting back to `meeting_overran`, invalidate any disputed payment, expire pending follow-ups, roll back auto-converted customers if applicable.
4. Keep the existing `acknowledged`, `log_payment`, `mark_no_show`, `mark_lost`, and false-positive correction branches aligned with current behavior except for the closer-already-acted gate, but change `schedule_follow_up` so it resolves the review after creating the follow-up **without** transitioning the opportunity away from `meeting_overran`.

**Why:** This is the core behavior change of v2 on the admin side. The disputed branch is the mechanism that gives the admin enforcement power when a closer fakes an outcome. Getting the rollback correct (especially the payment + customer + lead reverse) determines whether the audit trail is sound and whether tenant stats stay consistent. The closer-already-acted gate prevents the admin from double-acting on an outcome the closer already chose — the admin can only validate (acknowledge) or reject (dispute), not replace.

**Where:**
- `convex/reviews/mutations.ts` (modify)

**How:**

**Step 1: Expand imports**

```typescript
// Path: convex/reviews/mutations.ts — imports section

// ADD:
import type { Id } from "../_generated/dataModel";
import {
  expirePendingFollowUpsForOpportunity,
  rollbackCustomerConversionIfEmpty,
  syncCustomerPaymentSummary,
} from "../lib/paymentHelpers";

// Existing imports remain:
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { mutation } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { createManualReminder, createPaymentRecord } from "../lib/outcomeHelpers";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";
import { validateMeetingTransition, validateTransition } from "../lib/statusTransitions";
import { isActiveOpportunityStatus, updateTenantStats } from "../lib/tenantStatsHelper";
import { requireTenantUser } from "../requireTenantUser";
import { replaceMeetingAggregate, replaceOpportunityAggregate } from "../reporting/writeHooks";
```

**Step 2: Expand the `resolutionAction` union validator**

```typescript
// Path: convex/reviews/mutations.ts — resolveReview args

resolutionAction: v.union(
  v.literal("log_payment"),
  v.literal("schedule_follow_up"),
  v.literal("mark_no_show"),
  v.literal("mark_lost"),
  v.literal("acknowledged"),
  v.literal("disputed"), // v2
),
```

**Step 3: Add a helper — load the latest active follow-up for the review**

Insert at the top of `resolveReview` handler, BEFORE the branch selection:

```typescript
// Path: convex/reviews/mutations.ts — resolveReview handler, after loading review/meeting/opportunity

// v2: Detect "closer already acted" state.
// The closer already acted if either:
//   (a) opportunity.status is not meeting_overran anymore (closer ran
//       markAsLost / markNoShow / logPayment while review was pending), or
//   (b) opportunity is still meeting_overran but has an active follow-up
//       (createSchedulingLinkFollowUp / createManualReminderFollowUpPublic
//       created a followUps row without transitioning the opportunity).
const followUps = await ctx.db
  .query("followUps")
  .withIndex("by_opportunityId", (q) => q.eq("opportunityId", review.opportunityId))
  .take(20);

const activeFollowUp =
  followUps
    .filter((candidate) => candidate.status === "pending")
    .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;

const closerAlreadyActed =
  opportunity.status !== "meeting_overran" || activeFollowUp !== null;

// Direct-override actions (log_payment, schedule_follow_up, mark_no_show,
// mark_lost) are only valid BEFORE the closer acts. After the closer acts,
// only acknowledged and disputed are permitted.
if (
  closerAlreadyActed &&
  args.resolutionAction !== "acknowledged" &&
  args.resolutionAction !== "disputed"
) {
  throw new Error(
    "Direct override actions are only available before the closer has already acted. " +
      "Use 'acknowledged' to accept the closer's outcome or 'disputed' to revert it.",
  );
}
```

**Step 4: Keep the existing `acknowledged` branch as-is** (lines 111–138 of current file).

**Step 5: Add a new `disputed` branch**

Insert AFTER the existing `acknowledged` branch, BEFORE the `targetOpportunityStatus` switch that handles direct overrides:

```typescript
// Path: convex/reviews/mutations.ts — resolveReview handler

if (args.resolutionAction === "disputed") {
  const now = Date.now();
  const previousOpportunityStatus = opportunity.status;
  const previousMeetingStatus = meeting.status;

  // --- Payment invalidation (if the closer logged a payment) ---
  // If opportunity is currently payment_received, find the corresponding
  // paymentRecords row and mark it disputed.
  let paymentDisputed = false;
  let disputedPaymentCustomerId: Id<"customers"> | null = null;
  let disputedPaymentAmountMinor = 0;

  if (previousOpportunityStatus === "payment_received") {
    // Load the payment record written during logPayment.
    // Per paymentRecords index `by_opportunityId` on the table, query by opportunityId.
    const payments = await ctx.db
      .query("paymentRecords")
      .withIndex("by_opportunityId", (q) => q.eq("opportunityId", review.opportunityId))
      .take(50);

    // Find the non-disputed payment for this meeting. In normal flow there's
    // exactly one non-disputed payment for this opportunity/meeting. If there
    // are multiples, we dispute the one tied to this meeting.
    const targetPayment = payments.find(
      (p) => p.status !== "disputed" && p.meetingId === review.meetingId,
    );

    if (targetPayment) {
      paymentDisputed = true;
      disputedPaymentCustomerId = targetPayment.customerId ?? null;
      disputedPaymentAmountMinor = targetPayment.amountMinor;

      await ctx.db.patch(targetPayment._id, {
        status: "disputed",
        statusChangedAt: now,
      });
      await emitDomainEvent(ctx, {
        tenantId,
        entityType: "payment",
        entityId: targetPayment._id,
        eventType: "payment.disputed",
        source: "admin",
        actorUserId: userId,
        fromStatus: targetPayment.status,
        toStatus: "disputed",
        reason: "review_disputed",
        metadata: {
          reviewId: args.reviewId,
          opportunityId: review.opportunityId,
          meetingId: review.meetingId,
          amountMinor: targetPayment.amountMinor,
          currency: targetPayment.currency,
        },
        occurredAt: now,
      });
    }
  }

  // --- Revert opportunity to meeting_overran ---
  // This is an admin override — bypass validateTransition. The reverse
  // transition is intentionally NOT in VALID_TRANSITIONS so no other code
  // path can accidentally perform it.
  await ctx.db.patch(opportunity._id, {
    status: "meeting_overran",
    updatedAt: now,
    // Clear terminal-state timestamps if present (so status drift is clean):
    ...(previousOpportunityStatus === "payment_received"
      ? { paymentReceivedAt: undefined }
      : {}),
    ...(previousOpportunityStatus === "lost"
      ? { lostAt: undefined, lostByUserId: undefined, lostReason: undefined }
      : {}),
    ...(previousOpportunityStatus === "no_show"
      ? { noShowAt: undefined }
      : {}),
  });
  await replaceOpportunityAggregate(ctx, opportunity, opportunity._id);

  // --- Revert meeting to meeting_overran if the closer transitioned it ---
  // The only meeting-level transition a closer can perform on an overran
  // meeting is `meeting_overran → no_show` (via markNoShow). Revert it.
  if (previousMeetingStatus === "no_show") {
    await ctx.db.patch(meeting._id, {
      status: "meeting_overran",
      // Clear no-show side-effect fields:
      noShowMarkedAt: undefined,
      noShowWaitDurationMs: undefined,
      noShowReason: undefined,
      noShowNote: undefined,
      noShowMarkedByUserId: undefined,
      noShowSource: undefined,
    });
    await replaceMeetingAggregate(ctx, meeting, meeting._id);
  }

  // --- Expire pending follow-ups ---
  // If closer created a scheduling link or manual reminder, mark them expired.
  // This stops them acting as live workflow; audit rows remain.
  await expirePendingFollowUpsForOpportunity(ctx, opportunity._id);

  // --- Reverse tenant stats ---
  // Compute delta from previous status → meeting_overran.
  // meeting_overran IS active, so:
  //   no_show → meeting_overran: no_show is inactive, meeting_overran is active ⇒ +1
  //   lost → meeting_overran: lost is inactive, meeting_overran is active ⇒ +1
  //   payment_received → meeting_overran: payment_received inactive, meeting_overran active ⇒ +1
  //   legacy follow_up_scheduled → meeting_overran: both active ⇒ 0
  const activeDelta = getActiveOpportunityDelta(previousOpportunityStatus, "meeting_overran");
  const statsDelta: Parameters<typeof updateTenantStats>[2] = {
    ...(activeDelta !== 0 ? { activeOpportunities: activeDelta } : {}),
    ...(previousOpportunityStatus === "lost" ? { lostDeals: -1 } : {}),
    ...(previousOpportunityStatus === "payment_received"
      ? {
          wonDeals: -1,
          totalPaymentRecords: -1,
          totalRevenueMinor: -disputedPaymentAmountMinor,
        }
      : {}),
  };
  if (Object.keys(statsDelta).length > 0) {
    await updateTenantStats(ctx, tenantId, statsDelta);
  }

  // --- Customer conversion rollback (if disputed payment was the basis) ---
  let customerConversionRolledBack = false;
  if (paymentDisputed && disputedPaymentCustomerId) {
    const result = await rollbackCustomerConversionIfEmpty(ctx, {
      customerId: disputedPaymentCustomerId,
      opportunityId: opportunity._id,
      actorUserId: userId,
    });
    customerConversionRolledBack = result.rolledBack;
  }

  // --- Resolve the review ---
  await ctx.db.patch(args.reviewId, {
    status: "resolved",
    resolvedAt: now,
    resolvedByUserId: userId,
    resolutionAction: "disputed",
    ...(resolutionNote ? { resolutionNote } : {}),
  });

  await updateOpportunityMeetingRefs(ctx, opportunity._id);

  // --- Domain events ---
  if (previousOpportunityStatus !== "meeting_overran") {
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: opportunity._id,
      eventType: "opportunity.status_changed",
      source: "admin",
      actorUserId: userId,
      fromStatus: previousOpportunityStatus,
      toStatus: "meeting_overran",
      reason: "review_disputed",
      occurredAt: now,
    });
  }

  if (previousMeetingStatus === "no_show") {
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "meeting",
      entityId: meeting._id,
      eventType: "meeting.status_changed",
      source: "admin",
      actorUserId: userId,
      fromStatus: previousMeetingStatus,
      toStatus: "meeting_overran",
      reason: "review_disputed",
      occurredAt: now,
    });
  }

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
      resolutionAction: "disputed",
      previousOpportunityStatus,
      previousMeetingStatus,
      paymentDisputed,
      customerConversionRolledBack,
      closerAlreadyActed,
      activeFollowUpId: activeFollowUp?._id ?? null,
    },
  });

  console.log("[Review] disputed", {
    reviewId: args.reviewId,
    previousOpportunityStatus,
    previousMeetingStatus,
    paymentDisputed,
    customerConversionRolledBack,
  });
  return;
}
```

**Step 6: Keep `log_payment` / `mark_no_show` / `mark_lost` / false-positive correction aligned with the current implementation, but update `schedule_follow_up` to be side-effect only.**

The closer-already-acted gate (Step 3) already throws before these branches run when the closer has acted. The remaining direct-override branches proceed only when opportunity.status === `meeting_overran` AND no active follow-up exists.

For `schedule_follow_up`, keep the follow-up creation side effect but do **not** patch the opportunity to `follow_up_scheduled`. Resolve the review with `resolutionAction: "schedule_follow_up"`, emit the review-resolution domain event, and leave the opportunity at `meeting_overran` so any later booking still creates a new opportunity.

**Key implementation notes:**
- **The `disputed` branch is the ONLY code path that reverses `no_show`, `lost`, or `payment_received` to `meeting_overran`.** These reverse transitions are NOT in `VALID_TRANSITIONS` by design (Section 4.5 of overhaul-v2.md). We bypass `validateTransition` here intentionally — admin override. Any other code path attempting this transition will be rejected by `validateTransition`, which is correct.
- **`noShowReason: undefined` / `lostAt: undefined` / etc. on the patch:** Convex `patch` supports setting a field to `undefined` to delete it. This is the cleanest way to clear terminal-state timestamps so the reverted opportunity looks like a clean `meeting_overran` record, not a `meeting_overran` with leftover `lostAt` pointing to the disputed action.
- **`closerAlreadyActed` detection uses the SAME logic as the frontend.** Phase 5's `ReviewResolutionBar` computes `opportunityStatus !== "meeting_overran" || Boolean(activeFollowUp)`. The backend re-validates on every `resolveReview` call — never trust the client.
- **Stats delta computation uses `getActiveOpportunityDelta`** — the existing helper from this file. The reverse direction is handled naturally: `meeting_overran` IS active, so a transition from inactive (`no_show`, `lost`, `payment_received`) to active correctly gives `+1`.
- **Payment disputing logic respects existing `"disputed"` status filter.** The entire codebase already filters `status === "disputed"` out of revenue calculations. The `syncCustomerPaymentSummary` helper (3B) does this too. No need to add new filters elsewhere.
- **Customer rollback is conditional on `winningOpportunityId === opportunity._id`.** If the disputed payment was for a different customer (e.g., this is the closer's second sale to a returning customer), the customer is not deleted — only the payment summary is synced. The helper in 3B handles this.
- **Do NOT emit `opportunity.status_changed` if `previousOpportunityStatus === "meeting_overran"` already.** When closer never acted and admin disputes (which should really be called "acknowledged" but for consistency we allow "disputed" as a terminal confirmation), the opportunity was already `meeting_overran` → no status_changed event needed.
- **Do NOT touch `meetingReviews.closerResponse` / `closerStatedOutcome` / etc.** Those v1 fields stay in the record for audit. Only `status` / `resolvedAt` / `resolvedByUserId` / `resolutionAction` / `resolutionNote` are patched on the review.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reviews/mutations.ts` | Modify | Expand `resolutionAction` union, add closer-already-acted gate, add `disputed` branch |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/closer/meetingActions.ts` | Modify (append) | 3A (new `saveFathomLink` mutation) |
| `convex/lib/paymentHelpers.ts` | Create | 3B (3 helpers: `syncCustomerPaymentSummary`, `rollbackCustomerConversionIfEmpty`, `expirePendingFollowUpsForOpportunity`) |
| `convex/closer/payments.ts` | Modify | 3B (replace inline `syncCustomerPaymentSummary` with import) |
| `convex/lib/outcomeHelpers.ts` | Modify | 3B (replace inline `syncCustomerPaymentSummary` with import) |
| `convex/reporting/writeHooks.ts` | Modify | 3B (add `deleteCustomerAggregate` helper) |
| `convex/reviews/queries.ts` | Modify | 3C (add `loadActiveFollowUp` helper + `activeFollowUp` enrichment to both queries) |
| `convex/reviews/mutations.ts` | Modify | 3D (expand union, add closer-already-acted gate, add `disputed` branch) |

**Post-phase state:** `saveFathomLink` endpoint is live. The admin review pipeline can dispute outcomes; disputed payments are invalidated; disputed customer conversions are rolled back cleanly; pending follow-ups are expired. Review queries expose `activeFollowUp` so the admin UI can detect "closer already acted" even for follow-up-on-overran cases. `pnpm tsc --noEmit` passes.

**Critical path:** 3D is on the critical path — Phase 5's `ReviewResolutionBar` + `ReviewContextCard` directly depend on the `disputed` action being functional. 3B is a prerequisite of 3D. 3A and 3C are independent frontend prerequisites (Phase 4 uses 3A, Phase 5 uses 3C).
