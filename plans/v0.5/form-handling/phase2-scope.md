# Phase 2 Implementation Scope — Payment Form Dialog Migration

**Status**: Starting parallelization window 2
**Agent Role**: Phase 2 Solo Implementation (Payment Form Dialog)
**Started**: 2026-04-09

---

## Executive Summary

Migrate `payment-form-dialog.tsx` from 8 `useState` hooks + manual validation to **React Hook Form (RHF) + Zod** with inline field-level errors. This is the reference implementation that validates the form pattern before Phases 3, 4, 5 are merged.

**Current state**: 8 useState hooks + manual validation in `handleSubmit`
**Target state**: 1 `useForm` hook (RHF) + 2 remaining useState (`open`, `isSubmitting`) + 1 new (`submitError`) + Zod schema
**File**: `app/workspace/closer/meetings/_components/payment-form-dialog.tsx`
**Complexity**: Medium-High (file upload, Convex integration, conditional validation)
**Estimated time**: 3–4 hours

---

## Subphase Breakdown

### 2A — Define Zod Schema
- Add `z` import and validation constants
- Define `paymentFormSchema` with 5 fields: `amount`, `currency`, `provider`, `referenceCode`, `proofFile`
- File validation rules: `.refine()` for size (10 MB) and type (JPEG, PNG, GIF, PDF)
- Export `PaymentFormValues` type via `z.infer<>`
- Verify: `pnpm tsc --noEmit` passes

### 2B — Set Up useForm Hook and Submission Handler
- Import `useForm` and `zodResolver`
- Replace 8 `useState` with 1 `useForm()` call
- Keep `open`, `isSubmitting`, `submitError` state (3 total)
- Rewrite `onSubmit` to receive pre-validated `values: PaymentFormValues`
- Remove inline validation checks (Zod handles this now)
- Verify: `pnpm tsc --noEmit` passes

