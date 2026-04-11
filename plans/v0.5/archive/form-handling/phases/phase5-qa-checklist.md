# Phase 5 QA Checklist — Mark Lost & Role Edit Dialog Migration

**When to run**: After 5A, 5B, and 5C code changes are complete. Use `expect` skill for browser verification.

**Prerequisites**: Phase 1 (infrastructure) complete. Type check passes (`pnpm tsc --noEmit`).

---

## Type Check

**Command:**
```bash
pnpm tsc --noEmit
```

**Expected:** Zero errors. Both dialogs import `useForm`, `zodResolver`, `z` without errors.

---

## 5A — Mark Lost Dialog Browser Verification

**Route**: `/workspace/closer/meetings/[meetingId]` (logged in as closer)

**Setup**: Open a meeting detail page with at least 3 past opportunities. Find the "Mark as Lost" button.

### 1. Empty Submit
- Click "Mark as Lost" button → dialog opens
- Click "Mark as Lost" button in dialog with empty reason
- **Expected**: Submit succeeds (reason is optional), toast "Opportunity marked as lost", dialog closes
- **No inline error shown**

### 2. Long Reason (>500 chars)
- Click "Mark as Lost" again → dialog opens
- Type 501+ characters in reason textarea
- Click submit or Tab out
- **Expected**: Inline error "Reason must be under 500 characters" appears below textarea
- Submit button disabled or submission fails

### 3. Valid Reason
- Clear textarea, type a short reason (50 chars)
- Click "Mark as Lost"
- **Expected**: Submit succeeds, toast success, dialog closes, reason is sent to backend
- Check browser console for PostHog event: `opportunity_marked_lost`

### 4. Form Reset on Close
- Click "Mark as Lost" → dialog opens
- Type a reason
- Click "Cancel"
- Click "Mark as Lost" again
- **Expected**: Reason field is empty (form reset on close)

### 5. Loading State
- Click "Mark as Lost" → dialog opens
- Type a reason
- Click "Mark as Lost"
- **During submission**:
  - Button shows spinner + "Marking…" text
  - Cancel button is disabled
  - Textarea is disabled
  - Escape key does not close dialog
- **Expected**: All disabled until submission completes

### 6. Focus & Accessibility
- Open dialog
- **Expected**:
  - Textarea receives focus automatically (or first interactive element)
  - `aria-invalid="true"` set on textarea when error present
  - `aria-describedby` links textarea to error message ID
  - Tab key navigates Cancel → "Mark as Lost" button

---

## 5B — Role Edit Dialog Browser Verification

**Route**: `/workspace/team` (logged in as tenant_master)

**Setup**: Team page with at least 3 team members (mix of closers and admins). Find team member edit icons.

### 1. No-op Save (Same Role)
- Click edit icon on a closer
- Dialog opens, role shows "Closer"
- Don't change role
- **Expected**: Save button is **disabled** (grayed out)
- Hover tooltip or disabled state visible

### 2. Change Role
- Click edit icon on a closer
- Dialog opens, role shows "Closer"
- Select "Admin"
- **Expected**: Save button **enables** (becomes clickable)
- Click "Save"
- **Expected**: Toast "Name's role updated to Admin", dialog closes, team list updates to reflect new role

### 3. Reopen with Different User (useEffect Reset Test)
- Close dialog
- Click edit on a different closer (user B)
- Dialog opens
- **Expected**: Role dropdown shows "Closer" (not stale "Admin" from previous open)
- Verify the new user's actual role is reflected, not cached

### 4. Error Handling
- Simulate error: Click edit on a user, change role, click Save
- If backend fails (e.g., permission denied):
- **Expected**: Toast error, dialog stays open, user can retry or close

### 5. Loading State During Save
- Click edit, select new role, click "Save"
- **During submission**:
  - Button shows spinner + "Saving…" text
  - Cancel button disabled
  - Role select dropdown disabled
  - Dialog cannot close via Escape or outside click
- **Expected**: All interactions blocked until save completes

