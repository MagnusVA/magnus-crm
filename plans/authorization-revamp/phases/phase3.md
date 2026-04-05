# Phase 3 — Page-by-Page Wrapper Conversion

**Goal:** Convert each workspace and admin page from a `"use client"` page that performs its own role checking into a thin RSC wrapper that calls the appropriate auth helper from `lib/auth.ts`, then renders the existing client page as a child component. Extract client-side page logic into `_components/*-page-client.tsx` files.

**Prerequisite:** Phase 1 complete (`lib/auth.ts` available with `requireRole()`, `requireWorkspaceUser()`, `requireSystemAdmin()`) and Phase 2 complete (workspace layout converted to RSC with `getWorkspaceAccess()`).

**Runs in PARALLEL with:** Nothing -- depends on Phase 2 layout being in place. Phase 4 (Client Affordance Layer) is independent but benefits from Phase 3 being complete.

**Skills to invoke:**
- None -- this is systematic component migration across multiple pages following the pattern established in the design document.

**Estimated time:** 2-3 days (9 pages, but each is small and independent once the pattern is established)

**Risk:** Low per page. Each conversion is isolated to a single route directory. No cross-page dependencies exist between subphases.

---

## Acceptance Criteria

1. All 8 workspace pages (`/workspace`, `/workspace/team`, `/workspace/pipeline`, `/workspace/settings`, `/workspace/closer`, `/workspace/closer/pipeline`, `/workspace/closer/meetings/[meetingId]`, `/workspace/profile`) have RSC wrappers that call `requireRole()` or `requireWorkspaceUser()`.
2. The admin page (`/admin`) has an RSC wrapper that calls `requireSystemAdmin()`.
3. No converted page contains a `"use client"` directive in `page.tsx`.
4. Each wrapper preloads data using `preloadQuery()` where the page depends on Convex query data that should be ready on first paint.
5. Time-sensitive polling queries (`usePollingQuery`) remain client-side -- they are NOT preloaded.
6. `usePaginatedQuery` usage remains client-side -- there is no preload equivalent.
7. `useSearchParams()` usage remains client-side, wrapped in `<Suspense>` where needed.
8. Client components use `usePreloadedQuery()` instead of `useQuery()` for preloaded data, falling through to live Convex subscriptions.
9. Client components no longer call `useQuery(api.users.queries.getCurrentUser)` for role checking or closer redirect logic -- the RSC wrapper handles that.
10. Closers requesting any admin page (`/workspace`, `/workspace/team`, `/workspace/pipeline`, `/workspace/settings`) are redirected to `/workspace/closer` by `requireRole(ADMIN_ROLES)`.
11. Admins requesting closer pages (`/workspace/closer`, `/workspace/closer/pipeline`, `/workspace/closer/meetings/[meetingId]`) are redirected to `/workspace` by `requireRole(["closer"])`.
12. `pnpm tsc --noEmit` passes without errors after all subphases are complete.

---

## Subphase Dependency Graph

```
3A (/workspace/team)                         ──┐
                                               │
3B (/workspace/settings)                     ──┤
                                               │
3C (/workspace/pipeline)                     ──┤
                                               │
3D (/workspace — admin dashboard)            ──┤
                                               │  All independent — touch
3E (/workspace/closer — closer dashboard)    ──┤  separate route directories
                                               │
3F (/workspace/closer/pipeline)              ──┤
                                               │
3G (/workspace/closer/meetings/[meetingId])  ──┤
                                               │
3H (/workspace/profile)                      ──┤
                                               │
3I (/admin)                                  ──┘
```

**Optimal execution:**
All 9 subphases touch completely separate route directories. They can run in any order or fully in parallel. The recommended order (3A first) exists only because 3A establishes the clearest pattern for the team -- once 3A is merged and reviewed, all remaining subphases can proceed simultaneously.

---

## Subphases

### 3A — Convert `/workspace/team` (Admin, Preload Team Members)

**Type:** Full-Stack
**Parallelizable:** Yes -- independent of all other subphases. Recommended first to establish the pattern.

**What:** Convert `/workspace/team` from a `"use client"` page that calls `useQuery(getCurrentUser)`, checks `isAdmin`, conditionally fetches `listTeamMembers`, and redirects closers -- into a thin RSC wrapper that calls `requireRole(ADMIN_ROLES)` and preloads team members, then renders the existing UI as a client component.

**Why:** This page is the ideal first conversion: it has a clear admin-only role requirement, a single preloadable query (`listTeamMembers`), and dialog state management that stays entirely client-side. It establishes the pattern for all subsequent pages.

**Where:**
- `app/workspace/team/page.tsx` (rewrite to RSC wrapper)
- `app/workspace/team/_components/team-page-client.tsx` (new -- receives extracted client logic)

**How:**

**Step 1: Create the RSC wrapper**

```tsx
// Path: app/workspace/team/page.tsx
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

**Step 2: Move existing client logic into `team-page-client.tsx`**

Move the entire current `page.tsx` content into `_components/team-page-client.tsx` with these changes:

1. **Remove:** `useQuery(api.users.queries.getCurrentUser)` and all `currentUser`-derived role checks (`isAdmin`, `currentUser === undefined` loading gate, `currentUser === null` guard, `currentUser.role === "closer"` redirect).
2. **Remove:** The conditional skip on `listTeamMembers` (`isAdmin ? {} : "skip"`) -- the RSC wrapper guarantees admin access.
3. **Replace:** `useQuery(api.users.queries.listTeamMembers, ...)` with `usePreloadedQuery(preloadedTeam)`.
4. **Keep:** All dialog state management (`useState<DialogState>`), dynamic imports for `InviteUserDialog`, `RemoveUserDialog`, `CalendlyLinkDialog`, `RoleEditDialog`, `TeamMembersTable`, CSV export, `usePageTitle`, and the `TableSkeleton` (for the brief window while `usePreloadedQuery` initializes).

**Client component props signature:**

```tsx
// Path: app/workspace/team/_components/team-page-client.tsx
"use client";

