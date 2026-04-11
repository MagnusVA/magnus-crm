# Phase 3 Setup — Ready for Implementation

**Status**: ✅ Setup complete  
**Date**: 2026-04-09  
**Parallelization Window**: Window 2 (Full parallelism with Phases 2, 4, 5)

---

## Quick Start

You are starting **Phase 3 — Invite User Dialog Migration** in parallel with:
- Phase 2 (Payment Form Dialog) — another developer/agent
- Phase 4 (Follow-Up Assessment) — another developer/agent  
- Phase 5 (Mark Lost + Role Edit) — another developer/agent

**Target file**: `app/workspace/team/_components/invite-user-dialog.tsx`

**Your scope**: 3 coding subphases (3A → 3B → 3C) + 1 deferred QA phase (3D)

**Estimated time**: ~90 minutes coding + async browser QA (deferred)

---

## What's Prepared for You

### 1. Implementation Guide
**File**: `phase3-implementation-guide.md`

Complete guide including:
- Pre-implementation checklist ✅
- All required imports and dependencies ✅
- Subphase-by-subphase instructions (3A → 3B → 3C → 3D) ✅
- Key patterns with code examples ✅
- When/how to invoke complementary skills ✅
- Risk mitigation strategies ✅
- Code review checklist ✅
- References to codebase standards ✅

### 2. QA Verification Plan
**File**: `phase3-qa-verification.md`

Ready-to-execute browser QA checklist with:
- 15 comprehensive test sections
- Field rendering expectations
- Conditional logic tests (the heart of Phase 3)
- Submission flow validation
- Accessibility audit (WCAG AA)
- Performance metrics targets
- Failure criteria (blockers)
- Pass criteria (completion gates)
- Responsive viewport testing
- Commands to run

### 3. Memory Documentation
**File**: `.claude/projects/.../memory/form_handling_phase3_setup.md`

Persists across sessions:
- Phase 3 overview
- Key files created
- Subphase breakdown
- Skills to invoke
- Dependencies verified
- Risk mitigation
- Parallelization notes
- Code patterns reference
- QA verification strategy

---

## Phase 3 at a Glance

### Subphases

| Phase | Task | Time | Key Complexity |
|-------|------|------|---|
| **3A** | Zod schema with `.superRefine()` | 15 min | Cross-field validation with error targeting |
| **3B** | useForm + `form.watch("role")` | 20 min | Watched fields for conditional rendering |
| **3C** | JSX rewrite with Form* components | 45 min | Conditional field visibility + clearing logic |
| **3D** | Browser QA (deferred) | — | Comprehensive accessibility + performance audit |

### Key New Patterns (vs. Phase 2 reference)

| Aspect | Phase 2 (Reference) | Phase 3 (Your Phase) |
|--------|---|---|
| Schema | Simple field validation | Cross-field with `.superRefine()` |
| State | No watched fields | `form.watch("role")` for conditionals |
| Fields | All always present | Calendly field shown only for "closer" role |
| Validation | Per-field | Cross-field: Calendly required when role=closer |
| UX | Static form | Dynamic conditional field visibility |

### Skills to Invoke

1. **After 3B** → `vercel-react-best-practices` skill
   - Verify `form.watch()` re-render optimization

2. **After 3C** → `web-design-guidelines` skill
   - Verify WCAG AA color contrast, labels, focus order

3. **After 3C code ready** → Setup expect QA execution
   - Deferred until user runs QA (will use `phase3-qa-verification.md`)

---

## Before You Start

### Dependencies Met

- ✅ Phase 1 complete: Form components exist (`components/ui/form.tsx`)
- ✅ Phase 2 complete: Payment Form is reference implementation
- ✅ Packages installed: `react-hook-form`, `@hookform/resolvers`, `zod`
- ✅ Convex setup ready: `api.calendly.getUnmatchedCalendlyMembers` query available
- ✅ Mutation signature verified: `api.workos.userManagement.inviteUser`

### Pre-Flight Checks

```bash
# Type check
pnpm tsc --noEmit

# Build (quick)
pnpm build

# Dev server (for manual testing if needed)
pnpm dev
```

All should pass before you start Phase 3 coding.

---

## Execution Path (Your Scope)

### Subphase 3A (15 min)
1. Open `app/workspace/team/_components/invite-user-dialog.tsx`
2. Define `inviteUserSchema` using Zod
3. Use `.superRefine()` for conditional Calendly validation
4. Infer `InviteUserFormValues` type
5. Verify: `pnpm tsc --noEmit` (no errors)

**Reference**: See `phase3-implementation-guide.md`, section "3A — Define Zod Schema"

### Subphase 3B (20 min)
1. Import `useForm`, `zodResolver`
2. Initialize form with `useForm<InviteUserFormValues>()`
3. Add `const watchedRole = form.watch("role")`
4. Rewrite submission handler (`onSubmit`)
5. Verify: `pnpm tsc --noEmit` (no errors)

**Reference**: See `phase3-implementation-guide.md`, section "3B — Set Up useForm Hook"

### Subphase 3C (45 min)
1. Replace JSX with `<Form {...form}>` wrapper
2. Rewrite all fields using `<FormField>` + `<FormItem>` + etc.
3. Add conditional Calendly field: `{watchedRole === "closer" && <FormField ...>}`
4. Add role change side effect: clear Calendly when role changes away from "closer"
5. Verify: `pnpm tsc --noEmit` and `pnpm build` succeed

