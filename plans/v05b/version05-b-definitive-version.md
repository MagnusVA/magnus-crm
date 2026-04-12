# v0.5b — Definitive Database Foundation & Analytics Readiness

> **This is the final, definitive specification.** No incremental steps, no deferrals. Every finding from both audit reports is addressed with a concrete, deploy-ready solution. Cross-referenced from [version 1](version0-5b-version1.md) and [version 2](version0-5b-version2.md), drawing the strongest elements of each, verified against the live codebase and both audit reports ([v1](/.docs/audits/definite-database-audit-reportv1.md), [v2](/.docs/audits/definite-database-audit-reportv2.md)).

| Field | Value |
| --- | --- |
| **Status** | Final Specification |
| **Date** | 2026-04-12 |
| **Audit basis** | 5 independent audits → 22 consolidated findings |
| **Data footprint** | 1 tenant, ~5 users, ~200 leads, 213 meetings, 213 opportunities, ~50 payments, 288 raw webhook events |
| **Migration risk** | Low — single test tenant, fresh start acceptable as fallback |
| **Target** | Production-ready, analytics-grade data model with zero deferrals |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Decisions](#2-architecture-decisions)
3. [Finding-to-Change Traceability Matrix](#3-finding-to-change-traceability-matrix)
4. [Phase Plan Overview](#4-phase-plan-overview)
5. [Phase 1: Schema Widen + New Tables](#5-phase-1-schema-widen--new-tables)
6. [Phase 2: Backfill + Data Cleanup](#6-phase-2-backfill--data-cleanup)
7. [Phase 3: Backend Mutation Updates](#7-phase-3-backend-mutation-updates)
8. [Phase 4: Backend Query Rewrites](#8-phase-4-backend-query-rewrites)
9. [Phase 5: OAuth State Extraction](#9-phase-5-oauth-state-extraction)
10. [Phase 6: Schema Narrow](#10-phase-6-schema-narrow)
11. [Phase 7: Frontend Updates](#11-phase-7-frontend-updates)
12. [Schema Changes Reference](#12-schema-changes-reference)
13. [Index Changes Reference](#13-index-changes-reference)
14. [Codebase Impact Analysis](#14-codebase-impact-analysis)
15. [Migration Scripts](#15-migration-scripts)
16. [Testing & Validation Gates](#16-testing--validation-gates)
17. [Risk Matrix](#17-risk-matrix)
18. [Skills & Resources](#18-skills--resources)
19. [Success Criteria](#19-success-criteria)

---

## 1. Executive Summary

All 5 independent audits converged on the same conclusion: the current schema is a solid operational CRM foundation but not yet an analytics-grade data model. The 6 structural gaps are:

1. **No durable event history** — status transitions overwrite in place; cannot answer "what happened over time"
2. **Custom fields are an untyped blob** — `leads.customFields` uses `v.any()`, loses per-interaction provenance, expires with 30-day webhook cleanup
3. **Scan-on-read aggregates** — dashboards run 4+ full table scans on every reactive render
4. **Missing relationship and analytics indexes** — hot reads depend on post-fetch JS filtering, producing incomplete paginated results
5. **Unsafe money model** — floating-point amounts with no currency controls; mixed-currency sums
6. **Data lifecycle gaps** — tenant offboarding orphans 11+ tables; user deletion breaks referential integrity; OAuth token churn invalidates tenant queries 16x/day

This specification addresses **all 22 findings** across **7 sequential phases**, ordered by the widen-migrate-narrow discipline: schema additions first, data backfill second, code changes third, schema narrowing last. **Nothing is deferred** — including the tenant table split (Finding 14), which both previous versions pushed to "later."

**Data context**: 1 test tenant, ~700 total records. All migrations run as single-shot scripts. Fresh start is available as fallback for any phase.

---

## 2. Architecture Decisions

### AD-1: Single `domainEvents` table (Findings 1, 16, 17)

A single append-only table with `entityType` + `eventType` discriminators. Carries `fromStatus`/`toStatus` for transitions, `actorUserId` for attribution, and `metadata` (JSON string) for event-specific context.

**Rejected**: Multiple per-entity tables (GPT1/GPT2 — unnecessary proliferation at this scale); narrow `statusChanges` table (Opus1 — misses non-status events like payment recording, user invitation, lead merge).

### AD-2: Integer minor units for money (Finding 3)

All payment amounts stored as `amountMinor: v.number()` representing integer cents. Display conversion (`amountMinor / 100`) happens at the UI boundary via a shared `formatAmountMinor()` utility.

**Note on `v.int64()`**: For the current scale (sub-$1M per tenant), `v.number()` with integer validation is sufficient and avoids BigInt complexity throughout the stack.

### AD-3: User soft-delete, not hard-delete (Finding 8)

Users are never physically deleted. `deletedAt` timestamp + `isActive` boolean flag. Historical references remain valid. All operational queries filter by `isActive !== false`. The `requireTenantUser` auth guard rejects soft-deleted users.

### AD-4: `tenantStats` summary document (Findings 3, 4)

One document per tenant, maintained atomically by mutations that change source data. The admin dashboard reads 1 document instead of scanning 4 tables. `meetingsToday` stays as a live range query (time-dependent, already efficiently indexed).

### AD-5: `meetings.assignedCloserId` denormalization (Finding 12)

A direct closer dimension on meetings eliminates the O(n*m) join pattern across 5+ query paths. Maintained as a projection of `opportunities.assignedCloserId` — set on creation, updated on reassignment.

### AD-6: Normalized per-meeting booking answers (Finding 2)

A `meetingFormResponses` child table + `eventTypeFieldCatalog` dimension table replace the collapsed `leads.customFields` blob as the reporting source of truth. The lead-level blob remains for UI convenience but is hardened to `v.record(v.string(), v.string())`.

### AD-7: OAuth state extraction from tenants (Finding 14)

Calendly OAuth tokens, refresh locks, and webhook secrets move to a dedicated `tenantCalendlyConnections` table. This eliminates 16 reactive invalidations/day from token refresh on every query that touches `tenants`. The `tenants` table becomes a stable identity record.

### AD-8: Fresh-start migration strategy

Given: 1 test tenant, ~700 total records. All widen-migrate-narrow sequences execute as one-shot backfill scripts. Wipe and re-seed is available as fallback for any specific change.

---

## 3. Finding-to-Change Traceability Matrix

Every audit finding maps to one or more concrete changes. No finding is deferred.

| Finding | Description | Severity | Phase(s) | Changes |
| --- | --- | --- | --- | --- |
| F1 | No append-only business event history | High | 1, 3 | New `domainEvents` table + emit from 17 mutation functions (~25 sites) |
| F2 | `leads.customFields` untyped blob, no per-meeting provenance | High | 1, 2, 3 | New `meetingFormResponses` + `eventTypeFieldCatalog` tables; harden `customFields` type; backfill from raw webhooks |
| F3 | Payment model unsafe for reporting (float, no currency control) | High | 1, 2, 3, 4, 7 | Add `amountMinor`; validate currency; dual-write; backfill; switch reads; add `formatAmountMinor` utility |
| F4 | Dashboard/aggregate queries scan full tables | High | 1, 2, 3, 4 | New `tenantStats` table; customer `totalPaidMinor` denormalization; event type stats maintenance |
| F5 | Closer scheduling/pipeline uses scan+filter patterns | High | 1, 2, 4 | Add compound indexes; denormalize `meetings.assignedCloserId`; rewrite 5+ query paths |
| F6 | `leads.status` optional — permanent migration-mode queries | High | 2, 4, 6 | Backfill undefined -> `"active"`; make required; remove `?? "active"` fallbacks |
| F7 | Tenant offboarding orphans 11+ tables | High | 3 | Expand `deleteTenantRuntimeDataBatch` cascade to all tenant-scoped tables |
| F8 | User hard-delete breaks referential integrity | High | 1, 2, 3, 4, 7 | Add soft-delete fields; backfill; replace `ctx.db.delete`; add `isActive` guard; update team UI |
| F9 | Business-key uniqueness is soft/convention-based | High | 2, 3 | Deduplicate `eventTypeConfigs`; add upsert guard; fix webhook dedup with compound index |
| F10 | Post-paginate/post-search filtering produces incomplete results | High | 1, 4 | Add 5 correctness indexes; rewrite `listLeads`, `listCustomers`, `getActiveReminders` |
| F11 | Missing relationship indexes force capped scans | High | 1 | Add 3 targeted relationship indexes |
| F12 | `meetings` lacks direct closer dimension | Medium | 1, 2, 3, 4 | Add `meetings.assignedCloserId` + index; backfill; set on creation; update on reassignment |
| F13 | Missing analytics-grade composite indexes | Medium | 1 | Add 14 analytics indexes across 7 tables |
| F14 | `tenants` mixes stable identity with high-churn OAuth tokens | Medium | 5 | Extract to `tenantCalendlyConnections` table; migrate all OAuth reads/writes |
| F15 | Customer snapshot drifts from lead data after conversion | Medium | 3 | Add `syncCustomerSnapshot` helper; call from lead update mutations |
| F16 | Missing lifecycle timestamps on key transitions | Medium | 1, 3 | Add optional timestamps on 5 tables; set in status-changing mutations |
| F17 | Missing user attribution on status changes | Medium | 1, 3 | Add optional attribution fields; set in closer-initiated mutations |
| F18 | `paymentRecords`/`followUps` too polymorphic for clean reporting | Medium | 1, 2, 3 | Add `paymentRecords.contextType`; make `followUps.type` required |
| F19 | O(n*m) nested loops / N+1 patterns in detail queries | Medium | 4 | Flatten query patterns; batch enrichment with deduped ID sets |
| F20 | `meetings.leadName` / `opportunities.hostCalendly*` stale | Low | 3 | Add sync path for `meetings.leadName`; document `hostCalendly*` as intentional snapshot |
| F21 | `opportunities.calendlyEventUri` duplicates meeting data | Low | -- | Document as "original booking URI" — no code change needed |
| F22 | `rawWebhookEvents.payload` opaque string | Low | -- | Keep for replay fidelity — no change needed now |

---

## 4. Phase Plan Overview

```
Phase 1 (Schema Widen)
  5 new tables, ~15 optional fields, 24 indexes
  Zero breaking changes — purely additive

Phase 2 (Backfill + Data Cleanup)          TIME-CRITICAL: booking answer backfill
  8 data migrations, 5 data audits/cleanups
  Zero breaking changes — writes to new/optional fields only

Phase 3 (Backend Mutations)
  17+ mutation updates across 12 status-changing functions
  Domain events, lifecycle timestamps, attribution, soft-delete, money model

Phase 4 (Backend Queries)
  17+ query rewrites — correctness fixes + performance optimization
  No frontend changes (return shapes preserved)

Phase 5 (OAuth State Extraction)
  New tenantCalendlyConnections table
  Move all OAuth fields from tenants -> new table
  Update all OAuth readers/writers (tokens, health check, webhooks, crons)

Phase 6 (Schema Narrow)
  leads.status required; paymentRecords.amount removed
  users.isActive required; meetings.assignedCloserId required

Phase 7 (Frontend Updates)
  Payment displays (amountMinor); team soft-delete UI; lead status cleanup
  formatAmountMinor utility; customer totalPaidMinor display
```

### Phase Dependencies

```
Phase 1 --- no dependencies ---> start immediately
  |
  |-- Phase 2 (backfill) --- depends on Phase 1 (new fields/tables exist)
  |     |
  |     |-- Phase 3 (mutations) --- depends on Phase 2 (backfill complete)
  |           |
  |           |-- Phase 4 (queries) --- depends on Phase 3 (new fields populated)
  |
  |-- Phase 5 (OAuth) --- can start after Phase 1, parallel with 2-4
        |
        |-- Phase 6 (narrow) --- depends on Phase 2 + 3 + 4 + 5 all complete
              |
              |-- Phase 7 (frontend) --- depends on Phase 4 (query shapes finalized)
```

---

## 5. Phase 1: Schema Widen + New Tables

**Goal**: Deploy all schema additions. No behavioral changes. Zero breaking changes.

### 1.1 New tables

| # | Table | Finding | Purpose |
| --- | --- | --- | --- |
| 1.1a | `domainEvents` | F1 | Append-only business event history |
| 1.1b | `tenantStats` | F4 | Dashboard summary document per tenant |
| 1.1c | `meetingFormResponses` | F2 | Per-meeting booking answer facts |
| 1.1d | `eventTypeFieldCatalog` | F2 | Stable field registry per event type |
| 1.1e | `tenantCalendlyConnections` | F14 | Extracted OAuth/webhook state from `tenants` |

Full schemas in [Section 12](#12-schema-changes-reference).

### 1.2 New optional fields on existing tables

| # | Table | Field(s) | Finding |
| --- | --- | --- | --- |
| 1.2a | `users` | `deletedAt`, `isActive` | F8 |
| 1.2b | `meetings` | `assignedCloserId`, `completedAt`, `canceledAt`, `noShowMarkedByUserId` | F12, F16, F17 |
| 1.2c | `opportunities` | `lostAt`, `canceledAt`, `noShowAt`, `paymentReceivedAt`, `lostByUserId` | F16, F17 |
| 1.2d | `paymentRecords` | `amountMinor`, `verifiedAt`, `verifiedByUserId`, `statusChangedAt`, `contextType` | F3, F16, F17, F18 |
| 1.2e | `customers` | `totalPaidMinor`, `totalPaymentCount`, `paymentCurrency`, `churnedAt`, `pausedAt` | F4, F16 |
| 1.2f | `followUps` | `bookedAt` | F16 |

### 1.3 New indexes

| # | Category | Count | Finding |
| --- | --- | --- | --- |
| 1.3a | Correctness indexes (fix broken query shapes) | 8 | F5, F9, F10, F11 |
| 1.3b | Analytics indexes (enable reporting) | 14 | F13 |
| 1.3c | Closer dimension index | 1 | F12 |
| 1.3d | User soft-delete index | 1 | F8 |

**Total**: 24 new indexes. Full list in [Section 13](#13-index-changes-reference).

### Phase 1 deployment

1. Add 5 new tables to `convex/schema.ts`
2. Add all optional fields to existing tables
3. Add all 24 indexes
4. Deploy — Convex builds indexes asynchronously; at ~700 records this is negligible

**Breaking change risk**: Zero. All additions are optional fields and new tables/indexes.

---

## 6. Phase 2: Backfill + Data Cleanup

**Goal**: Fill all new fields with correct data. Clean up duplicates and orphans.

**TIME-CRITICAL**: Item 2.12 (booking answer backfill from `rawWebhookEvents`) must complete before the 30-day retention cleanup cron deletes historical webhook payloads.

### Backfill scripts

| # | Change | Finding | Priority |
| --- | --- | --- | --- |
| 2.1 | Backfill `leads.status`: all `undefined` -> `"active"` | F6 | Standard |
| 2.2 | Backfill `users.isActive`: all existing -> `true` | F8 | Standard |
| 2.3 | Backfill `meetings.assignedCloserId` from parent opportunity | F12 | Standard |
| 2.4 | Backfill `paymentRecords.amountMinor` = `Math.round(amount * 100)` | F3 | Standard |
| 2.5 | Backfill `customers.totalPaidMinor` from payment records | F4 | Standard |
| 2.6 | Backfill `paymentRecords.contextType` from FK presence | F18 | Standard |
| 2.7 | Seed `tenantStats` document from current counts | F4 | Standard |
| 2.8 | Deduplicate `eventTypeConfigs` by `(tenantId, calendlyEventTypeUri)` | F9 | Standard |
| 2.9 | Backfill `followUps.type` for legacy records missing it | F18 | Standard |
| 2.10 | Audit for orphaned tenant-scoped rows from prior deletions | F7 | Post-fix |
| 2.11 | Audit for orphaned user references from prior `removeUser` calls | F8 | Post-fix |
| 2.12 | **URGENT** Backfill `meetingFormResponses` from retained `rawWebhookEvents` | F2 | **CRITICAL** |
| 2.13 | Audit payment currencies per tenant | F3 | Post-fix |

Full migration scripts in [Section 15](#15-migration-scripts).

**Breaking change risk**: Zero. Only writes to new/optional fields. Reads unchanged.

---

## 7. Phase 3: Backend Mutation Updates

**Goal**: All write paths populate new fields. Domain events emitted. Integrity enforced.

**Ordering constraint**: Phase 2 backfills MUST complete before this phase deploys. Especially:
- `leads.status` backfill before code assumes it's always defined
- `users.isActive` backfill before `requireTenantUser` starts checking it
- `meetings.assignedCloserId` backfill before queries read it

### 3.1 New helper modules

| # | Module | Purpose |
| --- | --- | --- |
| 3.1a | `convex/lib/domainEvents.ts` | `emitDomainEvent(ctx, params)` — insert into `domainEvents` with `occurredAt: Date.now()` |
| 3.1b | `convex/lib/tenantStatsHelper.ts` | `updateTenantStats(ctx, tenantId, delta)` — atomic counter updates on `tenantStats` doc |
| 3.1c | `convex/lib/formatMoney.ts` | `validateAmountMinor(n)` / `validateCurrency(c)` — integer check + ISO 4217 allowlist |
| 3.1d | `convex/lib/syncCustomerSnapshot.ts` | `syncCustomerSnapshot(ctx, tenantId, leadId)` — patch linked customer when lead identity changes |

### 3.2 Domain event emission (Finding 1)

Every status-changing mutation emits a domain event. Complete inventory:

| File | Function | Entity | Transition | Domain Event |
| --- | --- | --- | --- | --- |
| `closer/meetingActions.ts` | `startMeeting` | opportunity + meeting | -> in_progress | `opportunity.status_changed`, `meeting.started` |
| `closer/meetingActions.ts` | `markAsLost` | opportunity | in_progress -> lost | `opportunity.marked_lost` |
| `closer/noShowActions.ts` | `markNoShow` | opportunity + meeting | -> no_show | `meeting.no_show`, `opportunity.status_changed` |
| `closer/noShowActions.ts` | `createNoShowRescheduleLink` | opportunity | no_show -> reschedule_link_sent | `opportunity.status_changed` |
| `closer/followUpMutations.ts` | `transitionToFollowUp` | opportunity | -> follow_up_scheduled | `opportunity.status_changed`, `followUp.created` |
| `closer/followUpMutations.ts` | `confirmFollowUpScheduled` | opportunity | -> follow_up_scheduled | `followUp.booked` |
| `closer/followUpMutations.ts` | `createManualReminderFollowUpPublic` | opportunity | -> follow_up_scheduled | `followUp.created` |
| `closer/payments.ts` | `logPayment` | opportunity | in_progress -> payment_received | `payment.recorded`, `opportunity.status_changed` |
| `pipeline/inviteeCreated.ts` | `process` | opportunity + meeting | 5 code paths -> scheduled | `opportunity.created`, `meeting.created` |
| `pipeline/inviteeCanceled.ts` | `process` | opportunity + meeting | -> canceled | `meeting.canceled`, `opportunity.status_changed` |
| `pipeline/inviteeNoShow.ts` | `process` | opportunity + meeting | -> no_show | `meeting.no_show`, `opportunity.status_changed` |
| `pipeline/inviteeNoShow.ts` | `revert` | opportunity + meeting | no_show -> scheduled | `meeting.reverted`, `opportunity.status_changed` |
| `customers/conversion.ts` | `executeConversion` | customer + lead | lead -> converted | `customer.converted`, `lead.status_changed` |
| `leads/mutations.ts` | `executeMerge` | lead | merged | `lead.merged` |
| `workos/userMutations.ts` | `inviteUser` | user | invited | `user.invited` |
| `workos/userMutations.ts` | `removeUser` | user | deactivated | `user.deactivated` |
| `workos/userMutations.ts` | `updateUserRole` | user | role changed | `user.role_changed` |

**Total**: 17 mutation functions, ~25 individual domain event emission sites.

**PostHog relationship**: 6 client-side PostHog captures correspond to status transitions. These are NOT replaced — PostHog tracks product analytics (funnel adoption, feature usage); `domainEvents` is the authoritative server-side audit trail. They are complementary.

### 3.3 Lifecycle timestamps (Finding 16)

Each status-changing mutation sets the corresponding timestamp alongside the status patch:

| Mutation | Timestamp field | On table |
| --- | --- | --- |
| `markAsLost` | `lostAt` | `opportunities` |
| Pipeline cancellation | `canceledAt` | `opportunities` + `meetings` |
| `logPayment` | `paymentReceivedAt` | `opportunities` |
| Meeting completion | `completedAt` | `meetings` |
| No-show recording | (already has `noShowMarkedAt`) | `meetings` |
| `confirmFollowUpScheduled` | `bookedAt` | `followUps` |
| Payment verification | `verifiedAt` | `paymentRecords` |
| Customer status change | `churnedAt` / `pausedAt` | `customers` |

### 3.4 User attribution (Finding 17)

| Mutation | Attribution field | On table |
| --- | --- | --- |
| `markAsLost` | `lostByUserId` | `opportunities` |
| `markNoShow` | `noShowMarkedByUserId` | `meetings` |
| Payment verification | `verifiedByUserId` | `paymentRecords` |

### 3.5 Money model corrections (Finding 3)

Update `logPayment` (`convex/closer/payments.ts`) and `recordCustomerPayment`:
- Compute `amountMinor = Math.round(amount * 100)` and write both fields during transition
- Validate `currency` against ISO 4217 allowlist (or at minimum 3-char uppercase)
- Atomically update `customers.totalPaidMinor`, `totalPaymentCount`, `paymentCurrency`
- Atomically update `tenantStats.totalRevenueMinor`, `totalPaymentRecords`

### 3.6 `meetings.assignedCloserId` maintenance (Finding 12)

| Trigger | File | Action |
| --- | --- | --- |
| Meeting created | `pipeline/inviteeCreated.ts` (4 insert sites) | Copy `opportunity.assignedCloserId` |
| Opportunity reassigned | Reassignment mutations | Batch-update all meetings for that opportunity |
| Lead merge (opp moves) | `leads/mutations.ts` merge handler | Update meetings if ownership changes |

### 3.7 Per-meeting booking answers (Finding 2)

In `pipeline/inviteeCreated.ts`, alongside meeting creation:
1. Parse `questions_and_answers` from the webhook payload (currently extracted at line ~952)
2. Upsert `eventTypeFieldCatalog` entries for each field key
3. Insert `meetingFormResponses` rows for each Q&A pair
4. Continue writing merged view to `leads.customFields` for backward compatibility

### 3.8 User soft-delete (Finding 8)

Replace hard delete in `convex/workos/userMutations.ts:428-458`:

```typescript
// Before: ctx.db.delete(userId)
// After:
// 1. Check for active assignments
const activeOpps = await ctx.db.query("opportunities")
  .withIndex("by_tenantId_and_assignedCloserId_and_status", q =>
    q.eq("tenantId", tenantId).eq("assignedCloserId", targetUserId))
  .take(10);

const hasActiveOpps = activeOpps.some(
  o => !["lost", "canceled", "payment_received"].includes(o.status)
);
if (hasActiveOpps) {
  throw new ConvexError("Cannot remove user with active opportunities. Reassign first.");
}

// 2. Soft-delete
await ctx.db.patch(targetUserId, { deletedAt: Date.now(), isActive: false });

// 3. Emit domain event
await emitDomainEvent(ctx, {
  tenantId, entityType: "user", entityId: targetUserId,
  eventType: "user_deactivated", source: "admin", actorUserId: userId,
});
```

Add `isActive: true` to all user creation paths (`createUserWithCalendlyLink`, `createInvitedUser`).

Add `isActive` check to `requireTenantUser` auth guard.

### 3.9 Tenant offboarding cascade (Finding 7)

Expand `deleteTenantRuntimeDataBatch` (`convex/admin/tenantsMutations.ts:65-128`) to cascade all tenant-scoped tables. Delete in reverse-dependency order within each batch (`.take(128)` per table):

| Order | Table | Notes |
| --- | --- | --- |
| 1 | `paymentRecords` | Delete `_storage` files via `proofFileId` first |
| 2 | `meetingFormResponses` | New table |
| 3 | `followUps` | |
| 4 | `meetingReassignments` | |
| 5 | `closerUnavailability` | |
| 6 | `meetings` | |
| 7 | `opportunities` | |
| 8 | `customers` | |
| 9 | `leadMergeHistory` | |
| 10 | `leadIdentifiers` | |
| 11 | `leads` | |
| 12 | `eventTypeConfigs` | |
| 13 | `eventTypeFieldCatalog` | New table |
| 14 | `domainEvents` | New table |
| 15 | `tenantStats` | New table |
| 16 | `tenantCalendlyConnections` | New table (Phase 5) |
| 17 | `rawWebhookEvents` | Already cleaned |
| 18 | `calendlyOrgMembers` | Already cleaned |
| 19 | `users` | Already cleaned — last, since others reference users |

Do not delete the tenant row until all dependent data is confirmed deleted.

### 3.10 Webhook dedup fix (Finding 9)

Replace scan-then-compare in `convex/webhooks/calendlyMutations.ts:15-29`:

```typescript
// Before -- O(n) scan + JS compare (confirmed OCC conflict source):
for await (const existing of existingEvents) {
  if (existing.calendlyEventUri === args.calendlyEventUri) { ... }
}

// After -- O(1) compound index lookup:
const existing = await ctx.db.query("rawWebhookEvents")
  .withIndex("by_tenantId_and_eventType_and_calendlyEventUri", q =>
    q.eq("tenantId", args.tenantId)
     .eq("eventType", args.eventType)
     .eq("calendlyEventUri", args.calendlyEventUri))
  .first();
```

### 3.11 Event type config upsert guard (Finding 9)

Funnel all future writes through a single upsert path in `convex/eventTypeConfigs/mutations.ts`. After Phase 2.8 dedup, `lookupEventTypeConfig()` in `pipeline/inviteeCreated.ts:685-717` simplifies from `.take(8)` + sort to `.first()`.

### 3.12 `customFields` type hardening (Finding 2)

Change `leads.customFields` from `v.any()` to `v.optional(v.record(v.string(), v.string()))` in schema. Update `mergeCustomFields()` and `syncLeadFromBooking()` accordingly (they already produce `Record<string, string>`, so logic changes are minimal).

### 3.13 `tenantStats` atomic counter maintenance (Finding 4)

Wire `updateTenantStats(ctx, tenantId, delta)` into every mutation that changes a counted value:

| Stat field | Updated by |
| --- | --- |
| `totalTeamMembers`, `totalClosers` | User create, user soft-delete |
| `totalOpportunities`, `activeOpportunities` | Opportunity create, status change |
| `wonDeals`, `lostDeals` | `logPayment` (-> payment_received), `markAsLost` (-> lost) |
| `totalRevenueMinor`, `totalPaymentRecords` | `logPayment`, `recordCustomerPayment` |
| `totalLeads` | Lead create (pipeline), lead merge |
| `totalCustomers` | Customer conversion |

### 3.14 Customer snapshot sync (Finding 15)

In `updateLead` mutation (and any lead identity mutation), after patching the lead:

```typescript
const customer = await ctx.db.query("customers")
  .withIndex("by_tenantId_and_leadId", q =>
    q.eq("tenantId", tenantId).eq("leadId", leadId))
  .first();
if (customer) {
  await ctx.db.patch(customer._id, {
    fullName: updatedLead.fullName,
    email: updatedLead.email,
    phone: updatedLead.phone,
  });
}
```

### 3.15 Denormalized field maintenance (Findings 15, 20)

| Gap | Fix |
| --- | --- |
| `leads.socialHandles` not rebuilt on all identifier mutations | Extract `rebuildLeadSocialHandles(ctx, leadId)` helper; call from `executeMerge()` and identifier mutation paths |
| `meetings.leadName` stale after lead name update | Add sync in `updateLead` mutation — query meetings via opportunity chain, patch `leadName` |
| `opportunities.hostCalendly*` stale | Document as intentional creation-time snapshot; host resolution uses `assignedCloserId -> user -> calendlyMemberName` |

---

## 8. Phase 4: Backend Query Rewrites

**Goal**: All read paths use new indexes and denormalized fields. Correctness bugs fixed.

### 4.1 Closer dashboard/pipeline/calendar rewrites (Findings 5, 12)

| Query | File | Current Pattern | New Pattern |
| --- | --- | --- | --- |
| `getNextMeeting` | `closer/dashboard.ts:13-77` | `.collect()` all opps -> build ID set -> scan meetings | `meetings.by_tenantId_and_assignedCloserId_and_scheduledAt` with `gte(now)` -> `.first()` |
| `getPipelineSummary` | `closer/dashboard.ts:85-121` | `.collect()` all closer opps -> JS count by status | `.withIndex("by_tenantId_and_assignedCloserId_and_status")` with status prefix |
| `listMyOpportunities` | `closer/pipeline.ts:24-70` | `.collect()` -> JS filter -> sort -> N+1 enrich | Compound index query -> `.paginate()` -> batch enrichment |
| `getMeetingsForRange` | `closer/calendar.ts:15-85` | `.collect()` all opps -> scan date range -> JS filter by opp set | `meetings.by_tenantId_and_assignedCloserId_and_scheduledAt` with range bounds |
| `listAffectedMeetingsForCloserInRange` | `unavailability/shared.ts:95-151` | `listActiveOpportunityIdsForCloser()` -> scan -> filter | Direct indexed range query |
| `buildCloserSchedulesForDate` | `unavailability/shared.ts:153-262` | Per-closer: scan all opps -> build map -> scan meetings | Per-closer indexed query |

### 4.2 Admin dashboard rewrite (Finding 4)

`getAdminDashboardStats` becomes a single document read from `tenantStats`. Keep `meetingsToday` as a live range query (bounded, efficient). Return shape preserved:
```
{ totalTeamMembers, totalClosers, unmatchedClosers, totalOpportunities,
  activeOpportunities, meetingsToday, wonDeals, revenueLogged, totalRevenue,
  paymentRecordsLogged }
```

Where `revenueLogged` becomes `tenantStats.totalRevenueMinor / 100` for display.

### 4.3 Pagination correctness fixes (Findings 6, 10)

| Query | File | Bug | Fix |
| --- | --- | --- | --- |
| `listLeads` | `leads/queries.ts:76-157` | Paginates by `tenantId` -> post-filters merged leads -> short pages | Make `status` required -> query `by_tenantId_and_status` directly |
| `searchLeads` | `leads/queries.ts:178-208` | Fetches 40 -> JS-filters -> truncates to 20 | Use search index `status` filter directly (status no longer optional) |
| `listCustomers` (closer) | `customers/queries.ts:52-54` | Paginates all tenant -> returns null for non-matching closer | `by_tenantId_and_convertedByUserId` paginated |
| `getActiveReminders` | `closer/followUpQueries.ts` | `.take(50)` -> `.filter(type === "manual_reminder")` -> short | Compound `by_tenantId_and_closerId_and_type_and_status_and_reminderScheduledAt` |

### 4.4 Customer payment summary (Finding 4)

- `listCustomers` drops per-customer payment `.collect()` loop — reads `totalPaidMinor` directly
- `getCustomerTotalPaid` becomes dead code (single doc read)
- `getCustomerDetail` payment history remains a separate bounded query

### 4.5 Detail query flattening (Finding 19)

| Query | File | Pattern | Fix |
| --- | --- | --- | --- |
| `getLeadDetail` | `leads/queries.ts:253-449` | Per-opp -> per-meeting nested loops | Query broadly, group in JS; batch enrichment with deduped ID sets |
| `getCustomerDetail` | `customers/queries.ts:90-185` | Same nested pattern | Same fix |
| `getMeetingDetail` | `closer/meetingDetail.ts:71-92` | "All related meetings for this lead" embedded | Separate bounded query |

Enrichment batching pattern:
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
// Then enrich from map instead of per-record lookups
```

### 4.6 Unbounded query bounds (Findings 4, 19)

| Query | File | Fix |
| --- | --- | --- |
| `listOpportunitiesForAdmin` | `opportunities/queries.ts:46-218` | `.paginate()` with `usePaginatedQuery` on client |
| `listMyOpportunities` | `closer/pipeline.ts:24-70` | `.paginate()` or `.take(50)` |
| `listTeamMembers` | User queries | `.take(200)` safety limit |
| `listUnmatchedCalendlyMembers` | User queries | `.take(200)` safety limit |

### 4.7 Additional query updates

| Change | Finding |
| --- | --- |
| Update all payment read queries to use `amountMinor` | F3 |
| Filter soft-deleted users from `listTeamMembers` and all user queries | F8 |
| Remove `isActiveLikeLeadStatus` helpers and `?? "active"` fallbacks | F6 |
| Update `getLeadDetail` follow-ups to use `followUps.by_tenantId_and_leadId_and_createdAt` | F11 |
| Rewrite `getEventTypeConfigsWithStats` to use `by_tenantId_and_eventTypeConfigId` | F4 |
| Rewrite closer schedule queries in `unavailability/shared.ts` to use compound index | F5 |

---

## 9. Phase 5: OAuth State Extraction

**Goal**: Separate high-churn Calendly OAuth state from stable tenant identity. Eliminate 16 reactive invalidations/day.

**This phase is NOT deferred.** Finding 14 quantifies the cost: every query reading any `tenants` field is invalidated 16x/day by the 90-minute token refresh cron. This is a real production cost for every reactive subscription that touches tenant data.

### 5.1 New table: `tenantCalendlyConnections`

```typescript
tenantCalendlyConnections: defineTable({
  tenantId: v.id("tenants"),
  // OAuth tokens
  calendlyAccessToken: v.optional(v.string()),
  calendlyRefreshToken: v.optional(v.string()),
  calendlyTokenExpiresAt: v.optional(v.number()),
  calendlyRefreshLockUntil: v.optional(v.number()),
  lastTokenRefreshAt: v.optional(v.number()),
  codeVerifier: v.optional(v.string()),
  // Organization URIs
  calendlyOrganizationUri: v.optional(v.string()),
  calendlyUserUri: v.optional(v.string()),
  // Webhook config
  calendlyWebhookUri: v.optional(v.string()),
  calendlyWebhookSigningKey: v.optional(v.string()),
  // Status
  connectionStatus: v.optional(v.union(
    v.literal("connected"),
    v.literal("disconnected"),
    v.literal("token_expired"),
  )),
  lastHealthCheckAt: v.optional(v.number()),
})
  .index("by_tenantId", ["tenantId"])
```

### 5.2 Migration steps

1. **Create table** (already done in Phase 1.1e)
2. **Backfill**: Copy all OAuth-related fields from existing `tenants` rows into new `tenantCalendlyConnections` rows
3. **Dual-read**: Update all OAuth consumers to read from new table, falling back to `tenants` during transition
4. **Switch writes**: Update all OAuth writers to write to new table only
5. **Remove from tenants**: Mark OAuth fields as deprecated in `tenants` schema (remove in Phase 6)

### 5.3 Files affected

| File | Current behavior | Change |
| --- | --- | --- |
| `convex/calendly/tokens.ts` | Reads/writes OAuth tokens on `tenants` | Read/write from `tenantCalendlyConnections` |
| `convex/calendly/healthCheck.ts` | Reads token from `tenants` | Read from `tenantCalendlyConnections` |
| `convex/calendly/orgMembers.ts` | Reads org URI from `tenants` | Read from `tenantCalendlyConnections` |
| `convex/webhooks/calendly.ts` | Reads webhook signing key from `tenants` | Read from `tenantCalendlyConnections` |
| `convex/admin/tenants.ts` | Onboarding writes OAuth data to `tenants` | Write to `tenantCalendlyConnections` |
| `convex/crons.ts:refreshAllTokens` | Iterates tenants for token refresh | Iterate `tenantCalendlyConnections` |
| `app/api/calendly/oauth/callback/route.ts` | Writes tokens to tenant | Write to `tenantCalendlyConnections` |
| `convex/admin/tenantsMutations.ts` | Tenant reset clears OAuth fields | Clear `tenantCalendlyConnections` row |

### 5.4 `tenants` table field removal plan

After 5.3 is deployed and verified, the following `tenants` fields become unused:
- `calendlyAccessToken`, `calendlyRefreshToken`, `calendlyTokenExpiresAt`
- `calendlyRefreshLockUntil`, `lastTokenRefreshAt`, `codeVerifier`
- `calendlyOrganizationUri`, `calendlyUserUri`
- `calendlyWebhookUri`, `calendlyWebhookSigningKey`

These are cleaned in Phase 6 via a backfill that removes the fields from all tenant documents, followed by removing them from the schema validator.

---

## 10. Phase 6: Schema Narrow

**Goal**: Tighten schema validators now that all data is backfilled and code is updated.

**Prerequisite**: All Phase 2 backfills complete + all Phase 3/4/5 code updates deployed and verified.

| # | Change | Finding | Validation before narrowing |
| --- | --- | --- | --- |
| 6.1 | Make `leads.status` required (remove `v.optional()`) | F6 | Zero leads with `status === undefined` |
| 6.2 | Remove `paymentRecords.amount` (replaced by `amountMinor`) | F3 | All reads use `amountMinor`; zero code references to `.amount` |
| 6.3 | Make `users.isActive` required | F8 | Zero users with `isActive === undefined` |
| 6.4 | Make `meetings.assignedCloserId` required | F12 | Zero meetings with `assignedCloserId === undefined` |
| 6.5 | Make `followUps.type` required | F18 | Zero follow-ups with `type === undefined` |
| 6.6 | Make `paymentRecords.contextType` required | F18 | Zero payment records with `contextType === undefined` |
| 6.7 | Harden `leads.customFields` to `v.optional(v.record(v.string(), v.string()))` | F2 | All existing values are valid `Record<string, string>` |
| 6.8 | Remove deprecated OAuth fields from `tenants` schema | F14 | All OAuth consumers read from `tenantCalendlyConnections` |

**Validation approach**: Before each narrowing, run a count query to verify zero documents have the old shape:
```typescript
const unmigrated = await ctx.db.query("leads")
  .filter(q => q.eq(q.field("status"), undefined)).take(1);
assert(unmigrated.length === 0);
```

Convex validates schema against existing data on deploy — it will reject if any document doesn't match.

---

## 11. Phase 7: Frontend Updates

**Goal**: UI reflects new data model. Payment displays use cents. Soft-deleted users handled.

### 7.1 New utility

```typescript
// lib/format-currency.ts
export function formatAmountMinor(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amountMinor / 100);
}
```

### 7.2 Payment model (`amount` -> `amountMinor`)

| File | Change |
| --- | --- |
| `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` | `Math.round(parseFloat(amount) * 100)` before mutation; arg key -> `amountMinor` |
| `app/workspace/customers/[customerId]/_components/record-payment-dialog.tsx` | Same conversion at submission boundary |
| `app/workspace/customers/[customerId]/_components/payment-history-table.tsx` | `payment.amount.toFixed(2)` -> `formatAmountMinor(payment.amountMinor, payment.currency)` |
| `app/workspace/closer/meetings/_components/deal-won-card.tsx` | `formatCurrency(payment.amount, ...)` -> `formatAmountMinor(payment.amountMinor, ...)` |
| `app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx` | `totalPaid` -> `totalPaidMinor / 100` for display |
| `app/workspace/customers/_components/customers-table.tsx` | `customer.totalPaid` -> `customer.totalPaidMinor / 100` |

### 7.3 User soft-delete UI

| File | Change |
| --- | --- |
| `app/workspace/team/_components/team-members-table.tsx` | Add deactivated visual indicator (dimmed row, "Deactivated" badge); hide action buttons for deactivated; add show/hide inactive toggle |
| `app/workspace/team/_components/remove-user-dialog.tsx` | Rename to "Deactivate User"; update dialog copy; pre-flight check for active assignments |
| `app/workspace/team/_components/team-page-client.tsx` | Pre-flight check in `handleRemoveUser`; CSV export includes deactivation status |
| Various closer/customer name displays | Handle deactivated users with "(Deactivated)" suffix or visual indicator |

### 7.4 `leads.status` cleanup

| File | Change |
| --- | --- |
| `app/workspace/leads/_components/leads-table.tsx:64,166` | Remove `?? "active"` fallbacks |
| `app/workspace/leads/[leadId]/_components/lead-detail-page-client.tsx:86,133` | Remove `?? "active"` fallbacks |
| `convex/customers/conversion.ts` | Remove `(lead.status ?? "active") as any` cast |

### 7.5 Dashboard stats

| File | Change |
| --- | --- |
| `app/workspace/_components/stats-row.tsx` | `revenueLogged` reads `totalRevenueMinor / 100` from summary doc |
| `app/workspace/_components/dashboard-page-client.tsx` | Remove 60s polling interval (reactive summary doc auto-updates) |

### 7.6 Pipeline pagination

| File | Change |
| --- | --- |
| `app/workspace/pipeline/_components/pipeline-page-client.tsx` | Switch from `useQuery` to `usePaginatedQuery`; handle "Load more" |
| `app/workspace/pipeline/_components/opportunities-table.tsx` | Handle paginated data; client-sort becomes per-page |
| `app/workspace/closer/pipeline/_components/closer-pipeline-page-client.tsx` | Switch to `usePaginatedQuery` |
| `app/workspace/closer/pipeline/_components/opportunity-table.tsx` | Handle paginated data |

---

## 12. Schema Changes Reference

### New tables (complete definitions)

```typescript
// Finding 1: Append-only business event history
domainEvents: defineTable({
  tenantId: v.id("tenants"),
  entityType: v.union(
    v.literal("opportunity"),
    v.literal("meeting"),
    v.literal("lead"),
    v.literal("customer"),
    v.literal("followUp"),
    v.literal("user"),
    v.literal("payment"),
  ),
  entityId: v.string(),
  eventType: v.string(),
  occurredAt: v.number(),
  actorUserId: v.optional(v.id("users")),
  source: v.union(
    v.literal("closer"),
    v.literal("admin"),
    v.literal("pipeline"),
    v.literal("system"),
  ),
  fromStatus: v.optional(v.string()),
  toStatus: v.optional(v.string()),
  reason: v.optional(v.string()),
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
  .index("by_tenantId_and_actorUserId_and_occurredAt", [
    "tenantId", "actorUserId", "occurredAt",
  ]),

// Finding 4: Dashboard summary document
tenantStats: defineTable({
  tenantId: v.id("tenants"),
  totalTeamMembers: v.number(),
  totalClosers: v.number(),
  totalOpportunities: v.number(),
  activeOpportunities: v.number(),
  wonDeals: v.number(),
  lostDeals: v.number(),
  totalRevenueMinor: v.number(),
  totalPaymentRecords: v.number(),
  totalLeads: v.number(),
  totalCustomers: v.number(),
  lastUpdatedAt: v.number(),
}).index("by_tenantId", ["tenantId"]),

// Finding 2: Per-meeting booking answers (normalized fact table)
meetingFormResponses: defineTable({
  tenantId: v.id("tenants"),
  meetingId: v.id("meetings"),
  opportunityId: v.id("opportunities"),
  leadId: v.id("leads"),
  eventTypeConfigId: v.optional(v.id("eventTypeConfigs")),
  fieldCatalogId: v.optional(v.id("eventTypeFieldCatalog")),
  fieldKey: v.string(),
  questionLabelSnapshot: v.string(),
  answerText: v.string(),
  capturedAt: v.number(),
})
  .index("by_meetingId", ["meetingId"])
  .index("by_tenantId_and_eventTypeConfigId", ["tenantId", "eventTypeConfigId"])
  .index("by_tenantId_and_fieldKey", ["tenantId", "fieldKey"])
  .index("by_leadId", ["leadId"]),

// Finding 2: Stable field registry per event type
eventTypeFieldCatalog: defineTable({
  tenantId: v.id("tenants"),
  eventTypeConfigId: v.id("eventTypeConfigs"),
  fieldKey: v.string(),
  currentLabel: v.string(),
  firstSeenAt: v.number(),
  lastSeenAt: v.number(),
  valueType: v.optional(v.string()),
})
  .index("by_tenantId_and_eventTypeConfigId", ["tenantId", "eventTypeConfigId"])
  .index("by_tenantId_and_fieldKey", ["tenantId", "fieldKey"]),

// Finding 14: Extracted Calendly OAuth/webhook state
tenantCalendlyConnections: defineTable({
  tenantId: v.id("tenants"),
  calendlyAccessToken: v.optional(v.string()),
  calendlyRefreshToken: v.optional(v.string()),
  calendlyTokenExpiresAt: v.optional(v.number()),
  calendlyRefreshLockUntil: v.optional(v.number()),
  lastTokenRefreshAt: v.optional(v.number()),
  codeVerifier: v.optional(v.string()),
  calendlyOrganizationUri: v.optional(v.string()),
  calendlyUserUri: v.optional(v.string()),
  calendlyWebhookUri: v.optional(v.string()),
  calendlyWebhookSigningKey: v.optional(v.string()),
  connectionStatus: v.optional(v.union(
    v.literal("connected"),
    v.literal("disconnected"),
    v.literal("token_expired"),
  )),
  lastHealthCheckAt: v.optional(v.number()),
})
  .index("by_tenantId", ["tenantId"]),
```

### Modified tables -- new optional fields

```typescript
// users (F8: soft-delete)
users: {
  deletedAt: v.optional(v.number()),
  isActive: v.optional(v.boolean()),  // undefined treated as true during migration
}

// meetings (F12: closer dimension; F16: timestamps; F17: attribution)
meetings: {
  assignedCloserId: v.optional(v.id("users")),
  completedAt: v.optional(v.number()),
  canceledAt: v.optional(v.number()),
  noShowMarkedByUserId: v.optional(v.id("users")),
}

// opportunities (F16: timestamps; F17: attribution)
opportunities: {
  lostAt: v.optional(v.number()),
  canceledAt: v.optional(v.number()),
  noShowAt: v.optional(v.number()),
  paymentReceivedAt: v.optional(v.number()),
  lostByUserId: v.optional(v.id("users")),
}

// paymentRecords (F3: money model; F16/F17: attribution; F18: discriminant)
paymentRecords: {
  amountMinor: v.optional(v.number()),    // Integer cents, replaces `amount`
  verifiedAt: v.optional(v.number()),
  verifiedByUserId: v.optional(v.id("users")),
  statusChangedAt: v.optional(v.number()),
  contextType: v.optional(v.union(
    v.literal("opportunity"),
    v.literal("customer"),
  )),
}

// customers (F4: denormalized totals; F16: timestamps)
customers: {
  totalPaidMinor: v.optional(v.number()),
  totalPaymentCount: v.optional(v.number()),
  paymentCurrency: v.optional(v.string()),
  churnedAt: v.optional(v.number()),
  pausedAt: v.optional(v.number()),
}

// followUps (F16: timestamps)
followUps: {
  bookedAt: v.optional(v.number()),
}

// leads (F2: type hardening -- narrowed in Phase 6)
// customFields: v.optional(v.any()) -> v.optional(v.record(v.string(), v.string()))
// status: v.optional(v.union(...)) -> v.union(...) (required)
```

---

## 13. Index Changes Reference

### Correctness indexes (fix current broken query shapes) -- 8 indexes

| Table | Index name | Fields | Fixes finding |
| --- | --- | --- | --- |
| `opportunities` | `by_tenantId_and_assignedCloserId_and_status` | `["tenantId", "assignedCloserId", "status"]` | F5, F10 |
| `opportunities` | `by_tenantId_and_potentialDuplicateLeadId` | `["tenantId", "potentialDuplicateLeadId"]` | F11 |
| `opportunities` | `by_tenantId_and_eventTypeConfigId` | `["tenantId", "eventTypeConfigId"]` | F4 |
| `customers` | `by_tenantId_and_convertedByUserId` | `["tenantId", "convertedByUserId"]` | F10 |
| `customers` | `by_tenantId_and_convertedByUserId_and_status` | `["tenantId", "convertedByUserId", "status"]` | F10 |
| `followUps` | `by_tenantId_and_leadId_and_createdAt` | `["tenantId", "leadId", "createdAt"]` | F10, F11 |
| `followUps` | `by_tenantId_and_closerId_and_type_and_status_reminderScheduledAt` | `["tenantId", "closerId", "type", "status", "reminderScheduledAt"]` | F10, F11 |
| `rawWebhookEvents` | `by_tenantId_and_eventType_and_calendlyEventUri` | `["tenantId", "eventType", "calendlyEventUri"]` | F9, F11 |

### Analytics indexes (enable reporting without full scans) -- 14 indexes

| Table | Index name | Fields | Use case |
| --- | --- | --- | --- |
| `opportunities` | `by_tenantId_and_createdAt` | `["tenantId", "createdAt"]` | Pipeline volume by date |
| `opportunities` | `by_tenantId_and_status_and_createdAt` | `["tenantId", "status", "createdAt"]` | Status cohort analysis |
| `meetings` | `by_tenantId_and_status_and_scheduledAt` | `["tenantId", "status", "scheduledAt"]` | No-show/completion rates |
| `meetings` | `by_tenantId_and_meetingOutcome_and_scheduledAt` | `["tenantId", "meetingOutcome", "scheduledAt"]` | Outcome analytics |
| `meetings` | `by_opportunityId_and_scheduledAt` | `["opportunityId", "scheduledAt"]` | Meeting timeline (sorted) |
| `meetings` | `by_tenantId_and_status` | `["tenantId", "status"]` | Meeting status distribution |
| `paymentRecords` | `by_tenantId_and_recordedAt` | `["tenantId", "recordedAt"]` | Revenue over time |
| `paymentRecords` | `by_tenantId_and_status_and_recordedAt` | `["tenantId", "status", "recordedAt"]` | Verified vs disputed trends |
| `paymentRecords` | `by_customerId_and_recordedAt` | `["customerId", "recordedAt"]` | Customer payment history |
| `paymentRecords` | `by_tenantId_and_closerId_and_recordedAt` | `["tenantId", "closerId", "recordedAt"]` | Closer revenue over time |
| `leads` | `by_tenantId_and_firstSeenAt` | `["tenantId", "firstSeenAt"]` | Lead acquisition cohorts |
| `followUps` | `by_tenantId_and_status_and_createdAt` | `["tenantId", "status", "createdAt"]` | Follow-up pipeline aging |
| `followUps` | `by_opportunityId_and_status` | `["opportunityId", "status"]` | Pending follow-up lookup |
| `meetingReassignments` | `by_tenantId_and_reassignedAt` | `["tenantId", "reassignedAt"]` | Reassignment frequency |

### Closer dimension index (depends on `meetings.assignedCloserId`) -- 1 index

| Table | Index name | Fields |
| --- | --- | --- |
| `meetings` | `by_tenantId_and_assignedCloserId_and_scheduledAt` | `["tenantId", "assignedCloserId", "scheduledAt"]` |

### User soft-delete index -- 1 index

| Table | Index name | Fields |
| --- | --- | --- |
| `users` | `by_tenantId_and_isActive` | `["tenantId", "isActive"]` |

**Total new indexes**: 24 (8 correctness + 14 analytics + 1 closer dimension + 1 soft-delete)

All within Convex's 32-per-table limit. Most-indexed table after migration: `meetings` (3 existing + 6 new = 9).

---

## 14. Codebase Impact Analysis

### Highest-impact files

#### `convex/pipeline/inviteeCreated.ts` (~1493 lines) -- ~20 touch points

| Change | Affected functions | Lines |
| --- | --- | --- |
| Domain events | `process` (5 code paths: UTM link ~1029, heuristic reschedule ~1272, follow-up reuse ~1385, new opp ~1413, new lead ~515) | 8+ emission points |
| `customFields` type | `extractQuestionsAndAnswers`, `mergeCustomFields`, `syncLeadFromBooking`, `process` | 30-66, 237-268, 952, 1191 |
| `meetings.assignedCloserId` | All 4 meeting insert sites | ~1104, ~1305, ~1436 |
| `meetingFormResponses` | All meeting insert sites need parallel insert | Same 4 sites |
| `tenantStats` | Opportunity creation paths -> `totalOpportunities++`, `activeOpportunities++` | 5 paths |

#### `convex/pipeline/inviteeCanceled.ts` (~141 lines) -- 3 touch points
Domain events (meeting + opportunity), lifecycle timestamps (`canceledAt`)

#### `convex/pipeline/inviteeNoShow.ts` (~195 lines) -- 6 touch points
Domain events (process: 2 sites, revert: 2 sites), lifecycle timestamps

#### `convex/closer/payments.ts` (~178 lines) -- 5 touch points
`amountMinor` write, currency validation, `tenantStats` update, customer totals, domain event

#### `convex/workos/userMutations.ts` -- 3 touch points
Soft-delete (`removeUser`), `isActive: true` on creation paths, domain events

#### `convex/admin/tenantsMutations.ts` -- 1 major rewrite
Expand `deleteTenantRuntimeDataBatch` cascade from 3 to 19 tables

#### `convex/webhooks/calendlyMutations.ts` -- 1 critical fix
Replace scan-then-compare with compound index lookup

### Query files (15+ rewrites)

| File | Queries affected |
| --- | --- |
| `convex/closer/dashboard.ts` | `getNextMeeting`, `getPipelineSummary` |
| `convex/closer/pipeline.ts` | `listMyOpportunities` |
| `convex/closer/calendar.ts` | `getMeetingsForRange` |
| `convex/closer/followUpQueries.ts` | `getActiveReminders` |
| `convex/closer/meetingDetail.ts` | `getMeetingDetail` (history section) |
| `convex/dashboard/adminStats.ts` | `getAdminDashboardStats` |
| `convex/leads/queries.ts` | `listLeads`, `searchLeads`, `getLeadDetail` |
| `convex/customers/queries.ts` | `listCustomers`, `getCustomerDetail`, `getCustomerTotalPaid` |
| `convex/opportunities/queries.ts` | `listOpportunitiesForAdmin` |
| `convex/eventTypeConfigs/queries.ts` | `getEventTypeConfigsWithStats` |
| `convex/unavailability/shared.ts` | `listAffectedMeetingsForCloserInRange`, `buildCloserSchedulesForDate` |

### OAuth files (Phase 5)

| File | Change |
| --- | --- |
| `convex/calendly/tokens.ts` | Read/write OAuth tokens from `tenantCalendlyConnections` |
| `convex/calendly/healthCheck.ts` | Read token/connection status from new table |
| `convex/calendly/orgMembers.ts` | Read org URI from new table |
| `convex/webhooks/calendly.ts` | Read signing key from new table |
| `convex/admin/tenants.ts` | Write OAuth data to new table during onboarding |
| `convex/crons.ts` | `refreshAllTokens` iterates `tenantCalendlyConnections` |
| `app/api/calendly/oauth/callback/route.ts` | Write tokens to new table |

### Frontend files (13+ updates)

See [Phase 7](#11-phase-7-frontend-updates) for the complete list.

---

## 15. Migration Scripts

All scripts run as Convex internal mutations. Given the small data footprint (~700 records), each processes all records in a single mutation without batching.

### Script 2.1: Backfill `leads.status`

```typescript
export const backfillLeadStatus = internalMutation({
  args: {},
  handler: async (ctx) => {
    const leads = await ctx.db.query("leads").collect();
    let updated = 0;
    for (const lead of leads) {
      if (lead.status === undefined) {
        await ctx.db.patch(lead._id, { status: "active" });
        updated++;
      }
    }
    console.log(`[Migration] Backfilled ${updated} leads with status="active"`);
    return { updated, total: leads.length };
  },
});
```

### Script 2.2: Backfill `users.isActive`

```typescript
export const backfillUserIsActive = internalMutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    let updated = 0;
    for (const user of users) {
      if (user.isActive === undefined) {
        await ctx.db.patch(user._id, { isActive: true });
        updated++;
      }
    }
    return { updated, total: users.length };
  },
});
```

### Script 2.3: Backfill `meetings.assignedCloserId`

```typescript
export const backfillMeetingCloserId = internalMutation({
  args: {},
  handler: async (ctx) => {
    const meetings = await ctx.db.query("meetings").collect();
    let updated = 0;
    for (const meeting of meetings) {
      if (meeting.assignedCloserId === undefined) {
        const opp = await ctx.db.get(meeting.opportunityId);
        if (opp?.assignedCloserId) {
          await ctx.db.patch(meeting._id, {
            assignedCloserId: opp.assignedCloserId,
          });
          updated++;
        }
      }
    }
    return { updated, total: meetings.length };
  },
});
```

### Script 2.4: Backfill `paymentRecords.amountMinor`

```typescript
export const backfillPaymentAmountMinor = internalMutation({
  args: {},
  handler: async (ctx) => {
    const payments = await ctx.db.query("paymentRecords").collect();
    let updated = 0;
    for (const payment of payments) {
      if (payment.amountMinor === undefined) {
        await ctx.db.patch(payment._id, {
          amountMinor: Math.round(payment.amount * 100),
        });
        updated++;
      }
    }
    return { updated, total: payments.length };
  },
});
```

### Script 2.5: Backfill `customers.totalPaidMinor`

```typescript
export const backfillCustomerTotals = internalMutation({
  args: {},
  handler: async (ctx) => {
    const customers = await ctx.db.query("customers").collect();
    let updated = 0;
    for (const customer of customers) {
      const payments = await ctx.db.query("paymentRecords")
        .withIndex("by_customerId", q => q.eq("customerId", customer._id))
        .collect();
      const nonDisputed = payments.filter(p => p.status !== "disputed");
      const totalMinor = nonDisputed.reduce(
        (sum, p) => sum + (p.amountMinor ?? Math.round(p.amount * 100)), 0
      );
      const currency = nonDisputed[0]?.currency ?? "USD";
      await ctx.db.patch(customer._id, {
        totalPaidMinor: totalMinor,
        totalPaymentCount: nonDisputed.length,
        paymentCurrency: currency,
      });
      updated++;
    }
    return { updated, total: customers.length };
  },
});
```

### Script 2.6: Backfill `paymentRecords.contextType`

```typescript
export const backfillPaymentContextType = internalMutation({
  args: {},
  handler: async (ctx) => {
    const payments = await ctx.db.query("paymentRecords").collect();
    let updated = 0;
    for (const payment of payments) {
      if (payment.contextType === undefined) {
        const contextType = payment.opportunityId
          ? "opportunity" as const
          : "customer" as const;
        await ctx.db.patch(payment._id, { contextType });
        updated++;
      }
    }
    return { updated, total: payments.length };
  },
});
```

### Script 2.7: Seed `tenantStats`

```typescript
export const seedTenantStats = internalMutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const users = await ctx.db.query("users")
      .withIndex("by_tenantId", q => q.eq("tenantId", tenantId)).collect();
    const activeUsers = users.filter(u => u.isActive !== false);
    const closers = activeUsers.filter(u => u.role === "closer");

    const opps = await ctx.db.query("opportunities")
      .withIndex("by_tenantId", q => q.eq("tenantId", tenantId)).collect();
    const activeStatuses = ["scheduled", "in_progress", "follow_up_scheduled",
      "reschedule_link_sent"];
    const active = opps.filter(o => activeStatuses.includes(o.status));
    const won = opps.filter(o => o.status === "payment_received");
    const lost = opps.filter(o => o.status === "lost");

    const payments = await ctx.db.query("paymentRecords")
      .withIndex("by_tenantId", q => q.eq("tenantId", tenantId)).collect();
    const nonDisputed = payments.filter(p => p.status !== "disputed");
    const totalRevenue = nonDisputed.reduce(
      (sum, p) => sum + (p.amountMinor ?? Math.round(p.amount * 100)), 0
    );

    const leads = await ctx.db.query("leads")
      .withIndex("by_tenantId", q => q.eq("tenantId", tenantId)).collect();
    const activeLeads = leads.filter(
      l => l.status === "active" || l.status === undefined
    );

    const customers = await ctx.db.query("customers")
      .withIndex("by_tenantId", q => q.eq("tenantId", tenantId)).collect();

    await ctx.db.insert("tenantStats", {
      tenantId,
      totalTeamMembers: activeUsers.length,
      totalClosers: closers.length,
      totalOpportunities: opps.length,
      activeOpportunities: active.length,
      wonDeals: won.length,
      lostDeals: lost.length,
      totalRevenueMinor: totalRevenue,
      totalPaymentRecords: nonDisputed.length,
      totalLeads: activeLeads.length,
      totalCustomers: customers.length,
      lastUpdatedAt: Date.now(),
    });
  },
});
```

### Script 2.8: Deduplicate `eventTypeConfigs`

```typescript
export const deduplicateEventTypeConfigs = internalMutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const configs = await ctx.db.query("eventTypeConfigs")
      .withIndex("by_tenantId", q => q.eq("tenantId", tenantId)).collect();

    const groups = new Map<string, typeof configs>();
    for (const config of configs) {
      const key = config.calendlyEventTypeUri;
      const group = groups.get(key) ?? [];
      group.push(config);
      groups.set(key, group);
    }

    let deleted = 0;
    for (const [uri, group] of groups) {
      if (group.length <= 1) continue;
      group.sort((a, b) => a.createdAt - b.createdAt);
      const canonical = group[0];
      const duplicates = group.slice(1);

      for (const dup of duplicates) {
        const opps = await ctx.db.query("opportunities")
          .withIndex("by_tenantId_and_eventTypeConfigId", q =>
            q.eq("tenantId", tenantId).eq("eventTypeConfigId", dup._id))
          .collect();
        for (const opp of opps) {
          await ctx.db.patch(opp._id, { eventTypeConfigId: canonical._id });
        }
        await ctx.db.delete(dup._id);
        deleted++;
      }
      console.log(`[Migration] ${uri}: kept ${canonical._id}, deleted ${duplicates.length} dupes`);
    }
    return { deleted };
  },
});
```

> **Note**: Requires the `by_tenantId_and_eventTypeConfigId` index from Phase 1.

### Script 2.9: Backfill `followUps.type`

```typescript
export const backfillFollowUpType = internalMutation({
  args: {},
  handler: async (ctx) => {
    const followUps = await ctx.db.query("followUps").collect();
    let updated = 0;
    for (const fu of followUps) {
      if (fu.type === undefined) {
        const inferredType = fu.schedulingLinkUrl
          ? "scheduling_link" as const
          : "manual_reminder" as const;
        await ctx.db.patch(fu._id, { type: inferredType });
        updated++;
      }
    }
    return { updated, total: followUps.length };
  },
});
```

### Script 2.12: Backfill `meetingFormResponses`

```typescript
export const backfillMeetingFormResponses = internalAction({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const rawEvents = await ctx.runQuery(
      internal.admin.migrations.getRawEventsForBackfill, { tenantId }
    );

    let created = 0;
    for (const rawEvent of rawEvents) {
      const payload = JSON.parse(rawEvent.payload);
      const qas = payload?.payload?.questions_and_answers;
      if (!qas?.length) continue;

      const meeting = await ctx.runQuery(
        internal.admin.migrations.getMeetingByCalendlyUri,
        { tenantId, calendlyEventUri: rawEvent.calendlyEventUri }
      );
      if (!meeting) continue;

      for (const qa of qas) {
        await ctx.runMutation(
          internal.admin.migrations.insertFormResponse, {
            tenantId,
            meetingId: meeting._id,
            opportunityId: meeting.opportunityId,
            leadId: meeting.leadId ?? "",
            fieldKey: qa.question?.toLowerCase().replace(/\s+/g, "_") ?? "unknown",
            questionLabelSnapshot: qa.question ?? "",
            answerText: qa.answer ?? "",
            capturedAt: rawEvent.receivedAt,
          }
        );
        created++;
      }
    }
    return { created };
  },
});
```

### Script 5.2: Backfill `tenantCalendlyConnections`

```typescript
export const backfillTenantCalendlyConnections = internalMutation({
  args: {},
  handler: async (ctx) => {
    const tenants = await ctx.db.query("tenants").collect();
    let created = 0;
    for (const tenant of tenants) {
      const existing = await ctx.db.query("tenantCalendlyConnections")
        .withIndex("by_tenantId", q => q.eq("tenantId", tenant._id))
        .first();
      if (existing) continue;

      await ctx.db.insert("tenantCalendlyConnections", {
        tenantId: tenant._id,
        calendlyAccessToken: tenant.calendlyAccessToken,
        calendlyRefreshToken: tenant.calendlyRefreshToken,
        calendlyTokenExpiresAt: tenant.calendlyTokenExpiresAt,
        calendlyRefreshLockUntil: tenant.calendlyRefreshLockUntil,
        lastTokenRefreshAt: tenant.lastTokenRefreshAt,
        codeVerifier: tenant.codeVerifier,
        calendlyOrganizationUri: tenant.calendlyOrganizationUri,
        calendlyUserUri: tenant.calendlyUserUri,
        calendlyWebhookUri: tenant.calendlyWebhookUri,
        calendlyWebhookSigningKey: tenant.calendlyWebhookSigningKey,
        connectionStatus: tenant.calendlyAccessToken ? "connected" : "disconnected",
      });
      created++;
    }
    return { created };
  },
});
```

---

## 16. Testing & Validation Gates

### Per-phase verification

#### After Phase 1 (Schema Widen)
- [ ] `npx convex deploy` succeeds with no schema validation errors
- [ ] All existing queries return correct data (new fields are `undefined`)
- [ ] Pipeline processes incoming webhooks without errors

#### After Phase 2 (Backfill)
- [ ] Zero leads with `status === undefined`
- [ ] Zero users with `isActive === undefined`
- [ ] All meetings have `assignedCloserId` matching their opportunity's closer
- [ ] All payment records have `amountMinor === Math.round(amount * 100)`
- [ ] All customers have `totalPaidMinor` matching sum of their payment `amountMinor` values
- [ ] `tenantStats` document exists and counts match live data
- [ ] Zero duplicate `eventTypeConfigs` per `(tenantId, calendlyEventTypeUri)`
- [ ] All follow-ups have a `type` value
- [ ] `meetingFormResponses` populated from retained raw webhooks

#### After Phase 3 (Backend Mutations)
- [ ] New Calendly booking -> opportunity + meeting created with `assignedCloserId` set
- [ ] New booking -> `meetingFormResponses` rows created from custom field answers
- [ ] New booking -> `domainEvents` emitted for `opportunity.created` + `meeting.created`
- [ ] Cancellation webhook -> `domainEvents` emitted, `canceledAt` set on both entities
- [ ] No-show webhook -> `domainEvents` emitted
- [ ] `markAsLost` -> `lostAt` + `lostByUserId` set, domain event emitted, `tenantStats` updated
- [ ] `logPayment` -> `amountMinor` stored, `paymentReceivedAt` set, `tenantStats` updated, customer totals updated
- [ ] `removeUser` -> user soft-deleted (row preserved, `isActive: false`)
- [ ] Soft-deleted user cannot authenticate (rejected by `requireTenantUser`)
- [ ] Tenant deletion cascades all 19 tables
- [ ] Webhook dedup works with compound index (no duplicate processing)
- [ ] Customer snapshot updates when lead identity fields change

#### After Phase 4 (Backend Queries)
- [ ] Admin dashboard loads in <200ms (single doc read instead of 4 table scans)
- [ ] Closer dashboard loads without `.collect()` on all opportunities
- [ ] Lead list pagination returns correct page sizes (no post-filter shrinkage)
- [ ] Lead search returns correct results (no over-fetch + truncate)
- [ ] Customer list for closers paginates correctly (no post-filter)
- [ ] Active reminders list returns all matching records (no post-take filter)
- [ ] Lead detail follow-ups load via index (not tenant scan + JS filter)
- [ ] Payment read queries use `amountMinor`

#### After Phase 5 (OAuth Extraction)
- [ ] Token refresh cron reads/writes from `tenantCalendlyConnections`
- [ ] Health check reads from `tenantCalendlyConnections`
- [ ] Webhook signature verification reads from `tenantCalendlyConnections`
- [ ] Onboarding writes OAuth data to `tenantCalendlyConnections`
- [ ] Queries reading `tenants` are no longer invalidated by token refresh

#### After Phase 6 (Schema Narrow)
- [ ] `npx convex deploy` succeeds with required `leads.status`
- [ ] `npx convex deploy` succeeds with removed `paymentRecords.amount`
- [ ] `npx convex deploy` succeeds with required `users.isActive`
- [ ] `npx convex deploy` succeeds without deprecated OAuth fields on `tenants`

#### After Phase 7 (Frontend)
- [ ] Payment form submits integer cents (verify in Convex dashboard)
- [ ] Payment displays show correct dollar amounts (cents / 100)
- [ ] Deactivated users show visual indicator on team page
- [ ] Deactivated users' names display correctly on historical records
- [ ] Lead list/detail no longer shows `?? "active"` artifacts
- [ ] Customer totals display correctly from denormalized field
- [ ] Pipeline views paginate correctly with "Load more"

### End-to-end validation

| Test | How |
| --- | --- |
| Full pipeline test | Trigger Calendly booking -> verify meeting with `assignedCloserId` + `meetingFormResponses` + domain event |
| Payment flow | Log payment -> verify `amountMinor` + `tenantStats` updated + customer totals + domain event |
| Lead merge | Merge leads -> verify `socialHandles` rebuilt + customer synced + domain event |
| User deactivation | Deactivate closer with active opps -> blocked; reassign -> retry -> soft-deleted |
| Tenant deletion | Delete test tenant -> all 19 tables cleaned |
| Dashboard perf | Compare load time before/after; target <500ms |
| OAuth isolation | Token refresh -> `tenants` NOT modified; `tenantCalendlyConnections` updated |

### Browser verification (Expect skill)

After each frontend change:
- [ ] Accessibility audit (axe-core)
- [ ] Performance metrics (LCP, CLS, INP)
- [ ] Console error check
- [ ] 4 viewport responsive test
- [ ] Data seeding: minimum 3 records per entity

---

## 17. Risk Matrix

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Booking answer backfill misses events past 30-day retention | Medium | High | Run backfill in Phase 2 BEFORE any cleanup cron fires; prioritize item 2.12 |
| Summary table drift (counters out of sync) | Low | Medium | Periodic full-recount comparison script |
| `amountMinor` rounding differs from `amount` | Low | Low | Accept <=1 cent variance; document `Math.round(amount * 100)` |
| User soft-delete breaks team management UI | Low | Medium | Pre-flight check prevents deactivation with active assignments |
| Too many indexes slow writes | Very Low | Low | 24 new indexes across 15 tables; well within Convex limits |
| Widen-migrate-narrow fails mid-way | Low | Medium | Small dataset allows fresh start |
| Domain event dual-write adds latency | Very Low | Low | Single insert per event; <5ms overhead |
| OAuth extraction breaks token refresh | Low | High | Dual-read during transition; health check validates after switch |
| OAuth migration leaves stale references | Low | Medium | Grep all `tenant.calendly*` accesses; automated verification |

---

## 18. Skills & Resources

### Required skills by phase

| Phase | Primary Skill | Secondary |
| --- | --- | --- |
| Phase 1 (Schema) | `convex-migration-helper` | -- |
| Phase 2 (Backfill) | `convex-migration-helper` | -- |
| Phase 3 (Mutations) | Convex guidelines (`convex/_generated/ai/guidelines.md`) | Form patterns (AGENTS.md) |
| Phase 4 (Queries) | `convex-performance-audit` | Convex guidelines |
| Phase 5 (OAuth) | `convex-migration-helper` | Calendly docs (`.docs/calendly/index.md`) |
| Phase 6 (Narrow) | `convex-migration-helper` | -- |
| Phase 7 (Frontend) | `expect` (browser verification) | `shadcn`, `frontend-design` |

### Documentation references

| Area | Document |
| --- | --- |
| Audit findings (v1) | `.docs/audits/definite-database-audit-reportv1.md` |
| Audit findings (v2) | `.docs/audits/definite-database-audit-reportv2.md` |
| Convex guidelines | `convex/_generated/ai/guidelines.md` |
| Convex best practices | `.docs/best-practices/convex-db-best-practices.md` |
| Convex + Next.js | `.docs/convex/nextjs.md`, `.docs/convex/module-nextjs.md` |
| Calendly integration | `.docs/calendly/index.md` |
| Status transitions | `convex/lib/statusTransitions.ts` |
| RBAC permissions | `convex/lib/permissions.ts` |
| Auth chain | `lib/auth.ts` |

### Key constraints

1. **30-day webhook retention**: `meetingFormResponses` backfill must run before `convex/webhooks/cleanup.ts` deletes old events.
2. **Convex transaction limits**: `.collect()` safe for ~700 records; would need batching at scale.
3. **Schema push validation**: Convex rejects deploys where existing docs don't match validators. All backfills MUST complete before Phase 6.
4. **Index build time**: Negligible at ~700 records (<1 second).

---

## 19. Success Criteria

v0.5b is complete when ALL of the following are true:

- [ ] **Event history**: All status transitions logged to `domainEvents` with actor, timestamp, and metadata. Can reconstruct "what happened over time" for any entity.
- [ ] **Custom fields**: `leads.customFields` type-safe (`v.record(v.string(), v.string())`). Per-meeting answers captured in `meetingFormResponses` with full provenance. `eventTypeFieldCatalog` tracks stable field keys.
- [ ] **Money model**: Revenue uses `amountMinor` (integer cents). `paymentRecords.amount` removed. Currency validated. No float accumulation errors.
- [ ] **Query performance**: Admin dashboard reads 1 doc instead of 4 scans. Closer queries use `meetings.assignedCloserId` index. Hot queries show >=50% reduction in bytes read.
- [ ] **Lead status**: Required. No `undefined`. Index-based filtering without JS fallbacks.
- [ ] **Data integrity**: Users soft-deleted. Tenant deletion cascades 19 tables. No orphaned references.
- [ ] **Analytics indexes**: 24 new indexes covering relationship, time, status, owner, and event type dimensions.
- [ ] **OAuth isolation**: Tokens in `tenantCalendlyConnections`. Token refresh no longer invalidates `tenants` queries. ~16 fewer invalidations/day.
- [ ] **Polymorphism resolved**: `paymentRecords.contextType` required. `followUps.type` required. Clean discriminants for reporting.
- [ ] **Denormalization health**: Customer snapshot syncs with lead changes. `socialHandles` rebuilds on all identifier mutations. `meetings.leadName` syncs.
- [ ] **No breaking changes**: All features work unchanged after each phase.
- [ ] **Backfills complete**: All scripts run. Booking answers backfilled before retention window. OAuth state migrated.

---

## Key File Reference

| Purpose | File | Lines of interest |
| --- | --- | --- |
| Schema (all tables) | `convex/schema.ts` | Full file (521 lines) |
| Pipeline main handler | `convex/pipeline/inviteeCreated.ts` | 1493 lines; customFields: 30-66, 952; meeting inserts: ~1104, ~1305, ~1436 |
| Pipeline cancellation | `convex/pipeline/inviteeCanceled.ts` | 141 lines |
| Pipeline no-show | `convex/pipeline/inviteeNoShow.ts` | 195 lines |
| Webhook dedupe | `convex/webhooks/calendlyMutations.ts` | 50 lines; scan: 15-29 |
| State machines | `convex/lib/statusTransitions.ts` | 78 lines |
| Meeting refs | `convex/lib/opportunityMeetingRefs.ts` | Full file |
| Admin dashboard | `convex/dashboard/adminStats.ts` | 113 lines; 4 scans: 37-88 |
| Customer queries | `convex/customers/queries.ts` | 217 lines |
| Closer dashboard | `convex/closer/dashboard.ts` | 147 lines |
| Closer calendar | `convex/closer/calendar.ts` | 85 lines |
| Closer pipeline | `convex/closer/pipeline.ts` | 70 lines |
| Payment logging | `convex/closer/payments.ts` | 178 lines |
| Customer conversion | `convex/customers/conversion.ts` | Full file |
| User removal | `convex/workos/userMutations.ts` | removeUser: 428-458 |
| Tenant deletion | `convex/admin/tenantsMutations.ts` | 65-128 |
| Redistribution | `convex/unavailability/shared.ts` | 95-262 |
| Lead queries | `convex/leads/queries.ts` | 449 lines |
| Calendly tokens | `convex/calendly/tokens.ts` | Full file (OAuth) |
| Health check | `convex/calendly/healthCheck.ts` | Full file |
| Webhook cleanup | `convex/webhooks/cleanup.ts` | 30-day retention |
| Cron jobs | `convex/crons.ts` | 5 jobs including 90-min token refresh |
