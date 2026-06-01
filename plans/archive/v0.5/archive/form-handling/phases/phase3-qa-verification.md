# Phase 3 QA Verification Plan — Invite User Dialog Migration

**Purpose**: Comprehensive QA checklist for Phase 3 (Invite User Dialog) before marking complete. Subphases 3A-3C are complete. This file covers subphase 3D (browser verification).

**Execution**: Run with `expect` skill after code changes are ready.

**Implementation notes** (deviations from original plan):
- Uses `standardSchemaResolver` (from `@hookform/resolvers/standard-schema`) instead of `zodResolver` — the Zod-specific resolver has type incompatibilities with Zod v4.3.x (`_zod.version.minor` mismatch). Standard Schema support works natively with Zod v4.
- Zod v4 uses `{ error: "..." }` instead of `{ required_error: "..." }` for `z.enum()` params.
- Zod v4 `.superRefine()` uses `{ code: "custom", ... }` string literal instead of `z.ZodIssueCode.custom`.
- `DialogFooter` component used instead of manual `div` for footer (consistent with codebase patterns).
- `open`/`setOpen` remain as internal `useState` (not props) — matching original component interface.

---

## Verification Scope

- **Component**: `app/workspace/team/_components/invite-user-dialog.tsx`
- **Features tested**: Conditional field visibility, conditional validation (`.superRefine()`), role change side effects, form submission, `form.reset()` on close
- **Browsers**: Chrome, Firefox, Safari (via expect)
- **Viewports**: Desktop (1920x1080), Tablet (768x1024), Mobile (375x667)
- **Accessibility**: WCAG AA compliance via axe-core

---

## QA Checklist

### 1. Code Quality & Type Safety

- [ ] `pnpm tsc --noEmit` passes without errors
- [ ] `pnpm build` succeeds with no warnings related to invite-user-dialog
- [ ] No unused imports or dead code
- [ ] All Zod types inferred correctly (`InviteUserFormValues`)
- [ ] RHF `useForm` initialization is correct with default values
- [ ] No console errors or warnings during component render

### 2. Form Field Rendering

- [ ] Email field renders with:
  - [ ] Label "Email" with required indicator (red asterisk)
  - [ ] Input type="email" with placeholder "user@example.com"
  - [ ] Disabled state during submission
  - [ ] Error message below on validation failure
  
- [ ] First Name field renders with:
  - [ ] Label "First Name" with required indicator
  - [ ] Input type="text" with placeholder "John"
  - [ ] Disabled state during submission
  - [ ] Error message below on validation failure

- [ ] Last Name field renders with:
  - [ ] Label "Last Name" (no required indicator — optional field)
  - [ ] Input type="text" with placeholder "Doe"
  - [ ] Disabled state during submission

- [ ] Role field renders with:
  - [ ] Label "Role" with required indicator
  - [ ] Select dropdown with two options: "Closer" and "Admin"
  - [ ] Disabled state during submission
  - [ ] Error message below on validation failure

- [ ] Calendly Member field (conditional):
  - [ ] **Visible by default** when dialog first opens (default role is "closer")
  - [ ] **Disappears** when role changes to "Admin"
  - [ ] **Reappears** when role is set back to "Closer"
  - [ ] Select trigger disabled while `unmatchedMembers` query is loading
  - [ ] Lists all unmatched Calendly members from the query
  - [ ] Shows helper text: "Only unmatched Calendly members are shown" (via `<FormDescription>`)

### 3. Inline Validation (Non-Conditional)

**Test**: Clear the email and first name fields, then submit