import type { Preloaded } from "convex/react";
import { usePreloadedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
// ... all other existing imports stay

interface TeamPageClientProps {
  preloadedTeam: Preloaded<typeof api.users.queries.listTeamMembers>;
}

export function TeamPageClient({ preloadedTeam }: TeamPageClientProps) {
  usePageTitle("Team");
  const members = usePreloadedQuery(preloadedTeam);

  // Dialog state, handlers, CSV export, table rendering -- all unchanged
  // ...
}
```

**Data strategy:** Preload `listTeamMembers`. The preloaded data renders immediately on mount, then `usePreloadedQuery` establishes a live Convex subscription so changes (invite accepted, role changed, user removed) appear in real time.

**What to remove from the client component:**
- `const currentUser = useQuery(api.users.queries.getCurrentUser);`
- `const isAdmin = currentUser?.role === "tenant_master" || currentUser?.role === "tenant_admin";`
- `const members = useQuery(api.users.queries.listTeamMembers, isAdmin ? {} : "skip");`
- `if (currentUser === undefined) { return <TableSkeleton />; }`
- `if (currentUser === null) { return null; }`
- `if (currentUser.role === "closer") { redirect("/workspace/closer"); }`
- Any references to `currentUser._id` for self-check logic should use a separate lightweight query or be passed as a prop from the RSC wrapper if needed.

**Note on `currentUser._id`:** The team page uses `currentUser._id` to prevent self-removal and self-role-edit. The RSC wrapper returns `access.crmUser`, so pass `currentUserId={access.crmUser._id}` as an additional prop to the client component.

**Updated wrapper with currentUserId:**

```tsx
// Path: app/workspace/team/page.tsx
import { requireRole } from "@/lib/auth";
import { ADMIN_ROLES } from "@/convex/lib/roleMapping";
import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { TeamPageClient } from "./_components/team-page-client";

export default async function TeamPage() {
  const { session, crmUser } = await requireRole(ADMIN_ROLES);
  const preloadedTeam = await preloadQuery(
    api.users.queries.listTeamMembers,
    {},
    { token: session.accessToken },
  );
  return (
    <TeamPageClient
      preloadedTeam={preloadedTeam}
      currentUserId={crmUser._id}
    />
  );
}
```

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/team/page.tsx` | Rewrite | Remove `"use client"`, replace with RSC wrapper calling `requireRole(ADMIN_ROLES)` + `preloadQuery(listTeamMembers)` |
| `app/workspace/team/_components/team-page-client.tsx` | Create | Extracted client page with `usePreloadedQuery`, dialog state, CSV export, table |

---

### 3B — Convert `/workspace/settings` (Admin, Preload Configs + Connection Status)

**Type:** Full-Stack
**Parallelizable:** Yes -- independent of all other subphases.

**What:** Convert `/workspace/settings` from a `"use client"` page into an RSC wrapper that calls `requireRole(ADMIN_ROLES)` and preloads both `listEventTypeConfigs` and `getConnectionStatus` in parallel using `Promise.all`.

**Why:** The settings page depends on two independent queries that the page always needs. Preloading both eliminates the sequential loading waterfall (user query -> role check -> config query + connection query).

**Where:**
- `app/workspace/settings/page.tsx` (rewrite to RSC wrapper)
- `app/workspace/settings/_components/settings-page-client.tsx` (new)

**How:**

**Step 1: Create the RSC wrapper**

```tsx
// Path: app/workspace/settings/page.tsx
import { requireRole } from "@/lib/auth";
import { ADMIN_ROLES } from "@/convex/lib/roleMapping";
import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { SettingsPageClient } from "./_components/settings-page-client";

export default async function SettingsPage() {
  const { session } = await requireRole(ADMIN_ROLES);

  const [preloadedEventTypeConfigs, preloadedConnectionStatus] =
    await Promise.all([
      preloadQuery(
        api.eventTypeConfigs.queries.listEventTypeConfigs,
        {},
        { token: session.accessToken },
      ),
      preloadQuery(
        api.calendly.oauthQueries.getConnectionStatus,
        {},
        { token: session.accessToken },
      ),
    ]);

  return (
    <SettingsPageClient
      preloadedEventTypeConfigs={preloadedEventTypeConfigs}
      preloadedConnectionStatus={preloadedConnectionStatus}
    />
  );
}
```

**Step 2: Move existing client logic into `settings-page-client.tsx`**

Move the entire current `page.tsx` content with these changes:

1. **Remove:** `useQuery(api.users.queries.getCurrentUser)` and all role/redirect logic.
2. **Remove:** The conditional skip on both queries (`isAdmin ? {} : "skip"`).
3. **Replace:** `useQuery(api.eventTypeConfigs.queries.listEventTypeConfigs, ...)` with `usePreloadedQuery(preloadedEventTypeConfigs)`.
4. **Replace:** `useQuery(api.calendly.oauthQueries.getConnectionStatus, ...)` with `usePreloadedQuery(preloadedConnectionStatus)`.
5. **Remove:** The `SettingsSkeleton` that guarded `currentUser === undefined` and the second skeleton that guarded `eventTypeConfigs === undefined || connectionStatus === undefined` -- preloaded data is available immediately.
6. **Keep:** `usePageTitle("Settings")`, `Tabs` component, `CalendlyConnection`, `EventTypeConfigList`, and all tab UI.

**Client component props signature:**

```tsx
// Path: app/workspace/settings/_components/settings-page-client.tsx
"use client";

import type { Preloaded } from "convex/react";
import { usePreloadedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
// ... other imports

interface SettingsPageClientProps {
  preloadedEventTypeConfigs: Preloaded<
    typeof api.eventTypeConfigs.queries.listEventTypeConfigs
  >;
  preloadedConnectionStatus: Preloaded<
    typeof api.calendly.oauthQueries.getConnectionStatus
  >;
}

export function SettingsPageClient({
  preloadedEventTypeConfigs,
  preloadedConnectionStatus,
}: SettingsPageClientProps) {
  usePageTitle("Settings");
  const eventTypeConfigs = usePreloadedQuery(preloadedEventTypeConfigs);
  const connectionStatus = usePreloadedQuery(preloadedConnectionStatus);

  // Tabs, CalendlyConnection, EventTypeConfigList -- all unchanged
  // ...
}
```

**Data strategy:** Preload both queries via `Promise.all`. Both are deterministic (no time-sensitivity) and always needed on first paint. `usePreloadedQuery` keeps them live after mount.

**What to remove from the client component:**
- `const currentUser = useQuery(api.users.queries.getCurrentUser);`
- `const isAdmin = currentUser?.role === ...;`
- `const eventTypeConfigs = useQuery(..., isAdmin ? {} : "skip");`
- `const connectionStatus = useQuery(..., isAdmin ? {} : "skip");`
- `if (currentUser === undefined) { return <SettingsSkeleton />; }`
- `if (currentUser === null) { return null; }`
- `if (currentUser.role === "closer") { redirect("/workspace/closer"); }`
- `if (eventTypeConfigs === undefined || connectionStatus === undefined) { return <SettingsSkeleton />; }`

The `SettingsSkeleton` component can be removed entirely or kept as a fallback for edge cases. With preloaded data, the component renders with data immediately.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/settings/page.tsx` | Rewrite | RSC wrapper with `requireRole(ADMIN_ROLES)` + `Promise.all([preloadQuery(...), preloadQuery(...)])` |
| `app/workspace/settings/_components/settings-page-client.tsx` | Create | Client page with `usePreloadedQuery` for both config queries, tabs UI |

---

### 3C — Convert `/workspace/pipeline` (Admin, Keep Search Params Client-Side)

**Type:** Full-Stack
**Parallelizable:** Yes -- independent of all other subphases.

**What:** Convert `/workspace/pipeline` from a `"use client"` page that wraps itself in `<Suspense>` for `useSearchParams()` into an RSC wrapper that calls `requireRole(ADMIN_ROLES)`, then renders the client component which retains all URL search param synchronization, filter state, and query execution.

**Why:** This page uses `useSearchParams()` for bidirectional URL filter sync and `useQuery` with dynamic filter args. The search param state must stay client-side because it changes on user interaction without a page navigation. Preloading a filtered query would only cover the initial filter state and add complexity for minimal benefit -- the user often changes filters immediately.

**Where:**
- `app/workspace/pipeline/page.tsx` (rewrite to RSC wrapper)
- `app/workspace/pipeline/_components/pipeline-page-client.tsx` (new)

**How:**

**Step 1: Create the RSC wrapper**

```tsx
// Path: app/workspace/pipeline/page.tsx
import { requireRole } from "@/lib/auth";
import { ADMIN_ROLES } from "@/convex/lib/roleMapping";
import { PipelinePageClient } from "./_components/pipeline-page-client";

export default async function PipelinePage() {
  await requireRole(ADMIN_ROLES);
  return <PipelinePageClient />;
}
```

The wrapper is minimal -- auth only, no preloading. The filter-driven queries stay client-side.

**Step 2: Move existing client logic into `pipeline-page-client.tsx`**

Move the entire `PipelineContent` function (and the wrapping `<Suspense>`) with these changes:

1. **Remove:** `useQuery(api.users.queries.getCurrentUser)` and all role/redirect logic.
2. **Remove:** The conditional skip on both queries (`isAdmin ? queryArgs : "skip"` and `isAdmin ? {} : "skip"`).
3. **Keep:** `useSearchParams()`, `useRouter()`, `usePathname()`, `useMemo` for query args, `setStatusFilter` / `setCloserFilter` URL sync callbacks.
4. **Keep:** `useQuery(api.opportunities.queries.listOpportunitiesForAdmin, queryArgs)` -- this stays as `useQuery` (not preloaded) because the args change when the user interacts with filters.
5. **Keep:** `useQuery(api.users.queries.listTeamMembers, {})` for the closer filter dropdown -- this could optionally be preloaded, but keeping it as `useQuery` maintains simplicity.
6. **Keep:** The `<Suspense>` boundary wrapping the component that uses `useSearchParams()`.
7. **Keep:** `TableSkeleton`, `PipelineFilters`, `OpportunitiesTable`, CSV export, `usePageTitle`.

**Client component props signature:**

```tsx
// Path: app/workspace/pipeline/_components/pipeline-page-client.tsx
"use client";

import { Suspense } from "react";
// ... all other existing imports (useSearchParams, useRouter, etc.)

// No props -- all data is fetched client-side due to filter dynamics
export function PipelinePageClient() {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <PipelineContent />
    </Suspense>
  );
}