### 2C — Rewrite JSX with Form Components
- Import shadcn Form components: `Form`, `FormField`, `FormItem`, `FormLabel`, `FormControl`, `FormMessage`, `FormDescription`
- Wrap entire form in `<Form {...form}>`
- Replace each `<Field>` + manual state with `<FormField control={form.control} name="...">`
- Use `<FormMessage />` for inline errors (auto-populated by RHF)
- Keep `<FieldGroup>` for layout (CSS-only, no logic changes)
- Keep `<Alert>` for submission-level errors (separate from field validation)
- Handle file input special case: destructure `{ value, onChange }` (can't set value programmatically)
- Verify: `pnpm build` and `pnpm tsc --noEmit` pass

### 2D — Browser Verification (QA — Deferred)
- **To be done later** as a QA step (see `phase2-qa.md`)
- Uses `expect` skill for accessibility audit, performance metrics, console error check
- Browser testing of inline errors, file upload, submission flow

---

## Key Implementation Decisions

| Decision | Why | Impact |
|---|---|---|
| Amount as `z.string()` not `z.number()` | HTML number inputs return strings via `.value`; `.refine()` parses and validates | Clear error messages for invalid input |
| File validation in Zod schema (`.refine()`) | Centralized validation logic; errors appear inline via `<FormMessage>` | No custom `handleFileChange` needed |
| Keep `isSubmitting` + add `submitError` state | RHF manages field validation; but runtime errors (network, Convex) need separate handling | Submission-level errors show in `<Alert>` (not inline) |
| `onOpenChange` checks `!isSubmitting` | Prevent closing dialog mid-submission | User can't accidentally cancel upload/mutation |
| `form.reset()` on dialog close | Clears form state for next open | Form starts fresh (including file input) |
| File input pattern: `{ value, onChange, ...fieldProps }` | Security restriction: file inputs can't be set programmatically | Pattern handles both reading selected file and clearing on reset |

---

## Skills & Documentation Rules

### Required Skills (from Phase 2 design doc)

1. **vercel-react-best-practices**
   - Verify RHF doesn't conflict with Convex subscriptions (`useQuery` / `useMutation`)
   - Ensure minimal re-renders when watching form values (`form.watch()`)
   - Optimization: prefer `useWatch()` over `form.watch()` if performance issues arise

2. **web-design-guidelines**
   - WCAG compliance of inline error messages: color contrast, `aria-invalid`, `aria-describedby`
   - Focus management when errors appear
   - Screen reader announcements for validation errors

3. **expect** (deferred to QA phase)
   - Browser verification of inline errors, file upload, accessibility
   - Performance metrics (INP < 200ms)
   - No console errors related to RHF, Zod, Form components

### Complementary Skills (from codebase)

- **next-best-practices**: Verify `"use client"` directive, import sources, tree-shaking for Zod
- **simplify**: After code generation, review for redundancy and efficiency

---

## Reference Materials

### Local Docs
- `.docs/convex/nextjs.md` — Convex + Next.js patterns (preload, fetch, mutations)
- `.docs/convex/module-nextjs.md` — Convex module patterns

### Existing Patterns in Codebase
- Form layout: `<FieldGroup>` + `<Field>` (CSS-only, no logic)
- Dialog pattern: `Dialog` + `DialogTrigger` + `DialogContent` + `DialogFooter`
- Error handling: `try/catch` → `setSubmitError` → `<Alert variant="destructive">`
- Toast feedback: `toast.error()`, `toast.success()` from `sonner`
- PostHog tracking: `posthog.capture()` for user actions, `posthog.captureException()` for errors
- Convex mutations: `useMutation(api.*)` for file upload + payment logging

### RHF + Zod Patterns (New to Codebase)
- Zod schema co-located in dialog file (not extracted to shared lib yet)
- `useForm(resolver: zodResolver(schema), defaultValues: {...})`
- `form.handleSubmit(onSubmit)` prevents submission if validation fails
- `<FormField control={form.control} name="field">` connects field to form state
- `<FormMessage />` auto-reads error state from RHF
- File input handling: destructure `{ value, onChange }`, manually pass `onChange`

---

## Acceptance Criteria (from design doc)

1. ✅ All 8 `useState` hooks replaced with 1 `useForm` + 3 remaining `useState` (`open`, `isSubmitting`, `submitError`)
2. ✅ `paymentFormSchema` Zod schema defined in same file, validates all 5 fields
3. ✅ All fields render via `<FormField>` + `<FormItem>` + `<FormLabel>` + `<FormControl>` + `<FormMessage>`
4. ✅ File upload validation in Zod schema; errors appear inline via `<FormMessage>`
5. ✅ Submission-level errors (network, Convex) display in `<Alert variant="destructive">` above submit button
6. ✅ On success: `setOpen(false)`, `form.reset()`, toast, PostHog event, `onSuccess()` callback, `router.refresh()`
7. ✅ Dialog + cancel buttons disabled during submission (`disabled={isSubmitting}`)
8. ✅ Inline errors appear below invalid fields; form doesn't submit if validation fails
9. ✅ All existing functionality preserved (amount/currency/provider parsing, 2-step file upload, Convex integration)
10. ✅ `pnpm tsc --noEmit` passes

---

## Common Pitfalls & Mitigations

| Pitfall | Mitigation |
|---|---|
| RHF re-renders on every field change | Use `useWatch()` for specific fields if profiling shows issues. RHF is already optimized for controlled components. |
| `z.instanceof(File)` fails in SSR context | File schema only runs in client component (`"use client"`). Verify `pnpm build` doesn't import this schema server-side. |
| File input value can't be cleared programmatically | Pattern: destructure `{ value, onChange }`, pass `onChange` only. Browser resets on `form.reset()` automatically. |
| `<Form>` wrapper breaks `<AlertDialog>` focus trap | `Form` is just `FormProvider` (no DOM). If focus breaks, move `<Form>` inside dialog content. *(Not applicable here — no AlertDialog in Payment Form.)* |
| `form.watch()` causes excess re-renders | Already mitigated by RHF optimization. Only payment form uses conditional logic; Phase 3 tests this more heavily. |
| Merge conflicts with other phases | File ownership: Phase 2 owns `payment-form-dialog.tsx` exclusively. Zero shared modifications with Phases 3, 4, 5. |

---

## File Modifications Summary

| File | Action | Subphase | Lines Changed |
|---|---|---|---|
| `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` | Migrate to RHF + Zod | 2A, 2B, 2C | ~80–120 (net: ~20 more due to Form* imports, ~10 fewer due to useState removal) |

---

## Success Metrics

- `pnpm tsc --noEmit` passes with no errors (subphase 2A, 2B, 2C)
- `pnpm build` succeeds (after 2C)
- Dialog renders in browser without console errors (QA phase 2D)
- Inline errors appear below fields when validation fails (QA phase 2D)
- File upload works end-to-end (client upload → Convex storage) (QA phase 2D)
- Submit button disabled during submission; dialog doesn't close mid-flight (QA phase 2D)
- All PostHog events fire correctly (QA phase 2D)
- Accessibility audit passes (WCAG AA for color contrast, aria attributes) (QA phase 2D)

---

## Next Steps After Phase 2

- ✅ Phase 2 merges with all verification passing
- ▶️ Phase 3 (Invite User Dialog) starts independently
- ▶️ Phase 4 (Follow-Up Assessment) runs in parallel
- ▶️ Phase 5 (Mark Lost + Role Edit) runs in parallel
- → Final regression testing across all 4 dialogs (convergence point)

---

## Timeline

- **2A** (Zod schema): ~30 min
- **2B** (useForm hook): ~45 min
- **2C** (JSX rewrite): ~90 min
- **2D** (QA — deferred): ~60 min (separate execution)
- **Total solo**: ~3.75 hours (excluding 2D)

---

## Contact & Alignment

**This scope aligns with:**
- `plans/v0.5/form-handling/form-handling-design.md` (feature design)
- `plans/v0.5/form-handling/phases/parallelization-strategy.md` (Window 2, Phase 2 critical path)
- `plans/v0.5/form-handling/phases/phase2.md` (detailed implementation guide)

**QA checklist**: `phase2-qa.md` (created separately for deferred execution)
