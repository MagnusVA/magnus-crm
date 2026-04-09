# Phase 3 — Suspense Boundaries & Granular Streaming

**Goal:** Break the admin and closer dashboard pages from monolithic "thin server wrapper → full-page client skeleton" into independently streaming sections. Each widget/section gets its own `<Suspense>` boundary so stats cards, pipeline summaries, calendar views, and system health stream in parallel rather than waiting for all data before showing anything. After this phase, the first dashboard section renders within 200ms while slower sections continue streaming.

**Prerequisite:** Phase 2 complete (workspace layout restructured with PPR static shell + Suspense-wrapped auth).

**Runs in PARALLEL with:** Nothing — Phase 4 depends on the Suspense boundary structure for view transitions and lazy loading.

> **Critical path:** This phase is on the critical path (Phase 1 → Phase 2 → Phase 3 → Phase 4).

**Skills to invoke:**
- `next-best-practices` — Suspense boundary placement, data patterns, avoiding waterfalls with `Promise.all()`, async Server Component streaming
- `vercel-react-best-practices` — `server-parallel-fetching` (CRITICAL — restructure to parallelize), `async-suspense-boundaries` (HIGH — stream instead of block), `rendering-hoist-jsx`
- `shadcn` — using `Skeleton`, `Card` components for inline skeleton fallbacks
- `web-design-guidelines` — `aria-live="polite"` for streamed content, CLS prevention rules

**Acceptance Criteria:**
1. Admin dashboard (`/workspace`) renders the header immediately, then stats cards, pipeline summary, and system health stream in independently — visible as sequential content appearing in the browser.
2. Closer dashboard (`/workspace/closer`) renders the header immediately, then featured meeting, pipeline strip, and calendar stream in independently.
3. Each Suspense fallback matches the dimensions of its resolved content (CLS < 0.1 for all dashboard sections).
4. If one section's data fetch fails, other sections still render — errors are contained per-Suspense boundary.
5. Granular skeleton components exist in `app/workspace/_components/skeletons/` for reuse.
6. `preloadQuery()` calls are started in parallel via `Promise.all()` on the server — no sequential waterfalls.
7. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (Granular skeleton components) ──────────────────────────────────┐
                                                                     ├── 3D (Closer dashboard granular streaming)
3B (Admin dashboard granular streaming) ─────────────────────────────┤
                                                                     │
3C (Dashboard header components) ───────────────────────────────────┘
```

**Optimal execution:**
1. Start 3A and 3C in parallel — skeletons and header components are pure UI with no data dependencies.
2. Once 3A is done → start 3B and 3D in parallel — they depend on the skeleton components.
3. (3C can finish at any time — 3B and 3D use the header components.)

**Estimated time:** 2 hours

---

## Subphases

### 3A — Granular Skeleton Components

**Type:** Frontend
**Parallelizable:** Yes — pure UI components with no data dependencies.

**What:** Create reusable skeleton components for individual dashboard sections: stats row, pipeline summary, system health, featured meeting, pipeline strip, calendar. These are used as `<Suspense>` fallbacks in the granular streaming pages.

**Why:** Each `<Suspense>` boundary needs a fallback that matches the resolved content's dimensions to prevent CLS. Extracting these into a shared `skeletons/` directory avoids duplication between the full-page `loading.tsx` skeletons and the inline Suspense fallbacks.

**Where:**
- `app/workspace/_components/skeletons/stats-row-skeleton.tsx` (new)
- `app/workspace/_components/skeletons/pipeline-summary-skeleton.tsx` (new)
- `app/workspace/_components/skeletons/system-health-skeleton.tsx` (new)

**How:**

**Step 1: Create the skeletons directory and stats row skeleton**

```typescript
// Path: app/workspace/_components/skeletons/stats-row-skeleton.tsx
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Skeleton for the 4-column stats row on the admin dashboard.
 * Matches: h-4 label + h-8 value + h-3 subtitle per card.
 */
export function StatsRowSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i}>
          <CardHeader className="pb-3">
            <Skeleton className="h-4 w-24" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-8 w-16" />
            <Skeleton className="mt-2 h-3 w-32" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
```

**Step 2: Create the pipeline summary skeleton**

```typescript
// Path: app/workspace/_components/skeletons/pipeline-summary-skeleton.tsx
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Skeleton for the pipeline summary card on the admin dashboard.
 * Matches: h-6 heading + 3 rows of h-12 status bars.
 */
