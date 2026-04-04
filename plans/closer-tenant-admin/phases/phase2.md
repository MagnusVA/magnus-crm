# Phase 2 — Tenant Owner Identification & WorkOS User Management

**Goal:** Implement tenant owner identification during onboarding, build the full programmatic user management system using the WorkOS Node SDK (inviteUser, updateUserRole, removeUser), create the CRM user provisioning mutations, and add Calendly member linking. After this phase, an admin can invite users who are fully provisioned in both WorkOS and the CRM before they ever sign up.

**Prerequisite:** Phase 1 complete (schema deployed with all new tables, `requireTenantUser` guard exists, `users/queries.ts` exists, role mapping utilities exist).

**Acceptance Criteria:**
1. When a tenant owner redeems the onboarding invite, `tenants.tenantOwnerId` is set to their `users._id`.
2. The `assignRoleToMembership` action successfully assigns the `owner` WorkOS role to the tenant owner's membership.
3. Calling `inviteUser` action with valid args creates a WorkOS user, org membership with role, CRM user record, links Calendly member (if provided), and sends invite email — all in one synchronous operation.
4. The CRM `users` record exists **before** the invited user signs up.
5. `updateUserRole` updates both the WorkOS membership role and the CRM `users.role` field.
6. `removeUser` removes the WorkOS org membership and deletes the CRM user record, unlinking any matched Calendly member.
7. `listTeamMembers` returns all tenant users enriched with Calendly member names.
8. `listUnmatchedCalendlyMembers` returns only unmatched members for the invite form dropdown.
9. `linkCloserToCalendlyMember` correctly links/unlinks Calendly members to CRM users.

---

## Subphases

### 2A — WorkOS Role Assignment Action

**Type:** Backend
**Parallelizable:** Yes — independent of all other Phase 2 subphases (after Phase 1 is complete).

**What:** Create the `assignRoleToMembership` internal action that assigns a WorkOS RBAC role to a user's organization membership.

**Why:** This action is called during onboarding (2B) to assign the `owner` role to the first user, and later by user management actions (2E, 2F) to set roles for invited users. It's the bridge between CRM roles and WorkOS RBAC.

**Where:** `convex/workos/roles.ts` (new file)

**How:**

```typescript
// convex/workos/roles.ts
"use node";

import { WorkOS } from "@workos-inc/node";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";

const workos = new WorkOS(process.env.WORKOS_API_KEY!, {
  clientId: process.env.WORKOS_CLIENT_ID!,
});

/**
 * Assign or update a WorkOS RBAC role for a user's organization membership.
 *
 * IMPORTANT: WorkOS role assignment requires the MEMBERSHIP ID, not the user ID.
 * We must first list memberships to find the membership ID, then update it.
 *
 * This is an internal action — only callable from other Convex functions.
 */
export const assignRoleToMembership = internalAction({
  args: {
    workosUserId: v.string(),
    organizationId: v.string(),
    roleSlug: v.string(), // "owner", "tenant-admin", or "closer"
  },
  handler: async (_ctx, { workosUserId, organizationId, roleSlug }) => {
    // Step 1: Find the user's membership in this organization
    const memberships = await workos.userManagement.listOrganizationMemberships({
      userId: workosUserId,
      organizationId,
    });

    const membership = memberships.data[0];
    if (!membership) {
      throw new Error(
        `No membership found for user ${workosUserId} in org ${organizationId}`
      );
    }

    // Step 2: Update the membership with the new role slug
    const updated = await workos.userManagement.updateOrganizationMembership(
      membership.id,
      { roleSlug }
    );

    console.log(
      `[WorkOS] Assigned role "${roleSlug}" to user ${workosUserId} in org ${organizationId}`
    );

    return updated;
  },
});
```

