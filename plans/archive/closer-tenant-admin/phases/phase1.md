# Phase 1 — Schema Extensions, Auth Guards & Core Utilities

**Goal:** Establish the foundational layer that all subsequent phases depend on: extend the Convex schema with 6 new tables, create the tenant-user authorization guard, build user lookup queries, define the opportunity status state machine, and scaffold the workspace layout shell with role-based routing.

**Prerequisite:** System Admin & Tenant Onboarding flow (Phases 1–6) is complete. The existing schema has `tenants`, `users`, `rawWebhookEvents`, and `calendlyOrgMembers` tables. WorkOS SDK is installed. Env vars are set. Calendly OAuth, webhooks, and cron jobs are operational.

**Acceptance Criteria:**
1. `npx convex dev` deploys the schema without errors — all 10 tables visible in the Convex dashboard.
2. `pnpm tsc --noEmit` passes with new table types available in `convex/_generated/dataModel`.
3. `requireTenantUser(ctx, ["tenant_master"])` correctly resolves a tenant user from a valid JWT.
4. `getCurrentUser` query returns the correct user record for an authenticated session.
5. `validateTransition("scheduled", "in_progress")` returns `true`; `validateTransition("lost", "in_progress")` returns `false`.
6. Navigating to `/workspace` renders the layout shell with role-appropriate sidebar navigation.
7. All new indexes follow the Convex naming convention (`by_<field1>_and_<field2>`).

---

## Subphases

### 1A — Schema Extension: New Tables & Modified `tenants`

**Type:** Backend
**Parallelizable:** No — must complete first. All other subphases depend on the generated types from this schema.

**What:** Add 6 new tables (`leads`, `opportunities`, `meetings`, `eventTypeConfigs`, `paymentRecords`, `followUps`) to the Convex schema. Modify the existing `tenants` table to add a `tenantOwnerId` field.

**Why:** Every subsequent phase imports types from `convex/_generated/dataModel`. Without these table definitions, TypeScript compilation fails and no Convex functions can reference the new tables.

**Where:** `convex/schema.ts`

**How:**

Modify the existing schema file. Keep all existing table definitions unchanged. Add the `tenantOwnerId` field to `tenants` and append the 6 new table definitions.

