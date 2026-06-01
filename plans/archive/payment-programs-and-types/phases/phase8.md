# Phase 8 — Customer Read-Surface + Non-Commissionable Dialog + Payment Display Refreshes (Frontend)

**Goal:** Rewrite the *non-commissionable* post-conversion payment dialog, refresh every customer read-surface so it speaks the new program / payment-type / attribution vocabulary from Phase 5, and update every remaining payment display surface (deal-won card, reminder history panel, review outcome card) so the whole app stops referencing the removed `provider` field and starts rendering `programName` + `paymentType` + commissionability badges consistently. This is the third frontend phase; after it merges, every surface that shows a `paymentRecord` row is on the new schema.

One dialog rewritten, two customer surfaces refreshed, three display components updated, one verification pass:

1. **`app/workspace/customers/[customerId]/_components/record-payment-dialog.tsx`** — the non-commissionable admin-only dialog. Drops `Provider`, adds `Program` (pre-seeded from `customer.programId` when active) + `Payment Type`, **keeps** `Reference Code` (admin attaches the real transaction ID — this is the one commissionable-adjacent dialog that preserves it alongside review-resolution). Adds a top-of-dialog `<Alert>` banner explaining post-conversion semantics. Wraps the dialog trigger in an admin-only render gate.
2. **`app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx`** — swap `customer.programType` → `customer.programName`; gate the `<RecordPaymentDialog>` render on `useRole().isAdmin`; pass the enriched payments through to the rewritten `<PaymentHistoryTable>`.
3. **`app/workspace/customers/[customerId]/_components/payment-history-table.tsx`** — drop the `Provider` column; add `Program` + `Payment Type` columns; add an `Attribution` column that shows the closer name for commissionable rows or a muted `"Post-conversion"` chip for non-commissionable rows; keep `Date` / `Amount` / `Status` intact.
4. **`app/workspace/closer/meetings/_components/deal-won-card.tsx`** — used by BOTH `meeting-detail-page-client` (closer) and `admin-meeting-detail-client` (admin). Drop the `Provider` row; add `Program` + `Payment Type` rows; rename the `"Recorded By"` row to `"Attributed To"` with the `attributedCloserName` value; add a muted line `"Recorded by <admin name> on behalf of <closer name>"` when `recordedByUserId !== attributedCloserId`.
5. **`app/workspace/closer/reminders/[followUpId]/_components/reminder-history-panel.tsx`** — the prior-payments list gets a second muted line per row showing `<programName> · <paymentType>`. Shared unchanged by the new admin reminder detail client (Phase 7D re-exports this component via `closer/_components` — no duplication).
6. **`app/workspace/reviews/[reviewId]/_components/review-outcome-card.tsx`** — the `PaymentSection` loses the `Provider` meta line, gains `Program` + `Payment Type` meta, and shows a muted `"Recorded by <admin name> on behalf of <closer name>"` line when the recorder and attributed closer differ.
7. **Verification pass (8G)** — grep sweep for stale `provider` references, `programType` references, `closerId` references on payments; `pnpm tsc --noEmit` + `pnpm lint` clean; smoke test covering one admin-recorded customer-direct payment, one closer commissionable payment, and one admin-on-behalf commissionable payment — then walk every surface and confirm consistent vocabulary.

**Prerequisites:**

- **Phase 1 merged** — `tenantPrograms` table + `listPrograms` query. The `ProgramSelect` embedded in 8A depends on this.
- **Phase 2 merged** — `customers.programId` + `customers.programName` fields added; `customers.programType` removed. `paymentRecords` rewritten with `programId` / `programName` / `paymentType` / `commissionable` / `attributedCloserId` / `recordedByUserId`. **Without Phase 2 the new customer detail render blows up on `customer.programName` lookup** (the field is undefined) and the payment history table renders `undefined` for every new column.
- **Phase 4 merged** — `api.customers.mutations.recordCustomerPayment` is rewritten to admin-only with `customer_direct` origin + `originatingOpportunityId: customer.winningOpportunityId`. **Without Phase 4 the rewritten dialog submits a payload the server rejects** (the old validator accepts `provider`; the new one requires `programId` + `paymentType`).
- **Phase 5 merged** — read-surface queries enriched: `getCustomerDetail` returns payments with `programName` / `paymentType` / `commissionable` / `attributedCloserName` / `recordedByName`; `listCustomers` returns `customer.programName`; `getMeetingDetail` / `getReminderDetail` / `getReviewDetail` all expose the same enriched payment shape. **Without Phase 5 the display components 8D–8F render `undefined` on the new fields and fail at runtime where they assume the field exists.**
- **Phase 6A merged** — `ProgramSelect` at `app/workspace/closer/_components/program-select.tsx`. The 8A dialog imports it.
- **Phase 7 is NOT a hard prerequisite.** 8A–8G run in parallel with Phase 7. The `deal-won-card.tsx` refresh (8D) touches a file Phase 7 does not touch; same for `reminder-history-panel.tsx` (8E) and `review-outcome-card.tsx` (8F). The only Phase-7 intersection is the `review-resolution-dialog.tsx` — that file is untouched by Phase 8 (7C owns it).

**Runs in PARALLEL with:**

- **Phase 6 (6B–6E)** — Settings Programs UI is independent.
- **Phase 7 (7A–7E)** — Commissionable payment dialogs + admin reminder route. Zero shared files with Phase 8.
- **Phase 9 (9A–9E)** — Reporting UI + Dashboard + Activity Feed. Zero shared files with Phase 8 except the top-deals-table (owned by 9A; Phase 8 does not modify it).

**Runs SERIALLY with:**

