# v0.6 — Admin Reporting & Analytics

> **Design proposal for team-level sales reporting.** Replaces the manual Excel tracking sheet (PT DOM) with real-time, aggregated analytics built on top of the CRM data model established in v0.5b. Scoped to `tenant_master` and `tenant_admin` roles only — closer-facing reporting is deferred to v0.7.

| Field | Value |
| --- | --- |
| **Status** | Design Proposal |
| **Date** | 2026-04-12 |
| **Depends on** | v0.5b (database audit) — all schema changes from that version are assumed deployed |
| **Data source** | `.docs/reports/current-manual-reports.md` (analysis of `SALESTEAMREPORT2026-PTDOM.xlsx`) |
| **Current footprint** | 1 tenant, ~8 closers, ~200 leads, 213 meetings, 213 opportunities, ~50 payments |
| **Key dependency** | [`@convex-dev/aggregate`](https://www.convex.dev/components/aggregate) v0.2.1 — write-time denormalized aggregation component |
| **Target** | Production-ready admin reporting that fully replaces the manual Excel workflow |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [Current State Analysis](#3-current-state-analysis)
4. [Data Mapping: Manual Report → CRM](#4-data-mapping-manual-report--crm)
5. [Architecture Decisions](#5-architecture-decisions)
6. [Schema & Component Changes](#6-schema--component-changes)
7. [Aggregate Integration Map](#7-aggregate-integration-map)
8. [Core Reporting Queries (Drafts)](#8-core-reporting-queries-drafts)
9. [KPI Catalog](#9-kpi-catalog)
10. [Frontend Routes & Components](#10-frontend-routes--components)
11. [Implementation Phases](#11-implementation-phases)
12. [Risk & Constraints](#13-risk--constraints)
13. [Success Criteria](#14-success-criteria)

---

## 1. Executive Summary

The sales team currently tracks all call outcomes, closer performance, and revenue in a manually maintained Google Sheet (`SALESTEAMREPORT2026-PTDOM.xlsx`). This workbook contains ~2,360 raw transaction rows across 14 sheets, with per-closer KPI tables split by "New Calls" vs "Follow Up Calls."

**The CRM already captures 95% of this data organically** through the Calendly webhook pipeline (`invitee.created`, `invitee.canceled`, `invitee_no_show`), meeting lifecycle tracking, and payment recording. The one significant gap is **call classification** — distinguishing whether a meeting is a lead's first interaction ("new call") or a subsequent booking ("follow-up call"). This requires a single schema addition and a pipeline update.

**Approach**: Write-time denormalized aggregation via the [`@convex-dev/aggregate`](https://www.convex.dev/components/aggregate) Convex component. Five aggregate instances maintain O(log n) counts and sums, synced atomically with every mutation that writes to `meetings`, `paymentRecords`, `opportunities`, `leads`, or `customers`. Reporting queries read from these aggregates — never scan source tables — enabling **reactive real-time dashboards** via standard `useQuery` subscriptions.

**Leveraging v0.5b infrastructure**: Beyond the aggregate-powered KPIs, v0.6 also consumes two v0.5b tables that are already populated with data but currently have no read-side consumers:

- **`domainEvents`** — the append-only audit trail (25 emission sites across 17 mutations) powers a new **Activity Feed** report, giving admins visibility into who did what and when. Queries use existing indexes — no additional aggregate instances needed.
- **`meetingFormResponses`** + **`eventTypeFieldCatalog`** — per-meeting booking answer facts (backfilled from raw webhooks) power a new **Booking Form Insights** section on the Leads & Conversions report, showing answer distributions across all bookings. These are insights the Excel cannot provide.

This replaces the naive alternative (scanning ~800 meetings per monthly report in O(n) actions) with an architecture that:

- Scales to any data volume without hitting transaction limits
- Enables live-updating reports (no "click to generate" UX)
- Requires no custom delta/sync logic — the component handles the data structure
- Stays in sync atomically (Convex mutations are transactions)
- Extracts full value from the v0.5b data model investment (42 KPIs across 5 report pages, up from the original 35 across 4)

---

## 2. Goals & Non-Goals

### Goals

1. **Replace the manual Excel report** — every KPI in the PT DOM workbook must be computable from CRM data
2. **Per-closer performance** — booked calls, cancellations, no-shows, show-up rate, sales, cash collected, close rate, average deal size
3. **New vs Follow-Up split** — separate metrics for first-time meetings vs return bookings (matching the Excel's two-table layout)
4. **Flexible time filtering** — day, week, month, custom date range
5. **Team totals** — aggregated row across all closers
6. **Real-time reactive dashboards** — reports update live as data flows in (via `useQuery`, not one-shot actions)
7. **Additional KPIs** — metrics the Excel can't compute (pipeline velocity, meeting outcome distribution, lead conversion, follow-up efficiency)
8. **Admin-only access** — `tenant_master` and `tenant_admin` roles; enforced server-side
9. **Activity visibility** — admin-facing audit trail showing who did what and when, powered by the `domainEvents` table (v0.5b)
10. **Booking form insights** — answer distribution analytics from Calendly form responses, powered by `meetingFormResponses` (v0.5b)

### Non-Goals (v0.6)

- Closer-facing reporting (deferred to v0.7)
- Export to CSV/PDF (deferred)
- Scheduled email reports
- Comparison views (month-over-month overlays)
- Historical data import from the Excel workbook

---

## 3. Current State Analysis

### What we already have

| Data Point (from Excel) | CRM Source | How It's Captured |
| --- | --- | --- |
| **Booked Calls** | `meetings` table | Each Calendly booking creates a `meetings` row via `invitee.created` webhook |
| **Cancelled Calls** | `meetings.status = "canceled"` | Set by `invitee.canceled` webhook handler |
| **No Shows** | `meetings.status = "no_show"` | Set by `invitee_no_show.created` webhook or closer action |
| **Calls Showed** | `meetings.status ∈ {"in_progress", "completed"}` | Set by closer "Start Meeting" action or meeting completion |
| **Sales** | `paymentRecords` linked to meeting | Created by `logPayment` mutation; count of payment records |
| **Cash Collected** | `paymentRecords.amountMinor` | Sum of payment amounts (integer cents) |
| **Phone Closer** | `meetings.assignedCloserId` → `users` | Denormalized on meeting creation from opportunity assignment |
| **Date** | `meetings.scheduledAt` | Epoch ms from Calendly booking start time |
| **Status** | Derived (see Section 4) | Combination of meeting status, opportunity status, meeting outcome |
| **Lead Email** | `leads.email` via `opportunities.leadId` | Extracted from Calendly invitee payload |
| **Lead Username** | `leadIdentifiers` (type = social handle) | Extracted from Calendly custom fields |

### What we're missing

| Gap | Impact | Solution |
| --- | --- | --- |
| **Call classification (new vs follow-up)** | Cannot split metrics into the two tables the Excel uses | Add `callClassification` field to `meetings` schema; set at pipeline creation time |
| **"Rescheduled" as distinct outcome** | Excel tracks rescheduled calls separately from other statuses | Derivable: a meeting is "rescheduled" if another meeting references it via `rescheduledFromMeetingId` |
| **"Overran" status** | Excel tracks meetings that exceeded scheduled duration | **New feature required**: add "End Meeting" action that records `stoppedAt`; compute overrun from `stoppedAt - (scheduledAt + durationMinutes * 60000)` |
| **"Started late" tracking** | Excel implies late starts from previous overruns | **New feature required**: detect late start when `startedAt > scheduledAt`; record duration and optional reason |
| **"DQ" (disqualified) status** | Excel has "DQ" for unqualified prospects | Already captured: `meetingOutcome = "not_qualified"` |
| **Show Up Rate / Close Rate** | Computed KPIs, not stored | Computed at query time from component metrics |

---

## 4. Data Mapping: Manual Report → CRM

### 4.1 Call Classification Logic

The Excel splits every transaction into **New Calls** vs **Follow Up Calls**. In the CRM, this maps to the pipeline flow that created the meeting:

| Pipeline Flow | Classification | How to Detect |
| --- | --- | --- |
| **New opportunity creation** (Flow 4 in `inviteeCreated.ts`) | `new` | A new opportunity was created alongside this meeting |
| **UTM-linked reactivation** (Flow 1) | `follow_up` | Existing opportunity reactivated via UTM params |
| **Heuristic reschedule** (Flow 2) | `follow_up` | Existing no-show/canceled opportunity reactivated by heuristic match |
| **Follow-up reuse** (Flow 3) | `follow_up` | Existing opportunity in `follow_up_scheduled` transitioned back to `scheduled` |

**Decision**: Set `callClassification` at meeting creation time in the pipeline. This is deterministic — the pipeline already knows which flow it's in. Backfill existing meetings by checking if the meeting was the first on its opportunity.

### 4.2 Call Outcome Mapping

The Excel uses 8 status values per transaction. Here's how each maps to CRM data:

| Excel Status | CRM Derivation | Source Fields |
| --- | --- | --- |
| **Sold** | `paymentRecords` exists for this meeting | `paymentRecords.meetingId = meeting._id` |
| **Lost** | Opportunity reached `lost` status AND this meeting is the latest | `opportunities.status = "lost"` + `opportunities.latestMeetingId = meeting._id` |
| **No show** | Meeting status is `no_show` | `meetings.status = "no_show"` |
| **Canceled** | Meeting status is `canceled` | `meetings.status = "canceled"` |
| **Rescheduled** | Another meeting references this one as rescheduled source | `EXISTS meeting2 WHERE meeting2.rescheduledFromMeetingId = meeting._id` |
| **Follow up** | Opportunity is in `follow_up_scheduled` AND meeting is `completed` | `opportunities.status = "follow_up_scheduled"` + `meetings.status = "completed"` |
| **DQ** | Meeting outcome is `not_qualified` | `meetings.meetingOutcome = "not_qualified"` |
| **Overran** | Meeting actual duration exceeded scheduled duration | `meetings.overranDurationMs > 0` (computed when closer clicks "End Meeting") |

> **Note**: "Overran" is a **time-tracking tag**, not a call outcome. A meeting can be both "Sold" and "Overran." The Excel conflates them because it has a single status column — our CRM separates the call outcome (Sold/Lost/Follow up/DQ) from the time-tracking flags (overran, started late). For reporting, outcomes are derived at query time by checking conditions in priority order: Sold > Lost > No show > Canceled > Rescheduled > DQ > Follow up > Scheduled (pending). Overran/Late Start are reported as independent tags alongside the outcome.

### 4.3 KPI Formulas (matching Excel)

| KPI | Formula | Source |
| --- | --- | --- |
| **Booked Calls** | Count of all meetings in period | `meetingsByStatus` aggregate — sum counts across all statuses |
| **Cancelled Calls** | Count of meetings with `canceled` status | `meetingsByStatus` aggregate — prefix `[closerId, classification, "canceled"]` |
| **No Shows** | Count of meetings with `no_show` status | `meetingsByStatus` aggregate — prefix `[closerId, classification, "no_show"]` |
| **Calls Showed** | Count with `completed` or `in_progress` status | `meetingsByStatus` aggregate — sum of two prefix queries |
| **Show Up Rate** | `callsShowed / (bookedCalls - cancelledCalls)` | Computed from above |
| **Sales** | Count of non-disputed payments in period | `paymentSums` aggregate — `count()` |
| **Cash Collected** | Sum of `amountMinor / 100` | `paymentSums` aggregate — `sum()` |
| **Close Rate** | `sales / callsShowed` | Computed from above |
| **Average Cash Collected** | `cashCollected / sales` | Computed from above |

---

## 5. Architecture Decisions

### AD-1: Write-Time Aggregation via `@convex-dev/aggregate`

All reporting metrics are maintained by the [Aggregate component](https://www.convex.dev/components/aggregate) — a Convex component that keeps denormalized counts and sums in an O(log n) data structure, synced atomically within mutations.

**Why**: Read-time aggregation (scanning source tables) works at current scale (~200 meetings/month) but fails at 10x growth (~2,000/month → 8k+ document reads hit transaction limits). The Aggregate component solves this from day one with zero custom delta logic — you just call `insert()`, `replace()`, and `delete()` alongside your `ctx.db` operations. The component maintains the data structure. Convex mutations are atomic transactions, so the aggregate can never drift out of sync.

**Rejected**: (a) Read-time O(n) table scans — doesn't scale; forces non-reactive actions instead of live queries. (b) Custom `closerDailyStats` table with manual delta updates — same result as the Aggregate component but with bespoke maintenance logic, more bug surface, and no built-in range query support.

### AD-2: Reactive Queries via `useQuery` (not one-shot actions)

Because aggregate lookups are O(log n), reporting endpoints are implemented as standard Convex **queries** (not actions). The frontend subscribes via `useQuery` — reports update in real-time as meetings, payments, and opportunities change.

**Why**: The cost of a full Team Performance report via aggregates is ~80-100 O(log n) lookups (8 closers × 2 classifications × 5 statuses, plus payment queries). This is cheap enough for reactive subscriptions. Live dashboards are a significant UX upgrade over "click Generate and wait."

**Impact**: No `useAction` + `useState` pattern needed. Standard `useQuery` with Suspense and skeletons.

### AD-3: `callClassification` on Meetings (stored at creation time)

Store `callClassification: "new" | "follow_up"` directly on the `meetings` document, set at creation time by the pipeline. This field is part of the aggregate sort key.

**Why**: Deriving classification at query time requires checking whether the opportunity had previous meetings — an expensive sub-query per meeting (N+1). The pipeline already knows the answer at insertion time. Storing it is O(1) and makes the aggregate key well-defined.

### AD-4: Derive Detailed Call Outcomes via Supplementary Queries

The core Tier 1 KPIs (booked, canceled, no-show, showed, sales, revenue) are fully served by aggregates. Detailed breakdowns (Lost, Rescheduled, DQ, Follow-up, Overran — Tier 2 KPIs) require cross-entity lookups and are served by **small supplementary queries** that scan only the subset of completed meetings.

**Why**: These outcomes depend on cross-entity state (opportunity status, payment existence, reschedule chain). Encoding them into aggregates would require additional instances and complex `replace()` cascades. Since "completed" meetings are a small subset (~30-40% of total), scanning them is cheap.

### AD-5: Tenant-Level Namespacing

Every aggregate instance uses `namespace: (doc) => doc.tenantId`. This provides:
- Complete multi-tenant data isolation
- Independent internal data structures per tenant (no cross-tenant interference)
- Higher write throughput (writes to one tenant don't contend with another)

### AD-6: Meeting Time Tracking — "End Meeting" Action + Late Start Detection

> See also: AD-7 and AD-8 below for the `domainEvents` and `meetingFormResponses` query strategies.

The Excel's "Overran" status is not a call outcome — it's a **time-tracking fact**: the meeting ran past its scheduled end time. Currently the CRM has a "Start Meeting" button but no "End Meeting" button, so actual meeting duration is never recorded.

**New feature**: Add an explicit **"End Meeting"** action (`stopMeeting` mutation) that records `stoppedAt` and computes overrun duration. Enhance the existing `startMeeting` mutation to detect and record late starts.

**Why this is a v0.6 requirement**: Without actual start/stop timestamps, we cannot compute the "Overran" metric from the Excel, nor any time-efficiency KPIs (avg meeting duration, on-time start rate, schedule adherence). These are high-value metrics for sales management.

**Design**:
- "Overran" and "Started Late" are **tags/flags**, not statuses. A meeting can be `completed` AND `overran`. A meeting can be `in_progress` AND `startedLate`.
- The `stopMeeting` action transitions the meeting to `completed` status. The opportunity stays `in_progress` — the closer then independently decides the outcome (payment, follow-up, lost).
- Late start detection happens automatically at start time. If `startedAt > scheduledAt`, the frontend shows a prompt asking for an optional reason.

**Workflow**:
```
1. Meeting scheduled at 2:00 PM, duration 30 min
   → scheduledEnd = 2:30 PM

2. Closer clicks "Start Meeting" at 2:07 PM
   → startedAt = 2:07 PM
   → lateStartDurationMs = 7 * 60000 = 420,000 ms
   → Frontend shows: "Meeting started 7 min late. Add a reason?" (optional)
   → lateStartReason = "Previous meeting ran over"

3. Closer clicks "End Meeting" at 2:42 PM
   → stoppedAt = 2:42 PM
   → Meeting transitions: in_progress → completed
   → overranDurationMs = (2:42 - 2:30) * 60000 = 720,000 ms (12 min overran)

4. Closer sets outcome, logs payment / schedules follow-up / marks lost
   → Opportunity transitions independently
```

### AD-7: Activity Feed via Direct Index Scans (not aggregates)

The `domainEvents` table is queried via its existing indexes (`by_tenantId_and_occurredAt`, `by_tenantId_and_eventType_and_occurredAt`, `by_tenantId_and_actorUserId_and_occurredAt`) using bounded range scans, **not** via `@convex-dev/aggregate`. At current scale (~1,000 events/month), a paginated scan of 50-100 events is well within Convex query limits. This avoids adding a 6th aggregate instance with its associated mutation hooks (25+ emission sites would each need an aggregate `insert()` call).

**Scaling path**: If the tenant reaches 10,000+ events/month, a `domainEventCounts` aggregate instance can be added retroactively — only for the summary/count queries, not the paginated feed (which is inherently bounded by `.take()`).

**Rejected**: (a) Aggregate instance for event counts — premature at current scale; would require touching all 25 emission sites. (b) Server action — unnecessary; the queries are well-indexed and bounded.

### AD-8: Form Response Analytics via `meetingFormResponses` Scans

Booking form answer analytics query `meetingFormResponses` via the `by_tenantId_and_fieldKey` index. The `eventTypeFieldCatalog` table provides the field dimension (available questions for the dropdown selector). No aggregate instance needed at current scale (~600 form response rows).

**Critical prerequisite**: The live pipeline (`inviteeCreated.ts`) does **not** currently insert into `meetingFormResponses` during new bookings — only the v0.5b backfill populated it. This must be fixed in Phase 2 before form response analytics can reflect new data. The fix reuses the same extraction logic from the backfill migration (`admin/migrations.ts` lines ~509-640), wired into the 3 meeting-insert code paths.

**Rejected**: (a) Aggregate on answer frequencies — premature; the table is append-only and small. (b) Deferred to v0.7 — the tables are already populated and the queries are simple; no reason to wait.

---

## 6. Schema & Component Changes

### 6.1 Install `@convex-dev/aggregate`

```bash
pnpm add @convex-dev/aggregate
```

### 6.2 Update `convex/convex.config.ts`

```typescript
import workOSAuthKit from "@convex-dev/workos-authkit/convex.config";
import aggregate from "@convex-dev/aggregate/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(workOSAuthKit);

// Reporting aggregates
app.use(aggregate, { name: "meetingsByStatus" });
app.use(aggregate, { name: "paymentSums" });
app.use(aggregate, { name: "opportunityByStatus" });
app.use(aggregate, { name: "leadTimeline" });
app.use(aggregate, { name: "customerConversions" });

export default app;
```

### 6.3 `meetings` table — add `callClassification`

```typescript
// In convex/schema.ts, inside the meetings defineTable:
callClassification: v.optional(
  v.union(
    v.literal("new"),
    v.literal("follow_up"),
  ),
),
```

**`v.optional`** because existing meetings won't have it until backfilled. The aggregate's `sortKey` function treats `undefined` as `"new"` (safe default — most unclassified meetings predate follow-up tracking).

### 6.4 `meetings` table — add time tracking fields

```typescript
// In convex/schema.ts, inside the meetings defineTable:

// === Meeting Time Tracking ===
// When the closer clicked "End Meeting". Distinct from completedAt (which
// may be set by other flows). Used to compute actual meeting duration and overrun.
stoppedAt: v.optional(v.number()),

// Late start tracking — computed and stored by startMeeting mutation.
// If startedAt > scheduledAt, the meeting was started late.
lateStartDurationMs: v.optional(v.number()),   // ms late (0 if on time or early)
lateStartReason: v.optional(v.string()),       // Free-text reason from closer (optional)

// Overrun tracking — computed and stored by stopMeeting mutation.
// If stoppedAt > scheduledAt + durationMinutes * 60000, the meeting overran.
overranDurationMs: v.optional(v.number()),     // ms over (0 if within scheduled time)
// === End Meeting Time Tracking ===
```

All fields are `v.optional` — existing meetings won't have them. Reporting queries treat `undefined` as "no data" (exclude from time-tracking calculations).

### 6.5 `startMeeting` mutation update

The existing `startMeeting` mutation in `closer/meetingActions.ts` is enhanced to compute and store late start data:

```typescript
// In startMeeting handler, after setting startedAt:
const now = Date.now();
const lateStartDurationMs = Math.max(0, now - meeting.scheduledAt);

await ctx.db.patch(meetingId, {
  status: "in_progress",
  startedAt: now,
  lateStartDurationMs,
  // lateStartReason is set separately — see below
});
```

**New mutation — `setLateStartReason`** (called by frontend after the late-start prompt):

```typescript
// convex/closer/meetingActions.ts
export const setLateStartReason = mutation({
  args: {
    meetingId: v.id("meetings"),
    reason: v.string(),
  },
  handler: async (ctx, { meetingId, reason }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);
    const { meeting, opportunity } = await loadMeetingContext(ctx, meetingId, tenantId);

    if (opportunity.assignedCloserId !== userId) {
      throw new Error("Not your meeting");
    }
    if (meeting.status !== "in_progress") {
      throw new Error("Meeting must be in progress to set late start reason");
    }
    if (!meeting.lateStartDurationMs || meeting.lateStartDurationMs === 0) {
      throw new Error("Meeting was not started late");
    }

    await ctx.db.patch(meetingId, { lateStartReason: reason.trim() });
  },
});
```

**Why a separate mutation for the reason**: `startMeeting` must return the join URL immediately so the closer can enter the call. The late-start prompt appears _after_ the meeting starts — it should not block the start action. The frontend calls `startMeeting` → opens join URL → shows a non-blocking modal → calls `setLateStartReason` if the closer provides one.

### 6.6 New `stopMeeting` mutation

```typescript
// convex/closer/meetingActions.ts
export const stopMeeting = mutation({
  args: { meetingId: v.id("meetings") },
  handler: async (ctx, { meetingId }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const { meeting, opportunity } = await loadMeetingContext(ctx, meetingId, tenantId);

    // Authorization
    const { role } = await requireTenantUser(ctx, ["closer", "tenant_master", "tenant_admin"]);
    if (role === "closer" && opportunity.assignedCloserId !== userId) {
      throw new Error("Not your meeting");
    }

    // Validate status
    if (meeting.status !== "in_progress") {
      throw new Error(`Cannot stop a meeting with status "${meeting.status}"`);
    }

    const now = Date.now();
    const scheduledEndMs = meeting.scheduledAt + meeting.durationMinutes * 60 * 1000;
    const overranDurationMs = Math.max(0, now - scheduledEndMs);

    // Transition meeting to completed
    await ctx.db.patch(meetingId, {
      status: "completed",
      stoppedAt: now,
      completedAt: now,   // Also set completedAt for backward compat
      overranDurationMs,
    });

    // Update denormalized refs
    await updateOpportunityMeetingRefs(ctx, opportunity._id);

    // Domain event
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "meeting",
      entityId: meetingId,
      eventType: "meeting.stopped",
      source: role === "closer" ? "closer" : "admin",
      actorUserId: userId,
      fromStatus: "in_progress",
      toStatus: "completed",
      occurredAt: now,
      metadata: JSON.stringify({
        overranDurationMs,
        actualDurationMs: meeting.startedAt ? now - meeting.startedAt : undefined,
      }),
    });

    return {
      overranDurationMs,
      wasOverran: overranDurationMs > 0,
    };
  },
});
```

**Key decisions:**
- `stopMeeting` transitions the meeting to `completed` but does **NOT** touch the opportunity status. The opportunity stays `in_progress` until the closer explicitly decides the outcome (payment, follow-up, lost).
- Both `stoppedAt` and `completedAt` are set for backward compatibility — existing code may check `completedAt`.
- Returns `wasOverran` and `overranDurationMs` so the frontend can show an immediate notification.

### 6.7 Aggregate Instance Definitions

```typescript
// convex/reporting/aggregates.ts

import { TableAggregate } from "@convex-dev/aggregate";
import { components } from "../_generated/api";
import { DataModel, Id } from "../_generated/dataModel";

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
 * Enables: sum revenue + count deals by closer + date range
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
 * Enables: count opportunities by status, by status+closer
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
 * Sort key: _creationTime
 * Enables: count new leads in date range
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
 * Sort key: [convertedByUserId, convertedAt]
 * Enables: count conversions by closer + date range
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

### 6.8 Pipeline Update — set `callClassification`

In `convex/pipeline/inviteeCreated.ts`, at each of the 4 flows where a meeting is inserted:

| Flow | Line (approx.) | Set To | Reason |
| --- | --- | --- | --- |
| Flow 1: UTM-linked reactivation | ~1161 | `"follow_up"` | Reactivating existing opportunity |
| Flow 2: Heuristic reschedule | ~1403 | `"follow_up"` | Reactivating no-show/canceled opp |
| Flow 3: Follow-up opp reuse | ~1593 | `"follow_up"` | Existing opp in follow_up_scheduled |
| Flow 4: New opportunity | ~1593 | `"new"` | Brand-new opportunity + meeting |

Each `ctx.db.insert("meetings", { ... })` call adds `callClassification: "new"` or `callClassification: "follow_up"`.

### 6.9 Backfill Scripts

Two backfill operations needed at deploy time:

**A. Backfill `callClassification` on existing meetings:**

```typescript
// convex/reporting/backfill.ts
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
    if (meetings.length === 500) {
      await ctx.scheduler.runAfter(
        0, internal.reporting.backfill.backfillMeetingClassification, {}
      );
    }
    return { updated };
  },
});
```

**B. Backfill all 5 aggregate instances from existing data:**

```typescript
// convex/reporting/backfill.ts
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
        0, internal.reporting.backfill.backfillMeetingsAggregate,
        { cursor: result.continueCursor }
      );
    }
  },
});

// Similar for: backfillPaymentsAggregate, backfillOpportunitiesAggregate,
// backfillLeadsAggregate, backfillCustomersAggregate
```

**At ~213 meetings, ~50 payments, ~213 opportunities, ~200 leads, ~30 customers — all backfills complete in a single batch.**

### 6.10 Pipeline Update — live `meetingFormResponses` insertion

**Problem**: The v0.5b backfill populated `meetingFormResponses` from historical raw webhooks, but the live pipeline in `convex/pipeline/inviteeCreated.ts` does NOT insert into `meetingFormResponses` during new bookings. It only writes to `leads.customFields` (the legacy blob). Without this fix, form response analytics will only reflect historical data — new bookings silently stop contributing to the dataset.

**Fix**: At each of the 3 meeting-insert code paths in `inviteeCreated.ts` (UTM reactivation, heuristic reschedule, new opportunity), after inserting the meeting:

1. Parse `questions_and_answers` from the Calendly webhook payload (already extracted at line ~952 via `extractQuestionsAndAnswers`)
2. For each Q&A pair:
   a. Upsert into `eventTypeFieldCatalog` — create if `(tenantId, eventTypeConfigId, fieldKey)` combo is new; update `lastSeenAt` if it exists
   b. Insert into `meetingFormResponses` with all FK references (`meetingId`, `opportunityId`, `leadId`, `eventTypeConfigId`, `fieldCatalogId`, `fieldKey`, `questionText`, `answerText`, `capturedAt`)
3. Continue writing merged view to `leads.customFields` for backward UI compatibility

**Reference implementation**: The backfill migration at `convex/admin/migrations.ts` lines ~509-640 contains the extraction and insertion logic. The live pipeline integration mirrors this, extracting it into a shared helper (e.g., `convex/lib/meetingFormResponseWriter.ts`) to avoid duplication.

This matches the v0.5b specification (Section 3.7) which explicitly called for this integration but was not implemented during the v0.5b rollout.

---

## 7. Aggregate Integration Map

Every mutation that writes to `meetings`, `paymentRecords`, `opportunities`, `leads`, or `customers` must also call the corresponding aggregate method. Below is the **complete inventory** of touch points.

### 7.1 `meetingsByStatus` — 15 touch points

The sort key is `[assignedCloserId, callClassification, status, scheduledAt]`. Any mutation that changes these fields requires an aggregate update.

#### Inserts (3) — call `meetingsByStatus.insert(ctx, doc)`

| File | Line | Function | Context |
| --- | --- | --- | --- |
| `pipeline/inviteeCreated.ts` | ~1161 | `process` | Meeting for UTM-linked reactivation (follow_up) |
| `pipeline/inviteeCreated.ts` | ~1403 | `process` | Meeting for heuristic reschedule (follow_up) |
| `pipeline/inviteeCreated.ts` | ~1593 | `process` | Meeting for new opportunity (new) |

**Pattern:**
```typescript
const meetingId = await ctx.db.insert("meetings", { ...fields, callClassification: "new" });
const doc = await ctx.db.get(meetingId);
await meetingsByStatus.insert(ctx, doc!);
```

#### Status Changes (9) — call `meetingsByStatus.replace(ctx, oldDoc, newDoc)`

| File | Line | Function | Transition |
| --- | --- | --- | --- |
| `closer/meetingActions.ts` | ~106 | `startMeeting` | scheduled → in_progress |
| `closer/meetingActions.ts` | new | `stopMeeting` | in_progress → completed |
| `pipeline/inviteeNoShow.ts` | ~85 | `process` | * → no_show (webhook) |
| `pipeline/inviteeNoShow.ts` | ~201 | `process` | * → no_show (rescheduled canceled) |
| `pipeline/inviteeNoShow.ts` | ~201 | `revert` | no_show → scheduled |
| `closer/noShowActions.ts` | ~71 | `markNoShow` | * → no_show (closer) |
| `pipeline/inviteeCanceled.ts` | ~91 | `process` | * → canceled (webhook) |
| `unavailability/redistribution.ts` | ~405 | `manuallyResolveMeeting` | * → canceled |

**Pattern:**
```typescript
const oldDoc = await ctx.db.get(meetingId);
await ctx.db.patch(meetingId, { status: "no_show", ... });
const newDoc = await ctx.db.get(meetingId);
await meetingsByStatus.replace(ctx, oldDoc!, newDoc!);
```

#### Closer Reassignment (3) — call `meetingsByStatus.replace(ctx, oldDoc, newDoc)`

| File | Line | Function | What Changes |
| --- | --- | --- | --- |
| `unavailability/redistribution.ts` | ~241 | `autoDistributeMeetings` | `reassignedFromCloserId` (+ closerId via sync) |
| `unavailability/redistribution.ts` | ~370 | `manuallyResolveMeeting` | `reassignedFromCloserId` (+ closerId via sync) |
| `lib/syncOpportunityMeetingsAssignedCloser.ts` | ~18 | `syncOpportunityMeetingsAssignedCloser` | `assignedCloserId` bulk sync |

**`syncOpportunityMeetingsAssignedCloser` pattern** (bulk — must update aggregate per meeting):
```typescript
for await (const meeting of ctx.db.query("meetings").withIndex("by_opportunityId", ...)) {
  if (meeting.assignedCloserId === assignedCloserId) continue;
  const oldDoc = meeting; // already loaded from iteration
  await ctx.db.patch(meeting._id, { assignedCloserId });
  const newDoc = await ctx.db.get(meeting._id);
  await meetingsByStatus.replace(ctx, oldDoc, newDoc!);
}
```

#### Irrelevant Patches (4) — NO aggregate call needed

| File | Function | What Changes | Why Irrelevant |
| --- | --- | --- | --- |
| `closer/meetingActions.ts` | `updateMeetingNotes` | `notes` | Not in sort key |
| `closer/meetingActions.ts` | `updateMeetingOutcome` | `meetingOutcome` | Not in sort key |
| `lib/syncLeadMeetingNames.ts` | `syncLeadMeetingNames` | `leadName` | Not in sort key |
| `meetings/maintenance.ts` | `backfillMeetingLinks` | `meetingJoinUrl` | Not in sort key |

### 7.2 `paymentSums` — 2 touch points

Sort key: `[closerId, recordedAt]`, sum: `amountMinor`. Only inserts matter — no patches change these fields.

| File | Line | Function | Operation |
| --- | --- | --- | --- |
| `closer/payments.ts` | ~146 | `logPayment` | `insert` |
| `customers/mutations.ts` | ~169 | `recordCustomerPayment` | `insert` |

**Pattern:**
```typescript
const paymentId = await ctx.db.insert("paymentRecords", { ... });
const doc = await ctx.db.get(paymentId);
await paymentSums.insert(ctx, doc!);
```

**Patches that DON'T need aggregate calls:**
- `closer/payments.ts:218,234` — patches `customerId` only (not in sort key)
- `customers/conversion.ts:168` — patches `customerId` only
- `admin/migrations.ts:1299` — patches `amountMinor` (one-time migration; run aggregate re-backfill after)

### 7.3 `opportunityByStatus` — 15 touch points

Sort key: `[status, assignedCloserId, createdAt]`. Status transitions and closer reassignment require `replace()`.

#### Insert (1)

| File | Line | Function |
| --- | --- | --- |
| `pipeline/inviteeCreated.ts` | ~1554 | `process` — new opportunity |

#### Status Transitions (12) — `replace(ctx, oldDoc, newDoc)`

| File | Line | Function | Transition |
| --- | --- | --- | --- |
| `pipeline/inviteeCreated.ts` | ~1059 | `process` (Flow 1) | follow_up_scheduled/reschedule_link_sent → scheduled |
| `pipeline/inviteeCreated.ts` | ~1509 | `process` (Flow 3) | follow_up_scheduled → scheduled |
| `pipeline/inviteeCanceled.ts` | ~143 | `process` | * → canceled |
| `pipeline/inviteeNoShow.ts` | ~116 | `process` | * → no_show |
| `pipeline/inviteeNoShow.ts` | ~229 | `revert` | no_show → scheduled |
| `closer/meetingActions.ts` | ~101 | `startMeeting` | scheduled → in_progress |
| `closer/meetingActions.ts` | ~188 | `markAsLost` | in_progress → lost |
| `closer/noShowActions.ts` | ~81 | `markNoShow` | in_progress → no_show |
| `closer/noShowActions.ts` | ~217 | `createNoShowRescheduleLink` | no_show → reschedule_link_sent |
| `closer/followUpMutations.ts` | ~84 | `transitionToFollowUp` | * → follow_up_scheduled |
| `closer/followUpMutations.ts` | ~268 | `scheduleFollowUpPublic` | * → follow_up_scheduled |
| `closer/followUpMutations.ts` | ~336 | `createManualReminderFollowUpPublic` | * → follow_up_scheduled |
| `closer/payments.ts` | ~165 | `logPayment` | in_progress → payment_received |

#### Closer Reassignment (2) — `replace(ctx, oldDoc, newDoc)`

| File | Line | Function |
| --- | --- | --- |
| `unavailability/redistribution.ts` | ~232 | `autoDistributeMeetings` — patches `assignedCloserId` |
| `unavailability/redistribution.ts` | ~361 | `manuallyResolveMeeting` — patches `assignedCloserId` |

#### Non-relevant patches (skip)

- `leads/merge.ts:133` — patches `leadId` only (not in sort key)
- `leads/merge.ts:238,281` — patches `potentialDuplicateLeadId` only
- `lib/opportunityMeetingRefs.ts:65` — patches meeting ref fields only

### 7.4 `leadTimeline` — 1 touch point

Sort key: `_creationTime` (immutable). Only inserts.

| File | Line | Function |
| --- | --- | --- |
| `pipeline/inviteeCreated.ts` | ~523 | `resolveLeadIdentity` — new lead |

Lead status changes (active → converted/merged) don't affect `_creationTime`, so no `replace` needed. We count total leads created in a period regardless of current status.

### 7.5 `customerConversions` — 1 touch point

Sort key: `[convertedByUserId, convertedAt]` (both immutable after creation). Only inserts.

| File | Line | Function |
| --- | --- | --- |
| `customers/conversion.ts` | ~89 | `executeConversion` — new customer |

Customer status changes (active → churned) don't affect the sort key fields.

### 7.6 Integration Summary

| Aggregate | Insert Points | Replace Points | Total | Files Touched |
| --- | --- | --- | --- | --- |
| `meetingsByStatus` | 3 | 12 | 15 | 6 files |
| `paymentSums` | 2 | 0 | 2 | 2 files |
| `opportunityByStatus` | 1 | 14 | 15 | 7 files |
| `leadTimeline` | 1 | 0 | 1 | 1 file |
| `customerConversions` | 1 | 0 | 1 | 1 file |
| **Total** | **8** | **26** | **34** | **~10 unique files** |

Many touch points overlap (e.g., `inviteeCreated.ts` has meeting insert + opportunity insert/status change in the same code path), so the actual code change count is lower than the raw numbers suggest.

---

## 8. Core Reporting Queries (Drafts)

### 8.1 Team Performance Report

> **Purpose**: Replaces the monthly Excel sheet — per-closer KPIs split by new/follow-up calls. Reactive via `useQuery`.

```typescript
// convex/reporting/teamPerformance.ts
import { query } from "../_generated/server";
import { v } from "convex/values";
import { requireTenantUser } from "../requireTenantUser";
import { MEETING_STATUSES } from "../lib/statusTransitions";
import { meetingsByStatus, paymentSums } from "./aggregates";

export const getTeamPerformanceMetrics = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, { startDate, endDate }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    // 1. Load active closers
    const closers = [];
    for await (const user of ctx.db
      .query("users")
      .withIndex("by_tenantId_and_isActive", (q) =>
        q.eq("tenantId", tenantId).eq("isActive", true),
      )) {
      closers.push(user);
    }

    const dateBounds = {
      lower: { key: startDate, inclusive: true as const },
      upper: { key: endDate, inclusive: false as const },
    };

    // 2. For each closer, query aggregate for all status × classification combos
    const closerResults = await Promise.all(
      closers.map(async (closer) => {
        const kpis: Record<string, any> = {};

        for (const classification of ["new", "follow_up"] as const) {
          const statusCounts: Record<string, number> = {};
          let booked = 0;

          // One O(log n) aggregate call per status
          await Promise.all(
            MEETING_STATUSES.map(async (status) => {
              const count = await meetingsByStatus.count(ctx, {
                namespace: tenantId,
                prefix: [closer._id, classification, status],
                bounds: dateBounds,
              });
              statusCounts[status] = count;
              booked += count;
            }),
          );

          const showed = (statusCounts["completed"] ?? 0) + (statusCounts["in_progress"] ?? 0);
          const canceled = statusCounts["canceled"] ?? 0;
          const noShows = statusCounts["no_show"] ?? 0;
          const denominator = booked - canceled;

          kpis[classification] = {
            bookedCalls: booked,
            canceledCalls: canceled,
            noShows,
            callsShowed: showed,
            showUpRate: denominator > 0 ? showed / denominator : 0,
          };
        }

        // 3. Payment metrics per closer (not split by classification)
        const [revenue, dealCount] = await Promise.all([
          paymentSums.sum(ctx, {
            namespace: tenantId,
            prefix: [closer._id],
            bounds: dateBounds,
          }),
          paymentSums.count(ctx, {
            namespace: tenantId,
            prefix: [closer._id],
            bounds: dateBounds,
          }),
        ]);

        return {
          closerId: closer._id,
          closerName: closer.fullName ?? closer.email,
          newCalls: kpis["new"],
          followUpCalls: kpis["follow_up"],
          sales: dealCount,
          cashCollectedMinor: revenue,
          closeRate:
            (kpis["new"].callsShowed + kpis["follow_up"].callsShowed) > 0
              ? dealCount / (kpis["new"].callsShowed + kpis["follow_up"].callsShowed)
              : 0,
          avgCashCollectedMinor: dealCount > 0 ? revenue / dealCount : 0,
        };
      }),
    );

    // 4. Team totals (sum across closers)
    const teamTotals = closerResults.reduce(
      (acc, r) => ({
        newBookedCalls: acc.newBookedCalls + r.newCalls.bookedCalls,
        newShowed: acc.newShowed + r.newCalls.callsShowed,
        newCanceled: acc.newCanceled + r.newCalls.canceledCalls,
        newNoShows: acc.newNoShows + r.newCalls.noShows,
        followUpBookedCalls: acc.followUpBookedCalls + r.followUpCalls.bookedCalls,
        followUpShowed: acc.followUpShowed + r.followUpCalls.callsShowed,
        followUpCanceled: acc.followUpCanceled + r.followUpCalls.canceledCalls,
        followUpNoShows: acc.followUpNoShows + r.followUpCalls.noShows,
        totalSales: acc.totalSales + r.sales,
        totalRevenue: acc.totalRevenue + r.cashCollectedMinor,
      }),
      { newBookedCalls: 0, newShowed: 0, newCanceled: 0, newNoShows: 0,
        followUpBookedCalls: 0, followUpShowed: 0, followUpCanceled: 0, followUpNoShows: 0,
        totalSales: 0, totalRevenue: 0 },
    );

    return { closers: closerResults, teamTotals };
  },
});
```

**Query cost**: 8 closers × 2 classifications × 5 statuses = 80 aggregate lookups + 8 × 2 payment lookups = **96 O(log n) calls**. Extremely fast.

### 8.2 Revenue Report

> **Purpose**: Revenue-focused view — total revenue, deal distribution, trends, top deals.

```typescript
// convex/reporting/revenue.ts

export const getRevenueMetrics = query({
  args: { startDate: v.number(), endDate: v.number() },
  handler: async (ctx, { startDate, endDate }) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    const closers = await getActiveClosers(ctx, tenantId);
    const dateBounds = makeDateBounds(startDate, endDate);

    // Per-closer revenue + deal count via aggregate
    const byCloser = await Promise.all(
      closers.map(async (closer) => {
        const [revenue, deals] = await Promise.all([
          paymentSums.sum(ctx, { namespace: tenantId, prefix: [closer._id], bounds: dateBounds }),
          paymentSums.count(ctx, { namespace: tenantId, prefix: [closer._id], bounds: dateBounds }),
        ]);
        return {
          closerId: closer._id,
          closerName: closer.fullName ?? closer.email,
          revenueMinor: revenue,
          dealCount: deals,
          avgDealMinor: deals > 0 ? revenue / deals : 0,
        };
      }),
    );

    const totalRevenue = byCloser.reduce((sum, c) => sum + c.revenueMinor, 0);
    const totalDeals = byCloser.reduce((sum, c) => sum + c.dealCount, 0);

    return {
      totalRevenueMinor: totalRevenue,
      totalDeals,
      avgDealMinor: totalDeals > 0 ? totalRevenue / totalDeals : 0,
      byCloser: byCloser.map((c) => ({
        ...c,
        revenuePercent: totalRevenue > 0 ? (c.revenueMinor / totalRevenue) * 100 : 0,
      })),
    };
  },
});

// Supplementary: Top deals + deal size distribution (small scan of payment records)
export const getRevenueDetails = query({
  args: { startDate: v.number(), endDate: v.number() },
  handler: async (ctx, { startDate, endDate }) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    // Scan payment records in range (bounded, ~50-150 records)
    const payments = [];
    for await (const payment of ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId_and_recordedAt", (q) =>
        q.eq("tenantId", tenantId).gte("recordedAt", startDate).lt("recordedAt", endDate),
      )) {
      if (payment.status !== "disputed") payments.push(payment);
    }

    // Top 10 deals
    const topDeals = payments
      .sort((a, b) => b.amountMinor - a.amountMinor)
      .slice(0, 10);

    // Enrich top deals with closer names
    const closerIds = [...new Set(topDeals.map((p) => p.closerId))];
    const closerMap = new Map(
      await Promise.all(
        closerIds.map(async (id) => [id, await ctx.db.get(id)] as const),
      ),
    );

    // Deal size distribution (5 buckets)
    const buckets = { under500: 0, to2k: 0, to5k: 0, to10k: 0, over10k: 0 };
    for (const p of payments) {
      const dollars = p.amountMinor / 100;
      if (dollars < 500) buckets.under500++;
      else if (dollars < 2000) buckets.to2k++;
      else if (dollars < 5000) buckets.to5k++;
      else if (dollars < 10000) buckets.to10k++;
      else buckets.over10k++;
    }

    return {
      topDeals: topDeals.map((p) => ({
        amountMinor: p.amountMinor,
        closerName: closerMap.get(p.closerId)?.fullName ?? "Unknown",
        recordedAt: p.recordedAt,
      })),
      dealSizeDistribution: buckets,
    };
  },
});
```

### 8.3 Revenue Trend (period-bucketed)

```typescript
// convex/reporting/revenueTrend.ts

export const getRevenueTrend = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
    granularity: v.union(v.literal("day"), v.literal("week"), v.literal("month")),
  },
  handler: async (ctx, { startDate, endDate, granularity }) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    // Generate period boundaries
    const periods = getPeriodsInRange(startDate, endDate, granularity);

    // One aggregate call per period
    const trend = await Promise.all(
      periods.map(async (period) => {
        const bounds = {
          lower: { key: period.start, inclusive: true as const },
          upper: { key: period.end, inclusive: false as const },
        };
        const [revenue, deals] = await Promise.all([
          paymentSums.sum(ctx, { namespace: tenantId, bounds }),
          paymentSums.count(ctx, { namespace: tenantId, bounds }),
        ]);
        return { periodKey: period.key, revenueMinor: revenue, dealCount: deals };
      }),
    );

    return { trend };
  },
});
```

### 8.4 Pipeline Health Report

```typescript
// convex/reporting/pipelineHealth.ts

