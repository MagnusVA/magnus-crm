# Phase 4 — Operations Hub: Scheduling and Phone Sales

**Goal:** Complete the Operations hub by adding Scheduling and Phone Sales tabs with index-backed lists, full-period phone-sales stats, closer/program/attribution filters, and health states for unmapped or unassigned bookings.

**Prerequisite:** Phase 2 optional meeting/opportunity attribution and booked-program fields are deployed. Phase 3 `operationsQualificationRows` projection exists and is refreshed when opportunity first-booking fields change.

**Runs in PARALLEL with:** Phase 5 can start after Phase 4A/4B query contracts stabilize. Reporting work in Phase 6 depends on the aggregate and dimension naming from this phase.

**Skills to invoke:**
- `convex-performance-audit` — Phone Sales stats must count full filtered periods without deriving from paginated rows.
- `convex-migration-helper` — Aggregate additions and meeting cache backfills need production-safe verification.
- `frontend-design` — These tabs are operator dashboards; prioritize scannable tables, compact controls, and clear unsupported-filter states.
- `shadcn` — Compose Tabs, Table, Select, ToggleGroup, Badge, Alert, Skeleton, Empty, and Button.
- `vercel-react-best-practices` — Keep query args stable and avoid loading hidden tabs if they become expensive.

**Acceptance Criteria:**
1. `/workspace/operations?tab=scheduling` lists qualification rows that have `firstMeetingId` and supports date plus one indexed primary filter at a time: booked program, sold program, Slack qualifier, DM team, DM closer, or phone closer.
2. Scheduling uses `firstMeetingAt` for date filters and displays `firstBookedAt` separately where available.
3. `/workspace/operations?tab=phone-sales` lists tenant meetings enriched with lead, opportunity, booked program, sold program, phone closer, DM attribution, and Slack qualifier.
4. Phone Sales filters include assigned closer, booked program, sold program, scheduled date range, meeting status, opportunity status, DM team, and DM closer, with one indexed primary dimension plus date range enabled at a time.
5. Phone Sales stat cards count the full filtered period, not the current page.
6. Unsupported filter combinations are disabled or shown as explicitly partial; the client never silently scans large result sets.
7. Unmapped booked programs, unmapped UTMs, and unassigned bookings surface as actionable health states.
8. Existing admin meeting detail routes remain linked from Operations rows.
9. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (Scheduling query) ────────────┬── 4D (Scheduling tab UI)
                                  │
4B (Phone Sales list query) ──────┼── 4E (Phone Sales tab UI)
                                  │
4C (Stats aggregate) ─────────────┘

4D + 4E complete ─────────────────── 4F (health states + verification)
```

**Optimal execution:**
1. Implement 4A and 4B backend list queries in parallel.
2. Implement 4C aggregate/stats after finalizing supported Phone Sales dimensions.
3. Build UI tabs once backend result shapes are stable.
4. Add health states and verify query performance.

**Estimated time:** 4-6 days

---

## Subphases

### 4A — Scheduling Queue Query

**Type:** Backend
**Parallelizable:** Yes — depends on Phase 3 projection fields but not Phone Sales list work.

**What:** Add a paginated Scheduling query over `operationsQualificationRows` using `firstMeetingAt` indexes.

**Why:** Scheduling answers "which qualified leads booked a meeting and when" without scanning opportunities or joining meetings for every row.

**Where:**
- `convex/operations/scheduling.ts` (new)
- `convex/operations/qualifications.ts` (reuse row enrichment helpers if extracted)

**How:**

**Step 1: Query rows by scheduled time or booked program + scheduled time.**

```typescript
// Path: convex/operations/scheduling.ts
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

