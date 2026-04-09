# Phase 4 — Client Affordance Cleanup

**Goal:** Replace all scattered ad hoc role checks across client components with the centralized `useRole()` hook, `<RequirePermission>` component, and `<AdminOnly>` component created in Phase 1. Remove redundant `useQuery(getCurrentUser)` calls whose sole purpose was UI gating. After this phase, every client-side role/permission check in the workspace tree flows through `RoleProvider`.

**Prerequisite:** Phase 1 complete (`components/auth/role-context.tsx`, `components/auth/require-permission.tsx`, `convex/lib/permissions.ts` available), Phase 2 complete (`WorkspaceShell` wraps children in `<RoleProvider initialRole={...}>`), and Phase 3 complete (page components extracted into `_components/*-page-client.tsx`).

**Runs in PARALLEL with:** Phase 5 (Session Freshness Improvements) — different concerns, no file overlap.

**Skills to invoke:**
- None — this is systematic find-and-replace across client components using established patterns.

**Risk:** Low. UX-only changes. Server-side authorization (Phase 2/3) and Convex mutation-level auth are unaffected. All changes are cosmetic refactors of client-side conditional rendering.

**Estimated time:** 1-2 days

---

## Acceptance Criteria

1. No client component in `app/workspace/` contains inline role comparisons like `currentUser?.role === "tenant_master"` or `currentUser?.role === "tenant_admin"` for UI gating purposes.
2. No client component in `app/workspace/` uses `useQuery(api.users.queries.getCurrentUser)` solely to derive an `isAdmin` flag or role check. Components that also use `currentUser.email`, `currentUser.fullName`, or other non-role fields may keep the query.
3. All admin-only UI sections use either `<AdminOnly>` or `const { isAdmin } = useRole()`.
4. All permission-specific UI sections (e.g., "only tenant_master can edit roles") use `<RequirePermission permission="...">` with permission names from `convex/lib/permissions.ts`.
5. Components outside the workspace tree (e.g., `/admin` page) do NOT use `useRole()` — they are excluded from this phase because `RoleProvider` is not available outside `WorkspaceShell`.
6. The command palette (`components/command-palette.tsx`) consumes `useRole()` instead of receiving an `isAdmin` prop, and the `WorkspaceShell` no longer passes `isAdmin` to it.
7. `CalendlyConnectionGuard` or equivalent connection-checking components consume role context instead of making independent role queries.
8. All permission names used in `<RequirePermission>` match keys in the `PERMISSIONS` map from `convex/lib/permissions.ts`.
9. No visual or behavioral regressions — admin users see the same UI elements as before, closers see the same restricted UI as before.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (Audit and catalog all role check patterns) ──────────┐
                                                         │
                                        ┌────────────────┴────────────────┐
                                        │                                 │
                                        v                                 v
                            4B (Replace role checks in          4C (Replace role checks in
                                admin workspace                     shared/shell components)
                                components)                                │
                                        │                                 │
                                        │         ┌───────────────────────┘
                                        │         │
                                        v         v
                                   4D (Replace role checks in
                                       closer components)
```

**Optimal execution:**
1. Start with 4A (research subphase — audit the codebase, produce a checklist).
2. Once 4A is complete, start 4B and 4C in parallel (they touch different component directories).
3. Once 4B and 4C are complete (or in parallel with them), start 4D (closer components are the least likely to need changes since they are already role-gated by RSC wrappers).

---

## Subphases

### 4A — Audit and Catalog All Role Check Patterns

**Type:** Research
**Parallelizable:** Yes — this is a standalone research subphase with no code changes.

**What:** Search the entire `app/workspace/` and `components/` directories for all instances of ad hoc role checking patterns. Produce a categorized list of every component that needs updating, what pattern it uses, and what it should be replaced with.

**Why:** A complete audit prevents missed patterns and ensures 4B, 4C, and 4D have a concrete checklist to work from. Without this step, refactoring is ad hoc and risks leaving scattered role checks behind.

**Where:** No files modified. Output is a checklist consumed by subsequent subphases.

**How:**

**Step 1: Search for all role comparison patterns**

Search for these patterns across client components:

```bash
# Pattern 1: Direct role string comparisons
rg "\.role\s*===\s*[\"']tenant_master[\"']" app/workspace/ components/
rg "\.role\s*===\s*[\"']tenant_admin[\"']" app/workspace/ components/
rg "\.role\s*===\s*[\"']closer[\"']" app/workspace/ components/

