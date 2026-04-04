# Phase 5 — Closer Dashboard: Pipeline, Calendar & Featured Event

**Goal:** Build the complete Closer operational experience: a dashboard with a featured next-meeting card, a pipeline summary strip with stage counts, a calendar view showing meetings across day/week/month, and a filterable opportunity list. After this phase, Closers have a full real-time view of their assigned meetings and pipeline.

**Prerequisite:** Phase 1 (schema, auth guard, user queries, workspace layout) and Phase 3 (pipeline processor — creates the Leads, Opportunities, and Meetings that the closer dashboard reads).

**Runs in PARALLEL with:** Phase 4 (Admin Dashboard, Team Management & Settings). No shared files.

**Skills to invoke:**
- `frontend-design` — production-grade closer dashboard interface
- `shadcn` — Card, Badge, Calendar primitives, Table, Tabs components
- `vercel-react-best-practices` — optimize subscriptions, avoid unnecessary re-renders
- `web-design-guidelines` — accessibility, responsive layout, color-coded meeting statuses

**Acceptance Criteria:**
1. Closer navigating to `/workspace/closer` sees the featured next-meeting card with lead name, countdown, Zoom link, and event type.
2. If the closer has no upcoming meetings, the featured card shows "No upcoming meetings" with appropriate empty state.
3. The pipeline summary strip shows accurate counts: Scheduled, In Progress, Follow-up, Won, Lost.
4. The calendar view displays meetings for the selected range (day/week/month) with color-coded status indicators.
5. Clicking a meeting in the calendar navigates to the meeting detail page (route exists, content built in Phase 6).
6. `/workspace/closer/pipeline` shows the closer's opportunities filterable by status.
7. An unmatched Closer (no `calendlyUserUri`) sees a prominent banner: "Your account is not linked to a Calendly member. Contact your admin."
8. All data is scoped to the authenticated closer — no access to other closers' data.

---

## Subphases

### 5A — Closer Dashboard Queries (Featured Event + Pipeline Summary)

**Type:** Backend
**Parallelizable:** Yes — independent of all other Phase 5 subphases. After Phase 1 complete.

**What:** Create the Convex queries that power the closer dashboard: `getNextMeeting` (featured event card), `getPipelineSummary` (stage counts), and `getCloserProfile` (profile + unmatched status check).

**Why:** The closer dashboard page (5D) needs these three data sources to render the featured meeting, pipeline strip, and unmatched-closer banner. They must be efficient real-time queries since the dashboard is the closer's primary workspace.

**Where:** `convex/closer/dashboard.ts` (new file)

**How:**

```typescript
// convex/closer/dashboard.ts
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

/**
 * Get the closer's next upcoming meeting.
 *
 * Returns the soonest meeting (by scheduledAt) with status "scheduled"
 * that belongs to an opportunity assigned to this closer.
 *
 * Enriched with lead info and opportunity data.
 * Returns null if no upcoming meetings.
 */
export const getNextMeeting = query({
  args: {},
  handler: async (ctx) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);
    const now = Date.now();

    // Get this closer's scheduled opportunities
    const myOpps = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId", (q) =>
        q.eq("tenantId", tenantId).eq("assignedCloserId", userId)
      )
      .filter((q) => q.eq(q.field("status"), "scheduled"))
      .collect();

    if (myOpps.length === 0) return null;

    const oppIds = new Set(myOpps.map((o) => o._id));

    // Get upcoming meetings for this tenant (sorted by scheduledAt via index)
    const upcomingMeetings = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q.eq("tenantId", tenantId).gte("scheduledAt", now)
      )
      .filter((q) => q.eq(q.field("status"), "scheduled"))
      .take(50);

    // Filter to this closer's meetings
    const myMeetings = upcomingMeetings.filter((m) => oppIds.has(m.opportunityId));

    if (myMeetings.length === 0) return null;

    // First match is the soonest (index is sorted by scheduledAt)
    const nextMeeting = myMeetings[0];
    const opportunity = myOpps.find((o) => o._id === nextMeeting.opportunityId);
    const lead = opportunity ? await ctx.db.get(opportunity.leadId) : null;

    return {
      meeting: nextMeeting,
      opportunity,
      lead,
    };
  },
});

/**
 * Get pipeline stage counts for this closer.
 *
 * Returns a breakdown of opportunity counts by status.
 * Powers the pipeline summary strip on the dashboard.
 */
export const getPipelineSummary = query({
  args: {},
  handler: async (ctx) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const myOpps = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId", (q) =>
        q.eq("tenantId", tenantId).eq("assignedCloserId", userId)
      )
      .collect();

    const counts = {
      scheduled: 0,
      in_progress: 0,
      follow_up_scheduled: 0,
      payment_received: 0,
      lost: 0,
      canceled: 0,
      no_show: 0,
    };

    for (const opp of myOpps) {
      if (opp.status in counts) {
        counts[opp.status as keyof typeof counts]++;
      }
    }

    return {
      counts,
      total: myOpps.length,
    };
  },
});

/**
 * Get the closer's profile status.
 *
 * Used to determine if the closer is linked to a Calendly member.
 * If not, the dashboard shows a warning banner.
 */
export const getCloserProfile = query({
  args: {},
  handler: async (ctx) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const user = await ctx.db.get(userId);
    if (!user) throw new Error("User not found");

    return {
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      isCalendlyLinked: !!user.calendlyUserUri,
      calendlyUserUri: user.calendlyUserUri,
    };
  },
});
```