```typescript
// Add to the existing tenants table definition (inside defineTable):
tenantOwnerId: v.optional(v.id("users")),  // Set during onboarding when first user redeems invite

// NEW TABLE: leads
leads: defineTable({
  tenantId: v.id("tenants"),
  email: v.string(),
  fullName: v.optional(v.string()),
  phone: v.optional(v.string()),
  customFields: v.optional(v.any()),   // JSON from Calendly questions_and_answers
  firstSeenAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_tenantId", ["tenantId"])
  .index("by_tenantId_and_email", ["tenantId", "email"]),

// NEW TABLE: opportunities
opportunities: defineTable({
  tenantId: v.id("tenants"),
  leadId: v.id("leads"),
  assignedCloserId: v.optional(v.id("users")),
  eventTypeConfigId: v.optional(v.id("eventTypeConfigs")),
  status: v.union(
    v.literal("scheduled"),
    v.literal("in_progress"),
    v.literal("payment_received"),
    v.literal("follow_up_scheduled"),
    v.literal("lost"),
    v.literal("canceled"),
    v.literal("no_show"),
  ),
  calendlyEventUri: v.optional(v.string()),
  cancellationReason: v.optional(v.string()),
  canceledBy: v.optional(v.string()),
  lostReason: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_tenantId", ["tenantId"])
  .index("by_tenantId_and_leadId", ["tenantId", "leadId"])
  .index("by_tenantId_and_assignedCloserId", ["tenantId", "assignedCloserId"])
  .index("by_tenantId_and_status", ["tenantId", "status"]),

// NEW TABLE: meetings
meetings: defineTable({
  tenantId: v.id("tenants"),
  opportunityId: v.id("opportunities"),
  calendlyEventUri: v.string(),
  calendlyInviteeUri: v.string(),
  zoomJoinUrl: v.optional(v.string()),
  scheduledAt: v.number(),
  durationMinutes: v.number(),
  status: v.union(
    v.literal("scheduled"),
    v.literal("in_progress"),
    v.literal("completed"),
    v.literal("canceled"),
    v.literal("no_show"),
  ),
  notes: v.optional(v.string()),
  createdAt: v.number(),
})
  .index("by_opportunityId", ["opportunityId"])
  .index("by_tenantId_and_scheduledAt", ["tenantId", "scheduledAt"])
  .index("by_tenantId_and_calendlyEventUri", ["tenantId", "calendlyEventUri"]),

// NEW TABLE: eventTypeConfigs
eventTypeConfigs: defineTable({
  tenantId: v.id("tenants"),
  calendlyEventTypeUri: v.string(),
  displayName: v.string(),
  paymentLinks: v.optional(v.array(v.object({
    provider: v.string(),
    label: v.string(),
    url: v.string(),
  }))),
  roundRobinEnabled: v.boolean(),
  createdAt: v.number(),
})
  .index("by_tenantId", ["tenantId"])
  .index("by_tenantId_and_calendlyEventTypeUri", ["tenantId", "calendlyEventTypeUri"]),

// NEW TABLE: paymentRecords
paymentRecords: defineTable({
  tenantId: v.id("tenants"),
  opportunityId: v.id("opportunities"),
  meetingId: v.id("meetings"),
  closerId: v.id("users"),
  amount: v.number(),
  currency: v.string(),
  provider: v.string(),
  referenceCode: v.optional(v.string()),
  proofFileId: v.optional(v.id("_storage")),
  status: v.union(
    v.literal("recorded"),
    v.literal("verified"),
    v.literal("disputed"),
  ),
  recordedAt: v.number(),
})
  .index("by_opportunityId", ["opportunityId"])
  .index("by_tenantId", ["tenantId"])
  .index("by_tenantId_and_closerId", ["tenantId", "closerId"]),

// NEW TABLE: followUps
followUps: defineTable({
  tenantId: v.id("tenants"),
  opportunityId: v.id("opportunities"),
  leadId: v.id("leads"),
  closerId: v.id("users"),
  schedulingLinkUrl: v.optional(v.string()),
  calendlyEventUri: v.optional(v.string()),
  reason: v.union(
    v.literal("closer_initiated"),
    v.literal("cancellation_follow_up"),
    v.literal("no_show_follow_up"),
  ),
  status: v.union(
    v.literal("pending"),
    v.literal("booked"),
    v.literal("expired"),
  ),
  createdAt: v.number(),
})
  .index("by_tenantId", ["tenantId"])
  .index("by_opportunityId", ["opportunityId"])
  .index("by_tenantId_and_closerId", ["tenantId", "closerId"]),
```

**Key implementation notes:**
- All new tables include `tenantId` as the first field for consistent tenant scoping.
- Every index includes `tenantId` as the leading field to ensure queries are always tenant-isolated.
- `v.optional()` is used for fields not populated initially (e.g., `assignedCloserId` may be null until Calendly webhook resolves the host).
- `v.any()` is used for `customFields` to store arbitrary Calendly form responses without strict schema validation.
- `v.id("_storage")` references Convex file storage for payment proof uploads.
- Index names follow Convex convention: `by_<field1>_and_<field2>` for composite indexes.
- This app is not in production — no migration needed. Schema changes take effect immediately.

**Files touched:** `convex/schema.ts` (modify — add `tenantOwnerId` to tenants, add 6 new tables)

**Verification:**
```bash
npx convex dev          # Should deploy without schema errors
pnpm tsc --noEmit       # Should pass with new types available
```

---

### 1B — Tenant User Auth Guard: `requireTenantUser`

**Type:** Backend
**Parallelizable:** Yes — after 1A deploys. Independent of 1C, 1D, 1E.

**What:** Create a shared authorization helper that validates the caller is an authenticated tenant user with one of the specified roles, and returns their resolved `userId`, `tenantId`, `role`, and `workosUserId`.

**Why:** Every tenant-scoped query and mutation needs to: (1) verify authentication, (2) resolve the user's organization, (3) look up the CRM user record, (4) check role permissions. This helper centralizes that logic to avoid duplication and ensure consistent authorization across all phases.

**Where:** `convex/requireTenantUser.ts` (new file)

**How:**

