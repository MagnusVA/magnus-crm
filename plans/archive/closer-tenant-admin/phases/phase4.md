# Phase 4 — Admin Dashboard, Team Management & Settings

**Goal:** Build the complete Tenant Owner/Admin experience: an overview dashboard with real-time stats, a team management page with the programmatic invite form and Calendly member linking, an all-opportunities pipeline view, and a settings page for Calendly connection health and event type configuration.

**Prerequisite:** Phase 1 (schema, auth guard, user queries, workspace layout) and Phase 2 (WorkOS user management actions, team queries) complete.

**Runs in PARALLEL with:** Phase 5 (Closer Dashboard). No shared files.

**Skills to invoke:**
- `frontend-design` — production-grade dashboard interfaces
- `shadcn` — Card, Table, Badge, Dialog, Select, Input, Button components
- `vercel-react-best-practices` — optimize React/Next.js performance
- `vercel-composition-patterns` — compound component patterns for forms and tables
- `web-design-guidelines` — accessibility, responsive design, color contrast
- `workos` — reference for understanding role assignment behavior in admin context

**Acceptance Criteria:**
1. Admin navigating to `/workspace` sees quick stats: Total Closers, Active Opportunities, Meetings Today, Revenue Logged.
2. `/workspace/team` shows a table of all team members with role, email, Calendly link status, and action buttons.
3. The "Invite User" dialog collects email, first name, last name, role, and (for Closers) a Calendly member dropdown.
4. Submitting the invite form calls `inviteUser` and shows success/error feedback.
5. Admin can change a user's role via inline action on the team table.
6. Admin can remove a user (with confirmation dialog).
7. `/workspace/pipeline` shows all opportunities filterable by status and closer.
8. `/workspace/settings` shows Calendly connection status, token health, and event type configuration.

---

## Subphases

### 4A — Admin Dashboard Stats Query

**Type:** Backend
**Parallelizable:** Yes — independent of all other Phase 4 subphases. After Phase 1 complete.

**What:** Create the `getAdminDashboardStats` query that returns aggregate counts for the admin overview dashboard.

**Why:** The admin overview page (4D) needs real-time stats: total closers, unmatched closers, active opportunities, meetings today, and logged revenue. This query powers the stats cards.

**Where:** `convex/dashboard/adminStats.ts` (new file)

**How:**

```typescript
// convex/dashboard/adminStats.ts
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

/**
 * Get aggregate stats for the admin dashboard overview.
 * Returns counts for key metrics displayed as cards.
 */
export const getAdminDashboardStats = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    // Count closers
    const allUsers = await ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .collect();

    const closers = allUsers.filter((u) => u.role === "closer");
    const unmatchedClosers = closers.filter((c) => !c.calendlyUserUri);

    // Count active opportunities
    const opportunities = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .collect();

    const activeStatuses = ["scheduled", "in_progress", "follow_up_scheduled"];
    const activeOpps = opportunities.filter((o) => activeStatuses.includes(o.status));

    // Count meetings today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startOfDay = today.getTime();
    const endOfDay = startOfDay + 86400000;

    const meetingsToday = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q.eq("tenantId", tenantId).gte("scheduledAt", startOfDay).lt("scheduledAt", endOfDay)
      )
      .collect();

    // Count won deals (payment_received)
    const wonDeals = opportunities.filter((o) => o.status === "payment_received").length;

    return {
      totalClosers: closers.length,
      unmatchedClosers: unmatchedClosers.length,
      totalTeamMembers: allUsers.length,
      activeOpportunities: activeOpps.length,
      meetingsToday: meetingsToday.length,
      wonDeals,
      totalOpportunities: opportunities.length,
    };
  },
});
```

**Key implementation notes:**
- Uses `requireTenantUser` with admin roles — closers cannot access this query.
- Collects all opportunities in one query, then filters in memory. Acceptable for MVP scale (< 1000 opportunities per tenant). For larger datasets, use `by_tenantId_and_status` index with separate queries per status.
- `meetingsToday` uses the `by_tenantId_and_scheduledAt` index for efficient date-range filtering.

