# Database Audit

Date: 2026-04-11

Scope:
- `convex/schema.ts`
- Convex queries, mutations, actions, and shared helpers under `convex/`
- Existing PostHog instrumentation only insofar as it affects analytics data capture

Audit criteria:
- `.docs/best-practices/convex-db-best-practices.md`
- `convex/_generated/ai/guidelines.md`
- Repository architecture rules in `AGENTS.md`

## Executive Summary

The current model is a solid operational CRM schema for v0.5-style workflows. The core business entities are mostly separated well, tenant scoping is consistent, state machines are explicit, and the codebase already uses some justified denormalizations such as `opportunities.latestMeetingId/latestMeetingAt`, `opportunities.nextMeetingId/nextMeetingAt`, `meetings.leadName`, and `leads.searchText`.

The main problem is not that the whole schema is "bad". The problem is that it is optimized for current screens and current state, not for historical facts and future analytics. Right now the system is much better at answering "what is the latest state?" than "what happened over time, who changed it, what was the exact data at that interaction, and how do we aggregate it without rescanning operational tables?".

For the stated goal of enterprise-grade analytics and reporting, the current model is not ready yet for five reasons:

1. It does not persist a durable, queryable event history for domain changes or product interactions.
2. It collapses booking answers into `leads.customFields`, which loses per-interaction provenance and prevents robust reporting.
3. It has a referential-integrity gap around user deletion.
4. Several hot read paths still depend on `.collect()` or table/index scans plus JS filtering.
5. The money model is not safe for serious financial reporting.

The right next step is not to over-index every imaginable future report. Since report shapes are still undefined, the immediate priority should be:

- preserve atomic facts and history
- add the missing relationship/index dimensions for known hot reads
- introduce summary/read-model tables only where current scans are already obvious
- keep Convex as the OLTP system and plan a warehouse/PostHog export path for heavier OLAP workloads

## 1. Domain And Data Model Summary

### Core entities

| Table | Responsibility | Notes |
| --- | --- | --- |
| `tenants` | Tenant identity, onboarding status, Calendly connection state | Currently mixes stable tenant metadata with high-churn integration state and secrets |
| `users` | CRM users within a tenant | Good core auth/role table; currently hard-deleted |
| `calendlyOrgMembers` | External Calendly org-member dimension | Good integration table with match back to `users` |
| `rawWebhookEvents` | Operational ingest/audit buffer for Calendly webhooks | Useful for debugging/replay, not a reporting model |
| `leads` | Lead identity and current lead-level state | Currently stores merged `customFields` and denormalized search/display fields |
| `leadIdentifiers` | Canonical multi-identifier lead resolution | Strong normalization choice |
| `leadMergeHistory` | Merge audit trail | Good relationship/audit table |
| `opportunities` | Core sales workflow record | Good central entity; already carries some useful denormalized read fields |
| `meetings` | Child interaction records for opportunities | Missing direct closer dimension and per-meeting booking answer snapshot |
| `followUps` | Follow-up work items | Good child table, but missing some report-oriented indexes |
| `paymentRecords` | Payment facts | Good dedicated table, but the money model is weak for enterprise reporting |
| `customers` | Converted-lead/customer lifecycle record | Works as a conversion snapshot; may need refactor later if post-sale domain grows |
| `eventTypeConfigs` | CRM overlays on Calendly event types | Good concept; stats currently computed by scan |
| `closerUnavailability` / `meetingReassignments` | Schedule constraints and reassignment audit | Good separation of concerns |

### What is already normalized well

- The app correctly models the main 1:N relationships as separate tables:
  - `tenant -> users`
  - `lead -> opportunities`
  - `opportunity -> meetings`
  - `opportunity -> followUps`
  - `lead -> leadIdentifiers`
  - `lead/opportunity/meeting -> payment/customer` links
- `leadIdentifiers` is the right relational answer for multi-channel identity matching.
- `leadMergeHistory` and `meetingReassignments` are good examples of storing relationship-specific facts on their own tables instead of burying them in parent documents.
- Status fields are mostly modeled as unions/literals instead of free-form strings.
- Tenant ownership is explicit across the operational tables.

### Existing denormalizations that are justified and should stay

