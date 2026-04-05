# Phase 6 — Optional: WorkOS Permission Promotion

**Goal:** Promote WorkOS session permissions to the primary authorization source in the server access layer (`lib/auth.ts`), replacing CRM-role-based checks with session-claim-based checks for route gating. This phase is **optional** and **separate from the core revamp** -- it should only be undertaken once session refresh is reliable and the team is comfortable trusting session claims operationally.

**Prerequisite:** Phase 5 complete -- session refresh after role changes is documented and understood. Both of these conditions must be true before starting:
1. Role-changing flows refresh the affected session with `refreshSession()` / `refreshAuth()`.
2. We are comfortable making session claims, rather than CRM role data, the first source checked in the server access layer.

**Runs in PARALLEL with:** Nothing -- this is the final phase.

**Skills to invoke:**
- `workos` -- for WorkOS permission slug configuration and session claim handling.

**Risk:** Medium to high. This is a separate change from the core revamp. Session claims may lag behind CRM role changes if refresh fails. The feature flag provides a rollback path.

**Estimated time:** 2-3 days

---

## Acceptance Criteria

1. A mapping file exists that maps every key in `convex/lib/permissions.ts` `PERMISSIONS` to a WorkOS permission slug (e.g., `team:invite` maps to `team:invite` in WorkOS).
2. WorkOS dashboard configuration is documented: which permission slugs to create, which roles receive which permissions.
3. Role-changing flows (`updateUserRole`, `removeUser`, `inviteUser`) call `refreshSession()` server-side after the Convex mutation succeeds.
4. Client-side role-changing flows call `refreshAuth()` after the server action completes.
5. `lib/auth.ts` `verifySession()` exposes a `permissions` array from the session claims.
6. A new `requirePermission()` helper exists in `lib/auth.ts` that checks session permissions.
7. `getWorkspaceAccess()` optionally checks session claims first, falling back to CRM role data, controlled by the `USE_WORKOS_PERMISSIONS` environment variable.
8. When `USE_WORKOS_PERMISSIONS` is unset or `false`, behavior is identical to Phase 5 (CRM-role-based).
9. When `USE_WORKOS_PERMISSIONS` is `true`, `requireRole()` delegates to session permissions instead of CRM role.
10. The Convex layer (`requireTenantUser`) does NOT change -- it stays CRM-role-based as the final data boundary.
11. Disabling the feature flag immediately reverts to CRM-role-based auth with no code changes needed.
12. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
6A (Define WorkOS permission slugs) ──────────────────────────────┐
                                                                   │
6B (Add session refresh to role-changing flows) ───────────────┐   │
                                                               │   │
                                                               ├───┤
                                                               │   │
6C (Promote session permissions in server access layer) ───────┘   │
                                                                   │