**Files touched:** `convex/dashboard/adminStats.ts` (create)

---

### 4B — Event Type Config Queries & Mutations

**Type:** Backend
**Parallelizable:** Yes — independent of other Phase 4 subphases. After Phase 1 complete.

**What:** Create queries and mutations for managing event type configurations (display names, payment links, round robin settings).

**Why:** The settings page (4G) needs to list all event type configs and allow admins to update payment links and display names. These configs are also used by the pipeline (Phase 3) and closer dashboard (Phase 5).

**Where:** `convex/eventTypeConfigs/queries.ts` and `convex/eventTypeConfigs/mutations.ts` (new files)

**How:**

```typescript
// convex/eventTypeConfigs/queries.ts
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const listEventTypeConfigs = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    return await ctx.db
      .query("eventTypeConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .collect();
  },
});
```

```typescript
// convex/eventTypeConfigs/mutations.ts
import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const upsertEventTypeConfig = mutation({
  args: {
    calendlyEventTypeUri: v.string(),
    displayName: v.string(),
    paymentLinks: v.optional(v.array(v.object({
      provider: v.string(),
      label: v.string(),
      url: v.string(),
    }))),
    roundRobinEnabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    const existing = await ctx.db
      .query("eventTypeConfigs")
      .withIndex("by_tenantId_and_calendlyEventTypeUri", (q) =>
        q.eq("tenantId", tenantId).eq("calendlyEventTypeUri", args.calendlyEventTypeUri)
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        displayName: args.displayName,
        paymentLinks: args.paymentLinks,
        roundRobinEnabled: args.roundRobinEnabled ?? existing.roundRobinEnabled,
      });
      return existing._id;
    } else {
      return await ctx.db.insert("eventTypeConfigs", {
        tenantId,
        calendlyEventTypeUri: args.calendlyEventTypeUri,
        displayName: args.displayName,
        paymentLinks: args.paymentLinks,
        roundRobinEnabled: args.roundRobinEnabled ?? false,
        createdAt: Date.now(),
      });
    }
  },
});
```

**Files touched:** `convex/eventTypeConfigs/queries.ts` (create), `convex/eventTypeConfigs/mutations.ts` (create)

---

### 4C — Admin Pipeline Queries (All Opportunities)

**Type:** Backend
**Parallelizable:** Yes — independent of other Phase 4 subphases. After Phase 1 complete.

**What:** Create queries for the admin pipeline view that returns all opportunities across all closers, enriched with lead and closer information, filterable by status.

**Why:** The admin pipeline page (4F) shows a comprehensive view of all sales activity. Admins need to see which closers have which opportunities at which stages.

**Where:** `convex/opportunities/queries.ts` (new file)

**How:**

```typescript
// convex/opportunities/queries.ts
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

/**
 * List all opportunities for the tenant, enriched with lead and closer info.
 * Supports optional status filter.
 */
export const listOpportunitiesForAdmin = query({
  args: {
    statusFilter: v.optional(v.string()),
  },
  handler: async (ctx, { statusFilter }) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    let opps;
    if (statusFilter) {
      opps = await ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_status", (q) =>
          q.eq("tenantId", tenantId).eq("status", statusFilter as any)
        )
        .collect();
    } else {
      opps = await ctx.db
        .query("opportunities")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .collect();
    }

    // Enrich with lead and closer data
    const enriched = await Promise.all(
      opps.map(async (opp) => {
        const lead = await ctx.db.get(opp.leadId);
        const closer = opp.assignedCloserId
          ? await ctx.db.get(opp.assignedCloserId)
          : null;

        // Get the latest meeting for this opportunity
        const latestMeeting = await ctx.db
          .query("meetings")
          .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opp._id))
          .order("desc")
          .first();

        return {
          ...opp,
          leadName: lead?.fullName ?? lead?.email ?? "Unknown",
          leadEmail: lead?.email,
          closerName: closer?.fullName ?? closer?.email ?? "Unassigned",
          nextMeetingAt: latestMeeting?.scheduledAt,
          meetingStatus: latestMeeting?.status,
        };
      })
    );

    // Sort by most recent first
    return enriched.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});
```