```typescript
// convex/requireTenantUser.ts
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getIdentityOrgId } from "./lib/identity";

type TenantUserResult = {
  userId: Id<"users">;
  tenantId: Id<"tenants">;
  role: "tenant_master" | "tenant_admin" | "closer";
  workosUserId: string;
};

/**
 * Validates the caller is an authenticated user belonging to a tenant,
 * with one of the specified allowed roles.
 *
 * Usage:
 *   const { userId, tenantId, role } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
 *
 * Throws:
 *   - "Not authenticated" if no JWT identity
 *   - "No organization context" if JWT lacks org_id
 *   - "User not found" if no CRM user record (user hasn't been provisioned)
 *   - "Organization mismatch" if user's tenant doesn't match the JWT org
 *   - "Insufficient permissions" if user's role isn't in allowedRoles
 */
export async function requireTenantUser(
  ctx: QueryCtx | MutationCtx,
  allowedRoles: Array<"tenant_master" | "tenant_admin" | "closer">,
): Promise<TenantUserResult> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Not authenticated");
  }

  const orgId = getIdentityOrgId(identity);
  if (!orgId) {
    throw new Error("No organization context");
  }

  const workosUserId = identity.subject ?? identity.tokenIdentifier;

  // Find the CRM user record by WorkOS user ID
  const user = await ctx.db
    .query("users")
    .withIndex("by_workosUserId", (q) => q.eq("workosUserId", workosUserId))
    .unique();

  if (!user) {
    throw new Error("User not found — please complete setup");
  }

  // Verify the user's tenant matches the JWT organization
  const tenant = await ctx.db.get(user.tenantId);
  if (!tenant || tenant.workosOrgId !== orgId) {
    throw new Error("Organization mismatch");
  }

  // Check role authorization
  if (!allowedRoles.includes(user.role)) {
    throw new Error("Insufficient permissions");
  }

  return {
    userId: user._id,
    tenantId: user.tenantId,
    role: user.role,
    workosUserId,
  };
}
```

**Key implementation notes:**
- This file does NOT have `"use node"` — it exports a plain helper function, not a Convex function. It can be imported by any query or mutation.
- It relies on the existing `getIdentityOrgId` utility from `convex/lib/identity.ts` which extracts the org ID from WorkOS JWT claims.
- The `workosUserId` is extracted from `identity.subject` (standard WorkOS claim) with a fallback to `identity.tokenIdentifier`.
- The tenant validation step (`tenant.workosOrgId !== orgId`) ensures a user cannot access another tenant's data even if they somehow have a CRM record.
- This guard is used by **every** subsequent phase's queries and mutations.

**Files touched:** `convex/requireTenantUser.ts` (create)

---

### 1C — User Queries Module: `getCurrentUser` & `getById`

**Type:** Backend
**Parallelizable:** Yes — after 1A deploys. Independent of 1B, 1D, 1E.

**What:** Create the user queries module with two essential queries: `getCurrentUser` (public, resolves the authenticated user) and `getById` (internal, used by other backend functions).

**Why:** The workspace layout (1F) needs `getCurrentUser` to detect the user's role for routing. All subsequent phases need user lookup capabilities. These queries are foundational.

**Where:** `convex/users/queries.ts` (new file — Phase 2 will add more queries to this file)

**How:**

```typescript
// convex/users/queries.ts
import { v } from "convex/values";
import { query, internalQuery } from "../_generated/server";

/**
 * Get the currently authenticated user's CRM record.
 *
 * Called by the workspace layout to determine role-based routing.
 * Returns null if the user has no CRM record (e.g., system admin,
 * or user who hasn't been provisioned yet).
 *
 * This is a PUBLIC query — callable from client code.
 */
export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const workosUserId = identity.subject ?? identity.tokenIdentifier;

    return await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", workosUserId))
      .unique();
  },
});

/**
 * Internal: Get a user by their Convex document ID.
 * Used by other backend functions (actions, mutations) that need user data.
 */
export const getById = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    return await ctx.db.get(userId);
  },
});

/**
 * Internal: Get the current user from a WorkOS user ID.
 * Used by actions that need to resolve the caller's CRM record.
 */
export const getCurrentUserInternal = internalQuery({
  args: { workosUserId: v.string() },
  handler: async (ctx, { workosUserId }) => {
    return await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", workosUserId))
      .unique();
  },
});
```

