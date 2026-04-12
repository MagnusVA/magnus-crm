# Database Audit

Date: 2026-04-11

Scope:
- `convex/schema.ts`
- Convex queries, mutations, internal mutations, and supporting helpers
- Tenant offboarding and data lifecycle paths
- Current analytics capture posture (`PostHog` callsites plus Convex data model)

Method:
- Reviewed `convex/_generated/ai/guidelines.md`
- Followed `.docs/best-practices/convex-db-best-practices.md`
- Audited the live schema, query shapes, write paths, denormalized fields, and cleanup flows

This audit is intentionally opinionated for the stated goal: make the CRM analytics-ready without turning Convex into an ad hoc reporting warehouse. Convex should stay the OLTP source of truth. The schema should support clean operational queries and durable business facts, and heavier analytics should be fed into summary tables and, eventually, an OLAP system.

## 1. Domain and data model summary

### Domain summary

This is a multi-tenant CRM where one WorkOS organization maps to one tenant. The core business flow is:

1. A tenant is provisioned and linked to Calendly + WorkOS.
2. Bookings create or update `leads`, `opportunities`, `meetings`, and `leadIdentifiers`.
3. Closers work meetings, follow-ups, no-shows, reschedules, payments, and conversions.
4. Admins manage team membership, unavailability, reassignment, event-type configuration, and tenant lifecycle.

The current schema has 15 tables, 14 of which are tenant-scoped child tables.

### Table inventory

| Table | Role | Assessment |
| --- | --- | --- |
| `tenants` | Tenant profile, onboarding state, Calendly tokens, webhook state | Functional but overloaded |
| `users` | CRM users and role assignments | Good normalized core |
| `rawWebhookEvents` | Append-only webhook inbox / retry surface | Good ingestion table, weak idempotency lookup |
| `calendlyOrgMembers` | Calendly org member mirror | Good normalized integration table |
| `leads` | Lead profile and current lead lifecycle state | Core entity, but weakened by `customFields` blob and optional `status` |
| `leadIdentifiers` | Canonical lead identity facts (email, phone, social) | Strong normalization choice |
| `leadMergeHistory` | Merge audit facts | Good immutable audit table |
| `opportunities` | Deal / pipeline unit of work | Good core entity with justified denormalization |
| `meetings` | Scheduled and completed interactions | Good core entity, but scheduling queries need better indexing/ownership shape |
| `closerUnavailability` | Closer availability blocks | Good normalized table |
| `meetingReassignments` | Immutable reassignment audit trail | Good audit design |
| `eventTypeConfigs` | Calendly event type dimension plus field mappings | Useful dimension table, duplicate handling is weak |
| `customers` | Post-conversion customer snapshot and status | Acceptable if snapshot is intentional |
| `paymentRecords` | Money movement facts | Too polymorphic for enterprise reporting |
| `followUps` | Follow-up scheduling links and manual reminders | Too polymorphic for enterprise reporting |

### Normalized source-of-truth tables

These are the strongest parts of the current design and should remain the backbone of the model:

- `users`
- `leadIdentifiers`
- `opportunities`
- `meetings`
- `closerUnavailability`
- `meetingReassignments`
- `leadMergeHistory`
- `rawWebhookEvents`

The `leadIdentifiers` table is especially important: it is the right relational move for identity resolution and much better than storing multiple mutable identifier arrays on `leads`.

### Existing denormalized fields and why they are justified

These denormalizations are sensible and should stay:

- `leads.searchText` in `convex/schema.ts:143-156`
  - Good search read model for lead lookup.
- `leads.socialHandles` in `convex/schema.ts:132-141`
  - Good display cache derived from `leadIdentifiers`.
- `users.calendlyMemberName` in `convex/schema.ts:63-76`
  - Acceptable small denormalization for UI efficiency.
- `opportunities.latestMeetingId/latestMeetingAt/nextMeetingId/nextMeetingAt` in `convex/schema.ts:227-230`
  - Strong denormalization for hot reads. Maintenance is centralized in `convex/lib/opportunityMeetingRefs.ts`.