function PipelineContent() {
  usePageTitle("Pipeline");
  const searchParams = useSearchParams();
  // ... rest of existing PipelineContent, minus the currentUser/role logic
}
```

**Data strategy:** No preloading. Both queries use dynamic filter args that change on user interaction. The `useQuery` calls remain as-is, but without the `isAdmin ? ... : "skip"` guard since the RSC wrapper guarantees admin access.

**What to remove from the client component:**
- `const currentUser = useQuery(api.users.queries.getCurrentUser);`
- `const isAdmin = currentUser?.role === ...;`
- The `isAdmin ? queryArgs : "skip"` conditional on `listOpportunitiesForAdmin` -- replace with just `queryArgs`.
- The `isAdmin ? {} : "skip"` conditional on `listTeamMembers` -- replace with just `{}`.
- `if (currentUser === undefined) { return <TableSkeleton />; }`
- `if (currentUser === null) { return null; }`
- `if (currentUser.role === "closer") { redirect("/workspace/closer"); }`

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/pipeline/page.tsx` | Rewrite | RSC wrapper with `requireRole(ADMIN_ROLES)`, no preloading |
| `app/workspace/pipeline/_components/pipeline-page-client.tsx` | Create | Client page with `useSearchParams`, filters, `useQuery` for dynamic data |