6D (Verify and test) ─────────────────────────────────────────────┘
```

**Optimal execution:**
1. Start 6A and 6B in parallel (6A defines the permission vocabulary for WorkOS, 6B adds session refresh -- they touch separate concerns).
2. Once 6A and 6B are both done, start 6C (the server access layer needs both the permission mapping and fresh session claims to work).
3. Once 6C is done, start 6D (end-to-end verification).

---

## Subphases

### 6A -- Define WorkOS Permission Slugs

**Type:** Backend / Configuration
**Parallelizable:** Yes -- independent of 6B, 6C, 6D. Only creates a mapping file and documents WorkOS dashboard setup.

**What:** Map each CRM permission from `convex/lib/permissions.ts` to a WorkOS permission slug. Document the WorkOS dashboard configuration needed. Create a mapping module that extends the existing permissions vocabulary.

**Why:** WorkOS permissions are string slugs assigned to roles in the WorkOS dashboard. For the server access layer to check session permissions instead of CRM roles, there must be a well-defined mapping between what the CRM calls a permission and what WorkOS calls a permission. Using the same slug strings keeps the mapping trivial and avoids translation layers.

**Where:**
- `lib/workos-permissions.ts` (new)
- `convex/lib/permissions.ts` (verify, no changes)

**How:**

**Step 1: Document the WorkOS dashboard configuration**

The following permission slugs must be created in the WorkOS dashboard under the environment's organization settings. Each slug mirrors a key from `PERMISSIONS` in `convex/lib/permissions.ts`.

| WorkOS Permission Slug | Assigned to WorkOS Roles | CRM Equivalent |
|---|---|---|
| `team:invite` | `tenant_master`, `tenant_admin` | `PERMISSIONS["team:invite"]` |
| `team:remove` | `tenant_master`, `tenant_admin` | `PERMISSIONS["team:remove"]` |
| `team:update-role` | `tenant_master` | `PERMISSIONS["team:update-role"]` |
| `pipeline:view-all` | `tenant_master`, `tenant_admin` | `PERMISSIONS["pipeline:view-all"]` |
| `pipeline:view-own` | `tenant_master`, `tenant_admin`, `closer` | `PERMISSIONS["pipeline:view-own"]` |
| `settings:manage` | `tenant_master`, `tenant_admin` | `PERMISSIONS["settings:manage"]` |
| `meeting:view-own` | `tenant_master`, `tenant_admin`, `closer` | `PERMISSIONS["meeting:view-own"]` |
| `meeting:manage-own` | `closer` | `PERMISSIONS["meeting:manage-own"]` |
| `payment:record` | `closer` | `PERMISSIONS["payment:record"]` |
| `payment:view-all` | `tenant_master`, `tenant_admin` | `PERMISSIONS["payment:view-all"]` |
| `payment:view-own` | `tenant_master`, `tenant_admin`, `closer` | `PERMISSIONS["payment:view-own"]` |

WorkOS role slugs are mapped via `convex/lib/roleMapping.ts` (`mapCrmRoleToWorkosSlug`). The WorkOS dashboard must assign each permission slug to the corresponding WorkOS roles.

**Step 2: Create the WorkOS permission mapping module**

```typescript
// Path: lib/workos-permissions.ts

import "server-only";
import type { Permission } from "@/convex/lib/permissions";

/**
 * Maps CRM permission keys to WorkOS permission slugs.
 *
 * By convention, WorkOS slugs mirror the CRM permission keys exactly.
 * This mapping exists so that if WorkOS slugs ever diverge (e.g.,
 * namespacing like "crm:team:invite"), only this file needs to change.
 */
export const WORKOS_PERMISSION_SLUGS: Record<Permission, string> = {
  "team:invite": "team:invite",
  "team:remove": "team:remove",
  "team:update-role": "team:update-role",
  "pipeline:view-all": "pipeline:view-all",
  "pipeline:view-own": "pipeline:view-own",
  "settings:manage": "settings:manage",
  "meeting:view-own": "meeting:view-own",
  "meeting:manage-own": "meeting:manage-own",
  "payment:record": "payment:record",
  "payment:view-all": "payment:view-all",
  "payment:view-own": "payment:view-own",
} as const;

/**
 * Check whether a set of WorkOS session permissions includes
 * the permission corresponding to a CRM permission key.
 */
export function sessionHasPermission(
  sessionPermissions: string[],
  permission: Permission,
): boolean {
  const slug = WORKOS_PERMISSION_SLUGS[permission];
  return sessionPermissions.includes(slug);
}

/**
 * Derive an admin flag from session permissions.
 * A user is considered an admin if they hold any admin-only permission.
 */
