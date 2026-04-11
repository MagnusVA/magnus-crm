# Phase 3 — Invite User Dialog Migration

**Goal:** Migrate the Invite User Dialog (`invite-user-dialog.tsx`) from 7 `useState` hooks + manual validation to React Hook Form + Zod with inline field-level errors. This dialog introduces **conditional validation** — the Calendly member field is required only when `role === "closer"` — which tests Zod's `.superRefine()` pattern and RHF's `watch()` API.

**Prerequisite:** Phase 1 complete (packages installed), Phase 2 complete (pattern proven with Payment Form).

**Runs in PARALLEL with:** Phases 4 and 5 can start immediately after this phase or while it's in progress (they have no cross-dependencies).

**Skills to invoke:**
- `vercel-react-best-practices` — Verify watched fields (`form.watch("role")`) don't trigger excessive re-renders.
- `expect` — Browser verification of conditional field visibility, conditional validation, and role-change side effects.

**Acceptance Criteria:**
1. All 7 `useState` hooks are replaced with 1 `useForm` hook and 2 remaining `useState` hooks (`open`, `isSubmitting`). Watched fields use `form.watch()` instead of separate `useState`.
2. `inviteUserSchema` Zod schema with `.superRefine()` validates: `email` (required, valid email), `firstName` (required), `lastName` (optional), `role` (required enum), `calendlyMemberId` (conditionally required if role === "closer").
3. The Calendly member field is only visible when `role === "closer"` via `form.watch("role")`.
4. When the user switches from "closer" to "tenant_admin", the `calendlyMemberId` field is cleared via `form.setValue("calendlyMemberId", undefined)` in the Select's `onValueChange`.
5. All 5 form fields render via `<FormField>` + `<FormItem>` + `<FormLabel>` + `<FormControl>` + `<FormMessage>`, with conditional rendering for the Calendly field.
6. Inline errors display below each invalid field. When role changes to "closer" and no Calendly member is selected, the error appears under the Calendly dropdown.
7. Submission-level errors (Convex action failures, network errors) display in a toast (existing pattern, unchanged).
8. On successful submission: `setOpen(false)`, `form.reset()`, success toast, PostHog event, `onSuccess()` callback, `router.refresh()`.
9. The `unmatchedMembers` query loading state is handled: Select trigger is disabled while `!unmatchedMembers`.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (Zod schema with .superRefine) ──→ 3B (useForm with watch) ──→ 3C (Rewrite JSX) ──→ 3D (Browser verify)
```

**Optimal execution:**
1. Start 3A — define the schema with conditional validation
2. Once 3A completes → start 3B — set up useForm and watched fields
3. Once 3B completes → start 3C — rewrite JSX with conditional Calendly field
4. Once 3C completes → start 3D — verify conditional logic and accessibility

**Estimated time:** 2–3 hours

---

## Subphases

### 3A — Define Zod Schema with Conditional Validation

**Type:** Frontend
**Parallelizable:** No — all other subphases depend on the schema.

**What:** Define `inviteUserSchema` with fields for email, first name, last name, role, and Calendly member ID. Use `.superRefine()` to validate that Calendly member is required when role is "closer".

**Why:** The `.superRefine()` pattern allows us to validate across multiple fields and target errors to specific field paths. When the validation fails for the Calendly field, the error appears inline under the dropdown (not as a generic form error).

**Where:**
- `app/workspace/team/_components/invite-user-dialog.tsx` (modify)

**How:**

**Step 1: Add imports**

```typescript
// Path: app/workspace/team/_components/invite-user-dialog.tsx

"use client";

import { z } from "zod";
```

**Step 2: Define the Zod schema with superRefine**

```typescript
// Path: app/workspace/team/_components/invite-user-dialog.tsx

const inviteUserSchema = z
  .object({
    email: z
      .string()
      .min(1, "Email is required")
      .email("Please enter a valid email address"),
    firstName: z.string().min(1, "First name is required"),
    lastName: z.string().optional(),
    role: z.enum(["closer", "tenant_admin"], {
      required_error: "Please select a role",
    }),
    calendlyMemberId: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.role === "closer" && !data.calendlyMemberId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Calendly member is required for Closers",
        path: ["calendlyMemberId"],
      });
    }
  });