---

### 3D — Convert `/workspace` Admin Dashboard (Admin, Keep Polling Client-Side)

**Type:** Full-Stack
**Parallelizable:** Yes -- independent of all other subphases.

**What:** Convert `/workspace` (the admin dashboard) from a `"use client"` page that calls `usePollingQuery` for stats with 60-second polling into an RSC wrapper that calls `requireRole(ADMIN_ROLES)`, then renders the client component which retains the polling query.

**Why:** The dashboard uses `usePollingQuery(api.dashboard.adminStats.getAdminDashboardStats, {}, { intervalMs: 60_000 })` for time-sensitive stats (e.g., "meetings today" changes at midnight). Preloading a time-sensitive polling query adds little value -- the stale data would be replaced on the first poll tick anyway.

**Where:**
- `app/workspace/page.tsx` (rewrite to RSC wrapper)
- `app/workspace/_components/dashboard-page-client.tsx` (new)

**How:**

**Step 1: Create the RSC wrapper**

```tsx
// Path: app/workspace/page.tsx
import { requireRole } from "@/lib/auth";
import { ADMIN_ROLES } from "@/convex/lib/roleMapping";
import { DashboardPageClient } from "./_components/dashboard-page-client";

export default async function AdminDashboardPage() {
  const { crmUser } = await requireRole(ADMIN_ROLES);
  return (
    <DashboardPageClient
      displayName={crmUser.fullName ?? crmUser.email}
    />
  );
}
```

The wrapper passes the display name for the greeting, avoiding a `getCurrentUser` call in the client component just for the welcome message.

**Step 2: Move existing client logic into `dashboard-page-client.tsx`**

Move the entire current `page.tsx` content with these changes:

1. **Remove:** `useQuery(api.users.queries.getCurrentUser)` and all role/redirect logic.
2. **Remove:** The conditional skip on the polling query (`user && user.role !== "closer" ? {} : "skip"`).
3. **Keep:** `usePollingQuery(api.dashboard.adminStats.getAdminDashboardStats, {}, { intervalMs: 60_000 })` -- the polling query stays client-side because it is time-sensitive.
4. **Keep:** `DashboardSkeleton`, `StatsRow`, `PipelineSummary`, `SystemHealth`, `usePageTitle`.
5. **Replace:** `{user.fullName ?? user.email}` in the greeting with the `displayName` prop.

**Client component props signature:**

```tsx
// Path: app/workspace/_components/dashboard-page-client.tsx
"use client";

import { usePollingQuery } from "@/hooks/use-polling-query";
import { api } from "@/convex/_generated/api";
// ... other imports

interface DashboardPageClientProps {
  displayName: string;
}

export function DashboardPageClient({ displayName }: DashboardPageClientProps) {
  usePageTitle("Dashboard");

  const stats = usePollingQuery(
    api.dashboard.adminStats.getAdminDashboardStats,
    {},
    { intervalMs: 60_000 },
  );

  if (stats === undefined) {
    return <DashboardSkeleton />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="mt-2 text-muted-foreground">
          Welcome back, {displayName}
        </p>
      </div>
      <StatsRow stats={stats} />
      <PipelineSummary stats={stats} />
      <SystemHealth />
    </div>
  );
}
```

**Data strategy:** No preloading. The stats query uses 60-second polling for time-sensitive data (`meetingsToday` changes at midnight). The `DashboardSkeleton` is retained for the brief initial load while the first poll resolves.

**What to remove from the client component:**
- `const user = useQuery(api.users.queries.getCurrentUser);`
- `user && user.role !== "closer" ? {} : "skip"` conditional on the polling query -- replace with just `{}`.
- `if (user === undefined) { return <DashboardSkeleton />; }`
- `if (user === null) return null;`
- `if (user.role === "closer") { redirect("/workspace/closer"); }`

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/page.tsx` | Rewrite | RSC wrapper with `requireRole(ADMIN_ROLES)`, passes `displayName` prop |
| `app/workspace/_components/dashboard-page-client.tsx` | Create | Client page with `usePollingQuery` for time-sensitive stats |

---

### 3E — Convert `/workspace/closer` Dashboard (Closer, Keep Polling Client-Side)

**Type:** Full-Stack
**Parallelizable:** Yes -- independent of all other subphases.

**What:** Convert `/workspace/closer` from a `"use client"` page into an RSC wrapper that calls `requireRole(["closer"])` and preloads the lighter deterministic queries (`getCloserProfile`, `getPipelineSummary`), while keeping the time-sensitive polling query (`getNextMeeting`) client-side.

**Why:** The closer dashboard has a mix of data strategies: `getCloserProfile` and `getPipelineSummary` are deterministic (depend only on document state), making them good preload candidates. But `getNextMeeting` uses 60-second polling because the "next meeting" result depends on `Date.now()` and can change when a meeting's `scheduledAt` time passes.

**Where:**
- `app/workspace/closer/page.tsx` (rewrite to RSC wrapper)
- `app/workspace/closer/_components/closer-dashboard-page-client.tsx` (new)

**How:**

**Step 1: Create the RSC wrapper**

```tsx
// Path: app/workspace/closer/page.tsx
import { requireRole } from "@/lib/auth";
import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { CloserDashboardPageClient } from "./_components/closer-dashboard-page-client";

