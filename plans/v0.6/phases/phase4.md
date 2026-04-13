# Phase 4 — Frontend: Report Shell & Navigation

**Goal:** Create the report route structure (`app/workspace/reports/*`), auth-gated layout, sidebar navigation entry, shared date controls component, and skeleton components for all 5 report pages. After this phase, navigating to `/workspace/reports` renders a functioning shell with proper auth gating and loading states.

**Prerequisite:** Phase 1 complete (workspace layout and auth system must be stable). No backend query dependency — this phase builds frontend scaffolding only.

**Runs in PARALLEL with:** Phase 2 (Mutation Integration — backend files) and Phase 3 (Core Reporting Queries — backend files). This phase touches only `app/workspace/reports/` (new directory) and `app/workspace/_components/workspace-shell-client.tsx` (sidebar nav). Zero overlap with Phase 2 or 3 files.

**Skills to invoke:**
- `shadcn` — for Calendar, Popover, Select components used by date controls
- `next-best-practices` — RSC page pattern, `unstable_instant`, layout auth gates, Suspense boundaries
- `vercel-composition-patterns` — composing reusable report shell with shared date controls

**Acceptance Criteria:**
1. `app/workspace/reports/layout.tsx` enforces `requireRole(["tenant_master", "tenant_admin"])` — closers are redirected away.
2. Navigating to `/workspace/reports` redirects to `/workspace/reports/team`.
3. The workspace sidebar shows a "Reports" section with 5 nav items (Team Performance, Revenue, Pipeline Health, Leads & Conversions, Activity Feed) — visible only to admin roles.
4. `ReportDateControls` component renders quick-pick buttons (Today, This Week, This Month, Last Month, Last 90 Days), a custom date range picker with calendar, and an optional granularity selector.
5. Each of the 5 report routes has a `page.tsx` with `unstable_instant = false` and a dedicated skeleton component.
6. `app/workspace/reports/loading.tsx` renders a generic reports-level skeleton.
7. All skeletons use `role="status"` and `aria-label` for accessibility.
8. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (report layout + landing + loading) ─────────────────────────────────┐
                                                                        ├── 4D (skeleton components — needs route structure from 4A)
4B (sidebar navigation update) ─────────────────────────────────────────┘

4C (shared date controls component) ────────────────────────────────────┘
```

**Optimal execution:**
1. Start **4A**, **4B**, **4C** all in parallel (different files: reports route structure vs sidebar vs shared components).
2. After 4A → start **4D** (skeletons live inside the report route directories created by 4A).

**Estimated time:** 1-2 days

---

## Subphases

### 4A — Report Layout + Landing Page + Route Structure

**Type:** Frontend
**Parallelizable:** Yes — touches only new files in `app/workspace/reports/`. No overlap with 4B or 4C.

**What:** Create `reports/layout.tsx` (RSC auth gate), `reports/page.tsx` (redirect to team report), `reports/loading.tsx` (skeleton), and the 5 report page files (thin RSC wrappers).

**Why:** The layout provides the auth gate — without it, closers could navigate to report URLs directly. The landing page redirect ensures `/workspace/reports` always goes somewhere useful. The page files follow the established three-layer pattern (RSC page → client component).

**Where:**
- `app/workspace/reports/layout.tsx` (new)
- `app/workspace/reports/page.tsx` (new)
- `app/workspace/reports/loading.tsx` (new)
- `app/workspace/reports/team/page.tsx` (new)
- `app/workspace/reports/revenue/page.tsx` (new)
- `app/workspace/reports/pipeline/page.tsx` (new)
- `app/workspace/reports/leads/page.tsx` (new)
- `app/workspace/reports/activity/page.tsx` (new)

**How:**

**Step 1: Create the reports layout with auth gate**

```typescript
// Path: app/workspace/reports/layout.tsx
import { requireRole } from "@/lib/auth";