export function sessionIsAdmin(sessionPermissions: string[]): boolean {
  return (
    sessionPermissions.includes(WORKOS_PERMISSION_SLUGS["team:invite"]) ||
    sessionPermissions.includes(WORKOS_PERMISSION_SLUGS["settings:manage"])
  );
}
```

**Step 3: Verify types compile**

Run `pnpm tsc --noEmit`. The `Record<Permission, string>` type ensures every permission key has a corresponding WorkOS slug. If a new permission is added to `PERMISSIONS`, TypeScript will require a matching entry in `WORKOS_PERMISSION_SLUGS`.

**Key implementation notes:**
- WorkOS slugs intentionally mirror CRM permission keys. This keeps the mapping trivial and readable.
- The `WORKOS_PERMISSION_SLUGS` record is `server-only` because session permissions are only checked on the server. Client-side permission checks continue to use `convex/lib/permissions.ts` via the `RoleProvider`.
- If WorkOS ever requires namespaced slugs (e.g., `crm:team:invite`), only this file needs to change.
- The `sessionIsAdmin` helper checks for `team:invite` or `settings:manage` -- permissions that only admin roles hold. This mirrors the `isAdmin` logic in `role-context.tsx`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `lib/workos-permissions.ts` | Create | WorkOS permission slug mapping, session permission helpers |

---

### 6B -- Add Session Refresh to Role-Changing Flows

**Type:** Backend / Frontend
**Parallelizable:** Yes -- independent of 6A. Touches server actions and client components that call role-changing mutations.

**What:** Implement `refreshSession()` server-side and `refreshAuth()` client-side in the role update, user removal, and invite flows. This ensures session claims are fresh after changes so that the server access layer can trust them.

**Why:** WorkOS updates the organization membership role immediately when `updateOrganizationMembership()` is called, but the session cookie retains the old claims until it is refreshed. Without explicit refresh, a user who just had their role changed would still see the old permissions in their session until the cookie naturally expires (typically 1 hour). For session permissions to be authoritative, refresh must happen immediately after every role change.

**Where:**
- Server actions that call `updateUserRole`, `removeUser`, or `inviteUser`
- Client components that trigger those server actions

**How:**

**Step 1: Add server-side session refresh after role changes**

The `refreshSession()` function from `@workos-inc/authkit-nextjs` refreshes the session cookie for the current request's user. It should be called after any Convex mutation that changes roles.

```typescript
// Path: app/workspace/_actions/team-actions.ts
"use server";

import { requireRole } from "@/lib/auth";
import { refreshSession } from "@workos-inc/authkit-nextjs";
import { fetchAction } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { ADMIN_ROLES } from "@/convex/lib/roleMapping";
import type { Id } from "@/convex/_generated/dataModel";
import type { CrmRole } from "@/convex/lib/roleMapping";

export async function updateTeamMemberRole(
  userId: Id<"users">,
  newRole: CrmRole,
) {
  const { session } = await requireRole(ADMIN_ROLES);

  // 1. Execute the Convex action (updates CRM role + WorkOS membership)
  await fetchAction(
    api.workos.userManagement.updateUserRole,
    { userId, newRole },
    { token: session.accessToken },
  );

  // 2. Refresh the caller's session so their own claims are fresh.
  //    This matters if the admin changed their own role or if we want
  //    consistent session state for subsequent server requests.
  await refreshSession();
}

export async function removeTeamMember(userId: Id<"users">) {
  const { session } = await requireRole(ADMIN_ROLES);

  await fetchAction(
    api.workos.userManagement.removeUser,
    { userId },
    { token: session.accessToken },
  );

  // Refresh session: the team composition changed, and future permission
  // checks should reflect the updated organization state.
  await refreshSession();
}

export async function inviteTeamMember(
  email: string,
  role: CrmRole,
  fullName: string,
) {
  const { session } = await requireRole(ADMIN_ROLES);

  await fetchAction(
    api.workos.userManagement.inviteUser,
    { email, role, fullName },
    { token: session.accessToken },
  );

  // Refresh not strictly necessary for invites (the invited user doesn't
  // have a session yet), but keeps the caller's session consistent.
  await refreshSession();
}
```

**Step 2: Add client-side session refresh after server action completes**

On the client side, `refreshAuth()` from `@workos-inc/authkit-nextjs/components` updates the client-side auth state to match the refreshed server session.

```tsx
// Path: app/workspace/team/_components/update-role-dialog.tsx (example)
"use client";

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useRouter } from "next/navigation";
import { updateTeamMemberRole } from "@/app/workspace/_actions/team-actions";
import type { Id } from "@/convex/_generated/dataModel";
import type { CrmRole } from "@/convex/lib/roleMapping";

