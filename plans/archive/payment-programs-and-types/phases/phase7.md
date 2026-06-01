# Phase 7 — Commissionable Payment Dialogs + Admin Reminder Detail Route (Frontend)

**Goal:** Rewrite every *commissionable* payment dialog to consume the new field vocabulary — `programId`, `paymentType`, dropped `provider`, dropped `referenceCode` (for meeting + reminder flows), kept `referenceCode` (for review-resolution only) — and ship the first-class admin reminder detail route so the "admin-on-behalf" reminder flow has a real UI that calls `logReminderPayment` with the `admin_reminder` origin.

Three dialogs rewritten, one new route, one verification pass:

1. **`app/workspace/closer/meetings/_components/payment-form-dialog.tsx`** — commissionable meeting payment. Drops `Provider` and `Reference Code` (misbound as "Fathom Link"), adds `Program` (`ProgramSelect`) and `Payment Type`. Shared by the closer's `outcome-action-bar` (`/workspace/closer/meetings/[id]`) AND the admin's `admin-action-bar` (`/workspace/pipeline/meetings/[id]`), so this single rewrite simultaneously unblocks both the `closer_meeting` and `admin_meeting` origin flows from Phase 4.
2. **`app/workspace/closer/reminders/[followUpId]/_components/reminder-payment-dialog.tsx`** — commissionable reminder payment. Same field-level changes as above. Also consumed by the new admin reminder detail route (7D), so this one rewrite unblocks both `closer_reminder` and `admin_reminder` origins from Phase 4.
3. **`app/workspace/reviews/[reviewId]/_components/review-resolution-dialog.tsx`** — in the `resolutionAction === "log_payment"` branch only: drop `Provider`, add `Program` + `Payment Type`, **keep** `Reference Code` (admins attach the real transaction ID on review-resolution rewrites). Every other resolution branch (schedule_follow_up / mark_no_show / mark_lost / acknowledged / disputed) stays unchanged.
4. **NEW** `app/workspace/pipeline/reminders/[followUpId]/page.tsx` + `_components/admin-reminder-detail-page-client.tsx` — admin-facing reminder detail route that mirrors the closer detail shell, preloads `api.pipeline.reminderDetail.getAdminReminderDetail`, and hosts the rewritten `ReminderPaymentDialog` so admins can log reminder payments on behalf of the assigned closer.
5. **Verification pass (7E)** — grep across the codebase for stale imports of the dropped field labels (`provider`, `"Fathom Link"`, the `PROVIDERS` enum), ensure `admin-action-bar.tsx` and `outcome-action-bar.tsx` render the rewritten `PaymentFormDialog` without regression, verify the new `Program` + `Payment Type` fields render in both closer and admin surfaces, confirm `pnpm tsc --noEmit` and `pnpm lint` both pass with zero errors.

**Prerequisites:**

- **Phase 1 merged** — `tenantPrograms` table + `api.tenantPrograms.queries.listPrograms` deployed. Without this, every `<ProgramSelect>` renders the muted "loading…" pill forever.
- **Phase 2 merged** — `paymentRecords` schema rewritten (`programId` / `paymentType` / `commissionable` / `attributedCloserId` / `recordedByUserId`; dropped `provider`, `loggedByAdminUserId`). **Without Phase 2 the type system accepts the old shape and the dialogs will submit payloads the server rejects** (the old `logPayment` validator is gone). Phase 7 is a hard consumer of Phase 2.
- **Phase 3 merged** — the shared backend helper/literal layer (`paymentTypes.ts`, `paymentHelpers.ts`, `tenantStatsHelper.ts`) is in place. Phase 7 does not call these files directly, but Phase 4's rewritten mutations depend on them.
- **Phase 4 merged** — `api.closer.payments.logPayment`, `api.closer.reminderOutcomes.logReminderPayment`, and `api.reviews.mutations.resolveReview` all accept the new `{ programId, paymentType, ... }` payload shape, and `api.pipeline.reminderDetail.getAdminReminderDetail` is exposed. **Without Phase 4 the meeting flow, admin reminder route, and review-resolution `log_payment` branch all break at runtime.**
- **Phase 6A merged** — `ProgramSelect` component at `app/workspace/closer/_components/program-select.tsx`. This is the only hard dependency from Phase 6; the rest of Phase 6 (Settings tab) can be behind Phase 7 and the dialogs still work — they render the empty hint telling admins to configure programs first.

**Runs in PARALLEL with:**

- **Phase 6 (6B–6E)** — Settings tab work is completely independent of the dialogs. 6A must land first, then 6B–6E and 7A–7E run in parallel.
- **Phase 8 (Customer Read-Surface + Record Payment Dialog + Display Refreshes)** — Phase 8's `record-payment-dialog.tsx` is the *non-commissionable* customer-direct payment dialog. It shares the same `ProgramSelect` and Payment Type pattern but is a separate file with an admin-only banner. Zero overlap with Phase 7.
- **Phase 9 (Reporting UI + Dashboard + Activity Feed)** — Phase 9 reads from Phase 5's reporting queries. No shared files.

**Runs SERIALLY with:**

- Nothing in Phase 7 — the four subphases 7A / 7B / 7C / 7D touch four different files with no cross-imports. They can run in four parallel streams.
- 7E (verification pass) runs last to confirm the four in-flight streams didn't introduce regressions.

> **Critical path:** Phase 7 is the largest frontend surface by file count and the one closers + admins interact with most frequently. A bug here blocks every sale-close flow. The subphase dependency graph is wide (four parallel streams), but the risk profile is serial: one dialog regression takes the whole release down. Prioritize: (a) robust acceptance criteria that catch the common regressions, (b) the smoke test script at the bottom, (c) explicit "run on two tenants with differing program configurations" QA before merge.

**Skills to invoke:**

- `shadcn` — no new shadcn primitives are needed. All four subphases compose existing `<Dialog>`, `<Form>`, `<Select>`, `<Input>`, `<Textarea>`, `<Alert>` components. Verify visually in both themes (light / dark) post-rewrite.
- `frontend-design` — reference only. The dialog layout (Amount → Currency → Program → Payment Type → Proof) is ordered by "likely-to-change-per-payment" so the fast-common-path fields are at the top.
- `vercel-composition-patterns` — 7A and 7B share 95% of their JSX. The temptation to extract a `<CommissionablePaymentFields>` composition component is real but **deferred** to a post-v0.5.1 polish pass. Rationale: the reminder dialog has one extra muted-line at the top showing the reminder context ("Scheduled for Launchpad lead — Jane Doe"), and the meeting dialog is the canonical shape. Extracting now risks churn while the rest of the feature is still moving. The follow-up note at the bottom of this file tracks it.
- `vercel-react-best-practices` — avoid unnecessary `useEffect`s for form-reset on close; leverage the `onOpenChange` callback on `<Dialog>`. Don't wrap the `PaymentType` select in a memo — it's a plain value prop.
- `web-design-guidelines` — verify: (a) every required field has a visible `*` asterisk with `text-destructive` color, (b) `<Alert variant="destructive">` is used for submit-level errors only (validation errors live inline via `<FormMessage>`), (c) disabled submit button during submission, (d) keyboard: tab order mirrors the JSX order top-to-bottom, (e) the new admin reminder route uses the existing `RequireAdmin` / role-check pattern so closers cannot access it.
- `convex-performance-audit` — reference only. Phase 7 does not add new Convex calls beyond what Phases 3 and 4 already shipped. The `<ProgramSelect>` inside each dialog fetches `listPrograms` via Convex's built-in client-side cache; no N+1 concern.

**Acceptance Criteria:**