function schedulingRowsQuery(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    bookingProgramId?: Id<"tenantPrograms">;
    soldProgramId?: Id<"tenantPrograms">;
    slackUserId?: string;
    assignedCloserId?: Id<"users">;
    attributionTeamId?: Id<"attributionTeams">;
    dmCloserId?: Id<"dmClosers">;
    scheduledFrom?: number;
    scheduledTo?: number;
  },
) {
  const primaryFilters = [
    args.bookingProgramId,
    args.soldProgramId,
    args.slackUserId,
    args.assignedCloserId,
    args.attributionTeamId,
    args.dmCloserId,
  ].filter(Boolean).length;
  if (primaryFilters > 1) {
    throw new Error("Select only one primary scheduling filter at a time.");
  }

  const from = args.scheduledFrom ?? 0;

  if (args.bookingProgramId) {
    return ctx.db.query("operationsQualificationRows").withIndex(
      "by_tenantId_and_bookingProgramId_and_firstMeetingAt",
      (q) => {
        const base = q
          .eq("tenantId", args.tenantId)
          .eq("bookingProgramId", args.bookingProgramId);
        const ranged = base.gte("firstMeetingAt", from);
        return args.scheduledTo !== undefined
          ? ranged.lt("firstMeetingAt", args.scheduledTo)
          : ranged;
      },
    );
  }
  if (args.soldProgramId) {
    return ctx.db.query("operationsQualificationRows").withIndex(
      "by_tenantId_and_soldProgramId_and_firstMeetingAt",
      (q) => {
        const base = q
          .eq("tenantId", args.tenantId)
          .eq("soldProgramId", args.soldProgramId);
        const ranged = base.gte("firstMeetingAt", from);
        return args.scheduledTo !== undefined
          ? ranged.lt("firstMeetingAt", args.scheduledTo)
          : ranged;
      },
    );
  }
  if (args.slackUserId) {
    return ctx.db.query("operationsQualificationRows").withIndex(
      "by_tenantId_and_slackUserId_and_firstMeetingAt",
      (q) => {
        const base = q
          .eq("tenantId", args.tenantId)
          .eq("slackUserId", args.slackUserId);
        const ranged = base.gte("firstMeetingAt", from);
        return args.scheduledTo !== undefined
          ? ranged.lt("firstMeetingAt", args.scheduledTo)
          : ranged;
      },
    );
  }
  if (args.assignedCloserId) {
    return ctx.db.query("operationsQualificationRows").withIndex(
      "by_tenantId_and_assignedCloserId_and_firstMeetingAt",
      (q) => {
        const base = q
          .eq("tenantId", args.tenantId)
          .eq("assignedCloserId", args.assignedCloserId);
        const ranged = base.gte("firstMeetingAt", from);
        return args.scheduledTo !== undefined
          ? ranged.lt("firstMeetingAt", args.scheduledTo)
          : ranged;
      },
    );
  }
  if (args.attributionTeamId) {
    return ctx.db.query("operationsQualificationRows").withIndex(
      "by_tenantId_and_attributionTeamId_and_firstMeetingAt",
      (q) => {
        const base = q
          .eq("tenantId", args.tenantId)
          .eq("attributionTeamId", args.attributionTeamId);
        const ranged = base.gte("firstMeetingAt", from);
        return args.scheduledTo !== undefined
          ? ranged.lt("firstMeetingAt", args.scheduledTo)
          : ranged;
      },
    );
  }
  if (args.dmCloserId) {
    return ctx.db.query("operationsQualificationRows").withIndex(
      "by_tenantId_and_dmCloserId_and_firstMeetingAt",
      (q) => {
        const base = q
          .eq("tenantId", args.tenantId)
          .eq("dmCloserId", args.dmCloserId);
        const ranged = base.gte("firstMeetingAt", from);
        return args.scheduledTo !== undefined
          ? ranged.lt("firstMeetingAt", args.scheduledTo)
          : ranged;
      },
    );
  }

  return ctx.db.query("operationsQualificationRows").withIndex(
    "by_tenantId_and_firstMeetingAt",
    (q) => {
      const base = q.eq("tenantId", args.tenantId);
      const ranged = base.gte("firstMeetingAt", from);
      return args.scheduledTo !== undefined
        ? ranged.lt("firstMeetingAt", args.scheduledTo)
        : ranged;
    },
  );
}
```

**Step 2: Add a paginated query with primary-filter guardrails.**

```typescript
// Path: convex/operations/scheduling.ts
export const listSchedulingQueue = query({
  args: {
    paginationOpts: paginationOptsValidator,
    scheduledFrom: v.optional(v.number()),
    scheduledTo: v.optional(v.number()),
    bookingProgramId: v.optional(v.id("tenantPrograms")),
    soldProgramId: v.optional(v.id("tenantPrograms")),
    slackUserId: v.optional(v.string()),
    assignedCloserId: v.optional(v.id("users")),
    attributionTeamId: v.optional(v.id("attributionTeams")),
    dmCloserId: v.optional(v.id("dmClosers")),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const result = await schedulingRowsQuery(ctx, {
      tenantId,
      bookingProgramId: args.bookingProgramId,
      soldProgramId: args.soldProgramId,
      slackUserId: args.slackUserId,
      assignedCloserId: args.assignedCloserId,
      attributionTeamId: args.attributionTeamId,
      dmCloserId: args.dmCloserId,
      scheduledFrom: args.scheduledFrom,
      scheduledTo: args.scheduledTo,
    })
      .order("desc")
      .paginate(args.paginationOpts);
    return result;
  },
});
```

**Key implementation notes:**
- Only one primary dimension plus date range is exact in MVP; disable unsupported multi-filter combinations instead of filtering after pagination.
- The query uses `gte("firstMeetingAt", 0)` when no start date is selected so unbooked qualification rows with missing `firstMeetingAt` do not enter Scheduling.
- `firstBookedAt` is not the date-range filter; it is a latency metric input.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/operations/scheduling.ts` | Create | Scheduling list query |

---

### 4B — Phone Sales Meeting Query

**Type:** Backend
**Parallelizable:** Yes — independent of Scheduling once Phase 2 meeting fields exist.

**What:** Add exact Phone Sales list support by widening meetings with an optional linked-opportunity status cache, then add a paginated query over `meetings` enriched with opportunity, lead, closer, attribution, and Slack qualifier data.

**Why:** Admins need to monitor phone closer execution and outcomes across all meetings, not only opportunity-level statuses.

**Where:**
- `convex/schema.ts` (modify)
- `convex/operations/phoneSales.ts` (new)

**How:**

**Step 1: Widen meetings for exact opportunity-status filtering.**