**Key implementation notes:**
- File uses `"use node"` — required for `@workos-inc/node` SDK. This means it can ONLY export actions, not queries or mutations.
- `internalAction` — not exposed to client code. Called via `ctx.scheduler.runAfter()` or `internal.workos.roles.assignRoleToMembership`.
- WorkOS RBAC gotcha: you must use the **membership ID** (not user ID) to update roles. `listOrganizationMemberships` returns membership objects that include the ID.
- Role slugs (`owner`, `tenant-admin`, `closer`) are environment-level WorkOS roles that already exist. **Never create org-level roles** — this permanently isolates the org from inheriting environment-level changes.

**Files touched:** `convex/workos/roles.ts` (create)

---

### 2B — Modify Onboarding: Set Tenant Owner & Trigger Role Assignment

**Type:** Backend
**Parallelizable:** Yes — independent of 2C, 2D, 2E, 2F, 2G (only needs Phase 1 + 2A deployed).

**What:** Modify the existing `redeemInviteAndCreateUser` mutation in `convex/onboarding/complete.ts` to set `tenantOwnerId` on the tenant record and schedule the WorkOS role assignment action.

**Why:** The tenant owner is the user who completed the onboarding flow. Capturing their ID on the tenant record provides a direct reference for fast lookup (avoids scanning all users to find the owner). The WorkOS `owner` role ensures their JWT carries the correct permissions.

**Where:** `convex/onboarding/complete.ts` (modify existing file)

**How:**

Add two operations after the user record is inserted:

```typescript
// In redeemInviteAndCreateUser handler, AFTER inserting the user:

const userId = await ctx.db.insert("users", {
  tenantId: tenant._id,
  workosUserId,
  email: identity.email ?? tenant.contactEmail,
  fullName: identity.name ?? undefined,
  role: "tenant_master",
});

// ===== NEW: Set tenant owner reference =====
await ctx.db.patch(tenant._id, {
  tenantOwnerId: userId,
  inviteRedeemedAt: Date.now(),
  status: "pending_calendly",
});

// ===== NEW: Schedule WorkOS role assignment =====
// Uses runAfter(0, ...) for immediate async execution.
// The role takes effect on the user's NEXT session (typically a page refresh).
await ctx.scheduler.runAfter(0, internal.workos.roles.assignRoleToMembership, {
  workosUserId,
  organizationId: tenant.workosOrgId,
  roleSlug: "owner",
});
```

**Key implementation notes:**
- `tenantOwnerId` is `v.optional(v.id("users"))` in the schema — it's set here and never changes (ownership transfer is deferred to a future phase).
- `ctx.scheduler.runAfter(0, ...)` schedules the action to run immediately after the mutation commits. The action is async — the mutation doesn't wait for it. This is acceptable because the role assignment takes effect on the user's next session.
- Import `internal` from `../_generated/api` to reference the internal action.
- The existing `inviteRedeemedAt` and `status` patches may already exist in the current code — merge them into a single `ctx.db.patch` call.

**Files touched:** `convex/onboarding/complete.ts` (modify)

---

### 2C — CRM User Creation Mutation (Internal)

**Type:** Backend
**Parallelizable:** Yes — independent of 2A, 2B. After Phase 1 complete.

**What:** Create an internal mutation that inserts a fully-provisioned CRM `users` record and optionally links a Calendly org member to the new user.

**Why:** The `inviteUser` action (2E) orchestrates WorkOS API calls (which require Node.js) and then calls this mutation to write to Convex DB. Separating the DB write into an internal mutation ensures transactional consistency and allows idempotency checks.

**Where:** `convex/workos/userMutations.ts` (new file)

**How:**