1. `payment-form-dialog.tsx` exposes `{ opportunityId, meetingId, onSuccess? }` props unchanged. The Zod schema drops `provider` and `referenceCode`; adds `programId: z.string().min(1, "Program is required")` and `paymentType: z.enum(["pif", "split", "monthly", "deposit"])`. `currency` stays. `amount` stays. `proofFile` stays.
2. `payment-form-dialog.tsx` body: `<Amount>` → `<Currency>` → `<Program>` (via `<ProgramSelect>`) → `<Payment Type>` → `<Proof File>`. The `Provider` dropdown is gone. The `Reference Code` text input is gone. The `Fathom Link` label text is gone (if it was ever wired). The submit button copy is `"Log Payment"` (create) or `"Submitting…"` while in flight.
3. `payment-form-dialog.tsx` submit payload: `{ opportunityId, meetingId, amount, currency, programId: programId as Id<"tenantPrograms">, paymentType, proofFileId? }`. The `Id` cast happens at the mutation boundary (RHF state stores `programId` as a plain string). The two-step file-upload flow (`generateUploadUrl → fetch → logPayment`) is preserved byte-for-byte.
4. `payment-form-dialog.tsx` success path preserved: `toast.success("Payment logged successfully")`, `await onSuccess?.()`, `setOpen(false)`, `form.reset()`. `posthog.capture("payment_logged", …)` metadata: `{ opportunity_id, meeting_id, amount_minor, currency, program_id, payment_type, has_proof_file }`. (`provider` and `has_reference_code` are removed.)
5. `reminder-payment-dialog.tsx` exposes `{ followUpId, onSuccess }` props unchanged. Same schema edits as 7A. Mutation call: `api.closer.reminderOutcomes.logReminderPayment({ followUpId, amount, currency, programId: programId as Id<"tenantPrograms">, paymentType, proofFileId? })`. The mutation extension to admin callers (Phase 4) is transparent to this dialog — the same function signature is called, and the backend routes to `admin_reminder` origin when the caller is an admin.
6. `reminder-payment-dialog.tsx` success path: `toast.success("Payment logged successfully")`, `onSuccess()`, `setOpen(false)`, `form.reset()`. `posthog.capture("reminder_outcome_payment", …)` metadata: `{ follow_up_id, payment_id, amount_minor, currency, program_id, payment_type, has_proof_file }`. (Preserve the top-level `payment_id` field from the mutation return.)
7. `review-resolution-dialog.tsx` — the conditional schema's `"log_payment"` branch drops `provider` validation and adds `programId: z.string().min(1, "Program is required")` + `paymentType: z.enum([...])`. Every other branch (`schedule_follow_up`, `mark_no_show`, `mark_lost`, `acknowledged`, `disputed`) keeps its existing schema and JSX untouched.
8. `review-resolution-dialog.tsx` — the `"log_payment"` branch JSX swaps the `Provider` select for a `<ProgramSelect>` + a new `Payment Type` select; keeps the `Reference Code` input (admin attaches the real transaction ID on dispute-resolve rewrites). No file upload is added (design decision — review resolution is an audit trail action, not a proof-collection action).
9. `review-resolution-dialog.tsx` submit payload for `log_payment`: `paymentData: { amount, currency, programId: programId as Id<"tenantPrograms">, paymentType, referenceCode?: referenceCode || undefined }`. Submitting action unchanged (`resolveReview` with `resolutionAction: "log_payment"`). All other action paths submit unchanged.
10. NEW route `app/workspace/pipeline/reminders/[followUpId]/page.tsx` is a thin RSC that calls `await requireRole(["tenant_master", "tenant_admin"])`, awaits the route params, preloads `api.pipeline.reminderDetail.getAdminReminderDetail`, and returns `<AdminReminderDetailPageClient preloadedDetail={preloaded} />`. `unstable_instant = false` is set. Bundle is client-component-heavy but the static shell (breadcrumbs, sidebar) renders immediately.
11. `app/workspace/pipeline/reminders/[followUpId]/_components/admin-reminder-detail-page-client.tsx` is a `"use client"` component that consumes `usePreloadedQuery(preloadedDetail)` and renders: breadcrumbs (`Pipeline → Reminders → <reminder lead name>`), a lead info panel (reuses the existing `<LeadInfoPanel>` if re-exportable from `closer/_components`; otherwise duplicates the small header card), a reminder metadata card, a reminder history panel with prior payments, and an action bar rendering **just the rewritten `ReminderPaymentDialog`** (no `Schedule Follow-Up` / `Mark Lost` buttons — admins use the review-resolution dialog for those branches; the new route is the *payment* on-behalf surface).
12. The new admin route handles null detail (`detail === null`): if the follow-up does not belong to the admin's tenant or does not exist, render a `<NotFound>` card with a "Back to Pipeline" button. The server-side auth gate in `page.tsx` already prevents closers from reaching the route.
13. Grep confirms zero references to the removed constants in `app/workspace/closer/meetings/**` and `app/workspace/closer/reminders/**`: no `PROVIDERS` export, no `provider` RHF field name, no `"Fathom Link"` label string. `app/workspace/reviews/**` still references `Reference Code` (kept) but no `provider` RHF field.
14. `pnpm tsc --noEmit` passes with zero errors. `pnpm lint` passes with zero new warnings. The `Id<"tenantPrograms">` casts are limited to the mutation boundaries (four call sites, one per rewrite).
15. Smoke test (per `TESTING.MD`): run the four scenarios at the end of this document as `closer@seed.dev` and `tenant_admin@seed.dev` on a tenant with two active programs. All four dialogs submit successfully; the Convex logs show the expected origin (`closer_meeting`, `admin_meeting`, `closer_reminder`, `admin_reminder`, `admin_review_resolution`) and the new `programId` / `paymentType` fields on every written row.

---

## Subphase Dependency Graph

```
7A (payment-form-dialog rewrite)           ──┐
                                             │
7B (reminder-payment-dialog rewrite)        ──┤
                                             ├──▶ 7E (verification pass)
7C (review-resolution-dialog update)        ──┤
                                             │
7D (admin reminder route + client)          ──┘
```

**Edges explained:**

- **7A / 7B / 7C / 7D are fully parallel.** Four files, no shared imports beyond `<ProgramSelect>` (already shipped in Phase 6A) and the Convex API surface (already shipped in Phases 1–4). Four developers or four parallel streams is the ideal throughput.
- **7E must run after all four finish.** The grep + typecheck + lint check depends on the union of the four file changes. Running it earlier catches nothing.
- **7D depends on 7B (via `ReminderPaymentDialog` rendered inside `AdminReminderDetailPageClient`).** But the dependency is only at integration time — 7D's page + client shell can be written and typechecked against the pre-rewrite `ReminderPaymentDialog` signature (which takes `{ followUpId, onSuccess }` and stays identical after 7B). The two can be parallelized if 7B's prop signature stays stable (which it does).

---

## 7A — Rewrite `payment-form-dialog.tsx`

**Type:** Frontend (`"use client"`)
**Parallelizable:** Yes — 7A, 7B, 7C, 7D run in four parallel streams.

**What:** Replace the `Provider` + `Reference Code` fields with `Program` (shared `<ProgramSelect>`) + `Payment Type` (new enum select). Preserve every other behavior: file upload, success toast, `onSuccess` callback, PostHog event shape (updated metadata), dialog-trigger button, `DialogTrigger` pattern.

**Why:** The dialog today (460 lines at `app/workspace/closer/meetings/_components/payment-form-dialog.tsx`) collects a free-form `provider` string and a "Fathom Link" textbox bound to `referenceCode`. Phase 2 drops both fields from `paymentRecords`; Phase 3 rewrites `logPayment` to require `programId` + `paymentType`. This dialog is the biggest write-surface change in the feature because it is shared by the closer (`outcome-action-bar.tsx`) AND the admin (`admin-action-bar.tsx` in `pipeline/meetings/_components/`). Rewriting it once unblocks both flows.

**Where:**
- `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` (rewritten)

**How:**

**Step 1: Update imports**

```tsx
// Path: app/workspace/closer/meetings/_components/payment-form-dialog.tsx (rewritten)
"use client";

import { useState } from "react";
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
  DialogTrigger,
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { BanknoteIcon, AlertCircleIcon, UploadIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";

// NEW — shared program dropdown from Phase 6A
import { ProgramSelect } from "@/app/workspace/closer/_components/program-select";
```

**Step 2: Update constants + schema**

```tsx
/** Max proof file size: 10 MB — server enforces again. */
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const VALID_FILE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "application/pdf",
];

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"] as const;

// NEW — payment type enum matches `paymentRecords.paymentType` in Phase 2.
const PAYMENT_TYPES = [
  { value: "pif", label: "PIF (Paid in Full)" },
  { value: "split", label: "Split" },
  { value: "monthly", label: "Monthly" },
  { value: "deposit", label: "Deposit" },
] as const;
type PaymentType = (typeof PAYMENT_TYPES)[number]["value"];

// REMOVED — PROVIDERS constant is deleted. `provider` no longer exists on
// `paymentRecords` after Phase 2.

const paymentFormSchema = z.object({
  amount: z
    .string()
    .min(1, "Amount is required")
    .refine(
      (value) => {
        const parsed = parseFloat(value);
        return !Number.isNaN(parsed) && parsed > 0;
      },
      { message: "Amount must be greater than 0" },
    ),
  currency: z.enum(CURRENCIES),
  // NEW — program picker stores the Id as a plain string; caller casts to Id.
  programId: z.string().min(1, "Program is required"),
  // NEW — payment type enum maps 1:1 to `paymentRecords.paymentType`.
  paymentType: z.enum(["pif", "split", "monthly", "deposit"], {
    error: "Please select a payment type",
  }),
  // REMOVED — provider + referenceCode fields.
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

type PaymentFormValues = z.infer<typeof paymentFormSchema>;
```

**Step 3: Component signature + defaults**

```tsx
type PaymentFormDialogProps = {
  opportunityId: Id<"opportunities">;
  meetingId: Id<"meetings">;
  /** Parent hook for post-submit actions (router refresh, cache invalidation). */
  onSuccess?: () => Promise<void>;
};

export function PaymentFormDialog({
  opportunityId,
  meetingId,
  onSuccess,
}: PaymentFormDialogProps) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm({
    resolver: standardSchemaResolver(paymentFormSchema),
    defaultValues: {
      amount: "",
      currency: "USD",
      programId: "",
      paymentType: undefined as PaymentType | undefined,
      proofFile: undefined,
    },
  });

  const generateUploadUrl = useMutation(api.closer.payments.generateUploadUrl);
  const logPayment = useMutation(api.closer.payments.logPayment);
```

