# Tenant Owner, Admin & Closer Dashboards — Design Specification

**Version:** 0.1 (MVP)
**Status:** Draft
**Scope:** Tenant owner identification & role provisioning → User management (WorkOS Widgets) → Webhook-driven user provisioning via AuthKit events → Calendly member matching → Tenant owner/admin dashboard → Closer pipeline dashboard → Webhook event routing & processing → Lead/Opportunity/Meeting lifecycle.
**Prerequisite:** Phases 1–6 of the System Admin & Tenant Onboarding flow are complete.

---

## Table of Contents

1. [Goals & Non-Goals](#1-goals--non-goals)
2. [Actors & Roles](#2-actors--roles)
3. [End-to-End Flow Overview](#3-end-to-end-flow-overview)
4. [Phase 1: Tenant Owner Identification & WorkOS Role Setup](#4-phase-1-tenant-owner-identification--workos-role-setup)
5. [Phase 2: User Management — WorkOS Widgets Integration](#5-phase-2-user-management--workos-widgets-integration)
6. [Phase 3: Webhook-Driven User Provisioning & Calendly Matching](#6-phase-3-webhook-driven-user-provisioning--calendly-matching)
7. [Phase 4: Tenant Owner / Admin Dashboard](#7-phase-4-tenant-owner--admin-dashboard)
8. [Phase 5: Webhook Event Processing Pipeline (Calendly)](#8-phase-5-webhook-event-processing-pipeline-calendly)
9. [Phase 6: Closer Dashboard — Pipeline & Calendar](#9-phase-6-closer-dashboard--pipeline--calendar)
10. [Phase 7: Meeting Detail Page & Outcome Actions](#10-phase-7-meeting-detail-page--outcome-actions)
11. [Phase 8: Payment Logging](#11-phase-8-payment-logging)
12. [Phase 9: Follow-Up Scheduling](#12-phase-9-follow-up-scheduling)
13. [Data Model — New & Modified Tables](#13-data-model--new--modified-tables)
14. [Convex Function Architecture](#14-convex-function-architecture)
15. [Routing & Authorization — Next.js App Router](#15-routing--authorization--nextjs-app-router)
16. [Security Considerations](#16-security-considerations)
17. [Error Handling & Edge Cases](#17-error-handling--edge-cases)
18. [Open Questions](#18-open-questions)
19. [Dependencies](#19-dependencies)
20. [Applicable Skills](#20-applicable-skills)

---

## 1. Goals & Non-Goals

### Goals

- The user who completed Calendly OAuth during onboarding is clearly identified as the **Tenant Owner** in both Convex and WorkOS.
- WorkOS RBAC roles (`owner`, `tenant-admin`, `closer`) **already exist** at the environment level with the correct permissions — particularly `widgets:users-table:manage` for the `owner` and `tenant-admin` roles. No setup step is needed.
- The Tenant Owner can manage users (invite, edit roles, remove) via the **WorkOS User Management Widget** embedded in the CRM.
- Tenant Admins have near-identical capabilities to the Tenant Owner, including Calendly token refresh.
- When a Tenant Owner/Admin invites a new user via the WorkOS User Management Widget, the CRM **immediately provisions** the user record in Convex via the `user.created` WorkOS webhook event — **before the user ever signs up or logs in**. Role mapping, org membership resolution, and Calendly member matching all happen at invite time, not at first login.
- Closer users **must be matched** to a Calendly organization member before their pipeline becomes operational. Email matching is attempted automatically at provisioning time but will not always succeed — manual matching via the admin UI is the fallback.
- The Tenant Owner and Tenant Admin share an **identical dashboard** (to be separated in a future phase).
- The Closer receives a **comprehensive operational dashboard**: calendar view, pipeline summary, featured next meeting, meeting detail page, payment logging, follow-up scheduling, and outcome actions.
- Raw webhook events (`invitee.created`, `invitee.canceled`, `invitee_no_show`) are processed through a pipeline that creates/updates Leads, Opportunities, and Meetings — with correct Closer assignment via Calendly `event_memberships`.
- All data remains fully tenant-scoped; all queries enforce `tenantId` isolation.

### Non-Goals (deferred)

- Separating Tenant Owner and Tenant Admin dashboards with distinct permissions (Phase 2).
- Advanced analytics and reporting for Tenant Admins (Phase 2).
- Automated email/SMS notifications to leads or closers (Phase 2).
- Mobile-first Closer app (Phase 3).
- SSO / Directory Sync configuration per tenant (Phase 2).
- Outbound lead communication (Phase 2).
- Stripe/PayPal payment link integration — MVP uses manual payment logging with proof upload.

---

## 2. Actors & Roles

| Actor | Identity | WorkOS Role Slug | Key Permissions | How they authenticate |
|---|---|---|---|---|
| **System Admin** | Us (developers / operators) | N/A (system admin org) | Full system access | WorkOS AuthKit, member of system admin org `org_01KN2GSWBZAQWJ2CBRAZ6CSVBP` |
| **Tenant Owner** | The customer who onboarded (completed Calendly OAuth) | `owner` | Full tenant access, user management (`widgets:users-table:manage`), Calendly re-auth | WorkOS AuthKit, member of their tenant's WorkOS org |
| **Tenant Admin** | Operational administrator added by the Owner | `tenant-admin` | Near-full tenant access, Calendly token refresh, user management | WorkOS AuthKit, same tenant org |
| **Closer** | Frontline sales operator added by Owner/Admin | `closer` | Own pipeline view, calendar, meeting execution, outcome logging, payment capture | WorkOS AuthKit, same tenant org |

### CRM Role ↔ WorkOS Role Slug Mapping

| CRM `users.role` value | WorkOS Role Slug | WorkOS Permissions |
|---|---|---|
| `tenant_master` | `owner` | `widgets:users-table:manage` |
| `tenant_admin` | `tenant-admin` | `widgets:users-table:manage` |
| `closer` | `closer` | _(none — no widget access)_ |

> **Important:** We check **permissions** (e.g., `role.permissions.includes('widgets:users-table:manage')`) rather than role slugs for authorization decisions per WorkOS RBAC best practices. Role slugs are used only for assignment.

---

## 3. End-to-End Flow Overview

```mermaid
sequenceDiagram
    participant SA as System Admin
    participant CVX as Convex Backend
    participant WOS as WorkOS API
    participant TO as Tenant Owner (Browser)
    participant TA as Tenant Admin (Browser)
    participant CL as Closer (Browser)
    participant CAL as Calendly API

    Note over SA,CVX: Pre-existing: Phases 1–6 Complete
    Note over TO,CVX: Phase 1 — Owner Identification
    CVX->>CVX: Mark onboarding user as tenant owner<br/>(tenantOwnerId on tenant record)
    CVX->>WOS: Assign "owner" role to membership

    Note over TO,WOS: Phase 2 — RBAC Setup (one-time)
    SA->>WOS: Create environment roles:<br/>owner, tenant-admin, closer
    SA->>WOS: Create permission:<br/>widgets:users-table:manage
    SA->>WOS: Assign permission to<br/>owner & tenant-admin roles

    Note over TO,CVX: Phase 3 — User Management
    TO->>CVX: Request widget token<br/>(scope: widgets:users-table:manage)
    CVX->>WOS: workos.widgets.getToken(...)
    WOS-->>CVX: Widget access token
    CVX-->>TO: Token for User Management Widget
    TO->>WOS: Widget renders members table<br/>Invite user, assign role, remove

    Note over TO,CVX: Phase 4 — Closer Creation & Matching
    TO->>WOS: Invite new user with role "closer"
    WOS-->>CL: Signup email
    CL->>WOS: Completes signup
    CL->>CVX: First auth → create user record<br/>(role: closer)
    CVX->>CVX: Match by email against<br/>calendlyOrgMembers
    CVX->>CVX: Set calendlyUserUri on user<br/>if match found

    Note over CVX,CAL: Phase 6 — Event Processing Pipeline
    CAL-->>CVX: invitee.created webhook
    CVX->>CVX: Upsert Lead (by email)
    CVX->>CVX: Create Opportunity (status: Scheduled)
    CVX->>CVX: Resolve Closer from<br/>event_memberships[].user URI
    CVX->>CVX: Create Meeting record

    Note over CL,CVX: Phases 7–10 — Closer Dashboard
    CL->>CVX: Load dashboard (real-time)
    CVX-->>CL: Calendar, pipeline, featured event
    CL->>CVX: Open meeting detail
    CVX-->>CL: Lead info, notes, payment links
    CL->>CVX: Log outcome (payment/follow-up/lost)
    CVX->>CVX: Update Opportunity status
```

---

## 4. Phase 1: Tenant Owner Identification & WorkOS Role Setup

### 4.1 Identifying the Tenant Owner

The tenant owner is the user who completed the Calendly OAuth flow during onboarding. We need to reliably identify this user.

**Strategy: `tenantOwnerId` field on the `tenants` table.**

We add a `tenantOwnerId` field to the `tenants` table pointing to the `users` document of the owner. This is set during the existing `redeemInviteAndCreateUser` mutation (Phase 3 of the system admin flow).

> **Why `tenantOwnerId` on `tenants` rather than an `isOwner` flag on `users`?**
> - A tenant has exactly one owner — this is a 1:1 relationship best modeled on the tenant.
> - Avoids the need to scan all users to find the owner.
> - The `users.role` field already carries `"tenant_master"` which semantically represents the owner, but a direct reference is more efficient for lookups.
> - Both are maintained: `tenantOwnerId` for fast lookup, `role: "tenant_master"` for authorization checks.

### 4.2 Schema Change: `tenants` Table

```typescript
// Add to tenants table definition:
tenantOwnerId: v.optional(v.id("users")),  // Set during onboarding
```

`v.optional` because the field doesn't exist when the tenant record is first created (status: `pending_signup`). It's set when the first user redeems the invite.

### 4.3 Modification to `redeemInviteAndCreateUser`

The existing mutation in `convex/onboarding/complete.ts` creates the first user with `role: "tenant_master"`. We modify it to also:

1. Store the new user's `_id` as `tenantOwnerId` on the tenant record.
2. Trigger a Convex action to assign the `owner` WorkOS role to the user's organization membership.

```typescript
// In redeemInviteAndCreateUser handler, after inserting the user:
const userId = await ctx.db.insert("users", {
  tenantId: tenant._id,
  workosUserId,
  email: identity.email ?? tenant.contactEmail,
  fullName: identity.name ?? undefined,
  role: "tenant_master",
});

// Set tenant owner reference
await ctx.db.patch(tenant._id, {
  tenantOwnerId: userId,
  inviteRedeemedAt: Date.now(),
  status: "pending_calendly",
});
```

### 4.4 WorkOS Role Assignment for the Owner

After the user record is created, we need to assign the `owner` role in WorkOS. This requires:

1. Finding the user's **membership ID** in the WorkOS organization (not the user ID — per WorkOS RBAC gotchas).
2. Calling `workos.userManagement.updateOrganizationMembership()` with `roleSlug: "owner"`.

This runs as a **Convex action** (requires `@workos-inc/node` SDK, which needs Node.js runtime):

```typescript
// convex/workos/roles.ts
"use node";

import { WorkOS } from "@workos-inc/node";
import { internalAction } from "../_generated/server";
import { v } from "convex/values";

const workos = new WorkOS(process.env.WORKOS_API_KEY!, {
  clientId: process.env.WORKOS_CLIENT_ID!,
});

export const assignRoleToMembership = internalAction({
  args: {
    workosUserId: v.string(),
    workosOrgId: v.string(),
    roleSlug: v.string(),
  },
  handler: async (_ctx, { workosUserId, workosOrgId, roleSlug }) => {
    // Step 1: Find the membership
    const memberships = await workos.userManagement.listOrganizationMemberships({
      userId: workosUserId,
      organizationId: workosOrgId,
    });

    const membership = memberships.data[0];
    if (!membership) {
      throw new Error(`No membership found for user ${workosUserId} in org ${workosOrgId}`);
    }

    // Step 2: Assign the role
    await workos.userManagement.updateOrganizationMembership(membership.id, {
      roleSlug,
    });
  },
});
```

> **Timing:** Role assignment happens asynchronously after `redeemInviteAndCreateUser` completes. Since the user is already authenticated and won't need widget access until they navigate to the user management page, this slight delay is acceptable. The role takes effect on the user's **next session** — which is typically a page refresh or re-login.

### 4.5 Retroactive Fix for Existing Tenants

For tenants onboarded before this change:

1. A one-time migration script queries all tenants with `status: "active"` and no `tenantOwnerId`.
2. For each, it finds the `users` record with `role: "tenant_master"` and `tenantId` matching.
3. Sets `tenantOwnerId` on the tenant.
4. Assigns the `owner` WorkOS role via the same action.

This is a **Convex migration** following the widen-migrate-narrow pattern (see **Skills: `convex-migration-helper`**).

---

## 5. Phase 2: WorkOS RBAC — Role & Permission Provisioning

### 5.1 Environment-Level Roles (One-Time Setup)

WorkOS roles are created at the **environment level** (not per-organization) so they apply across all tenants. This is a one-time setup done via the WorkOS Dashboard or API.

> **Warning from WorkOS RBAC gotchas:** Creating the first **org-level** role permanently isolates that org from inheriting environment-level role changes. We **must not** create org-level roles. All roles are environment-level.

#### Roles to Create

| Role Name | Slug | Description |
|---|---|---|
| Owner | `owner` | Tenant owner — full access including user management and Calendly re-auth |
| Tenant Admin | `tenant-admin` | Operational admin — near-full access, user management, Calendly token refresh |
| Closer | `closer` | Sales operator — own pipeline, meetings, payment logging |

#### Permission to Create

| Permission Name | Slug | Description |
|---|---|---|
| Manage Users Table Widget | `widgets:users-table:manage` | Required by WorkOS to generate User Management widget tokens |

#### Role-Permission Assignments

| Role | Permissions |
|---|---|
| `owner` | `widgets:users-table:manage` |
| `tenant-admin` | `widgets:users-table:manage` |
| `closer` | _(none)_ |

### 5.2 Provisioning via WorkOS Node SDK

This can be done from a one-time setup script or via the WorkOS Dashboard:

```typescript
// One-time setup script (run once, not part of the CRM runtime)
import { WorkOS } from "@workos-inc/node";

const workos = new WorkOS(process.env.WORKOS_API_KEY!, {
  clientId: process.env.WORKOS_CLIENT_ID!,
});

// Create the permission
const permission = await workos.roles.createPermission({
  slug: "widgets:users-table:manage",
  name: "Manage Users Table Widget",
  description: "Allows the user to manage org members via the User Management widget",
});

// Create the roles
const ownerRole = await workos.roles.createRole({
  slug: "owner",
  name: "Owner",
  description: "Tenant owner with full access",
});

const adminRole = await workos.roles.createRole({
  slug: "tenant-admin",
  name: "Tenant Admin",
  description: "Tenant admin with near-full access",
});

const closerRole = await workos.roles.createRole({
  slug: "closer",
  name: "Closer",
  description: "Sales operator with pipeline access",
});

// Assign permissions to roles
await workos.roles.addPermissionToRole(ownerRole.id, permission.id);
await workos.roles.addPermissionToRole(adminRole.id, permission.id);
```

### 5.3 Verifying Role Assignment on Login

When a user authenticates via WorkOS AuthKit, their JWT contains role and permission claims. The Next.js middleware or Convex auth layer can inspect these to determine the user's effective permissions.

For the MVP, we also maintain the `role` field on the Convex `users` table as the source of truth for CRM-level authorization. The WorkOS role is the source of truth for widget access and WorkOS-managed features.

### 5.4 Syncing WorkOS Role with CRM Role

When a user's role is changed via the User Management Widget:

1. WorkOS updates the membership role.
2. A **WorkOS webhook** (`organization_membership.updated`) fires.
3. Our webhook handler maps the new WorkOS role slug to the CRM role and updates the `users.role` field.

Alternatively, on each authenticated request, we resolve the user's current WorkOS role and update the CRM `users` record if it has drifted. The webhook approach is preferred for real-time consistency.

---

## 6. Phase 3: User Management — WorkOS Widgets Integration

### 6.1 Overview

The Tenant Owner (and Tenant Admin) can manage users within their organization via the **WorkOS User Management Widget**. This widget provides:

- Paginated members table (avatar, name, email, role, last active, status)
- Server-side search and role filtering
- Per-user actions: edit role, remove user
- Invite flow for adding new users

### 6.2 Widget Token Generation

The User Management Widget requires an `accessToken` generated via the WorkOS SDK with scope `widgets:users-table:manage`. The token is generated **server-side** in a Convex action (Node.js runtime):

```typescript
// convex/workos/widgetTokens.ts
"use node";

import { WorkOS } from "@workos-inc/node";
import { action } from "../_generated/server";
import { v } from "convex/values";

const workos = new WorkOS(process.env.WORKOS_API_KEY!, {
  clientId: process.env.WORKOS_CLIENT_ID!,
});

export const getUserManagementToken = action({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const orgId = getIdentityOrgId(identity);
    if (!orgId) {
      throw new Error("No organization context");
    }

    // Resolve CRM user to verify they have the right role
    const user = await ctx.runQuery(internal.users.getByWorkosUserId, {
      workosUserId: identity.subject,
    });

    if (!user || (user.role !== "tenant_master" && user.role !== "tenant_admin")) {
      throw new Error("Insufficient permissions for user management");
    }

    // Generate widget token
    const tokenResult = await workos.widgets.getToken({
      userId: identity.subject,
      organizationId: orgId,
      scopes: ["widgets:users-table:manage"],
    });

    return tokenResult;
  },
});
```

> **Token lifetime:** Widget tokens expire after **1 hour**. The frontend must refresh the token before expiry. The widget component should handle this via a callback or polling mechanism.

### 6.3 Next.js Page: User Management

```
app/workspace/team/page.tsx
```

This page:
1. Checks that the current user has `role: "tenant_master"` or `role: "tenant_admin"` (via Convex query).
2. Fetches a widget token from the Convex action.
3. Renders the User Management Widget using WorkOS Widget APIs (direct `fetch` calls to `/_widgets/UserManagement/*` endpoints).
4. Provides invite flow with role selection (Owner, Tenant Admin, Closer).

### 6.4 Widget API Endpoints Used

Per the WorkOS Widgets fetching-apis reference:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/_widgets/UserManagement/members` | List org members (paginated, searchable) |
| `POST` | `/_widgets/UserManagement/members/{userId}` | Update member (role change) |
| `DELETE` | `/_widgets/UserManagement/members/{userId}` | Remove member from org |
| `GET` | `/_widgets/UserManagement/roles` | List available roles |
| `GET` | `/_widgets/UserManagement/roles-and-config` | Get roles with widget config |
| `POST` | `/_widgets/UserManagement/invite-user` | Invite a new user to the org |
| `POST` | `/_widgets/UserManagement/invites/{userId}/resend` | Resend invite |
| `DELETE` | `/_widgets/UserManagement/invites/{userId}` | Revoke pending invite |

All calls are made from the **frontend** using the widget token as a Bearer token. The base URL is `process.env.WORKOS_BASE_API_URL` (fallback: `https://api.workos.com`).

### 6.5 Custom Role Selection on Invite

When inviting a new user, the Owner/Admin selects one of the three roles:

| Display Name | WorkOS Role Slug | CRM Behavior |
|---|---|---|
| Owner | `owner` | Same permissions as current owner (co-owner) |
| Admin | `tenant-admin` | Admin access, user management |
| Closer | `closer` | Pipeline-only access; must be matched to Calendly member |

The invite request body includes the `roleSlug`:

```typescript
POST /_widgets/UserManagement/invite-user
{
  "email": "closer@example.com",
  "roleSlug": "closer"
}
```

### 6.6 CRM User Record Creation on First Login

When an invited user first authenticates (via WorkOS AuthKit), they won't have a CRM `users` record yet. We need an **auto-provisioning** flow:

```mermaid
sequenceDiagram
    participant U as New User (Browser)
    participant NX as Next.js App
    participant CVX as Convex
    participant WOS as WorkOS

    U->>NX: First login after invite acceptance
    NX->>CVX: Query getCurrentUser()
    CVX-->>NX: null (no user record)
    NX->>CVX: Mutation: provisionUser()
    CVX->>CVX: Resolve tenantId from org_id
    CVX->>CVX: Check if user exists by workosUserId
    CVX->>CVX: Determine role from WorkOS membership
    Note over CVX: Must call WorkOS API to get<br/>membership role (action required)
    CVX->>CVX: Insert user record with<br/>correct role mapping
    CVX->>CVX: Attempt Calendly member<br/>email matching
    CVX-->>NX: User record created
    NX-->>U: Redirect to role-appropriate dashboard
```

**WorkOS role slug → CRM role mapping:**

```typescript
function mapWorkosRoleToCrmRole(roleSlug: string): "tenant_master" | "tenant_admin" | "closer" {
  switch (roleSlug) {
    case "owner": return "tenant_master";
    case "tenant-admin": return "tenant_admin";
    case "closer": return "closer";
    default: return "closer"; // Default to least privilege
  }
}
```

---

## 7. Phase 4: Closer User Creation & Calendly Member Matching

### 7.1 The Matching Requirement

Closer users **must** be matched to a Calendly organization member. Without this match, the system cannot:
- Route webhook events (meetings) to the correct Closer.
- Display the Closer's own meetings on their dashboard.
- Track round-robin assignments.

### 7.2 Matching Strategy

Matching happens at two points:

**Point 1: Automatic email match on user creation.**

When a new `users` record is created (via `provisionUser`), the system attempts to match by email against the `calendlyOrgMembers` table:

```typescript
// In provisionUser mutation:
const calendlyMember = await ctx.db
  .query("calendlyOrgMembers")
  .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
  .filter((q) => q.eq(q.field("email"), userEmail))
  .unique();

if (calendlyMember) {
  // Auto-match: set calendlyUserUri on the user
  await ctx.db.patch(userId, {
    calendlyUserUri: calendlyMember.calendlyUserUri,
  });
  // Also update the calendlyOrgMembers record
  await ctx.db.patch(calendlyMember._id, {
    matchedUserId: userId,
  });
}
```

**Point 2: Manual mapping via Admin UI.**

If automatic matching fails (e.g., different emails in Calendly and WorkOS), the Tenant Owner/Admin can manually map a CRM user to a Calendly org member from the team management page:

```mermaid
flowchart TD
    A[Team Management Page] --> B{Closer has<br/>calendlyUserUri?}
    B -->|Yes| C[✅ Matched<br/>Show Calendly name]
    B -->|No| D[⚠️ Unmatched<br/>Show warning + dropdown]
    D --> E[Admin selects from<br/>unmatched Calendly members]
    E --> F[Mutation: linkCloserToCalendlyMember]
    F --> G[Update user.calendlyUserUri<br/>Update calendlyOrgMembers.matchedUserId]
```

### 7.3 Unmatched Closer Behavior

An unmatched Closer can still log in, but their dashboard will show:

- A prominent banner: "Your account is not linked to a Calendly member. Please contact your admin."
- No meetings, no pipeline data.
- The admin's team page shows a warning badge next to unmatched Closers.

### 7.4 Calendly Member Sync Enhancement

The existing daily cron (`sync-calendly-org-members`) already syncs Calendly org members. We enhance it to:

1. After syncing members, re-attempt matching for any unmatched CRM users (closers with no `calendlyUserUri`).
2. Detect when a previously matched Calendly member is removed from the Calendly org and flag the CRM user.

### 7.5 Convex Functions for Matching

```typescript
// convex/users/linkCalendlyMember.ts
export const linkCloserToCalendlyMember = mutation({
  args: {
    userId: v.id("users"),
    calendlyMemberId: v.id("calendlyOrgMembers"),
  },
  handler: async (ctx, { userId, calendlyMemberId }) => {
    // Auth check: caller must be tenant_master or tenant_admin
    // Tenant scoping: verify both records belong to the same tenant
    const user = await ctx.db.get(userId);
    const member = await ctx.db.get(calendlyMemberId);

    if (!user || !member || user.tenantId !== member.tenantId) {
      throw new Error("Invalid user or member");
    }

    await ctx.db.patch(userId, {
      calendlyUserUri: member.calendlyUserUri,
    });
    await ctx.db.patch(calendlyMemberId, {
      matchedUserId: userId,
    });
  },
});
```

---

## 8. Phase 5: Tenant Owner / Admin Dashboard

### 8.1 Dashboard Layout

The Tenant Owner and Tenant Admin share an **identical dashboard** for MVP. It serves as the operational command center.

```
app/workspace/page.tsx  (enhanced — replaces current subsystem status page)
```

```mermaid
graph TD
    subgraph Owner/Admin Dashboard
        A[Header Bar<br/>Company name · User info · Role badge · Logout]
        B[Quick Stats Row<br/>Total Closers · Active Opps · Meetings Today · Revenue Logged]
        C[Navigation Tabs]
        C --> C1[Overview]
        C --> C2[Team]
        C --> C3[Pipeline]
        C --> C4[Settings]
    end
    C1 --> D[Pipeline Summary Cards<br/>Scheduled · In Progress · Follow-up · Won · Lost]
    C1 --> E[Recent Activity Feed<br/>Last 10 pipeline events]
    C1 --> F[System Health<br/>Calendly · Webhooks · Token status]
    C2 --> G[User Management Widget<br/>+ Calendly Matching Status]
    C3 --> H[All Opportunities Table<br/>Filterable by Closer, Status, Date]
    C4 --> I[Calendly Connection Status<br/>Reconnect button · Token health]
    C4 --> J[Event Type Configuration<br/>Payment links · Round robin settings]
```

### 8.2 Navigation Structure

| Route | Tab | Content |
|---|---|---|
| `/workspace` | Overview | Quick stats, pipeline summary, activity feed, system health |
| `/workspace/team` | Team | WorkOS User Management Widget + Calendly matching |
| `/workspace/pipeline` | Pipeline | All opportunities across all closers, filterable |
| `/workspace/settings` | Settings | Calendly connection, event type config |

### 8.3 Quick Stats Queries

```typescript
// convex/dashboard/adminStats.ts
export const getAdminDashboardStats = query({
  args: {},
  handler: async (ctx) => {
    // Resolve tenant from auth
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    const closers = await ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .filter((q) => q.eq(q.field("role"), "closer"))
      .collect();

    const opportunities = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .collect();

    const today = startOfDay(Date.now());
    const tomorrow = today + 86400000;
    const meetingsToday = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q.eq("tenantId", tenantId).gte("scheduledAt", today).lt("scheduledAt", tomorrow)
      )
      .collect();

    return {
      totalClosers: closers.length,
      unmatchedClosers: closers.filter(c => !c.calendlyUserUri).length,
      activeOpportunities: opportunities.filter(o =>
        ["scheduled", "in_progress", "follow_up_scheduled"].includes(o.status)
      ).length,
      meetingsToday: meetingsToday.length,
      totalRevenue: opportunities
        .filter(o => o.status === "payment_received")
        .length, // Full revenue calc requires paymentRecords join
    };
  },
});
```

### 8.4 Calendly Re-Authentication (Tenant Admin Capability)

Tenant Admins can trigger a Calendly token refresh from the Settings page. If the Calendly connection is lost (`status: "calendly_disconnected"`), both Owners and Admins can initiate re-authentication:

```mermaid
flowchart TD
    A[Settings Page] --> B{Calendly Status?}
    B -->|Active| C[Show: Connected ✅<br/>Last refresh time<br/>Token expires at]
    B -->|Disconnected| D[Show: Disconnected ⚠️<br/>Reconnect button]
    D --> E[Click Reconnect]
    E --> F[Initiate Calendly OAuth flow<br/>Same as onboarding Phase 4]
    F --> G[New tokens stored<br/>Webhooks re-provisioned]
    G --> H[Status → active]
    C --> I[Refresh Token button<br/>Manual proactive refresh]
    I --> J[Call refreshTenantToken action]
```

### 8.5 Event Type Configuration

The Settings tab includes an **Event Type Configuration** panel where Owners/Admins can:

1. View all Calendly event types synced from the org.
2. Associate **payment links** (external URLs) with each event type.
3. Enable/disable **round robin** tracking per event type.
4. Set a **display name** override for the CRM.

This data is stored in the `eventTypeConfigs` table (see [Data Model](#14-data-model--new--modified-tables)).

---

## 9. Phase 6: Webhook Event Processing Pipeline

### 9.1 Overview

Currently, raw webhook events are persisted to `rawWebhookEvents` with `processed: false`. This phase implements the **processing pipeline** that transforms raw events into domain entities (Leads, Opportunities, Meetings).

```mermaid
flowchart TD
    A[Raw webhook persisted<br/>processed: false] --> B[Pipeline Processor<br/>Convex action/mutation]
    B --> C{Event Type?}
    C -->|invitee.created| D[Invitee Created Flow]
    C -->|invitee.canceled| E[Cancellation Flow]
    C -->|invitee_no_show.created| F[No-Show Flow]
    C -->|invitee_no_show.deleted| G[No-Show Reversal Flow]
    C -->|routing_form_submission.created| H[Routing Form Flow]
    C -->|Other| I[Log & skip]

    D --> D1[Parse payload]
    D1 --> D2[Upsert Lead by email]
    D2 --> D3[Resolve Event Type Config]
    D3 --> D4[Resolve Closer from<br/>event_memberships]
    D4 --> D5[Create Opportunity<br/>status: scheduled]
    D5 --> D6[Create Meeting record<br/>with Zoom link]
    D6 --> D7[Mark raw event processed]

    E --> E1[Find Opportunity by<br/>calendly event URI]
    E1 --> E2[Update Opportunity<br/>status → canceled]
    E2 --> E3[Update Meeting<br/>status → canceled]
    E3 --> E4[Record cancellation details]

    F --> F1[Find Meeting by<br/>calendly event URI]
    F1 --> F2[Update Meeting<br/>status → no_show]
    F2 --> F3[Update Opportunity<br/>status → no_show]

    G --> G1[Find Meeting]
    G1 --> G2[Revert no_show status<br/>back to scheduled]
```

### 9.2 Pipeline Trigger

The pipeline processor is triggered via `ctx.scheduler.runAfter(0, ...)` immediately after persisting the raw event (already implemented in the webhook handler). The processor:

1. Reads the raw event.
2. Parses the JSON payload.
3. Dispatches to the appropriate flow based on `eventType`.
4. Marks the raw event as `processed: true` on success.

```typescript
// convex/pipeline/processor.ts
export const processRawEvent = internalAction({
  args: { rawEventId: v.id("rawWebhookEvents") },
  handler: async (ctx, { rawEventId }) => {
    const rawEvent = await ctx.runQuery(internal.pipeline.queries.getRawEvent, { rawEventId });
    if (!rawEvent || rawEvent.processed) return;

    const payload = JSON.parse(rawEvent.payload);

    switch (rawEvent.eventType) {
      case "invitee.created":
        await ctx.runMutation(internal.pipeline.inviteeCreated.process, {
          tenantId: rawEvent.tenantId,
          payload,
          rawEventId,
        });
        break;
      case "invitee.canceled":
        await ctx.runMutation(internal.pipeline.inviteeCanceled.process, {
          tenantId: rawEvent.tenantId,
          payload,
          rawEventId,
        });
        break;
      case "invitee_no_show.created":
        await ctx.runMutation(internal.pipeline.inviteeNoShow.process, {
          tenantId: rawEvent.tenantId,
          payload,
          rawEventId,
        });
        break;
      // ... other event types
    }
  },
});
```

### 9.3 `invitee.created` Flow — Core Pipeline

This is the primary pipeline entry point. It creates the full chain: Lead → Opportunity → Meeting.

```typescript
// convex/pipeline/inviteeCreated.ts

// Step 1: Extract key fields from payload
const inviteeEmail = payload.email;
const inviteeName = payload.name;
const inviteePhone = payload.text_reminder_number ?? null;
const scheduledEvent = payload.scheduled_event;
const eventTypeUri = scheduledEvent.event_type;
const eventMemberships = scheduledEvent.event_memberships; // [{ user, user_email, user_name }]
const scheduledAt = new Date(scheduledEvent.start_time).getTime();
const endTime = new Date(scheduledEvent.end_time).getTime();
const durationMinutes = Math.round((endTime - scheduledAt) / 60000);
const calendlyEventUri = scheduledEvent.uri;
const calendlyInviteeUri = payload.uri;

// Extract Zoom link from location if available
const zoomJoinUrl = scheduledEvent.location?.join_url ?? null;

// Step 2: Upsert Lead
let lead = await ctx.db
  .query("leads")
  .withIndex("by_tenantId_and_email", (q) =>
    q.eq("tenantId", tenantId).eq("email", inviteeEmail)
  )
  .unique();

if (!lead) {
  const leadId = await ctx.db.insert("leads", {
    tenantId,
    email: inviteeEmail,
    fullName: inviteeName,
    phone: inviteePhone,
    customFields: extractQuestionsAndAnswers(payload.questions_and_answers),
    firstSeenAt: Date.now(),
    updatedAt: Date.now(),
  });
  lead = await ctx.db.get(leadId);
} else {
  // Update existing lead with latest info
  await ctx.db.patch(lead._id, {
    fullName: inviteeName || lead.fullName,
    phone: inviteePhone || lead.phone,
    updatedAt: Date.now(),
  });
}

// Step 3: Resolve Closer from event_memberships
const assignedHost = eventMemberships[0]; // Primary assigned host
let closerId = null;

if (assignedHost) {
  const closerUser = await ctx.db
    .query("users")
    .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
      q.eq("tenantId", tenantId).eq("calendlyUserUri", assignedHost.user)
    )
    .unique();

  if (closerUser) {
    closerId = closerUser._id;
  }
}

// Fallback: assign to tenant owner if no closer matched
if (!closerId) {
  const tenant = await ctx.db.get(tenantId);
  closerId = tenant?.tenantOwnerId ?? null;
}

// Step 4: Resolve or create Event Type Config
let eventTypeConfigId = null;
if (eventTypeUri) {
  const config = await ctx.db
    .query("eventTypeConfigs")
    .withIndex("by_tenantId_and_calendlyEventTypeUri", (q) =>
      q.eq("tenantId", tenantId).eq("calendlyEventTypeUri", eventTypeUri)
    )
    .unique();

  if (config) {
    eventTypeConfigId = config._id;
  }
  // If no config exists, we create a placeholder to be configured later
}

// Step 5: Check for existing Opportunity (follow-up scenario)
// If a lead already has an active opportunity, this might be a follow-up
let existingOpp = await ctx.db
  .query("opportunities")
  .withIndex("by_tenantId_and_leadId", (q) =>
    q.eq("tenantId", tenantId).eq("leadId", lead!._id)
  )
  .filter((q) => q.eq(q.field("status"), "follow_up_scheduled"))
  .first();

let opportunityId;
if (existingOpp) {
  // This is a follow-up meeting — update existing opportunity
  opportunityId = existingOpp._id;
  await ctx.db.patch(opportunityId, {
    status: "scheduled",
    updatedAt: Date.now(),
  });
} else {
  // New opportunity
  opportunityId = await ctx.db.insert("opportunities", {
    tenantId,
    leadId: lead!._id,
    assignedCloserId: closerId,
    eventTypeConfigId,
    status: "scheduled",
    calendlyEventUri,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

// Step 6: Create Meeting record
await ctx.db.insert("meetings", {
  tenantId,
  opportunityId,
  calendlyEventUri,
  calendlyInviteeUri,
  zoomJoinUrl,
  scheduledAt,
  durationMinutes,
  status: "scheduled",
  notes: "",
  createdAt: Date.now(),
});

// Step 7: Mark raw event as processed
await ctx.db.patch(rawEventId, { processed: true });
```

### 9.4 `invitee.canceled` Flow

```typescript
// Find the meeting by calendlyEventUri (from payload.scheduled_event.uri)
const calendlyEventUri = payload.scheduled_event.uri;

const meeting = await ctx.db
  .query("meetings")
  .withIndex("by_tenantId_and_calendlyEventUri", (q) =>
    q.eq("tenantId", tenantId).eq("calendlyEventUri", calendlyEventUri)
  )
  .first();

if (meeting) {
  await ctx.db.patch(meeting._id, {
    status: "canceled",
  });

  // Update opportunity
  const opportunity = await ctx.db.get(meeting.opportunityId);
  if (opportunity && opportunity.status === "scheduled") {
    await ctx.db.patch(opportunity._id, {
      status: "canceled",
      cancellationReason: payload.cancellation?.reason ?? null,
      canceledBy: payload.cancellation?.canceler_type ?? null, // "invitee" or "host"
      updatedAt: Date.now(),
    });
  }
}

await ctx.db.patch(rawEventId, { processed: true });
```

### 9.5 `invitee_no_show.created` Flow

```typescript
const calendlyEventUri = payload.scheduled_event?.uri ?? payload.event;

const meeting = await ctx.db
  .query("meetings")
  .withIndex("by_tenantId_and_calendlyEventUri", (q) =>
    q.eq("tenantId", tenantId).eq("calendlyEventUri", calendlyEventUri)
  )
  .first();

if (meeting) {
  await ctx.db.patch(meeting._id, { status: "no_show" });

  const opportunity = await ctx.db.get(meeting.opportunityId);
  if (opportunity) {
    await ctx.db.patch(opportunity._id, {
      status: "no_show",
      updatedAt: Date.now(),
    });
  }
}

await ctx.db.patch(rawEventId, { processed: true });
```

### 9.6 Closer Assignment — Round Robin Resolution

When an `invitee.created` event arrives for a round-robin event type, the Calendly payload includes only the **assigned** host in `event_memberships`. The CRM resolves this host to a CRM user:

```mermaid
flowchart TD
    A[invitee.created payload] --> B[Extract event_memberships]
    B --> C["Get first membership's<br/>user URI (Calendly user)"]
    C --> D{Match users table by<br/>calendlyUserUri + tenantId}
    D -->|Match found| E[Assign opportunity<br/>to that Closer]
    D -->|No match| F{Match calendlyOrgMembers<br/>by URI + tenantId}
    F -->|Has matchedUserId| G[Use that user]
    F -->|No match| H[Fallback: assign to<br/>tenant owner]
    H --> I[Log warning:<br/>unmatched host URI]
    E --> J[Create opportunity<br/>with assignedCloserId]
    G --> J
    I --> J
```

---

## 10. Phase 7: Closer Dashboard — Pipeline & Calendar

### 10.1 Overview

The Closer Dashboard is the primary operational interface. It is scoped to show **only the Closer's own data** — their assigned meetings, opportunities, and pipeline.

```
app/workspace/closer/page.tsx
```

### 10.2 Dashboard Layout

```mermaid
graph TD
    subgraph Closer Dashboard
        A[Header Bar<br/>Name · Role: Closer · Company · Logout]
        B[Featured Event Card<br/>Next upcoming meeting<br/>Lead name · Time · Zoom link · Countdown]
        C[Calendar View<br/>Today default · Week · Month toggle]
        D[Pipeline Summary Strip<br/>Scheduled · In Progress · Follow-up · Won · Lost counts]
    end
    B --> E["Click → Meeting Detail Page"]
    C --> E
    D --> F["Click → Filtered Opportunity List"]
```

### 10.3 Featured Event Card

Displays the **next upcoming meeting** (soonest `scheduledAt` in the future with `status: "scheduled"`):

```typescript
// convex/closer/dashboard.ts
export const getNextMeeting = query({
  args: {},
  handler: async (ctx) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);
    const now = Date.now();

    // Get the closer's next scheduled meeting
    const opportunities = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId", (q) =>
        q.eq("tenantId", tenantId).eq("assignedCloserId", userId)
      )
      .filter((q) => q.eq(q.field("status"), "scheduled"))
      .collect();

    const oppIds = new Set(opportunities.map(o => o._id));

    const meetings = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q.eq("tenantId", tenantId).gte("scheduledAt", now)
      )
      .filter((q) =>
        q.and(
          q.eq(q.field("status"), "scheduled"),
        )
      )
      .take(50); // Get upcoming meetings

    // Filter to only this closer's meetings
    const myMeetings = meetings.filter(m => oppIds.has(m.opportunityId));

    if (myMeetings.length === 0) return null;

    const nextMeeting = myMeetings[0]; // Already sorted by scheduledAt (index)
    const opportunity = opportunities.find(o => o._id === nextMeeting.opportunityId);

    // Get lead info
    const lead = opportunity ? await ctx.db.get(opportunity.leadId) : null;

    return {
      meeting: nextMeeting,
      opportunity,
      lead,
    };
  },
});
```

**Featured Event Card contents:**
- Lead name and email
- Meeting time with countdown ("in 2 hours", "in 15 minutes", "NOW")
- Duration
- Zoom join link (prominent button)
- Event type name
- Quick-access: "View Details" button → Meeting Detail Page

### 10.4 Calendar View

A calendar component showing the Closer's meetings across Today / Week / Month views.

**Data source:** All meetings linked to opportunities assigned to this Closer.

```typescript
// convex/closer/calendar.ts
export const getMeetingsForRange = query({
  args: {
    startDate: v.number(), // Unix ms
    endDate: v.number(),
  },
  handler: async (ctx, { startDate, endDate }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    // Get this closer's opportunities
    const myOpps = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId", (q) =>
        q.eq("tenantId", tenantId).eq("assignedCloserId", userId)
      )
      .collect();

    const oppIds = new Set(myOpps.map(o => o._id));

    // Get meetings in the date range
    const meetings = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q.eq("tenantId", tenantId)
          .gte("scheduledAt", startDate)
          .lt("scheduledAt", endDate)
      )
      .collect();

    // Filter to this closer's meetings and enrich with lead data
    const myMeetings = meetings.filter(m => oppIds.has(m.opportunityId));

    const enriched = await Promise.all(
      myMeetings.map(async (meeting) => {
        const opp = myOpps.find(o => o._id === meeting.opportunityId);
        const lead = opp ? await ctx.db.get(opp.leadId) : null;
        return { meeting, opportunity: opp, lead };
      })
    );

    return enriched;
  },
});
```

**Calendar UI:**
- Uses a calendar grid component (build with shadcn/ui primitives or a lightweight library).
- Color-coded by meeting status:
  - 🟦 Scheduled (upcoming)
  - 🟨 In Progress
  - 🟩 Payment Received (won)
  - 🟥 Canceled / No Show
  - 🟪 Follow-up Scheduled
- Clicking a meeting slot navigates to the Meeting Detail Page.

### 10.5 Pipeline Summary Strip

A horizontal strip of pipeline stage cards showing counts:

```typescript
// convex/closer/pipeline.ts
export const getPipelineSummary = query({
  args: {},
  handler: async (ctx) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const myOpps = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId", (q) =>
        q.eq("tenantId", tenantId).eq("assignedCloserId", userId)
      )
      .collect();

    const counts = {
      scheduled: 0,
      in_progress: 0,
      follow_up_scheduled: 0,
      payment_received: 0,
      lost: 0,
      canceled: 0,
      no_show: 0,
    };

    for (const opp of myOpps) {
      if (opp.status in counts) {
        counts[opp.status as keyof typeof counts]++;
      }
    }

    return counts;
  },
});
```

### 10.6 Opportunity List (Pipeline View)

Clicking a pipeline stage card opens a filtered list of opportunities in that stage:

```
app/workspace/closer/pipeline/page.tsx?status=scheduled
```

This page shows a paginated table of opportunities with:
- Lead name and email
- Meeting date/time
- Status badge
- Time since created
- Quick actions (view details, mark outcome)

---

## 11. Phase 8: Meeting Detail Page & Outcome Actions

### 11.1 Route

```
app/workspace/closer/meetings/[meetingId]/page.tsx
```

### 11.2 Layout

```mermaid
flowchart TD
    A[Meeting Detail Page] --> B[Lead Info Panel<br/>Name · Email · Phone · Meeting History]
    A --> C[Meeting Info Panel<br/>Date · Duration · Zoom Link · Event Type · Status]
    A --> D[Meeting Notes<br/>Real-time editable text area<br/>Auto-saves via Convex mutation]
    A --> E[Payment Links Panel<br/>From Event Type Config<br/>Copyable URLs]
    A --> F[Outcome Actions Bar]
    F --> F1[💰 Log Payment]
    F --> F2[📅 Schedule Follow-up]
    F --> F3[❌ Mark as Lost]
    F --> F4[▶️ Start Meeting<br/>Opens Zoom + sets status: in_progress]
```

### 11.3 Lead Info Panel

Shows the lead's profile and history with this tenant:

```typescript
// convex/closer/meetingDetail.ts
export const getMeetingDetail = query({
  args: { meetingId: v.id("meetings") },
  handler: async (ctx, { meetingId }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer", "tenant_master", "tenant_admin"]);

    const meeting = await ctx.db.get(meetingId);
    if (!meeting || meeting.tenantId !== tenantId) {
      throw new Error("Meeting not found");
    }

    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (!opportunity) throw new Error("Opportunity not found");

    // For closers, verify they own this opportunity
    if (/* caller is closer */ true) {
      if (opportunity.assignedCloserId !== userId) {
        throw new Error("Not your meeting");
      }
    }

    const lead = await ctx.db.get(opportunity.leadId);

    // Get lead's full meeting history
    const leadOpps = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", opportunity.leadId)
      )
      .collect();

    const allMeetings = [];
    for (const opp of leadOpps) {
      const meetings = await ctx.db
        .query("meetings")
        .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opp._id))
        .collect();
      allMeetings.push(...meetings.map(m => ({ ...m, opportunityStatus: opp.status })));
    }

    // Get payment links from event type config
    let paymentLinks = null;
    if (opportunity.eventTypeConfigId) {
      const config = await ctx.db.get(opportunity.eventTypeConfigId);
      paymentLinks = config?.paymentLinks ?? null;
    }

    // Get payment records for this opportunity
    const payments = await ctx.db
      .query("paymentRecords")
      .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunity._id))
      .collect();

    return {
      meeting,
      opportunity,
      lead,
      meetingHistory: allMeetings,
      paymentLinks,
      payments,
    };
  },
});
```

### 11.4 Meeting Notes (Real-Time)

The notes field is a text area that auto-saves via debounced Convex mutations. Since Convex provides real-time subscriptions, changes are immediately reflected if the same meeting is viewed from another device.

```typescript
// convex/closer/meetingActions.ts
export const updateMeetingNotes = mutation({
  args: {
    meetingId: v.id("meetings"),
    notes: v.string(),
  },
  handler: async (ctx, { meetingId, notes }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer", "tenant_master", "tenant_admin"]);

    const meeting = await ctx.db.get(meetingId);
    if (!meeting || meeting.tenantId !== tenantId) {
      throw new Error("Meeting not found");
    }

    await ctx.db.patch(meetingId, { notes });
  },
});
```

### 11.5 "Start Meeting" Action

When the Closer clicks "Start Meeting" (or "Join Zoom"):

1. Opens the Zoom link in a new tab.
2. Updates the opportunity status to `in_progress`.
3. Updates the meeting status to `in_progress`.

```typescript
export const startMeeting = mutation({
  args: { meetingId: v.id("meetings") },
  handler: async (ctx, { meetingId }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const meeting = await ctx.db.get(meetingId);
    if (!meeting || meeting.tenantId !== tenantId) {
      throw new Error("Meeting not found");
    }

    await ctx.db.patch(meetingId, { status: "in_progress" });

    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (opportunity && opportunity.status === "scheduled") {
      await ctx.db.patch(opportunity._id, {
        status: "in_progress",
        updatedAt: Date.now(),
      });
    }

    return { zoomJoinUrl: meeting.zoomJoinUrl };
  },
});
```

### 11.6 "Mark as Lost" Action

```typescript
export const markAsLost = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, { opportunityId, notes }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    await ctx.db.patch(opportunityId, {
      status: "lost",
      lostReason: notes ?? null,
      updatedAt: Date.now(),
    });
  },
});
```

---

## 12. Phase 9: Payment Logging

### 12.1 Payment Flow

When a sale closes during a meeting, the Closer:

1. Shares a payment link from the Event Type Config's `paymentLinks` array.
2. The lead completes payment externally (Stripe, PayPal, etc.).
3. The Closer logs the payment in the CRM with proof.

```mermaid
flowchart TD
    A[Closer clicks Log Payment] --> B[Payment Form Modal]
    B --> C[Enter: Amount · Currency · Provider<br/>Reference Code · Upload Proof]
    C --> D{Validate}
    D -->|Valid| E[Create PaymentRecord<br/>via Convex mutation]
    E --> F[Update Opportunity<br/>status → payment_received]
    F --> G[Pipeline Complete ✅]
    D -->|Invalid| H[Show validation errors]
```

### 12.2 Payment Form Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `amount` | decimal (number) | Yes | Payment amount |
| `currency` | string | Yes | ISO 4217 code (default: "USD") |
| `provider` | string | Yes | "stripe", "paypal", "cash", "other" |
| `referenceCode` | string | No | Transaction ID from payment provider |
| `proofFileId` | Convex file ID | No | Uploaded screenshot/receipt |

### 12.3 Proof File Upload

Payment proof files are uploaded to **Convex file storage**:

```typescript
// convex/closer/payments.ts
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireTenantUser(ctx, ["closer", "tenant_master", "tenant_admin"]);
    return await ctx.storage.generateUploadUrl();
  },
});

export const logPayment = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.id("meetings"),
    amount: v.number(),
    currency: v.string(),
    provider: v.string(),
    referenceCode: v.optional(v.string()),
    proofFileId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const opportunity = await ctx.db.get(args.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    // Create payment record
    await ctx.db.insert("paymentRecords", {
      tenantId,
      opportunityId: args.opportunityId,
      meetingId: args.meetingId,
      closerId: userId,
      amount: args.amount,
      currency: args.currency,
      provider: args.provider,
      referenceCode: args.referenceCode ?? null,
      proofFileId: args.proofFileId ?? null,
      status: "recorded",
      recordedAt: Date.now(),
    });

    // Update opportunity status
    await ctx.db.patch(args.opportunityId, {
      status: "payment_received",
      updatedAt: Date.now(),
    });
  },
});
```

### 12.4 Proof File Access (Tenant-Scoped)

Payment proof files must be accessible only within the tenant. The serving URL is generated on-demand:

```typescript
export const getPaymentProofUrl = query({
  args: { paymentRecordId: v.id("paymentRecords") },
  handler: async (ctx, { paymentRecordId }) => {
    const { tenantId } = await requireTenantUser(ctx, ["closer", "tenant_master", "tenant_admin"]);

    const record = await ctx.db.get(paymentRecordId);
    if (!record || record.tenantId !== tenantId || !record.proofFileId) {
      return null;
    }

    return await ctx.storage.getUrl(record.proofFileId);
  },
});
```

---

## 13. Phase 10: Follow-Up Scheduling

### 13.1 Follow-Up Flow

When a meeting outcome is "follow-up needed," the Closer schedules a new meeting:

```mermaid
sequenceDiagram
    participant CL as Closer (CRM UI)
    participant CVX as Convex Backend
    participant CAL as Calendly API

    CL->>CVX: Request follow-up<br/>(opportunityId, eventTypeUri)
    CVX->>CAL: Create single-use scheduling link<br/>POST /scheduling_links
    CAL-->>CVX: Scheduling link URL
    CVX->>CVX: Create FollowUp record<br/>(status: pending)
    CVX-->>CL: Show scheduling link<br/>(share with lead)

    Note over CL: Closer shares link with lead<br/>via email/chat (manual for MVP)

    Note over CAL,CVX: Lead books via scheduling link
    CAL-->>CVX: invitee.created webhook
    CVX->>CVX: Pipeline detects existing<br/>Opportunity with follow_up_scheduled
    CVX->>CVX: Update Opportunity → scheduled<br/>Create new Meeting record<br/>Link to existing Opportunity
    CVX-->>CL: Real-time dashboard update
```

### 13.2 Scheduling Link Creation

Calendly supports **single-use scheduling links** via the API. This requires `scheduling_links:write` scope (which we may need to add — see [Open Questions](#19-open-questions)).

```typescript
// convex/closer/followUp.ts
export const createFollowUp = action({
  args: {
    opportunityId: v.id("opportunities"),
    eventTypeUri: v.optional(v.string()), // Which Calendly event type to use
  },
  handler: async (ctx, { opportunityId, eventTypeUri }) => {
    const { userId, tenantId } = await requireTenantUserAction(ctx, ["closer"]);

    const opportunity = await ctx.runQuery(internal.opportunities.get, { opportunityId });
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    const tenant = await ctx.runQuery(internal.tenants.getCalendlyTokens, { tenantId });
    const accessToken = await getValidAccessToken(ctx, tenantId);

    // Use the same event type as the original opportunity, or a specified one
    const targetEventType = eventTypeUri ?? opportunity.calendlyEventUri;

    // Create single-use scheduling link
    const response = await fetch("https://api.calendly.com/scheduling_links", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        max_event_count: 1,
        owner: targetEventType,
        owner_type: "EventType",
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create scheduling link: ${response.status}`);
    }

    const data = await response.json();
    const bookingUrl = data.resource.booking_url;

    // Update opportunity status
    await ctx.runMutation(internal.opportunities.updateStatus, {
      opportunityId,
      status: "follow_up_scheduled",
    });

    // Create follow-up record
    await ctx.runMutation(internal.followUps.create, {
      tenantId,
      opportunityId,
      leadId: opportunity.leadId,
      closerId: userId,
      schedulingLinkUrl: bookingUrl,
      reason: "closer_initiated",
      createdAt: Date.now(),
    });

    return { bookingUrl };
  },
});
```

### 13.3 Follow-Up Detection in Pipeline

When an `invitee.created` webhook arrives and the lead already has an opportunity with `status: "follow_up_scheduled"`, the pipeline processor:

1. Does **not** create a new opportunity.
2. Links the new meeting to the **existing** opportunity.
3. Transitions the opportunity back to `status: "scheduled"`.

This is handled in the `invitee.created` flow (see [Phase 6, Section 9.3](#93-inviteecreated-flow--core-pipeline)).

---

## 14. Data Model — New & Modified Tables

### 14.1 Modified: `tenants` Table

```typescript
tenants: defineTable({
  // ... existing fields ...

  // NEW: Owner reference
  tenantOwnerId: v.optional(v.id("users")),
})
  // ... existing indexes ...
```

### 14.2 New: `leads` Table

```typescript
leads: defineTable({
  tenantId: v.id("tenants"),
  email: v.string(),
  fullName: v.optional(v.string()),
  phone: v.optional(v.string()),
  customFields: v.optional(v.any()), // JSON from Calendly questions_and_answers
  firstSeenAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_tenantId", ["tenantId"])
  .index("by_tenantId_and_email", ["tenantId", "email"]),
```

### 14.3 New: `opportunities` Table

```typescript
opportunities: defineTable({
  tenantId: v.id("tenants"),
  leadId: v.id("leads"),
  assignedCloserId: v.optional(v.id("users")),  // null if unmatched
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
  calendlyEventUri: v.optional(v.string()),  // URI of the originating Calendly event
  cancellationReason: v.optional(v.string()),
  canceledBy: v.optional(v.string()),         // "invitee" or "host"
  lostReason: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_tenantId", ["tenantId"])
  .index("by_tenantId_and_leadId", ["tenantId", "leadId"])
  .index("by_tenantId_and_assignedCloserId", ["tenantId", "assignedCloserId"])
  .index("by_tenantId_and_status", ["tenantId", "status"]),
```

### 14.4 New: `meetings` Table

```typescript
meetings: defineTable({
  tenantId: v.id("tenants"),
  opportunityId: v.id("opportunities"),
  calendlyEventUri: v.string(),       // Calendly scheduled_event URI
  calendlyInviteeUri: v.string(),     // Calendly invitee URI
  zoomJoinUrl: v.optional(v.string()),
  scheduledAt: v.number(),            // Unix ms
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
```

### 14.5 New: `eventTypeConfigs` Table

```typescript
eventTypeConfigs: defineTable({
  tenantId: v.id("tenants"),
  calendlyEventTypeUri: v.string(),   // e.g. https://api.calendly.com/event_types/XXXX
  displayName: v.string(),
  paymentLinks: v.optional(v.array(v.object({
    provider: v.string(),             // "stripe", "paypal", etc.
    label: v.string(),                // Display label
    url: v.string(),                  // External payment URL
  }))),
  roundRobinEnabled: v.boolean(),
  createdAt: v.number(),
})
  .index("by_tenantId", ["tenantId"])
  .index("by_tenantId_and_calendlyEventTypeUri", ["tenantId", "calendlyEventTypeUri"]),
```

### 14.6 New: `paymentRecords` Table

```typescript
paymentRecords: defineTable({
  tenantId: v.id("tenants"),
  opportunityId: v.id("opportunities"),
  meetingId: v.id("meetings"),
  closerId: v.id("users"),
  amount: v.number(),
  currency: v.string(),
  provider: v.string(),
  referenceCode: v.optional(v.string()),
  proofFileId: v.optional(v.id("_storage")),  // Convex file storage
  status: v.union(
    v.literal("recorded"),
    v.literal("verified"),       // Future: admin verification
    v.literal("disputed"),       // Future: dispute handling
  ),
  recordedAt: v.number(),
})
  .index("by_opportunityId", ["opportunityId"])
  .index("by_tenantId", ["tenantId"])
  .index("by_tenantId_and_closerId", ["tenantId", "closerId"]),
```

### 14.7 New: `followUps` Table

```typescript
followUps: defineTable({
  tenantId: v.id("tenants"),
  opportunityId: v.id("opportunities"),
  leadId: v.id("leads"),
  closerId: v.id("users"),
  schedulingLinkUrl: v.optional(v.string()),  // Calendly single-use link
  calendlyEventUri: v.optional(v.string()),   // Set when follow-up meeting is booked
  reason: v.union(
    v.literal("closer_initiated"),
    v.literal("cancellation_follow_up"),
    v.literal("no_show_follow_up"),
  ),
  status: v.union(
    v.literal("pending"),        // Link shared, waiting for booking
    v.literal("booked"),         // Lead booked the follow-up
    v.literal("expired"),        // Link expired without booking
  ),
  createdAt: v.number(),
})
  .index("by_tenantId", ["tenantId"])
  .index("by_opportunityId", ["opportunityId"])
  .index("by_tenantId_and_closerId", ["tenantId", "closerId"]),
```

### 14.8 Opportunity Status State Machine

```mermaid
stateDiagram-v2
    [*] --> scheduled : invitee.created webhook
    scheduled --> in_progress : Closer starts meeting
    in_progress --> payment_received : Closer logs payment
    in_progress --> follow_up_scheduled : Closer schedules follow-up
    in_progress --> lost : Closer marks as lost
    scheduled --> canceled : invitee.canceled webhook
    scheduled --> no_show : invitee_no_show.created webhook
    canceled --> follow_up_scheduled : Closer initiates follow-up
    no_show --> follow_up_scheduled : Closer initiates follow-up
    follow_up_scheduled --> scheduled : New meeting booked via webhook
    payment_received --> [*] : Pipeline complete
    lost --> [*] : Archived
```

---

## 15. Convex Function Architecture

### 15.1 File Organization

```
convex/
├── admin/                          # System admin functions (existing)
│   ├── tenants.ts
│   ├── tenantsQueries.ts
│   └── tenantsMutations.ts
├── onboarding/                     # Tenant onboarding (existing, modified)
│   ├── invite.ts
│   └── complete.ts                 # MODIFIED: set tenantOwnerId + trigger role assignment
├── calendly/                       # Calendly integration (existing)
│   ├── oauth.ts
│   ├── oauthQueries.ts
│   ├── oauthMutations.ts
│   ├── tokens.ts
│   ├── tokenMutations.ts
│   ├── webhookSetup.ts
│   ├── webhookSetupMutations.ts
│   ├── orgMembers.ts              # ENHANCED: re-attempt user matching after sync
│   ├── orgMembersMutations.ts
│   └── healthCheck.ts
├── webhooks/                       # Webhook ingestion (existing)
│   ├── calendly.ts                # MODIFIED: schedule pipeline processing
│   └── calendlyMutations.ts
├── workos/                         # NEW: WorkOS integration
│   ├── roles.ts                   # Role assignment actions
│   └── widgetTokens.ts            # Widget token generation
├── pipeline/                       # NEW: Event processing pipeline
│   ├── processor.ts               # Main pipeline dispatcher
│   ├── inviteeCreated.ts          # invitee.created handler
│   ├── inviteeCanceled.ts         # invitee.canceled handler
│   ├── inviteeNoShow.ts           # invitee_no_show handler
│   └── queries.ts                 # Pipeline helper queries
├── closer/                         # NEW: Closer dashboard functions
│   ├── dashboard.ts               # Featured event, stats
│   ├── calendar.ts                # Calendar date range queries
│   ├── pipeline.ts                # Pipeline summary
│   ├── meetingDetail.ts           # Meeting detail page query
│   ├── meetingActions.ts          # Notes, start meeting, mark lost
│   ├── payments.ts                # Payment logging + file upload
│   └── followUp.ts                # Follow-up scheduling
├── dashboard/                      # NEW: Admin dashboard functions
│   └── adminStats.ts             # Admin quick stats
├── users/                          # NEW: User management
│   ├── queries.ts                 # User lookups
│   ├── mutations.ts               # User provisioning, updates
│   └── linkCalendlyMember.ts      # Manual Calendly matching
├── leads/                          # NEW: Lead management
│   └── queries.ts
├── opportunities/                  # NEW: Opportunity management
│   ├── queries.ts
│   └── mutations.ts
├── tenants.ts                      # Existing tenant queries/mutations
├── requireSystemAdmin.ts           # Existing auth guard
├── requireTenantUser.ts            # NEW: Tenant user auth guard
├── auth.ts                         # Existing WorkOS AuthKit
├── auth.config.ts                  # Existing JWT config
├── http.ts                         # Existing HTTP router
├── crons.ts                        # Existing cron jobs
└── schema.ts                       # MODIFIED: new tables added
```

### 15.2 New Auth Guard: `requireTenantUser`

A shared helper that validates the caller is an authenticated tenant user with one of the specified roles:

```typescript
// convex/requireTenantUser.ts
import type { QueryCtx, MutationCtx, ActionCtx } from "./_generated/server";

type TenantUserResult = {
  userId: Id<"users">;
  tenantId: Id<"tenants">;
  role: "tenant_master" | "tenant_admin" | "closer";
  workosUserId: string;
};

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

  // Find user record
  const user = await ctx.db
    .query("users")
    .withIndex("by_workosUserId", (q) => q.eq("workosUserId", workosUserId))
    .unique();

  if (!user) {
    throw new Error("User not found — please complete setup");
  }

  // Verify org matches tenant
  const tenant = await ctx.db.get(user.tenantId);
  if (!tenant || tenant.workosOrgId !== orgId) {
    throw new Error("Organization mismatch");
  }

  // Check role
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

---

## 16. Routing & Authorization — Next.js App Router

### 16.1 Route Structure

```
app/
├── admin/                          # System admin (existing)
│   └── page.tsx
├── workspace/                      # Tenant workspace (role-based routing)
│   ├── layout.tsx                 # Shared layout: sidebar nav, role detection
│   ├── page.tsx                   # MODIFIED: role-based redirect
│   ├── team/                      # Owner/Admin only
│   │   └── page.tsx               # User Management Widget
│   ├── pipeline/                  # Owner/Admin: all opportunities
│   │   └── page.tsx
│   ├── settings/                  # Owner/Admin only
│   │   └── page.tsx               # Calendly config, event types
│   └── closer/                    # Closer-specific routes
│       ├── page.tsx               # Closer dashboard
│       ├── pipeline/
│       │   └── page.tsx           # Closer's opportunity list
│       └── meetings/
│           └── [meetingId]/
│               └── page.tsx       # Meeting detail page
├── onboarding/                    # Existing
│   ├── page.tsx
│   └── connect/
│       └── page.tsx
├── callback/                      # Existing
│   └── calendly/
│       └── page.tsx
├── sign-in/                       # WorkOS AuthKit
│   └── page.tsx
└── sign-up/                       # WorkOS AuthKit
    └── page.tsx
```

### 16.2 Role-Based Routing Logic

The workspace layout detects the user's role and controls navigation:

```typescript
// app/workspace/layout.tsx
export default function WorkspaceLayout({ children }) {
  const user = useQuery(api.users.queries.getCurrentUser);

  if (!user) return <LoadingScreen />;

  // Closer should not see admin tabs
  const isAdmin = user.role === "tenant_master" || user.role === "tenant_admin";
  const isCloser = user.role === "closer";

  return (
    <div>
      <Sidebar>
        {isAdmin && <NavLink href="/workspace">Overview</NavLink>}
        {isAdmin && <NavLink href="/workspace/team">Team</NavLink>}
        {isAdmin && <NavLink href="/workspace/pipeline">Pipeline</NavLink>}
        {isAdmin && <NavLink href="/workspace/settings">Settings</NavLink>}
        {isCloser && <NavLink href="/workspace/closer">Dashboard</NavLink>}
        {isCloser && <NavLink href="/workspace/closer/pipeline">My Pipeline</NavLink>}
      </Sidebar>
      <main>{children}</main>
    </div>
  );
}
```

### 16.3 Workspace Root Redirect

```typescript
// app/workspace/page.tsx — redirects based on role
"use client";

export default function WorkspaceRoot() {
  const user = useQuery(api.users.queries.getCurrentUser);

  if (!user) return <LoadingScreen />;

  if (user.role === "closer") {
    redirect("/workspace/closer");
  }

  // Owner/Admin see the overview dashboard
  return <AdminDashboard />;
}
```

### 16.4 Auto-Provisioning Middleware

When a user logs in for the first time after being invited, they don't have a CRM `users` record yet. The workspace layout handles this:

```typescript
// In workspace layout or a provider component:
const user = useQuery(api.users.queries.getCurrentUser);
const provisionUser = useMutation(api.users.mutations.provisionFromWorkos);

useEffect(() => {
  if (user === null && isAuthenticated) {
    // Auto-provision: create CRM user record from WorkOS identity
    provisionUser({}).catch(console.error);
  }
}, [user, isAuthenticated]);
```

The `provisionFromWorkos` mutation:

1. Reads the caller's WorkOS identity (org_id, subject, email, name).
2. Resolves the tenant from org_id.
3. Calls a WorkOS action to get the user's membership role slug.
4. Maps the WorkOS role slug to CRM role.
5. Creates the user record.
6. Attempts Calendly email matching (for closers).

---

## 17. Security Considerations

### 17.1 Role-Based Data Access

| Data | Owner | Admin | Closer |
|---|---|---|---|
| All tenant opportunities | ✅ Read/Write | ✅ Read/Write | ❌ Own only |
| All meetings | ✅ Read | ✅ Read | ❌ Own only |
| User management | ✅ Full | ✅ Full | ❌ |
| Calendly settings | ✅ Full | ✅ Full (except re-auth) | ❌ |
| Calendly re-auth OAuth | ✅ | ❌ (refresh only) | ❌ |
| Payment records | ✅ All | ✅ All | ✅ Own only |
| Meeting notes | ✅ All | ✅ All | ✅ Own only |

### 17.2 Tenant Isolation in New Tables

Every new table (`leads`, `opportunities`, `meetings`, `eventTypeConfigs`, `paymentRecords`, `followUps`) carries a `tenantId` field. Every query uses a `tenantId`-scoped index. The `requireTenantUser` helper resolves `tenantId` from the authenticated user's WorkOS org — never from client input.

### 17.3 Closer Isolation

Closers can only access opportunities assigned to them. The `requireTenantUser` helper returns the caller's `userId`, and all Closer queries filter by `assignedCloserId = userId`.

### 17.4 Payment Proof Files

Convex file storage URLs are short-lived and unguessable. However, we still validate tenant ownership before generating URLs via `getPaymentProofUrl`.

### 17.5 Widget Token Security

Widget tokens are generated server-side in Convex actions. They are:
- Scoped to a specific user + organization.
- Valid for 1 hour.
- Never stored — generated on-demand and passed to the frontend.
- Only generated for users with the correct CRM role (`tenant_master` or `tenant_admin`).

---

## 18. Error Handling & Edge Cases

### 18.1 Unmatched Closer Receives a Meeting

If a webhook arrives with an `event_memberships` host URI that doesn't match any CRM user:

1. The opportunity is assigned to the **tenant owner** as a fallback.
2. A warning is logged (future: alert the admin).
3. The admin can reassign the opportunity manually from the pipeline view.

### 18.2 Lead Books Multiple Overlapping Meetings

If the same lead books multiple meetings (different event types or with different closers):

- Each booking creates a **separate opportunity** (they may be independent sales processes).
- The follow-up detection only links to an opportunity with `status: "follow_up_scheduled"` — not any arbitrary existing opportunity.

### 18.3 Closer Removed from Calendly Org

During the daily Calendly org member sync:
1. If a previously synced member is no longer in the Calendly org, their `calendlyOrgMembers` record is flagged.
2. The CRM user's `calendlyUserUri` is **not** automatically cleared (they may still have in-flight meetings).
3. An admin notification is generated (future: in-app alert).

### 18.4 Widget Token Generation Fails

If `workos.widgets.getToken()` fails (e.g., user doesn't have the required permission):
- Show a clear error: "Unable to load user management. Please ensure your role has the required permissions."
- Log the error for admin debugging.
- Suggest contacting the system admin if the issue persists.

### 18.5 Race Condition: Webhook Arrives Before User Provisioning

If a Calendly webhook arrives for a tenant whose Closer hasn't logged in yet (no CRM `users` record):
- The Closer assignment falls through to the email match in `calendlyOrgMembers`.
- If matched, the `matchedUserId` on `calendlyOrgMembers` is used for assignment.
- If no match, the fallback to the tenant owner applies.
- When the Closer eventually logs in and their user record is created, existing opportunities are **not** retroactively reassigned. The admin can manually reassign from the pipeline view.

### 18.6 Opportunity Status Transition Validation

The pipeline enforces valid state transitions. Invalid transitions (e.g., `lost` → `in_progress`) are rejected:

```typescript
const VALID_TRANSITIONS: Record<string, string[]> = {
  scheduled: ["in_progress", "canceled", "no_show"],
  in_progress: ["payment_received", "follow_up_scheduled", "lost"],
  canceled: ["follow_up_scheduled"],
  no_show: ["follow_up_scheduled"],
  follow_up_scheduled: ["scheduled"],
  payment_received: [], // Terminal
  lost: [],             // Terminal
};

function validateTransition(from: string, to: string): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
```

### 18.7 Duplicate Webhook Processing

The existing idempotency check on `calendlyEventUri` in `rawWebhookEvents` prevents duplicate raw event storage. The pipeline processor additionally checks `processed: true` before operating, ensuring exactly-once processing even if the scheduler retries.

---

## 19. Open Questions

| # | Question | Current Thinking |
|---|---|---|
| 1 | Should WorkOS roles be created via a setup script or the WorkOS Dashboard? | **Dashboard for MVP.** A script is fragile if run multiple times. The three roles and one permission are a one-time setup. Document the steps for reproducibility. |
| 2 | How do we sync WorkOS role changes back to CRM `users.role`? | **Option A (preferred):** WorkOS webhook `organization_membership.updated` → update CRM user. **Option B:** On each auth, compare and update. MVP: Option B (simpler, no additional webhook). |
| 3 | Does Calendly API support creating scheduling links for follow-ups? | Yes, via `POST /scheduling_links` with `max_event_count: 1`. This requires `scheduling_links:write` scope, which is **not** in our current MVP scope set. We need to add it or defer follow-up scheduling to Phase 2. |
| 4 | Should the admin be able to reassign opportunities between closers? | Yes, but defer to a later phase. For MVP, assignments are automatic via round-robin or manual by creating a new opportunity. |
| 5 | How should we handle the case where a Closer has meetings from before they were added to the CRM? | Don't backfill. Only new webhook events create opportunities. Past meetings are not imported. |
| 6 | Should the Tenant Owner be able to transfer ownership to another user? | Defer. For MVP, the onboarding user remains the owner. A future mutation can update `tenantOwnerId` and swap WorkOS roles. |
| 7 | How should we handle event type syncing from Calendly? | Sync event types when processing webhooks (lazy creation of `eventTypeConfigs`). A manual sync action can also be triggered from the Settings page. Full sync via cron is a Phase 2 enhancement. |
| 8 | What calendar component should we use for the Closer dashboard? | Build a custom calendar grid with shadcn/ui primitives (Table, Card). Avoid heavy third-party calendar libraries for MVP. A week view with time slots is the minimum. |
| 9 | Should the pipeline processor run as a mutation or action? | **Mutation** for the core processing (Lead upsert, Opportunity create, Meeting create) — these are all database writes and benefit from Convex's transactional guarantees. An **action** wrapper is used only if supplemental Calendly API calls are needed. |

---

## 20. Dependencies

### New Packages Required

| Package | Why | Runtime | Install |
|---|---|---|---|
| _(none)_ | All new dependencies are already available | | |

> **`@workos-inc/node`** is already installed (direct dependency, used in `convex/admin/tenants.ts`). No new packages are required for this phase.

### Environment Variables Required

All environment variables from the system admin flow remain in use. No new environment variables are needed — WorkOS API key and client ID are already configured.

| Variable | Already Set? | Used By |
|---|---|---|
| `WORKOS_API_KEY` | ✅ Convex env | Widget token generation, role assignment |
| `WORKOS_CLIENT_ID` | ✅ Convex env + `.env.local` | Widget token generation, AuthKit |
| `CALENDLY_CLIENT_ID` | ✅ Convex env | Follow-up scheduling (Calendly API calls) |
| `CALENDLY_CLIENT_SECRET` | ✅ Convex env | Token refresh |
| `INVITE_SIGNING_SECRET` | ✅ Convex env | Invite tokens (existing) |

### WorkOS Dashboard Configuration (One-Time)

| Action | Where | Details |
|---|---|---|
| Create permission `widgets:users-table:manage` | WorkOS Dashboard → Roles → Permissions | Required for User Management Widget |
| Create role `owner` with permission | WorkOS Dashboard → Roles | Slug: `owner` |
| Create role `tenant-admin` with permission | WorkOS Dashboard → Roles | Slug: `tenant-admin` |
| Create role `closer` (no permissions) | WorkOS Dashboard → Roles | Slug: `closer` |

### Calendly Scope Addition (If Follow-Up Scheduling Included)

If Phase 10 (follow-up scheduling) is included in MVP:

| Scope | Why |
|---|---|
| `scheduling_links:write` | Create single-use scheduling links for follow-ups |

This requires updating the OAuth authorize URL in `convex/calendly/oauth.ts` and prompting existing tenants to re-authorize. **Consider deferring to Phase 2** to avoid re-auth friction.

---

## 21. Applicable Skills

The following skills from the project's skills index should be invoked during implementation:

| Skill | When to Invoke | Phase |
|---|---|---|
| **`workos`** | Setting up RBAC roles, role assignment, understanding WorkOS membership API | Phase 1, 2 |
| **`workos-widgets`** | Implementing the User Management Widget (token generation, API calls, component) | Phase 3 |
| **`convex-migration-helper`** | Adding `tenantOwnerId` to existing tenants (widen-migrate-narrow) | Phase 1 |
| **`shadcn`** | Building dashboard UI components (cards, tables, calendar, badges) | Phases 5, 7, 8, 9 |
| **`frontend-design`** | Creating production-grade dashboard interfaces | Phases 5, 7, 8 |
| **`convex-setup-auth`** | If auth configuration needs updates for role-based access | Phase 1 |
| **`vercel-react-best-practices`** | Optimizing React/Next.js performance in dashboard views | Phases 5, 7 |
| **`vercel-composition-patterns`** | Designing reusable dashboard component patterns | Phases 5, 7 |
| **`convex-performance-audit`** | If dashboard queries become expensive (many opportunities, meetings) | Phase 7 |
| **`web-design-guidelines`** | Reviewing UI accessibility and design best practices | All UI phases |

---

*This document is a living specification. As implementation progresses and decisions from open questions are finalized, sections will be updated to reflect confirmed architectural choices, API contracts, and UX designs.*
