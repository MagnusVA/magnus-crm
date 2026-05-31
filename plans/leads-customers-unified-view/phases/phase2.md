# Phase 2 — Unified Route and Search Workspace

**Goal:** Add `/workspace/leads-customers` as the new searchable browse workspace while leaving old Leads, Customers, and Opportunities navigation/routes intact. After this phase, users can search, filter, paginate, open entity rows, and create a side deal from the new route behind the existing `lead:view-all` and `pipeline:view-own` gates.

**Prerequisite:** Phase 1A complete with generated API names available. For real data wiring, Phase 1E must be merged. Phase 1C backfill should pass before the route is exposed outside development/testing.

**Runs in PARALLEL with:** Phase 3 can run in parallel after Phase 1F publishes the detail payload contract. Phase 4 redirect resolver backend can begin after Phase 1E. Phase 5 nav flip must wait until this phase is verified.

**Skills to invoke:**
- `frontend-design` — build the compact operational search workspace, not a landing page.
- `shadcn` — compose `Table`, `Badge`, `Button`, `Input`, `ToggleGroup`, `Skeleton`, `Tooltip`, and responsive primitives.
- `next-best-practices` — route file stays a thin Server Component with Suspense/loading boundaries.
- `vercel-react-best-practices` — keep URL state stable, avoid unnecessary rerenders, and avoid overfetching.
- `web-design-guidelines` — audit focus, keyboard navigation, link semantics, mobile overflow, skeletons, and dark mode.

**Acceptance Criteria:**
1. `/workspace/leads-customers` renders for `tenant_master`, `tenant_admin`, and `closer` users who have `lead:view-all`; `lead_generator` users are redirected by the server gate.
2. The page has a compact search field that syncs `q` to the URL, debounces user input by 250-300 ms, and skips fuzzy search for terms shorter than 2 characters unless direct ID resolution applies.
3. Lifecycle filters for All, Leads, and Customers sync to URL state and drive server-side Convex filtering before pagination/search results render.
4. Browse mode paginates through `api.leadCustomers.queries.listEntities`; search mode uses `api.leadCustomers.queries.searchEntities`.
5. Result rows are real `Link` targets to `/workspace/leads-customers/[leadId]`, preserving Cmd/Ctrl-click and middle-click behavior.
6. Direct opportunity/meeting ID hits include an "Open opportunity" affordance that navigates to `/workspace/leads-customers/[leadId]?opportunityId=<id>`.
7. The route has `loading.tsx` and skeleton states with `role="status"` and `aria-label`, matching the final layout dimensions closely enough to avoid obvious CLS.
8. The new side-deal route `/workspace/leads-customers/new-opportunity` works with the existing create-manual opportunity flow and old `/workspace/opportunities/new` still works until Phase 4.
9. Desktop and mobile layouts do not overlap text, controls, or row actions in light or dark mode.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (route shell + skeleton) ───────────────┬── 2B (URL state/provider)
                                          │
                                          ├── 2C (search/filter controls)
                                          │
Phase 1E query contract ──────────────────┴── 2D (results/list wiring) ─────┐
                                                                            ├── 2F (responsive/a11y QA)
2E (new side-deal route) ───────────────────────────────────────────────────┘
```

**Optimal execution:**
1. Start 2A and 2E in parallel. They touch different route directories and can use existing components.
2. Build 2B once route search param conventions are agreed.
3. Build 2C and 2D in parallel after 2B; 2C owns controls, 2D owns data and row rendering.
4. Run 2F after the route, controls, results, and side-deal entry are all wired.

**Estimated time:** 3-5 days

---

## Subphases

### 2A — Route Shell, Loading State, and Skeleton

**Type:** Frontend / Next.js
**Parallelizable:** Yes — independent of result wiring and new side-deal route; it defines the route boundary other subphases fill in.

**What:** Create the thin App Router page, loading file, page client, and skeleton for `/workspace/leads-customers`.

**Why:** The route should exist early so Phase 2 subphases can iterate in the browser without changing old navigation.

**Where:**
- `app/workspace/leads-customers/page.tsx` (new)
- `app/workspace/leads-customers/loading.tsx` (new)
- `app/workspace/leads-customers/_components/leads-customers-page-client.tsx` (new)
- `app/workspace/leads-customers/_components/leads-customers-skeleton.tsx` (new)

**How:**

**Step 1: Add the server route.**

```tsx
// Path: app/workspace/leads-customers/page.tsx
import { Suspense } from "react";
import { requirePermission } from "@/lib/auth";
import { LeadsCustomersPageClient } from "./_components/leads-customers-page-client";
import { LeadsCustomersSkeleton } from "./_components/leads-customers-skeleton";