- `opportunities.latestMeetingId/latestMeetingAt` and `nextMeetingId/nextMeetingAt`
  - These are valid read-model denormalizations for hot pipeline/dashboard queries.
  - The current code generally updates them in the same write path via `convex/lib/opportunityMeetingRefs.ts`.
- `meetings.leadName`
  - Valid display denormalization for calendar/detail views.
- `leads.searchText`
  - Valid search denormalization for the full-text index.
- `users.calendlyMemberName`
  - Valid UI convenience copy if it remains a small bounded field.

### Denormalizations that are missing and should be added

- `meetings.assignedCloserId`
  - Needed for closer calendar/next-meeting/reporting without scanning opportunities then meetings.
- `customer` or `customerFinancialSummary` payment counters/totals
  - Needed to avoid recalculating totals from all `paymentRecords` on each read.
- Event-type booking stats summary
  - Needed if the event-type settings/reporting screens remain hot.
- Durable business event history
  - Needed for reporting/auditability of transitions and actions over time.

## 2. Normalization Review

### 1NF

Mostly good, with two notable exceptions:

- `leads.customFields` is currently `v.optional(v.any())` in `convex/schema.ts:110-156`.
  - This is not a scalable analytical representation.
  - It stores arbitrary shape, is not typed, is not per-interaction, and is overwritten/merged over time in `convex/pipeline/inviteeCreated.ts:252-265` and `convex/pipeline/inviteeCreated.ts:1180-1194`.
- `tenants` stores both tenant profile data and operational Calendly/OAuth state in the same document in `convex/schema.ts:6-51`.
  - This is a document-boundary problem more than a classical SQL 1NF problem, but it violates the Convex guidance to separate stable profile data from high-churn operational state.

### 2NF

No major 2NF issues in the core relationship tables.

Good examples:

- `leadMergeHistory` stores facts about the merge relationship itself in `convex/schema.ts:193-205`.
- `meetingReassignments` stores facts about the reassignment relationship itself in `convex/schema.ts:361-376`.

### 3NF

The biggest 3NF-style issues are not rampant duplication across the whole schema; they are a few specific places where mutable facts are copied or collapsed without a clear source-of-truth strategy:

- `leads.customFields` is a merged current-state object, but the real source facts are per booking/per meeting.
- `customers` duplicates lead identity fields in `convex/schema.ts:423-453` and `convex/customers/conversion.ts:86-102`.
  - Today this is acceptable as a conversion snapshot.
  - If customers become a long-lived operational domain, this may need a canonical `contacts` or `parties` model later.
- `tenants` mixes profile, onboarding, OAuth state, token refresh locks, and webhook secrets in one document.

Conclusion:

- The schema is close to 3NF for the operational CRM core.
- It is not close to 3NF for analytics-grade historical facts, because history is often compressed into latest-state fields rather than modeled as append-only records.

## 3. Findings

### Finding 1

Severity: High

Affected:
- `convex/schema.ts`
- Mutations that patch operational state directly, for example:
  - `convex/closer/meetingActions.ts:94-105`
  - `convex/closer/meetingActions.ts:149-159`
  - `convex/closer/noShowActions.ts:66-80`
  - `convex/closer/payments.ts:115-176`
  - `convex/closer/followUpMutations.ts:62-66`, `122-176`, `239-255`
- Client-side PostHog-only instrumentation:
  - `app/workspace/closer/meetings/_components/outcome-action-bar.tsx:121-127`
  - `app/workspace/closer/meetings/_components/payment-form-dialog.tsx:208-218`
  - `app/workspace/settings/_components/field-mapping-dialog.tsx:177-182`
  - `app/workspace/closer/pipeline/_components/closer-pipeline-page-client.tsx:43-48`
- `lib/posthog-capture.ts:43-60` exists, but there are no call sites in the app code

Why it matters:

The current system stores latest state well, but it does not store a durable, queryable history of important business events or UI/product events inside the data model. That means:

- you cannot reconstruct when an opportunity moved through stages unless the final state still implies it
- you cannot reliably answer "how many times was action X taken over time?" from Convex
- you cannot correlate button clicks or feature usage with CRM outcomes from the app database
- PostHog captures are useful for product analytics, but they are external, partial, client-heavy, and not modeled as relational facts tied to the CRM entities

Recommended fix:

Add an append-only business event model for reportable operational actions, for example a `domainEvents` table:

