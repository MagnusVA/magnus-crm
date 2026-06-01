# Phase 2 QA — Payment Form Dialog Migration Verification

**Status:** Ready to run
**Prerequisite:** Phase 2 code changes complete (`payment-form-dialog.tsx` migrated to RHF + Zod).
**Skills to invoke:** `expect` (browser verification + accessibility audit)

---

## Pre-Flight Checks (Automated)

Run these before opening the browser:

```bash
# 1. TypeScript passes for our file
pnpm tsc --noEmit 2>&1 | grep "payment-form-dialog"
# Expected: no output (zero errors)

# 2. Build succeeds (Zod schema not accidentally imported by server component)
pnpm build
# Expected: no errors

# 3. Form component exists and exports all needed components
grep -c "export" components/ui/form.tsx
# Expected: exports include Form, FormField, FormItem, FormLabel, FormControl, FormMessage, FormDescription

# 4. No remaining Field/FieldLabel/FieldDescription imports from field.tsx in payment dialog
grep -E "import.*Field(Label|Description)" app/workspace/closer/meetings/_components/payment-form-dialog.tsx
# Expected: only FieldGroup import remains
```

---

## Browser Verification (via Expect MCP)

### Setup

1. Start the dev server: `pnpm dev`
2. Sign in as a **closer** (or test tenant account with closer role)
3. Navigate to a meeting detail page: `/workspace/closer/meetings/[meetingId]`
4. Locate the "Log Payment" button

---

### Test 1: Inline Validation — Empty Submit

**Steps:**
1. Click "Log Payment" button to open the dialog
2. Click the "Log Payment" submit button **without entering any data**

**Expected:**
- Form does NOT submit (no network requests)
- Red error text appears below each required field:
  - Amount: "Amount is required"
  - Currency: already has default "USD" — no error
  - Provider: "Please select a payment provider"
