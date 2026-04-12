# Convex Database Audit Report

> **Audit date**: 2026-04-11
> **Auditor**: Claude (following `convex-db-best-practices` skill guide)
> **Scope**: Full schema, query, mutation, and index audit of the ptdom-crm Convex backend
> **Constraint**: One production tenant with live data — all breaking changes require migration planning

---

## 1. Domain and Data Model Summary

### Main entities

| Table                  | Responsibility                                                        | Record type           |
| ---------------------- | --------------------------------------------------------------------- | --------------------- |
| `tenants`              | Multi-tenant root; identity, lifecycle state, Calendly OAuth, webhook config | Source of truth        |
| `users`                | CRM users linked to WorkOS and Calendly                               | Source of truth        |
| `leads`                | Contact records created from Calendly bookings or manual entry        | Source of truth        |
| `leadIdentifiers`      | Multi-identifier model (email, phone, social handles) per lead        | Source of truth        |
| `leadMergeHistory`     | Audit trail for lead merge operations                                 | Source of truth (log)  |
| `opportunities`        | Sales pipeline items; one per booking chain                           | Source of truth        |
| `meetings`             | Individual Calendly meetings within an opportunity                    | Source of truth        |
| `customers`            | Converted leads (post-sale)                                           | Source of truth (copy) |
| `paymentRecords`       | Payment receipts linked to opportunities/meetings                     | Source of truth        |
| `followUps`            | Follow-up scheduling and reminders                                    | Source of truth        |
| `closerUnavailability` | Closer time-off / unavailability windows                              | Source of truth        |
| `meetingReassignments`  | Audit trail for meeting redistributions                               | Source of truth (log)  |
| `eventTypeConfigs`     | Calendly event type CRM overlays (payment links, field mappings)      | Source of truth        |
| `calendlyOrgMembers`   | Synced Calendly org member cache                                      | Derived (sync cache)  |
| `rawWebhookEvents`     | Raw webhook payloads for replay and debugging                         | Source of truth (log)  |

### Existing denormalized fields

| Field                                         | On table        | Source of truth               | Maintained by                          |
| --------------------------------------------- | --------------- | ----------------------------- | -------------------------------------- |
| `latestMeetingId`, `latestMeetingAt`           | `opportunities` | `meetings`                    | `updateOpportunityMeetingRefs()` ✅     |
| `nextMeetingId`, `nextMeetingAt`               | `opportunities` | `meetings`                    | `updateOpportunityMeetingRefs()` ✅     |
| `socialHandles`                                | `leads`         | `leadIdentifiers`             | `updateLeadSocialHandles()` ✅          |
| `searchText`                                   | `leads`         | lead fields + identifiers     | `updateLeadSearchText()` ✅             |
| `calendlyMemberName`                           | `users`         | `calendlyOrgMembers`          | `upsertMember()` ✅                     |
| `leadName`                                     | `meetings`      | `leads.fullName`              | Set at creation only ⚠️ (never updated) |
| `hostCalendlyEmail`, `hostCalendlyName`        | `opportunities` | `calendlyOrgMembers` / user   | Set at creation only ⚠️ (never updated) |
| `fullName`, `email`, `phone`, `socialHandles`  | `customers`     | `leads` + `leadIdentifiers`   | Snapshot at conversion ⚠️ (intentional) |

---

## 2. Findings

### F-01: `tenants` table mixes stable identity with high-churn OAuth tokens

| | |
|---|---|
| **Severity** | High |
| **Affected** | `tenants` |
| **Why it matters** | Calendly OAuth tokens are refreshed every 90 minutes by a cron job. Each token refresh patches `calendlyAccessToken`, `calendlyRefreshToken`, `calendlyTokenExpiresAt`, and `lastTokenRefreshAt` on the tenant document. Every reactive query that reads `tenants` (e.g. `getCurrentTenant`, `getConnectionStatus`, auth guards) is invalidated on each refresh. This means all authenticated users see a subscription re-fire 16× per day for data that hasn't semantically changed. |
| **Fix** | Extract Calendly OAuth state into a dedicated `calendlyConnections` table with a `tenantId` foreign key. The `tenants` table keeps stable identity and lifecycle fields only. |
| **Migration** | Yes — breaking change. Requires widen-migrate-narrow via `convex-migration-helper`. |

### F-02: `leads.customFields` uses `v.any()` — untyped catch-all

| | |
|---|---|
| **Severity** | Medium |
| **Affected** | `leads` |
| **Why it matters** | `v.any()` bypasses schema validation. The shape of stored data is unknown at compile time and runtime. This prevents reliable analytics queries over custom field data, blocks type-safe access, and risks document-size blowup if arbitrary structures are written. |
| **Fix** | If custom fields have a known structure (Calendly question/answer pairs), define a typed validator: `v.optional(v.array(v.object({ question: v.string(), answer: v.string() })))`. If truly open-ended, use `v.optional(v.record(v.string(), v.string()))` to at least constrain value types. |
| **Migration** | Yes — type narrowing on existing documents. |

### F-03: `customers` table copies lead data — 3NF violation with no sync

| | |
|---|---|
| **Severity** | Medium |
| **Affected** | `customers` |
| **Why it matters** | When a lead converts to a customer, `fullName`, `email`, `phone`, and `socialHandles` are snapshotted from the lead. If the lead's contact info is later corrected (via manual edit or a new booking), the customer record drifts. For analytics/reporting, this creates two conflicting sources for the same contact's identity. |
| **Fix** | **Option A (preferred)**: Remove duplicated fields from `customers` and resolve contact info via the `leadId` reference at read time. Keep only customer-specific fields (`programType`, `status`, `notes`, conversion metadata). **Option B**: If read performance requires the snapshot, add a maintenance path that patches the customer when the linked lead's identity fields change. |
| **Migration** | Yes if removing fields (Option A). No if adding a sync path (Option B). |

