# Phase 1 — Foundation: Auth Layer, Permissions & Proxy Upgrade

**Goal:** Create the five foundational files that all subsequent authorization phases depend on: a server-only session/tenant/role access layer, a permission vocabulary, a client role context provider, permission-gated UX helpers, and an upgraded proxy with coarse route gating.

**Prerequisite:** None -- this is the foundation phase. Existing `convex/lib/roleMapping.ts` and `lib/system-admin-org.ts` must be present (they already are).

**Runs in PARALLEL with:** Nothing -- all subsequent phases depend on the auth primitives created here.

**Skills to invoke:**
- None -- this is pure implementation following the design guidelines.

**Acceptance Criteria:**
1. `lib/auth.ts` exports `verifySession()`, `getWorkspaceAccess()`, `requireWorkspaceUser()`, `requireRole()`, and `requireSystemAdmin()`.
2. `verifySession()` returns a `VerifiedSession` with guaranteed non-null `user`, `accessToken`, and `organizationId`; redirects to `/sign-in` on failure.
3. `getWorkspaceAccess()` returns one of five discriminated kinds: `system_admin`, `no_tenant`, `pending_onboarding`, `not_provisioned`, or `ready`.
4. `resolveCrmUser()` calls `claimInvitedAccount` when `getCurrentUser` returns null, then re-fetches.
5. `requireWorkspaceUser()` redirects non-ready users to the correct route (system admins to `/admin`, pending tenants to `/onboarding/connect`, others to `/`).
6. `requireRole()` redirects users without an allowed role to a role-appropriate fallback.
7. `convex/lib/permissions.ts` exports `PERMISSIONS`, `Permission` type, and `hasPermission()` function.
8. `components/auth/role-context.tsx` exports `RoleProvider` and `useRole()` hook that provides `role`, `isAdmin`, and `hasPermission`.
9. `components/auth/require-permission.tsx` exports `RequirePermission` and `AdminOnly` wrapper components.
10. `proxy.ts` uses the composable `authkit()` API instead of `authkitProxy()` and gates `/admin` to system admins and `/workspace` to authenticated org users.
11. `pnpm tsc --noEmit` passes without errors.
12. The `config` matcher export is preserved unchanged in `proxy.ts`.

---

## Subphase Dependency Graph

```
1A (lib/auth.ts — server access layer) ────────────────────────────┐
                                                                   │
1B (convex/lib/permissions.ts — permission vocabulary) ────────┐   │
                                                               │   │
1C (components/auth/role-context.tsx — depends on 1B) ─────┐   │   │
                                                           │   │   │
1D (components/auth/require-permission.tsx — depends on 1B+1C) │   │
                                                               │   │
1E (proxy.ts — proxy upgrade, independent) ────────────────────┘───┘
```

**Optimal execution:**
1. Start 1A, 1B, and 1E in parallel (they touch completely separate files and have no cross-dependencies).
2. Once 1B is done, start 1C (imports `Permission` type and `hasPermission` from 1B).
3. Once 1B and 1C are done, start 1D (imports `Permission` from 1B and `useRole` from 1C).

**Estimated time:** 1-2 days

**Risk level:** Low to medium. `proxy.ts` is behavior-changing -- the switch from `authkitProxy()` to `authkit()` alters how every request is processed. Test thoroughly in dev before deploying.

---

## Subphases

### 1A — Server Access Layer (`lib/auth.ts`)

**Type:** Backend
**Parallelizable:** Yes -- independent of 1B, 1C, 1D, 1E. Only touches `lib/auth.ts`.

**What:** Create the core server-only authorization module with session verification, workspace access resolution, invite claim repair, and role-gated redirect helpers. This is the most critical piece of the entire authorization revamp.

**Why:** Every protected page in the application will call one of these helpers to enforce authorization before rendering. Without a server-side auth layer, authorization decisions happen client-side after HTML is already sent, creating a flash of unauthorized content and a security gap.

**Where:**
- `lib/auth.ts` (new file)

