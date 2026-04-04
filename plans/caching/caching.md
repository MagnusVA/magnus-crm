# Convex Caching Analysis — ptdom-crm

> Generated 2026-04-03. Based on source code review of all `convex/` query
> functions and every frontend `useQuery`/`usePaginatedQuery` call site.

---

## How Convex Caching Works (Context)

Convex caches **query function** results based on three things:

1. **The function** being called
2. **Its arguments**
3. **The data it reads** from the database

When *any* underlying document that a query read changes, the cache is
**automatically invalidated** and the query re-executes. This means Convex
caching is always **consistent with respect to data** — but **not consistent
with respect to time**.

**`Date.now()` is not a tracked dependency.** If a query calls `Date.now()` to
filter or compute results, Convex has no way to know that the passage of time
should invalidate the cache. The query only re-runs when the *data it reads*
changes. This is the #1 source of caching bugs in this codebase.

### What is NOT an issue

**Identity-based queries** (`getCurrentUser`, `getCurrentTenant`) with `args: {}`
are safe. Convex maintains per-client subscriptions tied to each client's auth
token. When a user logs out and another logs in, the Convex client reconnects
with a new token and all subscriptions are re-established. There is no cross-user
cache pollution.

---

## Inventory: All Public Query Subscriptions

| Query Function | File | Frontend Subscription Sites | Args |
|---|---|---|---|
| `getCurrentUser` | `convex/users/queries.ts:10` | `workspace/layout.tsx`, `workspace/page.tsx`, `workspace/settings/page.tsx`, `workspace/team/page.tsx`, `workspace/pipeline/page.tsx` | `{}` |
| `getCurrentTenant` | `convex/tenants.ts` | `onboarding/connect/page.tsx`, `page.tsx` | `{}` |
| `getAdminDashboardStats` | `convex/dashboard/adminStats.ts:23` | `workspace/page.tsx:66` | `{}` |
| `getNextMeeting` | `convex/closer/dashboard.ts:13` | `workspace/closer/page.tsx:31` | `{}` |
| `getPipelineSummary` | `convex/closer/dashboard.ts:85` | `workspace/closer/page.tsx:32`, `workspace/closer/pipeline/page.tsx:66` | `{}` |
| `getCloserProfile` | `convex/closer/dashboard.ts:128` | `workspace/closer/page.tsx:30` | `{}` |
| `listOpportunitiesForAdmin` | `convex/opportunities/queries.ts:44` | `workspace/pipeline/page.tsx:61` | `{statusFilter?, assignedCloserId?}` |
| `listTeamMembers` | `convex/users/queries.ts:120` | `workspace/team/page.tsx:34`, `workspace/pipeline/page.tsx:67` | `{}` |
| `listUnmatchedCalendlyMembers` | `convex/users/queries.ts:158` | `workspace/team/invite-user-dialog.tsx`, `workspace/team/calendly-link-dialog.tsx` | `{}` |
| `getConnectionStatus` | `convex/calendly/oauthQueries.ts:8` | `workspace/_components/system-health.tsx:41`, `workspace/settings/page.tsx:58` | `{}` |
| `getMeetingsForRange` | `convex/closer/calendar.ts:15` | `workspace/closer/_components/calendar-view.tsx:61` | `{startDate, endDate}` |
| `getMeetingDetail` | `convex/closer/meetingDetail.ts:26` | `workspace/closer/meetings/[meetingId]/page.tsx:47` | `{meetingId}` |
| `listMyOpportunities` | `convex/closer/pipeline.ts:23` | `workspace/closer/pipeline/page.tsx:67` | `{statusFilter?}` |
| `listEventTypeConfigs` | `convex/eventTypeConfigs/queries.ts` | `workspace/settings/page.tsx:54` | `{}` |
| `getPaymentProofUrl` | `convex/closer/payments.ts:151` | payment form dialogs | `{paymentRecordId}` |
| `listTenants` | `convex/admin/tenantsQueries.ts` | `admin/page.tsx:86` (paginated) | `{statusFilter?, paginationOpts}` |

**Zero `convex.query()` one-shot calls exist.** Every query is a standing
reactive subscription via `useQuery()`.

---

## 🔴 CRITICAL: Queries Using `Date.now()` (Time-Dependent Cache Bugs)

These queries produce results that depend on the current time, but Convex cannot
track time as a dependency. The cached result **will go stale** when time
passes unless an unrelated data write happens to trigger re-execution.

---

### 1. `getAdminDashboardStats` — Dashboard Stats with "Meetings Today"

