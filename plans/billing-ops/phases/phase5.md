# Phase 5 — Optional Least-Privilege Billing Role

**Goal:** Add an optional `billing_admin` CRM role mapped to WorkOS `billing-admin` for tenants that need Billing access without broader tenant-admin privileges. This phase is not part of MVP unless product decides tenant-admin access is too broad.

**Prerequisite:** Phases 0-4 are complete and Billing Ops has proven useful under `tenant_master` / `tenant_admin`. Product explicitly approves least-privilege role work and the WorkOS `billing-admin` environment role exists in dev and production.

**Runs in PARALLEL with:** Planning/preflight can run during Phase 4. Implementation should not run in parallel with Phase 4 navigation/auth changes because both edit role, shell, and team-management surfaces.

**Skills to invoke:**
- `convex-migration-helper` — required for widening the `users.role` union and planning assignment/rollback.
- `workos` — required for WorkOS RBAC role slug, membership-role update behavior, stale sessions, and IdP mapping caveats.
- `next-best-practices` — role-specific workspace fallback and route guards must stay server-side.

**Acceptance Criteria:**
1. WorkOS has an environment role slug `billing-admin` in dev and production before code exposes the role.
2. `users.role`, `CrmRole`, WorkOS role mapping, and Convex validators all include `billing_admin`.
3. `billing_admin` has `billing:view`, `billing:review`, `billing:correct`, and `billing:export` only unless product explicitly grants more permissions.
4. Team invite and edit-role UI can assign `billing_admin` without requiring a Calendly member.
5. WorkOS invitation and membership role updates use the `billing-admin` slug and continue to update by membership id, not user id.
6. `billing_admin` can access `/workspace/billing` when Billing Ops is enabled and cannot access tenant-admin pages such as `/workspace/team`, `/workspace/settings`, `/workspace/reviews`, or reports unless separately permitted.
7. `billing_admin` sidebar and command palette show Billing as the primary workspace destination.
8. Existing tenant-admin and closer behavior remains unchanged.
9. Migration/rollback notes exist for manually assigning or removing `billing_admin` users.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
5A (role decision + WorkOS preflight) ───────────┐
                                                ├── 5B (schema + role mapping)
                                                └── 5C (permissions + guards)

5B + 5C complete ───────────────┬── 5D (team invite/edit-role UI)
                                └── 5E (workspace route/nav fallback)

5D + 5E complete ───────────────── 5F (assignment migration + QA)
```

**Optimal execution:**
1. Complete 5A before code changes. Do not expose a role slug that does not exist in WorkOS.
2. Run 5B and 5C together after preflight because they edit backend type/permission contracts.
3. Run 5D and 5E in parallel after generated types include `billing_admin`.
4. Finish with 5F manual assignment, stale-session checks, and rollback.

**Estimated time:** 3-4 days

---

## Subphases

### 5A — Product Decision and WorkOS Preflight

**Type:** Manual / Config
**Parallelizable:** No — this gate decides whether Phase 5 happens at all.

**What:** Confirm the least-privilege role is required, create/verify the WorkOS `billing-admin` role slug, and document assignment strategy.

**Why:** Adding a new role touches auth, schema, invitations, UI, route fallbacks, and WorkOS membership updates. It should not be introduced speculatively.

**Where:**
- WorkOS Dashboard or management script (external)
- `plans/billing-ops/phases/phase5-role-rollout.md` (new)

**How:**

**Step 1: Verify WorkOS role exists.**

```typescript
// Path: plans/billing-ops/phases/phase5-role-rollout.md
export const workosPreflight = {
  requiredEnvironmentRoleSlug: "billing-admin",
  crmRole: "billing_admin",
  permissions: [
    "billing:view",
    "billing:review",
    "billing:correct",
    "billing:export",
  ],
  requiredEnvironments: ["development", "production"],
} as const;
```

**Step 2: Record WorkOS RBAC constraints.**

| Constraint | Phase 5 Handling |
|---|---|
| Role assignment requires membership id | Existing `getMembership()` flow already lists memberships before update. |
| IdP group mapping can override role changes | Document tenant-specific caveat before assigning Billing Admin. |
| Session claims can be stale | Existing CRM role remains authoritative; user may need refresh/re-auth for WorkOS session changes. |
| Org-level roles fork role config | Use environment-level `billing-admin` unless there is a deliberate tenant-specific exception. |

**Key implementation notes:**
- Do not add a CRM role until WorkOS role slug exists in every target environment.
- Do not use WorkOS role slug checks for authorization in this app; Convex/Next use CRM role plus permission table.
- If tenants use IdP role mapping, coordinate that mapping before assigning `billing_admin`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/billing-ops/phases/phase5-role-rollout.md` | Create | Role preflight and rollout notes |

---

