# Phase 1 — RBAC and Worker Configuration

**Goal:** Add `lead_generator` as a first-class CRM role, create the Lead Gen Ops worker/team/schedule/settings foundation, and make workspace routing safe before any worker can sign in. After this phase, admins can configure workers without giving them closer/admin CRM access.

**Prerequisite:** Phase 0 complete. WorkOS role slug `lead-generator` exists in dev before local verification and in production before deployment. No production worker invitations are sent until the Phase 1 route/nav gate passes.

**Runs in PARALLEL with:** Nothing at the phase level — Phases 2, 3, and 4 depend on the schema, role union, permissions, and route fallback behavior from this phase. Internal subphases parallelize after schema widening.

**Skills to invoke:**
- `convex` — schema validators, internal mutations, indexed queries, and generated types.
- `convex-migration-helper` — confirm this stays widen-only and no data backfill is introduced.
- `workos` — role slug, invitation, membership update, and stale-session behavior.
- `convex-dev-workos-authkit` — invited-user claim and AuthKit identity sync implications.
- `next-best-practices` — Server Component route gates, `redirect()`, and client boundary placement.
- `shadcn` — invite/role-edit forms, tabs, tables, switches, and skeleton primitives.
- `frontend-design` — admin configuration UI should be dense, operational, and consistent with the workspace shell.

**Acceptance Criteria:**
1. `users.role`, `CrmRole`, and all WorkOS user-management validators accept `lead_generator`.
2. `mapCrmRoleToWorkosSlug("lead_generator")` returns `lead-generator`, and `mapWorkosSlugToCrmRole("lead-generator")` returns `lead_generator`.
3. `lead_generator` has only Lead Gen Ops permissions and does not satisfy admin, closer, pipeline, meeting, payment, customer, or CRM report permissions.
4. New `leadGenSettings`, `leadGenTeams`, `leadGenWorkers`, and `leadGenWorkerSchedules` tables deploy with tenant-scoped indexes.
5. Inviting a `lead_generator` creates a CRM user and active/pending `leadGenWorkers` profile without requiring a Calendly member.
6. Changing a user to `lead_generator` creates or reactivates a worker profile; changing away or removing the user deactivates the worker profile without deleting history.
7. `/workspace` redirects `lead_generator` users to `/workspace/lead-gen/capture`; direct admin/closer route probes redirect through server gates.
8. Sidebar, command palette, keyboard shortcuts, breadcrumbs, and home link show a dedicated Lead Gen route set for `lead_generator`.
9. Admin invite and role-edit dialogs expose Lead Generator while preserving owner protections and closer Calendly-member validation.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (Schema + validators) ─────────────┬── 1B (Permissions + auth fallbacks) ──────┐
                                      ├── 1C (WorkOS lifecycle + worker sync) ───┤
                                      ├── 1D (Worker/team/settings functions) ───┤
                                      └── 1E (Route/nav shell safety) ───────────┤
                                                                                  ├── 1F (Admin config UI)
1B + 1C + 1D + 1E complete ──────────────────────────────────────────────────────┘

1F complete ─────────────────────────────── 1G (Phase 1 verification gate)
```

**Optimal execution:**
1. Complete 1A first and run `npx convex dev --once` so generated types include the new role and tables.
2. Run 1B, 1C, 1D, and 1E in parallel; they touch separate helper/action/frontend files but all depend on generated types.
3. Start 1F after 1B and 1D are stable so admin UI imports real permissions and functions.
4. Finish with 1G before enabling worker invites in any environment.

**Estimated time:** 2-3 days

> **Critical path:** Phase 1 is on the critical path for the full feature. Do not start capture, reporting, Slack matching, or corrections against local stubs until this schema/auth foundation compiles.

---

## Subphases

### 1A — Widen Schema and Add Lead Gen Validators

**Type:** Backend  
**Parallelizable:** No — every later subphase imports the generated role/table types.

**What:** Add `lead_generator` to the `users.role` union and create the foundational Lead Gen Ops tables and shared validators.

**Why:** Convex generated types must know the new role and table IDs before WorkOS, route guards, worker functions, capture, reporting, and audit matching can compile.

**Where:**
- `convex/schema.ts` (modify)
- `convex/leadGen/validators.ts` (new)

**How:**

**Step 1: Create shared validators.**

```typescript
// Path: convex/leadGen/validators.ts
import { v } from "convex/values";

export const leadGenSourceValidator = v.union(
  v.literal("instagram"),
  v.literal("meta_business"),
);

export const leadGenOriginKindValidator = v.union(
  v.literal("post"),
  v.literal("reel"),
  v.literal("story_poll"),
  v.literal("follower"),
  v.literal("application"),
  v.literal("meta_business"),
  v.literal("other"),
);

export const leadGenAuditMatchSourceValidator = v.union(
  v.literal("slack_qualification"),
  v.literal("admin_correction"),
);

export const leadGenAuditMatchStatusValidator = v.union(
  v.literal("candidate"),
  v.literal("accepted"),
  v.literal("rejected"),
);

