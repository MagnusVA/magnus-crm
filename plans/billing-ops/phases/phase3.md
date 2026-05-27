# Phase 3 — Payment Corrections

**Goal:** Add deliberate, audited corrections for Billing-owned payment fields: amount, payment type, program, reference code, and note. Financial corrections refresh reporting/customer/program caches and return reviewed payments to the review queue.

**Prerequisite:** Phase 1 aggregate hooks are in place and Phase 2 review semantics are implemented or at least contract-stable. Correction work must not start if product selected the dedicated billing-review-field branch without updating this phase.

**Runs in PARALLEL with:** Phase 2 can run in parallel after Phase 1D. Phase 4 copy/export UI can run in parallel after 3A publishes final corrected detail shape, but export must wait for correction audit labels from 3C.

**Skills to invoke:**
- `convex-migration-helper` — confirm this phase is mutation-only under the default MVP branch; invoke migration planning if correction ledger tables or dedicated billing fields are added.
- `frontend-design` — correction UX must make financial status reset obvious without overwhelming the detail page.
- `shadcn` — use Dialog, Alert, Form, Select, Input, Textarea, and Spinner primitives.

**Acceptance Criteria:**
1. Billing operators can correct only amount, payment type, active program, reference code, and note.
2. Correction mutation rejects disabled tenants, unauthorized roles, cross-tenant ids, disputed payments, archived/missing programs, empty reason, and no-op submissions.
3. Every successful correction emits exactly one `payment.corrected` domain event with reason and old/new values for changed fields only.
4. Amount and payment-type corrections refresh `paymentSums`, Billing count aggregates when keys change, tenant stats replacement deltas, and customer payment summary.
5. Program corrections patch `programId` and `programName`, refresh Billing aggregates, and refresh sold-program caches for opportunity/customer-direct contexts.
6. Financial corrections on `verified` payments set `status = "recorded"`, clear `verifiedAt` and `verifiedByUserId`, set `statusChangedAt`, and route the operator back to the same focused page.
7. Metadata-only corrections on `verified` payments keep the payment reviewed.
8. The correction dialog uses React Hook Form, Zod v4, and `standardSchemaResolver`.
9. Correction history is visible in the focused page event history without exposing raw JSON blobs.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (mutation contract + validators) ───────┬── 3B (tenant stats replacement)
                                           ├── 3C (program cache refresh)
                                           └── 3D (correction dialog UI)

3A + 3B + 3C complete ─────────────────────── 3E (detail refresh/history integration)

3D + 3E complete ──────────────────────────── 3F (financial QA matrix)
```

**Optimal execution:**
1. Start 3A first to define the mutation args, return shape, no-op behavior, and status reset rules.
2. Run 3B and 3C in parallel because they touch independent helper files.
3. Build 3D against the stable mutation contract while helper work completes.
4. Finish with 3E/3F integration and cross-surface financial checks.

**Estimated time:** 4-5 days

---

## Subphases

### 3A — Correction Mutation Contract

**Type:** Backend
**Parallelizable:** No — defines the public mutation contract used by backend helpers and UI.

**What:** Implement `api.billing.mutations.correctPayment` with editable-field validation, no-op handling, status reset rules, aggregate refresh calls, and audit event metadata.

**Why:** Payment correction changes financial data. It must be explicit, reasoned, transactional, and auditable.

**Where:**
- `convex/billing/mutations.ts` (modify)
- `convex/billing/validators.ts` (modify)

**How:**

**Step 1: Add return and arg validators.**

```typescript
// Path: convex/billing/validators.ts
import { v } from "convex/values";
import { paymentTypeValidator } from "../lib/paymentTypes";

export const correctPaymentArgsValidator = {
  paymentRecordId: v.id("paymentRecords"),
  amount: v.optional(v.number()),
  paymentType: v.optional(paymentTypeValidator),
  programId: v.optional(v.id("tenantPrograms")),
  referenceCode: v.optional(v.string()),
  note: v.optional(v.string()),
  reason: v.string(),
};

