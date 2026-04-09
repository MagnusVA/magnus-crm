# Authorization Revamp Design

## Review Outcome

The original proposal was directionally correct, but it was not sufficient as written.

Three blocking gaps had to be closed:

1. **Invited-user claim could not remain client-only.** Once page authorization moves into Server Components, the current "claim invited account after first render" flow in `app/workspace/layout.tsx` would run too late.
2. **Workspace access needed tenant lifecycle checks, not only role/org checks.** In this repo, `/workspace` is only valid once the tenant is active. Pending tenants belong in `/onboarding/connect`.
3. **The client role context needed a freshness strategy.** If the role context only receives a static role prop from the workspace layout, soft navigations and live role changes would leave stale UI state in place.

This revision resolves those gaps and converts the remaining open questions into explicit design decisions based on the current repo, Next.js `16.2.x`, Convex `1.34.x`, and `@workos-inc/authkit-nextjs` `3.x`.

## Problem Statement

The PTDOM CRM currently implements authorization primarily in client components:

- `app/workspace/layout.tsx` is a `"use client"` layout that fetches `api.users.queries.getCurrentUser` and redirects closers away from admin-only pages in the browser.
- Workspace pages such as `/workspace`, `/workspace/team`, `/workspace/pipeline`, and `/workspace/settings` are all `"use client"` pages that call `useQuery(...)` and branch on `currentUser.role`.
- `app/admin/page.tsx` gates the system admin console in the browser by checking `organizationId === SYSTEM_ADMIN_ORG_ID`.
- `proxy.ts` currently uses `authkitProxy({ middlewareAuth: { enabled: true } })`, so it only checks "is there a valid session?" and performs zero route-level authorization.

This creates four concrete problems:

1. **Unauthorized HTML can be rendered before redirects happen.**
2. **Role checks in the workspace layout do not re-run on soft navigation.**
3. **The Next.js runtime has no centralized authorization layer yet.**
4. **The current invited-user claim flow depends on client rendering and cannot survive an RSC-first architecture without being redesigned.**

## Current Repo Realities

Any design for this repo must respect these existing behaviors:

### 1. System admin access is organization-based

System admins are identified by `SYSTEM_ADMIN_ORG_ID`, not by a CRM `users` record. A system admin session may legitimately have **no CRM user document** at all.

### 2. Workspace access is both auth and lifecycle sensitive

Tenant users should not enter the normal workspace until the tenant is ready:

- `tenant.status === "active"` -> `/workspace`
- tenant exists but not active -> `/onboarding/connect`
- no tenant / no CRM user -> not provisioned flow

### 3. Invited users can authenticate before they are claim-linked

The callback route already establishes a WorkOS session before the CRM user is fully linked. Today the workspace layout patches this by calling `api.workos.userActions.claimInvitedAccount` after `getCurrentUser` resolves to `null`.

That behavior is critical and must be preserved, but it can no longer remain client-only.

### 4. CRM role changes are fresher than session role claims

`convex/workos/userManagement.ts` updates:

- the CRM user role immediately, and
- the WorkOS membership role for the **next session**

So, for this phase, CRM role data remains the authoritative source for app authorization. WorkOS `role` / `roles` / `permissions` are available in AuthKit, but they are session-bound and may lag until `refreshSession()` / `refreshAuth()` runs.

### 5. Not every page can be fully preloaded

The system admin console uses `usePaginatedQuery`, which has no `preloadQuery` equivalent. That page still benefits from an RSC auth wrapper even if the data stays client-side.

## Design Principles

1. **Defense in depth.** Proxy, server runtime, and Convex all enforce authorization. Client UI never counts as a security boundary.
2. **Server-first route gating.** Protected pages authorize before protected UI is rendered.
3. **Convex remains the authoritative data layer.** All mutations and sensitive queries continue to enforce auth with `requireTenantUser(...)` or `requireSystemAdminSession(...)`.
4. **CRM role is the source of truth in Phase 1.** WorkOS permissions are exposed by AuthKit, but we do not promote them to the primary authorization source until session refresh handling is part of the flow.
5. **Composition over scattered role checks.** Client affordance checks move into a small auth UI layer instead of ad hoc `useQuery(getCurrentUser)` calls spread across the tree.

## Route Decision Matrix

