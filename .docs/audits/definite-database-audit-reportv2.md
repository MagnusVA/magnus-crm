# Definitive Database Audit Report

Date: 2026-04-12

This report is a cross-referenced consolidation of five independent database audits conducted on 2026-04-11, each covering `convex/schema.ts`, all Convex queries/mutations/actions, denormalized field maintenance, and analytics readiness. Where the audits disagreed on severity or approach, the disagreement is noted and resolved. Where one audit found something the others missed, it is preserved. Code-level claims were spot-checked against the live codebase on 2026-04-12.

Source audits:
- `database-audit-gpt1.md` (9 findings)
- `database-gpt2.md` (9 findings)
- `database-audit-gpt3.md` (9 findings)
- `database-audit-opus2.md` (21 findings)
- `database-opus1.md` (15 findings)

Corrections applied after code verification:
- Opus1 Finding 2.15 (`inviteCleanupMutations` uses `.filter()`) was **false** — the function correctly uses `.withIndex("by_status_and_inviteExpiresAt")`. Excluded from this report.
- Opus1 Finding 2.8 (`leads.socialHandles` not rebuilt on merge) was **partially false** — `mergeLead` does call `buildSocialHandles()`. The drift risk is limited to non-merge identifier mutation paths that may not trigger a rebuild. Severity downgraded.
- Runtime signal snapshot from Convex Insights on 2026-04-10 confirmed 2 OCC conflicts on `rawWebhookEvents` via `persistRawEvent`, supporting the soft-uniqueness finding.

---

## 1. Executive Summary

The current schema is a solid operational CRM foundation. Tenant isolation is strong, core entity relationships are properly separated, status fields use typed unions, and several denormalizations are justified and well-maintained. The app works well for day-to-day CRM operations.

The schema is not yet ready for serious analytics and reporting. The five audits converge on the same core diagnosis:

1. **The model is current-state oriented.** Status transitions overwrite in place. There is no queryable history of when things changed, who changed them, or what the previous state was.
2. **Booking-answer data is collapsed into an untyped blob.** `leads.customFields` loses per-interaction provenance, is not indexable, and blocks the most obvious custom-field reporting.
3. **Several hot read paths already scan and filter in JS** rather than querying by index, producing incomplete paginated results and O(n) reactive subscriptions.
4. **The money model is not safe for financial reporting.** Floating-point amounts and mixed-currency summation are analytically invalid.
5. **Data lifecycle has gaps.** Tenant offboarding orphans 11+ tables. User deletion breaks referential integrity for historical records.

The right next step is not "add every possible index." It is:
1. Preserve lifecycle facts as append-only events.
2. Fix the current correctness and integrity risks.
3. Normalize the fields already known to matter for reporting.
4. Add a focused index layer around tenant + owner + status + time.
5. Keep Convex as the OLTP system; plan a warehouse or export path for heavier OLAP workloads.

---

## 2. Domain and Data Model Summary

### Core entities (15 tables)

| Table | Role | Record type | Notes |
| --- | --- | --- | --- |
| `tenants` | Multi-tenant root; identity, lifecycle, Calendly OAuth, webhook config | Canonical | Overloaded: mixes stable identity with high-churn OAuth state |
| `users` | CRM team members; WorkOS identity, CRM role, Calendly link | Canonical | Hard-deleted today; no lifecycle timestamps |
| `leads` | Inbound contacts from Calendly bookings or manual entry | Canonical | Weakened by `customFields` blob and optional `status` |
| `leadIdentifiers` | Multi-identifier model (email, phone, social handles) per lead | Canonical | Strong normalization choice; the right answer for identity resolution |
| `leadMergeHistory` | Audit trail for lead merge operations | Canonical (append-only) | Good immutable audit table |
| `opportunities` | Sales pipeline entity linking lead → closer → meetings | Canonical | 8-state machine; carries justified denormalized meeting refs |
| `meetings` | Individual Calendly meetings within an opportunity | Canonical | 5-state machine; lacks direct closer dimension |
| `customers` | Converted leads (post-sale snapshot + status) | Canonical + snapshot | Snapshot fields set at conversion, never refreshed |
| `paymentRecords` | Payment evidence per opportunity/meeting/customer | Canonical | Float amounts, optional foreign keys, mixed-currency risk |
| `followUps` | Follow-up scheduling links and manual reminders | Canonical | 4-state machine; polymorphic (two subtypes share one table) |
| `eventTypeConfigs` | CRM overlays on Calendly event types (field mappings, payment links) | Canonical | Duplicate handling is weak; stats computed by full scan |
| `closerUnavailability` | Date-range unavailability for closers | Canonical | Good, low volume |
| `meetingReassignments` | Audit trail for meeting redistribution | Canonical (append-only) | Good immutable audit table |
| `calendlyOrgMembers` | Synced Calendly org member mirror | Derived (sync cache) | Refreshed every 24h |
| `rawWebhookEvents` | Raw Calendly webhook payloads for replay/debugging | Operational staging | 30-day retention; cleaned up by daily cron |

### Existing denormalized fields

| Field(s) | On table | Source of truth | Maintained by | Status |
| --- | --- | --- | --- | --- |
| `latestMeetingId/At`, `nextMeetingId/At` | `opportunities` | `meetings` | `updateOpportunityMeetingRefs()` in all relevant mutations | ✅ Well-maintained |
| `socialHandles` | `leads` | `leadIdentifiers` | Pipeline `inviteeCreated` + `mergeLead` | ✅ Mostly maintained (merge rebuilds; other identifier paths may not) |
| `searchText` | `leads` | lead fields + identifiers | Pipeline and lead mutations via `updateLeadSearchText()` | ✅ Well-maintained |
| `calendlyMemberName` | `users` | `calendlyOrgMembers` | `upsertMember()` on sync + link | ✅ Well-maintained |
| `leadName` | `meetings` | `leads.fullName` | Set at creation only | ⚠️ Never updated after creation |
| `hostCalendlyEmail/Name` | `opportunities` | `calendlyOrgMembers` / user | Set at creation + repair mutation | ⚠️ Not updated when member profile changes |
| `fullName`, `email`, `phone`, `socialHandles` | `customers` | `leads` + `leadIdentifiers` | Set once at conversion | ⚠️ Never refreshed after conversion |

### What the model supports well today

- Current-state pipeline views
- Tenant-scoped operational pages
- Lead search (via full-text `searchText`)
- Meeting scheduling views
- Basic customer conversion tracking
- Narrow workflow histories for merge and reassignment
- Atomic multi-table writes within single mutation paths

### What the model does not support well today

- Funnel transition counts over time
- Time-in-stage and stage-to-stage duration reporting
- Historical assignment history beyond meeting reassignment
- Per-interaction booking-answer analytics
- Team lifecycle analytics (invite-to-accept latency, user tenure)
- Reliable filtering on custom-field values
- Currency-safe revenue analytics
- Cross-cutting activity timelines
- Closer calendar/schedule queries without O(n×m) joins
- Aggregate dashboards without full table scans

### Current analytics posture

There are approximately 23 `posthog.capture()` callsites across `app/`, `hooks/`, and `lib/`. A server-side capture helper exists (`lib/posthog-capture.ts`) but has no active call sites. PostHog handles product telemetry (clicks, feature usage, web vitals), but these events are external, partial, client-heavy, and not modeled as relational facts tied to CRM entities.

There is no first-class Convex table for business state transitions, domain events, or user interaction facts. Reporting would have to be reconstructed from mutable current-state tables, a few narrow audit tables, and external PostHog events.

---

## 3. Normalization Assessment

### 1NF

Mostly good. The schema uses separate tables with foreign keys instead of unbounded arrays. Bounded arrays (`socialHandles`, `paymentLinks`) are intentional and small.

One clear violation: `leads.customFields` is `v.any()` — untyped, unbounded, and shape-unknown at compile time and runtime.

### 2NF

No major 2NF issues. Junction/relationship tables (`leadIdentifiers`, `meetingReassignments`, `leadMergeHistory`) store only relationship-relevant attributes. One partial violation: `opportunities.hostCalendlyEmail/Name` describes the Calendly host membership, not the opportunity itself — a dependency on `assignedCloserId`, not on the opportunity's identity.

### 3NF

Several unmaintained field copies:
- `customers` duplicates lead identity fields (intentional snapshot, but never refreshed)
- `meetings.leadName` duplicates `leads.fullName` (never updated)
- `opportunities.calendlyEventUri` duplicates the first meeting's URI
- `leads.customFields` collapses per-meeting booking answers into a merged current-state blob

The well-maintained denormalizations (`latestMeeting*`, `searchText`, `socialHandles`) demonstrate the team understands the pattern; the unmaintained ones are legacy oversights.

### Summary