export const correctPaymentReturnValidator = v.object({
  paymentRecordId: v.id("paymentRecords"),
  status: billingStatusValidator,
  returnedToReview: v.boolean(),
  changed: v.boolean(),
});
```

**Step 2: Implement changed-field detection.**

```typescript
// Path: convex/billing/mutations.ts
import type { Doc } from "../_generated/dataModel";
import { toAmountMinor } from "../lib/formatMoney";
import { requireActiveProgram } from "../lib/paymentHelpers";
import {
  correctPaymentArgsValidator,
  correctPaymentReturnValidator,
} from "./validators";

type PaymentPatch = Partial<Doc<"paymentRecords">>;

function addChangedKey(
  changedKeys: Array<keyof Doc<"paymentRecords">>,
  key: keyof Doc<"paymentRecords">,
) {
  if (!changedKeys.includes(key)) {
    changedKeys.push(key);
  }
}

function isFinancialCorrection(key: keyof Doc<"paymentRecords">) {
  return (
    key === "amountMinor" ||
    key === "paymentType" ||
    key === "programId" ||
    key === "programName"
  );
}
```

**Step 3: Add the mutation.**

```typescript
// Path: convex/billing/mutations.ts
export const correctPayment = mutation({
  args: correctPaymentArgsValidator,
  returns: correctPaymentReturnValidator,
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireBillingPermission(
      ctx,
      "billing:correct",
    );
    await requireBillingOpsEnabled(ctx, tenantId);

    const payment = await ctx.db.get(args.paymentRecordId);
    if (!payment || payment.tenantId !== tenantId) {
      throw new Error("Payment not found.");
    }
    if (payment.status === "disputed") {
      throw new Error("Disputed payments must be repaired through a dispute flow.");
    }

    const reason = args.reason.trim();
    if (!reason) {
      throw new Error("A correction reason is required.");
    }

    const patch: PaymentPatch = {};
    const changedKeys: Array<keyof Doc<"paymentRecords">> = [];

    if (args.amount !== undefined) {
      const amountMinor = toAmountMinor(args.amount);
      if (amountMinor !== payment.amountMinor) {
        patch.amountMinor = amountMinor;
        addChangedKey(changedKeys, "amountMinor");
      }
    }

    if (args.paymentType !== undefined && args.paymentType !== payment.paymentType) {
      patch.paymentType = args.paymentType;
      addChangedKey(changedKeys, "paymentType");
    }

    if (args.programId !== undefined && args.programId !== payment.programId) {
      const program = await requireActiveProgram(ctx, tenantId, args.programId);
      patch.programId = program._id;
      patch.programName = program.name;
      addChangedKey(changedKeys, "programId");
      addChangedKey(changedKeys, "programName");
    }

    if (args.referenceCode !== undefined) {
      const nextReferenceCode = args.referenceCode.trim() || undefined;
      if (nextReferenceCode !== payment.referenceCode) {
        patch.referenceCode = nextReferenceCode;
        addChangedKey(changedKeys, "referenceCode");
      }
    }

    if (args.note !== undefined) {
      const nextNote = args.note.trim() || undefined;
      if (nextNote !== payment.note) {
        patch.note = nextNote;
        addChangedKey(changedKeys, "note");
      }
    }

    if (changedKeys.length === 0) {
      return {
        paymentRecordId: args.paymentRecordId,
        status: payment.status,
        returnedToReview: false,
        changed: false,
      };
    }

    const financialChange = changedKeys.some(isFinancialCorrection);
    const now = Date.now();
    const returnedToReview = financialChange && payment.status === "verified";
    if (returnedToReview) {
      patch.status = "recorded";
      patch.verifiedAt = undefined;
      patch.verifiedByUserId = undefined;
      patch.statusChangedAt = now;
    }

    await ctx.db.patch(args.paymentRecordId, patch);
    const nextPayment = { ...payment, ...patch };

    await refreshPaymentCorrectionSideEffects(ctx, {
      tenantId,
      before: payment,
      after: nextPayment,
      changedKeys,
      financialChange,
    });

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "payment",
      entityId: args.paymentRecordId,
      eventType: "payment.corrected",
      source: "admin",
      actorUserId: userId,
      fromStatus: payment.status,
      toStatus: nextPayment.status,
      reason,
      occurredAt: now,
      metadata: buildCorrectionMetadata(payment, nextPayment, changedKeys, {
        returnedToReview,
      }),
    });

    return {
      paymentRecordId: args.paymentRecordId,
      status: nextPayment.status,
      returnedToReview,
      changed: true,
    };
  },
});
```

**Key implementation notes:**
- No-op submissions return `changed: false` and do not emit a domain event.
- Disputed payments remain out of scope; they require dispute repair semantics, not Billing correction.
- Keep `currency`, proof file, customer, opportunity, meeting, attributed closer, commissionable, and origin immutable in Billing MVP.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/billing/validators.ts` | Modify | Correction args/return validators |
| `convex/billing/mutations.ts` | Modify | Correction mutation |