**How:**

**Step 1: Create `lib/auth.ts` with all types, session verification, workspace access resolution, and narrowing helpers**

```typescript
// Path: lib/auth.ts

import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { fetchMutation, fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { SYSTEM_ADMIN_ORG_ID } from "@/lib/system-admin-org";
import type { Doc } from "@/convex/_generated/dataModel";
import type { CrmRole } from "@/convex/lib/roleMapping";

type AuthResult = Awaited<ReturnType<typeof withAuth>>;
type CurrentTenant = {
  tenantId: string;
  companyName: string;
  workosOrgId: string;
  status:
    | "pending_signup"
    | "pending_calendly"
    | "provisioning_webhooks"
    | "active"
    | "calendly_disconnected"
    | "suspended"
    | "invite_expired";
  calendlyWebhookUri?: string;
  onboardingCompletedAt?: number;
};

export type VerifiedSession = AuthResult & {
  user: NonNullable<AuthResult["user"]>;
  accessToken: string;
  organizationId: string;
};

export type WorkspaceAccess =
  | { kind: "system_admin"; session: VerifiedSession }
  | { kind: "no_tenant"; session: VerifiedSession }
  | {
      kind: "pending_onboarding";
      session: VerifiedSession;
      tenant: CurrentTenant;
    }
  | {
      kind: "not_provisioned";
      session: VerifiedSession;
      tenant: CurrentTenant | null;
    }
  | {
      kind: "ready";
      session: VerifiedSession;
      tenant: CurrentTenant;
      crmUser: Doc<"users">;
    };

/**
 * Verify that a request has a valid, authenticated session.
 * Redirects to /sign-in if not authenticated.
 * Cached per-request via React's cache() function.
 */
export const verifySession = cache(async (): Promise<VerifiedSession> => {
  const auth = await withAuth({ ensureSignedIn: true });

  if (!auth.user || !auth.accessToken || !auth.organizationId) {
    redirect("/sign-in");
  }

  return auth as VerifiedSession;
});

/**
 * Resolve the CRM user for a verified session. If no user exists,
 * attempts to claim an invited account and re-fetches.
 * Cached per-request so multiple consumers share a single result.
 */
const resolveCrmUser = cache(async (session: VerifiedSession) => {
  let crmUser = await fetchQuery(
    api.users.queries.getCurrentUser,
    {},
    { token: session.accessToken }
  );

  if (!crmUser) {
    await fetchMutation(
      api.workos.userMutations.claimInvitedAccount,
      {},
      { token: session.accessToken }
    );

    crmUser = await fetchQuery(
      api.users.queries.getCurrentUser,
      {},
      { token: session.accessToken }
    );
  }

  return crmUser;
});

/**
 * Resolve the full workspace access state for the current request.
 * Returns a discriminated union describing system admin, tenant lifecycle,
 * or ready-to-use workspace access.
 */
export const getWorkspaceAccess = cache(
  async (): Promise<WorkspaceAccess> => {
    const session = await verifySession();

    // System admin check: organization-based, not role-based
    if (session.organizationId === SYSTEM_ADMIN_ORG_ID) {
      return { kind: "system_admin", session };
    }

    // Fetch tenant for this organization
    const tenant = await fetchQuery(
      api.tenants.getCurrentTenant,
      {},
      { token: session.accessToken }
    );

    if (!tenant) {
      return { kind: "no_tenant", session };
    }

    // Pending tenants should not access the active workspace
    if (tenant.status !== "active") {
      return { kind: "pending_onboarding", session, tenant };
    }

    // Resolve CRM user (may trigger invite claim)
    const crmUser = await resolveCrmUser(session);
    if (!crmUser) {
      return { kind: "not_provisioned", session, tenant };
    }

    return { kind: "ready", session, tenant, crmUser };
  }
);

/**
 * Require a fully provisioned workspace user.
 * Redirects non-ready access kinds to the appropriate route.
 * Returns the "ready" access state.
 */
export async function requireWorkspaceUser() {
  const access = await getWorkspaceAccess();

  switch (access.kind) {
    case "system_admin":
      redirect("/admin");
    case "pending_onboarding":
      redirect("/onboarding/connect");
    case "no_tenant":
      redirect("/");
    case "not_provisioned":
      redirect("/");
    case "ready":
      return access;
  }
}

/**
 * Require a workspace user with one of the specified CRM roles.
 * Redirects to a role-appropriate fallback if the user lacks permission.
 */
export async function requireRole(allowedRoles: CrmRole[]) {
  const access = await requireWorkspaceUser();

  if (!allowedRoles.includes(access.crmUser.role)) {
    const fallback =
      access.crmUser.role === "closer" ? "/workspace/closer" : "/workspace";
    redirect(fallback);
  }

  return access;
}

/**
 * Require system admin access. Redirects to /workspace if the
 * session does not belong to the system admin organization.
 */
export async function requireSystemAdmin() {
  const session = await verifySession();

  if (session.organizationId !== SYSTEM_ADMIN_ORG_ID) {
    redirect("/workspace");
  }

  return session;
}
```