# Pattern 2: isAdmin derived from role
rg "isAdmin" app/workspace/ components/ --type tsx

# Pattern 3: ADMIN_ROLES.includes or similar array checks
rg "ADMIN_ROLES" app/workspace/ components/ --type tsx

# Pattern 4: useQuery(getCurrentUser) calls in client components
rg "useQuery.*getCurrentUser" app/workspace/ components/ --type tsx

# Pattern 5: currentUser?.role usage
rg "currentUser\?\.role" app/workspace/ components/ --type tsx
```

**Step 2: Categorize each finding**

For each match, classify it:

| Category | Action |
|---|---|
| Role check only — no other `currentUser` fields used | Remove `useQuery(getCurrentUser)`, replace with `useRole()` |
| Role check + other fields (email, fullName, etc.) | Keep `useQuery(getCurrentUser)` for the fields, replace role logic with `useRole()` |
| Permission-specific check (e.g., only `tenant_master`) | Replace with `<RequirePermission permission="...">` |
| Admin-only UI section | Replace with `<AdminOnly>` |
| Outside workspace tree (e.g., `/admin`) | Skip — no `RoleProvider` available |

**Step 3: Produce the checklist**

Output a table of files and replacements for 4B, 4C, and 4D to consume.

**Key implementation notes:**
- The `/admin` page (`app/admin/`) checks `organizationId` directly and does NOT have `RoleProvider` in its tree. Exclude it from the audit.
- Components in `components/` that are only rendered inside the workspace tree ARE in scope (e.g., `command-palette.tsx`).
- The `WorkspaceShell` itself uses `initialRole` for nav items. It may optionally be updated to use `useRole()` for dynamic nav updates, but this is lower priority since the shell already receives `initialRole` from the server.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| (none) | Research only | Produces a checklist for 4B, 4C, 4D |

---

### 4B — Replace Role Checks in Admin Workspace Components

**Type:** Frontend
**Parallelizable:** Yes — independent of 4C and 4D. Touches only `app/workspace/team/`, `app/workspace/pipeline/`, and `app/workspace/settings/` client components.

**What:** Update all admin workspace client components (team, pipeline, settings) to use `useRole()`, `<RequirePermission>`, and `<AdminOnly>` instead of ad hoc role checks. Remove redundant `useQuery(getCurrentUser)` calls where the sole purpose was role gating.

**Why:** These pages are the most likely to contain role checks because they have mixed admin/tenant_master permissions (e.g., only `tenant_master` can edit roles, but both `tenant_master` and `tenant_admin` can invite users).

**Where:**
- `app/workspace/team/_components/team-members-table.tsx` (modify)
- `app/workspace/team/_components/invite-user-dialog.tsx` (modify)
- `app/workspace/team/_components/role-edit-dialog.tsx` (modify)
- `app/workspace/pipeline/_components/pipeline-filters.tsx` (modify)
- `app/workspace/settings/_components/calendly-connection.tsx` (modify)
- `app/workspace/settings/_components/event-type-config-list.tsx` (modify)
- Other files identified by the 4A audit

**How:**

**Step 1: Replace role checks in team member table**

The team members table likely checks the current user's role to decide whether to show edit/remove action buttons.

Before:
```tsx
// Path: app/workspace/team/_components/team-members-table.tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

