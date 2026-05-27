# Phase 2 — Review Actions

**Goal:** Add the transactional one-payment-at-a-time review workflow. Billing operators can mark a focused payment reviewed, the payment moves from `recorded` to `verified`, aggregate counts update in the same mutation, and an auditable domain event is written.

**Prerequisite:** Phase 1 read-only queue/detail queries are implemented, Billing aggregate write hooks are wired, and the focused payment page renders reliably with full context.

**Runs in PARALLEL with:** Phase 3 backend correction mutation can run in parallel after Phase 1D because both use the same guards, event helper, and aggregate replacement contract. Phase 4 copy payload can run in parallel because it is read-only.

**Skills to invoke:**
- `convex-migration-helper` — confirm no extra migration is needed when reusing existing `status`, `verifiedAt`, and `verifiedByUserId` fields.
- `frontend-design` — review action placement should keep the operator focused on the detail page, not the queue.
- `shadcn` — use AlertDialog or Button/Tooltip primitives for review confirmation and disabled states.

**Acceptance Criteria:**
1. `/workspace/billing/[paymentRecordId]` shows a Mark reviewed action only for `recorded` payments.
2. The queue page does not expose row-level Mark reviewed shortcuts.
3. `markReviewed` rejects missing, cross-tenant, disabled-tenant, unauthorized, and `disputed` payments.
4. Re-reviewing an already `verified` payment is idempotent and does not emit a duplicate event.
5. Successful review patches `status = "verified"`, `verifiedAt`, `verifiedByUserId`, and `statusChangedAt`.
6. Successful review calls `replaceBillingPaymentAggregates` in the same transaction as the payment patch.
7. Successful review emits one `payment.verified` domain event with actor, old/new status, amount, currency, type, and program metadata.
8. Existing `disputed` and side-deal void flows continue to remove invalid revenue and update Billing counts through shared hooks.
9. The focused page refreshes after review and can navigate to the next unreviewed payment when one exists.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (markReviewed mutation) ─────────────┬── 2B (next-review query)
                                        ├── 2C (event labels/history)
                                        └── 2D (detail-page review UI)

2A + 2D complete ───────────────────────── 2E (review/dispute QA)
```

**Optimal execution:**
1. Implement 2A first because all UI behavior depends on the mutation contract.
2. Run 2B and 2C in parallel. They touch separate query/label files.
3. Build 2D after 2A is stable.
4. Finish with 2E, including aggregate-count before/after checks.

**Estimated time:** 2-3 days

---

## Subphases

### 2A — Mark Reviewed Mutation

**Type:** Backend
**Parallelizable:** No — this mutation defines the review contract for the whole phase.

**What:** Add `api.billing.mutations.markReviewed` with tenant guard, enablement guard, idempotency, aggregate replacement, and domain event emission.

**Why:** Review is a database state transition. It must be transactional and must not trust client-supplied actor or tenant values.

**Where:**
- `convex/billing/mutations.ts` (new)
- `convex/billing/validators.ts` (modify if return validator is shared)

**How:**

**Step 1: Create the mutation file.**

```typescript
// Path: convex/billing/mutations.ts
import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { replaceBillingPaymentAggregates } from "./aggregates";
import { requireBillingOpsEnabled, requireBillingPermission } from "./guards";

export const markReviewed = mutation({
  args: { paymentRecordId: v.id("paymentRecords") },
  returns: v.null(),
  handler: async (ctx, { paymentRecordId }) => {
    const { tenantId, userId } = await requireBillingPermission(
      ctx,
      "billing:review",
    );
    await requireBillingOpsEnabled(ctx, tenantId);

    const payment = await ctx.db.get(paymentRecordId);
    if (!payment || payment.tenantId !== tenantId) {
      throw new Error("Payment not found.");
    }
    if (payment.status === "disputed") {
      throw new Error("Disputed payments cannot be marked reviewed.");
    }
    if (payment.status === "verified") {
      return null;
    }

    const now = Date.now();
    const reviewPatch = {
      status: "verified" as const,
      verifiedAt: now,
      verifiedByUserId: userId,
      statusChangedAt: now,
    };
    const reviewedPayment = { ...payment, ...reviewPatch };

    await ctx.db.patch(paymentRecordId, reviewPatch);
    await replaceBillingPaymentAggregates(ctx, payment, reviewedPayment);

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "payment",
      entityId: paymentRecordId,
      eventType: "payment.verified",
      source: "admin",
      actorUserId: userId,
      fromStatus: payment.status,
      toStatus: "verified",
      occurredAt: now,
      metadata: {
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        paymentType: payment.paymentType,
        programId: payment.programId,
        programName: payment.programName,
      },
    });

    return null;
  },
});
```

**Step 2: Keep idempotency narrow.**

Do not emit a new event when `payment.status === "verified"`. The mutation returning `null` lets the UI refresh safely after a double-click or stale detail page.

**Key implementation notes:**
- Use the pre-patch `payment` as the old aggregate row and the object spread as the next row.
- Do not call `replacePaymentAggregate`; review status affects Billing counts but revenue sum eligibility stays active for both `recorded` and `verified`.
- Do not add a "needs info" state in this phase.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/billing/mutations.ts` | Create | Review mutation |

