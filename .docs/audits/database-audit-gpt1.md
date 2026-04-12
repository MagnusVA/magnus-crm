# Database Audit

Date: 2026-04-11

Scope:
- `convex/schema.ts`
- Public and internal Convex queries, mutations, actions, and maintenance jobs
- Current app-side analytics capture points
- Runtime spot check via `npx convex insights --details` on 2026-04-11

Runtime signal snapshot:
- Convex Insights reported 2 warnings in the last 72 hours.
- One of them was `webhooks/calendlyMutations.persistRawEvent`, with 2 OCC conflicts on `rawWebhookEvents` on 2026-04-10.
- That signal supports the code-level finding that webhook dedupe and ingest uniqueness are currently soft.

This audit is focused on whether the current data model can support future CRM reporting and analytics without falling back to full scans, ambiguous joins, or lossy historical inference. The short version is:

- The schema is strong for day-to-day CRM operations.
- The schema is not yet strong enough for serious reporting.
- The biggest gap is not just missing indexes; it is that the model is mostly current-state oriented, while analytics needs append-only facts and durable transition history.

## 1. Domain and data model summary

### Core domain tables

| Area | Tables | Role today |
| --- | --- | --- |
| Tenant and auth | `tenants`, `users` | Tenant identity, WorkOS linkage, role membership, Calendly linkage |
| CRM entities | `leads`, `leadIdentifiers`, `opportunities`, `meetings`, `customers`, `paymentRecords`, `followUps` | Operational source of truth for the sales workflow |
| Integration support | `rawWebhookEvents`, `calendlyOrgMembers`, `eventTypeConfigs` | Calendly ingest, org-member sync, event-type overlays |
| History / audit-like tables | `leadMergeHistory`, `meetingReassignments`, `closerUnavailability` | Narrow workflow history for merges and reassignments |

### Good patterns already in place

- Tenant isolation is a first-class concern. Every operational table carries `tenantId`, and access is derived server-side via `requireTenantUser`.
- Cross-table relationships use typed `v.id("table")` references instead of raw strings.
- Status-like fields are usually modeled with unions/literals instead of freeform strings.
- A few denormalizations are purposeful and useful:
  - `leads.searchText`
  - `leads.socialHandles`
  - `opportunities.latestMeetingId/latestMeetingAt`
  - `opportunities.nextMeetingId/nextMeetingAt`
  - `meetings.leadName`
  - `users.calendlyMemberName`

### Existing denormalized and derived read models

- `leads.searchText` is a search-oriented denormalization.
- `opportunities.latestMeeting*` and `nextMeeting*` are read-optimized summary fields.
- `customers` is a snapshot-style derived entity created from `leads` and `opportunities`.
- `leadMergeHistory` and `meetingReassignments` are event-like history tables, but only for those two workflows.

### What the model supports well today

- Current-state pipeline views
- Tenant-scoped operational pages
- Lead search
- Meeting scheduling views
- Basic customer conversion tracking
- Narrow workflow histories for merge and reassignment

### What the model does not support well today

- Funnel transition counts over time
- Time-in-stage and stage-to-stage duration reporting
- Historical assignment history beyond meeting reassignment
- Team lifecycle analytics such as invite-to-accept latency
- Feature adoption reporting inside Convex
- Reliable filtering on custom-field values
- Currency-safe revenue analytics
- Cross-cutting activity timelines built from first-class facts

## 2. Findings

### Finding 1

- Severity: High
- Affected area: `convex/admin/tenants.ts`, `convex/admin/tenantsMutations.ts`
- Why it matters:
  The tenant offboarding flow deletes the tenant after only cleaning `rawWebhookEvents`, `calendlyOrgMembers`, and `users`. It does not delete `leads`, `leadIdentifiers`, `leadMergeHistory`, `opportunities`, `meetings`, `customers`, `paymentRecords`, `followUps`, `meetingReassignments`, `closerUnavailability`, or `eventTypeConfigs`. That creates orphaned tenant-scoped records and will contaminate future reporting.
- Evidence:
  - `convex/admin/tenantsMutations.ts:65-120`
  - `convex/admin/tenants.ts:701-730`
- Recommended fix:
  Replace the current partial cleanup with a full cascade plan across every tenant-scoped table, or switch to soft-delete plus asynchronous purge. Before introducing broader reporting, run an orphan audit across all tables keyed by `tenantId`.
- Migration required:
  No schema migration is required to fix the code path, but a one-time cleanup job is likely required for any already-orphaned data.

### Finding 2