export const leadGenWeekdayValidator = v.union(
  v.literal("monday"),
  v.literal("tuesday"),
  v.literal("wednesday"),
  v.literal("thursday"),
  v.literal("friday"),
  v.literal("saturday"),
  v.literal("sunday"),
);
```

**Step 2: Import validators in the schema.**

```typescript
// Path: convex/schema.ts
import {
  leadGenAuditMatchSourceValidator,
  leadGenAuditMatchStatusValidator,
  leadGenOriginKindValidator,
  leadGenSourceValidator,
  leadGenWeekdayValidator,
} from "./leadGen/validators";
```

**Step 3: Widen `users.role`.**

```typescript
// Path: convex/schema.ts
users: defineTable({
  tenantId: v.id("tenants"),
  workosUserId: v.string(),
  email: v.string(),
  fullName: v.optional(v.string()),
  role: v.union(
    v.literal("tenant_master"),
    v.literal("tenant_admin"),
    v.literal("closer"),
    v.literal("lead_generator"),
  ),
  calendlyUserUri: v.optional(v.string()),
  calendlyMemberName: v.optional(v.string()),
  invitationStatus: v.optional(
    v.union(v.literal("pending"), v.literal("accepted")),
  ),
  workosInvitationId: v.optional(v.string()),
  personalEventTypeUri: v.optional(v.string()),
  deletedAt: v.optional(v.number()),
  isActive: v.boolean(),
})
```

**Step 4: Add Phase 1 tables.**

```typescript
// Path: convex/schema.ts
leadGenSettings: defineTable({
  tenantId: v.id("tenants"),
  correctionWindowMinutes: v.optional(v.number()),
  rawExportMaxRows: v.number(),
  duplicateDisplayMode: v.union(
    v.literal("show_all"),
    v.literal("group_by_prospect"),
  ),
  createdAt: v.number(),
  updatedAt: v.number(),
}).index("by_tenantId", ["tenantId"]),

