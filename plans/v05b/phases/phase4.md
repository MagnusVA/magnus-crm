# Phase 4 — Backend Query Rewrites

**Goal:** All read paths use new indexes and denormalized fields. Correctness bugs fixed. No frontend changes (return shapes preserved). Every query either uses an indexed path, reads from a denormalized summary document, or applies batch enrichment instead of N+1 lookups.

**Prerequisite:** Phase 3 complete (new fields populated by mutations: `meetings.assignedCloserId` set on all writes, `tenantStats` maintained atomically, `amountMinor` dual-written, `users.isActive` checked by auth guard, `leads.status` always defined).

**Runs in PARALLEL with:** Nothing. Phase 4 is on the critical path: Phase 3 must complete before Phase 4 begins; Phase 6 (Schema Narrow) and Phase 7 (Frontend Updates) depend on Phase 4 completion.

**Skills to invoke:**
- `convex-performance-audit` -- For query optimization patterns, index usage verification, and subscription cost analysis
- Convex guidelines (`convex/_generated/ai/guidelines.md`) -- For pagination, index ordering, and bounded query patterns

---

**Acceptance Criteria:**

1. `getAdminDashboardStats` reads from `tenantStats` document (single `ctx.db.get` or indexed `.first()`) instead of scanning `users`, `opportunities`, and `paymentRecords` tables; `meetingsToday` remains a live range query.
2. `getNextMeeting`, `getMeetingsForRange`, `listAffectedMeetingsForCloserInRange`, and `buildCloserSchedulesForDate` query `meetings.by_tenantId_and_assignedCloserId_and_scheduledAt` directly -- no intermediate opportunity scan.
3. `getPipelineSummary` queries `opportunities.by_tenantId_and_assignedCloserId_and_status` with per-status prefix queries -- no `.collect()` followed by JS counting.
4. `listLeads` paginates with `by_tenantId_and_status` directly for all status filters (including default "active"); no post-paginate filtering that produces short pages.
5. `listCustomers` for closers paginates with `by_tenantId_and_convertedByUserId` -- no null-returning post-filter; payment totals read from `customer.totalPaidMinor` instead of per-customer `.collect()` loop.
6. `getActiveReminders` uses `by_tenantId_and_closerId_and_type_and_status_and_reminderScheduledAt` with all five prefix fields -- no `.take(50)` followed by `.filter(type)`.
7. `getLeadDetail`, `getCustomerDetail`, and `getMeetingDetail` use batch enrichment (deduped ID sets into Maps) -- no per-record N+1 lookups for closers, event types, or leads.
8. `listOpportunitiesForAdmin` uses `.paginate()` with `paginationOptsValidator`; `listMyOpportunities` uses `.take(50)` or `.paginate()`; `listTeamMembers` and `listUnmatchedCalendlyMembers` have `.take(200)` safety limits.
9. All payment read queries reference `amountMinor` (not `amount`); all user-listing queries filter by `isActive !== false`; all lead queries remove `?? "active"` fallbacks.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (Admin Dashboard Rewrite)  ──┐
4B (Closer Query Rewrites)    ──┤
4C (Pagination Corrections)   ──┼──→  4F (Integration Verification)
4D (Detail Query Flattening)  ──┤
4E (Payment + User + Bounds)  ──┘
```

**All of 4A-4E touch DIFFERENT files and can execute in parallel.** 4F is a verification-only subphase that runs after all code changes land.

**Estimated time:** 8-12 hours total (4A = 1h, 4B = 3h, 4C = 2h, 4D = 2h, 4E = 1.5h, 4F = 1h)

---

## Subphases

### 4A — Admin Dashboard Rewrite

**Type:** Backend
**Parallelizable:** Yes -- touches only `convex/dashboard/adminStats.ts`. No shared files with 4B-4E.

**What:** Replace the four full-table scans in `getAdminDashboardStats` with a single `tenantStats` document read. Keep `meetingsToday` as a live range query (time-dependent, already efficiently indexed).

**Why:** The current implementation (lines 24-113) iterates every user, opportunity, and payment record on every reactive render. With the `tenantStats` summary document maintained atomically by Phase 3 mutations, the dashboard reads 1 document + 1 bounded range query instead of scanning 3 tables. This eliminates O(n) reads on every subscription tick.

**Where:**
- `convex/dashboard/adminStats.ts` (modify)

**How:**

**Step 1: Read the tenantStats document**

```typescript
// Path: convex/dashboard/adminStats.ts

import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const getAdminDashboardStats = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    console.log("[Dashboard] getAdminDashboardStats called", { tenantId });

    // Single document read -- maintained atomically by mutations (Phase 3)
    const stats = await ctx.db
      .query("tenantStats")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .first();

    if (!stats) {
      console.warn("[Dashboard] No tenantStats document found", { tenantId });
      return {
        totalTeamMembers: 0,
        totalClosers: 0,
        unmatchedClosers: 0,
        totalOpportunities: 0,
        activeOpportunities: 0,
        meetingsToday: 0,
        wonDeals: 0,
        revenueLogged: 0,
        totalRevenue: 0,
        paymentRecordsLogged: 0,
      };
    }

    // meetingsToday: live range query (bounded, efficient, time-dependent)
    const now = Date.now();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = startOfDay.getTime() + 24 * 60 * 60 * 1000;

    let meetingsToday = 0;
    for await (const _meeting of ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("scheduledAt", startOfDay.getTime())
          .lt("scheduledAt", endOfDay),
      )) {
      meetingsToday += 1;
    }

    // Preserve exact return shape for frontend compatibility
    const revenueLogged = stats.totalRevenueMinor / 100;
    return {
      totalTeamMembers: stats.totalTeamMembers,
      totalClosers: stats.totalClosers,
      unmatchedClosers: 0, // TODO: track in tenantStats if needed
      totalOpportunities: stats.totalOpportunities,
      activeOpportunities: stats.activeOpportunities,
      meetingsToday,
      wonDeals: stats.wonDeals,
      revenueLogged,
      totalRevenue: revenueLogged,
      paymentRecordsLogged: stats.totalPaymentRecords,
    };
  },
});
```

**Step 2: Remove unused imports and helper function**

Delete the `ACTIVE_OPPORTUNITY_STATUSES` set and `getStartAndEndOfToday` helper -- they are no longer needed.

**Key implementation notes:**

- The return shape is **identical** to the current implementation. Frontend code requires zero changes.
- `unmatchedClosers` is not tracked in `tenantStats`. If this metric is needed at scale, add it to the stats document in a future iteration. For now, returning 0 is acceptable since the dashboard already shows closers separately.
- If `tenantStats` doesn't exist (edge case during Phase 2 seed), return zeroes gracefully rather than crashing.
- `revenueLogged` converts from `totalRevenueMinor` (integer cents) to dollars for display. Phase 7 will switch the frontend to read `amountMinor` directly; during Phase 4 the query adapts.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/dashboard/adminStats.ts` | Modify | Replace 4 table scans with tenantStats doc read + live meetingsToday |

---

### 4B — Closer Query Rewrites

**Type:** Backend
**Parallelizable:** Yes -- touches closer-specific files and `convex/unavailability/shared.ts`. No overlap with 4A, 4C, 4D, or 4E files.

