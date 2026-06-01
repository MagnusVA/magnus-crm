# Phase 1: Pipeline Date Filtering

> Add Day/Week/Month time period gating to the pipeline page, reusing the existing `TimePeriodFilter` pattern.

## Prerequisite reading

- `convex/_generated/ai/guidelines.md` (Convex coding standards)
- `app/workspace/_components/time-period-filter.tsx` (existing pattern)

---

## Step 1: Add schema indexes

**File**: `convex/schema.ts`

Add two new indexes to the `opportunities` table (after the existing `by_tenantId_and_status_and_createdAt` index):

```ts
.index("by_tenantId_and_assignedCloserId_and_createdAt", [
  "tenantId", "assignedCloserId", "createdAt",
])
.index("by_tenantId_and_assignedCloserId_and_status_and_createdAt", [
  "tenantId", "assignedCloserId", "status", "createdAt",
])
```

After saving, run `npx convex dev` to push the schema. These are additive index changes — no migration needed.

---

## Step 2: Update the Convex query

**File**: `convex/opportunities/queries.ts`

### 2a. Add new args

```ts
args: {
  paginationOpts: paginationOptsValidator,
  statusFilter: v.optional(opportunityStatusValidator),
  assignedCloserId: v.optional(v.id("users")),
  periodStart: v.optional(v.number()),   // NEW
  periodEnd: v.optional(v.number()),     // NEW
},
```

### 2b. Extract query builder helper

Replace the current nested ternary with a helper function. The function selects the correct index based on which filters are active:

```ts
function buildOpportunityQuery(
  db: DatabaseReader,
  tenantId: Id<"tenants">,
  filters: {
    statusFilter?: OpportunityStatus;
    assignedCloserId?: Id<"users">;
    periodStart?: number;
    periodEnd?: number;
  },
) {
  const { statusFilter, assignedCloserId, periodStart, periodEnd } = filters;
  const hasDate = periodStart !== undefined && periodEnd !== undefined;

  if (statusFilter && assignedCloserId && hasDate) {
    return db.query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId_and_status_and_createdAt", (q) =>
        q.eq("tenantId", tenantId)
         .eq("assignedCloserId", assignedCloserId)
         .eq("status", statusFilter)
         .gte("createdAt", periodStart)
         .lt("createdAt", periodEnd)
      );
  }
  if (statusFilter && hasDate) {
    return db.query("opportunities")
      .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
        q.eq("tenantId", tenantId)
         .eq("status", statusFilter)
         .gte("createdAt", periodStart)
         .lt("createdAt", periodEnd)
      );
  }
  if (assignedCloserId && hasDate) {
    return db.query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId_and_createdAt", (q) =>
        q.eq("tenantId", tenantId)
         .eq("assignedCloserId", assignedCloserId)
         .gte("createdAt", periodStart)
         .lt("createdAt", periodEnd)
      );
  }
  if (hasDate) {
    return db.query("opportunities")
      .withIndex("by_tenantId_and_createdAt", (q) =>
        q.eq("tenantId", tenantId)
         .gte("createdAt", periodStart)
         .lt("createdAt", periodEnd)
      );
  }
  if (statusFilter && assignedCloserId) {
    return db.query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId_and_status", (q) =>
        q.eq("tenantId", tenantId)
         .eq("assignedCloserId", assignedCloserId)
         .eq("status", statusFilter)
      );
  }
  if (statusFilter) {
    return db.query("opportunities")
      .withIndex("by_tenantId_and_status", (q) =>
        q.eq("tenantId", tenantId)
         .eq("status", statusFilter)
      );
  }
  if (assignedCloserId) {
    return db.query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId", (q) =>
        q.eq("tenantId", tenantId)
         .eq("assignedCloserId", assignedCloserId)
      );
  }
  return db.query("opportunities")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId));
}
```

### 2c. Use the helper in the handler

```ts
const paginatedResult = await buildOpportunityQuery(ctx.db, tenantId, {
  statusFilter, assignedCloserId, periodStart, periodEnd,
}).order("desc").paginate(paginationOpts);
```

