# Phase 1 — Aggregate Foundation

**Goal:** Install `@convex-dev/aggregate`, register 5 named aggregate instances, add `callClassification` and time-tracking fields to the `meetings` schema, define aggregate sort key configurations, create backfill mutations, and deploy — so all subsequent phases have O(log n) aggregation primitives and the schema fields they need.

**Prerequisite:** v0.5b database audit fully deployed — all schema changes, domain event emission sites (25), `meetingFormResponses` backfill, and `eventTypeFieldCatalog` population complete.

**Runs in PARALLEL with:** Nothing — all subsequent phases depend on this foundation (aggregate instances, schema fields, and backfill completion).

**Skills to invoke:**
- `convex-migration-helper` — if schema deployment fails or `callClassification` backfill needs widen-migrate-narrow strategy
- `convex-performance-audit` — verify aggregate backfill completes without hitting transaction limits

> **Critical path:** This phase is on the critical path (Phase 1 → Phase 2/3/4 → Phase 5 → Phase 6).
> Start immediately.

**Acceptance Criteria:**
1. `pnpm add @convex-dev/aggregate` succeeds and the package appears in `package.json` dependencies.
2. `convex/convex.config.ts` registers 5 named aggregate instances (`meetingsByStatus`, `paymentSums`, `opportunityByStatus`, `leadTimeline`, `customerConversions`).
3. `convex/schema.ts` includes `callClassification`, `stoppedAt`, `lateStartDurationMs`, `lateStartReason`, and `overranDurationMs` as `v.optional(...)` fields on the `meetings` table.
4. `npx convex dev` succeeds without schema errors after deploying all changes.
5. `convex/reporting/aggregates.ts` exports 5 `TableAggregate` instances with correct sort keys and namespace functions.
6. Running `backfillMeetingClassification` via the Convex dashboard sets `callClassification` on all existing meetings (~213 records).
7. Running all 5 `backfill*Aggregate` mutations populates the aggregates with existing data. Aggregate counts match direct table scans.
8. `convex/reporting/lib/periodBucketing.ts` exports `getPeriodsInRange` and `getPeriodKey` with correct UTC-based period boundaries.
9. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (install + config) ──────────────────────────────────────────┐
                                                                ├── 1D (backfill mutations — needs 1B schema + 1C aggregates)
1B (schema additions) ─────────────────────────────────────────┤
                                                                │
1C (aggregate instances) ──────────────────────────────────────┤
                                                                │
1E (period bucketing + helpers) ───────────────────────────────┘
                                                                │
                                                    1D complete ├── 1F (deploy + verify)
                                                                │
                                                    1E complete ┘
```

**Optimal execution:**
1. Start **1A** first — package install enables everything else.
2. After 1A completes → start **1B**, **1C**, **1E** all in parallel (different files, no shared imports).
3. After 1B + 1C complete → start **1D** (backfill needs schema types + aggregate imports).
4. After 1D + 1E complete → **1F** (deploy + run backfills + verify).

**Estimated time:** 2-3 days

---

## Subphases

### 1A — Install Aggregate Package + Register Component

**Type:** Config
**Parallelizable:** No — must complete first. All other subphases depend on the installed package and component registration.

**What:** Install `@convex-dev/aggregate` and register 5 named instances in `convex/convex.config.ts`.

**Why:** The aggregate component creates internal tables managed by the component runtime. Without registration, the `TableAggregate` class cannot be instantiated. All reporting queries depend on these instances.

**Where:**
- `convex/convex.config.ts` (modify)
- `package.json` (modify — via `pnpm add`)

**How:**

**Step 1: Install the package**

```bash
pnpm add @convex-dev/aggregate
```

**Step 2: Verify the installed API**

Before writing code, confirm the installed version's exports match the design assumptions:

```bash
# Check installed version
cat node_modules/@convex-dev/aggregate/package.json | grep version
# Verify exports: TableAggregate, insert, replace, count, sum, insertIfDoesNotExist
```

**Step 3: Register 5 named instances**

```typescript
// Path: convex/convex.config.ts
import workOSAuthKit from "@convex-dev/workos-authkit/convex.config";
import aggregate from "@convex-dev/aggregate/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(workOSAuthKit);