**File:** `convex/dashboard/adminStats.ts:23-112`  
**Frontend:** `app/workspace/page.tsx:66` via `useQuery()`

**The problem (line 64):**

```typescript
const { startOfDay, endOfDay } = getStartAndEndOfToday(Date.now());
let meetingsToday = 0;
for await (const _meeting of ctx.db
  .query("meetings")
  .withIndex("by_tenantId_and_scheduledAt", (q) =>
    q.eq("tenantId", tenantId)
     .gte("scheduledAt", startOfDay)
     .lt("scheduledAt", endOfDay)
  )) {
  meetingsToday += 1;
}
```

**What goes wrong:** At midnight, `startOfDay` / `endOfDay` should shift to the
new day. But the cached result was computed with yesterday's boundaries. If no
meeting or user or opportunity or payment record is written, the cache persists
and **`meetingsToday` shows yesterday's count** until any tenant data changes.

**Additional cost concern:** This query also performs 4 full-table scans per
tenant (users, opportunities, meetings-today, paymentRecords). Every write to
*any* of those tables for the tenant triggers a full re-execution of all 4 scans.

**Severity:** 🔴 Critical — stale time-based data + expensive re-execution

**Fix:** Convert to a one-shot fetch with a manual polling interval on the
frontend. This avoids the standing subscription overhead and ensures freshness
on a predictable schedule:

```typescript
// Frontend — poll every 60 seconds instead of reactive subscription
const convex = useConvex();
const [stats, setStats] = useState<AdminStats | null>(null);

useEffect(() => {
  let cancelled = false;
  const fetch = async () => {
    const result = await convex.query(
      api.dashboard.adminStats.getAdminDashboardStats, {}
    );
    if (!cancelled) setStats(result);
  };
  fetch();
  const interval = setInterval(fetch, 60_000);
  return () => { cancelled = true; clearInterval(interval); };
}, [convex]);
```

Alternatively, pre-compute stats at write time into a `tenantStats` table
updated by mutations, and subscribe to that single document instead of scanning
4 tables.

---

### 2. `getNextMeeting` — Closer's Next Upcoming Meeting

**File:** `convex/closer/dashboard.ts:13-77`  
**Frontend:** `app/workspace/closer/page.tsx:31` via `useQuery()`

**The problem (line 18 + line 42):**

```typescript
const now = Date.now();
// ...
const upcomingMeetings = ctx.db
  .query("meetings")
  .withIndex("by_tenantId_and_scheduledAt", (q) =>
    q.eq("tenantId", tenantId).gte("scheduledAt", now)
  );
```

**What goes wrong:** Suppose a closer has a meeting at 2:00 PM. The query is
cached showing that meeting as "next." At 2:01 PM, the meeting has passed — but
because no data was written, the cache persists. The closer still sees the
2:00 PM meeting as their "next" meeting, complete with a stale countdown timer
and a "Join Zoom" button for a meeting that already started.

The cached result only refreshes when *any* meeting in the tenant is written
(new booking, status change, etc.). In low-activity periods this could be hours.

**Severity:** 🔴 Critical — directly affects the closer's primary workflow
surface. A stale "next meeting" card with a defunct Zoom link is a bad UX.

**Fix:** One-shot fetch with polling, or accept the subscription but add a
client-side timer that refetches when the meeting's `scheduledAt` is reached:

```typescript
// Option A: Poll every 60 seconds
const convex = useConvex();
const [nextMeeting, setNextMeeting] = useState(null);

useEffect(() => {
  let cancelled = false;
  const fetch = async () => {
    const result = await convex.query(api.closer.dashboard.getNextMeeting, {});
    if (!cancelled) setNextMeeting(result);
  };
  fetch();
  const interval = setInterval(fetch, 60_000);
  return () => { cancelled = true; clearInterval(interval); };
}, [convex]);

// Option B: Keep useQuery but add a refetch at meeting time
// (Convex doesn't support manual refetch, so Option A is simpler)
```

---

### 3. `listOpportunitiesForAdmin` — Pipeline Table with "Next Meeting"

**File:** `convex/opportunities/queries.ts:44-197`  
**Frontend:** `app/workspace/pipeline/page.tsx:61` via `useQuery()`

**The problem (line 142 + lines 168-173):**

```typescript
const now = Date.now();
// For each opportunity, scan all its meetings:
for await (const meeting of ctx.db.query("meetings")
  .withIndex("by_opportunityId", (q) =>
    q.eq("opportunityId", opportunity._id))) {
  // ...
  if (meeting.scheduledAt >= now &&
      (nextMeeting === null || meeting.scheduledAt < nextMeeting.scheduledAt)) {
    nextMeeting = meeting;
  }
}
```

