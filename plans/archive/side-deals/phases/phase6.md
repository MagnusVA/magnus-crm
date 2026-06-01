# Phase 6 - Reporting, Void & Audit Trail

**Goal:** Make side-deal revenue visible in reporting, add admin-only voiding for mis-entered side-deal payments, and verify audit events/counters stay balanced across create, payment, lost, and void flows.

**Prerequisite:** Phase 5 detail page and side-deal payment flow are shipped. Phase 1 origin validators include `closer_side_deal` and `admin_side_deal`. Existing reporting aggregates (`paymentSums`, `opportunityByStatus`, `tenantStats`) are healthy.

**Runs in PARALLEL with:** Phase 7 backend staleness can start after Phase 6A clarifies the terminal/void semantics, but UI changes to the detail page should be sequenced to avoid merge conflicts. Reporting backend (6B/6C) can run in parallel with void UI (6D).

**Skills to invoke:**
- `convex-performance-audit` - verify reporting additions stay bounded and do not scan payment tables unnecessarily.
- `convex-migration-helper` - confirm no data migration is required; this phase is validator/query/UI additions only.
- `frontend-design` - keep dashboard/report cards information-dense and consistent with existing reporting surfaces.
- `web-design-guidelines` - verify destructive void dialog language and focus behavior.

---

## Acceptance Criteria

1. Admins can void a recorded side-deal payment from the opportunity detail page; closers cannot see or call the void path successfully.
2. `sideDeals.voidPayment` rejects non-side-deal payments and already-disputed payments.
3. Voiding patches the payment to `status: "disputed"`, transitions the side-deal opportunity from `payment_received` to `lost`, and records `lostReason` with the void reason.
4. Voiding reverses payment aggregates and tenant stats exactly once: revenue decreases, payment record count decreases according to existing `applyPaymentStatsDelta` semantics, won deals decrease, and lost deals increase.
5. If the voided payment was the only non-disputed payment for the customer created by that opportunity, customer conversion rollback runs; otherwise customer payment summary resyncs.
6. Dashboard/admin stats expose `sideDealRevenueInPeriod` and `sideDealCountInPeriod`.
7. Revenue origin UI recognizes `closer_side_deal` and `admin_side_deal` without type holes or "unknown" labels.
8. Domain events exist for `payment.voided`, `opportunity.status_changed`, and all side-deal payment events include filterable side-deal metadata.
9. Existing Calendly payment reporting is unchanged.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
6A (void mutation backend) ───────────────┐
                                         ├── 6D (detail void UI) ─────────────┐
6B (detail query permission update) ─────┘                                    │
                                                                              ├── 6F (accounting QA gate)
6C (reporting backend side-deal metrics) ──── 6E (reporting UI labels/cards) ─┘
```

**Optimal execution:**
1. Run **6A** and **6C** in parallel. They touch separate backend areas.
2. Run **6B** as soon as 6A's return/permission assumptions are clear.
3. Run **6D** after 6A/6B; run **6E** after 6C.
4. Run **6F** after both void and reporting streams merge.

**Estimated time:** 1.5-2 days solo, or 1 day with two backend streams plus one frontend stream.

---

## Subphases

### 6A - Admin Void Mutation

**Type:** Backend
**Parallelizable:** Yes - owns a new sideDeals mutation file.

**What:** Create `api.sideDeals.voidPayment.voidPayment`.

**Why:** MVP needs a safe correction path for mis-entered side-deal payments without opening generic terminal-state transitions for all opportunity flows.

**Where:**
- `convex/sideDeals/voidPayment.ts` (new)

**How:**

**Step 1: Implement admin-only void mutation.**

```typescript
// Path: convex/sideDeals/voidPayment.ts
import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { emitDomainEvent } from "../lib/domainEvents";
import { patchOpportunityLifecycle } from "../lib/opportunityActivity";
import {
  rollbackCustomerConversionIfEmpty,
  syncCustomerPaymentSummary,
} from "../lib/paymentHelpers";
import { isSideDeal } from "../lib/sideDeals";
import {
  applyPaymentStatsDelta,
  updateTenantStats,
} from "../lib/tenantStatsHelper";
import { replacePaymentAggregate } from "../reporting/writeHooks";