export const getPipelineDistribution = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    const STATUSES = [
      "scheduled", "in_progress", "follow_up_scheduled",
      "reschedule_link_sent", "payment_received", "lost", "canceled", "no_show",
    ] as const;

    // One O(log n) call per status
    const distribution = await Promise.all(
      STATUSES.map(async (status) => ({
        status,
        count: await opportunityByStatus.count(ctx, {
          namespace: tenantId,
          prefix: [status],
        }),
      })),
    );

    return { distribution };
  },
});

// Supplementary: Pipeline aging + velocity (scans active + recently won opps)
export const getPipelineAging = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    const now = Date.now();

    // Scan active opportunities for aging calculation
    const activeStatuses = ["scheduled", "in_progress", "follow_up_scheduled", "reschedule_link_sent"];
    const agingByStatus: Record<string, { totalDays: number; count: number }> = {};
    const staleOpps = [];

    for (const status of activeStatuses) {
      let totalAge = 0;
      let count = 0;
      for await (const opp of ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_status", (q) =>
          q.eq("tenantId", tenantId).eq("status", status),
        )
        .take(200)) {
        const ageDays = (now - opp.createdAt) / (24 * 60 * 60 * 1000);
        totalAge += ageDays;
        count++;
        // Flag stale: active with no meeting in 14 days
        if (opp.nextMeetingAt === undefined || opp.nextMeetingAt < now - 14 * 24 * 60 * 60 * 1000) {
          staleOpps.push({ id: opp._id, status, ageDays: Math.round(ageDays) });
        }
      }
      agingByStatus[status] = { totalDays: totalAge, count };
    }

    // Pipeline velocity: avg days to close for recently won opps (90 days)
    const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;
    let velocityTotal = 0;
    let velocityCount = 0;
    for await (const opp of ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", "payment_received").gte("createdAt", ninetyDaysAgo),
      )
      .take(200)) {
      if (opp.paymentReceivedAt) {
        velocityTotal += (opp.paymentReceivedAt - opp.createdAt) / (24 * 60 * 60 * 1000);
        velocityCount++;
      }
    }

    return {
      agingByStatus,
      velocityDays: velocityCount > 0 ? velocityTotal / velocityCount : null,
      staleOpps: staleOpps.slice(0, 20),
    };
  },
});
```

### 8.5 Lead & Conversion Report

```typescript
// convex/reporting/leadConversion.ts

