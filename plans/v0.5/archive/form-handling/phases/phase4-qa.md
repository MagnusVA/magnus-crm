# Phase 4 QA Checklist — Follow-Up Dialog Regression Verification

**Status**: DEFERRED — Execute only after Phases 2, 3, and 5 are merged to main.

**Purpose**: Verify that the Follow-Up Dialog (`follow-up-dialog.tsx`) remains fully functional and unchanged after the form-handling migrations in other phases.

**Duration**: ~20 minutes

**Skills to Invoke**:
- `expect` — Browser verification + accessibility audit + console error check + performance metrics

---

## Pre-QA Gate

**Trigger condition (must all be true)**:
- [ ] Phase 1 complete (infrastructure: RHF + Zod installed, shadcn Form component added, next.config.ts updated)
- [ ] Phase 2 complete (Payment Form Dialog migrated to RHF + Zod)
- [ ] Phase 3 complete (Invite User Dialog migrated with conditional validation)
- [ ] Phase 5 complete (Mark Lost & Role Edit dialogs migrated)
- [ ] All phases merged to `main` branch
- [ ] `pnpm install` and `pnpm build` succeed locally

**If any gate fails**: Do not proceed. Notify the team and wait for blocking phases to complete.

---

## QA Step 1: Type Check (No Code Changes Expected)

**Duration**: ~2 minutes

**Command**:
```bash
pnpm tsc --noEmit
```

**Expected result**: Zero TypeScript errors.

**If it fails**: Check for import errors in other phases (Phases 2, 3, 5 may have accidentally modified a shared file). Run `git diff` to identify the conflict.

---

## QA Step 2: Git Diff Verification (No Changes to Follow-Up Dialog)

**Duration**: ~1 minute

**Command**:
```bash
git diff HEAD -- app/workspace/closer/meetings/_components/follow-up-dialog.tsx
```

**Expected result**: Empty output (no changes to this file).

**If it fails**: A change was made to the follow-up dialog during another phase. Investigate the diff and revert if unintentional.

---

## QA Step 3: Browser Verification with Expect Skill

**Duration**: ~15 minutes

**Instructions**:

1. **Invoke the `expect` skill** with the following context:
   - **Goal**: Regression test the Follow-Up Dialog after form-handling migrations
   - **Route to test**: `/workspace/closer/meetings/[meetingId]` (substitute a real meeting ID from the test tenant)
   - **Test scenario**: Open the Follow-Up Dialog and verify the complete workflow

2. **Expect will**:
   - Open a headed browser
   - Navigate to the follow-up dialog route
   - Take screenshots and perform accessibility audits
   - Check console logs for errors
   - Report performance metrics (LCP, INP, CLS, etc.)

3. **Manual verification steps** (if expect tool is unavailable, perform these manually):

   **Step 3a: Dialog Visibility & Initial State**
   - [ ] Navigate to `/workspace/closer/meetings/[meetingId]` as an authenticated closer
   - [ ] Locate the "Schedule Follow-up" button
   - [ ] Click it — dialog opens in **idle state** (button text shows "Generate Link")
   - [ ] Dialog title, description, and "Generate Link" button are visible and readable

   **Step 3b: Generate Workflow**
   - [ ] Click "Generate Link" → loading spinner appears (1–2 seconds)
   - [ ] Spinner replaced by success state showing a booking URL in read-only `<InputGroupInput>`
   - [ ] "Copy" button is visible and enabled
   - [ ] "Generate Link" button is now "Retry" (in case of manual error)

   **Step 3c: Copy to Clipboard**
   - [ ] Click "Copy" button → text copies to clipboard
   - [ ] Button text changes to "Copied!" (visual feedback)
   - [ ] After ~2 seconds, button text reverts to "Copy"

   **Step 3d: Dialog Reopen (State Reset)**
   - [ ] Close the dialog (via X button or Escape key)
   - [ ] Reopen the dialog → back to **idle state** (not stale success/error)
   - [ ] "Generate Link" button is present
   - [ ] No lingering booking URL or "Copied!" state

   **Step 3e: Error Handling (Optional – if testable)**
   - [ ] If possible, trigger an error condition (e.g., disable network, corrupt Convex call)
   - [ ] Dialog should show error state with "Retry" button
   - [ ] Click "Retry" → returns to loading → success or error again

4. **Expect accessibility audit**:
   - [ ] Run axe-core accessibility check on the dialog
   - [ ] Verify WCAG 2.1 Level AA compliance
   - [ ] Check for missing alt text, button labels, focus management
   - [ ] Dialog focus trap works (Tab/Shift+Tab confined to dialog)

