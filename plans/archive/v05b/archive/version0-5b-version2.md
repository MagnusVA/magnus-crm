# v0.5b — Definitive Database Audit Operationalization

> **Specification document.** Evidence-based implementation plan derived from the [Definitive Database Audit Report v2](/.docs/audits/definite-database-audit-reportv2.md) (22 findings, 5 independent audits consolidated on 2026-04-12).

| Field | Value |
| --- | --- |
| **Status** | Draft |
| **Created** | 2026-04-12 |
| **Data footprint** | 1 tenant, 213 meetings, 213 opportunities, 288 raw webhook events |
| **Migration risk** | Low — single test tenant, fresh start acceptable |
| **Target** | Production-ready data model with analytics foundations |

---

## Table of Contents

1. [Scope & Goals](#1-scope--goals)
2. [Architecture Decisions](#2-architecture-decisions)
3. [Change Inventory](#3-change-inventory)
4. [Codebase Impact Analysis](#4-codebase-impact-analysis)
5. [Phase Plan](#5-phase-plan)
6. [Schema Changes Reference](#6-schema-changes-reference)
7. [Index Changes Reference](#7-index-changes-reference)
8. [Frontend Changes Reference](#8-frontend-changes-reference)
9. [Migration Scripts](#9-migration-scripts)
10. [Testing Checklist](#10-testing-checklist)
11. [Skills & Resources](#11-skills--resources)

---

## 1. Scope & Goals

### What this version delivers

1. **Analytics-ready data model** — append-only domain events, lifecycle timestamps, actor attribution
2. **Correctness fixes** — pagination bugs, post-filter issues, broken uniqueness invariants
3. **Performance fixes** — eliminate full-table scans, N+1 patterns, O(n×m) joins
4. **Data integrity** — user soft-delete, complete tenant offboarding cascade, referential soundness
5. **Financial safety** — integer minor-unit amounts, currency validation, per-currency aggregation
6. **Reporting foundations** — summary documents, denormalized dimensions, composite indexes

### What this version does NOT deliver

- Reporting UI / analytics dashboards (v0.6 scope)
- Warehouse export / OLAP pipeline (deferred)
- Tenant table split (extract OAuth state — deferred, Finding 14)
- Full `contacts`/`parties` model (deferred, Finding 21)

### Guiding principles

1. **Widen-migrate-narrow** for every schema change touching existing documents
2. **Zero downtime** — no deployment that breaks the running pipeline
3. **Dual-write during transition** — old and new fields coexist until backfill completes
4. **Facts before features** — get the data model right, then build UIs on top

---

## 2. Architecture Decisions

### AD-1: Single `domainEvents` table (not per-entity tables)

**Finding**: 1 (all 5 audits)

A single append-only `domainEvents` table with `entityType` + `eventType` discriminators. Avoids table proliferation while giving full flexibility via composite indexes. See [Appendix A of audit report](/.docs/audits/definite-database-audit-reportv2.md) for the full schema.

**Rejected alternatives**:
- Multiple entity-specific event tables (GPT1/GPT2) — complexity without benefit at this scale
- Narrow `statusChanges` table (Opus1) — misses non-status events (payment, conversion, invitation)

### AD-2: Integer minor units for money (not floating-point)

**Finding**: 3

All payment amounts stored as `amountMinor: v.number()` representing integer cents (or centavos, etc.). Display conversion (`amountMinor / 100`) happens at the UI boundary. A shared `formatAmountMinor()` utility centralizes formatting.

**Note on `v.int64()`**: Convex supports `v.int64()` but it requires BigInt handling throughout the stack. For the current scale (sub-$1M per tenant), `v.number()` with integer validation (`Number.isInteger()`, `> 0`) is sufficient. Re-evaluate if revenue crosses $9 quadrillion (IEEE 754 safe integer limit).

### AD-3: User soft-delete (not hard-delete)

**Finding**: 8

Users are never physically deleted. `deletedAt` timestamp + `isActive` boolean flag. Historical references remain valid. All operational queries filter by `isActive !== false`. The `requireTenantUser` auth guard rejects soft-deleted users.

### AD-4: `tenantStats` summary document (not reactive full-table scans)

**Finding**: 4

A single `tenantStats` document per tenant, maintained atomically by the mutations that change source data. The admin dashboard reads one document instead of scanning four tables. See [Appendix B of audit report](/.docs/audits/definite-database-audit-reportv2.md).

### AD-5: `meetings.assignedCloserId` denormalization

**Finding**: 12

A direct closer dimension on meetings eliminates the O(n×m) join pattern across closer dashboard, calendar, and redistribution queries. Maintained as a projection of `opportunities.assignedCloserId`.

### AD-6: Fresh-start migration strategy

Given: 1 test tenant, ~700 total records, no production users. All widen-migrate-narrow sequences can be executed as one-shot backfill scripts rather than incremental rolling migrations. We can also wipe and re-seed if a clean break is simpler for any specific change.

---

## 3. Change Inventory

Each change maps to one or more audit findings. Grouped by implementation phase.

### Phase 1: Schema Widen + New Tables (no breaking changes)

| # | Change | Findings | Type |
| --- | --- | --- | --- |
| 1.1 | Add `domainEvents` table | 1 | New table |
| 1.2 | Add `tenantStats` table | 4 | New table |
| 1.3 | Add `meetingFormResponses` table | 2 | New table |
| 1.4 | Add `eventTypeFieldCatalog` table | 2 | New table |
| 1.5 | Add `users.deletedAt`, `users.isActive` (optional) | 8 | Schema widen |
| 1.6 | Add `meetings.assignedCloserId` (optional) | 12 | Schema widen |
| 1.7 | Add `paymentRecords.amountMinor` (optional) | 3 | Schema widen |
| 1.8 | Add `customers.totalPaidMinor`, `customers.totalPaymentCount`, `customers.paymentCurrency` (optional) | 4 | Schema widen |
| 1.9 | Add lifecycle timestamps on `opportunities` (`lostAt`, `canceledAt`, `noShowAt`, `paymentReceivedAt`) | 16 | Schema widen |
| 1.10 | Add lifecycle timestamps on `meetings` (`completedAt`, `canceledAt`) | 16 | Schema widen |
| 1.11 | Add lifecycle timestamps on `paymentRecords` (`verifiedAt`), `customers` (`churnedAt`, `pausedAt`), `followUps` (`bookedAt`) | 16 | Schema widen |
| 1.12 | Add attribution fields: `opportunities.lostByUserId`, `meetings.noShowMarkedByUserId`, `paymentRecords.verifiedByUserId` | 17 | Schema widen |
| 1.13 | Add `paymentRecords.contextType` discriminant (optional) | 18 | Schema widen |
| 1.14 | Add all 8 correctness indexes | 5, 10, 11 | Index addition |
| 1.15 | Add all 14 analytics indexes | 13 | Index addition |
| 1.16 | Add `followUps.type` as required (currently already defined) | 18 | Validation |

### Phase 2: Backfill + Data Cleanup

| # | Change | Findings | Type |
| --- | --- | --- | --- |
| 2.1 | Backfill `leads.status`: set all `undefined` → `"active"` | 6 | Data migration |
| 2.2 | Backfill `users.isActive`: set all existing → `true` | 8 | Data migration |
| 2.3 | Backfill `meetings.assignedCloserId` from parent opportunity | 12 | Data migration |
| 2.4 | Backfill `paymentRecords.amountMinor` = `Math.round(amount * 100)` | 3 | Data migration |
| 2.5 | Backfill `customers.totalPaidMinor` from payment records | 4 | Data migration |
| 2.6 | Backfill `paymentRecords.contextType` from existing FK presence | 18 | Data migration |
| 2.7 | Seed `tenantStats` document from current counts | 4 | Data migration |
| 2.8 | Deduplicate `eventTypeConfigs` by `(tenantId, calendlyEventTypeUri)` | 9 | Data cleanup |
| 2.9 | Audit for orphaned tenant-scoped rows from prior deletions | 7 | Data cleanup |
| 2.10 | Audit for orphaned user references from prior `removeUser` calls | 8 | Data cleanup |
| 2.11 | Audit payment currencies per tenant | 3 | Data audit |
| 2.12 | Backfill `meetingFormResponses` from retained `rawWebhookEvents` | 2 | Data migration (time-critical — 30-day webhook retention window) |

### Phase 3: Code Changes — Backend Mutations

| # | Change | Findings | Type |
| --- | --- | --- | --- |
| 3.1 | Emit domain events from all status-changing mutations (12 callsites) | 1 | Mutation enhancement |
| 3.2 | Set lifecycle timestamps in all status-changing mutations | 16 | Mutation enhancement |
| 3.3 | Set user attribution in closer-initiated mutations | 17 | Mutation enhancement |
| 3.4 | Replace user hard-delete with soft-delete in `removeUser` | 8 | Mutation rewrite |
| 3.5 | Expand `deleteTenantRuntimeDataBatch` to cascade all 14 tables | 7 | Mutation rewrite |
| 3.6 | Update `logPayment` to write `amountMinor`, validate integer + currency | 3 | Mutation enhancement |
| 3.7 | Update `logPayment` to maintain `customers.totalPaidMinor` | 4 | Mutation enhancement |
| 3.8 | Update `recordCustomerPayment` to write `amountMinor`, maintain totals | 3, 4 | Mutation enhancement |
| 3.9 | Set `meetings.assignedCloserId` in all 4 meeting insert sites in `inviteeCreated.ts` | 12 | Mutation enhancement |
| 3.10 | Update `meetings.assignedCloserId` when opportunity is reassigned | 12 | Mutation enhancement |
| 3.11 | Write `meetingFormResponses` in pipeline `inviteeCreated.ts` alongside meeting creation | 2 | Mutation enhancement |
| 3.12 | Add `syncCustomerSnapshot` helper; call from `syncLeadFromBooking` and lead mutations | 15 | New mutation |
| 3.13 | Maintain `tenantStats` counters atomically from all relevant mutations | 4 | Mutation enhancement |
| 3.14 | Fix webhook dedup: use compound index instead of scan-then-compare | 9 | Mutation fix |
| 3.15 | Harden `leads.customFields` from `v.any()` to `v.optional(v.record(v.string(), v.string()))` | 2 | Validation tightening |
| 3.16 | Update `mergeCustomFields()` and `syncLeadFromBooking()` for typed customFields | 2 | Code update |
| 3.17 | Add `isActive` check to `requireTenantUser` auth guard | 8 | Auth enhancement |

### Phase 4: Code Changes — Backend Queries

| # | Change | Findings | Type |
| --- | --- | --- | --- |
| 4.1 | Rewrite `getAdminDashboardStats` to read from `tenantStats` (keep `meetingsToday` live) | 4 | Query rewrite |
| 4.2 | Rewrite `getNextMeeting` to use `by_tenantId_and_assignedCloserId_and_status` | 5 | Query optimization |
| 4.3 | Rewrite `getPipelineSummary` to use compound closer+status index | 5 | Query optimization |
| 4.4 | Rewrite `listMyOpportunities` to use compound closer+status index + pagination | 5 | Query optimization |
| 4.5 | Rewrite `getMeetingsForRange` to use `meetings.by_tenantId_and_assignedCloserId_and_scheduledAt` | 5, 12 | Query optimization |
| 4.6 | Rewrite `listLeads` to use `by_tenantId_and_status` directly (no post-paginate filter) | 6, 10 | Query correctness fix |
| 4.7 | Rewrite `searchLeads` to pass `status` directly to search index filter | 6, 10 | Query correctness fix |
| 4.8 | Rewrite `listCustomers` for closers to use `by_tenantId_and_convertedByUserId` | 10 | Query correctness fix |
| 4.9 | Rewrite `listCustomers` payment aggregation to read `totalPaidMinor` from customer doc | 4 | Query optimization |
| 4.10 | Rewrite `getActiveReminders` to use compound type+status index (no post-take filter) | 10 | Query correctness fix |
| 4.11 | Rewrite `getLeadDetail` follow-ups to use `followUps.by_tenantId_and_leadId` index | 11 | Query optimization |
| 4.12 | Rewrite `getEventTypeConfigsWithStats` to use `by_tenantId_and_eventTypeConfigId` or summary counts | 4 | Query optimization |
| 4.13 | Add `.take()` bounds to `listOpportunitiesForAdmin` and batch enrichment | 4, 19 | Query safety |
| 4.14 | Filter soft-deleted users from `listTeamMembers` and all user queries | 8 | Query update |
| 4.15 | Update all payment read queries to use `amountMinor` | 3 | Query update |
| 4.16 | Rewrite `unavailability/shared.ts` closer schedule queries to use compound index | 5 | Query optimization |
| 4.17 | Remove `isActiveLikeLeadStatus` helpers and `?? "active"` fallbacks | 6 | Code cleanup |

### Phase 5: Schema Narrow

| # | Change | Findings | Type |
| --- | --- | --- | --- |
| 5.1 | Make `leads.status` required: remove `v.optional()` wrapper | 6 | Schema narrow |
| 5.2 | Remove `paymentRecords.amount` (replaced by `amountMinor`) | 3 | Schema narrow |
| 5.3 | Make `users.isActive` required (optional: could leave as optional with `undefined === true` semantics) | 8 | Schema narrow |
| 5.4 | Make `meetings.assignedCloserId` required (optional: could leave as optional for edge cases) | 12 | Schema narrow |

### Phase 6: Frontend Updates

| # | Change | Findings | Type |
| --- | --- | --- | --- |
| 6.1 | Create shared `lib/format-currency.ts` utility for cents-to-display | 3 | New utility |
| 6.2 | Update payment form dialogs to send `amountMinor` (cents) | 3 | Form behavior |
| 6.3 | Update all payment display components to use `amountMinor / 100` | 3 | Display |
| 6.4 | Update team management UI for soft-delete (deactivate dialog, visual indicators) | 8 | UI behavior |
| 6.5 | Remove `?? "active"` fallbacks from lead display components | 6 | Code cleanup |
| 6.6 | Update customer list/detail to read `totalPaidMinor` instead of aggregating | 4 | Display |

---

## 4. Codebase Impact Analysis

### 4.1 Pipeline Files (highest impact)

#### `convex/pipeline/inviteeCreated.ts` (~1493 lines) — **~20 touch points**

This is the single most impacted file. It handles lead creation/resolution, opportunity creation, and meeting insertion across 5 distinct code paths (UTM linking, heuristic reschedule, follow-up reuse, new opportunity, new lead creation).

| Change | Functions affected | Lines |
| --- | --- | --- |
| Domain events | `process` (5 code paths: UTM link ~1029-1043, heuristic reschedule ~1272-1284, follow-up reuse ~1385-1400, new opportunity ~1413-1431, new lead ~515-524) | 8+ insertion points |
| `customFields` type | `extractQuestionsAndAnswers`, `mergeCustomFields`, `syncLeadFromBooking`, `process` | 30-66, 237-268, 952, 1191-1194 |
| `meetings.assignedCloserId` | All 4 meeting insert sites in `process` | ~1104, ~1305, ~1436 (value already computed in local `assignedCloserId` variable) |
| `meetingFormResponses` | All meeting insert sites need parallel `meetingFormResponses` insert | Same 4 sites |
| `leads.status` | `resolveLeadIdentity` (already sets `"active"`), `detectPotentialDuplicate`, `followMergeChain` | Safe after backfill |
| Lifecycle timestamps | Meeting inserts need `createdAt` (already present); lead creation already sets `firstSeenAt` | Minimal |

#### `convex/pipeline/inviteeCanceled.ts` (~141 lines) — **3 touch points**

| Change | Functions affected | Lines |
| --- | --- | --- |
| Domain events | `process`: meeting→canceled (~85), opportunity→canceled (~123-128) | 2 emission points |
| Lifecycle timestamps | Add `canceledAt` to both meeting and opportunity patches | ~85, ~123 |

#### `convex/pipeline/inviteeNoShow.ts` (~195 lines) — **6 touch points**

| Change | Functions affected | Lines |
| --- | --- | --- |
| Domain events | `process`: meeting→no_show (~80-84), opportunity→no_show (~101-104); `revert`: meeting→scheduled (~167), opportunity→scheduled (~176-179) | 4 emission points |
| Lifecycle timestamps | `noShowMarkedAt` already set on meetings; add to opportunity patch | ~101, ~176 |

#### `convex/webhooks/calendlyMutations.ts` (~50 lines) — **1 critical fix**

| Change | Functions affected | Lines |
| --- | --- | --- |
| Webhook dedup | `persistRawEvent`: replace scan-then-compare loop with compound index `.first()` | 15-29 → single indexed lookup |

**Current broken pattern:**
```typescript
// Scans ALL events for tenant+type, compares URI in JS — O(n)
for await (const existing of existingEvents) {
  if (existing.calendlyEventUri === args.calendlyEventUri) { ... }
}
```
**Fixed pattern:**
```typescript
// Direct compound index lookup — O(1)
const existing = await ctx.db.query("rawWebhookEvents")
  .withIndex("by_tenantId_and_eventType_and_calendlyEventUri", q =>
    q.eq("tenantId", args.tenantId)
     .eq("eventType", args.eventType)
     .eq("calendlyEventUri", args.calendlyEventUri))
  .first();
```

### 4.2 Closer Queries (performance-critical)

#### `convex/closer/dashboard.ts` — `getNextMeeting`, `getPipelineSummary`

**Current anti-pattern**: `.collect()` all closer opportunities → filter by status in JS → scan tenant meetings → filter by ownership.

**Fix**: Use `by_tenantId_and_assignedCloserId_and_status` index on opportunities. Later, use `meetings.by_tenantId_and_assignedCloserId_and_scheduledAt` to eliminate the O(n×m) meeting join.

**UI consumers** (no shape change needed):
- `app/workspace/closer/_components/closer-dashboard-page-client.tsx`
- `app/workspace/closer/_components/featured-meeting-section.tsx`
- `app/workspace/closer/_components/pipeline-strip-section.tsx`

#### `convex/closer/pipeline.ts` — `listMyOpportunities`

**Current anti-pattern**: `.collect()` all closer opportunities → filter → sort → N+1 enrich.

**Fix**: Compound index query → paginate → batch enrichment.

#### `convex/closer/calendar.ts` — `getMeetingsForRange`

**Current anti-pattern**: Collect all closer opportunities → build oppId Set → scan meetings in range → filter by Set membership.

**Fix**: With `meetings.assignedCloserId`, query meetings directly by closer + date range.

#### `convex/closer/followUpQueries.ts` — `getActiveReminders`

**Current bug**: `.take(50)` then `.filter(type === "manual_reminder")` — pages can be short.

**Fix**: Compound index `by_tenantId_and_closerId_and_status_and_type` or `by_tenantId_and_closerId_and_type_and_status_and_reminderScheduledAt`.

### 4.3 Dashboard & Aggregation Queries

#### `convex/dashboard/adminStats.ts` — `getAdminDashboardStats`

**Current**: 4 full-table scans (users, opportunities, meetings, paymentRecords) per render.

**Fix**: Read from `tenantStats` document for team/pipeline/revenue counts. Keep `meetingsToday` as a live range query (already efficiently indexed).

**Return shape must be preserved**:
```
{ totalTeamMembers, totalClosers, unmatchedClosers, totalOpportunities,
  activeOpportunities, meetingsToday, wonDeals, revenueLogged, totalRevenue,
  paymentRecordsLogged }
```

#### `convex/customers/queries.ts` — `listCustomers`, `getCustomerDetail`, `getCustomerTotalPaid`

**Current anti-patterns**:
- `listCustomers` post-paginate filters by closer (breaks page sizes)
- Per-customer `.collect()` all payments to compute totals (N+1 × unbounded)

**Fix**: `by_tenantId_and_convertedByUserId` for closer pagination. `totalPaidMinor` denormalized on customer doc. `getCustomerTotalPaid` becomes dead code.

#### `convex/leads/queries.ts` — `listLeads`, `searchLeads`, `getLeadDetail`

**Current anti-patterns**:
- `listLeads` bifurcated query (status optional) → post-paginate filter removes merged leads
- `searchLeads` over-fetches 40, filters, truncates to 20
- `getLeadDetail` scans 200 tenant follow-ups, filters by leadId

**Fix**: Make `leads.status` required → unified `by_tenantId_and_status` query. Add `followUps.by_tenantId_and_leadId` index.

### 4.4 Admin & Tenant Mutations

#### `convex/admin/tenantsMutations.ts` — `deleteTenantRuntimeDataBatch`

**Current**: Only cascades to 3 tables (`rawWebhookEvents`, `calendlyOrgMembers`, `users`).

**Fix**: Expand to all 14 tenant-scoped tables. Delete in reverse-dependency order within each batch:
1. `paymentRecords` (has `proofFileId` → also delete `_storage` files)
2. `meetingFormResponses` (new table)
3. `followUps`
4. `meetingReassignments`
5. `closerUnavailability`
6. `meetings`
7. `opportunities`
8. `customers`
9. `leadMergeHistory`
10. `leadIdentifiers`
11. `leads`
12. `eventTypeConfigs`
13. `domainEvents` (new table)
14. `tenantStats` (new table)
15. `rawWebhookEvents` (existing)
16. `calendlyOrgMembers` (existing)
17. `users` (existing — last, since other tables reference users)

#### `convex/workos/userMutations.ts` — `removeUser`

**Current**: `ctx.db.delete(userId)` at line 457.

**Fix**: Replace with `ctx.db.patch(userId, { deletedAt: Date.now(), isActive: false })`. Add `isActive: true` to all user creation paths (`createUserWithCalendlyLink`, `createInvitedUser`).

**Cascading requirement**: Before deactivation, check for active assignments:
- Active opportunities assigned to this closer
- Pending follow-ups owned by this closer
- Future scheduled meetings

If any exist, either require reassignment first or provide a force-deactivate option.

### 4.5 Status-Changing Mutations (Domain Event Emission Points)

Complete inventory of every function that patches `status` on opportunities or meetings:

| File | Function | Entity | Transition |
| --- | --- | --- | --- |
| `closer/meetingActions.ts` | `startMeeting` | opportunity + meeting | → in_progress |
| `closer/meetingActions.ts` | `markAsLost` | opportunity | in_progress → lost |
| `closer/noShowActions.ts` | `markNoShow` | opportunity + meeting | → no_show |
| `closer/noShowActions.ts` | `createNoShowRescheduleLink` | opportunity | no_show → reschedule_link_sent |
| `closer/followUpMutations.ts` | `transitionToFollowUp` | opportunity | → follow_up_scheduled |
| `closer/followUpMutations.ts` | `confirmFollowUpScheduled` | opportunity | → follow_up_scheduled |
| `closer/followUpMutations.ts` | `createManualReminderFollowUpPublic` | opportunity | → follow_up_scheduled |
| `closer/payments.ts` | `logPayment` | opportunity | in_progress → payment_received |
| `pipeline/inviteeCreated.ts` | `process` | opportunity + meeting | 5 code paths → scheduled |
| `pipeline/inviteeCanceled.ts` | `process` | opportunity + meeting | → canceled |
| `pipeline/inviteeNoShow.ts` | `process` | opportunity + meeting | → no_show |
| `pipeline/inviteeNoShow.ts` | `revert` | opportunity + meeting | no_show → scheduled |

**Total**: 12 mutation functions, ~20 individual status change sites.

Each needs a `ctx.db.insert("domainEvents", { ... })` call alongside the status patch.

### 4.6 `tenantStats` Maintenance Points

Every mutation that changes a stat must atomically update the summary document:

| Stat field | Updated by |
| --- | --- |
| `totalTeamMembers`, `totalClosers` | User create, user soft-delete |
| `totalOpportunities`, `activeOpportunities` | Opportunity create, status change |
| `wonDeals` | `logPayment` (→ payment_received) |
| `lostDeals` | `markAsLost` (→ lost) |
| `totalRevenueRecorded`, `totalPaymentRecords` | `logPayment`, `recordCustomerPayment` |
| `totalLeads` | Lead create (pipeline), lead merge |
| `totalCustomers` | Customer conversion |

**Helper function**: `updateTenantStats(ctx, tenantId, delta)` — accepts a partial delta object and atomically patches the summary document.

---

## 5. Phase Plan

### Phase 1: Schema Widen + New Tables

**Goal**: Deploy all schema additions without breaking existing code. No behavioral changes.

**Estimated effort**: Small-Medium

**Steps**:
1. Add 4 new tables to `convex/schema.ts`: `domainEvents`, `tenantStats`, `meetingFormResponses`, `eventTypeFieldCatalog`
2. Add all optional fields to existing tables (see [Section 6](#6-schema-changes-reference))
3. Add all 22 new indexes (see [Section 7](#7-index-changes-reference))
4. Deploy — Convex builds indexes before running new code

**Breaking change risk**: Zero. All additions are optional fields and new tables.

**Skill**: `convex-migration-helper` (for schema change review)

### Phase 2: Backfill + Data Cleanup

**Goal**: Fill all new fields with correct data. Clean up duplicates and orphans.

**Estimated effort**: Medium

**Steps**:
1. Write and run backfill scripts (see [Section 9](#9-migration-scripts)):
   - `leads.status` undefined → `"active"` (all leads)
   - `users.isActive` → `true` (all users)
   - `meetings.assignedCloserId` from parent opportunity
   - `paymentRecords.amountMinor` = `Math.round(amount * 100)`
   - `customers.totalPaidMinor` = sum of linked payment `amountMinor` values
   - `paymentRecords.contextType` from FK presence
2. Seed `tenantStats` document
3. Deduplicate `eventTypeConfigs`
4. Backfill `meetingFormResponses` from retained `rawWebhookEvents` (time-critical — 30-day window)
5. Run orphan audits (tenant data, user references)

**Breaking change risk**: Zero. Only writes to new/optional fields. Reads unchanged.

**Skill**: `convex-migration-helper` (for backfill script patterns)

### Phase 3: Backend Mutation Updates

**Goal**: All write paths populate new fields. Domain events emitted. Integrity enforced.

**Estimated effort**: Large (heaviest phase — 12+ mutation files)

**Steps**:
1. Create `convex/lib/domainEvents.ts` helper:
   ```typescript
   export async function emitDomainEvent(ctx, event) {
     await ctx.db.insert("domainEvents", { ...event, occurredAt: Date.now() });
   }
   ```
2. Create `convex/lib/tenantStatsHelper.ts`:
   ```typescript
   export async function updateTenantStats(ctx, tenantId, delta) {
     const stats = await ctx.db.query("tenantStats")
       .withIndex("by_tenantId", q => q.eq("tenantId", tenantId)).unique();
     if (stats) {
       await ctx.db.patch(stats._id, { ...delta, lastUpdatedAt: Date.now() });
     }
   }
   ```
3. Update all 12 status-changing mutation functions to:
   - Emit domain events
   - Set lifecycle timestamps
   - Set user attribution (where actor is available)
   - Update `tenantStats` counters
4. Update `removeUser` → soft-delete with `isActive` check
5. Update `logPayment` and `recordCustomerPayment` for `amountMinor` + customer totals
6. Update `inviteeCreated.ts`: set `assignedCloserId` on all 4 meeting inserts, write `meetingFormResponses`
7. Expand `deleteTenantRuntimeDataBatch` cascade
8. Fix webhook dedup in `calendlyMutations.ts`
9. Add `syncCustomerSnapshot` helper
10. Harden `leads.customFields` type
11. Add `isActive: true` to user creation paths
12. Add `isActive` check to `requireTenantUser`

**Breaking change risk**: Low if done correctly. Key risk: `requireTenantUser` rejecting soft-deleted users before any users are actually soft-deleted (safe — all existing users have `isActive: true` from backfill).

**Ordering constraint**: Phase 2 (backfill) MUST complete before this phase deploys. Especially:
- `leads.status` backfill before any code that assumes it's always defined
- `users.isActive` backfill before `requireTenantUser` starts checking it
- `meetings.assignedCloserId` backfill before queries start reading it

### Phase 4: Backend Query Rewrites

**Goal**: All read paths use new indexes and denormalized fields. Correctness bugs fixed.

**Estimated effort**: Medium-Large (15+ query functions)

**Steps**:
1. Rewrite closer dashboard/pipeline/calendar queries to use compound indexes
2. Rewrite `getAdminDashboardStats` to read from `tenantStats`
3. Fix pagination bugs in `listLeads`, `searchLeads`, `listCustomers`, `getActiveReminders`
4. Update `getLeadDetail` to use `followUps.by_tenantId_and_leadId`
5. Add `.take()` bounds to unbounded queries
6. Batch N+1 enrichment patterns
7. Update payment read queries to use `amountMinor`
8. Filter soft-deleted users in all operational queries
9. Remove `isActiveLikeLeadStatus` helpers and `?? "active"` fallbacks

**Breaking change risk**: Low for most changes (same return shapes). The pagination fixes in `listLeads` and `listCustomers` may return different page sizes — this is a correctness improvement but could surprise the UI if it was compensating for the bug.

### Phase 5: Schema Narrow

**Goal**: Tighten schema validators now that all data is backfilled and code is updated.

**Estimated effort**: Small

**Steps**:
1. Make `leads.status` required (remove `v.optional()`)
2. Remove `paymentRecords.amount` (all reads use `amountMinor`)
3. Optionally make `users.isActive` required
4. Optionally make `meetings.assignedCloserId` required

**Breaking change risk**: Zero if all backfills completed and all code updated. Convex validates schema against existing data on deploy — it will reject if any document doesn't match.

**Validation**: Before narrowing, run a count query to verify zero documents have the old shape:
```typescript
// Verify no leads have undefined status
const unmigratedLeads = await ctx.db.query("leads")
  .filter(q => q.eq(q.field("status"), undefined)).take(1);
assert(unmigratedLeads.length === 0);
```

### Phase 6: Frontend Updates

**Goal**: UI reflects new data model. Payment displays use cents. Soft-deleted users handled.

**Estimated effort**: Medium

**Steps**:
1. Create `lib/format-currency.ts`:
   ```typescript
   export function formatAmountMinor(amountMinor: number, currency: string): string {
     return new Intl.NumberFormat("en-US", {
       style: "currency",
       currency: currency.toUpperCase(),
     }).format(amountMinor / 100);
   }
   ```
2. Update payment form dialogs: convert `parseFloat(amount) * 100` → `amountMinor`
   - `app/workspace/closer/meetings/_components/payment-form-dialog.tsx`
   - `app/workspace/customers/[customerId]/_components/record-payment-dialog.tsx`
3. Update payment display components:
   - `app/workspace/customers/[customerId]/_components/payment-history-table.tsx`
   - `app/workspace/closer/meetings/_components/deal-won-card.tsx`
   - `app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx`
   - `app/workspace/customers/_components/customers-table.tsx`
4. Update team management for soft-delete:
   - `app/workspace/team/_components/team-members-table.tsx` — add deactivated visual indicator
   - `app/workspace/team/_components/remove-user-dialog.tsx` — rename to "Deactivate", update copy
5. Remove `?? "active"` fallbacks:
   - `app/workspace/leads/[leadId]/_components/lead-detail-page-client.tsx`
   - `app/workspace/leads/_components/leads-table.tsx`
6. Update customer displays for `totalPaidMinor`:
   - `app/workspace/customers/_components/customers-table.tsx`
   - `app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx`

**Skill**: `expect` (browser verification after each UI change)

---

## 6. Schema Changes Reference

### New tables

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
  metadata: v.optional(v.string()),
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

// Finding 2: Per-meeting booking answers
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
```

### Modified tables — new optional fields

```typescript
// users (Finding 8: soft-delete)
users: {
  // ... existing fields ...
  deletedAt: v.optional(v.number()),
  isActive: v.optional(v.boolean()),  // Treat undefined as true during migration
}

// meetings (Finding 12: closer dimension; Finding 16: timestamps; Finding 17: attribution)
meetings: {
  // ... existing fields ...
  assignedCloserId: v.optional(v.id("users")),
  completedAt: v.optional(v.number()),
  canceledAt: v.optional(v.number()),
  noShowMarkedByUserId: v.optional(v.id("users")),
}

// opportunities (Finding 16: timestamps; Finding 17: attribution)
opportunities: {
  // ... existing fields ...
  lostAt: v.optional(v.number()),
  canceledAt: v.optional(v.number()),
  noShowAt: v.optional(v.number()),
  paymentReceivedAt: v.optional(v.number()),
  lostByUserId: v.optional(v.id("users")),
}

// paymentRecords (Finding 3: money model; Finding 17: attribution; Finding 18: discriminant)
paymentRecords: {
  // ... existing fields ...
  amountMinor: v.optional(v.number()),  // Integer cents, replaces `amount`
  verifiedByUserId: v.optional(v.id("users")),
  statusChangedAt: v.optional(v.number()),
  contextType: v.optional(v.union(
    v.literal("opportunity"),
    v.literal("customer"),
  )),
}

// customers (Finding 4: denormalized totals; Finding 16: timestamps)
customers: {
  // ... existing fields ...
  totalPaidMinor: v.optional(v.number()),
  totalPaymentCount: v.optional(v.number()),
  paymentCurrency: v.optional(v.string()),
  churnedAt: v.optional(v.number()),
  pausedAt: v.optional(v.number()),
}

// followUps (Finding 16: timestamps)
followUps: {
  // ... existing fields ...
  bookedAt: v.optional(v.number()),
}

// leads (Finding 2: customFields hardening — Phase 5 narrow)
// leads.customFields changes from v.optional(v.any()) to:
//   v.optional(v.record(v.string(), v.string()))
// leads.status changes from v.optional(v.union(...)) to:
//   v.union(v.literal("active"), v.literal("converted"), v.literal("merged"))
```

---

## 7. Index Changes Reference

### Correctness indexes (fix current broken query shapes)

| Table | Index name | Fields | Fixes finding |
| --- | --- | --- | --- |
| `opportunities` | `by_tenantId_and_assignedCloserId_and_status` | `["tenantId", "assignedCloserId", "status"]` | 5, 10 |
| `opportunities` | `by_tenantId_and_potentialDuplicateLeadId` | `["tenantId", "potentialDuplicateLeadId"]` | 11 |
| `customers` | `by_tenantId_and_convertedByUserId` | `["tenantId", "convertedByUserId"]` | 10 |
| `customers` | `by_tenantId_and_convertedByUserId_and_status` | `["tenantId", "convertedByUserId", "status"]` | 10 |
| `followUps` | `by_tenantId_and_leadId_and_createdAt` | `["tenantId", "leadId", "createdAt"]` | 10, 11 |
| `followUps` | `by_tenantId_and_closerId_and_type_and_status_and_reminderScheduledAt` | `["tenantId", "closerId", "type", "status", "reminderScheduledAt"]` | 10, 11 |
| `followUps` | `by_opportunityId_and_status` | `["opportunityId", "status"]` | 11 |
| `rawWebhookEvents` | `by_tenantId_and_eventType_and_calendlyEventUri` | `["tenantId", "eventType", "calendlyEventUri"]` | 9, 11 |

### Analytics indexes (enable reporting without full scans)

| Table | Index name | Fields | Use case |
| --- | --- | --- | --- |
| `opportunities` | `by_tenantId_and_createdAt` | `["tenantId", "createdAt"]` | Pipeline volume by date |
| `opportunities` | `by_tenantId_and_status_and_createdAt` | `["tenantId", "status", "createdAt"]` | Status cohort analysis |
| `opportunities` | `by_tenantId_and_eventTypeConfigId` | `["tenantId", "eventTypeConfigId"]` | Event type stats |
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
| `meetingReassignments` | `by_tenantId_and_reassignedAt` | `["tenantId", "reassignedAt"]` | Reassignment frequency |

### Deferred indexes (depends on `meetings.assignedCloserId`)

| Table | Index name | Fields |
| --- | --- | --- |
| `meetings` | `by_tenantId_and_assignedCloserId_and_scheduledAt` | `["tenantId", "assignedCloserId", "scheduledAt"]` |

**Total new indexes**: 23 (8 correctness + 14 analytics + 1 deferred)

---

## 8. Frontend Changes Reference

### Payment model (`amount` → `amountMinor`)

| File | Change | Type |
| --- | --- | --- |
| `lib/format-currency.ts` | **New file** — shared `formatAmountMinor(amountMinor, currency)` utility | New utility |
| `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` | `Math.round(parseFloat(amount) * 100)` before mutation; arg key `amount` → `amountMinor` | Behavioral |
| `app/workspace/customers/[customerId]/_components/record-payment-dialog.tsx` | Same conversion at submission boundary | Behavioral |
| `app/workspace/customers/[customerId]/_components/payment-history-table.tsx` | `payment.amount.toFixed(2)` → `formatAmountMinor(payment.amountMinor, payment.currency)` | Display |
| `app/workspace/closer/meetings/_components/deal-won-card.tsx` | `formatCurrency(payment.amount, ...)` → `formatAmountMinor(payment.amountMinor, ...)` | Display |
| `app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx` | `totalPaid` → `totalPaidMinor / 100` for display | Display |
| `app/workspace/customers/_components/customers-table.tsx` | Same — `totalPaid` → `totalPaidMinor / 100` | Display |

### User soft-delete

| File | Change | Type |
| --- | --- | --- |
| `app/workspace/team/_components/team-members-table.tsx` | Add `isDeactivated` field to `TeamMember` type; muted row style + "(deactivated)" label; hide action buttons for deactivated users | Display + Behavioral |
| `app/workspace/team/_components/remove-user-dialog.tsx` | Rename to "Deactivate User"; update dialog copy; change mutation call | Behavioral |
| `app/workspace/team/_components/team-page-client.tsx` | CSV export includes deactivation status | Behavioral |
| Various closer/customer name displays | Backend returns "(deactivated)" suffix or `isDeactivated` flag for historical references | Display (backend-driven) |

### `leads.status` required

| File | Change | Type |
| --- | --- | --- |
| `app/workspace/leads/[leadId]/_components/lead-detail-page-client.tsx` | Remove `lead.status ?? "active"` fallbacks | Cleanup |
| `app/workspace/leads/_components/leads-table.tsx` | Remove `?? "active"` in comparator and display | Cleanup |
| `convex/customers/conversion.ts` | Remove `(lead.status ?? "active") as any` cast | Cleanup |

---

## 9. Migration Scripts

All scripts run as Convex internal mutations or actions. Given the small data footprint (~700 records), each can process all records in a single mutation without batching.

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
          contextType: payment.opportunityId ? "opportunity" as const : "customer" as const,
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
      const payments = await ctx.db
        .query("paymentRecords")
        .withIndex("by_customerId", q => q.eq("customerId", customer._id))
        .collect();
      const totalMinor = payments.reduce(
        (sum, p) => sum + (p.amountMinor ?? Math.round(p.amount * 100)), 0
      );
      const currency = payments[0]?.currency ?? "USD";
      await ctx.db.patch(customer._id, {
        totalPaidMinor: totalMinor,
        totalPaymentCount: payments.length,
        paymentCurrency: currency,
      });
      updated++;
    }
    return { updated, total: customers.length };
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
    const activeStatuses = ["scheduled", "in_progress", "follow_up_scheduled", "reschedule_link_sent"];
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
    const activeLeads = leads.filter(l => l.status === "active" || l.status === undefined);

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

    // Group by calendlyEventTypeUri
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

      // Keep oldest (canonical)
      group.sort((a, b) => a.createdAt - b.createdAt);
      const canonical = group[0];
      const duplicates = group.slice(1);

      for (const dup of duplicates) {
        // Repoint opportunities referencing this duplicate
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
      console.log(`[Migration] ${uri}: kept ${canonical._id}, deleted ${duplicates.length} duplicates`);
    }
    return { deleted };
  },
});
```

> **Note**: Script 2.8 requires the `by_tenantId_and_eventTypeConfigId` analytics index from Phase 1. Deploy Phase 1 first.

---

## 10. Testing Checklist

### Per-phase verification

#### After Phase 1 (Schema Widen)
- [ ] `npx convex deploy` succeeds with no schema validation errors
- [ ] All existing queries still return correct data (new fields are `undefined`)
- [ ] Pipeline processes incoming webhooks without errors

#### After Phase 2 (Backfill)
- [ ] Zero leads with `status === undefined`
- [ ] Zero users with `isActive === undefined`
- [ ] All meetings have `assignedCloserId` matching their opportunity's closer
- [ ] All payment records have `amountMinor === Math.round(amount * 100)`
- [ ] All customers have `totalPaidMinor` matching sum of their payment `amountMinor` values
- [ ] `tenantStats` document exists and counts match live data
- [ ] Zero duplicate `eventTypeConfigs` per `(tenantId, calendlyEventTypeUri)`

#### After Phase 3 (Backend Mutations)
- [ ] New booking (Calendly webhook) → opportunity + meeting created with `assignedCloserId` set
- [ ] New booking → `meetingFormResponses` rows created from custom field answers
- [ ] New booking → `domainEvents` emitted for opportunity.created + meeting.created
- [ ] Cancellation webhook → `domainEvents` emitted, `canceledAt` set
- [ ] No-show webhook → `domainEvents` emitted, `noShowMarkedAt` set
- [ ] `markAsLost` → `lostAt` + `lostByUserId` set, domain event emitted
- [ ] `logPayment` → `amountMinor` stored, `paymentReceivedAt` set, `tenantStats` updated, customer totals updated
- [ ] `removeUser` → user soft-deleted (row preserved, `isActive: false`)
- [ ] Soft-deleted user cannot authenticate (rejected by `requireTenantUser`)
- [ ] Tenant deletion cascades all 14+ tables
- [ ] Webhook dedup works with compound index (no duplicate processing)

#### After Phase 4 (Backend Queries)
- [ ] Admin dashboard loads in <200ms (single doc read instead of 4 table scans)
- [ ] Closer dashboard loads without `.collect()` on all opportunities
- [ ] Lead list pagination returns correct page sizes (no post-filter shrinkage)
- [ ] Lead search returns correct results (no over-fetch + truncate)
- [ ] Customer list for closers paginates correctly (no post-filter)
- [ ] Active reminders list returns all matching records (no post-take filter)
- [ ] Lead detail follow-ups load via index (not tenant scan + JS filter)

#### After Phase 5 (Schema Narrow)
- [ ] `npx convex deploy` succeeds with required `leads.status`
- [ ] `npx convex deploy` succeeds with removed `paymentRecords.amount`

#### After Phase 6 (Frontend)
- [ ] Payment form submits integer cents (verify in Convex dashboard)
- [ ] Payment displays show correct dollar amounts (cents / 100)
- [ ] Deactivated users show visual indicator on team page
- [ ] Deactivated users' names display correctly on historical records
- [ ] Lead list/detail no longer shows `?? "active"` artifacts
- [ ] Customer totals display correctly from denormalized field

### Browser verification (Expect skill)

After each frontend change:
- [ ] Accessibility audit (axe-core)
- [ ] Performance metrics (LCP, CLS, INP)
- [ ] Console error check
- [ ] 4 viewport responsive test
- [ ] Data seeding: minimum 3 records per entity before screenshots

---

## 11. Skills & Resources

### Required skills by phase

| Phase | Skills needed |
| --- | --- |
| Phase 1 (Schema) | `convex-migration-helper` for schema change review |
| Phase 2 (Backfill) | `convex-migration-helper` for widen-migrate-narrow patterns |
| Phase 3 (Mutations) | Convex guidelines (`convex/_generated/ai/guidelines.md`) |
| Phase 4 (Queries) | Convex guidelines for indexed query patterns |
| Phase 5 (Narrow) | `convex-migration-helper` for narrowing validation |
| Phase 6 (Frontend) | `expect` for browser verification; `shadcn` for component updates; `frontend-design` for new dialogs |

### Documentation references

| Area | Document |
| --- | --- |
| Audit findings | `.docs/audits/definite-database-audit-reportv2.md` |
| Convex guidelines | `convex/_generated/ai/guidelines.md` |
| Convex + Next.js | `.docs/convex/nextjs.md`, `.docs/convex/module-nextjs.md` |
| Status transitions | `convex/lib/statusTransitions.ts` |
| RBAC permissions | `convex/lib/permissions.ts` |
| Auth chain | `lib/auth.ts` |
| Pipeline processor | `convex/pipeline/processor.ts` → dispatches to `inviteeCreated`, `inviteeCanceled`, `inviteeNoShow` |

### Key constraints

1. **30-day webhook retention window**: `meetingFormResponses` backfill from `rawWebhookEvents` must happen before old events are cleaned up by `convex/webhooks/cleanup.ts`. Schedule this in Phase 2 with priority.
2. **Convex transaction limits**: Each mutation can read/write a bounded number of documents. The backfill scripts use `.collect()` which is safe for ~700 records but would need batching at scale.
3. **Schema push validation**: Convex rejects schema pushes where existing documents don't match new validators. All backfills must complete before any `v.optional()` → required narrowing.
4. **Index build time**: New indexes are built asynchronously after deploy. Queries using new indexes may be slow briefly after deploy until the index is fully built. For 700 records this is negligible.

---

## Summary

v0.5b operationalizes 22 audit findings across 6 sequential phases:

1. **Schema Widen** — 4 new tables, ~15 optional fields, 23 indexes
2. **Backfill** — 7 data migrations, 5 data cleanups
3. **Backend Mutations** — 17 mutation updates (12 status-changing functions + 5 infrastructure)
4. **Backend Queries** — 17 query rewrites (correctness fixes + performance optimization)
5. **Schema Narrow** — 4 field tightening operations
6. **Frontend** — 13 file updates (payment displays, soft-delete UI, status cleanup)

The data footprint is small (1 tenant, ~700 records), so all migrations can run as single-shot scripts. The fresh-start option remains available if any migration proves simpler as a wipe-and-reseed. The phases are strictly ordered by dependency: widen before backfill, backfill before code changes, code changes before narrowing.

After v0.5b, the data model supports:
- Funnel transition counts over time
- Time-in-stage and stage-to-stage duration reporting
- Per-closer performance analytics
- Currency-safe revenue reporting
- Historical actor attribution
- Real-time dashboards without full-table scans
- Correct pagination without post-filter artifacts
- Stable referential integrity across user lifecycle