- `meetings.leadName` in `convex/schema.ts:272-278`
  - Reasonable snapshot to avoid lead joins in calendar-like views.
- `meetings.reassignedFromCloserId` in `convex/schema.ts:294-298`
  - Good companion field to `meetingReassignments`.

### Normalization assessment against 1NF, 2NF, 3NF

| Area | Assessment | Notes |
| --- | --- | --- |
| `leads` + `leadIdentifiers` | Near 3NF | Good split, except `customFields` is not normalized |
| `opportunities` + `meetings` | Near 3NF with justified read models | Current denormalized refs are appropriate |
| `customers` | Conditional | Fine if this is a deliberate post-conversion snapshot; otherwise duplicated lead facts can drift |
| `paymentRecords` | Below target | Nullable foreign keys encode multiple business row types |
| `followUps` | Below target | One table stores two subtypes with mostly disjoint attributes |
| `tenants` | Below target | Stable tenant identity is mixed with temporary PKCE state, tokens, and webhook config |

### Current analytics posture

Operationally, the app already captures some analytics, but the model is not analytics-ready:

- There are 23 direct `posthog.capture(...)` or equivalent capture callsites across `app/`, `hooks/`, and `lib/`.
- Representative examples:
  - `lib/posthog-capture.ts:43-60`
  - `hooks/use-posthog-identify.ts:41-72`
  - `app/workspace/closer/meetings/_components/payment-form-dialog.tsx:210-218`
  - `app/workspace/closer/meetings/_components/follow-up-dialog.tsx:244-262`
- There is no first-class Convex table for product events, business state transitions, or user interaction facts.

Today, reporting would have to be reconstructed from:

- mutable current-state tables (`leads`, `opportunities`, `meetings`, `customers`, `paymentRecords`)
- a few narrow audit tables (`leadMergeHistory`, `meetingReassignments`)
- external PostHog events that are not modeled as relational business facts

That is the main architectural gap for analytics and reporting.

## 2. Findings

### Finding 1: There is no first-class analytics fact model

- Severity: High
- Affected: `convex/schema.ts`, `lib/posthog-capture.ts:43-60`, `hooks/use-posthog-identify.ts:41-72`, representative UI event capture sites such as `app/workspace/closer/meetings/_components/payment-form-dialog.tsx:210-218` and `app/workspace/closer/meetings/_components/follow-up-dialog.tsx:244-262`
- Why it matters:
  - The current tables mostly store current state, not immutable business events.
  - PostHog captures clicks and product interactions, but those events are not a tenant-scoped relational analytics backbone.
  - Reporting like "how often did a status change happen", "which actions led to conversions", "what was the funnel by meeting outcome", or "which buttons/features are used before a deal closes" will require reconstruction from mutable rows and ad hoc external events.
- Recommended fix:
  - Keep high-volume UI clickstream in PostHog.
  - Add append-only business fact tables in Convex for authoritative domain events. At minimum:
    - `opportunityStatusEvents`
    - `meetingLifecycleEvents`
    - `paymentEvents`
    - `customerConversionEvents`
    - `userActionEvents` for app-level interactions that must stay tenant-scoped and queryable
  - Standardize event dimensions: `tenantId`, `occurredAt`, `actorUserId`, `leadId`, `opportunityId`, `meetingId`, `customerId`, `eventType`, `properties`
  - Plan to export these facts to an OLAP store once reporting requirements expand. `.docs/investigations/convex-data-analisys.md` is directionally correct here: Convex should not become the long-term analytics engine.
- Migration required: No to start capturing new events. Yes if historical continuity/backfill is required.

### Finding 2: `leads.customFields` is a `v.any()` blob and is the biggest normalization gap in the schema