export function useRoleChangeWithRefresh() {
  const { refreshAuth } = useAuth();
  const router = useRouter();

  async function changeRole(userId: Id<"users">, newRole: CrmRole) {
    // 1. Call server action (which calls refreshSession() internally)
    await updateTeamMemberRole(userId, newRole);

    // 2. Refresh client-side auth state to match the new session
    await refreshAuth();

    // 3. Trigger a router refresh so server components re-render
    //    with the updated session claims
    router.refresh();
  }

  return { changeRole };
}
```

**Step 3: Apply the same pattern to user removal**

```tsx
// Path: app/workspace/team/_components/remove-user-dialog.tsx (example)
"use client";

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useRouter } from "next/navigation";
import { removeTeamMember } from "@/app/workspace/_actions/team-actions";
import type { Id } from "@/convex/_generated/dataModel";

export function useRemoveWithRefresh() {
  const { refreshAuth } = useAuth();
  const router = useRouter();

  async function remove(userId: Id<"users">) {
    await removeTeamMember(userId);
    await refreshAuth();
    router.refresh();
  }

  return { remove };
}
```

**Key implementation notes:**
- `refreshSession()` is an async server-side function that rewrites the session cookie. It must be called from a Server Action or Route Handler -- it cannot be called from a Server Component render.
- `refreshAuth()` is the client-side counterpart from `useAuth()`. It reads the updated cookie and updates the client-side auth context.
- The order matters: server action completes (which calls `refreshSession()` internally) -> client calls `refreshAuth()` -> client calls `router.refresh()`. This ensures both server and client have fresh state.
- `router.refresh()` triggers a server-side re-render of the current route's Server Components, which will now see the updated session claims via `verifySession()`.
- The Convex mutation (`updateUserRole`) updates the WorkOS membership role synchronously. By the time `refreshSession()` runs, WorkOS already has the new role, so the refreshed session will contain the updated permissions.
- Self-role-change is an edge case: if an admin demotes themselves, the refreshed session will reflect the reduced permissions, and the next server request will redirect them appropriately.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_actions/team-actions.ts` | Create or modify | Add `refreshSession()` after role-changing mutations |
| Client components calling role changes | Modify | Add `refreshAuth()` + `router.refresh()` after server action |

---

### 6C -- Promote Session Permissions in Server Access Layer

**Type:** Backend
**Parallelizable:** No -- depends on 6A (permission slug mapping) and 6B (session refresh in flows).

**What:** Update `lib/auth.ts` to optionally check the session `permissions` array before falling back to CRM role data. Gate this behavior behind the `USE_WORKOS_PERMISSIONS` environment variable. Add a `requirePermission()` helper. Modify `requireRole()` to optionally delegate to session permissions.

**Why:** This is the culmination of the entire authorization revamp. Once session permissions are fresh (6B) and mapped (6A), the server access layer can use them as the primary authorization source. The feature flag allows gradual rollout and instant rollback.

**Where:**
- `lib/auth.ts` (modify)

**How:**

**Step 1: Add the feature flag check**

```typescript
// Path: lib/auth.ts (add near the top, after existing imports)

import {
  sessionHasPermission,
  sessionIsAdmin,
} from "@/lib/workos-permissions";
import type { Permission } from "@/convex/lib/permissions";
import { hasPermission as crmHasPermission } from "@/convex/lib/permissions";

/**
 * When true, the server access layer checks WorkOS session permissions
 * before falling back to CRM role data. When false (default), CRM role
 * is the sole authorization source.
 */
const USE_WORKOS_PERMISSIONS =
  process.env.USE_WORKOS_PERMISSIONS === "true";
```

**Step 2: Extend `VerifiedSession` to expose permissions**

Before:

