# Phase 3 Implementation Guide — Invite User Dialog Migration

**Status**: Ready for parallel execution  
**Prerequisite**: Phase 1 complete, Phase 2 complete  
**Target file**: `app/workspace/team/_components/invite-user-dialog.tsx`  
**Estimated time**: 2–3 hours  
**Skills to invoke**: See [Applicable Skills](#applicable-skills) section

---

## Overview

Phase 3 migrates the Invite User Dialog from 7 `useState` hooks + manual validation to **React Hook Form + Zod** with **inline field-level errors**. The key complexity introduced in this phase is **conditional validation** — the Calendly member field is required only when `role === "closer"`.

This document provides:
1. Pre-implementation checks
2. Skills to invoke (with when/why)
3. Subphase breakdown (3A → 3B → 3C → 3D)
4. Code patterns and examples
5. Complementary documentation references
6. Known risks and mitigations

---

## Pre-Implementation Checklist

Before starting Phase 3, verify:

- [ ] Phase 1 complete: `components/ui/form.tsx` exists and exports all Form* components
- [ ] Phase 2 complete: Payment Form Dialog is migrated and verified — use it as reference pattern
- [ ] `pnpm install` completed (RHF, Zod, resolver are installed)
- [ ] `pnpm tsc --noEmit` passes for the workspace
- [ ] Current `invite-user-dialog.tsx` is readable and has clear structure
- [ ] Calendly members query (`api.calendly.getUnmatchedCalendlyMembers`) is available
- [ ] Convex mutation `api.workos.userManagement.inviteUser` accepts all required args

---

## Applicable Skills

| Skill | When to Invoke | Why | How |
|-------|---|---|---|
| **vercel-react-best-practices** | After 3B (useForm setup) | Verify that `form.watch("role")` doesn't cause excessive re-renders; RHF optimizations are in place | Read `.agents/skills/vercel-react-best-practices/SKILL.md` and check watched field performance patterns |
| **web-design-guidelines** | After 3C (JSX rewrite) | Ensure inline error messages meet WCAG AA color contrast; conditional field visibility is accessible | Run skill to audit form labels, error styling, and focus order |
| **expect** | After 3D (full implementation) | Browser verification of conditional logic, accessibility, performance | Create separate QA execution file (see phase3-qa-verification.md) for later execution |
| **next-best-practices** | Optional, after 3C | Verify Form component doesn't violate Next.js patterns (RSC boundaries, client component usage) | Read skill for RSC/client boundary guidelines |

---

## Dependency Management

### RHF + Zod Imports

All necessary packages installed in Phase 1:

```bash
pnpm ls react-hook-form @hookform/resolvers zod
```

**Required imports in Phase 3**:

```typescript
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useState, useCallback } from "react";

// From Phase 1 setup
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage, FormDescription } from "@/components/ui/form";

// Existing imports (unchanged)
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from "@/components/ui/select";
import { toast } from "sonner";
import posthog from "posthog-js";
import { useRouter } from "next/navigation";
import { useQuery, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
```

---

## Subphase Breakdown

### 3A — Define Zod Schema with Conditional Validation

**Type**: Frontend (type definition)  
**Dependencies**: None (independent)  
**Estimated time**: 15 minutes  
**Deliverable**: `inviteUserSchema` + `InviteUserFormValues` type

#### Key Pattern: `.superRefine()` for Cross-Field Validation

The `.superRefine()` method allows us to validate based on **multiple field values** and target errors to specific paths:

```typescript
const inviteUserSchema = z
  .object({
    email: z.string().min(1, "Email is required").email("Please enter a valid email address"),
    firstName: z.string().min(1, "First name is required"),
    lastName: z.string().optional(),
    role: z.enum(["closer", "tenant_admin"], { required_error: "Please select a role" }),
    calendlyMemberId: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    // Custom validation: Calendly member is required when role === "closer"
    if (data.role === "closer" && !data.calendlyMemberId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Calendly member is required for Closers",
        path: ["calendlyMemberId"], // ← Error appears under this field in the form
      });
    }
  });

type InviteUserFormValues = z.infer<typeof inviteUserSchema>;
```

**Why `.superRefine()` instead of `.refine()`**:
- `.refine()` creates a single top-level error; `.superRefine()` can target errors to specific field paths
- RHF's `<FormMessage />` component associates errors with the field path — so the Calendly error appears inline below the Calendly dropdown, not as a generic form error

#### Post-Implementation Verification

```bash
pnpm tsc --noEmit
# Expected: No errors, `InviteUserFormValues` type is correct
```

#### Reference

See **Phase 3 Design**, section "3A — Define Zod Schema with Conditional Validation" in `phase3.md` for detailed code example.

---

### 3B — Set Up useForm Hook with Watched Fields

**Type**: Frontend (hooks + state)  
**Dependencies**: 3A (schema defined)  
**Estimated time**: 20 minutes  
**Deliverable**: `useForm` initialization, watched `role` field, submission handler

#### Key Pattern: `form.watch()` for Conditional Rendering

```typescript
export function InviteUserDialog({ open, onOpenChange, onSuccess }: InviteUserDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Initialize form with RHF
  const form = useForm<InviteUserFormValues>({
    resolver: zodResolver(inviteUserSchema),
    defaultValues: {
      email: "",
      firstName: "",
      lastName: "",
      role: "closer", // Default to closer (since that's the more complex case)
      calendlyMemberId: undefined,
    },
  });

  // Watch role field to conditionally render Calendly field
  const watchedRole = form.watch("role");

  // Existing Convex queries/mutations (unchanged)
  const unmatchedMembers = useQuery(api.calendly.getUnmatchedCalendlyMembers, {});
  const inviteUser = useAction(api.workos.userManagement.inviteUser);
  const router = useRouter();

  // Submission handler
  const onSubmit = async (values: InviteUserFormValues) => {
    setIsSubmitting(true);
    try {
      await inviteUser({
        email: values.email,
        firstName: values.firstName,
        lastName: values.lastName || undefined,
        role: values.role,
        calendlyMemberId:
          values.role === "closer"
            ? (values.calendlyMemberId as Id<"calendlyOrgMembers">)
            : undefined,
      });

      posthog.capture("team_member_invited", {
        role: values.role,
        has_calendly_member: values.role === "closer",
      });
      toast.success("User invited successfully");
      onOpenChange(false);
      form.reset();
      onSuccess?.();
      router.refresh();
    } catch (error) {
      posthog.captureException(error);
      toast.error(error instanceof Error ? error.message : "Failed to invite user");
    } finally {
      setIsSubmitting(false);
    }
  };
}
```

**Key notes**:
- `form.watch("role")` returns the current role value. When it changes, the component re-renders.
- RHF optimizes this — only the component that depends on `watchedRole` re-renders, not the entire form.
- `form.reset()` clears all fields after successful submission.
- Default role is `"closer"` (safer assumption than empty, since Calendly is required).

#### Post-Implementation Verification

```bash
pnpm tsc --noEmit
# Expected: No errors, `values` type in onSubmit is correct
```

#### Reference

See **Phase 3 Design**, section "3B — Set Up useForm Hook with Watched Fields" in `phase3.md` for full code example.

---

### 3C — Rewrite JSX with Conditional Calendly Field

**Type**: Frontend (component JSX)  
**Dependencies**: 3B (form setup complete)  
**Estimated time**: 45 minutes  
**Deliverable**: Full form JSX using Form* components, conditional field rendering

#### Key Pattern: Conditional Field Visibility

```tsx
{watchedRole === "closer" && (
  <FormField
    control={form.control}
    name="calendlyMemberId"
    render={({ field }) => (
      <FormItem>
        <FormLabel>
          Calendly Member <span className="text-destructive">*</span>
        </FormLabel>
        <Select
          onValueChange={field.onChange}
          defaultValue={field.value}
          disabled={isSubmitting || !unmatchedMembers}
        >
          <FormControl>
            <SelectTrigger>
              <SelectValue placeholder="Select a Calendly member" />
            </SelectTrigger>
          </FormControl>
          <SelectContent>
            {unmatchedMembers ? (
              <SelectGroup>
                {unmatchedMembers.map((member) => (
                  <SelectItem key={member._id} value={member._id}>
                    {member.name ?? member.email} ({member.email})
                  </SelectItem>
                ))}
              </SelectGroup>
            ) : (
              <SelectItem value="" disabled>
                Loading Calendly members...
              </SelectItem>
            )}
          </SelectContent>
        </Select>
        <FormDescription>Only unmatched Calendly members are shown</FormDescription>
        <FormMessage /> {/* Error appears here if Calendly is required but not selected */}
      </FormItem>
    )}
  />
)}
```

**Key notes**:
- Wrapping the field in `{watchedRole === "closer" && <FormField ...>}` hides it when role is not "closer".
- The field doesn't render at all when hidden (not just `display: none`), so it won't cause validation errors.
- When role changes away from "closer" and back, the field reappears **empty** (we'll clear it on role change).

#### Clearing Calendly on Role Change

In the Role field's Select `onValueChange`:

```typescript
<FormField
  control={form.control}
  name="role"
  render={({ field }) => (
    <FormItem>
      <FormLabel>Role <span className="text-destructive">*</span></FormLabel>
      <Select
        onValueChange={(value) => {
          field.onChange(value);
          // Clear Calendly member when switching away from closer
          if (value !== "closer") {
            form.setValue("calendlyMemberId", undefined);
          }
        }}
        defaultValue={field.value}
        disabled={isSubmitting}
      >
        {/* ... rest of Select ... */}
      </Select>
      <FormMessage />
    </FormItem>
  )}
/>
```

This ensures no stale Calendly selections are submitted if the user switches roles.

#### Post-Implementation Verification

```bash
pnpm tsc --noEmit
pnpm build
# Expected: No errors, build succeeds
```

#### Reference

See **Phase 3 Design**, section "3C — Rewrite JSX with Conditional Calendly Field" in `phase3.md` for full JSX example with all fields.

---

### 3D — Browser Verification (QA Phase)

**Type**: QA / Testing  
**Dependencies**: 3C (code complete)  
**Estimated time**: 30 minutes + async expect run  
**Deliverable**: Signed-off QA checklist (phase3-qa-verification.md)

This step is **deferred** per user instruction. When ready to verify:

1. Start dev server: `pnpm dev`
2. Navigate to `/workspace/team` as an admin
3. Click "Invite User" button
4. Test scenarios from `phase3-qa-verification.md`
5. Run `expect` skill for accessibility and performance audit

**For now**, create the QA verification file (already done above) and document expected test scenarios.

---

## Complementary Documentation

### Related Design & Architecture Docs

| Document | Purpose | Key Section |
|-----------|---------|------------|
| `AGENTS.md` | Codebase standards | **Form Patterns** — manual state, RHF/Zod pattern approved |
| `AGENTS.md` | Codebase standards | **Testing with Expect** — how to use browser QA tool |
| `convex/_generated/ai/guidelines.md` | Convex coding patterns | Verify mutation signatures and type safety |
| `plans/v0.5/form-handling/form-handling-design.md` | Feature specification | Full context on Form Handling Modernization goals |
| `plans/v0.5/form-handling/phases/parallelization-strategy.md` | Execution strategy | Phase 3 is in "Full Parallelism Window" with Phases 2, 4, 5 |

### Key Patterns from AGENTS.md

#### Form Patterns Section

The codebase **standard** form pattern (before Phase 3):
```
Manual state management with useState per field + imperative validation
```

Phase 3 introduces a **new standard**:
```
React Hook Form + Zod schemas with inline field-level errors
```

This pattern is now established and should be used for **all new forms** going forward.

#### React Best Practices

From **vercel-react-best-practices**:
- `form.watch("role")` should only re-render the conditional field, not the entire form — RHF optimizes this automatically
- Avoid watching multiple fields unless necessary — each watched field triggers re-renders
- Prefer `useWatch()` hook for fine-grained subscriptions to specific fields (advanced; not needed for Phase 3)

#### Testing with Expect

From **Testing with Expect** section in AGENTS.md:
- Use `expect` skill to verify changes in real browser
- **Verification rules**: No completion claims without browser evidence
- **Data seeding**: Pages must have real data (minimum 3 Calendly members) before testing
- **Responsive**: 4 viewports minimum (desktop, tablet, mobile, large)
- **Completion gate**: Must run accessibility audit + performance metrics + console check

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|-----------|
| `form.watch("role")` causes excess re-renders | **Medium** | RHF is optimized for this; verify with `vercel-react-best-practices` skill after 3B |
| Conditional validation doesn't target error to `calendlyMemberId` field | **High** | Use `.superRefine()` with `path: ["calendlyMemberId"]` (not `.refine()`) |
| Stale Calendly selection submitted on role change | **Medium** | Clear field on role change via `form.setValue()` in Select `onValueChange` |
| Zod schema validation is stricter than Convex arg validators | **Low** | Both validate independently — Zod is client-side, Convex re-validates server-side |
| Form layout breaks on mobile | **Low** | Use responsive design patterns from AGENTS.md; test on 375px viewport |

---

## Code Review Checklist

Before marking 3C complete, verify:

- [ ] All 7 old `useState` hooks are removed
- [ ] Only 2 `useState` hooks remain: `isSubmitting` (and any other truly local state)
- [ ] `useForm` is initialized with correct default values
- [ ] `form.watch("role")` is used to conditionally render Calendly field
- [ ] Zod schema uses `.superRefine()` for cross-field validation
- [ ] All fields use `<FormField>` + `<FormItem>` + `<FormLabel>` + `<FormControl>` + `<FormMessage>`
- [ ] Calendly field is hidden when `role !== "closer"`
- [ ] Calendly field is cleared when role changes away from "closer"
- [ ] Submission handler uses pre-validated `values` from RHF (no re-validation)
- [ ] PostHog event `team_member_invited` is captured with correct properties
- [ ] No console errors during form interaction
- [ ] `pnpm tsc --noEmit` passes
- [ ] `pnpm build` passes

---

## Execution Order (When Running Phase 3 Solo)

1. **3A** → Define schema (15 min)
2. **3B** → Setup form hook (20 min)
3. **3C** → Rewrite JSX (45 min)
4. **Type check** → `pnpm tsc --noEmit` (2 min)
5. **Build check** → `pnpm build` (5 min)
6. **3D** → Browser QA (defer to later execution)

**Total: ~90 minutes of implementation + async QA**

---

## Reference: Phase 2 Pattern (Use as Template)

Phase 2 (Payment Form Dialog) is the **reference implementation** for RHF + Zod. Differences in Phase 3:

| Aspect | Phase 2 (Reference) | Phase 3 (This Phase) |
|--------|---|---|
| Complexity | Medium (file upload, multi-step) | Medium (conditional validation) |
| New pattern | RHF + Zod + inline errors | Conditional field rendering |
| Watched fields | None | `form.watch("role")` |
| Custom validation | None (single-field validation) | `.superRefine()` (cross-field) |
| Conditional fields | None | Calendly member field |

**Where to find Phase 2 code**:
```
app/workspace/closer/meetings/_components/payment-form-dialog.tsx
```

---

## Phase 3 Complete Criteria

✅ All 3 code subphases (3A, 3B, 3C) complete  
✅ `pnpm tsc --noEmit` passes  
✅ `pnpm build` succeeds  
✅ No console errors during manual testing  
✅ QA verification plan documented (phase3-qa-verification.md)  
✅ Ready for parallel execution with Phases 2, 4, 5  

Once complete, Phase 3 code can run in parallel with Phases 4 & 5 (zero file conflicts per parallelization strategy).

---

## Next Steps After Phase 3

- **Phase 4**: Follow-Up Dialog Assessment (manual review, no code changes)
- **Phase 5**: Mark Lost + Role Edit Dialog Migration (2 simple dialogs)
- **QA Phase**: Run expect verification on all 4 dialogs together
- **Regression**: Full end-to-end testing across all migrated dialogs