export const unstable_instant = false;

export default async function LeadsCustomersPage() {
  await requirePermission("lead:view-all");

  return (
    <Suspense fallback={<LeadsCustomersSkeleton />}>
      <LeadsCustomersPageClient />
    </Suspense>
  );
}
```

**Step 2: Add the segment loading file.**

```tsx
// Path: app/workspace/leads-customers/loading.tsx
import { LeadsCustomersSkeleton } from "./_components/leads-customers-skeleton";

export default function Loading() {
  return <LeadsCustomersSkeleton />;
}
```

**Step 3: Add a page client placeholder.**

```tsx
// Path: app/workspace/leads-customers/_components/leads-customers-page-client.tsx
"use client";

import { usePageTitle } from "@/hooks/use-page-title";
import { EntityBrowserProvider } from "./entity-browser-context";
import { useEntityBrowserUrlState } from "./use-entity-browser-url-state";
import { LeadsCustomersSkeleton } from "./leads-customers-skeleton";

export function LeadsCustomersPageClient() {
  usePageTitle("Leads & Customers");
  const browser = useEntityBrowserUrlState();

  return (
    <EntityBrowserProvider value={browser}>
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
        <LeadsCustomersSkeleton />
      </div>
    </EntityBrowserProvider>
  );
}
```

**Step 4: Add a layout-matching skeleton.**

```tsx
// Path: app/workspace/leads-customers/_components/leads-customers-skeleton.tsx
import { Skeleton } from "@/components/ui/skeleton";

export function LeadsCustomersSkeleton() {
  return (
    <div
      className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8"
      role="status"
      aria-label="Loading leads and customers workspace"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-9 w-36" />
      </div>
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-9 w-72 max-w-full" />
      <div className="rounded-md border">
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index} className="grid grid-cols-4 gap-4 border-b p-3 last:border-b-0">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}
```

**Key implementation notes:**
- Keep the page file server-only; all URL state and Convex hooks live in client components.
- Do not update sidebar or command palette in this phase.
- Skeleton dimensions should mirror final controls and result rows.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads-customers/page.tsx` | Create | Server route and permission gate |
| `app/workspace/leads-customers/loading.tsx` | Create | Segment loading UI |
| `app/workspace/leads-customers/_components/leads-customers-page-client.tsx` | Create | Client boundary |
| `app/workspace/leads-customers/_components/leads-customers-skeleton.tsx` | Create | Layout-matching skeleton |

---

### 2B — URL State Provider and Debounced Query State

**Type:** Frontend
**Parallelizable:** Yes — depends on 2A route existence but not on result table or backend data completion.

**What:** Add a provider-backed state layer for search text, lifecycle filter, debounced query value, and URL updates.

**Why:** Search controls, result list, export actions, and direct-hit links should share one URL-backed state source instead of prop-drilling booleans through a monolithic page.

**Where:**
- `app/workspace/leads-customers/_components/entity-browser-context.tsx` (new)
- `app/workspace/leads-customers/_components/use-entity-browser-url-state.ts` (new)
- `app/workspace/leads-customers/_components/use-debounced-value.ts` (new)

**How:**

**Step 1: Create the context.**