- `tenantId`
- `entityType`
- `entityId`
- `eventType`
- `actorUserId`
- `source` (`user`, `webhook`, `system`, `migration`)
- `occurredAt`
- `payload` with a typed event envelope per event family

Suggested indexes:

- `by_tenantId_and_occurredAt`
- `by_tenantId_and_entityType_and_entityId_and_occurredAt`
- `by_tenantId_and_eventType_and_occurredAt`
- optionally `by_actorUserId_and_occurredAt`

Examples that should emit domain events:

- meeting started
- meeting outcome changed
- opportunity status changed
- payment recorded / verified / disputed
- follow-up created / booked / completed / expired
- user invited / role changed / user deactivated
- lead merged
- customer converted

For product analytics:

- keep PostHog for product telemetry
- do not put every raw click into operational tables
- if an interaction needs first-class reporting inside the CRM, mirror a curated subset into `domainEvents` or stream it into a warehouse

Migration required:

- No schema migration is required if you add new append-only tables.
- The behavioral change is dual-write: start emitting events from all relevant write paths.

### Finding 2

Severity: High

Affected:
- `convex/schema.ts:110-156`
- `convex/pipeline/inviteeCreated.ts:252-265`
- `convex/pipeline/inviteeCreated.ts:1180-1194`
- `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx:205-223`
- Planned model expectation in `plans/v0.5/version0-5.md:84-93`
- Raw webhook cleanup:
  - `convex/webhooks/cleanup.ts:1-29`
  - `convex/webhooks/cleanupMutations.ts:17-29`
  - `convex/crons.ts:27-32`

Why it matters:

This is the single biggest analytics-model issue in the current schema.

Today:

- booking answers are merged into `lead.customFields`
- the field is `v.any()`
- the UI reads `lead.customFields`, not a meeting-specific answer snapshot

That has four consequences:

1. History loss
   - If the same lead books multiple meetings and answers a question differently each time, the model preserves only the merged/latest view, not the interaction-level fact.
2. Weak provenance
   - You cannot answer "which meeting produced this answer?" without reconstructing it from retained raw webhooks.
3. Poor analytics shape
   - Question labels are free-form strings.
   - There is no stable field catalog, no typed answer model, and no per-meeting fact table.
4. Schema unsafety
   - `v.any()` is too permissive for a production schema.

This is also inconsistent with the design direction documented in `plans/v0.5/version0-5.md:92`, which expected a per-meeting copy of booking/form data.

Backfill warning:

- Processed raw webhook payloads are cleaned up every day with a 30-day retention window.
- That means historical per-meeting answers can only be reconstructed for the retained raw events, not for the full lifetime of the system.

Recommended fix:

Split this into two layers:

1. Keep a bounded current-state summary if the UI still benefits from it
   - Either narrow `leads.customFields` to `v.record(v.string(), v.string())`
   - Or replace it with something explicitly named like `latestBookingAnswers`

2. Add proper interaction-level facts
   - Option A: add `meetings.customFormData` as a bounded snapshot for the full meeting detail UI
   - Option B: preferred for analytics, add normalized child tables:
     - `eventTypeFieldCatalog`
       - `tenantId`
       - `eventTypeConfigId`
       - `fieldKey` or normalized key
       - `currentLabel`
       - `firstSeenAt`
       - `lastSeenAt`
       - optional `valueType`
     - `meetingFormResponses`
       - `tenantId`
       - `meetingId`
       - `opportunityId`
       - `leadId`
       - `eventTypeConfigId`
       - `fieldCatalogId` or stable field key
       - `questionLabelSnapshot`
       - `answerText`
       - optional normalized answer columns
       - `capturedAt`

Suggested indexes:

- `meetingFormResponses.by_meetingId`
- `meetingFormResponses.by_tenantId_and_eventTypeConfigId`
- `meetingFormResponses.by_tenantId_and_fieldCatalogId`
- optionally time-based indexes for reporting windows

Migration required:

- Yes.
- Safe rollout:
  - widen schema with new optional field/table
  - dual-write new bookings into the new structure
  - backfill recent history from retained `rawWebhookEvents`
  - keep readers compatible with both models
  - narrow or deprecate `leads.customFields`

### Finding 3

Severity: High

