# Phase 3 — Admin Reporting, Exports, and Aggregates

**Goal:** Build the admin reporting layer for Lead Gen Ops using aggregate tables, bounded detail queries, safe CSV export serialization, and a desktop-first operational dashboard. After this phase, tenant admins can review worker/team/source performance without scanning raw submissions or mixing Lead Gen Ops into CRM conversion metrics.

**Prerequisite:** Phase 1 complete. Phase 3A can run in parallel with Phase 2, but end-to-end reporting verification requires Phase 2 capture writes.

**Runs in PARALLEL with:** Phase 2 and Phase 4 after Phase 1. Phase 3A is an upstream dependency for Phase 2B final capture wiring; Phase 3 UI depends on the reporting query DTOs, not on Phase 4 audit matching.

**Skills to invoke:**
- `convex` — aggregate write helpers, indexed report queries, bounded pagination, internal reconciliation.
- `convex-performance-audit` — inspect aggregate reads, write invalidation, and query bounds after seed data.
- `next-best-practices` — route-level streaming, RSC wrappers, client-side filters, and bundle-conscious charts/tables.
- `vercel-react-best-practices` — avoid data waterfalls and keep heavy dashboard components isolated.
- `shadcn` — `Tabs`, `Card`, `Chart`, `Table`, `Badge`, `Select`, `Popover`, `Skeleton`, `Empty`, and `Button`.
- `frontend-design` — dense desktop-first reporting UX with clear hierarchy, compact controls, and fast scanning.
- `web-design-guidelines` — table accessibility, filter labeling, responsive overflow, and export action affordances.

**Acceptance Criteria:**
1. Capture writes update `leadGenDailyStats` for submissions, unique prospects, duplicate submissions, and scheduled-hour snapshots without raw scans.
2. Rankable origins update `leadGenOriginStats`; non-rankable origins are excluded from top post/reel rankings.
3. Admin overview query reads aggregate rows through tenant/date indexes and returns bounded DTOs for summary cards, worker rows, team rows, source split, and top origins.
4. Reporting filters support date range, worker, team, and source without accepting client-supplied `tenantId`.
5. Scheduled hours are deduped by `(workerId, dayKey)` when no source filter is applied.
6. Raw submissions export is date-bounded, row-limited, admin-only, and paginated internally before serialization.
7. CSV helper escapes commas/quotes/newlines and formula-hardens cells beginning with `=`, `+`, `-`, `@`, tab, or carriage return.
8. `/workspace/lead-gen` renders an admin dashboard; `lead_generator` and `closer` users are redirected by server gates.
9. Dashboard UI uses aggregate queries for default views and paginated raw rows only for audit/detail tables.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (Aggregate helpers) ───────┬── 3B (Overview/report queries) ───────┐
                              ├── 3C (Export DTOs + CSV hardening) ───┤
                              └── 3D (Reconciliation scaffolding) ────┤
                                                                      ├── 3E (Admin dashboard UI)
Phase 2B (capture writes) ────────────────────────────────────────────┘

3E complete ───────────────────────────── 3F (Reporting QA + performance gate)
```

**Optimal execution:**
1. Start 3A immediately after Phase 1 so Phase 2 can call aggregate helpers.
2. Run 3B, 3C, and 3D in parallel after 3A because they touch separate files.
3. Start 3E once 3B query DTOs exist; use seeded capture rows from Phase 2 for realistic UI states.
4. Finish with 3F, comparing aggregate totals to raw non-voided submissions for a bounded seed range.

**Estimated time:** 3-4 days

> **Critical path:** Phase 3 is on the reporting and release critical path. Capture can be tested before the dashboard is polished, but release should not proceed without aggregate reconciliation and CSV hardening.

---

## Subphases

### 3A — Aggregate Write Helpers and Scheduled-Hour Snapshot

**Type:** Backend  
**Parallelizable:** Yes — starts after Phase 1 and unblocks Phase 2B final capture wiring.

**What:** Implement daily and origin aggregate helpers plus the schedule-hour snapshot rule used by capture and later corrections.

**Why:** Reports must read aggregate tables, not raw submission scans. Aggregates are part of the write contract and must be updated transactionally with accepted capture submissions.

**Where:**
- `convex/leadGen/aggregates.ts` (new)
- `convex/reporting/lib/hondurasBusinessTime.ts` (read existing helper)

**How:**

**Step 1: Add daily stat key and schedule lookup helpers.**

```typescript
// Path: convex/leadGen/aggregates.ts
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  addBusinessDays,
  businessDateToUtcStart,
  timestampToBusinessDateKey,
} from "../reporting/lib/hondurasBusinessTime";

