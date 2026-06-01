# Phase 3 - Frontend: Opportunities List Page

**Goal:** Add `/workspace/opportunities` as the first-class browse surface for all opportunities. The page supports role-scoped pagination, debounced search, common status/source/period/closer filters, row navigation to the future detail page, and navigation entry points for admins and closers.

**Prerequisite:** Phase 1 schema is deployed. Phase 2 `api.opportunities.listQueries.listOpportunities`, `api.opportunities.listQueries.searchOpportunities`, and `api.users.queries.listActiveClosers` signatures are stable. The page may be built before Phase 5 detail exists, but row links will 404 until Phase 5 ships.

**Runs in PARALLEL with:** Phase 4 can run concurrently after Phase 2 because it owns `/workspace/opportunities/new`. Phase 5 can build detail route files concurrently if it owns `/workspace/opportunities/[opportunityId]`. Coordinate only on shared nav/command-palette edits.

**Skills to invoke:**
- `frontend-design` - keep the CRM surface dense, calm, and task-focused; avoid marketing or decorative UI.
- `next-best-practices` - ensure `useSearchParams()` sits behind Suspense and page files use async-safe App Router conventions.
- `shadcn` - compose existing table, tabs, toggle group, select, badge, empty, skeleton, and button primitives consistently.
- `vercel-react-best-practices` - keep filter state, row arrays, and callbacks stable enough to avoid avoidable table re-renders.

---

## Acceptance Criteria

1. Navigating to `/workspace/opportunities` renders a page titled "Opportunities" inside the existing workspace shell for admins and closers.
2. Admins see all tenant opportunities by default and can filter by closer using an active-closer select.
3. Closers never see the closer filter and only receive their own assigned opportunities from the backend.
4. With no search term, the page uses `usePaginatedQuery(api.opportunities.listQueries.listOpportunities, ...)` with 25 initial rows and a "Load more" affordance.
5. Typing at least two characters switches to `useQuery(api.opportunities.listQueries.searchOpportunities, ...)` and skips the paginated query.
6. Status, source, and period filters are reflected in the URL query string without full page reloads and are restored on refresh.
7. Rows show lead, status, source, latest activity, created date, and closer column for admins only.
8. Clicking a row opens `/workspace/opportunities/{opportunityId}` in a new tab, matching the Leads page behavior.
9. Workspace sidebar shows "Opportunities" for both admin and closer navigation; command palette includes Opportunities and "Create opportunity" entries.
10. Loading and empty states use existing primitives with stable dimensions and no layout jump.
11. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (route shell + skeleton - owns route files) ─────────────┐
                                                           │
3B (URL/filter state client) ────────────────┐             │
                                             ├── 3D (table + badges + empty states) ──┐
3C (search/filter controls) ─────────────────┘                                      │
                                                                                    ├── 3F (QA gate)
3E (sidebar + command palette integration) ─────────────────────────────────────────┘
```

**Optimal execution:**
1. Start **3A, 3B, 3C, and 3E in parallel**. 3A owns route files, 3B owns page state/query plumbing, 3C owns controls, and 3E owns shared navigation.
2. Start **3D** once the row type and filter props from 3B/3C are stable.
3. Run **3F** after all UI files merge.

**Estimated time:** 1.5-2 days solo, or 1 day with three frontend streams.

---

## Subphases

### 3A - Route Shell, Loading State, and Page Skeleton

**Type:** Frontend
**Parallelizable:** Yes - owns new route files and does not touch shared navigation.

**What:** Create the route entry, loading file, and skeleton component.

**Why:** The route must follow the app's established page pattern: `unstable_instant = false`, thin server wrapper, client boundary, and a stable loading skeleton.

**Where:**
- `app/workspace/opportunities/page.tsx` (new)
- `app/workspace/opportunities/loading.tsx` (new)
- `app/workspace/opportunities/_components/skeletons/opportunities-page-skeleton.tsx` (new)
- `app/workspace/opportunities/_components/opportunities-page-client.tsx` (new shell)

**How:**

**Step 1: Add the page wrapper.**

```tsx
// Path: app/workspace/opportunities/page.tsx
import { Suspense } from "react";
import { OpportunitiesPageClient } from "./_components/opportunities-page-client";
import { OpportunitiesPageSkeleton } from "./_components/skeletons/opportunities-page-skeleton";

export const unstable_instant = false;