The schema is approximately at 2.5NF — solid 1NF with bounded arrays, good 2NF except for the host denormalization, and partial 3NF with several unmaintained field copies. It is close to 3NF for the operational CRM core. It is not close to 3NF for analytics-grade historical facts, because history is compressed into latest-state fields rather than modeled as append-only records.

---

## 4. Findings

### Finding 1: No append-only business event history

- Severity: **High**
- Consensus: All 5 audits flag this as the top analytics blocker
- Affected: `opportunities`, `meetings`, `leads`, `customers`, `followUps`, `users`, app-side analytics
- Evidence:
  - `convex/schema.ts:208-253` (opportunities stores only current status + `createdAt`/`updatedAt`)
  - `convex/schema.ts:255-338` (meetings stores some lifecycle fields but no general event log)
  - `convex/schema.ts:481-520` (followUps stores current status, not transition history)
  - `convex/schema.ts:53-81` (users has no lifecycle timestamps)
  - Client-side `posthog.capture()` calls in `app/` with no Convex-side mirror

Why it matters:

Every status transition overwrites the previous value in place. There is no record of when an opportunity became "lost," who transitioned it, what the previous status was, or how long it spent in each stage. Questions like "what is the average time-to-payment by closer?", "what is the no-show rate trend over time?", or "which actions led to conversions?" cannot be answered from the current model.

**Audits disagreed on the table design:**
- GPT1 and GPT2 proposed multiple entity-specific event tables (`opportunityEvents`, `meetingEvents`, etc.)
- GPT3 proposed a single `domainEvents` table with typed `entityType` and `eventType` discriminators
- Opus1 proposed a focused `statusChanges` table for status transitions only
- Opus2 proposed an `activityLog` table

**Resolution:** A single `domainEvents` table with typed envelope per event family is the most pragmatic approach for Convex. It avoids table proliferation while giving full flexibility via indexes on `entityType` + `eventType`. Opus1's `statusChanges` is too narrow — it would miss events like "payment recorded," "user invited," and "customer converted" that are not status transitions. Multiple tables per GPT1/GPT2 add complexity without clear benefit at this scale.

Recommended fix:

Add an append-only `domainEvents` table. Each event should carry:
- `tenantId`
- `entityType` (opportunity, meeting, lead, customer, followUp, user)
- `entityId`
- `eventType` (status_changed, payment_recorded, user_invited, customer_converted, etc.)
- `occurredAt`
- `actorUserId` (optional — omit for webhook-triggered changes)
- `source` (closer, admin, pipeline, system)
- `fromStatus` / `toStatus` (optional — only for status transitions)
- `reason` (optional)
- `metadata` (optional typed envelope per event family)

Suggested indexes:
- `by_tenantId_and_occurredAt`
- `by_tenantId_and_entityType_and_entityId_and_occurredAt`
- `by_tenantId_and_eventType_and_occurredAt`
- `by_entityId`

Emit domain events from: opportunity status changes, meeting lifecycle changes, no-show creation, follow-up creation/completion/booking/expiry, payment logging/verification/dispute, customer conversion, user invitation/acceptance/removal, lead merge, team role changes.

Keep high-volume UI clickstream in PostHog. Mirror only curated business facts into `domainEvents` that must be queryable against CRM entities.

Migration required: Additive only. Behavioral change is dual-write from relevant mutation paths. Backfill can be partial and approximate from existing `_creationTime` and current status for seed data. Historical completeness begins only after the new table is live.

---

### Finding 2: leads.customFields is an untyped blob that collapses per-interaction facts

- Severity: **High**
- Consensus: All 5 audits flag this. GPT1/GPT2/GPT3 rate it High; Opus1/Opus2 rate it Medium.

**Severity resolution:** High is correct. This is the single biggest normalization gap and the single biggest analytics-model issue. It is untyped (`v.any()`), not per-interaction, loses provenance, is not indexable, and blocks the most obvious custom-field reporting ("show leads where field X = Y," "count bookings by answer value," "compare conversion rates by intake question response").

- Affected:
  - `convex/schema.ts:110-156` (field definition: `customFields: v.optional(v.any())`)
  - `convex/pipeline/inviteeCreated.ts:252-265` (merge logic via `mergeCustomFields`)
  - Raw webhook cleanup: `convex/webhooks/cleanup.ts` (30-day retention)

Why it matters:

1. **History loss.** If the same lead books multiple meetings and answers a question differently each time, the model preserves only the merged/latest view, not the interaction-level fact.
2. **Weak provenance.** You cannot answer "which meeting produced this answer?" without reconstructing it from retained raw webhooks.
3. **Poor analytics shape.** Question labels are free-form strings. There is no stable field catalog, no typed answer model, and no per-meeting fact table.
4. **Schema unsafety.** `v.any()` bypasses validation entirely.
5. **Backfill constraint.** Processed raw webhook payloads are cleaned up after 30 days (`convex/webhooks/cleanup.ts`). Per-meeting answers can only be reconstructed from retained raw events, not for the full system lifetime. This window is closing.

Recommended fix (two layers):

**Layer 1 — Immediate hardening:** Change `customFields` to `v.optional(v.record(v.string(), v.string()))` to at least constrain value types and enable validation.

**Layer 2 — Enterprise model:** Add normalized tables:

- `eventTypeFieldCatalog` — stable field registry per event type:
  - `tenantId`, `eventTypeConfigId`, `fieldKey`, `currentLabel`, `firstSeenAt`, `lastSeenAt`, optional `valueType`
- `meetingFormResponses` — per-meeting booking answers:
  - `tenantId`, `meetingId`, `opportunityId`, `leadId`, `eventTypeConfigId`, `fieldCatalogId` or stable key, `questionLabelSnapshot`, `answerText`, `capturedAt`

Suggested indexes:
- `meetingFormResponses.by_meetingId`
- `meetingFormResponses.by_tenantId_and_eventTypeConfigId`
- `meetingFormResponses.by_tenantId_and_fieldCatalogId`

Keep a bounded current-state summary on leads for the UI if needed, but do not treat the blob as the reporting source of truth.

Migration required: Yes. Widen-migrate-narrow rollout:
1. Add new tables and optional field alongside existing `customFields`
2. Dual-write new bookings into the new structure
3. Backfill recent history from retained `rawWebhookEvents` (time-critical — 30-day window)
4. Keep readers compatible with both models
5. Narrow or deprecate `customFields`

---

### Finding 3: Payment model is unsafe for enterprise reporting