// Reporting aggregates — 5 instances for O(log n) counts and sums
app.use(aggregate, { name: "meetingsByStatus" });
app.use(aggregate, { name: "paymentSums" });
app.use(aggregate, { name: "opportunityByStatus" });
app.use(aggregate, { name: "leadTimeline" });
app.use(aggregate, { name: "customerConversions" });

export default app;
```

**Key implementation notes:**
- The import path is `@convex-dev/aggregate/convex.config.js` (with `.js` extension) — this is the Convex component config, not the runtime code.
- Each named instance gets its own internal tables. 5 instances = 5 independent B-trees.
- If the API shape doesn't match the design (e.g., `TableAggregate` is not the export name), read the package's TypeScript declarations and adjust the aggregate instance definitions in 1C accordingly.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/convex.config.ts` | Modify | Add 5 aggregate component registrations |
| `package.json` | Modify | Add `@convex-dev/aggregate` dependency (via pnpm) |

---

### 1B — Schema Additions

**Type:** Backend
**Parallelizable:** Yes — after 1A. Touches only `convex/schema.ts`, no overlap with 1C or 1E.

**What:** Add `callClassification` (new/follow-up split) and 4 time-tracking fields to the `meetings` table definition.

**Why:** `callClassification` is the core dimension for the Team Performance report's "New Calls" vs "Follow-Up Calls" split. Time-tracking fields (`stoppedAt`, `lateStartDurationMs`, `lateStartReason`, `overranDurationMs`) are needed by Phase 2's `stopMeeting` mutation and Tier 3 KPIs. All are `v.optional` because existing records lack them until backfill.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Add fields to the meetings table**

```typescript
// Path: convex/schema.ts — inside the meetings defineTable, after existing fields
// Look for the closing of the current meetings table fields, before the indexes.

// === v0.6: Call Classification ===
// Set at meeting creation time by the pipeline. "new" = first meeting on this opportunity.
// "follow_up" = subsequent booking on an existing opportunity.
callClassification: v.optional(
  v.union(
    v.literal("new"),
    v.literal("follow_up"),
  ),
),

// === v0.6: Meeting Time Tracking ===
// When the closer clicked "End Meeting". Distinct from completedAt (which may be
// set by other flows). Used to compute actual meeting duration and overrun.
stoppedAt: v.optional(v.number()),

// Late start tracking — computed and stored by startMeeting mutation.
// If startedAt > scheduledAt, the meeting was started late.
lateStartDurationMs: v.optional(v.number()),   // ms late (0 if on time or early)
lateStartReason: v.optional(v.string()),       // Free-text reason from closer (optional)

// Overrun tracking — computed and stored by stopMeeting mutation.
// If stoppedAt > scheduledAt + durationMinutes * 60000, the meeting overran.
overranDurationMs: v.optional(v.number()),     // ms over (0 if within scheduled time)
```

**Key implementation notes:**
- All 5 fields are `v.optional` — existing ~213 meetings will have `undefined` for these fields until backfill (1D).
- No new indexes are needed — `callClassification` is consumed via the aggregate sort key, and time-tracking fields are only read per-document (not queried by range).
- `stoppedAt` is distinct from `completedAt` — `completedAt` may be set by other flows (e.g., webhook-driven), while `stoppedAt` is exclusively set by the closer's "End Meeting" action.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add 5 new optional fields to meetings table |

---

### 1C — Aggregate Instance Definitions

**Type:** Backend
**Parallelizable:** Yes — after 1A. Touches only `convex/reporting/aggregates.ts` (new file), no overlap with 1B or 1E.

**What:** Create `convex/reporting/aggregates.ts` with 5 `TableAggregate` instances, each with a tailored namespace, sort key, and optional sum value.

**Why:** Each aggregate instance is the backbone of a specific report. The sort key design determines which queries are O(log n). Incorrect sort keys would require rebuilding the entire aggregate from scratch.

**Where:**
- `convex/reporting/aggregates.ts` (new)

**How:**

**Step 1: Create the reporting directory and aggregates file**