```typescript
// convex/workos/userMutations.ts
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

/**
 * Create a fully-provisioned CRM user record and link a Calendly org member.
 *
 * Called by the inviteUser action AFTER WorkOS user + membership + invitation
 * are already created. This ensures the CRM record exists before the user
 * ever signs up.
 *
 * Idempotent: if a user with this workosUserId already exists, returns
 * the existing user's ID without creating a duplicate.
 */
export const createUserWithCalendlyLink = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    workosUserId: v.string(),
    email: v.string(),
    fullName: v.optional(v.string()),
    role: v.union(
      v.literal("tenant_master"),
      v.literal("tenant_admin"),
      v.literal("closer"),
    ),
    calendlyUserUri: v.optional(v.string()),
    calendlyMemberId: v.optional(v.id("calendlyOrgMembers")),
  },
  handler: async (ctx, args) => {
    const {
      tenantId, workosUserId, email, fullName, role,
      calendlyUserUri, calendlyMemberId,
    } = args;

    // Idempotency: if user already exists, return existing ID
    const existing = await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", workosUserId))
      .unique();
    if (existing) return existing._id;

    // Insert CRM user record
    const userId = await ctx.db.insert("users", {
      tenantId,
      workosUserId,
      email,
      fullName,
      role,
      calendlyUserUri,
    });

    // Link the Calendly org member to this user (if selected during invite)
    if (calendlyMemberId) {
      await ctx.db.patch(calendlyMemberId, {
        matchedUserId: userId,
      });
    }

    return userId;
  },
});

/**
 * Update a CRM user's role.
 * Called by updateUserRole action after updating WorkOS membership.
 */
export const updateRole = internalMutation({
  args: {
    userId: v.id("users"),
    role: v.union(
      v.literal("tenant_master"),
      v.literal("tenant_admin"),
      v.literal("closer"),
    ),
  },
  handler: async (ctx, { userId, role }) => {
    await ctx.db.patch(userId, { role });
  },
});

/**
 * Remove a CRM user and unlink their Calendly org member.
 * Called by removeUser action after removing WorkOS membership.
 */
export const removeUser = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (!user) return;

    // Unlink Calendly org member (if linked)
    if (user.calendlyUserUri) {
      const member = await ctx.db
        .query("calendlyOrgMembers")
        .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
          q.eq("tenantId", user.tenantId).eq("calendlyUserUri", user.calendlyUserUri!)
        )
        .unique();
      if (member) {
        await ctx.db.patch(member._id, { matchedUserId: undefined });
      }
    }

    // Delete the CRM user record
    await ctx.db.delete(userId);
  },
});
```

**Key implementation notes:**
- This file does NOT have `"use node"` — it exports mutations, which cannot run in the Node.js runtime.
- `createUserWithCalendlyLink` is idempotent — calling it twice with the same `workosUserId` returns the existing user without creating a duplicate.
- `removeUser` unlinks the Calendly org member before deleting the user, ensuring the member is available for future invites.
- All mutations are `internalMutation` — only callable from other Convex functions (specifically, the WorkOS management actions in 2E and 2F).

**Files touched:** `convex/workos/userMutations.ts` (create)

---

### 2D — Calendly Member Linking Mutation

**Type:** Backend
**Parallelizable:** Yes — independent of 2A, 2B, 2C. After Phase 1 complete.

**What:** Create a public mutation that allows an admin to link or re-link a Calendly org member to an existing CRM user (e.g., if the wrong member was selected at invite time, or a Closer was created without a Calendly link).

**Why:** The invite form (Phase 4) allows selecting a Calendly member at creation time, but admins need the ability to change this linkage post-creation. This mutation handles the full link/unlink lifecycle.

**Where:** `convex/users/linkCalendlyMember.ts` (new file)

**How:**

```typescript
// convex/users/linkCalendlyMember.ts
import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

/**
 * Link a CRM user to a Calendly org member.
 * Handles unlinking the previous member (if any) and linking the new one.
 *
 * Only callable by tenant_master or tenant_admin.
 */
export const linkCloserToCalendlyMember = mutation({
  args: {
    userId: v.id("users"),
    calendlyMemberId: v.id("calendlyOrgMembers"),
  },
  handler: async (ctx, { userId, calendlyMemberId }) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    const user = await ctx.db.get(userId);
    const member = await ctx.db.get(calendlyMemberId);

    // Validate both records exist and belong to this tenant
    if (!user || !member || user.tenantId !== tenantId || member.tenantId !== tenantId) {
      throw new Error("Invalid user or member");
    }

    // Ensure the Calendly member isn't already linked to a DIFFERENT user
    if (member.matchedUserId && member.matchedUserId !== userId) {
      throw new Error("This Calendly member is already linked to another user");
    }

    // Unlink previous Calendly member (if the user was linked to someone else)
    if (user.calendlyUserUri) {
      const prevMember = await ctx.db
        .query("calendlyOrgMembers")
        .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
          q.eq("tenantId", tenantId).eq("calendlyUserUri", user.calendlyUserUri!)
        )
        .unique();
      if (prevMember) {
        await ctx.db.patch(prevMember._id, { matchedUserId: undefined });
      }
    }

    // Link the new Calendly member to the user
    await ctx.db.patch(userId, { calendlyUserUri: member.calendlyUserUri });
    await ctx.db.patch(calendlyMemberId, { matchedUserId: userId });
  },
});
```