export default function OpportunitiesPage() {
  return (
    <Suspense fallback={<OpportunitiesPageSkeleton />}>
      <OpportunitiesPageClient />
    </Suspense>
  );
}
```

**Step 2: Add `loading.tsx`.**

```tsx
// Path: app/workspace/opportunities/loading.tsx
import { OpportunitiesPageSkeleton } from "./_components/skeletons/opportunities-page-skeleton";

export default function OpportunitiesLoading() {
  return <OpportunitiesPageSkeleton />;
}
```

**Step 3: Add a dimensionally stable skeleton.**

```tsx
// Path: app/workspace/opportunities/_components/skeletons/opportunities-page-skeleton.tsx
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function OpportunitiesPageSkeleton() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="Loading opportunities">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-9 w-36" />
      </div>
      <Card className="p-4">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      </Card>
      <div className="overflow-hidden rounded-lg border">
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} className="h-14 w-full rounded-none border-b last:border-b-0" />
        ))}
      </div>
    </div>
  );
}
```

**Key implementation notes:**
- The page wrapper uses Suspense because 3B uses `useSearchParams()` in a client component.
- Do not add a landing/intro page. The first viewport is the usable list.
- Keep skeleton rows at a stable height so table load does not shift the layout.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/opportunities/page.tsx` | Create | Thin RSC wrapper with `unstable_instant = false`. |
| `app/workspace/opportunities/loading.tsx` | Create | Route-level loading file. |
| `app/workspace/opportunities/_components/skeletons/opportunities-page-skeleton.tsx` | Create | Stable page/table skeleton. |
| `app/workspace/opportunities/_components/opportunities-page-client.tsx` | Create | Initial client shell, completed in 3B. |

---

### 3B - Client State, URL Filters, and Convex Queries

**Type:** Frontend
**Parallelizable:** Yes - owns the page client and can run alongside controls/table creation once prop contracts are agreed.

**What:** Implement filter state, URL synchronization, list/search query switching, and row-click navigation in `OpportunitiesPageClient`.

**Why:** This is the page's behavioral core. Filters must survive refresh/share and must not cause whole-page server reloads while users refine lists.

**Where:**
- `app/workspace/opportunities/_components/opportunities-page-client.tsx` (modify)

**How:**

**Step 1: Define filter types and URL parsing helpers.**

```tsx
// Path: app/workspace/opportunities/_components/opportunities-page-client.tsx
"use client";

import { useCallback, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { usePaginatedQuery, useQuery } from "convex/react";
import { PlusIcon, DownloadIcon } from "lucide-react";
import Link from "next/link";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useRole } from "@/components/auth/role-context";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { OpportunityFilters } from "./opportunity-filters";
import { OpportunitySearchInput } from "./opportunity-search-input";
import { OpportunitiesTable } from "./opportunities-table";

type StatusFilter =
  | "all"
  | "scheduled"
  | "in_progress"
  | "meeting_overran"
  | "payment_received"
  | "follow_up_scheduled"
  | "reschedule_link_sent"
  | "lost"
  | "canceled"
  | "no_show";
type SourceFilter = "all" | "calendly" | "side_deal";
type PeriodFilter = "all" | "today" | "this_week" | "this_month";
```

**Step 2: Wire URL state without triggering full Next navigation.**

```tsx
// Path: app/workspace/opportunities/_components/opportunities-page-client.tsx
export function OpportunitiesPageClient() {
  const { isAdmin } = useRole();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const initialStatus = (searchParams.get("status") ?? "all") as StatusFilter;
  const initialSource = (searchParams.get("source") ?? "all") as SourceFilter;
  const initialPeriod = (searchParams.get("period") ?? "all") as PeriodFilter;
  const initialCloser = (searchParams.get("closer") ?? "all") as Id<"users"> | "all";

  const [statusFilter, setStatusFilter] = useState<StatusFilter>(initialStatus);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>(initialSource);
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>(initialPeriod);
  const [closerFilter, setCloserFilter] = useState<Id<"users"> | "all">(initialCloser);
  const [searchTerm, setSearchTerm] = useState("");

  const writeUrl = useCallback(
    (next: Partial<{
      status: StatusFilter;
      source: SourceFilter;
      period: PeriodFilter;
      closer: Id<"users"> | "all";
    }>) => {
      const params = new URLSearchParams(window.location.search);
      const values = {
        status: next.status ?? statusFilter,
        source: next.source ?? sourceFilter,
        period: next.period ?? periodFilter,
        closer: next.closer ?? closerFilter,
      };
      for (const [key, value] of Object.entries(values)) {
        if (value && value !== "all") params.set(key, value);
        else params.delete(key);
      }
      const qs = params.toString();
      window.history.replaceState(null, "", `${pathname}${qs ? `?${qs}` : ""}`);
    },
    [closerFilter, pathname, periodFilter, sourceFilter, statusFilter],
  );
```

