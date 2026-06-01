# Phase 5 — Reminder Outcome Action Bar + Dialogs

**Goal:** Replace the Phase 4 stub `ReminderOutcomeActionBar` with the real action bar that exposes three outcome buttons, wire each to its Phase 3 mutation via a dedicated dialog (`ReminderPaymentDialog`, `ReminderMarkLostDialog`, `ReminderNoResponseDialog`), and instrument three PostHog events so we can measure adoption. After this phase, a closer can open the reminder page, click any outcome, complete the flow, and return to the dashboard with the reminder removed and the opportunity correctly transitioned.

**Prerequisite:**
- Phase 3 deployed. The three mutations (`logReminderPayment`, `markReminderLost`, `markReminderNoResponse`) must be callable.
- Phase 4 scaffolding deployed. The `reminder-outcome-action-bar.tsx` stub must already be imported by the client shell.

**Runs in PARALLEL with:** Phase 4 (after both are past the stub exchange — see the parallelization strategy's Window 3 for the precise handoff). Phase 5 owns exactly one stub-replacement file (`reminder-outcome-action-bar.tsx`) plus three new dialog files. It does not modify the page or the panels.

> **Critical path:** This phase is on the critical path (Phase 1 → Phase 3 → **Phase 5** → Phase 6). The entire feature is gated on the dialogs working end-to-end — start 5A as soon as Phase 3's mutations are callable against the dev deployment.

**Skills to invoke:**
- `shadcn` — Source `Dialog`, `AlertDialog`, `RadioGroup`, `Form`, `Input`, `Textarea`, `Select`. Confirm each is installed.
- `frontend-design` — Polish the no-response dialog's conditional fields; keep the payment dialog visually consistent with the meeting payment dialog so closers do not perceive two different "log a payment" UIs.
- `web-design-guidelines` — WCAG: focus order inside each dialog, radio group labelling, visible focus rings, `aria-describedby` for inline errors.
- `vercel-react-best-practices` — Use `dynamic(() => import(...), { ssr: false })` for dialog shells that only open on interaction; keep payment upload state scoped to the payment dialog only.
- `convex-performance-audit` — Re-check that no dialog creates orphaned `useQuery` subscriptions while closed. The dialogs should only subscribe to data they render.

**Acceptance Criteria:**
1. The action bar renders exactly three outcome buttons on a pending reminder whose opportunity is in `follow_up_scheduled`: **Log Payment**, **Mark as Lost**, **No Response**.
2. When the follow-up is already completed (`followUp.status !== "pending"`), the action bar renders an informational alert and no buttons.
3. When the parent opportunity is in a terminal status (`payment_received`, `lost`, `no_show`), the action bar renders an informational alert with the terminal status and no buttons.
4. **Payment flow:** Clicking **Log Payment** opens `ReminderPaymentDialog`. Submitting a valid form calls `api.closer.reminderOutcomes.logReminderPayment`, closes the dialog on success, fires `posthog.capture("reminder_outcome_payment", ...)`, and navigates back to `/workspace/closer`.
5. **Mark as Lost flow:** Clicking **Mark as Lost** opens `ReminderMarkLostDialog` (AlertDialog). Confirming calls `api.closer.reminderOutcomes.markReminderLost` with the optional reason, fires `posthog.capture("reminder_outcome_lost", ...)`, and navigates back.
6. **No Response flow:** Clicking **No Response** opens `ReminderNoResponseDialog` with three radio choices. Submitting:
   - With `schedule_new` passes `newReminder: { contactMethod, reminderScheduledAt, reminderNote }` to the mutation; validates the time is in the future.
   - With `give_up` calls the mutation; the confirmation toast reads "Opportunity marked lost".
   - With `close_only` calls the mutation; the confirmation toast reads "Reminder closed".
   Fires `posthog.capture("reminder_outcome_no_response", { next_step, ... })` with the chosen next step.
7. Each dialog uses React Hook Form + Zod via `standardSchemaResolver` (AGENTS.md form pattern).
8. Each dialog disables its submit button while the mutation is in flight and re-enables it on success/error.
9. Each dialog shows a toast on success and a toast on error (`toast.error(err.message)`).
10. The payment dialog reuses `api.closer.payments.generateUploadUrl` for proof upload; file size and MIME type are validated client-side (`≤10MB`, image/PDF) before hitting the upload URL.
11. All four component files are dynamically imported via `next/dynamic` so they do not ship in the initial bundle.
12. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
5A (ReminderOutcomeActionBar) ──────┐
                                    ├── 5B (ReminderPaymentDialog)    ─┐
                                    ├── 5C (ReminderMarkLostDialog)   ─┤── 5E (PostHog events)
                                    └── 5D (ReminderNoResponseDialog) ─┘
```

**Optimal execution:**
1. **5A** first — it replaces the stub. Once 5A's scaffolding is on disk with `dynamic()` imports pointing at still-stub dialog files, 5B/5C/5D can run in parallel.
2. **5B**, **5C**, **5D** in parallel — each is a self-contained dialog file, different form schemas, different mutations. No shared files.
3. **5E** last — it is a small instrumentation pass across the three dialog files. Consolidating it into a single subphase avoids PostHog key drift between the three dialogs.

**Estimated time:** 2–2.5 days.
- 5A: 2–3 hours.
- 5B: 3–4 hours (payment dialog has the file-upload + RHF/Zod + mutation orchestration — most surface area).
- 5C: 1 hour (smallest dialog, AlertDialog pattern).
- 5D: 3–4 hours (conditional fields, `superRefine`, branch toasts).
- 5E: 1 hour (three events, three inserts).

---

## Subphases

### 5A — `ReminderOutcomeActionBar`

**Type:** Frontend
**Parallelizable:** No within Phase 5 (blocks 5B/5C/5D — they are mounted through this bar). Parallelizable with Phase 4's 4C/4D/4E if they have not landed yet.

**What:** Replace the Phase 4 stub with the real action bar. Renders three buttons (or an informational alert if the reminder is completed or the opportunity is terminal). Each button opens its matching dialog (5B/5C/5D) via `dynamic()` import.

**Why:** The bar is the traffic cop for all three outcomes. Centralising the "is this reminder actionable?" logic here (rather than in each dialog) keeps the dialogs simple and the UI state predictable.

**Where:**
- `app/workspace/closer/reminders/[followUpId]/_components/reminder-outcome-action-bar.tsx` (modify the 4B stub)

**How:**

**Step 1: Replace the stub with the full implementation.** Mirror `OutcomeActionBar` from the meeting detail page (`app/workspace/closer/meetings/_components/outcome-action-bar.tsx`) for structure.

```tsx
// Path: app/workspace/closer/reminders/[followUpId]/_components/reminder-outcome-action-bar.tsx
"use client";

import dynamic from "next/dynamic";
import type { Doc } from "@/convex/_generated/dataModel";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { InfoIcon } from "lucide-react";

// Lazy-load dialog components; they only hydrate when the button is
// clicked. Matches the meeting detail bar's pattern.
const ReminderPaymentDialog = dynamic(() =>
  import("./reminder-payment-dialog").then((m) => ({
    default: m.ReminderPaymentDialog,
  })),
);
const ReminderMarkLostDialog = dynamic(() =>
  import("./reminder-mark-lost-dialog").then((m) => ({
    default: m.ReminderMarkLostDialog,
  })),
);
const ReminderNoResponseDialog = dynamic(() =>
  import("./reminder-no-response-dialog").then((m) => ({
    default: m.ReminderNoResponseDialog,
  })),
);

type Props = {
  followUp: Doc<"followUps">;
  opportunity: Doc<"opportunities">;
  disabled: boolean;
  onCompleted: () => void;
};

/**
 * Reminder Outcome Action Bar — exposes the three outcome buttons
 * (payment / mark lost / no response). Guards against completed
 * reminders and terminal opportunities (see design doc §14.2, §14.3).
 */
export function ReminderOutcomeActionBar({
  followUp,
  opportunity,
  disabled,
  onCompleted,
}: Props) {
  // Already-completed reminder — matches design doc §14.2.
  if (disabled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert>
            <InfoIcon />
            <AlertDescription>
              This reminder has already been completed.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  // Opportunity-level guardrail — matches design doc §14.3.
  const isOppTerminal =
    opportunity.status === "payment_received" ||
    opportunity.status === "lost" ||
    opportunity.status === "no_show";

  if (isOppTerminal) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert>
            <InfoIcon />
            <AlertDescription>
              The underlying opportunity is already{" "}
              <b className="capitalize">
                {opportunity.status.replace(/_/g, " ")}
              </b>
              . Close this reminder from the previous page.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Outcome</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 [&_button]:w-full">
        <ReminderPaymentDialog
          followUpId={followUp._id}
          onSuccess={onCompleted}
        />
        <Separator />
        <ReminderMarkLostDialog
          followUpId={followUp._id}
          onSuccess={onCompleted}
        />
        <ReminderNoResponseDialog
          followUpId={followUp._id}
          leadId={followUp.leadId}
          onSuccess={onCompleted}
        />
      </CardContent>
    </Card>
  );
}
```

**Step 2: Verify the typecheck with three still-stubbed dialogs.** At this point the three dialog files exist but return `null`. TypeScript still validates the `{ followUpId, onSuccess }` and `{ followUpId, leadId, onSuccess }` prop shapes — so keep the dialog stubs typed:

```tsx
// Path: reminder-payment-dialog.tsx (stub)
"use client";
import type { Id } from "@/convex/_generated/dataModel";
export function ReminderPaymentDialog(_: {
  followUpId: Id<"followUps">;
  onSuccess: () => void;
}) {
  return null;
}
```

Apply the same stub pattern to `reminder-mark-lost-dialog.tsx` and `reminder-no-response-dialog.tsx` (the latter also takes `leadId`).

**Step 3: Browser check.** With the stubs in place, the action bar should render three empty slots + separators. Clicking does nothing (expected). The guardrail branches (already-completed, opp-terminal) should render their alerts correctly — test by temporarily hardcoding `disabled={true}` on the client shell.

**Key implementation notes:**
- **`dynamic()` lands the dialog code only on click.** The initial bundle stays lean. Matches the meeting bar's behaviour.
- **`[&_button]:w-full`.** Tailwind descendant selector forces every nested button to full width; keeps the bar visually consistent across the three dialogs' trigger buttons.
- **`<Separator />` between payment and the other two.** Matches the meeting detail action bar's visual hierarchy ("the desirable outcome on top, the other outcomes below").
- **Do NOT call mutations here.** The action bar is a dumb router; mutations live inside dialogs.
- **Do NOT pass `opportunity` into dialogs.** Each dialog only needs `followUpId` (and, in one case, `leadId`). The action bar is the single place that reads `opportunity.status` for guardrails; the mutations re-validate server-side anyway.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-outcome-action-bar.tsx` | Modify | Replace 4B stub with real action bar. |

---

### 5B — `ReminderPaymentDialog`

**Type:** Frontend
**Parallelizable:** Yes — independent file. 5A just imports it dynamically.

**What:** The "log payment from reminder" dialog. Mirrors `PaymentFormDialog` from the meeting detail page but calls `api.closer.reminderOutcomes.logReminderPayment` and drops the `meetingId` arg (server resolves it).

**Why:** Same reason Phase 3B exists — the happy path deserves first-class treatment. Cloning the meeting dialog keeps the UX identical, so a closer who knows one knows both.

**Where:**
- `app/workspace/closer/reminders/[followUpId]/_components/reminder-payment-dialog.tsx` (modify the 5A stub)

**How:**

**Step 1: Replace the stub. Share the Zod schema shape with the meeting payment dialog where possible — copy now, extract to `lib/schemas/` later if needed (design doc §8.3 rationale).**

```tsx
// Path: app/workspace/closer/reminders/[followUpId]/_components/reminder-payment-dialog.tsx
"use client";

import { useEffect, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { CheckCircle2Icon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";

const MAX_FILE_MB = 10;
const ALLOWED_MIME = ["image/png", "image/jpeg", "image/webp", "application/pdf"];

const paymentSchema = z
  .object({
    amount: z.coerce
      .number({ message: "Amount is required" })
      .positive("Amount must be positive"),
    currency: z.enum(["USD", "EUR", "GBP", "CAD", "AUD"]),
    provider: z.string().trim().min(1, "Provider is required"),
    referenceCode: z.string().trim().max(120).optional(),
    proofFile: z.instanceof(File).optional(),
  })
  .refine(
    (v) => !v.proofFile || v.proofFile.size <= MAX_FILE_MB * 1024 * 1024,
    { path: ["proofFile"], message: `Max file size ${MAX_FILE_MB}MB` },
  )
  .refine(
    (v) => !v.proofFile || ALLOWED_MIME.includes(v.proofFile.type),
    { path: ["proofFile"], message: "File must be PNG, JPEG, WEBP, or PDF" },
  );

type Values = z.infer<typeof paymentSchema>;

export function ReminderPaymentDialog({
  followUpId,
  onSuccess,
}: {
  followUpId: Id<"followUps">;
  onSuccess: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const generateUploadUrl = useAction(api.closer.payments.generateUploadUrl);
  const logReminderPayment = useMutation(
    api.closer.reminderOutcomes.logReminderPayment,
  );

  const form = useForm({
    resolver: standardSchemaResolver(paymentSchema),
    defaultValues: {
      amount: undefined as unknown as number, // RHF-friendly "empty number"
      currency: "USD",
      provider: "",
      referenceCode: "",
      proofFile: undefined as File | undefined,
    },
  });

  // Reset form whenever the dialog closes — matches meeting payment dialog.
  useEffect(() => {
    if (!open) form.reset();
  }, [open, form]);

  const onSubmit = async (vals: Values) => {
    setSubmitting(true);
    try {
      let proofFileId: Id<"_storage"> | undefined;
      if (vals.proofFile) {
        // generateUploadUrl returns a short-lived URL — AGENTS.md §Convex
        // webhook/upload pattern. No token bleeding across tenants.
        const uploadUrl = await generateUploadUrl({});
        const res = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": vals.proofFile.type },
          body: vals.proofFile,
        });
        if (!res.ok) throw new Error("Upload failed. Try again.");
        const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
        proofFileId = storageId;
      }

      const paymentId = await logReminderPayment({
        followUpId,
        amount: vals.amount,
        currency: vals.currency,
        provider: vals.provider,
        referenceCode: vals.referenceCode || undefined,
        proofFileId,
      });

      posthog.capture("reminder_outcome_payment", {
        follow_up_id: followUpId,
        payment_id: paymentId,
        amount: vals.amount,
        currency: vals.currency,
        provider: vals.provider,
        has_proof: Boolean(proofFileId),
      });

      toast.success("Payment recorded");
      setOpen(false);
      onSuccess();
    } catch (err) {
      posthog.captureException(err);
      toast.error(err instanceof Error ? err.message : "Failed to record payment");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !submitting && setOpen(v)}>
      <DialogTrigger asChild>
        <Button>
          <CheckCircle2Icon data-icon="inline-start" />
          Log Payment
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Log payment</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-4"
          >
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
                      inputMode="decimal"
                      disabled={submitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

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
                    disabled={submitting}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {["USD", "EUR", "GBP", "CAD", "AUD"].map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="provider"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Provider <span className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Stripe, Teya, Wire transfer…"
                      disabled={submitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="referenceCode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reference code (optional)</FormLabel>
                  <FormControl>
                    <Input disabled={submitting} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="proofFile"
              render={({ field: { value, onChange, ...rest } }) => (
                <FormItem>
                  <FormLabel>Proof (optional — PNG, JPEG, WEBP, PDF ≤10MB)</FormLabel>
                  <FormControl>
                    <Input
                      type="file"
                      accept={ALLOWED_MIME.join(",")}
                      disabled={submitting}
                      onChange={(e) => onChange(e.target.files?.[0] ?? undefined)}
                      {...rest}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={submitting}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Saving…
                  </>
                ) : (
                  "Save"
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

**Step 2: Hand-test the whole flow.** Pick a pending reminder, open the dialog, fill out the form, attach a tiny PDF, submit. Confirm:
- Dialog closes, toast says "Payment recorded".
- Dashboard reminder count drops by one.
- Convex dashboard shows a new `paymentRecords` row with the correct `origin` metadata.

**Step 3: Negative tests.**
- Submit with amount `0` → inline error "Amount must be positive".
- Submit a 20MB PDF → inline error "Max file size 10MB".
- Simulate a network failure mid-upload (DevTools → Network → offline) → `toast.error("Upload failed. Try again.")`; the dialog remains open with form state preserved.

**Key implementation notes:**
- **`standardSchemaResolver` not `zodResolver`.** AGENTS.md §Form Patterns rule — do not deviate; type overloads will mismatch otherwise.
- **`z.coerce.number()`.** `<input type="number">` emits strings; coercion beats manual `parseFloat`.
- **`onOpenChange` guarded by `!submitting`.** Prevents the user from dismissing mid-submit and missing the result toast.
- **`proofFile` passed as `undefined` instead of `null`.** RHF's form state is happier with `undefined`; the refine passes if the file is absent.
- **`posthog.captureException(err)`.** Every error goes to PostHog so we can see real failure rates once deployed.
- **Upload URL is short-lived.** The existing `generateUploadUrl` action handles the tenant scoping; we do not pass `tenantId` here.
- **Default `currency: "USD"`.** Change if the tenant has a preferred currency in settings (future enhancement); MVP keeps it static.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-payment-dialog.tsx` | Modify | Replace 5A stub with the full dialog. |

---

### 5C — `ReminderMarkLostDialog`

**Type:** Frontend
**Parallelizable:** Yes — independent file.

**What:** An `AlertDialog` that confirms "mark as lost" and accepts an optional reason (max 500 chars). Calls `api.closer.reminderOutcomes.markReminderLost`.

**Why:** Smallest possible dialog surface. AlertDialog conveys the weight of a terminal action ("are you sure?"). Matches the meeting `MarkLostDialog` pattern for consistency.

**Where:**
- `app/workspace/closer/reminders/[followUpId]/_components/reminder-mark-lost-dialog.tsx` (modify the 5A stub)

**How:**

**Step 1: Replace the stub.**

```tsx
// Path: app/workspace/closer/reminders/[followUpId]/_components/reminder-mark-lost-dialog.tsx
"use client";

import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { XCircleIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";

const schema = z.object({
  reason: z.string().max(500, "Keep it under 500 characters").optional(),
});
type Values = z.infer<typeof schema>;

export function ReminderMarkLostDialog({
  followUpId,
  onSuccess,
}: {
  followUpId: Id<"followUps">;
  onSuccess: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const markLost = useMutation(api.closer.reminderOutcomes.markReminderLost);

  const form = useForm({
    resolver: standardSchemaResolver(schema),
    defaultValues: { reason: "" },
  });

  useEffect(() => {
    if (!open) form.reset();
  }, [open, form]);

  const onSubmit = async (vals: Values) => {
    setSubmitting(true);
    try {
      await markLost({
        followUpId,
        reason: vals.reason?.trim() || undefined,
      });
      posthog.capture("reminder_outcome_lost", {
        follow_up_id: followUpId,
        has_reason: Boolean(vals.reason?.trim()),
      });
      toast.success("Opportunity marked lost");
      setOpen(false);
      onSuccess();
    } catch (err) {
      posthog.captureException(err);
      toast.error(err instanceof Error ? err.message : "Failed to mark lost");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(v) => !submitting && setOpen(v)}>
      <AlertDialogTrigger asChild>
        <Button variant="outline">
          <XCircleIcon data-icon="inline-start" />
          Mark as Lost
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Mark this opportunity as lost?</AlertDialogTitle>
          <AlertDialogDescription>
            The opportunity will transition to <b>lost</b> and the reminder will
            be completed. You can add an optional reason.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-3"
          >
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason (optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={3}
                      placeholder="e.g., Went with a competitor"
                      disabled={submitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <AlertDialogFooter>
              <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
              <AlertDialogAction asChild>
                <Button type="submit" variant="destructive" disabled={submitting}>
                  {submitting ? (
                    <>
                      <Spinner data-icon="inline-start" />
                      Saving…
                    </>
                  ) : (
                    "Mark as Lost"
                  )}
                </Button>
              </AlertDialogAction>
            </AlertDialogFooter>
          </form>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

**Step 2: Hand-test.** Open dialog, add reason, confirm. Check:
- Toast says "Opportunity marked lost".
- Dashboard reminder drops.
- `opportunities.<id>.lostReason` matches the submitted text.

**Key implementation notes:**
- **`AlertDialog` not `Dialog`.** The terminal nature of the action deserves the sterner confirmation UX.
- **`variant="destructive"` on the primary button.** Reinforces the negative outcome visually.
- **`AlertDialogAction asChild`.** Allows us to nest our own `<Button type="submit">` so the submit ties into RHF's handleSubmit. Without `asChild` the AlertDialogAction would close the dialog before the submit fires.
- **Reason is optional.** Do not force closers to justify a lost deal; they have the note field if they want.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-mark-lost-dialog.tsx` | Modify | Replace 5A stub with the full AlertDialog. |

---

### 5D — `ReminderNoResponseDialog`

**Type:** Frontend
**Parallelizable:** Yes — independent file.

**What:** The three-way dialog. Radio group with `schedule_new` / `give_up` / `close_only`. Conditional fields for `schedule_new` (contact method, new time, optional note). Optional note field for all three. Calls `api.closer.reminderOutcomes.markReminderNoResponse`.

**Why:** The most UI-heavy dialog because it carries three distinct paths. Every reminder that doesn't close in a sale or a hard loss lands here, so polish matters disproportionately.

**Where:**
- `app/workspace/closer/reminders/[followUpId]/_components/reminder-no-response-dialog.tsx` (modify the 5A stub)

**How:**

**Step 1: Replace the stub.** Use `superRefine` to conditionally require `newReminderAt` and `newContactMethod` only when `nextStep === "schedule_new"`.

```tsx
// Path: app/workspace/closer/reminders/[followUpId]/_components/reminder-no-response-dialog.tsx
"use client";

import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { PhoneOffIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";

const schema = z
  .object({
    nextStep: z.enum(["schedule_new", "give_up", "close_only"]),
    note: z.string().max(500).optional(),
    newReminderAt: z.string().optional(),
    newContactMethod: z.enum(["call", "text"]).optional(),
    newReminderNote: z.string().max(500).optional(),
  })
  .superRefine((vals, ctx) => {
    if (vals.nextStep !== "schedule_new") return;
    if (!vals.newReminderAt) {
      ctx.addIssue({
        code: "custom",
        path: ["newReminderAt"],
        message: "Pick a new reminder time",
      });
    } else if (new Date(vals.newReminderAt).getTime() <= Date.now()) {
      ctx.addIssue({
        code: "custom",
        path: ["newReminderAt"],
        message: "Time must be in the future",
      });
    }
    if (!vals.newContactMethod) {
      ctx.addIssue({
        code: "custom",
        path: ["newContactMethod"],
        message: "Pick call or text",
      });
    }
  });
type Values = z.infer<typeof schema>;

export function ReminderNoResponseDialog({
  followUpId,
  onSuccess,
}: {
  followUpId: Id<"followUps">;
  leadId: Id<"leads">; // accepted for future features; not used yet
  onSuccess: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const markNoResponse = useMutation(
    api.closer.reminderOutcomes.markReminderNoResponse,
  );

  const form = useForm({
    resolver: standardSchemaResolver(schema),
    defaultValues: {
      nextStep: "schedule_new" as const,
      note: "",
      newContactMethod: "call" as const,
      newReminderAt: "",
      newReminderNote: "",
    },
  });
  const step = form.watch("nextStep");

  useEffect(() => {
    if (!open) form.reset();
  }, [open, form]);

  const onSubmit = async (vals: Values) => {
    setSubmitting(true);
    try {
      await markNoResponse({
        followUpId,
        nextStep: vals.nextStep,
        note: vals.note?.trim() || undefined,
        newReminder:
          vals.nextStep === "schedule_new"
            ? {
                contactMethod: vals.newContactMethod!,
                reminderScheduledAt: new Date(vals.newReminderAt!).getTime(),
                reminderNote: vals.newReminderNote?.trim() || undefined,
              }
            : undefined,
      });
      posthog.capture("reminder_outcome_no_response", {
        follow_up_id: followUpId,
        next_step: vals.nextStep,
        has_note: Boolean(vals.note?.trim()),
      });
      toast.success(
        vals.nextStep === "schedule_new"
          ? "New reminder scheduled"
          : vals.nextStep === "give_up"
            ? "Opportunity marked lost"
            : "Reminder closed",
      );
      setOpen(false);
      onSuccess();
    } catch (err) {
      posthog.captureException(err);
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !submitting && setOpen(v)}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <PhoneOffIcon data-icon="inline-start" />
          No Response
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>No response — what next?</DialogTitle>
          <DialogDescription>
            Pick what to do with this reminder and the underlying opportunity.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-4"
          >
            <FormField
              control={form.control}
              name="nextStep"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Choose a next step</FormLabel>
                  <FormControl>
                    <RadioGroup
                      value={field.value}
                      onValueChange={field.onChange}
                      className="flex flex-col gap-2"
                    >
                      <label className="flex items-start gap-2 cursor-pointer">
                        <RadioGroupItem value="schedule_new" className="mt-0.5" />
                        <div>
                          <div className="font-medium">Try again — schedule a new reminder</div>
                          <div className="text-muted-foreground text-xs">
                            Keeps the opportunity alive. Creates a fresh reminder.
                          </div>
                        </div>
                      </label>
                      <label className="flex items-start gap-2 cursor-pointer">
                        <RadioGroupItem value="give_up" className="mt-0.5" />
                        <div>
                          <div className="font-medium">Give up — mark lost</div>
                          <div className="text-muted-foreground text-xs">
                            Transitions the opportunity to lost.
                          </div>
                        </div>
                      </label>
                      <label className="flex items-start gap-2 cursor-pointer">
                        <RadioGroupItem value="close_only" className="mt-0.5" />
                        <div>
                          <div className="font-medium">Close this reminder only</div>
                          <div className="text-muted-foreground text-xs">
                            Decide later. Opportunity stays untouched.
                          </div>
                        </div>
                      </label>
                    </RadioGroup>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {step === "schedule_new" && (
              <div className="flex flex-col gap-3 rounded-lg border p-3">
                <FormField
                  control={form.control}
                  name="newContactMethod"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        How? <span className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <RadioGroup
                          value={field.value ?? "call"}
                          onValueChange={field.onChange}
                          className="flex gap-4"
                        >
                          <label className="flex items-center gap-1 cursor-pointer">
                            <RadioGroupItem value="call" />
                            <span>Call</span>
                          </label>
                          <label className="flex items-center gap-1 cursor-pointer">
                            <RadioGroupItem value="text" />
                            <span>Text</span>
                          </label>
                        </RadioGroup>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="newReminderAt"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        New reminder time <span className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="datetime-local"
                          disabled={submitting}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="newReminderNote"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Note for next time (optional)</FormLabel>
                      <FormControl>
                        <Textarea rows={2} disabled={submitting} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}

            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {step === "give_up" ? "Reason (optional)" : "Note (optional)"}
                  </FormLabel>
                  <FormControl>
                    <Textarea rows={3} disabled={submitting} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={submitting}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Saving…
                  </>
                ) : (
                  "Save"
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

**Step 2: Hand-test all three branches.**
- `schedule_new`: pick a time in the future, submit. A second reminder should appear on the dashboard.
- `give_up`: submit. Opportunity transitions to `lost`.
- `close_only`: submit. Opportunity status unchanged; reminder removed.

**Step 3: Negative tests.**
- Pick `schedule_new`, leave the time blank → inline error on the time field.
- Pick `schedule_new`, set time to 10 minutes ago → inline error "Time must be in the future".

**Key implementation notes:**
- **`superRefine` targets errors to specific paths.** `path: ["newReminderAt"]` makes the error render under the time field, not as a generic form-level error — AGENTS.md form pattern rule.
- **`step === "schedule_new"` reveals the conditional block.** The conditional fields carry default values even when hidden; `superRefine` skips validation when `nextStep` is something else.
- **Radio items wrapped in `<label>`.** Clicking the label toggles the radio (native HTML behaviour). Accessibility win.
- **`rounded-lg border p-3` wrapper around conditional fields.** Visually groups "schedule new reminder" sub-form to distinguish it from the note field below.
- **`leadId` arg kept for future features.** The design doc hints at "pre-fill the new reminder's note from the lead's last contact record" — keep the prop so Phase 2 (the deferred admin version) can use it.
- **`datetime-local` input.** Native browser picker; we accept UX tradeoffs (no timezone selection) for MVP — all values are treated as the closer's local time and converted to UTC via `.getTime()`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-no-response-dialog.tsx` | Modify | Replace 5A stub with the three-branch dialog. |

---

### 5E — PostHog events

**Type:** Frontend / Instrumentation
**Parallelizable:** No within Phase 5 (touches all three dialog files); Parallelizable with Phase 6's 6A/6B.

**What:** Ensure each of the three dialog submission handlers emits the right PostHog event with consistent property naming, and add a single feature flag guard if we want to gate the whole feature in production.

**Why:** Product analytics need to answer "what fraction of reminders end in a sale?" Without instrumentation we are shipping blind. Consolidating in one subphase prevents drift between dialogs (e.g., one dialog using snake_case, another using camelCase).

**Where:**
- `app/workspace/closer/reminders/[followUpId]/_components/reminder-payment-dialog.tsx` (modify — 5B included the call; verify here)
- `app/workspace/closer/reminders/[followUpId]/_components/reminder-mark-lost-dialog.tsx` (modify — 5C included the call; verify here)
- `app/workspace/closer/reminders/[followUpId]/_components/reminder-no-response-dialog.tsx` (modify — 5D included the call; verify here)

**How:**

**Step 1: Audit the three event names and property shapes.** Verify they match:

```typescript
// Payment dialog (5B)
posthog.capture("reminder_outcome_payment", {
  follow_up_id: followUpId,
  payment_id: paymentId,
  amount: vals.amount,
  currency: vals.currency,
  provider: vals.provider,
  has_proof: Boolean(proofFileId),
});

// Lost dialog (5C)
posthog.capture("reminder_outcome_lost", {
  follow_up_id: followUpId,
  has_reason: Boolean(vals.reason?.trim()),
});

// No-response dialog (5D)
posthog.capture("reminder_outcome_no_response", {
  follow_up_id: followUpId,
  next_step: vals.nextStep,
  has_note: Boolean(vals.note?.trim()),
});
```

**Step 2: Add a single landing-event when the reminder detail page mounts.** One event for "closer opened this reminder page" lets PostHog build funnels cleanly.

```tsx
// Path: app/workspace/closer/reminders/[followUpId]/_components/reminder-detail-page-client.tsx
// Add near the top of the component body, after `usePageTitle`:

import { useEffect } from "react";
import posthog from "posthog-js";

// ...
useEffect(() => {
  if (detail) {
    posthog.capture("reminder_page_opened", {
      follow_up_id: detail.followUp._id,
      opportunity_id: detail.opportunity._id,
      opportunity_status: detail.opportunity.status,
      contact_method: detail.followUp.contactMethod,
      has_phone: Boolean(detail.lead.phone),
    });
  }
  // Run once per mount; dependencies excluded on purpose.
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

**Step 3: Confirm events flow end-to-end.** Open the dialog, submit, and watch the PostHog Live Events feed in the PostHog dashboard. The four events (`reminder_page_opened`, plus one of the three outcomes) should arrive within seconds of submission.

**Step 4: (Optional) add a GrowthBook / feature flag gate.** Keep this gate disabled for MVP — all closers get the feature — but scaffold the hook so a kill switch exists if issues arise:

```tsx
// Path: app/workspace/closer/reminders/[followUpId]/_components/reminder-detail-page-client.tsx
// At the top of ReminderDetailPageClient, before the null guard:

// Flag stub: always true. Wire through GrowthBook later if needed.
const REMINDER_OUTCOMES_ENABLED = true;
if (!REMINDER_OUTCOMES_ENABLED) {
  return null; // Feature disabled — dashboard will simply not navigate.
}
```

This is a placeholder; real flagging would use the existing GrowthBook integration if the project has one, or PostHog feature flags (`posthog.isFeatureEnabled("reminder-outcomes")`).

**Key implementation notes:**
- **Event names use `reminder_outcome_<outcome>` consistently.** PostHog cleans up easier when the taxonomy is predictable. Do not ship events under names like `payment_recorded_from_reminder` — the prefix should be the feature, not the action.
- **Property names in snake_case.** PostHog's convention; matches every existing event in the repo.
- **Do NOT log PII.** No `lead_phone`, no `lead_email`, no `lead_name`. Use booleans (`has_phone`) or ids.
- **`has_proof` / `has_reason` / `has_note` booleans.** Let analytics answer "how often do closers bother to attach proof?" without exposing the actual text.
- **Wrap captures in try/catch is NOT necessary.** PostHog's client is resilient; failures are silent and logged to the browser console.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-payment-dialog.tsx` | Modify | Verify event shape from 5B. |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-mark-lost-dialog.tsx` | Modify | Verify event shape from 5C. |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-no-response-dialog.tsx` | Modify | Verify event shape from 5D. |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-detail-page-client.tsx` | Modify | Add `reminder_page_opened` mount-once event + (optional) feature flag guard. |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-outcome-action-bar.tsx` | Modify | 5A |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-payment-dialog.tsx` | Modify | 5B |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-mark-lost-dialog.tsx` | Modify | 5C |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-no-response-dialog.tsx` | Modify | 5D |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-detail-page-client.tsx` | Modify | 5E |
