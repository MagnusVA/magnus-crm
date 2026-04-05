# Phase 5 — Session Freshness Improvements

**Goal:** Ensure that role-changing admin flows trigger `router.refresh()` so server components re-run with fresh CRM data, and document the integration points where `refreshSession()` / `refreshAuth()` will be added in Phase 6 when WorkOS permissions become authoritative.

**Prerequisite:** Phase 3 complete (role-edit dialog, remove-user dialog, and invite-user dialog are now in `_components`).

**Runs in PARALLEL with:** Phase 4 -- different concerns, different files. Phase 4 creates the RoleProvider and permission gates; Phase 5 adds freshness behavior to existing dialogs and documents future session refresh points.

**Skills to invoke:**
- None -- this is targeted modifications to existing dialog components and documentation comments.

**Acceptance Criteria:**
1. `role-edit-dialog.tsx` calls `router.refresh()` after a successful `updateUserRole` action.
2. `remove-user-dialog.tsx` calls `router.refresh()` after a successful `removeUser` action.
3. `invite-user-dialog.tsx` calls `router.refresh()` after a successful `inviteUser` action.
4. All three dialogs import `useRouter` from `next/navigation` and call `router.refresh()` after success, before or after `onSuccess?.()`.
5. `lib/auth.ts` contains a documented TODO comment block noting where `refreshSession()` would be integrated in Phase 6.
6. `app/workspace/_components/workspace-shell.tsx` contains a documented TODO comment noting where `refreshAuth()` from `useAuth()` would be called in Phase 6.
7. After changing a user's role in the team page, the admin's server components re-run on the next render (verified by observing updated nav/layout without a full page reload).
8. The target user's client UI updates reactively via the `RoleProvider` subscription (no additional work needed -- this is already handled by Phase 4's `useQuery(getCurrentUser)` in `RoleProvider`).
9. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
5A (Add router.refresh() to role-changing dialogs) ──┐
                                                     ├── 5C (Verify freshness behavior)
5B (Document Phase 6 session refresh points) ────────┘
```

**Optimal execution:**
1. Start 5A and 5B in parallel (they touch completely separate files).
2. Once 5A and 5B are done -> start 5C (manual verification of freshness behavior).

**Estimated time:** 0.5-1 day

---

## Subphases

### 5A — Add `router.refresh()` to Role-Changing Flows

**Type:** Frontend
**Parallelizable:** Yes -- independent of 5B. Only modifies dialog components.

**What:** Update `role-edit-dialog.tsx`, `remove-user-dialog.tsx`, and `invite-user-dialog.tsx` to call `router.refresh()` after their respective mutations succeed. This causes Next.js to re-run the current route's server components without a full page reload, so `getWorkspaceAccess()` re-fetches fresh CRM data on the server.

**Why:** When an admin changes another user's role (or removes/invites a user), the server components that rendered the current page may hold stale data from the initial request. Calling `router.refresh()` forces the RSC layer to re-execute, picking up the CRM changes made by the mutation. The client-side `RoleProvider` handles real-time UI updates independently via its `useQuery(getCurrentUser)` subscription, but server components (nav items, layout decisions, preloaded data) need an explicit refresh signal.

**Where:**
- `app/workspace/team/_components/role-edit-dialog.tsx` (modify)
- `app/workspace/team/_components/remove-user-dialog.tsx` (modify)
- `app/workspace/team/_components/invite-user-dialog.tsx` (modify)

**How:**

**Step 1: Update `role-edit-dialog.tsx`**

Before:

```tsx
// Path: app/workspace/team/_components/role-edit-dialog.tsx
"use client";