export const getLeadConversionMetrics = query({
  args: { startDate: v.number(), endDate: v.number() },
  handler: async (ctx, { startDate, endDate }) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    const closers = await getActiveClosers(ctx, tenantId);
    const dateBounds = makeDateBounds(startDate, endDate);

    // Aggregate: new leads in range
    const newLeads = await leadTimeline.count(ctx, {
      namespace: tenantId,
      bounds: dateBounds,
    });

    // Aggregate: conversions per closer
    const byCloser = await Promise.all(
      closers.map(async (closer) => {
        const conversions = await customerConversions.count(ctx, {
          namespace: tenantId,
          prefix: [closer._id],
          bounds: dateBounds,
        });
        return {
          closerId: closer._id,
          closerName: closer.fullName ?? closer.email,
          conversions,
        };
      }),
    );

    const totalConversions = byCloser.reduce((sum, c) => sum + c.conversions, 0);

    return {
      newLeads,
      totalConversions,
      conversionRate: newLeads > 0 ? totalConversions / newLeads : 0,
      byCloser,
    };
  },
});
```

### 8.6 Activity Feed

> **Purpose**: Admin-facing audit trail powered by `domainEvents`. Shows who did what and when — the CRM's "git log." Reactive via `useQuery`.

```typescript
// convex/reporting/activityFeed.ts