export function TeamMembersTable({ /* ... */ }) {
  const currentUser = useQuery(api.users.queries.getCurrentUser);
  const isAdmin =
    currentUser?.role === "tenant_master" ||
    currentUser?.role === "tenant_admin";
  const canEditRoles = currentUser?.role === "tenant_master";

  return (
    <table>
      {/* ... rows ... */}
      {members.map((member) => (
        <tr key={member._id}>
          <td>{member.fullName}</td>
          <td>{member.role}</td>
          <td>
            {isAdmin && <RemoveMemberButton memberId={member._id} />}
            {canEditRoles && <EditRoleButton memberId={member._id} />}
          </td>
        </tr>
      ))}
    </table>
  );
}
```

After:
```tsx
// Path: app/workspace/team/_components/team-members-table.tsx
"use client";

import { RequirePermission } from "@/components/auth/require-permission";

export function TeamMembersTable({ /* ... */ }) {
  // useQuery(getCurrentUser) removed — role check was its only purpose

  return (
    <table>
      {/* ... rows ... */}
      {members.map((member) => (
        <tr key={member._id}>
          <td>{member.fullName}</td>
          <td>{member.role}</td>
          <td>
            <RequirePermission permission="team:remove">
              <RemoveMemberButton memberId={member._id} />
            </RequirePermission>
            <RequirePermission permission="team:update-role">
              <EditRoleButton memberId={member._id} />
            </RequirePermission>
          </td>
        </tr>
      ))}
    </table>
  );
}
```

**Step 2: Replace role checks in invite user dialog**

Before:
```tsx
// Path: app/workspace/team/_components/invite-user-dialog.tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

export function InviteUserDialog() {
  const currentUser = useQuery(api.users.queries.getCurrentUser);
  const canInvite =
    currentUser?.role === "tenant_master" ||
    currentUser?.role === "tenant_admin";

  if (!canInvite) return null;

  return (
    <Dialog>
      {/* invite form */}
    </Dialog>
  );
}
```

After:
```tsx
// Path: app/workspace/team/_components/invite-user-dialog.tsx
"use client";

import { RequirePermission } from "@/components/auth/require-permission";

export function InviteUserDialog() {
  return (
    <RequirePermission permission="team:invite">
      <Dialog>
        {/* invite form */}
      </Dialog>
    </RequirePermission>
  );
}
```

**Step 3: Replace role checks in role edit dialog**

This component should use `team:update-role` permission, which is restricted to `tenant_master` only.

Before:
```tsx
// Path: app/workspace/team/_components/role-edit-dialog.tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

export function RoleEditDialog({ memberId }: { memberId: string }) {
  const currentUser = useQuery(api.users.queries.getCurrentUser);

  if (currentUser?.role !== "tenant_master") return null;

  return (
    <Dialog>
      {/* role editing form */}
    </Dialog>
  );
}
```

After:
```tsx
// Path: app/workspace/team/_components/role-edit-dialog.tsx
"use client";

import { RequirePermission } from "@/components/auth/require-permission";

export function RoleEditDialog({ memberId }: { memberId: string }) {
  return (
    <RequirePermission permission="team:update-role">
      <Dialog>
        {/* role editing form */}
      </Dialog>
    </RequirePermission>
  );
}
```

**Step 4: Replace role checks in pipeline filters**

If pipeline filters have admin-only filter options (e.g., filter by closer):

Before:
```tsx
// Path: app/workspace/pipeline/_components/pipeline-filters.tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

export function PipelineFilters() {
  const currentUser = useQuery(api.users.queries.getCurrentUser);
  const isAdmin =
    currentUser?.role === "tenant_master" ||
    currentUser?.role === "tenant_admin";

  return (
    <div>
      {/* common filters */}
      {isAdmin && <CloserFilterDropdown />}
    </div>
  );
}
```

After:
```tsx
// Path: app/workspace/pipeline/_components/pipeline-filters.tsx
"use client";

import { AdminOnly } from "@/components/auth/require-permission";

export function PipelineFilters() {
  return (
    <div>
      {/* common filters */}
      <AdminOnly>
        <CloserFilterDropdown />
      </AdminOnly>
    </div>
  );
}
```

**Step 5: Replace role checks in settings components**

Before:
```tsx
// Path: app/workspace/settings/_components/event-type-config-list.tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