```tsx
// Path: app/workspace/leads-customers/_components/entity-browser-context.tsx
"use client";

import { createContext, use, type ReactNode } from "react";

export type EntityLifecycleFilter = "all" | "lead" | "customer";

type EntityBrowserState = {
  query: string;
  debouncedQuery: string;
  lifecycle: EntityLifecycleFilter;
};

type EntityBrowserActions = {
  setQuery: (value: string) => void;
  setLifecycle: (value: EntityLifecycleFilter) => void;
};

export type EntityBrowserContextValue = {
  state: EntityBrowserState;
  actions: EntityBrowserActions;
};

const EntityBrowserContext = createContext<EntityBrowserContextValue | null>(null);

export function EntityBrowserProvider({
  value,
  children,
}: {
  value: EntityBrowserContextValue;
  children: ReactNode;
}) {
  return <EntityBrowserContext value={value}>{children}</EntityBrowserContext>;
}

export function useEntityBrowser() {
  const context = use(EntityBrowserContext);
  if (!context) {
    throw new Error("useEntityBrowser must be used inside EntityBrowserProvider");
  }
  return context;
}
```

**Step 2: Add a small debounce hook.**

```typescript
// Path: app/workspace/leads-customers/_components/use-debounced-value.ts
"use client";

import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, value]);

  return debounced;
}
```

**Step 3: Sync query params without full page reloads.**

```typescript
// Path: app/workspace/leads-customers/_components/use-entity-browser-url-state.ts
"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { EntityBrowserContextValue, EntityLifecycleFilter } from "./entity-browser-context";
import { useDebouncedValue } from "./use-debounced-value";

function parseLifecycle(value: string | null): EntityLifecycleFilter {
  if (value === "lead" || value === "customer") return value;
  return "all";
}

export function useEntityBrowserUrlState(): EntityBrowserContextValue {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [query, setQueryState] = useState(searchParams.get("q") ?? "");
  const lifecycle = parseLifecycle(searchParams.get("lifecycle"));
  const debouncedQuery = useDebouncedValue(query, 275);

  const replaceParams = useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value.length === 0) next.delete(key);
        else next.set(key, value);
      }
      startTransition(() => {
        router.replace(`${pathname}?${next.toString()}`, { scroll: false });
      });
    },
    [pathname, router, searchParams],
  );

  return useMemo(
    () => ({
      state: { query, debouncedQuery, lifecycle },
      actions: {
        setQuery: (value) => {
          setQueryState(value);
          replaceParams({ q: value });
        },
        setLifecycle: (value) => {
          replaceParams({ lifecycle: value === "all" ? null : value });
        },
      },
      isPending,
    }),
    [debouncedQuery, isPending, lifecycle, query, replaceParams],
  );
}
```

**Key implementation notes:**
- The context value type can grow later, but avoid storing result data in context.
- Keep the lifecycle URL param absent for "all" so legacy redirects can build cleaner URLs.
- The `isPending` value can be added to the type if controls need a pending visual; do not use it to block typing.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads-customers/_components/entity-browser-context.tsx` | Create | Shared URL state context |
| `app/workspace/leads-customers/_components/use-entity-browser-url-state.ts` | Create | Query param sync |
| `app/workspace/leads-customers/_components/use-debounced-value.ts` | Create | Local debounce utility |

---

### 2C — Search Header, Lifecycle Filters, and Primary Actions

**Type:** Frontend
**Parallelizable:** Yes — depends on 2B state, but independent from result table internals.

**What:** Build the workspace header, search input, lifecycle filters, and primary "New Side Deal" action.

**Why:** The unified route's value starts with fast operational lookup. Controls must be compact, keyboard-friendly, and URL-addressable.

**Where:**
- `app/workspace/leads-customers/_components/entity-browser-toolbar.tsx` (new)
- `app/workspace/leads-customers/_components/leads-customers-page-client.tsx` (modify)

**How:**

**Step 1: Add the toolbar.**

```tsx
// Path: app/workspace/leads-customers/_components/entity-browser-toolbar.tsx
"use client";