```typescript
// Path: convex/reporting/aggregates.ts
import { TableAggregate } from "@convex-dev/aggregate";
import { components } from "../_generated/api";
import type { DataModel, Id } from "../_generated/dataModel";

/**
 * Instance 1: meetingsByStatus
 * Powers: Team Performance report (Tier 1 KPIs)
 * Sort key: [closerId, callClassification, status, scheduledAt]
 * Enables: count meetings by closer + classification + status + date range
 */
export const meetingsByStatus = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [Id<"users">, string, string, number];
  DataModel: DataModel;
  TableName: "meetings";
}>(components.meetingsByStatus, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => [
    doc.assignedCloserId,
    doc.callClassification ?? "new",
    doc.status,
    doc.scheduledAt,
  ],
});

/**
 * Instance 2: paymentSums
 * Powers: Revenue report, Team Performance "Sales" + "Cash Collected"
 * Sort key: [closerId, recordedAt]
 * Sum value: amountMinor (excluding disputed payments)
 */
export const paymentSums = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [Id<"users">, number];
  DataModel: DataModel;
  TableName: "paymentRecords";
}>(components.paymentSums, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => [doc.closerId, doc.recordedAt],
  sumValue: (doc) => (doc.status !== "disputed" ? doc.amountMinor : 0),
});

/**
 * Instance 3: opportunityByStatus
 * Powers: Pipeline Health report
 * Sort key: [status, assignedCloserId, createdAt]
 */
export const opportunityByStatus = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [string, string, number];
  DataModel: DataModel;
  TableName: "opportunities";
}>(components.opportunityByStatus, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => [
    doc.status,
    doc.assignedCloserId ?? "",
    doc.createdAt,
  ],
});

/**
 * Instance 4: leadTimeline
 * Powers: Lead & Conversion report — "New Leads" count
 * Sort key: _creationTime (immutable — inserts only)
 */
export const leadTimeline = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: number;
  DataModel: DataModel;
  TableName: "leads";
}>(components.leadTimeline, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => doc._creationTime,
});

/**
 * Instance 5: customerConversions
 * Powers: Lead & Conversion report — conversion count by closer
 * Sort key: [convertedByUserId, convertedAt] (both immutable — inserts only)
 */
export const customerConversions = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [Id<"users">, number];
  DataModel: DataModel;
  TableName: "customers";
}>(components.customerConversions, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => [doc.convertedByUserId, doc.convertedAt],
});
```

**Key implementation notes:**
- The generic type parameters must match the actual table document shapes in `schema.ts`. If `assignedCloserId` is optional on `opportunities`, the sort key must handle `undefined` (e.g., `doc.assignedCloserId ?? ""`).
- `meetingsByStatus` defaults `callClassification ?? "new"` — unclassified meetings (pre-backfill) are counted as "new." This is a deliberate conservative default.
- `paymentSums` filters disputed payments in `sumValue` — a disputed payment contributes 0 to the sum. If a payment is later disputed, a `replace()` call zeroes its contribution automatically.
- `leadTimeline` and `customerConversions` are insert-only aggregates — no `replace()` needed (leads and customers are never status-transitioned in a way that changes sort key fields).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/aggregates.ts` | Create | 5 TableAggregate instances with namespace + sort key + sumValue |

---

### 1D — Backfill Mutations

**Type:** Backend
**Parallelizable:** No — depends on 1B (schema fields for `callClassification`) and 1C (aggregate instances for import).

**What:** Create `convex/reporting/backfill.ts` with 6 `internalMutation` functions: 1 for `callClassification` classification, and 5 for populating each aggregate from existing data.

**Why:** Existing ~213 meetings have no `callClassification`, and all 5 aggregates are empty after registration. Without backfill, reports would show zero values for historical data. The classification backfill must run before the aggregate backfill (the meetings aggregate uses `callClassification` in its sort key).

**Where:**
- `convex/reporting/backfill.ts` (new)

**How:**

**Step 1: Create the backfill file with classification mutation**

```typescript
// Path: convex/reporting/backfill.ts
import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import {
  meetingsByStatus,
  paymentSums,
  opportunityByStatus,
  leadTimeline,
  customerConversions,
} from "./aggregates";

/**
 * Stage A: Backfill callClassification on existing meetings.
 * Must run BEFORE aggregate backfill (meetingsByStatus uses callClassification in sort key).
 *
 * Logic: First meeting on an opportunity → "new"; subsequent → "follow_up".
 * Uses by_opportunityId_and_scheduledAt index to find the earliest meeting.
 */
