# Phase 2 — Payment Form Dialog Migration

**Goal:** Migrate the Payment Form Dialog (`payment-form-dialog.tsx`) from 8 `useState` hooks + manual validation to React Hook Form + Zod with inline field-level errors. This dialog is the most complex form in the codebase (multi-step file upload, Convex storage integration, cross-field validation), so completing it proves the pattern works and unblocks subsequent simpler dialogs.

**Prerequisite:** Phase 1 complete (packages installed, form component added, next.config.ts updated).

**Runs in PARALLEL with:** Nothing — this is the reference implementation. Subsequent dialogs are simpler and can be done independently once this completes.

**Skills to invoke:**
- `vercel-react-best-practices` — Verify that RHF's uncontrolled pattern doesn't conflict with Convex's reactive subscriptions; ensure minimal re-renders.
- `web-design-guidelines` — Verify WCAG compliance of inline error messages: color contrast, `aria-invalid`, `aria-describedby` associations, focus management.
- `expect` — Browser-based verification of inline errors rendering, file upload working, accessibility passing.

**Acceptance Criteria:**
1. All 8 `useState` hooks in the payment dialog are replaced with 1 `useForm` hook and 2 remaining `useState` hooks (`open`, `isSubmitting`). A third `submitError` state is added for submission-level errors. No new state variables beyond these 3.
2. `paymentFormSchema` Zod schema is defined co-located in the dialog file, validating: `amount` (required, positive number), `currency` (enum), `provider` (enum), `referenceCode` (optional), `proofFile` (optional, max 10 MB, valid file types).
3. All 5 form fields render via `<FormField>` + `<FormItem>` + `<FormLabel>` + `<FormControl>` + `<FormMessage>`, with no manual error checking in `handleSubmit`.
4. File upload validation (size, type) is in the Zod schema via `.refine()`, and file errors appear inline via `<FormMessage>` (not via `<Alert>`).
5. Submission-level errors (network, Convex mutation failures) display in an `<Alert variant="destructive">` above the submit button (existing pattern, unchanged).
6. On successful submission: `setOpen(false)`, `form.reset()`, toast success, PostHog event capture, `onSuccess()` callback, `router.refresh()`.
7. Dialog close button and cancel button are disabled during submission (`disabled={isSubmitting}`).
8. Inline error messages appear below each invalid field when validation fails (form.handleSubmit does not call onSubmit if validation fails).
9. All existing functionality is preserved: amount/currency/provider parsing, file upload two-step flow (generateUploadUrl → fetch → storageId), conditional storageId assignment.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (Zod schema) ──→ 2B (useForm hook) ──→ 2C (Rewrite JSX) ──→ 2D (Verify & test)
```

**Optimal execution:**
1. Start 2A — define the Zod schema
2. Once 2A completes → start 2B — set up useForm and submission handler
3. Once 2B completes → start 2C — rewrite JSX with Form* components
4. Once 2C completes → start 2D — run expect verification and accessibility audit

**Estimated time:** 3–4 hours

---

## Subphases

### 2A — Define Zod Schema

**Type:** Frontend
**Parallelizable:** No — all other subphases depend on the schema being defined.

**What:** Define `paymentFormSchema` as a Zod object with fields for amount, currency, provider, reference code, and proof file. Include validation rules and cross-field constraints.

**Why:** The schema is the single source of truth for form validation rules. It drives RHF's behavior, produces type-safe `PaymentFormValues`, and ensures consistent validation between browser and server.

**Where:**
- `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` (modify)

**How:**

**Step 1: Add imports at the top of the file**

```typescript
// Path: app/workspace/closer/meetings/_components/payment-form-dialog.tsx

"use client";

import { z } from "zod";
```

**Step 2: Define constants for validation**

```typescript
// Path: app/workspace/closer/meetings/_components/payment-form-dialog.tsx

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const VALID_FILE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "application/pdf",
];

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"] as const;
const PROVIDERS = [
  "Stripe",
  "PayPal",
  "Square",
  "Cash",
  "Bank Transfer",
  "Other",
] as const;
```

**Step 3: Define the Zod schema**

```typescript
// Path: app/workspace/closer/meetings/_components/payment-form-dialog.tsx

