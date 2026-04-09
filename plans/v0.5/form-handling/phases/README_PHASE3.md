# Phase 3 — Invite User Dialog Migration

**Status**: 🟢 Ready for implementation  
**Setup date**: 2026-04-09  
**Target file**: `app/workspace/team/_components/invite-user-dialog.tsx`  
**Execution model**: Parallel with Phases 2, 4, 5 (zero conflicts)

---

## 📋 Documents in This Directory

### For Implementation

1. **`PHASE3_SETUP.md`** ⭐ **START HERE**
   - Quick start guide
   - Dependencies checklist
   - Pre-flight verification
   - Execution path (3A → 3B → 3C → 3D)
   - Completion criteria

2. **`phase3-implementation-guide.md`** (Detailed reference)
   - Pre-implementation checklist
   - Subphase breakdown (3A, 3B, 3C, 3D)
   - Code patterns with examples
   - Skills to invoke (when/why)
   - Complementary docs (AGENTS.md references)
   - Risk mitigation
   - Code review checklist

### For QA (Deferred)

3. **`phase3-qa-verification.md`** (Browser testing)
   - 15 comprehensive test sections
   - Failure criteria (blockers)
   - Pass criteria (completion gates)
   - Accessibility audit (WCAG AA)
   - Performance metrics
   - Responsive viewport testing

### Historical Context

4. **`phase3.md`** (Original design doc)
   - Feature specification
   - Acceptance criteria
   - Detailed subphase breakdowns

---

## 🎯 Phase 3 at a Glance

### What You're Doing

Migrating the **Invite User Dialog** from:
- ❌ 7 `useState` hooks + manual validation
- ❌ Toast-only error feedback

To:
- ✅ React Hook Form + Zod
- ✅ Inline field-level validation errors
- ✅ Conditional field rendering (new pattern!)

### Key Complexity

**Conditional Validation** — Calendly member field is **required only when role === "closer"**

Uses Zod `.superRefine()` to validate across multiple fields and target errors to specific paths:

```typescript
.superRefine((data, ctx) => {
  if (data.role === "closer" && !data.calendlyMemberId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Calendly member is required for Closers",
      path: ["calendlyMemberId"],  // ← Error appears inline below field
    });
  }
})
```

### New Pattern: Watched Fields

Uses `form.watch("role")` to conditionally render the Calendly field:

```typescript
const watchedRole = form.watch("role");

// ... JSX ...
{watchedRole === "closer" && <FormField ... />}
```

When role changes away from "closer", clear the Calendly value to prevent stale submissions.

---

## ⏱️ Timeline

| Subphase | Task | Est. Time | Key Output |
|----------|------|-----------|---|
| **3A** | Define Zod schema with `.superRefine()` | 15 min | `inviteUserSchema` + type |
| **3B** | Setup `useForm` hook + submission handler | 20 min | useForm initialization + logic |
| **3C** | Rewrite JSX with Form* components | 45 min | Full form JSX (conditional field) |
| **3D** | Browser QA (deferred) | — | Signed-off QA checklist |

**Total implementation**: ~90 minutes  
**Total w/ async QA**: ~2 hours (QA runs in parallel)

---

## 🛠️ Skills to Invoke

### During Implementation

1. **After 3B** → `vercel-react-best-practices` skill
   - Verify `form.watch()` re-render optimization
   - Ensure no excess component re-renders

2. **After 3C** → `web-design-guidelines` skill
   - Verify inline error styling (WCAG AA contrast)
   - Check form labels, focus order, accessibility

### During QA (Deferred)

3. **When ready** → `expect` skill
   - Use `phase3-qa-verification.md` checklist
   - Browser verification (Chrome, Firefox, Safari)
   - Responsive testing (mobile, tablet, desktop)
   - Accessibility audit (axe-core)
   - Performance metrics

---

## 📚 Key References

### Codebase Standards (from AGENTS.md)

- **Form Patterns**: RHF + Zod is the new standard (Phase 2 was first, Phase 3 extends it)
- **Testing with Expect**: Browser-based QA tool for verifying changes
- **Next.js Best Practices**: App Router streaming RSC patterns
- **Convex Backend Standards**: Schema validation, function patterns

### Phase 2 Reference Implementation

**File**: `app/workspace/closer/meetings/_components/payment-form-dialog.tsx`

Phase 3 builds on Phase 2's pattern but adds:
- Conditional field visibility (new)
- Cross-field validation (new)
- Watched fields (new)

---

## ✅ Before You Start

### Prerequisites

- [ ] Phase 1 complete (Form components exist)
- [ ] Phase 2 complete (reference implementation available)
- [ ] `pnpm tsc --noEmit` passes
- [ ] `pnpm build` succeeds
- [ ] Current dialog file is readable

### Quick Checks

```bash
# Verify types
pnpm tsc --noEmit

# Verify build
pnpm build

# Verify form components exist
grep -r "export.*FormField" components/ui/form.tsx
```

All should pass ✅

---

## 🚀 Quick Start

1. **Read** `PHASE3_SETUP.md` (this file is a map; PHASE3_SETUP is your entry point)
2. **Open** `phase3-implementation-guide.md` for detailed guidance
3. **Start 3A** — Define Zod schema (follow the step-by-step guide)
4. **Move to 3B** — Setup form hook
5. **Complete 3C** — Rewrite JSX
6. **Verify** — TypeScript + build checks
7. **Defer 3D** — QA runs later when user schedules

