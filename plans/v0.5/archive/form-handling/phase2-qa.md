# Phase 2 QA Checklist — Payment Form Dialog Migration

**Status**: Ready for execution (after subphases 2A, 2B, 2C complete)
**Test Type**: Browser verification + accessibility audit + performance metrics
**Estimated time**: 60 minutes
**Tools**: `expect` skill (Playwright), DevTools (Console, Network, Performance tabs)

---

## Pre-QA Checks

### ✅ Code Review
- [ ] `pnpm tsc --noEmit` passes (subphase 2C complete)
- [ ] `pnpm build` succeeds (no build errors)
- [ ] No console errors in Editor during dev (`pnpm dev`)
- [ ] File contains all required imports:
  - [ ] `useForm`, `zodResolver` from RHF
  - [ ] `paymentFormSchema` Zod schema with all 5 fields
  - [ ] `Form`, `FormField`, `FormItem`, `FormLabel`, `FormControl`, `FormMessage`, `FormDescription` from shadcn
  - [ ] Existing: `Dialog`, `Button`, `Input`, `Select`, `Alert`, `Spinner`, `toast`, `posthog`

### ✅ State Verification
- [ ] Exactly 3 `useState` hooks remain: `open`, `isSubmitting`, `submitError`
- [ ] All 8 original `useState` hooks removed
- [ ] `useForm()` initialized with `zodResolver(paymentFormSchema)` and correct `defaultValues`
- [ ] `onSubmit` receives `values: PaymentFormValues` (pre-validated by Zod)

### ✅ File Structure
- [ ] File still marked with `"use client"` at top
- [ ] Zod constants defined: `CURRENCIES`, `PROVIDERS`, `MAX_FILE_SIZE`, `VALID_FILE_TYPES`
- [ ] Zod schema defined before component export
- [ ] `PaymentFormValues` type exported via `z.infer<>`

---

## QA Phase 2D — Browser Verification

### Step 1: Start Dev Server

```bash
pnpm dev
```

- [ ] Server starts without errors
- [ ] App is accessible at `http://localhost:3000`

### Step 2: Navigate to Payment Form

1. [ ] Sign in as a closer (or test tenant account with closer role)
2. [ ] Navigate to `/workspace/closer/meetings/[meetingId]` or find a meeting in pipeline
3. [ ] Locate "Log Payment" button
4. [ ] Click button — payment form dialog opens

---

### Step 3: Test Inline Validation (Form Submit without Data)

**Action**: Click "Log Payment" submit button with empty form

**Expected outcome**:
- [ ] Form does NOT submit
- [ ] Red error text appears below each required field:
  - [ ] Amount field: "Amount is required"
  - [ ] Currency field: "Please select a currency"
  - [ ] Provider field: "Please select a payment provider"
- [ ] Optional fields (Reference Code, Proof File) do NOT show errors
- [ ] First invalid field receives focus automatically
- [ ] No toast appears (validation errors are inline only)
- [ ] No submission-level alert appears

---

### Step 4: Test Amount Field Validation

**Action 1**: Enter "0" in amount field, trigger validation (click submit or tab out)

**Expected outcome**:
- [ ] Red error text appears: "Amount must be greater than 0"
- [ ] Form does not submit if triggered via button click

**Action 2**: Enter negative number ("-50")

**Expected outcome**:
- [ ] Same error: "Amount must be greater than 0"

**Action 3**: Enter valid amount ("299.99")

**Expected outcome**:
- [ ] Error disappears immediately or on field blur
- [ ] Field shows clean state (no red border/error text)

**Action 4**: Trigger submit with valid amount + valid currency + valid provider

**Expected outcome**:
- [ ] Amount field does NOT show an error
- [ ] Form can proceed (no block at amount validation)

---

### Step 5: Test Currency Field

**Action 1**: Leave currency at default "USD"

**Expected outcome**:
- [ ] Submit is blocked only by other required fields (amount, provider)
- [ ] Currency field shows no error

**Action 2**: Change to another currency ("EUR", "GBP", etc.)

**Expected outcome**:
- [ ] Currency changes immediately in the dropdown
- [ ] Form state updates (verified in console via `form.getValues()` if needed)

---

### Step 6: Test Provider Field

**Action 1**: Leave provider empty, attempt submit

**Expected outcome**:
- [ ] Red error: "Please select a payment provider"
- [ ] Form does not submit

**Action 2**: Select a provider ("Stripe", "PayPal", etc.)

**Expected outcome**:
- [ ] Error disappears
- [ ] Form can proceed (if other required fields filled)

---

### Step 7: Test Reference Code Field (Optional)

**Action 1**: Leave reference code empty