export const getActivityFeed = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
    entityType: v.optional(v.string()),
    eventType: v.optional(v.string()),
    actorUserId: v.optional(v.id("users")),
    limit: v.optional(v.number()),  // default 50, max 100
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const limit = Math.min(args.limit ?? 50, 100);

    // Use the most selective index available
    let q;
    if (args.actorUserId) {
      q = ctx.db
        .query("domainEvents")
        .withIndex("by_tenantId_and_actorUserId_and_occurredAt", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("actorUserId", args.actorUserId)
            .gte("occurredAt", args.startDate)
            .lt("occurredAt", args.endDate),
        )
        .order("desc");
    } else if (args.eventType) {
      q = ctx.db
        .query("domainEvents")
        .withIndex("by_tenantId_and_eventType_and_occurredAt", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("eventType", args.eventType)
            .gte("occurredAt", args.startDate)
            .lt("occurredAt", args.endDate),
        )
        .order("desc");
    } else {
      q = ctx.db
        .query("domainEvents")
        .withIndex("by_tenantId_and_occurredAt", (q) =>
          q
            .eq("tenantId", tenantId)
            .gte("occurredAt", args.startDate)
            .lt("occurredAt", args.endDate),
        )
        .order("desc");
    }

    const events = await q.take(limit);

    // Batch-enrich with actor names (deduplicated)
    const actorIds = [
      ...new Set(events.map((e) => e.actorUserId).filter(Boolean)),
    ] as Id<"users">[];
    const actors = new Map(
      await Promise.all(
        actorIds.map(async (id) => [id, await ctx.db.get(id)] as const),
      ),
    );

    return events.map((e) => ({
      ...e,
      actorName: e.actorUserId
        ? (actors.get(e.actorUserId)?.fullName ??
          actors.get(e.actorUserId)?.email)
        : null,
      metadata: e.metadata ? JSON.parse(e.metadata) : null,
    }));
  },
});
```

**Query cost**: One indexed range scan + `.take(50)` → ~50 document reads + actor enrichment (deduplicated, typically 5-8 users). Well within query limits at any scale.

```typescript
// convex/reporting/activityFeed.ts

