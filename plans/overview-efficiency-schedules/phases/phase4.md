# Phase 4 — Expandable Leaderboard Query and Interaction

**Status:** Code complete; browser interaction QA pending (2026-06-01)
**Goal:** Add on-demand full leaderboards for the three efficiency cards without bloating the initial overview payload. After this phase, expanding one card opens one additional bounded Convex subscription for that card only.

**Prerequisite:** Phase 3 shared builders exist. Phase 5 card copy can overlap after row types stabilize.

**Runs in PARALLEL with:** Phase 5A-5B after Phase 3 row types stabilize. Final QA waits for Phase 5.

**Skills to invoke:**
- `convex-performance-audit` — enforce skip-until-open, bounded rows, and shared builder reuse.
- `next-best-practices` — keep client interaction inside existing client components and avoid route-level loading misuse.
- `shadcn` — use Collapsible, Table, ToggleGroup, Input, Skeleton, Empty, ScrollArea, and Button primitives.
- `frontend-design` — keep the expanded reporting artifact dense and scannable.
- `vercel-react-best-practices` — use deferred search and avoid unnecessary re-renders.

**Acceptance Criteria:**
1. `api.dashboard.overviewLeaderboards.listOverviewLeaderboardRows` exists and is admin-only.
2. The expanded query uses the same builders and sort order as the top-5 overview cards.
3. The expanded query returns `totalRows`, `filteredRows`, and `truncated`.
4. Collapsed cards do not create expanded leaderboard subscriptions.
5. Opening one card creates only that card’s expanded query subscription.
6. Search/filter changes refetch only the expanded query, not the full overview query.
7. The expanded list includes scheduled zero-activity actors when `includeAllCandidates` is true.
8. Loading, empty, capped, and error states are scoped to the expanded area.
9. The expanded area has stable max height and internal scrolling.
10. `pnpm tsc --noEmit` passes without errors.

**Verification:** `pnpm tsc --noEmit` passed on 2026-06-01. Targeted ESLint for Phase 4 touched files passed on 2026-06-01. Expanded DM closer cap handling now returns a scoped capped state instead of throwing through the whole card, and non-cap query failures are isolated by the expanded leaderboard error boundary.

---

## Subphase Dependency Graph

```
4A (expanded Convex query) ───────┬── 4B (shared expanded table) ─────┐
                                 ├── 4C (filters + deferred search) ─┤── 4D (card integration)
                                 └── 4E (states + accessibility) ────┘

4D complete ─────────────────────────────────────────────────────────── 4F (interaction QA)
```

**Optimal execution:**
1. Build 4A first so frontend has a generated API reference.
2. Build 4B, 4C, and 4E in parallel.
3. Integrate into existing cards in 4D.
4. Finish with subscription and browser QA in 4F.

**Estimated time:** 1.5-2.5 days

---

## Subphases

### 4A — Expanded Leaderboard Convex Query

**Type:** Backend  
**Parallelizable:** No — frontend imports this API reference.

**What:** Add the expanded leaderboard query and filter validators.

**Why:** Full leaderboards should not be included in `getOverviewDashboard`; they are only needed after user intent.

**Where:**
- `convex/dashboard/overviewLeaderboards.ts` (create)
- `convex/dashboard/overviewLeaderboardBuilders.ts` (modify)
- `convex/dashboard/overviewTypes.ts` (modify)

**How:**

**Step 1: Add validators and query.**

```typescript
// Path: convex/dashboard/overviewLeaderboards.ts
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { deriveOverviewRange, overviewRangeValidator } from "./overviewRange";

const leaderboardKindValidator = v.union(
  v.literal("lead_gen"),
  v.literal("qualifiers"),
  v.literal("dm_closers"),
);

const leaderboardFilterValidator = v.object({
  search: v.optional(v.string()),
  schedule: v.optional(
    v.union(v.literal("all"), v.literal("scheduled"), v.literal("unscheduled")),
  ),
  activity: v.optional(
    v.union(v.literal("all"), v.literal("with_activity"), v.literal("without_activity")),
  ),
});

export const listOverviewLeaderboardRows = query({
  args: {
    kind: leaderboardKindValidator,
    range: overviewRangeValidator,
    filters: v.optional(leaderboardFilterValidator),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const range = deriveOverviewRange(args.range, Date.now());

    return await buildExpandedOverviewLeaderboard(ctx, {
      tenantId,
      kind: args.kind,
      range,
      filters: args.filters,
    });
  },
});
```