---

### 3B — Replacement-Style Tenant Stats Helper

**Type:** Backend
**Parallelizable:** Yes — independent of program cache helper and UI.

**What:** Add a tenant stats replacement helper for payment corrections that changes revenue/type buckets without changing payment count or won-deal counters.

**Why:** Existing `applyPaymentStatsDelta` is insert/delete-oriented and changes `totalPaymentRecords` based on amount sign. Corrections must not do that.

**Where:**
- `convex/lib/tenantStatsHelper.ts` (modify)

**How:**

**Step 1: Add bucket helpers.**

```typescript
// Path: convex/lib/tenantStatsHelper.ts
import type { Doc, Id } from "../_generated/dataModel";

type PaymentRevenueBucket =
  | "totalCommissionableFinalRevenueMinor"
  | "totalCommissionableDepositRevenueMinor"
  | "totalNonCommissionableFinalRevenueMinor"
  | "totalNonCommissionableDepositRevenueMinor";

function paymentRevenueBucket(payment: Doc<"paymentRecords">): PaymentRevenueBucket {
  if (payment.commissionable) {
    return payment.paymentType === "deposit"
      ? "totalCommissionableDepositRevenueMinor"
      : "totalCommissionableFinalRevenueMinor";
  }

  return payment.paymentType === "deposit"
    ? "totalNonCommissionableDepositRevenueMinor"
    : "totalNonCommissionableFinalRevenueMinor";
}
```

**Step 2: Add replacement helper.**

```typescript
// Path: convex/lib/tenantStatsHelper.ts
export async function replaceTenantPaymentStatsForCorrection(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  args: {
    before: Doc<"paymentRecords">;
    after: Doc<"paymentRecords">;
  },
) {
  const before = args.before.status === "disputed" ? 0 : args.before.amountMinor;
  const after = args.after.status === "disputed" ? 0 : args.after.amountMinor;
  const beforeBucket = paymentRevenueBucket(args.before);
  const afterBucket = paymentRevenueBucket(args.after);

  const delta: TenantStatsDelta = {
    totalRevenueMinor: after - before,
  };

  if (beforeBucket === afterBucket) {
    delta[beforeBucket] = after - before;
  } else {
    delta[beforeBucket] = -before;
    delta[afterBucket] = after;
  }

  await updateTenantStats(ctx, tenantId, delta);
}
```

**Step 3: Call from correction side effects only for financial changes.**

```typescript
// Path: convex/billing/mutations.ts
import { replaceTenantPaymentStatsForCorrection } from "../lib/tenantStatsHelper";

async function refreshPaymentCorrectionSideEffects(ctx: MutationCtx, args: SideEffectArgs) {
  if (args.financialChange) {
    await replaceTenantPaymentStatsForCorrection(ctx, args.tenantId, {
      before: args.before,
      after: args.after,
    });
  }
}
```

**Key implementation notes:**
- This helper must not update `totalPaymentRecords`, `wonDeals`, or active opportunity counters.
- Status reset from `verified` to `recorded` does not change revenue because both statuses are active.
- The helper still handles disputed defensively, but `correctPayment` should reject disputed payments.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/tenantStatsHelper.ts` | Modify | Replacement-style correction helper |
| `convex/billing/mutations.ts` | Modify | Invoke helper for financial changes |

---

### 3C — Program Cache and Aggregate Side Effects

**Type:** Backend
**Parallelizable:** Yes — can run with 3B because it owns a different helper file.

**What:** Refresh payment aggregates, Billing aggregates, customer summaries, and sold-program caches after correction.

**Why:** Program, amount, and type are duplicated into reports, customers, opportunities, meetings, and operations projections. Corrections must repair every affected derived surface.

**Where:**
- `convex/billing/mutations.ts` (modify)
- `convex/lib/soldProgramCache.ts` (modify)
- `convex/reporting/writeHooks.ts` (reuse)
- `convex/lib/paymentHelpers.ts` (reuse)

**How:**

**Step 1: Add a payment-context sold-program refresh helper.**

```typescript
// Path: convex/lib/soldProgramCache.ts
import type { Doc } from "../_generated/dataModel";

