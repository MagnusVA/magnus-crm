# Phase 5 — Mark Lost & Role Edit Dialog Migration

**Goal:** Migrate the final two form dialogs — Mark Lost Dialog and Role Edit Dialog — from manual `useState` + imperative handling to React Hook Form + Zod. Both are simple forms (1 field each), completing the form handling modernization across all existing workspace dialogs. After this phase, every form in the workspace uses the RHF + Zod pattern established in Phase 2.

**Prerequisite:** Phase 1 complete (infrastructure). Phase 2 recommended (pattern reference), but not strictly required — these are simpler than the Payment Form.

**Runs in PARALLEL with:** Phase 3 (Invite User) and Phase 4 (Follow-Up assessment) — no shared files.

**Skills to invoke:**
- `expect` — Browser verification of both dialogs: inline errors, submission flow, reset behavior, accessibility
- `vercel-react-best-practices` — Verify that `form.watch("role")` in Role Edit doesn't cause excess re-renders

**Acceptance Criteria:**
1. Mark Lost Dialog: `reason` field uses `<FormField>` + `<FormMessage>`, with `markLostSchema` Zod schema validating max 500 characters.
2. Mark Lost Dialog: 3 `useState` hooks replaced with 1 `useForm` + 2 `useState` (`open`, `isLoading`).
3. Mark Lost Dialog: Submitting with a reason > 500 characters shows inline error "Reason must be under 500 characters" below the textarea.
4. Mark Lost Dialog: The `<AlertDialog>` behavior is preserved — focus trap, escape-to-close, destructive action confirmation UX.
5. Role Edit Dialog: `selectedRole` field uses `<FormField>` + `<FormMessage>`, with `roleEditSchema` Zod schema validating the enum.
6. Role Edit Dialog: 2 `useState` hooks replaced with 1 `useForm` + 1 `useState` (`isSaving`).
7. Role Edit Dialog: Save button is disabled when `watchedRole === currentRole` (same no-op guard as before).
8. Role Edit Dialog: `useEffect` resets form to `currentRole` when dialog opens (handles externally controlled `open` prop).
9. On successful submission, both dialogs preserve: toast success/error, PostHog capture, `onSuccess` callback, dialog close + reset.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
5A (Mark Lost — schema + useForm + JSX) ─────────────────┐
                                                           ├── 5C (Verify & test both)
5B (Role Edit — schema + useForm + JSX) ──────────────────┘
```

**Optimal execution:**
1. Start 5A and 5B in parallel — they touch completely different files with zero overlap.
2. Once both complete → start 5C — run type check and browser verification for both dialogs.

**Estimated time:** 1.5–2.5 hours

---

## Subphases

### 5A — Mark Lost Dialog Migration

**Type:** Frontend
**Parallelizable:** Yes — independent of 5B (different file, different route).

**What:** Migrate `mark-lost-dialog.tsx` from 3 `useState` hooks to 1 `useForm` + 2 `useState`. Define a simple Zod schema for the optional `reason` textarea with a 500-character max.

**Why:** Consistency — even simple forms should use the same pattern. The Zod `.max()` validator enables inline character-limit feedback, which the current implementation lacks entirely (no validation on the reason field).

**Where:**
- `app/workspace/closer/meetings/_components/mark-lost-dialog.tsx` (modify)

**How:**

**Step 1: Add imports and define Zod schema**

```typescript
// Path: app/workspace/closer/meetings/_components/mark-lost-dialog.tsx

"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { AlertTriangleIcon, XCircleIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";

const markLostSchema = z.object({
  reason: z
    .string()
    .max(500, "Reason must be under 500 characters")
    .optional()
    .transform((val) => val?.trim() || undefined),
});

type MarkLostFormValues = z.infer<typeof markLostSchema>;
```

**Step 2: Replace useState hooks with useForm**

```typescript
// Path: app/workspace/closer/meetings/_components/mark-lost-dialog.tsx

