# Phase 4 — Frontend: Lead List Page

**Goal:** Build the `/workspace/leads` route with a searchable, filterable, sortable lead table accessible to all CRM roles. Add "Leads" to the sidebar navigation for both admins and closers. Clicking a lead row opens the lead detail page in a new browser tab. After this phase, every CRM user can browse, search, and filter the full lead list from the sidebar.

**Prerequisite:** Phase 2 complete — `api.leads.queries.listLeads` (paginated) and `api.leads.queries.searchLeads` (full-text search) are deployed and returning enriched lead rows with `opportunityCount`, `latestMeetingAt`, and `assignedCloserName`. Phase 1 schema deployed — `leads` table has `status`, `searchText`, and all required indexes.

**Runs in PARALLEL with:** Nothing directly. Phase 5 (Lead Detail Page) can start once the shared components from 4B (`LeadStatusBadge`, `LeadSearchInput`) are complete — it does not need to wait for 4E or 4F.

**Skills to invoke:**
- `shadcn` — verify Tabs, Badge, Card, Table components are installed and available
- `frontend-design` — production-grade table layout, responsive breakpoints, empty states
- `expect` — browser verification after implementation: accessibility audit, responsive layout at 4 viewports, performance metrics, console error check

**Acceptance Criteria:**

1. Navigating to `/workspace/leads` renders the lead list page with title "Leads" and subtitle text.
2. The page uses `usePaginatedQuery` with `initialNumItems: 25` for the default list view, switching to `useQuery(searchLeads)` when a search term is entered.
3. The search input debounces at 300ms and shows a clear button when non-empty.
4. Status filter tabs ("All", "Active", "Converted", "Merged") filter both paginated and search results.
5. The table has 7 columns: Name, Email, Social (hidden on mobile), Status, Opportunities, Last Meeting (hidden below `lg`), Closer (hidden below `lg`).
6. Name, Email, Status, Opportunities, and Last Meeting columns are sortable via `useTableSort` + `SortableHeader`.
7. Clicking any table row calls `window.open(\`/workspace/leads/${leadId}\`, "_blank")` to open the detail in a new tab.
8. The empty state uses the `Empty` component family and distinguishes between "no leads yet" (no data) and "no leads found" (search returned nothing).
9. A "Load more" button appears when `paginationStatus === "CanLoadMore"` and is hidden during search mode.
10. The "Leads" nav item (with `ContactIcon`) appears in both `adminNavItems` (after Pipeline) and `closerNavItems` (at the end).
11. The `loading.tsx` skeleton matches the page layout dimensions (header + filter bar + 8 table rows).
12. `LeadStatusBadge` renders "Active" in green/emerald, "Converted" in blue, and "Merged" in gray/muted.
13. The page title is set to "Leads -- Magnus CRM" via `usePageTitle("Leads")`.
14. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (Route Files: page.tsx + loading.tsx) ────────────────────────┐
                                                                  │
4B (Shared Components: LeadStatusBadge + LeadSearchInput) ───────┤
                                                                  ├── 4E (LeadsTable Component)
4C (Lead List Skeleton) ─────────────────────────────────────────┤      │
                                                                  │      ↓
4D (Navigation Update) ──────────────────────────────────────────┤  4F (Page Content: LeadsPageClient + LeadsPageContent)
                                                                  │
```

**Optimal execution:**

1. Start **4A**, **4B**, **4C**, and **4D** all in parallel — they create independent files with no overlap.
2. Once **4B** is complete → start **4E** (the table component imports `LeadStatusBadge`).
3. Once **4A**, **4B**, and **4E** are complete → start **4F** (wires `LeadsPageClient`, `LeadsPageContent`, search state, paginated query, and the table together).

**Estimated time:** 2-3 hours

---

## Subphases

### 4A — Route Files: page.tsx + loading.tsx

**Type:** Frontend
**Parallelizable:** Yes — no dependencies. Independent of all other subphases.

**What:** Create the thin RSC page wrapper at `app/workspace/leads/page.tsx` and the route-level loading skeleton at `app/workspace/leads/loading.tsx`.

**Why:** These are the Next.js route entry points. The page file follows the codebase's established pattern of a static RSC wrapper that delegates to a `*-page-client.tsx` component. The loading file provides the Suspense fallback shown during route transitions.

**Where:**
- `app/workspace/leads/page.tsx` (create)
- `app/workspace/leads/loading.tsx` (create)

**How:**

**Step 1: Create the page file**

```tsx
// Path: app/workspace/leads/page.tsx
import { LeadsPageClient } from "./_components/leads-page-client";