**Key implementation notes:**
- `getCurrentUser` is a **public** query (exported via `query`, not `internalQuery`). This allows the frontend to call it directly via `useQuery(api.users.queries.getCurrentUser)`.
- `getCurrentUser` returns `null` (not an error) when no user is found. This is intentional — system admins and unprovisioned users have no CRM record.
- `getById` and `getCurrentUserInternal` are internal queries — only callable from other Convex functions, not from client code.
- Phase 2 will add `listTeamMembers` and `listUnmatchedCalendlyMembers` to this same file.

**Files touched:** `convex/users/queries.ts` (create)

---

### 1D — Opportunity Status Transition Validation Utility

**Type:** Backend
**Parallelizable:** Yes — after 1A deploys. Independent of 1B, 1C, 1E.

**What:** Create a utility module that defines the valid state transitions for the opportunity status state machine and provides a `validateTransition` function.

**Why:** The opportunity lifecycle has strict state transitions (e.g., `scheduled` → `in_progress` is valid, but `lost` → `in_progress` is not). Multiple phases (3, 5, 6, 7) need to enforce these transitions consistently. Centralizing the logic prevents bugs from incorrect state changes.

**Where:** `convex/lib/statusTransitions.ts` (new file)

**How:**

```typescript
// convex/lib/statusTransitions.ts

/**
 * Valid state transitions for the opportunity status state machine.
 *
 * State diagram:
 *   [*] → scheduled (invitee.created webhook)
 *   scheduled → in_progress (Closer starts meeting)
 *   scheduled → canceled (invitee.canceled webhook)
 *   scheduled → no_show (invitee_no_show.created webhook)
 *   in_progress → payment_received (Closer logs payment)
 *   in_progress → follow_up_scheduled (Closer schedules follow-up)
 *   in_progress → lost (Closer marks as lost)
 *   canceled → follow_up_scheduled (Closer initiates follow-up)
 *   no_show → follow_up_scheduled (Closer initiates follow-up)
 *   follow_up_scheduled → scheduled (New meeting booked via webhook)
 *   payment_received → (terminal)
 *   lost → (terminal)
 */
export const VALID_TRANSITIONS: Record<string, string[]> = {
  scheduled: ["in_progress", "canceled", "no_show"],
  in_progress: ["payment_received", "follow_up_scheduled", "lost"],
  canceled: ["follow_up_scheduled"],
  no_show: ["follow_up_scheduled"],
  follow_up_scheduled: ["scheduled"],
  payment_received: [], // Terminal state
  lost: [],             // Terminal state
};

/**
 * Validates whether a status transition is allowed.
 *
 * @param from - Current opportunity status
 * @param to - Desired new status
 * @returns true if the transition is valid, false otherwise
 *
 * Usage:
 *   if (!validateTransition(opportunity.status, "in_progress")) {
 *     throw new Error(`Cannot transition from ${opportunity.status} to in_progress`);
 *   }
 */
export function validateTransition(from: string, to: string): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Meeting status values (separate from opportunity status).
 * Meetings have their own lifecycle that loosely mirrors opportunities.
 */
export const MEETING_STATUSES = [
  "scheduled",
  "in_progress",
  "completed",
  "canceled",
  "no_show",
] as const;

export type MeetingStatus = (typeof MEETING_STATUSES)[number];

/**
 * Opportunity status values.
 */
export const OPPORTUNITY_STATUSES = [
  "scheduled",
  "in_progress",
  "payment_received",
  "follow_up_scheduled",
  "lost",
  "canceled",
  "no_show",
] as const;

export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];
```

**Key implementation notes:**
- This is a pure utility module — no Convex functions, no `"use node"`. Importable everywhere.
- `VALID_TRANSITIONS` is a lookup map for O(1) transition validation.
- Terminal states (`payment_received`, `lost`) have empty arrays — no transitions out.
- The type exports (`MeetingStatus`, `OpportunityStatus`) provide type-safety for status values in other modules.
- Used by Phase 3 (pipeline processor), Phase 6 (meeting actions), and Phase 7 (payment/follow-up).

**Files touched:** `convex/lib/statusTransitions.ts` (create)

---

### 1E — Role Mapping Utility Functions

**Type:** Backend
**Parallelizable:** Yes — after 1A deploys. Independent of 1B, 1C, 1D.

**What:** Create utility functions to convert between CRM role values (`tenant_master`, `tenant_admin`, `closer`) and WorkOS role slugs (`owner`, `tenant-admin`, `closer`).