**Key implementation notes:**
- This is a **public** mutation (not internal) — callable from the team management UI (Phase 4E).
- Uses `requireTenantUser` to verify the caller is an admin.
- Handles the full lifecycle: unlink previous member → link new member. This prevents orphaned links.
- The `matchedUserId` check prevents accidentally linking a Calendly member to two different CRM users.

**Files touched:** `convex/users/linkCalendlyMember.ts` (create)

---

### 2E — `inviteUser` Convex Action (Full Programmatic Invite Flow)

**Type:** Backend
**Parallelizable:** Depends on 2A (role assignment action) + 2C (user creation mutation) + 2D (for Calendly validation pattern). Start after those are complete.

**What:** Create the main `inviteUser` action that orchestrates the entire user invitation flow: validate authorization, validate Calendly member, create WorkOS user, create org membership with role, send invite email, create CRM user record, and link Calendly member — all in one synchronous operation.

**Why:** This is the core of the programmatic user management system. It replaces WorkOS Widgets with a single, controlled action that guarantees the CRM record exists before the user ever signs up. No webhooks, no race conditions, no post-signup provisioning.

**Where:** `convex/workos/userManagement.ts` (new file)

**How:**

```typescript
// convex/workos/userManagement.ts
"use node";

import { WorkOS } from "@workos-inc/node";
import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { mapCrmRoleToWorkosSlug } from "../lib/roleMapping";

const workos = new WorkOS(process.env.WORKOS_API_KEY!, {
  clientId: process.env.WORKOS_CLIENT_ID!,
});

/**
 * Invite a new user to the tenant organization.
 *
 * This single action handles the ENTIRE flow:
 * 1. Validate caller authorization (must be tenant_master or tenant_admin)
 * 2. Validate Calendly member selection (if provided)
 * 3. Create WorkOS user via SDK
 * 4. Create organization membership with correct role slug
 * 5. Send WorkOS invitation email
 * 6. Create fully-provisioned CRM user record
 * 7. Link Calendly org member (if applicable)
 *
 * After this action completes, the CRM record exists with role, org,
 * and Calendly linkage. The user just needs to accept the invite.
 */
export const inviteUser = action({
  args: {
    email: v.string(),
    firstName: v.string(),
    lastName: v.optional(v.string()),
    role: v.union(
      v.literal("tenant_master"),
      v.literal("tenant_admin"),
      v.literal("closer"),
    ),
    calendlyMemberId: v.optional(v.id("calendlyOrgMembers")),
  },
  handler: async (ctx, { email, firstName, lastName, role, calendlyMemberId }) => {
    // ==== Step 1: Authorization ====
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const callerWorkosUserId = identity.subject ?? identity.tokenIdentifier;
    const caller = await ctx.runQuery(
      internal.users.queries.getCurrentUserInternal,
      { workosUserId: callerWorkosUserId }
    );
    if (!caller || (caller.role !== "tenant_master" && caller.role !== "tenant_admin")) {
      throw new Error("Insufficient permissions: only owners and admins can invite users");
    }

    const tenant = await ctx.runQuery(internal.tenants.getCalendlyTenant, {
      tenantId: caller.tenantId,
    });
    if (!tenant) throw new Error("Tenant not found");

    // ==== Step 2: Validate Calendly Member (if provided) ====
    let calendlyUserUri: string | undefined;
    if (calendlyMemberId) {
      const member = await ctx.runQuery(
        internal.calendly.orgMembersQueries.getMember,
        { memberId: calendlyMemberId }
      );
      if (!member || member.tenantId !== caller.tenantId) {
        throw new Error("Invalid Calendly member");
      }
      if (member.matchedUserId) {
        throw new Error("This Calendly member is already linked to another user");
      }
      calendlyUserUri = member.calendlyUserUri;
    }

    // ==== Step 3: Create WorkOS User ====
    const workosUser = await workos.userManagement.createUser({
      email,
      firstName,
      lastName: lastName ?? undefined,
    });

    // ==== Step 4: Create Organization Membership with Role ====
    const roleSlug = mapCrmRoleToWorkosSlug(role);
    await workos.userManagement.createOrganizationMembership({
      userId: workosUser.id,
      organizationId: tenant.workosOrgId,
      roleSlug,
    });

    // ==== Step 5: Send WorkOS Invitation Email ====
    await workos.userManagement.sendInvitation({
      email,
      organizationId: tenant.workosOrgId,
    });

    // ==== Step 6 + 7: Create CRM User Record + Link Calendly Member ====
    const userId = await ctx.runMutation(
      internal.workos.userMutations.createUserWithCalendlyLink,
      {
        tenantId: caller.tenantId,
        workosUserId: workosUser.id,
        email,
        fullName: [firstName, lastName].filter(Boolean).join(" "),
        role,
        calendlyUserUri,
        calendlyMemberId,
      }
    );

    return { userId, workosUserId: workosUser.id };
  },
});
```