```typescript
// Path: convex/schema.ts
meetings: defineTable({
  // Existing fields remain unchanged.
  opportunityStatus: v.optional(opportunityStatusValidator),
})
  .index("by_tenantId_and_opportunityStatus_and_scheduledAt", [
    "tenantId",
    "opportunityStatus",
    "scheduledAt",
  ]),
```

**Step 2: Select the narrowest meeting index.**

```typescript
// Path: convex/operations/phoneSales.ts
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { query } from "../_generated/server";
import { opportunityStatusValidator } from "../opportunities/validators";
import { requireTenantUser } from "../requireTenantUser";

const meetingStatusValidator = v.union(
  v.literal("scheduled"),
  v.literal("in_progress"),
  v.literal("completed"),
  v.literal("canceled"),
  v.literal("no_show"),
  v.literal("meeting_overran"),
);

function phoneSalesMeetingsQuery(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    assignedCloserId?: Id<"users">;
    bookingProgramId?: Id<"tenantPrograms">;
    soldProgramId?: Id<"tenantPrograms">;
    meetingStatus?: Doc<"meetings">["status"];
    opportunityStatus?: Doc<"opportunities">["status"];
    attributionTeamId?: Id<"attributionTeams">;
    dmCloserId?: Id<"dmClosers">;
    scheduledFrom?: number;
    scheduledTo?: number;
  },
) {
  const primaryFilters = [
    args.assignedCloserId,
    args.bookingProgramId,
    args.soldProgramId,
    args.meetingStatus,
    args.opportunityStatus,
    args.attributionTeamId,
    args.dmCloserId,
  ].filter(Boolean).length;
  if (primaryFilters > 1) {
    throw new Error("Select only one primary phone-sales filter at a time.");
  }
  const from = args.scheduledFrom ?? 0;

  if (args.assignedCloserId) {
    return ctx.db.query("meetings").withIndex(
      "by_tenantId_and_assignedCloserId_and_scheduledAt",
      (q) => {
        const base = q.eq("tenantId", args.tenantId).eq("assignedCloserId", args.assignedCloserId);
        const ranged = base.gte("scheduledAt", from);
        return args.scheduledTo !== undefined
          ? ranged.lt("scheduledAt", args.scheduledTo)
          : ranged;
      },
    );
  }
  if (args.bookingProgramId) {
    return ctx.db.query("meetings").withIndex(
      "by_tenantId_and_bookingProgramId_and_scheduledAt",
      (q) => {
        const base = q.eq("tenantId", args.tenantId).eq("bookingProgramId", args.bookingProgramId);
        const ranged = base.gte("scheduledAt", from);
        return args.scheduledTo !== undefined ? ranged.lt("scheduledAt", args.scheduledTo) : ranged;
      },
    );
  }
  if (args.soldProgramId) {
    return ctx.db.query("meetings").withIndex(
      "by_tenantId_and_soldProgramId_and_scheduledAt",
      (q) => {
        const base = q.eq("tenantId", args.tenantId).eq("soldProgramId", args.soldProgramId);
        const ranged = base.gte("scheduledAt", from);
        return args.scheduledTo !== undefined ? ranged.lt("scheduledAt", args.scheduledTo) : ranged;
      },
    );
  }
  if (args.meetingStatus) {
    return ctx.db.query("meetings").withIndex(
      "by_tenantId_and_status_and_scheduledAt",
      (q) => {
        const base = q.eq("tenantId", args.tenantId).eq("status", args.meetingStatus);
        const ranged = base.gte("scheduledAt", from);
        return args.scheduledTo !== undefined ? ranged.lt("scheduledAt", args.scheduledTo) : ranged;
      },
    );
  }
  if (args.opportunityStatus) {
    return ctx.db.query("meetings").withIndex(
      "by_tenantId_and_opportunityStatus_and_scheduledAt",
      (q) => {
        const base = q
          .eq("tenantId", args.tenantId)
          .eq("opportunityStatus", args.opportunityStatus);
        const ranged = base.gte("scheduledAt", from);
        return args.scheduledTo !== undefined ? ranged.lt("scheduledAt", args.scheduledTo) : ranged;
      },
    );
  }
  if (args.attributionTeamId) {
    return ctx.db.query("meetings").withIndex(
      "by_tenantId_and_attributionTeamId_and_scheduledAt",
      (q) => {
        const base = q.eq("tenantId", args.tenantId).eq("attributionTeamId", args.attributionTeamId);
        const ranged = base.gte("scheduledAt", from);
        return args.scheduledTo !== undefined ? ranged.lt("scheduledAt", args.scheduledTo) : ranged;
      },
    );
  }
  if (args.dmCloserId) {
    return ctx.db.query("meetings").withIndex(
      "by_tenantId_and_dmCloserId_and_scheduledAt",
      (q) => {
        const base = q.eq("tenantId", args.tenantId).eq("dmCloserId", args.dmCloserId);
        const ranged = base.gte("scheduledAt", from);
        return args.scheduledTo !== undefined ? ranged.lt("scheduledAt", args.scheduledTo) : ranged;
      },
    );
  }
  return ctx.db
    .query("meetings")
    .withIndex("by_tenantId_and_scheduledAt", (q) => {
      const base = q.eq("tenantId", args.tenantId);
      const ranged = base.gte("scheduledAt", from);
      return args.scheduledTo !== undefined ? ranged.lt("scheduledAt", args.scheduledTo) : ranged;
    });
}
```