export function EventTypeConfigList() {
  const currentUser = useQuery(api.users.queries.getCurrentUser);
  const canManage =
    currentUser?.role === "tenant_master" ||
    currentUser?.role === "tenant_admin";

  return (
    <div>
      {/* event type list */}
      {canManage && <EditEventTypeButton />}
    </div>
  );
}
```

After:
```tsx
// Path: app/workspace/settings/_components/event-type-config-list.tsx
"use client";

import { RequirePermission } from "@/components/auth/require-permission";

export function EventTypeConfigList() {
  return (
    <div>
      {/* event type list */}
      <RequirePermission permission="settings:manage">
        <EditEventTypeButton />
      </RequirePermission>
    </div>
  );
}
```

**Key implementation notes:**
- Only remove `useQuery(getCurrentUser)` when the component uses NO other fields from the user object. If the component also displays `currentUser.fullName` or `currentUser.email`, keep the query and only replace the role logic.
- Permission names must match keys in `convex/lib/permissions.ts`: `"team:invite"`, `"team:remove"`, `"team:update-role"`, `"pipeline:view-all"`, `"settings:manage"`, etc.
- These components are inside the workspace tree, so `useRole()` is guaranteed to have a `RoleProvider` ancestor (provided by `WorkspaceShell` from Phase 2).
- The actual security enforcement remains in Convex mutations (`requireTenantUser(ctx, ['tenant_master'])`). These client-side changes only affect which buttons and controls are visible.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/team/_components/team-members-table.tsx` | Modify | Replace role checks with `<RequirePermission>` |
| `app/workspace/team/_components/invite-user-dialog.tsx` | Modify | Replace role checks with `<RequirePermission permission="team:invite">` |
| `app/workspace/team/_components/role-edit-dialog.tsx` | Modify | Replace role checks with `<RequirePermission permission="team:update-role">` |
| `app/workspace/pipeline/_components/pipeline-filters.tsx` | Modify | Replace admin check with `<AdminOnly>` |
| `app/workspace/settings/_components/calendly-connection.tsx` | Modify | Replace role checks with `<RequirePermission permission="settings:manage">` |
| `app/workspace/settings/_components/event-type-config-list.tsx` | Modify | Replace role checks with `<RequirePermission permission="settings:manage">` |

---

### 4C — Replace Role Checks in Shared/Shell Components

**Type:** Frontend
**Parallelizable:** Yes — independent of 4B and 4D. Touches `components/command-palette.tsx`, `app/workspace/_components/workspace-shell.tsx`, and any other shared components identified in 4A.

**What:** Update the command palette and workspace shell to consume `useRole()` instead of relying on passed props or local role derivations. Remove the `isAdmin` prop from the command palette and have it call `useRole()` directly.

**Why:** The command palette currently receives `isAdmin` as a prop from the workspace shell. This creates a prop-drilling chain that the role context was designed to eliminate. The shell itself derives `isAdmin` from `initialRole` for nav items, which could optionally use `useRole()` for live updates.

**Where:**
- `components/command-palette.tsx` (modify)
- `app/workspace/_components/workspace-shell.tsx` (modify)

**How:**

**Step 1: Update command palette to use `useRole()` directly**

Before:
```tsx
// Path: components/command-palette.tsx
"use client";

interface CommandPaletteProps {
  isAdmin: boolean;
}

export function CommandPalette({ isAdmin }: CommandPaletteProps) {
  // ... command palette logic ...

  const commands = [
    { label: "Go to Dashboard", href: isAdmin ? "/workspace" : "/workspace/closer" },
    // Admin-only commands
    ...(isAdmin
      ? [
          { label: "Go to Team", href: "/workspace/team" },
          { label: "Go to Settings", href: "/workspace/settings" },
        ]
      : []),
    // Closer-only commands
    ...(!isAdmin
      ? [
          { label: "Go to My Pipeline", href: "/workspace/closer/pipeline" },
        ]
      : []),
  ];

  return (
    <CommandDialog>
      {commands.map((cmd) => (
        <CommandItem key={cmd.href}>{cmd.label}</CommandItem>
      ))}
    </CommandDialog>
  );
}
```