Affected:
- `convex/workos/userMutations.ts:428-458`
- All tables that reference `users`, including:
  - `opportunities.assignedCloserId` in `convex/schema.ts:208-253`
  - `closerUnavailability.closerId/createdByUserId` in `convex/schema.ts:341-359`
  - `meetingReassignments.fromCloserId/toCloserId/reassignedByUserId` in `convex/schema.ts:361-376`
  - `customers.convertedByUserId` in `convex/schema.ts:423-453`
  - `paymentRecords.closerId` in `convex/schema.ts:456-479`
  - `followUps.closerId` in `convex/schema.ts:481-520`
  - `leadMergeHistory.mergedByUserId` in `convex/schema.ts:193-205`

Why it matters:

`removeUser` currently unlinks the Calendly member and deletes the `users` row, but it does not reconcile the references left behind in other tables.

That creates orphaned references and breaks:

- historical reporting by actor/closer
- data integrity for current operational records
- reliable joins for timelines and audit views

This is especially problematic in an analytics/reporting context because actors are dimensions that must remain stable long after the operational user is no longer active.

Recommended fix:

Replace hard delete with soft delete:

- add `users.deletedAt`
- add `users.isActive` or `users.lifecycleStatus`
- preserve the row permanently for historical joins

For future operational integrity:

- block deactivation while the user still owns active opportunities, pending follow-ups, or future meetings unless those are reassigned first
- allow inactive users to remain referenced by historical records such as payments, merges, and conversions

Also add a one-time orphan audit to identify whether any references already point to deleted users.

Migration required:

- Additive soft-delete fields: safe, no breaking migration.
- Historical cleanup/orphan audit: migration script recommended.

### Finding 4

Severity: High

Affected:
- `convex/schema.ts:208-338`
- `convex/closer/dashboard.ts:20-61`
- `convex/closer/dashboard.ts:91-119`
- `convex/closer/pipeline.ts:32-68`
- `convex/closer/calendar.ts:28-83`
- `convex/unavailability/shared.ts:75-150`
- `convex/unavailability/shared.ts:153-240`

Why it matters:

The system frequently needs to answer "show meetings for this closer in time order", but `meetings` does not carry a direct closer key. As a result, the code repeatedly does this pattern:

1. load all opportunities for a closer
2. derive opportunity IDs in memory
3. scan tenant meetings in a time range
4. keep only meetings whose `opportunityId` belongs to that closer

That is the wrong shape for a hot calendar/reporting dimension.

This hurts:

- closer dashboard next-meeting lookup
- closer calendar rendering
- redistribution/unavailability scheduling logic
- any future reporting by closer + meeting date

Recommended fix:

Add `meetings.assignedCloserId` as an intentional denormalized dimension.

Suggested fields/indexes:

- new optional field: `assignedCloserId: v.optional(v.id("users"))`
- index: `by_tenantId_and_assignedCloserId_and_scheduledAt`
- optionally `by_tenantId_and_assignedCloserId_and_status_and_scheduledAt` if status-specific reads become frequent

Maintenance rules:

- set it when creating a meeting
- update it when the owning opportunity is reassigned
- treat it as a read-optimized projection of `opportunities.assignedCloserId`

Also add:

- `opportunities.by_tenantId_and_assignedCloserId_and_status`

That one index would remove several current `.collect()` + JS filter paths for closer-specific opportunity views.

Migration required:

- Yes for the meeting-level dimension if you want historical rows backfilled.
- Safe rollout:
  - add the field as optional
  - dual-write on new meeting/reassignment paths
  - backfill from opportunity ownership and reassignment history
  - then switch reads to the new index

### Finding 5

Severity: High

Affected:
- `convex/schema.ts:456-479`
- `convex/closer/payments.ts:38-178`
- `convex/customers/queries.ts:56-63`
- `convex/customers/queries.ts:147-154`
- `convex/customers/queries.ts:206-214`
- `convex/dashboard/adminStats.ts:78-110`

Why it matters:

The current payment model is not safe for enterprise reporting:

- `paymentRecords.amount` is a floating-point `number`
- `currency` is an arbitrary string
- customer totals sum all `amount` values and display the first payment's currency
- tenant/admin revenue sums all non-disputed payment amounts without currency controls

This means the current code can produce numerically correct-looking but semantically wrong totals if multiple currencies ever appear for the same tenant/customer/report.