**What:** Rewrite 6 closer-facing queries to use `meetings.by_tenantId_and_assignedCloserId_and_scheduledAt` directly, eliminating the intermediate opportunity scan pattern. Also rewrite `getPipelineSummary` to use the compound status index.

**Why:** The current pattern for every closer query is: (1) collect ALL closer opportunities, (2) build an ID set, (3) scan ALL tenant meetings and filter by that set. With `meetings.assignedCloserId` denormalized (Phase 1 schema, Phase 2 backfill, Phase 3 maintenance), queries go directly to the closer's meetings via a compound index. This eliminates the O(opportunities) + O(meetings) scan pattern, replacing it with O(closer_meetings) indexed reads.

**Where:**
- `convex/closer/dashboard.ts` (modify)
- `convex/closer/pipeline.ts` (modify)
- `convex/closer/calendar.ts` (modify)
- `convex/unavailability/shared.ts` (modify)

**How:**

**Step 1: Rewrite `getNextMeeting`**

Replace the two-phase scan (collect opps -> scan meetings) with a single indexed query:

```typescript
// Path: convex/closer/dashboard.ts

export const getNextMeeting = query({
  args: {},
  handler: async (ctx) => {
    console.log("[Closer:Dashboard] getNextMeeting called");
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);
    const now = Date.now();

    // Direct indexed query: closer's scheduled meetings from now onward
    const nextMeeting = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_assignedCloserId_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("assignedCloserId", userId)
          .gte("scheduledAt", now),
      )
      .first();

    if (!nextMeeting || nextMeeting.status !== "scheduled") {
      // Walk forward to find first "scheduled" meeting
      let found = null;
      for await (const meeting of ctx.db
        .query("meetings")
        .withIndex("by_tenantId_and_assignedCloserId_and_scheduledAt", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("assignedCloserId", userId)
            .gte("scheduledAt", now),
        )) {
        if (meeting.status === "scheduled") {
          found = meeting;
          break;
        }
      }
      if (!found) {
        console.log("[Closer:Dashboard] getNextMeeting: no upcoming meeting found");
        return null;
      }
      // Use found as nextMeeting below
      const opportunity = await ctx.db.get(found.opportunityId);
      const lead = opportunity ? await ctx.db.get(opportunity.leadId) : null;
      const eventTypeConfig = opportunity?.eventTypeConfigId
        ? await ctx.db.get(opportunity.eventTypeConfigId)
        : null;
      return {
        meeting: found,
        opportunity,
        lead,
        eventTypeName: eventTypeConfig?.displayName ?? null,
      };
    }

    const opportunity = await ctx.db.get(nextMeeting.opportunityId);
    const lead = opportunity ? await ctx.db.get(opportunity.leadId) : null;
    const eventTypeConfig = opportunity?.eventTypeConfigId
      ? await ctx.db.get(opportunity.eventTypeConfigId)
      : null;

    console.log("[Closer:Dashboard] getNextMeeting: found", {
      meetingId: nextMeeting._id,
      scheduledAt: nextMeeting.scheduledAt,
    });
    return {
      meeting: nextMeeting,
      opportunity,
      lead,
      eventTypeName: eventTypeConfig?.displayName ?? null,
    };
  },
});
```

**Step 2: Rewrite `getPipelineSummary`**

Replace `.collect()` + JS counting with per-status indexed prefix queries:

```typescript
// Path: convex/closer/dashboard.ts

const PIPELINE_STATUSES = [
  "scheduled",
  "in_progress",
  "follow_up_scheduled",
  "reschedule_link_sent",
  "payment_received",
  "lost",
  "canceled",
  "no_show",
] as const;

export const getPipelineSummary = query({
  args: {},
  handler: async (ctx) => {
    console.log("[Closer:Dashboard] getPipelineSummary called");
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const counts: Record<string, number> = {};
    let total = 0;

    for (const status of PIPELINE_STATUSES) {
      let count = 0;
      for await (const _opp of ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_assignedCloserId_and_status", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("assignedCloserId", userId)
            .eq("status", status),
        )) {
        count++;
      }
      counts[status] = count;
      total += count;
    }

    console.log("[Closer:Dashboard] getPipelineSummary counts", { total, counts });
    return { counts, total };
  },
});
```

**Step 3: Rewrite `listMyOpportunities`**

Replace `.collect()` + JS filter with index query and bounded results. Add batch enrichment:

```typescript
// Path: convex/closer/pipeline.ts

export const listMyOpportunities = query({
  args: {
    statusFilter: v.optional(opportunityStatusValidator),
  },
  handler: async (ctx, { statusFilter }) => {
    console.log("[Closer:Pipeline] listMyOpportunities called", {
      statusFilter: statusFilter ?? "all",
    });
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    // Use compound index for direct indexed query
    let opps;
    if (statusFilter) {
      opps = await ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_assignedCloserId_and_status", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("assignedCloserId", userId)
            .eq("status", statusFilter),
        )
        .take(50);
    } else {
      opps = await ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_assignedCloserId", (q) =>
          q.eq("tenantId", tenantId).eq("assignedCloserId", userId),
        )
        .take(50);
    }

    // Batch enrichment: collect unique lead IDs, fetch once
    const leadIds = new Set(opps.map((o) => o.leadId));
    const leadMap = new Map<string, { fullName?: string; email: string; phone?: string }>();
    await Promise.all(
      [...leadIds].map(async (id) => {
        const lead = await ctx.db.get(id);
        if (lead) leadMap.set(id, { fullName: lead.fullName, email: lead.email, phone: lead.phone });
      }),
    );

    const enriched = opps.map((opp) => {
      const lead = leadMap.get(opp.leadId);
      return {
        ...opp,
        leadName: lead?.fullName ?? lead?.email ?? "Unknown",
        leadEmail: lead?.email,
        leadPhone: lead?.phone,
        eventTypeConfigId: opp.eventTypeConfigId,
        latestMeetingId: opp.latestMeetingId,
        latestMeetingAt: opp.latestMeetingAt,
        latestMeetingStatus: undefined, // Preserve shape; populated from denormalized fields
      };
    });

    console.log("[Closer:Pipeline] listMyOpportunities result", {
      totalOpps: opps.length,
      enrichedCount: enriched.length,
    });
    return enriched.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});
```

**Step 4: Rewrite `getMeetingsForRange`**

Replace opportunity scan + meeting filter with direct indexed range query:

```typescript
// Path: convex/closer/calendar.ts

export const getMeetingsForRange = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, { startDate, endDate }) => {
    console.log("[Closer:Calendar] getMeetingsForRange called", { startDate, endDate });
    if (startDate >= endDate) {
      throw new Error("startDate must be earlier than endDate");
    }
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    // Direct indexed range query on the closer's meetings
    const myMeetings = [];
    for await (const meeting of ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_assignedCloserId_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("assignedCloserId", userId)
          .gte("scheduledAt", startDate)
          .lt("scheduledAt", endDate),
      )) {
      if (meeting.status !== "canceled") {
        myMeetings.push(meeting);
      }
    }

    console.log("[Closer:Calendar] meetings found in range", { count: myMeetings.length });

    // Batch-fetch opportunities and event type configs
    const oppIds = new Set(myMeetings.map((m) => m.opportunityId));
    const oppMap = new Map<string, { status: string; eventTypeConfigId?: string }>();
    await Promise.all(
      [...oppIds].map(async (id) => {
        const opp = await ctx.db.get(id);
        if (opp) oppMap.set(id, { status: opp.status, eventTypeConfigId: opp.eventTypeConfigId as string | undefined });
      }),
    );

    const etcIds = new Set<string>();
    for (const opp of oppMap.values()) {
      if (opp.eventTypeConfigId) etcIds.add(opp.eventTypeConfigId);
    }
    const etcMap = new Map<string, string>();
    await Promise.all(
      [...etcIds].map(async (id) => {
        const etc = await ctx.db.get(id as any);
        if (etc) etcMap.set(id, etc.displayName);
      }),
    );

    const enriched = myMeetings.map((meeting) => {
      const opp = oppMap.get(meeting.opportunityId);
      return {
        meeting,
        leadName: meeting.leadName ?? "Unknown",
        opportunityStatus: opp?.status,
        eventTypeName: opp?.eventTypeConfigId ? etcMap.get(opp.eventTypeConfigId) ?? null : null,
      };
    });

    console.log("[Closer:Calendar] enriched count", { count: enriched.length });
    return enriched;
  },
});
```

**Step 5: Rewrite `listAffectedMeetingsForCloserInRange`**

Replace the two-phase pattern (list opportunity IDs -> scan meetings) with a direct indexed query:

```typescript
// Path: convex/unavailability/shared.ts

export async function listAffectedMeetingsForCloserInRange(
  ctx: TenantContext,
  { tenantId, closerId, rangeStart, rangeEnd }: {
    tenantId: Id<"tenants">;
    closerId: Id<"users">;
    rangeStart: number;
    rangeEnd: number;
  },
): Promise<AffectedMeeting[]> {
  const affectedMeetings: AffectedMeeting[] = [];

  // Direct indexed range query -- no intermediate opportunity scan
  for await (const meeting of ctx.db
    .query("meetings")
    .withIndex("by_tenantId_and_assignedCloserId_and_scheduledAt", (q) =>
      q
        .eq("tenantId", tenantId)
        .eq("assignedCloserId", closerId)
        .gte("scheduledAt", rangeStart)
        .lt("scheduledAt", rangeEnd),
    )) {
    if (meeting.status !== "scheduled") continue;

    affectedMeetings.push({
      meetingId: meeting._id,
      opportunityId: meeting.opportunityId,
      scheduledAt: meeting.scheduledAt,
      durationMinutes: meeting.durationMinutes,
      leadName: meeting.leadName,
      meetingJoinUrl: meeting.meetingJoinUrl,
      status: meeting.status,
    });
  }

  affectedMeetings.sort((a, b) => a.scheduledAt - b.scheduledAt);
  return affectedMeetings;
}
```

**Step 6: Rewrite `buildCloserSchedulesForDate`**

Replace per-closer opportunity scan with direct meeting index:

```typescript
// Path: convex/unavailability/shared.ts

export async function buildCloserSchedulesForDate(
  ctx: TenantContext,
  { tenantId, date, closerIds }: {
    tenantId: Id<"tenants">;
    date: number;
    closerIds: readonly Id<"users">[];
  },
): Promise<Map<Id<"users">, CloserSchedule>> {
  const uniqueCloserIds = [...new Set(closerIds)];
  const schedules = new Map<Id<"users">, CloserSchedule>();
  const { dayStart, dayEnd } = getDayRange(date);

  // Initialize schedules with closer info
  for (const closerId of uniqueCloserIds) {
    const closer = await ctx.db.get(closerId);
    if (!closer || closer.tenantId !== tenantId || closer.role !== "closer") continue;

    schedules.set(closerId, {
      closerId,
      closerName: getUserDisplayName(closer),
      meetings: [],
      meetingsToday: 0,
      blockedRanges: [],
      isAvailable: true,
      unavailabilityReason: null,
    });
  }

  if (schedules.size === 0) return schedules;

  // Load unavailability records (unchanged -- already efficiently indexed)
  for await (const record of ctx.db
    .query("closerUnavailability")
    .withIndex("by_tenantId_and_date", (q) =>
      q.eq("tenantId", tenantId).eq("date", date),
    )) {
    const schedule = schedules.get(record.closerId);
    if (!schedule) continue;
    schedule.blockedRanges.push({
      ...getEffectiveRange(record),
      reason: record.reason,
      isFullDay: record.isFullDay,
    });
    if (record.isFullDay) {
      schedule.isAvailable = false;
      schedule.unavailabilityReason = record.reason;
    }
  }

  // Per-closer indexed meeting query (replaces scan-all-opps + scan-all-meetings)
  for (const closerId of schedules.keys()) {
    for await (const meeting of ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_assignedCloserId_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("assignedCloserId", closerId)
          .gte("scheduledAt", dayStart)
          .lt("scheduledAt", dayEnd),
      )) {
      if (meeting.status !== "scheduled") continue;

      const schedule = schedules.get(closerId)!;
      schedule.meetings.push({
        meetingId: meeting._id,
        opportunityId: meeting.opportunityId,
        scheduledAt: meeting.scheduledAt,
        durationMinutes: meeting.durationMinutes,
        leadName: meeting.leadName,
      });
    }
  }

  // Sort and count
  for (const schedule of schedules.values()) {
    schedule.meetings.sort((a, b) => a.scheduledAt - b.scheduledAt);
    schedule.meetingsToday = schedule.meetings.length;
  }

  return schedules;
}
```

**Step 7: Remove `listActiveOpportunityIdsForCloser`**

This helper function (lines 75-93) is no longer called by any code path after the rewrites above. Delete it.

**Key implementation notes:**