export const backfillMeetingClassification = internalMutation({
  args: {},
  handler: async (ctx) => {
    const meetings = await ctx.db.query("meetings").take(500);
    let updated = 0;

    for (const meeting of meetings) {
      if (meeting.callClassification !== undefined) continue;

      const firstMeeting = await ctx.db
        .query("meetings")
        .withIndex("by_opportunityId_and_scheduledAt", (q) =>
          q.eq("opportunityId", meeting.opportunityId),
        )
        .first();

      const classification =
        firstMeeting && firstMeeting._id === meeting._id ? "new" : "follow_up";
      await ctx.db.patch(meeting._id, { callClassification: classification });
      updated++;
    }

    // Continue in batches to avoid transaction limits
    if (meetings.length === 500) {
      await ctx.scheduler.runAfter(
        0,
        internal.reporting.backfill.backfillMeetingClassification,
        {},
      );
    }

    return { updated };
  },
});
```

**Step 2: Add aggregate backfill mutations (one per table)**

```typescript
// Path: convex/reporting/backfill.ts (continued)

export const backfillMeetingsAggregate = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const result = await ctx.db.query("meetings").paginate({
      numItems: 200,
      cursor: cursor ?? null,
    });
    for (const doc of result.page) {
      await meetingsByStatus.insertIfDoesNotExist(ctx, doc);
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.reporting.backfill.backfillMeetingsAggregate,
        { cursor: result.continueCursor },
      );
    }
  },
});

export const backfillPaymentsAggregate = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const result = await ctx.db.query("paymentRecords").paginate({
      numItems: 200,
      cursor: cursor ?? null,
    });
    for (const doc of result.page) {
      await paymentSums.insertIfDoesNotExist(ctx, doc);
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.reporting.backfill.backfillPaymentsAggregate,
        { cursor: result.continueCursor },
      );
    }
  },
});

export const backfillOpportunitiesAggregate = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const result = await ctx.db.query("opportunities").paginate({
      numItems: 200,
      cursor: cursor ?? null,
    });
    for (const doc of result.page) {
      await opportunityByStatus.insertIfDoesNotExist(ctx, doc);
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.reporting.backfill.backfillOpportunitiesAggregate,
        { cursor: result.continueCursor },
      );
    }
  },
});

export const backfillLeadsAggregate = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const result = await ctx.db.query("leads").paginate({
      numItems: 200,
      cursor: cursor ?? null,
    });
    for (const doc of result.page) {
      await leadTimeline.insertIfDoesNotExist(ctx, doc);
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.reporting.backfill.backfillLeadsAggregate,
        { cursor: result.continueCursor },
      );
    }
  },
});

export const backfillCustomersAggregate = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const result = await ctx.db.query("customers").paginate({
      numItems: 200,
      cursor: cursor ?? null,
    });
    for (const doc of result.page) {
      await customerConversions.insertIfDoesNotExist(ctx, doc);
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.reporting.backfill.backfillCustomersAggregate,
        { cursor: result.continueCursor },
      );
    }
  },
});
```

**Key implementation notes:**
- Classification backfill must run to completion BEFORE any aggregate backfill — the `meetingsByStatus` sort key reads `callClassification`.
- At current scale (~213 meetings, ~50 payments, ~213 opportunities, ~200 leads, ~30 customers), all backfills complete in a single batch. Pagination is included for safety.
- `insertIfDoesNotExist` is idempotent — safe to re-run if a backfill is interrupted or run twice.
- The `cursor ?? null` pattern handles both first invocation (no cursor) and continuation (with cursor string).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/backfill.ts` | Create | 6 internalMutation functions — 1 classification + 5 aggregate backfills |

---

### 1E — Period Bucketing Helpers

**Type:** Backend
**Parallelizable:** Yes — after 1A. Touches only new files in `convex/reporting/lib/`, no overlap with 1B, 1C, or 1D.

**What:** Create `convex/reporting/lib/periodBucketing.ts` — shared utility for generating time period boundaries (day/week/month) used by trend queries in Phase 3.

**Why:** The revenue trend chart and future trend queries need to bucket data into time periods. Centralizing this logic avoids duplication and ensures consistent UTC-based boundaries. Must be in place before Phase 3 queries are written.

**Where:**
- `convex/reporting/lib/periodBucketing.ts` (new)

**How:**

**Step 1: Create the period bucketing module**