**Key implementation notes:**
- All three queries use `requireTenantUser(ctx, ["closer"])` — only closers can access them. The guard also returns `userId` which is used to filter by `assignedCloserId`.
- `getNextMeeting` fetches upcoming meetings via the `by_tenantId_and_scheduledAt` index (already sorted), then filters by the closer's opportunity IDs. This is efficient because the index provides the sort order.
- `getPipelineSummary` collects all opportunities for this closer and counts by status in memory. Acceptable for MVP scale (< 500 opps per closer).
- `getCloserProfile` checks `calendlyUserUri` to determine if the closer is linked — used by the UI to show/hide the warning banner.

**Files touched:** `convex/closer/dashboard.ts` (create)

---

### 5B — Calendar Range Query

**Type:** Backend
**Parallelizable:** Yes — independent of 5A. After Phase 1 complete.

**What:** Create the `getMeetingsForRange` query that returns all of a closer's meetings within a date range, enriched with lead and opportunity data.

**Why:** The calendar view (5E) needs to display meetings for a selected time range (day, week, or month). The query returns enriched data so the calendar component can render meeting cards with lead names and status colors.

**Where:** `convex/closer/calendar.ts` (new file)

**How:**

```typescript
// convex/closer/calendar.ts
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

/**
 * Get all of a closer's meetings within a date range.
 *
 * Returns meetings enriched with lead name and opportunity status.
 * Used by the calendar view to render meeting blocks.
 *
 * Args:
 * - startDate: Unix ms timestamp for the start of the range
 * - endDate: Unix ms timestamp for the end of the range
 */
export const getMeetingsForRange = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, { startDate, endDate }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    // Get this closer's opportunities (needed to filter meetings)
    const myOpps = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId", (q) =>
        q.eq("tenantId", tenantId).eq("assignedCloserId", userId)
      )
      .collect();

    const oppIds = new Set(myOpps.map((o) => o._id));
    const oppMap = new Map(myOpps.map((o) => [o._id.toString(), o]));

    // Get meetings in the date range using the scheduledAt index
    const meetings = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("scheduledAt", startDate)
          .lt("scheduledAt", endDate)
      )
      .collect();

    // Filter to this closer's meetings only
    const myMeetings = meetings.filter((m) => oppIds.has(m.opportunityId));

    // Enrich with lead and opportunity data
    const enriched = await Promise.all(
      myMeetings.map(async (meeting) => {
        const opp = oppMap.get(meeting.opportunityId.toString());
        const lead = opp ? await ctx.db.get(opp.leadId) : null;

        return {
          meeting,
          leadName: lead?.fullName ?? lead?.email ?? "Unknown",
          leadEmail: lead?.email,
          opportunityStatus: opp?.status,
        };
      })
    );

    return enriched;
  },
});
```