- Severity: High
- Affected: `convex/schema.ts:110-156`, especially `convex/schema.ts:115`; `convex/pipeline/inviteeCreated.ts:26-54` and `convex/pipeline/inviteeCreated.ts:242-257`
- Why it matters:
  - This violates the spirit of 1NF for analytics/reporting: the values are neither typed nor queryable by key/value/index.
  - The runtime code clearly expects a `Record<string, string>`, but the schema accepts anything.
  - It blocks enterprise reporting questions such as "show leads where field X = Y", "count bookings by answer value", or "compare conversion rates by intake question response".
  - The UI also has to defensively treat custom fields as unknown because the schema does not protect it.
- Recommended fix:
  - Short-term hardening: change `customFields` to `v.record(v.string(), v.string())` if you need a minimally invasive improvement.
  - Enterprise model: move to normalized answer rows, for example:
    - `leadCustomFieldValues`
      - `tenantId`
      - `leadId`
      - `eventTypeConfigId`
      - `sourceMeetingId`
      - `fieldKey`
      - `fieldValue`
      - `capturedAt`
    - optional `customFieldDefinitions` / mapping dimension if you want semantic normalization across event types
  - Keep a derived display blob only if the UI needs it, but do not make it the source of truth.
- Migration required: Yes. This needs a widen-migrate-narrow rollout and likely the `convex-migration-helper` skill.

### Finding 3: Several important dashboards compute aggregates by scanning operational tables on read

- Severity: High
- Affected:
  - `convex/dashboard/adminStats.ts:24-111`
  - `convex/customers/queries.ts:12-80`
  - `convex/customers/queries.ts:146-215`
  - `convex/eventTypeConfigs/queries.ts:46-108`
- Why it matters:
  - `getAdminDashboardStats` scans all tenant users, opportunities, and payment records every time the dashboard query runs.
  - `listCustomers` and `getCustomerTotalPaid` recompute payment totals from raw payment rows on read.
  - `getEventTypeConfigsWithStats` rescans all tenant opportunities to compute booking counts and last-booking timestamps.
  - These are exactly the reads that should become cheap as the app scales; today they are O(n) in the underlying operational tables.
  - Because Convex queries are reactive, scan-heavy reads also increase invalidation cost.
- Recommended fix:
  - Add maintained summary documents or tables, for example:
    - `tenantDashboardStats`
    - `customerRevenueSummaries`
    - `eventTypeStats`
  - Maintain them in the same mutations that already change the source-of-truth rows.
  - Where counts/sums are enough, consider an aggregate-style component or equivalent pattern.
- Migration required: No for new summary tables. Yes if you want backfilled historical summaries.

### Finding 4: Closer scheduling and pipeline reads still depend on scan + filter patterns

- Severity: High
- Affected:
  - `convex/closer/dashboard.ts:13-75`
  - `convex/closer/dashboard.ts:85-119`
  - `convex/closer/calendar.ts:15-84`
  - `convex/closer/pipeline.ts:24-69`
  - `convex/unavailability/shared.ts:75-150`
  - `convex/unavailability/shared.ts:153-240`
- Why it matters:
  - The app repeatedly:
    - collects all opportunities for a closer
    - filters by status in memory
    - scans tenant meetings by date
    - filters those meetings back down by opportunity ownership
  - This is workable for a small tenant, but it is not a strong long-term shape for calendars, next-meeting widgets, redistribution, or any future schedule-based analytics.
- Recommended fix:
  - Minimum index fix:
    - add `opportunities.by_tenantId_and_assignedCloserId_and_status`
  - Better scheduling model:
    - denormalize `assignedCloserId` onto `meetings` and index it for schedule reads:
      - `meetings.by_tenantId_and_assignedCloserId_and_scheduledAt`
      - optionally `meetings.by_tenantId_and_assignedCloserId_and_status_and_scheduledAt` if the actual query mix justifies it
  - If you do not want that denormalization, introduce a meeting digest / schedule table that is explicitly read-optimized.
  - Paginate pipeline lists instead of returning unbounded arrays.
- Migration required: Index-only if you stop at compound opportunity indexes. Yes if you denormalize closer ownership onto `meetings`.

### Finding 5: List queries apply important business filters after pagination or search, so results are incomplete by construction