**Step 2: Verify types compile**

Run `pnpm tsc --noEmit` to ensure the new file compiles. The `"server-only"` import prevents accidental client-side usage.

**Key implementation notes:**
- `"server-only"` at the top ensures a build error if this module is ever imported from a `"use client"` file.
- `cache()` from React deduplicates calls per-request, so `verifySession()` and `getWorkspaceAccess()` can be called from multiple Server Components in the same render without duplicate Convex round-trips.
- `VerifiedSession` narrows the AuthKit result to guarantee `user`, `accessToken`, and `organizationId` are present -- no optional chaining needed downstream.
- `resolveCrmUser` is intentionally NOT exported. It is an internal helper consumed only by `getWorkspaceAccess()`.
- System admin check happens before tenant lookup so that system admins with no CRM user document can still access `/admin`.
- Tenant status check happens before CRM user resolution so we do not attempt to claim an invite for a non-active tenant.
- `redirect()` in a switch case does not need `break` because `redirect()` throws a Next.js redirect error.
- `CurrentTenant` includes `"invite_expired"` which is not in the Convex schema `status` union but is returned by the `getCurrentTenant` query for expired invites.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `lib/auth.ts` | Create | Server-only auth layer: session, workspace access, role guards |

---

### 1B — Permission Vocabulary (`convex/lib/permissions.ts`)

**Type:** Backend / Shared
**Parallelizable:** Yes -- independent of 1A, 1C, 1D, 1E. Only touches `convex/lib/permissions.ts`.

**What:** Create a standalone permission vocabulary that maps semantic permission slugs to the CRM roles that hold them. Exports a `PERMISSIONS` map, a `Permission` type, and a `hasPermission()` function.

**Why:** Today, role checks are scattered as ad-hoc string comparisons (`role === "closer"`, `ADMIN_ROLES.includes(role)`). A centralized permission map creates a single source of truth for what each role can do. Both the client role context (1C) and the permission gate components (1D) depend on this vocabulary.

**Where:**
- `convex/lib/permissions.ts` (new file)

**How:**

**Step 1: Create `convex/lib/permissions.ts`**

```typescript
// Path: convex/lib/permissions.ts

export const PERMISSIONS = {
  "team:invite": ["tenant_master", "tenant_admin"],
  "team:remove": ["tenant_master", "tenant_admin"],
  "team:update-role": ["tenant_master"],
  "pipeline:view-all": ["tenant_master", "tenant_admin"],
  "pipeline:view-own": ["tenant_master", "tenant_admin", "closer"],
  "settings:manage": ["tenant_master", "tenant_admin"],
  "meeting:view-own": ["tenant_master", "tenant_admin", "closer"],
  "meeting:manage-own": ["closer"],
  "payment:record": ["closer"],
  "payment:view-all": ["tenant_master", "tenant_admin"],
  "payment:view-own": ["tenant_master", "tenant_admin", "closer"],
} as const;

export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(role: string, permission: Permission): boolean {
  const allowedRoles = PERMISSIONS[permission];
  return (allowedRoles as readonly string[]).includes(role);
}
```

