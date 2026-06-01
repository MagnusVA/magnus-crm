# Phase 4 QA Verification Plan — Follow-Up Dialog Regression Check

**Purpose**: Regression verification for the Follow-Up Dialog after all form-handling migrations (Phases 2, 3, 5) are complete. Confirms the unchanged dialog still works end-to-end and no cross-dialog regressions occurred.

**When to run**: After Phases 2, 3, and 5 are all merged/complete. Not before — cross-dialog regression risk only exists once import patterns have changed in other files.

**Execution**: Run with `expect` skill for browser verification, accessibility audit, and console error checking.

**Estimated time**: 15-20 minutes

---

## Pre-Conditions (Must Be True Before Running)

- [ ] Phase 1 (Infrastructure Setup) is complete — RHF, Zod, shadcn Form installed
- [ ] Phase 2 (Payment Form Dialog) migration is complete
- [ ] Phase 3 (Invite User Dialog) migration is complete
- [ ] Phase 5 (Mark Lost + Role Edit Dialogs) migration is complete
- [ ] Development server is running (`pnpm dev`)
- [ ] Test tenant has at least one opportunity with a meeting (for the closer view)

---

## 1. Type Safety & Build Verification

### 1.1 Type Check (Full Project)

```bash
pnpm tsc --noEmit
```

- [ ] Passes with zero errors
- [ ] No type errors related to `follow-up-dialog.tsx`
- [ ] No type errors in any migrated dialog files (payment-form-dialog, invite-user-dialog, mark-lost-dialog, role-edit-dialog)

### 1.2 Build Check

```bash
pnpm build
```

- [ ] Build succeeds without errors
- [ ] No warnings related to follow-up-dialog or any dialog component

### 1.3 File Integrity Check

```bash
# Confirm follow-up-dialog.tsx has ZERO changes from before the form-handling feature
git diff HEAD -- app/workspace/closer/meetings/_components/follow-up-dialog.tsx
```

- [ ] Output is empty (no changes)
- [ ] If output is NOT empty — **STOP** — someone accidentally modified this file during another phase. Investigate and revert.

---

## 2. Browser Verification (Use `expect` Skill)

### Route

- `/workspace/closer/meetings/[meetingId]` — Navigate as a user with the `closer` role

### 2.1 Idle State

- [ ] Click "Schedule Follow-up" button on the meeting detail page
- [ ] Dialog opens with title "Schedule Follow-up"
- [ ] Dialog shows descriptive text about generating a Calendly link
- [ ] "Generate Scheduling Link" button is visible and enabled
- [ ] No console errors on dialog open

### 2.2 Loading State

- [ ] Click "Generate Scheduling Link"
- [ ] Spinner appears with "Creating scheduling link via Calendly..." text
- [ ] Generate button is replaced by loading indicator (no double-click possible)

### 2.3 Success State

- [ ] After loading completes, booking URL appears in a read-only input field
- [ ] The input field has `readOnly` attribute (user cannot type in it)
- [ ] "Copy" button is visible next to the input
- [ ] Click "Copy" — button text changes to "Copied" temporarily
- [ ] Toast notification "Scheduling link copied to clipboard" appears
- [ ] "Done" button is visible below the success alert
- [ ] Success alert reads "Scheduling link created successfully"

### 2.4 State Reset on Close

- [ ] Click "Done" to close the dialog
- [ ] Reopen the dialog — it resets to idle state (not stale success/error)
- [ ] No lingering booking URL or error message from previous open

### 2.5 Error State (If Reproducible)

> Note: Error state may be difficult to reproduce without network manipulation. If possible:

- [ ] Trigger an error condition (e.g., disconnect network, invalid opportunity)
- [ ] Error alert appears with descriptive message
- [ ] "Try Again" button is visible and functional
- [ ] "Cancel" button closes the dialog
- [ ] After cancel and reopen, dialog resets to idle state

---

## 3. Cross-Dialog Regression Checks

These verify that import changes in Phases 2, 3, and 5 did not accidentally break shared components used by the Follow-Up Dialog.

### 3.1 Shared UI Component Integrity

- [ ] `<Dialog>` / `<DialogContent>` / `<DialogHeader>` / `<DialogTitle>` / `<DialogTrigger>` — all render correctly (these are also used in migrated dialogs)
- [ ] `<Button>` — renders correctly in all states (idle, success, error)
- [ ] `<Alert>` / `<AlertDescription>` — renders correctly in success and error states
- [ ] `<InputGroup>` / `<InputGroupInput>` / `<InputGroupAddon>` — renders correctly in success state
- [ ] `<Spinner>` — renders during loading state

### 3.2 No Accidental Import Drift

```bash
# Verify follow-up-dialog.tsx does NOT import from form.tsx (it shouldn't — it's not a form)
grep -n "form" app/workspace/closer/meetings/_components/follow-up-dialog.tsx || echo "No form imports found (expected)"
```

- [ ] No imports from `components/ui/form.tsx`
- [ ] No `useForm`, `FormProvider`, `FormField`, `FormItem`, `FormMessage` references
- [ ] No `zod` or `z.` references

### 3.3 No Accidental Removal of Shared Utilities

```bash
# Verify the field.tsx compound components still exist (not accidentally deleted during migrations)
ls components/ui/field.tsx && echo "field.tsx exists"
```

- [ ] `components/ui/field.tsx` still exists and is unchanged

---

## 4. Accessibility Audit (Use `expect` MCP Tools)

### 4.1 axe-core Audit

Run via expect's `accessibility_audit` tool on the dialog in each state:

- [ ] **Idle state**: Zero critical/serious violations
- [ ] **Success state**: Zero critical/serious violations
- [ ] **Error state**: Zero critical/serious violations (if reproducible)