type InviteUserFormValues = z.infer<typeof inviteUserSchema>;
```

**Key notes:**
- The object schema is defined first, then `.superRefine()` is chained to add custom cross-field validation.
- Inside `.superRefine()`, we check `data.role === "closer" && !data.calendlyMemberId`. If true, `ctx.addIssue()` adds an error.
- The `path: ["calendlyMemberId"]` parameter targets the error to that specific field — RHF will associate it with the `calendlyMemberId` FormField, and `<FormMessage />` will display it under that field.
- `.superRefine()` (not `.refine()`) allows multiple errors and path targeting. `.refine()` would only support a single top-level error.

**Step 3: Verify types**

```bash
# Path: project root
pnpm tsc --noEmit
```

No type errors. `InviteUserFormValues` should have the correct shape.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/team/_components/invite-user-dialog.tsx` | Modify | Add Zod schema with superRefine |

---

### 3B — Set Up useForm Hook with Watched Fields

**Type:** Frontend
**Parallelizable:** No — depends on 3A.

**What:** Import `useForm` and `zodResolver`, initialize the form hook with the schema. Use `form.watch("role")` to subscribe to role changes. Rewrite the submission handler to work with RHF.

**Why:** `form.watch()` replaces the old `role` useState — when the role field changes, the component re-renders and the Calendly member field appears/disappears conditionally. The submission handler follows the same pattern as Phase 2.

**Where:**
- `app/workspace/team/_components/invite-user-dialog.tsx` (modify)

**How:**

**Step 1: Add imports**

```typescript
// Path: app/workspace/team/_components/invite-user-dialog.tsx

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useCallback } from "react";
```

**Step 2: Replace useState hooks and set up useForm**

```typescript
// Path: app/workspace/team/_components/invite-user-dialog.tsx

export function InviteUserDialog({
  open,
  onOpenChange,
  onSuccess,
}: InviteUserDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Initialize the form
  const form = useForm<InviteUserFormValues>({
    resolver: zodResolver(inviteUserSchema),
    defaultValues: {
      email: "",
      firstName: "",
      lastName: "",
      role: "closer",
      calendlyMemberId: undefined,
    },
  });

  // Watch role to conditionally render Calendly field
  const watchedRole = form.watch("role");

  // Existing queries (unchanged)
  const unmatchedMembers = useQuery(
    api.calendly.getUnmatchedCalendlyMembers,
    {}
  );
  const inviteUser = useAction(api.workos.userManagement.inviteUser);
  const router = useRouter();
}
```

**Remove the old 7 useState hooks** (look for `role`, `email`, `firstName`, `lastName`, `calendlyMemberId`, etc.). Keep only `isSubmitting`.

**Step 3: Rewrite the submission handler**

```typescript
// Path: app/workspace/team/_components/invite-user-dialog.tsx

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
    toast.error(
      error instanceof Error ? error.message : "Failed to invite user",
    );
  } finally {
    setIsSubmitting(false);
  }
};
```

**Key notes:**
- `values` is pre-validated by Zod, so we know `email`, `firstName`, and `role` are valid.
- If `role === "closer"`, Zod guarantees `calendlyMemberId` is a non-empty string (via `.superRefine()`).
- The conditional cast `as Id<"calendlyOrgMembers">` is safe because Zod validated it.
- Error handling is identical to Phase 2: `try/catch` → toast.error.

**Step 4: Verify types**

```bash
# Path: project root
pnpm tsc --noEmit
```