Recommended fix:

Use a real money model:

- add `amountMinor` as integer minor units
  - prefer `v.int64()` if you want full financial safety
- keep `currency` as a constrained code, ideally ISO 4217
- define the reporting rule explicitly:
  - single-tenant single-currency only, or
  - multi-currency payments with tenant reporting currency and FX conversion pipeline

For read models:

- maintain `customerFinancialSummary` or denormalized fields such as payment count and totals by currency
- if multi-currency remains possible, store totals per currency, not one mixed `totalPaid`

Migration required:

- Yes if you replace the amount representation.
- Safe rollout:
  - add `amountMinor` alongside `amount`
  - dual-write both
  - backfill
  - switch reads to `amountMinor`
  - eventually deprecate `amount`

### Finding 6

Severity: Medium

Affected:
- `convex/schema.ts:6-51`

Why it matters:

`tenants` currently contains:

- tenant identity
- onboarding/invite state
- Calendly OAuth tokens
- refresh locks
- webhook setup state
- webhook secrets

This is a document-boundary anti-pattern in Convex. The document is mixing:

- stable tenant profile data
- secrets
- integration runtime state
- fields updated by background jobs

At scale this causes avoidable invalidation/churn, makes security boundaries murkier, and makes the tenant row harder to reason about as a canonical business entity.

Recommended fix:

Split the current table into:

- `tenants`
  - company name
  - contact email
  - lifecycle/onboarding state
  - tenant owner
- `tenantCalendlyConnections` or similar
  - tenantId
  - org/user URIs
  - tokens
  - token expiry
  - refresh lock
  - webhook data

Potentially also separate temporary OAuth/bootstrap state if it has a different lifecycle.

Migration required:

- Yes.
- Safe rollout:
  - add the new table
  - dual-read/dual-write integration code
  - backfill
  - narrow old fields later

### Finding 7

Severity: Medium

Affected:
- `convex/leads/queries.ts:272-353`
- `convex/closer/followUpQueries.ts:9-39`
- `convex/eventTypeConfigs/queries.ts:46-108`
- `convex/dashboard/adminStats.ts:33-110`
- `convex/customers/queries.ts:48-79`, `146-215`
- `convex/closer/dashboard.ts:20-61`, `91-119`
- `convex/closer/pipeline.ts:32-68`

Why it matters:

Several report-like or dashboard-like queries still depend on JS filtering, table walks, or recomputation from base facts. This is not automatically wrong for a small tenant, but these shapes will become the first bottlenecks once analytics/reporting screens grow.

Examples:

- lead detail loads follow-ups with `by_tenantId` then filters by `leadId`
- active reminders load all pending follow-ups for a closer, then filter by `type` and sort in JS
- event type stats scan all tenant opportunities to compute counts and last booking
- admin dashboard stats scan users, opportunities, and payment records on every query
- customer totals collect all payments every time

Recommended fix:

For each path, either:

- add the missing index that matches the read shape, or
- introduce a summary/read-model table if the screen is aggregate-heavy

Do not try to solve undefined future analytics by adding every possible index now. Instead:

- add indexes for the read shapes that already exist today
- add append-only facts so future indexes can be introduced safely later

Migration required:

- Index additions: safe.
- Summary-table additions: safe.

### Finding 8

Severity: Medium

Affected:
- `convex/pipeline/inviteeCreated.ts:700-717`
- `convex/pipeline/inviteeCreated.ts:799-809`
- `convex/eventTypeConfigs/mutations.ts:141-170`
- `convex/customers/conversion.ts:42-56`

Why it matters:

The model has several logical uniqueness rules, but not all of them are enforced as hard invariants. The clearest example is `eventTypeConfigs`:

- the code explicitly handles the case where multiple configs exist for the same `(tenantId, calendlyEventTypeUri)`
- `lookupEventTypeConfig` loads up to eight candidates and picks the oldest one

That means duplicate logical records are already anticipated.

This is risky because analytics/reporting assumes clean dimensions. If one event type or one customer can exist multiple times for the same logical business key, aggregates drift.

Recommended fix:

- Keep all writes for uniqueness-sensitive tables behind one mutation path
- Continue using indexed existence checks in the same transaction
- Add duplicate detection audits for:
  - `eventTypeConfigs (tenantId, calendlyEventTypeUri)`
  - `customers (tenantId, leadId)`
  - `leadIdentifiers (tenantId, type, value)`