| Route family | Proxy decision | Server decision | Final outcome |
|--------------|----------------|-----------------|---------------|
| `/admin/**` | Require authenticated session and `organizationId === SYSTEM_ADMIN_ORG_ID` | `requireSystemAdmin()` | System admin console only |
| `/workspace/**` | Require authenticated session and some `organizationId` | `getWorkspaceAccess()` + `requireRole(...)` | Active tenant workspace only |
| `/onboarding/**` | Public in proxy | Page logic or optional future RSC gate checks session + tenant status | Pending tenant onboarding only |
| `/sign-in`, `/sign-up`, `/callback/**` | Public | AuthKit routes keep current behavior | Public auth flow |
| `/api/calendly/**`, `/callback/calendly` | Proxy covered so `withAuth()` works | Route handler calls `withAuth({ ensureSignedIn: true })` | Protected by route handler |
| `/` | Public in proxy | Existing redirect logic can remain for now | Public landing or authenticated redirect |

## Architecture: Four Authorization Layers

```
Request
  |
  v
+--------------------------------------------------------------+
| LAYER 1: Proxy (`proxy.ts`)                                  |
| Purpose: optimistic gate using only cookie/session claims    |
| Checks: authenticated? org present? system admin org?        |
+--------------------------------------------------------------+
  |
  v
+--------------------------------------------------------------+
| LAYER 2: Next.js server access layer (`lib/auth.ts`)         |
| Purpose: real route/page authorization before rendering      |
| Checks: session valid? tenant status valid? CRM user exists? |
|         server-side invite claim needed? role allowed?       |
+--------------------------------------------------------------+
  |
  v
+--------------------------------------------------------------+
| LAYER 3: Convex function auth                                |
| Purpose: row-level and mutation-level authorization          |
| Checks: requireTenantUser / requireSystemAdminSession        |
+--------------------------------------------------------------+
  |
  v
+--------------------------------------------------------------+
| LAYER 4: Client affordance layer                             |
| Purpose: nav, buttons, and dialogs adapt to permissions      |
| Checks: RoleProvider / RequirePermission                     |
| Note: never trusted as security                              |
+--------------------------------------------------------------+
```

## Layer 1: Proxy (`proxy.ts`)

### Current State

```ts
import { authkitProxy } from "@workos-inc/authkit-nextjs";

export default authkitProxy({
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: ["/sign-in", "/sign-up", "/callback", "/onboarding"],
  },
});
```

### Target State

Use the composable `authkit()` API so proxy can make coarse routing decisions while still returning via `handleAuthkitHeaders(...)`.

```ts
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
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export default async function proxy(request: NextRequest) {
  const { session, headers, authorizationUrl } = await authkit(request);
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return handleAuthkitHeaders(request, headers);
  }

  if (!session.user && authorizationUrl) {
    return handleAuthkitHeaders(request, headers, { redirect: authorizationUrl });
  }

  if (pathname.startsWith("/admin")) {
    if (session.organizationId !== SYSTEM_ADMIN_ORG_ID) {
      return handleAuthkitHeaders(request, headers, { redirect: "/workspace" });
    }
  }

  if (pathname.startsWith("/workspace")) {
    if (!session.organizationId) {
      return handleAuthkitHeaders(request, headers, { redirect: "/sign-in" });
    }
  }

  return handleAuthkitHeaders(request, headers);
}
```

### Proxy Rules

1. **Only use session/cookie claims in proxy.** No Convex call. No tenant lookup. No CRM role lookup.
2. **Do not check closer/admin CRM roles here.** That belongs in the server access layer.
3. **Keep proxy matcher broad.** Any route that calls `withAuth()` must remain covered by proxy, including route handlers.
4. **Treat proxy as optimistic only.** It improves UX and blocks obvious cases, but it is not the final security boundary.

## Layer 2: Server Access Layer (`lib/auth.ts`)

This is the main addition.

The original design stopped at `verifySession()` + `getAuthorizedUser()`. That was not enough for this repo. We need a richer server access layer that models:

- system admin sessions,
- tenant lifecycle state,
- first-load invite claiming,
- missing CRM users,
- and role-based route access.

### 2.1 Core Types

```ts
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
  | { kind: "pending_onboarding"; session: VerifiedSession; tenant: CurrentTenant }
  | { kind: "not_provisioned"; session: VerifiedSession; tenant: CurrentTenant | null }
  | {
      kind: "ready";
      session: VerifiedSession;
      tenant: CurrentTenant;
      crmUser: Doc<"users">;
    };
```

### 2.2 Session Verification

```ts
export const verifySession = cache(async (): Promise<VerifiedSession> => {
  const auth = await withAuth({ ensureSignedIn: true });

  if (!auth.user || !auth.accessToken || !auth.organizationId) {
    redirect("/sign-in");
  }

  return auth as VerifiedSession;
});
```