export const voidPayment = mutation({
  args: {
    paymentId: v.id("paymentRecords"),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { paymentId, reason }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const now = Date.now();
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      throw new Error("Void reason is required.");
    }

    const payment = await ctx.db.get(paymentId);
    if (!payment || payment.tenantId !== tenantId) {
      throw new Error("Payment not found.");
    }
    if (payment.status === "disputed") {
      throw new Error("Already voided.");
    }
    if (!payment.opportunityId) {
      throw new Error("Only opportunity payments can be voided here.");
    }

    const opportunity = await ctx.db.get(payment.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId || !isSideDeal(opportunity)) {
      throw new Error("Only side-deal payments can be voided via this mutation.");
    }

    await ctx.db.patch(paymentId, {
      status: "disputed",
      statusChangedAt: now,
    });

    await patchOpportunityLifecycle(ctx, payment.opportunityId, {
      status: "lost",
      lostAt: now,
      lostByUserId: userId,
      lostReason: `Payment voided: ${trimmedReason}`,
      paymentReceivedAt: undefined,
      updatedAt: now,
    });

    await replacePaymentAggregate(ctx, payment, paymentId);
    await applyPaymentStatsDelta(ctx, tenantId, {
      commissionable: payment.commissionable,
      paymentType: payment.paymentType,
      amountMinorDelta: -payment.amountMinor,
      wonDealDelta: -1,
      activeOpportunityDelta: 0,
    });
    await updateTenantStats(ctx, tenantId, { lostDeals: 1 });

    if (payment.customerId) {
      const rollback = await rollbackCustomerConversionIfEmpty(ctx, {
        customerId: payment.customerId,
        opportunityId: payment.opportunityId,
        actorUserId: userId,
      });
      if (!rollback.rolledBack) {
        await syncCustomerPaymentSummary(ctx, payment.customerId);
      }
    }

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "payment",
      entityId: paymentId,
      eventType: "payment.voided",
      source: "admin",
      actorUserId: userId,
      reason: trimmedReason,
      occurredAt: now,
      metadata: { opportunityId: payment.opportunityId, sideDeal: true },
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: payment.opportunityId,
      eventType: "opportunity.status_changed",
      source: "admin",
      actorUserId: userId,
      fromStatus: opportunity.status,
      toStatus: "lost",
      reason: `Payment voided: ${trimmedReason}`,
      occurredAt: now,
      metadata: { source: "side_deal" },
    });

    return null;
  },
});
```

**Key implementation notes:**
- Do not add `payment_received -> lost` to `VALID_TRANSITIONS`; this mutation is the explicit exception.
- Capture `payment` before patch and pass it to `replacePaymentAggregate` so the aggregate can subtract the old eligible row.
- `paymentRecords` does not currently carry a dispute reason field. Keep the reason on `domainEvents.reason` and the opportunity `lostReason`; add a payment-level optional reason only through a separate additive schema change if operators require it later.
- Reversal semantics match existing `applyPaymentStatsDelta`: a negative amount decrements `totalPaymentRecords`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/sideDeals/voidPayment.ts` | Create | Admin-only side-deal payment reversal. |

---

### 6B - Detail Query Void Permission

**Type:** Backend
**Parallelizable:** Yes after 6A defines eligibility.

**What:** Update `getOpportunityDetail` to return `canVoidPayment` and a voidable payment id.

**Why:** The client should hide destructive actions unless the backend has already computed the same eligibility conditions. The mutation still enforces security.

**Where:**
- `convex/opportunities/detailQuery.ts` (modify)

**How:**

**Step 1: Update permission fields.**