export async function refreshSoldProgramCachesForPaymentContext(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    payment: Doc<"paymentRecords">;
  },
) {
  const opportunityId =
    args.payment.opportunityId ?? args.payment.originatingOpportunityId;
  if (!opportunityId) {
    return;
  }

  await refreshSoldProgramCachesForOpportunity(ctx, {
    tenantId: args.tenantId,
    opportunityId,
  });

  if (args.payment.customerId) {
    const customer = await ctx.db.get(args.payment.customerId);
    if (
      customer &&
      customer.tenantId === args.tenantId &&
      customer.winningOpportunityId === opportunityId
    ) {
      await ctx.db.patch(customer._id, {
        programId: args.payment.programId,
        programName: args.payment.programName,
      });
    }
  }
}
```

**Step 2: Centralize correction side effects.**

```typescript
// Path: convex/billing/mutations.ts
import type { MutationCtx } from "../_generated/server";
import { syncCustomerPaymentSummary } from "../lib/paymentHelpers";
import { refreshSoldProgramCachesForPaymentContext } from "../lib/soldProgramCache";
import { replacePaymentAggregate } from "../reporting/writeHooks";

type SideEffectArgs = {
  tenantId: Id<"tenants">;
  before: Doc<"paymentRecords">;
  after: Doc<"paymentRecords">;
  changedKeys: Array<keyof Doc<"paymentRecords">>;
  financialChange: boolean;
};

async function refreshPaymentCorrectionSideEffects(
  ctx: MutationCtx,
  args: SideEffectArgs,
) {
  const storedAfter = await replacePaymentAggregate(
    ctx,
    args.before,
    args.after._id,
  );

  if (args.financialChange) {
    await replaceTenantPaymentStatsForCorrection(ctx, args.tenantId, {
      before: args.before,
      after: storedAfter,
    });
  }

  if (storedAfter.customerId) {
    await syncCustomerPaymentSummary(ctx, storedAfter.customerId);
  }

  if (args.changedKeys.includes("programId")) {
    await refreshSoldProgramCachesForPaymentContext(ctx, {
      tenantId: args.tenantId,
      payment: storedAfter,
    });
  }
}
```

**Key implementation notes:**
- This plan assumes Phase 1D updated `replacePaymentAggregate` to call Billing aggregate replacement. Do not double-call `replaceBillingPaymentAggregates` from corrections.
- Program correction must patch both `programId` and `programName`.
- Customer program fields should change only when the corrected payment is the customer's winning/conversion payment.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/soldProgramCache.ts` | Modify | Payment-context refresh helper |
| `convex/billing/mutations.ts` | Modify | Side-effect orchestration |

---

### 3D — Correction Dialog UI

**Type:** Frontend
**Parallelizable:** Yes — can begin once 3A mutation args/return shape are stable.

**What:** Add a correction dialog on the focused payment page with RHF/Zod validation, active program select, reason field, no-op detection, and financial-reset confirmation.

**Why:** Corrections should be deliberate. The UI must distinguish low-risk metadata edits from financial edits that return the row to review.

**Where:**
- `app/workspace/billing/_components/correction-dialog.tsx` (new)
- `app/workspace/billing/_components/billing-review-page-client.tsx` (modify)

**How:**

**Step 1: Define a Zod v4 form schema.**

```tsx
// Path: app/workspace/billing/_components/correction-dialog.tsx
"use client";

import { useMemo, useState } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

const correctionSchema = z.object({
  amount: z
    .string()
    .optional()
    .refine((value) => {
      if (!value) return true;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0;
    }, "Amount must be greater than 0"),
  paymentType: z.enum(["monthly", "split", "pif", "deposit"]).optional(),
  programId: z.string().optional(),
  referenceCode: z.string().optional(),
  note: z.string().optional(),
  reason: z.string().min(1, "A correction reason is required"),
});

type CorrectionFormValues = z.infer<typeof correctionSchema>;
```