export function PipelineSummarySkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-6 w-36" />
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
```

**Step 3: Create the system health skeleton**

```typescript
// Path: app/workspace/_components/skeletons/system-health-skeleton.tsx
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Skeleton for the system health card on the admin dashboard.
 * Matches: h-6 heading + h-20 content area.
 */
export function SystemHealthSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-6 w-32" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-20 w-full" />
      </CardContent>
    </Card>
  );
}
```

**Key implementation notes:**
- These are Server Components (no `"use client"`) — they render pure JSX as Suspense fallbacks.
- Skeleton dimensions are derived from the actual dashboard components. If component dimensions change, these must be updated to match.
- The same `StatsRowSkeleton` dimensions match what's in `app/workspace/loading.tsx` — consider importing these skeletons into `loading.tsx` to avoid duplication, or keep them separate for independent evolution.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/skeletons/stats-row-skeleton.tsx` | Create | 4-column stats card skeleton |
| `app/workspace/_components/skeletons/pipeline-summary-skeleton.tsx` | Create | Pipeline summary card skeleton |
| `app/workspace/_components/skeletons/system-health-skeleton.tsx` | Create | System health card skeleton |

---

### 3B — Admin Dashboard Granular Streaming

**Type:** Full-Stack
**Parallelizable:** Yes (after 3A) — touches only `/workspace/page.tsx` and admin dashboard section components.

**What:** Refactor `app/workspace/page.tsx` from the current "thin server wrapper → monolithic `DashboardPageClient`" pattern to a server page with multiple `<Suspense>` boundaries. Each section (stats, pipeline summary, system health) gets its own boundary and streams independently.

**Why:** Currently, `DashboardPageClient` shows a full-page skeleton until ALL data arrives via `usePollingQuery`. With granular Suspense, each section resolves independently — stats cards can appear in 150ms while the pipeline summary (a heavier query) takes 300ms. The user sees progressive content instead of a blank page.

**Where:**
- `app/workspace/page.tsx` (modify)
- `app/workspace/_components/dashboard-header.tsx` (new)
- `app/workspace/_components/stats-section.tsx` (new)
- `app/workspace/_components/pipeline-section.tsx` (new)
- `app/workspace/_components/system-health-section.tsx` (new)

**How:**

**Step 1: Create the dashboard header (pure component, no data)**

```typescript
// Path: app/workspace/_components/dashboard-header.tsx

/**
 * Dashboard header — renders immediately with no data dependency.
 * Display name comes from requireRole() in the parent server page.
 */
export function DashboardHeader({ displayName }: { displayName: string }) {
  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
      <p className="mt-2 text-muted-foreground">
        Welcome back, {displayName}
      </p>
    </div>
  );
}
```

**Step 2: Create async server section components**

Each section is an async Server Component that fetches its own data and renders the result. They stream independently because each is wrapped in its own `<Suspense>`.

```typescript
// Path: app/workspace/_components/stats-section.tsx
import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { StatsRow } from "./stats-row";

/**
 * Async server component that fetches and renders admin stats.
 * Wrapped in <Suspense> by the parent page — streams independently.
 */
export async function StatsSection() {
  const preloadedStats = await preloadQuery(
    api.dashboard.adminStats.getAdminDashboardStats,
    {},
  );

  return <StatsRow preloadedStats={preloadedStats} />;
}
```

```typescript
// Path: app/workspace/_components/pipeline-section.tsx
import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { PipelineSummary } from "./pipeline-summary";

/**
 * Async server component that fetches and renders pipeline summary.
 * Wrapped in <Suspense> by the parent page — streams independently.
 */
export async function PipelineSection() {
  const preloadedSummary = await preloadQuery(
    api.dashboard.adminStats.getPipelineSummary,
    {},
  );

  return <PipelineSummary preloadedSummary={preloadedSummary} />;
}
```

```typescript
// Path: app/workspace/_components/system-health-section.tsx
import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { SystemHealth } from "./system-health";

/**
 * Async server component that fetches and renders system health.
 * Wrapped in <Suspense> by the parent page — streams independently.
 */
export async function SystemHealthSection() {
  const preloadedHealth = await preloadQuery(
    api.dashboard.adminStats.getSystemHealth,
    {},
  );

  return <SystemHealth preloadedHealth={preloadedHealth} />;
}
```

> **Implementation note:** The exact Convex API functions (`getAdminDashboardStats`, `getPipelineSummary`, `getSystemHealth`) should be verified against the actual Convex function names in the codebase. The current `DashboardPageClient` uses `usePollingQuery(api.dashboard.adminStats.getAdminDashboardStats)` — the section components should call the same functions via `preloadQuery()`.