```typescript
// Path: convex/opportunities/detailQuery.ts
const recordedSideDealPayment = payments.find(
  (payment) =>
    payment.status === "recorded" &&
    (payment.origin === "closer_side_deal" || payment.origin === "admin_side_deal"),
);

// In permissions:
permissions: {
  viewerUserId: userId,
  canRecordPayment: isSideDeal && opportunity.status === "in_progress",
  canMarkLost: isSideDeal && opportunity.status === "in_progress",
  canVoidPayment:
    isAdmin &&
    isSideDeal &&
    opportunity.status === "payment_received" &&
    recordedSideDealPayment !== undefined,
  voidablePaymentId: recordedSideDealPayment?._id,
  canDeleteOpportunity: false,
},
```

**Key implementation notes:**
- Only recorded side-deal payments are voidable from this flow.
- Do not expose void for Calendly payment origins; they use existing review/dispute paths.
- If multiple recorded payments exist, use the newest by `recordedAt` because payments query is ordered desc.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/opportunities/detailQuery.ts` | Modify | Add void eligibility and payment id. |

---

### 6C - Reporting Backend Side-Deal Metrics

**Type:** Backend
**Parallelizable:** Yes - independent of void UI.

**What:** Add side-deal revenue/count metrics to admin stats and make revenue reports origin-aware for new side-deal origins.

**Why:** Side deals are not a separate entity; reporting must partition payment revenue by origin and opportunity source so operators can see the side-deal slice.

**Where:**
- `convex/dashboard/adminStats.ts` (modify)
- `convex/reporting/revenue.ts` (modify if origin union/labels are built server-side)
- `convex/reporting/lib/helpers.ts` (modify only if typed origin helpers need side-deal handling)

**How:**

**Step 1: Use `isSideDealOrigin` in dashboard stats.**

```typescript
// Path: convex/dashboard/adminStats.ts
import { isSideDealOrigin } from "../lib/sideDeals";

const sideDealPayments = paymentSplit.commissionable.allPayments.filter((payment) =>
  isSideDealOrigin(payment.origin),
);
const sideDealFinalOpportunityIds = new Set(
  paymentSplit.commissionable.finalPayments
    .filter((payment) => isSideDealOrigin(payment.origin))
    .map((payment) => payment.opportunityId)
    .filter((opportunityId): opportunityId is NonNullable<typeof opportunityId> =>
      opportunityId !== undefined,
    ),
);

return {
  // ... existing period stats ...
  sideDealRevenueInPeriod:
    sideDealPayments.reduce((sum, payment) => sum + payment.amountMinor, 0) / 100,
  sideDealCountInPeriod: sideDealFinalOpportunityIds.size,
};
```

**Step 2: Ensure reporting helpers classify the new origins as commissionable.**

```typescript
// Path: convex/reporting/lib/helpers.ts
// If this file has explicit origin switches, add:
case "closer_side_deal":
case "admin_side_deal":
  return true;
```

**Key implementation notes:**
- Prefer `isSideDealOrigin` over string checks repeated across files.
- If `convex/reporting/revenue.ts` groups by raw `origin`, no backend change may be needed beyond validator/types. Confirm with TypeScript.
- `sideDealCountInPeriod` should count final opportunity ids, not raw payment rows, to avoid split/deposit double-counting.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/dashboard/adminStats.ts` | Modify | Add side-deal revenue/count metrics. |
| `convex/reporting/revenue.ts` | Modify / Review | Ensure origin grouping includes side-deal origins. |
| `convex/reporting/lib/helpers.ts` | Modify / Review | Ensure commissionable origin helpers need no extra switch. |

---

### 6D - Detail Void UI

**Type:** Frontend
**Parallelizable:** Yes after 6A/6B.

**What:** Add `VoidPaymentDialog` and render it from the detail action bar for admins.

**Why:** Admin correction must be available where the payment is visible, with clear destructive wording and reason capture.

**Where:**
- `app/workspace/opportunities/[opportunityId]/_components/void-payment-dialog.tsx` (new)
- `app/workspace/opportunities/[opportunityId]/_components/opportunity-detail-client.tsx` (modify)