### F-04: `meetings.leadName` is never updated after creation

| | |
|---|---|
| **Severity** | Low |
| **Affected** | `meetings` |
| **Why it matters** | `leadName` is set when the meeting is created from a webhook. If the lead's name is later corrected (via `updateLead` mutation or a subsequent booking with better name data), the meeting's `leadName` becomes stale. Meeting list UIs and reports that read `leadName` will show outdated names. |
| **Fix** | Either (a) maintain `leadName` in the same mutation that updates `leads.fullName`, or (b) resolve the name via `opportunityId → opportunity.leadId → lead.fullName` at query time and remove the denormalized field. |
| **Migration** | No if adding a sync path. Yes if removing the field (need backfill). |

### F-05: `opportunities.hostCalendlyEmail/Name` — stale denormalization

| | |
|---|---|
| **Severity** | Low |
| **Affected** | `opportunities` |
| **Why it matters** | These fields describe the Calendly host at booking time. If an org member updates their Calendly profile, or if the org member → user link changes, these fields drift. For analytics (closer attribution), the `assignedCloserId` is the authoritative reference; these host fields are redundant and potentially misleading. |
| **Fix** | Resolve host display name via `assignedCloserId → user → calendlyMemberName` at query time. Keep the fields as immutable historical snapshots (rename to `originalHost*` for clarity) or remove if not needed. |
| **Migration** | No (rename is safe; removal requires backfill). |

### F-06: `opportunities.calendlyEventUri` duplicates meeting-level data

| | |
|---|---|
| **Severity** | Low |
| **Affected** | `opportunities` |
| **Why it matters** | Each meeting already stores `calendlyEventUri`. The opportunity's `calendlyEventUri` is the first meeting's event URI. This is a 3NF violation — the same fact stored in two places. If an opportunity gains a follow-up meeting, the opportunity's `calendlyEventUri` still points to the original booking, which may be misleading. |
| **Fix** | For new code, resolve via `latestMeetingId` or the first meeting in the chain. Keep the field during transition but document it as the "original booking event URI" for attribution, not a canonical Calendly reference. |
| **Migration** | No (documentation change; field can remain as historical context). |

### F-07: No activity/event history table — analytics blind spot

| | |
|---|---|
| **Severity** | High |
| **Affected** | System-wide |
| **Why it matters** | The CRM needs analytics on what happened, when, and by whom. Currently, status changes happen in-place on `opportunities` and `meetings` — there is no queryable history of transitions. Questions like "how long was this opportunity in `scheduled` before moving to `in_progress`?", "what is the average time-to-payment by closer?", or "what is the no-show rate trend over time?" cannot be answered from the current model without scanning raw webhook events and inferring timestamps. |
| **Fix** | Add an `activityLog` (or `opportunityEvents`) table that records every significant state change with a timestamp, actor, and metadata. Each entry references the entity it describes via typed `Id` references. This becomes the foundation for analytics dashboards, funnel reporting, and audit trails. |
| **Migration** | No — additive change. New table, no existing data affected. |

### F-08: No time-in-status tracking on opportunities

| | |
|---|---|
| **Severity** | Medium |
| **Affected** | `opportunities` |
| **Why it matters** | To report on pipeline velocity (e.g. "average days from `scheduled` to `payment_received`"), the system needs to know when each status transition occurred. Currently only `createdAt` and `updatedAt` exist — `updatedAt` is overwritten on every patch, losing intermediate transition timestamps. |
| **Fix** | Either (a) add a `statusChangedAt` field on `opportunities` that records when the current status was set, or (b) rely on the `activityLog` table from F-07 for time-series analysis. Option (b) is more flexible and avoids adding more fields to an already large document. |
| **Migration** | No if using activityLog table. Yes if adding a field (backfill from `updatedAt`). |

### F-09: `paymentRecords.opportunityId` and `meetingId` are optional — breaks joins

| | |
|---|---|
| **Severity** | Medium |
| **Affected** | `paymentRecords` |
| **Why it matters** | If a payment record has no `opportunityId`, it cannot be attributed to a pipeline opportunity for reporting. The `logPayment` mutation always receives an `opportunityId` and `meetingId`, so these should not be optional in practice. The optionality was likely added for the `recordCustomerPayment` mutation (Feature D), which creates customer-level payments without an opportunity. This creates a data model split that complicates analytics joins. |
| **Fix** | **Short-term**: Audit existing records — if all have `opportunityId`, tighten the schema. **Long-term**: If customer-level payments are needed, consider a separate `customerPayments` table or make `opportunityId` required and link customer payments to the winning opportunity. |
| **Migration** | Yes if tightening validators. |

### F-10: Dashboard stats query scans entire tables — `.collect().length` equivalent

| | |
|---|---|
| **Severity** | High |
| **Affected** | `dashboard/adminStats.getAdminDashboardStats` |
| **Why it matters** | This query runs four unbounded async iterators over `users`, `opportunities`, `meetings`, and `paymentRecords` — effectively four full table scans per dashboard render. Every reactive subscriber re-fires when any record in any of these tables changes. At scale, this becomes a bandwidth and invalidation bottleneck. |
| **Fix** | Replace with a denormalized `tenantStats` summary document maintained by mutations. Each mutation that changes a count (new opportunity, status change, payment) atomically increments/decrements the counter. The dashboard reads a single document instead of scanning four tables. |
| **Migration** | No — additive. Create the table, backfill initial values, switch reads. |