**Step 3: Enrich page rows only.**

```typescript
// Path: convex/operations/phoneSales.ts
async function enrichPhoneSalesRows(ctx: QueryCtx, meetings: Doc<"meetings">[]) {
  const opportunities = await Promise.all(
    meetings.map((meeting) => ctx.db.get(meeting.opportunityId)),
  );
  const leads = await Promise.all(
    opportunities.map((opportunity) =>
      opportunity ? ctx.db.get(opportunity.leadId) : Promise.resolve(null),
    ),
  );
  const closers = await Promise.all(
    meetings.map((meeting) => ctx.db.get(meeting.assignedCloserId)),
  );

  return meetings.map((meeting, index) => {
    const opportunity = opportunities[index];
    const lead = leads[index];
    const closer = closers[index];
    return {
      meetingId: meeting._id,
      opportunityId: meeting.opportunityId,
      leadId: lead?._id,
      leadName: lead?.fullName ?? lead?.email ?? meeting.leadName ?? "Unknown lead",
      scheduledAt: meeting.scheduledAt,
      meetingStatus: meeting.status,
      opportunityStatus: opportunity?.status ?? null,
      bookingProgramName: meeting.bookingProgramName ?? opportunity?.firstBookingProgramName ?? null,
      soldProgramName: meeting.soldProgramName ?? opportunity?.soldProgramName ?? null,
      assignedCloserName: closer?.fullName ?? closer?.email ?? "Unknown closer",
      attributionResolution: meeting.attributionResolution ?? "none",
      attributionTeamId: meeting.attributionTeamId,
      dmCloserId: meeting.dmCloserId,
      slackUserId: opportunity?.qualifiedBy?.slackUserId ?? null,
    };
  });
}
```

**Step 4: Add the public query.**

```typescript
// Path: convex/operations/phoneSales.ts
export const listPhoneSalesMeetings = query({
  args: {
    paginationOpts: paginationOptsValidator,
    closerId: v.optional(v.id("users")),
    bookingProgramId: v.optional(v.id("tenantPrograms")),
    soldProgramId: v.optional(v.id("tenantPrograms")),
    scheduledFrom: v.optional(v.number()),
    scheduledTo: v.optional(v.number()),
    meetingStatus: v.optional(meetingStatusValidator),
    opportunityStatus: v.optional(opportunityStatusValidator),
    attributionTeamId: v.optional(v.id("attributionTeams")),
    dmCloserId: v.optional(v.id("dmClosers")),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const result = await phoneSalesMeetingsQuery(ctx, {
      tenantId,
      assignedCloserId: args.closerId,
      bookingProgramId: args.bookingProgramId,
      soldProgramId: args.soldProgramId,
      meetingStatus: args.meetingStatus,
      opportunityStatus: args.opportunityStatus,
      attributionTeamId: args.attributionTeamId,
      dmCloserId: args.dmCloserId,
      scheduledFrom: args.scheduledFrom,
      scheduledTo: args.scheduledTo,
    })
      .order("desc")
      .paginate(args.paginationOpts);

    return {
      ...result,
      page: await enrichPhoneSalesRows(ctx, result.page),
    };
  },
});
```

**Key implementation notes:**
- Enrich only `result.page`; do not enrich all matching meetings.
- Do not accept a tenant ID arg from the client.
- Patch `meeting.opportunityStatus` when the linked opportunity status changes, and backfill it for historical meetings before enabling the filter.
- Only one primary dimension plus date range is exact in MVP; disable unsupported multi-filter combinations rather than filtering after pagination.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add optional meeting opportunity-status cache |
| `convex/operations/phoneSales.ts` | Create | Meeting list query and enrichment |

---

### 4C — Phone Sales Stats Rollup

**Type:** Backend
**Parallelizable:** Yes — can build after the supported filter dimensions are selected.

**What:** Add a small daily rollup for meetings scheduled, completed, no-shows, won, and show rate over the full filtered period.

**Why:** Stats derived from `paginate()` rows are wrong because they only count the current page.

**Where:**
- `convex/schema.ts` (modify)
- `convex/operations/meetingStats.ts` (new)
- `convex/reporting/writeHooks.ts` (modify)
- `convex/operations/phoneSales.ts` (modify)

**How:**

**Step 1: Add a daily stats table.**

```typescript
// Path: convex/schema.ts
operationsMeetingDailyStats: defineTable({
  tenantId: v.id("tenants"),
  dayKey: v.string(),
  assignedCloserId: v.id("users"),
  bookingProgramId: v.optional(v.id("tenantPrograms")),
  soldProgramId: v.optional(v.id("tenantPrograms")),
  attributionTeamId: v.optional(v.id("attributionTeams")),
  dmCloserId: v.optional(v.id("dmClosers")),
  opportunityStatus: v.optional(opportunityStatusValidator),
  meetingStatus: v.union(
    v.literal("scheduled"),
    v.literal("in_progress"),
    v.literal("completed"),
    v.literal("canceled"),
    v.literal("no_show"),
    v.literal("meeting_overran"),
  ),
  count: v.number(),
  updatedAt: v.number(),
})
  .index("by_tenantId_and_dayKey", ["tenantId", "dayKey"])
  .index("by_tenantId_and_assignedCloserId_and_dayKey", [
    "tenantId",
    "assignedCloserId",
    "dayKey",
  ]),
```

