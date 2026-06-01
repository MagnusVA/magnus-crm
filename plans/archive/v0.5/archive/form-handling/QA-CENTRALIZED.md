# Form Handling v0.5 — Centralized QA Plan

**Last Updated:** 2026-04-09
**Status:** All 5 phases implemented; QA ready for execution
**Scope:** Phases 1–5 across 4 dialog components + infrastructure

> **MANDATORY: Follow the CLI-first verification workflow from TESTING.MD.**
> Every QA run must: (1) seed real data, (2) verify via Convex CLI, (3) then validate in browser via Expect.
> Never skip CLI verification. Never use `npx convex dashboard`. The Expect agent's browser is for `localhost:3000` only.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Prerequisites](#prerequisites)
3. [Phase 0 — Pre-QA Type Safety](#phase-0--pre-qa-type-safety)
4. [Phase 1 — Seed Test Data via Convex CLI](#phase-1--seed-test-data-via-convex-cli)
5. [Phase 2 — Payment Form Dialog QA](#phase-2--payment-form-dialog-qa)
6. [Phase 3 — Invite User Dialog QA](#phase-3--invite-user-dialog-qa)
7. [Phase 4 — Mark Lost Dialog QA](#phase-4--mark-lost-dialog-qa)
8. [Phase 5 — Role Edit Dialog QA](#phase-5--role-edit-dialog-qa)
9. [Phase 6 — Follow-Up Dialog Regression](#phase-6--follow-up-dialog-regression)
10. [Phase 7 — Cross-Dialog Isolation & Full Regression](#phase-7--cross-dialog-isolation--full-regression)
11. [Completion Gates](#completion-gates)
12. [Appendix: Accessibility Checklist](#appendix-accessibility-checklist)
13. [Appendix: Console Error Policy](#appendix-console-error-policy)

---

## Executive Summary

| Phase | Component | Status | Files Modified |
|-------|-----------|--------|----------------|
| **1** | Infrastructure (RHF + Zod + shadcn form) | Implemented | `package.json`, `next.config.ts`, `components/ui/form.tsx` |
| **2** | Payment Form Dialog | Implemented | `payment-form-dialog.tsx` |
| **3** | Invite User Dialog | Implemented | `invite-user-dialog.tsx` |
| **4** | Follow-Up Dialog | Assessment only | _(no changes)_ |
| **5** | Mark Lost + Role Edit Dialogs | Implemented | `mark-lost-dialog.tsx`, `role-edit-dialog.tsx` |

**Stack:** `react-hook-form@7.72.1` + `@hookform/resolvers@5.2.2` + `zod@4.3.6`
**Resolver:** `standardSchemaResolver` (Zod v4 native via Standard Schema)
**Import:** `import { z } from "zod"` (no compat layer)

---

## Prerequisites

### Services Running

```bash
# Terminal 1 — Next.js dev server
pnpm dev
# Wait for http://localhost:3000

# Terminal 2 — Convex dev server (syncs to test deployment)
npx convex dev
```

### Test Accounts

| Email | CRM Role | Used For |
|-------|----------|----------|
| `vas.claudio15+tenantowner@icloud.com` | `tenant_master` | Team page, pipeline, role edit |
| `vas.claudio15+closer1@icloud.com` | `closer` | Meeting detail, payment, mark lost, follow-up |
| `vas.claudio15+closer2@icloud.com` | `closer` | Meeting detail (round-robin alternate) |

**Password:** `grep TEST_USERS_PASSWORD .env.local`
**Sign-in URL:** `http://localhost:3000/sign-in`

### Routes Under Test

| Dialog | Route | Role Required | Trigger |
|--------|-------|---------------|---------|
| Payment Form | `/workspace/closer/meetings/[meetingId]` | `closer` | "Log Payment" button (opportunity status `in_progress`) |
| Mark Lost | `/workspace/closer/meetings/[meetingId]` | `closer` | "Mark as Lost" button (opportunity status `in_progress`) |
| Follow-Up | `/workspace/closer/meetings/[meetingId]` | `closer` | "Schedule Follow-up" button (status `in_progress`, `canceled`, or `no_show`) |
| Invite User | `/workspace/team` | `tenant_admin` or `tenant_master` | "Invite User" button (always visible) |
| Role Edit | `/workspace/team` | `tenant_master` | "Edit Role" action on team member row |

---

## Phase 0 — Pre-QA Type Safety

**Time:** 2 minutes
**Owner:** Automated (run before any browser work)

```bash
# 1. Type check — must pass with zero errors
pnpm tsc --noEmit

# 2. Verify dependencies
pnpm list react-hook-form @hookform/resolvers zod

# 3. Verify form component exists
ls components/ui/form.tsx

# 4. Verify next.config.ts optimization
grep -A1 'optimizePackageImports' next.config.ts
# Must include "zod"

# 5. Verify import consistency — all 4 dialogs use native Zod v4
grep 'from "zod' app/workspace/closer/meetings/_components/payment-form-dialog.tsx \
                 app/workspace/closer/meetings/_components/mark-lost-dialog.tsx \
                 app/workspace/team/_components/invite-user-dialog.tsx \
                 app/workspace/team/_components/role-edit-dialog.tsx
# All must show: import { z } from "zod";

# 6. Verify resolver consistency — all use standardSchemaResolver
grep 'standardSchemaResolver\|zodResolver' app/workspace/closer/meetings/_components/payment-form-dialog.tsx \
                                            app/workspace/closer/meetings/_components/mark-lost-dialog.tsx \
                                            app/workspace/team/_components/invite-user-dialog.tsx \
                                            app/workspace/team/_components/role-edit-dialog.tsx
# All must show: standardSchemaResolver (NOT zodResolver)

# 7. Verify follow-up dialog is unchanged
git diff HEAD -- app/workspace/closer/meetings/_components/follow-up-dialog.tsx
# Must be empty
```

**Pass criteria:** All 7 checks pass. If any fail, stop and fix before proceeding.

---

## Phase 1 — Seed Test Data via Convex CLI

> **This phase is mandatory.** The form dialogs require real data to test — you need opportunities with meetings in specific statuses, and team members with different roles.

**Time:** 10 minutes

### Step 1: Verify existing test data

```bash
# Check if we have opportunities in the right statuses
# Sign in as closer1 first, then:
npx convex run closer/pipeline:listMyOpportunities
# Look for opportunities with status "in_progress" (needed for Payment Form + Mark Lost)
# Look for opportunities with status "scheduled" (can be transitioned to in_progress)

# Check team members exist (needed for Role Edit)
npx convex run users/queries:listTeamMembers
# Need at least 2 members with different roles

# Check unmatched Calendly members (needed for Invite User)
npx convex run users/queries:listUnmatchedCalendlyMembers
# Need at least 1 unmatched member for closer assignment
```

### Step 2: Create test meetings if needed

If no opportunities exist with status `in_progress`:

1. **Schedule a new Calendly meeting:**
   ```
   https://calendly.com/d/cvmm-vy4-696/test-meeting-for-crm
   ```
   - Pick an unused email: `vas.claudio15+lead{N}@icloud.com`
   - Fill ALL custom form fields

2. **Verify webhook processed:**
   ```bash
   # Watch for webhook processing in real time
   npx convex logs
   # Look for: [Pipeline] inviteeCreated | leadId=... meetingId=...

   # Or check after the fact:
   npx convex run rawWebhookEvents:getLatest
   # Confirm: eventType = "invitee.created", processed = true
   ```

3. **Verify data chain:**
   ```bash
   npx convex run leads:getByEmail '{"email": "vas.claudio15+lead{N}@icloud.com"}'
   # Note the leadId

   npx convex run opportunities:getByLeadId '{"leadId": "<leadId>"}'
   # Note: status, assignedCloserId, opportunityId

   npx convex run meetings:getByOpportunityId '{"opportunityId": "<opportunityId>"}'
   # Note: meetingId, status, scheduledAt
   ```

4. **If opportunity is `scheduled` and you need `in_progress`:**
   The meeting detail page transition to `in_progress` happens when the closer views a meeting whose scheduled time has passed. Use an existing meeting or wait for the scheduled time.

### Step 3: Record test data IDs

Write down these IDs — they'll be used in browser tests:

| Data | Value | Used By |
|------|-------|---------|
| Meeting ID (in_progress) | `_____________` | Payment Form, Mark Lost, Follow-Up |
| Opportunity ID | `_____________` | Payment Form, Mark Lost |
| Assigned Closer Email | `_____________` | Login for meeting tests |
| Team Member 1 (closer) | `_____________` | Role Edit test |
| Team Member 2 (admin) | `_____________` | Role Edit test |

---

## Phase 2 — Payment Form Dialog QA

**Route:** `/workspace/closer/meetings/[meetingId]`
**Login as:** The assigned closer (from Phase 1)
**Requires:** Opportunity with status `in_progress`
**Time:** 30 minutes

### Layer 1 — Expect Browser Tests

Use the `expect` skill to open the app and run through these test sequences.

#### Test 2.1: Inline Validation Errors

```
1. Navigate to /workspace/closer/meetings/[meetingId]
2. Click "Log Payment" button → dialog opens
3. Immediately click the "Log Payment" submit button (no data entered)
4. VERIFY:
   - Form does NOT submit (no network request)
   - Inline error appears below Amount: "Amount is required"
   - No toast notification appears
   - No Alert component appears
5. Enter "0" in Amount field
6. Click submit
7. VERIFY: Error below Amount changes to "Amount must be greater than 0"
8. Enter "299.99" in Amount field
9. VERIFY: Amount error disappears
10. Select a currency (USD)
11. Select a provider (Stripe)
12. Click submit
13. VERIFY: Form submits successfully
```

#### Test 2.2: File Upload Validation

```
1. Open Payment Form dialog
2. Fill required fields (amount: 100, currency: USD, provider: Cash)
3. In "Proof File" input, select a file LARGER than 10 MB
4. Click submit
5. VERIFY: Inline error below file input: "File size must be less than 10 MB"
6. Select a .txt file (unsupported type)
7. VERIFY: Error changes to "Only images (JPEG, PNG, GIF) and PDFs are allowed"
8. Select a valid small PNG file (< 10 MB)
9. VERIFY:
   - Error disappears
   - File name and size displayed below input (e.g., "test.png (45.2 KB)")
10. Click submit
11. VERIFY: Form submits, file upload succeeds (two-step Convex flow)
```

#### Test 2.3: Successful Submission

```
1. Open Payment Form dialog
2. Fill: amount=299.99, currency=USD, provider=Stripe, referenceCode=pi_test123
3. Click "Log Payment"
4. VERIFY:
   - Button shows spinner + "Logging..." text
   - Button is disabled
   - Cancel button is disabled
   - Dialog stays open during submission
5. On success:
   - Dialog closes
   - Success toast appears: "Payment logged successfully"
   - Form resets (reopen dialog → all fields empty)
```

#### Test 2.4: Submission Error Handling

```
1. Open Payment Form dialog
2. Fill all required fields
3. Open DevTools → Network tab → set to "Offline"
4. Click submit
5. VERIFY:
   - After timeout: red Alert appears ABOVE submit button (not inline)
   - Error toast appears
   - Form stays open with data preserved
   - User can retry
6. Restore network → click submit again → should succeed
```

#### Test 2.5: Dialog Close & Reset

```
1. Open Payment Form dialog
2. Enter data in all fields
3. Click Cancel
4. VERIFY: Dialog closes
5. Reopen dialog
6. VERIFY: All fields are empty (form.reset() worked)
7. Enter data → press Escape key
8. VERIFY: Dialog closes, data cleared on reopen
9. Enter data → click outside dialog overlay
10. VERIFY: Dialog closes, data cleared on reopen
```

### Layer 2 — CLI Post-Verification

After Test 2.3 (successful submission), verify the backend:

```bash
# Check the payment was recorded
npx convex run opportunities:getById '{"opportunityId": "<opportunityId>"}'
# Confirm: status should have transitioned (check for payment_received or similar)

# Check Convex logs for the mutation
npx convex logs
# Look for: logPayment success
```

### Layer 3 — Expect Completion Gates

```
- [ ] accessibility_audit → zero critical/serious violations
- [ ] performance_metrics → INP < 200ms during form interaction
- [ ] console_logs → zero type='error' entries
- [ ] screenshot at 375, 768, 1280, 1440 viewports
- [ ] close → session flushed
```

---

## Phase 3 — Invite User Dialog QA

**Route:** `/workspace/team`
**Login as:** `vas.claudio15+tenantowner@icloud.com` (tenant_master)
**Requires:** At least 1 unmatched Calendly member
**Time:** 30 minutes

### Layer 1 — CLI Pre-Verification

```bash
# Verify unmatched Calendly members exist
npx convex run users/queries:listUnmatchedCalendlyMembers
# Need at least 1 result — if empty, sync Calendly members first

# Verify team members list loads
npx convex run users/queries:listTeamMembers
```

### Layer 2 — Expect Browser Tests

#### Test 3.1: Basic Inline Validation

```
1. Navigate to /workspace/team
2. Click "Invite User" button → dialog opens
3. Click "Invite" submit button immediately
4. VERIFY inline errors:
   - "Email is required" below email field
   - "First name is required" below first name field
   - No toast (validation is inline only)
5. Enter "not-an-email" in email field
6. Tab out or click submit
7. VERIFY: Error changes to "Please enter a valid email address"
8. Enter "test@example.com"
9. VERIFY: Email error disappears
```

#### Test 3.2: Conditional Calendly Field (watch + superRefine)

```
1. Open Invite User dialog
2. VERIFY: Default role is "Closer" → Calendly Member field IS visible
3. Change role to "Admin"
4. VERIFY: Calendly Member field DISAPPEARS
5. Change role back to "Closer"
6. VERIFY: Calendly Member field REAPPEARS and is EMPTY
7. Fill email + first name, keep role as "Closer"
8. Do NOT select a Calendly member
9. Click submit
10. VERIFY: Inline error below Calendly dropdown:
    "Calendly member is required for Closers"
11. Select a Calendly member from dropdown
12. VERIFY: Error disappears
```

#### Test 3.3: Calendly Field Cleared on Role Switch

```
1. Open dialog, role = "Closer"
2. Select a Calendly member (note the name)
3. Change role to "Admin"
4. VERIFY: Calendly field disappears
5. Change role back to "Closer"
6. VERIFY: Calendly field reappears but is EMPTY (previous selection cleared)
```

#### Test 3.4: Successful Submission (Closer)

```
1. Fill: email=test-closer-invite@example.com, firstName=Jane, role=Closer
2. Select a Calendly member
3. Click "Invite"
4. VERIFY:
   - Button shows spinner + "Inviting..."
   - Button disabled, Cancel disabled
5. On success:
   - Dialog closes
   - Success toast: "User invited successfully"
   - Form resets
```

#### Test 3.5: Successful Submission (Admin — no Calendly required)

```
1. Fill: email=test-admin-invite@example.com, firstName=Bob, role=Admin
2. VERIFY: No Calendly field visible
3. Click "Invite"
4. VERIFY: Submits successfully, no Calendly validation error
```

#### Test 3.6: Loading State for Calendly Members

```
1. Open dialog with role = "Closer"
2. VERIFY: If unmatchedMembers query is loading, the Calendly Select trigger is disabled
3. Once loaded, Select enables and shows member options
```

### Layer 3 — Expect Completion Gates

```
- [ ] accessibility_audit → zero critical/serious violations
- [ ] performance_metrics → INP < 200ms
- [ ] console_logs → zero type='error' entries
- [ ] screenshot at 375, 768, 1280, 1440 viewports
- [ ] close → session flushed
```

---

## Phase 4 — Mark Lost Dialog QA

**Route:** `/workspace/closer/meetings/[meetingId]`
**Login as:** Assigned closer
**Requires:** Opportunity with status `in_progress`
**Time:** 15 minutes

> **Important:** This test is destructive — marking an opportunity as lost is permanent. Use a dedicated test opportunity, or create a fresh one via Calendly before running this phase.

### Layer 1 — Expect Browser Tests

#### Test 4.1: Optional Reason (Empty Submit)

```
1. Navigate to /workspace/closer/meetings/[meetingId]
2. Click "Mark as Lost" button → AlertDialog opens
3. VERIFY: Dialog shows warning icon, "Mark as Lost?" title, destructive description
4. Leave reason textarea EMPTY
5. Click "Mark as Lost" submit button
6. VERIFY: Submission SUCCEEDS (reason is optional)
   - Toast: "Opportunity marked as lost"
   - Dialog closes
```

#### Test 4.2: Character Limit Validation

```
1. Open Mark Lost dialog (need a different opportunity with in_progress status)
2. Type > 500 characters into the reason textarea
3. Click submit
4. VERIFY: Inline error below textarea: "Reason must be under 500 characters"
5. Delete characters to get under 500
6. VERIFY: Error disappears
7. Submit → success
```

#### Test 4.3: Loading State & Focus Trap

```
1. Open Mark Lost dialog
2. Enter a short reason
3. Click "Mark as Lost"
4. VERIFY during submission:
   - Button shows spinner + "Marking..."
   - "Cancel" (AlertDialogCancel) is disabled
   - Textarea is disabled
   - Escape key does NOT close dialog (prevented by onOpenChange guard)
   - Clicking outside does NOT close dialog
5. On success: dialog closes, toast appears
```

#### Test 4.4: Cancel & Reset

```
1. Open Mark Lost dialog
2. Type a reason
3. Click "Cancel"
4. VERIFY: Dialog closes
5. Reopen dialog
6. VERIFY: Reason textarea is empty (form.reset() worked)
```

### Layer 2 — CLI Post-Verification

```bash
# After Test 4.1 or 4.2, verify the opportunity status changed
npx convex run closer/pipeline:listMyOpportunities '{"statusFilter": "lost"}'
# The opportunity should appear in the "lost" list

npx convex logs
# Look for: [Pipeline] markAsLost or opportunity_marked_lost
```

### Layer 3 — Expect Completion Gates

```
- [ ] accessibility_audit → AlertDialog focus trap works, aria-invalid on textarea
- [ ] console_logs → zero type='error' entries
- [ ] screenshot at 375, 768, 1280, 1440 viewports
- [ ] close → session flushed
```

---

## Phase 5 — Role Edit Dialog QA

**Route:** `/workspace/team`
**Login as:** `vas.claudio15+tenantowner@icloud.com` (tenant_master)
**Requires:** At least 2 team members with different roles
**Time:** 15 minutes

### Layer 1 — CLI Pre-Verification

```bash
# List team members and note their roles
npx convex run users/queries:listTeamMembers
# Need at least 1 closer and 1 admin for role switching tests
# Record: userId, userName, currentRole for each
```

### Layer 2 — Expect Browser Tests

#### Test 5.1: No-Op Detection (Save Disabled)

```
1. Navigate to /workspace/team
2. Click "Edit Role" on a team member (e.g., closer1)
3. Dialog opens with current role pre-selected
4. VERIFY: Save button is DISABLED (role hasn't changed)
5. Do NOT change the role
6. VERIFY: Save button stays disabled — cannot submit
```

#### Test 5.2: Role Change

```
1. Open Role Edit for a closer (current role: "Closer")
2. Change dropdown to "Admin"
3. VERIFY: Save button ENABLES
4. Click "Save"
5. VERIFY:
   - Button shows spinner + "Saving..."
   - Cancel disabled, Select disabled
6. On success:
   - Toast: "[Name]'s role updated to Admin"
   - Dialog closes
   - Team page reflects the new role
```

#### Test 5.3: useEffect Reset (Different Users)

```
1. Open Role Edit for User A (role: Closer)
2. VERIFY: Dropdown shows "Closer"
3. Close dialog (Cancel or X)
4. Open Role Edit for User B (role: Admin)
5. VERIFY: Dropdown shows "Admin" (NOT stale "Closer" from User A)
6. Close dialog
7. Reopen for User A
8. VERIFY: Dropdown shows "Closer" again (reset works per-open)
```

#### Test 5.4: Error Handling

```
1. Open Role Edit dialog
2. Change role
3. Simulate network failure (DevTools → Offline)
4. Click Save
5. VERIFY:
   - Error toast appears
   - Dialog stays open
   - Can retry after restoring network
```

### Layer 3 — CLI Post-Verification

```bash
# After Test 5.2, verify the role changed in the backend
npx convex run users/queries:listTeamMembers
# The modified user should show the new role

# IMPORTANT: Revert the role change after testing to avoid breaking other tests
# Re-run the Role Edit dialog and switch the role back
```

### Layer 4 — Expect Completion Gates

```
- [ ] accessibility_audit → Select announces options, dialog has proper title
- [ ] console_logs → zero type='error' entries
- [ ] screenshot at 375, 768, 1280, 1440 viewports
- [ ] close → session flushed
```

---

## Phase 6 — Follow-Up Dialog Regression

**Route:** `/workspace/closer/meetings/[meetingId]`
**Login as:** Assigned closer
**Requires:** Opportunity with status `in_progress`, `canceled`, or `no_show`
**Time:** 10 minutes

> This dialog was NOT migrated (Phase 4 assessment confirmed it's a state-machine, not a form).
> This phase verifies zero regressions from the other dialog migrations.

### Layer 1 — Code Verification

```bash
# Confirm zero changes to the file
git diff HEAD -- app/workspace/closer/meetings/_components/follow-up-dialog.tsx
# MUST be empty — if any diff appears, investigate immediately
```

### Layer 2 — Expect Browser Tests

```
1. Navigate to /workspace/closer/meetings/[meetingId]
2. Click "Schedule Follow-up" → dialog opens in idle state
3. Click "Generate Link" → loading spinner appears
4. VERIFY: Success state shows booking URL in read-only input
5. Click "Copy" → URL copied to clipboard
6. VERIFY: Button text changes to "Copied!" momentarily
7. Close dialog → reopen
8. VERIFY: State resets to idle (not stale success/error)
```

### Layer 3 — Expect Completion Gates

```
- [ ] console_logs → zero type='error' entries related to form components
- [ ] No import errors or missing component errors
- [ ] close → session flushed
```

---

## Phase 7 — Cross-Dialog Isolation & Full Regression

**Time:** 15 minutes
**Login as:** Both closer and tenant_master (switch accounts)

> This phase tests that the RHF + Zod migration didn't break cross-dialog behavior.

### Test 7.1: Meeting Detail Page — All Dialogs Coexist

```
1. Login as closer
2. Navigate to /workspace/closer/meetings/[meetingId] (status: in_progress)
3. Open Payment Form → enter some data → Cancel
4. Open Mark Lost → enter a reason → Cancel
5. Open Follow-Up → generate link → close
6. VERIFY: Each dialog's state is independent:
   - Reopening Payment Form → fields empty
   - Reopening Mark Lost → reason empty
   - Reopening Follow-Up → idle state (not stale generated link)
7. No console errors after opening/closing all 3 dialogs
```

### Test 7.2: Team Page — Both Dialogs Coexist

```
1. Login as tenant_master
2. Navigate to /workspace/team
3. Open Invite User → fill email + name → Cancel
4. Open Role Edit for a user → change role → Cancel
5. VERIFY:
   - Reopening Invite User → fields empty
   - Reopening Role Edit → shows correct current role (not stale data)
6. No console errors
```

### Test 7.3: Full Page Regression

```
1. As closer: Navigate through dashboard → pipeline → meeting detail
   - VERIFY: No broken layouts, missing data, or errors
2. As tenant_master: Navigate through dashboard → pipeline → team → settings
   - VERIFY: No broken layouts, missing data, or errors
3. Run accessibility_audit on each page
4. Run performance_metrics on meeting detail page (has 3 dialogs)
```

---

## Completion Gates

All phases must pass these gates before QA is signed off.

### Per-Dialog Gates (via Expect skill)

| Gate | Expect Tool | Fail Condition | Required For |
|------|-------------|----------------|--------------|
| Accessibility | `accessibility_audit` | Any critical or serious WCAG violation | All 4 migrated dialogs |
| Performance | `performance_metrics` | INP > 200ms during form interaction | All 4 migrated dialogs |
| Console | `console_logs` | Any `type='error'` entry from RHF/Zod/Form | All 5 dialogs (incl. Follow-Up regression) |
| Responsive | `screenshot` | Broken layout at any of 4 viewports (375, 768, 1280, 1440) | All 4 migrated dialogs |
| Session | `close` | Must be called to flush artifacts | Every Expect session |

### Global Gates

| Gate | Command | Fail Condition |
|------|---------|----------------|
| TypeScript | `pnpm tsc --noEmit` | Any type error |
| Build | `pnpm build` | Build failure |
| Import consistency | `grep 'from "zod' app/**/*.tsx` | Any file using `"zod/v3"` |
| Resolver consistency | `grep 'zodResolver' app/**/*.tsx` | Any file using `zodResolver` instead of `standardSchemaResolver` |
| Follow-Up unchanged | `git diff HEAD -- follow-up-dialog.tsx` | Any diff output |
| No legacy imports | `grep 'FieldLabel\|FieldError\|FieldDescription' app/workspace/**/*.tsx` | Any match (should only use Form* components) |

---

## Appendix: Accessibility Checklist

All 4 migrated dialogs must pass these WCAG AA criteria. The `accessibility_audit` Expect tool (axe-core + IBM Equal Access) checks most of these automatically.

### Automated (via axe-core)

- `aria-invalid="true"` set on fields with errors (shadcn `FormControl` does this)
- `aria-describedby` links each field to its `FormMessage` ID
- Color contrast of error text (destructive) meets 4.5:1 ratio
- Dialog has `role="dialog"` and `aria-modal="true"`
- AlertDialog (Mark Lost) traps focus correctly
- All form labels programmatically associated via `htmlFor`

### Manual Verification (during Expect tests)

- Tab order is logical: fields top-to-bottom, then Cancel → Submit
- Focus visible on all interactive elements
- First form field receives focus on dialog open
- Focus returns to trigger button on dialog close
- Escape key closes dialog (unless `isSubmitting`)
- Screen reader announces dialog title on open
- Screen reader announces error messages when they appear
- Select fields operable via arrow keys
- Form submittable via Enter key

### Mobile (verify at 375px viewport)

- Touch targets >= 48x48px
- Text readable without horizontal scroll
- Zoom not disabled (no `user-scalable=no`)

---

## Appendix: Console Error Policy

### Acceptable (ignore these)

- PostHog network warnings (`Failed to load resource` for `/ingest/` if throttled)
- Pre-existing Next.js hydration warnings (not introduced by form changes)
- Browser extension console messages
- Convex subscription debug logs (`DEBUG=convex:*`)

### Not Acceptable (must fix)

- `Cannot read property 'X' of undefined` — RHF or form context issue
- `Zod validation error` — schema should catch all cases
- `FormMessage is not a component` — import path issue
- `Cannot assign to read-only property 'value'` — file input mishandling
- `useFormContext must be used within a FormProvider` — missing `<Form>` wrapper
- `standardSchemaResolver` or `zodResolver` type errors at runtime
- Unhandled promise rejections during form submission
- React strict mode double-invoke warnings (if not pre-existing)

---

## Sign-Off

### Automated Checks

- [ ] `pnpm tsc --noEmit` — zero errors
- [ ] `pnpm build` — zero errors
- [ ] Import consistency verified (all `"zod"`, all `standardSchemaResolver`)
- [ ] Follow-up dialog unchanged

### Browser QA (via Expect)

- [ ] Phase 2 — Payment Form Dialog: all tests pass
- [ ] Phase 3 — Invite User Dialog: all tests pass
- [ ] Phase 4 — Mark Lost Dialog: all tests pass
- [ ] Phase 5 — Role Edit Dialog: all tests pass
- [ ] Phase 6 — Follow-Up Dialog: regression check pass
- [ ] Phase 7 — Cross-dialog isolation: all tests pass

### Completion Gates

- [ ] Accessibility audit: zero critical/serious violations across all dialogs
- [ ] Performance metrics: INP < 200ms across all dialogs
- [ ] Console errors: zero form-related errors
- [ ] Responsive: verified at 4 viewports
- [ ] All Expect sessions closed

**Date:** _______________
**Tested by:** _______________
**Result:** _______________