**Key implementation notes:**
- Uses `by_tenantId_and_scheduledAt` index for efficient date-range queries.
- `oppMap` avoids repeated lookups when enriching each meeting with its opportunity data.
- The caller passes `startDate` and `endDate` — the frontend determines these based on the selected calendar view (day/week/month).
- All meetings returned belong to this closer's assigned opportunities only — no cross-closer data leakage.

**Files touched:** `convex/closer/calendar.ts` (create)

---

### 5C — Closer Opportunity List Query

**Type:** Backend
**Parallelizable:** Yes — independent of 5A, 5B. After Phase 1 complete.

**What:** Create the `listMyOpportunities` query that returns the closer's opportunities with optional status filtering, enriched with lead data and latest meeting info.

**Why:** The closer pipeline page (5F) shows a filterable list of opportunities. This query provides the data with enough enrichment that the frontend doesn't need to make additional queries.

**Where:** `convex/closer/pipeline.ts` (new file)

**How:**

```typescript
// convex/closer/pipeline.ts
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

/**
 * List the closer's opportunities with optional status filter.
 *
 * Returns opportunities enriched with:
 * - Lead name and email
 * - Latest meeting date and status
 * - Time since creation
 */
export const listMyOpportunities = query({
  args: {
    statusFilter: v.optional(v.string()),
  },
  handler: async (ctx, { statusFilter }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    // Get this closer's opportunities
    const myOpps = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId", (q) =>
        q.eq("tenantId", tenantId).eq("assignedCloserId", userId)
      )
      .collect();

    // Apply status filter if provided
    const filtered = statusFilter
      ? myOpps.filter((o) => o.status === statusFilter)
      : myOpps;

    // Enrich with lead and latest meeting data
    const enriched = await Promise.all(
      filtered.map(async (opp) => {
        const lead = await ctx.db.get(opp.leadId);

        // Get the latest meeting for this opportunity
        const latestMeeting = await ctx.db
          .query("meetings")
          .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opp._id))
          .order("desc")
          .first();

        return {
          ...opp,
          leadName: lead?.fullName ?? lead?.email ?? "Unknown",
          leadEmail: lead?.email,
          leadPhone: lead?.phone,
          latestMeetingId: latestMeeting?._id,
          latestMeetingAt: latestMeeting?.scheduledAt,
          latestMeetingStatus: latestMeeting?.status,
        };
      })
    );

    // Sort by most recent update first
    return enriched.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});
```

**Key implementation notes:**
- Uses `by_tenantId_and_assignedCloserId` index for efficient per-closer filtering.
- Status filtering happens in memory after collecting all opportunities. For MVP scale this is fine; for larger datasets, use the `by_tenantId_and_status` index combined with a secondary closer filter.
- Each opportunity is enriched with its latest meeting info, so the frontend can display meeting dates inline without additional queries.
- `latestMeetingId` is included so the frontend can link directly to the meeting detail page (Phase 6).

**Files touched:** `convex/closer/pipeline.ts` (create)

---

### 5D — Closer Dashboard Page UI

**Type:** Frontend
**Parallelizable:** Depends on 5A (dashboard queries). Can start with mock data.

**What:** Build the closer dashboard page with three main sections: a featured next-meeting card (prominent, top of page), a pipeline summary strip (horizontal stage counters), and an unmatched-closer warning banner (if applicable).

**Why:** This is the closer's home screen — the first thing they see after login. The featured meeting card eliminates the need to browse the calendar to find their next call. The pipeline strip provides instant context on their workload.

**Where:** `app/workspace/closer/page.tsx`, `app/workspace/closer/_components/` (new component files)

**How:**

**Component structure:**
```
app/workspace/closer/
├── page.tsx                          ← Closer dashboard (composition of below)
└── _components/
    ├── unmatched-banner.tsx          ← Warning: "Not linked to Calendly" (conditional)
    ├── featured-meeting-card.tsx     ← Next meeting: lead, time, countdown, Zoom link
    ├── pipeline-strip.tsx            ← Horizontal strip: Scheduled(5) InProgress(2) Won(8) Lost(1)
    └── empty-state.tsx               ← "No meetings scheduled" illustration
```