```typescript
// Path: lib/auth.ts

export type VerifiedSession = AuthResult & {
  user: NonNullable<AuthResult["user"]>;
  accessToken: string;
  organizationId: string;
};
```

After:

```typescript
// Path: lib/auth.ts

export type VerifiedSession = AuthResult & {
  user: NonNullable<AuthResult["user"]>;
  accessToken: string;
  organizationId: string;
  permissions: string[];
};
```

Update `verifySession()` to populate permissions:

Before:

```typescript
// Path: lib/auth.ts

export const verifySession = cache(async (): Promise<VerifiedSession> => {
  const auth = await withAuth({ ensureSignedIn: true });

  if (!auth.user || !auth.accessToken || !auth.organizationId) {
    redirect("/sign-in");
  }

  return auth as VerifiedSession;
});
```

After:

```typescript
// Path: lib/auth.ts

export const verifySession = cache(async (): Promise<VerifiedSession> => {
  const auth = await withAuth({ ensureSignedIn: true });

  if (!auth.user || !auth.accessToken || !auth.organizationId) {
    redirect("/sign-in");
  }

  return {
    ...auth,
    user: auth.user,
    accessToken: auth.accessToken,
    organizationId: auth.organizationId,
    // AuthKit 3.x exposes permissions on the session.
    // Default to empty array if not present (e.g., feature not
    // configured in WorkOS dashboard yet).
    permissions: (auth as Record<string, unknown>).permissions as string[] ?? [],
  } satisfies VerifiedSession;
});
```

**Step 3: Add `requirePermission()` helper**

```typescript
// Path: lib/auth.ts (add after requireRole)

/**
 * Require a workspace user with a specific permission.
 * When USE_WORKOS_PERMISSIONS is enabled, checks session permissions.
 * Otherwise, falls back to CRM role-based permission check.
 */
export async function requirePermission(permission: Permission) {
  const access = await requireWorkspaceUser();

  if (USE_WORKOS_PERMISSIONS) {
    // Check session permissions (WorkOS claims)
    if (!sessionHasPermission(access.session.permissions, permission)) {
      const fallback = sessionIsAdmin(access.session.permissions)
        ? "/workspace"
        : "/workspace/closer";
      redirect(fallback);
    }
  } else {
    // Fall back to CRM role-based check
    if (!crmHasPermission(access.crmUser.role, permission)) {
      const fallback =
        access.crmUser.role === "closer" ? "/workspace/closer" : "/workspace";
      redirect(fallback);
    }
  }

  return access;
}
```

**Step 4: Update `requireRole()` to optionally use session permissions**

Before:

```typescript
// Path: lib/auth.ts

export async function requireRole(allowedRoles: CrmRole[]) {
  const access = await requireWorkspaceUser();

  if (!allowedRoles.includes(access.crmUser.role)) {
    const fallback =
      access.crmUser.role === "closer" ? "/workspace/closer" : "/workspace";
    redirect(fallback);
  }

  return access;
}
```

After:

```typescript
// Path: lib/auth.ts

export async function requireRole(allowedRoles: CrmRole[]) {
  const access = await requireWorkspaceUser();

  if (USE_WORKOS_PERMISSIONS) {
    // When WorkOS permissions are promoted, derive the role check from
    // session permissions. An "admin" is someone with admin-only
    // permissions; a "closer" is someone without them.
    const isSessionAdmin = sessionIsAdmin(access.session.permissions);
    const wantsAdmin = allowedRoles.some(
      (r) => r === "tenant_master" || r === "tenant_admin",
    );
    const wantsCloser = allowedRoles.includes("closer");

    const allowed =
      (wantsAdmin && isSessionAdmin) || (wantsCloser && !isSessionAdmin);

    if (!allowed) {
      const fallback = isSessionAdmin ? "/workspace" : "/workspace/closer";
      redirect(fallback);
    }
  } else {
    // CRM role is authoritative (default)
    if (!allowedRoles.includes(access.crmUser.role)) {
      const fallback =
        access.crmUser.role === "closer" ? "/workspace/closer" : "/workspace";
      redirect(fallback);
    }
  }

  return access;
}
```