export const getActivitySummary = query({
  args: { startDate: v.number(), endDate: v.number() },
  handler: async (ctx, { startDate, endDate }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    // Scan events in range and bucket by source + entityType
    const bySource: Record<string, number> = {
      closer: 0,
      admin: 0,
      pipeline: 0,
      system: 0,
    };
    const byEntity: Record<string, number> = {};
    const byActor: Record<string, number> = {};
    let total = 0;

    for await (const event of ctx.db
      .query("domainEvents")
      .withIndex("by_tenantId_and_occurredAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("occurredAt", startDate)
          .lt("occurredAt", endDate),
      )) {
      total++;
      bySource[event.source] = (bySource[event.source] ?? 0) + 1;
      byEntity[event.entityType] =
        (byEntity[event.entityType] ?? 0) + 1;
      if (event.actorUserId) {
        byActor[event.actorUserId] =
          (byActor[event.actorUserId] ?? 0) + 1;
      }
    }

    return { totalEvents: total, bySource, byEntity, byActor };
  },
});
```

**Scalability note**: At current volume (~1,000 events/month), the summary scan is well within limits. At 10x scale (~10,000/month), this approaches Convex query document-read limits. The documented scaling path is to add a `domainEventCounts` aggregate instance at that point — **not needed now**.

### 8.7 Form Response Analytics

> **Purpose**: Booking form insights — which answers do leads give, and how frequently? Powered by `meetingFormResponses` + `eventTypeFieldCatalog` from v0.5b. Reactive via `useQuery`.

```typescript
// convex/reporting/formResponseAnalytics.ts

/**
 * Returns available form fields for the field selector dropdown.
 * Populated by the pipeline (after 6.10 fix) and the v0.5b backfill.
 */
export const getFieldCatalog = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const fields = await ctx.db
      .query("eventTypeFieldCatalog")
      .withIndex("by_tenantId_and_fieldKey", (q) =>
        q.eq("tenantId", tenantId),
      )
      .collect();

    return fields.map((f) => ({
      id: f._id,
      fieldKey: f.fieldKey,
      currentLabel: f.currentLabel,
      firstSeenAt: f.firstSeenAt,
      lastSeenAt: f.lastSeenAt,
    }));
  },
});

/**
 * Returns answer frequency distribution for a specific form field.
 * Supports optional date range filtering via capturedAt.
 */