No type errors.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/team/_components/invite-user-dialog.tsx` | Modify | Add useForm with watch, rewrite onSubmit |

---

### 3C — Rewrite JSX with Conditional Calendly Field

**Type:** Frontend
**Parallelizable:** No — depends on 3B.

**What:** Replace all `<Field>` + manual checks with `<Form>`, `<FormField>`, etc. Make the Calendly member field conditionally visible based on `watchedRole`. Add a side effect to clear the Calendly field when role switches away from "closer".

**Why:** Conditional rendering makes the UI cleaner and prevents stale Calendly selections. The side effect ensures data consistency.

**Where:**
- `app/workspace/team/_components/invite-user-dialog.tsx` (modify)

**How:**

**Step 1: Add form import**

```typescript
// Path: app/workspace/team/_components/invite-user-dialog.tsx

import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage, FormDescription } from "@/components/ui/form";
```

**Step 2: Replace JSX with Form structure**

```tsx
// Path: app/workspace/team/_components/invite-user-dialog.tsx

return (
  <Dialog open={open} onOpenChange={(value) => {
    if (!isSubmitting) {
      onOpenChange(value);
      if (!value) form.reset();
    }
  }}>
    <DialogTrigger asChild>
      <Button>
        <PlusIcon data-icon="inline-start" />
        Invite User
      </Button>
    </DialogTrigger>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Invite Team Member</DialogTitle>
        <DialogDescription>
          Send an invitation to join your team.
        </DialogDescription>
      </DialogHeader>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)}>
          <FieldGroup>
            {/* Email Field */}
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Email <span className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      placeholder="john@example.com"
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* First Name Field */}
            <FormField
              control={form.control}
              name="firstName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    First Name <span className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="text"
                      placeholder="John"
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Last Name Field */}
            <FormField
              control={form.control}
              name="lastName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Last Name</FormLabel>
                  <FormControl>
                    <Input
                      type="text"
                      placeholder="Doe"
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Role Field */}
            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Role <span className="text-destructive">*</span>
                  </FormLabel>
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
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="closer">Closer</SelectItem>
                        <SelectItem value="tenant_admin">Admin</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Conditionally Rendered: Calendly Member Field */}
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
                    <FormDescription>
                      Only unmatched Calendly members are shown
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
          </FieldGroup>

          <DialogFooter className="mt-5">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                onOpenChange(false);
                form.reset();
              }}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Spinner data-icon="inline-start" />
                  Inviting...
                </>
              ) : (
                "Send Invitation"
              )}
            </Button>
          </DialogFooter>
        </form>
      </Form>
    </DialogContent>
  </Dialog>
);
```

**Key changes:**
- `<Form {...form}>` wraps the form for RHF context.
- Each field uses `<FormField>` + `<FormItem>` + `<FormLabel>` + `<FormControl>` + `<FormMessage>`.
- The Calendly member field is wrapped in `{watchedRole === "closer" && <FormField ...>}` — it only renders when the role is "closer".
- In the role Select's `onValueChange`, we call `field.onChange(value)` to update the form state, then check if we need to clear the Calendly field.
- The Calendly Select is disabled while `!unmatchedMembers` (loading state).

**Step 3: Verify the component renders**

```bash
# Path: project root
pnpm build
pnpm tsc --noEmit
```

No errors.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/team/_components/invite-user-dialog.tsx` | Modify | Replace JSX with Form* components |

---

### 3D — Browser Verification of Conditional Logic and Accessibility

**Type:** QA / Testing
**Parallelizable:** No — depends on 3C.

**What:** Open the Invite User dialog in a browser, test the conditional Calendly field visibility, role change side effects, conditional validation, and accessibility.

**Why:** Conditional field visibility and validation are new patterns in this phase. Real browser testing confirms the watched field reactivity works, the Calendly field clears when switching roles, and errors appear/disappear correctly.

**Where:**
- Browser (live app at `/workspace/team`)
- expect MCP tools

**How:**

**Step 1: Start the dev server**

```bash
# Path: project root
pnpm dev
```

**Step 2: Navigate to the Team page**

1. Sign in as an admin (tenant_master or tenant_admin).
2. Navigate to `/workspace/team`.
3. Locate the "Invite User" button (or "Add Member" depending on labeling) and click it.
4. The Invite User dialog should open.

**Step 3: Test basic validation**