**Step 4: Rewrite the submit handler**

```tsx
  const onSubmit = async (values: PaymentFormValues) => {
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      // Step 1: Upload proof file if provided (two-step Convex storage flow).
      // Unchanged from before — only the mutation payload below changes.
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

      // Step 2: Log the payment via the Phase 3 mutation shape.
      const parsedAmount = parseFloat(values.amount);
      const amountMinor = Math.round(parsedAmount * 100);

      await logPayment({
        opportunityId,
        meetingId,
        amount: parsedAmount,
        currency: values.currency,
        programId: values.programId as Id<"tenantPrograms">,
        paymentType: values.paymentType,
        proofFileId,
      });

      // Step 3: Success path — preserve the exact same UX as before.
      await onSuccess?.();
      posthog.capture("payment_logged", {
        opportunity_id: opportunityId,
        meeting_id: meetingId,
        amount_minor: amountMinor,
        currency: values.currency,
        program_id: values.programId,
        payment_type: values.paymentType,
        has_proof_file: Boolean(proofFileId),
      });
      toast.success("Payment logged successfully");
      setOpen(false);
      form.reset();
    } catch (err: unknown) {
      posthog.captureException(err);
      const message =
        err instanceof Error
          ? err.message
          : "Failed to log payment. Please try again.";
      setSubmitError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };
```

**Step 5: Rewrite the dialog JSX — new field order**

```tsx
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!isSubmitting) {
          setOpen(value);
          if (!value) {
            form.reset();
            setSubmitError(null);
          }
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="lg">
          <BanknoteIcon data-icon="inline-start" />
          Log Payment
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Log Payment</DialogTitle>
          <DialogDescription>
            Record a payment to close this opportunity. Choose the program and
            payment type so reports group correctly.
          </DialogDescription>
        </DialogHeader>

        {submitError && (
          <Alert variant="destructive">
            <AlertCircleIcon className="size-4" />
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        )}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <FieldGroup>
              {/* Amount — unchanged */}
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
                        min="0"
                        placeholder="299.99"
                        disabled={isSubmitting}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Currency — unchanged */}
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
                          {CURRENCIES.map((currency) => (
                            <SelectItem key={currency} value={currency}>
                              {currency}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* NEW — Program (replaces Provider) */}
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
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* NEW — Payment Type */}
              <FormField
                control={form.control}
                name="paymentType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Payment Type{" "}
                      <span className="text-destructive">*</span>
                    </FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value ?? ""}
                      disabled={isSubmitting}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select payment type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {PAYMENT_TYPES.map((type) => (
                          <SelectItem key={type.value} value={type.value}>
                            {type.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {field.value === "deposit" && (
                      <FormDescription>
                        Deposits are tracked separately in reports — they do
                        not count toward closed-won revenue until a final
                        payment is logged.
                      </FormDescription>
                    )}
                    {(field.value === "split" ||
                      field.value === "monthly") && (
                      <FormDescription>
                        MVP: additional installments are logged later from the
                        Customer page by an admin. Those post-conversion
                        payments do not count toward closer commission.
                      </FormDescription>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Proof File — unchanged */}
              <FormField
                control={form.control}
                name="proofFile"
                render={({ field: { value, onChange, ...field } }) => (
                  <FormItem>
                    <FormLabel>Payment Proof</FormLabel>
                    <FormControl>
                      <Input
                        type="file"
                        accept={VALID_FILE_TYPES.join(",")}
                        disabled={isSubmitting}
                        onChange={(event) => {
                          onChange(event.target.files?.[0]);
                        }}
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Optional. Image (JPEG, PNG, GIF) or PDF up to 10 MB.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldGroup>

            <DialogFooter className="mt-5">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setOpen(false);
                  form.reset();
                  setSubmitError(null);
                }}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Submitting…
                  </>
                ) : (
                  <>
                    <UploadIcon data-icon="inline-start" />
                    Log Payment
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
```

**Key implementation notes:**
- **Why `value={field.value || undefined}` on `<ProgramSelect>`**: the component prop expects `string | undefined` (for the empty state). RHF stores the initial value as `""` which we convert to `undefined` at the boundary.
- **Why `value={field.value ?? ""}` on the Payment Type `<Select>`**: Radix's `<Select>` prop expects `string | undefined` but throws a warning if `undefined` is passed while items have values. Coercing to `""` keeps the placeholder visible without warnings.
- **Why the new field order (Amount → Currency → Program → Payment Type → Proof)**: mirrors the design doc's §6.4 pattern. Program and Payment Type are likely to be the same for most payments (program = their normal product; type = PIF 90% of the time), so they sit after the value-entry fields to keep the fast path fast.
- **Deposit description hint**: visible only when the user explicitly picks `deposit`. Addresses Open Question #9 of the design doc — admins need a visible reminder that deposits don't count toward closed-won.
- **Split / monthly description hint**: matches §14.12 of the design doc. MVP behavior for split/monthly is the same as PIF (opportunity terminates at `payment_received`), but the hint makes the post-conversion installment story clear so closers don't expect the opportunity to stay open.
- **`toast.error` inside the catch**: preserves the existing behavior. The `<Alert>` is for persistent in-dialog display; the toast gives a transient top-screen banner. Both pulse simultaneously.
- **No `router.refresh()` inside the dialog**: the `onSuccess` callback handles that (callers decide whether to refresh their RSC tree). Consistent with the pre-rewrite behavior.
- **`posthog.captureException(err)` before setting error state**: ensures the exception is captured even if the toast call throws in rare cases. Pattern from `invite-user-dialog.tsx:132`.
- **Admin vs. closer: same dialog, same payload.** The server-side mutation (`logPayment`, rewritten in Phase 3) inspects `requireTenantUser(ctx, [...])` to determine the role, derives `recordedByUserId` vs `attributedCloserId`, and sets the origin to `"closer_meeting"` or `"admin_meeting"` accordingly. The frontend does not branch.

**Verification checklist (specific to 7A):**

- [ ] Open the dialog as a closer → Program field shows the populated `<Select>` listing active programs.
- [ ] Open the dialog as a closer on a tenant with zero programs → Program field shows the muted "No programs configured yet. Ask an admin…" hint; submitting throws a `programId` required validation error inline.
- [ ] Select `PIF` → no FormDescription renders below the Payment Type.
- [ ] Select `Deposit` → FormDescription shows the deposit hint.
- [ ] Select `Monthly` → FormDescription shows the split/monthly hint.
- [ ] Attach a 12 MB file → inline error `"File size must be less than 10 MB"` under the Proof field.
- [ ] Submit with all required fields → Convex log shows `paymentRecords` row with `commissionable: true`, `origin: "closer_meeting"` (if closer) or `"admin_meeting"` (if admin).
- [ ] Submit as admin → the same dialog, the same payload shape; Convex log shows `attributedCloserId === opportunity.assignedCloserId` and `recordedByUserId === <admin user id>`.
- [ ] Close the dialog mid-submission (click outside, press Esc) → blocked; the spinner stays; the dialog closes only after the mutation resolves.
- [ ] Close the dialog after a successful submit → next open shows a clean form (no stale selected program, no stale amount).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` | Rewrite | Replace 5 field Zod shape + JSX; preserve file upload flow + success hooks. |

---

## 7B — Rewrite `reminder-payment-dialog.tsx`

**Type:** Frontend (`"use client"`)
**Parallelizable:** Yes — runs alongside 7A, 7C, 7D.

**What:** Identical Zod-schema + JSX changes as 7A applied to the reminder flow's dialog. The wire-up differences are: (a) mutation is `api.closer.reminderOutcomes.logReminderPayment`, (b) prop shape is `{ followUpId, onSuccess }`, (c) PostHog event name is `reminder_outcome_payment`, (d) no `DialogTrigger` wrapper — the dialog is externally controlled by the parent `<ReminderOutcomeActionBar>`.

**Why:** Phase 4 extended `logReminderPayment` to admin callers (new `admin_reminder` origin). The mutation signature adds `programId` + `paymentType` and drops `provider` + `referenceCode` (the dialog was also mis-labeling `referenceCode` as "Fathom Link", a legacy of the meeting variant's misbind). Without this rewrite the dialog sends fields the server no longer accepts and/or fails to send fields the server now requires.

**Where:**
- `app/workspace/closer/reminders/[followUpId]/_components/reminder-payment-dialog.tsx` (rewritten)

**How:**

**Step 1: Update imports**

```tsx
// Path: app/workspace/closer/reminders/[followUpId]/_components/reminder-payment-dialog.tsx (rewritten)
"use client";

import { useState } from "react";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { AlertCircleIcon, UploadIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";

import { ProgramSelect } from "@/app/workspace/closer/_components/program-select";
```

**Step 2: Constants + schema (identical to 7A)**

```tsx
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
  { value: "split", label: "Split" },
  { value: "monthly", label: "Monthly" },
  { value: "deposit", label: "Deposit" },
] as const;
type PaymentType = (typeof PAYMENT_TYPES)[number]["value"];