### F-11: Closer pipeline queries use unbounded `.collect()`

| | |
|---|---|
| **Severity** | High |
| **Affected** | `closer/dashboard.getPipelineSummary`, `closer/pipeline.listMyOpportunities`, `closer/dashboard.getNextMeeting`, `closer/calendar.getMeetingsForRange` |
| **Why it matters** | These queries `.collect()` all opportunities for a given closer, then filter or enrich in JavaScript. A high-performing closer could accumulate hundreds of opportunities over time, all of which are loaded on every render. |
| **Fix** | (1) Add a composite index `by_tenantId_and_assignedCloserId_and_status` on `opportunities` to filter by status at the index level. (2) Use `.take(n)` or `.paginate()` with `order("desc")` to load only recent/active items. (3) For the pipeline summary (counting by status), maintain a per-closer summary document. |
| **Migration** | No — additive index and query changes. |

### F-12: Admin opportunity list uses unbounded async iterators

| | |
|---|---|
| **Severity** | High |
| **Affected** | `opportunities/queries.ts → listOpportunitiesForAdmin` |
| **Why it matters** | Collects all opportunities into an in-memory array via `for await` loop, then enriches each with N+1 lookups for leads, users, and event type configs. No `.take()` bound. With growth, this will hit transaction read limits and create large reactive payloads. |
| **Fix** | Paginate the query. Pre-aggregate enrichment data with `Promise.all` over batched ID sets rather than per-record lookups. Consider server-side pagination with `usePaginatedQuery`. |
| **Migration** | No. |

### F-13: O(n×m) nested loops in detail queries

| | |
|---|---|
| **Severity** | Medium |
| **Affected** | `leads/queries.ts → getLeadDetail`, `customers/queries.ts → getCustomerDetail`, `closer/meetingDetail.ts → getMeetingDetail` |
| **Why it matters** | These queries iterate through opportunities, then for each opportunity iterate through meetings. For a lead with 10 opportunities, each with 5 meetings, that's 50+ individual index lookups in a single reactive query. This pattern compounds with scale and causes excessive read bandwidth. |
| **Fix** | (1) For lead/customer detail: query meetings directly by `tenantId + scheduledAt` range and group in JS, rather than iterating per opportunity. (2) For meeting detail: the "all related meetings for this lead" view should be a separate bounded query, not embedded in the detail page query. (3) Consider a `by_tenantId_and_leadId` index on `meetings` (requires adding `leadId` to meetings or querying via opportunities). |
| **Migration** | No for query changes. Yes if adding a `leadId` field to meetings. |

### F-14: `eventTypeConfigs` stats query does two full table scans

| | |
|---|---|
| **Severity** | Medium |
| **Affected** | `eventTypeConfigs/queries.ts → getEventTypeConfigsWithStats` |
| **Why it matters** | Scans all event type configs, then scans all opportunities, aggregating counts by `eventTypeConfigId`. Two unbounded scans in a single reactive query. |
| **Fix** | Maintain a `meetingCount` / `opportunityCount` on the `eventTypeConfigs` record, updated when opportunities are created. Or compute stats asynchronously and cache. |
| **Migration** | No if adding denormalized counts (additive field). |

### F-15: `users/listTeamMembers` and related queries are unbounded

| | |
|---|---|
| **Severity** | Low |
| **Affected** | `users/queries.ts → listTeamMembers`, `listUnmatchedCalendlyMembers`, `getAvailableClosersForDate` |
| **Why it matters** | These use async iterators without bounds. Practically, team sizes in this CRM are small (< 50 users per tenant), so the risk is low. However, as a matter of correctness and defensive design, they should have explicit bounds. |
| **Fix** | Add `.take(200)` or similar safety limit. Paginate if the team management UI ever needs to support larger organizations. |
| **Migration** | No. |

### F-16: Missing indexes for analytics and reporting workloads

| | |
|---|---|
| **Severity** | High |
| **Affected** | Multiple tables |
| **Why it matters** | The current indexes serve operational read paths (pipeline by closer, meeting by event URI, lead by email). For analytics — filtering by time range, aggregating by status + closer, trending over time — the required composite indexes are missing. Without them, every analytics query becomes a full table scan. |
| **Fix** | See the index matrix in Section 3 below. |
| **Migration** | No — additive index additions. Consider staged indexes for large tables. |

### F-17: `followUps` has no index on `(opportunityId, status)`

| | |
|---|---|
| **Severity** | Medium |
| **Affected** | `followUps`, pipeline `markFollowUpBooked` |
| **Why it matters** | `markFollowUpBooked` iterates through all follow-ups for an opportunity to find one with status `pending`. The `by_opportunityId` index exists but there's no compound index for `(opportunityId, status)`, forcing a JavaScript filter. Additionally, the lead detail query loads 200 follow-ups by tenant and filters client-side. |
| **Fix** | Add index `by_opportunityId_and_status` on `followUps`. The lead detail query should use `by_tenantId_and_closerId_and_status` or add `by_leadId_and_status`. |
| **Migration** | No — additive. |

### F-18: `meetingReassignments` indexes are granular but missing the hot compound