export default async function CloserDashboardPage() {
  const { session } = await requireRole(["closer"]);

  const [preloadedProfile, preloadedPipelineSummary] = await Promise.all([
    preloadQuery(
      api.closer.dashboard.getCloserProfile,
      {},
      { token: session.accessToken },
    ),
    preloadQuery(
      api.closer.dashboard.getPipelineSummary,
      {},
      { token: session.accessToken },
    ),
  ]);

  return (
    <CloserDashboardPageClient
      preloadedProfile={preloadedProfile}
      preloadedPipelineSummary={preloadedPipelineSummary}
    />
  );
}
```

**Step 2: Move existing client logic into `closer-dashboard-page-client.tsx`**

Move the entire current `page.tsx` content with these changes:

1. **Replace:** `useQuery(api.closer.dashboard.getCloserProfile)` with `usePreloadedQuery(preloadedProfile)`.
2. **Replace:** `useQuery(api.closer.dashboard.getPipelineSummary)` with `usePreloadedQuery(preloadedPipelineSummary)`.
3. **Keep:** `usePollingQuery(api.closer.dashboard.getNextMeeting, {}, { intervalMs: 60_000 })` client-side -- time-sensitive, not preloaded.
4. **Remove:** The combined loading gate (`profile === undefined || nextMeeting === undefined || pipelineSummary === undefined`) -- only `nextMeeting` can be undefined now. Simplify to check only `nextMeeting`.
5. **Keep:** `UnmatchedBanner`, `FeaturedMeetingCard`, `PipelineStrip`, `CloserEmptyState`, `CalendarView`, `DashboardSkeleton`, `usePageTitle`.

**Client component props signature:**

```tsx
// Path: app/workspace/closer/_components/closer-dashboard-page-client.tsx
"use client";

import type { Preloaded } from "convex/react";
import { usePreloadedQuery } from "convex/react";
import { usePollingQuery } from "@/hooks/use-polling-query";
import { api } from "@/convex/_generated/api";
// ... other imports

interface CloserDashboardPageClientProps {
  preloadedProfile: Preloaded<typeof api.closer.dashboard.getCloserProfile>;
  preloadedPipelineSummary: Preloaded<
    typeof api.closer.dashboard.getPipelineSummary
  >;
}

export function CloserDashboardPageClient({
  preloadedProfile,
  preloadedPipelineSummary,
}: CloserDashboardPageClientProps) {
  usePageTitle("My Dashboard");

  const profile = usePreloadedQuery(preloadedProfile);
  const pipelineSummary = usePreloadedQuery(preloadedPipelineSummary);

  // Polling query stays client-side — time-sensitive
  const nextMeeting = usePollingQuery(
    api.closer.dashboard.getNextMeeting,
    {},
    { intervalMs: 60_000 },
  );

  if (nextMeeting === undefined) {
    return <DashboardSkeleton />;
  }

  // ... rest of render unchanged (greeting, UnmatchedBanner, etc.)
}
```

**Data strategy:** Preload `getCloserProfile` and `getPipelineSummary` (deterministic, always needed). Keep `getNextMeeting` as a client-side polling query (time-sensitive, `Date.now()`-dependent).

**What to remove from the client component:**
- `const profile = useQuery(api.closer.dashboard.getCloserProfile);`
- `const pipelineSummary = useQuery(api.closer.dashboard.getPipelineSummary);`
- The combined `profile === undefined || ... || pipelineSummary === undefined` loading gate (simplify to only check `nextMeeting`).

**Note:** No role redirect logic exists in the current closer dashboard (it is already a closer-only route). The RSC wrapper's `requireRole(["closer"])` adds the enforcement that was previously implicit.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/page.tsx` | Rewrite | RSC wrapper with `requireRole(["closer"])` + `Promise.all` preloading profile and pipeline summary |
| `app/workspace/closer/_components/closer-dashboard-page-client.tsx` | Create | Client page with `usePreloadedQuery` for profile/pipeline, `usePollingQuery` for next meeting |

---

### 3F — Convert `/workspace/closer/pipeline` (Closer, Keep Filters Client-Side)

**Type:** Full-Stack
**Parallelizable:** Yes -- independent of all other subphases.

**What:** Convert `/workspace/closer/pipeline` from a `"use client"` page into an RSC wrapper that calls `requireRole(["closer"])`, then renders the client component which retains all `useSearchParams()` filter state, status tab sync, and client-side queries.

**Why:** Like the admin pipeline (3C), this page uses `useSearchParams()` for bidirectional URL filter sync. The `listMyOpportunities` query takes a `statusFilter` arg that changes on every tab click. Preloading would only cover the initial filter state.

**Where:**
- `app/workspace/closer/pipeline/page.tsx` (rewrite to RSC wrapper)
- `app/workspace/closer/pipeline/_components/closer-pipeline-page-client.tsx` (new)