- Severity: High
- Affected area: `opportunities`, `meetings`, `followUps`, `users`, app-side analytics capture
- Why it matters:
  The model stores mostly current state, not lifecycle facts. Opportunity status is overwritten in place. Follow-up status is overwritten in place. Meetings capture some state transitions, but not a general event history. Users do not carry core lifecycle timestamps like `invitedAt`, `acceptedAt`, or `removedAt`. App-side feature analytics are mostly captured in PostHog, not in Convex. That means many future reports would have to infer history from snapshots, which is brittle or impossible.
- Evidence:
  - `convex/schema.ts:53-81` (`users` has no lifecycle timestamps)
  - `convex/schema.ts:208-253` (`opportunities` stores only current status plus `createdAt` / `updatedAt`)
  - `convex/schema.ts:255-338` (`meetings` stores some lifecycle fields but not a general event log)
  - `convex/schema.ts:481-520` (`followUps` stores current status, not full transition history)
  - Client-side `posthog.capture(...)` calls exist in `app/`, but there is no Convex-side event table mirroring them
- Recommended fix:
  Introduce append-only business fact tables before report requirements harden. Minimum recommended set:
  - `opportunityEvents`
  - `meetingEvents`
  - `followUpEvents`
  - `userMembershipEvents`
  - `featureUsageEvents` only for CRM-owned usage analytics that must be queryable in Convex

  Each event should at minimum carry:
  - `tenantId`
  - `entityType`
  - `entityId`
  - `eventType`
  - `occurredAt`
  - `actorUserId` or `source`
  - `metadata`

  Keep high-volume raw clickstream in PostHog if that remains the product-analytics sink, but do not rely on PostHog alone for business reporting that needs to join cleanly with CRM entities.
- Migration required:
  Additive only to start. Backfill can be partial and approximate, but historical completeness will only begin after the new event tables are live.

### Finding 3

- Severity: High
- Affected area: `paymentRecords`, `dashboard/adminStats`, `customers/queries`
- Why it matters:
  Payments are stored as floating-point numbers (`v.number()`), and the main admin revenue aggregation simply sums all non-disputed payment amounts regardless of `currency`. That makes money analytics unsafe in two ways:
  - floating-point arithmetic is not ideal for money
  - summing USD, EUR, HNL, etc. into one number is analytically invalid
- Evidence:
  - `convex/schema.ts:456-479`
  - `convex/dashboard/adminStats.ts:78-88`
  - `convex/customers/queries.ts:57-63`
  - `convex/customers/queries.ts:147-154`
  - `convex/customers/queries.ts:206-214`
- Recommended fix:
  Move toward:
  - integer minor units, e.g. `amountMinor`
  - normalized ISO currency codes
  - explicit tenant currency policy or per-currency aggregates
  - reporting indexes such as:
    - `by_tenantId_and_recordedAt`
    - `by_tenantId_and_status_and_recordedAt`
    - `by_customerId_and_recordedAt`

  Also add a summary model for revenue widgets so dashboards do not rescan all payment records reactively.
- Migration required:
  Yes. This is a widen-migrate-narrow change if you replace `amount`.

### Finding 4

- Severity: High
- Affected area: `customers.listCustomers`, `closer.getActiveReminders`, `leads.listLeads`, `leads.searchLeads`, `leads.getLeadDetail`, `closer.getNextMeeting`
- Why it matters:
  Several live query paths already filter after pagination or after a bounded `take`, which means they can return incomplete or sparse results:
  - closers paginate all tenant customers, then filter their own customers client-side
  - reminders fetch 50 pending follow-ups, then filter to `manual_reminder`
  - lead detail fetches 200 tenant follow-ups, then filters by `leadId`
  - lead list/search overfetch because `active` is partly represented by `undefined`
  - next-meeting lookup collects all closer opportunities, then scans upcoming tenant meetings
- Evidence:
  - `convex/customers/queries.ts:30-80`
  - `convex/closer/followUpQueries.ts:9-39`
  - `convex/leads/queries.ts:76-93`
  - `convex/leads/queries.ts:178-198`
  - `convex/leads/queries.ts:253-285`
  - `convex/closer/dashboard.ts:20-55`
- Recommended fix:
  Rewrite these around indexes that match the real predicate instead of post-filtering:
  - customer list for closers:
    - `customers.by_tenantId_and_convertedByUserId`
    - `customers.by_tenantId_and_convertedByUserId_and_status`
  - reminder list:
    - `followUps.by_tenantId_and_closerId_and_type_and_status_and_reminderScheduledAt`
  - lead detail follow-ups:
    - `followUps.by_leadId`
    - or `followUps.by_tenantId_and_leadId_and_createdAt`
  - next meeting:
    - `opportunities.by_tenantId_and_assignedCloserId_and_status`
    - and/or a better opportunity-level summary read