import { useState } from "react";
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
import { FieldGroup, Field, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";

// ... (component props and role options unchanged)

export function RoleEditDialog({
  open,
  onOpenChange,
  userId,
  userName,
  currentRole,
  onSuccess,
}: RoleEditDialogProps) {
  const [selectedRole, setSelectedRole] = useState<CrmRole>(
    currentRole as CrmRole,
  );
  const [isSaving, setIsSaving] = useState(false);
  const updateRole = useAction(api.workos.userManagement.updateUserRole);

  const handleSave = async () => {
    if (selectedRole === currentRole) {
      onOpenChange(false);
      return;
    }

    setIsSaving(true);
    try {
      await updateRole({ userId, newRole: selectedRole });
      toast.success(`${userName}'s role updated to ${roleOptions.find((r) => r.value === selectedRole)?.label}`);
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update role",
      );
    } finally {
      setIsSaving(false);
    }
  };

  // ... (JSX unchanged)
}
```

After:

```tsx
// Path: app/workspace/team/_components/role-edit-dialog.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
import { FieldGroup, Field, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";

// ... (component props and role options unchanged)

export function RoleEditDialog({
  open,
  onOpenChange,
  userId,
  userName,
  currentRole,
  onSuccess,
}: RoleEditDialogProps) {
  const router = useRouter();
  const [selectedRole, setSelectedRole] = useState<CrmRole>(
    currentRole as CrmRole,
  );
  const [isSaving, setIsSaving] = useState(false);
  const updateRole = useAction(api.workos.userManagement.updateUserRole);

  const handleSave = async () => {
    if (selectedRole === currentRole) {
      onOpenChange(false);
      return;
    }

    setIsSaving(true);
    try {
      await updateRole({ userId, newRole: selectedRole });
      toast.success(`${userName}'s role updated to ${roleOptions.find((r) => r.value === selectedRole)?.label}`);
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

  // ... (JSX unchanged)
}
```

**Changes:**
1. Added `import { useRouter } from "next/navigation";`
2. Added `const router = useRouter();` inside the component.
3. Added `router.refresh();` after `onSuccess?.()` in the success path of `handleSave`.

**Step 2: Update `remove-user-dialog.tsx`**

Before:

```tsx
// Path: app/workspace/team/_components/remove-user-dialog.tsx
"use client";

import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";

// ... (interface unchanged)

export function RemoveUserDialog({
  open,
  onOpenChange,
  userId,
  userName,
  onSuccess,
}: RemoveUserDialogProps) {
  const [isRemoving, setIsRemoving] = useState(false);
  const removeUser = useAction(api.workos.userManagement.removeUser);

  const handleRemove = async () => {
    setIsRemoving(true);
    try {
      await removeUser({ userId });
      toast.success(`${userName} has been removed from the team`);
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to remove user",
      );
    } finally {
      setIsRemoving(false);
    }
  };

  // ... (JSX unchanged)
}
```

After:

```tsx
// Path: app/workspace/team/_components/remove-user-dialog.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";

// ... (interface unchanged)

export function RemoveUserDialog({
  open,
  onOpenChange,
  userId,
  userName,
  onSuccess,
}: RemoveUserDialogProps) {
  const router = useRouter();
  const [isRemoving, setIsRemoving] = useState(false);
  const removeUser = useAction(api.workos.userManagement.removeUser);

  const handleRemove = async () => {
    setIsRemoving(true);
    try {
      await removeUser({ userId });
      toast.success(`${userName} has been removed from the team`);
      onOpenChange(false);
      onSuccess?.();
      // Re-run server components so the team list and nav reflect the removal
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to remove user",
      );
    } finally {
      setIsRemoving(false);
    }
  };

  // ... (JSX unchanged)
}
```

**Changes:**
1. Added `import { useRouter } from "next/navigation";`
2. Added `const router = useRouter();` inside the component.
3. Added `router.refresh();` after `onSuccess?.()` in the success path of `handleRemove`.

**Step 3: Update `invite-user-dialog.tsx`**

Before:

```tsx
// Path: app/workspace/team/_components/invite-user-dialog.tsx
"use client";

import { useState } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
// ... (other imports unchanged)

export function InviteUserDialog({ onSuccess }: InviteUserDialogProps) {
  const [open, setOpen] = useState(false);
  // ... (form state unchanged)

  const inviteUser = useAction(api.workos.userManagement.inviteUser);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // ... (validation unchanged)

    setIsSubmitting(true);
    try {
      await inviteUser({
        email,
        firstName,
        lastName: lastName || undefined,
        role,
        calendlyMemberId:
          role === "closer"
            ? (calendlyMemberId as Id<"calendlyOrgMembers">)
            : undefined,
      });

      toast.success("User invited successfully");
      setOpen(false);
      resetForm();
      onSuccess?.();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to invite user",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  // ... (JSX unchanged)
}
```

After:

```tsx
// Path: app/workspace/team/_components/invite-user-dialog.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
// ... (other imports unchanged)

export function InviteUserDialog({ onSuccess }: InviteUserDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // ... (form state unchanged)

  const inviteUser = useAction(api.workos.userManagement.inviteUser);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // ... (validation unchanged)

    setIsSubmitting(true);
    try {
      await inviteUser({
        email,
        firstName,
        lastName: lastName || undefined,
        role,
        calendlyMemberId:
          role === "closer"
            ? (calendlyMemberId as Id<"calendlyOrgMembers">)
            : undefined,
      });

      toast.success("User invited successfully");
      setOpen(false);
      resetForm();
      onSuccess?.();
      // Re-run server components so the team list reflects the new invite
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to invite user",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  // ... (JSX unchanged)
}
```

**Changes:**
1. Added `import { useRouter } from "next/navigation";`
2. Added `const router = useRouter();` inside the component.
3. Added `router.refresh();` after `onSuccess?.()` in the success path of `handleSubmit`.

**Key implementation notes:**
- `router.refresh()` (from `next/navigation`) re-runs the current route's server components without a full page reload. It does not cause a browser navigation or reset client state.
- This causes `getWorkspaceAccess()` and any `preloadQuery()` calls in RSC wrappers to re-execute with fresh CRM data.
- The `router.refresh()` call is placed after `onSuccess?.()` so that any parent callback (e.g., closing a parent dialog, updating local state) runs first.
- The `RoleProvider` subscription in Phase 4 handles real-time client UI updates independently -- `router.refresh()` is specifically for the server component layer.
- Calling `router.refresh()` after `setIsSaving(false)` (in the `finally` block) would also work, but placing it in the success path only avoids unnecessary refreshes on failure.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/team/_components/role-edit-dialog.tsx` | Modify | Add `useRouter` + `router.refresh()` after role update |
| `app/workspace/team/_components/remove-user-dialog.tsx` | Modify | Add `useRouter` + `router.refresh()` after user removal |
| `app/workspace/team/_components/invite-user-dialog.tsx` | Modify | Add `useRouter` + `router.refresh()` after user invite |

---

### 5B — Document Session Refresh Integration Points

**Type:** Documentation
**Parallelizable:** Yes -- independent of 5A. Only adds comments to auth-related files.

**What:** Add TODO comment blocks in `lib/auth.ts` and `app/workspace/_components/workspace-shell.tsx` documenting where `refreshSession()` and `refreshAuth()` would be integrated in Phase 6 when WorkOS permissions become the authoritative source.

**Why:** Phase 6 will promote WorkOS session permissions to the primary authorization source. When that happens, role changes must also refresh the session claims so they are not stale until the user's next login. Documenting these integration points now ensures the Phase 6 implementer knows exactly where to add the calls, without Phase 5 taking on the risk of actually changing the session refresh behavior.

**Where:**
- `lib/auth.ts` (modify -- created in Phase 1A)
- `app/workspace/_components/workspace-shell.tsx` (modify -- created in Phase 2A)

**How:**

**Step 1: Add Phase 6 TODO to `lib/auth.ts`**

Add the following comment block at the end of the file, after the `requireSystemAdmin` function:

```typescript
// Path: lib/auth.ts

// ... (existing code from Phase 1A unchanged)

// ---------------------------------------------------------------------------
// Phase 6 — WorkOS Session Refresh Integration Points
// ---------------------------------------------------------------------------
//
// When WorkOS permissions become the authoritative source for authorization
// (replacing CRM role lookups in this layer), the following changes are needed:
//
// 1. After role-changing mutations in Server Actions, call:
//
//    import { refreshSession } from "@workos-inc/authkit-nextjs";
//    await refreshSession();
//
//    This updates the session cookie with the latest WorkOS membership role
//    and permissions so that subsequent requests to getWorkspaceAccess()
//    can read permissions directly from the session instead of querying CRM.
//
// 2. Update getWorkspaceAccess() to read permissions from session claims:
//
//    const { permissions } = session;
//    // Use permissions instead of (or in addition to) crmUser.role
//
// 3. Update requireRole() to accept permission slugs as an alternative to
//    CRM role arrays, allowing a gradual migration path.
//
// Until Phase 6 is implemented, CRM role data remains the authoritative
// source and session claims are not trusted for authorization decisions.
// ---------------------------------------------------------------------------
```

**Step 2: Add Phase 6 TODO to `workspace-shell.tsx`**

Add the following comment inside the `WorkspaceShell` component, before the return statement:

```tsx
// Path: app/workspace/_components/workspace-shell.tsx
"use client";

import { ReactNode } from "react";
import { Sidebar, SidebarContent, SidebarProvider } from "@/components/ui/sidebar";
import { RoleProvider } from "@/components/auth/role-context";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { CommandPalette } from "@/components/command-palette";
import type { CrmRole } from "@/convex/lib/roleMapping";

interface WorkspaceShellProps {
  initialRole: CrmRole;
  initialDisplayName: string;
  initialEmail: string;
  children: ReactNode;
}

export function WorkspaceShell({
  initialRole,
  initialDisplayName,
  initialEmail,
  children,
}: WorkspaceShellProps) {
  // TODO [Phase 6]: When WorkOS permissions become authoritative, import
  // { useAuth } from "@workos-inc/authkit-nextjs/components" and call
  // refreshAuth() after role-changing flows complete. This updates the
  // client-side session state to match the latest WorkOS membership.
  //
  // Example:
  //   const { refreshAuth } = useAuth();
  //   // Pass refreshAuth to dialogs or call it from an event handler
  //   // after role mutations succeed.
  //
  // This is not needed in Phase 5 because authorization reads fresh CRM
  // role data on every server request, and the RoleProvider subscription
  // handles client-side updates via useQuery(getCurrentUser).

  return (
    <RoleProvider initialRole={initialRole}>
      {/* ... existing shell JSX ... */}
    </RoleProvider>
  );
}
```

**Key implementation notes:**
- `refreshSession()` is a server-side function exported from `@workos-inc/authkit-nextjs`. It re-reads the WorkOS session and updates the cookie. It must be called from a Server Action or route handler, not from a client component.
- `refreshAuth()` is a client-side function returned by `useAuth()` from `@workos-inc/authkit-nextjs/components`. It refreshes the client-side auth state to reflect the latest session cookie.
- Neither function is called in Phase 5. The comments exist purely as documented integration points for Phase 6.
- The Phase 6 implementer should also update the role-changing dialogs (modified in 5A) to call `refreshAuth()` in addition to `router.refresh()`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `lib/auth.ts` | Modify | Add Phase 6 TODO comment block at end of file |
| `app/workspace/_components/workspace-shell.tsx` | Modify | Add Phase 6 TODO comment inside component |

---

### 5C — Verify Freshness Behavior

**Type:** Manual Testing
**Parallelizable:** No -- depends on 5A and 5B being complete.

**What:** Manually verify that role-changing flows correctly trigger server component re-execution and that the client UI updates reactively.

**Why:** Session freshness is subtle. The `router.refresh()` call must actually cause the RSC layer to re-run, and the `RoleProvider` subscription must reflect changes without a page reload. This verification step confirms both paths work together.

**Where:** No files modified. This is a testing checklist.

**How:**

**Manual Testing Checklist:**

1. **Role change -- admin perspective:**
   - Log in as a `tenant_admin`.
   - Navigate to `/workspace/team`.
   - Change another user's role from `closer` to `tenant_admin` (or vice versa) using the role edit dialog.
   - Verify the toast appears ("role updated to ...").
   - Verify the team list re-renders with the updated role without a full page reload.
   - Verify the page URL does not change (no navigation occurred -- only a refresh).

2. **Role change -- target user perspective:**
   - In a second browser (or incognito window), log in as the user whose role was changed.
   - Verify that the sidebar navigation updates reactively (e.g., if promoted to admin, admin nav items appear; if demoted, they disappear).
   - Navigate to a different workspace page (e.g., from `/workspace/closer` to `/workspace/closer/pipeline`).
   - Verify the server-side `requireRole()` check uses the updated CRM role (not a stale role from the previous session).

3. **User removal -- admin perspective:**
   - Navigate to `/workspace/team`.
   - Remove a user using the remove user dialog.
   - Verify the toast appears ("has been removed from the team").
   - Verify the team list re-renders without the removed user.

4. **User invite -- admin perspective:**
   - Navigate to `/workspace/team`.
   - Invite a new user using the invite dialog.
   - Verify the toast appears ("User invited successfully").
   - Verify the team list re-renders to include the newly invited (pending) user.

5. **No refresh on failure:**
   - Trigger a role change that fails (e.g., by simulating a network error or passing an invalid user ID).
   - Verify that `router.refresh()` is **not** called on failure (the page does not flicker or re-render server components).

6. **TypeScript check:**
   - Run `pnpm tsc --noEmit` and verify no type errors are introduced by the changes in 5A or 5B.

**Key implementation notes:**
- The test for "server components re-run" can be confirmed by adding a temporary `console.log` in `getWorkspaceAccess()` and checking the server logs after `router.refresh()` fires.
- The target user's experience (test 2) relies on Phase 4's `RoleProvider` being in place. If Phase 4 is not yet complete, test 2 can be deferred.
- Tests 1, 3, and 4 can be run as soon as 5A is complete.
- Test 6 (TypeScript) can be run immediately after 5A and 5B are complete.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| (none) | -- | Manual testing only |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/team/_components/role-edit-dialog.tsx` | Modify | 5A |
| `app/workspace/team/_components/remove-user-dialog.tsx` | Modify | 5A |
| `app/workspace/team/_components/invite-user-dialog.tsx` | Modify | 5A |
| `lib/auth.ts` | Modify | 5B |
| `app/workspace/_components/workspace-shell.tsx` | Modify | 5B |