### 5B — Schema and Role Mapping Widen

**Type:** Backend
**Parallelizable:** Yes — can run with 5C but must land before UI files compile.

**What:** Widen the CRM role union and WorkOS mapping to include `billing_admin` / `billing-admin`.

**Why:** Generated Convex types, WorkOS user actions, RoleProvider, and team UI all import `CrmRole`.

**Where:**
- `convex/schema.ts` (modify)
- `convex/lib/roleMapping.ts` (modify)
- `convex/workos/userManagement.ts` (modify validator)

**How:**

**Step 1: Widen `users.role`.**

```typescript
// Path: convex/schema.ts
users: defineTable({
  // ... existing fields ...
  role: v.union(
    v.literal("tenant_master"),
    v.literal("tenant_admin"),
    v.literal("closer"),
    v.literal("lead_generator"),
    v.literal("billing_admin"),
  ),
})
```

**Step 2: Update role mapping.**

```typescript
// Path: convex/lib/roleMapping.ts
export type CrmRole =
  | "tenant_master"
  | "tenant_admin"
  | "closer"
  | "lead_generator"
  | "billing_admin";

export type WorkosSlug =
  | "owner"
  | "tenant-admin"
  | "closer"
  | "lead-generator"
  | "billing-admin";

const CRM_TO_WORKOS_ROLE: Record<CrmRole, WorkosSlug> = {
  tenant_master: "owner",
  tenant_admin: "tenant-admin",
  closer: "closer",
  lead_generator: "lead-generator",
  billing_admin: "billing-admin",
};

const WORKOS_TO_CRM_ROLE: Record<string, CrmRole> = {
  owner: "tenant_master",
  "tenant-admin": "tenant_admin",
  closer: "closer",
  "lead-generator": "lead_generator",
  "billing-admin": "billing_admin",
};
```

**Step 3: Update WorkOS action role validator.**

```typescript
// Path: convex/workos/userManagement.ts
const crmRoleValidator = v.union(
  v.literal("tenant_master"),
  v.literal("tenant_admin"),
  v.literal("closer"),
  v.literal("lead_generator"),
  v.literal("billing_admin"),
);
```

**Key implementation notes:**
- Adding a union literal is a safe widen; no existing rows are invalidated.
- Do not add `billing_admin` to `ADMIN_ROLES`; that would grant tenant-admin management powers through existing checks.
- Keep `tenant_master` non-invitable and non-editable as today.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add `billing_admin` to user role union |
| `convex/lib/roleMapping.ts` | Modify | CRM/WorkOS mapping |
| `convex/workos/userManagement.ts` | Modify | Action validator accepts role |

---

### 5C — Permissions, Guards, and Server Fallbacks

**Type:** Backend / Auth
**Parallelizable:** Yes — can run with 5B, but compile depends on the widened `CrmRole`.

**What:** Grant Billing permissions to `billing_admin`, update Billing guards, and make server fallbacks route Billing Admin users to Billing.

**Why:** The role should be least-privilege: full Billing access, no broad admin access.

**Where:**
- `convex/lib/permissions.ts` (modify)
- `convex/billing/guards.ts` (modify)
- `lib/auth.ts` (modify)

**How:**

**Step 1: Add the role to Billing permissions only.**

```typescript
// Path: convex/lib/permissions.ts
export const PERMISSIONS = {
  // ... existing permissions ...
  "billing:view": ["tenant_master", "tenant_admin", "billing_admin"],
  "billing:review": ["tenant_master", "tenant_admin", "billing_admin"],
  "billing:correct": ["tenant_master", "tenant_admin", "billing_admin"],
  "billing:export": ["tenant_master", "tenant_admin", "billing_admin"],
} as const;
```

**Step 2: Allow Billing guard role resolution.**

```typescript
// Path: convex/billing/guards.ts
const BILLING_ROLES = [
  "tenant_master",
  "tenant_admin",
  "billing_admin",
] as const;
```

**Step 3: Route unauthorized Billing Admin users to Billing.**

```typescript
// Path: lib/auth.ts
function fallbackForRole(role: CrmRole) {
  if (role === "closer") return "/workspace/closer";
  if (role === "lead_generator") return "/workspace/lead-gen/capture";
  if (role === "billing_admin") return "/workspace/billing";
  return "/workspace";
}
```