- Migration required:
  Mostly additive indexes. `leads.status` cleanup is a separate migration item.

### Finding 5

- Severity: High
- Affected area: `leads.status`, `leads.listLeads`, `leads.searchLeads`
- Why it matters:
  `leads.status` is still optional, and the code treats `undefined` as equivalent to `"active"`. That keeps the read layer in permanent migration mode and makes analytics ambiguous. Any count, page, or search by lead status must remember this special-case behavior.
- Evidence:
  - `convex/schema.ts:119-126`
  - `convex/leads/queries.ts:35-52`
  - `convex/leads/queries.ts:76-93`
  - `convex/leads/queries.ts:178-198`
- Recommended fix:
  Run a widen-migrate-narrow rollout:
  1. Backfill every lead with explicit status
  2. Keep readers compatible during the migration window
  3. Make `status` required in schema
  4. Stop overfetching and JS-filtering active leads
- Migration required:
  Yes.

### Finding 6

- Severity: High
- Affected area: `leads.customFields`, `pipeline/inviteeCreated`
- Why it matters:
  `leads.customFields` is stored as `v.any()` and is built by merging all observed booking question/answer pairs into a single lead-level blob. That is convenient for display, but it is poor for analytics:
  - it is not indexable
  - it is not typed
  - it loses per-meeting provenance
  - it blurs "latest value" with "all observed values"
  - it can grow unbounded as a lead accumulates meetings and forms
- Evidence:
  - `convex/schema.ts:110-117`
  - `convex/pipeline/inviteeCreated.ts:30-66`
  - `convex/pipeline/inviteeCreated.ts:237-268`
- Recommended fix:
  Move custom field facts into their own table, for example:
  - `meetingCustomFieldFacts`
  - `leadAttributeFacts`

  Suggested fields:
  - `tenantId`
  - `leadId`
  - `meetingId`
  - `eventTypeConfigId`
  - `fieldKey`
  - `valueRaw`
  - `valueNormalized`
  - `valueType`
  - `observedAt`
  - optional `isLatestForLead`

  Keep a small lead-level summary if the UI still needs it, but do not treat the blob as the reporting source of truth.
- Migration required:
  Additive to start. If you eventually retire `customFields`, that becomes a migration.

### Finding 7

- Severity: Medium
- Affected area: `opportunities`, `meetings`, `followUps`, `paymentRecords`, `customers`, `users`
- Why it matters:
  The schema has the indexes needed for current UI screens, but not the foundational time/status/owner combinations that reporting nearly always needs. Right now the app leans heavily on `by_tenantId`, `by_tenantId_and_leadId`, `by_opportunityId`, and `by_tenantId_and_assignedCloserId`. That is enough for operational pages, but not enough for analytics-grade slicing.
- Evidence:
  Current schema coverage:
  - `opportunities`: only `tenantId`, `leadId`, `assignedCloserId`, `status`
  - `meetings`: only `opportunityId`, `tenantId + scheduledAt`, `tenantId + calendlyEventUri`
  - `paymentRecords`: only `opportunityId`, `tenantId`, `tenantId + closerId`, `customerId`
  - `customers`: no closer-specific index
  - `users`: no lifecycle timestamps or reporting indexes
- Recommended fix:
  Add a small, intentional analytics-ready index layer. The minimum likely set is:
  - `opportunities.by_tenantId_and_assignedCloserId_and_status`
  - `opportunities.by_tenantId_and_createdAt`
  - `opportunities.by_tenantId_and_updatedAt`
  - `opportunities.by_tenantId_and_eventTypeConfigId`
  - `meetings.by_opportunityId_and_scheduledAt`
  - `meetings.by_tenantId_and_status_and_scheduledAt`
  - `meetings.by_tenantId_and_meetingOutcome_and_scheduledAt`
  - `paymentRecords.by_tenantId_and_recordedAt`
  - `paymentRecords.by_customerId_and_recordedAt`
  - `customers.by_tenantId_and_convertedByUserId`
  - `customers.by_tenantId_and_convertedByUserId_and_status`
  - `followUps.by_leadId`
  - `followUps.by_tenantId_and_closerId_and_type_and_status_and_reminderScheduledAt`
- Migration required:
  Index additions only, but consider staged indexes on large tables.

### Finding 8