5. **Expect performance metrics**:
   - [ ] **LCP** (Largest Contentful Paint): ≤2.5s
   - [ ] **INP** (Interaction to Next Paint): ≤200ms (button clicks are snappy)
   - [ ] **CLS** (Cumulative Layout Shift): ≤0.1 (no jank when generating/copying)
   - [ ] **Long Animation Frames (LAF)**: ≤50ms (smooth loading spinner)

6. **Expect console error check**:
   - [ ] No JavaScript errors logged to console
   - [ ] No warnings related to Convex subscriptions, imports, or form libraries
   - [ ] No deprecation notices

---

## QA Step 4: Cross-Dialog Verification (Spot Check)

**Duration**: ~5 minutes (optional, but recommended)

**Why**: Other phases modified import statements (removed `Field`/`FieldLabel`, added `Form`/`FormField`). If a shared utility was accidentally broken, this check catches it.

**Spot check**:

1. **Payment Form Dialog** (Phase 2):
   - [ ] Navigate to `/workspace/closer/meetings/[meetingId]`
   - [ ] Click "Record Payment" → dialog opens
   - [ ] Form fields render correctly (no layout broken)
   - [ ] Inline validation errors appear when submitting empty form

2. **Invite User Dialog** (Phase 3):
   - [ ] Navigate to `/workspace/team`
   - [ ] Click "Invite Member" → dialog opens
   - [ ] Role dropdown works; conditional Calendly field appears when "closer" is selected
   - [ ] Form submission succeeds with valid data

3. **Mark Lost Dialog** (Phase 5):
   - [ ] Navigate to `/workspace/closer/pipeline`
   - [ ] Click on an opportunity, then "Mark as Lost" → dialog opens
   - [ ] 500-character limit on notes shows inline error when exceeded
   - [ ] Submit succeeds with valid data

---

## QA Step 5: Final Sign-Off

**Duration**: ~1 minute

**Checklist**:

- [ ] Type check passed (`pnpm tsc --noEmit`)
- [ ] Git diff shows zero changes to `follow-up-dialog.tsx`
- [ ] Dialog opens and closes correctly
- [ ] Idle → Generate → Success → Copy workflow works
- [ ] Dialog state resets on reopen
- [ ] Accessibility audit passed (WCAG 2.1 AA)
- [ ] Performance metrics healthy (LCP ≤2.5s, INP ≤200ms, CLS ≤0.1)
- [ ] Console is clean (no errors/warnings)
- [ ] Cross-dialog spot check passed (no regressions in Phases 2, 3, 5)

**Sign-off**: If all boxes are checked, Phase 4 QA is complete. Document the results and close the feature.

---

## Troubleshooting

| Issue | Cause | Resolution |
|-------|-------|-----------|
| Type check fails with import errors | Another phase modified a shared file | Run `git diff --name-only | grep -v follow-up` to find the culprit; investigate if unintended |
| Dialog does not open | Page route incorrect or test tenant has no meetings | Verify the test meeting ID exists; check browser console for errors |
| Loading spinner never appears | Convex action not called or endpoint down | Check network tab in DevTools; verify Convex deployment is healthy |
| "Copy" button doesn't copy | Browser clipboard API blocked by HTTPS requirement | Ensure localhost or HTTPS context; check browser console for security warnings |
| Dialog state not reset on reopen | `useState` cleanup logic broken in other phases | Check if `useEffect` cleanup or dialog `onOpenChange` callbacks were accidentally modified |
| Accessibility audit fails | Invalid HTML or missing ARIA in other phases | Fix the specific accessibility violation (e.g., missing `aria-label` on button) |
| Performance slow (LCP >2.5s) | Large bundle or unoptimized images in other phases | Check if Phase 1's `optimizePackageImports` was applied correctly; profile with DevTools |

---

## Notes

- **No code changes expected for Phase 4**: This file is verification-only. If you find issues with the follow-up dialog itself, they likely stem from unintended changes in Phases 2, 3, or 5.
- **Expect skill integration**: When possible, use the `expect` skill for full browser automation, accessibility auditing, and performance metrics. Manual verification is a fallback.
- **Future scope**: The v0.5 Phase 4 (Follow-Up & Rescheduling Overhaul) will redesign this dialog with a "Set Reminder" form using RHF + Zod. This QA confirms the baseline functionality is preserved.

---

*This QA checklist is executed as the final gate for the Form Handling Modernization feature (v0.5). Run it after Phases 2, 3, and 5 are merged to main.*