| | |
|---|---|
| **Severity** | Low |
| **Affected** | `meetingReassignments` |
| **Why it matters** | The table has 5 individual indexes but `getRecentReassignments` queries by `tenantId` with `.order("desc").take(n)`. For reporting on reassignment patterns by closer over time, a `(tenantId, reassignedAt)` index would be more efficient. |
| **Fix** | Add `by_tenantId_and_reassignedAt` index. The existing `by_tenantId` index without a timestamp field means ordering by `_creationTime`, which is close but not semantically identical. |
| **Migration** | No. |

### F-19: `meetings` table lacks index for closer-scoped queries

| | |
|---|---|
| **Severity** | Medium |
| **Affected** | `meetings`, closer calendar and dashboard |
| **Why it matters** | There is no way to directly query meetings by closer. The current pattern requires first loading all opportunities for a closer, then querying meetings per opportunity. This is the root cause of the O(n×m) patterns in F-13. A meeting doesn't directly store `closerId` — it's resolved through `opportunity.assignedCloserId`. |
| **Fix** | **Option A**: Add a denormalized `assignedCloserId` field to `meetings` with an index `by_tenantId_and_assignedCloserId_and_scheduledAt`. Maintain it when opportunity assignment changes (via `autoDistributeMeetings`, `manuallyResolveMeeting`). **Option B**: Add a `by_tenantId_and_status_and_scheduledAt` compound index and filter meetings in a single pass. |
| **Migration** | Yes for Option A (new field on existing docs). No for Option B. |

### F-20: `rawWebhookEvents.payload` stored as `v.string()` — missed structured storage opportunity

| | |
|---|---|
| **Severity** | Low |
| **Affected** | `rawWebhookEvents` |
| **Why it matters** | The payload is stored as a JSON string, requiring `JSON.parse()` at every read. For analytics over webhook data (e.g. "which event types are most common?", "what is our webhook processing latency?"), the raw string cannot be indexed or queried. The `eventType` is already extracted — but other useful metadata (e.g. scheduledAt, cancellation reason) is buried in the string. |
| **Fix** | Keep the payload as a string for replay fidelity. Add extracted metadata fields (e.g. `bookingScheduledAt`, `eventTypeUri`) alongside the raw payload for analytics. Or accept this as a log table that is only accessed for debugging, not analytics. |
| **Migration** | No if adding optional fields. |

### F-21: Tenant deletion does not cascade to all data tables

| | |
|---|---|
| **Severity** | Medium |
| **Affected** | `admin/tenantsMutations.ts → deleteTenantRuntimeDataBatch` |
| **Why it matters** | The batch deletion mutation only cleans up `rawWebhookEvents`, `calendlyOrgMembers`, and `users`. It does **not** clean up `leads`, `opportunities`, `meetings`, `paymentRecords`, `customers`, `followUps`, `leadIdentifiers`, `leadMergeHistory`, `closerUnavailability`, `meetingReassignments`, or `eventTypeConfigs` — 11 tables left orphaned. |
| **Fix** | Extend `deleteTenantRuntimeDataBatch` to cover all tenant-scoped tables. Use the same batching pattern (`.take(128)` per table, return `hasMore` for continuation). |
| **Migration** | No — code change only. |

---

## 3. Query and Index Matrix

### Current indexes (46 total across 15 tables)