- Severity: **High**
- Consensus: GPT1 and GPT3 flag this as High. Other audits mention it in context but do not isolate it.
- Affected:
  - `convex/schema.ts:456-479` (`amount: v.number()`, `currency: v.string()`)
  - `convex/dashboard/adminStats.ts:78-88` (sums all non-disputed amounts regardless of currency)
  - `convex/customers/queries.ts:57-63`, `147-154`, `206-214` (customer totals use first payment's currency)
  - `convex/closer/payments.ts:115-176`

Why it matters:

- `paymentRecords.amount` is a floating-point `v.number()`. Floating-point arithmetic accumulates rounding errors in financial sums.
- `currency` is a freeform string with no enforcement.
- Admin revenue sums all non-disputed payment amounts regardless of currency. Customer totals display the first payment's currency but sum all amounts. This is analytically invalid if multiple currencies ever appear.

Recommended fix:

- Add `amountMinor` as integer minor units (cents, centavos, etc.). Prefer `v.int64()` for full financial safety.
- Constrain `currency` as an ISO 4217 code.
- Define the reporting rule explicitly: single-tenant single-currency only, or multi-currency with per-currency aggregates.
- Maintain `customerFinancialSummary` or denormalized totals fields (by currency) so dashboards do not rescan all payment records reactively.
- Add reporting indexes: `by_tenantId_and_recordedAt`, `by_tenantId_and_status_and_recordedAt`, `by_customerId_and_recordedAt`.

Migration required: Yes. Widen-migrate-narrow:
1. Add `amountMinor` alongside `amount`
2. Dual-write both
3. Backfill existing records
4. Switch reads to `amountMinor`
5. Eventually deprecate `amount`

---

### Finding 4: Dashboard and aggregate queries perform full table scans

- Severity: **High**
- Consensus: GPT2, Opus2, Opus1 all flag dashboard scans. Opus2 adds admin opp list and event type stats.
- Affected:
  - `convex/dashboard/adminStats.ts:24-111` — scans `users`, `opportunities`, `meetings`, `paymentRecords` per render
  - `convex/customers/queries.ts:48-79`, `146-215` — `.collect()` all payments per customer to compute totals
  - `convex/eventTypeConfigs/queries.ts:46-108` — scans all tenant opportunities for booking counts
  - `convex/opportunities/queries.ts:69-217` — `listOpportunitiesForAdmin` uses unbounded `for await` with N+1 enrichment

Why it matters:

These are reactive queries. Every write to any scanned table re-fires the subscription. At 1k+ records per table this becomes slow and expensive. At 10k+ it will hit Convex transaction read limits. The customer list triggers a nested N+1 `.collect()` pattern — for each customer on a page, all payment records are collected.

Recommended fix:

- **Admin dashboard:** Replace with a `tenantStats` summary document maintained atomically by the mutations that change source data (user create/delete, opportunity status change, payment record). The dashboard reads a single document instead of scanning four tables.
- **Customer totals:** Maintain `totalPaid` and `totalPaymentCount` directly on the `customers` document, updated in `logPayment` and `recordCustomerPayment`.
- **Event type stats:** Maintain booking counts on `eventTypeConfigs` records, updated when opportunities are created.
- **Admin opportunity list:** Paginate with `usePaginatedQuery`. Batch enrichment lookups with `Promise.all` over batched ID sets.

Migration required: Summary tables are additive. Customer `totalPaid` fields need widen-migrate-narrow (add as optional, backfill, make required).

---

### Finding 5: Closer scheduling and pipeline reads depend on scan-then-filter patterns

- Severity: **High**
- Consensus: All 5 audits flag this. GPT3 and Opus2 provide the most detailed analysis.
- Affected:
  - `convex/closer/dashboard.ts:20-61` (`getNextMeeting` collects all closer opportunities, filters to "scheduled" in JS, then scans tenant meetings)
  - `convex/closer/dashboard.ts:91-119` (`getPipelineSummary` collects all closer opportunities, counts by status in JS)
  - `convex/closer/pipeline.ts:32-68` (`listMyOpportunities` collects all, filters/sorts in JS, N+1 enrichment)
  - `convex/closer/calendar.ts:28-83` (derives opportunity IDs, scans tenant meetings by date, filters by ownership)
  - `convex/unavailability/shared.ts:75-150`, `153-240` (same pattern for redistribution scheduling)

Why it matters:

The app repeatedly: (1) collects all opportunities for a closer, (2) filters by status in memory, (3) scans tenant meetings by date, (4) filters those meetings back down by opportunity ownership. A closer with 500+ accumulated opportunities across all statuses triggers increasingly expensive reads, and subsequent `Promise.all` enrichment amplifies the cost.

Recommended fix (two layers):

**Layer 1 — Index fix (immediate):**
- Add `opportunities.by_tenantId_and_assignedCloserId_and_status` — eliminates JS status filtering and enables direct status-specific queries.

**Layer 2 — Meetings closer dimension (next phase):**
- Denormalize `assignedCloserId` onto `meetings` and index it: `meetings.by_tenantId_and_assignedCloserId_and_scheduledAt`. This eliminates the O(n×m) join pattern for calendar, next-meeting, and redistribution reads.
- Maintenance rules: set it when creating a meeting, update it when the owning opportunity is reassigned, treat it as a read-optimized projection of `opportunities.assignedCloserId`.

**Layer 3 — Summary docs (later):**
- For `getPipelineSummary`, derive from maintained per-closer counter documents.
- Paginate `listMyOpportunities` instead of returning unbounded arrays.

Migration required: Index additions are safe. `meetings.assignedCloserId` requires widen-migrate-narrow (add as optional, backfill from opportunity ownership, switch reads, optionally make required).

---

### Finding 6: leads.status is optional, creating permanent migration-mode queries

- Severity: **High**
- **Audits disagreed on severity:** GPT1 rates High, GPT2 treats it as part of a Medium finding, Opus1 rates Low.
- **Severity resolution:** High is correct. This is not just a schema hygiene issue — it actively causes query correctness problems. Every lead query that segments by status must handle both `undefined` and `"active"` as meaning the same thing. The search index overfetches because the status filter cannot cleanly exclude merged leads. Paginated results are short because merged leads are removed after the page is filled.
- Affected:
  - `convex/schema.ts:119-126` (`status` is `v.optional(...)`)
  - `convex/leads/queries.ts:35-52`, `76-93`, `178-198`
- Evidence: `listLeads` paginates by `tenantId`, then removes merged leads in memory. `searchLeads` fetches 40 hits, filters statuses, truncates to 20. Pages can be short even when more matching documents exist.

Recommended fix:

Widen-migrate-narrow rollout:
1. Backfill every lead with `undefined` status to `"active"`
2. Keep readers compatible during the migration window
3. Make `status` required in schema
4. Stop overfetching and JS-filtering active leads
5. Update search index filter to work purely on indexed `status`

Migration required: Yes.

---

### Finding 7: Tenant offboarding leaves orphaned data across 11+ tables

- Severity: **High**
- Consensus: GPT1, GPT2, Opus2 all flag this independently
- Affected:
  - `convex/admin/tenantsMutations.ts:65-126`
  - `convex/admin/tenants.ts:700-734`
- Evidence: The batch deletion mutation only cleans up `rawWebhookEvents`, `calendlyOrgMembers`, and `users`, then deletes the tenant row. This leaves orphaned records in: `leads`, `leadIdentifiers`, `leadMergeHistory`, `opportunities`, `meetings`, `customers`, `paymentRecords`, `followUps`, `closerUnavailability`, `meetingReassignments`, `eventTypeConfigs`.

Why it matters:

Orphaned tenant-scoped records contaminate future reporting, waste storage, and represent a data lifecycle defect. If any orphaned data is later joined into analytics, it will produce ghost results for a deleted tenant.

Recommended fix:

Either:
- Extend `deleteTenantRuntimeDataBatch` to cascade across all 14 tenant-scoped tables using the same batching pattern (`.take(128)` per table, return `hasMore` for continuation), or
- Soft-delete/suspend the tenant and prevent reads until a full archival/deletion workflow completes. Do not delete the tenant root row until all dependent data is handled.

Also run a one-time orphan audit to identify data left behind by any prior offboarding runs.

Migration required: No schema migration — code change only. Historical orphan cleanup is a one-time data job.

---

### Finding 8: User hard-delete breaks referential integrity and historical reporting

- Severity: **High**
- Consensus: GPT3 flags this as High. Opus1 flags the orphan risk in its integrity review. Other audits do not isolate it.
- **Why it's High:** Actors are dimensions that must remain stable long after the operational user is no longer active. Historical reporting by closer/actor breaks when the user row is deleted.
- Affected:
  - `convex/workos/userMutations.ts:428-458` (`removeUser` hard-deletes the user row)
  - All tables referencing `users`: `opportunities.assignedCloserId`, `closerUnavailability.closerId/createdByUserId`, `meetingReassignments.fromCloserId/toCloserId/reassignedByUserId`, `customers.convertedByUserId`, `paymentRecords.closerId`, `followUps.closerId`, `leadMergeHistory.mergedByUserId`
- Evidence: Verified that `removeUser` calls `ctx.db.delete(userId)` at line 457 after only unlinking the Calendly org member. It does not reassign or clean up any references.

Recommended fix:

Replace hard delete with soft delete:
- Add `users.deletedAt: v.optional(v.number())`
- Add `users.isActive: v.optional(v.boolean())` (or `lifecycleStatus`)
- Preserve the row permanently for historical joins
- Filter inactive users from team lists and operational queries
- Block deactivation while the user still owns active opportunities, pending follow-ups, or future meetings — require reassignment first
- Allow inactive users to remain referenced by historical records

Also run a one-time orphan audit to identify whether any references already point to deleted users.

Migration required: Additive soft-delete fields are safe. Historical cleanup/orphan audit is a one-time script.

---

### Finding 9: Business-key uniqueness is soft and convention-based

- Severity: **High**
- Consensus: GPT1, GPT2, GPT3 all flag this. Runtime Convex Insights confirmed OCC conflicts on `persistRawEvent`.
- Affected:
  - `convex/webhooks/calendlyMutations.ts:15-29` (`persistRawEvent` scans prior rows to dedupe)
  - `convex/pipeline/inviteeCreated.ts:685-717` (loads up to 8 event type configs for the same URI, picks oldest)
  - `convex/pipeline/inviteeCreated.ts:799-809` (customer conversion uniqueness)
  - `convex/eventTypeConfigs/mutations.ts:141-170`

Why it matters:

Duplicate dimension rows for the same real-world entity create broken joins, split metrics, and ambiguous field mappings. The code already anticipates duplicates (e.g., logging when multiple `eventTypeConfigs` exist for the same URI), which means the invariant is already considered weak in practice.

Recommended fix:

- For each business key, choose one canonical write owner and enforce uniqueness there.
- Run a one-time dedupe migration for `eventTypeConfigs` by `(tenantId, calendlyEventTypeUri)`. Pick a canonical row, repoint dependents if necessary.
- Improve webhook dedupe: add `rawWebhookEvents.by_tenantId_and_eventType_and_calendlyEventUri` for precise lookup instead of scanning.
- After cleanup, funnel all future writes through a single upsert path and remove duplicate-tolerant read logic.
- Schedule duplicate audits for `eventTypeConfigs`, `customers` by `(tenantId, leadId)`, and `leadIdentifiers` by `(tenantId, type, value)` before building aggregate reporting on top.

Migration required: Data audit/repair migration recommended. Schema change not necessarily required (better indexes help).

---

### Finding 10: Post-paginate and post-search filtering produces incomplete results

- Severity: **High**
- Consensus: GPT1 provides the most detailed analysis. GPT2 covers the lead and customer cases.
- Affected:
  - `convex/leads/queries.ts:64-156` (`listLeads` paginates by `tenantId`, then removes merged leads in JS)
  - `convex/leads/queries.ts:160-209` (`searchLeads` fetches 40 hits, filters statuses, truncates to 20)
  - `convex/customers/queries.ts:12-80` (`listCustomers` paginates all tenant customers, then filters by closer ownership)
  - `convex/closer/followUpQueries.ts:9-39` (fetches 50 pending follow-ups, then filters to `manual_reminder`)
  - `convex/leads/queries.ts:253-285` (lead detail fetches 200 tenant follow-ups, then filters by `leadId`)

Why it matters:

Pages can be short even when more matching documents exist later in the index. Search relevance gets distorted by post-filtering. This is a correctness issue, not just a performance issue.

Recommended fix:

Rewrite each query around indexes that match the real predicate:
- **Customer list for closers:** Add `customers.by_tenantId_and_convertedByUserId` and `by_tenantId_and_convertedByUserId_and_status`
- **Reminder list:** Add `followUps.by_tenantId_and_closerId_and_type_and_status_and_reminderScheduledAt`
- **Lead detail follow-ups:** Add `followUps.by_tenantId_and_leadId_and_createdAt` (or `by_leadId`)
- **Lead list/search:** Resolve via Finding 6 (make `status` required, query `by_tenantId_and_status` directly)

Migration required: Mostly additive indexes. `leads.status` cleanup is a separate migration item (Finding 6).

---

### Finding 11: Several relationship indexes are missing, forcing capped scans

- Severity: **High**
- Consensus: GPT2 provides the most specific list. Opus2 adds `followUps.by_opportunityId_and_status`.
- Affected:
  - `convex/leads/queries.ts:253-353` (follow-ups loaded by tenant, filtered by `leadId`)
  - `convex/leads/merge.ts:201-214` (clears duplicate flags by taking 500 tenant opportunities, filtering on `potentialDuplicateLeadId`)
  - `convex/webhooks/calendlyMutations.ts:15-29` (scans events for `(tenantId, eventType)`, compares `calendlyEventUri` in code)
  - `convex/closer/followUpQueries.ts:9-21` (pending follow-ups filtered by `type` in JS)

Recommended fix — add these targeted indexes:
- `followUps.by_tenantId_and_leadId` (or `by_tenantId_and_leadId_and_createdAt`)
- `opportunities.by_tenantId_and_potentialDuplicateLeadId`
- `rawWebhookEvents.by_tenantId_and_eventType_and_calendlyEventUri`
- `followUps.by_tenantId_and_closerId_and_status_and_type`
- `followUps.by_opportunityId_and_status`

Migration required: Index additions only.

---

### Finding 12: meetings table lacks a direct closer dimension

- Severity: **Medium**
- Consensus: GPT3 rates High and provides the most detailed proposal. Opus2 rates Medium. Other audits note it implicitly.
- **Severity resolution:** Medium. It is a real architectural gap that causes O(n×m) joins, but it requires a migration (new field on existing docs) so it is a planned improvement rather than an immediate fix.
- Affected:
  - `convex/closer/dashboard.ts:20-61`, `91-119`
  - `convex/closer/calendar.ts:28-83`
  - `convex/unavailability/shared.ts:75-150`, `153-240`
  - `convex/schema.ts:255-338` (meetings has no `closerId` or `assignedCloserId`)

Why it matters:

The system frequently needs "meetings for this closer in time order," but `meetings` carries no direct closer key. The code pattern is: load all closer opportunities → derive IDs in memory → scan tenant meetings by date → keep only meetings whose `opportunityId` belongs to that closer. This is the root cause of the O(n×m) patterns across calendar, dashboard, redistribution, and any future reporting by closer + meeting date.

Recommended fix:

Add `meetings.assignedCloserId` as a denormalized dimension:
- New field: `assignedCloserId: v.optional(v.id("users"))`
- Index: `by_tenantId_and_assignedCloserId_and_scheduledAt`
- Maintenance: set on creation, update when opportunity is reassigned, treat as projection of `opportunities.assignedCloserId`

Migration required: Yes — widen-migrate-narrow. Add as optional, dual-write, backfill from opportunity ownership, switch reads, optionally make required.

---

### Finding 13: Missing analytics-grade composite indexes

- Severity: **Medium**
- Consensus: All 5 audits flag missing time/status/owner indexes for reporting.
- Affected: `opportunities`, `meetings`, `paymentRecords`, `customers`, `followUps`, `leads`, `meetingReassignments`

Why it matters:

The current indexes serve operational read paths (tenant + status, tenant + closer). For analytics — filtering by time range, aggregating by status + closer, trending over time — the required composite indexes are missing. Without them, every analytics query becomes a full index scan plus JS filtering.

**Note:** All audits agree that adding every possible speculative index is wrong. Add the minimum set that supports both current correctness and the most predictable reporting dimensions: tenant, owner, status, time, event type.

See Section 5 for the complete recommended index matrix.

Migration required: Index additions only. Consider staged indexes for large tables.

---

### Finding 14: tenants table mixes stable identity with high-churn OAuth tokens

- Severity: **Medium**
- **Audits disagreed on severity:** GPT1 rates Low, GPT3 rates Medium, Opus2 rates High (quantified: 16 reactive invalidations/day from token refresh every 90 minutes), Opus1 rates Low.
- **Severity resolution:** Medium. Opus2 makes the strongest case with the quantified reactivity cost — every query that reads any `tenants` field is invalidated 16× per day by token refresh. However, this is not the primary analytics blocker, and the fix is a significant refactor.
- Affected:
  - `convex/schema.ts:6-51` (~25 fields including OAuth tokens, refresh locks, webhook secrets)
  - Cron job `refreshAllTokens` patches tenant doc every 90 minutes

Recommended fix:

Extract Calendly OAuth state into a dedicated table:
- `tenantCalendlyConnections` (or `tenantCalendlyTokens`):
  - `tenantId`, `calendlyAccessToken`, `calendlyRefreshToken`, `calendlyTokenExpiresAt`, `calendlyRefreshLockUntil`, `lastTokenRefreshAt`, `codeVerifier`
- Leave `tenants` focused on: company name, contact email, lifecycle/onboarding state, tenant owner, `workosOrgId`

Migration required: Yes — significant refactor touching OAuth, token refresh, webhook setup, and health check flows. Plan for a dedicated later phase.

---

### Finding 15: Customer snapshot drifts from lead data after conversion

- Severity: **Medium**
- Consensus: Opus2 and Opus1 flag this. GPT3 notes it as conditional.
- **Audits disagreed on approach:** Opus2 prefers removing duplicated fields and resolving via `leadId` at read time. Opus1 prefers adding a sync path.
- **Resolution:** Add a sync path (Opus1's approach). The snapshot is intentional and useful for list views and calendar displays. Removing the fields would require changing every customer read path. The right fix is to patch the linked customer when the lead's identity fields change, and to explicitly document the snapshot as intentional behavior.
- Affected:
  - `convex/customers/conversion.ts:86-102` (copies `fullName`, `email`, `phone`, `socialHandles` at conversion)
  - `customers` table fields that duplicate `leads`

Recommended fix:

In the `updateLead` mutation (and any lead identity mutation), check for a linked customer via `customers.by_tenantId_and_leadId` and patch the snapshot fields if the customer exists. Document this as a maintained snapshot, not a 3NF violation.

Migration required: No — mutation logic change only.

---

### Finding 16: Missing lifecycle timestamps on key entity transitions

- Severity: **Medium**
- Source: Opus1 (unique finding — no other audit isolates this)

Why it matters:

Several business-critical moments are not recorded with their own timestamps. `updatedAt` is overwritten on every patch, losing intermediate transition timing. Without explicit timestamps, time-based analytics for each lifecycle event require the `domainEvents` table from Finding 1 as the sole source.

Missing timestamps:

| Table | Missing field | When it should be set |
| --- | --- | --- |
| `opportunities` | `lostAt` | When `markAsLost` is called |
| `opportunities` | `canceledAt` | When pipeline processes cancellation |
| `opportunities` | `paymentReceivedAt` | When `logPayment` transitions to `payment_received` |
| `meetings` | `completedAt` | When meeting transitions to `completed` |
| `meetings` | `canceledAt` | When pipeline processes `invitee.canceled` |
| `paymentRecords` | `verifiedAt` | When status changes to `verified` |
| `customers` | `churnedAt`, `pausedAt` | When `updateCustomerStatus` changes status |
| `followUps` | `bookedAt` | When pipeline auto-detects the follow-up booking |

Recommended fix:

Add these as `v.optional(v.number())` fields (non-breaking). Update the corresponding mutations to set them. These serve as lightweight analytics fields on the source-of-truth tables and complement the richer `domainEvents` table.

Migration required: No — all new fields are optional.

---

### Finding 17: Missing user attribution on status changes

- Severity: **Medium**
- Source: Opus1 (unique finding — no other audit isolates this)

Why it matters:

When an opportunity is marked lost, only `lostReason` (text) is stored — not who did it. When a no-show is recorded, `noShowSource` is `"closer"` but not the actual `closerId`. Payment records store `closerId` at creation but not `verifiedByUserId` or `disputedByUserId`. This prevents per-closer performance reporting and accountability tracking.

Recommended fix:

Add optional attribution fields:
- `opportunities`: `lostByUserId: v.optional(v.id("users"))`
- `meetings`: `noShowMarkedByUserId: v.optional(v.id("users"))`
- `paymentRecords`: `verifiedByUserId: v.optional(v.id("users"))`, `statusChangedAt: v.optional(v.number())`

These complement the `domainEvents` table (Finding 1) by providing quick point-read attribution without querying the event history.

Migration required: No — all optional fields.

---

### Finding 18: paymentRecords and followUps are too polymorphic for clean reporting

- Severity: **Medium**
- Source: GPT2 (unique angle — isolated as a polymorphism finding), Opus2 (F-09 on optional foreign keys)
- Affected:
  - `convex/schema.ts:456-520`
  - `convex/closer/payments.ts:115-176`
  - `convex/customers/conversion.ts:118-139`

Why it matters:

**paymentRecords** can represent three different business contexts:
1. A pre-conversion payment attached to an opportunity/meeting
2. A post-conversion customer payment with no opportunity/meeting
3. A backfilled hybrid row that later gains `customerId`

`opportunityId` and `meetingId` are optional, so the schema cannot prevent invalid context combinations. Analytics logic must branch on which references are present.

**followUps** store both scheduling links and manual reminders in one table with nullable fields for subtype-specific attributes. Queries must filter by `type` after fetching.

Recommended fix:

- For `paymentRecords`: Add an explicit `contextType` discriminant (e.g., `"opportunity"` | `"customer"`). For the immediate term, audit existing records — if all opportunity-linked payments have `opportunityId`, consider tightening. Long-term, either split by subtype or enforce strict field combinations per discriminant.
- For `followUps`: Make `type` required (if not already). Consider adding subtype-specific compound indexes (e.g., `by_tenantId_and_closerId_and_type_and_status_and_reminderScheduledAt`).

Migration required: Yes for adding required discriminants. Index additions are safe.

---

### Finding 19: O(n×m) nested loops and N+1 patterns in detail and list queries

- Severity: **Medium**
- Source: Opus2 (unique finding with explicit complexity analysis)
- Affected:
  - `convex/leads/queries.ts:272-353` (`getLeadDetail` — iterates opportunities, then meetings per opportunity)
  - `convex/customers/queries.ts` (`getCustomerDetail` — same pattern)
  - `convex/closer/meetingDetail.ts` (`getMeetingDetail` — "all related meetings for this lead" embedded in detail)
  - `convex/opportunities/queries.ts:69-217` (`listOpportunitiesForAdmin` — N+1 enrichment per opportunity)

Why it matters:

For a lead with 10 opportunities, each with 5 meetings, that is 50+ individual index lookups in a single reactive query. This compounds with scale and causes excessive read bandwidth.

Recommended fix:

- For lead/customer detail: query meetings directly by a more targeted index and group in JS, rather than iterating per opportunity.
- For admin opportunity list: batch enrichment lookups with `Promise.all` over collected ID sets rather than per-record lookups. Paginate the outer query.
- For meeting detail: the "all related meetings for this lead" view should be a separate bounded query, not embedded in the detail page query.
- Consider adding `meetings.by_opportunityId_and_scheduledAt` for sorted meeting timelines.

Migration required: No for query changes. Yes if adding a `leadId` field to meetings.

---

### Finding 20: meetings.leadName and opportunities.hostCalendly* are stale denormalizations

- Severity: **Low**
- Source: Opus2 (F-04, F-05), Opus1 (denormalized field table)

Why it matters:

`meetings.leadName` is set at meeting creation and never updated. If a lead's name is corrected, meeting list UIs show the old name. `opportunities.hostCalendlyEmail/Name` describe the Calendly host at booking time and are never updated if the org member profile changes.

Recommended fix:

- For `meetings.leadName`: Either maintain it in the same mutation that updates `leads.fullName`, or resolve at query time via the opportunity → lead chain.
- For `opportunities.hostCalendly*`: Rename to `originalHostCalendly*` for clarity. For current host resolution, use `assignedCloserId → user → calendlyMemberName`. Or add a sync path in the org member sync flow.

Migration required: No for adding sync paths. Rename is safe.

---

### Finding 21: opportunities.calendlyEventUri duplicates meeting-level data

- Severity: **Low**
- Source: Opus2 (F-06 — unique finding, no other audit flags this)

Why it matters:

Each meeting already stores `calendlyEventUri`. The opportunity's copy is the first meeting's event URI — a 3NF violation. If an opportunity gains follow-up meetings, the opportunity's URI still points to the original booking.

Recommended fix:

Document as "original booking event URI" for attribution purposes. For new code, resolve via `latestMeetingId` or the first meeting in the chain. No code change needed unless the field causes confusion.

Migration required: No.

---

### Finding 22: rawWebhookEvents.payload stored as opaque string

- Severity: **Low**
- Source: Opus2 (F-20 — unique finding)
- Affected: `rawWebhookEvents.payload` (`v.string()`)

Why it matters:

The payload is stored as a JSON string, requiring `JSON.parse()` at every read. For analytics over webhook data (processing latency, event type distribution), the raw string cannot be indexed. However, this is primarily a log/replay table, not an analytics table.

Recommended fix:

Keep the payload as a string for replay fidelity. If webhook-level analytics are needed later, add extracted metadata fields (`bookingScheduledAt`, `eventTypeUri`) alongside the raw payload. This is not urgent.

Migration required: No if adding optional fields.

---

## 5. Query and Index Matrix

### Current index inventory (53 indexes across 15 tables)

| Table | Index | Fields |
| --- | --- | --- |
| `tenants` | `by_contactEmail` | `["contactEmail"]` |
| `tenants` | `by_workosOrgId` | `["workosOrgId"]` |
| `tenants` | `by_status` | `["status"]` |
| `tenants` | `by_inviteTokenHash` | `["inviteTokenHash"]` |
| `tenants` | `by_status_and_inviteExpiresAt` | `["status", "inviteExpiresAt"]` |
| `users` | `by_tenantId` | `["tenantId"]` |
| `users` | `by_workosUserId` | `["workosUserId"]` |
| `users` | `by_tenantId_and_email` | `["tenantId", "email"]` |
| `users` | `by_tenantId_and_calendlyUserUri` | `["tenantId", "calendlyUserUri"]` |
| `rawWebhookEvents` | `by_tenantId_and_eventType` | `["tenantId", "eventType"]` |
| `rawWebhookEvents` | `by_calendlyEventUri` | `["calendlyEventUri"]` |
| `rawWebhookEvents` | `by_processed` | `["processed"]` |
| `rawWebhookEvents` | `by_processed_and_receivedAt` | `["processed", "receivedAt"]` |
| `calendlyOrgMembers` | `by_tenantId` | `["tenantId"]` |
| `calendlyOrgMembers` | `by_tenantId_and_calendlyUserUri` | `["tenantId", "calendlyUserUri"]` |
| `calendlyOrgMembers` | `by_tenantId_and_matchedUserId` | `["tenantId", "matchedUserId"]` |
| `calendlyOrgMembers` | `by_tenantId_and_lastSyncedAt` | `["tenantId", "lastSyncedAt"]` |
| `leads` | `by_tenantId` | `["tenantId"]` |
| `leads` | `by_tenantId_and_email` | `["tenantId", "email"]` |
| `leads` | `by_tenantId_and_status` | `["tenantId", "status"]` |
| `leads` | `search_leads` (search) | searchField: `"searchText"`, filter: `["tenantId", "status"]` |
| `leadIdentifiers` | `by_tenantId_and_type_and_value` | `["tenantId", "type", "value"]` |
| `leadIdentifiers` | `by_leadId` | `["leadId"]` |
| `leadIdentifiers` | `by_tenantId_and_value` | `["tenantId", "value"]` |
| `leadMergeHistory` | `by_tenantId` | `["tenantId"]` |
| `leadMergeHistory` | `by_sourceLeadId` | `["sourceLeadId"]` |
| `leadMergeHistory` | `by_targetLeadId` | `["targetLeadId"]` |
| `opportunities` | `by_tenantId` | `["tenantId"]` |
| `opportunities` | `by_tenantId_and_leadId` | `["tenantId", "leadId"]` |
| `opportunities` | `by_tenantId_and_assignedCloserId` | `["tenantId", "assignedCloserId"]` |
| `opportunities` | `by_tenantId_and_status` | `["tenantId", "status"]` |
| `meetings` | `by_opportunityId` | `["opportunityId"]` |
| `meetings` | `by_tenantId_and_scheduledAt` | `["tenantId", "scheduledAt"]` |
| `meetings` | `by_tenantId_and_calendlyEventUri` | `["tenantId", "calendlyEventUri"]` |
| `closerUnavailability` | `by_tenantId_and_date` | `["tenantId", "date"]` |
| `closerUnavailability` | `by_closerId_and_date` | `["closerId", "date"]` |
| `meetingReassignments` | `by_tenantId` | `["tenantId"]` |
| `meetingReassignments` | `by_meetingId` | `["meetingId"]` |
| `meetingReassignments` | `by_toCloserId` | `["toCloserId"]` |
| `meetingReassignments` | `by_fromCloserId` | `["fromCloserId"]` |
| `meetingReassignments` | `by_unavailabilityId` | `["unavailabilityId"]` |
| `eventTypeConfigs` | `by_tenantId` | `["tenantId"]` |
| `eventTypeConfigs` | `by_tenantId_and_calendlyEventTypeUri` | `["tenantId", "calendlyEventTypeUri"]` |
| `customers` | `by_tenantId` | `["tenantId"]` |
| `customers` | `by_tenantId_and_leadId` | `["tenantId", "leadId"]` |
| `customers` | `by_tenantId_and_status` | `["tenantId", "status"]` |
| `customers` | `by_tenantId_and_convertedAt` | `["tenantId", "convertedAt"]` |
| `paymentRecords` | `by_opportunityId` | `["opportunityId"]` |
| `paymentRecords` | `by_tenantId` | `["tenantId"]` |
| `paymentRecords` | `by_tenantId_and_closerId` | `["tenantId", "closerId"]` |
| `paymentRecords` | `by_customerId` | `["customerId"]` |
| `followUps` | `by_tenantId` | `["tenantId"]` |
| `followUps` | `by_opportunityId` | `["opportunityId"]` |
| `followUps` | `by_tenantId_and_closerId` | `["tenantId", "closerId"]` |
| `followUps` | `by_tenantId_and_closerId_and_status` | `["tenantId", "closerId", "status"]` |

Note: `rawWebhookEvents.by_processed` is likely redundant — it is subsumed by the prefix of `by_processed_and_receivedAt`. Verify no callers use it alone before removing.

### Recommended new indexes (consolidated across all 5 audits)

Indexes are grouped by purpose. "Correctness" indexes fix current broken query shapes. "Analytics" indexes enable future reporting without full scans.

**Correctness — fix existing query shapes:**

| Table | Proposed index | Fields | Fixes |
| --- | --- | --- | --- |
| `opportunities` | `by_tenantId_and_assignedCloserId_and_status` | `["tenantId", "assignedCloserId", "status"]` | Closer pipeline, next meeting, calendar (Finding 5, 10) |
| `opportunities` | `by_tenantId_and_potentialDuplicateLeadId` | `["tenantId", "potentialDuplicateLeadId"]` | Merge duplicate-flag cleanup (Finding 11) |
| `customers` | `by_tenantId_and_convertedByUserId` | `["tenantId", "convertedByUserId"]` | Customer list for closers (Finding 10) |
| `customers` | `by_tenantId_and_convertedByUserId_and_status` | `["tenantId", "convertedByUserId", "status"]` | Filtered customer list for closers (Finding 10) |
| `followUps` | `by_tenantId_and_leadId_and_createdAt` | `["tenantId", "leadId", "createdAt"]` | Lead detail follow-ups (Finding 10, 11) |
| `followUps` | `by_tenantId_and_closerId_and_type_and_status_and_reminderScheduledAt` | `["tenantId", "closerId", "type", "status", "reminderScheduledAt"]` | Active reminders (Finding 10, 11) |
| `followUps` | `by_opportunityId_and_status` | `["opportunityId", "status"]` | Pending follow-up lookup in pipeline (Finding 11) |
| `rawWebhookEvents` | `by_tenantId_and_eventType_and_calendlyEventUri` | `["tenantId", "eventType", "calendlyEventUri"]` | Webhook dedupe (Finding 9, 11) |

**Analytics — enable reporting without full scans:**

| Table | Proposed index | Fields | Analytics use case |
| --- | --- | --- | --- |
| `opportunities` | `by_tenantId_and_createdAt` | `["tenantId", "createdAt"]` | Pipeline volume by date range |
| `opportunities` | `by_tenantId_and_status_and_createdAt` | `["tenantId", "status", "createdAt"]` | Status cohort analysis by time |
| `opportunities` | `by_tenantId_and_eventTypeConfigId` | `["tenantId", "eventTypeConfigId"]` | Event type stats (avoids full scan) |
| `meetings` | `by_tenantId_and_status_and_scheduledAt` | `["tenantId", "status", "scheduledAt"]` | No-show/completion rates by date range |
| `meetings` | `by_tenantId_and_meetingOutcome_and_scheduledAt` | `["tenantId", "meetingOutcome", "scheduledAt"]` | Outcome analytics by time |
| `meetings` | `by_opportunityId_and_scheduledAt` | `["opportunityId", "scheduledAt"]` | Meeting timeline per opportunity (sorted) |
| `paymentRecords` | `by_tenantId_and_recordedAt` | `["tenantId", "recordedAt"]` | Revenue over time |
| `paymentRecords` | `by_tenantId_and_status_and_recordedAt` | `["tenantId", "status", "recordedAt"]` | Verified vs disputed revenue trends |
| `paymentRecords` | `by_customerId_and_recordedAt` | `["customerId", "recordedAt"]` | Customer payment history sorted |
| `paymentRecords` | `by_tenantId_and_closerId_and_recordedAt` | `["tenantId", "closerId", "recordedAt"]` | Closer revenue over time |
| `leads` | `by_tenantId_and_firstSeenAt` | `["tenantId", "firstSeenAt"]` | Lead acquisition cohorts |
| `followUps` | `by_tenantId_and_status_and_createdAt` | `["tenantId", "status", "createdAt"]` | Follow-up pipeline aging |
| `meetingReassignments` | `by_tenantId_and_reassignedAt` | `["tenantId", "reassignedAt"]` | Reassignment frequency trends |
| `meetings` | `by_tenantId_and_status` | `["tenantId", "status"]` | Meeting status distribution |

**Deferred — depends on meetings.assignedCloserId denormalization (Finding 12):**

| Table | Proposed index | Fields | Use case |
| --- | --- | --- | --- |
| `meetings` | `by_tenantId_and_assignedCloserId_and_scheduledAt` | `["tenantId", "assignedCloserId", "scheduledAt"]` | Closer calendar, next meeting, redistribution |

### Hot operational query shapes and risk

| Query shape | Current path | Risk | Fix |
| --- | --- | --- | --- |
| Admin dashboard counts and sums | Full scan of `users`, `opportunities`, `meetings`, `paymentRecords` | 🔴 High | Replace with `tenantStats` summary doc (Finding 4) |
| Closer next meeting | `.collect()` all closer opps → filter "scheduled" → scan tenant meetings | 🔴 High | Add `by_tenantId_and_assignedCloserId_and_status`; later add `meetings.assignedCloserId` |
| Closer pipeline by status | `.collect()` all closer opps → count in JS | 🟡 Medium | Add `by_tenantId_and_assignedCloserId_and_status`; paginate |
| Closer calendar range | Derive opp IDs → scan tenant meetings by date → filter by ownership | 🔴 High | Denormalize `assignedCloserId` onto meetings |
| Lead list (active) | Paginate by `tenantId` → post-filter merged leads | 🟡 Medium | Backfill `leads.status`, make required, query by status index |
| Lead search (active) | Fetch 40 → filter statuses → truncate to 20 | 🟡 Medium | Same as above |
| Lead detail follow-ups | `followUps.by_tenantId` → filter by `leadId` in JS | 🔴 High | Add `followUps.by_tenantId_and_leadId_and_createdAt` |
| Customer list for closer | Paginate all tenant customers → filter by closer | 🔴 High | Add `customers.by_tenantId_and_convertedByUserId` |
| Customer payment totals | `.collect()` all payments per customer | 🟡 Medium | Denormalize `totalPaid` on customer doc |
| Active reminders | Fetch pending follow-ups → filter by `type` in JS | 🟡 Medium | Add compound type+status index |
| Event type stats | Scan all tenant opportunities → count by eventTypeConfigId | 🟡 Medium | Maintain summary counts or add `by_tenantId_and_eventTypeConfigId` |
| Admin opportunity list | `for await` unbounded + N+1 enrichment | 🟡 Medium | Paginate; batch enrichment |
| Revenue by time/status | `paymentRecords.by_tenantId` only | 🟡 Medium → 🔴 High at scale | Add `by_tenantId_and_recordedAt` and `by_tenantId_and_status_and_recordedAt` |

---

## 6. Integrity and Atomicity Review

### Ownership and tenant boundaries

**Strong.** Every public query and mutation calls `requireTenantUser()` or `requireSystemAdminSession()`. Tenant ID is derived server-side from the JWT identity, never from client arguments. All data tables include `tenantId`. No bypass paths were found.

### Reference validation and orphan risk

**Mostly good on writes, with lifecycle gaps:**

| Scenario | Status | Notes |
| --- | --- | --- |
| Opportunity → Lead | ✅ Validated | Pipeline creates both atomically |
| Meeting → Opportunity | ✅ Validated | Pipeline creates meeting after opportunity |
| Payment → Opportunity/Meeting | ✅ Validated | `logPayment` loads and validates both |
| Customer → Lead | ✅ Validated | `executeConversion` loads lead in same mutation |
| FollowUp → Opportunity/Lead | ✅ Validated | Created from loaded opportunity context |
| User deletion → orphan references | ⚠️ No cascade | `removeUser` hard-deletes without reassigning opportunities or cleaning references (Finding 8) |
| Tenant deletion → orphan data | ⚠️ Incomplete | Only covers 3 of 14+ tables (Finding 7) |
| Lead deletion → orphan opps | ⚠️ Low risk | Leads are never hard-deleted (only merged/converted), but no explicit guard |

### Write atomicity

**Strong for core flows:**
- Status transitions on opportunities and meetings happen in the same mutation as related record creation
- `updateOpportunityMeetingRefs` runs inside the same mutation as meeting changes
- `logPayment` creates payment + transitions opportunity + auto-converts lead atomically
- `mergeLead` moves opportunities, identifiers, and writes merge history atomically

**Actions with sequential mutations:**
- `inviteUser`, `updateUserRole`, and Calendly OAuth flows use actions that call external APIs then write to the database. If the external call succeeds but the mutation fails, there is a mismatch. This is acceptable for the action pattern but should be documented.

**Missing atomic writes:**
- Business event facts are not written alongside state transitions (because `domainEvents` table does not exist yet)
- Reporting summaries are not updated atomically (because summary tables do not exist yet)

### Denormalized-field maintenance

| Denormalized field | Maintained correctly? | Risk |
| --- | --- | --- |
| `opportunities.latestMeeting*/nextMeeting*` | ✅ Via `updateOpportunityMeetingRefs()` in all relevant mutations | Low |
| `leads.searchText` | ✅ Via `updateLeadSearchText()` in pipeline and lead mutations | Low |
| `leads.socialHandles` | ✅ Rebuilt in pipeline `inviteeCreated` and `mergeLead` | Low (some non-merge identifier paths may not trigger rebuild) |
| `users.calendlyMemberName` | ✅ Updated on link/sync | Low |
| `meetings.leadName` | ⚠️ Set at creation only | Low (lead names rarely change after extraction) |
| `opportunities.hostCalendly*` | ⚠️ Set at creation only | Low (host profiles rarely change) |
| `customers.fullName/email/phone/socialHandles` | ❌ Never refreshed after conversion | Medium (drifts if lead data corrected — Finding 15) |

### Business-key uniqueness

**Soft, not hard.** Duplicate handling is implemented ad hoc rather than as a strongly owned invariant. The clearest example: `eventTypeConfigs` loads up to 8 candidates for the same `(tenantId, calendlyEventTypeUri)` and picks the oldest. This is manageable at small scale but dangerous once aggregate reporting depends on clean uniqueness (Finding 9).

---

## 7. Migration Notes

### Safe additive changes (ship directly)

These do not affect existing documents and can be deployed without migration:

1. **New `domainEvents` table** — append-only, purely additive (Finding 1)
2. **New `tenantStats` summary table** — additive, backfill initial values from a one-time action (Finding 4)
3. **New `meetingFormResponses` and `eventTypeFieldCatalog` tables** — additive (Finding 2)
4. **New indexes** — all 22 recommended indexes from Section 5 (Finding 5, 10, 11, 13)
5. **Optional lifecycle timestamps** — `lostAt`, `canceledAt`, `completedAt`, etc. (Finding 16)
6. **Optional attribution fields** — `lostByUserId`, `noShowMarkedByUserId`, etc. (Finding 17)
7. **Soft-delete fields on `users`** — `deletedAt`, `isActive` (Finding 8)
8. **Tenant deletion cascade fix** — code change only (Finding 7)
9. **Customer snapshot sync path** — mutation logic change (Finding 15)
10. **Query optimizations** — replacing `.collect()` with `.take(n)` or `.paginate()`, batching enrichment

### Changes that need widen-migrate-narrow

These affect existing documents and require the `convex-migration-helper` skill:

1. **`leads.status`** — backfill `undefined` → `"active"`, then make required (Finding 6)
2. **`leads.customFields`** — change `v.any()` to structured validator (Finding 2)
3. **`paymentRecords.amount`** → `amountMinor` as integer minor units (Finding 3)
4. **`meetings.assignedCloserId`** — add as optional, backfill from opportunity, switch reads (Finding 12)
5. **`customers.totalPaid/totalPaymentCount`** — add as optional, backfill, wire mutations (Finding 4)
6. **`paymentRecords` discriminant** — if adding required `contextType` (Finding 18)
7. **`tenantCalendlyConnections` extraction** — move OAuth fields from `tenants` (Finding 14)

### Index additions that may need staged rollout

If any table has significant row counts, use staged indexes:
- `opportunities` — likely candidate as pipeline grows
- `meetings` — likely candidate
- `paymentRecords` — depends on volume
- `followUps` — depends on volume

### Data cleanup work to schedule before reporting rollout

- Audit for orphaned tenant-scoped rows left behind by prior offboarding runs (Finding 7)
- Audit for orphaned user references from prior `removeUser` calls (Finding 8)
- Deduplicate `eventTypeConfigs` by `(tenantId, calendlyEventTypeUri)` (Finding 9)
- Audit for duplicate raw webhook rows by intended ingest key (Finding 9)
- Audit for duplicate `customers` by `(tenantId, leadId)` (Finding 9)
- Audit payment currencies per tenant before any revenue dashboard is treated as authoritative (Finding 3)

---

## 8. Remediation Plan

### Immediate — correctness, integrity, and highest-value analytics foundations

| # | Action | Findings | Effort |
| --- | --- | --- | --- |
| 1 | **Fix tenant offboarding** — extend `deleteTenantRuntimeDataBatch` to cascade across all tenant-scoped tables | 7 | Medium |
| 2 | **Replace user hard-delete with soft delete** — add `deletedAt`/`isActive` fields, audit existing orphans | 8 | Medium |
| 3 | **Add `domainEvents` table** and start emitting from highest-value mutations: opportunity status changes, meeting lifecycle, payment logging, customer conversion, follow-up transitions, user lifecycle | 1 | Medium |
| 4 | **Add correctness indexes** — the 8 indexes that fix current broken query shapes (Section 5, "Correctness" group) | 5, 10, 11 | Small |
| 5 | **Deduplicate `eventTypeConfigs`** — one-time cleanup, collapse to single canonical write path | 9 | Small |
| 6 | **Stop treating revenue as a single summed number** — at minimum, aggregate by currency per tenant/customer; add currency validation | 3 | Small |

### Next — query performance, data model hardening, and reporting readiness

| # | Action | Findings | Effort |
| --- | --- | --- | --- |
| 7 | **Backfill `leads.status`** and make it required — stop post-paginate/post-search filtering | 6, 10 | Medium |
| 8 | **Replace dashboard full-table scans** — create `tenantStats` summary table, maintain counters in mutations, rewrite `getAdminDashboardStats` | 4 | Medium |
| 9 | **Denormalize `totalPaid` on customers** — add optional field, backfill, wire into payment mutations, remove `.collect()` aggregation | 4 | Medium |
| 10 | **Add analytics indexes** — the 14 indexes from Section 5 "Analytics" group | 13 | Small |
| 11 | **Add lifecycle timestamps** — `lostAt`, `canceledAt`, `paymentReceivedAt`, `completedAt`, `verifiedAt`, `churnedAt`, `bookedAt` | 16 | Small |
| 12 | **Add user attribution fields** — `lostByUserId`, `noShowMarkedByUserId`, `verifiedByUserId` | 17 | Small |
| 13 | **Normalize booking answers** — add `meetingFormResponses` and `eventTypeFieldCatalog` tables, dual-write, backfill from retained raw webhooks (time-critical — 30-day window) | 2 | Large |
| 14 | **Correct the payment model** — add `amountMinor` as integer minor units, dual-write, backfill, switch reads | 3 | Medium |
| 15 | **Fix customer snapshot sync** — patch linked customer when lead identity fields change | 15 | Small |
| 16 | **Bound unbounded queries** — add `.take(n)` guards to `listMyOpportunities`, `getPipelineSummary`, `listTeamMembers`; paginate admin opportunity list | 4, 5, 19 | Small |

### Later — structural improvements for scale

| # | Action | Findings | Effort |
| --- | --- | --- | --- |
| 17 | **Add `meetings.assignedCloserId`** — denormalize, backfill, switch closer calendar/dashboard/redistribution reads | 12 | Medium |
| 18 | **Add event type stats summary** — maintain counts on `eventTypeConfigs` or dedicated stats table | 4 | Small |
| 19 | **Make `paymentRecords` and `followUps` explicitly discriminated** — add `contextType`/strengthen `type`, enforce field combinations | 18 | Medium |
| 20 | **Split `tenants`** — extract OAuth/integration state into `tenantCalendlyConnections` | 14 | Large |
| 21 | **Evaluate customer model** — if post-sale operations expand, consider canonical `contacts`/`parties` model | 15 | Large |
| 22 | **Stream business facts to warehouse** — plan export path for heavier OLAP workloads | 1 | Large |

---

## 9. Appendices

### Appendix A: Proposed domainEvents table schema

```ts
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
  eventType: v.string(), // e.g. "status_changed", "payment_recorded", "user_invited"
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
  metadata: v.optional(v.string()), // JSON string for additional typed context
})
  .index("by_entityId", ["entityId"])
  .index("by_tenantId_and_occurredAt", ["tenantId", "occurredAt"])
  .index("by_tenantId_and_entityType_and_entityId_and_occurredAt", [
    "tenantId",
    "entityType",
    "entityId",
    "occurredAt",
  ])
  .index("by_tenantId_and_eventType_and_occurredAt", [
    "tenantId",
    "eventType",
    "occurredAt",
  ])
  .index("by_tenantId_and_actorUserId_and_occurredAt", [
    "tenantId",
    "actorUserId",
    "occurredAt",
  ]),
```

This table enables:
- **Funnel analysis**: How many opportunities went from `scheduled` → `in_progress` → `payment_received` vs `scheduled` → `canceled`
- **Stage duration**: Average time in `in_progress` before payment or loss
- **Closer performance**: Which closer has the fastest cycle time, lowest no-show rate
- **Trend analysis**: Status change velocity over time by tenant
- **Audit trail**: Who changed what, when, and why

### Appendix B: Proposed tenantStats table schema

```ts
tenantStats: defineTable({
  tenantId: v.id("tenants"),
  // Team
  totalTeamMembers: v.number(),
  totalClosers: v.number(),
  // Pipeline
  totalOpportunities: v.number(),
  activeOpportunities: v.number(),
  wonDeals: v.number(),
  lostDeals: v.number(),
  // Revenue
  totalRevenueRecorded: v.number(),
  totalPaymentRecords: v.number(),
  // Leads & Customers
  totalLeads: v.number(),
  totalCustomers: v.number(),
  // Bookkeeping
  lastUpdatedAt: v.number(),
}).index("by_tenantId", ["tenantId"]);
```

Maintained by a helper called from:
- User create/delete mutations → team counts
- Opportunity status change mutations → pipeline counts
- Payment record mutations → revenue counts
- Lead create/merge mutations → lead counts
- Customer conversion mutations → customer counts

The dashboard query becomes a single `ctx.db.query("tenantStats").withIndex("by_tenantId", q => q.eq("tenantId", tenantId)).unique()` instead of four full-table scans.

### Appendix C: Proposed meetingFormResponses and eventTypeFieldCatalog schemas

```ts
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
```

---

## 10. Cross-Reference Matrix

This section documents which source audit contributed each finding, and where disagreements were resolved.

| Finding | GPT1 | GPT2 | GPT3 | Opus2 | Opus1 | Severity consensus | Resolution notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1. No event history | F2 ✅ | F1 ✅ | F1 ✅ | F-07 ✅ | 2.1 ✅ | All High | Single `domainEvents` table (GPT3 approach) over multiple entity tables or narrow `statusChanges` |
| 2. customFields blob | F6 ✅ | F2 ✅ | F2 ✅ | F-02 ✅ | 2.6 ✅ | 3 High, 2 Medium → **High** | GPT1/2/3 make stronger case re: provenance loss; GPT3 adds backfill constraint from 30-day webhook cleanup |
| 3. Payment model | F3 ✅ | — | F5 ✅ | — | — | Both High | GPT3 adds `v.int64()` recommendation |
| 4. Dashboard scans | — | F3 ✅ | F7 partial | F-10/12/14 ✅ | 2.2/2.3 ✅ | All High | Consolidated dashboard, customer totals, event type stats, admin opp list |
| 5. Closer scan+filter | F4 ✅ | F4 ✅ | F4 ✅ | F-11 ✅ | 2.3 ✅ | All High except Opus1 Medium → **High** | — |
| 6. leads.status optional | F5 ✅ | F5 partial | — | — | 2.11 ✅ | GPT1 High, Opus1 Low → **High** | Affects every lead query; causes pagination/search correctness issues |
| 7. Tenant offboarding | F1 ✅ | F9 ✅ | — | F-21 ✅ | — | All High | — |
| 8. User hard-delete | — | — | F3 ✅ | — | Partial ✅ | GPT3 High → **High** | Unique to GPT3; verified against code |
| 9. Soft uniqueness | F8 ✅ | F7 ✅ | F8 ✅ | — | — | GPT1/GPT3 Medium, GPT2 High → **High** | Runtime Insights OCC conflicts confirm; affects analytics dimensions |
| 10. Post-filter pagination | F4 ✅ | F5 ✅ | — | — | — | GPT1 High, GPT2 Medium → **High** | Correctness issue, not just performance |
| 11. Missing relationship indexes | — | F6 ✅ | — | F-17 ✅ | — | GPT2 High, Opus2 Medium → **High** | Includes specific indexes missing for known query shapes |
| 12. meetings lacks closer | — | — | F4 ✅ | F-19 ✅ | — | GPT3 High, Opus2 Medium → **Medium** | Requires migration; planned improvement |
| 13. Missing analytics indexes | F7 ✅ | — | F7 partial | F-16 ✅ | 2.9 ✅ | GPT1 Medium, Opus2 High, Opus1 Medium → **Medium** | — |
| 14. tenants mixed concerns | F9 ✅ | — | F6 ✅ | F-01 ✅ | 2.14 ✅ | Low/Medium/High → **Medium** | Opus2 quantified 16 invalidations/day; not primary analytics blocker |
| 15. Customer snapshot drift | — | — | — | F-03 ✅ | 2.7 ✅ | Both Medium | Add sync path, not remove fields |
| 16. Missing timestamps | — | — | — | — | 2.4 ✅ | Medium | Unique to Opus1 |
| 17. Missing attribution | — | — | — | — | 2.5 ✅ | Medium | Unique to Opus1 |
| 18. Polymorphic tables | — | F8 ✅ | — | F-09 ✅ | — | Both Medium | Consolidates GPT2 polymorphism + Opus2 optional FK findings |
| 19. O(n×m) detail queries | — | — | — | F-13 ✅ | — | Medium | Unique to Opus2 |
| 20. Stale denormalizations | — | — | — | F-04/05 ✅ | Partial ✅ | Low | — |
| 21. calendlyEventUri dupe | — | — | — | F-06 ✅ | — | Low | Unique to Opus2 |
| 22. Webhook payload string | — | — | — | F-20 ✅ | — | Low | Unique to Opus2 |

---

## Bottom Line

The current schema is a solid operational CRM foundation, but it is not yet an analytics-ready data model.

What is strong:
- Tenant-scoped core entities with server-side isolation
- Normalized lead identity via `leadIdentifiers`
- Justified and well-maintained denormalized meeting refs
- Immutable audit tables for merges and reassignments
- Typed status unions and validated arguments throughout

What is missing:
- Durable event history for lifecycle facts
- Interaction-level booking-answer data instead of a merged blob
- A stable actor model (users must survive deactivation)
- A direct closer/time meeting dimension
- A reporting-safe money model
- The focused index layer around tenant + owner + status + time
- Summary/digest tables for dashboard-grade reads

If the remediation plan is followed in sequence — facts first, correctness fixes next, targeted indexes, then structural improvements — the current CRM can keep operating while a reporting foundation is built that will not force full scans or historical guesswork later.