### 6. Focus & Accessibility
- Click edit to open dialog
- **Expected**:
  - Role select receives focus automatically
  - `aria-invalid="true"` set on select when error present
  - `aria-describedby` links select to error message ID
  - Tab key navigates Cancel → "Save" button

---

## Accessibility Audit (Both Dialogs)

**Use `expect` skill to run:**

```
npx expect-cli@latest audit
```

**Checks** (axe-core + IBM Equal Access):
- [ ] No "Critical" or "Serious" violations
- [ ] Form fields have associated labels
- [ ] Error messages linked via `aria-describedby`
- [ ] Buttons have accessible names
- [ ] Dialog focus trap works (focus confined to dialog)
- [ ] AlertDialog (Mark Lost) focus management correct
- [ ] Dialog (Role Edit) focus management correct
- [ ] Color contrast ≥ 4.5:1 for text
- [ ] No keyboard traps

---

## Performance Check

**Use `expect` skill metrics:**

- [ ] No Long Animation Frames (LAF > 50ms)
- [ ] INP < 200ms
- [ ] LCP < 2.5s
- [ ] CLS < 0.1
- [ ] No console errors or warnings during interactions

---

## Console & Network Checks

**Open DevTools (F12) while testing both dialogs:**

- [ ] No JavaScript errors in console
- [ ] No TypeScript compilation warnings
- [ ] PostHog event fired on successful Mark Lost submission
- [ ] No XHR failures or 4xx/5xx responses
- [ ] No missing imports or unresolved symbols

---

## Final Checklist

- [ ] `pnpm tsc --noEmit` passes
- [ ] Mark Lost Dialog: 5A.1–5A.6 all pass
- [ ] Role Edit Dialog: 5B.1–5B.6 all pass
- [ ] Accessibility audit: no critical violations
- [ ] Performance metrics: all within thresholds
- [ ] Console: no errors or warnings
- [ ] PostHog events captured for key actions

---

## How to Run with Expect Skill

When QA time comes, invoke the `expect` skill with this prompt:

```
Use the expect skill to verify Phase 5 (Mark Lost & Role Edit dialogs):

1. Run type check: pnpm tsc --noEmit
2. Open /workspace/closer/meetings/[some-id] and run the Mark Lost Dialog tests (checklist 5A.1–5A.6)
3. Open /workspace/team and run the Role Edit Dialog tests (checklist 5B.1–5B.6)
4. Run accessibility audit for both dialogs
5. Verify performance metrics (LCP, INP, CLS, LAF)
6. Check console for errors
7. Report pass/fail status for each checklist item
```

---

## Implementation Notes (for QA reviewer)

### Zod Import Path: `zod/v3` (not `zod`)

Both Phase 5 files import `z` from `"zod/v3"` instead of `"zod"`. This is required because:

- The project uses `zod@4.3.6` + `@hookform/resolvers@5.2.2`
- `@hookform/resolvers` type declarations import from `zod/v4/core` which expects `_zod.version.minor: 0`
- `import { z } from "zod"` resolves to the Zod 4 "classic" API with `_zod.version.minor: 3` — type mismatch
- `import { z } from "zod/v3"` uses the Zod 3 compatibility layer bundled in Zod 4, which produces schemas with `_def.typeName` matching the `Zod3Type` overload in the resolver

This is a **systemic infrastructure issue** (all phases need this fix, not just Phase 5). Other agents working on Phases 2 and 3 should apply the same fix. The `zod/v3` API has full feature parity for all schema types used in this project (`.object()`, `.string()`, `.max()`, `.optional()`, `.enum()`, `.refine()`, etc.).

### Trim Logic in Mark Lost Submit Handler

The Zod `.transform()` approach from the original plan causes a type mismatch with `zodResolver` (input vs output types differ). Instead, trimming is done inline in the submit handler: `values.reason?.trim() || undefined`. This preserves identical behavior to the original `reason.trim() || undefined` logic.

---

*QA plan derived from Phase 5 acceptance criteria and parallelization strategy.*