- No toast appears (validation errors are inline only)
- No `<Alert>` appears (that's for submission errors only)
- The first invalid field receives focus

---

### Test 2: Amount Field Validation

**Steps:**
1. Enter "0" in the Amount field
2. Click submit

**Expected:**
- Error "Amount must be greater than 0" appears below the Amount field
- Form does NOT submit

**Steps (continued):**
3. Clear and enter "-5"
4. Click submit

**Expected:**
- Same error "Amount must be greater than 0"

**Steps (continued):**
5. Clear and enter "299.99"

**Expected:**
- Amount error disappears

---

### Test 3: Provider Field Validation

**Steps:**
1. Fill in Amount: 299.99, leave Provider unselected
2. Click submit

**Expected:**
- Error "Please select a payment provider" appears below Provider
- Form does NOT submit

**Steps (continued):**
3. Select "Stripe" from the Provider dropdown

**Expected:**
- Provider error disappears

---

### Test 4: File Upload Validation — Size

**Steps:**
1. Fill all required fields with valid data
2. In the "Proof File" field, select a file **larger than 10 MB**
3. Click submit

**Expected:**
- Error "File size must be less than 10 MB" appears inline below the file input
- Form does NOT submit
- No `<Alert>` appears (error is inline via `<FormMessage>`, not the old `setError()` pattern)

---

### Test 5: File Upload Validation — Type

**Steps:**
1. Select a file with an unsupported type (e.g., `.txt`, `.doc`, `.mp4`)
2. Click submit

**Expected:**
- Error "Only images (JPEG, PNG, GIF) and PDFs are allowed" appears inline
- Form does NOT submit

---

### Test 6: Valid File Selection

**Steps:**
1. Select a valid file (JPEG, PNG, GIF, or PDF under 10 MB)

**Expected:**
- No error appears
- File name and size are shown below the input: `filename.png (123.4 KB)`
- Upload icon is visible next to the file info

---

### Test 7: Successful Submission

**Steps:**
1. Fill in all required fields with valid data:
   - Amount: 299.99
   - Currency: USD (default)
   - Provider: Stripe
   - Reference Code: (leave blank — optional)
   - Proof File: (leave blank or select a small PNG — optional)
2. Click "Log Payment"

**Expected:**
- Button shows spinner + "Logging..." text
- Button is disabled during submission
- Cancel button is disabled during submission
- Dialog cannot be closed (ESC / overlay click blocked) during submission
- On success:
  - Dialog closes
  - Form resets (reopening dialog shows empty fields, "USD" default, no provider selected)
  - Success toast appears: "Payment logged successfully"
- Payment record appears on the meeting detail page

---

### Test 8: Successful Submission with File Upload

**Steps:**
1. Same as Test 7 but also select a valid proof file (small PNG or PDF)
2. Click "Log Payment"

**Expected:**
- Same as Test 7, plus:
  - File uploads without error (check Network tab: POST to Convex storage URL returns 200)
  - The `storageId` is passed to the `logPayment` mutation
  - Payment record includes the proof file reference

---

### Test 9: Submission Error Handling

**Steps:**
1. Fill in valid data
2. Open DevTools > Network tab > throttle to "Offline"
3. Click "Log Payment"

**Expected:**
- After a timeout, a red `<Alert>` appears above the submit button with the error message
- A toast also appears at the top of the screen
- Form stays open with all data preserved
- User can correct or retry

**Steps (continued):**
4. Re-enable network
5. Click "Log Payment" again

**Expected:**
- The `<Alert>` error disappears when submission starts
- Submission succeeds

---

### Test 10: Dialog Cancel and Reset

**Steps:**
1. Fill in some fields (Amount: 100, Provider: PayPal, select a file)
2. Click "Cancel"

**Expected:**
- Dialog closes
- Reopen dialog → all fields are reset:
  - Amount: empty
  - Currency: USD (default)
  - Provider: empty (placeholder visible)
  - Reference Code: empty
  - Proof File: empty (no file selected, no file info shown)
  - No error messages visible
  - No `<Alert>` visible

---

### Test 11: Dialog Close via Overlay/ESC

**Steps:**
1. Open dialog, fill in some fields
2. Click outside the dialog (overlay) OR press ESC

**Expected:**
- Dialog closes
- Reopen dialog → all fields are reset (same as Test 10)

---

### Test 12: PostHog Event Capture

**Steps:**
1. Open DevTools > Network tab
2. Complete a successful payment submission
3. Filter network requests for PostHog (`/ingest/` or PostHog domain)

**Expected:**
- A `payment_logged` event is captured with properties:
  - `opportunity_id`: the current opportunity ID
  - `meeting_id`: the current meeting ID
  - `amount`: the parsed numeric amount (e.g., 299.99)
  - `currency`: "USD"
  - `provider`: "Stripe"
  - `has_reference_code`: false (or true if entered)
  - `has_proof_file`: false (or true if uploaded)

---

## Accessibility Audit

Use the `expect` skill to run a full accessibility audit:

```
Run accessibility audit on the payment form dialog
```

### Expected Results

| Check | Expected |
|---|---|
| **Color contrast** | Error text (`text-destructive`) meets WCAG AA (4.5:1 ratio) |
| **`aria-invalid`** | All form inputs have `aria-invalid="true"` when an error is present |
| **`aria-describedby`** | Each input is associated with its error message via `aria-describedby` (FormControl handles this) |
| **Focus order** | Tab through the form: Amount -> Currency trigger -> Provider trigger -> Reference Code -> Proof File -> Cancel -> Log Payment |
| **Focus on error** | After submitting with errors, focus moves to the first invalid field |
| **Screen reader** | Error messages are announced when they appear (via `aria-describedby` update) |
| **Keyboard submit** | Pressing Enter in any text input submits the form |

---

## Performance Verification

Use the `expect` skill:

```
Measure performance metrics while opening, filling, and submitting the payment form
```

### Expected Results

| Metric | Target |
|---|---|
| **INP** | < 200ms when clicking buttons or typing in fields |
| **No Long Animation Frames** | No blocking interactions during form interaction |
| **Form responsiveness** | No lag during file upload or field changes |
| **Re-renders** | Typing in one field does NOT re-render other fields (RHF uncontrolled) |

---

## Console Error Check

**Steps:**
1. Open DevTools > Console tab
2. Clear console
3. Open the payment form dialog
4. Fill fields, trigger errors, submit, cancel, reopen
5. Complete a successful submission

**Expected:**
- No red error messages in console
- No React warnings about controlled/uncontrolled component switching
- No RHF warnings about missing refs or validation
- No Zod-related errors

---

## Regression Checklist

| # | Check | Pass? |
|---|---|---|
| 1 | Dialog opens when "Log Payment" button is clicked | |
| 2 | All 5 fields are visible and interactive | |
| 3 | Empty submit shows inline errors (not toasts) | |
| 4 | Valid submit logs payment and closes dialog | |
| 5 | File upload works end-to-end (upload URL -> POST -> storageId -> mutation) | |
| 6 | Cancel resets form | |
| 7 | Close via overlay/ESC resets form | |
| 8 | Submission error shows Alert (not inline error) | |
| 9 | Button shows spinner during submission | |
| 10 | Buttons disabled during submission | |
| 11 | Dialog cannot be closed during submission | |
| 12 | PostHog event fires on success | |
| 13 | Toast fires on success and error | |
| 14 | `pnpm tsc --noEmit` passes (for this file) | |
| 15 | `pnpm build` succeeds | |
| 16 | No `<Field>` / `<FieldLabel>` / `<FieldDescription>` imports remain (only `FieldGroup`) | |
| 17 | Accessibility audit passes (axe-core + IBM Equal Access) | |

---

## Responsive Testing

Test at these 4 viewports (per expect skill requirements):

| Viewport | Width |
|---|---|
| Mobile | 375px |
| Tablet | 768px |
| Desktop | 1280px |
| Wide | 1920px |

For each viewport, verify:
- Dialog renders correctly within viewport bounds
- Fields are fully visible and usable
- Error messages are visible and readable
- File info text doesn't overflow
- Buttons are tappable/clickable
- `sm:max-w-md` class constrains dialog on larger screens

---

## Important: Zod/v3 Compatibility Note

This migration uses `import { z } from "zod/v3"` (the Zod 3 compatibility layer shipped inside the `zod@4.x` package). This is required because `@hookform/resolvers@5.2.2` types expect either Zod 3 schemas (with `_def.typeName`) or Zod 4 core schemas (with `_zod.version.minor: 0`). The main `zod` export (`_zod.version.minor: 3`) doesn't match either overload, causing TypeScript errors.

**Other phase agents should use `zod/v3` as well** for the `zodResolver` integration. This is a drop-in replacement with identical API — `z.enum()`, `z.instanceof()`, `.refine()`, `.superRefine()`, `z.infer<>` all work identically.