**Step 2: Maintain the rollup from meeting write hooks.**

```typescript
// Path: convex/operations/meetingStats.ts
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

function dayKey(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function sameStatsBucket(a: Doc<"meetings">, b: Doc<"meetings">) {
  return (
    a.tenantId === b.tenantId &&
    a.assignedCloserId === b.assignedCloserId &&
    a.bookingProgramId === b.bookingProgramId &&
    a.soldProgramId === b.soldProgramId &&
    a.attributionTeamId === b.attributionTeamId &&
    a.dmCloserId === b.dmCloserId &&
    a.opportunityStatus === b.opportunityStatus &&
    a.status === b.status &&
    dayKey(a.scheduledAt) === dayKey(b.scheduledAt)
  );
}

async function incrementMeetingStatsBucket(
  ctx: MutationCtx,
  meeting: Doc<"meetings">,
  delta: 1 | -1,
) {
  const key = dayKey(meeting.scheduledAt);
  const candidates = await ctx.db
    .query("operationsMeetingDailyStats")
    .withIndex("by_tenantId_and_assignedCloserId_and_dayKey", (q) =>
      q
        .eq("tenantId", meeting.tenantId)
        .eq("assignedCloserId", meeting.assignedCloserId)
        .eq("dayKey", key),
    )
    .take(100);

  const existing = candidates.find(
    (row) =>
      row.bookingProgramId === meeting.bookingProgramId &&
      row.soldProgramId === meeting.soldProgramId &&
      row.attributionTeamId === meeting.attributionTeamId &&
      row.dmCloserId === meeting.dmCloserId &&
      row.opportunityStatus === meeting.opportunityStatus &&
      row.meetingStatus === meeting.status,
  );

  if (existing) {
    const count = existing.count + delta;
    if (count <= 0) {
      await ctx.db.delete(existing._id);
    } else {
      await ctx.db.patch(existing._id, { count, updatedAt: Date.now() });
    }
    return;
  }

  if (delta > 0) {
    await ctx.db.insert("operationsMeetingDailyStats", {
      tenantId: meeting.tenantId,
      dayKey: key,
      assignedCloserId: meeting.assignedCloserId,
      bookingProgramId: meeting.bookingProgramId,
      soldProgramId: meeting.soldProgramId,
      attributionTeamId: meeting.attributionTeamId,
      dmCloserId: meeting.dmCloserId,
      opportunityStatus: meeting.opportunityStatus,
      meetingStatus: meeting.status,
      count: 1,
      updatedAt: Date.now(),
    });
  }
}

export async function insertOperationsMeetingStats(
  ctx: MutationCtx,
  meeting: Doc<"meetings">,
) {
  await incrementMeetingStatsBucket(ctx, meeting, 1);
}

export async function replaceOperationsMeetingStats(
  ctx: MutationCtx,
  oldMeeting: Doc<"meetings">,
  nextMeeting: Doc<"meetings">,
) {
  if (sameStatsBucket(oldMeeting, nextMeeting)) return;
  await incrementMeetingStatsBucket(ctx, oldMeeting, -1);
  await incrementMeetingStatsBucket(ctx, nextMeeting, 1);
}
```

**Step 3: Update write hooks.**

```typescript
// Path: convex/reporting/writeHooks.ts
import {
  insertOperationsMeetingStats,
  replaceOperationsMeetingStats,
} from "../operations/meetingStats";

export async function insertMeetingAggregate(
  ctx: MutationCtx,
  meetingId: Id<"meetings">,
): Promise<Doc<"meetings">> {
  const meeting = await getMeetingOrThrow(ctx, meetingId);
  await Promise.all([
    meetingsByStatus.insert(ctx, meeting),
    insertOperationsMeetingStats(ctx, meeting),
  ]);
  return meeting;
}

export async function replaceMeetingAggregate(
  ctx: MutationCtx,
  oldMeeting: Doc<"meetings">,
  meetingId: Id<"meetings">,
): Promise<Doc<"meetings">> {
  const meeting = await getMeetingOrThrow(ctx, meetingId);
  await Promise.all([
    meetingsByStatus.replace(ctx, oldMeeting, meeting),
    replaceOperationsMeetingStats(ctx, oldMeeting, meeting),
  ]);
  return meeting;
}
```

**Step 4: Count status buckets across the full filtered period.**