**Step 3: Refactor the admin dashboard page**

```typescript
// Path: app/workspace/page.tsx

// BEFORE:
import { ADMIN_ROLES } from "@/convex/lib/roleMapping";
import { requireRole } from "@/lib/auth";
import { DashboardPageClient } from "./_components/dashboard-page-client";

export default async function AdminDashboardPage() {
  const { crmUser } = await requireRole(ADMIN_ROLES);

  return (
    <DashboardPageClient displayName={crmUser.fullName ?? crmUser.email} />
  );
}
```

```typescript
// Path: app/workspace/page.tsx

// AFTER:
import { Suspense } from "react";
import { ADMIN_ROLES } from "@/convex/lib/roleMapping";
import { requireRole } from "@/lib/auth";
import { DashboardHeader } from "./_components/dashboard-header";
import { StatsSection } from "./_components/stats-section";
import { PipelineSection } from "./_components/pipeline-section";
import { SystemHealthSection } from "./_components/system-health-section";
import { StatsRowSkeleton } from "./_components/skeletons/stats-row-skeleton";
import { PipelineSummarySkeleton } from "./_components/skeletons/pipeline-summary-skeleton";
import { SystemHealthSkeleton } from "./_components/skeletons/system-health-skeleton";

export default async function AdminDashboardPage() {
  const { crmUser } = await requireRole(ADMIN_ROLES);

  return (
    <div className="flex flex-col gap-6">
      {/* Header renders immediately — no data dependency */}
      <DashboardHeader displayName={crmUser.fullName ?? crmUser.email} />

      {/* Each section streams independently */}
      <Suspense fallback={<StatsRowSkeleton />}>
        <StatsSection />
      </Suspense>

      <Suspense fallback={<PipelineSummarySkeleton />}>
        <PipelineSection />
      </Suspense>

      <Suspense fallback={<SystemHealthSkeleton />}>
        <SystemHealthSection />
      </Suspense>
    </div>
  );
}
```

**Key implementation notes:**
- `requireRole()` is called at the page level (not inside each section) — it accesses cookies via `withAuth()` and must resolve before page content renders. This is acceptable because the workspace layout's `WorkspaceAuth` already resolved auth — `requireRole()` should be fast (cached session).
- Each section component is an independent async Server Component. React streams them in parallel — the HTML for each arrives independently via chunked transfer encoding.
- The existing `DashboardPageClient` is not deleted — it can be kept for reference or used as a fallback. The section components replace its monolithic rendering with granular streaming.
- `preloadQuery()` returns a serializable `Preloaded` state. The client components (`StatsRow`, `PipelineSummary`, `SystemHealth`) use `usePreloadedQuery()` to hydrate reactively. This means the initial render is server-preloaded (fast) and subsequent updates come via Convex real-time subscriptions.
- If a section's `preloadQuery()` fails, that section's Suspense boundary catches it (error propagates to the nearest `error.tsx`). Other sections continue to render normally.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/page.tsx` | Modify | Granular Suspense boundaries |
| `app/workspace/_components/dashboard-header.tsx` | Create | Pure header component |
| `app/workspace/_components/stats-section.tsx` | Create | Async stats server component |
| `app/workspace/_components/pipeline-section.tsx` | Create | Async pipeline server component |
| `app/workspace/_components/system-health-section.tsx` | Create | Async system health server component |

---

### 3C — Dashboard Header Components

**Type:** Frontend
**Parallelizable:** Yes — pure UI components with no data dependencies or shared files with other subphases.

**What:** Create the closer dashboard header component (parallel to the admin `DashboardHeader` created in 3B).

**Why:** Both dashboard pages need a header that renders immediately without data dependencies. Extracting them as pure components ensures they appear instantly while data-dependent sections stream in behind them.

**Where:**
- `app/workspace/closer/_components/closer-dashboard-header.tsx` (new)

**How:**

**Step 1: Create the closer dashboard header**

```typescript
// Path: app/workspace/closer/_components/closer-dashboard-header.tsx
"use client";

import { usePreloadedQuery } from "convex/react";
import type { Preloaded } from "convex/nextjs";
import type { api } from "@/convex/_generated/api";

/**
 * Closer dashboard header — renders the closer's name and greeting.
 * Receives preloaded profile data from the parent server page.
 */