- Severity: Medium
- Affected:
  - `convex/leads/queries.ts:64-156`
  - `convex/leads/queries.ts:160-209`
  - `convex/customers/queries.ts:12-80`
  - `convex/schema.ts:124-156`
- Why it matters:
  - `listLeads` paginates by `tenantId`, then removes merged leads in memory for the default "active-like" view.
  - `searchLeads` fetches up to 40 search hits, then filters statuses and truncates to 20.
  - `listCustomers` paginates all tenant customers, then removes rows not owned by the closer.
  - Result: pages can be short even when more matching documents exist later, and search relevance gets distorted by post-filtering.
  - The root cause on leads is the legacy optional `status`; "active" is split across `undefined` and `"active"`.
- Recommended fix:
  - Backfill `leads.status` and make it required.
  - Move active/converted/merged filters into the indexed query shape.
  - Add:
    - `customers.by_tenantId_and_convertedByUserId`
    - likely `customers.by_tenantId_and_convertedByUserId_and_status`
  - Treat post-paginate filtering as a temporary migration shim, not a steady-state pattern.
- Migration required: Yes for `leads.status`. Index additions only for the customer-side fix.

### Finding 6: A handful of missing relationship indexes are forcing capped scans where exact lookups should exist

- Severity: High
- Affected:
  - `convex/leads/queries.ts:253-353`
  - `convex/leads/merge.ts:201-214`
  - `convex/webhooks/calendlyMutations.ts:15-29`
  - `convex/closer/followUpQueries.ts:9-21`
  - `convex/schema.ts:208-253`
  - `convex/schema.ts:456-520`
- Why it matters:
  - `getLeadDetail` reads follow-ups by tenant and then filters by `leadId`.
  - `executeMerge` clears duplicate flags by taking the first 500 tenant opportunities and filtering on `potentialDuplicateLeadId`.
  - `persistRawEvent` scans all events for `(tenantId, eventType)` and compares `calendlyEventUri` in code.
  - `getActiveReminders` fetches all pending follow-ups for a closer and then filters by `type`.
  - These are avoidable misses. The relationships are known and stable.
- Recommended fix:
  - Add:
    - `followUps.by_tenantId_and_leadId`
    - `opportunities.by_tenantId_and_potentialDuplicateLeadId`
    - `rawWebhookEvents.by_tenantId_and_eventType_and_calendlyEventUri`
    - `followUps.by_tenantId_and_closerId_and_status_and_type`
  - For reporting over time, also consider:
    - `paymentRecords.by_tenantId_and_recordedAt`
    - `paymentRecords.by_customerId_and_recordedAt`
- Migration required: Yes for index additions on large existing tables, ideally with staged rollout where needed.

### Finding 7: Event type configuration uniqueness is not trusted strongly enough

- Severity: High
- Affected:
  - `convex/pipeline/inviteeCreated.ts:685-717`
  - `convex/pipeline/inviteeCreated.ts:771-838`
  - `convex/eventTypeConfigs/mutations.ts:141-170`
- Why it matters:
  - The pipeline lookup explicitly loads up to 8 configs for the same `(tenantId, calendlyEventTypeUri)` and picks the oldest one.
  - The code even logs when multiple configs exist, which means the invariant is already considered weak in practice.
  - For analytics, `eventTypeConfigs` is a dimension table. Duplicate dimension rows for the same real-world event type create broken joins, split metrics, and ambiguous field mappings.
- Recommended fix:
  - Run a one-time dedupe migration for `eventTypeConfigs`.
  - Pick a canonical row per `(tenantId, calendlyEventTypeUri)`.
  - Repoint dependents if necessary.
  - Funnel all future writes through a single upsert path and remove duplicate-tolerant read logic once the migration is complete.
- Migration required: Yes.

### Finding 8: `paymentRecords` and `followUps` are too polymorphic for clean validation and reporting

- Severity: Medium
- Affected:
  - `convex/schema.ts:456-520`
  - `convex/closer/payments.ts:115-176`
  - `convex/customers/conversion.ts:118-139`