const reminderPaymentSchema = z.object({
  amount: z
    .string()
    .min(1, "Amount is required")
    .refine(
      (value) => {
        const parsed = parseFloat(value);
        return !Number.isNaN(parsed) && parsed > 0;
      },
      { message: "Amount must be greater than 0" },
    ),
  currency: z.enum(CURRENCIES),
  programId: z.string().min(1, "Program is required"),
  paymentType: z.enum(["pif", "split", "monthly", "deposit"], {
    error: "Please select a payment type",
  }),
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
type ReminderPaymentValues = z.infer<typeof reminderPaymentSchema>;
```

**Step 3: Component signature — externally controlled**

```tsx
type ReminderPaymentDialogProps = {
  followUpId: Id<"followUps">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
};

export function ReminderPaymentDialog({
  followUpId,
  open,
  onOpenChange,
  onSuccess,
}: ReminderPaymentDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm({
    resolver: standardSchemaResolver(reminderPaymentSchema),
    defaultValues: {
      amount: "",
      currency: "USD",
      programId: "",
      paymentType: undefined as PaymentType | undefined,
      proofFile: undefined,
    },
  });

  const generateUploadUrl = useMutation(api.closer.payments.generateUploadUrl);
  const logReminderPayment = useMutation(
    api.closer.reminderOutcomes.logReminderPayment,
  );
```

**Step 4: Submit handler**

```tsx
  const onSubmit = async (values: ReminderPaymentValues) => {
    setIsSubmitting(true);
    setSubmitError(null);

    try {
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

      const parsedAmount = parseFloat(values.amount);
      const amountMinor = Math.round(parsedAmount * 100);

      const result = await logReminderPayment({
        followUpId,
        amount: parsedAmount,
        currency: values.currency,
        programId: values.programId as Id<"tenantPrograms">,
        paymentType: values.paymentType,
        proofFileId,
      });

      // PostHog event mirror of the pre-rewrite shape — keep `payment_id`
      // from the mutation return so funnels that joined on this keep working.
      posthog.capture("reminder_outcome_payment", {
        follow_up_id: followUpId,
        payment_id: result.paymentId,
        amount_minor: amountMinor,
        currency: values.currency,
        program_id: values.programId,
        payment_type: values.paymentType,
        has_proof_file: Boolean(proofFileId),
      });
      toast.success("Payment logged successfully");
      onSuccess();
      onOpenChange(false);
      form.reset();
    } catch (err: unknown) {
      posthog.captureException(err);
      const message =
        err instanceof Error
          ? err.message
          : "Failed to log payment. Please try again.";
      setSubmitError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };
```

**Step 5: Dialog JSX — identical to 7A minus `DialogTrigger`**

```tsx
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!isSubmitting) {
          onOpenChange(value);
          if (!value) {
            form.reset();
            setSubmitError(null);
          }
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Log Reminder Payment</DialogTitle>
          <DialogDescription>
            Record a payment from this reminder. The opportunity will transition
            to closed-won once the payment is logged.
          </DialogDescription>
        </DialogHeader>

        {submitError && (
          <Alert variant="destructive">
            <AlertCircleIcon className="size-4" />
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        )}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <FieldGroup>
              {/* --- Fields are IDENTICAL to 7A in shape, order, and copy. --- */}
              {/* See 7A "Step 5" above for the Amount / Currency / Program / */}
              {/* Payment Type / Proof File JSX. No changes needed here. */}
            </FieldGroup>

            <DialogFooter className="mt-5">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                  form.reset();
                  setSubmitError(null);
                }}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Submitting…
                  </>
                ) : (
                  <>
                    <UploadIcon data-icon="inline-start" />
                    Log Payment
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
```

> **Note on JSX duplication.** The Amount / Currency / Program / Payment Type / Proof File fields in 7B are byte-for-byte identical to 7A's field JSX. To keep the rewrite reviewable, leave them in both files. Extracting a `<CommissionablePaymentFields>` composition component is tracked in the follow-up notes at the bottom of this document.

**Key implementation notes:**
- **`followUpId` is the sole link context prop**. The reminder dialog does NOT take `opportunityId` or `meetingId` — the server derives them from the follow-up (Phase 4's rewrite).
- **Externally controlled `open` state**: the parent `<ReminderOutcomeActionBar>` (or the admin equivalent wired in 7D) owns `open`. Matches the existing pre-rewrite prop shape so parent callers do not need to change.
- **Same `generateUploadUrl` / `logReminderPayment` import paths**: the mutation's internal signature changes (adds `programId` / `paymentType`, drops `provider` / `referenceCode`) but its name and module path do not. Consumers only update the payload shape.
- **`payment_id` in PostHog event**: preserved from the pre-rewrite mutation return. Funnel queries that join PostHog events to Convex payment rows rely on this field.
- **Admin-route reuse**: when rendered inside the new admin route (7D), the same dialog submits to the same mutation. The backend routes to `admin_reminder` origin based on the caller's role. No frontend branching.

**Verification checklist (specific to 7B):**

- [ ] Open the dialog from `/workspace/closer/reminders/<id>` → Program shows the active programs.
- [ ] Submit with all fields → Convex log shows `paymentRecords` row with `origin: "closer_reminder"`, `commissionable: true`, `attributedCloserId === followUp.closerId`.
- [ ] Open the dialog from `/workspace/pipeline/reminders/<id>` (after 7D lands) → same JSX. Submit → Convex log shows `origin: "admin_reminder"`, `recordedByUserId === <admin id>`, `attributedCloserId === followUp.closerId`.
- [ ] Submit with `programId = <archived program id>` (mutated out-of-band via admin archive while dialog open) → `toast.error` shows the Phase 3 invariant message `Program "X" is archived and cannot accept new payments. Restore it in Settings → Programs first.`.
- [ ] Submit when `followUp.closerId !== opportunity.assignedCloserId` (owner drift per §14.7) → submit succeeds; Convex log shows the opportunity's `assignedCloserId` was normalized to the reminder owner before the payment row landed.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-payment-dialog.tsx` | Rewrite | Drop provider/referenceCode, add programId/paymentType. |

---

## 7C — Update `review-resolution-dialog.tsx` (log_payment branch only)

**Type:** Frontend (`"use client"`)
**Parallelizable:** Yes — runs alongside 7A, 7B, 7D.

**What:** In the `log_payment` conditional branch of the review resolution dialog's `buildSchema` factory and its corresponding JSX block, replace the `Provider` select with `<ProgramSelect>` + a new `Payment Type` select. Keep the `Reference Code` input (admin attaches the real transaction ID on dispute-resolve rewrites). No file upload — review resolution is an audit action, not a proof-collection action. Every other resolution branch (`schedule_follow_up` / `mark_no_show` / `mark_lost` / `acknowledged` / `disputed`) stays unchanged.

**Why:** Phase 4 extended `resolveReview` to accept `paymentData.programId` + `paymentData.paymentType` under the `log_payment` branch and to write `origin: "admin_review_resolution"` through `createPaymentRecord`. Without updating this dialog, the `paymentData` payload fails validation on the backend and the admin cannot resolve overrun reviews by logging a payment.

**Where:**
- `app/workspace/reviews/[reviewId]/_components/review-resolution-dialog.tsx` (modified)

**How:**

**Step 1: Update the schema builder**

Current shape at `app/workspace/reviews/[reviewId]/_components/review-resolution-dialog.tsx:137-200` (approx):

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/review-resolution-dialog.tsx (current, relevant slice)
const buildSchema = (action: ResolutionAction) =>
  z
    .object({
      amount: z.string().optional(),
      currency: z.string().optional(),
      provider: z.string().optional(),          // ❌ TO REMOVE
      referenceCode: z.string().optional(),     // ✅ KEEP
      noShowReason: z.string().optional(),
      lostReason: z.string().optional(),
      resolutionNote: z.string().optional(),
    })
    .superRefine((data, ctx) => {
      if (action === "log_payment") {
        if (!data.amount || parseFloat(data.amount) <= 0) {
          ctx.addIssue({ code: "custom", message: "Amount is required", path: ["amount"] });
        }
        if (!data.currency) {
          ctx.addIssue({ code: "custom", message: "Currency is required", path: ["currency"] });
        }
        if (!data.provider || data.provider.trim().length === 0) {
          ctx.addIssue({ code: "custom", message: "Provider is required", path: ["provider"] });
        }
      }
      // ...other branches
    });
```

**After:**

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/review-resolution-dialog.tsx (modified)
const buildSchema = (action: ResolutionAction) =>
  z
    .object({
      amount: z.string().optional(),
      currency: z.string().optional(),
      // REMOVED — provider field
      programId: z.string().optional(),         // NEW
      paymentType: z.string().optional(),       // NEW
      referenceCode: z.string().optional(),     // KEPT
      noShowReason: z.string().optional(),
      lostReason: z.string().optional(),
      resolutionNote: z.string().optional(),
    })
    .superRefine((data, ctx) => {
      if (action === "log_payment") {
        if (!data.amount || parseFloat(data.amount) <= 0) {
          ctx.addIssue({ code: "custom", message: "Amount is required", path: ["amount"] });
        }
        if (!data.currency) {
          ctx.addIssue({ code: "custom", message: "Currency is required", path: ["currency"] });
        }
        // NEW — programId + paymentType required
        if (!data.programId) {
          ctx.addIssue({
            code: "custom",
            message: "Program is required",
            path: ["programId"],
          });
        }
        if (
          !data.paymentType ||
          !["pif", "split", "monthly", "deposit"].includes(data.paymentType)
        ) {
          ctx.addIssue({
            code: "custom",
            message: "Payment type is required",
            path: ["paymentType"],
          });
        }
      }
      // ...other branches unchanged
    });
```

**Step 2: Update `defaultValues`**

Current shape (relevant slice):

```tsx
defaultValues: {
  amount: "",
  currency: "",
  provider: "",             // ❌ REMOVE
  referenceCode: "",        // ✅ KEEP
  noShowReason: "",
  lostReason: "",
  resolutionNote: "",
}
```

**After:**

```tsx
defaultValues: {
  amount: "",
  currency: "",
  programId: "",            // NEW
  paymentType: "",          // NEW
  referenceCode: "",        // KEPT
  noShowReason: "",
  lostReason: "",
  resolutionNote: "",
}
```

**Step 3: Update the submit payload (for `log_payment` branch)**

Current shape (relevant slice from line ~257):

```tsx
await resolveReview({
  reviewId,
  resolutionAction,
  ...(resolutionAction === "log_payment" && {
    paymentData: {
      amount: parseFloat(data.amount as string),
      currency: data.currency as string,
      provider: data.provider as string,           // ❌ REMOVE
      referenceCode: (data.referenceCode as string) || undefined,
    },
  }),
  // ...other branches unchanged
});
```

**After:**

```tsx
await resolveReview({
  reviewId,
  resolutionAction,
  ...(resolutionAction === "log_payment" && {
    paymentData: {
      amount: parseFloat(data.amount as string),
      currency: data.currency as string,
      programId: data.programId as Id<"tenantPrograms">,           // NEW
      paymentType: data.paymentType as
        | "pif"
        | "split"
        | "monthly"
        | "deposit",                                               // NEW
      referenceCode: (data.referenceCode as string) || undefined,  // KEPT
    },
  }),
  ...(resolutionAction === "mark_lost" && {
    lostReason: data.lostReason as string,
  }),
  ...(resolutionAction === "mark_no_show" && {
    noShowReason: data.noShowReason as string,
  }),
  ...(resolutionAction === "schedule_follow_up" && {
    resolutionNote: data.resolutionNote as string,
  }),
});
```

**Step 4: Swap the JSX for the `log_payment` branch**

Current shape (relevant slice from ~line 338):

```tsx
{resolutionAction === "log_payment" && (
  <>
    {/* Amount */}
    <FormField control={form.control} name="amount" render={/* ... */} />
    {/* Currency */}
    <FormField control={form.control} name="currency" render={/* ... */} />
    {/* Provider */}
    <FormField
      control={form.control}
      name="provider"
      render={/* ... free-text or select */}
    />
    {/* Reference Code */}
    <FormField control={form.control} name="referenceCode" render={/* ... */} />
  </>
)}
```

**After:**

```tsx
{resolutionAction === "log_payment" && (
  <>
    {/* Amount — unchanged */}
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
              min="0"
              placeholder="299.99"
              disabled={isSubmitting}
              {...field}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />

    {/* Currency — unchanged */}
    <FormField
      control={form.control}
      name="currency"
      render={({ field }) => (
        <FormItem>
          <FormLabel>
            Currency <span className="text-destructive">*</span>
          </FormLabel>
          <Select
            value={field.value}
            onValueChange={field.onChange}
            disabled={isSubmitting}
          >
            <FormControl>
              <SelectTrigger>
                <SelectValue placeholder="USD" />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {CURRENCIES.map((currency) => (
                <SelectItem key={currency} value={currency}>
                  {currency}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />

    {/* NEW — Program (replaces Provider) */}
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
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />

    {/* NEW — Payment Type */}
    <FormField
      control={form.control}
      name="paymentType"
      render={({ field }) => (
        <FormItem>
          <FormLabel>
            Payment Type <span className="text-destructive">*</span>
          </FormLabel>
          <Select
            value={field.value || ""}
            onValueChange={field.onChange}
            disabled={isSubmitting}
          >
            <FormControl>
              <SelectTrigger>
                <SelectValue placeholder="Select payment type" />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              <SelectItem value="pif">PIF (Paid in Full)</SelectItem>
              <SelectItem value="split">Split</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
              <SelectItem value="deposit">Deposit</SelectItem>
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />

    {/* Reference Code — KEPT (admin attaches the real transaction ID) */}
    <FormField
      control={form.control}
      name="referenceCode"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Reference Code</FormLabel>
          <FormControl>
            <Input
              placeholder="Transaction ID from processor"
              disabled={isSubmitting}
              {...field}
            />
          </FormControl>
          <FormDescription>
            Optional. Useful when reconciling a review-resolved payment with
            an external processor's record.
          </FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  </>
)}
```

**Step 5: Ensure `ProgramSelect` is imported at the top of the file**

```tsx
import { ProgramSelect } from "@/app/workspace/closer/_components/program-select";
```

**Step 6: Verify other branches are untouched**

Do NOT edit the `mark_no_show`, `mark_lost`, `schedule_follow_up`, `acknowledged`, or `disputed` branches. Their schema entries (`noShowReason`, `lostReason`, `resolutionNote`) stay. Their JSX stays. Their submit payload stays.

**Key implementation notes:**
- **Why keep `referenceCode` here but drop it from the meeting + reminder dialogs**: design doc §5 explicitly preserves `referenceCode` for customer-direct + admin review-resolution flows. The meeting and reminder variants had it misbound as "Fathom Link" (the Fathom link's real home is `meetings.fathomLink`, edited via the existing `FathomLinkField` on the meeting detail page). Review resolution is the ONE commissionable flow where a real external transaction ID is the natural payload.
- **No file upload**: the review resolution flow already re-references the original payment that triggered the review (in the dispute path) or writes a fresh payment (in the log_payment path). Proof files belong to the original payment, not the resolution action. Do not add `proofFile` here.
- **The `Id<"tenantPrograms">` cast happens at the submit boundary**: same pattern as 7A / 7B. RHF state stores `programId` as a plain string; the server accepts `v.id("tenantPrograms")` via the Convex validator.
- **`paymentType` widened to `z.string().optional()` at the schema level, narrowed at the submit cast**: the review dialog's unified `buildSchema` returns a single schema shape whose branches are enforced via `superRefine`. Mirror the existing `currency: z.string().optional()` pattern instead of introducing a `z.enum` branch in this file.
- **No `posthog.capture` changes**: the review resolution dialog captures an aggregate `review_resolved` event with `resolutionAction` as a property; add `program_id` + `payment_type` to the event metadata when `resolutionAction === "log_payment"` to keep the funnel joinable. (This is a small addition — see the snippet below.)

```tsx
posthog.capture("review_resolved", {
  review_id: reviewId,
  action: resolutionAction,
  ...(resolutionAction === "log_payment" && {
    amount_minor: Math.round(parseFloat(data.amount as string) * 100),
    currency: data.currency,
    program_id: data.programId,
    payment_type: data.paymentType,
    has_reference_code: Boolean(data.referenceCode),
  }),
});
```

**Verification checklist (specific to 7C):**

- [ ] Open `/workspace/reviews/<id>` as tenant_admin, pick `Log payment` → Program, Payment Type, Reference Code fields render in order; Provider field is GONE.
- [ ] Submit with missing Program → inline `FormMessage` shows `"Program is required"`.
- [ ] Submit with missing Payment Type → inline `FormMessage` shows `"Payment type is required"`.
- [ ] Submit with all fields → Convex log shows `paymentRecords` row with `origin: "admin_review_resolution"`, `commissionable: true`, `recordedByUserId === <admin id>`, `attributedCloserId === <assigned closer of the opportunity>`, `referenceCode === <whatever admin typed>` or undefined.
- [ ] Pick `Mark no-show` → only the no-show reason field renders; no Program / Payment Type / Reference Code clutter.
- [ ] Pick `Schedule follow-up` → only the resolution note renders.
- [ ] Pick `Disputed` → unchanged from pre-rewrite (this branch disputes an existing payment and doesn't write a new one).
- [ ] Navigate back to `/workspace/reviews` on success.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reviews/[reviewId]/_components/review-resolution-dialog.tsx` | Modify | `log_payment` branch only; preserve all other branches. |

---

## 7D — NEW Admin Reminder Detail Route + Client

**Type:** Frontend (RSC + client component)
**Parallelizable:** Yes — runs alongside 7A, 7B, 7C. Consumes 7B's `ReminderPaymentDialog` at integration time.

**What:** A brand-new route `/workspace/pipeline/reminders/[followUpId]/` that lets tenant admins and masters view a reminder's detail and log an on-behalf payment. The route mirrors the existing closer reminder detail at `/workspace/closer/reminders/[followUpId]/` with two key differences: (a) server-side `requireRole(["tenant_master", "tenant_admin"])` instead of `["closer"]`, (b) the page calls the new Phase 4 query `api.pipeline.reminderDetail.getAdminReminderDetail` which does NOT filter by caller's `convertedByUserId`.

**Why:** Phase 4 extended `logReminderPayment` to accept admin callers with the new `admin_reminder` origin, but the design doc (§7.3) explicitly ties the backend extension to a dedicated admin UI surface. Without 7D, the admin reminder mutation is callable only via cURL or tests — not through any real user interface. 7D delivers the "real UI" that makes the backend extension user-visible.

**Where:**
- `app/workspace/pipeline/reminders/[followUpId]/page.tsx` (new — RSC)
- `app/workspace/pipeline/reminders/[followUpId]/loading.tsx` (new — route-level skeleton)
- `app/workspace/pipeline/reminders/[followUpId]/_components/admin-reminder-detail-page-client.tsx` (new — client)
- `app/workspace/pipeline/reminders/[followUpId]/_components/admin-reminder-outcome-action-bar.tsx` (new — small wrapper around `ReminderPaymentDialog`)

**How:**

**Step 1: Create the RSC page**

```tsx
// Path: app/workspace/pipeline/reminders/[followUpId]/page.tsx
import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { requireRole } from "@/lib/auth";
import type { Id } from "@/convex/_generated/dataModel";
import { AdminReminderDetailPageClient } from "./_components/admin-reminder-detail-page-client";

// PPR-ready marker per AGENTS.md § RSC three-layer page pattern
export const unstable_instant = false;

/**
 * Admin Reminder Detail Page (Phase 7D)
 *
 * Tenant-admin / master-only route that lets an admin view a reminder
 * and log a commissionable payment on behalf of the assigned closer.
 * The mutation (`logReminderPayment`) is shared with the closer flow;
 * the server-side role check drives the `admin_reminder` origin branch.
 *
 * `requireRole(["tenant_master", "tenant_admin"])` redirects non-admin
 * callers to their role-appropriate workspace per the existing auth helper.
 */
export default async function AdminReminderDetailPage({
  params,
}: {
  params: Promise<{ followUpId: string }>;
}) {
  const { session } = await requireRole([
    "tenant_master",
    "tenant_admin",
  ]);
  const { followUpId } = await params;

  const typedFollowUpId = followUpId as Id<"followUps">;
  const preloadedDetail = await preloadQuery(
    api.pipeline.reminderDetail.getAdminReminderDetail,
    { followUpId: typedFollowUpId },
    { token: session.accessToken },
  );

  return (
    <AdminReminderDetailPageClient preloadedDetail={preloadedDetail} />
  );
}
```

**Step 2: Route-level skeleton**

```tsx
// Path: app/workspace/pipeline/reminders/[followUpId]/loading.tsx
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export default function AdminReminderDetailLoading() {
  return (
    <div
      className="flex flex-col gap-6"
      role="status"
      aria-label="Loading reminder detail"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-8 w-64" />
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-48" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-48" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}
```

**Step 3: Client shell — reuses closer components where possible, duplicates where needed**

```tsx
// Path: app/workspace/pipeline/reminders/[followUpId]/_components/admin-reminder-detail-page-client.tsx
"use client";

import { usePreloadedQuery, type Preloaded } from "convex/react";
import { api } from "@/convex/_generated/api";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDistanceToNow } from "date-fns";
import { AlertCircleIcon, ArrowLeftIcon } from "lucide-react";

import { AdminReminderOutcomeActionBar } from "./admin-reminder-outcome-action-bar";

interface AdminReminderDetailPageClientProps {
  preloadedDetail: Preloaded<
    typeof api.pipeline.reminderDetail.getAdminReminderDetail
  >;
}

export function AdminReminderDetailPageClient({
  preloadedDetail,
}: AdminReminderDetailPageClientProps) {
  const detail = usePreloadedQuery(preloadedDetail);

  // Not found — either bad ID or cross-tenant hit (server already blocks).
  if (!detail) {
    return (
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertCircleIcon className="size-5 text-destructive" />
              Reminder not found
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              This reminder may have been deleted or doesn&apos;t exist. Try
              returning to the pipeline.
            </p>
            <Button asChild variant="outline" className="w-fit">
              <Link href="/workspace/pipeline">
                <ArrowLeftIcon data-icon="inline-start" />
                Back to Pipeline
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { followUp, lead, opportunity, meeting, assignedCloserName, priorPayments } =
    detail;

  return (
    <div className="flex flex-col gap-6">
      {/* Breadcrumbs-ish header */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Link
            href="/workspace/pipeline"
            className="hover:text-foreground hover:underline"
          >
            Pipeline
          </Link>
          <span>/</span>
          <span>Reminders</span>
        </div>
        <h1 className="text-2xl font-semibold">
          {lead?.fullName ?? lead?.email ?? "Unnamed lead"}
        </h1>
      </div>

      {/* Context card — lead + assigned closer + scheduled info */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Reminder Context</span>
            <Badge variant="secondary">
              Assigned to {assignedCloserName ?? "Unassigned"}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <p>
            <span className="text-muted-foreground">Scheduled for:</span>{" "}
            {formatDistanceToNow(followUp.scheduledFor, { addSuffix: true })}
          </p>
          {followUp.reason && (
            <p>
              <span className="text-muted-foreground">Reason:</span>{" "}
              {followUp.reason}
            </p>
          )}
          {meeting && (
            <p>
              <span className="text-muted-foreground">Related meeting:</span>{" "}
              <Link
                href={`/workspace/pipeline/meetings/${meeting._id}`}
                className="text-primary hover:underline"
              >
                View meeting detail
              </Link>
            </p>
          )}
        </CardContent>
      </Card>

      {/* Prior payments card — keeps the admin honest when re-logging */}
      {priorPayments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Prior Payments on This Opportunity</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {priorPayments.map((payment) => (
              <div
                key={payment._id}
                className="flex items-center justify-between rounded-md border px-3 py-2"
              >
                <div className="flex flex-col">
                  <p className="font-medium">
                    {(payment.amountMinor / 100).toLocaleString(undefined, {
                      style: "currency",
                      currency: payment.currency,
                    })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {payment.programName} · {payment.paymentType}
                  </p>
                </div>
                <Badge variant="outline">{payment.origin}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Action bar — the one write affordance this route offers */}
      <AdminReminderOutcomeActionBar
        followUpId={followUp._id}
        opportunityId={opportunity?._id}
      />
    </div>
  );
}
```

**Step 4: Action bar wrapper**

```tsx
// Path: app/workspace/pipeline/reminders/[followUpId]/_components/admin-reminder-outcome-action-bar.tsx
"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BanknoteIcon } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";

// Lazy-load the dialog — only mounts on user click
const ReminderPaymentDialog = dynamic(() =>
  import(
    "@/app/workspace/closer/reminders/[followUpId]/_components/reminder-payment-dialog"
  ).then((m) => ({ default: m.ReminderPaymentDialog })),
);

interface AdminReminderOutcomeActionBarProps {
  followUpId: Id<"followUps">;
  /** Present iff the reminder is still tied to an active opportunity. */
  opportunityId?: Id<"opportunities">;
}

export function AdminReminderOutcomeActionBar({
  followUpId,
  opportunityId,
}: AdminReminderOutcomeActionBarProps) {
  const router = useRouter();
  const [logOpen, setLogOpen] = useState(false);

  // If the opportunity is gone (deleted, converted to customer, etc.), hide
  // the action entirely — an admin cannot log a reminder payment without a
  // live opportunity. This mirrors Phase 4's `logReminderPayment` invariants.
  if (!opportunityId) {
    return (
      <div className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">
        This reminder no longer has an active opportunity. No payment action
        is available.
      </div>
    );
  }

  return (
    <div className="flex justify-end">
      <Button onClick={() => setLogOpen(true)}>
        <BanknoteIcon data-icon="inline-start" />
        Log Payment (on behalf)
      </Button>

      {logOpen && (
        <ReminderPaymentDialog
          followUpId={followUpId}
          open={logOpen}
          onOpenChange={setLogOpen}
          onSuccess={() => {
            // Re-run the RSC tree so the "Prior Payments" card reflects the
            // newly-inserted row without a manual reload.
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
```

**Step 5: Wire a navigation entry for admins (optional — out of scope note)**

Admins reach the new route by typing the URL or by following a link from a future admin pipeline surface. In Phase 7 we do NOT add a link on the admin dashboard or pipeline page — that is a Phase 9 concern (activity feed / reporting row actions). The route is reachable-via-URL-today, which is sufficient for the backend + QA surface. The Phase 9 wiring (activity feed CTA, reminders report row action) will add deep-link navigation.

**Step 6: Typecheck + lint**

```bash
pnpm tsc --noEmit
pnpm lint
```

**Key implementation notes:**
- **`requireRole(["tenant_master", "tenant_admin"])` at the RSC level is the primary gate**. Closers are redirected server-side and never see the client. The Convex query `getAdminReminderDetail` is a second line of defense — it also checks the caller's role, so a direct Convex call with a closer's token still fails.
- **Reuse of `reminder-payment-dialog.tsx` across two routes is intentional**. The dialog accepts `followUpId` + a standard `{ open, onOpenChange, onSuccess }` external-control contract. The admin route wraps it with a different "context" chrome (breadcrumbs, prior payments card); the dialog itself does not know or care which role opened it.
- **`priorPayments` query field**: the new `getAdminReminderDetail` query returns prior payments on the opportunity (Phase 4's query). They render as a muted audit trail so the admin can confirm they are not double-logging.
- **`assignedCloserName`**: also returned by `getAdminReminderDetail`. Displayed as a secondary badge so the admin is crystal clear which closer's commission is being credited.
- **`dynamic()` for the dialog**: defers the bundle until the admin actually clicks the button. Consistent with `programs-tab.tsx:20-24`.
- **`router.refresh()` on success**: re-runs the RSC tree so the "Prior Payments" card updates. `revalidatePath` would also work but `router.refresh()` is the lighter choice when the only changed surface is the current route.
- **Empty opportunity guard**: if `detail.opportunity === null` (the opportunity was deleted between the reminder creation and the admin's page visit), hide the payment action. The mutation would fail anyway; hiding the button pre-empts the error path.
- **Why `app/workspace/pipeline/reminders/...` and not `app/workspace/admin/reminders/...`**: the codebase nests admin surfaces under `pipeline/` (see `app/workspace/pipeline/meetings/[meetingId]/` which is the admin counterpart of the closer's meeting detail). Keep the convention.

**Verification checklist (specific to 7D):**

- [ ] Sign in as `tenant_admin@seed.dev` → manually visit `/workspace/pipeline/reminders/<valid followUpId from seed>` → the page loads, the header shows the lead name, the context card shows the assigned closer's name, any prior payments render.
- [ ] Sign in as `closer@seed.dev` → visit the same URL → server-side redirect fires; closer lands on `/workspace/closer`.
- [ ] As admin, click `Log Payment (on behalf)` → the rewritten `<ReminderPaymentDialog>` opens; all fields (Amount, Currency, Program, Payment Type, Proof) render.
- [ ] Submit → Convex log confirms `paymentRecords` row has `origin: "admin_reminder"`, `attributedCloserId === followUp.closerId`, `recordedByUserId === <admin user id>`, `commissionable: true`.
- [ ] The "Prior Payments" card on the same page shows the newly-inserted payment within ~500ms (reactive query).
- [ ] Submit an admin payment with `programId = <archived program>` (archive via Settings tab before the admin opens the dialog) → toast shows the archived-program invariant error from Phase 3.
- [ ] Visit `/workspace/pipeline/reminders/<deleted-followUpId>` → "Reminder not found" card renders with "Back to Pipeline" CTA.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/pipeline/reminders/[followUpId]/page.tsx` | Create | Admin reminder detail RSC. |
| `app/workspace/pipeline/reminders/[followUpId]/loading.tsx` | Create | Route-level skeleton. |
| `app/workspace/pipeline/reminders/[followUpId]/_components/admin-reminder-detail-page-client.tsx` | Create | Client shell + prior payments + action bar wrapper. |
| `app/workspace/pipeline/reminders/[followUpId]/_components/admin-reminder-outcome-action-bar.tsx` | Create | Button + lazy-loaded ReminderPaymentDialog. |

---

## 7E — Verification Pass

**Type:** Cross-cutting verification — not a new file.
**Parallelizable:** No — runs after 7A, 7B, 7C, 7D all merge.

**What:** A disciplined grep + typecheck + lint + runtime smoke test that confirms the four subphases integrate cleanly. No code is written in 7E; it is a checklist the final reviewer runs before marking Phase 7 complete.

**Why:** Four parallel streams touching adjacent concerns invite subtle regressions — a forgotten import, a stale enum reference, a wrong Id cast, a drifted PostHog field name. A dedicated verification pass catches the common forms.

**How:**

**Step 1: Grep for stale references**

```bash
# Should return ZERO hits in closer/meetings and closer/reminders.
# (Review resolution keeps Reference Code, so grep there is expected.)
pnpm grep -rn 'PROVIDERS' app/workspace/closer/
pnpm grep -rn '"Fathom Link"' app/workspace/closer/
pnpm grep -rn 'name="provider"' app/workspace/closer/
pnpm grep -rn "provider: z.enum" app/workspace/closer/
```

```bash
# Review resolution: expect ONE hit for referenceCode (kept), ZERO for provider.
pnpm grep -rn 'name="provider"' app/workspace/reviews/
pnpm grep -rn 'name="referenceCode"' app/workspace/reviews/  # should be 1
```

**Step 2: Typecheck + lint**

```bash
pnpm tsc --noEmit
pnpm lint
```

Both must pass with zero errors / zero new warnings.

**Step 3: Integration smoke test (per `TESTING.MD`)**

Execute the full Smoke Test Script at the bottom of this document. Abort merge if any step fails.

**Step 4: Confirm the admin action bar still uses `PaymentFormDialog`**

The `admin-action-bar.tsx` file (`app/workspace/pipeline/meetings/_components/admin-action-bar.tsx`) already imports and renders `<PaymentFormDialog opportunityId={...} meetingId={...} />`. 7A's rewrite is transparent to this caller because the prop signature did not change. Confirm by opening `/workspace/pipeline/meetings/<in-progress meeting id>` as an admin → "Log Payment" button opens the rewritten dialog.

**Step 5: Confirm closer's `outcome-action-bar.tsx` still uses `PaymentFormDialog`**

The closer's `outcome-action-bar.tsx` (`app/workspace/closer/meetings/_components/outcome-action-bar.tsx`) imports the same component. Confirm by opening `/workspace/closer/meetings/<in-progress meeting id>` as a closer → "Log Payment" button opens the rewritten dialog.

**Step 6: Confirm the closer's `reminder-outcome-action-bar.tsx` still uses `ReminderPaymentDialog`**

Open `/workspace/closer/reminders/<pending reminder id>` → "Log Payment" option opens the rewritten dialog with Program + Payment Type fields.

**Verification checklist (7E-level):**

- [ ] Grep passes (all expected zeros are zero; all expected ones are one).
- [ ] `pnpm tsc --noEmit` passes.
- [ ] `pnpm lint` passes.
- [ ] Smoke test script below passes.
- [ ] Convex dashboard `[Payments]` logs show the expected origin variety: one each of `closer_meeting`, `admin_meeting`, `closer_reminder`, `admin_reminder`, `admin_review_resolution`. No row with `provider` set. No row missing `programId` or `paymentType`.

**Files touched:** None.

---

## Rollout Order & Ship Checklist

**Ship Phase 7 as a single coordinated release.** Unlike Phase 6 (where 6A can ship ahead), Phase 7's four subphases must land together because:

- **7A's rewrite** makes the `PaymentFormDialog` incompatible with Phase 3's new `logPayment` signature. Shipping 7A alone against an un-migrated tenant breaks the closer meeting flow.
- **7B's rewrite** is identical — shipping 7B alone breaks the closer reminder flow.
- **7C's rewrite** breaks the review resolution flow.
- **7D's new route** references a query (`getAdminReminderDetail`) that was added in Phase 4; it only works if Phase 4 is merged.

Because Phases 1–5 (backend) must be deployed before any Phase 7 piece, the natural shipping order is:

1. Deploy Phases 1–5 Convex code to production.
2. Merge Phase 6A (`ProgramSelect` shared component) to the frontend.
3. **Merge Phase 7 (all four subphases + the verification pass) as a single PR or a tight chain of PRs.**
4. Observe the first production `closer_meeting` + `closer_reminder` + `admin_meeting` + `admin_reminder` + `admin_review_resolution` payment rows in Convex.
5. Merge Phase 6B–6E (Settings UI) once 7's smoke test passes — the Settings UI is admin comfort, not a write-path blocker.

**Rollback plan.** Phase 7 is frontend-only. If a production bug surfaces:

- Revert the Phase 7 commit(s) on the frontend branch.
- Vercel re-promotes the previous build.
- The `paymentRecords` rows created during the canary window are schema-valid under Phase 2's shape (Phase 7 does not write fields that are incompatible with the schema).
- Admins temporarily lose the review-resolution `log_payment` branch until the rewrite is re-landed; the `schedule_follow_up` / `mark_no_show` / `mark_lost` / `disputed` branches continue to work.
- The admin reminder route is gone; admins cannot log reminder payments on behalf of closers during the rollback window. This is tolerable for hours but not days.

**Feature-flagging considerations.** We do NOT gate Phase 7 behind a feature flag. Reasoning:

- The backend has already been destructively migrated (Phases 2–5). There is no parallel "old code path" to fall back to.
- A feature flag that routes between the old dialog and the new one would require keeping the old `PROVIDERS` constant + the old mutation signature alive — which defeats the Phase 2 simplification.
- The four frontend subphases are small enough (four files + one route) that the blast radius of a bad merge is contained.
- Monitoring via Convex logs + PostHog event shape is sufficient to detect a bad release within minutes.

---

## Smoke Test Script (manual QA per `TESTING.MD`)

**Prerequisites:**

- Phases 1–5 deployed to Convex.
- Phase 6A merged (shared `ProgramSelect`).
- At least two programs seeded for the test tenant: `Launchpad` + `Accelerator`.
- Test users: `tenant_admin@seed.dev`, `tenant_master@seed.dev`, `closer@seed.dev`.
- One in-progress opportunity + meeting to close (book via `testing/calendly:bookTestInvitee`).
- One pending reminder on an in-progress opportunity.
- One flagged review (overrun meeting) ready for resolution.

**Scenario 1: Closer meeting payment (`closer_meeting` origin) — 7A**

1. Sign in as `closer@seed.dev`.
2. Navigate to `/workspace/closer/meetings/<in-progress-id>`.
3. Click `Log Payment`. Verify the dialog opens; no Provider field visible; no Fathom Link field visible.
4. Type `299.99`, leave Currency as `USD`, select Program `Launchpad`, select Payment Type `PIF (Paid in Full)`.
5. Submit. Expect: `toast.success("Payment logged successfully")`; dialog closes; the meeting view refreshes.
6. In Convex dashboard, run `npx convex data paymentRecords --limit 1 --order desc` and confirm the row has `origin: "closer_meeting"`, `commissionable: true`, `attributedCloserId === <closer user id>`, `recordedByUserId === <closer user id>`, `programName: "Launchpad"`, `paymentType: "pif"`, no `provider` field, no `referenceCode` field.

**Scenario 2: Admin meeting payment on behalf (`admin_meeting` origin) — 7A via admin action bar**

1. Sign out. Sign in as `tenant_admin@seed.dev`.
2. Navigate to `/workspace/pipeline/meetings/<a DIFFERENT in-progress meeting id>`.
3. Click `Log Payment`. Verify the same rewritten dialog opens (no Provider, with Program + Payment Type).
4. Type `499.00`, select Program `Accelerator`, Payment Type `Deposit` → verify the "Deposits are tracked separately…" description appears.
5. Submit. Expect: toast + dialog close + meeting view refresh.
6. Convex row: `origin: "admin_meeting"`, `commissionable: true`, `attributedCloserId === opportunity.assignedCloserId`, `recordedByUserId === <admin user id>`, `paymentType: "deposit"`.

**Scenario 3: Closer reminder payment (`closer_reminder` origin) — 7B**

1. Sign in as `closer@seed.dev`.
2. Navigate to the closer dashboard; click a pending reminder in the `<RemindersSection>` card.
3. Land at `/workspace/closer/reminders/<id>`.
4. Click `Log Payment` in the outcome action bar.
5. Fill Amount `1,200.00`, Program `Launchpad`, Payment Type `Split` → verify the split/monthly description hint shows.
6. Submit. Convex row: `origin: "closer_reminder"`, `paymentType: "split"`, `attributedCloserId === followUp.closerId`.

**Scenario 4: Admin reminder payment on behalf (`admin_reminder` origin) — 7D + 7B**

1. Sign in as `tenant_admin@seed.dev`.
2. Manually navigate to `/workspace/pipeline/reminders/<a different pending reminder id>`.
3. Verify the admin reminder detail page loads: lead name in header, context card with assigned closer's name, prior payments (if any), "Log Payment (on behalf)" button.
4. Click the button. Verify the same rewritten `<ReminderPaymentDialog>` opens.
5. Submit a `499.00 USD` monthly payment under `Accelerator`.
6. Convex row: `origin: "admin_reminder"`, `attributedCloserId === followUp.closerId` (NOT the admin), `recordedByUserId === <admin user id>`, `commissionable: true`.
7. The "Prior Payments" card on the admin reminder page updates reactively within ~1s.

**Scenario 5: Admin review resolution — log payment (`admin_review_resolution` origin) — 7C**

1. Sign in as `tenant_admin@seed.dev`.
2. Navigate to `/workspace/reviews/<flagged review id>`.
3. Select `Log payment` as the resolution action.
4. Verify: Amount, Currency, Program, Payment Type, Reference Code fields render. Provider field is GONE.
5. Fill Amount `750.00`, Program `Launchpad`, Payment Type `PIF`, optional Reference Code `stripe_pi_abc123`.
6. Submit. Expect: toast + route push to `/workspace/reviews`.
7. Convex row: `origin: "admin_review_resolution"`, `commissionable: true`, `attributedCloserId === opportunity.assignedCloserId`, `recordedByUserId === <admin id>`, `referenceCode: "stripe_pi_abc123"`.

**Scenario 6: Closer can NOT reach admin reminder route — 7D gate**

1. Sign in as `closer@seed.dev`.
2. Manually navigate to `/workspace/pipeline/reminders/<any id>`.
3. Expect: server-side redirect to `/workspace/closer` (or `/` if no role).

**Scenario 7: Archived program mid-dialog protection — §14.2 + Phase 3 invariant**

1. Sign in as `tenant_admin@seed.dev` in tab A.
2. Sign in as `closer@seed.dev` in tab B; open `/workspace/closer/meetings/<in-progress>`; open the `Log Payment` dialog; select `Launchpad` as the program; do NOT submit.
3. In tab A, go to `/workspace/settings` → Programs → archive `Launchpad`.
4. In tab B, submit the dialog (program value still `Launchpad`, now archived).
5. Expect: `toast.error` shows the archived-program invariant from Phase 3 (`Program "Launchpad" is archived and cannot accept new payments. Restore it in Settings → Programs first.`). Dialog stays open; closer can switch to `Accelerator` and retry.

**Expected outcomes for all seven scenarios:** every submit either succeeds with the expected Convex row shape or fails with the expected guard error. No `undefined` program names. No NaN amounts. No `provider` field on any row. Console is clean.

---

## Follow-up Notes (out-of-scope for Phase 7)

- **Extract `<CommissionablePaymentFields>` composition**: the Amount / Currency / Program / Payment Type / Proof JSX is byte-for-byte duplicated between `payment-form-dialog.tsx` (7A) and `reminder-payment-dialog.tsx` (7B), and partially in `review-resolution-dialog.tsx` (7C). Post-v0.5.1 polish phase: extract into a single presentational component accepting `form` + `isSubmitting`. Blocked on Phase 7 stabilizing.
- **Admin navigation entry for reminder detail**: the admin route at `/workspace/pipeline/reminders/[id]` is currently reachable only by typing the URL or from the activity feed's reminder CTA (Phase 9). A future admin pipeline view might list active reminders in a dedicated panel; track in a separate design.
- **Activity-feed reminder row CTA**: when Phase 9 ships, the activity feed's "Reminder due for closer X" row should link to either the closer's view (if the admin is spectating) or the admin's view (if the admin intends to log on behalf). Leave to Phase 9 for the routing logic.
- **"Don't log a payment during split installment" guard**: Open Question #2 in the design doc — a payment plan scheduler that prevents the closer from mistakenly re-logging a scheduled installment as a fresh commissionable PIF. Deferred to Phase N+1.
- **Per-program Payment Type restrictions**: Open Question #3 — lock specific payment types to specific programs. Deferred. The MVP treats all four types as available in every program.
- **Admin bulk reminder payment UI**: the admin reminder route is one-at-a-time today. If bookkeeper role lands, bulk import will need a different surface (CSV upload or batch API). Out of scope.
- **Inline archive-program warning in `<ProgramSelect>`**: if an admin archives the currently-selected program while a closer's dialog is open, the closer sees the error at submit time. A friendlier UX would flash the select with an `aria-live="polite"` warning when the reactive `listPrograms` result changes. Deferred to a polish pass.
- **Deposit-handling evolution**: Open Question #1 — should deposits leave the opportunity in `in_progress` instead of terminating? MVP terminates at `payment_received` for every payment type. Revisit after production usage data.
- **Currency dropdown audit**: 7A / 7B / 7C share `CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"]` as inline constants. Phase 6B also has an overlapping `CURRENCY_OPTIONS` list but sans JPY. Alignment is a minor fit-and-finish task — extract to `lib/currency.ts` when the composition refactor happens.

---

## Files Touched Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` | Rewrite | 7A |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-payment-dialog.tsx` | Rewrite | 7B |
| `app/workspace/reviews/[reviewId]/_components/review-resolution-dialog.tsx` | Modify | 7C |
| `app/workspace/pipeline/reminders/[followUpId]/page.tsx` | Create | 7D |
| `app/workspace/pipeline/reminders/[followUpId]/loading.tsx` | Create | 7D |
| `app/workspace/pipeline/reminders/[followUpId]/_components/admin-reminder-detail-page-client.tsx` | Create | 7D |
| `app/workspace/pipeline/reminders/[followUpId]/_components/admin-reminder-outcome-action-bar.tsx` | Create | 7D |

**Total:** 3 rewritten dialogs, 4 new files for the admin reminder route — all under 500 lines individually, all following the canonical shadcn + RHF + Zod pattern from `AGENTS.md § Form Patterns`.