**How:**

**Step 1: Create the RSC wrapper**

```tsx
// Path: app/workspace/closer/pipeline/page.tsx
import { requireRole } from "@/lib/auth";
import { CloserPipelinePageClient } from "./_components/closer-pipeline-page-client";

export default async function CloserPipelinePage() {
  await requireRole(["closer"]);
  return <CloserPipelinePageClient />;
}
```

Minimal wrapper -- auth only, no preloading.

**Step 2: Move existing client logic into `closer-pipeline-page-client.tsx`**

Move the entire current `page.tsx` content. The current closer pipeline page has no `useQuery(getCurrentUser)` call and no role redirect -- it relies entirely on the layout for auth. The wrapper now adds explicit `requireRole(["closer"])` enforcement.

Changes:

1. **Keep everything as-is.** This page has no `getCurrentUser` call to remove.
2. **Keep:** `useSearchParams()`, `useRouter()`, `usePathname()`, `useState<OpportunityStatus | undefined>`, `handleStatusChange` URL sync callback.
3. **Keep:** `useQuery(api.closer.dashboard.getPipelineSummary)` and `useQuery(api.closer.pipeline.listMyOpportunities, { statusFilter })` -- both use client-side dynamic args.
4. **Keep:** `StatusTabs`, `OpportunityTable`, `CloserEmptyState`, `PipelineSkeleton`, `usePageTitle`.

**Client component props signature:**

```tsx
// Path: app/workspace/closer/pipeline/_components/closer-pipeline-page-client.tsx
"use client";

// ... all existing imports (useSearchParams, useRouter, useQuery, etc.)

// No props -- all data is fetched client-side due to filter dynamics
export function CloserPipelinePageClient() {
  usePageTitle("My Pipeline");
  const searchParams = useSearchParams();
  // ... rest of existing CloserPipelinePage, unchanged
}
```

**Data strategy:** No preloading. Both queries use dynamic filter args. The component is effectively a rename + extraction.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/pipeline/page.tsx` | Rewrite | RSC wrapper with `requireRole(["closer"])`, no preloading |
| `app/workspace/closer/pipeline/_components/closer-pipeline-page-client.tsx` | Create | Client page, mostly unchanged from current `page.tsx` |

---

### 3G — Convert `/workspace/closer/meetings/[meetingId]` (Closer, Preload or Keep Polling)

**Type:** Full-Stack
**Parallelizable:** Yes -- independent of all other subphases.

**What:** Convert the meeting detail page from a `"use client"` page that uses `useParams()` to extract `meetingId` and `usePollingQuery` for one-shot fetching into an RSC wrapper that calls `requireRole(["closer"])`, extracts `meetingId` from the route params, and preloads the meeting detail.

**Why:** This is a dynamic route that depends on a URL parameter. The current page uses `usePollingQuery` for one-shot fetching (not continuous polling). Preloading the initial detail gives the closer instant content on first paint, which is valuable because this is a deep-link destination (closers click through from the pipeline table or featured meeting card).

**Where:**
- `app/workspace/closer/meetings/[meetingId]/page.tsx` (rewrite to RSC wrapper)
- `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` (new)

**How:**

**Step 1: Create the RSC wrapper**

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/page.tsx
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

  return (
    <MeetingDetailPageClient
      preloadedDetail={preloadedDetail}
      meetingId={meetingId as Id<"meetings">}
    />
  );
}
```

**Note on `params`:** In Next.js 16.x, `params` is a `Promise` that must be awaited. The type annotation `params: Promise<{ meetingId: string }>` matches the design document convention.

**Step 2: Move existing client logic into `meeting-detail-page-client.tsx`**

Move the entire current `page.tsx` content with these changes:

1. **Remove:** `const params = useParams();` and `const meetingId = params.meetingId as Id<"meetings">;` -- the `meetingId` is now a prop from the RSC wrapper.
2. **Replace:** `usePollingQuery(api.closer.meetingDetail.getMeetingDetail, { meetingId })` with `usePreloadedQuery(preloadedDetail)`. The preloaded data provides instant first paint, and `usePreloadedQuery` subscribes to live updates.
3. **Keep:** `useRouter()` for back navigation, `useState` for `leadName` page title, `MeetingDetailSkeleton`, `MeetingNotFound`, and all sub-panels (`LeadInfoPanel`, `MeetingInfoPanel`, `MeetingNotes`, `PaymentLinksPanel`, `OutcomeActionBar`).
4. **Keep:** `usePageTitle` with dynamic lead name.

**Client component props signature:**

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx
"use client";