- If duplicates already exist, repair them before building reporting on top

Migration required:

- Schema change not necessarily required.
- Data audit/repair migration is recommended.

### Finding 9

Severity: Low

Affected:
- `convex/lib/opportunityMeetingRefs.ts:10-70`
- `convex/workos/userMutations.ts:350-380`

Why it matters:

These are not immediate design blockers, but they are worth noting:

- `updateOpportunityMeetingRefs` scans all meetings for an opportunity every time it recalculates the latest/next pointers.
- `normalizeStoredWorkosUserIds` does a full-table `ctx.db.query("users")` scan.

Both are acceptable today if usage is limited and the table sizes are still small. They are not the first places I would refactor for this audit.

Recommended fix:

- Keep as-is for now unless Convex insights show them as hotspots.
- If opportunity meeting histories grow materially, consider `meetings.by_opportunityId_and_scheduledAt` and more incremental maintenance logic.

Migration required:

- No immediate migration required.

## 4. Query And Index Matrix

| Query shape | Current implementation | Current index path | Risk | Recommendation |
| --- | --- | --- | --- | --- |
| Closer next meeting | `convex/closer/dashboard.ts:20-61` loads all closer opportunities, filters by status, then scans tenant meetings by date | `opportunities.by_tenantId_and_assignedCloserId`, `meetings.by_tenantId_and_scheduledAt` | High | Add `meetings.assignedCloserId` + `by_tenantId_and_assignedCloserId_and_scheduledAt`; add `opportunities.by_tenantId_and_assignedCloserId_and_status` |
| Closer pipeline summary/list | `convex/closer/dashboard.ts:91-119`, `convex/closer/pipeline.ts:32-68` use `.collect()` and JS status filtering | `opportunities.by_tenantId_and_assignedCloserId` | Medium | Add `opportunities.by_tenantId_and_assignedCloserId_and_status`; paginate admin-sized lists |
| Closer calendar and redistribution | `convex/closer/calendar.ts:28-83`, `convex/unavailability/shared.ts:75-150`, `153-240` derive opportunity IDs then filter tenant meetings | `opportunities.by_tenantId_and_assignedCloserId`, `meetings.by_tenantId_and_scheduledAt` | High | Same fix as above: denormalize closer onto meetings and index directly |
| Lead detail follow-ups | `convex/leads/queries.ts:272-353` loads follow-ups by tenant then filters by `leadId` | `followUps.by_tenantId` | Medium | Add `followUps.by_tenantId_and_leadId_and_createdAt` or `by_leadId_and_createdAt` |
| Active reminders | `convex/closer/followUpQueries.ts:9-39` loads pending follow-ups, filters by `type`, sorts by `reminderScheduledAt` | `followUps.by_tenantId_and_closerId_and_status` | Medium | Add `followUps.by_tenantId_and_closerId_and_type_and_status_and_reminderScheduledAt`, or split manual reminders into a dedicated model |
| Customer totals | `convex/customers/queries.ts:48-79`, `146-215` collect all customer payments and sum at read time | `paymentRecords.by_customerId` | Medium-High | Add customer financial summary fields/table; also fix money/currency semantics |
| Event type stats | `convex/eventTypeConfigs/queries.ts:46-108` scans all tenant opportunities | `opportunities.by_tenantId` | Medium | Maintain summary stats on `eventTypeConfigs` or a dedicated stats table |
| Admin dashboard stats | `convex/dashboard/adminStats.ts:33-110` scans users, opportunities, paymentRecords on each query | `users.by_tenantId`, `opportunities.by_tenantId`, `paymentRecords.by_tenantId` | Medium | Use summary docs or the Aggregate component for counts/sums |
| Admin opportunity list | `convex/opportunities/queries.ts:69-217` is unpaginated and may walk many records | `opportunities.by_tenantId`, `by_tenantId_and_status`, `by_tenantId_and_assignedCloserId` | Medium | Paginate once tenant data grows; keep current enrichment strategy until proven hot |

## 5. Integrity And Atomicity Review

### What is good