type LeadGenSource = Doc<"leadGenSubmissions">["source"];

function dailyStatKey(args: {
  dayKey: string;
  workerId: Id<"leadGenWorkers">;
  teamId?: Id<"leadGenTeams">;
  source: LeadGenSource;
}) {
  return [
    args.dayKey,
    args.workerId,
    args.teamId ?? "none",
    args.source,
  ].join(":");
}

async function getScheduledHoursForWorkerDay(
  ctx: MutationCtx,
  worker: Doc<"leadGenWorkers">,
  dayKey: string,
) {
  const weekday = new Date(`${dayKey}T12:00:00.000Z`)
    .toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })
    .toLowerCase() as Doc<"leadGenWorkerSchedules">["weekday"];

  const schedule = await ctx.db
    .query("leadGenWorkerSchedules")
    .withIndex("by_tenantId_and_workerId_and_weekday", (q) =>
      q
        .eq("tenantId", worker.tenantId)
        .eq("workerId", worker._id)
        .eq("weekday", weekday),
    )
    .unique();

  return schedule?.scheduledHours ?? 0;
}
```

**Step 2: Upsert daily aggregate rows.**

```typescript
// Path: convex/leadGen/aggregates.ts
export async function updateLeadGenDailyStats(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    worker: Doc<"leadGenWorkers">;
    source: LeadGenSource;
    submittedAt: number;
    duplicateProspectSubmission: boolean;
    prospectId: Id<"leadGenProspects">;
  },
) {
  const dayKey = timestampToBusinessDateKey(args.submittedAt);
  const statKey = dailyStatKey({
    dayKey,
    workerId: args.worker._id,
    teamId: args.worker.teamId,
    source: args.source,
  });

  const existing = await ctx.db
    .query("leadGenDailyStats")
    .withIndex("by_tenantId_and_statKey", (q) =>
      q.eq("tenantId", args.tenantId).eq("statKey", statKey),
    )
    .unique();

  const dayStart = businessDateToUtcStart(dayKey);
  const dayEnd = businessDateToUtcStart(addBusinessDays(dayKey, 1));
  const priorProspectToday = await ctx.db
    .query("leadGenSubmissions")
    .withIndex("by_tenantId_and_prospectId_and_submittedAt", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("prospectId", args.prospectId)
        .gte("submittedAt", dayStart)
        .lt("submittedAt", dayEnd),
    )
    .take(2);
  const isUniqueForBucket = priorProspectToday.length <= 1;

  if (existing) {
    await ctx.db.patch(existing._id, {
      submissions: existing.submissions + 1,
      uniqueProspectsSubmitted:
        existing.uniqueProspectsSubmitted + (isUniqueForBucket ? 1 : 0),
      duplicateProspectSubmissions:
        existing.duplicateProspectSubmissions +
        (args.duplicateProspectSubmission ? 1 : 0),
      updatedAt: Date.now(),
    });
    return existing._id;
  }

  return await ctx.db.insert("leadGenDailyStats", {
    tenantId: args.tenantId,
    statKey,
    dayKey,
    workerId: args.worker._id,
    userId: args.worker.userId,
    teamId: args.worker.teamId,
    source: args.source,
    submissions: 1,
    uniqueProspectsSubmitted: isUniqueForBucket ? 1 : 0,
    duplicateProspectSubmissions: args.duplicateProspectSubmission ? 1 : 0,
    scheduledHours: await getScheduledHoursForWorkerDay(
      ctx,
      args.worker,
      dayKey,
    ),
    updatedAt: Date.now(),
  });
}
```

**Step 3: Upsert origin stats for rankable origins.**

```typescript
// Path: convex/leadGen/aggregates.ts
export async function updateLeadGenOriginStats(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    source: LeadGenSource;
    originKind: Doc<"leadGenSubmissions">["originKind"];
    originKey: string;
    originValue: string;
    prospectId: Id<"leadGenProspects">;
    submittedAt: number;
  },
) {
  const dayKey = timestampToBusinessDateKey(args.submittedAt);
  const existing = await ctx.db
    .query("leadGenOriginStats")
    .withIndex("by_tenantId_and_originKey_and_dayKey", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("originKey", args.originKey)
        .eq("dayKey", dayKey),
    )
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, {
      submissions: existing.submissions + 1,
      updatedAt: Date.now(),
    });
    return existing._id;
  }

  return await ctx.db.insert("leadGenOriginStats", {
    tenantId: args.tenantId,
    originKey: args.originKey,
    dayKey,
    source: args.source,
    originKind: args.originKind,
    originValue: args.originValue,
    submissions: 1,
    uniqueProspectsSubmitted: 1,
    updatedAt: Date.now(),
  });
}
```

**Key implementation notes:**
- The unique-prospect query uses the same Honduras business-day window as existing reporting helpers.
- Scheduled hours live on source-specific rows for convenience, but report queries must dedupe by `(workerId, dayKey)` when summarizing across sources.
- Keep helpers as plain async functions called inside mutations, not public Convex functions.
- Corrections in Phase 5 must use companion delta helpers rather than duplicating counter math.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leadGen/aggregates.ts` | Create | Daily/origin aggregate helpers |