export const unstable_instant = false;

export default function LeadsPage() {
  return <LeadsPageClient />;
}
```

**Step 2: Create the loading file**

```tsx
// Path: app/workspace/leads/loading.tsx
import { LeadsSkeleton } from "./_components/skeletons/leads-skeleton";

export default function LeadsLoading() {
  return <LeadsSkeleton />;
}
```

**Key implementation notes:**
- `export const unstable_instant = false` is required on all pages per the codebase's PPR-ready architecture.
- The loading file imports the skeleton component created in 4C. If implementing 4A before 4C, create a minimal placeholder and replace it once 4C is done.
- The `_components/` directory follows Next.js convention — it is not routable.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads/page.tsx` | Create | Thin RSC wrapper delegating to `LeadsPageClient` |
| `app/workspace/leads/loading.tsx` | Create | Route-level skeleton using `LeadsSkeleton` |

---

### 4B — Shared Components: LeadStatusBadge + LeadSearchInput

**Type:** Frontend
**Parallelizable:** Yes — no dependencies. These are shared components reused in Phase 4 (list page), Phase 5 (detail page), and Phase 6 (merge page).

**What:** Create two shared components under `app/workspace/leads/_components/`:
1. `LeadStatusBadge` — renders a styled badge for lead status values ("Active", "Converted", "Merged").
2. `LeadSearchInput` — a debounced text input with 300ms delay, search icon, and clear button.

**Why:** Both components are consumed by the table (4E), the page content (4F), and later phases. Building them first unblocks downstream subphases and ensures consistent styling across all lead-related views.

**Where:**
- `app/workspace/leads/_components/lead-status-badge.tsx` (create)
- `app/workspace/leads/_components/lead-search-input.tsx` (create)

**How:**

**Step 1: Create `LeadStatusBadge`**

```tsx
// Path: app/workspace/leads/_components/lead-status-badge.tsx
"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type LeadStatus = "active" | "converted" | "merged";

const statusConfig: Record<LeadStatus, { label: string; className: string }> = {
  active: {
    label: "Active",
    className:
      "bg-emerald-500/10 text-emerald-700 border-emerald-200 dark:text-emerald-400 dark:border-emerald-900",
  },
  converted: {
    label: "Converted",
    className:
      "bg-blue-500/10 text-blue-700 border-blue-200 dark:text-blue-400 dark:border-blue-900",
  },
  merged: {
    label: "Merged",
    className:
      "bg-muted text-muted-foreground border-border",
  },
};

interface LeadStatusBadgeProps {
  status: LeadStatus;
  className?: string;
}

/**
 * Visual badge for lead status. Used in the lead list table (Phase 4)
 * and lead detail header (Phase 5).
 *
 * - Active: emerald/green — the lead is live and receiving bookings
 * - Converted: blue — the lead has been converted to a customer (Feature D)
 * - Merged: gray/muted — the lead was merged into another lead
 */
export function LeadStatusBadge({ status, className }: LeadStatusBadgeProps) {
  const config = statusConfig[status];

  return (
    <Badge
      variant="outline"
      className={cn(config.className, className)}
    >
      {config.label}
    </Badge>
  );
}
```

**Step 2: Create `LeadSearchInput`**

```tsx
// Path: app/workspace/leads/_components/lead-search-input.tsx
"use client";

import { useRef, useCallback, useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { SearchIcon, XIcon } from "lucide-react";

interface LeadSearchInputProps {
  value: string;
  onChange: (term: string) => void;
}

/**
 * Debounced search input for the lead list and merge target search.
 *
 * - 300ms debounce delay prevents excessive Convex queries on fast typing
 * - Local state keeps the input responsive while the debounced value propagates
 * - Clear button (XIcon) resets both local and parent state instantly
 */
export function LeadSearchInput({ value, onChange }: LeadSearchInputProps) {
  const [localValue, setLocalValue] = useState(value);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce search input by 300ms
  const handleChange = useCallback(
    (newValue: string) => {
      setLocalValue(newValue);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onChange(newValue);
      }, 300);
    },
    [onChange],
  );

  // Sync external value changes (e.g., programmatic reset)
  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div className="relative w-full sm:max-w-xs">
      <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={localValue}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="Search by name, email, phone, or social..."
        className="pl-9 pr-8"
      />
      {localValue.length > 0 && (
        <button
          type="button"
          onClick={() => handleChange("")}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label="Clear search"
        >
          <XIcon className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
```