**Files touched:** `convex/opportunities/queries.ts` (create)

---

### 4D — Admin Overview Page UI

**Type:** Frontend
**Parallelizable:** Depends on 4A (admin stats query). Can start with mock data, then wire to real query.

**What:** Build the admin dashboard overview page with quick stats cards, a pipeline summary, and a recent activity section.

**Why:** This is the landing page for Tenant Owners and Admins after login. It provides an at-a-glance view of business health: how many closers are active, how many deals are in the pipeline, and what's happening today.

**Where:** `app/workspace/page.tsx` (replace placeholder from Phase 1F), `app/workspace/_components/` (new component files)

**How:**

Build these components using shadcn/ui primitives:

**Stats Cards Row:**
```
┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│  Total       │ │  Active      │ │  Meetings    │ │  Won         │
│  Closers     │ │  Opps        │ │  Today       │ │  Deals       │
│     5        │ │     12       │ │     3        │ │     8        │
└─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘
```

**Component structure:**
```
app/workspace/
├── page.tsx                    ← Admin overview (uses StatsCards, PipelineSummary)
└── _components/
    ├── stats-card.tsx          ← Reusable stat card (icon, label, value)
    ├── stats-row.tsx           ← Row of 4 stats cards
    ├── pipeline-summary.tsx    ← Pipeline stage breakdown with colored badges
    └── system-health.tsx       ← Calendly connection status, webhook health
```

```typescript
// app/workspace/page.tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { StatsRow } from "./_components/stats-row";
import { PipelineSummary } from "./_components/pipeline-summary";
import { SystemHealth } from "./_components/system-health";

export default function AdminDashboardPage() {
  const stats = useQuery(api.dashboard.adminStats.getAdminDashboardStats);
  const user = useQuery(api.users.queries.getCurrentUser);

  if (stats === undefined || user === undefined) {
    return <DashboardSkeleton />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground">
          Welcome back, {user?.fullName ?? user?.email}
        </p>
      </div>

      <StatsRow stats={stats} />
      <PipelineSummary stats={stats} />
      <SystemHealth />
    </div>
  );
}
```

**Frontend design guidelines to follow:**
- Use shadcn `Card` for stat containers — consistent with the design system.
- Use `Badge` components with semantic colors for pipeline stages (blue=scheduled, yellow=in_progress, green=won, red=lost/canceled).
- Implement loading skeletons using shadcn's `Skeleton` component.
- Ensure stats cards are responsive: 4-column on desktop, 2-column on tablet, 1-column on mobile using CSS Grid or Tailwind's responsive utilities.
- Follow `web-design-guidelines`: sufficient color contrast (WCAG AA), semantic headings, `aria-label` on icon-only elements.

**Files touched:** `app/workspace/page.tsx` (rewrite), `app/workspace/_components/stats-card.tsx` (create), `app/workspace/_components/stats-row.tsx` (create), `app/workspace/_components/pipeline-summary.tsx` (create), `app/workspace/_components/system-health.tsx` (create)

---

### 4E — Team Page & Invite Form UI

**Type:** Frontend
**Parallelizable:** Depends on Phase 2E (inviteUser action), Phase 2G (listTeamMembers, listUnmatchedCalendlyMembers queries), and Phase 2D (linkCloserToCalendlyMember mutation). Can start UI shell with mock data, wire to real queries after Phase 2.

**What:** Build the team management page with: a table of all team members showing role/status/Calendly link, an "Invite User" dialog with the full form (email, name, role, Calendly member dropdown), inline role-edit and remove actions per user, and a Calendly re-link action for Closers.

**Why:** This is the primary user management interface. It replaces the need for WorkOS Widgets by providing a fully custom form that integrates Calendly member selection at invite time. The team table gives admins visibility into who's on the team, their roles, and whether their Calendly accounts are linked.

**Where:** `app/workspace/team/page.tsx`, `app/workspace/team/_components/` (new component files)

**How:**