- [ ] Email field shows error: "Email is required"
- [ ] First Name field shows error: "First name is required"
- [ ] Role field: no error (default value is "closer", so it's already valid)
- [ ] Errors appear **inline below the field**, not in a toast
- [ ] Calendly Member field shows error: "Calendly member is required for Closers" (visible because default role is "closer")

**Test**: Submit with invalid email format

- [ ] Email field shows error: "Please enter a valid email address"
- [ ] Other fields pass validation

**Test**: Fill First Name and Last Name, leave Email and Role empty

- [ ] Email field shows error: "Email is required"
- [ ] First Name field has no error
- [ ] Last Name field has no error
- [ ] Role field shows error: "Please select a role"

### 4. Conditional Field Visibility

**Test sequence**: Open dialog → Test conditional rendering

1. [ ] Dialog opens with Calendly Member field **visible** (default role is "closer")
2. [ ] Verify Calendly field has label with required indicator (red asterisk)
3. [ ] Verify Select trigger shows placeholder "Select a Calendly member"
4. [ ] Change role to **"Admin"** → Calendly Member field **disappears**
5. [ ] Change role back to **"Closer"** → Calendly Member field **reappears**
6. [ ] Change role to **"Admin"** again → field **disappears** (no animation glitch)
7. [ ] Change role to **"Closer"** once more → field is **empty** (previous selection was cleared)

**Viewport testing**: Repeat conditional visibility on mobile (375px) and tablet (768px) — field should appear/disappear smoothly on all sizes.

### 5. Conditional Validation (superRefine Pattern)

**Test**: Role = "Closer", no Calendly member selected, submit

- [ ] Calendly Member field shows error: "Calendly member is required for Closers"
- [ ] Error appears **inline below the Select**, not in a toast
- [ ] Form does **not** submit
- [ ] Button remains in submit state (spinner shows briefly, then resets)

**Test**: Role = "Closer", select a Calendly member, submit

- [ ] Calendly Member field error **disappears**
- [ ] Form is now valid and can submit

**Test**: Role = "Admin", no Calendly selection, submit

- [ ] Calendly Member field: **no error** (field is hidden, not required for Admin)
- [ ] Form can submit (assuming other fields are valid)

### 6. Role Change Side Effects (Clearing Calendly)

**Test**: Select Calendly member, then change role

1. [ ] Select role: **"Closer"**
2. [ ] Verify Calendly field appears
3. [ ] Select a Calendly member from the dropdown (verify it's selected in the trigger)
4. [ ] Change role to **"Admin"**
5. [ ] Calendly field **disappears**
6. [ ] Change role back to **"Closer"**
7. [ ] Calendly field **reappears** with **empty value** (previous selection was cleared)
8. [ ] Verify form state is clean — no stale Calendly value in `form.getValues()`

### 7. Form Submission Success Flow

**Test**: Fill all required fields and submit

1. [ ] Email: `test-closer@example.com`
2. [ ] First Name: `Jane`
3. [ ] Last Name: (optional — leave blank or fill)
4. [ ] Role: `Closer`
5. [ ] Calendly Member: Select one from list
6. [ ] Click "Invite" button
7. [ ] Button shows **spinner + "Inviting..." text**
8. [ ] Dialog remains open during submission
9. [ ] On success:
   - [ ] Dialog **closes**
   - [ ] Form **resets** (all fields empty)
   - [ ] Success toast appears: "User invited successfully"
   - [ ] PostHog event `team_member_invited` is captured with:
     - [ ] `role: "closer"`
     - [ ] `has_calendly_member: true`

### 8. Form Submission Error Flow

**Test**: Trigger a server error (e.g., duplicate email invitation)

- [ ] Button shows **spinner + "Inviting..." text**
- [ ] On error:
  - [ ] Dialog **remains open**
  - [ ] Button reverts to normal state
  - [ ] Error toast appears with error message
  - [ ] Form is still editable (user can retry)
  - [ ] PostHog event `posthog.captureException(error)` is logged

### 9. Dialog Open/Close Behavior

**Test**: Open dialog, fill data, click Cancel

- [ ] Cancel button is enabled during submission
- [ ] Clicking Cancel:
  - [ ] Dialog closes
  - [ ] Form resets on next open

**Test**: Open dialog, fill data, close via X button

- [ ] Dialog X button is clickable
- [ ] Clicking X:
  - [ ] Dialog closes
  - [ ] Form resets on next open

**Test**: Open dialog, fill data, start submission, click Cancel

- [ ] Cancel button is **disabled during submission** (cannot interrupt)
- [ ] Submission completes
- [ ] After submission, dialog closes automatically

### 10. Accessibility Audit

Run `expect` accessibility audit:

- [ ] **Form labels**: All inputs have associated labels via `<label htmlFor="...">`
- [ ] **Error announcements**: Error messages are announced by screen readers when they appear/disappear
- [ ] **Focus order**: Tab order is logical:
  1. Email input
  2. First Name input
  3. Last Name input
  4. Role select
  5. Calendly Member select (when visible)
  6. Cancel button
  7. Invite button
- [ ] **Screen reader on role change**: When Calendly field appears/disappears, screen readers announce the change
- [ ] **Color contrast**: 
  - [ ] Error text (red) meets WCAG AA contrast ratio vs. background
  - [ ] Required indicator (red asterisk) meets WCAG AA contrast
  - [ ] All text content meets WCAG AA
- [ ] **Keyboard navigation**: All interactive elements are reachable and operable via keyboard
- [ ] **ARIA attributes**: Required fields have `aria-required="true"` or similar (check shadcn Form implementation)
- [ ] **Dialog role**: `<DialogContent>` has proper `role="dialog"` and `aria-labelledby` pointing to `<DialogTitle>`

### 11. Performance Metrics

Run `expect` performance audit:

- [ ] **Long Animation Frames**: None detected during form interaction
- [ ] **Interaction to Next Paint (INP)**: < 200ms for form field changes
- [ ] **Largest Contentful Paint (LCP)**: < 2.5s
- [ ] **Cumulative Layout Shift (CLS)**: < 0.1 when Calendly field appears/disappears
- [ ] **Bundle impact**: No significant size increase from RHF + Zod imports
- [ ] **Form re-render optimization**: `form.watch("role")` only triggers re-render of conditional field, not entire form

### 12. Browser Compatibility

Test across multiple browsers (via expect):

- [ ] Chrome (latest)
- [ ] Firefox (latest)
- [ ] Safari (latest)

**Per-browser checks**:
- [ ] Form renders correctly
- [ ] Select dropdowns work (especially important for Safari Select styling)
- [ ] Conditional field visibility works
- [ ] Form submission works
- [ ] No console errors

### 13. Mobile/Responsive Testing

Test on mobile (375px) and tablet (768px) viewports:

- [ ] Dialog content is readable and not truncated
- [ ] Labels and inputs are properly sized
- [ ] Select dropdowns open and close correctly
- [ ] Conditional Calendly field appears/disappears smoothly
- [ ] Buttons are tappable (48px+ height)
- [ ] No horizontal scrolling
- [ ] Error messages are readable (not cut off)

### 14. Integration with Convex & PostHog

- [ ] Convex mutation `api.workos.userManagement.inviteUser` is called with correct arguments:
  - [ ] `email` (string)
  - [ ] `firstName` (string)
  - [ ] `lastName` (optional string)
  - [ ] `role` (enum: "closer" | "tenant_admin")
  - [ ] `calendlyMemberId` (optional string, only when role === "closer")
- [ ] PostHog event `team_member_invited` includes:
  - [ ] `role` field
  - [ ] `has_calendly_member` boolean flag
- [ ] Error capture: `posthog.captureException(error)` is called on submission failure

### 15. Data Integrity

**Test**: Verify form validation matches Zod schema

- [ ] Valid email patterns are accepted
- [ ] Invalid email patterns are rejected
- [ ] Empty email is rejected
- [ ] Empty firstName is rejected
- [ ] lastName can be empty (optional)
- [ ] role must be one of: "closer", "tenant_admin"
- [ ] calendlyMemberId is required only when role === "closer"

**Test**: Verify no stale state after multiple submissions

1. [ ] Submit with role "Closer" + Calendly member
2. [ ] On success, dialog closes and form resets
3. [ ] Reopen dialog — form should be completely empty
4. [ ] Select role "Admin" (no Calendly field)
5. [ ] Submit — should not include stale Calendly data

---

## Failure Criteria (Block Phase Completion)

- [ ] ❌ TypeScript errors (`pnpm tsc --noEmit` fails)
- [ ] ❌ Build fails (`pnpm build` fails)
- [ ] ❌ Conditional Calendly field doesn't appear/disappear on role change
- [ ] ❌ Conditional validation error doesn't appear inline under Calendly field
- [ ] ❌ Form submits without Calendly member when role === "closer" (validation bypass)
- [ ] ❌ Focus trap breaks in modal
- [ ] ❌ WCAG AA accessibility audit failures (contrast, labels, focus order)
- [ ] ❌ Form doesn't reset after successful submission
- [ ] ❌ Dialog doesn't close after successful submission
- [ ] ❌ PostHog event not captured or missing data
- [ ] ❌ Console errors during form interaction

---

## Pass Criteria (Phase 3 Complete)

✅ All 15 checklist sections pass  
✅ No failure criteria triggered  
✅ Accessibility audit (WCAG AA) passes  
✅ Performance metrics meet targets (INP < 200ms, CLS < 0.1)  
✅ All browsers tested successfully  
✅ Mobile/tablet responsive testing passes  
✅ Integration with Convex and PostHog verified  

---

## Notes for QA Agent

- Start with **code quality checks** (TS, build) — these are gates to proceed
- Then test **field rendering and basic validation** — ensure form layout is correct
- Then test **conditional logic** — the core new pattern in Phase 3
- Then test **submission and side effects** — ensure data flows correctly to backend
- Finally test **accessibility and performance** — cross-cutting concerns
- Document any deviations from this plan and escalate to developer
- Use `expect` MCP tools: `open`, `playwright`, `screenshot`, `accessibility_audit`, `performance_metrics`, `console_logs`, `network_requests`

---

## Commands to Run (for reference)

```bash
# Type check
pnpm tsc --noEmit

# Build
pnpm build

# Dev server (for browser testing)
pnpm dev

# Run expect verification
# (invoke via Skill tool with this file as context)
```

---

## Linked Files

- **Implementation**: `app/workspace/team/_components/invite-user-dialog.tsx`
- **Form Schema**: Defined in same file (3A)
- **useForm Setup**: Defined in same file (3B)
- **JSX Rewrite**: Defined in same file (3C)
- **Design Doc**: `plans/v0.5/form-handling/form-handling-design.md`
- **Phase Plan**: `plans/v0.5/form-handling/phases/phase3.md`
- **Parallelization**: `plans/v0.5/form-handling/phases/parallelization-strategy.md`