**Key implementation notes:**
- `LeadStatusBadge` uses `Badge variant="outline"` with custom color classes, consistent with the codebase's `StatusBadge` pattern in `components/status-badge.tsx` and the opportunity status config in `lib/status-config.ts`.
- The emerald/green color for "Active" was chosen to distinguish from the blue `scheduled` opportunity status. "Converted" uses blue to match the semantic meaning of progression. "Merged" uses muted gray to indicate the lead is no longer independently active.
- `LeadSearchInput` uses a dual-state pattern: `localValue` keeps the input responsive, while the debounced `onChange` callback fires after 300ms of idle time. This prevents the Convex `searchLeads` query from firing on every keystroke.
- The clear button calls `handleChange("")` rather than directly setting both states, ensuring the debounced parent callback fires immediately on clear (the timeout resets and fires with empty string after 300ms, but the user sees the input clear instantly).
- Both components are marked `"use client"` because they use hooks or browser APIs.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads/_components/lead-status-badge.tsx` | Create | Badge with 3 status variants: active (emerald), converted (blue), merged (muted) |
| `app/workspace/leads/_components/lead-search-input.tsx` | Create | Debounced search input with 300ms delay, SearchIcon, XIcon clear button |

---

### 4C — Lead List Skeleton

**Type:** Frontend
**Parallelizable:** Yes — no dependencies. Can be built alongside 4A, 4B, and 4D.

**What:** Create the loading skeleton for the leads list page at `app/workspace/leads/_components/skeletons/leads-skeleton.tsx`. The skeleton matches the layout dimensions of the fully loaded page (header, filter bar, and table rows) to prevent CLS.

**Why:** This skeleton is the fallback for both the route-level `loading.tsx` (4A) and the Suspense boundary in `LeadsPageClient` (4F). It must match the real content dimensions so the user sees a smooth transition from skeleton to data.

**Where:**
- `app/workspace/leads/_components/skeletons/leads-skeleton.tsx` (create)

**How:**

**Step 1: Create the skeleton component**

```tsx
// Path: app/workspace/leads/_components/skeletons/leads-skeleton.tsx
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading skeleton for the leads list page.
 *
 * Layout structure matches LeadsPageContent:
 * 1. Header row (title + subtitle + export button)
 * 2. Search + filter bar (Card with search input + tabs)
 * 3. Table rows (8 rows inside a rounded border container)
 */
export function LeadsSkeleton() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="Loading leads">
      {/* Header with title + export button */}
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-5 w-72" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>

      {/* Search + filter bar */}
      <Card className="p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <Skeleton className="h-9 w-full sm:max-w-xs" />
          <Skeleton className="h-9 w-64" />
        </div>
      </Card>

      {/* Table rows */}
      <div className="overflow-hidden rounded-lg border">
        {/* Table header */}
        <div className="border-b bg-muted/50 px-4 py-3">
          <div className="flex gap-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="hidden h-4 w-20 md:block" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="hidden h-4 w-24 lg:block" />
            <Skeleton className="hidden h-4 w-20 lg:block" />
          </div>
        </div>
        {/* Table body rows */}
        <div className="flex flex-col">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 border-b px-4 py-3 last:border-b-0">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-36" />
              <Skeleton className="hidden h-4 w-20 md:block" />
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-4 w-8" />
              <Skeleton className="hidden h-4 w-24 lg:block" />
              <Skeleton className="hidden h-4 w-20 lg:block" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