leadGenTeams: defineTable({
  tenantId: v.id("tenants"),
  name: v.string(),
  normalizedName: v.string(),
  isActive: v.boolean(),
  createdByUserId: v.id("users"),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_tenantId", ["tenantId"])
  .index("by_tenantId_and_isActive", ["tenantId", "isActive"])
  .index("by_tenantId_and_normalizedName", ["tenantId", "normalizedName"]),

leadGenWorkers: defineTable({
  tenantId: v.id("tenants"),
  userId: v.id("users"),
  workosUserId: v.string(),
  displayName: v.optional(v.string()),
  email: v.string(),
  teamId: v.optional(v.id("leadGenTeams")),
  isActive: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_tenantId", ["tenantId"])
  .index("by_tenantId_and_userId", ["tenantId", "userId"])
  .index("by_tenantId_and_workosUserId", ["tenantId", "workosUserId"])
  .index("by_tenantId_and_isActive", ["tenantId", "isActive"])
  .index("by_tenantId_and_teamId", ["tenantId", "teamId"]),

leadGenWorkerSchedules: defineTable({
  tenantId: v.id("tenants"),
  workerId: v.id("leadGenWorkers"),
  userId: v.id("users"),
  weekday: leadGenWeekdayValidator,
  scheduledHours: v.number(),
  updatedByUserId: v.id("users"),
  updatedAt: v.number(),
})
  .index("by_tenantId_and_workerId", ["tenantId", "workerId"])
  .index("by_tenantId_and_workerId_and_weekday", [
    "tenantId",
    "workerId",
    "weekday",
  ]),
```

**Step 5: Add future tables now to avoid cross-phase schema ownership.**

```typescript
// Path: convex/schema.ts
leadGenProspects: defineTable({
  tenantId: v.id("tenants"),
  firstSource: leadGenSourceValidator,
  latestSource: leadGenSourceValidator,
  dedupeKey: v.string(),
  normalizedHandle: v.string(),
  rawHandle: v.string(),
  profileUrl: v.string(),
  firstCapturedByWorkerId: v.id("leadGenWorkers"),
  firstCapturedAt: v.number(),
  lastSubmittedByWorkerId: v.id("leadGenWorkers"),
  lastSubmittedAt: v.number(),
  latestOriginKind: leadGenOriginKindValidator,
  latestOriginValue: v.optional(v.string()),
  contactAttemptCount: v.number(),
  distinctWorkerCount: v.number(),
  currentAuditMatchId: v.optional(v.id("leadGenAuditMatches")),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_tenantId", ["tenantId"])
  .index("by_tenantId_and_dedupeKey", ["tenantId", "dedupeKey"])
  .index("by_tenantId_and_normalizedHandle", ["tenantId", "normalizedHandle"])
  .index("by_tenantId_and_latestSource", ["tenantId", "latestSource"])
  .index("by_tenantId_and_lastSubmittedAt", ["tenantId", "lastSubmittedAt"])
  .index("by_tenantId_and_firstCapturedByWorkerId", [
    "tenantId",
    "firstCapturedByWorkerId",
  ])
  .index("by_tenantId_and_currentAuditMatchId", [
    "tenantId",
    "currentAuditMatchId",
  ]),

leadGenSubmissions: defineTable({
  tenantId: v.id("tenants"),
  prospectId: v.id("leadGenProspects"),
  workerId: v.id("leadGenWorkers"),
  userId: v.id("users"),
  teamId: v.optional(v.id("leadGenTeams")),
  source: leadGenSourceValidator,
  originKind: leadGenOriginKindValidator,
  originValue: v.optional(v.string()),
  originRankable: v.boolean(),
  clientSubmissionKey: v.optional(v.string()),
  submittedAt: v.number(),
  createdAt: v.number(),
  voidedAt: v.optional(v.number()),
  voidedByUserId: v.optional(v.id("users")),
  voidReason: v.optional(v.string()),
})
  .index("by_tenantId_and_submittedAt", ["tenantId", "submittedAt"])
  .index("by_tenantId_and_workerId_and_submittedAt", [
    "tenantId",
    "workerId",
    "submittedAt",
  ])
  .index("by_tenantId_and_teamId_and_submittedAt", [
    "tenantId",
    "teamId",
    "submittedAt",
  ])
  .index("by_tenantId_and_source_and_submittedAt", [
    "tenantId",
    "source",
    "submittedAt",
  ])
  .index("by_tenantId_and_prospectId", ["tenantId", "prospectId"])
  .index("by_tenantId_and_prospectId_and_submittedAt", [
    "tenantId",
    "prospectId",
    "submittedAt",
  ])
  .index("by_tenantId_and_prospectId_and_workerId", [
    "tenantId",
    "prospectId",
    "workerId",
  ])
  .index("by_tenantId_and_workerId_and_clientSubmissionKey", [
    "tenantId",
    "workerId",
    "clientSubmissionKey",
  ]),
```

**Step 6: Add aggregate, audit, and correction tables in the same schema commit.**

```typescript
// Path: convex/schema.ts
leadGenDailyStats: defineTable({
  tenantId: v.id("tenants"),
  statKey: v.string(),
  dayKey: v.string(),
  workerId: v.id("leadGenWorkers"),
  userId: v.id("users"),
  teamId: v.optional(v.id("leadGenTeams")),
  source: leadGenSourceValidator,
  submissions: v.number(),
  uniqueProspectsSubmitted: v.number(),
  duplicateProspectSubmissions: v.number(),
  scheduledHours: v.number(),
  updatedAt: v.number(),
})
  .index("by_tenantId_and_statKey", ["tenantId", "statKey"])
  .index("by_tenantId_and_dayKey", ["tenantId", "dayKey"])
  .index("by_tenantId_and_workerId_and_dayKey", [
    "tenantId",
    "workerId",
    "dayKey",
  ])
  .index("by_tenantId_and_teamId_and_dayKey", [
    "tenantId",
    "teamId",
    "dayKey",
  ])
  .index("by_tenantId_and_source_and_dayKey", [
    "tenantId",
    "source",
    "dayKey",
  ]),

leadGenOriginStats: defineTable({
  tenantId: v.id("tenants"),
  originKey: v.string(),
  dayKey: v.string(),
  source: leadGenSourceValidator,
  originKind: leadGenOriginKindValidator,
  originValue: v.string(),
  submissions: v.number(),
  uniqueProspectsSubmitted: v.number(),
  updatedAt: v.number(),
})
  .index("by_tenantId_and_dayKey", ["tenantId", "dayKey"])
  .index("by_tenantId_and_originKey_and_dayKey", [
    "tenantId",
    "originKey",
    "dayKey",
  ])
  .index("by_tenantId_and_source_and_dayKey", [
    "tenantId",
    "source",
    "dayKey",
  ]),

leadGenAuditMatches: defineTable({
  tenantId: v.id("tenants"),
  prospectId: v.id("leadGenProspects"),
  leadId: v.id("leads"),
  opportunityId: v.optional(v.id("opportunities")),
  matchSource: leadGenAuditMatchSourceValidator,
  matchStatus: leadGenAuditMatchStatusValidator,
  matchedVia: v.literal("social_handle"),
  normalizedHandle: v.string(),
  createdByUserId: v.optional(v.id("users")),
  rejectedByUserId: v.optional(v.id("users")),
  rejectedAt: v.optional(v.number()),
  rejectionReason: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_tenantId_and_prospectId", ["tenantId", "prospectId"])
  .index("by_tenantId_and_leadId", ["tenantId", "leadId"])
  .index("by_tenantId_and_opportunityId", ["tenantId", "opportunityId"])
  .index("by_tenantId_and_matchStatus", ["tenantId", "matchStatus"])
  .index("by_tenantId_and_prospectId_and_leadId", [
    "tenantId",
    "prospectId",
    "leadId",
  ]),

leadGenCorrectionEvents: defineTable({
  tenantId: v.id("tenants"),
  targetType: v.union(
    v.literal("prospect"),
    v.literal("submission"),
    v.literal("audit_match"),
  ),
  targetId: v.string(),
  correctionKind: v.union(
    v.literal("edited"),
    v.literal("voided"),
    v.literal("match_rejected"),
    v.literal("match_accepted"),
  ),
  reason: v.string(),
  beforeSnapshot: v.string(),
  afterSnapshot: v.string(),
  correctedByUserId: v.id("users"),
  correctedAt: v.number(),
})
  .index("by_tenantId_and_correctedAt", ["tenantId", "correctedAt"])
  .index("by_tenantId_and_targetType_and_targetId", [
    "tenantId",
    "targetType",
    "targetId",
  ]),
```

**Step 7: Verify schema generation.**

```bash
# Path: terminal
npx convex dev --once
```

**Key implementation notes:**
- This remains widen-only because existing documents still satisfy the schema.
- Add all new Lead Gen tables in Phase 1 so later phases do not fight over `convex/schema.ts`.
- Every table includes `tenantId`; public functions must still derive it from auth.
- Index names include all indexed fields and keep the field order used by queries.
- Do not add `leadGenWorkers` as an array on `users`; workers need independent lifecycle and reporting fields.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leadGen/validators.ts` | Create | Shared Lead Gen validators |
| `convex/schema.ts` | Modify | Widen `users.role` and add all Lead Gen tables |

---

### 1B — Role Mapping, Permissions, and Server Fallbacks

**Type:** Backend / Auth  
**Parallelizable:** Yes — depends only on 1A generated role type.

**What:** Add `lead_generator` to CRM/WorkOS mapping, add Lead Gen permission literals, and update server-side fallback helpers so `lead_generator` never falls into closer routes.

**Why:** The app currently treats non-admin workspace users as closers in several places. A dedicated role branch is required before workers can authenticate.

**Where:**
- `convex/lib/roleMapping.ts` (modify)
- `convex/lib/permissions.ts` (modify)
- `lib/auth.ts` (modify)
- `components/auth/role-context.tsx` (verify; likely no change beyond generated types)

**How:**

**Step 1: Extend role mapping.**

```typescript
// Path: convex/lib/roleMapping.ts
export type CrmRole =
  | "tenant_master"
  | "tenant_admin"
  | "closer"
  | "lead_generator";

export type WorkosSlug =
  | "owner"
  | "tenant-admin"
  | "closer"
  | "lead-generator";

const CRM_TO_WORKOS_ROLE: Record<CrmRole, WorkosSlug> = {
  tenant_master: "owner",
  tenant_admin: "tenant-admin",
  closer: "closer",
  lead_generator: "lead-generator",
};

const WORKOS_TO_CRM_ROLE: Record<string, CrmRole> = {
  owner: "tenant_master",
  "tenant-admin": "tenant_admin",
  closer: "closer",
  "lead-generator": "lead_generator",
};

export const ADMIN_ROLES: CrmRole[] = ["tenant_master", "tenant_admin"];
```

**Step 2: Add Lead Gen permissions without changing existing CRM permissions.**

```typescript
// Path: convex/lib/permissions.ts
export const PERMISSIONS = {
  // existing permissions...
  "lead-gen:capture": ["lead_generator", "tenant_master", "tenant_admin"],
  "lead-gen:view-own": ["lead_generator", "tenant_master", "tenant_admin"],
  "lead-gen:view-all": ["tenant_master", "tenant_admin"],
  "lead-gen:manage-workers": ["tenant_master", "tenant_admin"],
  "lead-gen:manage-config": ["tenant_master", "tenant_admin"],
  "lead-gen:correct": ["tenant_master", "tenant_admin"],
  "lead-gen:export": ["tenant_master", "tenant_admin"],
} as const;
```

**Step 3: Add role-specific fallback and permission guard.**

```typescript
// Path: lib/auth.ts
import type { Permission } from "@/convex/lib/permissions";
import { hasPermission } from "@/convex/lib/permissions";

function fallbackForRole(role: CrmRole) {
  if (role === "closer") return "/workspace/closer";
  if (role === "lead_generator") return "/workspace/lead-gen/capture";
  return "/workspace";
}

export async function requireRole(allowedRoles: CrmRole[]) {
  const access = await requireWorkspaceUser();

  if (!allowedRoles.includes(access.crmUser.role)) {
    redirect(fallbackForRole(access.crmUser.role));
  }

  return access;
}

export async function requirePermission(permission: Permission) {
  const access = await requireWorkspaceUser();

  if (!hasPermission(access.crmUser.role, permission)) {
    redirect(fallbackForRole(access.crmUser.role));
  }

  return access;
}
```

**Key implementation notes:**
- Keep `ADMIN_ROLES` unchanged. Lead generators are not admins.
- Do not default unknown WorkOS roles to `lead_generator`; the current fallback to `closer` is a legacy safety behavior, but any new role mapping should be explicit.
- `useRole().hasPermission()` remains UI-only; every Convex function still calls `requireTenantUser()`.
- Consider adding a unit-level type assertion or exhaustive object mapping so future roles cannot be omitted silently.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/roleMapping.ts` | Modify | Add `lead_generator` and `lead-generator` mapping |
| `convex/lib/permissions.ts` | Modify | Add Lead Gen permission literals |
| `lib/auth.ts` | Modify | Add `fallbackForRole()` and `requirePermission()` |

---

### 1C — WorkOS Lifecycle and Worker Profile Sync

**Type:** Backend / WorkOS  
**Parallelizable:** Yes — depends on 1A and 1B role types, independent from route UI.

**What:** Widen WorkOS user-management validators and add an internal helper that keeps `leadGenWorkers` in sync whenever users are invited, claimed, role-changed, removed, or reactivated.

**Why:** Worker profiles are operational records with historical reporting links. They must follow user lifecycle events without deleting submissions or duplicating sync logic across WorkOS actions.

**Where:**
- `convex/leadGen/workers.ts` (new)
- `convex/workos/userManagement.ts` (modify)
- `convex/workos/userMutations.ts` (modify)
- `convex/users/queries.ts` (verify internal current-user return shape)

**How:**

**Step 1: Create the internal worker sync helper.**

```typescript
// Path: convex/leadGen/workers.ts
import { v } from "convex/values";
import { internalMutation, mutation, query } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireTenantUser } from "../requireTenantUser";

function displayNameForUser(user: Doc<"users">) {
  return user.fullName?.trim() || user.email;
}

export const syncWorkerProfileForUser = internalMutation({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (!user) return null;

    const existing = await ctx.db
      .query("leadGenWorkers")
      .withIndex("by_tenantId_and_userId", (q) =>
        q.eq("tenantId", user.tenantId).eq("userId", user._id),
      )
      .unique();

    const shouldBeActive = user.role === "lead_generator" && user.isActive;
    const now = Date.now();

    if (!existing && user.role !== "lead_generator") {
      return null;
    }

    if (!existing) {
      return await ctx.db.insert("leadGenWorkers", {
        tenantId: user.tenantId,
        userId: user._id,
        workosUserId: user.workosUserId,
        email: user.email,
        displayName: displayNameForUser(user),
        isActive: shouldBeActive,
        createdAt: now,
        updatedAt: now,
      });
    }

    await ctx.db.patch(existing._id, {
      workosUserId: user.workosUserId,
      email: user.email,
      displayName: displayNameForUser(user),
      isActive: shouldBeActive,
      updatedAt: now,
    });

    return existing._id;
  },
});
```

**Step 2: Widen role validators in WorkOS actions and mutations.**

```typescript
// Path: convex/workos/userManagement.ts
role: v.union(
  v.literal("tenant_master"),
  v.literal("tenant_admin"),
  v.literal("closer"),
  v.literal("lead_generator"),
),
```

```typescript
// Path: convex/workos/userManagement.ts
newRole: v.union(
  v.literal("tenant_master"),
  v.literal("tenant_admin"),
  v.literal("closer"),
  v.literal("lead_generator"),
),
```

```typescript
// Path: convex/workos/userMutations.ts
role: v.union(
  v.literal("tenant_master"),
  v.literal("tenant_admin"),
  v.literal("closer"),
  v.literal("lead_generator"),
),
```

**Step 3: Keep Calendly member assignment closer-only.**

```typescript
// Path: convex/workos/userManagement.ts
if (calendlyMemberId && role !== "closer") {
  throw new Error("Only closers can be linked to Calendly members");
}
```

**Step 4: Sync after every lifecycle mutation.**

```typescript
// Path: convex/workos/userMutations.ts
import { internal } from "../_generated/api";

// After createInvitedUser inserts or patches the user:
await ctx.runMutation(internal.leadGen.workers.syncWorkerProfileForUser, {
  userId,
});

// After claimInvitedAccountByEmail patches the real WorkOS user id:
await ctx.runMutation(internal.leadGen.workers.syncWorkerProfileForUser, {
  userId: pendingUser._id,
});

// After updateRole / updateRoleAndInvitation patches role:
await ctx.runMutation(internal.leadGen.workers.syncWorkerProfileForUser, {
  userId,
});

// After removeUser soft-deletes the user:
await ctx.runMutation(internal.leadGen.workers.syncWorkerProfileForUser, {
  userId,
});
```

**Step 5: Clear stale Calendly assignment when changing a closer to lead generator.**

```typescript
// Path: convex/workos/userMutations.ts
const patch: {
  role: Doc<"users">["role"];
  calendlyUserUri?: undefined;
  calendlyMemberName?: undefined;
  personalEventTypeUri?: undefined;
} = { role };

if (role === "lead_generator") {
  patch.calendlyUserUri = undefined;
  patch.calendlyMemberName = undefined;
  patch.personalEventTypeUri = undefined;
}

await ctx.db.patch(userId, patch);
```

**Key implementation notes:**
- The helper deactivates profiles instead of deleting them; historical submissions must keep stable `workerId` references.
- Pending invited users get a worker profile with `workosUserId = "pending:<email>"`; claim flow patches it to the canonical WorkOS ID.
- Keep tenant stats logic focused on team members and closers. Do not increment `totalClosers` for `lead_generator`.
- Role changes take effect on the user's next WorkOS session; server-side CRM role checks refresh on request.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leadGen/workers.ts` | Create | Internal worker sync helper plus admin worker functions in 1D |
| `convex/workos/userManagement.ts` | Modify | Widen validators and keep Calendly closer-only |
| `convex/workos/userMutations.ts` | Modify | Widen validators and call worker sync after lifecycle changes |

---

### 1D — Worker, Team, Schedule, and Settings Functions

**Type:** Backend  
**Parallelizable:** Yes — depends on 1A and `requireTenantUser()` supporting the widened `CrmRole`.

**What:** Add admin functions for listing workers, managing teams, updating worker profiles, setting schedules, and reading/updating tenant Lead Gen settings.

**Why:** Capture and reporting need stable worker/team/schedule records. Admin configuration is desktop-first and must be server-authorized, not sidebar-hidden.

**Where:**
- `convex/leadGen/workers.ts` (modify)
- `convex/leadGen/settings.ts` (new)

**How:**

**Step 1: Add admin list query.**

```typescript
// Path: convex/leadGen/workers.ts
export const listWorkers = query({
  args: {
    includeInactive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const rows = await ctx.db
      .query("leadGenWorkers")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(250);

    return rows
      .filter((worker) => args.includeInactive || worker.isActive)
      .sort((a, b) => a.email.localeCompare(b.email));
  },
});
```

**Step 2: Add team create/archive functions.**

```typescript
// Path: convex/leadGen/workers.ts
function normalizeTeamName(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export const createTeam = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const normalizedName = normalizeTeamName(name);
    if (!normalizedName) throw new Error("Team name is required");

    const existing = await ctx.db
      .query("leadGenTeams")
      .withIndex("by_tenantId_and_normalizedName", (q) =>
        q.eq("tenantId", tenantId).eq("normalizedName", normalizedName),
      )
      .unique();
    if (existing && existing.isActive) {
      throw new Error("A lead-gen team with this name already exists");
    }

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        name: name.trim(),
        isActive: true,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("leadGenTeams", {
      tenantId,
      name: name.trim(),
      normalizedName,
      isActive: true,
      createdByUserId: userId,
      createdAt: now,
      updatedAt: now,
    });
  },
});
```

**Step 3: Add worker profile update with tenant validation.**

```typescript
// Path: convex/leadGen/workers.ts
export const updateWorkerProfile = mutation({
  args: {
    workerId: v.id("leadGenWorkers"),
    teamId: v.optional(v.id("leadGenTeams")),
    isActive: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const worker = await ctx.db.get(args.workerId);
    if (!worker || worker.tenantId !== tenantId) {
      throw new Error("Worker not found");
    }

    if (args.teamId) {
      const team = await ctx.db.get(args.teamId);
      if (!team || team.tenantId !== tenantId || !team.isActive) {
        throw new Error("Invalid lead-gen team");
      }
    }

    await ctx.db.patch(worker._id, {
      teamId: args.teamId,
      isActive: args.isActive,
      updatedAt: Date.now(),
    });

    return worker._id;
  },
});
```

**Step 4: Add schedule upsert.**

```typescript
// Path: convex/leadGen/workers.ts
import { leadGenWeekdayValidator } from "./validators";

export const setWorkerSchedule = mutation({
  args: {
    workerId: v.id("leadGenWorkers"),
    weekday: leadGenWeekdayValidator,
    scheduledHours: v.number(),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    if (args.scheduledHours < 0 || args.scheduledHours > 24) {
      throw new Error("Scheduled hours must be between 0 and 24");
    }

    const worker = await ctx.db.get(args.workerId);
    if (!worker || worker.tenantId !== tenantId) {
      throw new Error("Worker not found");
    }

    const existing = await ctx.db
      .query("leadGenWorkerSchedules")
      .withIndex("by_tenantId_and_workerId_and_weekday", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("workerId", worker._id)
          .eq("weekday", args.weekday),
      )
      .unique();

    const patch = {
      scheduledHours: args.scheduledHours,
      updatedByUserId: userId,
      updatedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }

    return await ctx.db.insert("leadGenWorkerSchedules", {
      tenantId,
      workerId: worker._id,
      userId: worker.userId,
      weekday: args.weekday,
      ...patch,
    });
  },
});
```

**Step 5: Add settings get/update.**

```typescript
// Path: convex/leadGen/settings.ts
import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

const DEFAULT_RAW_EXPORT_MAX_ROWS = 5000;

export const getSettings = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const settings = await ctx.db
      .query("leadGenSettings")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .unique();

    return (
      settings ?? {
        rawExportMaxRows: DEFAULT_RAW_EXPORT_MAX_ROWS,
        duplicateDisplayMode: "show_all" as const,
      }
    );
  },
});

export const updateSettings = mutation({
  args: {
    correctionWindowMinutes: v.optional(v.number()),
    rawExportMaxRows: v.number(),
    duplicateDisplayMode: v.union(
      v.literal("show_all"),
      v.literal("group_by_prospect"),
    ),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    if (args.rawExportMaxRows < 1 || args.rawExportMaxRows > 50000) {
      throw new Error("Raw export limit must be between 1 and 50000 rows");
    }

    const existing = await ctx.db
      .query("leadGenSettings")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .unique();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { ...args, updatedAt: now });
      return existing._id;
    }

    return await ctx.db.insert("leadGenSettings", {
      tenantId,
      ...args,
      createdAt: now,
      updatedAt: now,
    });
  },
});
```

**Key implementation notes:**
- Query bounds are intentionally explicit. If a tenant can exceed 250 workers, switch to pagination instead of raising bounds blindly.
- Settings are tenant-scoped and admin-only. Capture should not need to read admin settings during repeated entry unless product adds worker edit windows.
- Store weekly schedules as separate rows, not an array on `leadGenWorkers`, so later snapshots and edits avoid rewriting a hot profile document.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leadGen/workers.ts` | Modify | Admin worker/team/schedule queries and mutations |
| `convex/leadGen/settings.ts` | Create | Tenant Lead Gen settings query/mutation |

---

### 1E — Workspace Route, Navigation, and Command Safety

**Type:** Frontend / Auth  
**Parallelizable:** Yes — depends on 1B permission/fallback helpers; independent from WorkOS action internals.

**What:** Update workspace landing, nav selection, command palette, shortcuts, breadcrumbs, and home link so lead generators see only Lead Gen Ops entry points.

**Why:** The current app assumes non-admin means closer. That is unsafe for a third role with no CRM pipeline access.

**Where:**
- `app/workspace/page.tsx` (modify)
- `app/workspace/_components/workspace-shell-client.tsx` (modify)
- `components/command-palette.tsx` (modify)
- `components/workspace-breadcrumbs.tsx` (modify)

**How:**

**Step 1: Redirect `/workspace` by role.**

```tsx
// Path: app/workspace/page.tsx
import { redirect } from "next/navigation";
import { requireWorkspaceUser } from "@/lib/auth";
import { DashboardPageClient } from "./_components/dashboard-page-client";

export const unstable_instant = false;

export default async function WorkspaceIndexPage() {
  const access = await requireWorkspaceUser();

  if (access.crmUser.role === "lead_generator") {
    redirect("/workspace/lead-gen/capture");
  }

  if (access.crmUser.role === "closer") {
    redirect("/workspace/closer");
  }

  return <DashboardPageClient />;
}
```

**Step 2: Add a dedicated Lead Gen nav set.**

```tsx
// Path: app/workspace/_components/workspace-shell-client.tsx
import {
  ActivityIcon,
  ClipboardListIcon,
  TargetIcon,
  UserCircleIcon,
} from "lucide-react";

const leadGeneratorNavItems: NavItem[] = [
  {
    href: "/workspace/lead-gen/capture",
    label: "Capture",
    icon: TargetIcon,
    exact: true,
  },
  {
    href: "/workspace/lead-gen/my-activity",
    label: "My Activity",
    icon: ActivityIcon,
  },
];

function navForRole(role: CrmRole, isAdmin: boolean) {
  if (isAdmin) return adminNavItems;
  if (role === "lead_generator") return leadGeneratorNavItems;
  return closerNavItems;
}

function homeHrefForRole(role: CrmRole, isAdmin: boolean) {
  if (isAdmin) return "/workspace";
  if (role === "lead_generator") return "/workspace/lead-gen/capture";
  return "/workspace/closer";
}
```

**Step 3: Use the helpers in the shell.**

```tsx
// Path: app/workspace/_components/workspace-shell-client.tsx
const navItems = navForRole(role, isAdmin);
const homeHref = homeHrefForRole(role, isAdmin);

// ...
<Link
  href={homeHref}
  aria-label="MAGNUS CRM workspace home"
  className="group/brand flex min-h-10 items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-1"
>
  <MagnusBrand
    label="MAGNUS CRM"
    size="sm"
    textClassName="text-sidebar-foreground group-hover/brand:text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden"
  />
</Link>
```

**Step 4: Update command palette role lists.**

```tsx
// Path: components/command-palette.tsx
import { ActivityIcon, TargetIcon } from "lucide-react";

const leadGenPages = [
  {
    label: "Capture",
    href: "/workspace/lead-gen/capture",
    icon: TargetIcon,
    shortcut: "1",
  },
  {
    label: "My Activity",
    href: "/workspace/lead-gen/my-activity",
    icon: ActivityIcon,
    shortcut: "2",
  },
];

export function CommandPalette() {
  const router = useRouter();
  const { isAdmin, role } = useRole();

  const pages = isAdmin
    ? adminPages
    : role === "lead_generator"
      ? leadGenPages
      : closerPages;

  const showCreateOpportunity = isAdmin || role === "closer";
  // Render "Create opportunity" only when showCreateOpportunity is true.
}
```

**Step 5: Add breadcrumb labels.**

```tsx
// Path: components/workspace-breadcrumbs.tsx
const segmentLabels: Record<string, string> = {
  // existing labels...
  "lead-gen": "Lead Gen Ops",
  capture: "Capture",
  "my-activity": "My Activity",
  prospects: "Prospects",
};
```

**Key implementation notes:**
- Keep admin users on the admin route set. Admin capture is allowed through explicit Lead Gen pages, not by replacing their whole shell.
- Shortcut handlers should read `navItems[n]` after `navForRole()` so lead generators do not inherit closer shortcuts.
- Command palette quick actions must not show "Create opportunity" to `lead_generator`.
- Breadcrumbs are display only; route authorization still lives in page wrappers.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/page.tsx` | Modify | Role-specific landing redirects |
| `app/workspace/_components/workspace-shell-client.tsx` | Modify | Lead Gen nav/home/shortcut behavior |
| `components/command-palette.tsx` | Modify | Lead Gen pages and action filtering |
| `components/workspace-breadcrumbs.tsx` | Modify | Lead Gen labels |

---

### 1F — Admin Invite, Role Edit, and Configuration UI

**Type:** Frontend  
**Parallelizable:** Yes — depends on 1B, 1C, and 1D function contracts; can run while route-shell polish finishes.

**What:** Expose Lead Generator in team invite/role-edit dialogs and add the admin configuration shell for workers, teams, schedules, and rules.

**Why:** Admins need a safe desktop-first setup flow before workers capture prospects. The UI must make the Calendly requirement role-specific and prevent accidental owner/closer coupling.

**Where:**
- `app/workspace/team/_components/invite-user-dialog.tsx` (modify)
- `app/workspace/team/_components/role-edit-dialog.tsx` (modify)
- `app/workspace/lead-gen/settings/page.tsx` (new)
- `app/workspace/lead-gen/_components/lead-gen-settings-page-client.tsx` (new)
- `app/workspace/lead-gen/_components/lead-gen-settings-skeleton.tsx` (new)

**How:**

**Step 1: Update invite form schema.**

```tsx
// Path: app/workspace/team/_components/invite-user-dialog.tsx
const inviteUserSchema = z
  .object({
    email: z
      .string()
      .min(1, "Email is required")
      .email("Please enter a valid email address"),
    firstName: z.string().min(1, "First name is required"),
    lastName: z.string().optional(),
    role: z.enum(["closer", "tenant_admin", "lead_generator"]),
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
```

**Step 2: Add Lead Generator role option and clear Calendly assignment outside closer.**

```tsx
// Path: app/workspace/team/_components/invite-user-dialog.tsx
<SelectContent>
  <SelectItem value="closer">Closer</SelectItem>
  <SelectItem value="lead_generator">Lead Generator</SelectItem>
  <SelectItem value="tenant_admin">Admin</SelectItem>
</SelectContent>
```

```tsx
// Path: app/workspace/team/_components/invite-user-dialog.tsx
await inviteUser({
  email: values.email,
  firstName: values.firstName,
  lastName: values.lastName || undefined,
  role: values.role,
  calendlyMemberId:
    values.role === "closer"
      ? (values.calendlyMemberId as Id<"calendlyOrgMembers">)
      : undefined,
});
```

**Step 3: Update role edit dialog.**

```tsx
// Path: app/workspace/team/_components/role-edit-dialog.tsx
const roleEditSchema = z.object({
  role: z.enum(["closer", "tenant_admin", "lead_generator"]),
});

type CrmRole = "tenant_admin" | "closer" | "lead_generator";

const roleOptions: Array<{ value: CrmRole; label: string }> = [
  { value: "closer", label: "Closer" },
  { value: "lead_generator", label: "Lead Generator" },
  { value: "tenant_admin", label: "Admin" },
];
```

**Step 4: Add settings page wrapper.**

```tsx
// Path: app/workspace/lead-gen/settings/page.tsx
import { Suspense } from "react";
import { requirePermission } from "@/lib/auth";
import { LeadGenSettingsPageClient } from "../_components/lead-gen-settings-page-client";
import { LeadGenSettingsSkeleton } from "../_components/lead-gen-settings-skeleton";

export const unstable_instant = false;

export default async function LeadGenSettingsPage() {
  await requirePermission("lead-gen:manage-workers");

  return (
    <Suspense fallback={<LeadGenSettingsSkeleton />}>
      <LeadGenSettingsPageClient />
    </Suspense>
  );
}
```

**Step 5: Compose the admin settings shell with existing primitives.**

```tsx
// Path: app/workspace/lead-gen/_components/lead-gen-settings-page-client.tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function LeadGenSettingsPageClient() {
  const workers = useQuery(api.leadGen.workers.listWorkers, {
    includeInactive: true,
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal">
          Lead Gen Ops
        </h1>
        <p className="text-sm text-muted-foreground">
          Manage workers, teams, schedules, and capture rules.
        </p>
      </div>

      <Tabs defaultValue="workers">
        <TabsList>
          <TabsTrigger value="workers">Workers</TabsTrigger>
          <TabsTrigger value="teams">Teams</TabsTrigger>
          <TabsTrigger value="schedules">Schedules</TabsTrigger>
          <TabsTrigger value="rules">Rules</TabsTrigger>
        </TabsList>
        <TabsContent value="workers">
          <Card>
            <CardHeader>
              <CardTitle>Workers</CardTitle>
            </CardHeader>
            <CardContent>
              {workers === undefined ? (
                <Skeleton className="h-40 w-full" />
              ) : (
                <WorkerSettingsTable workers={workers} />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

**Key implementation notes:**
- Use React Hook Form + Zod v4 with `standardSchemaResolver`, matching existing dialogs.
- Do not ask admins to select a worker during capture. Worker identity is always auth-derived.
- Use shadcn `Tabs`, `Card`, `Table`, `Switch`, `Select`, `FieldGroup`, `Skeleton`, and `Badge`; avoid custom one-off controls.
- Keep the UI dense and operational: tables, tabs, controls, and clear row actions instead of a marketing-style layout.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/team/_components/invite-user-dialog.tsx` | Modify | Add Lead Generator role and conditional Calendly validation |
| `app/workspace/team/_components/role-edit-dialog.tsx` | Modify | Add Lead Generator role |
| `app/workspace/lead-gen/settings/page.tsx` | Create | Admin settings RSC wrapper |
| `app/workspace/lead-gen/_components/lead-gen-settings-page-client.tsx` | Create | Settings tabs shell |
| `app/workspace/lead-gen/_components/lead-gen-settings-skeleton.tsx` | Create | Route skeleton |

---

### 1G — Phase 1 Verification Gate

**Type:** QA / Integration  
**Parallelizable:** No — runs after all Phase 1 implementation is complete.

**What:** Verify schema generation, role mapping, WorkOS invite/role flows, route fallbacks, and UI role visibility before worker capture starts.

**Why:** Phase 1 is the feature's safety foundation. A mistake here can expose CRM routes or make invited workers unable to sign in.

**Where:**
- `plans/lead-gen-ops/phases/phase0-qa-matrix.md` (read)
- Local browser for `/workspace`, `/workspace/team`, and `/workspace/lead-gen/settings`

**How:**

**Step 1: Run automated checks.**

```bash
# Path: terminal
npx convex dev --once
pnpm tsc --noEmit
pnpm lint
```

**Step 2: Run targeted role checks in development.**

```bash
# Path: terminal
rg "lead_generator|lead-generator|lead-gen" convex lib app components
rg "isAdmin \\? .*: closer|isAdmin \\? .*closer|role === \"closer\"" app components lib
```

**Step 3: Manual QA role behavior.**

```markdown
<!-- Path: plans/lead-gen-ops/phases/phase0-qa-matrix.md -->

- Sign in as admin: `/workspace` shows admin dashboard and Lead Gen settings are reachable.
- Sign in as closer: `/workspace` redirects to `/workspace/closer`; Lead Gen admin settings redirect away.
- Sign in as lead generator: `/workspace` redirects to `/workspace/lead-gen/capture`.
- Open command palette as lead generator: only Capture and My Activity page actions are available.
- Invite lead generator: no Calendly member required; worker profile exists.
- Change lead generator to closer: worker profile is inactive; closer Calendly validation still applies where required.
```

**Key implementation notes:**
- If `npx convex dev --once` regenerates `_generated` files, include them in the implementation commit if this repo tracks generated files.
- Do not invite production lead generators until direct URL probes have been manually verified.
- Role changes may require sign-out/sign-in for WorkOS session claims; server-side CRM role checks should still update after `router.refresh()`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| No production code | Verify | Automated and manual Phase 1 gate |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/leadGen/validators.ts` | Create | 1A |
| `convex/schema.ts` | Modify | 1A |
| `convex/lib/roleMapping.ts` | Modify | 1B |
| `convex/lib/permissions.ts` | Modify | 1B |
| `lib/auth.ts` | Modify | 1B |
| `convex/leadGen/workers.ts` | Create | 1C, 1D |
| `convex/leadGen/settings.ts` | Create | 1D |
| `convex/workos/userManagement.ts` | Modify | 1C |
| `convex/workos/userMutations.ts` | Modify | 1C |
| `app/workspace/page.tsx` | Modify | 1E |
| `app/workspace/_components/workspace-shell-client.tsx` | Modify | 1E |
| `components/command-palette.tsx` | Modify | 1E |
| `components/workspace-breadcrumbs.tsx` | Modify | 1E |
| `app/workspace/team/_components/invite-user-dialog.tsx` | Modify | 1F |
| `app/workspace/team/_components/role-edit-dialog.tsx` | Modify | 1F |
| `app/workspace/lead-gen/settings/page.tsx` | Create | 1F |
| `app/workspace/lead-gen/_components/lead-gen-settings-page-client.tsx` | Create | 1F |
| `app/workspace/lead-gen/_components/lead-gen-settings-skeleton.tsx` | Create | 1F |