**Step 5: Optionally update `getWorkspaceAccess()` to expose permission info**

`getWorkspaceAccess()` does not need structural changes. The `VerifiedSession` it returns now includes `permissions`, so consumers of the `ready` access kind can use `access.session.permissions` if needed.

**Key implementation notes:**
- The feature flag is a simple environment variable (`USE_WORKOS_PERMISSIONS`). No runtime configuration store is needed.
- When the flag is `false` (or unset), every code path is identical to Phase 5. The `if (USE_WORKOS_PERMISSIONS)` branches are dead code that the runtime never enters.
- When the flag is `true`, `requireRole()` translates role arrays into permission checks. This is intentionally coarse: it checks "are you an admin?" rather than mapping each role to a specific set of permissions. Fine-grained permission checks use `requirePermission()` instead.
- `requirePermission()` is the new preferred API for pages that need a specific permission (e.g., `requirePermission("team:invite")` instead of `requireRole(ADMIN_ROLES)`). However, `requireRole()` continues to work as a backward-compatible API.
- The Convex layer (`requireTenantUser`) does NOT change. It continues to check CRM roles in the database. This means the authorization stack is: session permissions (Layer 2, optional) -> CRM roles (Layer 3, always). If session permissions drift, Convex catches the mismatch.
- The `permissions` field on `VerifiedSession` defaults to `[]` if AuthKit does not expose permissions (e.g., WorkOS dashboard not configured yet). This means the feature flag should only be enabled after the WorkOS dashboard is fully configured (6A).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `lib/auth.ts` | Modify | Add `USE_WORKOS_PERMISSIONS` flag, extend `VerifiedSession`, add `requirePermission()`, update `requireRole()` |

---

### 6D -- Verify and Test

**Type:** QA / Manual verification
**Parallelizable:** No -- depends on 6A, 6B, and 6C being complete.

**What:** Comprehensive end-to-end testing of permission promotion: change a role, verify the session refreshes, confirm the server access layer uses the new permissions. Test rollback by disabling the feature flag.

**Why:** This phase changes the authorization source from database-backed CRM roles to session-backed WorkOS permissions. A regression could lock users out of pages they should access or grant access to pages they should not. Both directions must be tested.

**Where:** Browser testing, server logs, and WorkOS dashboard verification.

**How:**

**Step 1: TypeScript compilation**

```bash
pnpm tsc --noEmit
```

Must pass with zero errors.

**Step 2: Verify WorkOS dashboard configuration**

In the WorkOS dashboard, confirm:

| Check | Expected |
|---|---|
| All 11 permission slugs exist | `team:invite`, `team:remove`, `team:update-role`, `pipeline:view-all`, `pipeline:view-own`, `settings:manage`, `meeting:view-own`, `meeting:manage-own`, `payment:record`, `payment:view-all`, `payment:view-own` |
| `tenant_master` WorkOS role has all 11 permissions | Yes |
| `tenant_admin` WorkOS role has 8 permissions (all except `team:update-role`, `meeting:manage-own`, `payment:record`) | Yes |
| `closer` WorkOS role has 5 permissions (`pipeline:view-own`, `meeting:view-own`, `meeting:manage-own`, `payment:record`, `payment:view-own`) | Yes |

**Step 3: Test with feature flag disabled (baseline)**

Set `USE_WORKOS_PERMISSIONS=false` (or unset) and verify all existing behavior is preserved:

| Test case | Expected behavior |
|---|---|
| Admin visits `/workspace/team` | Access granted (CRM role check) |
| Closer visits `/workspace/team` | Redirected to `/workspace/closer` |
| Admin changes closer's role to `tenant_admin` | CRM role updates, page refreshes |
| Closer visits `/workspace/team` after promotion | Still redirected until next full page load (CRM role requires fresh server render) |

**Step 4: Test with feature flag enabled**