import type { Preloaded } from "convex/react";
import { usePreloadedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
// ... other imports

interface MeetingDetailPageClientProps {
  preloadedDetail: Preloaded<
    typeof api.closer.meetingDetail.getMeetingDetail
  >;
  meetingId: Id<"meetings">;
}

export function MeetingDetailPageClient({
  preloadedDetail,
  meetingId,
}: MeetingDetailPageClientProps) {
  const router = useRouter();
  const [leadName, setLeadName] = useState<string | undefined>(undefined);
  usePageTitle(leadName ?? "Meeting");

  const detail = usePreloadedQuery(preloadedDetail);

  // Update page title when detail loads
  if (detail && detail.lead?.fullName && leadName !== detail.lead.fullName) {
    setLeadName(detail.lead.fullName);
  }

  // ... rest of render unchanged
}
```

**Data strategy:** Preload `getMeetingDetail` by route param. The current page uses `usePollingQuery` as a one-shot fetch (no continuous polling interval), so preloading provides strictly better UX -- the closer sees meeting content immediately instead of a skeleton. `usePreloadedQuery` subscribes to live updates after mount, so real-time changes (notes saved, status changed) are still reflected.

**What to remove from the client component:**
- `const params = useParams();`
- `const meetingId = params.meetingId as Id<"meetings">;`
- `const detail = usePollingQuery(api.closer.meetingDetail.getMeetingDetail, { meetingId });`
- The `refreshDetail` no-op callback can be removed or replaced with `router.refresh()` if needed.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/[meetingId]/page.tsx` | Rewrite | RSC wrapper with `requireRole(["closer"])` + `preloadQuery` by route param |
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | Create | Client page with `usePreloadedQuery` for meeting detail |

---

### 3H — Convert `/workspace/profile` (Any Workspace User)

**Type:** Full-Stack
**Parallelizable:** Yes -- independent of all other subphases.

**What:** Convert `/workspace/profile` from a `"use client"` page into an RSC wrapper that calls `requireWorkspaceUser()` (not `requireRole` -- any authenticated active workspace user can view their own profile) and preloads the current user data.

**Why:** The profile page is the simplest conversion. It uses a single `useQuery(getCurrentUser)` call, has no role gating beyond workspace access, and the user data is a perfect preload candidate.

**Where:**
- `app/workspace/profile/page.tsx` (rewrite to RSC wrapper)
- `app/workspace/profile/_components/profile-page-client.tsx` (new)

**How:**

**Step 1: Create the RSC wrapper**

```tsx
// Path: app/workspace/profile/page.tsx
import { requireWorkspaceUser } from "@/lib/auth";
import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { ProfilePageClient } from "./_components/profile-page-client";

export default async function ProfilePage() {
  const { session } = await requireWorkspaceUser();

  const preloadedProfile = await preloadQuery(
    api.users.queries.getCurrentUser,
    {},
    { token: session.accessToken },
  );

  return <ProfilePageClient preloadedProfile={preloadedProfile} />;
}
```

**Step 2: Move existing client logic into `profile-page-client.tsx`**

Move the entire current `page.tsx` content with these changes:

1. **Remove:** `useQuery(api.users.queries.getCurrentUser)` -- replace with `usePreloadedQuery(preloadedProfile)`.
2. **Remove:** `if (user === undefined) { return <ProfileSkeleton />; }` and `if (user === null) { return null; }` -- preloaded data is always available, and the RSC wrapper guarantees a valid workspace user.
3. **Keep:** `usePageTitle("Profile")`, the `Card` layout, `InfoRow` helper component, and all field rendering (name, email, role, Calendly status).
4. **Keep:** The `ProfileSkeleton` can be removed or kept as an export for potential reuse elsewhere.

**Client component props signature:**

```tsx
// Path: app/workspace/profile/_components/profile-page-client.tsx
"use client";

import type { Preloaded } from "convex/react";
import { usePreloadedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
// ... other imports

interface ProfilePageClientProps {
  preloadedProfile: Preloaded<typeof api.users.queries.getCurrentUser>;
}

export function ProfilePageClient({
  preloadedProfile,
}: ProfilePageClientProps) {
  usePageTitle("Profile");
  const user = usePreloadedQuery(preloadedProfile);

  // The RSC wrapper guarantees a valid user, but usePreloadedQuery
  // can return null if the document is deleted between preload and render.
  // Handle gracefully.
  if (!user) return null;

  return (
    <div className="mx-auto max-w-2xl flex flex-col gap-6">
      {/* ... existing profile card unchanged ... */}
    </div>
  );
}
```

**Data strategy:** Preload `getCurrentUser`. Simple, deterministic, always needed. The profile page has no filters, no polling, and no pagination.

**What to remove from the client component:**
- `const user = useQuery(api.users.queries.getCurrentUser);`
- `if (user === undefined) { return <ProfileSkeleton />; }`
- `if (user === null) { return null; }` (keep a lighter null guard for edge cases)

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/profile/page.tsx` | Rewrite | RSC wrapper with `requireWorkspaceUser()` + `preloadQuery(getCurrentUser)` |
| `app/workspace/profile/_components/profile-page-client.tsx` | Create | Client page with `usePreloadedQuery` for user data |

---

### 3I — Convert `/admin` (System Admin, Auth Wrapper Only)

**Type:** Full-Stack
**Parallelizable:** Yes -- independent of all other subphases.

**What:** Convert `/admin` from a `"use client"` page that checks `organizationId === SYSTEM_ADMIN_ORG_ID` into an RSC wrapper that calls `requireSystemAdmin()`, then renders the existing page content as a client component. No preloading -- the page uses `usePaginatedQuery`, which has no preload equivalent.

**Why:** The admin page is the most complex current page (590+ lines) with `usePaginatedQuery`, `useAction`, dynamic imports, gate screens, pagination controls, and tenant management dialogs. The RSC wrapper replaces the client-side gate screens (loading/auth checks) with server-side authorization, eliminating the flash of unauthorized content. The paginated data stays client-side because `usePaginatedQuery` has no `preloadQuery` equivalent.

**Where:**
- `app/admin/page.tsx` (rewrite to RSC wrapper)
- `app/admin/_components/admin-page-client.tsx` (new)

**How:**

**Step 1: Create the RSC wrapper**

```tsx
// Path: app/admin/page.tsx
import { requireSystemAdmin } from "@/lib/auth";
import { AdminPageClient } from "./_components/admin-page-client";

export default async function AdminPage() {
  await requireSystemAdmin();
  return <AdminPageClient />;
}
```

The wrapper is minimal -- auth only. All data and interaction stays client-side.

**Step 2: Move existing client logic into `admin-page-client.tsx`**

Move the entire current `page.tsx` content with these changes:

1. **Remove:** `useConvexAuth()` and `const { isAuthenticated, isLoading } = useConvexAuth();` -- the RSC wrapper guarantees authentication.
2. **Remove:** `const { organizationId, signOut, loading: authLoading } = useAuth();` -- the organization check is handled by `requireSystemAdmin()`. Keep `useAuth()` only for `signOut()` if the page's sign-out button is retained.
3. **Remove:** `const isSystemAdmin = organizationId === SYSTEM_ADMIN_ORG_ID;` and `const canQuery = isAuthenticated && !authLoading && isSystemAdmin;` -- replace with a simple `true` or remove the conditional entirely.
4. **Remove:** The `canQuery ? { statusFilter } : "skip"` conditional on `usePaginatedQuery` -- replace with just `{ statusFilter }`.
5. **Remove:** The three gate screen conditionals at the bottom of the component (`isLoading || authLoading`, `!isAuthenticated`, `!isSystemAdmin`) -- the RSC wrapper handles all of these server-side.
6. **Remove:** The `GateScreen` component entirely (no longer needed).
7. **Remove:** `import { SYSTEM_ADMIN_ORG_ID } from "@/lib/system-admin-org";` -- no longer needed in the client component.
8. **Keep:** `usePaginatedQuery(api.admin.tenantsQueries.listTenants, { statusFilter }, ...)` -- stays client-side (no preload equivalent).
9. **Keep:** `useAction` calls for `createTenantInvite`, `regenerateInvite`, `deleteTenant`.
10. **Keep:** All state management (`statusFilter`, `dialogOpen`, `inviteResult`, `tenantToReset`), dynamic imports (`CreateTenantDialog`, `ResetTenantDialog`), `InviteBanner`, `TenantRow`, `StatusBadge`, `InviteExpiry`, `computeStats`, toast helpers.
11. **Keep:** `useAuth()` for the `signOut()` function used by the sign-out button in the header.
12. **Keep:** `usePageTitle("Admin Console")`.

**Client component props signature:**

```tsx
// Path: app/admin/_components/admin-page-client.tsx
"use client";

import { usePaginatedQuery, useAction } from "convex/react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { api } from "@/convex/_generated/api";
// ... all other existing imports minus SYSTEM_ADMIN_ORG_ID, useConvexAuth

// No props — all data is fetched client-side (usePaginatedQuery)
export function AdminPageClient() {
  usePageTitle("Admin Console");
  const { signOut } = useAuth();

  const [statusFilter, setStatusFilter] = useState<TenantStatus | undefined>(
    undefined,
  );
  // ... rest of existing state

  const {
    results: tenants,
    status: paginationStatus,
    loadMore,
  } = usePaginatedQuery(
    api.admin.tenantsQueries.listTenants,
    { statusFilter },
    { initialNumItems: PAGE_SIZE },
  );

  // ... handlers, render (minus gate screens)
}
```

**Data strategy:** No preloading. `usePaginatedQuery` has no preload equivalent. The RSC wrapper provides server-side auth; the client component owns all data fetching and pagination.

**What to remove from the client component:**
- `const { isAuthenticated, isLoading } = useConvexAuth();`
- `const { organizationId, signOut, loading: authLoading } = useAuth();` (keep `useAuth()` for `signOut()` only)
- `const isSystemAdmin = organizationId === SYSTEM_ADMIN_ORG_ID;`
- `const canQuery = isAuthenticated && !authLoading && isSystemAdmin;`
- The `canQuery ? { statusFilter } : "skip"` conditional -- replace with `{ statusFilter }`.
- The three gate screen conditional blocks (`if (isLoading || authLoading)`, `if (!isAuthenticated)`, `if (!isSystemAdmin)`).
- The `GateScreen` component definition.
- The `SYSTEM_ADMIN_ORG_ID` import.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/admin/page.tsx` | Rewrite | RSC wrapper with `requireSystemAdmin()`, no preloading |
| `app/admin/_components/admin-page-client.tsx` | Create | Client page with `usePaginatedQuery`, all tenant management UI, minus gate screens |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/team/page.tsx` | Rewrite | 3A |
| `app/workspace/team/_components/team-page-client.tsx` | Create | 3A |
| `app/workspace/settings/page.tsx` | Rewrite | 3B |
| `app/workspace/settings/_components/settings-page-client.tsx` | Create | 3B |
| `app/workspace/pipeline/page.tsx` | Rewrite | 3C |
| `app/workspace/pipeline/_components/pipeline-page-client.tsx` | Create | 3C |
| `app/workspace/page.tsx` | Rewrite | 3D |
| `app/workspace/_components/dashboard-page-client.tsx` | Create | 3D |
| `app/workspace/closer/page.tsx` | Rewrite | 3E |
| `app/workspace/closer/_components/closer-dashboard-page-client.tsx` | Create | 3E |
| `app/workspace/closer/pipeline/page.tsx` | Rewrite | 3F |
| `app/workspace/closer/pipeline/_components/closer-pipeline-page-client.tsx` | Create | 3F |
| `app/workspace/closer/meetings/[meetingId]/page.tsx` | Rewrite | 3G |
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | Create | 3G |
| `app/workspace/profile/page.tsx` | Rewrite | 3H |
| `app/workspace/profile/_components/profile-page-client.tsx` | Create | 3H |
| `app/admin/page.tsx` | Rewrite | 3I |
| `app/admin/_components/admin-page-client.tsx` | Create | 3I |