**Reference**: See `phase3-implementation-guide.md`, section "3C — Rewrite JSX"

### Subphase 3D (Deferred)
Browser QA verification — skip for now, execute when user schedules it.

**Reference**: See `phase3-qa-verification.md` for full checklist

---

## Code Review Before Marking 3C Complete

Verify:

- ✅ All 7 old `useState` hooks removed
- ✅ Only `isSubmitting` (+ minimal necessary local state) remains
- ✅ `inviteUserSchema` with `.superRefine()` defined correctly
- ✅ `useForm` initialized with correct default values
- ✅ `form.watch("role")` used to conditionally render Calendly field
- ✅ All fields use `<FormField>` + `<FormItem>` + `<FormLabel>` + `<FormControl>` + `<FormMessage>`
- ✅ Calendly field hidden when `role !== "closer"`
- ✅ Calendly field cleared when role changes away from "closer"
- ✅ `onSubmit` uses pre-validated `values` (no re-validation)
- ✅ PostHog event `team_member_invited` captured with `role` + `has_calendly_member`
- ✅ No console errors during manual testing
- ✅ `pnpm tsc --noEmit` passes
- ✅ `pnpm build` passes

---

## Parallelization Notes

**Zero conflicts with other phases:**

- Phase 2 modifies: `app/workspace/closer/meetings/_components/payment-form-dialog.tsx`
- Phase 3 modifies: `app/workspace/team/_components/invite-user-dialog.tsx` (your scope)
- Phase 4 modifies: (nothing — read-only assessment)
- Phase 5 modifies: `mark-lost-dialog.tsx` + `role-edit-dialog.tsx`

**Shared dependency (read-only)**:
- All phases import from `components/ui/form.tsx` (created in Phase 1)
- No modifications to this file by Phases 2–5

**Merge conflict risk**: **Zero** ✅

---

## If You Get Stuck

### Common Issues & Solutions

**Issue**: "Calendly field doesn't show up when role = 'closer'"
- Check: `form.watch("role")` is defined correctly
- Check: Conditional JSX is `{watchedRole === "closer" && <FormField ...>}`
- Check: No typo in role enum value

**Issue**: "Calendly error doesn't appear inline"
- Check: Using `.superRefine()` (not `.refine()`)
- Check: `path: ["calendlyMemberId"]` is in the `ctx.addIssue()` call
- Check: `<FormMessage />` component is present in the Calendly field

**Issue**: "Form submits even with missing Calendly"
- Check: `.superRefine()` validation logic is correct
- Check: Zod schema is passed to `zodResolver`
- Check: `form.handleSubmit(onSubmit)` is on the `<form>` element

**Issue**: "TypeScript errors in onSubmit"
- Check: `values` parameter is typed as `InviteUserFormValues`
- Check: `inviteUserSchema` type inference is correct (`z.infer<>`)

### Resources

1. **React Hook Form docs**: https://react-hook-form.com/form-builder
2. **Zod superRefine**: https://zod.dev/?id=superrefine
3. **Phase 2 reference code**: `app/workspace/closer/meetings/_components/payment-form-dialog.tsx`
4. **shadcn Form guide**: `components/ui/form.tsx` (source of truth)
5. **AGENTS.md Form Patterns**: Codebase standard for form architecture

---

## Completion Criteria

✅ All 3 code subphases (3A, 3B, 3C) complete  
✅ `pnpm tsc --noEmit` passes  
✅ `pnpm build` succeeds  
✅ Manual smoke test shows:
  - Form renders without errors
  - Calendly field appears when role = "closer"
  - Calendly field disappears when role = "admin"
  - Inline validation errors show up
✅ Code passes review checklist above  
✅ Ready for browser QA (3D, deferred)

---

## What Comes Next

Once Phase 3 is code-complete:

1. **Phase 4** starts (Follow-Up Dialog assessment — minimal code)
2. **Phase 5** continues (Mark Lost + Role Edit — 2 simple dialogs)
3. **All phases complete** → Full regression testing
4. **Quality gates** → Accessibility + performance audit on all 4 dialogs
5. **v0.5 complete** → All form dialogs migrated

---

## Files to Reference During Implementation

| File | Purpose |
|------|---------|
| `phase3-implementation-guide.md` | Your main implementation reference |
| `phase3-qa-verification.md` | QA checklist (for later execution) |
| `../phase3.md` | Original phase design doc |
| `../form-handling-design.md` | Full feature specification |
| `../parallelization-strategy.md` | Why phases are parallel-safe |
| `AGENTS.md` | Codebase standards (Form Patterns, RHF usage) |
| `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` | Reference implementation |

---

## Ready?

You have:
- ✅ Implementation guide (phase3-implementation-guide.md)
- ✅ QA plan (phase3-qa-verification.md)
- ✅ Skills references (vercel-react-best-practices, web-design-guidelines, expect)
- ✅ Memory notes (persisted for future sessions)
- ✅ Code patterns and examples
- ✅ Risk mitigation strategies
- ✅ Parallelization assurance (zero conflicts)

**Start with 3A** — define the Zod schema. See `phase3-implementation-guide.md` for detailed walkthrough.

Good luck! 🚀
