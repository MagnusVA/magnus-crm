# Phase 5 — Personal Event Type Assignment

**Goal:** Add the ability for admins to assign a personal Calendly booking page URL (`personalEventTypeUri`) to each closer via the Team page. The Team table gains a "Personal Event Type" column showing assignment status, and a new dialog allows admins to set or change the URL. After this phase, admins can configure closers' booking page URLs, which are used by the scheduling link follow-up path (Phase 3).

**Prerequisite:** Phase 1 complete (schema deployed with `personalEventTypeUri` on `users` table, `"team:assign-event-type"` permission registered).

**Runs in PARALLEL with:** Phase 2 (Pipeline UTM Intelligence), Phase 3 (Follow-Up Dialog), Phase 4 (Reminders Dashboard) — zero shared files.

**Skills to invoke:**
- `shadcn` — Dialog component, form primitives, table column for the assignment dialog.
- `frontend-design` — Clean dialog design with URL input validation feedback.
- `web-design-guidelines` — WCAG compliance for the assignment dialog (focus management, label association, error announcement).
- `workos` — Understanding of WorkOS role slugs for the `RequirePermission` guard on the dropdown action (reference only, no WorkOS API calls).

**Acceptance Criteria:**
1. The Team members table shows a "Personal Event Type" column after "Calendly Status".
2. For closers: shows the URL if set, or "Not assigned" in amber text if unset. For non-closers: shows "—".
3. The row dropdown menu includes "Assign Event Type" (or "Change Event Type" if already set) for closers, gated by `team:assign-event-type` permission.
4. Clicking the action opens the `EventTypeAssignmentDialog` with a URL input field.
5. The dialog validates the URL: must be non-empty, valid URL format, and contain `calendly.com/`.
6. On successful submission, `assignPersonalEventType` mutation is called, a success toast appears, and the dialog closes.
7. The backend mutation validates: caller must be `tenant_master` or `tenant_admin`, target user must be a closer, URL must be a valid Calendly URL.
8. `listTeamMembers` query returns `personalEventTypeUri` for each user (it's already on the user document — no query change needed).
9. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
5A (Backend mutation) ────────────────────────────────────────┐
                                                               ├── 5C (Dialog state + table column — depends on 5A, 5B)
5B (Assignment dialog component) ─────────────────────────────┘

5C complete ──→ 5D (Verify & polish)
```

**Optimal execution:**
1. Start 5A (backend mutation) and 5B (dialog component) in parallel — different files.
2. Once 5A and 5B are done → 5C (wire into team page: dialog state, table column, dropdown action).
3. Once 5C is done → 5D (visual verification).

**Estimated time:** 1 day

---

## Subphases

### 5A — Backend Mutation: assignPersonalEventType

**Type:** Backend
**Parallelizable:** Yes — independent of 5B (different file).

**What:** Add `assignPersonalEventType` mutation to the Convex users module. The mutation validates caller authorization, target user role, and URL format.

**Why:** The admin needs a secure way to assign personal event types to closers. The mutation enforces RBAC (only `tenant_master`/`tenant_admin`), role validation (only closers), and URL validation (must be a Calendly URL).

**Where:**
- `convex/users/mutations.ts` (new file — or add to an existing user mutations file)

**How:**

**Step 1: Determine the file location**

The codebase has `convex/users/queries.ts` but no `convex/users/mutations.ts`. User mutations exist in feature-specific files like `convex/users/linkCalendlyMember.ts`. Following the established pattern, create a new file for this mutation:

```typescript
// Path: convex/users/assignPersonalEventType.ts (new)
import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

/**
 * Assign a personal Calendly event type URI to a closer.
 * Called by admins from the Team page.
 *
 * The URI is the closer's personal Calendly booking page URL
 * (e.g., "https://calendly.com/john-doe/30min").
 * Used by createSchedulingLinkFollowUp to construct scheduling links with UTM params.
 */
export const assignPersonalEventType = mutation({
  args: {
    userId: v.id("users"),
    personalEventTypeUri: v.string(),
  },
  handler: async (ctx, { userId, personalEventTypeUri }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const targetUser = await ctx.db.get(userId);
    if (!targetUser || targetUser.tenantId !== tenantId) {
      throw new Error("User not found");
    }
    if (targetUser.role !== "closer") {
      throw new Error("Personal event types can only be assigned to closers");
    }

    // Basic URL validation
    try {
      const url = new URL(personalEventTypeUri);
      if (!url.hostname.includes("calendly.com")) {
        throw new Error("URL must be a Calendly booking page");
      }
    } catch (e) {
      if (e instanceof Error && e.message === "URL must be a Calendly booking page") {
        throw e;
      }
      throw new Error("Invalid URL format");
    }

    await ctx.db.patch(userId, { personalEventTypeUri });

    console.log("[Users] assignPersonalEventType", {
      userId,
      personalEventTypeUri: personalEventTypeUri.substring(0, 60),
    });
  },
});
```

**Key implementation notes:**
- Uses `requireTenantUser(ctx, ["tenant_master", "tenant_admin"])` — only admins can assign.
- Validates the target user is a closer — personal event types don't apply to admins.
- URL validation uses `new URL()` for format check + hostname check for `calendly.com`. This is a basic check — we do NOT validate against the Calendly API (see design doc: "No (MVP). URL format validation is sufficient.").
- The mutation is a simple `ctx.db.patch` — idempotent, can be called again to change the URL.
- Following the established pattern of feature-specific mutation files (like `linkCalendlyMember.ts`), this is a standalone file rather than adding to a shared `mutations.ts`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/users/assignPersonalEventType.ts` | Create | `assignPersonalEventType` mutation |

---

### 5B — EventTypeAssignmentDialog Component

**Type:** Frontend
**Parallelizable:** Yes — can be built alongside 5A (knows the mutation signature from the design).

**What:** Create `app/workspace/team/_components/event-type-assignment-dialog.tsx` — a dialog with a URL input field, Zod validation, and RHF integration.

**Why:** Admins need a clear, validated input for assigning Calendly URLs. The dialog follows the established form pattern (RHF + Zod + `standardSchemaResolver`) and externally-controlled dialog pattern (like `RoleEditDialog`).

**Where:**
- `app/workspace/team/_components/event-type-assignment-dialog.tsx` (new)

**How:**

**Step 1: Create the dialog component**

```tsx
// Path: app/workspace/team/_components/event-type-assignment-dialog.tsx
"use client";

import { useState, useEffect } from "react";
import { useMutation } from "convex/react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircleIcon } from "lucide-react";
import { toast } from "sonner";

const eventTypeSchema = z.object({
  personalEventTypeUri: z
    .string()
    .min(1, "Event type URL is required")
    .url("Must be a valid URL")
    .refine(
      (url) => url.includes("calendly.com/"),
      "Must be a Calendly booking page URL (e.g., https://calendly.com/your-name/30min)",
    ),
});
type EventTypeFormValues = z.infer<typeof eventTypeSchema>;

type EventTypeAssignmentDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: Id<"users">;
  userName: string;
  currentUri?: string;
};

export function EventTypeAssignmentDialog({
  open,
  onOpenChange,
  userId,
  userName,
  currentUri,
}: EventTypeAssignmentDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const assignEventType = useMutation(
    api.users.assignPersonalEventType.assignPersonalEventType,
  );

  const form = useForm({
    resolver: standardSchemaResolver(eventTypeSchema),
    defaultValues: {
      personalEventTypeUri: currentUri ?? "",
    },
  });

  // Reset form when dialog opens with new data (externally controlled pattern)
  useEffect(() => {
    if (open) {
      form.reset({ personalEventTypeUri: currentUri ?? "" });
      setSubmitError(null);
    }
  }, [open, currentUri, form]);

  const onSubmit = async (values: EventTypeFormValues) => {
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await assignEventType({
        userId,
        personalEventTypeUri: values.personalEventTypeUri,
      });
      toast.success(`Event type assigned to ${userName}`);
      onOpenChange(false);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Failed to assign event type.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {currentUri ? "Change" : "Assign"} Personal Event Type
          </DialogTitle>
          <DialogDescription>
            Enter the Calendly booking page URL for {userName}. This URL will be
            used to generate scheduling links for follow-ups.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
            <FormField
              control={form.control}
              name="personalEventTypeUri"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Calendly Booking URL <span className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder="https://calendly.com/john-doe/30min"
                      disabled={isSubmitting}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {submitError && (
              <Alert variant="destructive">
                <AlertCircleIcon className="size-4" />
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" disabled={isSubmitting} className="w-full">
              {isSubmitting ? "Assigning..." : currentUri ? "Update Event Type" : "Assign Event Type"}
            </Button>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
```

**Key implementation notes:**
- **Externally controlled dialog pattern:** Uses `open`/`onOpenChange` props (like `RoleEditDialog`). The `useEffect` resets form state when the dialog opens with new data.
- **Form pattern:** RHF + Zod + `standardSchemaResolver` — follows AGENTS.md. Schema is co-located.
- **Zod validation:** `.url()` validates format, `.refine()` checks for `calendly.com/` — same dual validation as the backend mutation.
- **Title/button text adapts:** Shows "Change" / "Update" when `currentUri` exists, "Assign" when it doesn't.
- The mutation import path depends on the file location of the mutation. If `assignPersonalEventType` is in `convex/users/assignPersonalEventType.ts`, the import is `api.users.assignPersonalEventType.assignPersonalEventType`. Adjust based on actual file naming after Phase 5A.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/team/_components/event-type-assignment-dialog.tsx` | Create | Event type assignment dialog with RHF + Zod validation |

---

### 5C — Team Page Integration (Column + Dialog State + Dropdown Action)

**Type:** Frontend
**Parallelizable:** No — depends on 5A (mutation) and 5B (dialog component).

**What:** Add the "Personal Event Type" column to the Team members table, add the "Assign Event Type" dropdown action, and wire the dialog state into `team-page-client.tsx`.

**Why:** The Team page is the admin's interface for managing team members. The new column shows assignment status at a glance, and the dropdown action provides the path to assign/change the URL.

**Where:**
- `app/workspace/team/_components/team-page-client.tsx` (modify)
- `app/workspace/team/_components/team-members-table.tsx` (modify)

**How:**

**Step 1: Add the new dialog state variant to `team-page-client.tsx`**

```typescript
// Path: app/workspace/team/_components/team-page-client.tsx — BEFORE (DialogState type, lines 58-62)
type DialogState =
  | { type: null }
  | { type: "remove"; userId: Id<"users">; userName: string }
  | { type: "calendly"; userId: Id<"users">; userName: string }
  | { type: "role"; userId: Id<"users">; userName: string; currentRole: string };
```

```typescript
// Path: app/workspace/team/_components/team-page-client.tsx — AFTER
type DialogState =
  | { type: null }
  | { type: "remove"; userId: Id<"users">; userName: string }
  | { type: "calendly"; userId: Id<"users">; userName: string }
  | { type: "role"; userId: Id<"users">; userName: string; currentRole: string }
  | {
      type: "event-type";
      userId: Id<"users">;
      userName: string;
      currentUri?: string;
    };
```

**Step 2: Add the handler function**

```typescript
// Path: app/workspace/team/_components/team-page-client.tsx (add handler)
const handleAssignEventType = (memberId: Id<"users">) => {
  const member = members?.find((m) => m._id === memberId);
  if (member && member.role === "closer") {
    setDialog({
      type: "event-type",
      userId: memberId,
      userName: member.fullName || member.email,
      currentUri: member.personalEventTypeUri,
    });
  }
};
```

**Step 3: Add the dialog render**

```tsx
// Path: app/workspace/team/_components/team-page-client.tsx (add dialog render alongside others)
import { EventTypeAssignmentDialog } from "./event-type-assignment-dialog";

// ... in the JSX, alongside other dialog renders:
{dialog.type === "event-type" && (
  <EventTypeAssignmentDialog
    open
    onOpenChange={(open) => {
      if (!open) closeDialog();
    }}
    userId={dialog.userId}
    userName={dialog.userName}
    currentUri={dialog.currentUri}
  />
)}
```

**Step 4: Pass the handler to the table component**

```tsx
// Path: app/workspace/team/_components/team-page-client.tsx (pass to TeamMembersTable)
<TeamMembersTable
  members={sortedMembers}
  // ... existing props ...
  onAssignEventType={handleAssignEventType}
/>
```

**Step 5: Add the column and dropdown action to `team-members-table.tsx`**

Add "Personal Event Type" as a new column header after "Calendly Status":

```tsx
// Path: app/workspace/team/_components/team-members-table.tsx (add in TableHeader)
<SortableHeader
  label="Personal Event Type"
  sortKey="personalEventType"
  sort={sort}
  onToggle={toggle}
/>
```

Add the cell in each row:

```tsx
// Path: app/workspace/team/_components/team-members-table.tsx (add in row)
<TableCell>
  {member.role === "closer" ? (
    member.personalEventTypeUri ? (
      <span className="text-sm text-muted-foreground truncate max-w-[200px] block">
        {member.personalEventTypeUri}
      </span>
    ) : (
      <span className="text-sm text-amber-600 dark:text-amber-400">
        Not assigned
      </span>
    )
  ) : (
    <span className="text-sm text-muted-foreground">—</span>
  )}
</TableCell>
```

Add the dropdown action (after existing actions like "Re-link Calendly"):

```tsx
// Path: app/workspace/team/_components/team-members-table.tsx (add in DropdownMenuContent)
{member.role === "closer" && hasPermission("team:assign-event-type") && (
  <DropdownMenuItem
    onClick={() => onAssignEventType?.(member._id)}
  >
    <CalendarPlusIcon data-icon="inline-start" />
    {member.personalEventTypeUri ? "Change Event Type" : "Assign Event Type"}
  </DropdownMenuItem>
)}
```

**Step 6: Update the component props interface**

```typescript
// Path: app/workspace/team/_components/team-members-table.tsx (update props)
type TeamMembersTableProps = {
  members: TeamMember[];
  // ... existing props ...
  onAssignEventType?: (memberId: Id<"users">) => void;
};
```

Update the `TeamMember` type to include `personalEventTypeUri`:

```typescript
// Path: app/workspace/team/_components/team-members-table.tsx (update type)
type TeamMember = {
  _id: Id<"users">;
  _creationTime: number;
  email: string;
  fullName?: string;
  role: string;
  calendlyMemberName?: string;
  calendlyUserUri?: string;
  personalEventTypeUri?: string; // NEW
};
```

**Key implementation notes:**
- The `personalEventTypeUri` is already on the user document returned by `listTeamMembers` — no backend query changes needed. Convex returns all document fields by default.
- The `hasPermission("team:assign-event-type")` guard ensures only admins see the action. This uses the `useRole()` hook's `hasPermission` method — UI visibility only, the mutation re-validates server-side.
- The column is sortable (via `SortableHeader`) — sorting by `personalEventType` sorts alphabetically by URL string, with `undefined` values last.
- The URL is truncated to 200px width (`max-w-[200px] truncate`) to prevent table layout issues.
- Import `CalendarPlusIcon` from `lucide-react` for the dropdown action icon.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/team/_components/team-page-client.tsx` | Modify | Add `event-type` dialog state, handler, dialog render, pass handler to table |
| `app/workspace/team/_components/team-members-table.tsx` | Modify | Add column header, cell, dropdown action, update props/types |

---

### 5D — Verify & Polish

**Type:** Frontend
**Parallelizable:** No — final verification step.

**What:** Verify the end-to-end flow: admin opens Team page, sees column, clicks "Assign Event Type", enters URL, submits, sees updated table.

**Why:** The personal event type assignment is a prerequisite for the scheduling link follow-up path. Must work reliably.

**Where:**
- No file changes — verification only.

**How:**

**Step 1: Verify column rendering**

Open the Team page as an admin. Verify:
- Closers with `personalEventTypeUri` show the URL (truncated).
- Closers without it show "Not assigned" in amber.
- Non-closer roles show "—".

**Step 2: Verify the assignment dialog**

1. Click the dropdown on a closer → "Assign Event Type".
2. Verify the dialog opens with an empty URL input.
3. Enter an invalid URL → verify inline Zod error.
4. Enter a non-Calendly URL → verify the `.refine()` error.
5. Enter a valid Calendly URL → submit → verify success toast.
6. Verify the table column now shows the assigned URL.

**Step 3: Verify changing an existing event type**

1. Click the dropdown on a closer who already has a URL → "Change Event Type".
2. Verify the dialog pre-fills with the current URL.
3. Change the URL → submit → verify update.

**Step 4: Verify authorization**

1. As a closer, verify the "Assign Event Type" action is NOT visible in the dropdown.
2. As a `tenant_admin`, verify it IS visible for closers but NOT for other admins/owners.

**Step 5: TypeScript compilation**

```bash
pnpm tsc --noEmit
```

**Files touched:**

| File | Action | Notes |
|---|---|---|
| _(none)_ | — | Verification only |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/users/assignPersonalEventType.ts` | Create | 5A |
| `app/workspace/team/_components/event-type-assignment-dialog.tsx` | Create | 5B |
| `app/workspace/team/_components/team-page-client.tsx` | Modify | 5C |
| `app/workspace/team/_components/team-members-table.tsx` | Modify | 5C |

---

**Next Phase:** Phase 5 is the final phase. Once all 5 phases are deployed, the full follow-up & rescheduling system is operational:
- **Phase 1** (backend) + **Phase 5** (event type assignment) = admins can configure closer booking URLs
- **Phase 1** + **Phase 3** (dialog) = closers can create both types of follow-ups
- **Phase 1** + **Phase 4** (dashboard) = closers can view and manage reminders
- **Phase 1** + **Phase 2** (pipeline) + **Phase 5** = end-to-end scheduling link → booking → opportunity relink flow
