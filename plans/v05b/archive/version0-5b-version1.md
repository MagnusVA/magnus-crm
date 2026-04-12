# v0.5b — Database Foundation & Analytics Readiness

**Status**: Specification (Pre-Implementation)
**Date**: 2026-04-12
**Based on**: Definitive Database Audit Report (`.docs/audits/definite-database-audit-report.md`) — 5 independent audits consolidated
**Scope**: Operationalize 22 audit findings into a phased implementation plan that transitions this CRM from an operational foundation to an analytics-grade data model.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Data State & Migration Context](#data-state--migration-context)
3. [Phase 1 — Schema Foundation: Event History, Indexes & Closer Dimension](#phase-1--schema-foundation-event-history-indexes--closer-dimension)
4. [Phase 2 — Data Model Correctness: Types, Money & Timestamps](#phase-2--data-model-correctness-types-money--timestamps)
5. [Phase 3 — Performance: Summary Tables, Query Flattening & Pagination](#phase-3--performance-summary-tables-query-flattening--pagination)
6. [Phase 4 — Data Integrity: Soft-Delete, Cascade & Cleanup](#phase-4--data-integrity-soft-delete-cascade--cleanup)
7. [Phase 5 — Structural: OAuth Separation (Deferred)](#phase-5--structural-oauth-separation-deferred)
8. [Frontend Side Effects Matrix](#frontend-side-effects-matrix)
9. [Implementation Roadmap](#implementation-roadmap)
10. [Testing & Validation Gates](#testing--validation-gates)
11. [Risk Matrix](#risk-matrix)
12. [Skills & Resources](#skills--resources)
13. [Success Criteria](#success-criteria)

---

## Executive Summary

All 5 independent audits converged on the same conclusion: the current schema is a solid operational CRM foundation but not yet an analytics-grade data model. The 5 main gaps are:

1. **No durable event history** — status transitions overwrite in place; cannot answer "what happened over time"
2. **Custom fields are an untyped blob** — `leads.customFields` uses `v.any()`, loses per-interaction provenance
3. **Scan-on-read aggregates** — dashboards run 4 full table scans on every reactive render
4. **Missing relationship and analytics indexes** — hot reads depend on post-fetch JS filtering
5. **Unsafe money model** — floating-point amounts with no currency controls

This spec addresses all 22 findings across 5 phases, ordered by: correctness first, then performance, then structural improvements. Every change is traced to specific files, line numbers, and downstream side effects verified against the live codebase.

**Data context**: 1 test tenant, 213 meetings, 213 opportunities, 288 raw webhook events. No real migration risk — clean backfill or fresh start are both viable.

---

## Data State & Migration Context

| Table | Row Count (approx) | Migration Complexity |
|-------|-------------------|---------------------|
| `tenants` | 1 | Trivial |
| `users` | ~5 | Trivial |
| `rawWebhookEvents` | 288 | Trivial |
| `opportunities` | 213 | Small — backfill optional fields |
| `meetings` | 213 | Small — backfill `assignedCloserId` from opportunity chain |
| `leads` | ~100-200 | Small — backfill `status: "active"` for undefined |
| `paymentRecords` | ~20-50 | Trivial — compute `amountMinor = Math.round(amount * 100)` |
| `customers` | ~10-30 | Trivial |
| `followUps` | ~30-50 | Trivial — backfill `type` from existing field presence |
| `eventTypeConfigs` | ~5-10 | Deduplicate by `(tenantId, calendlyEventTypeUri)` |
| `leadIdentifiers` | ~200-400 | No changes needed |
| `leadMergeHistory` | ~5-10 | No changes needed |
| `closerUnavailability` | ~5-10 | No changes needed |
| `meetingReassignments` | ~5-10 | No changes needed |

**Migration approach**: Given the tiny dataset, we can use `convex-migration-helper` widen-migrate-narrow for correctness and to establish the pattern, but a full data reset is always available as a fallback. The 30-day raw webhook retention window (`convex/webhooks/cleanup.ts` line 6: `RETENTION_MS = 30 * 24 * 60 * 60 * 1000`) means per-meeting booking answer backfill must happen before historical events expire.

---

## Phase 1 — Schema Foundation: Event History, Indexes & Closer Dimension

**Goal**: Establish the event history backbone, add missing relationship indexes, and denormalize the closer dimension onto meetings.
**Duration**: ~1 week
**Risk**: Low (purely additive — new table, new indexes, new optional field)
**Skills**: `convex-migration-helper` (for `meetings.assignedCloserId` backfill)
**Prerequisite**: Read `convex/_generated/ai/guidelines.md` before any schema work

### 1.1 — Add `domainEvents` Table (Audit F1)

**Severity**: 🔴 High — confirmed by all 5 audits
**Why**: Every status transition currently overwrites in place. There is no record of when, who, what the previous state was, or how long an entity spent in each stage. This blocks all time-based analytics, funnel reporting, and accountability tracking.

#### Schema addition (`convex/schema.ts`)

```typescript
domainEvents: defineTable({
  tenantId: v.id("tenants"),
  entityType: v.union(
    v.literal("opportunity"),
    v.literal("meeting"),
    v.literal("lead"),
    v.literal("customer"),
    v.literal("followUp"),
    v.literal("user"),
  ),
  entityId: v.string(),
  eventType: v.string(),
  actorUserId: v.optional(v.id("users")),
  source: v.union(
    v.literal("closer"),
    v.literal("admin"),
    v.literal("pipeline"),
    v.literal("system"),
  ),
  occurredAt: v.number(),
  metadata: v.optional(v.string()), // JSON-serialized event payload
})
  .index("by_entityId", ["entityId"])
  .index("by_tenantId_and_occurredAt", ["tenantId", "occurredAt"])
  .index("by_tenantId_and_entityType_and_entityId_and_occurredAt", [
    "tenantId", "entityType", "entityId", "occurredAt",
  ])
  .index("by_tenantId_and_eventType_and_occurredAt", [
    "tenantId", "eventType", "occurredAt",
  ])
```

#### New helper: `convex/lib/domainEvents.ts`

```typescript
import { MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";

type EntityType = "opportunity" | "meeting" | "lead" | "customer" | "followUp" | "user";
type Source = "closer" | "admin" | "pipeline" | "system";

export async function emitDomainEvent(
  ctx: MutationCtx,
  params: {
    tenantId: Id<"tenants">;
    entityType: EntityType;
    entityId: string;
    eventType: string;
    actorUserId?: Id<"users">;
    source: Source;
    metadata?: Record<string, unknown>;
  }
) {
  await ctx.db.insert("domainEvents", {
    tenantId: params.tenantId,
    entityType: params.entityType,
    entityId: params.entityId,
    eventType: params.eventType,
    actorUserId: params.actorUserId,
    source: params.source,
    occurredAt: Date.now(),
    metadata: params.metadata ? JSON.stringify(params.metadata) : undefined,
  });
}
```

#### Mutation call sites for dual-write

These are the verified mutation files that perform status transitions and must emit domain events:

| Mutation | File | Event(s) to emit |
|----------|------|-----------------|
| Opportunity status transitions | `convex/pipeline/inviteeCreated.ts` (lines 991, 1242, 1378) | `opportunity.status_changed` with `{from, to}` |
| Meeting creation | `convex/pipeline/inviteeCreated.ts` (meeting insert) | `meeting.created` |
| Meeting cancellation | `convex/pipeline/inviteeCanceled.ts` | `meeting.canceled`, `opportunity.status_changed` |
| Meeting no-show | `convex/pipeline/inviteeNoShow.ts` | `meeting.no_show`, `opportunity.status_changed` |
| Meeting started | Closer UI mutation (via `meeting_started` PostHog event) | `meeting.started` |
| Payment logged | `convex/closer/payments.ts` (lines 38-178) | `payment.recorded`, `opportunity.status_changed` |
| Mark lost | Closer UI mutation (via `opportunity_marked_lost` PostHog event) | `opportunity.marked_lost` |
| Follow-up created | `convex/closer/followUpMutations.ts` | `followUp.created`, `opportunity.status_changed` |
| Follow-up booked | `convex/closer/followUpMutations.ts` (line 83) | `followUp.booked` |
| Customer conversion | `convex/customers/conversion.ts` (lines 87-102) | `customer.converted`, `lead.status_changed` |
| Lead merge | `convex/leads/mutations.ts` (merge handler) | `lead.merged` |
| User invitation/removal | `convex/workos/userMutations.ts` | `user.invited`, `user.removed`, `user.role_changed` |

**PostHog relationship**: 6 client-side PostHog captures correspond to status transitions (`payment_logged`, `meeting_started`, `opportunity_marked_lost`, `meeting_marked_no_show`, `no_show_reschedule_link_sent`, `follow_up_scheduling_link_created`). These should NOT be removed — PostHog tracks product analytics (funnel adoption, feature usage); `domainEvents` is the authoritative server-side audit trail. The unused `lib/posthog-capture.ts` server-side capture helper could later be wired to mirror domain events to PostHog via `@posthog/convex`.

**Frontend impact**: None. Domain events are backend-only.

---

### 1.2 — Add Missing Relationship Indexes (Audit F10)

**Severity**: 🔴 High — confirmed by all 5 audits
**Why**: Several hot query paths scan broad indexes and filter in JavaScript. These are avoidable — the relationships are known and stable.

#### New indexes on `convex/schema.ts`

| Table | New Index | Fields | Eliminates |
|-------|-----------|--------|-----------|
| `opportunities` | `by_tenantId_and_assignedCloserId_and_status` | `["tenantId", "assignedCloserId", "status"]` | `.collect()` + JS status filter in `convex/closer/pipeline.ts:33-43`, `convex/closer/dashboard.ts:21-27` |
| `opportunities` | `by_tenantId_and_potentialDuplicateLeadId` | `["tenantId", "potentialDuplicateLeadId"]` | `.take(500)` + JS filter in merge duplicate-flag cleanup |
| `opportunities` | `by_tenantId_and_eventTypeConfigId` | `["tenantId", "eventTypeConfigId"]` | Full tenant scan in `convex/eventTypeConfigs/queries.ts:70-92` |
| `rawWebhookEvents` | `by_tenantId_and_eventType_and_calendlyEventUri` | `["tenantId", "eventType", "calendlyEventUri"]` | Unbounded scan + JS URI compare in `convex/webhooks/calendlyMutations.ts:15-29` (confirmed OCC conflict source) |
| `followUps` | `by_tenantId_and_leadId` | `["tenantId", "leadId"]` | `.take(200)` by tenant + JS filter by leadId in `convex/leads/queries.ts:274,351` |
| `followUps` | `by_opportunityId_and_status` | `["opportunityId", "status"]` | `by_opportunityId` + JS status filter in `convex/closer/followUpMutations.ts:83` |
| `customers` | `by_tenantId_and_convertedByUserId` | `["tenantId", "convertedByUserId"]` | Paginate by tenant + JS filter by closer in `convex/customers/queries.ts:52-54` |
| `customers` | `by_tenantId_and_convertedByUserId_and_status` | `["tenantId", "convertedByUserId", "status"]` | Compound closer + status filter |

#### Query files to update after index addition

| Query Function | File | Current Pattern | New Pattern |
|---------------|------|-----------------|-------------|
| `getPipelineSummary` | `convex/closer/dashboard.ts:85-121` | `.collect()` all closer opps → JS count by status | `.withIndex("by_tenantId_and_assignedCloserId_and_status")` with status prefix |
| `listMyOpportunities` | `convex/closer/pipeline.ts:24-70` | `.collect()` → JS filter by status → JS sort | `.withIndex(...)` with status filter → `.take(n)` |
| `getLeadDetail` (follow-ups) | `convex/leads/queries.ts:274` | `followUps.by_tenantId` + filter by leadId at line 351 | `followUps.by_tenantId_and_leadId` |
| `persistRawEvent` | `convex/webhooks/calendlyMutations.ts:15-29` | `by_tenantId_and_eventType` + JS URI compare loop | `by_tenantId_and_eventType_and_calendlyEventUri` → `.first()` |
| `getEventTypeConfigsWithStats` | `convex/eventTypeConfigs/queries.ts:70-92` | Full opp scan → JS groupBy configId | `by_tenantId_and_eventTypeConfigId` per config |
| `listCustomers` (closer filter) | `convex/customers/queries.ts:52-54` | Paginate by tenant → return null for non-matching closer | `by_tenantId_and_convertedByUserId` paginated |

**Frontend impact**: None (return shapes unchanged). Performance improvement visible to users.

---

### 1.3 — Add `meetings.assignedCloserId` Denormalized Field (Audit F4)

**Severity**: 🔴 High — confirmed by all 5 audits
**Why**: The app repeatedly collects ALL of a closer's opportunities (unbounded `.collect()`), builds an ID set, then scans ALL tenant meetings to filter by that set. This two-hop pattern is the root cause of performance issues in 5+ query paths.

#### Schema change (`convex/schema.ts`, meetings table at line 255)

Add optional field:
```typescript
assignedCloserId: v.optional(v.id("users")),
```

Add indexes:
```typescript
.index("by_tenantId_and_assignedCloserId_and_scheduledAt", [
  "tenantId", "assignedCloserId", "scheduledAt"
])
```

#### Maintenance contract

| Trigger | Where | Action |
|---------|-------|--------|
| Meeting created (pipeline) | `convex/pipeline/inviteeCreated.ts` (meeting insert) | Copy `opportunity.assignedCloserId` to new meeting field |
| Opportunity reassigned | Reassignment mutations | Batch-update all meetings for that opportunity |
| Lead merge (opportunity moves) | `convex/leads/mutations.ts` merge handler | Update meetings if opportunity ownership changes |

#### Backfill script

```typescript
// convex/admin/backfillMeetingCloserId.ts
export const backfillMeetingCloserId = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const batch = await ctx.db
      .query("meetings")
      .paginate({ numItems: 100, cursor: args.cursor ?? null });
    
    for (const meeting of batch.page) {
      if (meeting.assignedCloserId !== undefined) continue;
      const opp = await ctx.db.get(meeting.opportunityId);
      if (opp?.assignedCloserId) {
        await ctx.db.patch(meeting._id, { assignedCloserId: opp.assignedCloserId });
      }
    }
    
    if (!batch.isDone) {
      await ctx.scheduler.runAfter(0, internal.admin.backfillMeetingCloserId.backfillMeetingCloserId, {
        cursor: batch.continueCursor,
      });
    }
  },
});
```

#### Query paths that switch to direct index lookup

| Query | File | Current Two-Hop | New Direct Lookup |
|-------|------|-----------------|-------------------|
| `getNextMeeting` | `convex/closer/dashboard.ts:13-77` | `.collect()` all opps → build ID set → scan meetings | `meetings.by_tenantId_and_assignedCloserId_and_scheduledAt` with `gte(now)` → `.first()` |
| `getMeetingsForRange` | `convex/closer/calendar.ts:15-85` | `.collect()` all opps → scan date range → JS filter by opp set | `meetings.by_tenantId_and_assignedCloserId_and_scheduledAt` with range bounds |
| `listAffectedMeetingsForCloserInRange` | `convex/unavailability/shared.ts:95-151` | `listActiveOpportunityIdsForCloser()` → scan meetings → JS filter | Direct indexed range query |
| `buildCloserSchedulesForDate` | `convex/unavailability/shared.ts:153-262` | For each closer: scan all opps → build map → scan day's meetings | Per-closer indexed query |
| Meeting detail auth | `convex/closer/meetingDetail.ts:45-59` | Fetch meeting → fetch opportunity → check `assignedCloserId` | Still needs opportunity for data, but auth check could be direct |

**Frontend impact**: None (return shapes unchanged). Closer dashboard, calendar, and pipeline views get significantly faster.

---

### 1.4 — Fix Event Type Config Uniqueness (Audit F9)

**Severity**: 🔴 High — confirmed by GPT1, GPT2, GPT3
**Why**: Multiple configs can exist for the same `(tenantId, calendlyEventTypeUri)`. Pipeline explicitly loads up to 8 configs and picks the oldest (`convex/pipeline/inviteeCreated.ts:707-715`). Duplicate dimension rows break analytics aggregation.

#### Implementation

1. **One-time dedupe script**: Query all configs grouped by `(tenantId, calendlyEventTypeUri)`, keep the oldest, delete duplicates.
2. **Upsert pattern**: Funnel all future writes through a single upsert path in `convex/eventTypeConfigs/mutations.ts` — check existence by index before insert, update if exists.
3. **Remove duplicate-tolerant read logic**: Once deduped, `lookupEventTypeConfig()` in `convex/pipeline/inviteeCreated.ts:685-717` no longer needs `.take(8)` + sort by `createdAt`. Change to `.first()`.

#### Files to modify

- `convex/eventTypeConfigs/mutations.ts` — add upsert guard
- `convex/pipeline/inviteeCreated.ts:685-717` — simplify to `.first()` after dedupe
- New: `convex/admin/deduplicateEventTypeConfigs.ts` — one-time cleanup script

**Frontend impact**: None.

---

### 1.5 — Finding 19 Resolution: Already Fixed

**Note**: The audit flagged `convex/admin/inviteCleanupMutations.ts` as using `.filter()` instead of `withIndex`. Codebase investigation confirmed this is **already using `withIndex("by_status_and_inviteExpiresAt")`** correctly (line 12-15). No action needed.

---

## Phase 2 — Data Model Correctness: Types, Money & Timestamps

**Goal**: Fix type safety, money model, lead status ambiguity, and add analytics timestamps.
**Duration**: ~1.5 weeks
**Risk**: Medium (type narrowing migrations on `leads.customFields`, `leads.status`, `paymentRecords.amount`)
**Skills**: `convex-migration-helper` (widen-migrate-narrow)

### 2.1 — Type-Narrow `leads.customFields` & Add Per-Meeting Booking Answers (Audit F2)

**Severity**: 🔴 High — confirmed by all 5 audits
**Why**: `leads.customFields` is `v.any()` (`convex/schema.ts:115`). The pipeline merges booking answers into this blob (`convex/pipeline/inviteeCreated.ts:30-66`), overwriting previous answers if the same lead books again. No per-meeting provenance. Data is unrecoverable after the 30-day raw webhook cleanup.

#### Phase 2.1a — Type narrowing

**Schema change** (widen-migrate-narrow via `convex-migration-helper`):

Step 1 — Widen: Change `v.any()` → `v.optional(v.record(v.string(), v.string()))` — accepts both shapes during migration.
Step 2 — Backfill: Iterate all leads; if `customFields` exists and has non-string values, coerce to strings.
Step 3 — Narrow: Keep as `v.optional(v.record(v.string(), v.string()))`.

**Files to modify**:
- `convex/schema.ts:115` — type change
- `convex/pipeline/inviteeCreated.ts:30-66` — `extractQuestionsAndAnswers()` and `mergeCustomFields()` already produce `Record<string, string>`, so no logic changes needed

#### Phase 2.1b — Per-meeting booking answers

**Schema addition** on `meetings` table (`convex/schema.ts:255-338`):

```typescript
bookingAnswers: v.optional(
  v.array(
    v.object({
      question: v.string(),
      answer: v.string(),
      fieldKey: v.optional(v.string()), // Maps to eventTypeConfigs.knownCustomFieldKeys
    })
  )
),
```

**Pipeline change**: In `convex/pipeline/inviteeCreated.ts`, when creating the meeting record, also write `bookingAnswers` from the parsed `questions_and_answers` payload (currently extracted at line 952 but only written to the lead, not the meeting).

**Backfill from raw webhooks** (URGENT — 30-day retention window):
- Query `rawWebhookEvents` with `eventType = "invitee.created"` and `processed = true`
- Parse `payload.questions_and_answers` from each
- Match to meeting by `calendlyEventUri`
- Write to `meetings.bookingAnswers`
- Must run before `cleanup-expired-webhook-events` cron deletes historical events

**Files to modify**:
- `convex/schema.ts` — add field to meetings
- `convex/pipeline/inviteeCreated.ts` — write `bookingAnswers` when creating meeting
- New: `convex/admin/backfillBookingAnswers.ts` — one-time backfill action

**Frontend impact**: None immediately. Future meeting detail UI can display per-meeting booking answers.

---

### 2.2 — Fix Money Model (Audit F5)

**Severity**: 🔴 High — confirmed by GPT1, GPT3
**Why**: `paymentRecords.amount` is `v.number()` (IEEE 754 float). Revenue sums accumulate rounding errors. `currency` is an arbitrary string with no ISO 4217 constraint. Multiple query paths blindly sum amounts across currencies and pick `payments[0]?.currency` as the display currency.

#### Verified problematic code paths

| File | Lines | Issue |
|------|-------|-------|
| `convex/closer/payments.ts` | 38-178 | `logPayment` accepts `amount: v.number()`, `currency: v.string()` with no validation beyond `.trim().toUpperCase()` |
| `convex/customers/queries.ts` | 57-63 | `listCustomers` enrichment: `.collect()` all payments → `reduce((sum, p) => sum + p.amount, 0)` → currency from `payments[0]` |
| `convex/customers/queries.ts` | 147-154 | `getCustomerDetail`: same blind sum |
| `convex/customers/queries.ts` | 206-214 | `getCustomerTotalPaid`: same pattern |
| `convex/dashboard/adminStats.ts` | 80-88 | `getAdminDashboardStats`: sums all non-disputed payment amounts across entire tenant |

#### Schema change (widen-migrate-narrow)

```typescript
paymentRecords: defineTable({
  // ... existing fields ...
  // Phase 1: widen — add alongside old
  amountMinor: v.optional(v.number()),    // Integer cents (e.g., 9999 = $99.99)
  amountCurrency: v.optional(v.string()), // ISO 4217 code, validated at write time
  // Keep old amount/currency during transition
})
```

#### Migration steps

1. **Widen**: Add `amountMinor` and `amountCurrency` as optional fields
2. **Dual-write**: Update `logPayment` (`convex/closer/payments.ts`) to compute `amountMinor = Math.round(amount * 100)` and write both. Validate `currency` against an ISO 4217 allowlist (or at minimum validate 3-char uppercase string).
3. **Backfill**: Iterate existing records, compute `amountMinor` from `amount`
4. **Switch reads**: Update all 4 query paths above to use `amountMinor`
5. **Narrow**: Make `amountMinor` and `amountCurrency` required; mark `amount` as deprecated

#### Reporting rule

**Single-tenant, single-currency only** for now. If multi-currency becomes a requirement, revenue totals must be per-currency aggregates. The mutation should reject payments whose currency doesn't match the tenant's established currency (first payment sets it).

#### Frontend impact

**Payment form dialogs** (2 files):
- `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` — already parses `parseFloat(values.amount)`. Add `amountMinor: Math.round(parsedAmount * 100)` to mutation args.
- `app/workspace/customers/[customerId]/_components/record-payment-dialog.tsx` — same change.

**Payment display** (4 files — change during "switch reads" step):
- `app/workspace/closer/meetings/_components/deal-won-card.tsx` — uses `formatCurrency(payment.amount, payment.currency)`
- `app/workspace/customers/[customerId]/_components/payment-history-table.tsx` — uses `payment.amount.toFixed(2)`
- `app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx` — uses `formatCurrency(totalPaid, currency)`
- `app/workspace/customers/_components/customers-table.tsx` — uses `customer.totalPaid.toFixed(2)`

During the widen phase, UI continues using `amount` (float). After the switch, UI reads `amountMinor / 100` for display. The `formatCurrency` utility should be updated to accept minor units.

---

### 2.3 — Make `leads.status` Required (Audit F8)

**Severity**: 🔴 High — confirmed by GPT1, GPT2, Opus1
**Why**: `leads.status` is `v.optional(...)` (`convex/schema.ts:119-126`). Code treats `undefined` as `"active"`. This causes:
- `listLeads` (`convex/leads/queries.ts:76-157`) paginates by `tenantId` and post-filters merged leads in JS — pages can be short
- `searchLeads` (`convex/leads/queries.ts:178-208`) fetches 40 results, JS-filters, truncates to 20 — a heuristic 2x overfetch
- Every query path has `?? "active"` fallbacks and special-case `undefined` handling

#### Migration (widen-migrate-narrow)

1. **Backfill**: Set `status: "active"` on every lead with `status === undefined`
2. **Narrow**: Change schema from `v.optional(v.union(...))` to `v.union(...)` (required)
3. **Query cleanup**: Remove `isActiveLikeLeadStatus()` helper, remove `?? "active"` fallbacks, use `by_tenantId_and_status` index directly for all status filters

#### Frontend impact (cleanup, no behavior change)

The frontend is already prepared — every component uses `?? "active"` fallbacks:
- `app/workspace/leads/_components/leads-table.tsx:64,166` — `lead.status ?? "active"`
- `app/workspace/leads/_components/lead-status-badge.tsx` — accepts `LeadStatus` type
- `app/workspace/leads/[leadId]/_components/lead-detail-page-client.tsx:86,133` — `lead.status ?? "active"`

After migration, the `??` fallbacks become no-ops and can be cleaned up. The `status` field on the `LeadRow` type changes from optional to required.

---

### 2.4 — Add Analytics Timestamps & User Attribution (Audit F14)

**Severity**: 🟡 Medium — unique to Opus1 audit
**Why**: Business-critical moments lack their own timestamps and actor attribution.

#### New optional fields

**On `opportunities`** (`convex/schema.ts:208-253`):
```typescript
lostAt: v.optional(v.number()),
lostByUserId: v.optional(v.id("users")),
canceledAt: v.optional(v.number()),
paymentReceivedAt: v.optional(v.number()),
```

**On `meetings`** (`convex/schema.ts:255-338`):
```typescript
completedAt: v.optional(v.number()),
canceledAt: v.optional(v.number()),
noShowRecordedByUserId: v.optional(v.id("users")),
```

**On `customers`** (`convex/schema.ts:423-453`):
```typescript
churnedAt: v.optional(v.number()),
pausedAt: v.optional(v.number()),
```

**On `paymentRecords`** (`convex/schema.ts:456-479`):
```typescript
verifiedAt: v.optional(v.number()),
verifiedByUserId: v.optional(v.id("users")),
disputedByUserId: v.optional(v.id("users")),
```

**On `followUps`** (`convex/schema.ts:481-520`):
```typescript
bookedAt: v.optional(v.number()),
```

#### Mutation updates

Update each status-transition mutation to set the corresponding timestamp and actor:
- Mark lost: set `lostAt`, `lostByUserId` (closer UI mutation)
- Pipeline cancellation: set `canceledAt` on both opportunity and meeting
- `logPayment` → `convex/closer/payments.ts`: set `paymentReceivedAt` on opportunity
- Meeting completion: set `completedAt`
- No-show: set `noShowRecordedByUserId`
- Follow-up booked: set `bookedAt` in `convex/closer/followUpMutations.ts`
- Payment verification: set `verifiedAt`, `verifiedByUserId`
- Customer status changes: set `churnedAt`/`pausedAt`

**Note**: If `domainEvents` (Phase 1.1) is in place, many of these timestamps can be derived from events. Adding them directly is non-breaking and useful for simpler queries without event table joins.

**Frontend impact**: None (all fields are optional, backend-only).

---

### 2.5 — Fix Denormalized Field Maintenance (Audit F12)

**Severity**: 🟡 Medium — confirmed by Opus1, Opus2, GPT3

#### Gap 1: `leads.socialHandles` drift on merge

**Current**: `socialHandles` is only written during pipeline `inviteeCreated` (`convex/pipeline/inviteeCreated.ts`). The merge mutation moves identifiers to the target lead but does NOT rebuild `socialHandles` on the target.

**Fix**: Extract `rebuildLeadSocialHandles(ctx, leadId)` helper.

```typescript
// convex/lib/denormalization.ts
export async function rebuildLeadSocialHandles(
  ctx: MutationCtx,
  leadId: Id<"leads">
) {
  const identifiers = await ctx.db
    .query("leadIdentifiers")
    .withIndex("by_leadId", (q) => q.eq("leadId", leadId))
    .collect();
  
  const socialTypes = ["instagram", "tiktok", "twitter", "facebook", "linkedin", "other_social"];
  const socialHandles = identifiers
    .filter((id) => socialTypes.includes(id.type))
    .map((id) => ({ type: id.type, handle: id.value }));
  
  await ctx.db.patch(leadId, { socialHandles });
}
```

**Call from**: `executeMerge()` in `convex/leads/mutations.ts` after moving identifiers.

#### Gap 2: `customers` identity snapshot drift

**Current**: `customers.fullName/email/phone/socialHandles` are copied from lead at conversion time (`convex/customers/conversion.ts:87-102`) and never refreshed.

**Fix**: When `updateLead` patches lead identity fields (`convex/leads/mutations.ts`), check if a linked customer exists and patch it too.

```typescript
// In updateLead mutation, after patching lead:
const customer = await ctx.db
  .query("customers")
  .withIndex("by_tenantId_and_leadId", (q) =>
    q.eq("tenantId", tenantId).eq("leadId", leadId)
  )
  .first();

if (customer) {
  await ctx.db.patch(customer._id, {
    fullName: updatedLead.fullName,
    email: updatedLead.email,
    phone: updatedLead.phone,
  });
}
```

#### Gap 3: `meetings.leadName` and `opportunities.hostCalendly*`

These are set once at creation and never updated. Lead names rarely change after Calendly extraction, and `assignedCloserId` is the authoritative closer reference.

**Fix**: Document these as intentional creation-time snapshots with schema comments. Low priority to add sync paths.

**Frontend impact**: None for gap 1 & 3. Gap 2 means customer detail views will show up-to-date data when lead info is corrected (currently they showed stale snapshots).

---

### 2.6 — Tighten `followUps.type` and `paymentRecords` Discriminants (Audit F13)

**Severity**: 🟡 Medium — unique to GPT2 audit

#### `followUps.type` — make required

**Current**: `type` is `v.optional(v.union(...))` (`convex/schema.ts:489`). The `createFollowUpRecord` mutation at `convex/closer/followUpMutations.ts:26` inserts without `type` for some code paths. Legacy records have no `type` field.

**Migration**:
1. Backfill: Infer type from field presence — if `schedulingLinkUrl` exists → `"scheduling_link"`, if `contactMethod` exists → `"manual_reminder"`, else → `"scheduling_link"` (default for Calendly-based follow-ups)
2. Narrow: Make `type` required: `type: v.union(v.literal("scheduling_link"), v.literal("manual_reminder"))`
3. Update `createFollowUpRecord` to always include `type`

#### `paymentRecords` — add `contextType`

**Current**: `opportunityId` and `meetingId` are both optional. `logPayment` (`convex/closer/payments.ts:38-178`) always receives both, but `recordCustomerPayment` may only provide `customerId`. The optionality creates ambiguous attribution.

**Migration**:
1. Add `contextType: v.optional(v.union(v.literal("opportunity_payment"), v.literal("customer_payment")))` 
2. Backfill: Records with `opportunityId` → `"opportunity_payment"`, records with only `customerId` → `"customer_payment"`
3. Narrow: Make `contextType` required
4. Add mutation validation: enforce that the correct foreign keys are present for each context type

**Frontend impact**: Minimal. `payment-form-dialog.tsx` already passes `opportunityId` and `meetingId`. The mutation just needs to also pass `contextType: "opportunity_payment"`.

---

## Phase 3 — Performance: Summary Tables, Query Flattening & Pagination

**Goal**: Replace scan-heavy reads with pre-computed summaries, flatten nested query patterns, and add pagination.
**Duration**: ~1.5 weeks
**Risk**: Low (additive tables, query refactors)
**Skills**: `convex-performance-audit`

### 3.1 — Add Analytics-Grade Indexes (Audit F15)

**Severity**: 🟡 Medium — confirmed by all 5 audits

Add compound indexes with time as the final range-queryable element:

```typescript
// opportunities
.index("by_tenantId_and_createdAt", ["tenantId", "createdAt"])
.index("by_tenantId_and_updatedAt", ["tenantId", "updatedAt"])

// meetings
.index("by_tenantId_and_status_and_scheduledAt", ["tenantId", "status", "scheduledAt"])
.index("by_tenantId_and_meetingOutcome_and_scheduledAt", ["tenantId", "meetingOutcome", "scheduledAt"])
.index("by_opportunityId_and_scheduledAt", ["opportunityId", "scheduledAt"])

// paymentRecords
.index("by_tenantId_and_recordedAt", ["tenantId", "recordedAt"])
.index("by_tenantId_and_status_and_recordedAt", ["tenantId", "status", "recordedAt"])
.index("by_customerId_and_recordedAt", ["customerId", "recordedAt"])

// customers
.index("by_tenantId_and_convertedByUserId_and_convertedAt", ["tenantId", "convertedByUserId", "convertedAt"])

// followUps
.index("by_tenantId_and_status_and_createdAt", ["tenantId", "status", "createdAt"])

// leads
.index("by_tenantId_and_firstSeenAt", ["tenantId", "firstSeenAt"])

// meetingReassignments
.index("by_tenantId_and_reassignedAt", ["tenantId", "reassignedAt"])
```

Total: ~12 new indexes across 7 tables. Well within Convex's 32-per-table limit.

**Frontend impact**: None. Enables future analytics queries.

---

### 3.2 — Add `tenantDashboardStats` Summary Table (Audit F3)

**Severity**: 🔴 High — confirmed by all 5 audits
**Why**: `getAdminDashboardStats` (`convex/dashboard/adminStats.ts:24-113`) runs 4 unbounded `for await` loops over `users`, `opportunities`, `meetings`, and `paymentRecords` on every render. Because Convex queries are reactive, every write to any of these tables triggers re-execution.

#### Schema addition

```typescript
tenantDashboardStats: defineTable({
  tenantId: v.id("tenants"),
  totalTeamMembers: v.number(),
  totalClosers: v.number(),
  unmatchedClosers: v.number(),
  totalOpportunities: v.number(),
  activeOpportunities: v.number(),
  wonDeals: v.number(),
  totalRevenueMinor: v.number(),    // Integer cents
  totalRevenueCurrency: v.string(), // ISO 4217
  paymentRecordsLogged: v.number(),
  totalCustomers: v.number(),
  lastUpdatedAt: v.number(),
})
  .index("by_tenantId", ["tenantId"])
```

#### Atomic counter maintenance

Each mutation that changes a counted value atomically increments/decrements the summary:

| Mutation | Counter to update |
|----------|------------------|
| User added/removed | `totalTeamMembers`, `totalClosers`, `unmatchedClosers` |
| Opportunity created | `totalOpportunities`, `activeOpportunities` |
| Opportunity → `payment_received` | `activeOpportunities--`, `wonDeals++` |
| Opportunity → `lost`/`canceled` | `activeOpportunities--` |
| Payment logged (non-disputed) | `totalRevenueMinor += amountMinor`, `paymentRecordsLogged++` |
| Payment disputed | `totalRevenueMinor -= amountMinor` |
| Customer converted | `totalCustomers++` |

Helper:
```typescript
// convex/lib/dashboardStats.ts
export async function updateDashboardStat(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  updates: Partial<Record<string, number>>
) {
  const stats = await ctx.db
    .query("tenantDashboardStats")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .first();
  
  if (!stats) return; // No stats doc yet; backfill will create it
  
  const patch: Record<string, number> = { lastUpdatedAt: Date.now() };
  for (const [key, delta] of Object.entries(updates)) {
    patch[key] = (stats[key as keyof typeof stats] as number) + delta;
  }
  await ctx.db.patch(stats._id, patch);
}
```

#### Dashboard query replacement

`getAdminDashboardStats` becomes a single document read:
```typescript
const stats = await ctx.db
  .query("tenantDashboardStats")
  .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
  .first();
```

The `meetingsToday` counter stays as a live query (bounded date range via `by_tenantId_and_scheduledAt`) since it's time-dependent and already efficient.

#### Backfill script

Compute all counters from source tables once, insert the initial `tenantDashboardStats` document.

#### Frontend impact

- `app/workspace/_components/stats-row.tsx` — consumes stats object. Return shape must match current interface (`totalClosers`, `unmatchedClosers`, `totalTeamMembers`, `activeOpportunities`, `meetingsToday`, `wonDeals`, `totalOpportunities`, `revenueLogged`, `paymentRecordsLogged`). The `revenueLogged` field changes from float sum to `totalRevenueMinor / 100` (display conversion).
- `app/workspace/_components/stats-row-client.tsx` and `pipeline-summary-client.tsx` — use `Preloaded<typeof api.dashboard.adminStats.getAdminDashboardStats>`. Return type change propagates via Convex codegen automatically.
- Polling interval (60s in `dashboard-page-client.tsx`) can be removed since reactive summary doc auto-updates.

---

### 3.3 — Customer Payment Summary Denormalization (Audit F3)

**Why**: `listCustomers` triggers N+1 payment queries — for each customer in a paginated page, `.collect()` all payments and reduce. `getCustomerTotalPaid` does the same for a single customer.

#### Approach: Add fields directly on `customers` table

```typescript
customers: defineTable({
  // ... existing ...
  totalPaidMinor: v.optional(v.number()),      // Sum of amountMinor for non-disputed payments
  totalPaidCurrency: v.optional(v.string()),   // ISO 4217
  paymentCount: v.optional(v.number()),
  lastPaymentAt: v.optional(v.number()),
})
```

Maintained atomically by:
- `logPayment` — increment `totalPaidMinor`, `paymentCount`, set `lastPaymentAt`
- `recordCustomerPayment` — same
- Payment dispute — decrement `totalPaidMinor`

After backfill and migration:
- `listCustomers` drops the per-customer payment `.collect()` loop — reads denormalized fields directly
- `getCustomerTotalPaid` becomes a single document read
- `getCustomerDetail` payment history remains a separate bounded query for display

#### Frontend impact

- `app/workspace/customers/_components/customers-table.tsx` — reads `customer.totalPaid` (already). After migration, reads `customer.totalPaidMinor / 100`.
- `app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx` — uses `totalPaid` from query. After migration, reads from customer doc.

---

### 3.4 — Flatten O(n×m) Detail Queries (Audit F16)

**Severity**: 🟡 Medium — unique to Opus2 audit
**Why**: `getLeadDetail` (`convex/leads/queries.ts:253-449`), `getCustomerDetail` (`convex/customers/queries.ts:90-185`), and `getMeetingDetail` (`convex/closer/meetingDetail.ts:34-246`) iterate opportunities, then for each iterate meetings, then for each iterate related records. A lead with 10 opportunities × 5 meetings = 50+ individual index lookups.

#### Fix pattern: Query broadly, group in JS

```typescript
// Instead of:
for (const opp of opportunities) {
  const meetings = await ctx.db.query("meetings")
    .withIndex("by_opportunityId", q => q.eq("opportunityId", opp._id))
    .take(50);
  // ... per-meeting work
}

// Do:
const oppIds = new Set(opportunities.map(o => o._id));
const allMeetings = [];
for (const opp of opportunities) {
  const oppMeetings = await ctx.db.query("meetings")
    .withIndex("by_opportunityId", q => q.eq("opportunityId", opp._id))
    .take(20);
  allMeetings.push(...oppMeetings);
}
// Group in memory
const meetingsByOpp = groupBy(allMeetings, "opportunityId");
```

With `meetings.assignedCloserId` from Phase 1.3, the meeting detail "all related meetings for this lead" query can also be simplified.

#### Enrichment batching

Replace per-record lookups with batch-deduplication:

```typescript
// Collect unique IDs first
const closerIds = new Set(opportunities.map(o => o.assignedCloserId).filter(Boolean));
const closerMap = new Map();
await Promise.all(
  [...closerIds].map(async (id) => {
    const user = await ctx.db.get(id);
    if (user) closerMap.set(id, user);
  })
);
// Then enrich from map
```

The admin opportunity list (`convex/opportunities/queries.ts:46-218`) already does this dedup pattern for some fields — extend it consistently to all detail queries.

#### Files to modify
- `convex/leads/queries.ts:253-449` — `getLeadDetail`
- `convex/customers/queries.ts:90-185` — `getCustomerDetail`
- `convex/closer/meetingDetail.ts:71-92` — meeting history section

**Frontend impact**: None (return shapes unchanged).

---

### 3.5 — Paginate Unbounded Queries (Audit F17, F20)

#### Admin opportunity list — `listOpportunitiesForAdmin`

**Current** (`convex/opportunities/queries.ts:46-218`): Three code paths, all using unbounded `for await` with no `.take()` or `.paginate()`. A tenant with 1,000 opportunities reads all documents, enriches each, and sorts in-memory.

**Fix**: Use `.paginate()` with `usePaginatedQuery` on the client.

**Frontend impact**:
- `app/workspace/pipeline/_components/pipeline-page-client.tsx` — switch from `useQuery` to `usePaginatedQuery` with `loadMore` pattern
- `app/workspace/pipeline/_components/opportunities-table.tsx` — currently applies client-side sort via `useTableSort`. With server-side pagination, sorting should move server-side (order by index) or be per-page.
- CSV export (lines 138-158 in `pipeline-page-client.tsx`) currently dumps ALL opportunities. Pagination means either a separate "export all" query or limiting export to current page.

#### Closer pipeline — `listMyOpportunities`

**Current** (`convex/closer/pipeline.ts:24-70`): `.collect()` unbounded → JS filter by status → per-record enrichment → JS sort.

**Fix**: With the `by_tenantId_and_assignedCloserId_and_status` index from Phase 1.2, use `.paginate()` or `.take(50)`.

**Frontend impact**:
- `app/workspace/closer/pipeline/_components/closer-pipeline-page-client.tsx` — switch to `usePaginatedQuery`
- `app/workspace/closer/pipeline/_components/opportunity-table.tsx` — same client-sort considerations

#### User/member lists

**Current**: `listTeamMembers`, `listUnmatchedCalendlyMembers`, `getAvailableClosersForDate` — async iterators without bounds. Team sizes are small (<50), but defensive bounds should be added.

**Fix**: Add `.take(200)` safety limits.

**Frontend impact**: None (team sizes are well under 200).

---

## Phase 4 — Data Integrity: Soft-Delete, Cascade & Cleanup

**Goal**: Fix tenant offboarding orphans and user deletion orphans.
**Duration**: ~1 week
**Risk**: Medium (behavioral change to user removal flow)
**Skills**: `convex-migration-helper`

### 4.1 — User Soft-Delete (Audit F7)

**Severity**: 🔴 High — confirmed by GPT3, noted by Opus1/Opus2
**Why**: `removeUser` (`convex/workos/userMutations.ts:428-458`) deletes the user document. 7+ tables hold dangling `userId` references: `opportunities.assignedCloserId`, `paymentRecords.closerId`, `followUps.closerId`, `customers.convertedByUserId`, `closerUnavailability.closerId/createdByUserId`, `meetingReassignments.fromCloserId/toCloserId/reassignedByUserId`, `leadMergeHistory.mergedByUserId`.

#### Schema change

```typescript
users: defineTable({
  // ... existing fields ...
  deletedAt: v.optional(v.number()),
  isActive: v.optional(v.boolean()), // Default true; set false on soft-delete
})
  // Keep existing indexes
  // Add:
  .index("by_tenantId_and_isActive", ["tenantId", "isActive"])
```

Note: `isActive` must be a real field (not computed) because Convex doesn't support computed fields. Maintain in sync with `deletedAt`.

#### Mutation change (`convex/workos/userMutations.ts:428-458`)

```typescript
// Before: ctx.db.delete(userId)
// After:
// 1. Check for active assignments
const activeOpps = await ctx.db
  .query("opportunities")
  .withIndex("by_tenantId_and_assignedCloserId_and_status", (q) =>
    q.eq("tenantId", tenantId).eq("assignedCloserId", targetUserId)
  )
  .take(10);

const hasActiveOpps = activeOpps.some(
  (o) => !["lost", "canceled", "payment_received"].includes(o.status)
);

if (hasActiveOpps) {
  throw new ConvexError("Cannot remove user with active opportunities. Reassign first.");
}

// 2. Soft-delete
await ctx.db.patch(targetUserId, { deletedAt: Date.now(), isActive: false });

// 3. Emit domain event
await emitDomainEvent(ctx, {
  tenantId, entityType: "user", entityId: targetUserId,
  eventType: "user_deactivated", source: "admin",
  actorUserId: userId,
});
```

#### Query updates

All user listing queries filter by `isActive`:
- `listTeamMembers` — add `.eq("isActive", true)` or use `by_tenantId_and_isActive` index
- Historical references (payment history, reassignment logs) continue to resolve correctly since the user row still exists

#### Backfill

Set `isActive: true` and `deletedAt: undefined` on all existing users.

#### Frontend impact

- `app/workspace/team/_components/remove-user-dialog.tsx` — currently says "This action cannot be undone." Change to "This user will be deactivated." Add warning if user has active assignments (pre-flight check before showing dialog).
- `app/workspace/team/_components/team-members-table.tsx` — add visual indicator for inactive users (dimmed row, "Inactive" badge). Add filter toggle to show/hide inactive members.
- `app/workspace/team/_components/team-page-client.tsx:118` — `handleRemoveUser` needs pre-flight check for active assignments.
- All components that display closer names (pipeline tables, meeting detail, lead detail) should handle deactivated users gracefully — e.g., show "(Inactive)" suffix.

---

### 4.2 — Extend Tenant Offboarding Cascade (Audit F6)

**Severity**: 🔴 High — confirmed by GPT1, GPT2, Opus2
**Why**: `deleteTenantRuntimeDataBatch` (`convex/admin/tenantsMutations.ts:65-128`) only cleans 3 of 14+ tables: `rawWebhookEvents`, `calendlyOrgMembers`, `users`. This leaves orphaned records in 11 tables.

#### Implementation

Extend `deleteTenantRuntimeDataBatch` to cover all tenant-scoped tables. Use the existing batching pattern (`.take(128)` per table per batch, return `hasMore` for continuation).

**Tables to add** (ordered by foreign key dependencies — delete children first):

| Order | Table | Index for cleanup |
|-------|-------|------------------|
| 1 | `paymentRecords` | `by_tenantId` |
| 2 | `meetingReassignments` | `by_tenantId` |
| 3 | `followUps` | `by_tenantId` |
| 4 | `meetings` | `by_tenantId_and_scheduledAt` |
| 5 | `closerUnavailability` | `by_tenantId_and_date` |
| 6 | `customers` | `by_tenantId` |
| 7 | `opportunities` | `by_tenantId` |
| 8 | `leadIdentifiers` | `by_tenantId_and_type_and_value` |
| 9 | `leadMergeHistory` | `by_tenantId` |
| 10 | `leads` | `by_tenantId` |
| 11 | `eventTypeConfigs` | `by_tenantId` |
| 12 | `domainEvents` (Phase 1) | `by_tenantId_and_occurredAt` |
| 13 | `tenantDashboardStats` (Phase 3) | `by_tenantId` |
| 14 | `rawWebhookEvents` | Already cleaned ✅ |
| 15 | `calendlyOrgMembers` | Already cleaned ✅ |
| 16 | `users` | Already cleaned ✅ |

Also: Delete `_storage` files referenced by `paymentRecords.proofFileId` before deleting payment records.

**Do not delete the tenant row until all dependent data is confirmed deleted.**

#### Files to modify

- `convex/admin/tenantsMutations.ts:65-128` — extend batch deletion to cover all tables
- `convex/admin/tenants.ts:704-727` — update the batch loop caller if the return shape changes

**Frontend impact**: None (admin-only operation).

---

### 4.3 — Data Cleanup Jobs (Audit F9, F18)

One-time cleanup scripts to run before building analytics:

1. **Deduplicate `eventTypeConfigs`** — Pick canonical row per `(tenantId, calendlyEventTypeUri)`, repoint any dependents, delete duplicates.
2. **Audit orphaned references** — Scan all tables with `userId`-type fields, check if referenced users still exist. Report any dangling IDs.
3. **Audit payment currencies** — For each tenant, check if all payments use the same currency. Report any mixed-currency tenants.
4. **Audit raw webhook duplicates** — Check for duplicate `(tenantId, eventType, calendlyEventUri)` tuples in `rawWebhookEvents`.

These are internal scripts, not user-facing features.

---

## Phase 5 — Structural: OAuth Separation (Deferred)

**Goal**: Separate high-churn Calendly OAuth state from stable tenant identity.
**Duration**: ~1.5 weeks
**Risk**: Medium (touches OAuth, token refresh, webhook setup, and health check flows)
**Priority**: Deferred — real reactivity cost (~16 invalidations/day) but not a correctness issue

### 5.1 — Extract `tenantCalendlyConnections` (Audit F11)

Split `tenants` (currently ~25 fields) into:
- `tenants` — company name, contact email, lifecycle/onboarding state, tenant owner
- `tenantCalendlyConnections` — tenantId, org/user URIs, tokens, token expiry, refresh lock, webhook data

**Files affected** (significant refactor):
- `convex/schema.ts:6-51` — split table
- `convex/calendly/tokens.ts` — read/write from new table
- `convex/calendly/healthCheck.ts` — read from new table
- `convex/calendly/orgMembers.ts` — read org URI from new table
- `convex/webhooks/` — read webhook config from new table
- `convex/admin/tenants.ts` — onboarding flow writes to new table
- `convex/crons.ts:refreshAllTokens` — reads from new table

**Frontend impact**: None directly. All tenant OAuth state is backend-only.

### 5.2 — Optional: Structured `rawWebhookEvents` Fields (Audit F22)

Low priority. Keep `payload` as string for replay fidelity. If webhook analytics become important, add extracted metadata fields alongside. Not planned for v0.5b.

---

## Frontend Side Effects Matrix

Comprehensive list of all UI files affected by v0.5b backend changes:

### Phase 1 — No frontend changes

All Phase 1 changes are backend-only (new table, new indexes, new field with backfill).

### Phase 2 — Minimal frontend changes

| File | Change | Phase |
|------|--------|-------|
| `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` | Add `amountMinor` computation to submit handler | 2.2 |
| `app/workspace/customers/[customerId]/_components/record-payment-dialog.tsx` | Add `amountMinor` computation to submit handler | 2.2 |
| `app/workspace/closer/meetings/_components/deal-won-card.tsx` | Switch from `payment.amount` to `payment.amountMinor / 100` (after read switch) | 2.2 |
| `app/workspace/customers/[customerId]/_components/payment-history-table.tsx` | Same — `amountMinor / 100` | 2.2 |
| `app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx` | Same for `totalPaid` | 2.2 |
| `app/workspace/customers/_components/customers-table.tsx` | Same for `customer.totalPaid` | 2.2 |
| `app/workspace/leads/_components/leads-table.tsx:64,166` | Remove `?? "active"` fallbacks (cleanup) | 2.3 |
| `app/workspace/leads/[leadId]/_components/lead-detail-page-client.tsx:86,133` | Remove `?? "active"` fallbacks (cleanup) | 2.3 |

### Phase 3 — Performance-related UI changes

| File | Change | Phase |
|------|--------|-------|
| `app/workspace/_components/stats-row.tsx` | Adjust `revenueLogged` to read from summary doc (may need `totalRevenueMinor / 100`) | 3.2 |
| `app/workspace/_components/dashboard-page-client.tsx` | Can remove 60s polling interval (reactive summary doc auto-updates) | 3.2 |
| `app/workspace/pipeline/_components/pipeline-page-client.tsx` | Switch from `useQuery` to `usePaginatedQuery` | 3.5 |
| `app/workspace/pipeline/_components/opportunities-table.tsx` | Handle paginated data + "Load more" UI | 3.5 |
| `app/workspace/closer/pipeline/_components/closer-pipeline-page-client.tsx` | Switch to `usePaginatedQuery` | 3.5 |
| `app/workspace/closer/pipeline/_components/opportunity-table.tsx` | Handle paginated data | 3.5 |

### Phase 4 — User management UI changes

| File | Change | Phase |
|------|--------|-------|
| `app/workspace/team/_components/remove-user-dialog.tsx` | Change messaging to "deactivate"; add active-assignment pre-flight check | 4.1 |
| `app/workspace/team/_components/team-members-table.tsx` | Add inactive visual indicator; add show/hide inactive toggle | 4.1 |
| `app/workspace/team/_components/team-page-client.tsx` | Add pre-flight check in `handleRemoveUser`; update CSV export to include status | 4.1 |
| Components displaying closer names (pipeline, meeting detail, etc.) | Handle deactivated users with "(Inactive)" suffix | 4.1 |

---

## Implementation Roadmap

### Phase Dependencies

```
Phase 1 (Foundation) ─── no dependencies ───► can start immediately
    │
    ├── Phase 1.1 (domainEvents) ──► Phase 2.4 (timestamps use same events)
    ├── Phase 1.2 (indexes) ──► Phase 3.4 (flatten queries use new indexes)
    └── Phase 1.3 (meetings.assignedCloserId) ──► Phase 3.4, 3.5 (query refactors)
    
Phase 2 (Data Model) ─── depends on Phase 1.1 for event logging ───►
    │
    ├── Phase 2.2 (money) ──► Phase 3.2 (summary tables use amountMinor)
    └── Phase 2.3 (lead status) ──► Phase 3.5 (index-based pagination)

Phase 3 (Performance) ─── depends on Phase 1 + 2 ───►
    │
    └── Phase 3.2 (summary tables) ──► needs Phase 2.2 (amountMinor)

Phase 4 (Integrity) ─── depends on Phase 1.2 (indexes for active opp check) ───►

Phase 5 (OAuth split) ─── independent, deferred ───►
```

### Weekly Breakdown

**Week 1**: Phase 1 — Foundation
- [ ] 1.1: Add `domainEvents` table + `emitDomainEvent` helper + wire into highest-value mutations
- [ ] 1.2: Add 8 relationship indexes + update query functions to use them
- [ ] 1.3: Add `meetings.assignedCloserId` + backfill script + update closer query paths
- [ ] 1.4: Deduplicate event type configs + add upsert guard

**Week 2**: Phase 2a — Type Safety
- [ ] 2.1a: Narrow `leads.customFields` type via widen-migrate-narrow
- [ ] 2.1b: Add `meetings.bookingAnswers` + backfill from raw webhooks (URGENT — retention window)
- [ ] 2.3: Make `leads.status` required + backfill undefined → "active"
- [ ] 2.6: Make `followUps.type` required + add `paymentRecords.contextType`

**Week 3**: Phase 2b — Money & Timestamps
- [ ] 2.2: Add `amountMinor` + dual-write + backfill + switch reads + update frontend
- [ ] 2.4: Add analytics timestamps + user attribution fields + update mutations
- [ ] 2.5: Extract `rebuildLeadSocialHandles` + customer sync path

**Week 4**: Phase 3 — Performance
- [ ] 3.1: Add 12 analytics-grade indexes
- [ ] 3.2: Add `tenantDashboardStats` + atomic counter maintenance + backfill
- [ ] 3.3: Customer payment summary denormalization
- [ ] 3.4: Flatten O(n×m) detail queries
- [ ] 3.5: Paginate admin/closer pipeline lists + update frontend

**Week 5**: Phase 4 — Integrity
- [ ] 4.1: User soft-delete + frontend changes + backfill `isActive`
- [ ] 4.2: Extend tenant offboarding cascade to all 16 tables
- [ ] 4.3: Run data cleanup jobs (deduplication, orphan audit, currency audit)

**Week 6**: QA & Documentation
- [ ] End-to-end verification on test tenant
- [ ] Convex Insights performance validation
- [ ] Schema comments and AGENTS.md updates
- [ ] Optional: Phase 5 (OAuth separation)

---

## Testing & Validation Gates

### Per-phase validation (before merge)

| Check | Method | Pass criteria |
|-------|--------|--------------|
| **Schema safety** | Deploy to dev environment | No deployment errors; existing features work unchanged |
| **Migration correctness** | `convex-migration-helper` dry run | All rows match expected post-migration shape |
| **Query performance** | Convex Insights before/after | Hot queries show ≥50% reduction in bytes read |
| **No OCC regression** | Convex Insights (72h window) | No new OCC conflicts on modified tables |
| **Data integrity** | Spot-check scripts | Computed sums match hand-verified values; no orphaned refs |
| **Frontend smoke test** | `expect` MCP tool or manual | Dashboard loads, pipeline renders, payment forms work |

### End-to-end validation (v0.5b completion)

| Test | How |
|------|-----|
| Full pipeline test | Trigger Calendly booking → verify meeting created with `assignedCloserId` + `bookingAnswers` + domain event |
| Payment flow | Log payment → verify `amountMinor` stored + summary updated + domain event emitted |
| Lead merge | Merge two leads → verify `socialHandles` rebuilt + customer synced + domain event logged |
| User deactivation | Deactivate closer with active opps → verify blocked; reassign → retry → verify soft-deleted |
| Tenant deletion | Delete test tenant → verify all 16 tables cleaned |
| Dashboard performance | Compare load time before/after summary tables; target <500ms |

---

## Risk Matrix

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Booking answer backfill misses events past 30-day retention | Medium | High | Run backfill script in Week 2 BEFORE any cleanup cron fires |
| Summary table drift (counters out of sync) | Low | Medium | Backfill verification script; compare summary vs. source-of-truth scan periodically |
| `amountMinor` rounding differs from original `amount` | Low | Low | Accept ≤1 cent variance; document rounding rule (`Math.round(amount * 100)`) |
| User soft-delete breaks existing team management UI | Low | Medium | Pre-flight check prevents deactivation with active assignments; graceful "Inactive" display |
| Too many indexes slow writes | Very Low | Low | Convex handles index maintenance automatically; validate via Insights |
| Widen-migrate-narrow migration fails mid-way | Low | Medium | Small dataset allows fresh start; use `convex-migration-helper` for rollback support |
| Domain event dual-write adds latency to mutations | Very Low | Low | Single indexed insert per event; expected <5ms overhead |

---

## Skills & Resources

| Phase | Primary Skill | Secondary | Reference Docs |
|-------|--------------|-----------|---------------|
| 1 | `convex-migration-helper` | — | `convex/_generated/ai/guidelines.md`, `.docs/best-practices/convex-db-best-practices.md` |
| 2 | `convex-migration-helper` | Form patterns (AGENTS.md §Form Patterns) | `convex/lib/statusTransitions.ts`, `convex/lib/opportunityMeetingRefs.ts` |
| 3 | `convex-performance-audit` | `expect` (dashboard perf testing) | Convex Insights dashboard |
| 4 | `convex-migration-helper` | WorkOS integration (AGENTS.md §Authentication) | `convex/workos/userMutations.ts`, `convex/admin/tenantsMutations.ts` |
| 5 | `convex-migration-helper` | — | `convex/calendly/tokens.ts`, `convex/crons.ts` |

---

## Success Criteria

v0.5b is complete when:

- [ ] **Event history**: All status transitions logged to `domainEvents` with actor, timestamp, and metadata. Can reconstruct "what happened over time" for any entity.
- [ ] **Custom fields**: `leads.customFields` type-safe (`v.record(v.string(), v.string())`). Per-meeting `bookingAnswers` captured with full provenance.
- [ ] **Money model**: Revenue calculations use `amountMinor` (integer cents). Currency validated at write time. No floating-point accumulation errors.
- [ ] **Query performance**: Admin dashboard reads 1 summary document instead of 4 table scans. Closer queries use direct `meetings.assignedCloserId` index instead of two-hop.
- [ ] **Lead status**: `leads.status` is required. No `undefined` values. Queries use index-based filtering without post-fetch JS filters.
- [ ] **Data integrity**: Users are soft-deleted (preserve historical references). Tenant deletion cascades to all 16 tables.
- [ ] **Analytics indexes**: 20+ new indexes in place covering relationship, time, status, and owner dimensions.
- [ ] **No breaking changes**: All existing features work unchanged. Frontend changes are minimal and backward-compatible.
- [ ] **Backfill complete**: All migration scripts have run. Booking answers backfilled from raw webhooks before retention window expires.

---

## Post-v0.5b: v0.6 Outlook

With v0.5b complete, the data model supports:
- **Funnel analytics** — `domainEvents` + time-based indexes enable "time in stage," "stage-to-stage duration," "conversion velocity by closer"
- **Revenue reporting** — currency-safe `amountMinor` + `tenantDashboardStats` + payment indexes enable accurate revenue dashboards
- **Team performance** — user soft-delete + domain events enable "invite-to-accept latency," "meetings per closer per week," "no-show rate trends"
- **Custom field analytics** — per-meeting `bookingAnswers` enable "most common form answers," "booking answer distribution by event type"

v0.6 will build reporting/analytics UI on top of this foundation.

---

## Appendix: Key File Reference

| Purpose | File | Lines of interest |
|---------|------|------------------|
| Schema (all tables) | `convex/schema.ts` | Full file (521 lines) |
| Pipeline main handler | `convex/pipeline/inviteeCreated.ts` | 1493 lines; customFields: 30-66, 952; eventTypeConfig: 685-717 |
| Pipeline dispatcher | `convex/pipeline/processor.ts` | 125 lines; dispatch: 65-112 |
| Webhook dedupe | `convex/webhooks/calendlyMutations.ts` | 50 lines; scan pattern: 15-29 |
| State machines | `convex/lib/statusTransitions.ts` | 78 lines; opp transitions: 24-36 |
| Meeting ref maintenance | `convex/lib/opportunityMeetingRefs.ts` | Full file |
| Admin dashboard stats | `convex/dashboard/adminStats.ts` | 113 lines; 4 scans: 37-88 |
| Customer queries (N+1) | `convex/customers/queries.ts` | 217 lines; listCustomers: 49-75; totalPaid: 192-217 |
| Closer dashboard (two-hop) | `convex/closer/dashboard.ts` | 147 lines; getNextMeeting: 13-77 |
| Closer calendar (two-hop) | `convex/closer/calendar.ts` | 85 lines; getMeetingsForRange: 15-85 |
| Closer pipeline (collect+filter) | `convex/closer/pipeline.ts` | 70 lines; listMyOpportunities: 24-70 |
| Payment logging | `convex/closer/payments.ts` | 178 lines; logPayment: 38-178 |
| Customer conversion | `convex/customers/conversion.ts` | Full file; snapshot: 87-102; backfill loop: 118-139 |
| User removal | `convex/workos/userMutations.ts` | removeUser: 428-458 |
| Tenant deletion | `convex/admin/tenantsMutations.ts` | deleteTenantRuntimeDataBatch: 65-128 |
| Tenant orchestrator | `convex/admin/tenants.ts` | resetTenantForReonboarding: 631-758 |
| Redistribution logic | `convex/unavailability/shared.ts` | listAffected: 95-151; buildSchedules: 153-262 |
| Lead queries | `convex/leads/queries.ts` | listLeads: 76-157; search: 178-208; detail: 253-449 |
| Event type config stats | `convex/eventTypeConfigs/queries.ts` | getWithStats: 46-108 |
| Follow-up mutations | `convex/closer/followUpMutations.ts` | createFollowUpRecord: 26; markBooked: 83 |
| Follow-up queries | `convex/closer/followUpQueries.ts` | getActiveReminders: 10+ |
| Meeting detail | `convex/closer/meetingDetail.ts` | 246 lines; auth hop: 45-59; history: 71-92 |
| Webhook cleanup | `convex/webhooks/cleanup.ts` | 41 lines; retention: 30 days |
| Cron jobs | `convex/crons.ts` | 41 lines; 5 jobs |
| Convex guidelines | `convex/_generated/ai/guidelines.md` | Schema rules, query patterns, migration guidance |
| DB best practices | `.docs/best-practices/convex-db-best-practices.md` | 548 lines; normalization, indexes, anti-patterns |
| Audit report | `.docs/audits/definite-database-audit-report.md` | Full 22-finding report |