```typescript
// Path: convex/reporting/lib/periodBucketing.ts

export type Granularity = "day" | "week" | "month";

export interface Period {
  key: string;   // e.g., "2026-01-15", "2026-W03", "2026-01"
  start: number; // epoch ms (inclusive)
  end: number;   // epoch ms (exclusive)
}

/**
 * Generate period boundaries for a date range at the specified granularity.
 * All boundaries are UTC-based (no timezone conversion).
 * Capped at 90 periods max to prevent runaway generation.
 */
export function getPeriodsInRange(
  startDate: number,
  endDate: number,
  granularity: Granularity,
): Period[] {
  const periods: Period[] = [];
  let current = startDate;

  while (current < endDate && periods.length < 90) {
    const periodEnd = getNextPeriodStart(current, granularity);
    const clampedEnd = Math.min(periodEnd, endDate);
    periods.push({
      key: getPeriodKey(current, granularity),
      start: current,
      end: clampedEnd,
    });
    current = periodEnd;
  }

  return periods;
}

export function getPeriodKey(timestamp: number, granularity: Granularity): string {
  const d = new Date(timestamp);
  switch (granularity) {
    case "day":
      return d.toISOString().slice(0, 10); // "2026-01-15"
    case "week":
      return `${d.getUTCFullYear()}-W${String(getISOWeek(d)).padStart(2, "0")}`;
    case "month":
      return d.toISOString().slice(0, 7); // "2026-01"
  }
}

function getNextPeriodStart(timestamp: number, granularity: Granularity): number {
  const d = new Date(timestamp);
  switch (granularity) {
    case "day":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    case "week":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (7 - d.getUTCDay()));
    case "month":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
}

function getISOWeek(d: Date): number {
  const temp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  temp.setUTCDate(temp.getUTCDate() + 4 - (temp.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(temp.getUTCFullYear(), 0, 1));
  return Math.ceil(((temp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
```

**Key implementation notes:**
- All boundaries are UTC — no timezone awareness in v0.6 (deferred to v0.7).
- 90-period cap prevents a 1-year daily range from generating 365 periods (would be expensive for queries).
- `getISOWeek` follows ISO 8601 week numbering (Monday-start, first week contains January 4).
- Edge case: if `startDate` and `endDate` are within the same period, the function returns a single period.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/lib/periodBucketing.ts` | Create | Period generation utility for trend queries |

---

### 1F — Deploy and Verify

**Type:** Manual
**Parallelizable:** No — final step after all other subphases complete.

**What:** Deploy schema + component registration, run backfills in sequence, verify aggregate integrity.

**Why:** The deployment sequence matters: schema must be deployed before backfills run, classification backfill must complete before aggregate backfills. Verification ensures the foundation is solid before Phase 2-5 build on it.

**Where:**
- Convex dashboard (manual verification)

**How:**

**Step 1: Deploy**

```bash
npx convex dev
```

Verify in the Convex dashboard:
- 5 aggregate component instances appear in the component list
- `meetings` table schema includes the 5 new fields

**Step 2: Run classification backfill**

```bash
# Via Convex dashboard → Functions → reporting/backfill → backfillMeetingClassification
# Or via CLI:
npx convex run reporting/backfill:backfillMeetingClassification
```

Verify: all meetings have `callClassification` set (check a few in the dashboard).

**Step 3: Run aggregate backfills (can be concurrent — different tables)**

```bash
npx convex run reporting/backfill:backfillMeetingsAggregate
npx convex run reporting/backfill:backfillPaymentsAggregate
npx convex run reporting/backfill:backfillOpportunitiesAggregate
npx convex run reporting/backfill:backfillLeadsAggregate
npx convex run reporting/backfill:backfillCustomersAggregate
```

**Step 4: Verify aggregate integrity**

Spot-check: compare an aggregate count against a direct table scan in the Convex dashboard.

**Step 5: TypeScript check**

```bash
pnpm tsc --noEmit
```

**Key implementation notes:**
- The 5 aggregate backfills can run concurrently — they touch different source tables and different aggregate instances.
- If any backfill fails mid-batch, re-run it. `insertIfDoesNotExist` is idempotent.
- If `npx convex dev` fails with schema validation errors, use the `convex-migration-helper` skill.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| — | — | No file changes — manual deployment and verification |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `package.json` | Modify | 1A |
| `convex/convex.config.ts` | Modify | 1A |
| `convex/schema.ts` | Modify | 1B |
| `convex/reporting/aggregates.ts` | Create | 1C |
| `convex/reporting/backfill.ts` | Create | 1D |
| `convex/reporting/lib/periodBucketing.ts` | Create | 1E |