**How:**

**Step 1: Create the dialog.**

```tsx
// Path: app/workspace/opportunities/[opportunityId]/_components/void-payment-dialog.tsx
"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import posthog from "posthog-js";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";

const schema = z.object({
  reason: z.string().min(1, "Reason is required").max(500),
});
type Values = z.infer<typeof schema>;

export function VoidPaymentDialog({ paymentId }: { paymentId: Id<"paymentRecords"> }) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const voidPayment = useMutation(api.sideDeals.voidPayment.voidPayment);
  const form = useForm({
    resolver: standardSchemaResolver(schema),
    defaultValues: { reason: "" },
  });

  const onSubmit = async (values: Values) => {
    setIsSubmitting(true);
    setError(null);
    try {
      await voidPayment({ paymentId, reason: values.reason.trim() });
      posthog.capture("side_deal_payment_voided", { payment_id: paymentId });
      toast.success("Payment voided");
      setOpen(false);
      form.reset();
    } catch (err) {
      posthog.captureException(err);
      setError(err instanceof Error ? err.message : "Failed to void payment");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(value) => !isSubmitting && setOpen(value)}>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm">Void payment</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Void this side-deal payment?</AlertDialogTitle>
          <AlertDialogDescription>
            This marks the payment as disputed, reverses side-deal revenue, and moves the opportunity to lost.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason</FormLabel>
                  <FormControl><Textarea rows={3} {...field} disabled={isSubmitting} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isSubmitting}>Cancel</AlertDialogCancel>
              <Button type="submit" variant="destructive" disabled={isSubmitting}>Void payment</Button>
            </AlertDialogFooter>
          </form>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

**Step 2: Render from detail client.**

```tsx
// Path: app/workspace/opportunities/[opportunityId]/_components/opportunity-detail-client.tsx
import { VoidPaymentDialog } from "./void-payment-dialog";

{permissions.canVoidPayment && permissions.voidablePaymentId ? (
  <VoidPaymentDialog paymentId={permissions.voidablePaymentId} />
) : null}
```

**Key implementation notes:**
- Button text says "Void payment", not "Delete", because the payment row remains for audit.
- Keep destructive styling only for the confirm action and trigger; avoid making the whole page feel alarming.
- The detail query controls visibility; the mutation remains authoritative.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/opportunities/[opportunityId]/_components/void-payment-dialog.tsx` | Create | Admin destructive correction dialog. |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-detail-client.tsx` | Modify | Render void action when permission flag is true. |

---

### 6E - Reporting UI Labels and Dashboard Card

**Type:** Frontend
**Parallelizable:** Yes after 6C.

**What:** Add side-deal origin labels/colors and dashboard card display.

**Why:** Backend metrics are not useful if the UI falls back to unknown labels or hides the new slice.

**Where:**
- `app/workspace/reports/revenue/_components/revenue-by-origin-chart.tsx` (modify)
- `app/workspace/_components/stats-row.tsx` or `app/workspace/_components/stats-row-client.tsx` (modify according to current data flow)
- `app/workspace/reports/revenue/_components/revenue-kpi-cards.tsx` (review/modify if it enumerates origins)

**How:**

**Step 1: Add origin metadata.**

```tsx
// Path: app/workspace/reports/revenue/_components/revenue-by-origin-chart.tsx
const ORIGIN_META = {
  closer_meeting: { label: "Closer meeting", color: "var(--chart-1)" },
  closer_reminder: { label: "Closer reminder", color: "var(--chart-2)" },
  admin_meeting: { label: "Admin meeting", color: "var(--chart-3)" },
  admin_reminder: { label: "Admin reminder", color: "var(--chart-4)" },
  admin_review_resolution: { label: "Review resolution", color: "var(--chart-5)" },
  closer_side_deal: { label: "Closer side deal", color: "var(--chart-6)" },
  admin_side_deal: { label: "Admin side deal", color: "var(--chart-7)" },
} satisfies Record<RevenueOrigin, { label: string; color: string }>;
```

**Step 2: Add dashboard card.**

```tsx
// Path: app/workspace/_components/stats-row.tsx
{periodStats?.sideDealCountInPeriod !== undefined ? (
  <StatsCard
    icon={LinkIcon}
    label="Side-deal revenue"
    value={formatCurrency(periodStats.sideDealRevenueInPeriod ?? 0, "USD")}
    sublabel={`${periodStats.sideDealCountInPeriod} deals`}
  />
) : null}
```

**Key implementation notes:**
- Use chart variables already present in the design system; do not introduce a new one-off palette.
- If the current stats row is at capacity, place side-deal revenue in the next row/section instead of shrinking type.
- The dashboard card is admin-facing only if `getAdminDashboardStats` is the source. Do not add closer dashboard changes in MVP unless the existing closer stats already receives these fields.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/revenue/_components/revenue-by-origin-chart.tsx` | Modify | Add side-deal origin labels/colors. |
| `app/workspace/_components/stats-row.tsx` | Modify / Review | Add side-deal revenue card if this is where period stats render. |
| `app/workspace/_components/stats-row-client.tsx` | Modify / Review | Update client-side type if stats row is split. |
| `app/workspace/reports/revenue/_components/revenue-kpi-cards.tsx` | Modify / Review | Add/recognize side-deal slice if needed. |