**Step 3: Switch between paginated list mode and search mode.**

```tsx
// Path: app/workspace/opportunities/_components/opportunities-page-client.tsx
  const isSearching = searchTerm.trim().length >= 2;

  const queryArgs = useMemo(
    () => ({
      statusFilter: statusFilter === "all" ? undefined : statusFilter,
      sourceFilter: sourceFilter === "all" ? undefined : sourceFilter,
      periodFilter: periodFilter === "all" ? undefined : periodFilter,
      closerFilter: isAdmin && closerFilter !== "all" ? closerFilter : undefined,
    }),
    [closerFilter, isAdmin, periodFilter, sourceFilter, statusFilter],
  );

  const {
    results,
    status: paginationStatus,
    loadMore,
  } = usePaginatedQuery(
    api.opportunities.listQueries.listOpportunities,
    isSearching ? "skip" : queryArgs,
    { initialNumItems: 25 },
  );

  const searchResults = useQuery(
    api.opportunities.listQueries.searchOpportunities,
    isSearching ? { ...queryArgs, searchTerm: searchTerm.trim() } : "skip",
  );

  const rows = isSearching ? searchResults ?? [] : results;

  const onRowClick = useCallback((opportunityId: Id<"opportunities">) => {
    window.open(`/workspace/opportunities/${opportunityId}`, "_blank");
  }, []);
```

**Step 4: Render header, filters, and table.**

```tsx
// Path: app/workspace/opportunities/_components/opportunities-page-client.tsx
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Opportunities</h1>
          <p className="text-sm text-muted-foreground">
            Browse Calendly-sourced opportunities and side deals in one place.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled title="Coming soon">
            <DownloadIcon data-icon="inline-start" />
            Export CSV
          </Button>
          <Button asChild size="sm">
            <Link href="/workspace/opportunities/new">
              <PlusIcon data-icon="inline-start" />
              New Opportunity
            </Link>
          </Button>
        </div>
      </div>

      <Card className="p-4">
        <div className="flex flex-col gap-4">
          <OpportunitySearchInput value={searchTerm} onChange={setSearchTerm} />
          <OpportunityFilters
            isAdmin={isAdmin}
            statusFilter={statusFilter}
            sourceFilter={sourceFilter}
            periodFilter={periodFilter}
            closerFilter={closerFilter}
            onStatusChange={(value) => {
              setStatusFilter(value);
              writeUrl({ status: value });
            }}
            onSourceChange={(value) => {
              setSourceFilter(value);
              writeUrl({ source: value });
            }}
            onPeriodChange={(value) => {
              setPeriodFilter(value);
              writeUrl({ period: value });
            }}
            onCloserChange={(value) => {
              setCloserFilter(value);
              writeUrl({ closer: value });
            }}
          />
        </div>
      </Card>

      <OpportunitiesTable
        opportunities={rows}
        isSearching={isSearching}
        isLoading={!isSearching && paginationStatus === "LoadingFirstPage"}
        canLoadMore={!isSearching && paginationStatus === "CanLoadMore"}
        onLoadMore={() => loadMore(25)}
        onRowClick={onRowClick}
        showCloserColumn={isAdmin}
      />
    </div>
  );
}
```

**Key implementation notes:**
- `useSearchParams()` is safe because 3A wraps the client in Suspense.
- Use `window.history.replaceState` rather than `router.replace` to avoid re-running the async workspace layout and flashing skeletons, matching the closer pipeline pattern.
- Source and period filters are not search-only; pass them to both list and search modes.
- Export is intentionally disabled for MVP.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/opportunities/_components/opportunities-page-client.tsx` | Modify | URL state, Convex query switching, render composition. |

---

### 3C - Search Input and Filter Bar

**Type:** Frontend
**Parallelizable:** Yes - owns isolated controls that receive state from 3B.

**What:** Add a debounced search input and filter controls for status, source, period, and closer.

**Why:** The list page must support the same high-speed triage workflow as Leads while adding source and owner filters specific to opportunities.

**Where:**
- `app/workspace/opportunities/_components/opportunity-search-input.tsx` (new)
- `app/workspace/opportunities/_components/opportunity-filters.tsx` (new)

**How:**

**Step 1: Implement debounced search.**

```tsx
// Path: app/workspace/opportunities/_components/opportunity-search-input.tsx
"use client";