**Step 2: Apply filters after candidate set build.**

```typescript
// Path: convex/dashboard/overviewLeaderboardBuilders.ts
function applyCommonFilters<T extends {
  displayName?: string | null;
  scheduledHours: number;
}>(rows: T[], filters?: LeaderboardFilters) {
  return rows.filter((row) => {
    if (filters?.schedule === "scheduled" && row.scheduledHours <= 0) return false;
    if (filters?.schedule === "unscheduled" && row.scheduledHours > 0) return false;
    return true;
  });
}
```

**Key implementation notes:**
- This query may use `Date.now()` only through existing range derivation; do not add extra time-dependent filtering.
- Keep result rows projected to display fields only.
- Preserve section cap/truncation metadata.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/dashboard/overviewLeaderboards.ts` | Create | Expanded query |
| `convex/dashboard/overviewLeaderboardBuilders.ts` | Modify | Full candidate filtering |
| `convex/dashboard/overviewTypes.ts` | Modify | Expanded return type |

### 4B — Expanded Leaderboard Table

**Type:** Frontend  
**Parallelizable:** Yes — can build against expected return types after 4A shape is known.

**What:** Create shared table rendering for expanded lead gen, qualifier, and DM closer rows.

**Why:** Expanded cards should share loading, empty, capped, and table structure while preserving row-specific columns.

**Where:**
- `app/workspace/_components/overview-expanded-leaderboard-table.tsx` (create)

**How:**

```tsx
// Path: app/workspace/_components/overview-expanded-leaderboard-table.tsx
"use client";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDecimal, formatWholeNumber } from "./overview-formatters";
import type { ExpandedOverviewLeaderboard } from "./overview-dashboard-types";

