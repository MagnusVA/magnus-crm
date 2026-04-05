# Phase 2 — Workspace Layout Conversion to RSC

**Goal:** Convert `app/workspace/layout.tsx` from a `"use client"` component to a Server Component that calls `getWorkspaceAccess()` and renders the appropriate UI (workspace shell, not-provisioned screen, or redirect). Extract the client shell into a separate component so the authorization decision is made on the server before any client code mounts.

**Prerequisite:** Phase 1 complete — `lib/auth.ts` must be available with `getWorkspaceAccess()`, `requireWorkspaceUser()`, and the `WorkspaceAccess` type. `components/auth/role-context.tsx` must exist with `RoleProvider` (created in Phase 4, but the import placeholder is added here).

**Runs in PARALLEL with:** Nothing — the workspace layout is the foundation for all `/workspace/**` routes. Phase 3 (page-by-page wrapper conversion) depends on this phase being complete.

**Skills to invoke:**
- None — this is pure component migration following the design guidelines.

**Risk:** Medium. The layout currently owns navigation, keyboard shortcuts, sign-out, command palette, and not-provisioned behavior. All of this must be preserved exactly while moving it into the client shell.

**Estimated time:** 1-2 days

---

## Acceptance Criteria

1. `app/workspace/layout.tsx` has no `"use client"` directive and is a Server Component.
2. `app/workspace/layout.tsx` calls `getWorkspaceAccess()` and handles all five access kinds (`system_admin`, `no_tenant`, `pending_onboarding`, `not_provisioned`, `ready`).
3. System admins accessing `/workspace/**` are redirected to `/admin`.
4. Pending tenants accessing `/workspace/**` are redirected to `/onboarding/connect`.
5. Users with `no_tenant` or `not_provisioned` access see a `<NotProvisionedScreen />` component.
6. Active workspace users render `<WorkspaceShell>` with role-appropriate initial data (`initialRole`, `initialDisplayName`, `initialEmail`).
7. `app/workspace/_components/workspace-shell.tsx` is a `"use client"` component that accepts `initialRole`, `initialDisplayName`, `initialEmail`, and `children` props.
8. The workspace shell includes `RoleProvider` wrapping children (placeholder for Phase 4 integration).
9. Sidebar navigation, keyboard shortcuts (Cmd+1 through Cmd+4), command palette, sign-out, notification center, breadcrumbs, skip link, and profile link all function identically to the current layout.
10. The `WorkspaceLoadingShell` skeleton is no longer needed in the layout (server-side resolution replaces client-side loading states).
11. Navigating between workspace routes still performs page-level authorization (layout does not become the only auth gate).
12. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (Extract WorkspaceShell) ──────────┐
                                      ├── 2C (Convert layout to RSC) ── 2D (Verify & test)
2B (Extract NotProvisionedScreen) ────┘
```

**Optimal execution:**
1. Start 2A and 2B in parallel (they are independent UI components extracted from the current layout).
2. Once 2A and 2B are done -> start 2C (the layout needs to import both components).
3. Once 2C is done -> start 2D (manual verification that everything works end-to-end).

---

## Subphases

### 2A — Extract WorkspaceShell Client Component

**Type:** Frontend
**Parallelizable:** Yes — independent of 2B. Only extracts existing client logic into a new file.

**What:** Move all sidebar, navigation, keyboard shortcuts, command palette, sign-out, notification center, breadcrumbs, and skip-to-content link from `app/workspace/layout.tsx` into a new `app/workspace/_components/workspace-shell.tsx`. The shell accepts `initialRole`, `initialDisplayName`, and `initialEmail` as props and derives all UI decisions from those values.

**Why:** The current layout mixes server authorization concerns (session verification, CRM user resolution, role-based redirects) with client UI concerns (sidebar, keyboard shortcuts, command palette). Extracting the shell allows the layout to become a Server Component while preserving all existing UI behavior in the client shell.

**Where:**
- `app/workspace/_components/workspace-shell.tsx` (new)

**How:**

**Step 1: Create the workspace shell component**

The shell must reproduce the exact sidebar structure, nav items, keyboard shortcuts, header bar, and command palette from the current layout. The key difference is that instead of deriving `isAdmin` from a Convex query result, it derives it from the `initialRole` prop.

```tsx
// Path: app/workspace/_components/workspace-shell.tsx
"use client";