**What goes wrong:** The `nextMeeting` field on each enriched opportunity
compares `scheduledAt >= now`. As time passes, meetings that are in the past
continue to show as "next" in the pipeline table until a write occurs.

**Additional cost concern:** This query is O(opportunities × meetings). For each
opportunity, it iterates *all* meetings to find the latest and next. If a tenant
has 200 opportunities averaging 2 meetings each, that's 400+ document reads per
subscription evaluation — triggered by *any* write to opportunities, meetings,
leads, users, or eventTypeConfigs for the tenant.

**Severity:** 🔴 Critical — stale time data + expensive O(N×M) reads

**Fix (two-part):**

1. **Remove `Date.now()` from the query.** Return `latestMeeting` and
   `nextScheduledMeeting` (the soonest meeting with status `"scheduled"`) without
   a time comparison. Let the frontend compute whether it's in the past.

2. **Denormalize latest/next meeting IDs onto the opportunity document.** Update
   these fields in the mutations that create/update meetings. This eliminates the
   per-opportunity meeting scan entirely.

---

## 🟠 HIGH: Expensive Aggregation Queries Under Reactive Subscriptions

These queries are correctly cached (no `Date.now()` issue), but their read
amplification means every data write triggers an expensive re-scan.

---

### 4. `getMeetingDetail` — Full Lead History on a Detail Page

**File:** `convex/closer/meetingDetail.ts:26-136`  
**Frontend:** `app/workspace/closer/meetings/[meetingId]/page.tsx:47`

**The cost (lines 64-84):**

```typescript
// Load ALL opportunities for this lead
for await (const leadOpportunity of ctx.db
  .query("opportunities")
  .withIndex("by_tenantId_and_leadId", (q) =>
    q.eq("tenantId", tenantId).eq("leadId", opportunity.leadId))) {

  // For EACH opportunity, load ALL its meetings
  for await (const historicalMeeting of ctx.db
    .query("meetings")
    .withIndex("by_opportunityId", (q) =>
      q.eq("opportunityId", leadOpportunity._id))) {
    meetingHistory.push({ ...historicalMeeting, opportunityStatus, isCurrentMeeting });
  }
}
```

**Read cost:** O(lead_opportunities × meetings_per_opportunity). A returning
lead with 5 opportunities and 3 meetings each = 20+ document reads just for the
history section, plus the meeting, opportunity, lead, eventTypeConfig, closer,
and payment records.

**Why this is cached badly:** This is a *detail page* for viewing a single
meeting. The user navigates here, looks at the data, and typically leaves.
Meanwhile, the reactive subscription keeps this expensive query alive. Any write
to *any* meeting, opportunity, or payment record for this lead's tenant triggers
a full re-evaluation.

**Severity:** 🟠 High — unnecessary subscription cost for a read-once page

**Fix:** Convert to a one-shot fetch. A meeting detail page doesn't need
real-time reactivity for the history section:

```typescript
// Frontend — one-shot fetch instead of subscription
const convex = useConvex();
const [detail, setDetail] = useState(null);

useEffect(() => {
  convex.query(api.closer.meetingDetail.getMeetingDetail, { meetingId })
    .then(setDetail);
}, [meetingId, convex]);
```

If real-time updates on the *current* meeting are needed (e.g., notes being
saved), split into two queries: a lightweight `getMeeting` subscription for the
current meeting, and a one-shot `getMeetingHistory` for the history.

---

### 5. `getMeetingsForRange` — Calendar View with Enrichment

**File:** `convex/closer/calendar.ts:15-86`  
**Frontend:** `app/workspace/closer/_components/calendar-view.tsx:61`

**The cost (lines 66-81):**

```typescript
const enriched = await Promise.all(
  myMeetings.map(async (meeting) => {
    const opp = oppMap.get(meeting.opportunityId.toString());
    const lead = opp ? await ctx.db.get(opp.leadId) : null;
    const eventTypeConfig =
      opp?.eventTypeConfigId ? await ctx.db.get(opp.eventTypeConfigId) : null;
    return { meeting, leadName, leadEmail, opportunityStatus, eventTypeName };
  })
);
```

**Read cost:** For each meeting in the range: 1 lead read + 1 eventTypeConfig
read. A week view with 15 meetings = 30 extra document reads. Plus the initial
scan of all closer's opportunities + all tenant meetings in the range.

**Mitigating factor:** The `startDate`/`endDate` args are well-memoized in the
`CalendarView` component (line 42-59), so the subscription only updates when the
user navigates to a new period. This is correct usage.