**Key implementation notes:**
- Existing admin-only pages that call `requireRole(["tenant_master", "tenant_admin"])` should continue rejecting `billing_admin`.
- Pages using `requirePermission("reports:view")`, `settings:manage`, or `team:invite` should reject unless permissions are explicitly expanded.
- System-admin org users remain separate and do not become Billing Admins.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/permissions.ts` | Modify | Billing permissions include `billing_admin` |
| `convex/billing/guards.ts` | Modify | Guard resolves Billing Admin role |
| `lib/auth.ts` | Modify | Billing Admin fallback route |

---

### 5D — Team Invite and Role Edit UI

**Type:** Full-Stack
**Parallelizable:** Yes — can run with 5E after generated types include `billing_admin`.

**What:** Allow owners/admins to invite and edit users as Billing Admin without Calendly member requirements.

**Why:** A role that can only be assigned manually in the database is not operationally useful.

**Where:**
- `app/workspace/team/_components/invite-user-dialog.tsx` (modify)
- `app/workspace/team/_components/role-edit-dialog.tsx` (modify)
- `convex/workos/userManagement.ts` (verify invite/update flows)
- `convex/workos/userMutations.ts` (verify role validator if present)

**How:**

**Step 1: Update invite form schema and role options.**

```tsx
// Path: app/workspace/team/_components/invite-user-dialog.tsx
const inviteUserSchema = z
  .object({
    email: z.string().min(1, "Email is required").email("Please enter a valid email address"),
    firstName: z.string().min(1, "First name is required"),
    lastName: z.string().optional(),
    role: z.enum(["closer", "tenant_admin", "lead_generator", "billing_admin"]),
    calendlyMemberId: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.role === "closer" && !data.calendlyMemberId) {
      ctx.addIssue({
        code: "custom",
        message: "Calendly member is required for Closers",
        path: ["calendlyMemberId"],
      });
    }
  });

const roleOptions = [
  { value: "closer", label: "Closer" },
  { value: "lead_generator", label: "Lead Generator" },
  { value: "billing_admin", label: "Billing Admin" },
  { value: "tenant_admin", label: "Admin" },
] as const;
```

**Step 2: Update role edit schema.**

```tsx
// Path: app/workspace/team/_components/role-edit-dialog.tsx
const roleEditSchema = z.object({
  role: z.enum(["closer", "tenant_admin", "lead_generator", "billing_admin"]),
});

const roleOptions: Array<{ value: CrmRole; label: string }> = [
  { value: "closer", label: "Closer" },
  { value: "lead_generator", label: "Lead Generator" },
  { value: "billing_admin", label: "Billing Admin" },
  { value: "tenant_admin", label: "Admin" },
];
```

**Step 3: Preserve Calendly constraints.**

```typescript
// Path: convex/workos/userManagement.ts
if (calendlyMemberId) {
  if (role !== "closer") {
    throw new Error("Only closers can be linked to Calendly members");
  }
  // Existing Calendly member validation remains unchanged.
}
```

**Key implementation notes:**
- Billing Admin does not need a Calendly member.
- Existing tenant admins can assign Billing Admin, because the app already lets tenant admins invite non-owner roles.
- If product wants only tenant owners to assign Billing Admin, that is a separate permission change.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/team/_components/invite-user-dialog.tsx` | Modify | Add role option |
| `app/workspace/team/_components/role-edit-dialog.tsx` | Modify | Add role option |
| `convex/workos/userManagement.ts` | Verify / Modify | Invite and update role slug |
| `convex/workos/userMutations.ts` | Verify / Modify | Internal role validators |

---

### 5E — Billing Admin Workspace Shell

**Type:** Frontend / Auth
**Parallelizable:** Yes — can run with 5D after role types compile.

**What:** Give Billing Admin users a Billing-focused workspace nav and command palette while keeping profile/sign-out and denying broader admin pages.

**Why:** Billing Admin users should not land on the admin overview or see admin-only operations they cannot access.

**Where:**
- `app/workspace/_components/workspace-shell-client.tsx` (modify)
- `components/command-palette.tsx` (modify)
- `app/workspace/page.tsx` (inspect/modify if home redirect logic exists)

**How:**

**Step 1: Add Billing Admin nav items.**

```tsx
// Path: app/workspace/_components/workspace-shell-client.tsx
const billingAdminNavItems: NavItem[] = [
  { href: "/workspace/billing", label: "Billing", icon: DollarSignIcon, exact: true },
];

function navForRole(role: CrmRole, isAdmin: boolean, billingOpsEnabled: boolean) {
  if (role === "billing_admin") {
    return billingOpsEnabled ? billingAdminNavItems : [];
  }
  if (isAdmin) {
    return billingOpsEnabled
      ? [...adminNavItems.slice(0, 3), billingNavItem, ...adminNavItems.slice(3)]
      : adminNavItems;
  }
  if (role === "lead_generator") return leadGeneratorNavItems;
  return closerNavItems;
}

function homeHrefForRole(role: CrmRole, isAdmin: boolean) {
  if (role === "billing_admin") return "/workspace/billing";
  if (isAdmin) return "/workspace";
  if (role === "lead_generator") return "/workspace/lead-gen/capture";
  return "/workspace/closer";
}
```

**Step 2: Add command palette page set.**