import { type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import type { CrmRole } from "@/convex/lib/roleMapping";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import {
  KanbanIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  SettingsIcon,
  UserCircleIcon,
  UsersIcon,
} from "lucide-react";
import { WorkspaceBreadcrumbs } from "@/components/workspace-breadcrumbs";
import { CommandPaletteTrigger } from "@/components/command-palette-trigger";
import { NotificationCenter } from "@/components/notification-center";
import { useKeyboardShortcut } from "@/hooks/use-keyboard-shortcut";

// Dynamic import for command palette (vercel-react-best-practices: bundle-dynamic-imports)
const CommandPalette = dynamic(
  () =>
    import("@/components/command-palette").then((m) => ({
      default: m.CommandPalette,
    })),
  { ssr: false },
);

// ---------------------------------------------------------------------------
// Hoisted static nav definitions — avoids re-creation on every render
// (vercel-react-best-practices: rendering-hoist-jsx)
// ---------------------------------------------------------------------------

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType;
  exact?: boolean;
};

const adminNavItems: NavItem[] = [
  { href: "/workspace", label: "Overview", icon: LayoutDashboardIcon, exact: true },
  { href: "/workspace/team", label: "Team", icon: UsersIcon },
  { href: "/workspace/pipeline", label: "Pipeline", icon: KanbanIcon },
  { href: "/workspace/settings", label: "Settings", icon: SettingsIcon },
];

const closerNavItems: NavItem[] = [
  { href: "/workspace/closer", label: "Dashboard", icon: LayoutDashboardIcon, exact: true },
  { href: "/workspace/closer/pipeline", label: "My Pipeline", icon: KanbanIcon },
];