**Featured Meeting Card layout:**
```
┌──────────────────────────────────────────────────────────────┐
│  🔵 Next Meeting                                   in 2h 15m │
│                                                              │
│  Lead: John Smith (john@example.com)                        │
│  Event: 30-Min Sales Call                                   │
│  Time: Today at 2:30 PM                                     │
│  Duration: 30 minutes                                       │
│                                                              │
│  [Join Zoom Meeting]              [View Details →]           │
└──────────────────────────────────────────────────────────────┘
```

**Pipeline Summary Strip layout:**
```
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│ Scheduled│ │In Progress│ │ Follow-up│ │   Won    │ │  Lost    │
│    5     │ │     2     │ │    1     │ │    8     │ │    1     │
│  🟦     │ │   🟨     │ │   🟪    │ │   🟩    │ │   🟥    │
└──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘
  clickable    clickable    clickable    clickable    clickable
  → filtered   → filtered   → filtered   → filtered   → filtered
  pipeline pg  pipeline pg  pipeline pg  pipeline pg  pipeline pg
```

```typescript
// app/workspace/closer/page.tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { UnmatchedBanner } from "./_components/unmatched-banner";
import { FeaturedMeetingCard } from "./_components/featured-meeting-card";
import { PipelineStrip } from "./_components/pipeline-strip";
import { EmptyState } from "./_components/empty-state";

export default function CloserDashboardPage() {
  const profile = useQuery(api.closer.dashboard.getCloserProfile);
  const nextMeeting = useQuery(api.closer.dashboard.getNextMeeting);
  const pipelineSummary = useQuery(api.closer.dashboard.getPipelineSummary);

  // Loading state
  if (profile === undefined || nextMeeting === undefined || pipelineSummary === undefined) {
    return <DashboardSkeleton />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">My Dashboard</h1>
        <p className="text-muted-foreground">
          Welcome back, {profile.fullName ?? profile.email}
        </p>
      </div>

      {/* Unmatched Closer Warning */}
      {!profile.isCalendlyLinked && <UnmatchedBanner />}

      {/* Featured Next Meeting */}
      {nextMeeting ? (
        <FeaturedMeetingCard
          meeting={nextMeeting.meeting}
          lead={nextMeeting.lead}
          opportunity={nextMeeting.opportunity}
        />
      ) : (
        <EmptyState
          title="No upcoming meetings"
          description="You don't have any scheduled meetings. New meetings will appear here when leads book through Calendly."
        />
      )}

      {/* Pipeline Summary Strip */}
      <PipelineStrip counts={pipelineSummary.counts} total={pipelineSummary.total} />
    </div>
  );
}
```

**Frontend design guidelines to follow:**
- **Featured Meeting Card**: Use shadcn `Card` with prominent styling (slightly larger, maybe with a left-side colored border indicating status). The Zoom link should be a `Button` with `variant="default"` (primary action). The countdown timer should update reactively (use `useEffect` with `setInterval` or a relative-time library).
- **Pipeline Strip**: Each stage is a clickable `Card` that navigates to `/workspace/closer/pipeline?status=<status>`. Use `Link` from `next/link` for client-side navigation.
- **Unmatched Banner**: Use shadcn `Alert` with `variant="warning"` — yellow background, warning icon, clear message.
- **Empty State**: Centered illustration (can use a simple SVG or emoji) with descriptive text.
- **Loading Skeleton**: Use shadcn `Skeleton` components that mirror the layout of the real content.
- Follow `vercel-react-best-practices`: the three queries (`profile`, `nextMeeting`, `pipelineSummary`) are all separate Convex subscriptions. They update independently — if a new meeting is booked, only `nextMeeting` re-renders. This is optimal.
- Follow `web-design-guidelines`: the featured card should have sufficient contrast, the Zoom link should be a clear primary action, and the countdown should be screen-reader friendly with `aria-live="polite"`.