---

### 3B — Admin Overview, Worker, Team, and Origin Queries

**Type:** Backend  
**Parallelizable:** Yes — depends on 3A aggregate schema/contract but does not touch exports or UI files.

**What:** Add admin-only reporting queries that return bounded DTOs for overview cards, worker/team/source tables, and top rankable origins.

**Why:** The dashboard should be fast, reactive, and independent from raw submission volume.

**Where:**
- `convex/leadGen/reporting.ts` (new)

**How:**

**Step 1: Define filters with no `tenantId` argument.**

```typescript
// Path: convex/leadGen/reporting.ts
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { leadGenSourceValidator } from "./validators";

const reportFiltersValidator = {
  startDayKey: v.string(),
  endDayKey: v.string(),
  teamId: v.optional(v.id("leadGenTeams")),
  workerId: v.optional(v.id("leadGenWorkers")),
  source: v.optional(leadGenSourceValidator),
};
```

**Step 2: Implement overview query with bounded aggregate reads.**

```typescript
// Path: convex/leadGen/reporting.ts
export const getOverview = query({
  args: reportFiltersValidator,
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const rows = await ctx.db
      .query("leadGenDailyStats")
      .withIndex("by_tenantId_and_dayKey", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("dayKey", args.startDayKey)
          .lte("dayKey", args.endDayKey),
      )
      .take(500);

    const filtered = rows.filter((row) => {
      if (args.teamId && row.teamId !== args.teamId) return false;
      if (args.workerId && row.workerId !== args.workerId) return false;
      if (args.source && row.source !== args.source) return false;
      return true;
    });

    const scheduledHoursByWorkerDay = new Map<string, number>();
    for (const row of filtered) {
      scheduledHoursByWorkerDay.set(
        `${row.workerId}:${row.dayKey}`,
        row.scheduledHours,
      );
    }

    const totals = filtered.reduce(
      (acc, row) => ({
        submissions: acc.submissions + row.submissions,
        uniqueProspects: acc.uniqueProspects + row.uniqueProspectsSubmitted,
        duplicates: acc.duplicates + row.duplicateProspectSubmissions,
      }),
      { submissions: 0, uniqueProspects: 0, duplicates: 0 },
    );

    const scheduledHours = [...scheduledHoursByWorkerDay.values()].reduce(
      (sum, hours) => sum + hours,
      0,
    );

    return {
      ...totals,
      scheduledHours,
      leadsPerHour:
        scheduledHours > 0 ? totals.submissions / scheduledHours : null,
    };
  },
});
```