### 2.3 Server-Side Invite Claim

This replaces the client-only claim dependency.

```ts
const resolveCrmUser = cache(async (session: VerifiedSession) => {
  let crmUser = await fetchQuery(
    api.users.queries.getCurrentUser,
    {},
    { token: session.accessToken },
  );

  if (!crmUser) {
    await fetchMutation(
      api.workos.userMutations.claimInvitedAccount,
      {},
      { token: session.accessToken },
    );

    crmUser = await fetchQuery(
      api.users.queries.getCurrentUser,
      {},
      { token: session.accessToken },
    );
  }

  return crmUser;
});
```

**Why this is required**

- The callback route can establish a valid session before the CRM user is claim-linked.
- Page-level `requireRole(...)` now runs on the server, before any client component mounts.
- Therefore claim repair must happen on the server before role enforcement.

### 2.4 Workspace Access Resolution

`getWorkspaceAccess()` is the repo-specific gate the original design was missing.

```ts
export const getWorkspaceAccess = cache(async (): Promise<WorkspaceAccess> => {
  const session = await verifySession();

  if (session.organizationId === SYSTEM_ADMIN_ORG_ID) {
    return { kind: "system_admin", session };
  }

  const tenant = await fetchQuery(
    api.tenants.getCurrentTenant,
    {},
    { token: session.accessToken },
  );

  if (!tenant) {
    return { kind: "no_tenant", session };
  }

  if (tenant.status !== "active") {
    return { kind: "pending_onboarding", session, tenant };
  }

  const crmUser = await resolveCrmUser(session);
  if (!crmUser) {
    return { kind: "not_provisioned", session, tenant };
  }

  return { kind: "ready", session, tenant, crmUser };
});
```

### 2.5 Narrowing Helpers

```ts
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

export async function requireRole(allowedRoles: CrmRole[]) {
  const access = await requireWorkspaceUser();

  if (!allowedRoles.includes(access.crmUser.role)) {
    const fallback = access.crmUser.role === "closer"
      ? "/workspace/closer"
      : "/workspace";
    redirect(fallback);
  }

  return access;
}

export async function requireSystemAdmin() {
  const session = await verifySession();
  if (session.organizationId !== SYSTEM_ADMIN_ORG_ID) {
    redirect("/workspace");
  }
  return session;
}
```

### 2.6 Workspace Layout Behavior

The workspace layout should fetch shell data, but it should not be the only authorization boundary.

It should:

1. call `getWorkspaceAccess()`,
2. redirect known non-workspace states,
3. render a not-provisioned screen when appropriate,
4. and pass only minimal shell data into the client shell.

```tsx
import { getWorkspaceAccess } from "@/lib/auth";
import { redirect } from "next/navigation";
import { WorkspaceShell } from "./_components/workspace-shell";

export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const access = await getWorkspaceAccess();

  if (access.kind === "system_admin") {
    redirect("/admin");
  }

  if (access.kind === "pending_onboarding") {
    redirect("/onboarding/connect");
  }

  if (access.kind === "no_tenant" || access.kind === "not_provisioned") {
    return <NotProvisionedScreen />;
  }

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
```

### 2.7 Page Wrapper Patterns

Protected pages move to thin RSC wrappers.

#### Admin workspace page

```tsx
import { requireRole } from "@/lib/auth";
import { ADMIN_ROLES } from "@/convex/lib/roleMapping";
import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { TeamPageClient } from "./_components/team-page-client";

export default async function TeamPage() {
  const { session } = await requireRole(ADMIN_ROLES);

  const preloadedTeam = await preloadQuery(
    api.users.queries.listTeamMembers,
    {},
    { token: session.accessToken },
  );

  return <TeamPageClient preloadedTeam={preloadedTeam} />;
}
```

#### Dynamic closer page

```tsx
import { requireRole } from "@/lib/auth";
import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { MeetingDetailPageClient } from "./_components/meeting-detail-page-client";
import type { Id } from "@/convex/_generated/dataModel";

export default async function MeetingPage({
  params,
}: {
  params: Promise<{ meetingId: string }>;
}) {
  const { session } = await requireRole(["closer"]);
  const { meetingId } = await params;

  const preloadedDetail = await preloadQuery(
    api.closer.meetingDetail.getMeetingDetail,
    { meetingId: meetingId as Id<"meetings"> },
    { token: session.accessToken },
  );

  return <MeetingDetailPageClient preloadedDetail={preloadedDetail} />;
}
```