```typescript
// Path: convex/operations/phoneSales.ts
const PHONE_SALES_STATUSES = ["scheduled", "in_progress", "completed", "no_show", "meeting_overran"] as const;

export const getPhoneSalesStats = query({
  args: {
    closerId: v.optional(v.id("users")),
    scheduledFrom: v.number(),
    scheduledTo: v.number(),
    bookingProgramId: v.optional(v.id("tenantPrograms")),
    attributionTeamId: v.optional(v.id("attributionTeams")),
    dmCloserId: v.optional(v.id("dmClosers")),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const startKey = new Date(args.scheduledFrom).toISOString().slice(0, 10);
    const endExclusive = new Date(args.scheduledTo);
    endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
    const endExclusiveKey = endExclusive.toISOString().slice(0, 10);
    const rows = args.closerId
      ? await ctx.db
          .query("operationsMeetingDailyStats")
          .withIndex("by_tenantId_and_assignedCloserId_and_dayKey", (q) =>
            q
              .eq("tenantId", tenantId)
              .eq("assignedCloserId", args.closerId!)
              .gte("dayKey", startKey)
              .lt("dayKey", endExclusiveKey),
          )
          .take(1000)
      : await ctx.db
          .query("operationsMeetingDailyStats")
          .withIndex("by_tenantId_and_dayKey", (q) =>
            q.eq("tenantId", tenantId).gte("dayKey", startKey).lt("dayKey", endExclusiveKey),
          )
          .take(1000);

    const filtered = rows.filter((row) => {
      if (args.bookingProgramId && row.bookingProgramId !== args.bookingProgramId) return false;
      if (args.attributionTeamId && row.attributionTeamId !== args.attributionTeamId) return false;
      if (args.dmCloserId && row.dmCloserId !== args.dmCloserId) return false;
      return true;
    });

    const byStatus = new Map<string, number>();
    for (const row of filtered) {
      byStatus.set(row.meetingStatus, (byStatus.get(row.meetingStatus) ?? 0) + row.count);
    }

    const completed = byStatus.get("completed") ?? 0;
    const noShows = byStatus.get("no_show") ?? 0;
    const won = filtered
      .filter((row) => row.opportunityStatus === "payment_received")
      .reduce((sum, row) => sum + row.count, 0);
    return {
      scheduled: PHONE_SALES_STATUSES.reduce(
        (sum, status) => sum + (byStatus.get(status) ?? 0),
        0,
      ),
      completed,
      noShows,
      won,
      showRate: completed + noShows > 0 ? completed / (completed + noShows) : null,
    };
  },
});
```

**Key implementation notes:**
- The daily rollup supports "all booked programs" by summing rollup rows; missing filters are not treated as empty-string keys.
- Cap UI date ranges to a reasonable window, such as 90 days, unless the rollup query is further indexed by month.
- Won counts use the meeting `opportunityStatus` cache when it is `payment_received`; do not infer won from the booked program.
- Any mutation that patches a linked opportunity into or out of `payment_received` must refresh affected meetings and replace their stats buckets.
- Backfill this rollup from existing meetings with a resumable migration before relying on stats in production.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add daily stats table |
| `convex/operations/meetingStats.ts` | Create | Maintain daily buckets |
| `convex/reporting/writeHooks.ts` | Modify | Insert/replace rollups |
| `convex/operations/phoneSales.ts` | Modify | Stats query |

---

### 4D — Scheduling Tab UI

**Type:** Frontend
**Parallelizable:** Yes — depends on 4A query.

**What:** Replace the Scheduling placeholder with filters, paginated rows, and links to meeting/opportunity detail.

**Why:** Ops needs to see whether Slack-qualified leads booked and when they are scheduled.

**Where:**
- `app/workspace/operations/_components/operations-page-client.tsx` (modify)
- `app/workspace/operations/_components/scheduling-tab.tsx` (new)
- `app/workspace/operations/_components/scheduling-table.tsx` (new)
- `app/workspace/operations/_components/operations-filter-bar.tsx` (new)

**How:**

**Step 1: Render the Scheduling tab.**

```tsx
// Path: app/workspace/operations/_components/operations-page-client.tsx
import { SchedulingTab } from "./scheduling-tab";

<TabsContent value="scheduling" className="mt-6">
  <SchedulingTab />
</TabsContent>
```

**Step 2: Use the scheduling query.**

```tsx
// Path: app/workspace/operations/_components/scheduling-tab.tsx
"use client";

import { useMemo, useState } from "react";
import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { SchedulingTable } from "./scheduling-table";

export function SchedulingTab() {
  const [bookingProgramId, setBookingProgramId] = useState<Id<"tenantPrograms"> | "all">("all");
  const [range, setRange] = useState<{ from?: number; to?: number }>({});

  const queryArgs = useMemo(
    () => ({
      bookingProgramId: bookingProgramId === "all" ? undefined : bookingProgramId,
      scheduledFrom: range.from,
      scheduledTo: range.to,
    }),
    [bookingProgramId, range.from, range.to],
  );

  const { results, status, loadMore } = usePaginatedQuery(
    api.operations.scheduling.listSchedulingQueue,
    queryArgs,
    { initialNumItems: 25 },
  );

  return (
    <div className="flex flex-col gap-4">
      <OperationsFilterBar
        bookingProgramId={bookingProgramId}
        onBookingProgramChange={setBookingProgramId}
        range={range}
        onRangeChange={setRange}
      />
      <SchedulingTable rows={results} isLoading={status === "LoadingFirstPage"} />
      {status === "CanLoadMore" ? (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => loadMore(25)}>
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
```