**Key implementation notes:**
- The skeleton uses `role="status"` and `aria-label="Loading leads"` for accessibility, consistent with the existing `PipelineLoading` and `TeamLoading` skeletons.
- Column widths approximate the real table content to minimize layout shift. The `hidden md:block` and `hidden lg:block` responsive classes match the table's responsive column visibility in 4E.
- The header skeleton matches the `h-8` title and `h-5` subtitle heights from the actual page content.
- The search + filter bar skeleton uses the same `Card className="p-4"` wrapper and responsive flex layout as the real component.
- This component is a Server Component by default (no `"use client"` directive) because it has no interactivity — just Skeleton primitives.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads/_components/skeletons/leads-skeleton.tsx` | Create | Loading skeleton matching leads list page layout |

---

### 4D — Navigation Update

**Type:** Frontend
**Parallelizable:** Yes — no dependencies on other subphases. Modifies a single existing file.

**What:** Add a "Leads" navigation item (with `ContactIcon` from `lucide-react`) to both the `adminNavItems` and `closerNavItems` arrays in `app/workspace/_components/workspace-shell-client.tsx`.

**Why:** Without a sidebar link, users can only reach `/workspace/leads` by typing the URL. The nav item makes the new page discoverable. Both admin and closer roles can view leads (`lead:view-all` permission), so both nav arrays need the item.

**Where:**
- `app/workspace/_components/workspace-shell-client.tsx` (modify)

**How:**

**Step 1: Add `ContactIcon` to the lucide-react import**

Before:

```typescript
// Path: app/workspace/_components/workspace-shell-client.tsx
import {
  KanbanIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  SettingsIcon,
  type LucideIcon,
  UserCircleIcon,
  UsersIcon,
} from "lucide-react";
```

After:

```typescript
// Path: app/workspace/_components/workspace-shell-client.tsx
import {
  ContactIcon,
  KanbanIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  SettingsIcon,
  type LucideIcon,
  UserCircleIcon,
  UsersIcon,
} from "lucide-react";
```

**Step 2: Add "Leads" to `adminNavItems`**

Insert after Pipeline and before Team to group data-browsing routes together:

Before:

```typescript
// Path: app/workspace/_components/workspace-shell-client.tsx
const adminNavItems: NavItem[] = [
  { href: "/workspace", label: "Overview", icon: LayoutDashboardIcon, exact: true },
  { href: "/workspace/team", label: "Team", icon: UsersIcon },
  { href: "/workspace/pipeline", label: "Pipeline", icon: KanbanIcon },
  { href: "/workspace/settings", label: "Settings", icon: SettingsIcon },
];
```

After:

```typescript
// Path: app/workspace/_components/workspace-shell-client.tsx
const adminNavItems: NavItem[] = [
  { href: "/workspace", label: "Overview", icon: LayoutDashboardIcon, exact: true },
  { href: "/workspace/pipeline", label: "Pipeline", icon: KanbanIcon },
  { href: "/workspace/leads", label: "Leads", icon: ContactIcon },
  { href: "/workspace/team", label: "Team", icon: UsersIcon },
  { href: "/workspace/settings", label: "Settings", icon: SettingsIcon },
];
```

**Step 3: Add "Leads" to `closerNavItems`**

Append at the end of the closer nav:

Before:

```typescript
// Path: app/workspace/_components/workspace-shell-client.tsx
const closerNavItems: NavItem[] = [
  { href: "/workspace/closer", label: "Dashboard", icon: LayoutDashboardIcon, exact: true },
  { href: "/workspace/closer/pipeline", label: "My Pipeline", icon: KanbanIcon },
];
```

After:

```typescript
// Path: app/workspace/_components/workspace-shell-client.tsx
const closerNavItems: NavItem[] = [
  { href: "/workspace/closer", label: "Dashboard", icon: LayoutDashboardIcon, exact: true },
  { href: "/workspace/closer/pipeline", label: "My Pipeline", icon: KanbanIcon },
  { href: "/workspace/leads", label: "Leads", icon: ContactIcon },
];
```

**Key implementation notes:**
- `ContactIcon` is the lucide-react icon for a person's contact card. It visually communicates "lead" better than `UserIcon` (which is used for profile) or `UsersIcon` (which is used for Team).
- The admin nav reorders existing items: Pipeline moves before Team so that the data-browsing routes (Pipeline, Leads) are grouped together, followed by the management routes (Team, Settings). This matches the design doc's specified order.
- The closer nav appends Leads at the end because the closer's primary workflow is Dashboard → My Pipeline → (occasionally) Leads. The leads route is at `/workspace/leads` (not `/workspace/closer/leads`) because it's a shared route — see design doc Section 7.5 decision.
- The `exact` property is not set on the Leads item, so `pathname.startsWith("/workspace/leads")` will highlight the nav item on both the list page and any nested routes (`/workspace/leads/[leadId]`, `/workspace/leads/[leadId]/merge`).
- Keyboard shortcuts remain unchanged — Cmd+1 through Cmd+4 map to array indices. With the new admin order (Overview, Pipeline, Leads, Team, Settings), Cmd+3 now navigates to Leads and Cmd+4 to Team. For closers (Dashboard, My Pipeline, Leads), Cmd+3 navigates to Leads.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/workspace-shell-client.tsx` | Modify | Add `ContactIcon` import; add "Leads" nav item to both `adminNavItems` and `closerNavItems` |