**Step 3: Add top origins query.**

```typescript
// Path: convex/leadGen/reporting.ts
export const listTopOrigins = query({
  args: {
    startDayKey: v.string(),
    endDayKey: v.string(),
    source: v.optional(leadGenSourceValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const rows = await ctx.db
      .query("leadGenOriginStats")
      .withIndex("by_tenantId_and_dayKey", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("dayKey", args.startDayKey)
          .lte("dayKey", args.endDayKey),
      )
      .take(500);

    return rows
      .filter((row) => !args.source || row.source === args.source)
      .sort((a, b) => b.submissions - a.submissions)
      .slice(0, Math.min(args.limit ?? 10, 25));
  },
});
```

**Step 4: Add worker/team row queries.**

```typescript
// Path: convex/leadGen/reporting.ts
export const listWorkerPerformance = query({
  args: reportFiltersValidator,
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const rows = await ctx.db
      .query("leadGenDailyStats")
      .withIndex("by_tenantId_and_dayKey", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("dayKey", args.startDayKey)
          .lte("dayKey", args.endDayKey),
      )
      .take(500);

    const byWorker = new Map<
      string,
      { workerId: string; submissions: number; uniqueProspects: number; duplicates: number }
    >();

    for (const row of rows) {
      if (args.teamId && row.teamId !== args.teamId) continue;
      if (args.workerId && row.workerId !== args.workerId) continue;
      if (args.source && row.source !== args.source) continue;

      const current =
        byWorker.get(row.workerId) ??
        {
          workerId: row.workerId,
          submissions: 0,
          uniqueProspects: 0,
          duplicates: 0,
        };
      current.submissions += row.submissions;
      current.uniqueProspects += row.uniqueProspectsSubmitted;
      current.duplicates += row.duplicateProspectSubmissions;
      byWorker.set(row.workerId, current);
    }

    return [...byWorker.values()].sort(
      (a, b) => b.submissions - a.submissions,
    );
  },
});
```

**Key implementation notes:**
- The initial query can filter a bounded date range in memory. If tenants exceed 500 aggregate rows per normal range, add branch-specific indexes instead of increasing `.take()`.
- Do not calculate admin dashboard counts from `leadGenSubmissions`.
- If row DTOs need worker names, fetch `leadGenWorkers` by IDs in a bounded loop or denormalize worker display name into aggregate rows in a future widen-only change.
- Keep audit matches as a separate metric only; do not expose conversion rates.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leadGen/reporting.ts` | Create | Admin aggregate report queries |

---

### 3C — CSV Export DTOs and Formula Hardening

**Type:** Backend / Frontend Utility  
**Parallelizable:** Yes — depends on aggregate/detail query contracts, independent from dashboard layout.

**What:** Add date-bounded admin export queries and a shared client/server-safe CSV serialization helper.

**Why:** Admins need exports, but raw user-entered social/origin strings can trigger spreadsheet formulas if exported naively.

**Where:**
- `convex/leadGen/exports.ts` (new)
- `lib/csv.ts` (new) or `app/workspace/lead-gen/_components/csv.ts` (new; choose shared `lib/` if used outside UI)

**How:**

**Step 1: Add CSV hardening helper.**

```typescript
// Path: lib/csv.ts
function hardenFormulaCell(value: string) {
  const trimmedStart = value.trimStart();
  if (/^[=+\-@\t\r]/.test(trimmedStart)) {
    return `'${value}`;
  }
  return value;
}