**Component structure:**
```
app/workspace/team/
├── page.tsx                        ← Team page (table + invite button)
└── _components/
    ├── team-members-table.tsx      ← DataTable with columns: Name, Email, Role, Calendly Status, Actions
    ├── invite-user-dialog.tsx      ← Modal form: email, first/last name, role, Calendly member dropdown
    ├── role-select.tsx             ← Inline role editor dropdown
    ├── remove-user-dialog.tsx      ← Confirmation dialog for user removal
    └── calendly-link-dialog.tsx    ← Re-link Calendly member dialog
```

**Invite User Dialog form fields:**

| Field | Component | Required | Notes |
|---|---|---|---|
| Email | `<Input type="email" />` | Yes | Validated as email format |
| First Name | `<Input />` | Yes | Used for WorkOS user creation |
| Last Name | `<Input />` | No | Optional, appended to full name |
| Role | `<Select>` | Yes | Options: Closer, Tenant Admin, Owner |
| Calendly Member | `<Select>` | Conditional | **Required for Closers only.** Hidden for Admin/Owner. Populated from `listUnmatchedCalendlyMembers` query. |

**Form behavior:**
- When "Closer" role is selected, the Calendly Member dropdown appears and becomes required.
- When "Tenant Admin" or "Owner" role is selected, the Calendly Member dropdown is hidden.
- Submit button calls `api.workos.userManagement.inviteUser` action.
- On success: toast notification, dialog closes, table refreshes (real-time via Convex subscription).
- On error: inline error message preserved in dialog, form values retained for correction.

**Team table columns:**

| Column | Source | Notes |
|---|---|---|
| Name | `user.fullName` | With fallback to email |
| Email | `user.email` | |
| Role | `user.role` | Badge with role-specific color |
| Calendly Status | `user.calendlyMemberName` or "Not linked" | Warning icon if Closer is unlinked |
| Actions | Dropdown menu | Edit Role, Re-link Calendly, Remove User |

```typescript
// app/workspace/team/page.tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { TeamMembersTable } from "./_components/team-members-table";
import { InviteUserDialog } from "./_components/invite-user-dialog";
import { Button } from "@/components/ui/button";

export default function TeamPage() {
  const members = useQuery(api.users.queries.listTeamMembers);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Team</h1>
          <p className="text-muted-foreground">
            Manage your team members and invite new users
          </p>
        </div>
        <InviteUserDialog />
      </div>

      {members === undefined ? (
        <TableSkeleton />
      ) : (
        <TeamMembersTable members={members} />
      )}
    </div>
  );
}
```

**Frontend design guidelines to follow:**
- Use shadcn `Dialog` for the invite modal — accessible, keyboard-navigable, closeable via Escape.
- Use shadcn `Table` for the team list — sortable headers, responsive on smaller screens.
- Use `react-hook-form` (if available) or controlled inputs for form state management.
- Implement optimistic UI: after successful invite, the table updates in real-time via Convex subscription.
- The Calendly Member dropdown should show member name + email for clarity.
- Unlinked Closers should have a visible warning badge in the table.
- Follow `vercel-composition-patterns`: the invite dialog is a compound component (trigger button + dialog content).
- Follow `web-design-guidelines`: form labels associated with inputs, error messages are `role="alert"`, focus management in dialog.

**Files touched:** `app/workspace/team/page.tsx` (create), `app/workspace/team/_components/team-members-table.tsx` (create), `app/workspace/team/_components/invite-user-dialog.tsx` (create), `app/workspace/team/_components/role-select.tsx` (create), `app/workspace/team/_components/remove-user-dialog.tsx` (create), `app/workspace/team/_components/calendly-link-dialog.tsx` (create)

---

### 4F — Admin Pipeline Page UI

**Type:** Frontend
**Parallelizable:** Depends on 4C (admin pipeline query). Can start with mock data.

**What:** Build the admin pipeline view showing all opportunities across all closers with filtering by status and closer.

**Why:** Admins need to see the full sales pipeline to understand business health, identify bottlenecks (e.g., too many opportunities stuck at "in_progress"), and spot unassigned opportunities.