- Why it matters:
  - `paymentRecords` can represent:
    - a pre-conversion payment attached to an opportunity/meeting
    - a post-conversion customer payment with no opportunity/meeting
    - a backfilled hybrid row that later gains `customerId`
  - `followUps` can represent both scheduling links and manual reminders, but the schema encodes that with nullable fields instead of a discriminated model.
  - This makes validation weaker and analytics logic branchy.
- Recommended fix:
  - Either split by subtype or add explicit discriminants:
    - `paymentRecords.contextType` with strict allowed field combinations
    - `followUps.type` required, plus subtype-specific required fields
  - If you keep one table, make the discriminator required and write validators/helpers around it.
  - Decide and document whether `customers` is a snapshot projection or a canonical entity separate from `leads`.
- Migration required: Yes.

### Finding 9: Tenant offboarding currently leaves orphaned tenant-scoped data behind

- Severity: High
- Affected:
  - `convex/admin/tenants.ts:700-734`
  - `convex/admin/tenantsMutations.ts:65-126`
- Why it matters:
  - There are 14 tenant-scoped child tables in the schema.
  - The offboarding batch only deletes:
    - `rawWebhookEvents`
    - `calendlyOrgMembers`
    - `users`
  - It then deletes the `tenants` row.
  - That leaves orphaned records in tables like `leads`, `leadIdentifiers`, `opportunities`, `meetings`, `customers`, `paymentRecords`, `followUps`, `eventTypeConfigs`, `closerUnavailability`, `meetingReassignments`, and `leadMergeHistory`.
  - This is both a data lifecycle defect and an analytics contamination risk.
- Recommended fix:
  - Either:
    - perform full tenant-scoped cascading cleanup across every child table, batched and scheduled, or
    - soft-delete/suspend the tenant and prevent reads until a full archival/deletion workflow completes
  - Do not delete the tenant root row until all dependent tenant-scoped data is handled.
- Migration required: No schema migration is required to fix the code path, but historical orphan cleanup is required in production.

## 3. Query and index matrix

| Query shape | Current path | Current index used | Expected scale | Risk | Recommended index or rewrite |
| --- | --- | --- | --- | --- | --- |
| Admin dashboard counts and sums | `convex/dashboard/adminStats.ts` | `users.by_tenantId`, `opportunities.by_tenantId`, `paymentRecords.by_tenantId` | Grows with all tenant data | High | Replace scan-on-read with summary docs / aggregate tables |
| Closer next meeting | `convex/closer/dashboard.ts:getNextMeeting` | `opportunities.by_tenantId_and_assignedCloserId`, `meetings.by_tenantId_and_scheduledAt` | Grows with tenant meetings and closer opps | High | Add meeting ownership digest or denormalize `assignedCloserId` onto meetings |
| Closer pipeline by status | `convex/closer/pipeline.ts` | `opportunities.by_tenantId_and_assignedCloserId` then JS filter | Grows with closer book size | Medium | Add `opportunities.by_tenantId_and_assignedCloserId_and_status`; paginate |
| Closer calendar range | `convex/closer/calendar.ts` | `opportunities.by_tenantId_and_assignedCloserId`, `meetings.by_tenantId_and_scheduledAt` | Grows with tenant meeting volume | High | Same fix as next-meeting path; current shape scans tenant range then filters |
| Redistribution / availability schedule build | `convex/unavailability/shared.ts` | same as above | Grows with team size and daily meetings | High | Same meeting ownership denormalization or digest |
| Lead list default view | `convex/leads/queries.ts:listLeads` | `leads.by_tenantId` paginate + post-filter | Grows with merged leads and opps/lead | Medium | Backfill required lead status; move filter into indexed query |
| Lead search default view | `convex/leads/queries.ts:searchLeads` | `search_leads` by tenant only + post-filter | Grows with mixed-status leads | Medium | Backfill `status`; keep search filter purely indexed |
| Lead detail follow-ups | `convex/leads/queries.ts:getLeadDetail` | `followUps.by_tenantId` + filter by lead | Grows with tenant follow-up volume | High | Add `followUps.by_tenantId_and_leadId` |
| Merge duplicate-flag cleanup | `convex/leads/merge.ts` | `opportunities.by_tenantId` + filter by `potentialDuplicateLeadId` | Grows with tenant opportunities | High | Add `opportunities.by_tenantId_and_potentialDuplicateLeadId` |
| Customer list for closer | `convex/customers/queries.ts:listCustomers` | `customers.by_tenantId[_and_status]` paginate + role filter | Grows with tenant customer base | High | Add `customers.by_tenantId_and_convertedByUserId[_and_status]` |
| Customer revenue totals | `convex/customers/queries.ts` | `paymentRecords.by_customerId` + `.collect()` | Grows with payment history | Medium | Denormalize totals to customer summary; add date indexes if reporting by time |
| Event type stats | `convex/eventTypeConfigs/queries.ts:getEventTypeConfigsWithStats` | `eventTypeConfigs.by_tenantId`, `opportunities.by_tenantId` | Grows with opportunity count | Medium | Maintain `eventTypeStats` or add an explicit summary path |
| Raw webhook duplicate detection | `convex/webhooks/calendlyMutations.ts` | `rawWebhookEvents.by_tenantId_and_eventType` + URI compare | Grows with webhook volume | High | Add `rawWebhookEvents.by_tenantId_and_eventType_and_calendlyEventUri` |
| Active reminders | `convex/closer/followUpQueries.ts` | `followUps.by_tenantId_and_closerId_and_status` + type filter | Grows with follow-up volume | Medium | Add `...and_type` or split reminder subtype |
| Admin opportunity list with both status + closer filters | `convex/opportunities/queries.ts:listOpportunitiesForAdmin` | `opportunities.by_tenantId_and_status` or `...assignedCloserId` | Grows with pipeline | Medium | Add `opportunities.by_tenantId_and_assignedCloserId_and_status`; paginate if list keeps growing |