**Severity:** 🟡 Medium — acceptable for week/day view, but month view with 40+
meetings becomes expensive

**Fix:** Denormalize `leadName` and `eventTypeName` onto the meeting or
opportunity document at write time. This eliminates the per-meeting enrichment
reads entirely.

---

### 6. `listTeamMembers` — Double Table Scan for Enrichment

**File:** `convex/users/queries.ts:120-150`  
**Frontend:** `workspace/team/page.tsx:34`, `workspace/pipeline/page.tsx:67`

**The cost (lines 127-138):**

```typescript
// Scan 1: all users in tenant
for await (const user of ctx.db.query("users")
  .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
  users.push(user);
}

// Scan 2: all calendlyOrgMembers in tenant (just for name lookup)
for await (const member of ctx.db.query("calendlyOrgMembers")
  .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
  memberNameByUri.set(member.calendlyUserUri, member.name);
}
```

**Severity:** 🟡 Medium — two full table scans, but team/org-member tables are
typically small (< 50 rows)

**Fix:** Denormalize `calendlyMemberName` onto the `users` table when a closer
is linked to a Calendly member (in `linkCloserToCalendlyMember` mutation). This
eliminates the second scan entirely.

---

## 🟡 MEDIUM: Internal Queries with `Date.now()` (Cron Context)

These internal queries use `Date.now()` but are called from cron jobs, not
frontend subscriptions. The caching behavior matters less because they're invoked
on a schedule, not as standing subscriptions.

### 7. `listStuckProvisioningTenants`

**File:** `convex/calendly/healthCheckMutations.ts:6-36`  
**Cron:** `crons.ts:13` — runs every 24 hours

```typescript
const cutoff = Date.now() - PROVISIONING_TIMEOUT_MS; // 10 minutes
```

**Risk:** Low. Called by cron every 24h. Even if the result is cached between
cron runs, the cron triggers a fresh execution.

### 8. `listExpiredInvites`

**File:** `convex/admin/inviteCleanupMutations.ts:10-37`  
**Cron:** `crons.ts:34` — runs every 24 hours

```typescript
const cutoff = Date.now() - GRACE_PERIOD_MS; // 14 days
```

**Risk:** Low. Same reasoning as above. 24h cron interval is appropriate for a
14-day grace period.

---

## ✅ GOOD: Queries That Are Correctly Cached

These queries benefit from reactive caching and have no `Date.now()` issues:

| Query | Why Caching Is Correct |
|---|---|
| `getCurrentUser` | Auth-context scoped; invalidated on user data change; used in 5 components for role checks |
| `getCurrentTenant` | Auth-context scoped; invalidated on tenant data change |
| `getCloserProfile` | Single document read by ID; cheap; invalidated when user updates |
| `getPipelineSummary` | Status counts update reactively when opportunity status changes; cheap iteration |
| `listMyOpportunities` | Properly indexed; enrichment is bounded by closer's opportunities (typically < 50) |
| `listEventTypeConfigs` | Small table; tenant-scoped index; admin-only page |
| `listUnmatchedCalendlyMembers` | Indexed on `matchedUserId = undefined`; reactive when members are linked |
| `getConnectionStatus` | Single document read; updates reactively when token refresh mutations run |
| `getPaymentProofUrl` | Single document + storage URL; per-payment-record ID; cheap |
| `listTenants` (admin) | Paginated; system admin only; low frequency |

---

## ⚠️ NOTE: Frontend `Date.now()` in Render (Not a Caching Issue)

**File:** `app/workspace/_components/system-health.tsx:21-38`

```typescript
function formatRelativeTime(timestamp: number) {
  const hours = Math.floor((Date.now() - timestamp) / (60 * 60 * 1000));
  // ...
}
function formatExpiry(timestamp: number) {
  const days = Math.floor((timestamp - Date.now()) / (24 * 60 * 60 * 1000));
  // ...
}
```

This is client-side display formatting, not a Convex query. It updates on
re-render but doesn't affect the Convex cache. However, the displayed "Token
expires: Today" / "Last refresh: 2 hours ago" text can go stale if the component
doesn't re-render. This is a standard React staleness issue, not a Convex issue.

---

## Summary: What Should NOT Be Cached (Action Items)