- The `by_tenantId_and_assignedCloserId_and_scheduledAt` index on `meetings` is the single index that unlocks all 6 closer query rewrites. It was added in Phase 1 and backfilled in Phase 2.
- `getNextMeeting` walks forward from `now` using async iteration, stopping at the first `"scheduled"` meeting. This is O(1) in the common case (next meeting is scheduled) and O(k) where k is the number of non-scheduled meetings to skip.
- `getPipelineSummary` uses 8 separate indexed prefix queries, one per status. Each is a bounded count. At typical closer scales (10-50 opportunities), this is fast. If a closer had 1000+ opportunities, consider a closer-level stats document.
- `buildCloserSchedulesForDate` now does per-closer indexed queries instead of a single tenant-wide scan. This is better when the number of closers is small (typical: 3-8); the per-closer queries are tightly bounded by the day range.
- All return shapes are preserved exactly. No frontend changes needed.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/dashboard.ts` | Modify | Rewrite `getNextMeeting` and `getPipelineSummary` to use compound indexes |
| `convex/closer/pipeline.ts` | Modify | Rewrite `listMyOpportunities` with index query + batch enrichment |
| `convex/closer/calendar.ts` | Modify | Rewrite `getMeetingsForRange` with direct closer meeting index |
| `convex/unavailability/shared.ts` | Modify | Rewrite `listAffectedMeetingsForCloserInRange` and `buildCloserSchedulesForDate`; delete `listActiveOpportunityIdsForCloser` |

---

### 4C — Pagination Correctness Fixes

**Type:** Backend
**Parallelizable:** Yes -- touches `convex/leads/queries.ts`, `convex/customers/queries.ts`, and `convex/closer/followUpQueries.ts`. No overlap with 4A, 4B, 4D, or 4E.

**What:** Fix four queries where post-paginate or post-fetch filtering produces incomplete pages, short results, or null entries. Each fix pushes the filter into the index so the database returns exactly the rows the client expects.

**Why:** Post-paginate filtering is a correctness bug: if a paginated page has 25 items and 10 are filtered out in JS, the client sees a page of 15 and cannot tell whether more items exist. This produces short pages, missing records, and unreliable "Load more" behavior. The search index overfetch-then-truncate pattern wastes reads and still misses results.

**Where:**
- `convex/leads/queries.ts` (modify)
- `convex/customers/queries.ts` (modify)
- `convex/closer/followUpQueries.ts` (modify)

**How:**

**Step 1: Fix `listLeads` pagination**

After Phase 2 backfill and Phase 6 narrowing, `leads.status` is always defined. But even during Phase 4 (before narrowing), the backfill ensures no undefined values remain. Simplify the query to always use `by_tenantId_and_status`:

```typescript
// Path: convex/leads/queries.ts

export const listLeads = query({
  args: {
    paginationOpts: paginationOptsValidator,
    statusFilter: v.optional(leadStatusValidator),
  },
  handler: async (ctx, { paginationOpts, statusFilter }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    // Default to "active" when no filter specified (matches current behavior
    // of hiding merged leads). After Phase 2 backfill, status is always defined.
    const effectiveStatus = statusFilter ?? "active";

    const rawResults = await ctx.db
      .query("leads")
      .withIndex("by_tenantId_and_status", (q) =>
        q.eq("tenantId", tenantId).eq("status", effectiveStatus),
      )
      .order("desc")
      .paginate(paginationOpts);

    // No post-filter needed -- index returns exactly the right leads

    const closerNameCache = new Map<string, string | null>();
    const enrichedPage = await Promise.all(
      rawResults.page.map(async (lead) => {
        const opportunities = await ctx.db
          .query("opportunities")
          .withIndex("by_tenantId_and_leadId", (q) =>
            q.eq("tenantId", tenantId).eq("leadId", lead._id),
          )
          .order("desc")
          .take(50);

        let latestMeetingAt: number | null = null;
        let assignedCloserName: string | null = null;

        for (const opportunity of opportunities) {
          if (
            opportunity.latestMeetingAt !== undefined &&
            (latestMeetingAt === null || opportunity.latestMeetingAt > latestMeetingAt)
          ) {
            latestMeetingAt = opportunity.latestMeetingAt;
          }
          if (assignedCloserName || !opportunity.assignedCloserId) continue;
          const cacheKey = opportunity.assignedCloserId as string;
          if (!closerNameCache.has(cacheKey)) {
            const closer = await ctx.db.get(opportunity.assignedCloserId);
            closerNameCache.set(
              cacheKey,
              closer && closer.tenantId === tenantId
                ? closer.fullName ?? closer.email
                : null,
            );
          }
          assignedCloserName = closerNameCache.get(cacheKey) ?? null;
        }

        return {
          ...lead,
          opportunityCount: opportunities.length,
          latestMeetingAt,
          assignedCloserName,
        };
      }),
    );

    console.log("[Leads:List] listLeads completed", {
      tenantId,
      statusFilter: effectiveStatus,
      pageSize: enrichedPage.length,
      isDone: rawResults.isDone,
    });

    return {
      ...rawResults,
      page: enrichedPage,
    };
  },
});
```

**Step 2: Fix `searchLeads`**

With `status` always defined, the search index can filter by status directly. Remove the overfetch-then-truncate pattern:

```typescript
// Path: convex/leads/queries.ts

export const searchLeads = query({
  args: {
    searchTerm: v.string(),
    statusFilter: v.optional(leadStatusValidator),
  },
  handler: async (ctx, { searchTerm, statusFilter }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    const trimmed = searchTerm.trim();
    if (trimmed.length === 0) return [];

    // status is always defined after backfill -- use search index filter directly
    const effectiveStatus = statusFilter ?? "active";

    const results = await ctx.db
      .query("leads")
      .withSearchIndex("search_leads", (q) =>
        q
          .search("searchText", trimmed)
          .eq("tenantId", tenantId)
          .eq("status", effectiveStatus),
      )
      .take(20);

    // No post-filter needed -- search index handles status filtering

    console.log("[Leads:Search] searchLeads completed", {
      tenantId,
      searchTerm: trimmed,
      statusFilter: effectiveStatus,
      resultCount: results.length,
    });

    return results;
  },
});
```

**Step 3: Fix `listCustomers` closer pagination**

Replace the null-returning post-filter with a proper index for closer-scoped queries:

```typescript
// Path: convex/customers/queries.ts

export const listCustomers = query({
  args: {
    paginationOpts: paginationOptsValidator,
    statusFilter: v.optional(
      v.union(v.literal("active"), v.literal("churned"), v.literal("paused")),
    ),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId, role } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    let paginatedResult;

    if (role === "closer") {
      // Closer: paginate directly on their customers -- no post-filter nulls
      if (args.statusFilter) {
        paginatedResult = await ctx.db
          .query("customers")
          .withIndex("by_tenantId_and_convertedByUserId_and_status", (q) =>
            q
              .eq("tenantId", tenantId)
              .eq("convertedByUserId", userId)
              .eq("status", args.statusFilter!),
          )
          .order("desc")
          .paginate(args.paginationOpts);
      } else {
        paginatedResult = await ctx.db
          .query("customers")
          .withIndex("by_tenantId_and_convertedByUserId", (q) =>
            q.eq("tenantId", tenantId).eq("convertedByUserId", userId),
          )
          .order("desc")
          .paginate(args.paginationOpts);
      }
    } else {
      // Admin: paginate all tenant customers
      if (args.statusFilter) {
        paginatedResult = await ctx.db
          .query("customers")
          .withIndex("by_tenantId_and_status", (q) =>
            q.eq("tenantId", tenantId).eq("status", args.statusFilter!),
          )
          .order("desc")
          .paginate(args.paginationOpts);
      } else {
        paginatedResult = await ctx.db
          .query("customers")
          .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
          .order("desc")
          .paginate(args.paginationOpts);
      }
    }

    // Enrich: read totalPaidMinor directly instead of per-customer payment scan
    const enrichedPage = await Promise.all(
      paginatedResult.page.map(async (customer) => {
        const converter = await ctx.db.get(customer.convertedByUserId);
        return {
          ...customer,
          totalPaid: (customer.totalPaidMinor ?? 0) / 100,
          currency: customer.paymentCurrency ?? "USD",
          paymentCount: customer.totalPaymentCount ?? 0,
          convertedByName: converter?.fullName ?? converter?.email ?? "Unknown",
        };
      }),
    );

    return {
      ...paginatedResult,
      page: enrichedPage,
    };
  },
});
```

**Step 4: Fix `getActiveReminders`**

Use the 5-field compound index to push all filtering into the database:

```typescript
// Path: convex/closer/followUpQueries.ts