**Key implementation notes:**
- File uses `"use node"` — required for the WorkOS SDK. ONLY actions can be exported.
- This is a **public** action (not internal) — callable from the invite form UI (Phase 4E).
- The action is **not transactional** across WorkOS and Convex — if the WorkOS calls succeed but the CRM mutation fails, the WorkOS user and membership exist without a CRM record. This is handled by:
  1. The `createUserWithCalendlyLink` mutation's idempotency check (retry-safe).
  2. Best-effort cleanup could be added in a future error-handling pass.
- `mapCrmRoleToWorkosSlug` converts CRM roles to WorkOS slugs (from `convex/lib/roleMapping.ts`).
- The caller's identity is verified via `ctx.auth.getUserIdentity()` — this works in actions because Convex passes the auth context.
- The internal query references (`internal.users.queries.getCurrentUserInternal`, `internal.tenants.getCalendlyTenant`, `internal.calendly.orgMembersQueries.getMember`) must already exist from Phase 1 and the sys-admin flow.

**Files touched:** `convex/workos/userManagement.ts` (create — this file will be extended in 2F)

---

### 2F — `updateUserRole` & `removeUser` Actions

**Type:** Backend
**Parallelizable:** Depends on 2A (role assignment pattern) + 2C (user mutations). Start after those are complete.