export function MarkLostDialog({
  opportunityId,
  onSuccess,
}: MarkLostDialogProps) {
  const [open, setOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const markAsLost = useMutation(api.closer.meetingActions.markAsLost);

  const form = useForm<MarkLostFormValues>({
    resolver: zodResolver(markLostSchema),
    defaultValues: {
      reason: "",
    },
  });

  // BEFORE: const [reason, setReason] = useState("");
  // AFTER: reason lives inside form state, accessed via form.getValues("reason")
```

**Step 3: Rewrite submit handler**

```typescript
// Path: app/workspace/closer/meetings/_components/mark-lost-dialog.tsx

const onSubmit = async (values: MarkLostFormValues) => {
  setIsLoading(true);
  try {
    await markAsLost({
      opportunityId,
      reason: values.reason,
    });
    await onSuccess?.();
    posthog.capture("opportunity_marked_lost", {
      opportunity_id: opportunityId,
      has_reason: Boolean(values.reason),
    });
    toast.success("Opportunity marked as lost");
    setOpen(false);
    form.reset();
  } catch (error) {
    posthog.captureException(error);
    toast.error(
      error instanceof Error ? error.message : "Failed to mark as lost",
    );
  } finally {
    setIsLoading(false);
  }
};
```

**Step 4: Rewrite JSX with Form components**

```tsx
// Path: app/workspace/closer/meetings/_components/mark-lost-dialog.tsx

return (
  <>
    <Button variant="destructive" size="lg" onClick={() => setOpen(true)}>
      <XCircleIcon data-icon="inline-start" />
      Mark as Lost
    </Button>

    <AlertDialog
      open={open}
      onOpenChange={(value) => {
        if (!isLoading) {
          setOpen(value);
          if (!value) form.reset();
        }
      }}
    >
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <div className="flex items-start gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-destructive/10">
              <AlertTriangleIcon className="size-4 text-destructive" />
            </div>
            <div className="flex-1">
              <AlertDialogTitle>Mark as Lost?</AlertDialogTitle>
              <AlertDialogDescription>
                This will mark the opportunity as lost. This action is
                permanent and cannot be undone.
              </AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason (optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Why did this deal fall through? (e.g., budget constraints, chose competitor…)"
                      className="min-h-[100px] resize-none text-sm"
                      disabled={isLoading}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <AlertDialogFooter className="mt-4">
              <AlertDialogCancel disabled={isLoading}>
                Cancel
              </AlertDialogCancel>
              <Button
                type="submit"
                variant="destructive"
                disabled={isLoading}
              >
                {isLoading ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Marking…
                  </>
                ) : (
                  "Mark as Lost"
                )}
              </Button>
            </AlertDialogFooter>
          </form>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  </>
);
```

**Key implementation notes:**
- The `<Form>` wrapper works inside `<AlertDialogContent>` because `Form` is just a `FormProvider` context — it renders no DOM. The AlertDialog's focus trap and escape-key behavior remain intact.
- The `reason` field uses `.optional()` and `.transform()` to trim and convert empty strings to `undefined`. This matches the current `reason.trim() || undefined` logic in the submit handler.
- The `<AlertDialog>` `onOpenChange` now prevents close during loading and resets the form on close.
- Previous approach used `<Field>` + `<FieldLabel>` which is replaced by `<FormField>` + `<FormItem>` + `<FormLabel>` + `<FormControl>` + `<FormMessage>`.
- The submit button changes from `onClick={handleMarkAsLost}` to `type="submit"` — form submission is now handled by RHF's `handleSubmit` wrapper.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/mark-lost-dialog.tsx` | Modify | RHF + Zod migration: 3 useState → 1 useForm + 2 useState |

---

### 5B — Role Edit Dialog Migration

**Type:** Frontend
**Parallelizable:** Yes — independent of 5A (different file, different route).

**What:** Migrate `role-edit-dialog.tsx` from 2 `useState` hooks to 1 `useForm` + 1 `useState`. Define a simple Zod enum schema for the `role` field. Handle the externally-controlled dialog pattern (`open`/`onOpenChange` props) with a `useEffect` reset.

**Why:** Consistency with the established pattern, and type-safe role validation via Zod enum. The `useEffect` reset pattern is important for future dialogs that are controlled externally (e.g., editing different records with the same dialog component).

**Where:**
- `app/workspace/team/_components/role-edit-dialog.tsx` (modify)

**How:**

**Step 1: Add imports and define Zod schema**

```typescript
// Path: app/workspace/team/_components/role-edit-dialog.tsx

"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";

type CrmRole = "tenant_admin" | "closer";

const roleOptions: Array<{ value: CrmRole; label: string }> = [
  { value: "closer", label: "Closer" },
  { value: "tenant_admin", label: "Admin" },
];

const roleEditSchema = z.object({
  role: z.enum(["closer", "tenant_admin"], {
    required_error: "Please select a role",
  }),
});

type RoleEditFormValues = z.infer<typeof roleEditSchema>;
```

**Step 2: Replace useState hooks with useForm + useEffect reset**

```typescript
// Path: app/workspace/team/_components/role-edit-dialog.tsx

export function RoleEditDialog({
  open,
  onOpenChange,
  userId,
  userName,
  currentRole,
  onSuccess,
}: RoleEditDialogProps) {
  const router = useRouter();
  const [isSaving, setIsSaving] = useState(false);
  const updateRole = useAction(api.workos.userManagement.updateUserRole);

  const form = useForm<RoleEditFormValues>({
    resolver: zodResolver(roleEditSchema),
    defaultValues: {
      role: currentRole as CrmRole,
    },
  });

  // Watch the role field for no-op detection (save button disable)
  const watchedRole = form.watch("role");

  // Reset form when dialog opens (currentRole may have changed between opens)
  useEffect(() => {
    if (open) {
      form.reset({ role: currentRole as CrmRole });
    }
  }, [open, currentRole, form]);

  // BEFORE: const [selectedRole, setSelectedRole] = useState<CrmRole>(currentRole as CrmRole);
  // AFTER: selectedRole lives inside form state, watched via form.watch("role")
```

**Step 3: Rewrite submit handler**

```typescript
// Path: app/workspace/team/_components/role-edit-dialog.tsx

const onSubmit = async (values: RoleEditFormValues) => {
  // No-op guard: if the selected role matches the current role, just close
  if (values.role === currentRole) {
    onOpenChange(false);
    return;
  }

  setIsSaving(true);
  try {
    await updateRole({ userId, newRole: values.role });
    toast.success(
      `${userName}'s role updated to ${roleOptions.find((r) => r.value === values.role)?.label}`,
    );
    onOpenChange(false);
    onSuccess?.();
    // Re-run server components so getWorkspaceAccess() picks up fresh CRM data
    router.refresh();
  } catch (error) {
    toast.error(
      error instanceof Error ? error.message : "Failed to update role",
    );
  } finally {
    setIsSaving(false);
  }
};
```

**Step 4: Rewrite JSX with Form components**

```tsx
// Path: app/workspace/team/_components/role-edit-dialog.tsx