#### Paginated admin console

`/admin` only needs an RSC auth wrapper. The paginated data can remain client-side:

```tsx
import { requireSystemAdmin } from "@/lib/auth";
import { AdminPageClient } from "./_components/admin-page-client";

export default async function AdminPage() {
  await requireSystemAdmin();
  return <AdminPageClient />;
}
```

### 2.8 Conversion Matrix

| Route | Wrapper auth helper | Data strategy |
|-------|---------------------|---------------|
| `/workspace` | `requireRole(ADMIN_ROLES)` | `preloadQuery` where useful |
| `/workspace/team` | `requireRole(ADMIN_ROLES)` | `preloadQuery(listTeamMembers)` |
| `/workspace/pipeline` | `requireRole(ADMIN_ROLES)` | wrapper validates search params, preloads filtered query |
| `/workspace/settings` | `requireRole(ADMIN_ROLES)` | `Promise.all([preloadQuery(...), preloadQuery(...)])` |
| `/workspace/closer` | `requireRole(["closer"])` | preload lighter dashboard queries, keep time-sensitive polling client-side if needed |
| `/workspace/closer/pipeline` | `requireRole(["closer"])` | validate search params server-side or keep filters client-side |
| `/workspace/closer/meetings/[meetingId]` | `requireRole(["closer"])` | preload by route param |
| `/workspace/profile` | `requireWorkspaceUser()` | any authenticated active workspace user |
| `/admin` | `requireSystemAdmin()` | auth wrapper only; keep `usePaginatedQuery` client-side |

### 2.9 Server Actions and Route Handlers

#### Server Actions

Every Server Action must authenticate independently.

```ts
"use server";

import { requireRole } from "@/lib/auth";
import { fetchMutation } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { ADMIN_ROLES } from "@/convex/lib/roleMapping";

export async function updateTeamMemberRole(userId: string, newRole: string) {
  const { session } = await requireRole(ADMIN_ROLES);

  await fetchMutation(
    api.workos.userManagement.updateUserRole,
    { userId, newRole },
    { token: session.accessToken },
  );
}
```

#### Route Handlers

Existing route handlers can keep using `withAuth({ ensureSignedIn: true })`. Refactoring them from `ConvexHttpClient` to `fetchAction` / `fetchMutation` is optional and not required for this revamp.

## Layer 3: Convex Authorization

The Convex layer is already the strongest part of the current system and should be preserved.

### Keep As-Is

- `requireTenantUser(ctx, allowedRoles)`
- `requireSystemAdminSession(identity)`
- tenant-isolated indexed queries
- centralized role mapping in `convex/lib/roleMapping.ts`

### Hardening in This Plan

1. **Reduce noisy auth logs.** Replace broad `console.log(...)` usage in auth helpers with a debug flag.
2. **Begin permission naming now, without changing enforcement yet.** Introduce `convex/lib/permissions.ts` as a CRM-role-to-permission map for UI and helper readability.
3. **Do not remove Convex role checks just because pages gain RSC auth.** Convex remains the final arbiter for data access.

## Layer 4: Client Affordance Layer

This layer exists for UX only.

### 4.1 Centralized Role Provider

The original design proposed a purely static role prop coming from the server layout. That is not enough.

The provider should:

- accept an initial role from the server,
- subscribe to `getCurrentUser()` in exactly one place,
- use the live user when available,
- and expose role/permission helpers to the rest of the tree.

```tsx
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

This keeps the role query centralized instead of scattered while still avoiding stale UI after hydration.

### 4.2 Permission Gates

```tsx
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

### 4.3 Workspace Shell Placement

`WorkspaceShell` becomes the single client shell that owns:

- sidebar and navigation,
- keyboard shortcuts,
- command palette,
- `RoleProvider`,
- sign-out,
- and other UX-only concerns.

The auth decision is already made before this shell renders.

## Permissions Strategy

### Phase 1: Permission Vocabulary on Top of CRM Roles

Introduce a permission map for readability and UI composition, but continue enforcing against CRM roles in Convex and server wrappers.

```ts
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
```

### Phase 2: Promote WorkOS Permissions Carefully

AuthKit `3.x` already exposes `role`, `roles`, and `permissions`, and the server/client APIs support session refresh. That means the repo does **not** need to guess whether the SDK exposes permissions; it does.

However, we should only promote WorkOS permissions to the primary auth source after both of these are true:

1. role-changing flows refresh the affected session with `refreshSession()` / `refreshAuth()`, and
2. we are comfortable making session claims, rather than CRM role data, the first source checked in the server access layer.

Until then:

- **Convex and server route auth stay CRM-role based**
- **AuthKit permissions can be used for future UI convenience or experimentation**

## Invite Claim Lifecycle

This is the complete first-login path for invited users after the revamp:

1. User accepts a WorkOS invite and lands in `app/callback/route.ts`.
2. Callback saves a valid WorkOS session cookie.
3. First request to `/workspace` reaches proxy and passes coarse auth.
4. Server layout/page calls `getWorkspaceAccess()`.
5. `getCurrentTenant` resolves the tenant.
6. `getCurrentUser` returns `null` because the CRM record still has a placeholder `workosUserId`.
7. Server access layer calls `fetchMutation(api.workos.userMutations.claimInvitedAccount, {}, { token })`.
8. Server access layer re-fetches `getCurrentUser`.
9. If the user now exists, role gating proceeds normally.
10. If the user still does not exist, the request falls into the not-provisioned flow.

This removes the current race where page-level server auth would otherwise happen before the client claim effect.

## Role Change and Session Freshness

The original design correctly identified stale role/session behavior, but it did not fully specify the solution.

### Phase 1 Rules

1. **Authorization uses fresh CRM role data.**
2. **UI context uses a single reactive `getCurrentUser()` subscription** so nav and buttons update after hydration.
3. **Proxy does not depend on CRM role or WorkOS role claims.**
4. **If a mutation changes the current user's role, client code should call `router.refresh()` after success.**

### Phase 2 Rules

If and when server-side authorization begins reading WorkOS `permissions` directly, the flow must also refresh session claims:

- server: `refreshSession()` in route handlers or server actions
- client: `refreshAuth()` from `useAuth()`

Without that, role changes will remain one-session stale even if the WorkOS membership has already changed.

## Migration Plan

### Phase 1: Foundation

1. Add `lib/auth.ts` with:
   - `verifySession`
   - `resolveCrmUser`
   - `getWorkspaceAccess`
   - `requireWorkspaceUser`
   - `requireRole`
   - `requireSystemAdmin`
2. Add `convex/lib/permissions.ts`.
3. Add `components/auth/role-context.tsx` and `components/auth/require-permission.tsx`.
4. Update `proxy.ts` from `authkitProxy(...)` to `authkit(...)`.

**Risk:** Low to medium. `proxy.ts` is behavior-changing and must be tested carefully.

### Phase 2: Workspace Layout Conversion

1. Extract the existing client shell from `app/workspace/layout.tsx` into `app/workspace/_components/workspace-shell.tsx`.
2. Convert `app/workspace/layout.tsx` into an RSC that calls `getWorkspaceAccess()`.
3. Reuse the current loading / not-provisioned UX, but make the decision on the server.
4. Put `RoleProvider` inside the client shell.

**Risk:** Medium. The layout currently owns navigation, keyboard shortcuts, sign-out, command palette, and not-provisioned behavior.

### Phase 3: Page-by-Page Wrapper Conversion

Recommended order:

1. `/workspace/team`
2. `/workspace/settings`
3. `/workspace/pipeline`
4. `/workspace`
5. `/workspace/closer`
6. `/workspace/closer/pipeline`
7. `/workspace/closer/meetings/[meetingId]`
8. `/workspace/profile`
9. `/admin`

For each route:

1. Move the existing client page into `_components/*-page-client.tsx`.
2. Turn `page.tsx` into a thin RSC wrapper.
3. Use `preloadQuery(...)` when the page already depends on Convex query data that should be ready on first paint.
4. Keep time-sensitive polling and paginated queries client-side when preloading adds little value.

**Risk:** Low per page. Each conversion is isolated.

### Phase 4: Client Affordance Cleanup

1. Replace scattered role checks with `useRole()`, `<RequirePermission>`, and `<AdminOnly>`.
2. Remove duplicate `useQuery(getCurrentUser)` calls where the only purpose is UI gating.
3. Update components like `CalendlyConnectionGuard` to consume role context instead of making their own role query.

**Risk:** Low. UX-only changes.

### Phase 5: Session Freshness Improvements

1. After self-role changes or future permission-affecting flows, trigger `router.refresh()`.
2. When WorkOS permissions become authoritative, add `refreshSession()` / `refreshAuth()` to role-changing flows.

**Risk:** Medium. This affects subtle state synchronization behavior.