**Why:** The two systems use different role naming conventions. Phase 2 needs these mappings when creating users (CRM role → WorkOS slug for membership creation) and when syncing roles. Centralizing this avoids scattered inline mappings.

**Where:** `convex/lib/roleMapping.ts` (new file)

**How:**

```typescript
// convex/lib/roleMapping.ts

type CrmRole = "tenant_master" | "tenant_admin" | "closer";
type WorkosSlug = "owner" | "tenant-admin" | "closer";

/**
 * Convert a CRM user role to the corresponding WorkOS role slug.
 * Used when creating/updating WorkOS organization memberships.
 */
export function mapCrmRoleToWorkosSlug(crmRole: CrmRole): WorkosSlug {
  const mapping: Record<CrmRole, WorkosSlug> = {
    tenant_master: "owner",
    tenant_admin: "tenant-admin",
    closer: "closer",
  };
  return mapping[crmRole];
}

/**
 * Convert a WorkOS role slug to the corresponding CRM user role.
 * Used when interpreting WorkOS membership data.
 */
export function mapWorkosSlugToCrmRole(workosSlug: string): CrmRole {
  const mapping: Record<string, CrmRole> = {
    owner: "tenant_master",
    "tenant-admin": "tenant_admin",
    closer: "closer",
  };
  return mapping[workosSlug] ?? "closer"; // Default to least privilege
}

/**
 * All CRM roles that have admin-level access (can manage users, view all data).
 */
export const ADMIN_ROLES: CrmRole[] = ["tenant_master", "tenant_admin"];

/**
 * Check if a CRM role has admin-level access.
 */
export function isAdminRole(role: string): boolean {
  return ADMIN_ROLES.includes(role as CrmRole);
}
```

**Key implementation notes:**
- Pure utility module — no Convex functions, no `"use node"`.
- The `mapWorkosSlugToCrmRole` defaults to `"closer"` (least privilege) for unknown slugs.
- `ADMIN_ROLES` array and `isAdminRole` helper are used by frontend components to conditionally render admin-only UI elements.
- Phase 2 imports `mapCrmRoleToWorkosSlug` for user management actions.

**Files touched:** `convex/lib/roleMapping.ts` (create)

---

### 1F — Workspace Layout Shell & Role-Based Routing

**Type:** Frontend
**Parallelizable:** Depends on 1C (`getCurrentUser` query must exist).

**What:** Create the workspace layout component with a sidebar that conditionally renders navigation links based on the user's CRM role, and a workspace root page that redirects Closers to their dashboard.

**Why:** This layout is the structural foundation for all Phase 4 (admin) and Phase 5 (closer) UI pages. It must detect the user's role and render the appropriate navigation before any page content is built.

**Where:** `app/workspace/layout.tsx` (modify existing or create), `app/workspace/page.tsx` (modify existing)

**How:**

```typescript
// app/workspace/layout.tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { redirect } from "next/navigation";
import Link from "next/link";

// Skill references: Use shadcn for Sidebar, Navigation components.
// Follow vercel-composition-patterns for layout composition.
// Follow web-design-guidelines for accessibility (aria-labels, keyboard nav).

export default function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = useQuery(api.users.queries.getCurrentUser);

  // Loading state — query still in flight
  if (user === undefined) {
    return <WorkspaceLoadingShell />;
  }

  // No CRM user found — redirect to appropriate page
  if (user === null) {
    return <NotProvisionedScreen />;
  }

  const isAdmin = user.role === "tenant_master" || user.role === "tenant_admin";
  const isCloser = user.role === "closer";

  return (
    <div className="flex h-screen">
      {/* Sidebar Navigation */}
      <aside className="w-64 border-r bg-muted/40 p-4">
        <div className="mb-6">
          <p className="text-sm font-medium">{user.fullName ?? user.email}</p>
          <p className="text-xs text-muted-foreground capitalize">
            {user.role.replace("_", " ")}
          </p>
        </div>

        <nav className="space-y-1">
          {isAdmin && (
            <>
              <NavLink href="/workspace">Overview</NavLink>
              <NavLink href="/workspace/team">Team</NavLink>
              <NavLink href="/workspace/pipeline">Pipeline</NavLink>
              <NavLink href="/workspace/settings">Settings</NavLink>
            </>
          )}
          {isCloser && (
            <>
              <NavLink href="/workspace/closer">Dashboard</NavLink>
              <NavLink href="/workspace/closer/pipeline">My Pipeline</NavLink>
            </>
          )}
        </nav>
      </aside>

      {/* Main content area */}
      <main className="flex-1 overflow-auto p-6">
        {children}
      </main>
    </div>
  );
}

// Helper components (can be extracted to separate files in Phase 4/5)
function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="block rounded-md px-3 py-2 text-sm hover:bg-accent"
    >
      {children}
    </Link>
  );
}

function WorkspaceLoadingShell() {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="animate-pulse text-muted-foreground">Loading workspace...</div>
    </div>
  );
}

function NotProvisionedScreen() {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="text-center">
        <h2 className="text-lg font-semibold">Account Not Found</h2>
        <p className="text-muted-foreground mt-2">
          Your account has not been set up yet. Please contact your administrator.
        </p>
      </div>
    </div>
  );
}
```

