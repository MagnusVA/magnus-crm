# Definitive Database Audit Report

Date: 2026-04-12

This report is a consolidation of five independent database audits conducted on 2026-04-11, cross-referenced against `.docs/best-practices/convex-db-best-practices.md` and verified against the live codebase.

Source audits:

- `database-audit-gpt1.md` (GPT1)
- `database-gpt2.md` (GPT2)
- `database-audit-gpt3.md` (GPT3)
- `database-opus1.md` (Opus1)
- `database-audit-opus2.md` (Opus2)

Methodology:

- Every finding from every audit is included.
- Where audits agree, the finding is marked with its consensus severity and the strongest evidence from any source.
- Where audits contradict each other on severity or approach, the contradiction is noted and resolved with reasoning.
- Findings unique to one or two audits are preserved and marked as such.
- Recommendations represent the resolved middle ground, not any single audit's opinion.

Runtime signal: Convex Insights reported 2 warnings in the 72 hours prior to audit. One was `webhooks/calendlyMutations.persistRawEvent` with 2 OCC conflicts on `rawWebhookEvents` on 2026-04-10, confirming that webhook dedupe and ingest uniqueness are under concurrency pressure.

---

## 1. Executive Summary

All five audits independently reached the same core conclusion: the current schema is a solid operational CRM foundation, but it is not yet an analytics-grade data model.

The strongest parts of the current design are:

- Tenant-scoped core entities with consistent server-side access control via `requireTenantUser`
- Normalized lead identity via `leadIdentifiers`
- Justified denormalized meeting refs on `opportunities` with centralized maintenance
- Immutable audit tables for merges (`leadMergeHistory`) and reassignments (`meetingReassignments`)
- Status fields modeled as unions/literals, not freeform strings
- Cross-table relationships using typed `v.id("table")` references

The five main gaps, confirmed across all audits, are:

1. **No durable event history** — status transitions overwrite in place; the model cannot answer "what happened over time"
2. **Custom fields are an untyped blob** — `leads.customFields` uses `v.any()`, loses per-interaction provenance, and is not queryable
3. **Scan-on-read aggregates** — dashboards and summary screens scan full operational tables on every reactive render
4. **Missing relationship and analytics indexes** — several hot reads depend on post-fetch JS filtering instead of index-level predicates
5. **Unsafe money model** — floating-point amounts with no currency controls produce silently wrong revenue totals

The right next step is not to speculatively add every possible index. The priority order is:

1. Preserve lifecycle facts as append-only events
2. Fix current correctness risks (tenant offboarding, user deletion, money model, query shapes)
3. Normalize the fields already known to matter for reporting
4. Add a focused index layer around tenant + owner + status + time
5. Reserve OLAP-style reporting for an eventual external warehouse

---

## 2. Domain and Data Model Summary

### Table inventory (15 tables)

| Table                  | Responsibility                                                         | Record type          | Assessment                                                                       |
| ---------------------- | ---------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------- |
| `tenants`              | Multi-tenant root; identity, lifecycle, Calendly OAuth, webhook config | Canonical            | Functional but overloaded — mixes stable identity with high-churn token state    |
| `users`                | CRM team members; WorkOS identity, CRM role, Calendly link             | Canonical            | Good normalized core; currently hard-deleted (orphan risk)                       |
| `rawWebhookEvents`     | Append-only webhook inbox and replay surface                           | Operational staging  | Good ingestion table; weak idempotency lookup; 30-day retention via cleanup cron |
| `calendlyOrgMembers`   | Synced Calendly org member mirror                                      | Derived (sync cache) | Good normalized integration table                                                |
| `leads`                | Inbound contacts from Calendly bookings or manual entry                | Canonical            | Core entity; weakened by `customFields` blob and optional `status`               |
| `leadIdentifiers`      | Multi-identifier model (email, phone, social handles) per lead         | Canonical            | Strong normalization choice — best part of the schema                            |
| `leadMergeHistory`     | Audit trail for lead merge operations                                  | Canonical (log)      | Good immutable audit table                                                       |
| `opportunities`        | Sales pipeline entity linking lead → closer → meetings                 | Canonical            | Good core entity with justified denormalized meeting refs                        |
| `meetings`             | Individual Calendly meetings within an opportunity                     | Canonical            | Good core entity; lacks direct closer dimension for schedule queries             |
| `closerUnavailability` | Closer time-off / unavailability windows                               | Canonical            | Good normalized table                                                            |
| `meetingReassignments` | Audit trail for meeting redistributions                                | Canonical (log)      | Good immutable audit table                                                       |
| `eventTypeConfigs`     | Calendly event type CRM overlays (field mappings, payment links)       | Canonical            | Useful dimension table; duplicate handling is weak                               |
| `customers`            | Post-conversion customer snapshot and status                           | Canonical + snapshot | Acceptable if snapshot is intentional; identity fields drift from lead           |
| `paymentRecords`       | Payment evidence per opportunity/meeting/customer                      | Canonical            | Too polymorphic; money representation unsafe for enterprise reporting            |
| `followUps`            | Follow-up scheduling links and manual reminders                        | Canonical            | Too polymorphic — two subtypes with disjoint attributes in one table             |

### Existing denormalized fields

| Field(s)                                                               | On table        | Source of truth             | Maintained by                           | Status                                               |
| ---------------------------------------------------------------------- | --------------- | --------------------------- | --------------------------------------- | ---------------------------------------------------- |
| `latestMeetingId`, `latestMeetingAt`, `nextMeetingId`, `nextMeetingAt` | `opportunities` | `meetings`                  | `updateOpportunityMeetingRefs()`        | ✅ Well-maintained                                   |
| `socialHandles`                                                        | `leads`         | `leadIdentifiers`           | `updateLeadSocialHandles()` in pipeline | ⚠️ Not rebuilt on merge or manual identifier changes |
| `searchText`                                                           | `leads`         | lead fields + identifiers   | `updateLeadSearchText()`                | ✅ Well-maintained                                   |
| `calendlyMemberName`                                                   | `users`         | `calendlyOrgMembers`        | `upsertMember()` on sync                | ✅ Well-maintained                                   |
| `leadName`                                                             | `meetings`      | `leads.fullName`            | Set at creation only                    | ⚠️ Never updated after creation                      |
| `hostCalendlyEmail`, `hostCalendlyName`                                | `opportunities` | `calendlyOrgMembers` / user | Set at creation only                    | ⚠️ Never updated after creation                      |
| `fullName`, `email`, `phone`, `socialHandles`                          | `customers`     | `leads` + `leadIdentifiers` | Snapshot at conversion                  | ⚠️ Never refreshed — intentional snapshot but drifts |

### Normalization assessment

| Level | Status      | Notes                                                                                                                                                                                                                                                                                                           |
| ----- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1NF   | Mostly good | `leads.customFields` (`v.any()`) is the exception — untyped, unbounded, shape unknown                                                                                                                                                                                                                           |
| 2NF   | Good        | Junction/relationship tables store only relationship-relevant attributes. Minor exception: `opportunities.hostCalendly*` describes the Calendly host membership, not the opportunity itself                                                                                                                     |
| 3NF   | Partial     | `customers` duplicates lead identity fields. `meetings.leadName` duplicates `leads.fullName`. `opportunities.calendlyEventUri` duplicates meeting-level data. Well-maintained denormalizations (`latestMeeting*`, `searchText`) demonstrate the team understands the pattern; unmaintained ones are legacy gaps |

### Current analytics posture

- There are approximately 23 direct `posthog.capture(...)` callsites across `app/`, `hooks/`, and `lib/`.
- `lib/posthog-capture.ts:43-60` exists as a server-side capture helper but has no active call sites in the app code.
- There is no first-class Convex table for business events, status transitions, or user interaction facts.
- Reporting would currently have to be reconstructed from mutable current-state tables, a few narrow audit tables, and external PostHog events that are not modeled as relational business facts.
- Processed raw webhook payloads are cleaned up after 30 days (`convex/webhooks/cleanup.ts`), which means historical per-meeting booking answers can only be reconstructed from retained raw events, not from the full system lifetime.

### What the model supports well today

- Current-state pipeline views
- Tenant-scoped operational pages
- Lead search (via `searchText` denormalization)
- Meeting scheduling views
- Basic customer conversion tracking
- Narrow workflow histories for merge and reassignment

### What the model does not support well today

- Funnel transition counts over time
- Time-in-stage and stage-to-stage duration reporting
- Historical assignment history beyond meeting reassignment
- Team lifecycle analytics (invite-to-accept latency, user tenure)
- Reliable filtering on custom-field values
- Currency-safe revenue analytics
- Cross-cutting activity timelines built from first-class facts
- Closer performance analytics (conversion velocity, no-show rate trends)

---

## 3. Findings

### Finding 1 — No durable event history for status transitions or business actions