export function serializeCsvCell(value: unknown) {
  const raw = value == null ? "" : String(value);
  const hardened = hardenFormulaCell(raw);
  if (/[",\r\n]/.test(hardened)) {
    return `"${hardened.replace(/"/g, '""')}"`;
  }
  return hardened;
}

export function serializeCsv(rows: unknown[][]) {
  return rows.map((row) => row.map(serializeCsvCell).join(",")).join("\r\n");
}
```

**Step 2: Add summary export query.**

```typescript
// Path: convex/leadGen/exports.ts
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const getSummaryExportRows = query({
  args: {
    startDayKey: v.string(),
    endDayKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const rows = await ctx.db
      .query("leadGenDailyStats")
      .withIndex("by_tenantId_and_dayKey", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("dayKey", args.startDayKey)
          .lte("dayKey", args.endDayKey),
      )
      .take(1000);

    return rows.map((row) => ({
      dayKey: row.dayKey,
      workerId: row.workerId,
      teamId: row.teamId,
      source: row.source,
      submissions: row.submissions,
      uniqueProspects: row.uniqueProspectsSubmitted,
      duplicates: row.duplicateProspectSubmissions,
      scheduledHours: row.scheduledHours,
    }));
  },
});
```

**Step 3: Add raw export query with row limit.**

```typescript
// Path: convex/leadGen/exports.ts
export const getRawSubmissionExportRows = query({
  args: {
    startTimestamp: v.number(),
    endTimestamp: v.number(),
    maxRows: v.number(),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    if (args.maxRows < 1 || args.maxRows > 5000) {
      throw new Error("Export row limit is outside the allowed range");
    }

    const rows = await ctx.db
      .query("leadGenSubmissions")
      .withIndex("by_tenantId_and_submittedAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("submittedAt", args.startTimestamp)
          .lte("submittedAt", args.endTimestamp),
      )
      .take(args.maxRows + 1);

    if (rows.length > args.maxRows) {
      throw new Error("Export is too large. Narrow the date range.");
    }

    return rows.map((row) => ({
      submittedAt: row.submittedAt,
      workerId: row.workerId,
      source: row.source,
      originKind: row.originKind,
      originValue: row.originValue,
      voidedAt: row.voidedAt,
    }));
  },
});
```

**Key implementation notes:**
- Convex queries return DTO rows. CSV string generation can run in the browser for MVP to avoid server file generation.
- Preserve raw values in Convex. Hardening happens only in export serialization.
- For larger exports, add a later chunked export action; do not raise query limits beyond safe transaction bounds.
- Formula hardening must run before quote escaping so the literal apostrophe is part of the escaped CSV cell.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leadGen/exports.ts` | Create | Admin export DTO queries |
| `lib/csv.ts` | Create | Shared CSV serialization and formula hardening |

---

### 3D — Aggregate Reconciliation Scaffolding

**Type:** Backend / QA Support  
**Parallelizable:** Yes — depends on 3A; independent from UI.

**What:** Add an internal/admin repair path that can recompute aggregate rows for a bounded date range from non-voided raw submissions.

**Why:** Corrections and early MVP data fixes need a safe way to detect aggregate drift without manual database edits.

**Where:**
- `convex/leadGen/reconciliation.ts` (new)
- `convex/leadGen/aggregates.ts` (modify if shared reset/upsert helpers are extracted)

**How:**

**Step 1: Add bounded audit query for aggregate drift.**

```typescript
// Path: convex/leadGen/reconciliation.ts
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const auditAggregateRange = query({
  args: {
    startTimestamp: v.number(),
    endTimestamp: v.number(),
    maxRows: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const rows = await ctx.db
      .query("leadGenSubmissions")
      .withIndex("by_tenantId_and_submittedAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("submittedAt", args.startTimestamp)
          .lte("submittedAt", args.endTimestamp),
      )
      .take(args.maxRows ?? 1000);

    const activeRows = rows.filter((row) => !row.voidedAt);
    return {
      rawRowsChecked: rows.length,
      activeSubmissions: activeRows.length,
      note: "Compare with leadGenDailyStats totals for the same range.",
    };
  },
});
```

**Step 2: Defer destructive rebuild until Phase 5 corrections need it.**

```typescript
// Path: convex/leadGen/reconciliation.ts
// Phase 5 will add an admin-only mutation that deletes/rebuilds aggregate rows
// for a narrow date range after correction flows are implemented.
// Keep Phase 3 read-only unless real drift is detected during QA.
```

**Key implementation notes:**
- Start with drift audit before a rebuild mutation. Rebuilds need careful range deletes and should be introduced only when corrections require them.
- Never use `.collect()` across unbounded raw submissions.
- If a true rebuild is needed, batch by date range and schedule continuations with `ctx.scheduler.runAfter(0, ...)`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leadGen/reconciliation.ts` | Create | Bounded aggregate drift audit |

---

### 3E — Admin Dashboard, Filters, Tables, and Export UI

**Type:** Frontend  
**Parallelizable:** Yes — depends on 3B and 3C query DTOs; can proceed while 3D is reviewed.

**What:** Build `/workspace/lead-gen` as an admin-only desktop-first dashboard with date/source/team/worker filters, summary cards, worker/team performance, top origins, export actions, and loading states.

**Why:** Admin users need fast scanning and operational control, not a marketing page. The dashboard should sit naturally inside the existing workspace shell.

**Where:**
- `app/workspace/lead-gen/page.tsx` (new)
- `app/workspace/lead-gen/loading.tsx` (new)
- `app/workspace/lead-gen/_components/lead-gen-admin-page-client.tsx` (new)
- `app/workspace/lead-gen/_components/lead-gen-filter-bar.tsx` (new)
- `app/workspace/lead-gen/_components/lead-gen-summary-cards.tsx` (new)
- `app/workspace/lead-gen/_components/worker-performance-table.tsx` (new)
- `app/workspace/lead-gen/_components/top-origins-table.tsx` (new)
- `app/workspace/lead-gen/_components/lead-gen-export-menu.tsx` (new)
- `app/workspace/lead-gen/_components/lead-gen-admin-skeleton.tsx` (new)

**How:**

**Step 1: Add admin route wrapper.**

```tsx
// Path: app/workspace/lead-gen/page.tsx
import { Suspense } from "react";
import { requirePermission } from "@/lib/auth";
import { LeadGenAdminPageClient } from "./_components/lead-gen-admin-page-client";
import { LeadGenAdminSkeleton } from "./_components/lead-gen-admin-skeleton";

export const unstable_instant = false;

export default async function LeadGenAdminPage() {
  await requirePermission("lead-gen:view-all");

  return (
    <Suspense fallback={<LeadGenAdminSkeleton />}>
      <LeadGenAdminPageClient />
    </Suspense>
  );
}
```

**Step 2: Query dashboard DTOs from a single filter state.**

```tsx
// Path: app/workspace/lead-gen/_components/lead-gen-admin-page-client.tsx
"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { LeadGenFilterBar } from "./lead-gen-filter-bar";
import { LeadGenSummaryCards } from "./lead-gen-summary-cards";
import { WorkerPerformanceTable } from "./worker-performance-table";
import { TopOriginsTable } from "./top-origins-table";

type LeadGenFilters = {
  startDayKey: string;
  endDayKey: string;
  source?: "instagram" | "meta_business";
};

export function LeadGenAdminPageClient() {
  const [filters, setFilters] = useState<LeadGenFilters>(() => ({
    startDayKey: new Date().toISOString().slice(0, 10),
    endDayKey: new Date().toISOString().slice(0, 10),
  }));

  const overview = useQuery(api.leadGen.reporting.getOverview, filters);
  const workers = useQuery(api.leadGen.reporting.listWorkerPerformance, filters);
  const origins = useQuery(api.leadGen.reporting.listTopOrigins, {
    startDayKey: filters.startDayKey,
    endDayKey: filters.endDayKey,
    source: filters.source,
    limit: 10,
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-normal">
          Lead Gen Ops
        </h1>
        <p className="text-sm text-muted-foreground">
          Worker activity, source quality, and operational exports.
        </p>
      </div>
      <LeadGenFilterBar value={filters} onChange={setFilters} />
      <LeadGenSummaryCards data={overview} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.8fr)]">
        <WorkerPerformanceTable rows={workers} />
        <TopOriginsTable rows={origins} />
      </div>
    </div>
  );
}
```

**Step 3: Build summary cards with stable dimensions.**

```tsx
// Path: app/workspace/lead-gen/_components/lead-gen-summary-cards.tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type Overview = {
  submissions: number;
  uniqueProspects: number;
  duplicates: number;
  scheduledHours: number;
  leadsPerHour: number | null;
};