**Key implementation notes:**
- Display both `firstBookedAt` and `firstMeetingAt`.
- Link `firstMeetingId` to `/workspace/pipeline/meetings/[meetingId]` for admins.
- Reuse filter components with Phone Sales where possible, but avoid over-generalizing unsupported filters.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/operations/_components/operations-page-client.tsx` | Modify | Render Scheduling |
| `app/workspace/operations/_components/scheduling-tab.tsx` | Create | Query container |
| `app/workspace/operations/_components/scheduling-table.tsx` | Create | Scheduling rows |
| `app/workspace/operations/_components/operations-filter-bar.tsx` | Create | Shared filters |

---

### 4E — Phone Sales Tab UI

**Type:** Frontend
**Parallelizable:** Yes — depends on 4B and 4C.

**What:** Replace the Phone Sales placeholder with stats, filters, paginated meeting table, and admin meeting detail links.

**Why:** Mauro/ops needs to monitor phone closer meeting volume, outcomes, no-shows, won states, and attribution.

**Where:**
- `app/workspace/operations/_components/operations-page-client.tsx` (modify)
- `app/workspace/operations/_components/phone-sales-tab.tsx` (new)
- `app/workspace/operations/_components/phone-sales-stat-cards.tsx` (new)
- `app/workspace/operations/_components/phone-sales-table.tsx` (new)

**How:**

**Step 1: Render the tab.**

```tsx
// Path: app/workspace/operations/_components/operations-page-client.tsx
import { PhoneSalesTab } from "./phone-sales-tab";

<TabsContent value="phone-sales" className="mt-6">
  <PhoneSalesTab />
</TabsContent>
```

**Step 2: Query rows and stats separately.**

```tsx
// Path: app/workspace/operations/_components/phone-sales-tab.tsx
"use client";

import { useMemo, useState } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PhoneSalesStatCards } from "./phone-sales-stat-cards";
import { PhoneSalesTable } from "./phone-sales-table";

export function PhoneSalesTab() {
  const [closerId, setCloserId] = useState<Id<"users"> | undefined>();
  const [range, setRange] = useState(requiredCurrentWeekRange());

  const queryArgs = useMemo(
    () => ({
      closerId,
      scheduledFrom: range.from,
      scheduledTo: range.to,
    }),
    [closerId, range.from, range.to],
  );

  const stats = useQuery(
    api.operations.phoneSales.getPhoneSalesStats,
    { closerId, scheduledFrom: range.from, scheduledTo: range.to },
  );
  const meetings = usePaginatedQuery(
    api.operations.phoneSales.listPhoneSalesMeetings,
    queryArgs,
    { initialNumItems: 25 },
  );

  return (
    <div className="flex flex-col gap-4">
      <PhoneSalesFilters
        closerId={closerId}
        onCloserChange={setCloserId}
        range={range}
        onRangeChange={setRange}
      />
      <PhoneSalesStatCards stats={stats} />
      <PhoneSalesTable
        rows={meetings.results}
        isLoading={meetings.status === "LoadingFirstPage"}
      />
    </div>
  );
}
```

**Step 3: Link rows to existing admin meeting detail.**

```tsx
// Path: app/workspace/operations/_components/phone-sales-table.tsx
import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function PhoneSalesTable({ rows, isLoading }: PhoneSalesTableProps) {
  if (isLoading) return <PhoneSalesTableSkeleton />;

  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Lead</TableHead>
            <TableHead>Scheduled</TableHead>
            <TableHead>Closer</TableHead>
            <TableHead>Meeting</TableHead>
            <TableHead>Opportunity</TableHead>
            <TableHead>Booked Program</TableHead>
            <TableHead>Sold Program</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.meetingId}>
              <TableCell>{row.leadName}</TableCell>
              <TableCell>{new Date(row.scheduledAt).toLocaleString()}</TableCell>
              <TableCell>{row.assignedCloserName}</TableCell>
              <TableCell>{row.meetingStatus}</TableCell>
              <TableCell>{row.opportunityStatus ?? "-"}</TableCell>
              <TableCell>{row.bookingProgramName ?? "Unmapped"}</TableCell>
              <TableCell>{row.soldProgramName ?? "-"}</TableCell>
              <TableCell className="text-right">
                <Link href={`/workspace/pipeline/meetings/${row.meetingId}`} className="text-sm text-primary hover:underline">
                  Open
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