|                  |                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| **Severity**     | High                                                                                              |
| **Confirmed by** | All 5 audits (GPT1 F2, GPT2 F1, GPT3 F1, Opus1 F2.1, Opus2 F-07/F-08)                             |
| **Affected**     | `opportunities`, `meetings`, `followUps`, `leads`, `customers`, `users`, app-side PostHog capture |

**Why it matters:**

Every status transition overwrites the previous value in place. There is no record of when an opportunity became "lost", who transitioned it, what the previous status was, or how long it spent in each stage. Questions like "what is the average time-to-payment by closer?", "what is the no-show rate trend over time?", or "how many opportunities moved from scheduled to in_progress to payment_received vs. scheduled to canceled?" cannot be answered from the current model without reconstructing events from mutable rows and external PostHog captures.

PostHog captures clicks and product interactions, but those events are external, partial, client-heavy, and not modeled as relational facts tied to CRM entities.

**Evidence:**

- `convex/schema.ts:208-253` — opportunities store only current status plus `createdAt`/`updatedAt`
- `convex/schema.ts:255-338` — meetings store some lifecycle fields but not a general event log
- `convex/schema.ts:481-520` — followUps store current status, not transition history
- `convex/schema.ts:53-81` — users have no lifecycle timestamps (`invitedAt`, `acceptedAt`, `removedAt`)
- Client-side `posthog.capture(...)` calls exist in `app/` but there is no Convex-side event table mirroring them

**Resolution of audit differences:**

The five audits disagreed on table design:

- GPT1 and GPT2 recommended multiple per-entity event tables (`opportunityEvents`, `meetingEvents`, etc.)
- GPT3 recommended a single `domainEvents` table with an `entityType` discriminator
- Opus1 recommended a single `statusChanges` table with `entityType` union and provided a concrete schema
- Opus2 recommended a single `activityLog` table

**Resolved recommendation: single table with entity-type discriminator.** In Convex, a single `domainEvents` table is better than multiple per-entity tables because:

- It avoids table proliferation (Convex has no cross-table unions)
- Cross-entity timeline queries work without combining results from multiple tables
- `entityType` discriminator in compound indexes provides efficient per-entity-type filtering
- The schema is simpler to maintain and extend