The rest of the enrichment logic stays the same.

---

## Step 3: Update the frontend

### 3a. Add period filter to pipeline-filters.tsx

**File**: `app/workspace/pipeline/_components/pipeline-filters.tsx`

Import and render `TimePeriodFilter` alongside the existing status/closer filters. Add an "All" option to allow clearing the period:

```tsx
import { TimePeriodFilter, type TimePeriod } from "@/app/workspace/_components/time-period-filter";

// In the component — add after the closer filter
{/* Time period filter */}
<div className="flex items-center gap-2">
  <TimePeriodFilter value={period} onValueChange={onPeriodChange} />
  {period && (
    <Button variant="ghost" size="sm" onClick={() => onPeriodChange(undefined)}>
      Clear
    </Button>
  )}
</div>
```

Note: `TimePeriodFilter` currently requires a non-optional value. We need to make `period` optional (undefined = all time). Options:
- Wrap `TimePeriodFilter` with an outer "All time / Filtered" toggle
- OR extend TimePeriodFilter to support an "all" value

Simplest: keep `TimePeriodFilter` as-is, render it always with a default of `this_week`, and add a separate "All time" button to clear.

**Decision**: Default to no period filter (all time). Show Day/Week/Month toggles. When one is active, show a "Clear" button to go back to all time. This means the `TimePeriodFilter` value can be `undefined`, and we handle that by conditionally rendering it.

### 3b. Wire into pipeline-page-client.tsx

**File**: `app/workspace/pipeline/_components/pipeline-page-client.tsx`

Add `period` to URL search params and compute `periodStart`/`periodEnd`:

```tsx
import { getDateRange, type TimePeriod } from "@/app/workspace/_components/time-period-filter";

// In PipelineContent:
const periodParam = searchParams.get("period") as TimePeriod | null;

const setPeriod = useCallback(
  (value: TimePeriod | undefined) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set("period", value);
    } else {
      params.delete("period");
    }
    const qs = params.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  },
  [pathname, router, searchParams],
);

const queryArgs = useMemo(() => {
  const args: {
    statusFilter?: OpportunityStatus;
    assignedCloserId?: Id<"users">;
    periodStart?: number;
    periodEnd?: number;
  } = {};

  if (statusFilter !== "all") {
    args.statusFilter = statusFilter as OpportunityStatus;
  }
  if (closerFilter !== "all") {
    args.assignedCloserId = closerFilter as Id<"users">;
  }
  if (periodParam) {
    const { periodStart, periodEnd } = getDateRange(periodParam);
    args.periodStart = periodStart;
    args.periodEnd = periodEnd;
  }

  return args;
}, [closerFilter, statusFilter, periodParam]);
```

Pass `period` and `setPeriod` to `PipelineFilters`.

---

## Step 4: Verify

- [ ] Pipeline loads with no date filter (all time) — same as current behavior
- [ ] Selecting "Day" shows only today's opportunities
- [ ] Selecting "Week" shows this week's opportunities
- [ ] Selecting "Month" shows this month's opportunities
- [ ] Clearing the period returns to all-time view
- [ ] Pagination (Load More) works correctly with date filter active
- [ ] Combining date filter + status filter works
- [ ] Combining date filter + closer filter works
- [ ] Combining all three filters works
- [ ] CSV export respects the active filters
- [ ] URL params persist across page navigation

---

## Notes

- The `getDateRange()` function computes client-side date boundaries. Since Convex queries run server-side, there's a minor timezone consideration: `getDateRange` uses the browser's local timezone. For a single-tenant app this is acceptable. If multi-timezone support is needed later, pass the timezone to the query.
- The `by_tenantId_and_createdAt` index orders by `createdAt` after equality on `tenantId`. The `.order("desc")` ensures newest-first within the date window. This matches the current UX (sorted by `updatedAt` on the client, but the paginated cursor moves by `createdAt`).