---

## 📝 Code Review Checklist

Before marking 3C complete, verify:

- [ ] All 7 old `useState` hooks are gone
- [ ] Only `isSubmitting` + minimal state remains
- [ ] `inviteUserSchema` with `.superRefine()` is correct
- [ ] `useForm` initialized with correct defaults
- [ ] `form.watch("role")` used for conditional rendering
- [ ] All fields use `<FormField>` + `<FormItem>` + etc.
- [ ] Calendly field hidden when `role !== "closer"`
- [ ] Calendly cleared when role changes away from "closer"
- [ ] Submission handler uses pre-validated `values`
- [ ] PostHog event `team_member_invited` captured
- [ ] `pnpm tsc --noEmit` passes
- [ ] `pnpm build` succeeds

---

## 🔀 Parallelization

**Running in parallel with:**
- Phase 2: Payment Form Dialog
- Phase 4: Follow-Up Assessment
- Phase 5: Mark Lost + Role Edit

**File ownership** (zero conflicts):
- Phase 2 owns: `payment-form-dialog.tsx` (different file)
- Phase 3 owns: `invite-user-dialog.tsx` (your target)
- Phase 4 owns: (nothing — read-only assessment)
- Phase 5 owns: `mark-lost-dialog.tsx` + `role-edit-dialog.tsx` (different files)

**Shared import** (read-only):
- All phases import from `components/ui/form.tsx` (created in Phase 1)
- No phase modifies this file

**Merge conflict risk**: **Zero** ✅

---

## 🎓 Learning Resources

### Zod `.superRefine()` Pattern

See `phase3-implementation-guide.md` → **3A — Define Zod Schema** for detailed explanation and code examples.

Key insight: `.superRefine()` allows you to validate based on multiple fields and target errors to specific field paths, enabling inline error messages for conditional fields.

### React Hook Form `.watch()` Pattern

See `phase3-implementation-guide.md` → **3B — Set Up useForm Hook** for how `form.watch("role")` enables conditional field rendering with RHF's built-in re-render optimization.

### Conditional Field Rendering

See `phase3-implementation-guide.md` → **3C — Rewrite JSX** for the pattern of wrapping a FormField in a conditional to hide/show based on other field values.

---

## 📊 Status Dashboard

| Component | Status | Notes |
|-----------|--------|-------|
| **Setup** | ✅ Complete | Documentation, guides, QA plan ready |
| **3A — Schema** | ⏳ Pending | Ready to start |
| **3B — useForm** | ⏳ Pending | Depends on 3A |
| **3C — JSX** | ⏳ Pending | Depends on 3B |
| **3D — QA** | ⏳ Deferred | Runs after code is ready |
| **Integration** | ✅ Verified | Phases 2, 4, 5 can run in parallel |
| **Skills** | ✅ Available | vercel-react-best-practices, web-design-guidelines, expect |

---

## 🆘 Get Help

### If Stuck

1. Check **Execution Path** section in `PHASE3_SETUP.md`
2. Review **Common Issues** section in `PHASE3_SETUP.md`
3. Reference Phase 2 implementation: `app/workspace/closer/meetings/_components/payment-form-dialog.tsx`
4. Read relevant section in `phase3-implementation-guide.md`
5. Check AGENTS.md for codebase standards

### Questions About

- **Zod schemas** → See `phase3-implementation-guide.md` → 3A
- **RHF hooks** → See `phase3-implementation-guide.md` → 3B
- **Form JSX** → See `phase3-implementation-guide.md` → 3C
- **Testing** → See `phase3-qa-verification.md`
- **Codebase standards** → See `AGENTS.md` (Form Patterns, RHF usage)

---

## 🎉 Completion

Phase 3 is complete when:

✅ All 3 code subphases done (3A, 3B, 3C)  
✅ TypeScript passes (`pnpm tsc --noEmit`)  
✅ Build succeeds (`pnpm build`)  
✅ Code review checklist passes  
✅ Ready for browser QA (3D — runs later)  

---

## Next Steps

After Phase 3:

1. **Phase 4** → Follow-Up Dialog Assessment (minimal code, mostly review)
2. **Phase 5** → Mark Lost + Role Edit Migration (2 simple dialogs)
3. **Full Regression** → All 4 migrated dialogs tested together
4. **v0.5 Complete** → All form dialogs modernized

**Why this order?** Phases 4 & 5 are shorter and can complete while Phase 2 (most complex) is still in progress. After all code is done, run full regression testing.

---

## 📖 Document Index

| File | Purpose | Read When |
|------|---------|-----------|
| `PHASE3_SETUP.md` | Quick start guide | **First** — read this |
| `phase3-implementation-guide.md` | Detailed implementation | During coding (reference) |
| `phase3-qa-verification.md` | QA checklist | When ready to test (deferred) |
| `phase3.md` | Original design doc | For context/history |
| `../form-handling-design.md` | Feature specification | For big-picture understanding |
| `../parallelization-strategy.md` | Execution strategy | To understand why phases are parallel-safe |
| `AGENTS.md` | Codebase standards | For form patterns, RHF usage, testing |
| `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` | Reference code | For implementation patterns |

---

Ready? Start with **`PHASE3_SETUP.md`** 🚀