export const getActiveReminders = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId, userId } = await requireTenantUser(ctx, ["closer"]);

    // Use compound index: all 5 prefix fields push filter into the DB
    const reminders = await ctx.db
      .query("followUps")
      .withIndex(
        "by_tenantId_and_closerId_and_type_and_status_and_reminderScheduledAt",
        (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("closerId", userId)
            .eq("type", "manual_reminder")
            .eq("status", "pending"),
      )
      .take(50);

    // Already ordered by reminderScheduledAt (index tail field)
    const enriched = await Promise.all(
      reminders.map(async (reminder) => {
        const lead = await ctx.db.get(reminder.leadId);
        return {
          ...reminder,
          leadName: lead?.fullName ?? lead?.email ?? "Unknown",
          leadPhone: lead?.phone ?? null,
        };
      }),
    );

    console.log("[Closer:FollowUp] getActiveReminders", {
      userId,
      count: enriched.length,
    });

    return enriched;
  },
});
```

**Key implementation notes:**

- `listLeads` default behavior: when no `statusFilter` is provided, the current code shows all non-merged leads. Since `status` is now always defined (after Phase 2 backfill), defaulting to `"active"` matches existing behavior. If "show all non-merged" is truly needed, the frontend should pass `statusFilter: "active"` explicitly.
- `searchLeads`: the Convex search index `search_leads` has `filterFields: ["tenantId", "status"]`, so `.eq("status", effectiveStatus)` is pushed into the search engine. No JS filtering needed.
- `listCustomers`: the `by_tenantId_and_convertedByUserId` and `by_tenantId_and_convertedByUserId_and_status` indexes were added in Phase 1. The closer path now returns full pages with zero null entries.
- `getActiveReminders`: the 5-field compound index `by_tenantId_and_closerId_and_type_and_status_and_reminderScheduledAt` pushes all predicates into the index. Results come back ordered by `reminderScheduledAt` (the tail field), so no JS sort needed.
- All return shapes preserved. No frontend changes.
- Remove the `isActiveLikeLeadStatus`, `matchesStatusFilter`, and related helper functions from `leads/queries.ts` -- they are no longer needed.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leads/queries.ts` | Modify | Fix `listLeads` and `searchLeads` to use `by_tenantId_and_status` and search index filter directly; remove `isActiveLikeLeadStatus` and `matchesStatusFilter` helpers |
| `convex/customers/queries.ts` | Modify | Fix `listCustomers` closer pagination with `by_tenantId_and_convertedByUserId`; read `totalPaidMinor` directly |
| `convex/closer/followUpQueries.ts` | Modify | Fix `getActiveReminders` with 5-field compound index |

---

### 4D — Detail Query Flattening

**Type:** Backend
**Parallelizable:** Yes -- touches `convex/leads/queries.ts` (different functions from 4C), `convex/customers/queries.ts` (different function from 4C), and `convex/closer/meetingDetail.ts`. No overlap with 4A, 4B, or 4E.

**What:** Flatten N+1 nested loop patterns in `getLeadDetail`, `getCustomerDetail`, and `getMeetingDetail` using batch enrichment with deduped ID sets.

**Why:** The current detail queries use per-opportunity nested loops that fetch meetings, then per-meeting or per-opportunity lookups for closers, event types, and other related entities. This creates O(opportunities * meetings) read patterns. Batch enrichment collects all needed IDs upfront, fetches each entity once, and builds lookup maps for O(1) enrichment.

**Where:**
- `convex/leads/queries.ts` (`getLeadDetail` function)
- `convex/customers/queries.ts` (`getCustomerDetail` function)
- `convex/closer/meetingDetail.ts` (`getMeetingDetail` function)

**How:**

**Step 1: Rewrite `getLeadDetail` follow-ups query**

Replace the tenant-wide follow-ups scan + JS filter with a direct indexed query:

```typescript
// Path: convex/leads/queries.ts (inside getLeadDetail handler)

// BEFORE: Fetches 200 tenant follow-ups, then JS-filters by leadId
// const tenantFollowUps = await ctx.db
//   .query("followUps")
//   .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
//   .order("desc")
//   .take(200);
// const followUps = tenantFollowUps.filter((f) => f.leadId === leadId);

// AFTER: Direct indexed query for this lead's follow-ups
const followUps = await ctx.db
  .query("followUps")
  .withIndex("by_tenantId_and_leadId_and_createdAt", (q) =>
    q.eq("tenantId", tenantId).eq("leadId", leadId),
  )
  .order("desc")
  .take(50);
```

**Step 2: Consolidate `getLeadDetail` batch fetching**

The current implementation already uses batch enrichment for closers and event types (lines 287-325). Keep that pattern but ensure the parallel initial fetch replaces the tenant-wide follow-ups scan:

```typescript
// Path: convex/leads/queries.ts (inside getLeadDetail handler, replace the Promise.all)

const [
  identifiers,
  rawOpportunities,
  followUps,
  mergeHistoryAsSource,
  mergeHistoryAsTarget,
] = await Promise.all([
  ctx.db
    .query("leadIdentifiers")
    .withIndex("by_leadId", (q) => q.eq("leadId", leadId))
    .order("desc")
    .take(100),
  ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId),
    )
    .order("desc")
    .take(50),
  // Direct indexed query replaces tenant-wide scan + JS filter
  ctx.db
    .query("followUps")
    .withIndex("by_tenantId_and_leadId_and_createdAt", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId),
    )
    .order("desc")
    .take(50),
  ctx.db
    .query("leadMergeHistory")
    .withIndex("by_sourceLeadId", (q) => q.eq("sourceLeadId", leadId))
    .take(20),
  ctx.db
    .query("leadMergeHistory")
    .withIndex("by_targetLeadId", (q) => q.eq("targetLeadId", leadId))
    .take(20),
]);
```

Remove the post-fetch filter that was needed for the old tenant-wide query:
```typescript
// REMOVE this line -- no longer needed:
// const followUps = tenantFollowUps
//   .filter((followUp) => followUp.leadId === leadId)
//   .sort((a, b) => b.createdAt - a.createdAt);

// Follow-ups already come sorted from the index (order("desc"))
```

**Step 3: Rewrite `getCustomerDetail` with batch enrichment**

Replace the per-opportunity meeting loop with a single batch pattern:

```typescript
// Path: convex/customers/queries.ts (inside getCustomerDetail handler)

// Load all opportunities for this lead
const opportunities = await ctx.db
  .query("opportunities")
  .withIndex("by_tenantId_and_leadId", (q) =>
    q.eq("tenantId", tenantId).eq("leadId", customer.leadId),
  )
  .take(50);

// Batch-fetch all meetings for all opportunities at once
const allMeetings = await Promise.all(
  opportunities.map((opp) =>
    ctx.db
      .query("meetings")
      .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opp._id))
      .take(20),
  ),
);

// Flatten and enrich from in-memory opportunity map
const oppStatusMap = new Map(opportunities.map((o) => [o._id.toString(), o.status]));
const meetings = allMeetings
  .flat()
  .map((m) => ({
    ...m,
    opportunityStatus: oppStatusMap.get(m.opportunityId.toString()) ?? "scheduled",
  }))
  .sort((a, b) => b.scheduledAt - a.scheduledAt)
  .slice(0, 20);

// Read totalPaidMinor directly instead of scanning payments
const totalPaid = (customer.totalPaidMinor ?? 0) / 100;
const currency = customer.paymentCurrency ?? "USD";

// Payment history: bounded query (keep for detail view)
const payments = await ctx.db
  .query("paymentRecords")
  .withIndex("by_customerId", (q) => q.eq("customerId", customer._id))
  .take(50);
payments.sort((a, b) => b.recordedAt - a.recordedAt);
```

**Step 4: Rewrite `getMeetingDetail` meeting history**

The current pattern (lines 71-92) iterates all lead opportunities, then all meetings per opportunity -- an O(opps * meetings) nested loop. Replace with a flatter query:

```typescript
// Path: convex/closer/meetingDetail.ts (inside getMeetingDetail handler)

// Load lead's opportunities
const leadOpportunities = await ctx.db
  .query("opportunities")
  .withIndex("by_tenantId_and_leadId", (q) =>
    q.eq("tenantId", tenantId).eq("leadId", opportunity.leadId),
  )
  .take(50);

// Batch-fetch meetings for all opportunities in parallel
const oppStatusMap = new Map(
  leadOpportunities.map((o) => [o._id.toString(), o.status]),
);

const meetingBatches = await Promise.all(
  leadOpportunities.map((opp) =>
    ctx.db
      .query("meetings")
      .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opp._id))
      .order("desc")
      .take(20),
  ),
);

const meetingHistory: MeetingHistoryEntry[] = meetingBatches
  .flat()
  .map((m) => ({
    ...m,
    opportunityStatus: oppStatusMap.get(m.opportunityId.toString()) as any,
    isCurrentMeeting: m._id === meetingId,
  }))
  .sort((a, b) => b.scheduledAt - a.scheduledAt);
```

**Step 5: Deduplicate payment closer lookups in `getMeetingDetail`**

The current code fetches the closer for every payment record individually. Batch it:

```typescript
// Path: convex/closer/meetingDetail.ts (payment enrichment section)

// Collect unique closer IDs from payments
const paymentCloserIds = new Set(
  paymentRecordsRaw.map((p) => p.closerId).filter(Boolean),
);
const paymentCloserMap = new Map<string, string | null>();
await Promise.all(
  [...paymentCloserIds].map(async (id) => {
    const closer = await ctx.db.get(id);
    paymentCloserMap.set(
      id,
      closer && closer.tenantId === tenantId
        ? closer.fullName ?? closer.email
        : null,
    );
  }),
);

// Then enrich payments from the map
const payments: EnrichedPayment[] = [];
for (const payment of paymentRecordsRaw) {
  // ... resolve proof file (unchanged) ...
  payments.push({
    ...payment,
    proofFileUrl,
    proofFileContentType,
    proofFileSize,
    closerName: paymentCloserMap.get(payment.closerId) ?? null,
  });
}
```

**Key implementation notes:**

- `getLeadDetail` follow-ups: the `by_tenantId_and_leadId_and_createdAt` index was added in Phase 1. This eliminates the tenant-wide scan of 200 follow-ups followed by JS filtering.
- `getCustomerDetail`: the per-opportunity meeting fetch uses `Promise.all` for parallelism. The `by_opportunityId` index is already efficient for this. The key win is reading `totalPaidMinor` directly instead of scanning all payments per customer.
- `getMeetingDetail`: the meeting history batch fetch replaces nested `for await` loops with parallel `Promise.all`. The O(opps * meetings) async iteration becomes O(opps) parallel bounded queries.
- Payment closer dedup: if 5 payments were all recorded by the same closer, the current code fetches that closer 5 times. The batch pattern fetches once.
- All return shapes preserved exactly.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leads/queries.ts` | Modify | Rewrite `getLeadDetail` follow-ups to use `by_tenantId_and_leadId_and_createdAt`; remove tenant-wide scan |
| `convex/customers/queries.ts` | Modify | Rewrite `getCustomerDetail` with batch meeting fetch and `totalPaidMinor` read |
| `convex/closer/meetingDetail.ts` | Modify | Flatten meeting history nested loops; batch payment closer lookups |

---

### 4E — Payment, User, and Unbounded Query Updates

**Type:** Backend
**Parallelizable:** Yes -- touches `convex/opportunities/queries.ts`, `convex/users/queries.ts`, `convex/eventTypeConfigs/queries.ts`, and `convex/customers/queries.ts` (only `getCustomerTotalPaid`). No overlap with 4A-4D file/function pairs.

**What:** Apply five cross-cutting query updates: (1) switch payment reads to `amountMinor`, (2) filter soft-deleted users, (3) add safety bounds to unbounded queries, (4) remove `?? "active"` lead status fallbacks, and (5) rewrite `getEventTypeConfigsWithStats` to use the `by_tenantId_and_eventTypeConfigId` index.

**Why:** These are individually small changes that span multiple files. Grouping them into a single subphase avoids interleaving with the larger rewrites in 4A-4D while ensuring no query is left behind. Each addresses a specific audit finding.

**Where:**
- `convex/opportunities/queries.ts` (modify)
- `convex/users/queries.ts` (modify)
- `convex/eventTypeConfigs/queries.ts` (modify)
- `convex/customers/queries.ts` (modify -- `getCustomerTotalPaid` only)

**How:**

**Step 1: Add safety bounds to `listOpportunitiesForAdmin`**

Convert the unbounded `for await` collection to `.paginate()`:

```typescript
// Path: convex/opportunities/queries.ts

import { paginationOptsValidator } from "convex/server";

export const listOpportunitiesForAdmin = query({
  args: {
    paginationOpts: paginationOptsValidator,
    statusFilter: v.optional(opportunityStatusValidator),
    assignedCloserId: v.optional(v.id("users")),
  },
  handler: async (ctx, { paginationOpts, statusFilter, assignedCloserId }) => {
    console.log("[Opportunities] listOpportunitiesForAdmin called", {
      statusFilter: statusFilter ?? "all",
      assignedCloserId: assignedCloserId ?? "none",
    });
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    if (assignedCloserId) {
      const closer = await ctx.db.get(assignedCloserId);
      if (!closer || closer.tenantId !== tenantId || closer.role !== "closer") {
        throw new Error("Invalid closer filter");
      }
    }

    // Paginated queries based on filter combination
    let paginatedResult;
    if (statusFilter && assignedCloserId) {
      // Use the 3-field compound index for both filters
      paginatedResult = await ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_assignedCloserId_and_status", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("assignedCloserId", assignedCloserId)
            .eq("status", statusFilter),
        )
        .order("desc")
        .paginate(paginationOpts);
    } else if (statusFilter) {
      paginatedResult = await ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_status", (q) =>
          q.eq("tenantId", tenantId).eq("status", statusFilter),
        )
        .order("desc")
        .paginate(paginationOpts);
    } else if (assignedCloserId) {
      paginatedResult = await ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_assignedCloserId", (q) =>
          q.eq("tenantId", tenantId).eq("assignedCloserId", assignedCloserId),
        )
        .order("desc")
        .paginate(paginationOpts);
    } else {
      paginatedResult = await ctx.db
        .query("opportunities")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .order("desc")
        .paginate(paginationOpts);
    }

    // Batch enrichment (existing pattern -- unchanged)
    // ... (keep existing enrichment logic from lines 100-216) ...

    return {
      ...paginatedResult,
      page: enriched,
    };
  },
});
```

**Step 2: Add safety bounds and soft-delete filter to `listTeamMembers`**

```typescript
// Path: convex/users/queries.ts