**Step 2: Submit normalized values to the mutation.**

```tsx
// Path: app/workspace/billing/_components/correction-dialog.tsx
export function CorrectionDialog({
  payment,
  onCorrected,
}: {
  payment: BillingPaymentSummary;
  onCorrected: (returnedToReview: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingValues, setPendingValues] =
    useState<CorrectionFormValues | null>(null);
  const correctPayment = useMutation(api.billing.mutations.correctPayment);
  const programs = useQuery(api.tenantPrograms.queries.listPrograms, {
    includeArchived: false,
  });

  const form = useForm({
    resolver: standardSchemaResolver(correctionSchema),
    defaultValues: {
      amount: (payment.amountMinor / 100).toFixed(2),
      paymentType: payment.paymentType,
      programId: payment.programId,
      referenceCode: payment.referenceCode ?? "",
      note: payment.note ?? "",
      reason: "",
    },
  });

  const watched = form.watch();
  const financialChange = useMemo(() => {
    return (
      Math.round(Number(watched.amount || "0") * 100) !== payment.amountMinor ||
      watched.paymentType !== payment.paymentType ||
      watched.programId !== payment.programId
    );
  }, [watched, payment]);

  const submitCorrection = async (values: CorrectionFormValues) => {
    setIsSubmitting(true);
    try {
      const result = await correctPayment({
        paymentRecordId: payment.id,
        amount: values.amount ? Number(values.amount) : undefined,
        paymentType: values.paymentType,
        programId: values.programId as Id<"tenantPrograms"> | undefined,
        referenceCode: values.referenceCode,
        note: values.note,
        reason: values.reason,
      });
      setOpen(false);
      setPendingValues(null);
      onCorrected(result.returnedToReview);
    } finally {
      setIsSubmitting(false);
    }
  };

  const onSubmit = async (values: CorrectionFormValues) => {
    if (financialChange && payment.status === "verified") {
      setPendingValues(values);
      return;
    }
    await submitCorrection(values);
  };

  return null;
}
```

**Step 3: Confirm financial reset with `AlertDialog`.**

```tsx
// Path: app/workspace/billing/_components/correction-dialog.tsx
<AlertDialog
  open={pendingValues !== null}
  onOpenChange={(nextOpen) => {
    if (!nextOpen && !isSubmitting) setPendingValues(null);
  }}
>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Return payment to review?</AlertDialogTitle>
      <AlertDialogDescription>
        This correction changes billing substance on a reviewed payment. It
        will clear the reviewer stamp and move the payment back to Recorded.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel disabled={isSubmitting}>Cancel</AlertDialogCancel>
      <AlertDialogAction
        disabled={isSubmitting}
        onClick={() => {
          if (pendingValues) void submitCorrection(pendingValues);
        }}
      >
        Continue
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

**Key implementation notes:**
- Do not pass a generic to `useForm`; let `standardSchemaResolver` infer Zod v4 types.
- Program select must list active programs only; archived programs can display as current value but cannot be chosen for a new correction.
- Keep proof, customer, opportunity, meeting, closer, and commissionable fields out of the dialog.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/billing/_components/correction-dialog.tsx` | Create | Correction form/dialog |
| `app/workspace/billing/_components/billing-review-page-client.tsx` | Modify | Mount correction action |

---

### 3E — Detail Refresh and Correction History

**Type:** Full-Stack
**Parallelizable:** No — depends on 3A backend and 3D UI.

**What:** Refresh the focused detail after correction, show returned-to-review state, and make correction metadata readable in event history.

**Why:** Operators need immediate feedback when a reviewed payment returns to the queue, and the audit trail must be understandable.

**Where:**
- `app/workspace/billing/_components/billing-review-page-client.tsx` (modify)
- `app/workspace/billing/_components/billing-event-history.tsx` (modify)
- `convex/billing/enrichment.ts` (modify if event DTO needs actor names)

**How:**

**Step 1: Refresh current route after correction.**