| # | Query | Problem | Fix | Priority |
|---|---|---|---|---|
| 1 | `getAdminDashboardStats` | `Date.now()` on line 64 + 4 full-table scans | One-shot fetch with 60s polling; or pre-computed stats table | 🔴 Critical |
| 2 | `getNextMeeting` | `Date.now()` on line 18; stale "next meeting" after it passes | One-shot fetch with 60s polling; or client-side timer-based refetch | 🔴 Critical |
| 3 | `listOpportunitiesForAdmin` | `Date.now()` on line 142 + O(N×M) reads | Remove time comparison; denormalize latest/next meeting onto opportunity | 🔴 Critical |
| 4 | `getMeetingDetail` | O(opps × meetings) history; subscription on read-once page | One-shot fetch; or split into current-meeting subscription + history one-shot | 🟠 High |
| 5 | `getMeetingsForRange` | Per-meeting enrichment reads (lead + eventType) | Denormalize `leadName`/`eventTypeName` onto meetings at write time | 🟡 Medium |
| 6 | `listTeamMembers` | Double table scan for Calendly name enrichment | Denormalize `calendlyMemberName` onto users table | 🟡 Medium |

---

## Implementation Plan

### Phase 1 — Fix `Date.now()` Bugs (Critical)

**Goal:** Eliminate stale time-dependent results.

#### 1a. `getNextMeeting` → one-shot fetch + polling

```typescript
// app/workspace/closer/page.tsx
import { useConvex } from "convex/react";

const convex = useConvex();
const [nextMeeting, setNextMeeting] = useState<NextMeetingResult | null>(null);
const [isLoading, setIsLoading] = useState(true);

useEffect(() => {
  let cancelled = false;
  const fetch = async () => {
    try {
      const result = await convex.query(api.closer.dashboard.getNextMeeting, {});
      if (!cancelled) {
        setNextMeeting(result);
        setIsLoading(false);
      }
    } catch (e) {
      console.error("Failed to fetch next meeting", e);
    }
  };
  fetch();
  const interval = setInterval(fetch, 60_000); // Refresh every minute
  return () => { cancelled = true; clearInterval(interval); };
}, [convex]);
```

#### 1b. `getAdminDashboardStats` → one-shot fetch + polling

Same pattern as 1a. Poll every 60 seconds. The dashboard is a summary view
that doesn't need sub-second reactivity.

#### 1c. `listOpportunitiesForAdmin` → remove `Date.now()` from query

```typescript
// convex/opportunities/queries.ts — change the enrichment loop
// BEFORE:
const now = Date.now();
if (meeting.scheduledAt >= now && ...) { nextMeeting = meeting; }

// AFTER: Return the soonest "scheduled" status meeting without time check
if (meeting.status === "scheduled" &&
    (nextMeeting === null || meeting.scheduledAt < nextMeeting.scheduledAt)) {
  nextMeeting = meeting;
}
```

The frontend can then check `nextMeeting.scheduledAt > Date.now()` to decide
display styling. This keeps the query deterministic (only depends on data, not
time) while the UI handles the time-sensitive presentation.

### Phase 2 — Reduce Read Amplification (High)

#### 2a. `getMeetingDetail` → one-shot fetch

Convert the frontend from `useQuery` to `convex.query()` one-shot. If real-time
updates on notes/status are needed, split into:
- `useQuery(api.closer.meeting.getCurrent, { meetingId })` — lightweight, single doc
- `convex.query(api.closer.meeting.getHistory, { meetingId })` — one-shot, heavy

#### 2b. Denormalize `latestMeetingId` / `nextMeetingId` onto opportunities

Update the mutations that create/update meetings to also patch the parent
opportunity with the latest/next meeting reference. This eliminates the
per-opportunity meeting scan in `listOpportunitiesForAdmin`.

### Phase 3 — Denormalization (Medium)

#### 3a. Add `calendlyMemberName` to users table

In `linkCloserToCalendlyMember` mutation, copy the Calendly member's name onto
the user document. Update `listTeamMembers` to use it directly.

#### 3b. Add `leadName` to meetings table (or opportunity)

When a meeting is created in the pipeline processor, copy `lead.fullName` or
`lead.email` onto the meeting doc. Update `getMeetingsForRange` to use it
directly instead of fetching the lead per meeting.

---

## Checklist

- [ ] Convert `getNextMeeting` subscription to one-shot fetch + 60s polling
- [ ] Convert `getAdminDashboardStats` subscription to one-shot fetch + 60s polling
- [ ] Remove `Date.now()` from `listOpportunitiesForAdmin`; use status-based "next meeting" instead
- [ ] Convert `getMeetingDetail` to one-shot fetch on the detail page
- [ ] Denormalize `latestMeetingId`/`nextMeetingId` onto opportunity documents
- [ ] Denormalize `calendlyMemberName` onto user documents
- [ ] Denormalize `leadName` onto meeting documents
- [ ] Consider pre-computed `tenantStats` table for dashboard (long-term)
