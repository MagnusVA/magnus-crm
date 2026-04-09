# Phase 2 — Layout Streaming Architecture & Activity

**Goal:** Restructure the workspace layout so the static shell (sidebar frame, header chrome, "Magnus" logo) prerenderers at build time and serves instantly from CDN. Auth-dependent content (role-based nav, user name, page content) streams in behind `<Suspense>` boundaries. Combined with `cacheComponents: true` from Phase 1, this enables Partial Prerendering (PPR) and state preservation via React `<Activity>`. After this phase, users see the workspace frame in < 50ms with auth-dependent content streaming in within 200-400ms.

**Prerequisite:** Phase 1 complete (`cacheComponents: true` in config, all `loading.tsx` and `error.tsx` files in place).

**Runs in PARALLEL with:** Nothing — Phase 3 depends on the restructured layout for granular Suspense to work correctly.

> **Critical path:** This phase is on the critical path (Phase 1 → Phase 2 → Phase 3 → Phase 4).
> Start immediately after Phase 1 completes.

**Skills to invoke:**
- `vercel-composition-patterns` — splitting `WorkspaceShell` into static frame + auth-dependent client shell, compound component composition with Suspense
- `next-best-practices` — RSC boundary validation, streaming layout patterns, `cacheComponents` directive requirements, async `cookies()`/`headers()` inside Suspense
- `vercel-react-best-practices` — `rendering-activity` (state preservation), `server-parallel-fetching` (independent async components), `rendering-hoist-jsx` (static nav definitions)
- `web-design-guidelines` — skip-to-content link, focus management, semantic HTML in shell components

**Acceptance Criteria:**
1. Navigating to `/workspace` shows the sidebar frame and header bar instantly (< 50ms) before auth resolves — visible as static HTML in the initial response.
2. Auth-dependent content (role-based nav items, user display name, role label) streams in within 200-400ms inside the sidebar and header.
3. `WorkspaceShellSkeleton` renders nav placeholder items and a content skeleton while auth resolves — matching the dimensions of the real nav to prevent CLS.
4. The "Skip to content" link is present and focuses the `#main-content` element on activation.
5. Navigating between `/workspace` and `/workspace/closer` preserves client state (sidebar open/closed, scroll position) via Activity — confirmed by toggling sidebar, navigating away, and navigating back.
6. Redirects for `system_admin` (→ `/admin`) and `pending_onboarding` (→ `/onboarding/connect`) still work correctly from the `WorkspaceAuth` component.
7. `NotProvisionedScreen` still renders for `no_tenant` / `not_provisioned` access states.
8. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (WorkspaceShellFrame — static server shell) ──────────┐
                                                          ├── 2D (Layout wiring & Activity verification)
2B (WorkspaceAuth — Suspense-wrapped auth resolver) ──────┤
                                                          │
2C (WorkspaceShellClient — auth-dependent client) ────────┘
```

**Optimal execution:**
1. Start 2A, 2B, 2C in parallel — they create new files with no dependencies on each other.
2. Once all three are done → 2D wires them together in `layout.tsx` and verifies Activity behavior.

**Estimated time:** 1.5 hours

---

## Subphases

### 2A — WorkspaceShellFrame (Static Server Shell)

**Type:** Frontend
**Parallelizable:** Yes — creates a new file with no dependencies on 2B or 2C.

**What:** Create `workspace-shell-frame.tsx` — a Server Component that renders the sidebar frame, "Magnus" logo, header bar with sidebar trigger, and the skip-to-content link. Contains NO dynamic data — prerendered at build time and served instantly.

**Why:** This is the static shell that PPR serves from CDN/cache. Users see the workspace chrome immediately without waiting for auth resolution. Without this split, the entire workspace (sidebar, header, nav items, page content) waits for `getWorkspaceAccess()` to complete (200-500ms).

**Where:**
- `app/workspace/_components/workspace-shell-frame.tsx` (new)

**How:**

**Step 1: Create the static frame component**

```typescript
// Path: app/workspace/_components/workspace-shell-frame.tsx
import { type ReactNode } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";

/**
 * Static shell for the workspace layout.
 * This component contains NO dynamic data — it renders at build time
 * and is served instantly from CDN / static cache.
 *
 * Auth-dependent content (nav items, user info, page content) streams
 * in via {children} inside a <Suspense> boundary.
 */