**Expected outcome**:
- [ ] No error appears (it's optional)
- [ ] Form submits if other required fields are valid

**Action 2**: Enter reference code text

**Expected outcome**:
- [ ] Text appears in field
- [ ] No validation errors (optional field, any string value accepted)

---

### Step 8: Test File Upload Validation

**Action 1**: Select a file larger than 10 MB

**Expected outcome**:
- [ ] Red error appears: "File size must be less than 10 MB"
- [ ] File is NOT accepted (no file name display)
- [ ] Form does not submit

**Action 2**: Select a file with unsupported type (.txt, .doc, .xlsx, etc.)

**Expected outcome**:
- [ ] Red error appears: "Only images (JPEG, PNG, GIF) and PDFs are allowed"
- [ ] File is NOT accepted
- [ ] Form does not submit

**Action 3**: Select a valid file (JPEG, PNG, GIF, or PDF under 10 MB)

**Expected outcome**:
- [ ] Error disappears immediately
- [ ] File name and size display below input:
  - [ ] Format: "filename.jpg (234.5 KB)"
  - [ ] Icon present (lucide `UploadIcon`)
  - [ ] Text truncates if filename is very long
- [ ] Form can submit (file validation passed)

**Action 4**: After selecting valid file, select "No file" or cancel file picker

**Expected outcome**:
- [ ] File input is cleared (depends on browser behavior — may not show visual clear, but value is nullified in form state)
- [ ] File name/size display is gone

---

### Step 9: Test Successful Submission (Without File)

**Fill form with valid data**:
- [ ] Amount: 299.99
- [ ] Currency: USD
- [ ] Provider: Stripe
- [ ] Reference Code: (leave empty — optional)
- [ ] Proof File: (leave empty — optional)

**Click "Log Payment"**:

**Expected during submission**:
- [ ] Submit button shows spinner + "Logging..." text
- [ ] Submit button becomes disabled
- [ ] Cancel button becomes disabled
- [ ] Form fields remain visible and their inputs might be disabled or not (both acceptable)
- [ ] Dialog stays open (doesn't close prematurely)
- [ ] No inline field errors appear

**Expected on success** (after ~1–2 seconds):
- [ ] Dialog closes automatically
- [ ] Form resets (all fields return to default state)
- [ ] Success toast appears: "Payment logged successfully"
- [ ] PostHog event fired (check Network tab: `POST /ingest` or similar)
- [ ] Page refreshes data (payment record appears in meeting details if visible elsewhere)
- [ ] Button returns to normal state (no spinner, "Log Payment" text)

---

### Step 10: Test Successful Submission (With File)

**Fill form with valid data + file**:
- [ ] Amount: 150.00
- [ ] Currency: EUR
- [ ] Provider: PayPal
- [ ] Reference Code: "txn_12345"
- [ ] Proof File: Valid JPEG/PNG/GIF/PDF under 10 MB

**Click "Log Payment"**:

**Expected during submission**:
- [ ] Submit button disabled with spinner (as before)
- [ ] Dialog open, form visible

**Expected on success**:
- [ ] Dialog closes
- [ ] Form resets (file input clears)
- [ ] Success toast appears
- [ ] PostHog event fires with `has_proof_file: true`
- [ ] Convex storage upload completed successfully (no errors in Network tab)
- [ ] Payment record created with `proofFileId` in database (verify in Convex dashboard if access available)

---

### Step 11: Test Submission Error Handling (Simulated Network Failure)

**Fill form with valid data**:
- [ ] Amount: 100.00
- [ ] Currency: USD
- [ ] Provider: Cash
- [ ] Proof File: (empty)

**Simulate network offline**:
- [ ] Open DevTools (F12)
- [ ] Go to **Network** tab
- [ ] Click the gear icon → set throttling to "Offline" (or use "Disconnect")
- [ ] Return to form, click "Log Payment"

**Expected on error**:
- [ ] Button shows spinner initially
- [ ] After ~5–10 seconds (timeout), button returns to normal state
- [ ] Red alert appears above submit button with error message:
  - [ ] Message describes network failure or timeout
  - [ ] Alert includes `<AlertCircleIcon>`
  - [ ] Variant is `"destructive"` (red background)
- [ ] Error toast appears at top of screen (red, from `sonner`)
- [ ] Form stays open with data preserved (user can correct/retry)
- [ ] No inline field errors appear (this is a submission error, not validation)

**Recovery**:
- [ ] Open DevTools again, disable throttling/reconnect
- [ ] Click "Log Payment" again
- [ ] Expected: form submits successfully this time

---

### Step 12: Test Dialog Close/Cancel

**Open dialog, fill partial data (not all required fields)**:

**Click Cancel button**:
- [ ] Dialog closes immediately (no validation check)
- [ ] Form resets to defaults
- [ ] On reopen, form is empty again

**Open dialog, fill valid data, start submission**:

**Attempt to close dialog during submission** (click X or outside):
- [ ] Dialog does NOT close (blocked by `!isSubmitting` check)
- [ ] Submission continues
- [ ] User sees spinner until complete

**After submission completes**:
- [ ] Dialog closes automatically
- [ ] Form resets

---

### Step 13: Accessibility Audit (Invoke `expect` skill)

Use the `expect` skill to run an accessibility audit. This agent will use Playwright + axe-core to verify:

**Invoke**:
```
expect: Run accessibility audit on the payment form dialog (open it, fill fields, check WCAG compliance)
```

**Expected checks**:
- [ ] **Color contrast**: Error text (red) meets WCAG AA standard (7:1 or 4.5:1 depending on element)
- [ ] **aria-invalid**: Fields with errors have `aria-invalid="true"`
- [ ] **aria-describedby**: Error message (`<FormMessage />`) is associated with input via aria-describedby
- [ ] **Focus management**: Tab through form — focus order is logical (top-to-bottom)
- [ ] **Screen reader**: Error messages are announced when they appear
- [ ] **Labels**: All inputs have associated `<label>` or `<FieldLabel>`
- [ ] **Required fields**: Marked with asterisk (*) or via `aria-required` (if shadcn provides this)

**Expected result**: No critical or serious accessibility violations.

---

### Step 14: Performance Metrics (Invoke `expect` skill)

Use `expect` skill to measure Core Web Vitals:

**Invoke**:
```
expect: Measure performance metrics while opening, filling, and submitting the payment form
```

**Expected metrics**:
- [ ] **FCP (First Contentful Paint)**: < 1.8s
- [ ] **LCP (Largest Contentful Paint)**: < 2.5s (dialog opening)
- [ ] **INP (Interaction to Next Paint)**: < 200ms (typing, clicking buttons)
- [ ] **CLS (Cumulative Layout Shift)**: < 0.1 (no jarring layout changes)
- [ ] **TTFB (Time to First Byte)**: < 600ms

**Interactions to test**:
- [ ] Type in amount field
- [ ] Click currency dropdown, select option
- [ ] Click provider dropdown, select option
- [ ] Click file input, select file
- [ ] Click submit button

**Expected outcome**: No Long Animation Frames (LAF) blocking interactions. Form is responsive.

---

### Step 15: Console Error Check

**Action**: Interact with form (open, fill fields, submit, close, reopen) while watching **Console** tab in DevTools

**Expected**:
- [ ] No red error messages in console
- [ ] No warnings related to RHF, Zod, Form components
- [ ] No `undefined` errors
- [ ] No React warnings (e.g., "Missing dependencies in useEffect")
- [ ] PostHog network requests appear in Network tab (black/gray, not red)

**Optional**: Check **Sources** tab for breakpoints if debugging needed.

---

## Test Data Requirements

For testing to be valid, these prerequisites must be met:

- [ ] Real database records exist (not mocked):
  - [ ] At least 1 test opportunity in a "pending_payment" or similar state
  - [ ] At least 1 associated meeting record
  - [ ] Test user has "closer" role on the test tenant

- [ ] Dev environment clean:
  - [ ] No stale builds
  - [ ] `pnpm install` / `pnpm build` run successfully
  - [ ] Convex backend is running (`npx convex dev` in separate terminal)

---

## Sign-Off Criteria

All of the following must be true to mark Phase 2 as complete:

- [ ] **2A–2C Code**: All subphases implemented and committed
- [ ] **TypeScript**: `pnpm tsc --noEmit` passes
- [ ] **Build**: `pnpm build` succeeds
- [ ] **Inline Validation**: All 5 fields validate correctly; errors appear inline
- [ ] **File Upload**: Size and type validation works; errors inline
- [ ] **Submission Success**: Dialog closes, form resets, toast appears, PostHog event fired
- [ ] **Submission Error**: Network errors display in alert (not inline), form preserved
- [ ] **Accessibility**: axe-core audit passes (no critical/serious violations)
- [ ] **Performance**: INP < 200ms, no LAF during interactions
- [ ] **Console**: No red errors or RHF/Zod warnings
- [ ] **Browser State**: Dialog close/cancel/reopen works correctly; form state persists/resets as expected

---

## Notes for QA Executor

1. **Deferred Execution**: This checklist is created now but executed AFTER subphases 2A–2C are complete and merged.

2. **Parallel Phases**: During Phase 2 QA (2D), Phases 3, 4, 5 will be in progress. QA can run concurrently.

3. **Device Testing**: Verify on desktop (1920×1080) and mobile (375×667) viewports — dialog responsiveness matters for UX.

4. **Reusable Checklist**: This checklist can be adapted for Phases 3 and 5 (simpler dialogs) with minimal changes.

5. **Evidence Capture**: Use `expect` skill's screenshot/network/console tools to capture evidence of passing tests.

---

## Rollback Plan (If QA Fails)

If QA fails (e.g., accessibility violations, console errors, performance issues):

1. **Identify root cause**: Debug via console, Network tab, DevTools
2. **Fix in branch**: Return to code, fix issue, re-run subphase 2C
3. **Re-run QA**: Execute this checklist again
4. **Merge when passing**: Only merge Phase 2 when all criteria met

Example issues and fixes:
- **Console error about aria-describedby**: shadcn `FormMessage` might not set it automatically — manually add to input
- **Color contrast failure**: Inline error text color might not meet WCAG AA; adjust Tailwind color in `<FormMessage>`
- **INP > 200ms**: Rare with RHF, but if observed, switch to `useWatch()` for specific fields

---

## Related Documents

- `phase2-scope.md` — Implementation scope and guidance
- `phases/phase2.md` — Detailed design and step-by-step instructions
- `parallelization-strategy.md` — Critical path and timeline
- `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` — Target file

---

*Last updated: 2026-04-09*
*Ready for execution after Phase 2 subphases complete.*