---

### 4E — LeadsTable Component

**Type:** Frontend
**Parallelizable:** No — depends on **4B** (imports `LeadStatusBadge`).

**What:** Create the `LeadsTable` component at `app/workspace/leads/_components/leads-table.tsx`. This is a sortable table with 7 columns, responsive column visibility, client-side sorting via `useTableSort`, empty state handling, and a "Load more" button for pagination.

**Why:** The table is the core UI of the leads list page. Separating it from the page content component keeps concerns clean — the table handles display and sorting while the page content handles data fetching and state.

**Where:**
- `app/workspace/leads/_components/leads-table.tsx` (create)

**How:**

**Step 1: Create the table component**

```tsx
// Path: app/workspace/leads/_components/leads-table.tsx
"use client";

import { useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { SortableHeader } from "@/components/sortable-header";
import { useTableSort } from "@/hooks/use-table-sort";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { LeadStatusBadge } from "./lead-status-badge";
import { SearchIcon, InboxIcon } from "lucide-react";
import { format } from "date-fns";
import type { Id } from "@/convex/_generated/dataModel";

type LeadRow = {
  _id: Id<"leads">;
  fullName?: string;
  email: string;
  phone?: string;
  status?: "active" | "converted" | "merged";
  socialHandles?: Array<{ type: string; handle: string }>;
  opportunityCount: number;
  latestMeetingAt: number | null;
  assignedCloserName: string | null;
};

interface LeadsTableProps {
  leads: LeadRow[];
  isSearching: boolean;
  isLoading: boolean;
  canLoadMore: boolean;
  onLoadMore: () => void;
  onLeadClick: (leadId: Id<"leads">) => void;
}

type SortKey = "name" | "email" | "status" | "opportunities" | "meetings";

export function LeadsTable({
  leads,
  isSearching,
  isLoading,
  canLoadMore,
  onLoadMore,
  onLeadClick,
}: LeadsTableProps) {
  const comparators = useMemo(
    () => ({
      name: (a: LeadRow, b: LeadRow) =>
        (a.fullName ?? a.email).localeCompare(b.fullName ?? b.email),
      email: (a: LeadRow, b: LeadRow) => a.email.localeCompare(b.email),
      status: (a: LeadRow, b: LeadRow) =>
        (a.status ?? "active").localeCompare(b.status ?? "active"),
      meetings: (a: LeadRow, b: LeadRow) =>
        (b.latestMeetingAt ?? 0) - (a.latestMeetingAt ?? 0),
      opportunities: (a: LeadRow, b: LeadRow) =>
        b.opportunityCount - a.opportunityCount,
    }),
    [],
  );

  const { sorted, sort, toggle } = useTableSort<LeadRow, SortKey>(leads, comparators);

  // Empty state
  if (!isLoading && leads.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            {isSearching ? <SearchIcon /> : <InboxIcon />}
          </EmptyMedia>
          <EmptyTitle>
            {isSearching ? "No leads found" : "No leads yet"}
          </EmptyTitle>
          <EmptyDescription>
            {isSearching
              ? "Try adjusting your search term or filters."
              : "Leads will appear here as new bookings come in through Calendly."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div>
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHeader
                label="Name"
                sortKey="name"
                sort={sort}
                onToggle={toggle}
              />
              <SortableHeader
                label="Email"
                sortKey="email"
                sort={sort}
                onToggle={toggle}
              />
              <TableHead className="hidden md:table-cell">Social</TableHead>
              <SortableHeader
                label="Status"
                sortKey="status"
                sort={sort}
                onToggle={toggle}
              />
              <SortableHeader
                label="Opportunities"
                sortKey="opportunities"
                sort={sort}
                onToggle={toggle}
                className="text-right"
              />
              <SortableHeader
                label="Last Meeting"
                sortKey="meetings"
                sort={sort}
                onToggle={toggle}
                className="hidden lg:table-cell"
              />
              <TableHead className="hidden lg:table-cell">Closer</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((lead) => (
              <TableRow
                key={lead._id}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => onLeadClick(lead._id)}
              >
                <TableCell className="font-medium">
                  {lead.fullName ?? "\u2014"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {lead.email}
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  {lead.socialHandles && lead.socialHandles.length > 0 ? (
                    <span className="text-xs text-muted-foreground">
                      {lead.socialHandles.map((s) => `@${s.handle}`).join(", ")}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{"\u2014"}</span>
                  )}
                </TableCell>
                <TableCell>
                  <LeadStatusBadge status={lead.status ?? "active"} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {lead.opportunityCount}
                </TableCell>
                <TableCell className="hidden lg:table-cell text-muted-foreground">
                  {lead.latestMeetingAt
                    ? format(new Date(lead.latestMeetingAt), "MMM d, yyyy")
                    : "\u2014"}
                </TableCell>
                <TableCell className="hidden lg:table-cell text-muted-foreground">
                  {lead.assignedCloserName ?? "\u2014"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {canLoadMore && (
        <div className="flex justify-center py-4">
          <Button variant="outline" size="sm" onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
```