| Table                  | Index name                                  | Fields                                   | Used by                                  |
| ---------------------- | ------------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| `tenants`              | `by_contactEmail`                           | `[contactEmail]`                         | Tenant lookup during onboarding          |
| `tenants`              | `by_workosOrgId`                            | `[workosOrgId]`                          | Auth guards, tenant resolution           |
| `tenants`              | `by_status`                                 | `[status]`                               | Admin list, cron health checks           |
| `tenants`              | `by_inviteTokenHash`                        | `[inviteTokenHash]`                      | Invite redemption                        |
| `tenants`              | `by_status_and_inviteExpiresAt`             | `[status, inviteExpiresAt]`              | Invite cleanup cron                      |
| `users`                | `by_tenantId`                               | `[tenantId]`                             | Team list, closer list                   |
| `users`                | `by_workosUserId`                           | `[workosUserId]`                         | Auth guard (hot path)                    |
| `users`                | `by_tenantId_and_email`                     | `[tenantId, email]`                      | User lookup by email                     |
| `users`                | `by_tenantId_and_calendlyUserUri`           | `[tenantId, calendlyUserUri]`            | Host resolution from Calendly webhooks   |
| `rawWebhookEvents`     | `by_tenantId_and_eventType`                 | `[tenantId, eventType]`                  | Event filtering                          |
| `rawWebhookEvents`     | `by_calendlyEventUri`                       | `[calendlyEventUri]`                     | Duplicate detection                      |
| `rawWebhookEvents`     | `by_processed`                              | `[processed]`                            | Unprocessed event scan                   |
| `rawWebhookEvents`     | `by_processed_and_receivedAt`               | `[processed, receivedAt]`               | Stale event cleanup                      |
| `calendlyOrgMembers`   | `by_tenantId`                               | `[tenantId]`                             | Member list                              |
| `calendlyOrgMembers`   | `by_tenantId_and_calendlyUserUri`           | `[tenantId, calendlyUserUri]`            | Upsert lookup                            |
| `calendlyOrgMembers`   | `by_tenantId_and_matchedUserId`             | `[tenantId, matchedUserId]`              | Unmatched member filter                  |
| `calendlyOrgMembers`   | `by_tenantId_and_lastSyncedAt`              | `[tenantId, lastSyncedAt]`              | Stale member cleanup                     |
| `leads`                | `by_tenantId`                               | `[tenantId]`                             | Tenant-scoped lead list                  |
| `leads`                | `by_tenantId_and_email`                     | `[tenantId, email]`                      | Lead lookup from webhooks                |
| `leads`                | `by_tenantId_and_status`                    | `[tenantId, status]`                     | Active/merged/converted filter           |
| `leads`                | `search_leads` (search)                     | `searchText` + filter `[tenantId, status]` | Lead search                              |
| `leadIdentifiers`      | `by_tenantId_and_type_and_value`            | `[tenantId, type, value]`                | Identity resolution                      |
| `leadIdentifiers`      | `by_leadId`                                 | `[leadId]`                               | Lead detail                              |
| `leadIdentifiers`      | `by_tenantId_and_value`                     | `[tenantId, value]`                      | Cross-type identifier search             |
| `leadMergeHistory`     | `by_tenantId`                               | `[tenantId]`                             | Tenant-scoped audit list                 |
| `leadMergeHistory`     | `by_sourceLeadId`                           | `[sourceLeadId]`                         | Merge history for source                 |
| `leadMergeHistory`     | `by_targetLeadId`                           | `[targetLeadId]`                         | Merge history for target                 |
| `opportunities`        | `by_tenantId`                               | `[tenantId]`                             | Admin stats, full pipeline               |
| `opportunities`        | `by_tenantId_and_leadId`                    | `[tenantId, leadId]`                     | Lead detail, follow-up heuristic         |
| `opportunities`        | `by_tenantId_and_assignedCloserId`          | `[tenantId, assignedCloserId]`           | Closer pipeline, dashboard               |
| `opportunities`        | `by_tenantId_and_status`                    | `[tenantId, status]`                     | Pipeline by status                       |
| `meetings`             | `by_opportunityId`                          | `[opportunityId]`                        | Meeting refs, detail pages               |
| `meetings`             | `by_tenantId_and_scheduledAt`               | `[tenantId, scheduledAt]`                | Calendar, next meeting lookup            |
| `meetings`             | `by_tenantId_and_calendlyEventUri`          | `[tenantId, calendlyEventUri]`           | Webhook dedup, cancellation lookup       |
| `closerUnavailability` | `by_tenantId_and_date`                      | `[tenantId, date]`                       | Unavailability list                      |
| `closerUnavailability` | `by_closerId_and_date`                      | `[closerId, date]`                       | Closer availability check                |
| `meetingReassignments`  | `by_tenantId`                               | `[tenantId]`                             | Recent reassignments list                |
| `meetingReassignments`  | `by_meetingId`                              | `[meetingId]`                            | Meeting reassignment history             |
| `meetingReassignments`  | `by_toCloserId`                             | `[toCloserId]`                           | Incoming reassignment count              |
| `meetingReassignments`  | `by_fromCloserId`                           | `[fromCloserId]`                         | Outgoing reassignment count              |
| `meetingReassignments`  | `by_unavailabilityId`                       | `[unavailabilityId]`                     | Reassignments per unavailability         |
| `eventTypeConfigs`     | `by_tenantId`                               | `[tenantId]`                             | Config list                              |
| `eventTypeConfigs`     | `by_tenantId_and_calendlyEventTypeUri`      | `[tenantId, calendlyEventTypeUri]`       | Config lookup from webhooks              |
| `customers`            | `by_tenantId`                               | `[tenantId]`                             | Customer list                            |
| `customers`            | `by_tenantId_and_leadId`                    | `[tenantId, leadId]`                     | Lead → customer lookup                   |
| `customers`            | `by_tenantId_and_status`                    | `[tenantId, status]`                     | Filtered customer list                   |
| `customers`            | `by_tenantId_and_convertedAt`               | `[tenantId, convertedAt]`                | Time-sorted customer list                |
| `paymentRecords`       | `by_opportunityId`                          | `[opportunityId]`                        | Payments per opportunity                 |
| `paymentRecords`       | `by_tenantId`                               | `[tenantId]`                             | Admin stats, tenant payments             |
| `paymentRecords`       | `by_tenantId_and_closerId`                  | `[tenantId, closerId]`                   | Closer payment list                      |
| `paymentRecords`       | `by_customerId`                             | `[customerId]`                           | Customer payment list                    |
| `followUps`            | `by_tenantId`                               | `[tenantId]`                             | Tenant follow-up list                    |
| `followUps`            | `by_opportunityId`                          | `[opportunityId]`                        | Follow-ups per opportunity               |
| `followUps`            | `by_tenantId_and_closerId`                  | `[tenantId, closerId]`                   | Closer follow-up list                    |
| `followUps`            | `by_tenantId_and_closerId_and_status`       | `[tenantId, closerId, status]`           | Active reminders query                   |

### Recommended new indexes (for analytics and operational efficiency)