**Files touched:** `app/workspace/closer/page.tsx` (create), `app/workspace/closer/_components/unmatched-banner.tsx` (create), `app/workspace/closer/_components/featured-meeting-card.tsx` (create), `app/workspace/closer/_components/pipeline-strip.tsx` (create), `app/workspace/closer/_components/empty-state.tsx` (create)

---

### 5E — Calendar View Component

**Type:** Frontend
**Parallelizable:** Depends on 5B (calendar range query). Can start with mock data.

**What:** Build a calendar view component that displays the closer's meetings across Day, Week, and Month views with color-coded status indicators and clickable meeting slots.

**Why:** Closers need a visual overview of their schedule to plan their day and week. The calendar provides temporal context that the pipeline list doesn't — seeing meetings distributed across time helps identify busy/free periods.

**Where:** `app/workspace/closer/_components/calendar-view.tsx` (new component), integrated into the closer dashboard or as a dedicated sub-route.

**How:**

**Calendar UI approach:**
Build a custom calendar grid using shadcn/ui primitives (no heavy third-party calendar library). The minimum viable view is a **week view with time slots**.

**View modes:**
- **Day view**: Single column, hourly time slots, meetings rendered as time blocks
- **Week view** (default): 7 columns (Mon–Sun), hourly rows, meetings as colored blocks
- **Month view**: Grid of days, meetings as small dots or count badges per day

**Component structure:**
```
app/workspace/closer/_components/
├── calendar-view.tsx             ← Main calendar component (manages state, view mode)
├── calendar-header.tsx           ← Navigation: ← Today → | Day | Week | Month toggle
├── week-view.tsx                 ← 7-column grid with time slots
├── day-view.tsx                  ← Single column with hourly slots
├── month-view.tsx                ← Month grid with meeting count badges
└── meeting-block.tsx             ← Individual meeting block (colored, clickable)
```

**Meeting block content:**
- Lead name (truncated if long)
- Time: "2:30 PM – 3:00 PM"
- Status color:
  - Scheduled: blue (`bg-blue-100 border-blue-400`)
  - In Progress: yellow (`bg-yellow-100 border-yellow-400`)
  - Completed: green (`bg-green-100 border-green-400`)
  - Canceled: gray (`bg-gray-100 border-gray-400`, strikethrough text)
  - No Show: orange (`bg-orange-100 border-orange-400`)

```typescript
// app/workspace/closer/_components/calendar-view.tsx
"use client";

import { useState, useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { CalendarHeader } from "./calendar-header";
import { WeekView } from "./week-view";
import { DayView } from "./day-view";
import { MonthView } from "./month-view";

type ViewMode = "day" | "week" | "month";

export function CalendarView() {
  const [viewMode, setViewMode] = useState<ViewMode>("week");
  const [currentDate, setCurrentDate] = useState(new Date());

  // Calculate date range based on view mode
  const { startDate, endDate } = useMemo(() => {
    const start = new Date(currentDate);
    const end = new Date(currentDate);

    if (viewMode === "day") {
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
    } else if (viewMode === "week") {
      const dayOfWeek = start.getDay();
      start.setDate(start.getDate() - dayOfWeek); // Start of week (Sunday)
      start.setHours(0, 0, 0, 0);
      end.setDate(start.getDate() + 7);
      end.setHours(0, 0, 0, 0);
    } else {
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      end.setMonth(end.getMonth() + 1, 1);
      end.setHours(0, 0, 0, 0);
    }

    return { startDate: start.getTime(), endDate: end.getTime() };
  }, [currentDate, viewMode]);

  const meetings = useQuery(api.closer.calendar.getMeetingsForRange, {
    startDate,
    endDate,
  });

  return (
    <div className="space-y-4">
      <CalendarHeader
        currentDate={currentDate}
        viewMode={viewMode}
        onDateChange={setCurrentDate}
        onViewModeChange={setViewMode}
      />

      {meetings === undefined ? (
        <CalendarSkeleton viewMode={viewMode} />
      ) : viewMode === "day" ? (
        <DayView meetings={meetings} date={currentDate} />
      ) : viewMode === "week" ? (
        <WeekView meetings={meetings} startDate={new Date(startDate)} />
      ) : (
        <MonthView meetings={meetings} month={currentDate} />
      )}
    </div>
  );
}
```