```tsx
// Path: components/command-palette.tsx
const billingAdminPages = [
  { label: "Billing", href: "/workspace/billing", icon: DollarSignIcon, shortcut: "1" },
];

const pages = isAdmin
  ? adminPagesForBillingFlag
  : role === "billing_admin"
    ? billingAdminPages
    : role === "lead_generator"
      ? leadGenPages
      : closerPages;
```

**Step 3: Avoid reports section for Billing Admin.**

```tsx
// Path: app/workspace/_components/workspace-shell-client.tsx
{isAdmin && (
  <SidebarGroup>
    <SidebarGroupLabel>Reports</SidebarGroupLabel>
    {/* existing reports */}
  </SidebarGroup>
)}
```

`isAdmin` should remain true only for `tenant_master` and `tenant_admin` via `RoleProvider`, so the existing reports section stays hidden.

**Key implementation notes:**
- If Billing Ops is disabled, Billing Admin may have no workspace nav item. Direct `/workspace/billing` renders unavailable.
- Keep Profile and Sign Out footer visible.
- Keyboard shortcut handlers must tolerate an empty nav array.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/workspace-shell-client.tsx` | Modify | Billing Admin nav/home |
| `components/command-palette.tsx` | Modify | Billing Admin page set |
| `app/workspace/page.tsx` | Inspect / Modify | Home fallback if needed |

---

### 5F — Assignment Migration and QA

**Type:** Migration / Manual / QA
**Parallelizable:** No — final gate for role rollout.

**What:** Document and execute manual assignment or migration for selected billing users, then verify access boundaries.

**Why:** Role rollout crosses WorkOS and CRM. The system must handle pending invitations, active memberships, and rollback cleanly.

**Where:**
- `plans/billing-ops/phases/phase5-role-rollout.md` (modify)
- `convex/admin/migrations.ts` or `convex/migrations.ts` (optional, only if bulk assignment is needed)

**How:**

**Step 1: Prefer manual assignment for the current production test tenant.**

```typescript
// Path: plans/billing-ops/phases/phase5-role-rollout.md
export const assignmentPlan = {
  default: "manual",
  reason:
    "The app has one production test tenant, so manual CRM + WorkOS assignment is lower risk than a bulk migration.",
  rollback:
    "Change the user back to tenant_admin/closer in CRM and WorkOS membership, then force re-auth if session claims are stale.",
} as const;
```

**Step 2: Use a migration only for bulk assignment.**

```typescript
// Path: convex/migrations.ts
export const assertBillingAdminAssignments = migrations.define({
  table: "users",
  batchSize: 100,
  migrateOne: async (_ctx, user) => {
    if (user.role === "billing_admin" && user.isActive === false) {
      throw new Error(`Inactive billing_admin user ${user._id} must be reviewed`);
    }
  },
});
```

**Step 3: Verify access matrix.**

| Role | Billing | Team | Settings | Reviews | Reports | Closer Pipeline |
|---|---:|---:|---:|---:|---:|---:|
| `billing_admin` | Yes | No | No | No | No | No |
| `tenant_admin` | Yes | Yes | Yes | Yes | Yes | No |
| `closer` | No | No | No | No | No | Yes |
| `lead_generator` | No | No | No | No | No | No |

**Key implementation notes:**
- If a user is assigned by WorkOS dashboard only, CRM role will remain stale. Update both systems through the app or a controlled admin mutation.
- For pending invitations, revoke/re-send so WorkOS membership gets the correct role on accept.
- After role changes, use `router.refresh()` as existing team dialogs do; users may still need a new session for WorkOS-side display.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/billing-ops/phases/phase5-role-rollout.md` | Modify | Assignment and rollback plan |
| `convex/migrations.ts` | Optional Modify | Only for bulk assignment/assertions |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `plans/billing-ops/phases/phase5-role-rollout.md` | Create / Modify | 5A, 5F |
| `convex/schema.ts` | Modify | 5B |
| `convex/lib/roleMapping.ts` | Modify | 5B |
| `convex/workos/userManagement.ts` | Modify | 5B, 5D |
| `convex/lib/permissions.ts` | Modify | 5C |
| `convex/billing/guards.ts` | Modify | 5C |
| `lib/auth.ts` | Modify | 5C |
| `app/workspace/team/_components/invite-user-dialog.tsx` | Modify | 5D |
| `app/workspace/team/_components/role-edit-dialog.tsx` | Modify | 5D |
| `convex/workos/userMutations.ts` | Verify / Modify | 5D |
| `app/workspace/_components/workspace-shell-client.tsx` | Modify | 5E |
| `components/command-palette.tsx` | Modify | 5E |
| `app/workspace/page.tsx` | Inspect / Modify | 5E |
| `convex/migrations.ts` | Optional Modify | 5F |