export default async function ReportsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Server-side auth gate — redirects if not tenant_master or tenant_admin
  await requireRole(["tenant_master", "tenant_admin"]);

  return <>{children}</>;
}
```

**Step 2: Create the landing page (redirect)**

```typescript
// Path: app/workspace/reports/page.tsx
import { redirect } from "next/navigation";

export const unstable_instant = false;

export default function ReportsPage() {
  redirect("/workspace/reports/team");
}
```

**Step 3: Create the loading page**

```tsx
// Path: app/workspace/reports/loading.tsx
import { Skeleton } from "@/components/ui/skeleton";

export default function ReportsLoading() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading reports">
      <div className="flex gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-24" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-lg" />
    </div>
  );
}
```

**Step 4: Create all 5 report page files (thin RSC wrappers)**

Each page follows the same pattern — import the `-page-client` component (created in Phase 5):

```tsx
// Path: app/workspace/reports/team/page.tsx
export const unstable_instant = false;

export default function TeamPerformancePage() {
  // TeamReportPageClient will be created in Phase 5
  return <div>Team Performance — loading...</div>;
}
```

```tsx
// Path: app/workspace/reports/revenue/page.tsx
export const unstable_instant = false;

export default function RevenuePage() {
  return <div>Revenue — loading...</div>;
}
```

```tsx
// Path: app/workspace/reports/pipeline/page.tsx
export const unstable_instant = false;

export default function PipelineHealthPage() {
  return <div>Pipeline Health — loading...</div>;
}
```

```tsx
// Path: app/workspace/reports/leads/page.tsx
export const unstable_instant = false;

export default function LeadsConversionsPage() {
  return <div>Leads & Conversions — loading...</div>;
}
```

```tsx
// Path: app/workspace/reports/activity/page.tsx
export const unstable_instant = false;