export function WorkspaceShellFrame({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <Sidebar>
        <SidebarHeader>
          <span className="px-2 py-1.5 text-xs font-semibold uppercase tracking-[0.25em] text-sidebar-foreground/80">
            Magnus
          </span>
          <Separator className="mx-2" />
        </SidebarHeader>
        <SidebarContent>
          {/* Nav items stream in via children — the Suspense fallback
              shows skeleton nav items while auth resolves */}
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 items-center gap-2 border-b px-4">
          <SidebarTrigger aria-label="Toggle sidebar" />
          <Separator orientation="vertical" className="h-4" />
          {/* Breadcrumbs and toolbar stream in via children */}
        </header>
        <div id="main-content" className="flex-1 overflow-auto p-6" tabIndex={-1}>
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
```

**Key implementation notes:**
- `SidebarProvider` is `"use client"` (shadcn component using `useState`/`useContext` for open/close state). This does NOT prevent PPR — client component HTML is still prerendered at build time. The dynamic/static split happens at the `<Suspense>` boundary around `WorkspaceAuth`, not at the `"use client"` boundary.
- The "Magnus" logo and sidebar trigger are identical for every user and role — purely static.
- `SidebarContent` receives its children (nav items) from the streamed auth component — during the streaming delay, it appears empty but the `WorkspaceShellSkeleton` fills it.
- Skip-to-content link follows `web-design-guidelines` (WCAG 2.4.1) — uses `sr-only` with `focus:not-sr-only` for keyboard-only visibility.
- If `SidebarProvider` interferes with PPR static prerendering, the fallback plan is to move it inside `WorkspaceAuth` (2B).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/workspace-shell-frame.tsx` | Create | Static server shell — no dynamic data |

---

### 2B — WorkspaceAuth (Suspense-Wrapped Auth Resolver)

**Type:** Frontend
**Parallelizable:** Yes — creates a new file; no dependency on 2A or 2C during creation.

**What:** Create `workspace-auth.tsx` — an async Server Component that resolves `getWorkspaceAccess()` inside a `<Suspense>` boundary. Handles redirects, not-provisioned states, and passes auth data to the client shell.

**Why:** With `cacheComponents: true`, any component accessing runtime APIs (`cookies()`, `headers()` — called by `withAuth()` inside `getWorkspaceAccess()`) MUST be inside a `<Suspense>` boundary. Without this, the build throws `Error: Uncached data was accessed outside of <Suspense>`. This component isolates the async auth resolution so the static shell can prerender.

**Where:**
- `app/workspace/_components/workspace-auth.tsx` (new)
- `app/workspace/_components/workspace-shell-skeleton.tsx` (new)

**How:**

**Step 1: Create the auth resolver component**

```typescript
// Path: app/workspace/_components/workspace-auth.tsx
import { type ReactNode } from "react";
import { getWorkspaceAccess } from "@/lib/auth";
import { redirect } from "next/navigation";
import { WorkspaceShellClient } from "./workspace-shell-client";
import { NotProvisionedScreen } from "./not-provisioned-screen";

/**
 * Resolves workspace access inside a Suspense boundary.
 * Redirects/shows error states as needed.
 * Streams in after the static frame is already visible.
 */
export async function WorkspaceAuth({ children }: { children: ReactNode }) {
  const access = await getWorkspaceAccess();

  switch (access.kind) {
    case "system_admin":
      redirect("/admin");
    case "pending_onboarding":
      redirect("/onboarding/connect");
    case "no_tenant":
    case "not_provisioned":
      return <NotProvisionedScreen />;
    case "ready":
      return (
        <WorkspaceShellClient
          initialRole={access.crmUser.role}
          initialDisplayName={access.crmUser.fullName ?? access.crmUser.email}
          initialEmail={access.crmUser.email}
          workosUserId={access.crmUser.workosUserId}
          workosOrgId={access.tenant.workosOrgId}
          tenantName={access.tenant.companyName}
        >
          {children}
        </WorkspaceShellClient>
      );
  }
}
```

**Step 2: Create the shell skeleton (Suspense fallback)**

This skeleton fills the sidebar and content area while auth resolves. It matches the dimensions of the real nav items to prevent CLS.

```typescript
// Path: app/workspace/_components/workspace-shell-skeleton.tsx
import { Skeleton } from "@/components/ui/skeleton";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

/**
 * Shown inside the sidebar/main area while auth resolves.
 * Matches the dimensions of the real nav to prevent CLS.
 */
export function WorkspaceShellSkeleton() {
  return (
    <>
      {/* Sidebar nav skeleton */}
      <SidebarGroup>
        <SidebarGroupLabel>Navigation</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {Array.from({ length: 4 }).map((_, i) => (
              <SidebarMenuItem key={i}>
                <Skeleton className="h-8 w-full rounded-md" />
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      {/* Main content loading */}
      <div className="flex flex-col gap-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
      </div>
    </>
  );
}
```

**Key implementation notes:**
- `WorkspaceAuth` is an async Server Component — it `await`s `getWorkspaceAccess()` which chains `withAuth()` → `fetchQuery(getCurrentTenant)` → `fetchQuery(getCurrentUser)`.
- Redirects (`redirect()`) become client-side redirects with PPR because the `200 OK` status is sent with the static shell before `WorkspaceAuth` resolves. This is acceptable because these are authenticated routes (not indexed by search engines).
- The `WorkspaceShellSkeleton` uses the same shadcn sidebar components as the real nav to prevent layout shift. 4 skeleton items match the typical nav count for admin users.
- Do NOT wrap `redirect()` in a try-catch — it throws internally and must propagate.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/workspace-auth.tsx` | Create | Async auth resolver inside Suspense |
| `app/workspace/_components/workspace-shell-skeleton.tsx` | Create | Auth loading skeleton |

---

### 2C — WorkspaceShellClient (Auth-Dependent Client Shell)

**Type:** Frontend
**Parallelizable:** Yes — creates a new file; no dependency on 2A or 2B during creation.

**What:** Extract the interactive, auth-dependent parts of the current `WorkspaceShell` into `workspace-shell-client.tsx` — role-based nav items, user info, sign-out, command palette, theme toggle, notification center, keyboard shortcuts, PostHog identification.

**Why:** The current `WorkspaceShell` is a monolithic `"use client"` component containing both the static frame (sidebar, header) and dynamic content (role-based nav, user info). By extracting the dynamic parts, the static frame can prerender while this component streams in with auth data.

**Where:**
- `app/workspace/_components/workspace-shell-client.tsx` (new — extracted from `workspace-shell.tsx`)

**How:**

**Step 1: Create the auth-dependent client shell**

This component receives auth data as props from `WorkspaceAuth` (server) and renders the interactive parts that need role/user information.

```typescript
// Path: app/workspace/_components/workspace-shell-client.tsx
"use client";

import { type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import type { CrmRole } from "@/convex/lib/roleMapping";
import { RoleProvider, useRole } from "@/components/auth/role-context";
import {
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  KanbanIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  SettingsIcon,
  type LucideIcon,
  UserCircleIcon,
  UsersIcon,
} from "lucide-react";
import { WorkspaceBreadcrumbs } from "@/components/workspace-breadcrumbs";
import { CommandPaletteTrigger } from "@/components/command-palette-trigger";
import { NotificationCenter } from "@/components/notification-center";
import { ThemeToggle } from "@/components/theme-toggle";
import { useKeyboardShortcut } from "@/hooks/use-keyboard-shortcut";
import { usePostHogIdentify } from "@/hooks/use-posthog-identify";
import posthog from "posthog-js";

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
  icon: LucideIcon;
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
// WorkspaceShellClient
// ---------------------------------------------------------------------------

interface WorkspaceShellClientProps {
  initialRole: CrmRole;
  initialDisplayName: string;
  initialEmail: string;
  workosUserId: string;
  workosOrgId: string;
  tenantName: string;
  children: ReactNode;
}

export function WorkspaceShellClient({
  initialRole,
  initialDisplayName,
  initialEmail,
  workosUserId,
  workosOrgId,
  tenantName,
  children,
}: WorkspaceShellClientProps) {
  return (
    <RoleProvider initialRole={initialRole}>
      <WorkspaceShellClientInner
        initialDisplayName={initialDisplayName}
        initialEmail={initialEmail}
        initialRole={initialRole}
        workosUserId={workosUserId}
        workosOrgId={workosOrgId}
        tenantName={tenantName}
      >
        {children}
      </WorkspaceShellClientInner>
    </RoleProvider>
  );
}

function WorkspaceShellClientInner({
  initialDisplayName,
  initialEmail,
  initialRole,
  workosUserId,
  workosOrgId,
  tenantName,
  children,
}: Omit<WorkspaceShellClientProps, "initialRole"> & { initialRole: CrmRole }) {
  const { isAdmin, role } = useRole();
  const { signOut } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const displayName = initialDisplayName || initialEmail;

  const navItems = isAdmin ? adminNavItems : closerNavItems;

  // Identify user in PostHog with full context
  usePostHogIdentify({
    workosUserId,
    email: initialEmail,
    name: initialDisplayName,
    role: initialRole,
    workosOrgId,
    tenantName,
  });

  const handleSignOut = () => {
    posthog.capture("user_signed_out");
    posthog.reset();
    signOut();
  };

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
    <>
      {/* Sidebar nav items — rendered inside SidebarContent via portal or direct children */}
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

      {/* Sidebar footer — user info and sign out */}
      <SidebarFooter>
        <div className="flex flex-col gap-1 px-2 py-1.5">
          <p className="truncate text-sm font-medium">{displayName}</p>
          <p className="text-xs capitalize text-sidebar-foreground/70">
            {role.replace(/_/g, " ")}
          </p>
        </div>
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
              onClick={handleSignOut}
              tooltip="Sign out"
            >
              <LogOutIcon />
              <span>Sign Out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      {/* Header toolbar — streams in after auth */}
      <div className="ml-auto flex items-center gap-2">
        <WorkspaceBreadcrumbs />
        <CommandPaletteTrigger />
        <ThemeToggle />
        <NotificationCenter />
      </div>

      {/* Page content */}
      {children}

      {/* Command palette — global overlay */}
      <CommandPalette />
    </>
  );
}
```

**Key implementation notes:**
- This component renders fragments (`<>...</>`) that get composed into the frame by the layout. The exact wiring depends on how `WorkspaceShellFrame` slots children — see subphase 2D.
- The current `workspace-shell.tsx` wraps everything in `<SidebarProvider>`. In the new architecture, `SidebarProvider` lives in `WorkspaceShellFrame` (2A). This client component renders *inside* that provider context.
- `RoleProvider` stays in this component — it wraps the role-reactive UI (nav items change when role changes).
- The `usePostHogIdentify`, `useKeyboardShortcut`, `useAuth` hooks all require a `"use client"` component — they stay here.
- The exact DOM structure for slotting nav items into the sidebar and toolbar items into the header will be refined in 2D when wiring the layout. The key point is that this component contains all the auth-dependent interactive pieces.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/workspace-shell-client.tsx` | Create | Auth-dependent interactive shell |

---

### 2D — Layout Wiring & Activity Verification

**Type:** Full-Stack
**Parallelizable:** No — depends on 2A, 2B, 2C being complete.

**What:** Rewire `app/workspace/layout.tsx` to compose `WorkspaceShellFrame` → `<Suspense>` → `WorkspaceAuth` → `WorkspaceShellClient`. Verify Activity state preservation and auth flows work correctly. Mark the old `workspace-shell.tsx` as deprecated.

**Why:** This is where all three new components come together. The layout becomes the orchestrator: static frame wraps Suspense wraps auth wraps client shell wraps page content. Without this wiring, the components exist in isolation.

**Where:**
- `app/workspace/layout.tsx` (modify)
- `app/workspace/_components/workspace-shell.tsx` (modify — deprecate or remove)

**How:**

**Step 1: Rewrite the workspace layout**

```typescript
// Path: app/workspace/layout.tsx

// BEFORE:
import { type ReactNode } from "react";
import { getWorkspaceAccess } from "@/lib/auth";
import { redirect } from "next/navigation";
import { WorkspaceShell } from "./_components/workspace-shell";
import { NotProvisionedScreen } from "./_components/not-provisioned-screen";

export default async function WorkspaceLayout({
  children,
}: {
  children: ReactNode;
}) {
  const access = await getWorkspaceAccess();

  switch (access.kind) {
    case "system_admin":
      redirect("/admin");
    case "pending_onboarding":
      redirect("/onboarding/connect");
    case "no_tenant":
    case "not_provisioned":
      return <NotProvisionedScreen />;
    case "ready":
      return (
        <WorkspaceShell
          initialRole={access.crmUser.role}
          initialDisplayName={access.crmUser.fullName ?? access.crmUser.email}
          initialEmail={access.crmUser.email}
          workosUserId={access.crmUser.workosUserId}
          workosOrgId={access.tenant.workosOrgId}
          tenantName={access.tenant.companyName}
        >
          {children}
        </WorkspaceShell>
      );
  }
}
```

```typescript
// Path: app/workspace/layout.tsx

// AFTER:
import { type ReactNode, Suspense } from "react";
import { WorkspaceShellFrame } from "./_components/workspace-shell-frame";
import { WorkspaceAuth } from "./_components/workspace-auth";
import { WorkspaceShellSkeleton } from "./_components/workspace-shell-skeleton";

export default function WorkspaceLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <WorkspaceShellFrame>
      <Suspense fallback={<WorkspaceShellSkeleton />}>
        <WorkspaceAuth>{children}</WorkspaceAuth>
      </Suspense>
    </WorkspaceShellFrame>
  );
}
```

**Step 2: Handle DOM composition**

The biggest implementation challenge is slotting auth-dependent content into the correct locations within the static frame. The `WorkspaceShellFrame` has three content areas:
1. **Sidebar nav** — inside `<SidebarContent>`
2. **Header toolbar** — inside the `<header>` bar
3. **Main content** — inside `<div id="main-content">`

Since `WorkspaceShellClient` renders as a fragment, the wiring may need to be adjusted. Two approaches:

**Approach A (Recommended): Restructure the frame to accept slotted children.**

Modify `WorkspaceShellFrame` to accept `sidebarContent`, `headerContent`, and `children` as separate props:

```typescript
// Path: app/workspace/_components/workspace-shell-frame.tsx (adjustment)

interface WorkspaceShellFrameProps {
  children: ReactNode; // Main content area
}

// The Suspense boundary wraps the entire frame content (sidebar nav + header tools + page content).
// WorkspaceShellClient renders all three areas as a single streamed unit.
```

**Approach B: Keep the frame simple and let client shell render into frame's children slot.**

The `WorkspaceShellClient` renders sidebar nav + footer + header tools + page content as a single component that gets slotted into the frame. This means the frame's `<SidebarContent>` and `<header>` contain {children} which is the full Suspense-wrapped auth output.

> **Implementation note:** The exact DOM composition should be validated during implementation. The design doc proposes the frame + auth split, but the shadcn sidebar components use React context (`SidebarProvider`) which must wrap all sidebar subcomponents. Test both approaches and choose whichever results in correct sidebar behavior + PPR prerendering.

**Step 3: Verify Activity state preservation**

With `cacheComponents: true` from Phase 1, Activity is automatically enabled. Test:

1. Navigate to `/workspace` → toggle sidebar closed → navigate to `/workspace/closer` → navigate back to `/workspace` → sidebar should still be closed (preserved by Activity).
2. Navigate to `/workspace/closer` → scroll down in the page → navigate to `/workspace/pipeline` → navigate back to `/workspace/closer` → scroll position should be restored.
3. Open command palette → navigate to another route → palette should close (transient state resets on Activity hide via `useLayoutEffect` cleanup).

**Step 4: Verify auth flows**

1. Sign in as system_admin → navigate to `/workspace` → should redirect to `/admin`.
2. Sign in as pending_onboarding user → navigate to `/workspace` → should redirect to `/onboarding/connect`.
3. Sign in as not_provisioned user → navigate to `/workspace` → should see `NotProvisionedScreen`.
4. Sign in as admin → navigate to `/workspace` → should see admin dashboard with correct nav items.
5. Sign in as closer → navigate to `/workspace/closer` → should see closer dashboard with correct nav items.

**Step 5: Mark old workspace-shell.tsx as deprecated**

```typescript
// Path: app/workspace/_components/workspace-shell.tsx

// Add at the top of the file:
/**
 * @deprecated This component has been split into three parts:
 * - WorkspaceShellFrame (static server shell)
 * - WorkspaceAuth (Suspense-wrapped auth resolver)
 * - WorkspaceShellClient (auth-dependent client shell)
 *
 * See layout.tsx for the new composition.
 * This file can be deleted once all imports are updated.
 */
```

**Key implementation notes:**
- The layout is no longer `async` — it's a synchronous Server Component that composes static frame + Suspense boundary. This is what enables PPR prerendering.
- With PPR, redirects become client-side (`<meta>` tag injection) because the `200 OK` is sent with the static shell before `WorkspaceAuth` resolves. This is acceptable for authenticated routes.
- `SidebarProvider` context must wrap all sidebar subcomponents. If `WorkspaceShellFrame` renders `SidebarProvider` and `WorkspaceShellClient` renders `SidebarMenu`, the client shell must be a descendant in the React tree (which it is via children).
- Activity preserves hidden routes in the DOM with `display: none`. Effects cleanup when hidden, re-run when visible. Convex `useQuery` subscriptions will pause when hidden and resume when visible — no stale data.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/layout.tsx` | Modify | Rewire to use frame + Suspense + auth |
| `app/workspace/_components/workspace-shell.tsx` | Modify | Deprecation notice |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/_components/workspace-shell-frame.tsx` | Create | 2A |
| `app/workspace/_components/workspace-auth.tsx` | Create | 2B |
| `app/workspace/_components/workspace-shell-skeleton.tsx` | Create | 2B |
| `app/workspace/_components/workspace-shell-client.tsx` | Create | 2C |
| `app/workspace/layout.tsx` | Modify | 2D |
| `app/workspace/_components/workspace-shell.tsx` | Modify | 2D |