export function LeadGenSummaryCards({ data }: { data: Overview | undefined }) {
  const cards = [
    ["Submissions", data?.submissions],
    ["Unique prospects", data?.uniqueProspects],
    ["Duplicates", data?.duplicates],
    ["Leads/hour", data?.leadsPerHour?.toFixed(2) ?? null],
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {cards.map(([label, value]) => (
        <Card key={label}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">{label}</CardTitle>
          </CardHeader>
          <CardContent>
            {data === undefined ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <p className="text-3xl font-semibold tracking-normal">
                {value ?? "—"}
              </p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
```

**Step 4: Add export menu using the CSV helper.**

```tsx
// Path: app/workspace/lead-gen/_components/lead-gen-export-menu.tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { serializeCsv } from "@/lib/csv";
import { Button } from "@/components/ui/button";
import { DownloadIcon } from "lucide-react";

export function LeadGenExportMenu(props: {
  startDayKey: string;
  endDayKey: string;
}) {
  const rows = useQuery(api.leadGen.exports.getSummaryExportRows, props);

  const download = () => {
    if (!rows) return;
    const csv = serializeCsv([
      ["Day", "Worker", "Team", "Source", "Submissions", "Unique", "Duplicates"],
      ...rows.map((row) => [
        row.dayKey,
        row.workerId,
        row.teamId ?? "",
        row.source,
        row.submissions,
        row.uniqueProspects,
        row.duplicates,
      ]),
    ]);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `lead-gen-summary-${props.startDayKey}-${props.endDayKey}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Button variant="outline" onClick={download} disabled={!rows}>
      <DownloadIcon data-icon="inline-start" />
      Export
    </Button>
  );
}
```

**Key implementation notes:**
- Use cards only for individual summary metrics and tables; do not put the whole page in a floating card.
- Keep filters compact and sticky only if existing report pages use that pattern.
- Use semantic tokens and existing chart/table primitives. Avoid a new color system for this module.
- Keep table columns scannable; truncate long origin values with accessible full value in a tooltip or link.
- For mobile admin, allow horizontal table scroll; do not compress dense reporting into unreadable cards.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/lead-gen/page.tsx` | Create | Admin dashboard RSC wrapper |
| `app/workspace/lead-gen/loading.tsx` | Create | Route loading state |
| `app/workspace/lead-gen/_components/lead-gen-admin-page-client.tsx` | Create | Dashboard client |
| `app/workspace/lead-gen/_components/lead-gen-filter-bar.tsx` | Create | Date/source/team/worker filters |
| `app/workspace/lead-gen/_components/lead-gen-summary-cards.tsx` | Create | Summary cards |
| `app/workspace/lead-gen/_components/worker-performance-table.tsx` | Create | Worker table |
| `app/workspace/lead-gen/_components/top-origins-table.tsx` | Create | Origin ranking |
| `app/workspace/lead-gen/_components/lead-gen-export-menu.tsx` | Create | CSV export actions |
| `app/workspace/lead-gen/_components/lead-gen-admin-skeleton.tsx` | Create | Dashboard skeleton |

---

### 3F — Reporting QA, Reconciliation, and Performance Gate

**Type:** QA / Performance  
**Parallelizable:** No — runs after aggregate writes, reporting queries, exports, and dashboard UI are complete.

**What:** Verify aggregate accuracy, export hardening, admin authorization, query bounds, and desktop dashboard polish.

**Why:** Reporting is compensation-adjacent even though payout automation is out of scope. Wrong counts or unsafe exports are high-trust failures.

**Where:**
- `convex/leadGen/aggregates.ts` (verify)
- `convex/leadGen/reporting.ts` (verify)
- `convex/leadGen/exports.ts` (verify)
- `lib/csv.ts` (verify)
- `app/workspace/lead-gen/*` (verify)

**How:**

**Step 1: Run automated checks.**

```bash
# Path: terminal
pnpm tsc --noEmit
pnpm lint
rg "\\.collect\\(\\)" convex/leadGen
```

Any `.collect()` in `convex/leadGen` must be justified and bounded by design; default answer is to replace it.

**Step 2: Reconcile aggregate totals against seed data.**

```markdown
<!-- Path: QA notes -->

For a one-day seed range:

- Raw non-voided submissions count equals overview `submissions`.
- Count of unique prospect IDs equals overview `uniqueProspects`.
- Repeated same-prospect submissions equal overview `duplicates`.
- Source filters sum to total submissions.
- Scheduled hours do not double-count when both Instagram and Meta rows exist for one worker/day.
```

**Step 3: Verify CSV hardening.**

```typescript
// Path: lib/csv.ts
serializeCsv([
  ["origin"],
  ["=IMPORTXML(\"https://example.com\")"],
  ["+1"],
  ["@cmd"],
]);
```

Expected exported cells begin with a literal apostrophe after CSV parsing.

**Step 4: Desktop dashboard QA.**

```markdown
<!-- Path: QA notes -->

- 1440px desktop: summary cards, filters, worker table, and top origins fit without overlap.
- 1024px tablet: dashboard remains scannable; tables scroll horizontally if needed.
- Empty state: zero data shows useful empty states without fake metrics.
- Loading state: skeleton dimensions match final cards/tables.
- Unauthorized: `lead_generator` direct visit to `/workspace/lead-gen` redirects to capture.
```

**Key implementation notes:**
- If Convex insights show high docs read in reporting queries, add specific indexes for the filter combinations that are hot instead of moving to raw scans.
- Keep Lead Gen Ops audit matches out of conversion charts. A count can appear as traceability only after Phase 4.
- Verify exports in a spreadsheet app as part of manual QA because formula-hardening failures are user-visible outside the browser.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| No production code | Verify | Reporting, export, and performance gate |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/leadGen/aggregates.ts` | Create | 3A |
| `convex/leadGen/reporting.ts` | Create | 3B |
| `convex/leadGen/exports.ts` | Create | 3C |
| `lib/csv.ts` | Create | 3C |
| `convex/leadGen/reconciliation.ts` | Create | 3D |
| `app/workspace/lead-gen/page.tsx` | Create | 3E |
| `app/workspace/lead-gen/loading.tsx` | Create | 3E |
| `app/workspace/lead-gen/_components/lead-gen-admin-page-client.tsx` | Create | 3E |
| `app/workspace/lead-gen/_components/lead-gen-filter-bar.tsx` | Create | 3E |
| `app/workspace/lead-gen/_components/lead-gen-summary-cards.tsx` | Create | 3E |
| `app/workspace/lead-gen/_components/worker-performance-table.tsx` | Create | 3E |
| `app/workspace/lead-gen/_components/top-origins-table.tsx` | Create | 3E |
| `app/workspace/lead-gen/_components/lead-gen-export-menu.tsx` | Create | 3E |
| `app/workspace/lead-gen/_components/lead-gen-admin-skeleton.tsx` | Create | 3E |