## 4. Integrity and atomicity review

### What is already good

- Tenant boundaries are derived server-side through `requireTenantUser` in `convex/requireTenantUser.ts`.
- Public Convex functions reviewed during this audit use argument validators.
- No database `.filter(...)` anti-patterns or `.collect().length` counting anti-patterns were found in `convex/`.
- Important denormalized fields are maintained through explicit helpers, especially `updateOpportunityMeetingRefs` in `convex/lib/opportunityMeetingRefs.ts`.
- `leadMergeHistory` and `meetingReassignments` are proper immutable audit tables instead of embedded mutable arrays.

### Ownership and tenant boundaries

Strong overall:

- Every operational table carries `tenantId` except the tenant root itself.
- Most reads validate tenant ownership before returning data.
- `leadIdentifiers`, `opportunities`, `meetings`, `customers`, and payment flows all verify tenant membership before mutating.

Risk:

- Offboarding breaks tenant lifecycle integrity today by deleting the tenant before deleting all tenant-owned children.

### Reference validation and orphan risk

Mostly good on writes, but not fully encoded in schema:

- `paymentRecords` uses optional foreign keys, so the schema itself cannot prevent invalid context combinations.
- `followUps` similarly allows partially populated rows for different subtypes.
- `customers` duplicates lead identity facts; whether those are snapshots or canonical post-conversion attributes is not made explicit in schema design.
- Offboarding currently creates orphans.

### Write atomicity

Generally solid:

- `logPayment` creates the payment, transitions opportunity status, and triggers conversion in one mutation path.
- `mergeLead` moves opportunities and identifiers and writes merge history in one mutation.
- Webhook processing is properly staged as `persist raw -> schedule async processor`.

Things to improve:

- Business event facts are not written alongside state transitions because those tables do not exist yet.
- Reporting summaries are not updated atomically because they do not exist yet.

### Denormalized-field maintenance

Good patterns present:

- `opportunities.latestMeeting*` and `nextMeeting*` are maintained through a single helper.
- `leads.searchText` and `socialHandles` are refreshed from normalized identity data rather than treated as canonical.

Open question to document:

- `meetings.leadName` and `customers` lead-profile fields behave like snapshots. That is fine, but it should be explicitly documented as snapshot behavior so later engineers do not try to keep them perfectly synchronized without a deliberate policy.

## 5. Migration notes

### Safe changes that can ship directly

- Add new append-only analytics event tables and start writing new events.
- Add summary tables alongside current reads, then switch readers over after backfill.
- Add new indexes where the table size is still small enough for a normal deploy.
- Fix the tenant offboarding code path without changing document shapes.

### Changes that need widen-migrate-narrow

- Making `leads.status` required instead of optional
- Replacing `leads.customFields` with a typed or normalized model
- Adding explicit discriminants to `paymentRecords` and `followUps`
- Splitting `tenants` into stable profile vs integration/onboarding state if you choose to do that
- Adding denormalized `assignedCloserId` to `meetings` if you use that design

### Index additions that may need staged rollout

- `rawWebhookEvents.by_tenantId_and_eventType_and_calendlyEventUri`
- `followUps.by_tenantId_and_leadId`
- `followUps.by_tenantId_and_closerId_and_status_and_type`
- `opportunities.by_tenantId_and_potentialDuplicateLeadId`
- `opportunities.by_tenantId_and_assignedCloserId_and_status`
- `customers.by_tenantId_and_convertedByUserId`
- `customers.by_tenantId_and_convertedByUserId_and_status`
- `paymentRecords.by_tenantId_and_recordedAt`
- `paymentRecords.by_customerId_and_recordedAt`

### Historical cleanup required

- Deduplicate `eventTypeConfigs` by `(tenantId, calendlyEventTypeUri)`
- Audit for orphaned tenant-scoped rows left behind by prior offboarding runs
- If `leads.status` becomes required, backfill all legacy rows to `"active"` or their true business state

## 6. Remediation plan

### Immediate

1. Fix tenant offboarding so every tenant-scoped table is handled before the tenant row is deleted.
2. Decide the analytics architecture now:
   - UI clickstream stays in PostHog
   - authoritative business facts become append-only Convex event tables
3. Add the highest-value missing indexes:
   - `followUps.by_tenantId_and_leadId`
   - `opportunities.by_tenantId_and_potentialDuplicateLeadId`
   - `rawWebhookEvents.by_tenantId_and_eventType_and_calendlyEventUri`
   - `customers.by_tenantId_and_convertedByUserId`
4. Deduplicate `eventTypeConfigs` and collapse future creation to one canonical write path.

### Next

1. Replace `leads.customFields` with a typed or normalized answer model.
2. Backfill `leads.status` and remove post-paginate/post-search filtering.
3. Add summary tables for:
   - tenant dashboard stats
   - customer revenue totals
   - event type booking stats
4. Make `paymentRecords` and `followUps` explicitly discriminated.
5. Add time-based payment indexes if revenue-over-time reporting is needed inside Convex before an OLAP export exists.

### Later

1. If calendar and redistribution reads become hot, denormalize meeting ownership (`assignedCloserId`) or build a meeting schedule digest.
2. Split the overloaded `tenants` document into:
   - tenant profile
   - onboarding/invite state
   - integration credentials/state
   - webhook subscription state
3. Stream authoritative business facts into a warehouse for true analytics/reporting.

## Bottom line

The current schema is good enough for operating the CRM, but not yet good enough for the analytics/reporting goal you described.

The strongest parts of the model are:

- tenant-scoped core entities
- normalized lead identity via `leadIdentifiers`
- justified denormalized meeting refs
- immutable audit tables for merges and reassignments

The main blockers are:

- no first-class analytics fact model
- an untyped `customFields` blob
- scan-on-read aggregates
- a few missing relationship indexes
- polymorphic tables that are hard to query cleanly
- a real tenant-offboarding orphan risk

If you want this system to become enterprise-class for reporting, the next iteration should focus less on adding speculative indexes everywhere and more on:

1. making facts immutable and relational,
2. tightening the few weak schemas,
3. moving recurring aggregates to maintained read models,
4. reserving OLAP-style reporting for an external warehouse.