### 4.2 Focus Management

- [ ] Dialog traps focus when open (Tab key cycles within dialog)
- [ ] Escape key closes the dialog
- [ ] Focus returns to the trigger button after dialog closes
- [ ] "Copy" button is keyboard-accessible (Enter/Space activates it)

### 4.3 ARIA Attributes

- [ ] Dialog has appropriate `role="dialog"` or `role="alertdialog"`
- [ ] Dialog has `aria-labelledby` pointing to the title
- [ ] Read-only input has `aria-label="Scheduling link"`
- [ ] Copy button has `aria-label` that updates from "Copy scheduling link" to "Link copied to clipboard"

---

## 5. Performance & Console Check (Use `expect` MCP Tools)

### 5.1 Console Errors

Run via expect's `console_logs` tool:

- [ ] Zero console errors during dialog open/close cycle
- [ ] Zero console warnings related to React key, deprecated API, or missing props
- [ ] No network errors (except intentional error-state testing)

### 5.2 Performance

Run via expect's `performance_metrics` tool:

- [ ] No Long Animation Frames triggered by dialog open/close
- [ ] Dialog open/close transition is smooth (no layout shift)

---

## 6. PostHog Event Verification

- [ ] `follow_up_link_generated` event fires on successful link generation (check via PostHog dashboard or console)
- [ ] `follow_up_link_copied` event fires on copy action
- [ ] Events include `opportunity_id` property

---

## 7. Final Sign-Off

- [ ] All sections above pass
- [ ] `pnpm tsc --noEmit` — PASS
- [ ] `pnpm build` — PASS
- [ ] `git diff HEAD -- follow-up-dialog.tsx` — empty (no changes)
- [ ] Browser verification — all states work (idle, loading, success, error, reset)
- [ ] Accessibility audit — zero critical/serious violations
- [ ] Console check — zero errors
- [ ] Cross-dialog regression — no shared components broken

**Phase 4 Status**: COMPLETE

---

## Phase 4A & 4B Audit Results (Reference)

The following audit was performed independently against the source code at `app/workspace/closer/meetings/_components/follow-up-dialog.tsx` (232 lines, last modified in commit `9793e37`).

### 4A — Code Audit Findings

**All 5 `useState` hooks classified:**

| # | Hook | Type | Initial Value | Category | RHF Replaceable? | Evidence |
|---|------|------|---------------|----------|-------------------|----------|
| 1 | `open` | `boolean` | `false` | Dialog visibility | No | Controls `<Dialog open={open}>` — RHF doesn't manage dialog open/close |
| 2 | `state` | `DialogState` (`"idle" \| "loading" \| "success" \| "error"`) | `"idle"` | UI state machine | No | Drives conditional rendering of 4 dialog states — not a form field |
| 3 | `bookingUrl` | `string \| null` | `null` | Backend result | No | Set by `createFollowUp` action return value — not user input |
| 4 | `error` | `string \| null` | `null` | Action-level error | No | Set by `catch` block on action failure — not a validation error |
| 5 | `copied` | `boolean` | `false` | Clipboard feedback | No | Transient UI flag for "Copied" text, resets after 2s timeout |

**JSX scan for user-editable elements:**

| Element | Line | Editable? | Verdict |
|---------|------|-----------|---------|
| `<InputGroupInput>` | 165-169 | **No** — has `readOnly` attribute | Display-only; shows backend-generated booking URL |
| `<Button>` (x5) | 140, 173, 196, 211, 218 | N/A — buttons, not inputs | `onClick` handlers only; no form submission |

**Additional observations:**
- Zero `<form>` tags in the entire component
- Zero `onSubmit` handlers — all interactions are via `onClick`
- Zero `<Field>`, `<FieldLabel>`, `<Select>`, `<Textarea>` elements
- Zero validation logic — no `if/else` checks, no `parseFloat`, no regex
- The `<Alert>` components serve as state-machine feedback, not validation error display
- PostHog events fire on `handleGenerate` success and `handleCopy` — behavioral tracking, not form analytics

### 4B — Migration Criteria Evaluation

| # | Migration Criterion | Result | Evidence |
|---|---------------------|--------|----------|
| 1 | Has user-editable input fields? | **No** | All 5 `useState` hooks are UI state. The `<InputGroupInput>` is `readOnly`. No `<Select>`, `<Textarea>`, or editable `<Input>` exists. |
| 2 | Has manual validation logic in submit handler? | **No** | No submit handler exists. No `<form>` tag. The "Generate" button calls a Convex action directly via `onClick`. |
| 3 | Would benefit from inline error display (`<FormMessage>`)? | **No** | Errors are action-level (network/Convex runtime failures), not field-level validation. The `<Alert variant="destructive">` + toast pattern is appropriate for action errors. |
| 4 | Has `useState` hooks managing field values that RHF could replace? | **No** | All 5 hooks manage UI concerns: dialog visibility, state machine mode, backend result display, action error message, clipboard feedback. Zero hooks hold user-entered values. |

**Decision: No migration. 0 of 4 criteria met. The dialog is not a form.**

### Future Scope Note

This dialog will be **completely redesigned** in v0.5 Phase 4 (Follow-Up & Rescheduling Overhaul). The redesigned version will have:
- **"Send Link" path** — similar to current state-machine (no form fields, no RHF needed)
- **"Set Reminder" path** — a real form with reminder method select, date/time picker, optional notes textarea → **will use RHF + Zod**

The infrastructure from Phase 1 and patterns from Phases 2, 3, 5 will be ready for that implementation.

---

*This QA plan covers the full 4C regression verification scope. Run it after all form-handling phases are complete.*