export default function ActivityFeedPage() {
  return <div>Activity Feed — loading...</div>;
}
```

> **Note:** The page files contain placeholder content. Phase 5 will replace the placeholder divs with the actual `-page-client` component imports.

**Key implementation notes:**
- The `requireRole` call in `layout.tsx` runs on every navigation within `/workspace/reports/*`. It's cached per-request via React `cache()` (inside `lib/auth.ts`).
- `unstable_instant = false` on all pages signals the PPR-ready architecture.
- The placeholder approach lets Phase 4 and Phase 5 work in parallel — 4 creates the route structure, 5 fills in the content.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/layout.tsx` | Create | RSC auth gate |
| `app/workspace/reports/page.tsx` | Create | Redirect to /team |
| `app/workspace/reports/loading.tsx` | Create | Generic reports skeleton |
| `app/workspace/reports/team/page.tsx` | Create | Placeholder (Phase 5 fills in) |
| `app/workspace/reports/revenue/page.tsx` | Create | Placeholder |
| `app/workspace/reports/pipeline/page.tsx` | Create | Placeholder |
| `app/workspace/reports/leads/page.tsx` | Create | Placeholder |
| `app/workspace/reports/activity/page.tsx` | Create | Placeholder |

---

### 4B — Sidebar Navigation Update

**Type:** Frontend
**Parallelizable:** Yes — touches only `app/workspace/_components/workspace-shell-client.tsx`. No overlap with 4A, 4C, or 4D.

**What:** Add a "Reports" navigation section to the admin sidebar, visible only to `tenant_master` and `tenant_admin` roles.

**Why:** Without a sidebar entry, admins have no way to discover or navigate to the report pages. The navigation must be role-gated client-side (UI visibility only — the layout auth gate provides actual security).

**Where:**
- `app/workspace/_components/workspace-shell-client.tsx` (modify)

**How:**

**Step 1: Add report nav items to the admin navigation**

Locate the existing admin navigation items array in `workspace-shell-client.tsx`. After the existing items (Overview, Pipeline, Leads, Customers, Team, Settings), add a Reports section:

```tsx
// Path: app/workspace/_components/workspace-shell-client.tsx
// Add imports at the top:
import {
  BarChart3Icon,
  DollarSignIcon,
  ActivityIcon,
  TrendingUpIcon,
  ClockIcon,
} from "lucide-react";

// Inside the admin navigation items, after "Settings":
// Reports section (admin only — guarded by pipeline:view-all permission)
...(isAdmin
  ? [
      { type: "separator" as const },
      {
        label: "Reports",
        items: [
          { href: "/workspace/reports/team", label: "Team Performance", icon: BarChart3Icon },
          { href: "/workspace/reports/revenue", label: "Revenue", icon: DollarSignIcon },
          { href: "/workspace/reports/pipeline", label: "Pipeline Health", icon: ActivityIcon },
          { href: "/workspace/reports/leads", label: "Leads & Conversions", icon: TrendingUpIcon },
          { href: "/workspace/reports/activity", label: "Activity Feed", icon: ClockIcon },
        ],
      },
    ]
  : []),
```

**Step 2: Verify the nav structure**

The existing sidebar likely uses `SidebarGroup`, `SidebarGroupLabel`, `SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton` from `components/ui/sidebar`. Match the existing nav item rendering pattern. If the sidebar uses a flat array of `{ href, label, icon }` objects, wrap the Reports section with a group label.

**Key implementation notes:**
- `isAdmin` is derived from `useRole()` — it checks `role === "tenant_master" || role === "tenant_admin"`. This is UI visibility only (not security — the backend enforces access).
- The separator and group label create visual separation between core nav and reports.
- Icon choices match the report content: `BarChart3Icon` for performance, `DollarSignIcon` for revenue, `ActivityIcon` for pipeline health, `TrendingUpIcon` for leads/conversions, `ClockIcon` for activity feed.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/workspace-shell-client.tsx` | Modify | Add Reports nav section for admin roles |

---

### 4C — Shared Date Controls Component

**Type:** Frontend
**Parallelizable:** Yes — creates a new file in `app/workspace/reports/_components/`. No overlap with 4A, 4B, or 4D.

**What:** Create `ReportDateControls` — a shared component with quick-pick buttons (Today, This Week, This Month, Last Month, Last 90 Days), a custom date range picker, and an optional granularity selector.

**Why:** All 5 report pages need date range selection. Centralizing this prevents duplication and ensures consistent UX. The granularity toggle is needed specifically for the revenue trend chart but is exposed as an optional prop for future use.

**Where:**
- `app/workspace/reports/_components/report-date-controls.tsx` (new)

**How:**

**Step 1: Create the date controls component**

```tsx
// Path: app/workspace/reports/_components/report-date-controls.tsx
"use client";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CalendarIcon } from "lucide-react";
import {
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  startOfDay,
  endOfDay,
  subMonths,
  subDays,
} from "date-fns";

type Granularity = "day" | "week" | "month";

interface DateRange {
  startDate: number;
  endDate: number;
}

interface ReportDateControlsProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
  granularity?: Granularity;
  onGranularityChange?: (g: Granularity) => void;
  showGranularity?: boolean;
}

const QUICK_PICKS = [
  {
    label: "Today",
    getRange: () => ({
      startDate: startOfDay(new Date()).getTime(),
      endDate: endOfDay(new Date()).getTime(),
    }),
  },
  {
    label: "This Week",
    getRange: () => ({
      startDate: startOfWeek(new Date()).getTime(),
      endDate: endOfWeek(new Date()).getTime(),
    }),
  },
  {
    label: "This Month",
    getRange: () => ({
      startDate: startOfMonth(new Date()).getTime(),
      endDate: endOfMonth(new Date()).getTime(),
    }),
  },
  {
    label: "Last Month",
    getRange: () => {
      const last = subMonths(new Date(), 1);
      return {
        startDate: startOfMonth(last).getTime(),
        endDate: endOfMonth(last).getTime(),
      };
    },
  },
  {
    label: "Last 90 Days",
    getRange: () => ({
      startDate: subDays(new Date(), 90).getTime(),
      endDate: new Date().getTime(),
    }),
  },
] as const;

export function ReportDateControls({
  value,
  onChange,
  granularity,
  onGranularityChange,
  showGranularity = false,
}: ReportDateControlsProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Quick pick buttons */}
      {QUICK_PICKS.map((pick) => (
        <Button
          key={pick.label}
          variant="outline"
          size="sm"
          onClick={() => onChange(pick.getRange())}
        >
          {pick.label}
        </Button>
      ))}

      {/* Custom date range picker */}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">
            <CalendarIcon className="mr-2 h-4 w-4" />
            {format(value.startDate, "MMM d")} -{" "}
            {format(value.endDate, "MMM d, yyyy")}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="range"
            selected={{
              from: new Date(value.startDate),
              to: new Date(value.endDate),
            }}
            onSelect={(range) => {
              if (range?.from && range?.to) {
                onChange({
                  startDate: range.from.getTime(),
                  endDate: range.to.getTime(),
                });
              }
            }}
          />
        </PopoverContent>
      </Popover>

      {/* Granularity toggle (for trend charts) */}
      {showGranularity && onGranularityChange && (
        <Select
          value={granularity}
          onValueChange={(v) => onGranularityChange(v as Granularity)}
        >
          <SelectTrigger className="w-[100px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="day">Day</SelectItem>
            <SelectItem value="week">Week</SelectItem>
            <SelectItem value="month">Month</SelectItem>
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
```

**Step 2: Verify shadcn components are installed**

Ensure `calendar`, `popover`, and `select` components are available:

```bash
# Check for existing components
ls components/ui/calendar.tsx components/ui/popover.tsx components/ui/select.tsx
```

If any are missing, install via shadcn CLI (use the `shadcn` skill).

**Key implementation notes:**
- The Calendar component uses `mode="range"` — this requires the `react-day-picker` dependency (bundled with shadcn's Calendar component).
- Quick-pick buttons compute fresh dates on each click (not cached). This means "Today" always reflects the current date, even if the page was left open overnight.
- `date-fns` functions are already in `optimizePackageImports` in `next.config.ts` — tree-shaking is handled.
- The component is responsive by default via `flex-wrap`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/_components/report-date-controls.tsx` | Create | Shared date range + granularity controls |

---

### 4D — Skeleton Components

**Type:** Frontend
**Parallelizable:** No — depends on 4A (report route directories must exist).

**What:** Create dedicated skeleton components for all 5 report pages, matching their expected layout dimensions.

**Why:** Skeletons prevent CLS (Cumulative Layout Shift) during loading and provide visual feedback. Each report has a different layout (tables vs charts vs feed list), so each needs its own skeleton.

**Where:**
- `app/workspace/reports/team/_components/team-report-skeleton.tsx` (new)
- `app/workspace/reports/revenue/_components/revenue-report-skeleton.tsx` (new)
- `app/workspace/reports/pipeline/_components/pipeline-report-skeleton.tsx` (new)
- `app/workspace/reports/leads/_components/leads-report-skeleton.tsx` (new)
- `app/workspace/reports/activity/_components/activity-feed-skeleton.tsx` (new)

**How:**

**Step 1: Team Performance skeleton**

```tsx
// Path: app/workspace/reports/team/_components/team-report-skeleton.tsx
import { Skeleton } from "@/components/ui/skeleton";

export function TeamReportSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading team report">
      {/* Date controls placeholder */}
      <div className="flex gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-24" />
        ))}
      </div>
      {/* KPI summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-lg" />
        ))}
      </div>
      {/* Two performance tables */}
      <Skeleton className="h-64 rounded-lg" />
      <Skeleton className="h-64 rounded-lg" />
    </div>
  );
}
```

**Step 2: Revenue skeleton**

```tsx
// Path: app/workspace/reports/revenue/_components/revenue-report-skeleton.tsx
import { Skeleton } from "@/components/ui/skeleton";

export function RevenueReportSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading revenue report">
      <div className="flex gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-24" />
        ))}
      </div>
      {/* Trend chart */}
      <Skeleton className="h-[300px] rounded-lg" />
      {/* Closer breakdown table + deal distribution */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Skeleton className="h-64 rounded-lg" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
      {/* Top deals table */}
      <Skeleton className="h-48 rounded-lg" />
    </div>
  );
}
```

**Step 3: Pipeline Health skeleton**

```tsx
// Path: app/workspace/reports/pipeline/_components/pipeline-report-skeleton.tsx
import { Skeleton } from "@/components/ui/skeleton";

export function PipelineReportSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading pipeline report">
      {/* Status distribution chart + velocity card */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Skeleton className="h-[300px] rounded-lg" />
        <Skeleton className="h-28 rounded-lg" />
      </div>
      {/* Aging table */}
      <Skeleton className="h-48 rounded-lg" />
      {/* Stale pipeline list */}
      <Skeleton className="h-48 rounded-lg" />
    </div>
  );
}
```

**Step 4: Leads & Conversions skeleton**

```tsx
// Path: app/workspace/reports/leads/_components/leads-report-skeleton.tsx
import { Skeleton } from "@/components/ui/skeleton";

export function LeadsReportSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading leads report">
      <div className="flex gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-24" />
        ))}
      </div>
      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-lg" />
        ))}
      </div>
      {/* Conversion table */}
      <Skeleton className="h-48 rounded-lg" />
      {/* Form insights */}
      <Skeleton className="h-64 rounded-lg" />
    </div>
  );
}
```

**Step 5: Activity Feed skeleton**

```tsx
// Path: app/workspace/reports/activity/_components/activity-feed-skeleton.tsx
import { Skeleton } from "@/components/ui/skeleton";

export function ActivityFeedSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading activity feed">
      <div className="flex gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-24" />
        ))}
      </div>
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-lg" />
        ))}
      </div>
      {/* Filter bar */}
      <Skeleton className="h-10 w-full rounded-lg" />
      {/* Feed items */}
      <div className="space-y-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
```

**Key implementation notes:**
- All skeletons include `role="status"` and `aria-label` for screen reader accessibility.
- Skeleton dimensions are matched to expected content (e.g., 300px for charts, 64px for tables, 16px for feed items).
- The `_components/` directory convention is used per Next.js routing — these files are not routable.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/team/_components/team-report-skeleton.tsx` | Create | Team performance loading state |
| `app/workspace/reports/revenue/_components/revenue-report-skeleton.tsx` | Create | Revenue loading state |
| `app/workspace/reports/pipeline/_components/pipeline-report-skeleton.tsx` | Create | Pipeline health loading state |
| `app/workspace/reports/leads/_components/leads-report-skeleton.tsx` | Create | Leads & conversions loading state |
| `app/workspace/reports/activity/_components/activity-feed-skeleton.tsx` | Create | Activity feed loading state |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/reports/layout.tsx` | Create | 4A |
| `app/workspace/reports/page.tsx` | Create | 4A |
| `app/workspace/reports/loading.tsx` | Create | 4A |
| `app/workspace/reports/team/page.tsx` | Create | 4A |
| `app/workspace/reports/revenue/page.tsx` | Create | 4A |
| `app/workspace/reports/pipeline/page.tsx` | Create | 4A |
| `app/workspace/reports/leads/page.tsx` | Create | 4A |
| `app/workspace/reports/activity/page.tsx` | Create | 4A |
| `app/workspace/_components/workspace-shell-client.tsx` | Modify | 4B |
| `app/workspace/reports/_components/report-date-controls.tsx` | Create | 4C |
| `app/workspace/reports/team/_components/team-report-skeleton.tsx` | Create | 4D |
| `app/workspace/reports/revenue/_components/revenue-report-skeleton.tsx` | Create | 4D |
| `app/workspace/reports/pipeline/_components/pipeline-report-skeleton.tsx` | Create | 4D |
| `app/workspace/reports/leads/_components/leads-report-skeleton.tsx` | Create | 4D |
| `app/workspace/reports/activity/_components/activity-feed-skeleton.tsx` | Create | 4D |