**Where:** `app/workspace/pipeline/page.tsx`, `app/workspace/pipeline/_components/` (new component files)

**How:**

**Component structure:**
```
app/workspace/pipeline/
├── page.tsx                        ← Pipeline page (filters + table)
└── _components/
    ├── pipeline-filters.tsx        ← Status filter tabs/buttons, closer dropdown
    ├── opportunities-table.tsx     ← DataTable: Lead, Closer, Status, Meeting Date, Actions
    └── status-badge.tsx            ← Reusable status badge with semantic colors
```

**Pipeline filters:**
- **Status tabs:** All | Scheduled | In Progress | Follow-up | Won | Lost | Canceled | No Show
- **Closer filter:** Dropdown of all closers (populated from team members query)

**Table columns:**

| Column | Source | Notes |
|---|---|---|
| Lead | `leadName` / `leadEmail` | Link to future lead detail page |
| Closer | `closerName` | Badge if unassigned |
| Status | `status` | Color-coded badge |
| Next Meeting | `nextMeetingAt` | Formatted date/time, relative time |
| Created | `createdAt` | Relative time |
| Actions | — | View details (future) |

**Frontend design guidelines to follow:**
- Use shadcn `Tabs` for status filtering — clear active state, accessible.
- Use shadcn `Table` with sortable columns.
- Status badges should use consistent colors across the entire application:
  - Scheduled: `bg-blue-100 text-blue-800`
  - In Progress: `bg-yellow-100 text-yellow-800`
  - Payment Received: `bg-green-100 text-green-800`
  - Follow-up Scheduled: `bg-purple-100 text-purple-800`
  - Lost: `bg-red-100 text-red-800`
  - Canceled: `bg-gray-100 text-gray-800`
  - No Show: `bg-orange-100 text-orange-800`
- Empty state: "No opportunities found" with appropriate illustration.

**Files touched:** `app/workspace/pipeline/page.tsx` (create), `app/workspace/pipeline/_components/pipeline-filters.tsx` (create), `app/workspace/pipeline/_components/opportunities-table.tsx` (create), `app/workspace/pipeline/_components/status-badge.tsx` (create)

---

### 4G — Settings Page UI

**Type:** Frontend
**Parallelizable:** Depends on 4B (event type config queries). Can start with mock data.

**What:** Build the settings page with Calendly connection status display, token health indicators, event type configuration (payment links, display names), and a manual token refresh button.

**Why:** Admins need visibility into the Calendly integration health and the ability to configure payment links per event type. This page also provides the Calendly re-authentication flow when tokens expire.

**Where:** `app/workspace/settings/page.tsx`, `app/workspace/settings/_components/` (new component files)

**How:**

**Component structure:**
```
app/workspace/settings/
├── page.tsx                          ← Settings page (sections)
└── _components/
    ├── calendly-connection.tsx       ← Connection status card (active/disconnected, token expiry)
    ├── event-type-config-list.tsx    ← List of event types with edit actions
    ├── event-type-config-dialog.tsx  ← Edit dialog: display name, payment links
    └── payment-link-editor.tsx       ← Dynamic list editor for payment links
```

**Calendly Connection section:**
```
┌─────────────────────────────────────────────┐
│  Calendly Connection                        │
│                                             │
│  Status: ✅ Connected                       │
│  Token expires: 2026-04-02 14:30            │
│  Last refresh: 2 hours ago                  │
│                                             │
│  [Refresh Token]  [Reconnect Calendly]      │
└─────────────────────────────────────────────┘
```