After:
```tsx
// Path: components/command-palette.tsx
"use client";

import { useRole } from "@/components/auth/role-context";

export function CommandPalette() {
  const { isAdmin } = useRole();

  // ... command palette logic ...

  const commands = [
    { label: "Go to Dashboard", href: isAdmin ? "/workspace" : "/workspace/closer" },
    // Admin-only commands
    ...(isAdmin
      ? [
          { label: "Go to Team", href: "/workspace/team" },
          { label: "Go to Settings", href: "/workspace/settings" },
        ]
      : []),
    // Closer-only commands
    ...(!isAdmin
      ? [
          { label: "Go to My Pipeline", href: "/workspace/closer/pipeline" },
        ]
      : []),
  ];

  return (
    <CommandDialog>
      {commands.map((cmd) => (
        <CommandItem key={cmd.href}>{cmd.label}</CommandItem>
      ))}
    </CommandDialog>
  );
}
```

**Step 2: Remove the `isAdmin` prop from WorkspaceShell's CommandPalette usage**

Before:
```tsx
// Path: app/workspace/_components/workspace-shell.tsx

export function WorkspaceShell({
  initialRole,
  initialDisplayName,
  initialEmail,
  children,
}: WorkspaceShellProps) {
  // ...
  const isAdmin =
    initialRole === "tenant_master" || initialRole === "tenant_admin";
  // ...

  return (
    <RoleProvider initialRole={initialRole}>
      <SidebarProvider>
        {/* ... sidebar ... */}
        <CommandPalette isAdmin={isAdmin} />
      </SidebarProvider>
    </RoleProvider>
  );
}
```

After:
```tsx
// Path: app/workspace/_components/workspace-shell.tsx

export function WorkspaceShell({
  initialRole,
  initialDisplayName,
  initialEmail,
  children,
}: WorkspaceShellProps) {
  // ...

  return (
    <RoleProvider initialRole={initialRole}>
      <SidebarProvider>
        {/* ... sidebar ... */}
        <CommandPalette />
      </SidebarProvider>
    </RoleProvider>
  );
}
```

**Step 3: Optionally update nav item logic to use `useRole()`**

The workspace shell currently derives `isAdmin` from `initialRole` for selecting nav items. Since the shell is already inside `RoleProvider`, it can use `useRole()` for live updates when a user's role changes mid-session. This is optional but recommended.

Before:
```tsx
// Path: app/workspace/_components/workspace-shell.tsx

export function WorkspaceShell({ initialRole, /* ... */ }: WorkspaceShellProps) {
  const isAdmin =
    initialRole === "tenant_master" || initialRole === "tenant_admin";
  const navItems = isAdmin ? adminNavItems : closerNavItems;
  // ...
}
```

After:
```tsx
// Path: app/workspace/_components/workspace-shell.tsx

import { useRole } from "@/components/auth/role-context";

export function WorkspaceShell({ initialRole, /* ... */ }: WorkspaceShellProps) {
  // initialRole is still passed to RoleProvider, but the shell's own UI
  // reads from the live context so nav updates if the role changes mid-session.
  const { isAdmin } = useRole();
  const navItems = isAdmin ? adminNavItems : closerNavItems;
  // ...
}
```

Note: `useRole()` works here because the `WorkspaceShell` renders its return value inside `<RoleProvider>`. However, `useRole()` must be called from a child of `RoleProvider`, not a sibling. If the shell's JSX structure has `RoleProvider` wrapping children but the hook call is in the shell function body, this requires restructuring. The recommended approach is to extract the shell's inner content into a separate component:

```tsx
// Path: app/workspace/_components/workspace-shell.tsx

export function WorkspaceShell({
  initialRole,
  initialDisplayName,
  initialEmail,
  children,
}: WorkspaceShellProps) {
  return (
    <RoleProvider initialRole={initialRole}>
      <WorkspaceShellInner
        initialDisplayName={initialDisplayName}
        initialEmail={initialEmail}
      >
        {children}
      </WorkspaceShellInner>
    </RoleProvider>
  );
}

function WorkspaceShellInner({
  initialDisplayName,
  initialEmail,
  children,
}: {
  initialDisplayName: string;
  initialEmail: string;
  children: ReactNode;
}) {
  const { isAdmin } = useRole();
  const navItems = isAdmin ? adminNavItems : closerNavItems;
  const router = useRouter();
  const pathname = usePathname();
  const { signOut } = useAuth();

  // keyboard shortcuts, sidebar, command palette, etc.
  // ...

  return (
    <SidebarProvider>
      {/* ... full shell UI ... */}
      <CommandPalette />
    </SidebarProvider>
  );
}
```

**Key implementation notes:**
- The command palette is rendered inside the workspace tree (it is a child of `WorkspaceShell`, which is a child of `RoleProvider`). Therefore `useRole()` is safe to call.
- Removing the `isAdmin` prop from `CommandPalette` is a breaking change for the component's interface. Ensure no other caller passes this prop. Since the command palette is only rendered inside `WorkspaceShell`, this should be safe.
- The `WorkspaceShellInner` pattern is only needed if the shell calls `useRole()` in its own function body. If the shell only passes `isAdmin` down via props or JSX, the simpler approach (just removing the prop from `CommandPalette`) is sufficient.
- The shell still receives `initialRole` because it passes it to `RoleProvider`. The `initialRole` prop is NOT removed from the shell's interface.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `components/command-palette.tsx` | Modify | Remove `isAdmin` prop, consume `useRole()` instead |
| `app/workspace/_components/workspace-shell.tsx` | Modify | Remove `isAdmin` prop from `<CommandPalette>`, optionally use `useRole()` for nav |

---

### 4D — Replace Role Checks in Closer Components

**Type:** Frontend
**Parallelizable:** Yes — independent of 4B and 4C. Touches only `app/workspace/closer/` client components.

**What:** Update any closer components that contain role-based UI gating. These components are the least likely to need changes because they are already role-gated at the page level by RSC wrappers (`requireRole(["closer"])`), so internal role checks should be rare.

**Why:** Even though closer pages are role-gated by their RSC wrappers, individual components within those pages might still have role checks for fine-grained permissions (e.g., a closer who can record payments but not view all payments).

**Where:**
- `app/workspace/closer/_components/` (any files identified by 4A audit)
- `app/workspace/closer/pipeline/_components/` (any files identified by 4A audit)
- `app/workspace/closer/meetings/[meetingId]/_components/` (any files identified by 4A audit)

**How:**

**Step 1: Check for role-based UI in closer dashboard**

Closer dashboard components might have permission checks for payment recording or meeting management.

Before:
```tsx
// Path: app/workspace/closer/_components/closer-dashboard-page-client.tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

export function CloserDashboardPageClient({ preloadedDashboard }) {
  const currentUser = useQuery(api.users.queries.getCurrentUser);

  return (
    <div>
      {/* Dashboard content */}
      {currentUser?.role === "closer" && <RecordPaymentButton />}
    </div>
  );
}
```

After:
```tsx
// Path: app/workspace/closer/_components/closer-dashboard-page-client.tsx
"use client";

import { RequirePermission } from "@/components/auth/require-permission";

export function CloserDashboardPageClient({ preloadedDashboard }) {
  return (
    <div>
      {/* Dashboard content */}
      <RequirePermission permission="payment:record">
        <RecordPaymentButton />
      </RequirePermission>
    </div>
  );
}
```

**Step 2: Check meeting detail components**

Meeting detail pages might check permissions for managing meetings.