export const listTeamMembers = query({
  args: {},
  handler: async (ctx) => {
    console.log("[Users] listTeamMembers called");
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    // Safety bound + filter soft-deleted users
    const users: Doc<"users">[] = [];
    for await (const user of ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
      if (user.isActive === false) continue; // Skip soft-deleted users
      users.push(user);
      if (users.length >= 200) break; // Safety limit
    }

    console.log("[Users] listTeamMembers result", { count: users.length });
    return await Promise.all(
      users.map(async (user) => {
        let calendlyMemberName = user.calendlyMemberName;
        if (!calendlyMemberName && user.calendlyUserUri) {
          const linkedMember = await ctx.db
            .query("calendlyOrgMembers")
            .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
              q.eq("tenantId", tenantId).eq("calendlyUserUri", user.calendlyUserUri!),
            )
            .unique();
          calendlyMemberName = linkedMember?.name;
        }
        return {
          ...user,
          calendlyMemberName,
          isPendingInvite: user.invitationStatus === "pending",
        };
      }),
    );
  },
});
```

**Step 3: Add safety bound to `listUnmatchedCalendlyMembers`**

```typescript
// Path: convex/users/queries.ts

export const listUnmatchedCalendlyMembers = query({
  args: {},
  handler: async (ctx) => {
    console.log("[Users] listUnmatchedCalendlyMembers called");
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    const members = await ctx.db
      .query("calendlyOrgMembers")
      .withIndex("by_tenantId_and_matchedUserId", (q) =>
        q.eq("tenantId", tenantId).eq("matchedUserId", undefined),
      )
      .take(200); // Safety limit

    console.log("[Users] listUnmatchedCalendlyMembers result", { count: members.length });
    return members;
  },
});
```

**Step 4: Rewrite `getEventTypeConfigsWithStats`**

Replace the full tenant opportunity scan with per-config indexed queries:

```typescript
// Path: convex/eventTypeConfigs/queries.ts