**Event Type Configs section:**
```
┌─────────────────────────────────────────────┐
│  Event Type Configurations                  │
│                                             │
│  ┌─────────────────────────────────────┐   │
│  │ 30-Min Sales Call                    │   │
│  │ Payment Links: Stripe, PayPal       │   │
│  │ Round Robin: Enabled                │   │
│  │ [Edit]                              │   │
│  └─────────────────────────────────────┘   │
│                                             │
│  ┌─────────────────────────────────────┐   │
│  │ 60-Min Demo                          │   │
│  │ Payment Links: None configured      │   │
│  │ Round Robin: Disabled               │   │
│  │ [Edit]                              │   │
│  └─────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

**Payment link editor** (within the edit dialog):
- Dynamic add/remove rows: Provider (select: Stripe/PayPal/Other), Label (text), URL (url input)
- Validates URLs before saving

**Frontend design guidelines to follow:**
- Use shadcn `Card` for each section.
- Use semantic status indicators: green dot for active, yellow for expiring soon, red for disconnected.
- The "Reconnect Calendly" button initiates the same OAuth flow from the onboarding phase (redirect to `/api/calendly/start`).
- Payment link editor should use `vercel-composition-patterns` — a compound component with add/remove row controls.

**Files touched:** `app/workspace/settings/page.tsx` (create), `app/workspace/settings/_components/calendly-connection.tsx` (create), `app/workspace/settings/_components/event-type-config-list.tsx` (create), `app/workspace/settings/_components/event-type-config-dialog.tsx` (create), `app/workspace/settings/_components/payment-link-editor.tsx` (create)

---

## Parallelization Summary

```
Phase 1 + Phase 2 Complete
  │
  ├── 4A (admin stats query) ──────────────────────┐
  ├── 4B (event type config queries/mutations) ────┤  All 3 backend subphases
  └── 4C (admin pipeline query) ───────────────────┤  run in PARALLEL
                                                    │
  After backend subphases complete:                 │
  ├── 4D (admin overview page) ────────────────────┤
  ├── 4E (team page + invite form) ────────────────┤  All 4 frontend subphases
  ├── 4F (admin pipeline page) ────────────────────┤  run in PARALLEL
  └── 4G (settings page) ─────────────────────────┘
```

**Optimal execution:**
1. Start 4A, 4B, 4C all in parallel (backend).
2. Once all backend subphases are done → start 4D, 4E, 4F, 4G all in parallel (frontend).
3. Frontend subphases can start with mock data before backend is complete for faster iteration.

**Estimated time:** 3–5 days

---

## Files Modified/Created Summary

| File | Action | Subphase |
|---|---|---|
| `convex/dashboard/adminStats.ts` | Created | 4A |
| `convex/eventTypeConfigs/queries.ts` | Created | 4B |
| `convex/eventTypeConfigs/mutations.ts` | Created | 4B |
| `convex/opportunities/queries.ts` | Created | 4C |
| `app/workspace/page.tsx` | Rewritten (admin overview) | 4D |
| `app/workspace/_components/stats-card.tsx` | Created | 4D |
| `app/workspace/_components/stats-row.tsx` | Created | 4D |
| `app/workspace/_components/pipeline-summary.tsx` | Created | 4D |
| `app/workspace/_components/system-health.tsx` | Created | 4D |
| `app/workspace/team/page.tsx` | Created | 4E |
| `app/workspace/team/_components/team-members-table.tsx` | Created | 4E |
| `app/workspace/team/_components/invite-user-dialog.tsx` | Created | 4E |
| `app/workspace/team/_components/role-select.tsx` | Created | 4E |
| `app/workspace/team/_components/remove-user-dialog.tsx` | Created | 4E |
| `app/workspace/team/_components/calendly-link-dialog.tsx` | Created | 4E |
| `app/workspace/pipeline/page.tsx` | Created | 4F |
| `app/workspace/pipeline/_components/pipeline-filters.tsx` | Created | 4F |
| `app/workspace/pipeline/_components/opportunities-table.tsx` | Created | 4F |
| `app/workspace/pipeline/_components/status-badge.tsx` | Created | 4F |
| `app/workspace/settings/page.tsx` | Created | 4G |
| `app/workspace/settings/_components/calendly-connection.tsx` | Created | 4G |
| `app/workspace/settings/_components/event-type-config-list.tsx` | Created | 4G |
| `app/workspace/settings/_components/event-type-config-dialog.tsx` | Created | 4G |
| `app/workspace/settings/_components/payment-link-editor.tsx` | Created | 4G |

---

*End of Phase 4. This phase runs in PARALLEL with Phase 5 (Closer Dashboard). Together they deliver the complete user experience for all roles.*