Recommended schema (adapted from Opus1's concrete proposal):

```
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
```

Mutations that should emit domain events:

- Opportunity status transitions (all state machine paths)
- Meeting lifecycle changes (started, completed, no-show, canceled)
- Follow-up lifecycle changes (created, booked, completed, expired)
- Payment recording, verification, dispute
- Customer conversion and status changes
- User invitation, acceptance, role change, removal
- Lead merge

**Analytics boundary:** Keep high-volume UI clickstream in PostHog. Do not put every raw click into operational tables. If a business interaction needs first-class reporting inside the CRM, emit it as a `domainEvents` row. Plan to export these facts to a warehouse for heavier OLAP workloads.

**Migration required:** No — additive. New table, no existing data affected. Behavioral change is dual-write from all relevant mutation paths.

---

### Finding 2 — `leads.customFields` is an untyped blob that loses per-interaction provenance

|                  |                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | High                                                                                                                   |
| **Confirmed by** | All 5 audits (GPT1 F6, GPT2 F2, GPT3 F2, Opus1 F2.6, Opus2 F-02)                                                       |
| **Affected**     | `convex/schema.ts:110-156`, `convex/pipeline/inviteeCreated.ts:252-265`, `convex/pipeline/inviteeCreated.ts:1180-1194` |

**Why it matters:**

This is the single biggest analytics-model issue in the current schema. Today, booking answers are merged into `leads.customFields` as a `v.any()` blob. This has four consequences:

1. **History loss** — If the same lead books multiple meetings and answers a question differently each time, only the merged/latest view is preserved, not the per-interaction fact.
2. **Weak provenance** — You cannot answer "which meeting produced this answer?" without reconstructing from retained raw webhooks (which are cleaned up after 30 days).
3. **Poor analytics shape** — Question labels are free-form strings, there is no stable field catalog, no typed answer model, and no per-meeting fact table.
4. **Schema unsafety** — `v.any()` bypasses schema validation entirely. The runtime code clearly expects `Record<string, string>`, but the schema accepts anything.

This is also inconsistent with the design direction documented in `plans/v0.5/version0-5.md:92`, which expected a per-meeting copy of booking/form data.

**Backfill constraint (unique to GPT3):** Processed raw webhook payloads are cleaned up every day with a 30-day retention window (`convex/webhooks/cleanup.ts:5-29`, `convex/webhooks/cleanupMutations.ts:17-29`). Historical per-meeting answers can only be backfilled from retained raw events, not for the full lifetime of the system. This creates a deadline for backfill work.

**Resolution of audit differences:**

The audits differed on the recommended fix:

- Opus1 and Opus2 recommended short-term type narrowing to `v.record(v.string(), v.string())`
- GPT1 recommended normalized child tables (`meetingCustomFieldFacts`, `leadAttributeFacts`)
- GPT2 recommended `leadCustomFieldValues` with per-meeting provenance
- GPT3 recommended `eventTypeFieldCatalog` + `meetingFormResponses` (preferred) or `meetings.customFormData` snapshot

**Resolved recommendation: three-phase approach.**

Phase 1 (immediate): Narrow the type from `v.any()` to `v.optional(v.record(v.string(), v.string()))`. This is a type-narrowing migration but improves validation without a complex restructure.

Phase 2 (next): Add per-meeting booking answer capture. Either:

- Add `meetings.bookingAnswers: v.optional(v.array(v.object({ question: v.string(), answer: v.string() })))` for a bounded meeting-level snapshot, or
- Add a `meetingFormResponses` child table for full normalization

Phase 3 (later, if analytics on custom field values becomes a hard requirement): Add a `eventTypeFieldCatalog` dimension table and normalize historical data.

Keep a bounded current-state summary on `leads` if the UI still benefits from it, but do not treat it as the reporting source of truth.

**Migration required:** Yes — type change on existing field. Requires widen-migrate-narrow via `convex-migration-helper`. Start backfilling per-meeting answers from retained raw webhooks before the 30-day retention window erases them.

---

### Finding 3 — Dashboard and summary queries scan full operational tables

|                  |                                                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | High                                                                                                                                                             |
| **Confirmed by** | All 5 audits (GPT1 F4, GPT2 F3, GPT3 F7, Opus1 F2.2, Opus2 F-10)                                                                                                 |
| **Affected**     | `convex/dashboard/adminStats.ts:24-111`, `convex/customers/queries.ts:12-80`, `convex/customers/queries.ts:146-215`, `convex/eventTypeConfigs/queries.ts:46-108` |

**Why it matters:**

- `getAdminDashboardStats` runs four unbounded async iterators over `users`, `opportunities`, `meetings`, and `paymentRecords` — effectively four full table scans per dashboard render.
- `listCustomers` and `getCustomerTotalPaid` recompute payment totals from raw payment rows on every read. Every customer in a paginated list triggers a `.collect()` on that customer's payment records — a nested N+1 pattern.
- `getEventTypeConfigsWithStats` scans all tenant opportunities to compute booking counts and last-booking timestamps.
- Because Convex queries are reactive, scan-heavy reads also increase invalidation cost. Every write to any of the scanned tables causes re-execution.

**Recommended fix:**

Add maintained summary documents or tables:

- `tenantDashboardStats` — per-tenant counters maintained atomically by mutations that change the underlying records. The dashboard reads a single document instead of scanning four tables.
- Customer financial summary — maintain `totalPaid` and `paymentCount` directly on the `customers` document or a `customerFinancialSummary` table. Update atomically in `logPayment` and `recordCustomerPayment`.
- Event type stats — maintain `opportunityCount` / `lastBookedAt` on `eventTypeConfigs` records, updated when opportunities are created.

**Migration required:** No for new summary tables — additive. Yes if making customer financial summary fields required (add as optional, backfill, then narrow).

---

### Finding 4 — Closer scheduling and pipeline reads depend on scan + filter patterns and lack a direct meeting-to-closer dimension

|                  |                                                                                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | High                                                                                                                                                                                                                               |
| **Confirmed by** | All 5 audits (GPT1 F4, GPT2 F4, GPT3 F4, Opus1 F2.3, Opus2 F-11/F-19)                                                                                                                                                              |
| **Affected**     | `convex/closer/dashboard.ts:13-75`, `convex/closer/dashboard.ts:85-119`, `convex/closer/pipeline.ts:24-69`, `convex/closer/calendar.ts:15-84`, `convex/unavailability/shared.ts:75-150`, `convex/unavailability/shared.ts:153-240` |

**Why it matters:**

The app repeatedly:

1. Collects all opportunities for a closer via `.collect()`
2. Filters by status in JavaScript
3. Scans tenant meetings by date
4. Filters those meetings back down by opportunity ownership

This pattern is the root cause of multiple performance issues:

- Closer dashboard next-meeting lookup
- Closer calendar rendering
- Redistribution/unavailability scheduling logic
- Closer pipeline summary and list
- Any future reporting by closer + meeting date

A closer with 500+ opportunities (accumulated over time across all statuses) triggers increasingly expensive reads, and the subsequent `Promise.all` enrichment amplifies the cost.

The root cause is that `meetings` does not carry a direct closer key — it must be resolved through `opportunity.assignedCloserId`. This forces every closer-scoped meeting query into a two-hop pattern.

**Resolution of audit differences:**

- GPT1 did not recommend `meetings.assignedCloserId` denormalization
- GPT2 recommended it as a "Later" item
- GPT3 recommended it as a High-priority item with concrete index proposals
- Opus1 and Opus2 recommended it as Medium-priority

**Resolved recommendation: two-part fix.**

Part A (immediate): Add `opportunities.by_tenantId_and_assignedCloserId_and_status` index. This eliminates the `.collect()` + JS filter patterns for closer-specific opportunity views without any schema change.

Part B (next): Add `meetings.assignedCloserId` as an intentional denormalized dimension.

- New optional field: `assignedCloserId: v.optional(v.id("users"))`
- Index: `by_tenantId_and_assignedCloserId_and_scheduledAt`
- Maintenance: set on creation, update when the owning opportunity is reassigned
- Treat as a read-optimized projection of `opportunities.assignedCloserId`

Part B requires a widen-migrate-narrow migration (add as optional, backfill from opportunity ownership, then switch reads to the new index).

Also paginate pipeline lists instead of returning unbounded arrays.

**Migration required:** No for Part A (index-only). Yes for Part B (new field on existing documents).

---

### Finding 5 — Money model is unsafe for enterprise reporting

|                  |                                                                                                                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | High                                                                                                                                                                                                                       |
| **Confirmed by** | GPT1 F3, GPT3 F5. Partially noted by GPT2, Opus1, Opus2                                                                                                                                                                    |
| **Affected**     | `convex/schema.ts:456-479`, `convex/closer/payments.ts:38-178`, `convex/customers/queries.ts:56-63`, `convex/customers/queries.ts:147-154`, `convex/customers/queries.ts:206-214`, `convex/dashboard/adminStats.ts:78-110` |

**Why it matters:**

The current payment model is not safe for enterprise reporting:

- `paymentRecords.amount` is a floating-point `v.number()`. Floating-point arithmetic is not ideal for money and accumulates rounding errors over many operations.
- `currency` is an arbitrary string with no ISO 4217 constraint.
- Customer totals sum all `amount` values and display the first payment's currency — if a customer has payments in multiple currencies, the total is meaningless.
- Tenant/admin revenue sums all non-disputed payment amounts without any currency controls — summing USD, EUR, HNL into one number is analytically invalid.

This means the current code can produce numerically correct-looking but semantically wrong totals if multiple currencies ever appear for the same tenant or customer.

**Note:** Opus1 and Opus2 did not flag this as a standalone finding, likely because their focus was more on index/query performance. The issue is real and verified from the codebase.

**Recommended fix:**

- Add `amountMinor` as integer minor units (e.g., cents). Prefer `v.int64()` for full financial safety.
- Constrain `currency` to ISO 4217 codes via a union or enum.
- Define the reporting rule explicitly: single-tenant single-currency only, or multi-currency with per-currency aggregates and tenant reporting currency.
- For read models: maintain totals per currency, not one mixed `totalPaid`.
- Add reporting indexes: `by_tenantId_and_recordedAt`, `by_tenantId_and_status_and_recordedAt`, `by_customerId_and_recordedAt`.

**Migration required:** Yes — widen-migrate-narrow. Add `amountMinor` alongside `amount`, dual-write, backfill, switch reads, then eventually deprecate `amount`.

---

### Finding 6 — Tenant offboarding leaves orphaned CRM data in 11+ tables

|                  |                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------ |
| **Severity**     | High                                                                                       |
| **Confirmed by** | GPT1 F1, GPT2 F9, GPT3 (implied in integrity review), Opus1 (integrity review), Opus2 F-21 |
| **Affected**     | `convex/admin/tenants.ts:700-734`, `convex/admin/tenantsMutations.ts:65-126`               |

**Why it matters:**

The batch deletion mutation `deleteTenantRuntimeDataBatch` only cleans up 3 of 14+ tenant-scoped tables:

- ✅ `rawWebhookEvents`
- ✅ `calendlyOrgMembers`
- ✅ `users`

It then deletes the `tenants` row. That leaves orphaned records in: `leads`, `leadIdentifiers`, `leadMergeHistory`, `opportunities`, `meetings`, `customers`, `paymentRecords`, `followUps`, `eventTypeConfigs`, `closerUnavailability`, and `meetingReassignments`.

This is both a data lifecycle defect and an analytics contamination risk. Orphaned tenant data will pollute any future cross-tenant or system-level reporting.

**Recommended fix:**

Either:

- Extend `deleteTenantRuntimeDataBatch` to cover all tenant-scoped tables using the same batching pattern (`.take(128)` per table, return `hasMore` for continuation), or
- Soft-delete/suspend the tenant and prevent reads until a full archival/deletion workflow completes

Do not delete the tenant root row until all dependent tenant-scoped data is handled.

**Migration required:** No schema migration required to fix the code path. A one-time cleanup job is required for any already-orphaned data in production.

---

### Finding 7 — User hard-delete orphans references across 7+ tables

|                  |                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | High                                                                                                                                                                                                                                                                                                                                                 |
| **Confirmed by** | GPT3 F3 (primary). Opus1 (integrity review), Opus2 (integrity review)                                                                                                                                                                                                                                                                                |
| **Affected**     | `convex/workos/userMutations.ts:428-458` and all tables referencing `users`: `opportunities.assignedCloserId`, `closerUnavailability.closerId/createdByUserId`, `meetingReassignments.fromCloserId/toCloserId/reassignedByUserId`, `customers.convertedByUserId`, `paymentRecords.closerId`, `followUps.closerId`, `leadMergeHistory.mergedByUserId` |

**Why it matters:**

`removeUser` currently unlinks the Calendly member and deletes the `users` row, but does not reconcile the references left behind in other tables. This creates orphaned references and breaks:

- Historical reporting by actor/closer — actors are dimensions that must remain stable long after the operational user is no longer active
- Data integrity for current operational records — active opportunities may reference a deleted closer
- Reliable joins for timelines and audit views

**Note:** GPT1 and GPT2 did not flag this as a standalone finding. GPT3 made the strongest case with the most detailed evidence.

**Recommended fix:**

Replace hard delete with soft delete:

- Add `users.deletedAt: v.optional(v.number())`
- Add `users.isActive` or `users.lifecycleStatus`
- Preserve the row permanently for historical joins

For operational integrity:

- Block deactivation while the user still owns active opportunities, pending follow-ups, or future meetings unless those are reassigned first
- Allow inactive users to remain referenced by historical records

Also run a one-time orphan audit to identify whether any references already point to deleted users.

**Migration required:** Additive soft-delete fields: safe, no breaking migration. Historical cleanup/orphan audit: migration script recommended.

---

### Finding 8 — `leads.status` is optional, causing overfetching and ambiguous queries

|                  |                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | High                                                                                                                            |
| **Confirmed by** | GPT1 F5, GPT2 F5 (partial), GPT3 (noted in context), Opus1 F2.11, Opus2 (noted in context)                                      |
| **Affected**     | `convex/schema.ts:119-126`, `convex/leads/queries.ts:35-52`, `convex/leads/queries.ts:76-93`, `convex/leads/queries.ts:178-198` |

**Why it matters:**

`leads.status` is `v.optional(...)`, and the code treats `undefined` as equivalent to `"active"`. This keeps the read layer in permanent migration mode:

- `listLeads` paginates by `tenantId`, then removes merged leads in memory — pages can be short even when more matching documents exist later
- `searchLeads` fetches up to 40 search hits, then filters statuses and truncates to 20 — search relevance gets distorted by post-filtering
- Every analytics query that segments by lead status must handle the `undefined`/`"active"` ambiguity

**Resolution of audit differences:**

- GPT1: High severity
- GPT2: Medium (part of a broader finding)
- Opus1: Low severity
- Opus2: Not a standalone finding

**Resolved: High.** The severity disagreement exists because Opus1 focused on the schema definition (a simple migration) while GPT1 correctly focused on the downstream impact (multiple live query paths are broken by this). The impact on query correctness across multiple hot reads justifies High.

**Recommended fix:**

Widen-migrate-narrow rollout:

1. Backfill every lead with explicit status (`"active"` for all `undefined` values)
2. Keep readers compatible during the migration window
3. Make `status` required in schema
4. Stop overfetching and JS-filtering active leads

**Migration required:** Yes — widen-migrate-narrow via `convex-migration-helper`.

---

### Finding 9 — Event type configuration uniqueness is not enforced, creating broken dimensions

|                  |                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | High                                                                                                                                     |
| **Confirmed by** | GPT1 F8, GPT2 F7, GPT3 F8. Not flagged by Opus1 or Opus2                                                                                 |
| **Affected**     | `convex/pipeline/inviteeCreated.ts:685-717`, `convex/pipeline/inviteeCreated.ts:799-809`, `convex/eventTypeConfigs/mutations.ts:141-170` |

**Why it matters:**

The pipeline lookup explicitly loads up to 8 configs for the same `(tenantId, calendlyEventTypeUri)` and picks the oldest one. The code even logs when multiple configs exist, which means the invariant is already considered weak in practice.

For analytics, `eventTypeConfigs` is a dimension table. Duplicate dimension rows for the same real-world event type create broken joins, split metrics, and ambiguous field mappings. Any aggregate reporting grouped by event type will drift.

**Recommended fix:**

- Run a one-time dedupe migration for `eventTypeConfigs` — pick a canonical row per `(tenantId, calendlyEventTypeUri)` and repoint dependents if necessary
- Funnel all future writes through a single upsert path
- Remove duplicate-tolerant read logic once the migration is complete
- Continue using indexed existence checks in the same transaction for uniqueness enforcement

**Migration required:** Yes — data cleanup, not necessarily schema change.

---

### Finding 10 — Missing relationship indexes force capped scans where exact lookups should exist

|                  |                                       |
| ---------------- | ------------------------------------- |
| **Severity**     | High                                  |
| **Confirmed by** | All 5 audits with varying specificity |
| **Affected**     | Multiple tables and query paths       |

**Why it matters:**

Several query paths use the wrong index shape and then filter in JavaScript. These are avoidable misses — the relationships are known and stable.

**Specific gaps identified across all audits:**

| Query shape                                              | Current pattern                                                                                 | Missing index                                                                                                                      | Sources                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Lead detail follow-ups                                   | `followUps.by_tenantId` + filter by `leadId` in JS                                              | `followUps.by_tenantId_and_leadId` or `by_leadId`                                                                                  | GPT1, GPT2, GPT3, Opus1, Opus2 |
| Active reminders for closer                              | `followUps.by_tenantId_and_closerId_and_status` + filter by `type` in JS                        | `followUps.by_tenantId_and_closerId_and_type_and_status_and_reminderScheduledAt` or `by_tenantId_and_closerId_and_status_and_type` | GPT1, GPT2, GPT3, Opus1, Opus2 |
| Customer list for closer                                 | `customers.by_tenantId[_and_status]` + filter `convertedByUserId` in JS                         | `customers.by_tenantId_and_convertedByUserId` and `by_tenantId_and_convertedByUserId_and_status`                                   | GPT1, GPT2, GPT3, Opus1        |
| Merge duplicate-flag cleanup                             | `opportunities.by_tenantId` + filter by `potentialDuplicateLeadId` (takes first 500)            | `opportunities.by_tenantId_and_potentialDuplicateLeadId`                                                                           | GPT2 (unique)                  |
| Raw webhook duplicate detection                          | `rawWebhookEvents.by_tenantId_and_eventType` + compare `calendlyEventUri` in code               | `rawWebhookEvents.by_tenantId_and_eventType_and_calendlyEventUri`                                                                  | GPT2 (unique)                  |
| Pending follow-up lookup                                 | `followUps.by_opportunityId` + filter status in JS                                              | `followUps.by_opportunityId_and_status`                                                                                            | Opus2 (unique)                 |
| Closer pipeline by status                                | `opportunities.by_tenantId_and_assignedCloserId` + JS filter                                    | `opportunities.by_tenantId_and_assignedCloserId_and_status`                                                                        | All 5                          |
| Admin opportunity list with both status + closer filters | `by_tenantId_and_status` or `by_tenantId_and_assignedCloserId` — cannot use both simultaneously | `opportunities.by_tenantId_and_assignedCloserId_and_status`                                                                        | GPT2, Opus1                    |

**Migration required:** Mostly additive index additions. Consider staged indexes on large tables.

---

### Finding 11 — `tenants` table mixes stable identity with high-churn OAuth token state

|                  |                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------- |
| **Severity**     | Medium                                                                             |
| **Confirmed by** | All 5 audits (GPT1 F9, GPT2 (Finding 6 partial), GPT3 F6, Opus1 F2.14, Opus2 F-01) |
| **Affected**     | `convex/schema.ts:6-51`                                                            |

**Why it matters:**

The `tenants` document contains approximately 25 fields mixing:

- Stable tenant identity (company name, contact email, lifecycle state)
- Calendly OAuth tokens (`calendlyAccessToken`, `calendlyRefreshToken`, `calendlyTokenExpiresAt`)
- Token refresh locks (`calendlyRefreshLockUntil`)
- Webhook configuration state
- Temporary PKCE/onboarding state

OAuth tokens are refreshed every 90 minutes by a cron job. Each refresh patches the tenant document, causing every reactive query that reads any tenant field to invalidate — approximately 16 unnecessary invalidations per day for all authenticated users.

**Resolution of audit differences:**

- Opus2 rated this High because of quantified reactivity impact (16×/day)
- GPT1 and Opus1 rated this Low
- GPT3 rated this Medium

**Resolved: Medium.** Opus2 made the strongest case by quantifying the reactivity cost. However, this is a performance/efficiency issue, not a correctness or data integrity issue. It causes unnecessary re-renders but does not produce wrong results. The migration to fix it is significant (touching OAuth, token refresh, webhook setup, and health check flows), which argues for "next" priority rather than "immediate".

**Recommended fix:**

Split into:

- `tenants` — company name, contact email, lifecycle/onboarding state, tenant owner
- `tenantCalendlyConnections` — tenantId, org/user URIs, tokens, token expiry, refresh lock, webhook data

**Migration required:** Yes — significant refactor. Plan for a dedicated phase.

---

### Finding 12 — Denormalized field maintenance gaps across multiple tables

|                  |                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------- |
| **Severity**     | Medium                                                                                 |
| **Confirmed by** | Opus1 F2.7/F2.8 (primary), Opus2 F-03/F-04/F-05, GPT3 (integrity section)              |
| **Affected**     | `customers`, `meetings.leadName`, `leads.socialHandles`, `opportunities.hostCalendly*` |

**Why it matters:**

Several denormalized fields are set once and never updated:

1. **`customers` identity snapshot** — `fullName`, `email`, `phone`, `socialHandles` are copied from the lead at conversion time. If the lead's contact info is later corrected, the customer record drifts. Reports that join on customer email will miss the update.

2. **`meetings.leadName`** — set when the meeting is created from a webhook. If the lead's name is later corrected, meetings show outdated names.

3. **`leads.socialHandles`** — only written during pipeline `inviteeCreated`. If a lead merge moves identifiers, or a manual identifier is added/removed, `socialHandles` is not rebuilt. The merge mutation moves identifiers but does not rebuild the target lead's `socialHandles`.

4. **`opportunities.hostCalendlyEmail/Name`** — describes the Calendly host at booking time. If an org member updates their profile, these fields drift. For analytics, `assignedCloserId` is the authoritative reference; these host fields are redundant.

**Recommended fix:**

- **Customers:** Add a sync path — when `updateLead` patches lead identity fields, also patch the linked customer if one exists. Keep the snapshot fields (removing them would break existing reads).
- **`leads.socialHandles`:** Extract a helper `rebuildLeadSocialHandles(ctx, leadId)` and call it from `mergeLead` and any future identifier mutation paths.
- **`meetings.leadName`:** Either maintain it in the same mutation that updates `leads.fullName`, or resolve at read time via the opportunity chain. Given that lead names rarely change after Calendly extraction, this is Low urgency.
- **`opportunities.hostCalendly*`:** Rename to `originalHost*` for clarity. Resolve current host display at read time via `assignedCloserId`. Low urgency.

**Migration required:** No for sync path additions. Yes only if removing fields.

---

### Finding 13 — `paymentRecords` and `followUps` are too polymorphic for clean validation and reporting

|                  |                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| **Severity**     | Medium                                                                                                    |
| **Confirmed by** | GPT2 F8 (primary, unique finding). Partially noted by Opus2 F-09                                          |
| **Affected**     | `convex/schema.ts:456-520`, `convex/closer/payments.ts:115-176`, `convex/customers/conversion.ts:118-139` |

**Why it matters:**

`paymentRecords` can represent:

- A pre-conversion payment attached to an opportunity/meeting
- A post-conversion customer payment with no opportunity/meeting
- A backfilled hybrid row that later gains `customerId`

`followUps` can represent both scheduling links and manual reminders, but the schema encodes that with nullable fields instead of a discriminated model.

`paymentRecords.opportunityId` and `meetingId` are optional, which means a payment cannot always be attributed to a pipeline opportunity for reporting. The `logPayment` mutation always receives both, so the optionality exists only for customer-level payments, creating a data model split that complicates analytics.

This makes validation weaker and analytics logic branchy.

**Recommended fix:**

Either split by subtype or add explicit discriminants:

- `paymentRecords.contextType` with strict allowed field combinations
- `followUps.type` required, plus subtype-specific required fields

If keeping one table (recommended for now), make the discriminator required and write validators/helpers around it.

**Migration required:** Yes if adding required discriminators — widen-migrate-narrow.

---

### Finding 14 — Missing analytics timestamps and user attribution on status changes

|                  |                                                                         |
| ---------------- | ----------------------------------------------------------------------- |
| **Severity**     | Medium                                                                  |
| **Confirmed by** | Opus1 F2.4/F2.5 (primary, unique finding)                               |
| **Affected**     | `opportunities`, `meetings`, `paymentRecords`, `customers`, `followUps` |

**Why it matters:**

Several business-critical moments are not recorded with their own timestamps, and several status changes do not record who performed them. This prevents time-based analytics and accountability tracking.

**Missing timestamps:**

| Table            | Missing field           | When it should be set                               |
| ---------------- | ----------------------- | --------------------------------------------------- |
| `opportunities`  | `lostAt`                | When `markAsLost` is called                         |
| `opportunities`  | `canceledAt`            | When pipeline processes cancellation                |
| `opportunities`  | `paymentReceivedAt`     | When `logPayment` transitions to `payment_received` |
| `meetings`       | `completedAt`           | When meeting transitions to `completed`             |
| `meetings`       | `canceledAt`            | When pipeline processes `invitee.canceled`          |
| `paymentRecords` | `verifiedAt`            | When status changes to `verified`                   |
| `customers`      | `churnedAt`, `pausedAt` | When `updateCustomerStatus` changes status          |
| `followUps`      | `bookedAt`              | When pipeline auto-detects the follow-up booking    |

**Missing user attribution:**

| Table            | Missing field                          | Context                                                            |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------ |
| `opportunities`  | `lostByUserId`                         | Only `lostReason` (text) is stored, not who did it                 |
| `meetings`       | `noShowMarkedByUserId`                 | `noShowSource` is the string `"closer"` but not the actual user ID |
| `paymentRecords` | `verifiedByUserId`, `disputedByUserId` | `closerId` is recorded at creation but not for status changes      |

**Note:** If Finding 1 (domain events table) is implemented, many of these timestamps and attributions can be derived from the event log rather than denormalized onto the entity. However, adding them directly is non-breaking and useful for simpler queries.

**Recommended fix:** Add these as `v.optional(v.number())` and `v.optional(v.id("users"))` fields respectively. Update the corresponding mutations to set them.

**Migration required:** No — all new fields are optional. Safe to ship directly.

---

### Finding 15 — Missing analytics-grade indexes for time, status, and owner dimensions

|                  |                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| **Severity**     | Medium                                                                                                   |
| **Confirmed by** | All 5 audits (GPT1 F7, GPT2 (Finding 6 partial), GPT3 F7, Opus1 F2.9, Opus2 F-16)                        |
| **Affected**     | `opportunities`, `meetings`, `paymentRecords`, `customers`, `followUps`, `meetingReassignments`, `leads` |

**Why it matters:**

The current index set serves operational read paths (tenant + status, tenant + closer). There are no compound indexes that include a time field as the final range-queryable element, which means any future date-range report requires a full index scan followed by JavaScript filtering.

**Consolidated recommended index additions (from all audits):**

| Table                  | Index                                            | Fields                                          | Use case                                  |
| ---------------------- | ------------------------------------------------ | ----------------------------------------------- | ----------------------------------------- |
| `opportunities`        | `by_tenantId_and_createdAt`                      | `["tenantId", "createdAt"]`                     | Pipeline volume by date range             |
| `opportunities`        | `by_tenantId_and_updatedAt`                      | `["tenantId", "updatedAt"]`                     | Recent pipeline activity                  |
| `opportunities`        | `by_tenantId_and_eventTypeConfigId`              | `["tenantId", "eventTypeConfigId"]`             | Event type stats without full scan        |
| `meetings`             | `by_tenantId_and_status_and_scheduledAt`         | `["tenantId", "status", "scheduledAt"]`         | Meeting status distribution by date range |
| `meetings`             | `by_opportunityId_and_scheduledAt`               | `["opportunityId", "scheduledAt"]`              | Meeting timeline per opportunity (sorted) |
| `meetings`             | `by_tenantId_and_meetingOutcome_and_scheduledAt` | `["tenantId", "meetingOutcome", "scheduledAt"]` | Outcome analytics by date range           |
| `paymentRecords`       | `by_tenantId_and_recordedAt`                     | `["tenantId", "recordedAt"]`                    | Revenue time-series                       |
| `paymentRecords`       | `by_tenantId_and_status_and_recordedAt`          | `["tenantId", "status", "recordedAt"]`          | Verified vs disputed revenue trends       |
| `paymentRecords`       | `by_customerId_and_recordedAt`                   | `["customerId", "recordedAt"]`                  | Customer payment history (sorted)         |
| `customers`            | `by_tenantId_and_convertedByUserId`              | `["tenantId", "convertedByUserId"]`             | Closer conversion leaderboard             |
| `followUps`            | `by_tenantId_and_status_and_createdAt`           | `["tenantId", "status", "createdAt"]`           | Follow-up pipeline aging                  |
| `leads`                | `by_tenantId_and_firstSeenAt`                    | `["tenantId", "firstSeenAt"]`                   | Lead acquisition cohorts                  |
| `meetingReassignments` | `by_tenantId_and_reassignedAt`                   | `["tenantId", "reassignedAt"]`                  | Reassignment frequency trends             |

**Note:** Do not add dozens of speculative compound indexes before report requirements are finalized. Add the set above because they support both current correctness and the most predictable reporting dimensions: tenant, owner, status, time, event type.

**Potentially redundant index:** `rawWebhookEvents.by_processed` may be subsumed by `by_processed_and_receivedAt` (prefix match). Verify no callers use it alone before removing.

**Migration required:** No — index additions are non-breaking. Use staged indexes if tables are large (likely candidates: `opportunities`, `meetings`, `paymentRecords`).

---

### Finding 16 — O(n×m) nested loops in detail queries

|                  |                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | Medium                                                                                                                                            |
| **Confirmed by** | Opus2 F-13 (primary, unique finding)                                                                                                              |
| **Affected**     | `convex/leads/queries.ts → getLeadDetail`, `convex/customers/queries.ts → getCustomerDetail`, `convex/closer/meetingDetail.ts → getMeetingDetail` |

**Why it matters:**

These queries iterate through opportunities, then for each opportunity iterate through meetings. For a lead with 10 opportunities, each with 5 meetings, that is 50+ individual index lookups in a single reactive query. This pattern compounds with scale and causes excessive read bandwidth.

**Recommended fix:**

- For lead/customer detail: query meetings directly by `tenantId + scheduledAt` range and group in JS, rather than iterating per opportunity.
- For meeting detail: the "all related meetings for this lead" view should be a separate bounded query, not embedded in the detail page query.
- If `meetings.assignedCloserId` is added (Finding 4), closer-scoped detail queries become direct indexed lookups.

**Migration required:** No for query restructuring. Yes if adding `leadId` field to meetings.

---

### Finding 17 — Admin opportunity list uses unbounded async iterators with N+1 enrichment

|                  |                                                               |
| ---------------- | ------------------------------------------------------------- |
| **Severity**     | Medium                                                        |
| **Confirmed by** | Opus2 F-12 (primary), Opus1 (noted in query matrix)           |
| **Affected**     | `convex/opportunities/queries.ts → listOpportunitiesForAdmin` |

**Why it matters:**

Collects all opportunities into an in-memory array via `for await` loop, then enriches each with N+1 lookups for leads, users, and event type configs. No `.take()` bound. With growth, this will hit transaction read limits and create large reactive payloads.

**Recommended fix:**

Paginate the query using `usePaginatedQuery`. Pre-aggregate enrichment data with `Promise.all` over batched ID sets rather than per-record lookups.

**Migration required:** No.

---

### Finding 18 — Webhook dedupe and business-key uniqueness are soft conventions, not hard invariants

|                  |                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Severity**     | Medium                                                                                                                                                                         |
| **Confirmed by** | GPT1 F8, GPT2 (partial), GPT3 F8                                                                                                                                               |
| **Affected**     | `convex/webhooks/calendlyMutations.ts:15-29`, `convex/pipeline/inviteeCreated.ts:685-717`, `convex/pipeline/inviteeCreated.ts:799-809`, `convex/customers/conversion.ts:42-56` |

**Why it matters:**

Uniqueness is treated as a code convention, not as a strongly owned invariant:

- `persistRawEvent` scans prior rows to dedupe — confirmed under concurrency pressure by Convex Insights (2 OCC conflicts on 2026-04-10)
- `inviteeCreated` picks the oldest event type config when multiple exist for the same URI
- Several business-key lookups use `.first()` instead of a truly canonical uniqueness strategy
- Customer conversion does not hard-enforce one customer per lead

This is manageable at small scale but dangerous once aggregate reporting depends on clean uniqueness.

**Recommended fix:**

For each business key, choose one canonical write owner and enforce uniqueness there:

- Raw webhook ingest: add `rawWebhookEvents.by_tenantId_and_eventType_and_calendlyEventUri` for precise dedupe
- Event type config: one mutation path only, plus cleanup for existing duplicates (see Finding 9)
- Customer conversion: keep a single owned conversion path
- Meeting ingest: keep `tenantId + calendlyEventUri` canonical

Schedule a one-time duplicate audit across all dimension-like tables before building aggregate reporting.

**Migration required:** Likely data cleanup, not necessarily schema change.

---

### Finding 19 — `.filter()` used instead of available index in invite cleanup

|                  |                                                               |
| ---------------- | ------------------------------------------------------------- |
| **Severity**     | Low                                                           |
| **Confirmed by** | Opus1 F2.15 (unique finding)                                  |
| **Affected**     | `convex/admin/inviteCleanupMutations.ts → listExpiredInvites` |

**Why it matters:**

This internal query uses `.filter()` to check expiration time instead of using the existing `by_status_and_inviteExpiresAt` index. While the tenant table is small now, this sets a bad precedent.

**Recommended fix:**

Rewrite to use `withIndex("by_status_and_inviteExpiresAt", q => q.eq("status", "pending_signup").lt("inviteExpiresAt", now))`.

**Migration required:** No.

---

### Finding 20 — Unbounded user/member list queries

|                  |                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| **Severity**     | Low                                                                                                |
| **Confirmed by** | Opus2 F-15 (unique finding)                                                                        |
| **Affected**     | `users/queries.ts → listTeamMembers`, `listUnmatchedCalendlyMembers`, `getAvailableClosersForDate` |

**Why it matters:**

These queries use async iterators without bounds. Practically, team sizes in this CRM are small (< 50 users per tenant), so the risk is low. However, as a matter of defensive design, they should have explicit bounds.

**Recommended fix:** Add `.take(200)` or similar safety limit.

**Migration required:** No.

---

### Finding 21 — Minor denormalization artifacts on opportunities

|                  |                                                                          |
| ---------------- | ------------------------------------------------------------------------ |
| **Severity**     | Low                                                                      |
| **Confirmed by** | Opus2 F-05/F-06 (unique findings)                                        |
| **Affected**     | `opportunities.hostCalendlyEmail/Name`, `opportunities.calendlyEventUri` |

**Why it matters:**

- `hostCalendlyEmail/Name` describes the Calendly host at booking time and drifts if the org member updates their profile. For analytics, `assignedCloserId` is the authoritative reference.
- `calendlyEventUri` on opportunities duplicates the first meeting's event URI. If an opportunity gains follow-up meetings, this field points to the original booking, which may be misleading.

**Recommended fix:**

- Rename `hostCalendly*` to `originalHost*` for clarity. Resolve current host at read time.
- Document `calendlyEventUri` as "original booking event URI" for attribution context, not a canonical Calendly reference.

**Migration required:** No (documentation/rename only).

---

### Finding 22 — `rawWebhookEvents.payload` stored as string, missing structured metadata

|                  |                             |
| ---------------- | --------------------------- |
| **Severity**     | Low                         |
| **Confirmed by** | Opus2 F-20 (unique finding) |
| **Affected**     | `rawWebhookEvents`          |

**Why it matters:**

The payload is stored as a JSON string, requiring `JSON.parse()` at every read. For analytics over webhook data (event type frequency, processing latency), the raw string cannot be indexed or queried.

**Recommended fix:** Keep the payload as a string for replay fidelity. This is a log table primarily accessed for debugging, not analytics. If webhook analytics become important, add extracted metadata fields alongside the raw payload rather than restructuring the string.

**Migration required:** No if adding optional fields.

---

## 4. Query and Index Matrix

### Current hot operational queries

| Query                           | Function                             | Current index path                                                 | Result bound                               | Scale risk | Recommendation                                                                                        |
| ------------------------------- | ------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------- |
| Admin dashboard stats           | `getAdminDashboardStats`             | `by_tenantId` on 4 tables                                          | Unbounded `for await`                      | 🔴 High    | Replace with summary doc reads (Finding 3)                                                            |
| Closer next meeting             | `getNextMeeting`                     | `by_tenantId_and_assignedCloserId` + `by_tenantId_and_scheduledAt` | `.collect()` for opps, stream for meetings | 🔴 High    | Add `meetings.assignedCloserId` + direct index; or use `nextMeetingAt` denormalized field (Finding 4) |
| Closer calendar range           | `getMeetingsForRange`                | same two-hop pattern                                               | Same                                       | 🔴 High    | Same fix as next-meeting (Finding 4)                                                                  |
| Redistribution/availability     | `unavailability/shared.ts`           | same two-hop pattern                                               | Same                                       | 🔴 High    | Same fix (Finding 4)                                                                                  |
| Lead detail follow-ups          | `getLeadDetail`                      | `followUps.by_tenantId` + filter by `leadId`                       | `.take(200)` + filter                      | 🔴 High    | Add `followUps.by_tenantId_and_leadId` (Finding 10)                                                   |
| Merge duplicate-flag cleanup    | `executeMerge`                       | `opportunities.by_tenantId` + filter `potentialDuplicateLeadId`    | `.take(500)` + filter                      | 🔴 High    | Add `opportunities.by_tenantId_and_potentialDuplicateLeadId` (Finding 10)                             |
| Raw webhook duplicate detection | `persistRawEvent`                    | `by_tenantId_and_eventType` + URI compare in code                  | Scan + compare                             | 🔴 High    | Add `rawWebhookEvents.by_tenantId_and_eventType_and_calendlyEventUri` (Finding 10)                    |
| Closer pipeline summary         | `getPipelineSummary`                 | `by_tenantId_and_assignedCloserId`                                 | `.collect()`                               | 🟡 Medium  | Add `by_tenantId_and_assignedCloserId_and_status`; consider counter docs (Finding 4)                  |
| Closer pipeline list            | `listMyOpportunities`                | `by_tenantId_and_assignedCloserId`                                 | `.collect()` + JS filter/sort              | 🟡 Medium  | Add status index; paginate (Finding 4)                                                                |
| Customer list for closer        | `listCustomers`                      | `by_tenantId[_and_status]` + role filter                           | `.paginate()` + filter                     | 🟡 Medium  | Add `by_tenantId_and_convertedByUserId` (Finding 10)                                                  |
| Customer payment totals         | `getCustomerTotalPaid`               | `by_customerId`                                                    | `.collect()`                               | 🟡 Medium  | Denormalize `totalPaid` on customer doc (Finding 3)                                                   |
| Active reminders                | `getActiveReminders`                 | `by_tenantId_and_closerId_and_status` + type filter                | `.take(50)` + filter                       | 🟡 Medium  | Add `...and_type` index or split model (Finding 10)                                                   |
| Event type stats                | `getEventTypeConfigsWithStats`       | `opportunities.by_tenantId` full scan                              | Unbounded                                  | 🟡 Medium  | Maintain summary stats on `eventTypeConfigs` or dedicated stats table (Finding 3)                     |
| Admin opportunity list          | `listOpportunitiesForAdmin`          | `by_tenantId_and_status` / `by_tenantId_and_assignedCloserId`      | `for await` (unbounded)                    | 🟡 Medium  | Paginate; batch enrichment (Finding 17)                                                               |
| Lead list (active)              | `listLeads`                          | `by_tenantId` paginate + post-filter merged                        | `.paginate()`                              | 🟡 Medium  | Backfill `status`; move filter into indexed query (Finding 8)                                         |
| Lead search (active)            | `searchLeads`                        | `search_leads` + overfetch + JS filter                             | `.take(40)` + filter to 20                 | 🟡 Medium  | Backfill `status`; keep search filter purely indexed (Finding 8)                                      |
| Lead/customer detail nested     | `getLeadDetail`, `getCustomerDetail` | Per-opp iteration → per-meeting iteration                          | O(n×m) lookups                             | 🟡 Medium  | Flatten joins; query meetings directly (Finding 16)                                                   |
| Meeting detail                  | `getMeetingDetail`                   | Point reads via `ctx.db.get()`                                     | Single doc                                 | 🟢 Low     | Good                                                                                                  |
| Lead search (bounded)           | `searchLeads`                        | `search_leads`                                                     | `.take(20/40)`                             | 🟢 Low     | Good — bounded                                                                                        |

### Consolidated recommended new indexes (for analytics and operational efficiency)

See Finding 10 for relationship indexes (high-priority operational fixes) and Finding 15 for analytics-grade time/status indexes. Combined, the recommended additions total approximately 20 new indexes across 8 tables.

---

## 5. Integrity and Atomicity Review

### Ownership and tenant boundaries

**Strong overall.**

- Every public query and mutation calls `requireTenantUser()` or `requireSystemAdminSession()`
- Tenant ID is derived server-side from `ctx.auth.getUserIdentity()`, never from client arguments
- All data tables include `tenantId` and all hot indexes start with `tenantId` where tenant-scoped access is required
- Public functions generally define `args` validators
- No `.filter()` anti-patterns or `.collect().length` counting anti-patterns were found in `convex/` (Opus1 confirmed)

### Reference validation and orphan risk

**Mostly good on writes, with two critical gaps:**

| Check                                        | Status      | Notes                                                                                                              |
| -------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Opportunity → Lead reference                 | ✅          | Pipeline creates both atomically                                                                                   |
| Meeting → Opportunity reference              | ✅          | Pipeline validates opportunity exists                                                                              |
| Payment → Opportunity/Meeting reference      | ✅          | `logPayment` validates both and checks they belong to same chain                                                   |
| Customer → Lead/Opportunity reference        | ✅          | `executeConversion` validates all references                                                                       |
| FollowUp → Opportunity/Lead/Closer reference | ✅          | Created from loaded opportunity context                                                                            |
| User removal → orphaned assignments          | ⚠️ **Gap**  | `removeUser` deletes the user record without reassigning active opportunities, follow-ups, or meetings (Finding 7) |
| Tenant deletion → orphaned data              | ⚠️ **Gap**  | Only 3 of 14+ tables cleaned up (Finding 6)                                                                        |
| Lead deletion → orphaned opps/meetings       | 🟢 Low risk | Leads are never hard-deleted (only merged/converted), so low practical risk                                        |

### Write atomicity

**Strong for core flows:**

- Meeting status change + opportunity status change: always in same mutation
- Opportunity status change + denormalized refs: `updateOpportunityMeetingRefs()` called in same mutation
- Lead merge: source patch + target patch + identifier move + merge history: all in `mergeLead` mutation
- Payment + opportunity status transition + auto-conversion: `logPayment` does all atomically
- Follow-up creation + opportunity transition: same mutation in all follow-up flows
- External API calls are properly separated into actions that schedule mutations for DB writes

**Gaps:**

- Business event facts are not written alongside state transitions because the event table does not exist yet (Finding 1)
- Reporting summaries are not updated atomically because they do not exist yet (Finding 3)

### Denormalized-field maintenance

| Field                                           | Maintained correctly? | Risk                                                                            |
| ----------------------------------------------- | --------------------- | ------------------------------------------------------------------------------- |
| `opportunities.latestMeeting*` / `nextMeeting*` | ✅ Yes                | Low                                                                             |
| `leads.searchText`                              | ✅ Yes                | Low                                                                             |
| `users.calendlyMemberName`                      | ✅ Yes                | Low                                                                             |
| `leads.socialHandles`                           | ⚠️ Pipeline only      | Medium — drifts on merge or manual identifier changes (Finding 12)              |
| `meetings.leadName`                             | ⚠️ Creation only      | Low — lead names rarely change after extraction                                 |
| `opportunities.hostCalendly*`                   | ⚠️ Creation only      | Low — `assignedCloserId` is authoritative                                       |
| `customers.fullName/email/phone/socialHandles`  | ❌ Never refreshed    | Medium — drifts if lead data corrected (Finding 12)                             |
| `leads.customFields`                            | ❌ Not a safe denorm  | High — acting as the only stored representation of per-meeting data (Finding 2) |

### Business-key uniqueness

**Soft, not hard.** Duplicate handling is implemented ad hoc in code rather than modeled as a strongly owned invariant across all writers. That is manageable at small scale but dangerous once aggregate reporting depends on clean uniqueness. See Findings 9 and 18.

---

## 6. Migration Notes

### Safe changes that can ship directly

These are additive and do not affect existing documents:

1. **New `domainEvents` table** — purely additive; start dual-writing from relevant mutations (Finding 1)
2. **New summary/read-model tables** — `tenantDashboardStats`, `customerFinancialSummary`, `eventTypeStats` (Finding 3)
3. **New indexes** — all relationship indexes (Finding 10) and analytics indexes (Finding 15) can be added immediately
4. **New optional timestamp fields** — `lostAt`, `canceledAt`, `paymentReceivedAt`, `completedAt`, `verifiedAt`, `churnedAt`, `bookedAt` (Finding 14)
5. **New optional attribution fields** — `lostByUserId`, `noShowMarkedByUserId`, `verifiedByUserId` (Finding 14)
6. **Soft-delete fields on `users`** — `deletedAt`, `isActive` (Finding 7)
7. **Query optimizations** — replacing `.collect()` with `.take(n)` or `.paginate()`, adding `Promise.all` batching (Findings 4, 16, 17, 20)
8. **Extending tenant deletion cascade** — code change only (Finding 6)
9. **Helper extractions** — `rebuildLeadSocialHandles`, `logStatusChange` (Findings 1, 12)
10. **Replacing `.filter()` with `withIndex()`** in `listExpiredInvites` (Finding 19)

### Breaking changes that need widen-migrate-narrow

1. **`leads.customFields`** — change `v.any()` to typed validator; existing documents must match new type (Finding 2)
2. **`leads.status`** — make optional → required; backfill all `undefined` to `"active"` (Finding 8)
3. **`paymentRecords.amount`** → `amountMinor` — widen with new field, dual-write, backfill, switch reads, deprecate old field (Finding 5)
4. **`meetings.assignedCloserId`** — add as optional, backfill from opportunity ownership, then switch reads (Finding 4)
5. **`tenants` split** — extract Calendly OAuth into `tenantCalendlyConnections`; widen, dual-read/dual-write, backfill, narrow (Finding 11)
6. **`paymentRecords`/`followUps` discriminants** — add required `contextType`/tighten `type` (Finding 13)
7. **`customers.totalPaid`/`totalPaymentCount`** — add as optional, backfill, narrow (Finding 3)

### Index additions that may need staged rollout

If any table exceeds approximately 10,000–50,000 rows, use staged indexes:

- `opportunities` — likely candidate as pipeline grows
- `meetings` — likely candidate
- `paymentRecords` — depends on volume
- `followUps` — depends on volume

### Data cleanup work to schedule before reporting rollout

- Audit for orphaned tenant-scoped rows from prior offboarding runs
- Deduplicate `eventTypeConfigs` by `(tenantId, calendlyEventTypeUri)` — pick canonical row per key
- Audit for duplicate raw webhook rows by intended ingest key
- Audit payment currencies per tenant before any revenue dashboard is treated as authoritative
- Audit for references to deleted users across all tables with `userId`-type fields
- If `leads.status` becomes required, backfill all legacy rows to `"active"` or their true business state

### Data recovery constraints

Per-meeting booking answers can only be backfilled from the retained raw webhook payloads. Processed events are cleaned up after 30 days (`convex/webhooks/cleanup.ts:5-29`). Begin backfill work before historical data is permanently lost.

---

## 7. Remediation Plan

### Immediate — correctness and data integrity

| #   | Finding                           | Action                                                                                                                                        | Effort |
| --- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | F6: Tenant offboarding orphans    | Extend `deleteTenantRuntimeDataBatch` to cover all 14+ tenant-scoped tables                                                                   | Medium |
| 2   | F7: User hard-delete orphans      | Replace hard delete with soft delete; add `deletedAt` and `isActive` fields to `users`                                                        | Medium |
| 3   | F5: Unsafe money model            | Stop treating revenue as a single summed number across arbitrary currencies; add `amountMinor` field and begin dual-write                     | Medium |
| 4   | F10: Missing relationship indexes | Add the 8 relationship indexes from Finding 10 (all additive)                                                                                 | Small  |
| 5   | F1: No event history              | Add `domainEvents` table and begin dual-writing from highest-value mutations: opportunity transitions, meeting lifecycle, payment, conversion | Medium |
| 6   | F3: Dashboard full table scans    | Add `tenantDashboardStats` summary table; maintain counters in mutations; switch dashboard query to single-document read                      | Medium |

### Next — performance, analytics readiness, and schema hardening

| #   | Finding                               | Action                                                                                                                               | Effort       |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| 7   | F8: `leads.status` optional           | Backfill all leads to explicit status, then make `status` required in schema                                                         | Small-Medium |
| 8   | F2: `customFields` v.any()            | Phase 1: narrow type to `v.record(v.string(), v.string())`. Phase 2: add per-meeting booking answer capture                          | Medium       |
| 9   | F4: Closer scheduling scan+filter     | Part A: add `by_tenantId_and_assignedCloserId_and_status` on opportunities. Part B: add `assignedCloserId` to meetings with backfill | Medium-Large |
| 10  | F15: Analytics indexes                | Add the 13 analytics-grade time/status indexes from Finding 15                                                                       | Small        |
| 11  | F14: Missing timestamps + attribution | Add optional timestamp and user attribution fields; update mutations to set them                                                     | Small-Medium |
| 12  | F9: Event type config uniqueness      | Deduplicate `eventTypeConfigs`; collapse future creation to single upsert path                                                       | Medium       |
| 13  | F3: Customer payment enrichment       | Add summary fields (`totalPaid`, `paymentCount`) to customers; wire into payment mutations; remove `.collect()` aggregation          | Medium       |
| 14  | F12: Denormalized field drift         | Extract `rebuildLeadSocialHandles` helper; add customer sync path in `updateLead`                                                    | Small        |
| 15  | F17: Admin opportunity list unbounded | Paginate `listOpportunitiesForAdmin`; batch enrichment lookups                                                                       | Small        |

### Later — structural improvements for scale

| #   | Finding                                | Action                                                                                                     | Effort   |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------- |
| 16  | F11: Tenants table overloaded          | Split `tenants` into stable profile + `tenantCalendlyConnections` for OAuth state                          | Large    |
| 17  | F13: Polymorphic tables                | Add explicit discriminants to `paymentRecords` and `followUps`                                             | Medium   |
| 18  | F16: O(n×m) detail queries             | Refactor lead/customer/meeting detail queries to flatten joins                                             | Medium   |
| 19  | F18: Business-key uniqueness           | Reduce heuristic dedupe paths; enforce canonical write owners for all business keys                        | Medium   |
| 20  | F2 Phase 3: Custom field normalization | Add `eventTypeFieldCatalog` + `meetingFormResponses` if analytics on field values is a hard requirement    | Large    |
| 21  | OLAP planning                          | Decide what stays in PostHog only, what is mirrored into Convex, and what belongs in a warehouse/ETL layer | Planning |

---

## 8. Audit Cross-Reference

This section documents where each finding originated, which audits agreed, and where disagreements were resolved.

### Findings confirmed by all 5 audits

| Finding                           | GPT1 | GPT2 | GPT3 | Opus1 | Opus2     |
| --------------------------------- | ---- | ---- | ---- | ----- | --------- |
| F1: No event history              | F2   | F1   | F1   | F2.1  | F-07/F-08 |
| F2: `customFields` blob           | F6   | F2   | F2   | F2.6  | F-02      |
| F3: Dashboard full scans          | F4   | F3   | F7   | F2.2  | F-10      |
| F4: Closer scan+filter patterns   | F4   | F4   | F4   | F2.3  | F-11/F-19 |
| F10: Missing relationship indexes | F4   | F6   | F7   | F2.9  | F-16/F-17 |
| F15: Missing analytics indexes    | F7   | F6   | F7   | F2.9  | F-16      |

### Findings confirmed by 3–4 audits

| Finding                          | Sources                                   | Not flagged by                                   |
| -------------------------------- | ----------------------------------------- | ------------------------------------------------ |
| F5: Unsafe money model           | GPT1 F3, GPT3 F5                          | Opus1, Opus2 (not a standalone finding)          |
| F6: Tenant offboarding orphans   | GPT1 F1, GPT2 F9, Opus2 F-21              | GPT3, Opus1 (mentioned only in integrity review) |
| F8: `leads.status` optional      | GPT1 F5, GPT2 F5, Opus1 F2.11             | Opus2 (noted but not standalone)                 |
| F9: Event type config uniqueness | GPT1 F8, GPT2 F7, GPT3 F8                 | Opus1, Opus2                                     |
| F11: Tenants mixed concerns      | GPT1 F9, GPT3 F6, Opus1 F2.14, Opus2 F-01 | GPT2 (not standalone)                            |
| F12: Denormalization drift       | Opus1 F2.7/F2.8, Opus2 F-03/F-04, GPT3    | GPT1, GPT2 (not standalone)                      |
| F18: Webhook/uniqueness softness | GPT1 F8, GPT2 (partial), GPT3 F8          | Opus1, Opus2                                     |

### Findings unique to one or two audits

| Finding                                            | Source                   | Notes                                                                                 |
| -------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------- |
| F7: User hard-delete orphans                       | GPT3 F3 (primary)        | Opus1/Opus2 noted in integrity review but not as standalone finding                   |
| F13: Polymorphic tables                            | GPT2 F8 (unique)         | Only GPT2 specifically called out `paymentRecords`/`followUps` polymorphism           |
| F14: Missing timestamps + attribution              | Opus1 F2.4/F2.5 (unique) | Only Opus1 enumerated specific missing timestamps and user attribution fields         |
| F16: O(n×m) detail queries                         | Opus2 F-13 (unique)      | Only Opus2 identified the nested loop pattern in detail queries                       |
| F17: Admin opp list unbounded                      | Opus2 F-12 (unique)      | Only Opus2 called this out as a standalone finding                                    |
| F19: `.filter()` in invite cleanup                 | Opus1 F2.15 (unique)     | Only Opus1 identified this specific anti-pattern                                      |
| F20: Unbounded user lists                          | Opus2 F-15 (unique)      | Only Opus2 noted the missing `.take()` bounds                                         |
| F21: Opportunity host field artifacts              | Opus2 F-05/F-06 (unique) | Only Opus2 analyzed `hostCalendly*` and `calendlyEventUri` as separate findings       |
| F22: Raw webhook payload as string                 | Opus2 F-20 (unique)      | Only Opus2 noted the missed structured storage opportunity                            |
| `leads.socialHandles` drift on merge               | Opus1 F2.8 (unique)      | Only Opus1 identified the specific merge-time drift                                   |
| 30-day backfill deadline for booking answers       | GPT3 F2 (unique)         | Only GPT3 connected the webhook cleanup cron to the custom fields backfill constraint |
| `lib/posthog-capture.ts` has no call sites         | GPT3 F1 (unique)         | Only GPT3 noted the unused server-side capture helper                                 |
| Convex Insights OCC warning                        | GPT1 (unique)            | Only GPT1 cited runtime telemetry as supporting evidence                              |
| `rawWebhookEvents.by_processed` possibly redundant | Opus2 (unique)           | Only Opus2 identified the potential prefix-match redundancy                           |

### Severity disagreements and resolutions

| Finding                      | GPT1 | GPT2   | GPT3   | Opus1  | Opus2  | Resolved   | Reasoning                                                                                              |
| ---------------------------- | ---- | ------ | ------ | ------ | ------ | ---------- | ------------------------------------------------------------------------------------------------------ |
| F8: `leads.status` optional  | High | Medium | —      | Low    | —      | **High**   | Multiple live query paths are broken by this; overfetching and sparse pagination affect real users     |
| F11: Tenants mixed concerns  | Low  | —      | Medium | Low    | High   | **Medium** | Real reactivity cost (16×/day) but not a correctness issue; heavy migration argues for "next" priority |
| F12: Customer snapshot drift | —    | —      | —      | Medium | Medium | **Medium** | Consensus where flagged; documented as intentional snapshot + recommended sync path                    |
| F4: Closer scan+filter       | High | High   | High   | Medium | High   | **High**   | Consensus of 4/5 at High; affects multiple core screens                                                |

### Design approach disagreements and resolutions

| Topic                                | Disagreement                                                                             | Resolution                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Event table design                   | GPT1/GPT2: multiple per-entity tables. GPT3/Opus1/Opus2: single table with discriminator | **Single table** — better for Convex (no cross-table unions, simpler schema, cross-entity timeline queries)        |
| Custom fields fix                    | Opus1/Opus2: type-narrow the blob. GPT1/GPT2/GPT3: normalize into child tables           | **Three-phase approach** — narrow type first, add per-meeting capture next, normalize later if needed              |
| Customer snapshot                    | Opus2: remove duplicate fields. Opus1/GPT3: add sync path                                | **Add sync path, keep fields** — removing would break existing reads for marginal gain                             |
| `meetings.assignedCloserId` priority | GPT2: Later. GPT3: Immediate. Opus1/Opus2: Next                                          | **Two-part: index first (immediate), denormalization second (next)** — gets 80% of the benefit without a migration |

---

## 9. Bottom Line

The current schema is a solid operational CRM foundation. It is not yet an analytics-grade data model.

The most important next move is not "add every possible index." It is:

1. **Preserve lifecycle facts** as append-only domain events
2. **Fix current correctness risks** — tenant offboarding, user deletion, money model, query shapes
3. **Normalize the fields already known to matter** — `customFields`, `leads.status`, per-meeting booking answers
4. **Add a focused index layer** around tenant + owner + status + time
5. **Introduce summary/read-model tables** where scans are already obviously expensive
6. **Keep Convex as the OLTP system** and plan a warehouse/PostHog export path for heavier OLAP workloads

If that sequence is followed, the current CRM can keep moving while building a reporting foundation that will not force full scans or historical guesswork later.