- Tenant and role checks are consistently derived server-side with `requireTenantUser`.
- Public functions generally define `args` validators.
- Cross-table references are explicit with `v.id("table")`.
- State transitions are guarded in the write paths, for example:
  - `convex/closer/meetingActions.ts`
  - `convex/closer/noShowActions.ts`
  - `convex/closer/payments.ts`
- Important denormalized fields are often maintained in the same transaction:
  - `opportunities.latestMeeting*` / `nextMeeting*`
  - `leads.searchText`
  - `leadIdentifiers` and `socialHandles`

### What is weak

- User deletion can orphan references.
- There is no generic audit/event table for state changes.
- Some logical uniqueness is tolerated rather than enforced as a clean invariant.
- Booking-answer facts are not modeled at the same granularity as the interaction that produced them.

### Referential integrity risk map

Most concerning current risk:

- hard-deleting `users` while preserving foreign-key-like references in historical and active records

Secondary risk:

- historical recovery of booking data depends on raw webhook retention

### Denormalized-field maintenance

Overall rating: Good, with one major exception

Good:

- `updateOpportunityMeetingRefs` is used in the meeting write paths.
- `updateLeadSearchText` and identifier maintenance happen in the pipeline write path.

Exception:

- `leads.customFields` is not a safe denormalized field because it is currently acting as the only stored representation of data that should exist at meeting granularity.

## 6. Migration Notes

### Safe changes that can ship directly

- Add new append-only tables such as `domainEvents`
- Add new summary/read-model tables
- Add new indexes such as:
  - `opportunities.by_tenantId_and_assignedCloserId_and_status`
  - `followUps.by_tenantId_and_leadId_and_createdAt`
  - `followUps.by_tenantId_and_closerId_and_type_and_status_and_reminderScheduledAt`
- Add soft-delete fields to `users`

### Changes that need widen-migrate-narrow

- Replacing or narrowing `leads.customFields`
- Adding `meetings.assignedCloserId` if historical backfill is required and readers need to rely on it
- Splitting integration fields out of `tenants`
- Replacing `paymentRecords.amount` with integer minor units
- Introducing normalized booking-answer tables if you want backfilled history

### Data recovery constraints

- Per-meeting booking answers can only be backfilled from the retained raw webhook payloads.
- Processed raw webhook events are cleaned up after 30 days in:
  - `convex/webhooks/cleanup.ts:5-29`
  - `convex/webhooks/cleanupMutations.ts:17-29`

### Recommended migration order

1. Stop hard-deleting users by moving to soft delete.
2. Add `domainEvents` and begin dual-write from the highest-value mutations first.
3. Add `meetings.assignedCloserId` and the missing indexes for current hot reads.
4. Add new booking-answer tables or `meetings.customFormData`, then dual-write.
5. Backfill recent booking-answer history from retained raw webhooks.
6. Introduce the corrected money model.
7. Split `tenants` once the operational analytics work is stabilized.

## 7. Remediation Plan

### Immediate

- Replace `users` hard delete with soft delete and audit existing orphaned references.
- Add a `domainEvents` table and start emitting durable business events from:
  - meeting start
  - meeting outcome change
  - no-show creation
  - follow-up creation/completion/booking
  - payment logging
  - customer conversion
  - team/user lifecycle changes
- Start dual-writing booking answers at meeting granularity.
- Add the obvious missing indexes already used by existing screens.

### Next

- Add `meetings.assignedCloserId` and switch closer calendar/dashboard/unavailability reads to it.
- Correct the payment model to integer minor units plus explicit currency/reporting rules.
- Add summary models for:
  - customer financial totals
  - event type stats
  - admin dashboard counts/sums

### Later

- Split `tenants` into stable tenant identity plus integration connection state.
- If customer operations expand materially, evaluate a canonical `contacts`/`parties` model instead of treating `customers` as only a conversion snapshot.
- Stream curated operational facts to a warehouse or analytics sink for broader OLAP reporting.

## 8. Bottom Line

The current schema is a good operational CRM foundation, but it is not yet an analytics-grade data model.

What is missing is not "more denormalization everywhere". What is missing is:

- durable event history
- interaction-level facts instead of merged latest-state blobs
- a stable actor model
- a direct closer/time meeting dimension
- a reporting-safe money model

If those five areas are addressed first, the rest of the current schema can evolve rather than be replaced wholesale.