- Severity: Medium
- Affected area: `rawWebhookEvents`, `eventTypeConfigs`, `leadIdentifiers`, meeting ingest paths
- Why it matters:
  Uniqueness is treated as a code convention, not as a strongly owned invariant. The code already contains defensive behavior that assumes duplicates can exist:
  - `persistRawEvent` scans prior rows to dedupe
  - `inviteeCreated` picks the oldest event type config when multiple exist for the same URI
  - several business-key lookups use `.first()` instead of a truly canonical uniqueness strategy

  The runtime insights warning on `persistRawEvent` confirms this area is already under concurrency pressure.
- Evidence:
  - `convex/webhooks/calendlyMutations.ts:15-29`
  - `convex/pipeline/inviteeCreated.ts:685-717`
  - `convex/pipeline/inviteeCreated.ts:799-809`
- Recommended fix:
  For each business key, choose one canonical write owner and enforce uniqueness there:
  - raw webhook ingest: use a more precise dedupe key if available
  - event type config ownership: one mutation path only, plus cleanup for existing duplicates
  - customer conversion: keep a single owned conversion path
  - meeting ingest: keep `tenantId + calendlyEventUri` canonical

  Also schedule a one-time duplicate audit before building aggregate reporting on top.
- Migration required:
  Likely data cleanup, not necessarily schema change.

### Finding 9

- Severity: Low
- Affected area: `tenants`
- Why it matters:
  The `tenants` document mixes stable profile fields with high-churn Calendly token state, refresh locks, webhook provisioning state, and secrets. That is not the main blocker for analytics, but it is not ideal for long-term contention, reactivity, or boundary clarity.
- Evidence:
  - `convex/schema.ts:6-51`
- Recommended fix:
  Consider splitting integration state into a dedicated table such as `tenantCalendlyConnections` or `tenantIntegrations`, leaving `tenants` focused on business identity and lifecycle.
- Migration required:
  Yes, if you move the fields.

## 3. Query and index matrix

| Query shape | Current index / pattern | Expected scale | Risk | Recommended rewrite / index |
| --- | --- | --- | --- | --- |
| Closer customer list | `customers.by_tenantId` or `by_tenantId_and_status`, then filter `convertedByUserId` in JS | Medium | High | Add `customers.by_tenantId_and_convertedByUserId` and `by_tenantId_and_convertedByUserId_and_status` |
| Active reminders by closer ordered by due time | `followUps.by_tenantId_and_closerId_and_status`, then filter `type` and sort after fetch | Medium | High | Add `followUps.by_tenantId_and_closerId_and_type_and_status_and_reminderScheduledAt` |
| Lead detail follow-ups | `followUps.by_tenantId`, then filter `leadId` in JS | Medium | High | Add `followUps.by_leadId` or `by_tenantId_and_leadId_and_createdAt` |
| Lead list for active-like status | `leads.by_tenantId`, then filter out merged / treat `undefined` as active | Medium | High | Backfill explicit status, then query `by_tenantId_and_status` directly |
| Lead search for active-like status | `search_leads` + overfetch + JS filter | Medium | Medium | Backfill explicit status, then use search index filter on a required `status` |
| Closer next meeting | `opportunities.by_tenantId_and_assignedCloserId` + full `collect()` + scan tenant meetings by `scheduledAt` | Medium | High | Add `opportunities.by_tenantId_and_assignedCloserId_and_status`; consider summary read keyed by `nextMeetingAt` |
| Closer pipeline summary | `opportunities.by_tenantId_and_assignedCloserId`, then count in JS | Medium | Medium | Add `opportunities.by_tenantId_and_assignedCloserId_and_status` or digest counters |
| Event type stats | `opportunities.by_tenantId` full scan | Medium | Medium | Add `opportunities.by_tenantId_and_eventTypeConfigId`; consider summary table keyed by event type |
| Tenant dashboard totals | full scans on `users`, `opportunities`, `paymentRecords` | Medium | High | Maintain `tenantStats` digest / counters; add payment time indexes |
| Customer payment history and totals | `paymentRecords.by_customerId.collect()` | Medium | Medium | Add `paymentRecords.by_customerId_and_recordedAt`; use summary fields for list views |
| Revenue by time / provider / status | `paymentRecords.by_tenantId` only | Medium to Large | High | Add `by_tenantId_and_recordedAt`, `by_tenantId_and_status_and_recordedAt`, optionally `by_tenantId_and_provider_and_recordedAt` |
| Meetings by opportunity chronology | `meetings.by_opportunityId` only | Medium | Medium | Add `meetings.by_opportunityId_and_scheduledAt` |
| Opportunity reporting by time | no `createdAt` / `updatedAt` tenant indexes | Medium to Large | High | Add `opportunities.by_tenantId_and_createdAt` and `by_tenantId_and_updatedAt` |