Before:
```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

export function MeetingDetailPageClient({ preloadedDetail }) {
  const currentUser = useQuery(api.users.queries.getCurrentUser);
  const canManage = currentUser?.role === "closer";

  return (
    <div>
      {/* Meeting details */}
      {canManage && <RescheduleMeetingButton />}
      {canManage && <CancelMeetingButton />}
    </div>
  );
}
```

After:
```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx
"use client";

import { RequirePermission } from "@/components/auth/require-permission";

export function MeetingDetailPageClient({ preloadedDetail }) {
  return (
    <div>
      {/* Meeting details */}
      <RequirePermission permission="meeting:manage-own">
        <RescheduleMeetingButton />
        <CancelMeetingButton />
      </RequirePermission>
    </div>
  );
}
```

**Step 3: Check CalendlyConnectionGuard or equivalent**

If a Calendly connection guard component exists in the closer tree and makes its own role query to determine whether to show connection UI:

Before:
```tsx
// Path: app/workspace/closer/_components/calendly-connection-guard.tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

export function CalendlyConnectionGuard({ children }: { children: ReactNode }) {
  const currentUser = useQuery(api.users.queries.getCurrentUser);
  const isAdmin =
    currentUser?.role === "tenant_master" ||
    currentUser?.role === "tenant_admin";

  // Admins bypass the connection check
  if (isAdmin) return children;

  // Closers see the connection guard
  return <CalendlyConnectionStatus>{children}</CalendlyConnectionStatus>;
}
```

After:
```tsx
// Path: app/workspace/closer/_components/calendly-connection-guard.tsx
"use client";

import { useRole } from "@/components/auth/role-context";

export function CalendlyConnectionGuard({ children }: { children: ReactNode }) {
  const { isAdmin } = useRole();

  // Admins bypass the connection check
  if (isAdmin) return children;

  // Closers see the connection guard
  return <CalendlyConnectionStatus>{children}</CalendlyConnectionStatus>;
}
```

**Key implementation notes:**
- Closer components are the least likely to need changes. The 4A audit will determine which files actually need modification. If the audit finds no role checks in closer components, this subphase is a no-op.
- Permission names for closer actions: `"payment:record"`, `"meeting:manage-own"`, `"meeting:view-own"`, `"pipeline:view-own"`, `"payment:view-own"`.
- The RSC wrapper already ensures only closers can reach these pages. Internal role checks are only needed when a component needs to distinguish between different permission levels (e.g., a component shared between admin and closer views).
- `CalendlyConnectionGuard` may live in `app/workspace/settings/` rather than in the closer tree. Check the 4A audit for exact location.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/_components/*.tsx` | Modify (if needed) | Replace role checks with `useRole()` or `<RequirePermission>` |
| `app/workspace/closer/pipeline/_components/*.tsx` | Modify (if needed) | Replace role checks |
| `app/workspace/closer/meetings/[meetingId]/_components/*.tsx` | Modify (if needed) | Replace role checks |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| (audit output) | Research | 4A |
| `app/workspace/team/_components/team-members-table.tsx` | Modify | 4B |
| `app/workspace/team/_components/invite-user-dialog.tsx` | Modify | 4B |
| `app/workspace/team/_components/role-edit-dialog.tsx` | Modify | 4B |
| `app/workspace/pipeline/_components/pipeline-filters.tsx` | Modify | 4B |
| `app/workspace/settings/_components/calendly-connection.tsx` | Modify | 4B |
| `app/workspace/settings/_components/event-type-config-list.tsx` | Modify | 4B |
| `components/command-palette.tsx` | Modify | 4C |
| `app/workspace/_components/workspace-shell.tsx` | Modify | 4C |
| `app/workspace/closer/_components/*.tsx` | Modify (if needed) | 4D |
| `app/workspace/closer/pipeline/_components/*.tsx` | Modify (if needed) | 4D |
| `app/workspace/closer/meetings/[meetingId]/_components/*.tsx` | Modify (if needed) | 4D |