export const getEventTypeConfigsWithStats = query({
  args: {},
  handler: async (ctx) => {
    console.log("[EventTypeConfig] getEventTypeConfigsWithStats called");
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const configs = await ctx.db
      .query("eventTypeConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(100);

    // Per-config indexed query instead of scanning all opportunities
    const results = await Promise.all(
      configs.map(async (config) => {
        let bookingCount = 0;
        let lastBookingAt: number | undefined;

        for await (const opp of ctx.db
          .query("opportunities")
          .withIndex("by_tenantId_and_eventTypeConfigId", (q) =>
            q.eq("tenantId", tenantId).eq("eventTypeConfigId", config._id),
          )) {
          bookingCount++;
          if (
            opp.latestMeetingAt !== undefined &&
            (lastBookingAt === undefined || opp.latestMeetingAt > lastBookingAt)
          ) {
            lastBookingAt = opp.latestMeetingAt;
          }
        }

        return {
          ...config,
          bookingCount,
          lastBookingAt,
          fieldCount: config.knownCustomFieldKeys?.length ?? 0,
        };
      }),
    );

    console.log("[EventTypeConfig] getEventTypeConfigsWithStats result", {
      count: results.length,
    });
    return results;
  },
});
```

**Step 5: Mark `getCustomerTotalPaid` as dead code**

With `listCustomers` reading `totalPaidMinor` directly from the customer document, the per-customer payment scan query becomes unnecessary:

```typescript
// Path: convex/customers/queries.ts

/**
 * @deprecated Use customer.totalPaidMinor directly.
 * Kept temporarily for backward compatibility during Phase 4-7 transition.
 * Remove after Phase 7 frontend migration confirms no callers remain.
 */
export const getCustomerTotalPaid = query({
  args: { customerId: v.id("customers") },
  handler: async (ctx, { customerId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    const customer = await ctx.db.get(customerId);
    if (!customer || customer.tenantId !== tenantId) return null;

    // Read from denormalized field instead of scanning payments
    return {
      totalPaid: (customer.totalPaidMinor ?? 0) / 100,
      currency: customer.paymentCurrency ?? "USD",
      paymentCount: customer.totalPaymentCount ?? 0,
    };
  },
});
```

**Step 6: Remove `?? "active"` lead status fallbacks**

After Phase 2 backfill, `leads.status` is always defined. Remove defensive fallbacks:

```typescript
// Path: convex/leads/queries.ts
// Remove these functions entirely:
// - isActiveLikeLeadStatus()
// - matchesStatusFilter()
// All callers now use direct index queries (4C) or explicit status checks.
```

**Key implementation notes:**

- `listOpportunitiesForAdmin` changes from returning all results to paginated results. The frontend (Phase 7) will switch to `usePaginatedQuery`. During Phase 4 the return shape changes from `Array<...>` to `{ page, isDone, continueCursor }`. This is the one intentional shape change -- the frontend must be updated in Phase 7. Alternatively, keep the current unbounded pattern with a `.take(200)` safety limit if frontend pagination isn't ready yet.
- `listTeamMembers` soft-delete filter: `isActive === false` (explicit check) rather than `!isActive` to handle the undefined case during transition. After Phase 6 narrows `isActive` to required, this can simplify to `!user.isActive`.
- `getEventTypeConfigsWithStats`: the per-config query pattern is better when configs are few (typically 1-5 per tenant). The old pattern was O(all_opportunities); the new pattern is O(configs * per_config_opportunities), which is equivalent but avoids loading the full opportunity table into memory.
- `getCustomerTotalPaid` is deprecated, not deleted, to avoid breaking any frontend callers until Phase 7 confirms they're gone.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/opportunities/queries.ts` | Modify | Convert `listOpportunitiesForAdmin` to paginated; add `paginationOptsValidator` |
| `convex/users/queries.ts` | Modify | Add `.take(200)` to `listTeamMembers` and `listUnmatchedCalendlyMembers`; filter soft-deleted users |
| `convex/eventTypeConfigs/queries.ts` | Modify | Rewrite `getEventTypeConfigsWithStats` to use `by_tenantId_and_eventTypeConfigId` per-config |
| `convex/customers/queries.ts` | Modify | Deprecate `getCustomerTotalPaid`; body reads `totalPaidMinor` directly |
| `convex/leads/queries.ts` | Modify | Remove `isActiveLikeLeadStatus` and `matchesStatusFilter` helpers |

---

### 4F — Integration Verification

**Type:** Verification
**Parallelizable:** No -- runs after 4A-4E are all complete.

**What:** Verify that all query return shapes are unchanged (except the intentional `listOpportunitiesForAdmin` pagination change), type-check passes, and performance targets are met.

**Why:** Phase 4 rewrites 17+ queries across 11 files. A single verification pass ensures no return shape regressions, no missing imports, and no type errors before declaring Phase 4 complete.

**Where:**
- All files modified in 4A-4E
- TypeScript compilation (`pnpm tsc --noEmit`)

**How:**

**Step 1: Type-check the full project**

```bash
pnpm tsc --noEmit
```

All errors must be resolved. Common issues:
- Missing imports for `paginationOptsValidator` in newly paginated queries
- Type mismatches from `Id` vs `string` in Map keys (use `.toString()` or cast)
- Optional field access on `totalPaidMinor` / `paymentCurrency` (use `?? 0` / `?? "USD"`)

**Step 2: Verify return shape compatibility**

For each rewritten query, confirm the return type matches the original by reviewing the frontend consumer:

| Query | Frontend consumer | Shape check |
|---|---|---|
| `getAdminDashboardStats` | `app/workspace/_components/dashboard-page-client.tsx` | Same 10-field object |
| `getNextMeeting` | `app/workspace/closer/_components/closer-dashboard-page-client.tsx` | Same `{ meeting, opportunity, lead, eventTypeName }` |
| `getPipelineSummary` | Same closer dashboard | Same `{ counts, total }` |
| `listMyOpportunities` | `app/workspace/closer/pipeline/_components/closer-pipeline-page-client.tsx` | Same enriched opportunity array |
| `getMeetingsForRange` | `app/workspace/closer/_components/closer-calendar-section.tsx` | Same `{ meeting, leadName, opportunityStatus, eventTypeName }[]` |
| `listLeads` | `app/workspace/leads/_components/leads-page-client.tsx` | Same paginated result with enriched page |
| `searchLeads` | Same leads page (search mode) | Same lead array |
| `listCustomers` | `app/workspace/customers/_components/customers-page-client.tsx` | Same paginated result (no more nulls) |
| `getActiveReminders` | Closer dashboard reminders section | Same enriched reminder array |
| `getLeadDetail` | `app/workspace/leads/[leadId]/_components/lead-detail-page-client.tsx` | Same 8-field result object |
| `getCustomerDetail` | `app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx` | Same result with `totalPaid` |
| `getMeetingDetail` | `app/workspace/closer/meetings/[id]/_components/meeting-detail-page-client.tsx` | Same 12-field result object |
| `listOpportunitiesForAdmin` | `app/workspace/pipeline/_components/pipeline-page-client.tsx` | **CHANGED**: paginated (Phase 7 handles) |
| `listTeamMembers` | `app/workspace/team/_components/team-page-client.tsx` | Same array (soft-deleted filtered out) |
| `getEventTypeConfigsWithStats` | `app/workspace/settings/_components/field-mappings-tab.tsx` | Same enriched config array |

**Step 3: Verify no `.collect()` without bounds remain**

Search all modified files for `.collect()` to confirm none were left behind:

```bash
grep -n "\.collect()" convex/closer/dashboard.ts convex/closer/pipeline.ts \
  convex/closer/calendar.ts convex/dashboard/adminStats.ts \
  convex/leads/queries.ts convex/customers/queries.ts \
  convex/opportunities/queries.ts convex/unavailability/shared.ts
```

Any remaining `.collect()` must have a clear justification (e.g., bounded by a prior `.take()`).

**Step 4: Invoke `convex-performance-audit` skill**

Run the performance audit skill against the rewritten queries to verify:
- No queries scan more documents than necessary
- Index usage is confirmed for all hot paths
- Subscription costs are reduced (especially admin dashboard)

**Key implementation notes:**

- The `listOpportunitiesForAdmin` pagination change is the one intentional frontend-visible change. It will require Phase 7 to update the pipeline page from `useQuery` to `usePaginatedQuery`. Until Phase 7, this query can alternatively keep a `.take(200)` bound instead of `.paginate()` to avoid blocking.
- If any return shape regression is found, fix it in the corresponding subphase file before proceeding.
- Performance targets: admin dashboard should read 2 documents max (tenantStats + meetingsToday range). Closer dashboard should never scan all opportunities.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| _(No code changes)_ | Verify | Type-check, return shape audit, performance verification |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/dashboard/adminStats.ts` | Modify | 4A |
| `convex/closer/dashboard.ts` | Modify | 4B |
| `convex/closer/pipeline.ts` | Modify | 4B |
| `convex/closer/calendar.ts` | Modify | 4B |
| `convex/unavailability/shared.ts` | Modify | 4B |
| `convex/leads/queries.ts` | Modify | 4C, 4D, 4E |
| `convex/customers/queries.ts` | Modify | 4C, 4D, 4E |
| `convex/closer/followUpQueries.ts` | Modify | 4C |
| `convex/closer/meetingDetail.ts` | Modify | 4D |
| `convex/opportunities/queries.ts` | Modify | 4E |
| `convex/users/queries.ts` | Modify | 4E |
| `convex/eventTypeConfigs/queries.ts` | Modify | 4E |

---

## Notes for Implementer

- **Return shape preservation is paramount.** Phase 4 is a pure backend refactor. With the exception of `listOpportunitiesForAdmin` (which gains pagination), every rewritten query must return the identical shape. Use `pnpm tsc --noEmit` as the primary verification gate, but also spot-check by reading the frontend consumer files.
- **Index dependencies:** All indexes referenced in this phase were added in Phase 1 and backfilled in Phase 2. If any index is missing, check `convex/schema.ts` before proceeding. Key indexes: `meetings.by_tenantId_and_assignedCloserId_and_scheduledAt`, `opportunities.by_tenantId_and_assignedCloserId_and_status`, `followUps.by_tenantId_and_closerId_and_type_and_status_and_reminderScheduledAt`, `followUps.by_tenantId_and_leadId_and_createdAt`, `customers.by_tenantId_and_convertedByUserId`, `opportunities.by_tenantId_and_eventTypeConfigId`.
- **Batch enrichment pattern:** Always collect unique IDs into a `Set`, fetch each entity once via `Promise.all`, store in a `Map`, then enrich from the map. Never fetch the same document twice in a single query handler.
- **`listOpportunitiesForAdmin` pagination decision:** If the frontend is not ready for `usePaginatedQuery` in Phase 7, use `.take(200)` as a temporary bound instead of `.paginate()`. This preserves the array return shape while still bounding reads.
- **Soft-delete filter:** Use `user.isActive === false` (triple-equals with explicit `false`) rather than `!user.isActive` to correctly handle the `undefined` case during the transition before Phase 6 narrows `isActive` to required.
- **Testing:** After all subphases complete, manually verify the admin dashboard, closer dashboard, pipeline, calendar, leads list, customer list, lead detail, customer detail, and meeting detail pages all render correctly with real data.
- **Next phase:** Phase 6 (Schema Narrow) depends on Phase 4 completion. Phase 7 (Frontend Updates) also depends on Phase 4 for finalized query shapes.