1. Click submit without entering any data.
2. Expected: Inline errors appear:
   - "Email is required"
   - "First name is required"
   - "Please select a role"
   - (No error under Calendly member yet — only appears when role is "closer" and field is empty)

**Step 4: Test conditional field visibility**

1. Verify the Calendly member field is **hidden** (not visible in the dialog).
2. Select role: **"Closer"**.
3. Expected: The Calendly member field **appears** below the role field.
4. Select role: **"Admin"**.
5. Expected: The Calendly member field **disappears** from the dialog.
6. Select role: **"Closer"** again.
7. Expected: The field **reappears**.

**Step 5: Test conditional validation**

1. Select role: **"Closer"**.
2. The Calendly member field is now visible.
3. Click submit without selecting a Calendly member.
4. Expected: Error "Calendly member is required for Closers" appears **inline under the Calendly dropdown**.
5. Select any Calendly member from the dropdown.
6. Expected: The error disappears.

**Step 6: Test role change side effect (clearing Calendly)**

1. Select a Calendly member from the dropdown.
2. Verify it's selected (the dropdown shows the member's name).
3. Change the role from "Closer" to "Admin".
4. Expected: The Calendly member field **disappears**.
5. Change the role back to "Closer".
6. Expected: The field **reappears** and is **empty** (the previous selection was cleared).

**Step 7: Test successful submission**

1. Fill in valid data:
   - Email: `new-closer@example.com`
   - First Name: `Jane`
   - Last Name: (optional — leave blank or enter)
   - Role: `Closer`
   - Calendly Member: (select one from the list)
2. Click "Send Invitation".
3. Expected:
   - Button shows spinner and "Inviting..." text.
   - Dialog stays open.
   - On success: Dialog closes, form resets, success toast appears.

**Step 8: Accessibility audit**

Use the expect skill:

```
invoke expect with: "Run accessibility audit on the Invite User dialog"
```

Expected:
- Form labels are properly associated with inputs (`htmlFor` attribute).
- Error messages are announced by screen readers.
- Focus order is logical (email → firstName → lastName → role → calendlyMember → buttons).
- When the Calendly field appears/disappears, screen readers announce the change.
- Color contrast of error text meets WCAG AA.

**Step 9: Verify no console errors**

Open DevTools Console and interact with the form. No errors should appear.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| (none — testing only) | — | Browser testing |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/team/_components/invite-user-dialog.tsx` | Modify | 3A (schema), 3B (useForm), 3C (JSX) |

---

## Implementation Notes

### Using .superRefine() for Conditional Validation

The `.superRefine()` method is preferred over `.refine()` when you need to:
- Validate across multiple fields (cross-field validation)
- Target errors to specific field paths
- Add multiple errors in a single pass

Inside `.superRefine((data, ctx) => { ... })`:
- `data` is the entire validated object
- `ctx.addIssue({ code, message, path })` adds an error
- `path: ["fieldName"]` targets the error to a specific field — RHF's `<FormMessage />` will display it there

Example:
```typescript
.superRefine((data, ctx) => {
  if (data.role === "closer" && !data.calendlyMemberId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Calendly member is required for Closers",
      path: ["calendlyMemberId"],
    });
  }
})
```

### Watched Fields Performance

`form.watch("role")` subscribes to changes on the `role` field. When it changes, the component re-renders. RHF optimizes this to avoid unnecessary re-renders of the entire form — only components that depend on the watched value re-render.

For this dialog, `watchedRole` is only used in the conditional render of the Calendly field, so the impact is minimal.

### Clearing Fields on Condition Change

When the role changes from "closer" to another value, we clear the Calendly field:

```typescript
onValueChange={(value) => {
  field.onChange(value);
  if (value !== "closer") {
    form.setValue("calendlyMemberId", undefined);
  }
}}
```

This prevents stale Calendly selections from being submitted if the user switches back to "closer" later. The `form.setValue()` method updates the form state directly.

---

## Next Phase

Once Phase 3 is verified in the browser, proceed to **Phase 4: Follow-Up Dialog Assessment**. The Follow-Up dialog is a state-machine dialog (not a traditional form), so it requires a different approach.