### Phase 6: Optional WorkOS Permission Promotion

1. Define permission slugs in WorkOS.
2. Map them to environment roles.
3. Refresh session claims after role changes.
4. Promote session permissions into the server access layer only once they are fresh enough to trust operationally.

**Risk:** Medium to high. This is a separate change from the core revamp.

## Testing Matrix

The revamp is not complete until each of these cases passes.

### Authentication and routing

1. Unauthenticated user requests `/workspace/team` -> redirected to sign-in before page HTML is sent.
2. Unauthenticated user requests `/admin` -> redirected to sign-in.
3. System admin requests `/workspace` -> redirected to `/admin`.
4. Non-system-admin requests `/admin` -> redirected to `/workspace`.

### Tenant lifecycle

1. Tenant owner with `tenant.status !== "active"` requests `/workspace` -> redirected to `/onboarding/connect`.
2. Active tenant user requests `/onboarding/connect` -> existing onboarding page logic routes away appropriately.
3. Authenticated user with no tenant record -> sees not-provisioned path, not a broken workspace shell.

### Invite claim flow

1. Fresh invited user signs up and lands on `/workspace`.
2. First request triggers server-side `claimInvitedAccount`.
3. User reaches their correct destination without needing a client-side retry loop.

### Role enforcement

1. Closer requests `/workspace/team` -> redirected to `/workspace/closer`.
2. Admin requests `/workspace/closer` -> redirected to `/workspace`.
3. Direct mutation call from an unauthorized role still fails in Convex.

### Soft navigation and freshness

1. Shared workspace layout does not become the only gate.
2. Navigating between admin pages still performs page-level authorization.
3. After role changes, nav/buttons update from the centralized role provider, and protected routes reject on next request.

### Route handlers

1. `/api/calendly/start` still works with `withAuth({ ensureSignedIn: true })`.
2. `/callback/calendly` still works with authenticated onboarding sessions.

## Acceptance Criteria

This design is complete enough to implement when all of these statements are true:

1. No protected workspace or admin page relies on a client-side role redirect as its primary authorization mechanism.
2. Every protected page authorizes on the server before protected content renders.
3. Invited-user claim repair works without needing the page to mount first.
4. Pending tenants cannot access the active workspace.
5. System admin access does not assume the existence of a CRM user.
6. Convex remains the final authorization boundary for data access.
7. Client role affordance logic is centralized and no longer scattered across pages.

## Files to Create / Modify

### New files

| File | Purpose |
|------|---------|
| `lib/auth.ts` | Server-only session, tenant, claim, and role access layer |
| `convex/lib/permissions.ts` | Permission vocabulary over current CRM roles |
| `components/auth/role-context.tsx` | Centralized client role provider |
| `components/auth/require-permission.tsx` | Permission-gated UX helpers |
| `app/workspace/_components/workspace-shell.tsx` | Extracted client shell |

### Modified files

| File | Change |
|------|--------|
| `proxy.ts` | Switch to `authkit()` composable with coarse route gating |
| `app/workspace/layout.tsx` | Convert to RSC and use `getWorkspaceAccess()` |
| `app/workspace/page.tsx` | Thin RSC wrapper |
| `app/workspace/team/page.tsx` | Thin RSC wrapper |
| `app/workspace/pipeline/page.tsx` | Thin RSC wrapper |
| `app/workspace/settings/page.tsx` | Thin RSC wrapper |
| `app/workspace/profile/page.tsx` | Thin RSC wrapper |
| `app/workspace/closer/page.tsx` | Thin RSC wrapper |
| `app/workspace/closer/pipeline/page.tsx` | Thin RSC wrapper |
| `app/workspace/closer/meetings/[meetingId]/page.tsx` | Thin RSC wrapper |
| `app/admin/page.tsx` | Thin RSC auth wrapper |
| Various client components | Replace ad hoc role checks with `useRole()` or permission wrappers |

## Decisions Resolved by This Review

These are no longer open questions:

1. **`preloadQuery` and `fetchQuery` can be used with authenticated Convex calls.** The local Convex docs explicitly support passing `{ token: accessToken }`.
2. **AuthKit `3.x` exposes `organizationId`, `role`, `roles`, and `permissions`.** The installed package types and README confirm this.
3. **Invite claim must move server-side.** A client-only solution is incompatible with page-level RSC authorization.
4. **Admin pagination does not block the revamp.** `/admin` still benefits from an RSC auth wrapper even if the list stays on `usePaginatedQuery`.