---

### 2B — Next Payment for Review

**Type:** Backend
**Parallelizable:** Yes — depends on Phase 1 query helpers but not on UI details.

**What:** Add a bounded query that returns the next `recorded` payment id after the current payment's recorded timestamp, falling back to the oldest unreviewed payment.

**Why:** After review, operators should keep momentum without returning to the queue and re-filtering manually.

**Where:**
- `convex/billing/queries.ts` (modify)

**How:**

**Step 1: Query next unreviewed by indexed status/date.**

```typescript
// Path: convex/billing/queries.ts
import { v } from "convex/values";

export const getNextPaymentForReview = query({
  args: { currentPaymentRecordId: v.optional(v.id("paymentRecords")) },
  handler: async (ctx, { currentPaymentRecordId }) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    await requireBillingOpsEnabled(ctx, tenantId);

    const current = currentPaymentRecordId
      ? await ctx.db.get(currentPaymentRecordId)
      : null;
    if (currentPaymentRecordId && (!current || current.tenantId !== tenantId)) {
      throw new Error("Payment not found.");
    }

    const afterCurrent = current
      ? await ctx.db
          .query("paymentRecords")
          .withIndex("by_tenantId_and_status_and_recordedAt", (q) =>
            q
              .eq("tenantId", tenantId)
              .eq("status", "recorded")
              .lt("recordedAt", current.recordedAt),
          )
          .order("desc")
          .first()
      : null;

    if (afterCurrent) {
      return { paymentRecordId: afterCurrent._id };
    }

    const oldest = await ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId_and_status_and_recordedAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", "recorded"),
      )
      .order("asc")
      .first();

    return { paymentRecordId: oldest?._id ?? null };
  },
});
```

**Key implementation notes:**
- The default queue order is newest first, so "next" after the current row is the next older `recorded` payment.
- Use `.first()`, not `.take(1).collect()`.
- The fallback makes the action useful even if the current payment was not opened from the default queue.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/billing/queries.ts` | Modify | Add next-review query |

---

### 2C — Review Event Labels and History Rendering

**Type:** Backend / Frontend
**Parallelizable:** Yes — independent of the mutation and UI button as long as the event type is known.

**What:** Ensure `payment.verified` renders clearly in event history and add missing labels for `payment.corrected` and `payment.voided` so Phase 3/4 histories are ready.

**Why:** The focused page includes payment event history. Operators need readable audit entries, not raw event slugs.

**Where:**
- `convex/reporting/lib/eventLabels.ts` (modify)
- `app/workspace/billing/_components/billing-event-history.tsx` (modify)

**How:**

**Step 1: Add or verify event label definitions.**

```typescript
// Path: convex/reporting/lib/eventLabels.ts
export const EVENT_LABELS = {
  // ... existing labels ...
  "payment.recorded": {
    verb: "recorded a payment",
    tone: "default",
  },
  "payment.verified": {
    verb: "marked payment reviewed",
    tone: "success",
  },
  "payment.corrected": {
    verb: "corrected payment details",
    tone: "warning",
  },
  "payment.disputed": {
    verb: "disputed a payment",
    tone: "destructive",
  },
  "payment.voided": {
    verb: "voided a payment",
    tone: "destructive",
  },
} as const;
```

**Step 2: Render correction/review metadata without dumping raw JSON.**

```tsx
// Path: app/workspace/billing/_components/billing-event-history.tsx
function renderPaymentEventMetadata(event: BillingPaymentEvent) {
  const metadata =
    typeof event.metadata === "string" ? JSON.parse(event.metadata) : null;

  if (event.eventType === "payment.verified") {
    return "Moved from recorded to reviewed.";
  }

  if (event.eventType === "payment.corrected" && metadata) {
    return Object.keys(metadata)
      .filter((key) => key !== "returnedToReview")
      .join(", ");
  }

  return event.reason ?? null;
}
```

**Key implementation notes:**
- Keep event labels shared if existing reporting components already use this file.
- Never show proof-file URLs in event metadata.
- Treat `payment.verified` as Billing-reviewed in UI copy; avoid "money verified" wording.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/lib/eventLabels.ts` | Modify | Payment event labels |
| `app/workspace/billing/_components/billing-event-history.tsx` | Modify | Human-readable history |

---

### 2D — Focused Page Review Action UI

**Type:** Frontend
**Parallelizable:** Yes — depends on 2A mutation and 2B next-review query.

**What:** Add a Mark reviewed action to the focused payment page, with loading state, idempotent refresh, toast, and optional navigation to the next unreviewed payment.

**Why:** The design explicitly avoids reviewing from the queue. The operator must review full context first.