return (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-sm">
      <DialogHeader>
        <DialogTitle>Change Role</DialogTitle>
        <DialogDescription>
          Update the role for {userName}. Role changes take effect on their
          next session.
        </DialogDescription>
      </DialogHeader>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)}>
          <FormField
            control={form.control}
            name="role"
            render={({ field }) => (
              <FormItem>
                <FormLabel>New Role</FormLabel>
                <Select
                  onValueChange={field.onChange}
                  value={field.value}
                  disabled={isSaving}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {roleOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="flex justify-end gap-2 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSaving || watchedRole === currentRole}
            >
              {isSaving && <Spinner data-icon="inline-start" />}
              {isSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        </form>
      </Form>
    </DialogContent>
  </Dialog>
);
```

**Key implementation notes:**
- **Externally controlled dialog:** This dialog receives `open`/`onOpenChange` as props (unlike other dialogs that manage their own `open` state). The `useEffect` resets the form to `currentRole` whenever the dialog opens, ensuring the correct initial value when the same dialog is reused for different users.
- **`value` vs `defaultValue` on Select:** Because the form resets via `useEffect`, we use `value={field.value}` (controlled) on the `<Select>`, not `defaultValue`. This ensures the select always reflects the form's current state after a reset.
- **No-op guard preserved:** The `watchedRole === currentRole` check disables the Save button, matching existing behavior. An additional guard in `onSubmit` handles the edge case of submitting via keyboard.
- **No `<FieldGroup>` needed:** The original used `<FieldGroup>` around a single `<Field>`, which was unnecessary. The migration simplifies to a single `<FormField>`.
- **`router.refresh()`** is preserved — it re-runs server components so `getWorkspaceAccess()` picks up the role change.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/team/_components/role-edit-dialog.tsx` | Modify | RHF + Zod migration: 2 useState → 1 useForm + 1 useState + useEffect reset |

---

### 5C — Verify and Test Both Dialogs

**Type:** Manual
**Parallelizable:** No — depends on 5A and 5B completing.

**What:** Run type checking and browser verification for both the Mark Lost Dialog and the Role Edit Dialog.

**Why:** Both dialogs are on different routes with different access patterns. Both need to be verified individually.

**Where:**
- N/A (verification, not code changes)

**How:**

**Step 1: Type check**

```bash
# Path: project root
pnpm tsc --noEmit
```

Must pass with zero errors.

**Step 2: Mark Lost Dialog — browser verification**

Open a meeting detail page as a closer (route: `/workspace/closer/meetings/[meetingId]`):

1. **Empty submit** — Click "Mark as Lost" → dialog opens → click "Mark as Lost" button with empty reason → submit succeeds (reason is optional). No inline error.
2. **Long reason** — Type >500 characters in the reason field → submit → inline error "Reason must be under 500 characters" below the textarea.
3. **Valid reason** — Enter a short reason → submit → opportunity marked as lost, toast success, dialog closes, PostHog event fires.
4. **Cancel** — Enter a reason → click Cancel → dialog closes → reopen → reason field is empty.
5. **Loading state** — During submission, the "Mark as Lost" button shows spinner, Cancel is disabled, textarea is disabled.
6. **Dialog close during loading** — Click outside dialog during submission → dialog stays open (prevented by `onOpenChange` guard).

**Step 3: Role Edit Dialog — browser verification**

Open the team page as a tenant master (route: `/workspace/team`):

1. **No-op submit** — Open dialog for a user → don't change the role → Save button is disabled.
2. **Change role** — Select a different role → Save button enables → click Save → role updates, toast success, dialog closes.
3. **Reopen with different user** — Open dialog for user A (closer) → close → open for user B (admin) → role field shows "Admin" (not stale "Closer" from previous open).
4. **Error handling** — If the action fails → toast error, dialog stays open, user can retry.
5. **Loading state** — During save, spinner shows on the button, Cancel is disabled, select is disabled.

**Step 4: Accessibility check**

Use the `expect` skill to verify both dialogs:
- `aria-invalid` is set on fields with errors.
- `aria-describedby` links each field to its error message.
- Focus management: first field receives focus on dialog open.
- AlertDialog focus trap works correctly with the `<Form>` wrapper.

**Key implementation notes:**
- The Mark Lost Dialog uses `<AlertDialog>` (not `<Dialog>`) — test that the focus trap and accessibility behavior work correctly with the nested `<Form>`.
- The Role Edit Dialog is externally controlled — test the `useEffect` reset by opening it for different users in sequence.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| _(none)_ | — | Verification only |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/closer/meetings/_components/mark-lost-dialog.tsx` | Modify | 5A |
| `app/workspace/team/_components/role-edit-dialog.tsx` | Modify | 5B |

---

## Implementation Notes

### Mark Lost Dialog — Import Changes

**Remove:**
```typescript
import { Field, FieldLabel } from "@/components/ui/field";
```

**Add:**
```typescript
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
```

### Role Edit Dialog — Import Changes

**Remove:**
```typescript
import { FieldGroup, Field, FieldLabel } from "@/components/ui/field";
```

**Add:**
```typescript
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
```

### State Reduction — Mark Lost Dialog

| Before | After |
|---|---|
| `useState` for `open` | `useState` for `open` |
| `useState` for `reason` | _(managed by useForm)_ |
| `useState` for `isLoading` | `useState` for `isLoading` |

**Net reduction:** 3 `useState` → 2 `useState` + 1 `useForm` = **−1 hook** (but gains inline validation and declarative schema).

### State Reduction — Role Edit Dialog

| Before | After |
|---|---|
| `useState` for `selectedRole` | _(managed by useForm + watch)_ |
| `useState` for `isSaving` | `useState` for `isSaving` |
| _(none)_ | `useEffect` for dialog reset |

**Net reduction:** 2 `useState` → 1 `useState` + 1 `useForm` + 1 `useEffect` = **−1 hook** (but gains type-safe enum validation and consistent pattern).

---

## Form Handling Modernization Complete

After Phase 5, all existing workspace form dialogs use the RHF + Zod pattern:

| Dialog | Phase | Status |
|---|---|---|
| Infrastructure (packages + components) | Phase 1 | ✅ |
| Payment Form Dialog | Phase 2 | ✅ |
| Invite User Dialog | Phase 3 | ✅ |
| Follow-Up Dialog | Phase 4 | ⏭️ Skipped (state-machine, no form fields) |
| Mark Lost Dialog | Phase 5 | ✅ |
| Role Edit Dialog | Phase 5 | ✅ |

**Total useState reduction across all dialogs:** 25 → 13 hooks (−9 hooks net, +4 `useForm` hooks).

The RHF + Zod infrastructure is now ready for new form dialogs built in subsequent v0.5 phases (Follow-Up Redesign, Lead Merge, Customer Conversion, Redistribution).