export const getAnswerDistribution = query({
  args: {
    fieldKey: v.string(),
    startDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
  },
  handler: async (ctx, { fieldKey, startDate, endDate }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const responses: string[] = [];
    for await (const r of ctx.db
      .query("meetingFormResponses")
      .withIndex("by_tenantId_and_fieldKey", (q) =>
        q.eq("tenantId", tenantId).eq("fieldKey", fieldKey),
      )) {
      if (startDate && r.capturedAt < startDate) continue;
      if (endDate && r.capturedAt >= endDate) continue;
      responses.push(r.answerText);
    }

    // Group and count
    const freq: Record<string, number> = {};
    for (const answer of responses) {
      const normalized = answer.trim();
      freq[normalized] = (freq[normalized] ?? 0) + 1;
    }

    // Sort by frequency descending
    const distribution = Object.entries(freq)
      .map(([answer, count]) => ({
        answer,
        count,
        percent:
          responses.length > 0 ? (count / responses.length) * 100 : 0,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      fieldKey,
      totalResponses: responses.length,
      distinctAnswers: distribution.length,
      distribution,
    };
  },
});
```

**Query cost**: `getFieldCatalog` collects ~5-10 field definitions (tiny). `getAnswerDistribution` scans one field's responses via index — ~200 rows at current scale. Both are standard `useQuery` endpoints.

---

## 9. KPI Catalog

### Tier 1: Direct Excel Replacements (must ship)

These are the exact KPIs from the manual report. Every one must be present in the v0.6 release.

| # | KPI | Source | Split by New/Follow-up | Per Closer | Team Total |
| --- | --- | --- | --- | --- | --- |
| 1 | Booked Calls | `meetingsByStatus` aggregate | Yes | Yes | Yes |
| 2 | Cancelled Calls | `meetingsByStatus` aggregate | Yes | Yes | Yes |
| 3 | No Shows | `meetingsByStatus` aggregate | Yes | Yes | Yes |
| 4 | Calls Showed | `meetingsByStatus` aggregate | Yes | Yes | Yes |
| 5 | Show Up Rate | Computed from 1, 2, 4 | Yes | Yes | Yes |
| 6 | Sales (Deals Closed) | `paymentSums` aggregate | No* | Yes | Yes |
| 7 | Cash Collected | `paymentSums` aggregate | No* | Yes | Yes |
| 8 | Close Rate | Computed from 4, 6 | No* | Yes | Yes |
| 9 | Avg Cash Collected | Computed from 6, 7 | No* | Yes | Yes |

> \* Sales and Cash Collected are not split by new/follow-up in v0.6 because the payment aggregate is keyed by closer + date, not by call classification. The per-classification split for revenue is a Tier 2 enhancement that requires either a second payment aggregate or a supplementary query.

### Tier 2: Enhanced KPIs (ship with v0.6)

| # | KPI | Source | Where Shown |
| --- | --- | --- | --- |
| 10 | **Lost Deals** | Supplementary query (completed meetings → opportunity status) | Team Performance |
| 11 | **DQ Rate** | Supplementary query (`meetingOutcome = "not_qualified"`) | Team Performance |
| 12 | **Rebook Rate** | Supplementary query (reschedule chain check) | Team Performance |
| 13 | **Revenue Trend** | `paymentSums` aggregate — bucketed by period | Revenue Report |
| 14 | **Deal Size Distribution** | Supplementary scan of payment records | Revenue Report |
| 15 | **Top 10 Deals** | Supplementary scan of payment records | Revenue Report |
| 16 | **Avg Deal Size by Closer** | `paymentSums` aggregate (sum / count) | Revenue Report |
| 17 | **Revenue Concentration** | `paymentSums` aggregate (closer % of total) | Revenue Report |
| 18 | **Meeting Outcome Distribution** | Supplementary query on completed meetings | Team Performance |
| 19 | **Pipeline Status Distribution** | `opportunityByStatus` aggregate | Pipeline Health |
| 20 | **Pipeline Velocity** | Supplementary query on won opportunities | Pipeline Health |
| 21 | **Opportunity Aging** | Supplementary query on active opportunities | Pipeline Health |
| 22 | **Stale Pipeline Count** | Supplementary query (active + no recent meeting) | Pipeline Health |
| 23 | **Actions per Closer (daily avg)** | `COUNT(domainEvents WHERE actorUserId=closer) / distinct_active_days` in period | Activity Feed, Team Performance |
| 24 | **Activity by Source** | Count of domain events grouped by `source` (closer / admin / pipeline / system) | Activity Feed |
| 25 | **Activity by Entity** | Count of domain events grouped by `entityType` (meeting / opportunity / payment / lead / user) | Activity Feed |
| 26 | **Most Active Closer** | `MAX(byActor)` from activity summary in period | Activity Feed |

### Tier 3: Meeting Time Tracking KPIs (ship with v0.6)

These KPIs are enabled by the new "End Meeting" feature (AD-6). All are computed via supplementary queries on completed meetings with time-tracking data.

| # | KPI | Formula | Where Shown |
| --- | --- | --- | --- |
| 27 | **On-Time Start Rate** | `COUNT(lateStartDurationMs = 0) / COUNT(started meetings)` | Team Performance |
| 28 | **Avg Late Start Duration** | `AVG(lateStartDurationMs) WHERE lateStartDurationMs > 0` (minutes) | Team Performance |
| 29 | **Overran Rate** | `COUNT(overranDurationMs > 0) / COUNT(completed meetings)` | Team Performance |
| 30 | **Avg Overrun Duration** | `AVG(overranDurationMs) WHERE overranDurationMs > 0` (minutes) | Team Performance |
| 31 | **Avg Actual Meeting Duration** | `AVG(stoppedAt - startedAt)` for completed meetings (minutes) | Team Performance |
| 32 | **Schedule Adherence** | `COUNT(on-time start AND not overran) / COUNT(completed meetings)` | Team Performance |
| 33 | **Late Start Reasons** | Distribution of `lateStartReason` values | Team Performance detail |

### Tier 4: Conversion, Lead & Form Response KPIs (ship with v0.6)

| # | KPI | Source | Where Shown |
| --- | --- | --- | --- |
| 34 | **New Leads** | `leadTimeline` aggregate | Leads & Conversions |
| 35 | **Conversions** | `customerConversions` aggregate | Leads & Conversions |
| 36 | **Lead Conversion Rate** | Computed from 34, 35 | Leads & Conversions |
| 37 | **Avg Meetings per Sale** | Supplementary query | Leads & Conversions |
| 38 | **Avg Time to Conversion** | Supplementary query | Leads & Conversions |
| 39 | **Conversions per Closer** | `customerConversions` aggregate (prefix by closer) | Leads & Conversions |
| 40 | **Form Response Rate** | `COUNT(DISTINCT meetingId in meetingFormResponses) / COUNT(meetings)` in period | Leads & Conversions (Form Insights) |
| 41 | **Top Answer per Field** | `MODE(answerText)` from `meetingFormResponses` grouped by `fieldKey` | Leads & Conversions (Form Insights) |
| 42 | **Answer Distribution per Field** | `GROUP BY answerText, COUNT(*)` for selected `fieldKey` from `meetingFormResponses` | Leads & Conversions (Form Insights) |

### Tier 5: Future KPIs (not in v0.6 scope)

| KPI | Notes |
| --- | --- |
| Follow-up Efficiency | Requires tracking follow-up → rebook linkage more rigorously |
| No-Show Recovery Rate | No-shows that eventually rebooked and paid; needs chain tracking |
| Revenue per Lead Source | Requires UTM attribution to be consistently set |
| Customer Lifetime Value | Requires sufficient customer payment history |
| Sales by Call Classification | Requires a second payment aggregate keyed by `[closerId, classification, recordedAt]` |
| Answer-to-Conversion Correlation | Requires joining `meetingFormResponses` → `leads` → `customers`; deferred due to small sample size at current scale |
| Full Entity Timeline | Per-entity chronological event log from `domainEvents`; requires entity-detail-page UI pattern (not a report page) |

---

## 10. Frontend Routes & Components

### Route Structure

```
app/workspace/reports/
├── layout.tsx              # Auth gate: requireRole(["tenant_master", "tenant_admin"])
├── loading.tsx             # Reports skeleton
├── page.tsx                # Reports landing → redirect to /reports/team
├── team/
│   ├── page.tsx            # Team Performance report
│   └── _components/
│       ├── team-report-page-client.tsx
│       ├── team-report-controls.tsx       # Date picker, granularity toggle
│       ├── team-kpi-summary-cards.tsx     # Top-line KPIs (4-6 cards)
│       ├── closer-performance-table.tsx   # Per-closer KPI table (New Calls)
│       ├── follow-up-performance-table.tsx # Per-closer KPI table (Follow-up)
│       ├── outcome-distribution-chart.tsx # Pie/bar chart of call outcomes
│       └── team-report-skeleton.tsx
├── revenue/
│   ├── page.tsx            # Revenue report
│   └── _components/
│       ├── revenue-report-page-client.tsx
│       ├── revenue-trend-chart.tsx        # Line chart over time
│       ├── closer-revenue-table.tsx       # Per-closer revenue breakdown
│       ├── deal-size-distribution.tsx     # Histogram
│       ├── top-deals-table.tsx            # Top 10 deals
│       └── revenue-report-skeleton.tsx
├── pipeline/
│   ├── page.tsx            # Pipeline Health report
│   └── _components/
│       ├── pipeline-report-page-client.tsx
│       ├── status-distribution-chart.tsx  # Donut chart
│       ├── pipeline-aging-table.tsx       # Avg days per status
│       ├── velocity-metric-card.tsx       # Days to close
│       ├── stale-pipeline-list.tsx        # Opps needing attention
│       └── pipeline-report-skeleton.tsx
├── leads/
│   ├── page.tsx            # Lead & Conversion report (includes Form Insights section)
│   └── _components/
│       ├── leads-report-page-client.tsx
│       ├── conversion-funnel-chart.tsx    # New leads → conversions
│       ├── conversion-by-closer-table.tsx
│       ├── form-response-analytics-section.tsx  # Container with field selector
│       ├── field-answer-distribution.tsx         # Bar chart of answer frequencies
│       ├── form-field-selector.tsx               # Dropdown from eventTypeFieldCatalog
│       ├── form-response-table.tsx               # Tabular answer frequency view
│       └── leads-report-skeleton.tsx
└── activity/
    ├── page.tsx            # Activity Feed report
    └── _components/
        ├── activity-feed-page-client.tsx
        ├── activity-feed-list.tsx         # Paginated event list with filters
        ├── activity-feed-filters.tsx      # entityType/eventType/actor/date filters
        ├── activity-event-row.tsx         # Single event: icon + actor + verb + timestamp
        ├── activity-summary-cards.tsx     # Top-line activity counts by source
        └── activity-feed-skeleton.tsx
```

### Navigation

Add a "Reports" section to the admin sidebar (`WorkspaceShellClient`):

```
📊 Reports
  ├── Team Performance
  ├── Revenue
  ├── Pipeline Health
  ├── Leads & Conversions
  └── Activity Feed
```

Visible only when `useRole().hasPermission("pipeline:view-all")` (tenant_master and tenant_admin).

### Data Fetching Pattern

Because reports are now reactive queries (not actions), the frontend uses the standard Convex pattern:

```tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

function TeamReportPageClient() {
  const [startDate, setStartDate] = useState(startOfMonth);
  const [endDate, setEndDate] = useState(endOfMonth);

  // Reactive — updates live as data changes
  const metrics = useQuery(api.reporting.teamPerformance.getTeamPerformanceMetrics, {
    startDate,
    endDate,
  });

  if (metrics === undefined) return <TeamReportSkeleton />;

  return (
    <>
      <ReportDateControls startDate={startDate} endDate={endDate} onChange={...} />
      <TeamKpiSummaryCards totals={metrics.teamTotals} />
      <CloserPerformanceTable closers={metrics.closers} callType="new" />
      <CloserPerformanceTable closers={metrics.closers} callType="follow_up" />
    </>
  );
}
```

### Date Range Controls

Shared `<ReportDateControls>` component used across all report pages:

- **Quick picks**: Today, This Week, This Month, Last Month, Last 90 Days, Custom
- **Custom range**: Two date pickers (start, end)
- **Granularity toggle**: Day / Week / Month (only for trend charts)

State managed locally via `useState`. When dates change, `useQuery` automatically refetches.

### Charts — shadcn/ui + Recharts v3

All charts use the **shadcn `chart` component** (`components/ui/chart.tsx`) which wraps [Recharts v3](https://recharts.org/) with theme-aware colors, accessible tooltips, and legend components. The `chart` component is already installed in the project.

**Pattern**: Build charts using Recharts primitives (`BarChart`, `LineChart`, etc.) inside a `ChartContainer`, and layer in shadcn's `ChartTooltip`, `ChartTooltipContent`, `ChartLegend`, and `ChartLegendContent` for consistent styling.

```tsx
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
} from "@/components/ui/chart"

const chartConfig = {
  newCalls: {
    label: "New Calls",
    color: "var(--chart-1)",
  },
  followUpCalls: {
    label: "Follow-Up Calls",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig

function CloserComparisonChart({ data }) {
  return (
    <ChartContainer config={chartConfig} className="min-h-[300px] w-full">
      <BarChart accessibilityLayer data={data}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="closerName" tickLine={false} axisLine={false} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="newCalls" fill="var(--color-newCalls)" radius={4} />
        <Bar dataKey="followUpCalls" fill="var(--color-followUpCalls)" radius={4} />
      </BarChart>
    </ChartContainer>
  )
}
```

**Key conventions**:
- Colors reference CSS variables via `var(--color-KEY)` (Recharts v3 — no `hsl()` wrapping)
- `ChartConfig` maps data keys to human-readable labels + color tokens (OKLCH via `--chart-1` through `--chart-5`)
- Always set `min-h-*` on `ChartContainer` so `ResponsiveContainer` can measure
- Always add `accessibilityLayer` to the root chart component for keyboard + screen reader support

**Chart types per report page**:

| Report | Chart Type | Recharts Component | Purpose |
| --- | --- | --- | --- |
| Revenue | Line chart | `LineChart` + `Line` | Revenue trend over time |
| Revenue | Histogram | `BarChart` + `Bar` | Deal size distribution |
| Team Performance | Grouped bar chart | `BarChart` + `Bar` | Per-closer KPI comparison |
| Team Performance | Pie chart | `PieChart` + `Pie` | Meeting outcome distribution |
| Pipeline Health | Donut chart | `PieChart` + `Pie` (with `innerRadius`) | Pipeline status distribution |
| Leads & Conversions | Funnel / bar chart | `BarChart` + `Bar` | Conversion funnel |
| Leads & Conversions (Form Insights) | Horizontal bar chart | `BarChart` + `Bar` (with `layout="vertical"`) | Answer frequency distribution |

Browse the full shadcn chart library for additional styles: [ui.shadcn.com/charts](https://ui.shadcn.com/charts)

---

## 11. Implementation Phases

### Phase 1: Aggregate Foundation (2-3 days)

**Install, define, schema, backfill.** Everything the reporting system depends on.

**Files created:**
- `convex/reporting/aggregates.ts` — 5 `TableAggregate` instance definitions
- `convex/reporting/backfill.ts` — backfill mutations for all 5 aggregates + `callClassification`
- `convex/reporting/lib/periodBucketing.ts` — `getPeriodKey`, `getPeriodsInRange` helpers

**Files modified:**
- `convex/convex.config.ts` — add 5 `app.use(aggregate, { name: "..." })` calls
- `convex/schema.ts` — add `callClassification` + time tracking fields to `meetings`
- `package.json` — add `@convex-dev/aggregate` dependency

**Steps:**
1. `pnpm add @convex-dev/aggregate`
2. Add 5 aggregate component registrations to `convex.config.ts`
3. Add to `meetings` schema: `callClassification`, `stoppedAt`, `lateStartDurationMs`, `lateStartReason`, `overranDurationMs` (all `v.optional`)
4. Create `convex/reporting/aggregates.ts` with all 5 `TableAggregate` instances
5. Deploy schema changes
6. Run `backfillMeetingClassification` to set `callClassification` on all ~213 meetings
7. Run backfill for each aggregate to populate from existing data
8. Verify: aggregate counts match direct table counts

**Depends on**: v0.5b schema deployed
**Risk**: Low — additive changes only; backfill is small dataset

### Phase 2: Meeting Time Tracking + Mutation Integration + Form Response Pipeline (3.5-4.5 days)

**Three goals**: (A) Build the `stopMeeting` mutation and enhance `startMeeting` with late-start detection. (B) Hook aggregate calls into every relevant mutation. (C) Wire live `meetingFormResponses` insertion into the pipeline. This is the highest-risk phase — must not miss any write point.

**Part A — Meeting Time Tracking (1-1.5 days):**
1. Enhance `startMeeting` in `closer/meetingActions.ts`: compute and store `lateStartDurationMs`
2. Add `setLateStartReason` mutation in `closer/meetingActions.ts`
3. Add `stopMeeting` mutation in `closer/meetingActions.ts`: transition meeting to `completed`, compute `overranDurationMs`, set `stoppedAt` and `completedAt`
4. Add frontend "End Meeting" button on meeting detail page (alongside existing "Start Meeting")
5. Add late-start prompt modal: shown after `startMeeting` returns if `lateStartDurationMs > 0`; calls `setLateStartReason` on submit

**Part B — Aggregate Hooks (2-2.5 days):**

**Files modified (~12):**

| File | Aggregates Hooked | Touch Points |
| --- | --- | --- |
| `pipeline/inviteeCreated.ts` | meetings (3 inserts), opportunities (1 insert + 2 status), leads (1 insert) | 7 |
| `pipeline/inviteeCanceled.ts` | meetings (1 status), opportunities (1 status) | 2 |
| `pipeline/inviteeNoShow.ts` | meetings (3 status changes), opportunities (2 status) | 5 |
| `closer/meetingActions.ts` | meetings (2 status: start + stop), opportunities (2 status) | 4 |
| `closer/noShowActions.ts` | meetings (1 status), opportunities (2 status) | 3 |
| `closer/followUpMutations.ts` | opportunities (3 status) | 3 |
| `closer/payments.ts` | payments (1 insert), opportunities (1 status) | 2 |
| `customers/mutations.ts` | payments (1 insert) | 1 |
| `customers/conversion.ts` | customers (1 insert) | 1 |
| `lib/syncOpportunityMeetingsAssignedCloser.ts` | meetings (N replaces in loop) | 1 |
| `unavailability/redistribution.ts` | meetings (3 changes), opportunities (2 changes) | 5 |

**Pattern for each:**

```typescript
// BEFORE (existing code):
await ctx.db.patch(meetingId, { status: "no_show", noShowMarkedAt: now });

// AFTER (with aggregate hook):
import { meetingsByStatus } from "../reporting/aggregates";

const oldDoc = await ctx.db.get(meetingId); // may already be loaded above
await ctx.db.patch(meetingId, { status: "no_show", noShowMarkedAt: now });
const newDoc = await ctx.db.get(meetingId);
await meetingsByStatus.replace(ctx, oldDoc!, newDoc!);
```

**Verification after each file:**
1. Run existing tests (if any)
2. Trigger the relevant flow (e.g., cancel a meeting in the Convex dashboard)
3. Check aggregate counts match expected values

**Part C — Live `meetingFormResponses` Pipeline Integration (0.5 day):**

Complete the v0.5b Section 3.7 specification that was not implemented during the v0.5b rollout:

1. Extract shared helper `convex/lib/meetingFormResponseWriter.ts` from backfill logic in `admin/migrations.ts` (~lines 509-640)
2. Wire into `pipeline/inviteeCreated.ts` at the 3 meeting-insert code paths:
   - Flow 1 (UTM reactivation) — after meeting insert at ~1161
   - Flow 2 (Heuristic reschedule) — after meeting insert at ~1403
   - Flow 4 (New opportunity) — after meeting insert at ~1593
3. For each inserted meeting: upsert `eventTypeFieldCatalog` entries + insert `meetingFormResponses` rows from `questions_and_answers`
4. Verify: trigger a test booking via Calendly and confirm `meetingFormResponses` rows appear

**Depends on**: Phase 1
**Risk**: Medium — high touch point count; systematic but tedious. Risk of missing a write point. Mitigation: the integration map in Section 7 is exhaustive. Part C additionally requires verifying against a live Calendly booking.

### Phase 3: Core Reporting Queries (3-4 days)

**Files created:**
- `convex/reporting/teamPerformance.ts` — Team Performance query
- `convex/reporting/revenue.ts` — Revenue metrics + details queries
- `convex/reporting/revenueTrend.ts` — Period-bucketed revenue trend
- `convex/reporting/pipelineHealth.ts` — Pipeline distribution + aging queries
- `convex/reporting/leadConversion.ts` — Lead & conversion metrics
- `convex/reporting/activityFeed.ts` — Activity feed + summary queries (v0.5b `domainEvents`)
- `convex/reporting/formResponseAnalytics.ts` — Field catalog + answer distribution queries (v0.5b `meetingFormResponses`)
- `convex/reporting/lib/outcomeDerivation.ts` — `deriveCallOutcome` helper for supplementary queries
- `convex/reporting/lib/eventLabels.ts` — Human-readable label map for all `eventType` values (e.g., `meeting.started` → "Started meeting")
- `convex/reporting/lib/helpers.ts` — shared utilities (`getActiveClosers`, `makeDateBounds`)

**Steps:**
1. Implement shared helpers + event labels map
2. Build Team Performance report query (aggregates + supplementary)
3. Build Revenue report queries (aggregate + payment scan)
4. Build Pipeline Health queries (aggregate + opp scan)
5. Build Lead & Conversion query (aggregates)
6. Build Activity Feed queries (`getActivityFeed` + `getActivitySummary`) — see Section 8.6
7. Build Form Response Analytics queries (`getFieldCatalog` + `getAnswerDistribution`) — see Section 8.7
8. Test all queries in Convex dashboard against known data

**Depends on**: Phase 2 (especially Part C — live form response insertion must be verified before step 7)
**Risk**: Medium — aggregation logic complexity. Cross-reference with Excel data for validation. Activity and form response queries are straightforward index scans.

### Phase 4: Frontend — Report Shell & Navigation (1-2 days)

**Files created:** Report layout, loading states, navigation updates

1. Create `app/workspace/reports/` route structure with auth-gated layout
2. Add report navigation to sidebar (permission-gated) — now 5 items including Activity Feed
3. Build shared `ReportDateControls` component
4. Build skeleton components for all 5 report pages
5. Set up the page pattern (RSC wrapper → client component → `useQuery`)

**Depends on**: Phase 3 queries available
**Risk**: Low — standard page scaffolding

### Phase 5: Frontend — Report Pages (5.5-6.5 days)

**5A. Team Performance (2 days)**
- Wire up `useQuery(getTeamPerformanceMetrics)` with date controls
- Build KPI summary cards (booked, showed, sales, revenue)
- Build New Calls performance table (per-closer rows + team total)
- Build Follow-Up Calls performance table
- Build outcome distribution chart

**5B. Revenue (1-2 days)**
- Revenue trend line chart (`useQuery(getRevenueTrend)`)
- Per-closer revenue breakdown table
- Deal size distribution histogram
- Top 10 deals table

**5C. Pipeline Health (1 day)**
- Status distribution donut chart
- Aging table with avg days per status
- Velocity metric card
- Stale opportunities list

**5D. Lead & Conversion + Form Insights (1 day)**
- Conversion funnel visualization
- Conversions by closer table
- Form Insights section:
  - Field selector dropdown (`useQuery(getFieldCatalog)`)
  - Answer distribution bar chart (`useQuery(getAnswerDistribution)`) — updates reactively when field selection changes
  - Frequency table with counts and percentages
  - Empty state when no form fields exist

**5E. Activity Feed (1 day)**
- Activity summary cards (total events, by-source breakdown, most active closer)
- Paginated event list with `useQuery(getActivityFeed)` + date range controls
- Filter controls: entity type, event type, actor dropdown
- Human-readable event rendering using `eventLabels` map:
  - Row format: `[icon by entityType] [actor name] [verb] [relative timestamp]`
  - Expandable metadata for events with extra context (e.g., `overranDurationMs` for `meeting.stopped`)
- "Load more" pagination (increment `limit` param)
- Skeleton loading state

All with skeleton loading states, error boundaries, responsive layout.

**Depends on**: Phase 4
**Risk**: Medium — chart configuration and number formatting. Activity Feed requires the `eventLabels` map to be comprehensive (all ~20 event types need human-readable labels).

### Phase 6: QA & Polish (1-2 days)

1. Cross-reference Team Performance report against Excel data (January + February 2026)
2. Verify all 9 Tier 1 KPIs match expected values
3. Verify aggregate counts stay in sync after live mutations
4. Run Expect for accessibility, performance, responsive testing (4 viewports)
5. Edge cases: empty date ranges, single-day ranges, closers with zero meetings
6. Error states: loading skeletons, auth expiry
7. Performance: ensure report queries render under 1 second
8. Verify Activity Feed displays domain events with correct actor attribution and human-readable labels
9. Verify Form Insights shows answer distribution for at least one Calendly form field
10. Verify live bookings (post-Phase 2C) create `meetingFormResponses` rows — confirm they appear in Form Insights

**Depends on**: Phase 5
**Total estimated effort**: **16-22 days**

---

## 12. Risk & Constraints

| Risk | Impact | Mitigation |
| --- | --- | --- |
| **Missing aggregate hook** | Aggregate count drifts from source table | Exhaustive integration map (Section 7); periodic reconciliation script that compares aggregate vs table counts |
| **Aggregate backfill ordering** | Backfilling before schema deploy fails | Phase 1 is sequenced: schema → deploy → backfill classification → backfill aggregates |
| **Component version compat** | `@convex-dev/aggregate` API may differ from docs | Pin to v0.2.1; verify API against installed package before coding |
| **Reactive query performance** | 96 aggregate calls per Team Performance render could be slow on cold cache | Monitor; each call is O(log n) and aggregate data is small. If needed, batch into fewer queries |
| **Chart rendering performance** | Large datasets in Recharts v3 (via shadcn `ChartContainer`) could cause jank | Limit trend data to max 90 data points; aggregate to coarser granularity for long ranges. Always set `min-h-*` on `ChartContainer` for proper responsive sizing |
| **Time zones** | `scheduledAt` is UTC epoch; reports may need tenant timezone | v0.6 uses UTC. Tenant timezone support can be added in v0.7 |
| **Aggregate data structure growth** | 5 aggregate instances add internal tables | Aggregate uses a balanced tree; space is O(n) per instance. At current scale (~700 total records) this is negligible |
| **Transaction write limits** | Bulk operations (redistribution) that replace many meetings in aggregate could hit limits | Redistribution already batches; aggregate replace adds ~2 reads + ~2 writes per meeting. Monitor batch sizes |
| **`domainEvents` summary scan at 10x scale** | `getActivitySummary` scans all events in date range; at 10,000+/month could approach read limits | Paginated feed (`take(50)`) is safe at any scale. Summary query only risks at 10x growth. Documented scaling path: add `domainEventCounts` aggregate at that point |
| **`meetingFormResponses` not populated by live pipeline** | Form response analytics only reflect backfilled historical data, not new bookings | Phase 2C prerequisite: wire `meetingFormResponses` insertion into `inviteeCreated.ts`. Verify with a test booking before Phase 3 query work |

---

## 13. Success Criteria

### Must Have (v0.6 release gate)

- [ ] All 9 Tier 1 KPIs (Excel replacements) compute correctly
- [ ] Team Performance report matches Excel data for January 2026 (within 5% tolerance for edge-case timing)
- [ ] All 5 aggregate instances are populated and stay in sync with source tables
- [ ] Reports are accessible only to `tenant_master` and `tenant_admin`
- [ ] Date range filtering works for day, week, and month granularity
- [ ] New/Follow-up split is present and correctly classified
- [ ] Reports are reactive (update live when data changes)
- [ ] "End Meeting" button works: records `stoppedAt`, computes `overranDurationMs`, transitions to `completed`
- [ ] Late start detection works: `lateStartDurationMs` computed at start, reason prompt shown
- [ ] All report pages have loading skeletons and error boundaries
- [ ] Responsive layout passes on 4 viewports (mobile, tablet, desktop, wide)
- [ ] Accessibility audit passes (axe-core)

### Should Have

- [ ] All Tier 2 KPIs (Enhanced + Activity) are present — including activity-by-source and actions-per-closer
- [ ] All Tier 3 KPIs (Meeting Time Tracking) are present — requires `stopMeeting` usage
- [ ] All Tier 4 KPIs (Lead & Conversion + Form Insights) are present
- [ ] Activity Feed shows the 50 most recent domain events with correct actor attribution
- [ ] Activity Feed filters work (by entity type, event type, actor)
- [ ] Form Insights shows answer distribution for at least one Calendly form field
- [ ] Live pipeline bookings create `meetingFormResponses` rows (Phase 2C verified)
- [ ] Charts render without performance issues
- [ ] Report pages render in under 1 second

### Nice to Have

- [ ] Quick-pick date range presets (This Month, Last Month, etc.)
- [ ] Report pages accessible from the command palette (Cmd+K)
- [ ] Reconciliation script that verifies aggregate integrity
- [ ] Activity Feed: expandable metadata on events with extra context (overrun duration, payment amount, etc.)
- [ ] Form Insights: date-range-filtered answer distribution (not just all-time)

---

## Appendix A: File Inventory

### New Files (~36)

```
convex/reporting/
├── aggregates.ts                   # 5 TableAggregate instance definitions
├── teamPerformance.ts              # Team Performance query
├── revenue.ts                      # Revenue metrics + details queries
├── revenueTrend.ts                 # Period-bucketed revenue trend
├── pipelineHealth.ts               # Pipeline distribution + aging queries
├── leadConversion.ts               # Lead & conversion metrics
├── activityFeed.ts                 # Activity feed + summary queries (domainEvents)
├── formResponseAnalytics.ts        # Field catalog + answer distribution (meetingFormResponses)
├── backfill.ts                     # Backfill mutations (classification + all 5 aggregates)
└── lib/
    ├── periodBucketing.ts          # getPeriodKey, getPeriodsInRange
    ├── outcomeDerivation.ts        # deriveCallOutcome for supplementary queries
    ├── eventLabels.ts              # Human-readable eventType → label map (~20 entries)
    └── helpers.ts                  # getActiveClosers, makeDateBounds

convex/lib/
└── meetingFormResponseWriter.ts    # Shared helper: upsert catalog + insert responses (extracted from migration)

app/workspace/reports/
├── layout.tsx
├── loading.tsx
├── page.tsx
├── team/
│   ├── page.tsx
│   └── _components/ (6 files)
├── revenue/
│   ├── page.tsx
│   └── _components/ (5 files)
├── pipeline/
│   ├── page.tsx
│   └── _components/ (5 files)
├── leads/
│   ├── page.tsx
│   └── _components/ (8 files — original 4 + 4 form response components)
└── activity/
    ├── page.tsx
    └── _components/ (6 files)
```

### Modified Files (~13)

```
convex/convex.config.ts                     # Add 5 aggregate component registrations
convex/schema.ts                            # Add callClassification + time tracking fields to meetings
package.json                                # Add @convex-dev/aggregate dependency
convex/pipeline/inviteeCreated.ts           # 7 aggregate hooks + set callClassification + meetingFormResponses insertion (Phase 2C)
convex/pipeline/inviteeCanceled.ts          # 2 aggregate hooks
convex/pipeline/inviteeNoShow.ts            # 5 aggregate hooks
convex/closer/meetingActions.ts             # 4 aggregate hooks + stopMeeting + setLateStartReason + startMeeting late-start tracking
convex/closer/noShowActions.ts              # 3 aggregate hooks
convex/closer/followUpMutations.ts          # 3 aggregate hooks
convex/closer/payments.ts                   # 2 aggregate hooks
convex/customers/mutations.ts               # 1 aggregate hook
convex/customers/conversion.ts              # 1 aggregate hook
convex/lib/syncOpportunityMeetingsAssignedCloser.ts  # meeting aggregate replace in loop
convex/unavailability/redistribution.ts     # 5 aggregate hooks
app/workspace/_components/workspace-shell-client.tsx  # Add Reports nav section (5 items)
```

### Estimated Total: ~49 files (21 backend, 28 frontend)