**Step 2: Verify imports compile**

Run `pnpm tsc --noEmit`. The file has no dependencies on other new files -- it uses plain strings rather than importing `CrmRole` from `roleMapping.ts`. The `as const` assertion and `keyof typeof` derive the `Permission` type directly from the map keys.

**Key implementation notes:**
- `PERMISSIONS` uses `as const` to preserve literal types. This means `Permission` is a union of string literals like `"team:invite" | "team:remove" | ...`.
- `hasPermission()` accepts `role: string` (not `CrmRole`) for flexibility. The permission map values are `readonly string[]` after the `as const` assertion, so we cast to `readonly string[]` for the `.includes()` call.
- This vocabulary is NOT yet enforced in Convex mutations. Existing `requireTenantUser(ctx, ['role'])` checks remain as-is until Phase 3+.
- No import of `CrmRole` is needed because the role strings in the map are self-documenting and the `hasPermission` function accepts any string.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/permissions.ts` | Create | Permission vocabulary: role-to-permission mapping |

---

### 1C — Client Role Provider (`components/auth/role-context.tsx`)

**Type:** Frontend
**Parallelizable:** Partially -- depends on 1B for `Permission` type and `hasPermission` function.

**What:** Create a React context provider that holds the current user's CRM role, derived `isAdmin` flag, and a `hasPermission()` convenience method. The provider accepts an `initialRole` prop (set by the server layout) and stays fresh via a live Convex subscription to `getCurrentUser`.

**Why:** Today, every client component that needs role information calls `useQuery(api.users.queries.getCurrentUser)` independently and performs its own role checks. This provider centralizes that logic and ensures role changes (e.g., admin promotes a closer mid-session) are reflected immediately across the component tree.

**Where:**
- `components/auth/role-context.tsx` (new file)

**How:**

**Step 1: Create `components/auth/role-context.tsx`**

```tsx
// Path: components/auth/role-context.tsx

"use client";