const paymentFormSchema = z.object({
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
  currency: z.enum(CURRENCIES, {
    required_error: "Please select a currency",
  }),
  provider: z.enum(PROVIDERS, {
    required_error: "Please select a payment provider",
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

type PaymentFormValues = z.infer<typeof paymentFormSchema>;
```

**Step 4: Verify types**

```bash
# Path: project root
pnpm tsc --noEmit
```

No type errors. The `z.infer<>` should produce a type with the correct shape.

**Key implementation notes:**
- `amount` is `z.string()` (not `z.number()`) because HTML `<input type="number">` returns a string via `e.target.value`. The `.refine()` manually parses and validates it's a positive number, giving a clear error message.
- `currency` and `provider` are `z.enum()` — Zod infers the union type directly from the const arrays.
- `proofFile` is `z.instanceof(File).optional()` — Zod validates the actual File object (not just a filename string). The two `.refine()` calls check size and type.
- `referenceCode` is optional (no validation beyond "it's a string").
- The schema coexists in the same file as the dialog component — no extraction to a shared lib (per the design doc's decision to co-locate for now).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` | Modify | Add Zod schema and constants |

---

### 2B — Set Up useForm Hook and Submission Handler

**Type:** Frontend
**Parallelizable:** No — depends on 2A (schema must be defined first).

**What:** Import `useForm` and `zodResolver`, initialize the form hook with the schema and default values, and rewrite the `onSubmit` handler to work with RHF's `form.handleSubmit()`. Keep `isSubmitting` and `submitError` state for submission-level error handling and loading UI.

**Why:** The `useForm` hook manages all field values, validation state, and submission. RHF's `form.handleSubmit()` wraps the submission handler to prevent `onSubmit` from running if validation fails — replacing the current `if/else` checks.

**Where:**
- `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` (modify)

**How:**

**Step 1: Add imports**

```typescript
// Path: app/workspace/closer/meetings/_components/payment-form-dialog.tsx

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
```

**Step 2: Replace useState hooks with useForm**

Find the existing function component and replace the 8 `useState` hooks with:

```typescript
// Path: app/workspace/closer/meetings/_components/payment-form-dialog.tsx

export function PaymentFormDialog({
  opportunityId,
  meetingId,
  onSuccess,
}: PaymentFormDialogProps) {
  // Keep dialog state and submission error state
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Initialize the form
  const form = useForm<PaymentFormValues>({
    resolver: zodResolver(paymentFormSchema),
    defaultValues: {
      amount: "",
      currency: "USD",
      provider: undefined,
      referenceCode: "",
      proofFile: undefined,
    },
  });

  // Convex mutations (existing, unchanged)
  const generateUploadUrl = useMutation(api.closer.payments.generateUploadUrl);
  const logPayment = useMutation(api.closer.payments.logPayment);

  // ... rest of component
}
```

**Remove the old 8 useState hooks** (look for lines like `const [amount, setAmount] = useState("")`, etc.). Replace all of them with the single `useForm` hook above.

**Step 3: Rewrite the submission handler**

```typescript
// Path: app/workspace/closer/meetings/_components/payment-form-dialog.tsx

const onSubmit = async (values: PaymentFormValues) => {
  setIsSubmitting(true);
  setSubmitError(null);

  try {
    // Upload proof file if provided
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

    // Log the payment
    const parsedAmount = parseFloat(values.amount);
    await logPayment({
      opportunityId,
      meetingId,
      amount: parsedAmount,
      currency: values.currency,
      provider: values.provider,
      referenceCode: values.referenceCode || undefined,
      proofFileId,
    });

    // Success path (unchanged from existing)
    await onSuccess?.();
    posthog.capture("payment_logged", {
      opportunity_id: opportunityId,
      meeting_id: meetingId,
      amount: parsedAmount,
      currency: values.currency,
      provider: values.provider,
      has_reference_code: Boolean(values.referenceCode),
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

**Key differences from the old code:**
- `onSubmit` now receives `values: PaymentFormValues` (pre-validated by Zod) instead of extracting from individual `useState` hooks.
- No validation checks (`if (!amount)`, etc.) — Zod ran first, so validation is guaranteed.
- File upload and Convex mutation code is identical; only the state and value sourcing changed.
- Error handling is the same: `try/catch` → `setSubmitError` → display in `<Alert>` + toast.

**Step 4: Verify types**

```bash
# Path: project root
pnpm tsc --noEmit
```

No type errors. The `values` parameter should be correctly typed as `PaymentFormValues`.

**Key implementation notes:**
- RHF's `form.handleSubmit(onSubmit)` is a wrapper that intercepts form submission, runs Zod validation, and **only calls `onSubmit` if validation passes**.
- If validation fails, `onSubmit` is never called — RHF automatically populates error state for each field, which `<FormMessage>` reads and displays.
- `isSubmitting` flag prevents double-submissions and disables buttons/inputs during the async file upload and Convex mutation.
- `submitError` is for runtime errors (network, Convex failures) — distinct from validation errors which are displayed inline.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` | Modify | Add useForm hook, rewrite onSubmit |

---

### 2C — Rewrite JSX with Form Components

**Type:** Frontend
**Parallelizable:** No — depends on 2B (form hook must be set up first).

**What:** Replace all `<Field>` + manual error handling with `<Form>`, `<FormField>`, `<FormItem>`, `<FormLabel>`, `<FormControl>`, and `<FormMessage>`. Wrap the form in `<Form {...form}>` and each field in `<FormField control={form.control} name={...}>`. Move file upload validation into the Zod schema.

**Why:** The shadcn Form components integrate with RHF and automatically display errors. This eliminates manual error UI code and makes the template cleaner.

**Where:**
- `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` (modify)

**How:**

**Step 1: Add form import**

```typescript
// Path: app/workspace/closer/meetings/_components/payment-form-dialog.tsx

import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage, FormDescription } from "@/components/ui/form";
```

**Step 2: Wrap the form in <Form> and replace each field**

Replace the existing JSX inside the `<DialogContent>` with this structure:

```tsx
// Path: app/workspace/closer/meetings/_components/payment-form-dialog.tsx

return (
  <Dialog open={open} onOpenChange={(value) => {
    if (!isSubmitting) {
      setOpen(value);
      if (!value) form.reset();
    }
  }}>
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
          Record a payment to close this opportunity.
        </DialogDescription>
      </DialogHeader>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)}>
          <FieldGroup>
            {/* Amount Field */}
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

            {/* Currency Field */}
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
                    defaultValue={field.value}
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

            {/* Provider Field */}
            <FormField
              control={form.control}
              name="provider"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Provider <span className="text-destructive">*</span>
                  </FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    defaultValue={field.value}
                    disabled={isSubmitting}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select provider" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectGroup>
                        {PROVIDERS.map((prov) => (
                          <SelectItem key={prov} value={prov}>
                            {prov}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Reference Code Field */}
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

            {/* Proof File Field */}
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

          {/* Submission-level error */}
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
              onClick={() => {
                setOpen(false);
                form.reset();
              }}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Spinner data-icon="inline-start" />
                  Logging...
                </>
              ) : (
                "Log Payment"
              )}
            </Button>
          </DialogFooter>
        </form>
      </Form>
    </DialogContent>
  </Dialog>
);
```

**Key changes:**
- `<Form {...form}>` wraps the entire form — provides RHF context to child `<FormField>` components.
- Each field is now a `<FormField>` that connects to the form state via `control={form.control}` and `name="fieldName"`.
- `<FormMessage />` automatically reads the field's error state and renders it — no manual `{amount.error ? <Alert>...` checks.
- File input special handling: destructure `{ value, onChange }` separately because file inputs can't have values set programmatically (security restriction).
- `<FieldGroup>` still wraps multiple fields as a layout container — it's CSS-only and has no form logic.
- `form.handleSubmit(onSubmit)` replaces the old `handleSubmit` function that manually checked for validation.

**Step 3: Verify the form renders**

```bash
# Path: project root
pnpm build
pnpm tsc --noEmit
```

No errors. The component should compile correctly.

**Key implementation notes:**
- The `onOpenChange` handler now checks `!isSubmitting` to prevent closing during submission (see design doc section 13.6).
- File input validation is 100% in the Zod schema (size, type) — no custom `handleFileChange` function needed.
- Inline errors (from `<FormMessage />`) are separate from submission errors (from `<Alert>`).
- The submit button shows a spinner and changes text during submission (existing pattern, preserved).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` | Modify | Replace all JSX with Form* components |

---

### 2D — Browser Verification and Accessibility Audit

**Type:** QA / Testing
**Parallelizable:** No — depends on 2C (JSX must be rewritten first).

**What:** Launch the application in a real browser, test the payment form's inline errors, file upload, submission flow, and accessibility. Use the expect skill to capture evidence of working functionality.

**Why:** RHF and Zod are new to the codebase. Real browser testing confirms the integration works, errors display correctly, and no regressions were introduced. Accessibility audit ensures `aria-invalid`, focus management, and color contrast meet WCAG standards.

**Where:**
- Browser (live app at `/workspace/closer/meetings/[meetingId]`)
- expect MCP tools

**How:**

**Step 1: Start the dev server**

```bash
# Path: project root
pnpm dev
```

Wait for the server to start (usually http://localhost:3000).

**Step 2: Navigate to a meeting detail page**

1. Sign in as a closer (or use a test tenant account with closer role).
2. Navigate to `/workspace/closer/[opportunityId]/meetings/[meetingId]` or find a meeting in the pipeline and open its detail.
3. Locate the "Log Payment" button and click it.
4. The payment form dialog should open.

**Step 3: Test inline validation**

1. Click the "Log Payment" submit button **without entering any data**.
2. Expected: Form does NOT submit. Red error text appears below each required field:
   - "Amount is required"
   - "Please select a currency"
   - "Please select a payment provider"
3. The first invalid field should receive focus automatically.
4. No toast or alert should appear (validation errors are inline only).

**Step 4: Test amount field validation**

1. Enter "0" in the amount field.
2. Click submit (or tab out of the field to trigger validation).
3. Expected: Error "Amount must be greater than 0" appears below the field.
4. Enter "299.99".
5. Expected: Error disappears.

**Step 5: Test file upload validation**

1. In the "Proof File" field, select a file larger than 10 MB.
2. Click submit or tab out.
3. Expected: Error "File size must be less than 10 MB" appears inline.
4. Select a file with an unsupported type (e.g., .txt, .doc).
5. Expected: Error "Only images (JPEG, PNG, GIF) and PDFs are allowed" appears.
6. Select a valid file (JPEG, PNG, GIF, or PDF under 10 MB).
7. Expected: Error disappears, file name and size are shown below the input.

**Step 6: Test successful submission**

1. Fill in all required fields with valid data:
   - Amount: 299.99
   - Currency: USD
   - Provider: Stripe
   - Reference Code: (optional — leave blank)
   - Proof File: (optional — leave blank or select a small PNG)
2. Click "Log Payment".
3. Expected:
   - Button shows a spinner and "Logging..." text.
   - Button is disabled.
   - Dialog stays open until submission completes.
   - On success: dialog closes, form resets, success toast appears.
   - If a file was uploaded, the Convex storage upload completes without error.
4. Verify the payment was recorded by checking the meeting detail page or dashboard (the payment record should appear).

**Step 7: Test submission error handling**

1. Reopen the payment form.
2. Fill in valid data.
3. Simulate a network error (DevTools → Network tab → throttle to "Offline").
4. Click "Log Payment".
5. Expected: After a timeout, an error alert appears above the submit button (red alert with error message).
6. A toast also appears (top of screen).
7. Form stays open with data preserved — user can correct or retry.

**Step 8: Accessibility audit**

Use the expect skill to run an accessibility audit:

```
invoke expect with: "Run accessibility audit on the payment form dialog (open it, check WCAG compliance)"
```

Expected results:
- Color contrast of error text (red) meets WCAG AA standards.
- All form inputs have `aria-invalid="true"` when an error is present.
- `<FormMessage>` is associated with the input via `aria-describedby` (RHF handles this automatically).
- Focus order is logical (tab through the form).
- Screen reader announces error messages when they appear.

**Step 9: Performance check**

Use the expect skill to measure Core Web Vitals while interacting with the form:

```
invoke expect with: "Measure performance metrics while opening, filling, and submitting the payment form"
```

Expected:
- INP (Input Latency) < 200ms when clicking buttons or typing in fields.
- No Long Animation Frames blocking interactions.
- Form is responsive and doesn't lag during file upload.

**Step 10: Verify no console errors**

1. Open DevTools (F12).
2. Go to the **Console** tab.
3. Interact with the payment form (open, fill fields, submit, close).
4. Expected: No red error messages or warnings in the console related to RHF, Zod, or Form components.
5. Expected: PostHog events fire (you may see network requests to PostHog in the Network tab).

**Key implementation notes:**
- All error messages should appear inline below the relevant field, not as toasts or alerts.
- Submission errors (network, Convex failures) are the only exceptions — these appear as alerts.
- The file input's file name display is conditional (`{value && <div>...`) — verify it appears after file selection and disappears after closing/resetting the dialog.
- The form should be fully keyboard-navigable — test with Tab, Shift+Tab, and Enter to submit.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| (none — testing/verification only) | — | Browser testing |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` | Modify | 2A (Zod schema), 2B (useForm), 2C (JSX) |

---

## Implementation Notes

### Handling File Inputs with RHF

File inputs are tricky because HTML prevents setting `value` programmatically (security). RHF provides two patterns:

**Pattern 1: Controlled via onChange only** (used here)
```tsx
render={({ field: { value, onChange, ...fieldProps } }) => (
  <Input
    type="file"
    onChange={(e) => {
      const file = e.target.files?.[0];
      onChange(file);
    }}
    {...fieldProps}
  />
)}
```

The `value` can be read (it's the File object), but not programmatically set. On `form.reset()`, the file input clears because `onChange` is not called — the browser's file input resets its internal state automatically.

**Pattern 2: Using setValue** (alternative)
```tsx
onChange={(e) => {
  form.setValue("proofFile", e.target.files?.[0]);
}}
```

Both work; we chose Pattern 1 because it's more consistent with other fields.

### Coexistence with FieldGroup

The `<FieldGroup>` component from `components/ui/field.tsx` is still used as a layout wrapper. It's CSS-only and has no form logic — it works perfectly inside RHF forms.

---

## Next Phase

Once Phase 2 is verified in the browser, proceed to **Phase 3: Invite User Dialog Migration**. The Invite User dialog is simpler (7 useState hooks, conditional Calendly member field) and tests the conditional validation pattern (`.superRefine()`).