export function OverviewExpandedLeaderboardTable({
  data,
}: {
  data: ExpandedOverviewLeaderboard;
}) {
  return (
    <Table aria-label="Expanded efficiency leaderboard">
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead className="text-right">Rate</TableHead>
          <TableHead className="text-right">Count</TableHead>
          <TableHead className="text-right">Hours</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.rows.map((row) => (
          <TableRow key={rowKey(data.kind, row)}>
            <TableCell>{displayNameForRow(data.kind, row)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatDecimal(rateForRow(data.kind, row))}</TableCell>
            <TableCell className="text-right tabular-nums">{formatWholeNumber(countForRow(data.kind, row))}</TableCell>
            <TableCell className="text-right tabular-nums">{formatDecimal(row.scheduledHours)}h</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
```

**Key implementation notes:**
- Keep text compact; this is an operational reporting table.
- Use existing formatter helpers.
- Do not render cards inside cards.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/overview-expanded-leaderboard-table.tsx` | Create | Shared expanded table |

### 4C — Filters and Deferred Search

**Type:** Frontend  
**Parallelizable:** Yes — independent of table rendering after 4A shape is known.

**What:** Add search, schedule filter, and activity filter controls.

**Why:** Expanded reports need lightweight filtering without reloading the entire dashboard.

**Where:**
- `app/workspace/_components/overview-expandable-leaderboard.tsx` (create)

**How:**

```tsx
// Path: app/workspace/_components/overview-expandable-leaderboard.tsx
"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

export function OverviewExpandableLeaderboard(props: {
  kind: "lead_gen" | "qualifiers" | "dm_closers";
  range: DashboardRangeInput;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const filters = useMemo(
    () => ({
      ...(deferredSearch.trim() ? { search: deferredSearch.trim() } : {}),
    }),
    [deferredSearch],
  );
  const rows = useQuery(
    api.dashboard.overviewLeaderboards.listOverviewLeaderboardRows,
    props.open ? { kind: props.kind, range: props.range, filters } : "skip",
  );
}
```

**Key implementation notes:**
- Use `ToggleGroup` for schedule/activity filters.
- Use primitive dependencies in `useMemo`.
- Keep local filter state per expanded card.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/overview-expandable-leaderboard.tsx` | Create | Collapsible + filters |

### 4D — Card Integration

**Type:** Frontend  
**Parallelizable:** No — depends on 4B-4C.

**What:** Integrate `OverviewExpandableLeaderboard` into the Lead Gen, Top Qualifiers, and Top DM Closers cards.

**Why:** The user wants the existing top cards to expand into the reporting artifact, not navigate to separate report routes.

**Where:**
- `app/workspace/_components/overview-top-cards.tsx` (modify)
- `app/workspace/_components/lead-gen-overview-card.tsx` (modify)
- `app/workspace/_components/top-qualifiers-card.tsx` (modify)
- `app/workspace/_components/top-dm-closers-card.tsx` (modify)

**How:**

```tsx
// Path: app/workspace/_components/overview-top-cards.tsx
const [expandedKind, setExpandedKind] = useState<
  "lead_gen" | "qualifiers" | "dm_closers" | null
>(null);

<LeadGenOverviewCard
  section={overview.leadGen}
  range={overview.queryRange}
  expanded={expandedKind === "lead_gen"}
  onExpandedChange={(open) => setExpandedKind(open ? "lead_gen" : null)}
/>
```

**Key implementation notes:**
- Prefer one expanded card at a time to cap subscriptions.
- Pass validated `queryRange`, not draft `range`.
- Mobile can replace the top-5 list with the table to avoid duplicate rows.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/overview-top-cards.tsx` | Modify | Expansion state |
| `app/workspace/_components/lead-gen-overview-card.tsx` | Modify | Add expandable control |
| `app/workspace/_components/top-qualifiers-card.tsx` | Modify | Add expandable control |
| `app/workspace/_components/top-dm-closers-card.tsx` | Modify | Add expandable control |

### 4E — States and Accessibility

**Type:** Frontend  
**Parallelizable:** Yes — can run with 4B/4C.

**What:** Add skeleton, empty, capped, and error states inside the expanded area.

**Why:** Expanded query failures should not break the top-5 card or the full overview page.

**Where:**
- `app/workspace/_components/overview-expandable-leaderboard.tsx` (modify)
- `app/workspace/_components/overview-expanded-leaderboard-table.tsx` (modify)

**How:**

```tsx
// Path: app/workspace/_components/overview-expandable-leaderboard.tsx
function ExpandedLeaderboardSkeleton() {
  return (
    <div className="flex h-64 flex-col gap-3" role="status" aria-label="Loading expanded leaderboard">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
```

**Key implementation notes:**
- Use `CollapsibleTrigger` with `asChild`.
- Use `aria-label` or caption on the table.
- Use `ScrollArea` or stable max-height container for the expanded table.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/overview-expandable-leaderboard.tsx` | Modify | States/accessibility |

### 4F — Interaction QA

**Type:** QA  
**Parallelizable:** No — validates all Phase 4 work.

**What:** Verify subscriptions, filters, range changes, and mobile layout.

**Why:** The main failure mode is accidental extra subscriptions or expanded rows drifting from top-5 semantics.

**How:**
1. Load `/workspace`; confirm no expanded query runs while cards are collapsed.
2. Open Lead Gen; confirm only Lead Gen expanded query runs.
3. Search/filter; confirm only expanded query refetches.
4. Change range; confirm overview and open expanded query use the new range.
5. Close card; confirm expanded subscription stops.
6. Repeat for Qualifiers and DM Closers.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| None | QA only | Browser/Convex verification |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/dashboard/overviewLeaderboards.ts` | Create | 4A |
| `convex/dashboard/overviewLeaderboardBuilders.ts` | Modify | 4A |
| `convex/dashboard/overviewTypes.ts` | Modify | 4A |
| `app/workspace/_components/overview-expanded-leaderboard-table.tsx` | Create | 4B |
| `app/workspace/_components/overview-expandable-leaderboard.tsx` | Create | 4C, 4E |
| `app/workspace/_components/overview-top-cards.tsx` | Modify | 4D |
| `app/workspace/_components/lead-gen-overview-card.tsx` | Modify | 4D |
| `app/workspace/_components/top-qualifiers-card.tsx` | Modify | 4D |
| `app/workspace/_components/top-dm-closers-card.tsx` | Modify | 4D |