import { createContext, use, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { CrmRole } from "@/convex/lib/roleMapping";
import type { Permission } from "@/convex/lib/permissions";
import { hasPermission } from "@/convex/lib/permissions";

type RoleContextValue = {
  role: CrmRole;
  isAdmin: boolean;
  hasPermission: (permission: Permission) => boolean;
};

const RoleContext = createContext<RoleContextValue | null>(null);

export function RoleProvider({
  initialRole,
  children,
}: {
  initialRole: CrmRole;
  children: ReactNode;
}) {
  const currentUser = useQuery(api.users.queries.getCurrentUser);
  const role = currentUser?.role ?? initialRole;

  const isAdmin = role === "tenant_master" || role === "tenant_admin";

  return (
    <RoleContext
      value={{
        role,
        isAdmin,
        hasPermission: (permission) => hasPermission(role, permission),
      }}
    >
      {children}
    </RoleContext>
  );
}

export function useRole() {
  const ctx = use(RoleContext);
  if (!ctx) throw new Error("useRole must be used within RoleProvider");
  return ctx;
}
```

**Step 2: Verify the context compiles and imports resolve**

Run `pnpm tsc --noEmit`. Confirm that `convex/lib/permissions` is importable from a client component (it contains no server-only code).

**Key implementation notes:**
- `initialRole` is provided by the server layout (from `access.crmUser.role`). This avoids a loading flash on first render.
- `useQuery(api.users.queries.getCurrentUser)` creates a live Convex subscription. When the user's role changes in the database, the context value updates automatically and all consumers re-render.
- `currentUser?.role ?? initialRole` means the server-provided role is used until the Convex subscription resolves, then the live value takes over. This handles the brief window where the subscription is loading.
- `use(RoleContext)` is the React 19 API for consuming context (replaces `useContext`). It works in both sync and async components.
- The `hasPermission` method on the context value is a bound closure over the current `role`, so consumers do not need to pass `role` explicitly.
- `RoleProvider` will be mounted inside the workspace shell layout (Phase 2). It should wrap all workspace page content.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `components/auth/role-context.tsx` | Create | Client role context with live Convex subscription |

---

### 1D — Permission Gate Components (`components/auth/require-permission.tsx`)

**Type:** Frontend
**Parallelizable:** No -- depends on 1B (`Permission` type) and 1C (`useRole` hook).

**What:** Create two declarative wrapper components for permission-gated UI: `RequirePermission` (shows children only if the user has a specific permission) and `AdminOnly` (shows children only if the user is an admin).

**Why:** Permission checks in JSX are currently inline conditionals scattered across the codebase (e.g., `{isAdmin && <InviteButton />}`). These wrapper components make permission intent explicit, reduce boilerplate, and ensure consistent fallback behavior.

**Where:**
- `components/auth/require-permission.tsx` (new file)

**How:**

**Step 1: Create `components/auth/require-permission.tsx`**

```tsx
// Path: components/auth/require-permission.tsx

"use client";

import type { ReactNode } from "react";
import type { Permission } from "@/convex/lib/permissions";
import { useRole } from "./role-context";

export function RequirePermission({
  permission,
  children,
  fallback = null,
}: {
  permission: Permission;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { hasPermission } = useRole();
  return hasPermission(permission) ? children : fallback;
}

export function AdminOnly({
  children,
  fallback = null,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { isAdmin } = useRole();
  return isAdmin ? children : fallback;
}
```

**Step 2: Verify the components compile**

Run `pnpm tsc --noEmit`. Both components depend on `useRole()` from `role-context.tsx` (1C) and `Permission` from `convex/lib/permissions.ts` (1B).

**Key implementation notes:**
- Both components accept an optional `fallback` prop (defaults to `null`). This allows rendering alternative UI for unauthorized users (e.g., a disabled button, an upgrade prompt) instead of hiding content entirely.
- `RequirePermission` checks a specific permission slug. `AdminOnly` checks the broader `isAdmin` flag.
- These components are NOT security boundaries. They are UX affordances that hide controls the user cannot use. The actual security enforcement lives in Convex mutations and the server auth layer.
- The return type is `ReactNode` (not `JSX.Element`) so fragments, strings, and null all work as children.
- Usage example:
  ```tsx
  <RequirePermission permission="team:invite">
    <InviteTeamMemberButton />
  </RequirePermission>

  <AdminOnly fallback={<p>Contact your admin to manage settings.</p>}>
    <SettingsPanel />
  </AdminOnly>
  ```

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `components/auth/require-permission.tsx` | Create | Permission-gated UX wrapper components |

---

### 1E — Proxy Upgrade (`proxy.ts`)

**Type:** Backend / Config
**Parallelizable:** Yes -- independent of 1A, 1B, 1C, 1D. Only touches `proxy.ts`.

**What:** Replace the current `authkitProxy({ middlewareAuth: { enabled: true } })` with the composable `authkit()` and `handleAuthkitHeaders()` API. Add coarse route gating: public paths pass through, unauthenticated users on protected paths are redirected to login, `/admin` is restricted to the system admin organization, and `/workspace` requires an `organizationId`.

**Why:** The current proxy can only answer "is there a session?" -- it cannot inspect claims like `organizationId` to make routing decisions. The composable API exposes the full session object, allowing the proxy to serve as the first defense-in-depth layer. System admins get routed to `/admin`, non-admins are blocked from `/admin`, and org-less users cannot reach `/workspace`.

**Where:**
- `proxy.ts` (modify)

**How:**

**Step 1: Replace `proxy.ts` contents**

Before (current):

```typescript
// Path: proxy.ts

import { authkitProxy } from "@workos-inc/authkit-nextjs";

export default authkitProxy({
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: ["/sign-in", "/sign-up", "/callback", "/onboarding"],
  },
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
```

After (target):

```typescript
// Path: proxy.ts

import { NextRequest } from "next/server";
import { authkit, handleAuthkitHeaders } from "@workos-inc/authkit-nextjs";
import { SYSTEM_ADMIN_ORG_ID } from "@/lib/system-admin-org";

const PUBLIC_PREFIXES = [
  "/sign-in",
  "/sign-up",
  "/callback",
  "/onboarding",
] as const;

function isPublicPath(pathname: string) {
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

export default async function proxy(request: NextRequest) {
  const { session, headers, authorizationUrl } = await authkit(request);
  const { pathname } = request.nextUrl;

  // Public paths bypass auth entirely
  if (isPublicPath(pathname)) {
    return handleAuthkitHeaders(request, headers);
  }

  // Unauthenticated users on protected paths -> redirect to login
  if (!session.user && authorizationUrl) {
    return handleAuthkitHeaders(request, headers, {
      redirect: authorizationUrl,
    });
  }

  // /admin routes: only SYSTEM_ADMIN_ORG_ID users
  if (pathname.startsWith("/admin")) {
    if (session.organizationId !== SYSTEM_ADMIN_ORG_ID) {
      return handleAuthkitHeaders(request, headers, {
        redirect: "/workspace",
      });
    }
  }

  // /workspace routes: require any organizationId
  if (pathname.startsWith("/workspace")) {
    if (!session.organizationId) {
      return handleAuthkitHeaders(request, headers, {
        redirect: "/sign-in",
      });
    }
  }

  // All other authenticated requests pass through
  return handleAuthkitHeaders(request, headers);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
```

**Step 2: Verify behavior in development**

After the change:
- Unauthenticated user requests `/workspace/team` -- redirected to sign-in before HTML is sent.
- System admin requests `/admin` -- passes through proxy, proceeds to server layer.
- Non-system-admin requests `/admin` -- redirected to `/workspace` at the proxy layer.
- Authenticated user with `organizationId` requests `/workspace` -- passes through proxy, proceeds to server layer.
- Any request to `/sign-in`, `/sign-up`, `/callback/**`, `/onboarding/**` -- passes through with no auth check.

**Key implementation notes:**
- The `config` export with the `matcher` pattern is preserved unchanged. This ensures the proxy runs on the same set of requests as before.
- `PUBLIC_PREFIXES` uses `as const` for type narrowing but the runtime behavior is a simple `.some()` check.
- `isPublicPath()` checks both exact matches (`/sign-in`) and prefix matches (`/sign-in/...`) to handle nested routes correctly.
- The proxy does NOT call Convex. It only reads session/cookie claims. This keeps proxy execution fast (<5ms typically).
- The proxy does NOT check CRM roles (closer vs. admin). That is the server auth layer's responsibility (1A).
- The proxy is optimistic: it improves UX and provides a first security layer, but it is NOT the final security boundary. The server auth layer and Convex mutations are the authoritative enforcement points.
- `SYSTEM_ADMIN_ORG_ID` is imported from `lib/system-admin-org.ts` which re-exports from `convex/lib/constants.ts`.
- The `/onboarding` prefix includes all onboarding sub-routes (e.g., `/onboarding/connect`). These are public in the proxy because the server layer handles onboarding-specific gating.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `proxy.ts` | Modify | Replace `authkitProxy(...)` with composable `authkit()` and route gating |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `lib/auth.ts` | Create | 1A |
| `convex/lib/permissions.ts` | Create | 1B |
| `components/auth/role-context.tsx` | Create | 1C |
| `components/auth/require-permission.tsx` | Create | 1D |
| `proxy.ts` | Modify | 1E |
| `convex/lib/roleMapping.ts` | Verify exists | 1B (dependency) |
| `lib/system-admin-org.ts` | Verify exists | 1A, 1E (dependency) |