| Table               | Proposed index name                                         | Fields                                            | Purpose                                            | Risk  |
| -------------------- | ----------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------- | ----- |
| `opportunities`      | `by_tenantId_and_assignedCloserId_and_status`               | `[tenantId, assignedCloserId, status]`             | Closer pipeline by status (eliminates F-11 scans)  | Low   |
| `opportunities`      | `by_tenantId_and_createdAt`                                 | `[tenantId, createdAt]`                            | Time-series: new opportunities over time            | Low   |
| `opportunities`      | `by_tenantId_and_status_and_createdAt`                      | `[tenantId, status, createdAt]`                    | Pipeline cohort analysis by status + time range     | Low   |
| `meetings`           | `by_tenantId_and_status_and_scheduledAt`                    | `[tenantId, status, scheduledAt]`                  | Scheduled meetings in date range                    | Low   |
| `meetings`           | `by_opportunityId_and_scheduledAt`                          | `[opportunityId, scheduledAt]`                     | Meeting timeline per opportunity (sorted)           | Low   |
| `meetings`           | `by_tenantId_and_meetingOutcome`                            | `[tenantId, meetingOutcome]`                       | Outcome distribution analytics                      | Low   |
| `paymentRecords`     | `by_tenantId_and_status`                                    | `[tenantId, status]`                               | Payment verification dashboard                      | Low   |
| `paymentRecords`     | `by_tenantId_and_recordedAt`                                | `[tenantId, recordedAt]`                           | Revenue time-series                                 | Low   |
| `paymentRecords`     | `by_tenantId_and_closerId_and_recordedAt`                   | `[tenantId, closerId, recordedAt]`                 | Closer revenue time-series                          | Low   |
| `followUps`          | `by_opportunityId_and_status`                               | `[opportunityId, status]`                          | Fast pending follow-up lookup (pipeline handler)    | Low   |
| `followUps`          | `by_tenantId_and_status_and_createdAt`                      | `[tenantId, status, createdAt]`                    | Follow-up effectiveness analytics                   | Low   |
| `leads`              | `by_tenantId_and_firstSeenAt`                               | `[tenantId, firstSeenAt]`                          | Lead acquisition over time                          | Low   |
| `customers`          | `by_tenantId_and_convertedByUserId`                         | `[tenantId, convertedByUserId]`                    | Conversion attribution by user                      | Low   |
| `meetingReassignments` | `by_tenantId_and_reassignedAt`                             | `[tenantId, reassignedAt]`                         | Reassignment trends over time                       | Low   |

### Potentially redundant indexes

| Table               | Index                              | Reason potentially redundant                                       |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| `rawWebhookEvents`   | `by_processed`                     | Subsumed by `by_processed_and_receivedAt` (prefix match). Verify no callers use this alone before removing. |

---

## 4. Integrity and Atomicity Review

### Ownership and tenant boundaries

| Check | Status |
|-------|--------|
| Every public query/mutation validates tenancy | ✅ All public functions use `requireTenantUser()` which validates org → tenant mapping |
| Tenant ID derived server-side, not from client | ✅ `requireTenantUser` extracts from `ctx.auth.getUserIdentity()` |
| Role-based access control on all public functions | ✅ `requireTenantUser(ctx, allowedRoles)` validates role |
| System admin functions use separate guard | ✅ `requireSystemAdmin()` checks `SYSTEM_ADMIN_ORG_ID` |
| Internal functions omit tenant checks | ✅ Appropriate — internal functions are not publicly accessible |

### Reference validation and orphan risk

| Scenario | Status | Notes |
|----------|--------|-------|
| New opportunity references valid lead | ✅ | Pipeline handler validates lead exists |
| New meeting references valid opportunity | ✅ | Pipeline handler validates opportunity exists |
| Payment references valid opportunity + meeting | ✅ | `logPayment` validates both exist and belong to same chain |
| Customer references valid lead + opportunity | ✅ | `convertLeadToCustomer` validates all references |
| Follow-up references valid opportunity + lead + closer | ✅ | `createSchedulingLinkFollowUp` validates all |
| User deletion → orphan opportunities | ⚠️ | No cascade check. Deleting a closer (`removeUser`) does not reassign their opportunities or check for active pipeline items |
| Tenant deletion → orphan data | ⚠️ | `deleteTenantRuntimeDataBatch` only covers 3 of 14+ data tables (see F-21) |

### Write atomicity

| Pattern | Status | Notes |
|---------|--------|-------|
| Meeting status change + opportunity status change | ✅ | Always in same mutation (`startMeeting`, `markNoShow`, `inviteeCanceled`) |
| Opportunity status change + denormalized refs | ✅ | `updateOpportunityMeetingRefs()` called in same mutation |
| Lead merge: source patch + target patch + identifier move | ✅ | All in `mergeLead` mutation |
| Payment + opportunity status transition | ✅ | `logPayment` does both atomically |
| Follow-up creation + opportunity transition | ✅ | Same mutation in all follow-up flows |
| External API call + DB write | ✅ | Separated: actions call external APIs, then schedule mutations for DB writes |

### Denormalized-field maintenance

| Denormalized field | Maintained correctly? | Notes |
|---|---|---|
| `opportunities.latestMeeting*` / `nextMeeting*` | ✅ | `updateOpportunityMeetingRefs()` called in all relevant mutations |
| `leads.socialHandles` | ✅ | `updateLeadSocialHandles()` called after identifier changes |
| `leads.searchText` | ✅ | `updateLeadSearchText()` called after lead field or identifier changes |
| `users.calendlyMemberName` | ✅ | `upsertMember()` syncs on org member changes |
| `meetings.leadName` | ⚠️ | Set at creation only; not updated when lead name changes (F-04) |
| `opportunities.hostCalendly*` | ⚠️ | Set at creation only; not updated when member changes (F-05) |
| `customers.fullName/email/phone/socialHandles` | ⚠️ | Snapshot at conversion; not synced with lead changes (F-03) |

---

## 5. Migration Notes

### Safe changes (ship directly)

These changes are additive and do not affect existing documents:

1. **New indexes** — All 14 proposed indexes from Section 3 can be added immediately. None require data changes. Consider staging for `opportunities`, `meetings`, and `paymentRecords` if their row counts are significant.
2. **New `activityLog` table** — Purely additive; no existing schema affected.
3. **New `tenantStats` summary table** — Purely additive; backfill initial values from a one-time internal action.
4. **Query optimizations** — Replacing `.collect()` with `.take(n)` or `.paginate()`, adding `Promise.all` batching, eliminating N+1 patterns. All backward-compatible.
5. **Adding `.take()` bounds to unbounded async iterators** — No schema change needed.
6. **Extending tenant deletion cascade** — Code change only; no schema modification.