import Link from "next/link";
import { PlusIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useEntityBrowser, type EntityLifecycleFilter } from "./entity-browser-context";

const lifecycleItems: Array<{ value: EntityLifecycleFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "lead", label: "Leads" },
  { value: "customer", label: "Customers" },
];

export function EntityBrowserToolbar() {
  const { state, actions } = useEntityBrowser();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Leads & Customers</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Search by name, email, phone, handle, lead ID, customer ID, opportunity ID, or meeting ID.
          </p>
        </div>
        <Button asChild size="sm" className="shrink-0">
          <Link href="/workspace/leads-customers/new-opportunity">
            <PlusIcon aria-hidden="true" />
            New Side Deal
          </Link>
        </Button>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <label className="relative block min-w-0 flex-1">
          <span className="sr-only">Search leads and customers</span>
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={state.query}
            onChange={(event) => actions.setQuery(event.target.value)}
            className="h-10 pl-9"
            placeholder="Search identifier..."
            autoComplete="off"
          />
        </label>
        <Tooltip>
          <TooltipTrigger asChild>
            <ToggleGroup
              type="single"
              value={state.lifecycle}
              onValueChange={(value) => {
                if (value) actions.setLifecycle(value as EntityLifecycleFilter);
              }}
              aria-label="Filter lifecycle"
              className="justify-start"
            >
              {lifecycleItems.map((item) => (
                <ToggleGroupItem key={item.value} value={item.value} size="sm">
                  {item.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </TooltipTrigger>
          <TooltipContent>Filter by lead or customer lifecycle</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
```

**Step 2: Mount the toolbar in the page client.**

```tsx
// Path: app/workspace/leads-customers/_components/leads-customers-page-client.tsx
import { EntityBrowserResults } from "./entity-browser-results";
import { EntityBrowserToolbar } from "./entity-browser-toolbar";

export function LeadsCustomersPageClient() {
  usePageTitle("Leads & Customers");
  const browser = useEntityBrowserUrlState();

  return (
    <EntityBrowserProvider value={browser}>
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
        <EntityBrowserToolbar />
        <EntityBrowserResults />
      </div>
    </EntityBrowserProvider>
  );
}
```

**Key implementation notes:**
- Use `PlusIcon` instead of a text-only button for the create command.
- Keep helper text short and operational; do not turn the page into a feature explainer.
- If product wants no visible search explanation, move the accepted lookup types into placeholder or tooltip copy.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads-customers/_components/entity-browser-toolbar.tsx` | Create | Header, search, filters, primary action |
| `app/workspace/leads-customers/_components/leads-customers-page-client.tsx` | Modify | Mount toolbar and results |

---

### 2D — Results Data Hook, Table, Mobile Rows, and Footer

**Type:** Frontend / Convex Client
**Parallelizable:** Yes — depends on 2B state and Phase 1E query names; independent from toolbar styling after state contract is stable.

**What:** Wire `listEntities` and `searchEntities`, render desktop table rows and mobile result cards, handle direct opportunity hits, and add load-more footer behavior.

**Why:** The browse/search route must feel like one workspace even though it switches between paginated browse mode and bounded search mode.

**Where:**
- `app/workspace/leads-customers/_components/use-entity-results.ts` (new)
- `app/workspace/leads-customers/_components/entity-browser-results.tsx` (new)
- `app/workspace/leads-customers/_components/entity-result-row.tsx` (new)
- `app/workspace/leads-customers/_components/entity-result-mobile-card.tsx` (new)
- `app/workspace/leads-customers/_components/entity-result-formatters.ts` (new)

**How:**

**Step 1: Add a data hook that separates browse and search modes.**

```typescript
// Path: app/workspace/leads-customers/_components/use-entity-results.ts
"use client";

import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useEntityBrowser } from "./entity-browser-context";

export function useEntityResults() {
  const { state } = useEntityBrowser();
  const searchTerm = state.debouncedQuery.trim();
  const lifecycle = state.lifecycle === "all" ? undefined : state.lifecycle;
  const isSearchMode = searchTerm.length > 0;

  const searchResults = useQuery(
    api.leadCustomers.queries.searchEntities,
    isSearchMode ? { searchTerm, lifecycle } : "skip",
  );

  const browse = usePaginatedQuery(
    api.leadCustomers.queries.listEntities,
    isSearchMode ? "skip" : { lifecycle: state.lifecycle },
    { initialNumItems: 25 },
  );

  return {
    mode: isSearchMode ? "search" as const : "browse" as const,
    rows: isSearchMode ? (searchResults ?? []) : browse.results,
    isLoading: isSearchMode
      ? searchResults === undefined
      : browse.status === "LoadingFirstPage",
    canLoadMore: !isSearchMode && browse.status === "CanLoadMore",
    loadMore: () => browse.loadMore(25),
  };
}
```

**Step 2: Render table and mobile layouts.**

```tsx
// Path: app/workspace/leads-customers/_components/entity-browser-results.tsx
"use client";

import { Button } from "@/components/ui/button";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EntityResultMobileCard } from "./entity-result-mobile-card";
import { EntityResultRow } from "./entity-result-row";
import { useEntityResults } from "./use-entity-results";

export function EntityBrowserResults() {
  const { rows, isLoading, canLoadMore, loadMore, mode } = useEntityResults();

  if (isLoading) {
    return <div role="status" aria-label="Loading entity results" className="rounded-md border p-4">Loading...</div>;
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
        No leads or customers found.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="hidden overflow-hidden rounded-md border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Identity</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Last signal</TableHead>
              <TableHead className="text-right">Related</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <EntityResultRow key={row._id} row={row} />
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="grid gap-2 md:hidden">
        {rows.map((row) => (
          <EntityResultMobileCard key={row._id} row={row} />
        ))}
      </div>
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{rows.length} shown{mode === "search" ? " for this search" : ""}</span>
        {canLoadMore ? (
          <Button variant="outline" size="sm" onClick={loadMore}>
            Load More
          </Button>
        ) : null}
      </div>
    </div>
  );
}
```

**Step 3: Render direct-hit links correctly.**

```tsx
// Path: app/workspace/leads-customers/_components/entity-result-row.tsx
"use client";

import Link from "next/link";
import { ExternalLinkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import type { Doc, Id } from "@/convex/_generated/dataModel";

type SearchRow = Doc<"leadCustomerSearchRows"> & {
  selectedOpportunityId?: Id<"opportunities">;
};

function detailHref(row: SearchRow) {
  const params = new URLSearchParams();
  if (row.selectedOpportunityId) params.set("opportunityId", row.selectedOpportunityId);
  const suffix = params.toString();
  return `/workspace/leads-customers/${row.leadId}${suffix ? `?${suffix}` : ""}`;
}

export function EntityResultRow({ row }: { row: SearchRow }) {
  return (
    <TableRow>
      <TableCell>
        <Link href={detailHref(row)} className="block min-w-0 hover:underline">
          <span className="block truncate font-medium">{row.displayName}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {row.email ?? row.phone ?? row.primaryIdentifier ?? row.leadId}
          </span>
        </Link>
      </TableCell>
      <TableCell>
        <Badge variant={row.lifecycle === "customer" ? "default" : "secondary"}>
          {row.lifecycle === "customer" ? "Customer" : "Lead"}
        </Badge>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {new Date(row.latestActivityAt).toLocaleDateString()}
      </TableCell>
      <TableCell className="text-right">
        {row.selectedOpportunityId ? (
          <Button asChild variant="ghost" size="sm">
            <Link href={detailHref(row)}>
              Open Opportunity
              <ExternalLinkIcon aria-hidden="true" />
            </Link>
          </Button>
        ) : (
          <span className="tabular-nums">
            {row.opportunityCount} opp / {row.meetingCount} mtg
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}
```

**Step 4: Format mobile rows for scanning.**

```tsx
// Path: app/workspace/leads-customers/_components/entity-result-mobile-card.tsx
"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { Doc } from "@/convex/_generated/dataModel";

export function EntityResultMobileCard({
  row,
}: {
  row: Doc<"leadCustomerSearchRows">;
}) {
  return (
    <Link
      href={`/workspace/leads-customers/${row.leadId}`}
      className="rounded-md border p-3 text-sm hover:bg-muted/50"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium">{row.displayName}</div>
          <div className="truncate text-muted-foreground">
            {row.email ?? row.phone ?? row.primaryIdentifier ?? row.leadId}
          </div>
        </div>
        <Badge variant="secondary" className="shrink-0">
          {row.lifecycle === "customer" ? "Customer" : "Lead"}
        </Badge>
      </div>
      <div className="mt-2 text-xs text-muted-foreground">
        {row.opportunityCount} opportunities · {row.meetingCount} meetings
      </div>
    </Link>
  );
}
```

**Key implementation notes:**
- Match the existing repo pattern for `usePaginatedQuery`: pass filter args only; Convex React supplies `paginationOpts`.
- Use `Link` for rows instead of `router.push` click handlers.
- Avoid rendering PII in analytics events from result interactions.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads-customers/_components/use-entity-results.ts` | Create | Convex client data hook |
| `app/workspace/leads-customers/_components/entity-browser-results.tsx` | Create | Results layout and footer |
| `app/workspace/leads-customers/_components/entity-result-row.tsx` | Create | Desktop table row |
| `app/workspace/leads-customers/_components/entity-result-mobile-card.tsx` | Create | Mobile row/card |
| `app/workspace/leads-customers/_components/entity-result-formatters.ts` | Create | Dates, money, state labels |

---

### 2E — New Side-Deal Route Under Unified Workspace

**Type:** Frontend / Next.js
**Parallelizable:** Yes — touches only the new route and can reuse old create-opportunity components while old route remains available.

**What:** Add `/workspace/leads-customers/new-opportunity` using the existing manual side-deal creation UI and permission gate.

**Why:** Users must keep side-deal creation, but the canonical entry should live under the new workspace before old opportunity navigation is redirected.

**Where:**
- `app/workspace/leads-customers/new-opportunity/page.tsx` (new)
- `app/workspace/leads-customers/new-opportunity/loading.tsx` (new)

**How:**

**Step 1: Add the new page and reuse existing components.**

```tsx
// Path: app/workspace/leads-customers/new-opportunity/page.tsx
import { Suspense } from "react";
import { requirePermission } from "@/lib/auth";
import { CreateOpportunityPageClient } from "../../opportunities/new/_components/create-opportunity-page-client";
import { CreateOpportunitySkeleton } from "../../opportunities/new/_components/create-opportunity-skeleton";

export const unstable_instant = false;

export default async function NewLeadCustomerOpportunityPage() {
  await requirePermission("pipeline:view-own");

  return (
    <Suspense fallback={<CreateOpportunitySkeleton />}>
      <CreateOpportunityPageClient />
    </Suspense>
  );
}
```

**Step 2: Add loading state.**

```tsx
// Path: app/workspace/leads-customers/new-opportunity/loading.tsx
import { CreateOpportunitySkeleton } from "../../opportunities/new/_components/create-opportunity-skeleton";

export default function Loading() {
  return <CreateOpportunitySkeleton />;
}
```

**Step 3: Verify both old and new routes.**

```bash
# Path: terminal
pnpm tsc --noEmit
```

Manual browser checks:

- `/workspace/opportunities/new` still loads.
- `/workspace/leads-customers/new-opportunity` loads the same form.
- Successful creation still uses existing Convex mutation guards.

**Key implementation notes:**
- This temporary route-level import is acceptable for Phase 2 because Phase 4 redirects the old route. If the form needs substantial changes, extract shared components instead of duplicating.
- Do not change the create mutation contract in this phase.
- The primary action label should be "New Side Deal" in browse UI, but the existing form can keep its current title until UX polish.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads-customers/new-opportunity/page.tsx` | Create | New canonical side-deal route |
| `app/workspace/leads-customers/new-opportunity/loading.tsx` | Create | Loading state |

---

### 2F — Responsive, Accessibility, and Dark Mode QA

**Type:** Frontend / Manual QA
**Parallelizable:** No — depends on 2A through 2E.

**What:** Verify desktop/mobile rendering, keyboard behavior, loading states, empty states, and dark-mode contrast for the new browse workspace.

**Why:** The route is data-dense and operational. Text overlap, bad row links, or unstable loading states would make it worse than the legacy pages.

**Where:**
- `plans/leads-customers-unified-view/phase2-qa.md` (new)
- `app/workspace/leads-customers/**` (read/modify if QA finds defects)

**How:**

**Step 1: Create a QA checklist.**

```markdown
<!-- Path: plans/leads-customers-unified-view/phase2-qa.md -->

# Phase 2 QA — Unified Search Workspace

| Check | Desktop | Mobile | Notes |
|---|---|---|---|
| Route gate redirects `lead_generator` | TBD | TBD |  |
| Search by active lead handle | TBD | TBD |  |
| Search by customer email | TBD | TBD |  |
| Direct opportunity ID opens detail URL with `opportunityId` | TBD | TBD |  |
| Lifecycle filter changes URL and results | TBD | TBD |  |
| Browse load more preserves lifecycle | TBD | N/A |  |
| Empty search state is compact | TBD | TBD |  |
| Skeleton does not cause visible layout jump | TBD | TBD |  |
| Dark mode contrast passes visual review | TBD | TBD |  |
| Row links support Cmd/Ctrl-click | TBD | TBD |  |
```

**Step 2: Run automated checks.**

```bash
# Path: terminal
pnpm tsc --noEmit
pnpm lint
```

**Step 3: Use browser QA for target widths.**

```markdown
<!-- Path: plans/leads-customers-unified-view/phase2-qa.md -->

## Viewports

- Desktop: 1440 x 1000
- Narrow desktop: 1024 x 768
- Tablet: 768 x 1024
- Mobile: 390 x 844
```

**Key implementation notes:**
- If the table is too dense at 1024px, switch earlier to mobile cards rather than shrinking text with viewport units.
- Buttons and badges must not resize row height on hover.
- Do not ship visible placeholder debug states or raw IDs as primary labels unless no better identity exists.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/leads-customers-unified-view/phase2-qa.md` | Create | QA evidence |
| `app/workspace/leads-customers/**` | Modify | Only if QA defects are found |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/leads-customers/page.tsx` | Create | 2A |
| `app/workspace/leads-customers/loading.tsx` | Create | 2A |
| `app/workspace/leads-customers/_components/leads-customers-page-client.tsx` | Create / Modify | 2A, 2C |
| `app/workspace/leads-customers/_components/leads-customers-skeleton.tsx` | Create | 2A |
| `app/workspace/leads-customers/_components/entity-browser-context.tsx` | Create | 2B |
| `app/workspace/leads-customers/_components/use-entity-browser-url-state.ts` | Create | 2B |
| `app/workspace/leads-customers/_components/use-debounced-value.ts` | Create | 2B |
| `app/workspace/leads-customers/_components/entity-browser-toolbar.tsx` | Create | 2C |
| `app/workspace/leads-customers/_components/use-entity-results.ts` | Create | 2D |
| `app/workspace/leads-customers/_components/entity-browser-results.tsx` | Create | 2D |
| `app/workspace/leads-customers/_components/entity-result-row.tsx` | Create | 2D |
| `app/workspace/leads-customers/_components/entity-result-mobile-card.tsx` | Create | 2D |
| `app/workspace/leads-customers/_components/entity-result-formatters.ts` | Create | 2D |
| `app/workspace/leads-customers/new-opportunity/page.tsx` | Create | 2E |
| `app/workspace/leads-customers/new-opportunity/loading.tsx` | Create | 2E |
| `plans/leads-customers-unified-view/phase2-qa.md` | Create | 2F |