Set `USE_WORKOS_PERMISSIONS=true` and restart the dev server:

| Test case | Expected behavior |
|---|---|
| Admin visits `/workspace/team` | Access granted (session permissions include `team:invite`) |
| Closer visits `/workspace/team` | Redirected to `/workspace/closer` (session permissions lack `team:invite`) |
| Admin changes closer's role to `tenant_admin` | CRM role and WorkOS membership both update |
| Server action calls `refreshSession()` | Session cookie is rewritten with new permissions |
| Client calls `refreshAuth()` + `router.refresh()` | Client auth state updates, server re-renders with new claims |
| Newly promoted user visits `/workspace/team` | Access granted (session permissions now include admin permissions) |
| Admin demotes themselves to closer | Session refreshes, redirected to `/workspace/closer` on next navigation |

**Step 5: Test session refresh in role-changing flows**

| Flow | Server refresh | Client refresh | Verification |
|---|---|---|---|
| `updateTeamMemberRole` | `refreshSession()` called | `refreshAuth()` + `router.refresh()` | Log session permissions before/after -- new role's permissions appear |
| `removeTeamMember` | `refreshSession()` called | `refreshAuth()` + `router.refresh()` | Removed user's next request fails auth |
| `inviteTeamMember` | `refreshSession()` called | `refreshAuth()` + `router.refresh()` | Caller's session stays consistent |

**Step 6: Test rollback**

1. With `USE_WORKOS_PERMISSIONS=true`, change a user's role and verify session-based auth works.
2. Set `USE_WORKOS_PERMISSIONS=false` and restart the dev server.
3. Verify all authorization reverts to CRM-role-based checks immediately.
4. Verify no errors in server logs related to missing permissions.
5. Verify the user experience is identical to Phase 5 behavior.

**Step 7: Test edge cases**

| Edge case | Expected behavior |
|---|---|
| Session has empty `permissions` array (WorkOS not configured) | Feature flag `true` but no permissions -> all permission checks fail -> user redirected. This is why the flag should only be enabled after WorkOS dashboard is configured. |
| Session refresh fails (network error) | Server action should catch and log the error but not block the mutation. The next natural session refresh will pick up the changes. |
| User has no WorkOS membership (orphaned session) | `verifySession()` still succeeds (session is valid), but `permissions` is `[]`. `requireRole()` with flag on will redirect based on empty permissions. |
| Concurrent role changes (two admins change the same user) | Last write wins in both CRM and WorkOS. `refreshSession()` after each change ensures the caller's view is consistent. |

**Step 8: Verify Convex layer is unchanged**

Confirm that `requireTenantUser(ctx, allowedRoles)` in Convex mutations still checks CRM roles from the database, not session claims. This is the final data boundary and must remain independent of the feature flag.

```bash
# Verify no changes to the Convex auth helpers
git diff convex/lib/requireTenantUser.ts  # should show no changes
```

**Files touched:**

| File | Action | Notes |
|---|---|---|
| (none) | Manual testing | Verify all acceptance criteria |

---

## Rollback Plan

If session permissions prove unreliable in production:

1. Set `USE_WORKOS_PERMISSIONS=false` in the environment.
2. Redeploy (or restart the dev server).
3. All authorization immediately reverts to CRM-role-based checks.
4. No code changes, no database migrations, no Convex changes needed.
5. WorkOS dashboard configuration can remain in place (unused slugs cause no harm).

The feature flag is the single control point. When disabled:
- `requireRole()` checks `access.crmUser.role` (Phase 1 behavior).
- `requirePermission()` checks `crmHasPermission(role, permission)` (Phase 1 behavior).
- `verifySession()` still populates `permissions` on the session type, but nothing reads it.

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `lib/workos-permissions.ts` | Create | 6A |
| `app/workspace/_actions/team-actions.ts` | Create or modify | 6B |
| Client components (role change dialogs) | Modify | 6B |
| `lib/auth.ts` | Modify | 6C |