export function CloserDashboardHeader({
  preloadedProfile,
}: {
  preloadedProfile: Preloaded<typeof api.closer.dashboard.getCloserProfile>;
}) {
  const profile = usePreloadedQuery(preloadedProfile);

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">
        {profile?.greeting ?? "Welcome"}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {profile?.subtitle ?? "Here's your day at a glance."}
      </p>
    </div>
  );
}
```

> **Implementation note:** The exact shape of the `getCloserProfile` response should be verified against the Convex function. The current `CloserDashboardPageClient` likely accesses `profile.fullName` or similar — adapt the header accordingly.

**Key implementation notes:**
- The closer header uses `usePreloadedQuery` for reactive updates (name change mid-session).
- The admin `DashboardHeader` (created in 3B) is a pure Server Component — it receives `displayName` as a string prop from `requireRole()`. The closer header is a Client Component because it uses `usePreloadedQuery`.
- Both headers render before any dashboard data streams in — they're outside the data-dependent Suspense boundaries.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/_components/closer-dashboard-header.tsx` | Create | Closer greeting header |

---

### 3D — Closer Dashboard Granular Streaming

**Type:** Full-Stack
**Parallelizable:** Yes (after 3A) — touches only `/workspace/closer/page.tsx` and closer section components. No overlap with 3B.

**What:** Refactor `app/workspace/closer/page.tsx` from passing all preloaded data to a monolithic `CloserDashboardPageClient` to a server page with multiple `<Suspense>` boundaries for featured meeting, pipeline strip, and calendar sections.

**Why:** Currently, the closer dashboard awaits `Promise.all([preloadedProfile, preloadedPipelineSummary])` and passes both to a single client component. With granular Suspense, the header can render immediately (profile resolves fast), the pipeline strip streams in next, and the calendar (heaviest) streams last. Each section appears as its data arrives.

**Where:**
- `app/workspace/closer/page.tsx` (modify)
- `app/workspace/closer/_components/featured-meeting-section.tsx` (new)
- `app/workspace/closer/_components/pipeline-strip-section.tsx` (new)
- `app/workspace/closer/_components/calendar-section.tsx` (new)

**How:**

**Step 1: Create async section components for the closer dashboard**

```typescript
// Path: app/workspace/closer/_components/featured-meeting-section.tsx
import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { FeaturedMeetingCard } from "./featured-meeting-card";

/**
 * Async server component for the featured/next meeting card.
 * Streams independently in its own Suspense boundary.
 */
export async function FeaturedMeetingSection() {
  // Note: requires session token for auth — may need to receive token as prop
  // or use a shared auth context. Verify during implementation.
  const preloadedMeeting = await preloadQuery(
    api.closer.dashboard.getNextMeeting,
    {},
  );

  return <FeaturedMeetingCard preloadedMeeting={preloadedMeeting} />;
}
```

```typescript
// Path: app/workspace/closer/_components/pipeline-strip-section.tsx
"use client";

import { usePreloadedQuery } from "convex/react";
import type { Preloaded } from "convex/nextjs";
import type { api } from "@/convex/_generated/api";
import { PipelineStrip } from "./pipeline-strip";

/**
 * Client component that renders the pipeline status strip.
 * Receives preloaded data from the parent server page.
 */
export function PipelineStripSection({
  preloadedPipelineSummary,
}: {
  preloadedPipelineSummary: Preloaded<typeof api.closer.dashboard.getPipelineSummary>;
}) {
  const summary = usePreloadedQuery(preloadedPipelineSummary);

  if (!summary) return null;

  return <PipelineStrip summary={summary} />;
}
```

```typescript
// Path: app/workspace/closer/_components/calendar-section.tsx
"use client";

import { CalendarView } from "./calendar-view";

/**
 * Calendar section — wraps the calendar view.
 * In Phase 4, this will be lazy-loaded via dynamic().
 */
export function CalendarSection() {
  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold tracking-tight text-pretty">
        My Schedule
      </h2>
      <CalendarView />
    </div>
  );
}
```

**Step 2: Refactor the closer dashboard page**

```typescript
// Path: app/workspace/closer/page.tsx

// BEFORE:
import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { requireRole } from "@/lib/auth";
import { CloserDashboardPageClient } from "./_components/closer-dashboard-page-client";

export default async function CloserDashboardPage() {
  const { session } = await requireRole(["closer"]);

  const [preloadedProfile, preloadedPipelineSummary] = await Promise.all([
    preloadQuery(api.closer.dashboard.getCloserProfile, {}, {
      token: session.accessToken,
    }),
    preloadQuery(api.closer.dashboard.getPipelineSummary, {}, {
      token: session.accessToken,
    }),
  ]);

  return (
    <CloserDashboardPageClient
      preloadedProfile={preloadedProfile}
      preloadedPipelineSummary={preloadedPipelineSummary}
    />
  );
}
```