### Breaking changes (require widen-migrate-narrow)

These changes affect existing documents and require the `convex-migration-helper` skill:

1. **F-01: Extract `calendlyConnections` from `tenants`** — Move 8+ Calendly OAuth fields to a new table. Existing tenant documents need those fields removed. Widen: make them optional on tenants, add the new table. Migrate: copy data. Narrow: remove fields from tenants.
2. **F-02: Type `leads.customFields`** — Change `v.any()` to a typed validator. Existing documents with `customFields` must match the new type. Widen: keep `v.any()`, add a typed alias field. Migrate: transform existing data. Narrow: replace `v.any()` with typed field.
3. **F-09: Tighten `paymentRecords.opportunityId`** — Make optional → required. All existing records must have the field. Verify first; backfill any missing values.
4. **F-19 Option A: Add `assignedCloserId` to `meetings`** — New required field on existing meeting documents. Widen: add as optional. Migrate: backfill from opportunity. Narrow: make required.

### Index additions that may need staged rollout

If any table has > 10,000 rows, use staged indexes to avoid blocking deploys:

- `opportunities` — likely candidate as the pipeline grows
- `meetings` — likely candidate
- `paymentRecords` — depends on volume

---

## 6. Remediation Plan

### Immediate — correctness and security risks

| # | Finding | Action | Effort |
|---|---------|--------|--------|
| 1 | F-10: Dashboard full table scans | Add a `tenantStats` summary table; update mutations to maintain counts; switch dashboard query to single-document read | Medium |
| 2 | F-11: Closer pipeline unbounded `.collect()` | Add `by_tenantId_and_assignedCloserId_and_status` index on `opportunities`; rewrite closer queries to use it with `.take(n)` or `.paginate()` | Small |
| 3 | F-12: Admin opportunity list unbounded | Paginate `listOpportunitiesForAdmin` with `usePaginatedQuery`; batch enrichment lookups | Small |
| 4 | F-16: Missing analytics indexes | Add the 14 recommended indexes from Section 3 (all additive) | Small |
| 5 | F-17: Missing `followUps` compound index | Add `by_opportunityId_and_status` | Trivial |
| 6 | F-21: Tenant deletion cascade gap | Extend `deleteTenantRuntimeDataBatch` to cover all tenant-scoped tables | Medium |

### Next — performance and maintainability

| # | Finding | Action | Effort |
|---|---------|--------|--------|
| 7 | F-01: Tenant OAuth churn | Extract `calendlyConnections` table via migration | Large |
| 8 | F-07: No activity log | Design and add `activityLog` table; instrument status-change mutations to log transitions | Medium |
| 9 | F-13: O(n×m) detail queries | Refactor lead/customer/meeting detail queries to flatten joins; consider adding `leadId` to meetings | Medium |
| 10 | F-02: `customFields` uses `v.any()` | Audit existing values; define typed validator; migrate via widen-migrate-narrow | Medium |
| 11 | F-14: Event type stats full scan | Add denormalized counts to `eventTypeConfigs` or compute asynchronously | Small |
| 12 | F-15: Unbounded user/member lists | Add `.take()` safety limits to all async iterators | Trivial |
| 13 | F-18: Reassignment index | Add `by_tenantId_and_reassignedAt` | Trivial |

### Later — structural improvements for scale

| # | Finding | Action | Effort |
|---|---------|--------|--------|
| 14 | F-03: Customer data copies lead fields | Evaluate removing duplicated fields from `customers` (resolve at read time) or add sync path | Medium |
| 15 | F-04: `meetings.leadName` stale | Add maintenance path or resolve at read time | Small |
| 16 | F-05: `hostCalendly*` stale denormalization | Rename to `originalHost*` for clarity; resolve current host at read time | Small |
| 17 | F-06: `calendlyEventUri` on opportunities | Document as "original booking URI"; no code change needed | Trivial |
| 18 | F-08: No time-in-status tracking | Addressed by F-07 (`activityLog` table) | — |
| 19 | F-09: Optional payment references | Audit existing data; tighten if all records have values | Small |
| 20 | F-19: `assignedCloserId` on meetings | Add via migration for direct closer → meeting queries | Medium |
| 21 | F-20: Raw webhook payload metadata | Add extracted metadata fields for analytics queries over webhook history | Small |

---

## Normalization Assessment

### 1NF Compliance

| Check | Status | Notes |
|-------|--------|-------|
| No unbounded arrays inside documents | ✅ | `leadIdentifiers`, `meetingReassignments`, `leadMergeHistory` are separate tables, not arrays |
| Atomic fields for access patterns | ✅ | Status fields use unions/literals; UTM params are a bounded object |
| `leads.socialHandles` (array) | ⚠️ | Intentional denormalization. Source of truth is `leadIdentifiers`. Array is bounded (< 10 entries per lead). Acceptable. |
| `eventTypeConfigs.paymentLinks` (array) | ✅ | Configuration data; bounded by business logic (< 5 links per event type) |
| `leads.customFields` (`v.any()`) | ❌ | Unbounded, untyped. Violates 1NF in spirit — shape unknown. See F-02. |

### 2NF Compliance