**What:** Add two more actions to `convex/workos/userManagement.ts`: `updateUserRole` (changes a user's role in both WorkOS and CRM) and `removeUser` (removes a user from the organization).

**Why:** User management is incomplete without the ability to change roles and remove users. These actions mirror the `inviteUser` pattern: they update both WorkOS and the CRM in a single synchronous operation.

**Where:** `convex/workos/userManagement.ts` (append to file created in 2E)

**How:**

```typescript
// Append to convex/workos/userManagement.ts

/**
 * Update a user's role in both WorkOS and the CRM.
 *
 * Steps:
 * 1. Validate caller is admin/owner
 * 2. Find the user's WorkOS membership
 * 3. Update the membership role slug
 * 4. Update the CRM user role
 *
 * Note: Role changes take effect on the user's NEXT session.
 */
export const updateUserRole = action({
  args: {
    userId: v.id("users"),
    newRole: v.union(
      v.literal("tenant_master"),
      v.literal("tenant_admin"),
      v.literal("closer"),
    ),
  },
  handler: async (ctx, { userId, newRole }) => {
    // Validate caller
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const callerWorkosUserId = identity.subject ?? identity.tokenIdentifier;
    const caller = await ctx.runQuery(
      internal.users.queries.getCurrentUserInternal,
      { workosUserId: callerWorkosUserId }
    );
    if (!caller || (caller.role !== "tenant_master" && caller.role !== "tenant_admin")) {
      throw new Error("Insufficient permissions");
    }

    // Get the target user
    const user = await ctx.runQuery(internal.users.queries.getById, { userId });
    if (!user || user.tenantId !== caller.tenantId) {
      throw new Error("User not found");
    }

    // Get tenant for WorkOS org ID
    const tenant = await ctx.runQuery(internal.tenants.getCalendlyTenant, {
      tenantId: caller.tenantId,
    });
    if (!tenant) throw new Error("Tenant not found");

    // Update WorkOS membership role
    const memberships = await workos.userManagement.listOrganizationMemberships({
      userId: user.workosUserId,
      organizationId: tenant.workosOrgId,
    });
    const membership = memberships.data[0];
    if (membership) {
      await workos.userManagement.updateOrganizationMembership(membership.id, {
        roleSlug: mapCrmRoleToWorkosSlug(newRole),
      });
    }

    // Update CRM user role
    await ctx.runMutation(internal.workos.userMutations.updateRole, {
      userId,
      role: newRole,
    });
  },
});

/**
 * Remove a user from the tenant organization.
 *
 * Steps:
 * 1. Validate caller is admin/owner
 * 2. Prevent self-removal
 * 3. Remove WorkOS org membership
 * 4. Delete CRM user record + unlink Calendly member
 */
export const removeUser = action({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    // Validate caller
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const callerWorkosUserId = identity.subject ?? identity.tokenIdentifier;
    const caller = await ctx.runQuery(
      internal.users.queries.getCurrentUserInternal,
      { workosUserId: callerWorkosUserId }
    );
    if (!caller || (caller.role !== "tenant_master" && caller.role !== "tenant_admin")) {
      throw new Error("Insufficient permissions");
    }

    // Get the target user
    const user = await ctx.runQuery(internal.users.queries.getById, { userId });
    if (!user || user.tenantId !== caller.tenantId) {
      throw new Error("User not found");
    }

    // Prevent self-removal
    if (user._id === caller._id) {
      throw new Error("Cannot remove yourself");
    }

    // Get tenant for WorkOS org ID
    const tenant = await ctx.runQuery(internal.tenants.getCalendlyTenant, {
      tenantId: caller.tenantId,
    });
    if (!tenant) throw new Error("Tenant not found");

    // Remove WorkOS org membership
    const memberships = await workos.userManagement.listOrganizationMemberships({
      userId: user.workosUserId,
      organizationId: tenant.workosOrgId,
    });
    const membership = memberships.data[0];
    if (membership) {
      await workos.userManagement.deleteOrganizationMembership(membership.id);
    }

    // Remove CRM user record + unlink Calendly member
    await ctx.runMutation(internal.workos.userMutations.removeUser, { userId });
  },
});
```

**Key implementation notes:**
- Both actions follow the same pattern as `inviteUser`: validate caller → get target → update WorkOS → update CRM.
- `removeUser` prevents self-removal to avoid locking out the last admin.
- WorkOS membership deletion is best-effort — if the membership was already removed (e.g., via WorkOS dashboard), the CRM cleanup still runs.
- The `workos` client is shared at the module level (initialized once per file).

**Files touched:** `convex/workos/userManagement.ts` (append to existing file from 2E)

---

### 2G — Team Management Queries

**Type:** Backend
**Parallelizable:** Yes — independent of 2A–2F. After Phase 1 complete.

**What:** Add team management queries to the user queries module: `listTeamMembers` (returns all tenant users enriched with Calendly member info) and `listUnmatchedCalendlyMembers` (returns unmatched members for the invite form dropdown).

**Why:** The team page (Phase 4E) needs to display all team members with their status and provide a dropdown of available Calendly members when inviting a new Closer. These queries drive those UI components.

**Where:** `convex/users/queries.ts` (append to file created in Phase 1C)

**How:**

```typescript
// Append to convex/users/queries.ts
import { requireTenantUser } from "../requireTenantUser";

/**
 * List all team members for the current tenant.
 * Enriched with Calendly member names for display.
 *
 * Only callable by tenant_master or tenant_admin.
 */
export const listTeamMembers = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    const users = await ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .collect();

    // Enrich each user with their linked Calendly member's name
    const enriched = await Promise.all(
      users.map(async (user) => {
        let calendlyMemberName: string | undefined;
        if (user.calendlyUserUri) {
          const member = await ctx.db
            .query("calendlyOrgMembers")
            .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
              q.eq("tenantId", tenantId).eq("calendlyUserUri", user.calendlyUserUri!)
            )
            .unique();
          calendlyMemberName = member?.name;
        }
        return { ...user, calendlyMemberName };
      })
    );

    return enriched;
  },
});

/**
 * List Calendly org members that are NOT yet linked to a CRM user.
 * Used by the invite form dropdown when inviting a Closer.
 *
 * Only callable by tenant_master or tenant_admin.
 */
export const listUnmatchedCalendlyMembers = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    const members = await ctx.db
      .query("calendlyOrgMembers")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .filter((q) => q.eq(q.field("matchedUserId"), undefined))
      .collect();

    return members;
  },
});
```

**Key implementation notes:**
- Both are **public** queries — callable from the frontend via `useQuery`.
- `listTeamMembers` enriches each user with their Calendly member name by performing a secondary query. This is acceptable for small team sizes (< 50 users per tenant). For larger teams, consider denormalizing the name onto the `users` table.
- `listUnmatchedCalendlyMembers` filters for members where `matchedUserId` is `undefined` — these are available for linking to new Closers.
- Both use `requireTenantUser` with admin roles — Closers cannot see the team list.

**Files touched:** `convex/users/queries.ts` (append to existing file from Phase 1C)

---

## Parallelization Summary

```
Phase 1 Complete
  │
  ├── 2A (WorkOS role assignment action) ────────────────────────┐
  ├── 2B (modify onboarding/complete.ts) ────────────────────────┤  All independent
  ├── 2C (CRM user creation mutation) ──────────────────────────┤  of each other
  ├── 2D (Calendly member linking mutation) ─────────────────────┤
  └── 2G (team management queries) ─────────────────────────────┤
                                                                  │
  2A + 2C + 2D complete ──────────────────────────── 2E (inviteUser action)
                                                                  │
  2A + 2G complete ──────────────────────────────── 2F (updateUserRole + removeUser)
```

**Optimal execution:**
1. Start 2A, 2B, 2C, 2D, 2G all in parallel (they're independent).
2. Once 2A + 2C + 2D are done → start 2E.
3. Once 2A + 2G are done → start 2F.

**Estimated time:** 2–3 days

---

## Files Modified/Created Summary

| File | Action | Subphase |
|---|---|---|
| `convex/workos/roles.ts` | Created (assignRoleToMembership action) | 2A |
| `convex/onboarding/complete.ts` | Modified (set tenantOwnerId, trigger role assignment) | 2B |
| `convex/workos/userMutations.ts` | Created (createUserWithCalendlyLink, updateRole, removeUser) | 2C |
| `convex/users/linkCalendlyMember.ts` | Created (linkCloserToCalendlyMember mutation) | 2D |
| `convex/workos/userManagement.ts` | Created (inviteUser action) | 2E |
| `convex/workos/userManagement.ts` | Appended (updateUserRole, removeUser actions) | 2F |
| `convex/users/queries.ts` | Appended (listTeamMembers, listUnmatchedCalendlyMembers) | 2G |

---

*End of Phase 2. This phase runs in PARALLEL with Phase 3 (Webhook Event Processing Pipeline). They share no files or dependencies.*