**Key implementation notes:**
- Support all-closers stats through `by_tenantId_and_dayKey`; use the closer-prefixed index only when a closer is selected.
- Keep stat cards separate from list query to avoid page-count bugs.
- Use explicit disabled messaging for filters not backed by the aggregate.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/operations/_components/operations-page-client.tsx` | Modify | Render Phone Sales |
| `app/workspace/operations/_components/phone-sales-tab.tsx` | Create | Query container |
| `app/workspace/operations/_components/phone-sales-stat-cards.tsx` | Create | Full-period stats |
| `app/workspace/operations/_components/phone-sales-table.tsx` | Create | Meeting table |

---

### 4F — Health States and Verification

**Type:** Full-Stack / Manual
**Parallelizable:** No — depends on all list and stats queries.

**What:** Surface unmapped booked programs, unmapped UTMs, and unassigned bookings; verify TypeScript and query behavior.

**Why:** Missing mapping data is operational work. Hiding it makes the new filters look broken.

**Where:**
- `convex/operations/unmappedUtms.ts` (reuse / modify)
- `convex/operations/bookingHealth.ts` (new)
- `convex/operations/phoneSales.ts` (modify)
- `convex/migrations.ts` (modify)
- `app/workspace/operations/_components/operations-health-banner.tsx` (new)
- `app/workspace/operations/_components/operations-page-client.tsx` (modify)

**How:**

**Step 1: Reuse the bounded unmapped UTM query from Phase 2.**

```typescript
// Path: convex/operations/unmappedUtms.ts
// Phase 2 creates listRecentUnmappedUtms for Settings -> Attribution.
// Phase 4 imports the same query in the Operations health banner.
```

**Step 2: Add a raw-webhook health query for unassigned or failed bookings.**

```typescript
// Path: convex/operations/bookingHealth.ts
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const listRecentBookingHealthIssues = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const failedInviteeCreated = await ctx.db
      .query("rawWebhookEvents")
      .withIndex("by_tenantId_and_receivedAt", (q) =>
        q.eq("tenantId", tenantId).gte("receivedAt", since),
      )
      .order("desc")
      .take(100);

    return failedInviteeCreated
      .filter((event) => event.eventType === "invitee.created" && !event.processed)
      .slice(0, 25)
      .map((event) => ({
        rawEventId: event._id,
        receivedAt: event.receivedAt,
        calendlyEventUri: event.calendlyEventUri,
        issue: "unprocessed_invitee_created" as const,
      }));
  },
});
```

**Step 3: Render health banner above tabs.**

```tsx
// Path: app/workspace/operations/_components/operations-health-banner.tsx
"use client";

import { useQuery } from "convex/react";
import { AlertTriangleIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function OperationsHealthBanner() {
  const unmapped = useQuery(api.operations.unmappedUtms.listRecentUnmappedUtms, {});
  const bookingIssues = useQuery(api.operations.bookingHealth.listRecentBookingHealthIssues, {});
  if ((!unmapped || unmapped.length === 0) && (!bookingIssues || bookingIssues.length === 0)) {
    return null;
  }

  return (
    <Alert>
      <AlertTriangleIcon />
      <AlertTitle>Attribution needs mapping</AlertTitle>
      <AlertDescription>
        {(unmapped?.length ?? 0)} recent booking UTM values are unmapped and{" "}
        {(bookingIssues?.length ?? 0)} recent booking webhooks need review.
      </AlertDescription>
    </Alert>
  );
}
```

**Step 4: Backfill caches and verify locally.**

```bash
# Path: /Users/nimbus/dev/ptdom-crm
npx convex run migrations:run '{"fn":"backfillMeetingOpportunityStatusAndOperationsStats","dryRun":true}'
npx convex dev --once
pnpm tsc --noEmit
pnpm dev
```

**Key implementation notes:**
- The unmapped query is bounded to recent rows; do not scan all meeting history.
- Unassigned bookings that fail before meeting insert must come from `rawWebhookEvents`; inserted meetings with invalid assignment should come from the meeting list/query layer.
- Confirm Phone Sales stats and page row counts intentionally differ when more rows exist than a page.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/operations/unmappedUtms.ts` | Reuse / Modify | Recent unmapped UTM health query from Phase 2 |
| `convex/operations/bookingHealth.ts` | Create | Recent failed/unprocessed booking health query |
| `convex/operations/phoneSales.ts` | Modify | Health/status support |
| `convex/migrations.ts` | Modify | Backfill meeting opportunity-status cache and stats |
| `app/workspace/operations/_components/operations-health-banner.tsx` | Create | Health banner |
| `app/workspace/operations/_components/operations-page-client.tsx` | Modify | Render banner |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/operations/scheduling.ts` | Create | 4A |
| `convex/operations/phoneSales.ts` | Create / Modify | 4B, 4C, 4F |
| `convex/schema.ts` | Modify | 4B, 4C |
| `convex/operations/meetingStats.ts` | Create | 4C |
| `convex/reporting/writeHooks.ts` | Modify | 4C |
| `app/workspace/operations/_components/operations-page-client.tsx` | Modify | 4D, 4E, 4F |
| `app/workspace/operations/_components/scheduling-tab.tsx` | Create | 4D |
| `app/workspace/operations/_components/scheduling-table.tsx` | Create | 4D |
| `app/workspace/operations/_components/operations-filter-bar.tsx` | Create | 4D |
| `app/workspace/operations/_components/phone-sales-tab.tsx` | Create | 4E |
| `app/workspace/operations/_components/phone-sales-stat-cards.tsx` | Create | 4E |
| `app/workspace/operations/_components/phone-sales-table.tsx` | Create | 4E |
| `convex/operations/unmappedUtms.ts` | Reuse / Modify | 4F |
| `convex/operations/bookingHealth.ts` | Create | 4F |
| `convex/migrations.ts` | Modify | 4F |
| `app/workspace/operations/_components/operations-health-banner.tsx` | Create | 4F |