**Key implementation notes:**
- **`SortableHeader` is used directly in `<TableRow>`, not nested inside `<TableHead>`.** The `SortableHeader` component renders its own `<TableHead>` wrapper internally (see `components/sortable-header.tsx`). This matches the established pattern in `app/workspace/pipeline/_components/opportunities-table.tsx`. The design doc's code (Section 7.6) incorrectly nests `SortableHeader` inside `<TableHead>` — do NOT follow that nesting.
- The `SortKey` type alias constrains the sort keys to the 5 sortable columns. The Social and Closer columns are not sortable — Social has no natural sort order (array of handles), and Closer is a denormalized name that may be null.
- `useMemo` wraps the `comparators` record to prevent re-creation on every render, following `vercel-react-best-practices: rendering-hoist-jsx`.
- Empty state uses `EmptyMedia variant="icon"` with `SearchIcon` (for search-no-results) or `InboxIcon` (for no-data), matching the pattern in `app/workspace/pipeline/_components/opportunities-table.tsx`.
- `"\u2014"` is the em dash character, used for missing values instead of rendering blank cells.
- Responsive column visibility: Social is hidden below `md` (768px), Last Meeting and Closer are hidden below `lg` (1024px). This ensures the table is usable on tablets and phones with only the essential columns (Name, Email, Status, Opportunities).
- The `tabular-nums` class on the Opportunities cell ensures numbers are monospaced for vertical alignment.
- `format` from `date-fns` is tree-shaken via the `optimizePackageImports` config in `next.config.ts`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads/_components/leads-table.tsx` | Create | Sortable 7-column table with empty state, responsive visibility, and "Load more" button |

---

### 4F — Page Content: LeadsPageClient + LeadsPageContent

**Type:** Frontend
**Parallelizable:** No — depends on **4A** (route files exist), **4B** (search input component), and **4E** (table component).

**What:** Create the two client-side components that wire everything together:
1. `LeadsPageClient` — sets page title, wraps content in Suspense with skeleton fallback.
2. `LeadsPageContent` — manages search state, status filter tabs, paginated/search query switching, and renders the table.

**Why:** This is the integration layer. `LeadsPageClient` is the thin client boundary referenced by the RSC page wrapper (4A). `LeadsPageContent` is the substantial component that manages all interactive state and data fetching. The two-component split follows the codebase's pattern of separating the Suspense boundary from the content.

**Where:**
- `app/workspace/leads/_components/leads-page-client.tsx` (create)
- `app/workspace/leads/_components/leads-page-content.tsx` (create)

**How:**

**Step 1: Create `LeadsPageClient`**

```tsx
// Path: app/workspace/leads/_components/leads-page-client.tsx
"use client";