- Nothing internal to Phase 8 except the verification pass (8G) which runs after 8A–8F complete.
- 8A / 8B are tightly coupled (8B renders 8A's dialog); in practice one developer ships both together. 8C is independent but imported by 8B.
- 8D / 8E / 8F are fully independent — three parallel display-refresh streams.

> **Critical path:** Phase 8 is the *broadest* frontend phase by surface count (six files touched across customers / meetings / reminders / reviews), but each subphase is small — display-refresh cardinality rather than business-logic cardinality. The risk is consistency: if the deal-won card shows `programName` but the reminder-history-panel keeps showing `provider`, users will ask "which is right?". 8G's grep sweep is the safety net that catches these straggler references before release.

**Skills to invoke:**

- `shadcn` — no new shadcn primitives. All changes compose existing `<Alert>`, `<Badge>`, `<Table>`, `<Card>`, `<Form>`, `<Select>`, `<Input>`, `<DropdownMenu>`. Verify visually in both themes.
- `frontend-design` — reference only. Payment-history table row density stays the same (single row per payment, no expansion). Commissionability renders as a muted chip, not a loud "Commission!" flag, because it is a reporting fact, not a user action.
- `vercel-composition-patterns` — the payment-history-table row and the deal-won payment entry share 80% of the same fields. An extraction `<PaymentMetaRow>` compound component is a candidate for a post-v0.5.1 polish pass, but deferred for the same reason as the 7A/7B deferral: the two callers have different densities (table cell vs. grid field) and premature extraction costs more than it saves. Follow-up noted at the bottom of this file.
- `vercel-react-best-practices` — the payment-history-table reads all columns from a plain array prop. No memoization needed; React 19's compiler handles this class of render optimization. Do NOT wrap the table rows in `React.memo`.
- `web-design-guidelines` — verify: (a) the non-commission banner in 8A uses `<Alert variant="default">` with `<InfoIcon>`, not destructive or warning variants (it is informational, not actionable), (b) every commissionability chip has an `aria-label` like `"Commissionable — attributed to Jane Doe"` so screen readers speak the full attribution, (c) the `Record Payment` CTA is the primary button on the customer detail page for admins but is *completely absent* for closers (not disabled — absent), (d) the payment-history table keeps a `role="status"` on the "No payments" empty state.
- `convex-performance-audit` — reference only. Phase 8 adds zero new Convex queries beyond `listPrograms` (via `ProgramSelect`, already shipped in Phase 6A). All other data comes from `getCustomerDetail` / `getMeetingDetail` / `getReminderDetail` / `getReviewDetail` return shapes already enriched in Phase 5.

**Acceptance Criteria:**

1. `record-payment-dialog.tsx` schema: drops `provider`, keeps `amount` / `currency` / `referenceCode` / `proofFile` unchanged, adds `programId: z.string().min(1, "Program is required")` and `paymentType: z.enum(["pif", "split", "monthly", "deposit"])`. Body order: `<Alert>` banner → `Amount` → `Currency` → `Program` (via `<ProgramSelect>`) → `Payment Type` → `Reference Code` → `Proof File`. `<Alert variant="default">` has title `"Post-conversion payment"` and body `"Payments recorded from the Customer page are not counted toward any closer's Cash Collected. They still appear in the customer's payment history and in admin revenue reports. Commission is only earned on payments logged from a meeting, reminder, or review-resolution flow."`.
2. `record-payment-dialog.tsx` pre-seeds `programId` from `customer.programId` when the customer's linked program is still active. The dialog accepts `customer` as a prop (or `customerProgramId` + `customerProgramIsActive`). If the customer's program is archived, the form opens with `programId: undefined` and the user picks an active program; the dialog never errors on mount. Pre-seeding happens inside the `open` `useEffect` reset (mirrors `field-mapping-dialog.tsx:133-146`), not inside `defaultValues`, so editing after reopening the dialog always reflects the latest customer state.
3. `record-payment-dialog.tsx` submit payload: `{ customerId, amount, currency, programId: programId as Id<"tenantPrograms">, paymentType, referenceCode?: referenceCode || undefined, proofFileId? }`. The two-step file-upload flow (`generateUploadUrl → fetch → recordCustomerPayment`) is preserved. The `Id<"tenantPrograms">` cast happens at the mutation boundary.
4. `record-payment-dialog.tsx` success path: `toast.success("Payment recorded")`, `await onPaymentRecorded?.()`, `setOpen(false)`, `form.reset()`. `posthog.capture("customer_payment_recorded", …)` metadata: `{ customer_id, amount_minor, currency, program_id, payment_type, has_reference_code, has_proof_file, preseeded_from_customer_program }`. The `preseeded_from_customer_program: boolean` lets the analytics team confirm admins usually accept the preselection.
5. `customer-detail-page-client.tsx` renders `customer.programName` in the Conversion card (was `customer.programType`). The label stays `"Program"`. When `programName` is `undefined` (pre-Phase-5 row or edge case), the card row is hidden — no `"— "` placeholder.
6. `customer-detail-page-client.tsx` wraps the `<RecordPaymentDialog>` render in `useRole().isAdmin && (…)`. Closers viewing the same page see the rest of the card exactly as admins do (total paid, history rows, statuses) but the CTA button is absent — not disabled with a tooltip. The status-control card stays visible; its internal admin check already hides write controls for non-admins.
7. `payment-history-table.tsx` columns after rewrite, left-to-right: `Date` → `Amount` → `Program` → `Payment Type` → `Reference` → `Attribution` → `Status`. The `Provider` column is gone. `Program` renders `payment.programName ?? "—"` with the currency chip beside the amount (no longer embedded in the currency column, because the amount already formats with currency). `Payment Type` renders capitalized (`PIF` / `Split` / `Monthly` / `Deposit`). `Attribution` renders `payment.attributedCloserName` for commissionable rows or a muted `"Post-conversion"` chip for non-commissionable rows.
8. `deal-won-card.tsx` payment row grid after rewrite: `Amount Paid` → `Program` (with `programName`) → `Payment Type` → `Reference` (when present) → `Recorded` (timestamp) → `Attributed To` (with `attributedCloserName`) → `Status`. The `Provider` row is gone. When `recordedByUserId !== attributedCloserId`, a muted `<p>` under the grid reads `"Recorded by <recordedByName> on behalf of <attributedCloserName>"` with `text-xs text-muted-foreground`. When they are equal, that line is absent (no "Recorded by X on behalf of X" tautology).
9. `reminder-history-panel.tsx` `<PaymentRow>` now renders two lines: line 1 `date · amount currency` (unchanged); line 2 `<programName> · <paymentType>` in `text-xs text-muted-foreground`, left-aligned. When `programName` is `undefined` (edge case), line 2 renders only `paymentType` capitalized. Non-commissionable rows are *impossible* in the reminder detail view (reminders are always commissionable), but the component must not crash if a `customer_direct` row somehow appears — it renders a muted `"post-conversion"` chip replacing line 2.
10. `review-outcome-card.tsx` `<PaymentSection>` meta grid keeps `Reference`, replaces `Provider` with `Program` (`programName`) + `Payment Type`, and appends a line `"Recorded by <recordedByName>"` when `recordedByUserId !== attributedCloserId` (admin-on-behalf) or omits the line when equal. The "Logged by <closerName>" header line (line 272 of the current file) is replaced with "Attributed to <attributedCloserName>" — the review-resolution flow always renders a commissionable payment so `attributedCloserName` is always set.
11. `pnpm tsc --noEmit` passes with zero errors. Grep confirms:
    - Zero references to `customer.programType` across `app/**`, `components/**`, `hooks/**`, `lib/**`.
    - Zero references to `payment.provider` across the same scope.
    - Zero references to `payment.closerId` or `payment.closerName` across the same scope (Phase 5 renamed; Phase 8 lands the final consumer rewrites).
    - Zero references to the `PROVIDERS` enum in `app/workspace/customers/**` (the record-payment-dialog was the last consumer).
    - Every occurrence of `payment.programName` is wrapped in a `?? "—"` or equivalent fallback (since the field is optional on the query return despite being denormalized at write time — defensive on the TS boundary).
12. `pnpm lint` passes with zero new warnings. No `eslint-disable` comments added.
13. Smoke test (per `TESTING.MD`): on a tenant with two active programs (`Launchpad`, `Accelerator`), one converted customer (originating opp on `Launchpad`), and three payments — (a) a commissionable PIF logged by the closer from the meeting flow, (b) a commissionable deposit logged by an admin on behalf of a closer from the meeting flow, and (c) a non-commissionable `$500` monthly logged by an admin from the customer page — walk every surface and confirm:
    - Customer detail page shows `Launchpad` under `Program`, a `Record Payment` CTA (as admin) / no CTA (as closer), and a payment history table with all three rows — columns match acceptance #7, Attribution column shows `Jane Closer`, `Jane Closer`, and `Post-conversion` respectively.
    - Closer meeting detail deal-won card shows the first two payments with `Program: Launchpad`, `Payment Type: PIF` / `Deposit`, `Attributed To: Jane Closer`, and the muted "Recorded by ... on behalf of ..." line appears on the deposit row but not the PIF row.
    - Admin meeting detail page shows the same deal-won card with identical content (shared component; the `on behalf of` line fires on the deposit row for the admin viewer too).
    - Closer reminder detail (if the opportunity had a reminder) shows the prior-payments list with the two-line format.
    - Admin reminder detail (from Phase 7D; not strictly required to be up for Phase 8 to smoke-test) shows the same two-line format.
    - Review-detail page (if a review was generated from a meeting-overran flag) shows the payment audit list with `Program: Launchpad`, `Payment Type`, `Reference` (when present), and the "Recorded by ... on behalf of ..." line on the admin-logged deposit.

---

## Subphase Dependency Graph

```
8A (record-payment-dialog rewrite)      ──┐
                                          │
8B (customer-detail-page-client refresh) ──┤
                                          │
8C (payment-history-table rewrite)      ──┼──▶ 8G (verification pass)
                                          │
8D (deal-won-card refresh)              ──┤
                                          │
8E (reminder-history-panel refresh)     ──┤
                                          │
8F (review-outcome-card refresh)        ──┘
```

**Edges explained:**

- **8A / 8B / 8C form a natural cluster.** 8B renders 8A's dialog; 8C is imported by 8B. In practice one developer ships all three in one PR.
- **8D / 8E / 8F are fully independent.** Three different files in three different directories, no shared imports. Three parallel streams possible.
- **8G runs last.** Grep + typecheck + lint + full smoke test.

**Optimal execution:**

1. **Ship 8A + 8B + 8C together** (~half-day sprint). One PR; the three files interlock naturally and sharing the review cycle is cheaper than splitting.
2. **Ship 8D + 8E + 8F in parallel** (~half-day sprint, three developers — or one developer back-to-back in 2–3 hours). Each file is a 40-line edit.
3. **Run 8G** after the above lands on `main`. Grep takes a minute; the smoke test takes ~30 min on a seeded tenant.

**Estimated time:** 1 day solo, 0.5 day with three parallel streams after 8A/B/C lands.

---

## Subphases

### 8A — Rewrite `record-payment-dialog.tsx` (Admin-Only, Non-Commissionable)

**Type:** Frontend (`"use client"`)
**Parallelizable:** Packaged with 8B + 8C in one PR, but independent at the file level.

**What:** Rewrite the dialog to drop the `PROVIDERS` enum, drop the `provider` RHF field, add `programId` (via shared `<ProgramSelect>`) with pre-seeding from `customer.programId`, add `paymentType` enum select, add the post-conversion `<Alert>` banner at the top. Keep `referenceCode` (this is the one dialog with Reference Code besides review-resolution). Keep the proof-file upload flow.

**Why:** The current dialog at `app/workspace/customers/[customerId]/_components/record-payment-dialog.tsx` (406 lines, reviewed pre-rewrite) assumes the old payment shape — hardcoded `PROVIDERS` list, no program concept, no payment-type concept. Phase 2 dropped `provider` from `paymentRecords` and added `programId` + `paymentType` as required fields. Phase 3 rewrote `recordCustomerPayment` to require them. Phase 5 enriched `getCustomerDetail` with `customer.programId` + `programName` so the dialog can pre-seed intelligently. Phase 8A is the frontend catch-up.

**Where:**
- `app/workspace/customers/[customerId]/_components/record-payment-dialog.tsx` (rewritten)

**How:**

**Step 1: Imports**

```tsx
// Path: app/workspace/customers/[customerId]/_components/record-payment-dialog.tsx (rewritten)
"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { FieldGroup } from "@/components/ui/field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import {
  BanknoteIcon,
  AlertCircleIcon,
  InfoIcon,
  UploadIcon,
} from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";

// NEW — shared program dropdown from Phase 6A
import { ProgramSelect } from "@/app/workspace/closer/_components/program-select";
```

**Step 2: Constants + schema**

```tsx
// ---------------------------------------------------------------------------
// Constants — Provider enum REMOVED. Payment type enum added.
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const VALID_FILE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "application/pdf",
];
const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"] as const;

const PAYMENT_TYPES = [
  { value: "pif", label: "PIF (Paid in Full)" },
  { value: "split", label: "Split Payment" },
  { value: "monthly", label: "Monthly" },
  { value: "deposit", label: "Deposit" },
] as const;

// ---------------------------------------------------------------------------
// Schema — drops `provider`; adds `programId` + `paymentType`; keeps
// `referenceCode`, `amount`, `currency`, `proofFile` exactly as before.
// ---------------------------------------------------------------------------

const paymentSchema = z.object({
  amount: z
    .string()
    .min(1, "Amount is required")
    .refine(
      (val) => {
        const num = parseFloat(val);
        return !isNaN(num) && num > 0;
      },
      { message: "Amount must be greater than 0" },
    ),
  currency: z.enum(CURRENCIES),
  programId: z.string().min(1, "Program is required"),
  paymentType: z.enum(["pif", "split", "monthly", "deposit"], {
    error: "Please select a payment type",
  }),
  referenceCode: z.string().optional(),
  proofFile: z
    .instanceof(File)
    .optional()
    .refine(
      (file) => !file || file.size <= MAX_FILE_SIZE,
      "File size must be less than 10 MB",
    )
    .refine(
      (file) => !file || VALID_FILE_TYPES.includes(file.type),
      "Only images (JPEG, PNG, GIF) and PDFs are allowed",
    ),
});

type PaymentFormValues = z.infer<typeof paymentSchema>;
```

**Step 3: Component — props widened with customer-program context**

```tsx
interface RecordPaymentDialogProps {
  customerId: Id<"customers">;
  /**
   * Customer's current program linkage. Used to pre-seed `programId` when
   * the dialog opens. If the program is archived (`isActive === false`) the
   * dialog opens with no preselected program and requires the user to pick
   * an active one — see design §14 edge case "customer points at archived
   * program".
   */
  customerProgram: {
    id: Id<"tenantPrograms"> | undefined;
    isActive: boolean;
  };
  onPaymentRecorded?: () => void;
}

export function RecordPaymentDialog({
  customerId,
  customerProgram,
  onPaymentRecorded,
}: RecordPaymentDialogProps) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const generateUploadUrl = useMutation(api.closer.payments.generateUploadUrl);
  const recordPayment = useMutation(
    api.customers.mutations.recordCustomerPayment,
  );

  const form = useForm({
    resolver: standardSchemaResolver(paymentSchema),
    defaultValues: {
      amount: "",
      currency: "USD",
      programId: "",
      paymentType: undefined,
      referenceCode: "",
      proofFile: undefined,
    },
  });

  // --- Pre-seed programId when the dialog opens -----------------------------
  // Why inside useEffect rather than defaultValues:
  //   - defaultValues snapshots at mount; if the admin changes the customer's
  //     program in another tab then reopens this dialog, the preseed needs to
  //     reflect the NEW program. Re-seeding on `open` flip guarantees that.
  //   - Mirrors the field-mapping-dialog.tsx:133-146 pattern.
  useEffect(() => {
    if (!open) return;
    const preseeded =
      customerProgram.isActive && customerProgram.id
        ? customerProgram.id
        : "";
    form.reset({
      amount: "",
      currency: "USD",
      programId: preseeded,
      paymentType: undefined,
      referenceCode: "",
      proofFile: undefined,
    });
    setSubmitError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps — `form` / `customerProgram.id` / `customerProgram.isActive` covered
  }, [open, customerProgram.id, customerProgram.isActive]);
```

**Step 4: Submit handler — new payload shape, PostHog metadata updated**

```tsx
  const onSubmit = async (values: PaymentFormValues) => {
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      // === Upload proof file (unchanged two-step flow) =====================
      let proofFileId: Id<"_storage"> | undefined;
      if (values.proofFile) {
        const uploadUrl = await generateUploadUrl();
        const uploadResponse = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": values.proofFile.type },
          body: values.proofFile,
        });

        if (!uploadResponse.ok) {
          throw new Error("Failed to upload proof file");
        }

        const uploadData = (await uploadResponse.json()) as {
          storageId?: string;
        };
        if (!uploadData.storageId) {
          throw new Error("File upload returned invalid storage ID");
        }
        proofFileId = uploadData.storageId as Id<"_storage">;
      }

      // === Record payment — NEW field vocabulary ============================
      await recordPayment({
        customerId,
        amount: parseFloat(values.amount),
        currency: values.currency,
        programId: values.programId as Id<"tenantPrograms">,
        paymentType: values.paymentType,
        referenceCode: values.referenceCode || undefined,
        proofFileId,
      });

      // === Analytics — dropped `provider` / `has_reference_code` is RENAMED
      // to the more meaningful `preseeded_from_customer_program` so the
      // analytics team can measure whether admins accept the preselection.
      posthog.capture("customer_payment_recorded", {
        customer_id: customerId,
        amount_minor: Math.round(parseFloat(values.amount) * 100),
        currency: values.currency,
        program_id: values.programId,
        payment_type: values.paymentType,
        has_reference_code: !!values.referenceCode,
        has_proof_file: !!values.proofFile,
        preseeded_from_customer_program:
          customerProgram.isActive &&
          !!customerProgram.id &&
          customerProgram.id === values.programId,
      });

      toast.success("Payment recorded");
      setOpen(false);
      onPaymentRecorded?.();
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to record payment. Please try again.";
      setSubmitError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };
```

**Step 5: JSX — banner + new fields in the documented order**

```tsx
  return (
    <>
      <Button onClick={() => setOpen(true)} variant="outline" size="sm">
        <BanknoteIcon data-icon="inline-start" />
        Record Payment
      </Button>

      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!isSubmitting) setOpen(value);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Record Payment</DialogTitle>
            <DialogDescription>
              Record a post-conversion payment (installment, upsell, renewal).
            </DialogDescription>
          </DialogHeader>

          {/* --- NEW --- Post-conversion explanatory banner ----------------- */}
          <Alert className="mb-4" variant="default">
            <InfoIcon />
            <AlertTitle>Post-conversion payment</AlertTitle>
            <AlertDescription>
              Payments recorded from the Customer page are <strong>not</strong>{" "}
              counted toward any closer&apos;s Cash Collected. They still appear
              in the customer&apos;s payment history and in admin revenue
              reports. Commission is only earned on payments logged from a
              meeting, reminder, or review-resolution flow.
            </AlertDescription>
          </Alert>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)}>
              <FieldGroup>
                {/* Amount */}
                <FormField
                  control={form.control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Amount <span className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          step="0.01"
                          placeholder="299.99"
                          min="0"
                          disabled={isSubmitting}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Currency */}
                <FormField
                  control={form.control}
                  name="currency"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Currency <span className="text-destructive">*</span>
                      </FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value}
                        disabled={isSubmitting}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectGroup>
                            {CURRENCIES.map((curr) => (
                              <SelectItem key={curr} value={curr}>
                                {curr}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* --- NEW --- Program (shared ProgramSelect) --------------- */}
                <FormField
                  control={form.control}
                  name="programId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Program <span className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <ProgramSelect
                          value={field.value || undefined}
                          onChange={field.onChange}
                          disabled={isSubmitting}
                          placeholder="Select program"
                        />
                      </FormControl>
                      <FormDescription>
                        {customerProgram.isActive && customerProgram.id
                          ? "Pre-seeded from this customer's program. Change only if this payment belongs to a different program."
                          : "This customer's original program is archived. Pick an active program for this payment."}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* --- NEW --- Payment Type -------------------------------- */}
                <FormField
                  control={form.control}
                  name="paymentType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Payment Type <span className="text-destructive">*</span>
                      </FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value}
                        disabled={isSubmitting}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select payment type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectGroup>
                            {PAYMENT_TYPES.map((pt) => (
                              <SelectItem key={pt.value} value={pt.value}>
                                {pt.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Reference Code (kept — admin attaches real txn ID) ------- */}
                <FormField
                  control={form.control}
                  name="referenceCode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Reference Code</FormLabel>
                      <FormControl>
                        <Input
                          type="text"
                          placeholder="e.g., pi_3abc123..."
                          disabled={isSubmitting}
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        Transaction ID from your payment provider
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Proof File (unchanged) ---------------------------------- */}
                <FormField
                  control={form.control}
                  name="proofFile"
                  render={({ field: { value, onChange, ...fieldProps } }) => (
                    <FormItem>
                      <FormLabel>Proof File</FormLabel>
                      <FormControl>
                        <Input
                          type="file"
                          accept="image/jpeg,image/png,image/gif,application/pdf"
                          disabled={isSubmitting}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            onChange(file);
                          }}
                          {...fieldProps}
                        />
                      </FormControl>
                      {value && (
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <UploadIcon className="size-3 shrink-0" />
                          <span className="truncate">
                            {value.name} ({(value.size / 1024).toFixed(1)} KB)
                          </span>
                        </div>
                      )}
                      <FormDescription>
                        Max 10 MB. Allowed: PNG, JPEG, GIF, PDF
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </FieldGroup>

              {submitError && (
                <Alert variant="destructive" className="mt-4">
                  <AlertCircleIcon />
                  <AlertDescription>{submitError}</AlertDescription>
                </Alert>
              )}

              <DialogFooter className="mt-5">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setOpen(false)}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <>
                      <Spinner data-icon="inline-start" />
                      Recording...
                    </>
                  ) : (
                    "Record Payment"
                  )}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  );
}
```

**Acceptance for 8A:**
- File compiles (`pnpm tsc --noEmit`).
- Grep confirms zero references to the deleted `PROVIDERS` enum in `app/workspace/customers/**`.
- Grep confirms the new `ProgramSelect` import at the top.
- RHF `defaultValues` do not contain `programId` populated — that happens on `open` flip inside the `useEffect`.
- Manual test: open the dialog as an admin; the program is pre-seeded from the customer's program. Change the program, submit; confirm the submitted `programId` matches the selection, not the preseed.

---

### 8B — Refresh `customer-detail-page-client.tsx` (programName display + admin gate)

**Type:** Frontend (`"use client"`)
**Parallelizable:** Packaged with 8A + 8C.

**What:**
1. Swap the `customer.programType` reference for `customer.programName`.
2. Wrap `<RecordPaymentDialog>` in an `isAdmin` guard from `useRole()`.
3. Pass the new `customerProgram` prop shape into `<RecordPaymentDialog>` (extract `programId` + an `isActive` computation from the detail response).
4. Pass the enriched payments through to the rewritten `<PaymentHistoryTable>` (8C owns the Table shape).

**Why:** The Conversion card currently prints `customer.programType` (a freeform string — removed in Phase 2). Phase 2 added `customer.programId` + `customer.programName`. Phase 5 ensures `listCustomers` + `getCustomerDetail` expose both. Phase 8B is the frontend consumption.

The admin gate closes the loophole exposed by the design: closers can read the customer page (tenant-wide read-only) but must never see the `Record Payment` CTA. The server-side mutation check (Phase 3's `requireRole(["tenant_master","tenant_admin"])` on `recordCustomerPayment`) is the authoritative gate; the client-side gate is a UX clarity layer so closers never see a button that would error on click.

**Where:**
- `app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx` (modify)

**How:**

**Step 1: Imports — add `useRole`**

```tsx
// Path: app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx (MODIFY)
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeftIcon } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import { usePageTitle } from "@/hooks/use-page-title";
import { formatCurrency } from "@/lib/format-currency";
import { format, formatDistanceToNow } from "date-fns";
import { useRole } from "@/components/auth/role-context"; // NEW
import { CustomerStatusBadge } from "../../_components/customer-status-badge";
import { CustomerStatusControl } from "../../_components/customer-status-control";
import { PaymentHistoryTable } from "./payment-history-table";
import { RecordPaymentDialog } from "./record-payment-dialog";
```

**Step 2: Swap `customer.programType` → `customer.programName`**

Before (lines 190–195):

```tsx
{customer.programType && (
  <div>
    <p className="text-xs text-muted-foreground">Program</p>
    <p className="text-sm font-medium">{customer.programType}</p>
  </div>
)}
```

After:

```tsx
{customer.programName && (
  <div>
    <p className="text-xs text-muted-foreground">Program</p>
    <p className="text-sm font-medium">{customer.programName}</p>
  </div>
)}
```

**Step 3: Admin gate on the `Record Payment` CTA + pass `customerProgram` prop**

Before (lines 206–218 — Payment History card header):

```tsx
<Card>
  <CardHeader>
    <div className="flex items-center justify-between">
      <CardTitle className="text-base">Payment History</CardTitle>
      <RecordPaymentDialog
        customerId={id}
        onPaymentRecorded={() => {
          /* useQuery auto-refreshes */
        }}
      />
    </div>
  </CardHeader>
```

After:

```tsx
const { isAdmin } = useRole();

// Inside the JSX, replacing the current Payment History header —

<Card>
  <CardHeader>
    <div className="flex items-center justify-between">
      <CardTitle className="text-base">Payment History</CardTitle>
      {isAdmin && (
        <RecordPaymentDialog
          customerId={id}
          customerProgram={{
            id: customer.programId,
            // Phase 5 returns `customer.programName` only when the program
            // is active (see design §14); if `programName` is undefined,
            // treat the linkage as inactive.
            isActive: !!customer.programName,
          }}
          onPaymentRecorded={() => {
            /* useQuery auto-refreshes */
          }}
        />
      )}
    </div>
  </CardHeader>
```

**Note** on `customerProgram.isActive`: the design wants the admin dialog to pre-seed the program only when the customer's linked program is still available for selection. Phase 5 only denormalizes `programName` at write time (on `customers.programName`), and doesn't guarantee the program is still active at read time. If a closer reassigns the customer's program or the admin archives it, `programName` is stale. For Phase 8 we adopt the design's conservative rule: **`programName` presence IS the active signal** — `getCustomerDetail` in Phase 5 is free to null out `programName` when the program is archived (design §14 edge case). If Phase 5 lands *without* that null-out, 8B's implementation is still safe because `isActive: !!programName` defaults to `true` when the program still exists under any state; the dialog's internal check against `ProgramSelect`'s active-programs-only list would re-filter anyway.

**Step 4: Pass enriched payments to `<PaymentHistoryTable>` — shape change lives in 8C**

The `payments` destructuring at line 64–74 is unchanged:

```tsx
const {
  customer,
  lead,
  winningOpportunity,
  winningMeeting,
  convertedByName,
  closerName,
  totalPaid,
  currency,
  payments, // now enriched with programName / paymentType / commissionable / attributedCloserName / recordedByName
} = detail;
```

`<PaymentHistoryTable payments={payments} />` at line 228 stays — Table type widens in 8C to accept the enriched shape.

**Acceptance for 8B:**
- File compiles.
- Grep confirms zero references to `customer.programType` in this file.
- As a closer signed in at `/workspace/customers/<id>`, the Record Payment button is absent. As an admin, it is present.
- The Conversion card shows `customer.programName` when set; the row is hidden when unset.
- Props passed to `<RecordPaymentDialog>` match the new interface from 8A.

---

### 8C — Rewrite `payment-history-table.tsx` (drop Provider, add Program / Payment Type / Attribution)

**Type:** Frontend (`"use client"`)
**Parallelizable:** Packaged with 8A + 8B.

**What:** Replace the existing 5-column table (`Date`, `Amount`, `Provider`, `Reference`, `Status`) with a 7-column table (`Date`, `Amount`, `Program`, `Payment Type`, `Reference`, `Attribution`, `Status`). The row shape widens to consume the Phase 5 enrichment: `programName`, `paymentType`, `commissionable`, `attributedCloserName`.

**Why:** The current table hardcodes `Provider` as a column (Phase 2 dropped the field) and has no surface for `programName` / `paymentType` / attribution. Phase 5 adds all three to the query response. Phase 8C wires them up.

**Where:**
- `app/workspace/customers/[customerId]/_components/payment-history-table.tsx` (rewritten)

**How:**

**Step 1: Widen the `Payment` interface**

```tsx
// Path: app/workspace/customers/[customerId]/_components/payment-history-table.tsx (rewritten)
"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { formatCurrency } from "@/lib/format-currency";
import type { Id } from "@/convex/_generated/dataModel";

// Matches the Phase 5 shape of `getCustomerDetail.payments[N]`.
interface Payment {
  _id: Id<"paymentRecords">;
  amount: number;
  currency: string;
  status: "recorded" | "verified" | "disputed";
  recordedAt: number;
  referenceCode?: string;
  // NEW — Phase 5 enrichment
  programId: Id<"tenantPrograms">;
  programName?: string;
  paymentType: "pif" | "split" | "monthly" | "deposit";
  commissionable: boolean;
  attributedCloserId?: Id<"users">;
  attributedCloserName: string | null;
  recordedByUserId: Id<"users">;
  recordedByName: string | null;
}

const statusConfig = {
  recorded: {
    label: "Recorded",
    className:
      "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/25",
  },
  verified: {
    label: "Verified",
    className:
      "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/25",
  },
  disputed: {
    label: "Disputed",
    className:
      "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/25",
  },
} as const;

const PAYMENT_TYPE_LABELS = {
  pif: "PIF",
  split: "Split",
  monthly: "Monthly",
  deposit: "Deposit",
} as const;
```

**Step 2: Rewrite the table body — 7 columns in the documented order**

```tsx
interface PaymentHistoryTableProps {
  payments: Payment[];
}

export function PaymentHistoryTable({ payments }: PaymentHistoryTableProps) {
  if (payments.length === 0) {
    return (
      <p
        className="py-4 text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        No payments recorded yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Program</TableHead>
            <TableHead>Payment Type</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead>Attribution</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {payments.map((payment) => {
            const statusCfg = statusConfig[payment.status];
            return (
              <TableRow key={payment._id}>
                <TableCell className="text-sm">
                  {format(new Date(payment.recordedAt), "MMM d, yyyy")}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {formatCurrency(payment.amount, payment.currency)}
                </TableCell>
                <TableCell className="text-sm">
                  {payment.programName ?? "—"}
                </TableCell>
                <TableCell className="text-sm">
                  {PAYMENT_TYPE_LABELS[payment.paymentType]}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {payment.referenceCode ?? "—"}
                </TableCell>
                <TableCell className="text-sm">
                  {payment.commissionable ? (
                    <span
                      aria-label={`Commissionable — attributed to ${payment.attributedCloserName ?? "unknown"}`}
                    >
                      {payment.attributedCloserName ?? "—"}
                    </span>
                  ) : (
                    <Badge
                      variant="outline"
                      className="bg-muted/60 text-muted-foreground"
                      aria-label="Post-conversion — not commissionable"
                    >
                      Post-conversion
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={statusCfg.className}>
                    {statusCfg.label}
                  </Badge>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
```

**Acceptance for 8C:**
- File compiles.
- Grep confirms zero references to the old `provider` field name in this file.
- Manual test: load a customer with one commissionable payment (attribution column shows closer name) and one non-commissionable payment (attribution column shows "Post-conversion" chip).
- Column widths don't cause horizontal scroll on a 1280px viewport; on narrower viewports the existing `overflow-x-auto` wrapper handles it.

---

### 8D — Refresh `deal-won-card.tsx` (drop Provider, add Program / Payment Type / admin-on-behalf line)

**Type:** Frontend (`"use client"`)
**Parallelizable:** Yes — fully independent.

**What:** Inside the per-payment grid (`<dl>` at lines 108–180 of the current file), drop the `Provider` row and add two new rows: `Program` (rendering `programName`) and `Payment Type` (rendering the capitalized label). Rename `Recorded By` to `Attributed To` and populate it with `attributedCloserName`. Add a muted explainer line under the grid when `recordedByUserId !== attributedCloserId` that reads `"Recorded by <recordedByName> on behalf of <attributedCloserName>"`.

**Why:** The deal-won card is the primary surface for "look at the payment that just closed this deal" on both the closer meeting detail and the admin meeting detail. Both pages import this same file. The Phase 5 `getMeetingDetail` now returns payments with `programName` / `paymentType` / `attributedCloserName` / `recordedByName`; the current card still reads `provider` and the old `closerName` field. Phase 8D lands the visual refresh.

**Where:**
- `app/workspace/closer/meetings/_components/deal-won-card.tsx` (modify)

**How:**

**Step 1: Update the `EnrichedPayment` type**

```tsx
// Path: app/workspace/closer/meetings/_components/deal-won-card.tsx (MODIFY — top of file)
type EnrichedPayment = {
  _id: string;
  amount: number;
  currency: string;
  // REMOVED: provider
  referenceCode?: string;
  status: "recorded" | "verified" | "disputed";
  recordedAt: number;
  proofFileUrl: string | null;
  proofFileContentType: string | null;
  proofFileSize: number | null;
  // NEW — Phase 5 enrichment
  programId: string;
  programName?: string;
  paymentType: "pif" | "split" | "monthly" | "deposit";
  commissionable: boolean;
  attributedCloserId?: string;
  attributedCloserName: string | null;
  recordedByUserId: string;
  recordedByName: string | null;
};
```

**Step 2: Replace the `Provider` row with `Program` + `Payment Type`**

Before (lines 120–128):

```tsx
{/* Provider */}
<div>
  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
    Provider
  </dt>
  <dd className="flex items-center gap-1.5 text-sm font-medium">
    <CreditCardIcon className="size-3.5 text-muted-foreground" />
    {payment.provider}
  </dd>
</div>
```

After:

```tsx
{/* Program */}
<div>
  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
    Program
  </dt>
  <dd className="text-sm font-medium">{payment.programName ?? "—"}</dd>
</div>

{/* Payment Type */}
<div>
  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
    Payment Type
  </dt>
  <dd className="text-sm font-medium capitalize">{payment.paymentType}</dd>
</div>
```

Remove the now-unused `CreditCardIcon` import if no other code in the file uses it.

**Step 3: Rename `Recorded By` → `Attributed To` + add admin-on-behalf muted line**

Before (lines 153–164):

```tsx
{/* Recorded By */}
{payment.closerName && (
  <div>
    <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
      Recorded By
    </dt>
    <dd className="flex items-center gap-1.5 text-sm font-medium">
      <UserIcon className="size-3.5 text-muted-foreground" />
      {payment.closerName}
    </dd>
  </div>
)}
```

After:

```tsx
{/* Attributed To — commissionable payments only */}
{payment.commissionable && payment.attributedCloserName && (
  <div>
    <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
      Attributed To
    </dt>
    <dd className="flex items-center gap-1.5 text-sm font-medium">
      <UserIcon className="size-3.5 text-muted-foreground" />
      {payment.attributedCloserName}
    </dd>
  </div>
)}
```

Immediately below the closing `</dl>` (line 180), before the Proof File block, add:

```tsx
{/* Admin-on-behalf explainer — only when recorder and attributed closer differ */}
{payment.commissionable &&
  payment.attributedCloserId &&
  payment.recordedByUserId !== payment.attributedCloserId && (
    <p className="mt-2 text-xs italic text-muted-foreground">
      Recorded by{" "}
      <span className="font-medium">
        {payment.recordedByName ?? "an admin"}
      </span>{" "}
      on behalf of{" "}
      <span className="font-medium">
        {payment.attributedCloserName ?? "the assigned closer"}
      </span>
      .
    </p>
  )}
```

**Acceptance for 8D:**
- File compiles.
- Grep confirms zero references to `payment.provider` or `payment.closerName` in this file.
- The `CreditCardIcon` import is removed if unused elsewhere in the file.
- Manual test (closer meeting detail): a PIF payment recorded by the closer renders `Program: Launchpad`, `Payment Type: PIF`, `Attributed To: <closer name>`, and no "Recorded by ... on behalf of ..." line.
- Manual test (admin-on-behalf): a deposit payment recorded by an admin on behalf of a closer renders the same fields plus the muted italic line.

---

### 8E — Refresh `reminder-history-panel.tsx` (program + payment-type context per row)

**Type:** Frontend (`"use client"`)
**Parallelizable:** Yes — fully independent.

**What:** Inside the `<PaymentRow>` helper (lines 139–161), render a second line under the primary `date · amount` line showing `<programName> · <paymentType>`. When `commissionable === false` (edge case: a stray `customer_direct` row somehow reached this view), replace the program/paymentType line with a muted `"post-conversion"` chip.

**Why:** The reminder detail page (both closer and the new admin route from Phase 7D) shows prior payments on the opportunity so the user can answer "have we already taken a deposit?". Today the row shows only `date · amount currency`; the reviewer has to cross-reference the meeting detail page to see what program and payment type the prior payment was for. Phase 5 enriched the `getReminderDetail` + `getAdminReminderDetail` responses with `programName` + `paymentType` — Phase 8E makes the data visible.

The Phase 7D admin route imports this same file via `app/workspace/closer/reminders/[followUpId]/_components/reminder-history-panel.tsx`. One rewrite covers both views.

**Where:**
- `app/workspace/closer/reminders/[followUpId]/_components/reminder-history-panel.tsx` (modify)

**How:**

**Step 1: Update the `Props` type** — the `payments` array now carries the enriched fields. Since the current file types `payments` as `Doc<"paymentRecords">[]`, and Phase 2 rewrote `Doc<"paymentRecords">` to include `programId` / `programName` / `paymentType` / `commissionable`, the field accesses Just Work. Confirm the type inference is correct — no new explicit typing needed. If the Phase 5 query returns enriched rows (`Doc<"paymentRecords"> & { attributedCloserName, recordedByName }`), the Props type can widen accordingly, but the existing shape works.

**Step 2: Rewrite `<PaymentRow>`**

Before (lines 139–161):

```tsx
function PaymentRow({ payment }: { payment: Doc<"paymentRecords"> }) {
  const amount = (payment.amountMinor / 100).toFixed(2);
  const date = format(
    new Date(payment.recordedAt ?? payment._creationTime),
    "MMM d",
  );

  return (
    <li className="flex items-center justify-between text-sm tabular-nums">
      <span className="text-muted-foreground">{date}</span>
      <span className="font-medium">
        {amount} {payment.currency.toUpperCase()}
      </span>
    </li>
  );
}
```

After:

```tsx
const PAYMENT_TYPE_LABELS = {
  pif: "PIF",
  split: "Split",
  monthly: "Monthly",
  deposit: "Deposit",
} as const;

function PaymentRow({ payment }: { payment: Doc<"paymentRecords"> }) {
  const amount = (payment.amountMinor / 100).toFixed(2);
  const date = format(
    new Date(payment.recordedAt ?? payment._creationTime),
    "MMM d",
  );

  // Defensive: payment.paymentType is required after Phase 2, but the
  // compiler still allows `undefined` when the Doc type is read in a
  // mid-migration window. Fall back to a dash rather than crashing.
  const typeLabel =
    PAYMENT_TYPE_LABELS[payment.paymentType as keyof typeof PAYMENT_TYPE_LABELS] ??
    "—";

  return (
    <li className="flex flex-col gap-0.5 text-sm tabular-nums">
      {/* Line 1: date + amount (unchanged layout) */}
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">{date}</span>
        <span className="font-medium">
          {amount} {payment.currency.toUpperCase()}
        </span>
      </div>
      {/* Line 2: program · type — or post-conversion pill on the edge case */}
      <div className="flex items-center justify-between text-xs">
        {payment.commissionable ? (
          <span className="text-muted-foreground">
            {payment.programName ?? "—"} · {typeLabel}
          </span>
        ) : (
          <span className="italic text-muted-foreground">post-conversion</span>
        )}
      </div>
    </li>
  );
}
```

**Acceptance for 8E:**
- File compiles.
- Grep confirms zero references to `payment.provider` in this file (there never were any, but the check is part of the 8G sweep).
- Manual test (closer reminder detail on an opportunity with one prior deposit): the row renders two lines — `MMM d | $500 USD` and `Launchpad · Deposit`.
- Row height stays within the `flex-col gap-1.5` outer `<ul>` spacing; no visual regression on long program names (truncation isn't needed because the `flex justify-between` naturally flows).

---

### 8F — Refresh `review-outcome-card.tsx` `PaymentSection` (drop Provider, add Program / Payment Type / on-behalf line)

**Type:** Frontend (`"use client"`)
**Parallelizable:** Yes — fully independent.

**What:** Only the `<PaymentSection>` helper (lines 244–345) of this file is in scope. Replace the `Provider` meta line with `Program` + `Payment Type`. Rename the `"Logged by <closerName>"` header with `"Attributed to <attributedCloserName>"`. Append a `"Recorded by <recordedByName>"` muted line when the recorder and attributed closer differ.

**Why:** The review outcome card is the admin's audit surface for a meeting-overran review. When the closer logged a payment to close the review, the audit row must show which program the payment credited, whether it was a deposit or final, and — critically — whether an admin had to record it on behalf of the closer. The current card shows `Provider` (gone) and `Logged by <closerName>` (renamed to `attributedCloserName` in Phase 5). Phase 8F lands the final rendering.

Non-commissionable payments never reach a meeting-review surface (reviews are meeting-driven, payments logged from the review-resolution flow are always commissionable with `origin: "admin_review_resolution"`), so the Phase 8F changes are narrower than 8D: no commissionable-vs-not branch, just the vocabulary rename.

**Where:**
- `app/workspace/reviews/[reviewId]/_components/review-outcome-card.tsx` (modify)

**How:**

**Step 1: Widen the `PaymentRecord` type — reuse `Doc<"paymentRecords">` enriched by Phase 5**

The current type is `type PaymentRecord = Doc<"paymentRecords">;` (line 56). Phase 5 extends the `getReviewDetail` response to include `attributedCloserName` + `recordedByName` on every payment row. Widen the local alias:

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/review-outcome-card.tsx (MODIFY, line 56)
type PaymentRecord = Doc<"paymentRecords"> & {
  attributedCloserName?: string | null;
  recordedByName?: string | null;
};
```

**Step 2: Rename the header from `Logged by <closerName>` to `Attributed to <attributedCloserName>`**

Before (lines 269–273):

```tsx
return (
  <div className="space-y-3">
    <div className="text-muted-foreground">
      Logged by <span className="font-medium text-foreground">{closerName}</span>
    </div>
```

After:

```tsx
return (
  <div className="space-y-3">
    <div className="text-muted-foreground">
      Attributed to{" "}
      <span className="font-medium text-foreground">
        {/* Prefer the row-level attributedCloserName (Phase 5 enrichment);
            fall back to the section-level closerName prop for rows written
            pre-Phase 4 (shouldn't happen on any new row). */}
        {paymentRecords[0]?.attributedCloserName ?? closerName}
      </span>
    </div>
```

**Note:** The `closerName` prop is still passed by `review-detail-page-client.tsx`; we keep accepting it as a fallback, but the primary source is now the row-level `attributedCloserName`.

**Step 3: Replace the `Provider` meta line with `Program` + `Payment Type`**

Before (lines 301–306):

```tsx
<div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
  <div>
    <span>Provider:</span>{" "}
    <span className="text-foreground">{p.provider}</span>
  </div>
  {p.referenceCode && (
```

After:

```tsx
<div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
  <div>
    <span>Program:</span>{" "}
    <span className="text-foreground">{p.programName ?? "—"}</span>
  </div>
  <div>
    <span>Payment Type:</span>{" "}
    <span className="text-foreground capitalize">{p.paymentType}</span>
  </div>
  {p.referenceCode && (
```

**Step 4: Add an on-behalf-of line inside the payment `<li>` — rendered only when recorder and attributed differ**

Immediately before the `<div className="col-span-2">` block that shows `Recorded: <timestamp>` (line 314), add:

```tsx
{/* Admin-on-behalf disclosure */}
{p.attributedCloserId &&
  p.recordedByUserId !== p.attributedCloserId && (
    <div className="col-span-2 italic">
      Recorded by{" "}
      <span className="text-foreground">{p.recordedByName ?? "an admin"}</span>
    </div>
  )}
```

**Acceptance for 8F:**
- File compiles.
- Grep confirms zero references to `p.provider` in this file.
- The `closerName` parameter of `<PaymentSection>` is still accepted (fallback); the primary source is `paymentRecords[0].attributedCloserName`.
- Manual test (review detail on a meeting that was resolved via admin review-resolution `log_payment`): the card shows `Attributed to <closer>`, each payment row shows `Program: Launchpad`, `Payment Type: Pif`, `Recorded by <admin name>` (italic), `Recorded: <timestamp>`.

---

### 8G — Verification Pass

**Type:** Verification + manual QA.
**Parallelizable:** No — runs after 8A–8F land.

**What:** Run a three-step check to catch stragglers and regressions before the phase ships.

**Step 1 — Grep sweep:**

```bash
# Zero hits expected across app/, components/, hooks/, lib/:
rg -n "customer\\.programType" app components hooks lib
rg -n "payment\\.provider\\b" app components hooks lib
rg -n "payment\\.closerId\\b|payment\\.closerName\\b" app components hooks lib
rg -n "PROVIDERS\\b" app/workspace/customers   # the PROVIDERS enum in record-payment-dialog
```

Any hit = unresolved regression. Fix before proceeding to Step 2.

Run **two more sweeps** as a smoke test against the global grep contract from phases 5–7:

```bash
# Should show references ONLY inside convex/schema.ts backup comments
# (none expected after Phase 2) and zero hits in app/:
rg -n "\\bprovider\\b" app/workspace/customers app/workspace/closer/meetings app/workspace/closer/reminders app/workspace/reviews

# Must show references in the rewritten files (5+ hits each is expected):
rg -n "programName|paymentType|commissionable|attributedCloserName" app/workspace/customers app/workspace/closer/meetings/_components/deal-won-card.tsx app/workspace/closer/reminders/\[followUpId\]/_components/reminder-history-panel.tsx app/workspace/reviews/\[reviewId\]/_components/review-outcome-card.tsx
```

**Step 2 — Typecheck + lint:**

```bash
pnpm tsc --noEmit
pnpm lint
```

Both must pass with zero errors and zero new warnings. The `Id<"tenantPrograms">` cast in `record-payment-dialog.tsx` submit handler is the one canonical unsafe cast — all other paths are type-safe.

**Step 3 — Smoke test** (per `TESTING.MD`):

Setup:
1. Seed a tenant with two programs: `Launchpad` (active, USD), `Accelerator` (active, USD).
2. Book a test invitee. Start the meeting. Close it with a PIF payment of $3,000 as `closer@seed.dev` → this creates a `customer` linked to the `Launchpad` program.
3. On the same opportunity's next meeting (schedule a second one), record an admin-on-behalf deposit of $500 as `tenant_admin@seed.dev`.
4. Open the customer detail page as `tenant_admin@seed.dev` and record a $500 monthly payment via the rewritten 8A dialog.

Walk the following pages:

| Surface | Expected content |
|---|---|
| `/workspace/customers/<customerId>` (as admin) | Conversion card shows `Program: Launchpad`. Payment History shows 3 rows: PIF (`Jane Closer`, commissionable), Deposit (`Jane Closer`, commissionable), Monthly (`Post-conversion` chip, non-commissionable). `Record Payment` button visible. |
| `/workspace/customers/<customerId>` (as closer) | Same page content EXCEPT the `Record Payment` button is absent. Payment history row data identical. |
| `/workspace/closer/meetings/<meetingId>` (PIF meeting) | Deal Won card shows `Program: Launchpad`, `Payment Type: Pif`, `Attributed To: Jane Closer`, no "Recorded by ... on behalf of ..." line. |
| `/workspace/closer/meetings/<meetingId>` (deposit meeting) | Deal Won card shows `Program: Launchpad`, `Payment Type: Deposit`, `Attributed To: Jane Closer`, muted italic "Recorded by Admin Acme on behalf of Jane Closer". |
| `/workspace/pipeline/meetings/<meetingId>` (deposit meeting, as admin) | Same content as above (shared component). |
| `/workspace/closer/reminders/<followUpId>` (if a reminder exists on the opp) | Reminder History panel's prior-payments list shows two-line rows: `date | amount currency` on top, `Launchpad · Pif` / `Launchpad · Deposit` underneath. |
| `/workspace/pipeline/reminders/<followUpId>` (from Phase 7D) | Same panel as above (shared component). |
| `/workspace/reviews/<reviewId>` (if a meeting-overran review was generated) | Review Outcome Card `PaymentSection` shows `Attributed to Jane Closer` header, each row shows `Program: Launchpad` + `Payment Type: Pif`/`Deposit`, the deposit row shows italic `Recorded by Admin Acme`. |

No NaN, no `undefined`, no blank where data should be. No "Provider" label anywhere in the UI. No "programType" anywhere. No "closerName" on a payment row.

**Step 4 — PostHog event verification** (optional, post-deploy):

Fire the three test payments (commissionable PIF, commissionable deposit, non-commissionable monthly) and confirm the PostHog events land:

- `payment_logged` (from Phase 7A, two events) — each with `program_id`, `payment_type`, no `provider` / `has_reference_code`.
- `customer_payment_recorded` (from 8A, one event) — with `program_id`, `payment_type`, `has_reference_code`, `has_proof_file`, `preseeded_from_customer_program`.

**Acceptance for 8G:**
- All greps return the expected counts (zero stragglers, ≥5 hits on the new vocab terms across the rewritten files).
- `pnpm tsc --noEmit` + `pnpm lint` pass.
- Smoke test passes end-to-end.
- PostHog verification optional but recommended before unfeathering to the live tenant.

---

## Files Touched by Phase 8

| File | Subphase | Action |
|---|---|---|
| `app/workspace/customers/[customerId]/_components/record-payment-dialog.tsx` | 8A | Rewrite |
| `app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx` | 8B | Modify (imports + 2 render changes) |
| `app/workspace/customers/[customerId]/_components/payment-history-table.tsx` | 8C | Rewrite |
| `app/workspace/closer/meetings/_components/deal-won-card.tsx` | 8D | Modify (grid cells + type widening) |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-history-panel.tsx` | 8E | Modify (`<PaymentRow>` only) |
| `app/workspace/reviews/[reviewId]/_components/review-outcome-card.tsx` | 8F | Modify (`<PaymentSection>` only) |

No new files in Phase 8. No files deleted.

---

## Integration Points With Other Phases

| Consumer | Integration point | Provider |
|---|---|---|
| `RecordPaymentDialog` props (8A) | `customerProgram: { id, isActive }` | `customer-detail-page-client.tsx` (8B) derives from `customer.programId` + `customer.programName` |
| `PaymentHistoryTable` props (8C) | `payments` with enriched row shape | `getCustomerDetail` (Phase 5) |
| `DealWonCard` props (8D) | `payments` with enriched row shape | `getMeetingDetail` (Phase 5) — consumed by both `meeting-detail-page-client` (closer) and `admin-meeting-detail-client` (admin) |
| `ReminderHistoryPanel` props (8E) | `payments` with enriched row shape | `getReminderDetail` + `getAdminReminderDetail` (Phase 5) — `getAdminReminderDetail` consumed by the new Phase 7D admin route |
| `ReviewOutcomeCard` props (8F) | `paymentRecords` with enriched row shape | `getReviewDetail` (Phase 5) |
| `ProgramSelect` consumption (8A) | `value` / `onChange` / `disabled` / `placeholder` | `app/workspace/closer/_components/program-select.tsx` (Phase 6A) |

---

## Edge Cases Handled

1. **Customer points at an archived program.** Design §14 edge case. The dialog opens with `programId: ""` and requires the user to pick an active program. The `FormDescription` under the Program field tells the admin why the preseed is absent. Phase 5's `getCustomerDetail` nulls out `programName` when the linked program is archived — 8B's `isActive: !!customer.programName` computation is the gate.
2. **Non-commissionable row appears in reminder history** (should not happen — reminders are always commissionable, see design §5.4). 8E's `<PaymentRow>` falls back to a muted `post-conversion` chip rather than crashing. This is defense-in-depth, not a happy path.
3. **Recorder === attributed closer on a commissionable row.** 8D and 8F both omit the "Recorded by ... on behalf of ..." line entirely in this case — no tautology like "Recorded by Jane on behalf of Jane".
4. **Payment row with `commissionable: true` but `attributedCloserName === null`.** Possible if the attributed closer user was deleted after the payment was logged. The deal-won card's `Attributed To` row renders nothing (the whole `<div>` is gated on `payment.attributedCloserName`). The payment-history-table falls back to `"—"`. The review-outcome-card falls back to the section-level `closerName` prop passed by the review detail page.
5. **Customer without a `winningOpportunityId`.** The existing `customer-detail-page-client.tsx` already handles this by not rendering the Winning Opportunity card. 8B does not change the behavior.

---

## Follow-Up Notes (deferred out of Phase 8)

1. **Extract `<PaymentMetaRow>` compound component.** 8D (deal-won-card grid), 8F (review-outcome-card grid), and — down the road — the activity-feed payment row all share the same meta vocabulary (Program, Payment Type, Reference, Recorded, Attributed). Extracting a shared compound component (`<PaymentMetaRow label=... value=...>` with a header variant) would collapse ~40 lines of duplicated JSX into a single reusable block. Deferred for the same reason as the Phase 7 composition deferral: the three callers have slightly different densities (grid cell vs. meta line vs. audit row), and the abstraction cost exceeds the DRY savings at 3 call sites. Revisit once the activity-feed payment row lands (Phase 9).
2. **Per-currency totals on the payment-history table.** The current table footer doesn't aggregate multi-currency totals (it assumes one currency per customer). When a customer ever accumulates payments in mixed currencies, the "total" becomes ambiguous. Deferred to a post-v0.5.1 polish pass; the design doc already tags this as Open Question #8.
3. **Program badge color.** Phase 8 renders the program name as plain text (`"Launchpad"`). A future iteration could assign a stable color to each program via a hash on `programId` so the user visually scans a mixed-program payment list. Deferred; low impact at 1–3 programs per tenant.
4. **Collapse the deal-won, reminder-history, and review-outcome grids into a shared composition.** See (1) above. Same deferral.
5. **Add a `"post-conversion"` muted chip to the deal-won card on non-commissionable rows.** Non-commissionable payments never render in the deal-won card today (the card is gated on `opportunity.status === "payment_received" && payments.length > 0` — all such payments ARE commissionable). Keep this asymmetry for now; if a future flow surfaces customer-direct payments on a meeting page, the chip infrastructure from the payment-history-table (8C) can be lifted wholesale.
6. **Currency array deduplication.** `CURRENCIES` is inlined at the top of `record-payment-dialog.tsx` (Phase 8A) and at the top of `payment-form-dialog.tsx` (Phase 7A) and at the top of `reminder-payment-dialog.tsx` (Phase 7B). Three copies is a smell. Deferred to a shared `@/lib/payment-currencies.ts` constant module in a post-v0.5.1 cleanup PR.

---

## Smoke Test Script (full, per `TESTING.MD`)

**Setup:**

1. `npx convex run testing/programs:seedTestProgram '{"tenantId":"<tenant>","name":"Launchpad","defaultCurrency":"USD"}'`
2. `npx convex run testing/programs:seedTestProgram '{"tenantId":"<tenant>","name":"Accelerator","defaultCurrency":"USD"}'`
3. `npx convex run testing/calendly:bookTestInvitee '{"meetingScheduledAt":<ts>}'`
4. Sign in as `closer@seed.dev`, start the meeting, Log Payment → `Launchpad`, `PIF`, `$3,000` → submit.
5. Book a second Calendly invitee on the same lead (creates a new opportunity? or reuse winning opp? — TEST HELPER: `npx convex run testing/pipeline:forceSecondOpportunity '{"leadEmail":"<lead>"}'`).
6. Sign in as `tenant_admin@seed.dev`, open the second meeting detail, Log Payment → `Launchpad`, `Deposit`, `$500` → submit. (This fires `admin_meeting` origin.)
7. Still as admin, navigate to the Customers tab, open the customer created in step 4, click `Record Payment` → `Launchpad` (pre-seeded), `Monthly`, `$500`, `ref: stripe_live_abc123` → submit.

**Walk-through:**

1. **Customer detail page (as admin)** — `/workspace/customers/<customerId>`
   - Conversion card: `Program: Launchpad` row present.
   - Payment History card: three rows. PIF row shows `Jane Closer` in Attribution. Deposit row shows `Jane Closer`. Monthly row shows `Post-conversion` chip.
   - `Record Payment` button visible in the card header.
2. **Customer detail page (as closer)** — same URL, signed in as `closer@seed.dev`
   - Conversion card: same.
   - Payment History card: same three rows.
   - `Record Payment` button absent.
3. **Closer meeting detail — PIF meeting** — `/workspace/closer/meetings/<meeting1Id>`
   - Deal Won card: `Amount Paid: $3,000`, `Program: Launchpad`, `Payment Type: Pif`, `Attributed To: Jane Closer`, `Recorded: <ts>`, `Status: Recorded`.
   - No italic "Recorded by ... on behalf of ..." line.
4. **Admin meeting detail — deposit meeting** — `/workspace/pipeline/meetings/<meeting2Id>`
   - Deal Won card: `Amount Paid: $500`, `Program: Launchpad`, `Payment Type: Deposit`, `Attributed To: Jane Closer`, italic line `Recorded by Admin Acme on behalf of Jane Closer`.
5. **Closer reminder detail** — `/workspace/closer/reminders/<followUpId>` (if a reminder exists)
   - Prior payments list: two rows (PIF + Deposit). Each row shows two lines: `MMM d | $amount USD` and `Launchpad · Pif`/`Launchpad · Deposit`.
6. **Review detail** — `/workspace/reviews/<reviewId>` (if the meeting-overran flow created a review on either meeting)
   - Review Outcome Card: `Attributed to Jane Closer` header. Each payment row: `Program: Launchpad`, `Payment Type: Pif`/`Deposit`, `Recorded by Admin Acme` italic line on the deposit row.
7. **Post-deploy — `npx convex data paymentRecords --limit 5`**
   - Every row has `programId`, `programName`, `paymentType`, `commissionable`, `recordedByUserId`.
   - Commissionable rows have `attributedCloserId` set; non-commissionable rows do not.

All seven scenarios must pass without visual glitches, without NaN, without blank fields, and without references to the removed `provider` label.

---

## Rollback Plan

Phase 8 is pure frontend display + dialog logic. Rollback == revert the six-file diff. Backend (Phases 1–5) stays deployed; the old dialogs + display surfaces re-appear and continue to function against the new schema (they read fields the new schema no longer has, hence immediately visible regressions). In practice, Phase 8 is low-rollback-risk because:

- No migrations to undo.
- No Convex functions to revert.
- No cron jobs to pause.
- No external integrations to reconnect.

If a critical regression is found post-deploy (e.g., the admin gate is broken and closers can access the `Record Payment` button), hotfix rather than revert — the blast radius of a revert (losing all six file changes) exceeds the blast radius of a one-line fix on the specific bug.

---

## Prerequisites — Recap Sign-off Checklist

Before opening a Phase 8 PR, confirm:

- [ ] Phase 1 deployed; `api.tenantPrograms.queries.listPrograms` returns non-empty on the target tenant.
- [ ] Phase 2 deployed; `customers.programId` + `customers.programName` fields exist on `schema.ts`; `paymentRecords.programId` / `programName` / `paymentType` / `commissionable` / `attributedCloserId` / `recordedByUserId` all present.
- [ ] Phase 3 deployed; `api.customers.mutations.recordCustomerPayment` signature is `{ customerId, amount, currency, programId, paymentType, referenceCode?, proofFileId? }`.
- [ ] Phase 5 deployed; `getCustomerDetail` response includes `customer.programName`, each `payments[N]` has `programName` / `paymentType` / `commissionable` / `attributedCloserName` / `recordedByName`.
- [ ] Phase 6A deployed; `ProgramSelect` component compiles and renders.
- [ ] (Optional) Phase 7D deployed if you want to smoke-test the shared `reminder-history-panel.tsx` refresh on both closer and admin reminder routes in one pass.