**Frontend design guidelines to follow:**
- **No third-party calendar library** — build with CSS Grid for the week/month grids and shadcn `Card`/`Button` for meeting blocks.
- The week view should use a `grid-template-columns: 60px repeat(7, 1fr)` layout — first column for time labels, 7 columns for days.
- Meeting blocks should be positioned absolutely within their day column based on `scheduledAt` and `durationMinutes`.
- Use `next/link` on each meeting block to navigate to `/workspace/closer/meetings/[meetingId]` (Phase 6).
- The calendar header should have clear navigation: left/right arrows to move dates, "Today" button to jump to current date, view mode toggle (Day/Week/Month).
- Follow `vercel-react-best-practices`: the `startDate`/`endDate` calculation is memoized to prevent unnecessary re-queries when the component re-renders.
- Follow `web-design-guidelines`: calendar grid cells should be keyboard-navigable, meeting blocks should have `aria-label` with full meeting details.

**Files touched:** `app/workspace/closer/_components/calendar-view.tsx` (create), `app/workspace/closer/_components/calendar-header.tsx` (create), `app/workspace/closer/_components/week-view.tsx` (create), `app/workspace/closer/_components/day-view.tsx` (create), `app/workspace/closer/_components/month-view.tsx` (create), `app/workspace/closer/_components/meeting-block.tsx` (create)

---

### 5F — Closer Pipeline List Page

**Type:** Frontend
**Parallelizable:** Depends on 5C (opportunity list query). Can start with mock data.

**What:** Build the closer's pipeline page showing their opportunities in a filterable, sortable table with status tabs and quick actions.

**Why:** While the dashboard pipeline strip shows counts, this page shows the actual opportunities. Closers use it to review their full workload, track follow-ups, and quickly navigate to meeting details.

**Where:** `app/workspace/closer/pipeline/page.tsx`, `app/workspace/closer/pipeline/_components/` (new component files)

**How:**

**Component structure:**
```
app/workspace/closer/pipeline/
├── page.tsx                          ← Pipeline page (tabs + table)
└── _components/
    ├── status-tabs.tsx               ← Filter tabs: All | Scheduled | In Progress | etc.
    ├── opportunity-table.tsx         ← DataTable: Lead, Status, Meeting Date, Actions
    └── opportunity-row.tsx           ← Individual row with lead info + quick actions
```

**Status tabs:**
- All (default) | Scheduled | In Progress | Follow-up | Won | Lost | Canceled | No Show
- Active tab highlighted, count shown in badge

**Table columns:**

| Column | Source | Notes |
|---|---|---|
| Lead | `leadName` + `leadEmail` | Name bold, email below in muted text |
| Status | `status` | Color-coded badge (reuse status-badge from Phase 4F) |
| Next Meeting | `latestMeetingAt` | Formatted date, relative time ("in 2 hours") |
| Created | `createdAt` | Relative time ("3 days ago") |
| Actions | — | "View Meeting" button → `/workspace/closer/meetings/[meetingId]` |

```typescript
// app/workspace/closer/pipeline/page.tsx
"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { useSearchParams } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { StatusTabs } from "./_components/status-tabs";
import { OpportunityTable } from "./_components/opportunity-table";

export default function CloserPipelinePage() {
  const searchParams = useSearchParams();
  const initialStatus = searchParams.get("status") ?? undefined;
  const [statusFilter, setStatusFilter] = useState<string | undefined>(initialStatus);

  const opportunities = useQuery(api.closer.pipeline.listMyOpportunities, {
    statusFilter,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">My Pipeline</h1>
        <p className="text-muted-foreground">
          Track your opportunities and meeting outcomes
        </p>
      </div>

      <StatusTabs
        activeStatus={statusFilter}
        onStatusChange={setStatusFilter}
      />

      {opportunities === undefined ? (
        <TableSkeleton />
      ) : opportunities.length === 0 ? (
        <EmptyPipelineState status={statusFilter} />
      ) : (
        <OpportunityTable opportunities={opportunities} />
      )}
    </div>
  );
}
```