// ---------------------------------------------------------------------------
// WorkspaceShell
// ---------------------------------------------------------------------------

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
  const { signOut } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const isAdmin =
    initialRole === "tenant_master" || initialRole === "tenant_admin";
  const navItems = isAdmin ? adminNavItems : closerNavItems;

  // Navigation shortcuts: Cmd+1 through Cmd+4
  useKeyboardShortcut({
    key: "1",
    modifiers: ["meta"],
    handler: () => router.push(navItems[0]?.href ?? "/workspace"),
  });
  useKeyboardShortcut({
    key: "2",
    modifiers: ["meta"],
    handler: () => router.push(navItems[1]?.href ?? "/workspace"),
  });
  useKeyboardShortcut({
    key: "3",
    modifiers: ["meta"],
    handler: () => router.push(navItems[2]?.href ?? "/workspace"),
  });
  useKeyboardShortcut({
    key: "4",
    modifiers: ["meta"],
    handler: () => router.push(navItems[3]?.href ?? "/workspace"),
  });

  return (
    // Phase 4: RoleProvider will wrap this entire return block.
    // For now, initialRole is used directly for nav/UI decisions.
    <SidebarProvider>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <Sidebar>
        <SidebarHeader>
          {/* Brand wordmark — links to role-appropriate home */}
          <Link
            href={isAdmin ? "/workspace" : "/workspace/closer"}
            className="flex items-center gap-2 px-2 py-1.5"
          >
            <span className="text-xs font-semibold uppercase tracking-[0.25em] text-sidebar-foreground/80">
              Magnus
            </span>
          </Link>
          <Separator className="mx-2" />
          {/* User info */}
          <div className="flex flex-col gap-1 px-2 py-1.5">
            <p className="truncate text-sm font-medium">
              {initialDisplayName}
            </p>
            <p className="text-xs capitalize text-sidebar-foreground/70">
              {initialRole.replace(/_/g, " ")}
            </p>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Navigation</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {navItems.map((item) => {
                  const isActive = item.exact
                    ? pathname === item.href
                    : pathname.startsWith(item.href);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
                        isActive={isActive}
                        tooltip={item.label}
                      >
                        <Link href={item.href}>
                          <item.icon />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="Profile">
                <Link href="/workspace/profile">
                  <UserCircleIcon />
                  <span>Profile</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => signOut()}
                tooltip="Sign out"
              >
                <LogOutIcon />
                <span>Sign Out</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 items-center gap-2 border-b px-4">
          <SidebarTrigger aria-label="Toggle sidebar" />
          <Separator orientation="vertical" className="h-4" />
          <WorkspaceBreadcrumbs />
          <div className="ml-auto flex items-center gap-2">
            <CommandPaletteTrigger />
            <NotificationCenter />
          </div>
        </header>
        <div id="main-content" className="flex-1 overflow-auto p-6" tabIndex={-1}>
          {children}
        </div>
      </SidebarInset>
      {/* Command palette — lazy loaded, rendered outside the sidebar */}
      <CommandPalette isAdmin={isAdmin} />
    </SidebarProvider>
  );
}
```

**Step 2: Verify all imports resolve**

Ensure the shell can import:
- UI components from `@/components/ui/sidebar`, `@/components/ui/separator`
- Auth components from `@workos-inc/authkit-nextjs/components`
- Icons from `lucide-react`
- Hooks from `@/hooks/use-keyboard-shortcut`
- Feature components: `WorkspaceBreadcrumbs`, `CommandPaletteTrigger`, `NotificationCenter`, `CommandPalette`
- Types from `@/convex/lib/roleMapping`

**Key implementation notes:**
- The shell is `"use client"` and can use hooks freely.
- The shell does **not** call `useQuery(getCurrentUser)` or perform any authorization checks. The server layout has already made that decision and passed the results as props.
- `initialRole` drives `isAdmin`, nav item selection, and the `CommandPalette` `isAdmin` prop. In Phase 4, `RoleProvider` will wrap children and subscribe to live role data via `useQuery`, making `initialRole` the SSR bootstrap value rather than the final source of truth.
- The `WorkspaceLoadingShell` skeleton is **not** moved here. It is no longer needed because the server layout resolves the user before rendering. If a loading state is needed during client hydration, it would be handled by Suspense boundaries in Phase 3.
- The auto-claim logic (`claimInvitedAccount`) is **not** moved here. Phase 1 moved that into `resolveCrmUser()` in `lib/auth.ts`, which runs on the server.
- The closer-to-admin-path redirect (`if (resolvedUser.role === "closer" && isAdminOnlyPath)`) is **not** in the shell. The server layout handles redirects. Phase 3 page wrappers will add per-page `requireRole()` calls.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/workspace-shell.tsx` | Create | Client shell with sidebar, nav, keyboard shortcuts, command palette, sign-out, notification center |

---

### 2B — Extract NotProvisionedScreen

**Type:** Frontend
**Parallelizable:** Yes — independent of 2A. Only extracts an existing UI component.

**What:** Move the `NotProvisionedScreen` from `app/workspace/layout.tsx` into its own file at `app/workspace/_components/not-provisioned-screen.tsx`. The component becomes a Server Component (no `"use client"` needed) because it no longer receives an `onSignOut` callback — sign-out is handled by a link or a separate client component.

**Why:** The RSC layout (2C) needs to render the not-provisioned screen as a Server Component subtree. Extracting it keeps the layout clean and makes the component independently testable.

**Where:**
- `app/workspace/_components/not-provisioned-screen.tsx` (new)

**How:**

**Step 1: Create the not-provisioned screen**

The current `NotProvisionedScreen` uses the shadcn `Empty` compound component and accepts an `onSignOut` callback. In the RSC version, sign-out requires a client boundary. We preserve the existing visual design while making sign-out work without a callback prop.

```tsx
// Path: app/workspace/_components/not-provisioned-screen.tsx

import { UserCircleIcon } from "lucide-react";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { SignOutButton } from "./sign-out-button";

/**
 * Shown when the authenticated user has no CRM record
 * (e.g., user who hasn't been provisioned yet).
 * Uses the shadcn Empty compound component.
 *
 * This is a Server Component — the sign-out button is a separate
 * client component to keep the boundary minimal.
 */
export function NotProvisionedScreen() {
  return (
    <div className="flex h-screen items-center justify-center">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UserCircleIcon />
          </EmptyMedia>
          <EmptyTitle>Account Not Found</EmptyTitle>
          <EmptyDescription>
            Your account has not been set up yet. Please contact your
            administrator.
          </EmptyDescription>
        </EmptyHeader>
        <SignOutButton />
      </Empty>
    </div>
  );
}
```

**Step 2: Create the sign-out button client component**

Since `signOut()` from `@workos-inc/authkit-nextjs/components` requires a client component, extract a minimal client boundary.

```tsx
// Path: app/workspace/_components/sign-out-button.tsx
"use client";

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { Button } from "@/components/ui/button";
import { LogOutIcon } from "lucide-react";

export function SignOutButton() {
  const { signOut } = useAuth();

  return (
    <Button onClick={() => signOut()} variant="outline">
      <LogOutIcon data-icon="inline-start" aria-hidden="true" />
      Sign Out
    </Button>
  );
}
```

**Key implementation notes:**
- The screen preserves the exact visual appearance of the current `NotProvisionedScreen` in `app/workspace/layout.tsx`.
- The `onSignOut` prop is removed. Instead, a dedicated `SignOutButton` client component handles the sign-out action. This keeps the not-provisioned screen itself as a Server Component.
- If a shared `SignOutButton` already exists at `components/auth/sign-out-button.tsx`, use that instead of creating a new one. Check the codebase before creating a duplicate.
- The screen does not provide self-service actions (no "Request access" button). That can be added in a future iteration.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/not-provisioned-screen.tsx` | Create | Server Component: user-friendly screen for unprovisioned users |
| `app/workspace/_components/sign-out-button.tsx` | Create | Minimal client boundary for sign-out action |

---

### 2C — Convert Layout to RSC

**Type:** Frontend
**Parallelizable:** No — depends on 2A (workspace shell) and 2B (not-provisioned screen).

**What:** Replace the entire `app/workspace/layout.tsx` with a Server Component that:
1. Calls `getWorkspaceAccess()` from `lib/auth.ts`.
2. Handles all access kinds via a `switch` statement.
3. Renders the appropriate UI (redirect, not-provisioned screen, or workspace shell with initial props).

**Why:** This moves the authorization boundary from client-side (after hydration, after Convex query resolution) to server-side (before any HTML is rendered). Unauthorized HTML is never generated or sent to the browser.

**Where:**
- `app/workspace/layout.tsx` (rewrite)

**How:**

**Step 1: Replace the layout**

Delete the entire contents of `app/workspace/layout.tsx` and replace with the RSC version. The `"use client"` directive, all hooks, all client-side state, and the `WorkspaceLoadingShell` skeleton are removed.

```tsx
// Path: app/workspace/layout.tsx

import { getWorkspaceAccess } from "@/lib/auth";
import { redirect } from "next/navigation";
import { WorkspaceShell } from "./_components/workspace-shell";
import { NotProvisionedScreen } from "./_components/not-provisioned-screen";

export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const access = await getWorkspaceAccess();

  switch (access.kind) {
    // System admins should use the admin panel, not the workspace
    case "system_admin":
      redirect("/admin");

    // Pending tenants should complete onboarding first
    case "pending_onboarding":
      redirect("/onboarding/connect");

    // No tenant or not provisioned: show a friendly message
    case "no_tenant":
    case "not_provisioned":
      return <NotProvisionedScreen />;

    // Tenant is active and user is provisioned: render the workspace shell
    case "ready":
      return (
        <WorkspaceShell
          initialRole={access.crmUser.role}
          initialDisplayName={access.crmUser.fullName ?? access.crmUser.email}
          initialEmail={access.crmUser.email}
        >
          {children}
        </WorkspaceShell>
      );
  }
}
```

**Step 2: Verify the switch is exhaustive**

TypeScript will enforce exhaustive handling of the `WorkspaceAccess` discriminated union. If a new access kind is added in the future, the compiler will flag this `switch` statement.

**Step 3: Confirm removed behavior**

The following behaviors from the old layout are intentionally removed or relocated:

| Old behavior | Where it went |
|---|---|
| `useQuery(api.users.queries.getCurrentUser)` | `getWorkspaceAccess()` in `lib/auth.ts` (server-side) |
| `useAction(api.workos.userActions.claimInvitedAccount)` | `resolveCrmUser()` in `lib/auth.ts` (server-side) |
| `useConvexAuth()` / `isAuthenticated` check | Proxy + `verifySession()` (server-side) |
| `WorkspaceLoadingShell` skeleton | No longer needed — server resolves before rendering |
| `NotProvisionedScreen` with `onSignOut` | Extracted to 2B with its own client sign-out button |
| Closer-to-admin redirect (`redirect("/workspace/closer")`) | Phase 3 per-page `requireRole()` calls |
| Sidebar, nav, keyboard shortcuts, command palette | WorkspaceShell (2A) |
| `claimedUser` / `claimDone` state | `resolveCrmUser()` handles this server-side |

**Step 4: Verify `getWorkspaceAccess()` is cached**

`getWorkspaceAccess()` uses React's `cache()` function, so if a child page also calls `getWorkspaceAccess()` or `requireWorkspaceUser()` in the same request, the Convex calls are not duplicated.

**Key implementation notes:**
- The layout is now the **authoritative gateway** for `/workspace/**` routes. Child pages can assume they have a valid workspace user when they render within this layout.
- However, **child pages still call `requireRole()` for per-page role gating** (Phase 3). The layout does not become the only auth gate.
- The `switch` exhaustively handles all `WorkspaceAccess` kinds. Adding a new kind to the union in `lib/auth.ts` will cause a TypeScript error here until handled.
- The shell is not aware of the authorization decision; it only renders UI with the data it receives.
- The `no_tenant` and `not_provisioned` cases both show the same screen. They could be split in the future if different messaging is needed.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/layout.tsx` | Rewrite | Remove `"use client"`, all hooks, all client state. Replace with RSC calling `getWorkspaceAccess()` |

---

### 2D — Verify and Test

**Type:** QA / Manual verification
**Parallelizable:** No — depends on 2C being complete.

**What:** Manually verify that the converted workspace layout behaves identically to the current version for all user states. Confirm keyboard shortcuts, navigation, sign-out, command palette, and redirects all work.

**Why:** The layout is the most critical component in the workspace. A regression here would affect every workspace page.

**Where:** Browser testing against the running application.

**How:**

**Step 1: TypeScript compilation**

```bash
pnpm tsc --noEmit
```

Must pass with zero errors.

**Step 2: Test each access kind**

| Test case | Expected behavior |
|---|---|
| Unauthenticated user visits `/workspace` | Proxy redirects to sign-in (unchanged) |
| System admin visits `/workspace` | Server redirects to `/admin` |
| User with pending tenant visits `/workspace` | Server redirects to `/onboarding/connect` |
| User with no tenant visits `/workspace` | Renders `NotProvisionedScreen` with sign-out button |
| User with no CRM record (not provisioned) visits `/workspace` | Renders `NotProvisionedScreen` with sign-out button |
| Active tenant admin visits `/workspace` | Renders WorkspaceShell with admin nav (Overview, Team, Pipeline, Settings) |
| Active closer visits `/workspace/closer` | Renders WorkspaceShell with closer nav (Dashboard, My Pipeline) |
| Invited user visits `/workspace` for the first time | Server-side claim resolves, workspace loads normally |

**Step 3: Test preserved UI behavior**

| Feature | How to verify |
|---|---|
| Sidebar navigation | Click each nav item, verify active state highlighting |
| Keyboard shortcuts | Press Cmd+1, Cmd+2, Cmd+3, Cmd+4 — verify navigation |
| Command palette | Click trigger or use keyboard shortcut — verify it opens |
| Sign out | Click sign-out in sidebar footer — verify session ends |
| Profile link | Click profile in sidebar footer — verify navigation |
| Breadcrumbs | Navigate to nested page — verify breadcrumbs update |
| Notification center | Click notification bell — verify it opens |
| Skip to content | Tab into page — verify skip link appears and works |
| Sidebar toggle | Click toggle — verify sidebar collapses/expands |
| Brand wordmark | Click "Magnus" — verify it links to role-appropriate home |

**Step 4: Test soft navigation**

Navigate between workspace pages (e.g., `/workspace` -> `/workspace/team` -> `/workspace/pipeline`) using the sidebar. Verify:
- The layout does not re-fetch (the layout RSC is cached for the request).
- The sidebar active state updates correctly.
- Keyboard shortcuts continue to work after navigation.

**Step 5: Verify no client-side authorization leaks**

Open browser DevTools Network tab and verify:
- No `getCurrentUser` Convex query is fired from the layout (it should only come from child pages if they need it).
- No `claimInvitedAccount` action is fired from the layout.
- The HTML source does not contain unauthorized content (view source for not-provisioned state should not contain sidebar/nav HTML).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| (none) | Manual testing | Verify all acceptance criteria |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/_components/workspace-shell.tsx` | Create | 2A |
| `app/workspace/_components/not-provisioned-screen.tsx` | Create | 2B |
| `app/workspace/_components/sign-out-button.tsx` | Create | 2B |
| `app/workspace/layout.tsx` | Rewrite | 2C |