```typescript
// Path: app/workspace/closer/page.tsx

// AFTER:
import { Suspense } from "react";
import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { requireRole } from "@/lib/auth";
import { CloserDashboardHeader } from "./_components/closer-dashboard-header";
import { FeaturedMeetingSection } from "./_components/featured-meeting-section";
import { PipelineStripSection } from "./_components/pipeline-strip-section";
import { CalendarSection } from "./_components/calendar-section";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";

export default async function CloserDashboardPage() {
  const { session } = await requireRole(["closer"]);

  // Start all preloads in parallel — no sequential waterfall
  const [preloadedProfile, preloadedPipelineSummary] = await Promise.all([
    preloadQuery(api.closer.dashboard.getCloserProfile, {}, {
      token: session.accessToken,
    }),
    preloadQuery(api.closer.dashboard.getPipelineSummary, {}, {
      token: session.accessToken,
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      {/* Header streams in with profile data */}
      <Suspense fallback={<Skeleton className="h-14 w-64" />}>
        <CloserDashboardHeader preloadedProfile={preloadedProfile} />
      </Suspense>

      {/* Featured meeting */}
      <Suspense fallback={<Skeleton className="h-[180px] rounded-xl" />}>
        <FeaturedMeetingSection />
      </Suspense>

      {/* Pipeline strip */}
      <Suspense
        fallback={
          <div className="flex flex-col gap-3">
            <Skeleton className="h-4 w-24" />
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-7">
              {Array.from({ length: 7 }).map((_, i) => (
                <Skeleton key={i} className="h-[76px] rounded-lg" />
              ))}
            </div>
          </div>
        }
      >
        <PipelineStripSection preloadedPipelineSummary={preloadedPipelineSummary} />
      </Suspense>

      <Separator />

      {/* Calendar — heaviest section, streams last */}
      <Suspense fallback={<Skeleton className="h-[400px] rounded-xl" />}>
        <CalendarSection />
      </Suspense>
    </div>
  );
}
```

**Key implementation notes:**
- `requireRole(["closer"])` still executes sequentially at the top — it's a fast auth check (session already resolved by layout). The `preloadQuery()` calls after it run in parallel via `Promise.all()`.
- The `preloadedProfile` promise is awaited before passing to `CloserDashboardHeader` — this is intentional because the header needs the profile to render the greeting. An alternative is to pass the unresolved promise and use `use()` in the client component, but `usePreloadedQuery` expects a resolved `Preloaded` object.
- `FeaturedMeetingSection` may need the session `accessToken` passed as a prop for authenticated `preloadQuery()` calls. Verify during implementation whether the Convex token is needed.
- `CalendarSection` is the heaviest section (date-fns, react-day-picker, multiple view modes). In Phase 4, it will be lazy-loaded via `dynamic()`. For now, it renders directly but inside its own Suspense boundary.
- Inline Suspense fallbacks use `Skeleton` directly instead of extracted components — these are simple enough to be inline. For the pipeline strip, the grid skeleton matches the 7-column layout of `PipelineStrip`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/page.tsx` | Modify | Granular Suspense boundaries |
| `app/workspace/closer/_components/featured-meeting-section.tsx` | Create | Async featured meeting server component |
| `app/workspace/closer/_components/pipeline-strip-section.tsx` | Create | Pipeline strip client wrapper |
| `app/workspace/closer/_components/calendar-section.tsx` | Create | Calendar wrapper (pre-lazy-load) |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/_components/skeletons/stats-row-skeleton.tsx` | Create | 3A |
| `app/workspace/_components/skeletons/pipeline-summary-skeleton.tsx` | Create | 3A |
| `app/workspace/_components/skeletons/system-health-skeleton.tsx` | Create | 3A |
| `app/workspace/page.tsx` | Modify | 3B |
| `app/workspace/_components/dashboard-header.tsx` | Create | 3B |
| `app/workspace/_components/stats-section.tsx` | Create | 3B |
| `app/workspace/_components/pipeline-section.tsx` | Create | 3B |
| `app/workspace/_components/system-health-section.tsx` | Create | 3B |
| `app/workspace/closer/_components/closer-dashboard-header.tsx` | Create | 3C |
| `app/workspace/closer/page.tsx` | Modify | 3D |
| `app/workspace/closer/_components/featured-meeting-section.tsx` | Create | 3D |
| `app/workspace/closer/_components/pipeline-strip-section.tsx` | Create | 3D |
| `app/workspace/closer/_components/calendar-section.tsx` | Create | 3D |