import { useEffect, useState } from "react";
import { SearchIcon } from "lucide-react";
import { Input } from "@/components/ui/input";

export function OpportunitySearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => onChange(draft), 300);
    return () => window.clearTimeout(timeout);
  }, [draft, onChange]);

  return (
    <div className="relative w-full lg:max-w-sm">
      <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Search by lead name, email, or phone"
        className="pl-9"
      />
    </div>
  );
}
```

**Step 2: Implement filters with existing primitives.**

```tsx
// Path: app/workspace/opportunities/_components/opportunity-filters.tsx
"use client";

import { useQuery } from "convex/react";
import type { Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type StatusFilter = "all" | "scheduled" | "in_progress" | "payment_received" | "lost" | "canceled" | "no_show" | "meeting_overran" | "follow_up_scheduled" | "reschedule_link_sent";
type SourceFilter = "all" | "calendly" | "side_deal";
type PeriodFilter = "all" | "today" | "this_week" | "this_month";

export function OpportunityFilters({
  isAdmin,
  statusFilter,
  sourceFilter,
  periodFilter,
  closerFilter,
  onStatusChange,
  onSourceChange,
  onPeriodChange,
  onCloserChange,
}: {
  isAdmin: boolean;
  statusFilter: StatusFilter;
  sourceFilter: SourceFilter;
  periodFilter: PeriodFilter;
  closerFilter: Id<"users"> | "all";
  onStatusChange: (value: StatusFilter) => void;
  onSourceChange: (value: SourceFilter) => void;
  onPeriodChange: (value: PeriodFilter) => void;
  onCloserChange: (value: Id<"users"> | "all") => void;
}) {
  const closers = useQuery(api.users.queries.listActiveClosers, isAdmin ? {} : "skip");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup type="single" value={periodFilter} onValueChange={(value) => value && onPeriodChange(value as PeriodFilter)} size="sm" variant="outline">
          <ToggleGroupItem value="all">All time</ToggleGroupItem>
          <ToggleGroupItem value="today">Today</ToggleGroupItem>
          <ToggleGroupItem value="this_week">Week</ToggleGroupItem>
          <ToggleGroupItem value="this_month">Month</ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup type="single" value={sourceFilter} onValueChange={(value) => value && onSourceChange(value as SourceFilter)} size="sm" variant="outline">
          <ToggleGroupItem value="all">All sources</ToggleGroupItem>
          <ToggleGroupItem value="calendly">Calendly</ToggleGroupItem>
          <ToggleGroupItem value="side_deal">Side deals</ToggleGroupItem>
        </ToggleGroup>
        {isAdmin ? (
          <Select value={closerFilter} onValueChange={(value) => onCloserChange(value as Id<"users"> | "all")}>
            <SelectTrigger size="sm" className="w-48">
              <SelectValue placeholder="All closers" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All closers</SelectItem>
              {closers?.map((closer) => (
                <SelectItem key={closer._id} value={closer._id}>
                  {closer.fullName ?? closer.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
      <Tabs value={statusFilter} onValueChange={(value) => onStatusChange(value as StatusFilter)}>
        <TabsList className="grid w-full grid-cols-3 sm:grid-cols-6 lg:w-auto">
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="in_progress">In Progress</TabsTrigger>
          <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
          <TabsTrigger value="payment_received">Won</TabsTrigger>
          <TabsTrigger value="lost">Lost</TabsTrigger>
          <TabsTrigger value="canceled">Canceled</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}
```

**Key implementation notes:**
- Controls must wrap on mobile. Do not force a single horizontal toolbar.
- Keep status tabs to the most-used subset; rare statuses can still appear in "All" and be added later if operators request them.
- For admin closer select, show active closers only. Historical inactive closer rows still render in the table if returned from backend enrichment.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/opportunities/_components/opportunity-search-input.tsx` | Create | Debounced search input. |
| `app/workspace/opportunities/_components/opportunity-filters.tsx` | Create | Status/source/period/closer filters. |

---

### 3D - Opportunities Table, Source Badge, and Empty States

**Type:** Frontend
**Parallelizable:** Yes after row type from 3B is stable.

**What:** Add the table component and source badge.

**Why:** This is the primary browse UI. It should mirror the Leads table behavior while adding opportunity-specific fields and row click behavior.

**Where:**
- `app/workspace/opportunities/_components/opportunities-table.tsx` (new)
- `app/workspace/opportunities/_components/opportunity-source-badge.tsx` (new)

**How:**

**Step 1: Implement source badge.**

```tsx
// Path: app/workspace/opportunities/_components/opportunity-source-badge.tsx
import { Badge } from "@/components/ui/badge";

export function OpportunitySourceBadge({
  source,
}: {
  source: "calendly" | "side_deal";
}) {
  return (
    <Badge variant={source === "side_deal" ? "secondary" : "outline"}>
      {source === "side_deal" ? "Side deal" : "Calendly"}
    </Badge>
  );
}
```

**Step 2: Implement table with stable columns and load-more support.**

```tsx
// Path: app/workspace/opportunities/_components/opportunities-table.tsx
"use client";

import { format, formatDistanceToNow } from "date-fns";
import { InboxIcon, SearchIcon } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/status-badge";
import { OpportunitySourceBadge } from "./opportunity-source-badge";

export type OpportunityListRow = {
  _id: Id<"opportunities">;
  leadName: string;
  leadEmail?: string;
  closerName?: string;
  status: string;
  source: "calendly" | "side_deal";
  latestActivityAt?: number;
  createdAt: number;
};

export function OpportunitiesTable({
  opportunities,
  isSearching,
  isLoading,
  canLoadMore,
  showCloserColumn,
  onLoadMore,
  onRowClick,
}: {
  opportunities: OpportunityListRow[];
  isSearching: boolean;
  isLoading: boolean;
  canLoadMore: boolean;
  showCloserColumn: boolean;
  onLoadMore: () => void;
  onRowClick: (opportunityId: Id<"opportunities">) => void;
}) {
  if (isLoading) {
    return (
      <div className="overflow-hidden rounded-lg border" role="status" aria-label="Loading opportunity rows">
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} className="h-14 w-full rounded-none border-b last:border-b-0" />
        ))}
      </div>
    );
  }

  if (opportunities.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            {isSearching ? <SearchIcon /> : <InboxIcon />}
          </EmptyMedia>
          <EmptyTitle>{isSearching ? "No opportunities found" : "No opportunities yet"}</EmptyTitle>
          <EmptyDescription>
            {isSearching
              ? "Try changing the search term or filters."
              : "Calendly bookings and manually created side deals will appear here."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Lead</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Source</TableHead>
              {showCloserColumn ? <TableHead>Closer</TableHead> : null}
              <TableHead>Latest activity</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {opportunities.map((opportunity) => (
              <TableRow
                key={opportunity._id}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => onRowClick(opportunity._id)}
              >
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">{opportunity.leadName}</span>
                    {opportunity.leadEmail ? (
                      <span className="text-xs text-muted-foreground">{opportunity.leadEmail}</span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell><StatusBadge status={opportunity.status} /></TableCell>
                <TableCell><OpportunitySourceBadge source={opportunity.source} /></TableCell>
                {showCloserColumn ? (
                  <TableCell className="text-muted-foreground">{opportunity.closerName ?? "Unassigned"}</TableCell>
                ) : null}
                <TableCell className="font-mono text-sm tabular-nums text-muted-foreground">
                  {opportunity.latestActivityAt
                    ? formatDistanceToNow(new Date(opportunity.latestActivityAt), { addSuffix: true })
                    : "No activity"}
                </TableCell>
                <TableCell className="font-mono text-sm tabular-nums text-muted-foreground">
                  {format(new Date(opportunity.createdAt), "MMM d, yyyy")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {canLoadMore ? (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={onLoadMore}>Load more</Button>
        </div>
      ) : null}
    </div>
  );
}
```

**Key implementation notes:**
- Do not nest this table inside another card; the bordered table container is enough.
- Use `StatusBadge` from shared status UI rather than creating a second status palette.
- On mobile, the table can horizontally scroll via the existing table container behavior; do not collapse into cards in MVP.
- Phase 7 will add a stale badge column/indicator. Leave row type extensible but do not add dead UI now.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/opportunities/_components/opportunities-table.tsx` | Create | List table and empty/loading states. |
| `app/workspace/opportunities/_components/opportunity-source-badge.tsx` | Create | Source badge reused by detail page. |

---

### 3E - Sidebar and Command Palette Integration

**Type:** Frontend
**Parallelizable:** Yes - shared-file ownership must be coordinated with Phases 4 and 5.

**What:** Add Opportunities to workspace navigation and command palette.

**Why:** A first-class entity list must be discoverable from both admin and closer workspaces, and the command palette should support fast create/list navigation.

**Where:**
- `app/workspace/_components/workspace-shell-client.tsx` (modify)
- `components/command-palette.tsx` (modify)

**How:**

**Step 1: Add `TargetIcon` import and nav items.**

```tsx
// Path: app/workspace/_components/workspace-shell-client.tsx
import {
  // ... existing imports ...
  TargetIcon,
} from "lucide-react";

const adminNavItems: NavItem[] = [
  { href: "/workspace", label: "Overview", icon: LayoutDashboardIcon, exact: true },
  { href: "/workspace/pipeline", label: "Pipeline", icon: KanbanIcon },
  { href: "/workspace/opportunities", label: "Opportunities", icon: TargetIcon },
  { href: "/workspace/reviews", label: "Reviews", icon: ClipboardCheckIcon },
  // ...
];

const closerNavItems: NavItem[] = [
  { href: "/workspace/closer", label: "Dashboard", icon: LayoutDashboardIcon, exact: true },
  { href: "/workspace/closer/pipeline", label: "My Pipeline", icon: KanbanIcon },
  { href: "/workspace/opportunities", label: "Opportunities", icon: TargetIcon },
  // ...
];
```

**Step 2: Add command palette page and quick action entries.**

```tsx
// Path: components/command-palette.tsx
import {
  // ... existing imports ...
  PlusIcon,
  TargetIcon,
} from "lucide-react";

const adminPages = [
  // ...
  { label: "Opportunities", href: "/workspace/opportunities", icon: TargetIcon },
];

const closerPages = [
  // ...
  { label: "Opportunities", href: "/workspace/opportunities", icon: TargetIcon },
];

<CommandItem onSelect={() => navigate("/workspace/opportunities/new")}>
  <PlusIcon />
  <span>Create opportunity</span>
</CommandItem>
```

**Key implementation notes:**
- The current command palette has shortcut labels for the first few pages. Do not assign a conflicting shortcut unless the keyboard shortcut map in `workspace-shell-client.tsx` is updated in the same commit.
- Coordinate with Phase 4 if it also touches `components/command-palette.tsx`; Phase 3 owns list-page nav, Phase 4 owns create quick action if work is split.
- `TargetIcon` exists in `lucide-react` and semantically matches opportunities.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/workspace-shell-client.tsx` | Modify | Add Opportunities nav for admin and closer. |
| `components/command-palette.tsx` | Modify | Add page entry and create quick action. |

---

### 3F - Frontend QA Gate

**Type:** Manual / Frontend
**Parallelizable:** No - runs after all list-page files merge.

**What:** Typecheck, lint, and manually verify behavior across admin/closer, desktop/mobile widths, search/list modes, and URL filters.

**Why:** The list is a high-frequency operational surface. Small filter or access-control mistakes create trust issues quickly.

**Where:**
- Terminal
- Local browser

**How:**

**Step 1: Run static checks.**

```bash
# Path: repo root
pnpm tsc --noEmit
pnpm lint
```

**Step 2: Start the app and test manually.**

```bash
# Path: repo root
pnpm dev
```

Verify:
- `/workspace/opportunities` renders inside workspace shell.
- URL filters update without full shell reload.
- Search switches at two characters and clears back to paginated mode.
- A closer account cannot reveal all opportunities by manually adding `?closer=<otherId>`.
- At 390px width, buttons/filter labels wrap without overlapping.

**Key implementation notes:**
- Use the in-app browser or Playwright for screenshots if there is any layout doubt.
- Confirm no UI text describes keyboard shortcuts or implementation details.
- Confirm the disabled Export CSV button has a clear `title` but no fake implementation.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| None | Manual | Verification only. |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/opportunities/page.tsx` | Create | 3A |
| `app/workspace/opportunities/loading.tsx` | Create | 3A |
| `app/workspace/opportunities/_components/skeletons/opportunities-page-skeleton.tsx` | Create | 3A |
| `app/workspace/opportunities/_components/opportunities-page-client.tsx` | Create / Modify | 3A, 3B |
| `app/workspace/opportunities/_components/opportunity-search-input.tsx` | Create | 3C |
| `app/workspace/opportunities/_components/opportunity-filters.tsx` | Create | 3C |
| `app/workspace/opportunities/_components/opportunities-table.tsx` | Create | 3D |
| `app/workspace/opportunities/_components/opportunity-source-badge.tsx` | Create | 3D |
| `app/workspace/_components/workspace-shell-client.tsx` | Modify | 3E |
| `components/command-palette.tsx` | Modify | 3E |