Note:
- I would not add dozens of speculative compound indexes before report requirements are finalized.
- I would add the small set above because they support both current correctness and the most predictable reporting dimensions: tenant, owner, status, time, event type.

## 4. Integrity and atomicity review

### Ownership and tenant boundaries

- Strong overall.
- `requireTenantUser` derives identity server-side and verifies tenant membership before returning `tenantId`.
- Public functions generally validate IDs with `v.id("table")` and re-check ownership before writes.

### Reference validation and orphan risk

- Many mutations correctly validate parent-child ownership before writing:
  - payments validate meeting/opportunity linkage
  - no-show flow validates meeting/opportunity ownership
  - customer conversion validates lead and winning opportunity
- The biggest exception is tenant deletion, which currently leaves orphans.

### Write atomicity

- Most invariant-preserving operational writes are kept within one mutation, which is good.
- Denormalized meeting refs are updated in the same mutation path via `updateOpportunityMeetingRefs`, which is the right pattern.
- The app does rely on PostHog for some analytics capture outside Convex transactions. That is acceptable for product analytics, but not sufficient if the same facts must back authoritative CRM reporting.

### Denormalized-field maintenance

- Good:
  - `opportunities.latestMeeting*` / `nextMeeting*`
  - `leads.searchText`
  - `leads.socialHandles`
- Drift risks still exist:
  - `lead.email` and `lead.phone` overlap conceptually with `leadIdentifiers`
  - `customers` is a snapshot of lead data, so later lead edits do not change historical customer snapshot fields
  - `customFields` is merged over time and does not preserve origin

### Business-key uniqueness

- Soft, not hard.
- Duplicate handling is implemented ad hoc in code rather than modeled as a strongly owned invariant across all writers.
- That is manageable at small scale but dangerous once aggregate reporting depends on clean uniqueness.

## 5. Migration notes

### Safe additive changes that can ship directly

- Add append-only event tables
- Add optional lifecycle timestamps such as:
  - `invitedAt`
  - `acceptedAt`
  - `lostAt`
  - `canceledAt`
  - `bookedAt`
  - `expiredAt`
- Add new indexes for proven read paths
- Add digest / summary tables for dashboards and reporting widgets

### Breaking or migration-sensitive changes

- Make `leads.status` required
- Replace `paymentRecords.amount` float with integer minor units
- Split `tenants` integration state into its own table
- Retire `leads.customFields` as the reporting source of truth

These should use a widen-migrate-narrow strategy.

### Index additions that may need staged rollout

- `opportunities` new time and owner/status indexes
- `meetings.by_opportunityId_and_scheduledAt`
- `paymentRecords` reporting indexes
- `followUps` lead/reminder indexes
- any large-table index added after production data has grown materially

### Data cleanup work to schedule before reporting rollout

- Audit for orphaned tenant-scoped rows
- Audit for duplicate `eventTypeConfigs` by `(tenantId, calendlyEventTypeUri)`
- Audit for duplicate raw webhook rows by intended ingest key
- Audit payment currencies per tenant before any revenue dashboard is treated as authoritative

## 6. Remediation plan

### Immediate

1. Fix tenant offboarding so it cannot leave orphaned CRM data.
2. Stop treating revenue as a single summed number across arbitrary currencies.
3. Fix the query correctness issues already present:
   - closer customer pagination
   - active reminders
   - lead detail follow-ups
   - next meeting lookup
4. Start emitting append-only business events for:
   - opportunity transitions
   - meeting lifecycle changes
   - follow-up lifecycle changes
   - user invitation / acceptance / removal

### Next

1. Backfill `leads.status` and make it required.
2. Add the core reporting indexes listed in the matrix.
3. Introduce summary/digest records for dashboard cards and recurring reporting widgets.
4. Normalize custom-field facts so they are queryable and provenance-safe.
5. Add user lifecycle timestamps if team-growth and onboarding analytics matter.

### Later

1. Split `tenants` integration state from stable tenant business identity.
2. Clean up duplicate-prone business keys and reduce heuristic dedupe paths.
3. Decide what stays in PostHog only, what is mirrored into Convex, and what belongs in a warehouse or ETL layer.

## Bottom line

The current schema is a solid operational CRM schema, but it is not yet a reporting-ready schema.

The most important next move is not "add every possible index." It is:

1. preserve lifecycle facts as append-only events,
2. clean up the few current correctness risks,
3. normalize the fields you already know will matter for reporting,
4. then add a focused index layer around tenant + owner + status + time.

If that sequence is followed, you can keep the current CRM moving while building a reporting foundation that will not force full scans or historical guesswork later.