---

### 6F - Accounting and Reporting QA Gate

**Type:** Manual / Full-Stack
**Parallelizable:** No - requires complete backend and UI.

**What:** Verify side-deal payment reporting, void reversal, audit events, and no Calendly regression.

**Why:** Accounting bugs are high-impact even with one test tenant. This gate must prove every counter and aggregate moves in the expected direction.

**Where:**
- Terminal
- Convex dashboard
- Local browser

**How:**

**Step 1: Static checks.**

```bash
# Path: repo root
pnpm tsc --noEmit
pnpm lint
```

**Step 2: Create a controlled side-deal payment and capture before/after stats.**

```typescript
// Path: Convex dashboard
// Before:
// - tenantStats totals
// - revenue report for current period
// - payment aggregate row if visible
// Action:
// - record side-deal payment
// After:
// - totalRevenueMinor increased by amount
// - wonDeals +1
// - activeOpportunities -1
// - sideDealRevenueInPeriod includes amount
```

**Step 3: Void and verify reversal.**

```typescript
// Path: Convex dashboard
// After void:
// - payment.status === "disputed"
// - opportunity.status === "lost"
// - totalRevenueMinor decreased by amount
// - wonDeals -1 relative to paid state
// - lostDeals +1 relative to paid state
// - customer either rolled back or summary excludes disputed payment
// - payment.voided and opportunity.status_changed events exist
```

**Key implementation notes:**
- Test admin-created and closer-created side-deal payments because origins differ.
- Test a Calendly payment still appears with its original origin labels.
- If tenant stats can go negative in a malformed test dataset, stop and repair data before production deploy; do not hide the problem in UI.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| None | Manual | Accounting and reporting verification. |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/sideDeals/voidPayment.ts` | Create | 6A |
| `convex/opportunities/detailQuery.ts` | Modify | 6B |
| `convex/dashboard/adminStats.ts` | Modify | 6C |
| `convex/reporting/revenue.ts` | Modify / Review | 6C |
| `convex/reporting/lib/helpers.ts` | Modify / Review | 6C |
| `app/workspace/opportunities/[opportunityId]/_components/void-payment-dialog.tsx` | Create | 6D |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-detail-client.tsx` | Modify | 6D |
| `app/workspace/reports/revenue/_components/revenue-by-origin-chart.tsx` | Modify | 6E |
| `app/workspace/_components/stats-row.tsx` | Modify / Review | 6E |
| `app/workspace/_components/stats-row-client.tsx` | Modify / Review | 6E |
| `app/workspace/reports/revenue/_components/revenue-kpi-cards.tsx` | Modify / Review | 6E |