**Where:**
- `app/workspace/billing/_components/billing-review-page-client.tsx` (modify)
- `app/workspace/billing/_components/billing-review-actions.tsx` (new)

**How:**

**Step 1: Add a separate action component.**

```tsx
// Path: app/workspace/billing/_components/billing-review-actions.tsx
"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { CheckCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export function BillingReviewActions({
  paymentRecordId,
  status,
}: {
  paymentRecordId: Id<"paymentRecords">;
  status: "recorded" | "verified" | "disputed";
}) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const markReviewed = useMutation(api.billing.mutations.markReviewed);
  const next = useQuery(api.billing.queries.getNextPaymentForReview, {
    currentPaymentRecordId: paymentRecordId,
  });

  if (status !== "recorded") {
    return null;
  }

  const submit = async () => {
    setIsSubmitting(true);
    try {
      await markReviewed({ paymentRecordId });
      toast.success("Payment marked reviewed.");
      if (next?.paymentRecordId && next.paymentRecordId !== paymentRecordId) {
        router.push(`/workspace/billing/${next.paymentRecordId}`);
      } else {
        router.refresh();
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to mark reviewed.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Button onClick={submit} disabled={isSubmitting}>
      {isSubmitting ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <CheckCircleIcon data-icon="inline-start" />
      )}
      Mark reviewed
    </Button>
  );
}
```

**Step 2: Mount it only on focused detail.**

```tsx
// Path: app/workspace/billing/_components/billing-review-page-client.tsx
import { BillingReviewActions } from "./billing-review-actions";

export function BillingReviewPageClient({ preloadedPayment }: Props) {
  const detail = usePreloadedQuery(preloadedPayment);
  if (!detail) return <PaymentNotFound />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <BackToBillingButton />
        <BillingReviewActions
          paymentRecordId={detail.payment.id}
          status={detail.payment.status}
        />
      </div>
      <BillingPaymentSummary detail={detail} />
    </div>
  );
}
```

**Key implementation notes:**
- Do not render this action in `billing-queue-table.tsx`.
- Disable the button while submitting; the backend idempotency handles stale double-submit cases.
- Route to next unreviewed only when the next id differs from the current id.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/billing/_components/billing-review-actions.tsx` | Create | Review action component |
| `app/workspace/billing/_components/billing-review-page-client.tsx` | Modify | Mount focused action |

---

### 2E — Review and Dispute QA

**Type:** Manual / QA
**Parallelizable:** No — consumes all Phase 2 behavior.

**What:** Verify review transitions, aggregate counts, domain events, and existing dispute/void behavior.

**Why:** Billing review changes the same `status` field used by reporting and customer summaries. The safest implementation is one that proves both Billing and non-Billing surfaces still agree.

**Where:**
- `plans/billing-ops/phases/phase2-review-qa.md` (new)
- `convex/reviews/mutations.ts` (inspect)
- `convex/sideDeals/voidPayment.ts` (inspect)

**How:**

**Step 1: Capture before/after counts.**

```typescript
// Path: plans/billing-ops/phases/phase2-review-qa.md
export const reviewQaChecks = [
  "Before review: recorded count is N and verified count is M.",
  "After review: recorded count is N - 1 and verified count is M + 1.",
  "Customer payment summary remains unchanged because both statuses are active revenue.",
  "Revenue reports remain unchanged because paymentSums sumValue excludes only disputed.",
  "Domain history shows exactly one payment.verified event.",
] as const;
```

**Step 2: Verify rejected states.**

| Scenario | Expected Result |
|---|---|
| Disabled tenant | Mutation rejects with Billing disabled error. |
| Closer role | Mutation rejects before payment read. |
| Cross-tenant id | Mutation returns "Payment not found." |
| `disputed` payment | Mutation rejects. |
| Already `verified` payment | Mutation returns success without another event. |

**Key implementation notes:**
- Use direct URL checks for unauthorized roles; do not rely only on hidden buttons.
- Re-run `getPaymentCount` after every status transition.
- Verify existing side-deal void still changes Billing count from active status to `disputed`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/billing-ops/phases/phase2-review-qa.md` | Create | Manual QA checklist |
| `convex/reviews/mutations.ts` | Inspect | Ensure shared replacement hook is used |
| `convex/sideDeals/voidPayment.ts` | Inspect | Ensure shared replacement hook is used |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/billing/mutations.ts` | Create | 2A |
| `convex/billing/queries.ts` | Modify | 2B |
| `convex/reporting/lib/eventLabels.ts` | Modify | 2C |
| `app/workspace/billing/_components/billing-event-history.tsx` | Modify | 2C |
| `app/workspace/billing/_components/billing-review-actions.tsx` | Create | 2D |
| `app/workspace/billing/_components/billing-review-page-client.tsx` | Modify | 2D |
| `plans/billing-ops/phases/phase2-review-qa.md` | Create | 2E |
| `convex/reviews/mutations.ts` | Inspect | 2E |
| `convex/sideDeals/voidPayment.ts` | Inspect | 2E |