| Check | Status | Notes |
|-------|--------|-------|
| Non-key facts depend on the whole entity | ✅ | Junction/relationship tables (`leadIdentifiers`, `meetingReassignments`) store only relationship-relevant attributes |
| `opportunities.hostCalendly*` | ⚠️ | These describe the Calendly host membership, not the opportunity itself. They depend on `assignedCloserId`, not the opportunity's identity. Partial 2NF violation. See F-05. |

### 3NF Compliance

| Check | Status | Notes |
|-------|--------|-------|
| Each fact stored on its owning entity | ⚠️ | `customers` duplicates lead fields (F-03). `meetings.leadName` duplicates `leads.fullName` (F-04). `opportunities.calendlyEventUri` duplicates meeting-level data (F-06). |
| Denormalized fields are explicitly maintained | Partial | `latestMeeting*`, `socialHandles`, `searchText`, `calendlyMemberName` are well-maintained. `leadName`, `hostCalendly*`, and customer fields are not. |

### Summary

The schema is approximately at **2.5NF** — solid 1NF with bounded arrays, good 2NF except for the host denormalization on opportunities, and partial 3NF with several unmaintained field copies. The well-maintained denormalizations (`latestMeeting*`, `searchText`) demonstrate the team understands the pattern; the unmaintained ones are legacy oversights that should be resolved.

---

## Proposed `activityLog` Table Schema

For finding F-07, the recommended table design:

```ts
activityLog: defineTable({
  tenantId: v.id("tenants"),
  entityType: v.union(
    v.literal("opportunity"),
    v.literal("meeting"),
    v.literal("lead"),
    v.literal("customer"),
    v.literal("payment"),
    v.literal("follow_up"),
  ),
  entityId: v.string(), // The _id of the affected record (string because it could be any table)
  action: v.union(
    v.literal("created"),
    v.literal("status_changed"),
    v.literal("assigned"),
    v.literal("reassigned"),
    v.literal("payment_recorded"),
    v.literal("converted"),
    v.literal("merged"),
    v.literal("follow_up_created"),
    v.literal("no_show_marked"),
    v.literal("canceled"),
    v.literal("note_updated"),
    v.literal("outcome_set"),
  ),
  actorType: v.union(
    v.literal("user"),
    v.literal("system"),         // Webhook-driven changes
    v.literal("cron"),           // Scheduled job changes
  ),
  actorUserId: v.optional(v.id("users")),
  metadata: v.optional(v.object({
    fromStatus: v.optional(v.string()),
    toStatus: v.optional(v.string()),
    fromCloserId: v.optional(v.id("users")),
    toCloserId: v.optional(v.id("users")),
    reason: v.optional(v.string()),
    amount: v.optional(v.number()),
    currency: v.optional(v.string()),
  })),
  occurredAt: v.number(),
})
  .index("by_tenantId_and_occurredAt", ["tenantId", "occurredAt"])
  .index("by_tenantId_and_entityType_and_occurredAt", ["tenantId", "entityType", "occurredAt"])
  .index("by_entityId", ["entityId"])
  .index("by_tenantId_and_actorUserId_and_occurredAt", ["tenantId", "actorUserId", "occurredAt"])
  .index("by_tenantId_and_action", ["tenantId", "action"]),
```

**Design notes:**
- `entityId` is `v.string()` rather than a specific `v.id()` because it references documents across multiple tables. The `entityType` discriminant tells you which table to resolve against.
- `metadata` uses a typed object with optional fields rather than `v.any()` to keep the schema safe.
- Indexes support: time-series queries by tenant, filtering by entity type, lookup by specific entity, actor attribution, and action-type analytics.
- This table is append-only (insert, never update or delete), making it safe for high-write workloads.
- Estimated growth: ~5–20 events per meeting lifecycle, bounded by business workflow.

---

## Proposed `tenantStats` Summary Table Schema

For finding F-10:

```ts
tenantStats: defineTable({
  tenantId: v.id("tenants"),
  // Pipeline counts by status
  opportunitiesByStatus: v.object({
    scheduled: v.number(),
    in_progress: v.number(),
    payment_received: v.number(),
    follow_up_scheduled: v.number(),
    reschedule_link_sent: v.number(),
    lost: v.number(),
    canceled: v.number(),
    no_show: v.number(),
  }),
  // Meeting counts
  meetingsScheduledThisWeek: v.number(),
  meetingsCompletedThisWeek: v.number(),
  // Payment totals
  totalPaymentsRecorded: v.number(),
  totalPaymentsVerified: v.number(),
  totalRevenueRecorded: v.number(),
  // Team
  totalClosers: v.number(),
  totalAdmins: v.number(),
  // Refresh tracking
  lastRecomputedAt: v.number(),
})
  .index("by_tenantId", ["tenantId"]),
```

**Maintenance pattern:** Each mutation that changes a relevant count calls a shared `updateTenantStats()` helper that atomically patches the summary document. Weekly counts can be recomputed by a periodic cron or on read if stale.

---

## Audit Checklist

- [x] Read the local Convex guidelines and docs first
- [x] Inventory every table, index, and major function path
- [x] Confirm document boundaries are bounded and intentional
- [x] Confirm relationships use explicit `Id` references or junction tables
- [x] Check that important invariants are enforced in mutations
- [x] Check that public functions validate arguments and auth
- [x] Check that hot reads use `withIndex`, `take`, or `paginate`
- [x] Check for `.filter`, broad `.collect`, and `.collect().length`
- [x] Check for redundant or missing indexes
- [x] Check for denormalized fields and whether their write paths maintain them
- [x] Check for high-churn fields mixed into stable documents
- [x] Identify any changes that require migration planning