```tsx
// Path: app/workspace/billing/_components/billing-review-page-client.tsx
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CorrectionDialog } from "./correction-dialog";

export function BillingReviewPageClient({ preloadedPayment }: Props) {
  const router = useRouter();
  const detail = usePreloadedQuery(preloadedPayment);

  if (!detail) return <PaymentNotFound />;

  return (
    <div className="flex flex-col gap-4">
      <CorrectionDialog
        payment={detail.payment}
        onCorrected={(returnedToReview) => {
          toast.success(
            returnedToReview
              ? "Payment corrected and returned to review."
              : "Payment corrected.",
          );
          router.refresh();
        }}
      />
      <BillingPaymentSummary detail={detail} />
    </div>
  );
}
```

**Step 2: Render changed fields with old/new labels.**

```tsx
// Path: app/workspace/billing/_components/billing-event-history.tsx
function CorrectionMetadata({ metadata }: { metadata: Record<string, unknown> }) {
  const entries = Object.entries(metadata).filter(
    ([key]) => key !== "returnedToReview",
  );

  return (
    <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
      {entries.map(([key, value]) => {
        const change = value as { from?: unknown; to?: unknown };
        return (
          <li key={key}>
            <span className="font-medium text-foreground">{key}</span>:{" "}
            {String(change.from ?? "empty")} to {String(change.to ?? "empty")}
          </li>
        );
      })}
    </ul>
  );
}
```

**Key implementation notes:**
- Use `router.refresh()` because the page is preloaded from an RSC query.
- If financial correction returns to review, leave the operator on the same payment so they can re-review immediately.
- Event metadata can be JSON-parsed client-side only after defensive checks.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/billing/_components/billing-review-page-client.tsx` | Modify | Refresh after correction |
| `app/workspace/billing/_components/billing-event-history.tsx` | Modify | Correction metadata rendering |
| `convex/billing/enrichment.ts` | Modify | Optional actor display enrichment |

---

### 3F — Correction QA Matrix

**Type:** Manual / QA
**Parallelizable:** No — final gate for the correction workflow.

**What:** Verify every editable field, no-op path, reviewed-status reset behavior, and downstream aggregate/cache refresh.

**Why:** This is the highest financial-integrity phase. A missed side effect can corrupt reports, customer summaries, or operational Billing counts.

**Where:**
- `plans/billing-ops/phases/phase3-correction-qa.md` (new)

**How:**

**Step 1: Create the QA matrix.**

```typescript
// Path: plans/billing-ops/phases/phase3-correction-qa.md
export const correctionQaMatrix = [
  "Recorded payment amount change keeps status recorded.",
  "Verified payment amount change returns status to recorded and clears reviewer.",
  "Verified note-only correction keeps status verified.",
  "Payment type deposit-to-pif moves tenant stats bucket without changing payment count.",
  "Program change updates payment program fields and sold-program caches.",
  "Archived program is rejected.",
  "No-op submission returns changed false and creates no domain event.",
  "Disputed payment correction is rejected.",
] as const;
```

**Step 2: Verify downstream surfaces.**

| Correction | Surfaces to Check |
|---|---|
| Amount | Billing count unchanged; revenue totals delta; customer summary delta. |
| Type | Billing count may move type filter; revenue bucket moves; total revenue unchanged. |
| Program | Billing count moves program filter; opportunity/meeting sold program display updates. |
| Reference/note | No aggregate changes; event history shows metadata. |
| Reviewed financial | Queue status moves from `verified` to `recorded`. |

**Key implementation notes:**
- Run QA with one `recorded`, one `verified`, and one `disputed` payment.
- Capture aggregate counts before and after every correction.
- Verify no correction path changes `totalPaymentRecords`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/billing-ops/phases/phase3-correction-qa.md` | Create | Manual financial QA matrix |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/billing/validators.ts` | Modify | 3A |
| `convex/billing/mutations.ts` | Modify | 3A, 3B, 3C |
| `convex/lib/tenantStatsHelper.ts` | Modify | 3B |
| `convex/lib/soldProgramCache.ts` | Modify | 3C |
| `app/workspace/billing/_components/correction-dialog.tsx` | Create | 3D |
| `app/workspace/billing/_components/billing-review-page-client.tsx` | Modify | 3D, 3E |
| `app/workspace/billing/_components/billing-event-history.tsx` | Modify | 3E |
| `convex/billing/enrichment.ts` | Modify | 3E |
| `plans/billing-ops/phases/phase3-correction-qa.md` | Create | 3F |