import { Suspense } from "react";
import { LeadsPageContent } from "./leads-page-content";
import { LeadsSkeleton } from "./skeletons/leads-skeleton";
import { usePageTitle } from "@/hooks/use-page-title";

export function LeadsPageClient() {
  usePageTitle("Leads");

  return (
    <Suspense fallback={<LeadsSkeleton />}>
      <LeadsPageContent />
    </Suspense>
  );
}
```

**Step 2: Create `LeadsPageContent`**

```tsx
// Path: app/workspace/leads/_components/leads-page-content.tsx
"use client";

import { useState, useCallback } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useRole } from "@/components/auth/role-context";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DownloadIcon } from "lucide-react";
import { LeadSearchInput } from "./lead-search-input";
import { LeadsTable } from "./leads-table";
import type { Id } from "@/convex/_generated/dataModel";

type StatusFilter = "all" | "active" | "converted" | "merged";

export function LeadsPageContent() {
  const { hasPermission } = useRole();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [searchTerm, setSearchTerm] = useState("");

  // Paginated list (when not searching)
  const {
    results: paginatedLeads,
    status: paginationStatus,
    loadMore,
  } = usePaginatedQuery(
    api.leads.queries.listLeads,
    searchTerm.trim().length > 0
      ? "skip"
      : {
          statusFilter: statusFilter === "all" ? undefined : statusFilter,
        },
    { initialNumItems: 25 },
  );

  // Search results (when searching)
  const searchResults = useQuery(
    api.leads.queries.searchLeads,
    searchTerm.trim().length > 0
      ? {
          searchTerm: searchTerm.trim(),
          statusFilter: statusFilter === "all" ? undefined : statusFilter,
        }
      : "skip",
  );

  const leads = searchTerm.trim().length > 0 ? searchResults ?? [] : paginatedLeads;
  const isSearching = searchTerm.trim().length > 0;

  const handleSearchChange = useCallback((term: string) => {
    setSearchTerm(term);
  }, []);

  // Open lead detail in a new browser tab
  const handleLeadClick = useCallback((leadId: Id<"leads">) => {
    window.open(`/workspace/leads/${leadId}`, "_blank");
  }, []);

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="text-sm text-muted-foreground">
            Manage leads, merge duplicates, and track identities.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasPermission("lead:export") && (
            <Button variant="outline" size="sm" disabled title="Coming soon">
              <DownloadIcon data-icon="inline-start" />
              Export CSV
            </Button>
          )}
        </div>
      </div>

      {/* Search + Filters */}
      <Card className="p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <LeadSearchInput
            value={searchTerm}
            onChange={handleSearchChange}
          />
          <Tabs
            value={statusFilter}
            onValueChange={(val) => setStatusFilter(val as StatusFilter)}
          >
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="active">Active</TabsTrigger>
              <TabsTrigger value="converted">Converted</TabsTrigger>
              <TabsTrigger value="merged">Merged</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </Card>

      {/* Lead Table — row clicks open a new tab */}
      <LeadsTable
        leads={leads}
        isSearching={isSearching}
        isLoading={paginationStatus === "LoadingFirstPage"}
        canLoadMore={!isSearching && paginationStatus === "CanLoadMore"}
        onLoadMore={() => loadMore(25)}
        onLeadClick={handleLeadClick}
      />
    </div>
  );
}
```

**Key implementation notes:**
- **Dual query strategy:** The page uses `usePaginatedQuery` for the default list view and `useQuery(searchLeads)` for search. When `searchTerm` is non-empty, the paginated query receives `"skip"` (Convex convention for disabling a query), and vice versa. This prevents both queries from running simultaneously and wasting bandwidth/subscriptions.
- **Status filter applies to both queries:** When `statusFilter !== "all"`, the value is passed to both `listLeads` (as `statusFilter` arg) and `searchLeads` (as `statusFilter` arg). Both queries accept `v.optional(v.union(...))`, with `undefined` meaning "all statuses".
- **`handleLeadClick` uses `window.open`** per the design doc's decision. This opens the lead detail in a new browser tab, letting the user keep the lead list open for cross-referencing. The `"_blank"` target creates a new tab (not a new window).
- **Export CSV button is disabled** with `title="Coming soon"`. The `lead:export` permission gates its visibility (admins only). The actual export implementation is deferred per the design doc's Non-Goals.
- **`useCallback` wraps both handlers** to maintain stable references, preventing unnecessary re-renders of child components (`LeadSearchInput`, `LeadsTable`).
- The `isLoading` prop for `LeadsTable` uses `paginationStatus === "LoadingFirstPage"` — this is the initial loading state from `usePaginatedQuery`. During search mode, `searchResults` being `undefined` means Convex is still loading; `searchResults` being `[]` means no results. The table's empty state handles the latter case.
- The responsive layout (`flex-col gap-4 sm:flex-row`) stacks the search input and tabs vertically on mobile, and shows them side-by-side on `sm` (640px) and above.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads/_components/leads-page-client.tsx` | Create | Client boundary with `usePageTitle("Leads")` + Suspense wrapper |
| `app/workspace/leads/_components/leads-page-content.tsx` | Create | Search state, filter tabs, paginated + search query switching, table rendering |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/leads/page.tsx` | Create | 4A |
| `app/workspace/leads/loading.tsx` | Create | 4A |
| `app/workspace/leads/_components/lead-status-badge.tsx` | Create | 4B |
| `app/workspace/leads/_components/lead-search-input.tsx` | Create | 4B |
| `app/workspace/leads/_components/skeletons/leads-skeleton.tsx` | Create | 4C |
| `app/workspace/_components/workspace-shell-client.tsx` | Modify | 4D |
| `app/workspace/leads/_components/leads-table.tsx` | Create | 4E |
| `app/workspace/leads/_components/leads-page-client.tsx` | Create | 4F |
| `app/workspace/leads/_components/leads-page-content.tsx` | Create | 4F |

---

## Notes for Implementer

- **SortableHeader renders its own `<TableHead>`.** The `SortableHeader` component wraps content in `<TableHead>` internally. Do NOT nest it inside another `<TableHead>` — this would produce `<th><th>` which is invalid HTML. Use `SortableHeader` directly inside `<TableRow>`, matching the pattern in `app/workspace/pipeline/_components/opportunities-table.tsx`. The design doc Section 7.6 incorrectly nests them.
- **Admin nav item reordering.** The current `adminNavItems` array puts Team before Pipeline. This phase reorders it to: Overview, Pipeline, Leads, Team, Settings. This groups data-browsing routes (Pipeline, Leads) together. This changes the Cmd+2 shortcut from Team to Pipeline, and Cmd+3 from Pipeline to Leads. If this reordering is undesirable, insert Leads after Pipeline without moving Team — the Phase plan's `adminNavItems` placement should be discussed before implementation.
- **No new RBAC permissions needed in this phase.** The `lead:view-all`, `lead:export`, and `lead:merge` permissions are defined in Phase 1. The `useRole().hasPermission()` calls in the page content reference these already-deployed permissions. If Phase 1 has not been deployed, the `hasPermission` calls will return `false` and the Export button will be hidden — this is safe degradation.
- **Shared components for Phase 5.** `LeadStatusBadge` and `LeadSearchInput` (from 4B) are imported by Phase 5's detail page and Phase 6's merge page. Once 4B is complete, Phase 5 can begin implementing the detail page client component.
- **Read the Convex AI guidelines** (`convex/_generated/ai/guidelines.md`) before making any backend query changes. Phase 4 is pure frontend, but the `usePaginatedQuery` and `useQuery` usage must align with Convex's client-side subscription model.
- **Use `expect` for browser verification.** After implementing all subphases: (1) verify the page renders with real or seeded data (minimum 3 leads), (2) test search with 300ms debounce, (3) test all 4 status filter tabs, (4) verify sort toggles cycle correctly (null -> asc -> desc -> null), (5) verify row click opens new tab, (6) test responsive layout at 4 viewports (mobile 375px, tablet 768px, desktop 1024px, wide 1440px), (7) run accessibility audit, (8) check performance metrics, (9) verify no console errors.
- **Dark mode.** Test both light and dark themes. The `LeadStatusBadge` and skeleton components use `dark:` variants. The table hover state (`hover:bg-muted/50`) and all border colors work in both themes via CSS custom properties.