```typescript
// app/workspace/page.tsx — Role-based redirect for workspace root
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { redirect } from "next/navigation";

export default function WorkspaceRoot() {
  const user = useQuery(api.users.queries.getCurrentUser);

  if (user === undefined) return null; // Loading
  if (user === null) return null; // Not provisioned — layout handles this

  // Closers get redirected to their dedicated dashboard
  if (user.role === "closer") {
    redirect("/workspace/closer");
  }

  // Owner/Admin see the admin dashboard (built in Phase 4)
  // Placeholder until Phase 4 builds the real content
  return (
    <div>
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <p className="text-muted-foreground mt-2">
        Welcome back, {user.fullName ?? user.email}.
        Admin dashboard content coming in Phase 4.
      </p>
    </div>
  );
}
```

**Key implementation notes:**
- `"use client"` is required because `useQuery` is a React hook that runs on the client.
- The layout queries `getCurrentUser` once — all child pages inherit the user context.
- `user === undefined` means the Convex query is still loading (show skeleton). `user === null` means no CRM record exists (show error screen).
- The sidebar navigation uses conditional rendering based on role. Closers see only their own routes; admins see the full admin navigation.
- This layout will be enhanced in Phase 4 (admin) and Phase 5 (closer) with polished components. For now, it provides the structural foundation.
- Follow `vercel-react-best-practices`: avoid unnecessary re-renders by keeping the query at the layout level.
- Follow `vercel-composition-patterns`: the layout is a compound component pattern — sidebar + main content area.
- Follow `web-design-guidelines`: use semantic HTML (`aside`, `nav`, `main`), proper heading hierarchy, sufficient color contrast.

**Files touched:** `app/workspace/layout.tsx` (modify/create), `app/workspace/page.tsx` (modify)

---

## Parallelization Summary

```
1A (Schema extension — MUST BE FIRST)
  │
  ├── After 1A deployed:
  │   ├── 1B (requireTenantUser auth guard)  ─────────┐
  │   ├── 1C (User queries module) ───────────────────┤
  │   ├── 1D (Status transition validation) ──────────┤
  │   └── 1E (Role mapping utilities) ────────────────┘
  │                                                    │
  │   All 4 subphases above run in PARALLEL            │
  │                                                    │
  └── 1F (Workspace layout shell) ─────────────────────┘
       Depends on 1C (getCurrentUser query)
```

**Execution order:** 1A → (1B + 1C + 1D + 1E in parallel) → 1F

**Estimated time:** 1–2 days (1A takes ~30 minutes, 1B–1E each ~1–2 hours, 1F ~2–3 hours)

---

## Files Modified/Created Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modified (add `tenantOwnerId` to tenants, add 6 new tables) | 1A |
| `convex/requireTenantUser.ts` | Created | 1B |
| `convex/users/queries.ts` | Created (`getCurrentUser`, `getById`, `getCurrentUserInternal`) | 1C |
| `convex/lib/statusTransitions.ts` | Created | 1D |
| `convex/lib/roleMapping.ts` | Created | 1E |
| `app/workspace/layout.tsx` | Modified/Created (workspace layout with role-based sidebar) | 1F |
| `app/workspace/page.tsx` | Modified (role-based redirect + placeholder admin content) | 1F |

---

*End of Phase 1. Next: Phase 2 (Tenant Owner Identification & WorkOS User Management) and Phase 3 (Webhook Event Processing Pipeline) — these two phases run in PARALLEL.*