**Frontend design guidelines to follow:**
- Use shadcn `Tabs` for status filtering — each tab shows the status name and count.
- Use shadcn `Table` for the opportunity list — clean, accessible, responsive.
- "View Meeting" button uses `Link` from `next/link` for client-side navigation.
- URL query params (`?status=scheduled`) are synced with the tab state so the pipeline strip on the dashboard can link directly to a filtered view.
- Follow `vercel-composition-patterns`: the status tabs and table are separate components that communicate via props (lifted state pattern).
- Follow `web-design-guidelines`: table headers should be `<th>` with proper scope, rows should be keyboard-navigable with tab.
- Empty state should be context-aware: "No scheduled opportunities" vs "No lost opportunities" based on the active filter.

**Files touched:** `app/workspace/closer/pipeline/page.tsx` (create), `app/workspace/closer/pipeline/_components/status-tabs.tsx` (create), `app/workspace/closer/pipeline/_components/opportunity-table.tsx` (create), `app/workspace/closer/pipeline/_components/opportunity-row.tsx` (create)

---

## Parallelization Summary

```
Phase 1 + Phase 3 Complete
  │
  ├── 5A (closer dashboard queries) ──────────────┐
  ├── 5B (calendar range query) ──────────────────┤  All 3 backend subphases
  └── 5C (opportunity list query) ────────────────┤  run in PARALLEL
                                                   │
  After backend subphases complete:                │
  ├── 5D (closer dashboard page) ─────────────────┤
  ├── 5E (calendar view component) ───────────────┤  All 3 frontend subphases
  └── 5F (closer pipeline page) ──────────────────┘  run in PARALLEL
```

**Optimal execution:**
1. Start 5A, 5B, 5C all in parallel (backend).
2. Once all backend subphases are done → start 5D, 5E, 5F all in parallel (frontend).
3. Frontend subphases can start with mock data before backend completes.

**Estimated time:** 3–5 days (calendar view is the most complex component)

---

## Files Modified/Created Summary

| File | Action | Subphase |
|---|---|---|
| `convex/closer/dashboard.ts` | Created (getNextMeeting, getPipelineSummary, getCloserProfile) | 5A |
| `convex/closer/calendar.ts` | Created (getMeetingsForRange) | 5B |
| `convex/closer/pipeline.ts` | Created (listMyOpportunities) | 5C |
| `app/workspace/closer/page.tsx` | Created (closer dashboard) | 5D |
| `app/workspace/closer/_components/unmatched-banner.tsx` | Created | 5D |
| `app/workspace/closer/_components/featured-meeting-card.tsx` | Created | 5D |
| `app/workspace/closer/_components/pipeline-strip.tsx` | Created | 5D |
| `app/workspace/closer/_components/empty-state.tsx` | Created | 5D |
| `app/workspace/closer/_components/calendar-view.tsx` | Created | 5E |
| `app/workspace/closer/_components/calendar-header.tsx` | Created | 5E |
| `app/workspace/closer/_components/week-view.tsx` | Created | 5E |
| `app/workspace/closer/_components/day-view.tsx` | Created | 5E |
| `app/workspace/closer/_components/month-view.tsx` | Created | 5E |
| `app/workspace/closer/_components/meeting-block.tsx` | Created | 5E |
| `app/workspace/closer/pipeline/page.tsx` | Created | 5F |
| `app/workspace/closer/pipeline/_components/status-tabs.tsx` | Created | 5F |
| `app/workspace/closer/pipeline/_components/opportunity-table.tsx` | Created | 5F |
| `app/workspace/closer/pipeline/_components/opportunity-row.tsx` | Created | 5F |

---

*End of Phase 5. This phase runs in PARALLEL with Phase 4. Next: Phase 6 (Meeting Detail Page & Outcome Actions) — depends on Phase 5.*
