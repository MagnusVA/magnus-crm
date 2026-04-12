# Convex Database Audit Report

> **Date**: 2026-04-11
> **Scope**: Full data model, query/mutation paths, index coverage, integrity, and analytics readiness
> **Status**: 1 production tenant with live data — all breaking changes require migration planning

---

## 1. Domain and Data Model Summary

### Core entities (14 tables)

| Table                  | Responsibility                                                             | Source of truth?                     | Approximate lifecycle                           |
| ---------------------- | -------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------- |
| `tenants`              | Multi-tenant root; Calendly OAuth, webhook config, invite lifecycle        | ✅ Canonical                         | Long-lived, status-machine driven               |
| `users`                | CRM team members; WorkOS identity, CRM role, Calendly link                 | ✅ Canonical                         | Long-lived                                      |
| `leads`                | Inbound contacts extracted from Calendly bookings or manual entry          | ✅ Canonical                         | Long-lived, status: active → converted / merged |
| `leadIdentifiers`      | Multi-identifier model (email, phone, social handles) per lead             | ✅ Canonical                         | Append-mostly, immutable once written           |
| `leadMergeHistory`     | Audit trail for lead merge operations                                      | ✅ Canonical                         | Append-only                                     |
| `opportunities`        | Sales pipeline entity linking lead → closer → meetings                     | ✅ Canonical                         | Status-machine driven (8 states)                |
| `meetings`             | Individual Calendly meetings within an opportunity                         | ✅ Canonical                         | Status-machine driven (5 states)                |
| `customers`            | Converted leads after payment                                              | ✅ Canonical + denormalized snapshot | Long-lived                                      |
| `paymentRecords`       | Payment evidence per opportunity/meeting                                   | ✅ Canonical                         | Append-mostly                                   |
| `followUps`            | Scheduling links and manual reminders after meetings                       | ✅ Canonical                         | Status-machine driven (4 states)                |
| `eventTypeConfigs`     | CRM-side overlays for Calendly event types (field mappings, payment links) | ✅ Canonical                         | Config, low churn                               |
| `closerUnavailability` | Date-range unavailability records for closers                              | ✅ Canonical                         | Low volume                                      |
| `meetingReassignments` | Audit trail for meeting redistribution                                     | ✅ Canonical                         | Append-only                                     |
| `rawWebhookEvents`     | Calendly webhook payloads (raw ingest, then marked processed)              | Operational staging                  | High volume, prunable                           |
| `calendlyOrgMembers`   | Synced Calendly org membership mirror                                      | Derived (sync target)                | Refreshed every 24h                             |

### Existing denormalized fields

| Location        | Fields                                                                 | Maintained by                                                                       |
| --------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `opportunities` | `latestMeetingId`, `latestMeetingAt`, `nextMeetingId`, `nextMeetingAt` | `updateOpportunityMeetingRefs()` helper — called from pipeline and closer mutations |
| `opportunities` | `hostCalendlyUserUri`, `hostCalendlyEmail`, `hostCalendlyName`         | Pipeline inviteeCreated + repair maintenance mutation                               |
| `leads`         | `socialHandles` (array snapshot of leadIdentifiers)                    | Pipeline inviteeCreated only                                                        |
| `leads`         | `searchText` (full-text search composite)                              | Pipeline and lead mutations                                                         |
| `meetings`      | `leadName`                                                             | Pipeline inviteeCreated                                                             |
| `customers`     | `fullName`, `email`, `phone`, `socialHandles`                          | Set once at conversion, **never refreshed**                                         |
| `users`         | `calendlyMemberName`                                                   | Calendly org member sync + link mutation                                            |

---

## 2. Findings

### Finding 2.1 — No status change history (analytics blocker)

|                        |                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**           | 🔴 High                                                                                                                                                                                                                                                                                                                                 |
| **Affected**           | `opportunities`, `meetings`, `leads`, `customers`                                                                                                                                                                                                                                                                                       |
| **Why it matters**     | Every status transition overwrites the previous value in-place. There is no record of _when_ an opportunity became "lost", _who_ transitioned it, or _what the previous status was_. This makes funnel analysis, conversion velocity, stage-duration metrics, and audit trails impossible without full event replay from logs.          |
| **Recommended fix**    | Create an append-only `statusChanges` table that logs every transition: `{ tenantId, entityType, entityId, fromStatus, toStatus, changedByUserId, changedAt, reason? }`. Write to it in the same mutation that patches the status field. Add indexes `by_entityId` and `by_tenantId_and_changedAt`. See Appendix B for proposed schema. |
| **Migration required** | Yes — new table + mutation changes (additive, non-breaking). Optional backfill from existing `_creationTime` and current status for seed data.                                                                                                                                                                                          |

### Finding 2.2 — Dashboard stats are full-table scans

|                        |                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**           | 🔴 High                                                                                                                                                                                                                                                                                                                                                             |
| **Affected**           | `getAdminDashboardStats` (`convex/dashboard/adminStats.ts`), `getPipelineSummary` (`convex/closer/dashboard.ts`)                                                                                                                                                                                                                                                    |
| **Why it matters**     | Both dashboard queries iterate every document in their target tables (`users`, `opportunities`, `paymentRecords`) using `for await` loops with no range bounds. At 1k+ records per table this becomes slow and expensive. At 10k+ it will hit Convex transaction read limits. These are reactive queries, so they re-execute on every write to any of those tables. |
| **Recommended fix**    | Phase 1: Maintain per-tenant counter/summary documents (e.g., `tenantMetrics` table) updated atomically in the same mutations that change status or create records. Phase 2: Replace full-scan dashboard queries with point reads on summary docs.                                                                                                                  |
| **Migration required** | Yes — new table, backfill counters from current data, wire mutations to maintain them.                                                                                                                                                                                                                                                                              |

### Finding 2.3 — Closer pipeline `.collect()` without bounds

|                        |                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**           | 🟡 Medium                                                                                                                                                                                                                                                                                                                                                     |
| **Affected**           | `listMyOpportunities` (`convex/closer/pipeline.ts`), `getPipelineSummary` (`convex/closer/dashboard.ts`), `getNextMeeting` (`convex/closer/dashboard.ts`)                                                                                                                                                                                                     |
| **Why it matters**     | All three queries call `.collect()` on the closer's full opportunity set, then filter/sort in JavaScript. A closer with 500+ opportunities (accumulated over time across all statuses) will trigger increasingly expensive reads. The subsequent `Promise.all` enrichment in `listMyOpportunities` amplifies the cost with N additional `ctx.db.get()` calls. |
| **Recommended fix**    | For `listMyOpportunities`: switch to pagination or at minimum `.take(100)` with client-side "load more". For `getPipelineSummary`: derive from maintained counter doc per closer. For `getNextMeeting`: use the denormalized `nextMeetingAt` on opportunities to avoid scanning all meetings.                                                                 |
| **Migration required** | No for `.take()` bounds and pagination. Yes for counter documents (new table).                                                                                                                                                                                                                                                                                |

### Finding 2.4 — Missing timestamps for analytics-critical events

|                    |                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| **Severity**       | 🟡 Medium                                                                                                      |
| **Affected**       | `opportunities`, `meetings`, `paymentRecords`, `customers`, `followUps`                                        |
| **Why it matters** | Several business-critical moments are not recorded with their own timestamps, preventing time-based analytics. |

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

|                        |                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Recommended fix**    | Add these as `v.optional(v.number())` fields (non-breaking). Update the corresponding mutations to set them. |
| **Migration required** | No — all new fields are optional. Safe to ship directly.                                                     |

### Finding 2.5 — Missing user attribution on status changes

|                        |                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**           | 🟡 Medium                                                                                                                                                                                                                                                                                                                                                                                               |
| **Affected**           | `opportunities.markAsLost`, `meetings.markNoShow`, `paymentRecords` status changes                                                                                                                                                                                                                                                                                                                      |
| **Why it matters**     | When an opportunity is marked lost, only `lostReason` (text) is stored — not _who_ did it. When a no-show is recorded by a closer, `noShowSource` is the string `"closer"` but not the actual `closerId`. Payment records store `closerId` at creation but not `verifiedByUserId` or `disputedByUserId` for status changes. This prevents per-closer performance reporting and accountability tracking. |
| **Recommended fix**    | Add `lostByUserId: v.optional(v.id("users"))` to opportunities. Add `noShowMarkedByUserId: v.optional(v.id("users"))` to meetings. Add `verifiedByUserId: v.optional(v.id("users"))` and `statusChangedAt: v.optional(v.number())` to paymentRecords.                                                                                                                                                   |
| **Migration required** | No — all optional fields.                                                                                                                                                                                                                                                                                                                                                                               |

### Finding 2.6 — `customFields` uses `v.any()` on leads

|                        |                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**           | 🟡 Medium                                                                                                                                                                                                                                                                                                           |
| **Affected**           | `leads.customFields` (schema.ts line 115)                                                                                                                                                                                                                                                                           |
| **Why it matters**     | `v.any()` bypasses schema validation entirely. The field stores arbitrary Calendly form responses. For analytics, these need to be queryable and filterable, but `v.any()` provides no type safety and cannot be indexed. Future reports that want to analyze custom field data will have to handle unknown shapes. |
| **Recommended fix**    | Short term: Replace with `v.optional(v.array(v.object({ key: v.string(), value: v.string() })))` to normalize the structure. Long term: Extract hot custom fields into `leadIdentifiers` via the `customFieldMappings` pipeline (Feature F).                                                                        |
| **Migration required** | Yes — type change on existing field. Requires widen-migrate-narrow via `convex-migration-helper`.                                                                                                                                                                                                                   |

### Finding 2.7 — Denormalized customer snapshot never refreshed

|                        |                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Severity**           | 🟡 Medium                                                                                                                                                                                                                            |
| **Affected**           | `customers` (`fullName`, `email`, `phone`, `socialHandles`)                                                                                                                                                                          |
| **Why it matters**     | Customer records snapshot lead data at conversion time. If a lead's email, phone, or name is later corrected (via `updateLead` or lead merge), the customer record drifts. Reports that join on customer email will miss the update. |
| **Recommended fix**    | Option A: In `updateLead` mutation, check for linked customer and patch it too. Option B: Stop denormalizing on customers and always join to leads at read time. Option A is safer given the existing read paths.                    |
| **Migration required** | No for Option A — just mutation logic changes.                                                                                                                                                                                       |

### Finding 2.8 — `leads.socialHandles` drift risk

|                        |                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Severity**           | 🟡 Medium                                                                                                                                                                                                                                                                                                                |
| **Affected**           | `leads.socialHandles`                                                                                                                                                                                                                                                                                                    |
| **Why it matters**     | This denormalized array is only written during pipeline `inviteeCreated` processing. If a lead merge moves identifiers, or a manual identifier is added/removed, `socialHandles` is not rebuilt. The merge mutation in `convex/leads/merge.ts` moves identifiers but does not rebuild the target lead's `socialHandles`. |
| **Recommended fix**    | Extract a helper `rebuildLeadSocialHandles(ctx, leadId)` that reads all `leadIdentifiers` of social types and patches `leads.socialHandles`. Call it from: (1) `mergeLead`, (2) any future identifier CRUD mutations.                                                                                                    |
| **Migration required** | No.                                                                                                                                                                                                                                                                                                                      |

### Finding 2.9 — Missing indexes for time-range analytics queries

|                        |                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**           | 🟡 Medium                                                                                                                                                                                                                                                                                                                                                                                     |
| **Affected**           | `opportunities`, `meetings`, `paymentRecords`, `leads`, `customers`, `followUps`, `meetingReassignments`                                                                                                                                                                                                                                                                                      |
| **Why it matters**     | The current index set is designed for operational read paths (tenant + status, tenant + closer). There are no compound indexes that include a time field as the final range-queryable element, which means any future date-range report (e.g., "opportunities created this month by status", "payments recorded this week") would require a full index scan followed by JavaScript filtering. |
| **Recommended fix**    | Add these indexes (see Section 3 for the full matrix).                                                                                                                                                                                                                                                                                                                                        |
| **Migration required** | No — index additions are non-breaking. Use staged indexes if tables are large.                                                                                                                                                                                                                                                                                                                |

### Finding 2.10 — `paymentRecords` has `.collect()` in customer enrichment

|                        |                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**           | 🟡 Medium                                                                                                                                                                                                                                                                                                                                                                       |
| **Affected**           | `listCustomers` (`convex/customers/queries.ts`), `getCustomerDetail`, `getCustomerTotalPaid`                                                                                                                                                                                                                                                                                    |
| **Why it matters**     | Every customer in a paginated list triggers a `.collect()` on that customer's payment records to compute `totalPaid`. This is a nested N+1 pattern — for each of the N customers on a page, all payment records are collected. While payment counts per customer are likely small now, this pattern scales poorly and creates excessive document reads per reactive query tick. |
| **Recommended fix**    | Maintain `totalPaid` and `totalPaymentCount` directly on the `customers` document. Update them atomically in `logPayment` and `recordCustomerPayment` mutations.                                                                                                                                                                                                                |
| **Migration required** | Yes — new fields on existing customer documents. Use widen-migrate-narrow: add as optional → backfill → make required.                                                                                                                                                                                                                                                          |

### Finding 2.11 — `leads.status` is optional (should be required with default)

|                        |                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**           | 🟢 Low                                                                                                                                                                                                                                                                                                                     |
| **Affected**           | `leads.status` (schema.ts line 125)                                                                                                                                                                                                                                                                                        |
| **Why it matters**     | The `status` field is `v.optional(...)`, meaning leads created before Feature E have `undefined` status. Queries that filter by status (e.g., `by_tenantId_and_status`) must handle both `undefined` and `"active"` as meaning the same thing. This adds complexity to every analytics query that segments by lead status. |
| **Recommended fix**    | Backfill all existing leads with `status: "active"`, then change the schema to make `status` required.                                                                                                                                                                                                                     |
| **Migration required** | Yes — widen-migrate-narrow. Backfill existing docs, then narrow.                                                                                                                                                                                                                                                           |

### Finding 2.12 — No index for `meetings.by_tenantId_and_status`

|                        |                                                                                                                                                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**           | 🟢 Low                                                                                                                                                                                                                                                                                         |
| **Affected**           | `meetings` table                                                                                                                                                                                                                                                                               |
| **Why it matters**     | Several queries filter meetings by status after fetching them (e.g., `getNextMeeting` filters for `status === "scheduled"` in JavaScript). There is no compound index on `["tenantId", "status"]` for meetings. Reports like "all no-show meetings this month" would require full-index scans. |
| **Recommended fix**    | Add `by_tenantId_and_status` index on meetings: `["tenantId", "status"]`.                                                                                                                                                                                                                      |
| **Migration required** | No.                                                                                                                                                                                                                                                                                            |

### Finding 2.13 — `meetingReassignments` lacks time-range index

|                        |                                                                                                                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**           | 🟢 Low                                                                                                                                                                                                                                  |
| **Affected**           | `meetingReassignments`                                                                                                                                                                                                                  |
| **Why it matters**     | `getRecentReassignments` uses `withIndex("by_tenantId").order("desc").take(N)` which relies on `_creationTime` ordering. This works operationally but for analytics (e.g., "reassignments this week"), there's no `reassignedAt` index. |
| **Recommended fix**    | Add `by_tenantId_and_reassignedAt` index: `["tenantId", "reassignedAt"]`.                                                                                                                                                               |
| **Migration required** | No.                                                                                                                                                                                                                                     |

### Finding 2.14 — `tenants` table is an oversized document with mixed concerns

|                        |                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**           | 🟢 Low                                                                                                                                                                                                                                                                                                                                         |
| **Affected**           | `tenants` table (~25 fields including OAuth tokens)                                                                                                                                                                                                                                                                                            |
| **Why it matters**     | The `tenants` document combines identity, invite lifecycle, Calendly OAuth tokens, webhook configuration, and metadata. OAuth token refreshes update the tenant document every 90 minutes (via cron), causing all queries that read any tenant field to invalidate. This is a textbook case of high-churn data mixed with stable profile data. |
| **Recommended fix**    | Extract Calendly OAuth state (`calendlyAccessToken`, `calendlyRefreshToken`, `calendlyTokenExpiresAt`, `calendlyRefreshLockUntil`, `lastTokenRefreshAt`, `codeVerifier`) into a separate `tenantCalendlyTokens` table with `tenantId` reference. This isolates token refresh churn from tenant profile reads.                                  |
| **Migration required** | Yes — significant refactor. Plan for later phase.                                                                                                                                                                                                                                                                                              |

### Finding 2.15 — `admin/inviteCleanupMutations.ts` uses `.filter()` instead of index

|                        |                                                                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**           | 🟢 Low                                                                                                                                                                                    |
| **Affected**           | `listExpiredInvites` (internalQuery)                                                                                                                                                      |
| **Why it matters**     | This query uses `.filter()` to check expiration time instead of using the existing `by_status_and_inviteExpiresAt` index. While the tenant table is small now, this sets a bad precedent. |
| **Recommended fix**    | Rewrite to use `withIndex("by_status_and_inviteExpiresAt", q => q.eq("status", "pending_signup").lt("inviteExpiresAt", now))`.                                                            |
| **Migration required** | No.                                                                                                                                                                                       |

---

## 3. Query and Index Matrix

### Hot operational queries

| Query                   | Function                    | Current index                                                      | Result bound                               | Scale risk                                                        | Recommendation                                 |
| ----------------------- | --------------------------- | ------------------------------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------- |
| Admin dashboard stats   | `getAdminDashboardStats`    | `by_tenantId` on 4 tables                                          | Unbounded `for await`                      | 🔴 High — full scan of `users`, `opportunities`, `paymentRecords` | Replace with summary doc reads                 |
| Closer pipeline summary | `getPipelineSummary`        | `by_tenantId_and_assignedCloserId`                                 | `.collect()`                               | 🟡 Medium — all opps for closer                                   | Use counter doc or `.take(500)` guard          |
| Closer opportunity list | `listMyOpportunities`       | `by_tenantId_and_assignedCloserId`                                 | `.collect()` + JS filter/sort              | 🟡 Medium — N+1 enrichment                                        | Paginate; use denormalized `leadName` on opp   |
| Next meeting for closer | `getNextMeeting`            | `by_tenantId_and_assignedCloserId` + `by_tenantId_and_scheduledAt` | `.collect()` for opps, stream for meetings | 🟡 Medium — collects all closer opps                              | Use `nextMeetingAt` denormalized field instead |
| Customer list           | `listCustomers`             | `by_tenantId` / `by_tenantId_and_status`                           | `.paginate()` ✅                           | 🟡 Medium — N+1 `.collect()` on payments per customer             | Denormalize `totalPaid` on customer            |
| Customer total paid     | `getCustomerTotalPaid`      | `by_customerId`                                                    | `.collect()`                               | 🟡 Medium per customer                                            | Denormalize on customer doc                    |
| Lead list               | `listLeads`                 | `by_tenantId_and_status` / `by_tenantId`                           | `.paginate()` ✅                           | 🟢 Low                                                            | Good — uses pagination properly                |
| Lead search             | `searchLeads`               | `search_leads` (full-text)                                         | `.take(20/40)` ✅                          | 🟢 Low                                                            | Good — bounded                                 |
| Admin opportunity list  | `listOpportunitiesForAdmin` | `by_tenantId_and_status` / `by_tenantId_and_assignedCloserId`      | `for await` streaming                      | 🟡 Medium — no hard bound                                         | Add `.take()` or paginate                      |
| Meeting detail          | `getMeetingDetail`          | Point reads via `ctx.db.get()`                                     | Single doc                                 | 🟢 Low                                                            | Good                                           |

### Indexes needed for future analytics/reporting

| Table                  | Needed index                             | Fields                                  | Analytics use case                     |
| ---------------------- | ---------------------------------------- | --------------------------------------- | -------------------------------------- |
| `opportunities`        | `by_tenantId_and_createdAt`              | `["tenantId", "createdAt"]`             | New pipeline volume by date range      |
| `opportunities`        | `by_tenantId_and_status_and_updatedAt`   | `["tenantId", "status", "updatedAt"]`   | Status cohort analysis with recency    |
| `meetings`             | `by_tenantId_and_status`                 | `["tenantId", "status"]`                | Meeting status distribution            |
| `meetings`             | `by_tenantId_and_status_and_scheduledAt` | `["tenantId", "status", "scheduledAt"]` | No-show/completion rates by date range |
| `meetings`             | `by_tenantId_and_meetingOutcome`         | `["tenantId", "meetingOutcome"]`        | Outcome classification analytics       |
| `paymentRecords`       | `by_tenantId_and_recordedAt`             | `["tenantId", "recordedAt"]`            | Revenue over time                      |
| `paymentRecords`       | `by_tenantId_and_status_and_recordedAt`  | `["tenantId", "status", "recordedAt"]`  | Verified vs disputed revenue trends    |
| `leads`                | `by_tenantId_and_firstSeenAt`            | `["tenantId", "firstSeenAt"]`           | Lead acquisition cohorts               |
| `followUps`            | `by_tenantId_and_status_and_createdAt`   | `["tenantId", "status", "createdAt"]`   | Follow-up pipeline aging               |
| `meetingReassignments` | `by_tenantId_and_reassignedAt`           | `["tenantId", "reassignedAt"]`          | Redistribution frequency               |
| `customers`            | `by_tenantId_and_convertedByUserId`      | `["tenantId", "convertedByUserId"]`     | Closer conversion leaderboard          |

---

## 4. Integrity and Atomicity Review

### Ownership and tenant boundaries

✅ **Strong** — Every public query and mutation calls `requireTenantUser()` or `requireSystemAdminSession()`. Tenant ID is derived server-side from the JWT identity, never from client arguments. All data tables include `tenantId` and all indexes start with `tenantId` where tenant-scoped access is required.

### Reference validation and orphan risk

| Check                                    | Status        | Notes                                                                                                                                                                   |
| ---------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opportunity → Lead reference             | ✅ Validated  | Pipeline creates both atomically                                                                                                                                        |
| Meeting → Opportunity reference          | ✅ Validated  | Pipeline creates meeting after opportunity                                                                                                                              |
| Payment → Opportunity/Meeting reference  | ✅ Validated  | `logPayment` loads and validates both before writing                                                                                                                    |
| Customer → Lead reference                | ✅ Validated  | `executeConversion` loads lead in same mutation                                                                                                                         |
| FollowUp → Opportunity/Lead reference    | ✅ Validated  | Created from loaded opportunity context                                                                                                                                 |
| Lead deletion → orphaned opps/meetings   | ⚠️ No cascade | Leads are never hard-deleted (only merged/converted), so low risk. But no explicit guard prevents direct deletion via dashboard.                                        |
| Opportunity deletion → orphaned meetings | ⚠️ No cascade | Opportunities are never deleted in normal flow. No explicit deletion guard.                                                                                             |
| User removal → orphaned assignments      | ⚠️ Partial    | `removeUser` in WorkOS flow deletes the user record but does not reassign or clean up `assignedCloserId` on opportunities. Orphaned closer references could accumulate. |

### Write atomicity

✅ **Strong for core flows** — Status transitions on opportunities and meetings happen in the same mutation as related record creation (e.g., `logPayment` creates payment record + transitions opportunity + auto-converts lead in one mutation). `updateOpportunityMeetingRefs` runs inside the same mutation as meeting changes.

⚠️ **Actions with sequential mutations** — `inviteUser`, `updateUserRole`, and Calendly OAuth flows use actions that call external APIs then write to the database. If the external call succeeds but the mutation fails, there's a mismatch. This is acceptable for the action pattern but should be documented.

### Denormalized-field maintenance

| Denormalized field                                   | Updated in same write path?                                                  | Risk                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------- |
| `opportunities.latestMeetingId/At, nextMeetingId/At` | ✅ Yes — `updateOpportunityMeetingRefs()` called from all relevant mutations | Low                                                      |
| `leads.socialHandles`                                | ⚠️ Only in pipeline `inviteeCreated`                                         | Medium — drifts on merge or manual identifier changes    |
| `leads.searchText`                                   | ⚠️ Updated in pipeline and some lead mutations                               | Low-Medium — may miss edge cases                         |
| `meetings.leadName`                                  | ⚠️ Only set at creation                                                      | Low — lead names rarely change after Calendly extraction |
| `customers.fullName/email/phone/socialHandles`       | ❌ Never refreshed after conversion                                          | Medium — drifts if lead data corrected                   |
| `users.calendlyMemberName`                           | ✅ Updated on link/sync                                                      | Low                                                      |

---

## 5. Migration Notes

### Safe changes (ship directly)

These are additive and do not affect existing documents:

1. **New optional timestamp fields** on opportunities, meetings, paymentRecords, customers, followUps (Finding 2.4)
2. **New optional attribution fields** (`lostByUserId`, `noShowMarkedByUserId`, `verifiedByUserId`, etc.) (Finding 2.5)
3. **New indexes** for analytics — 11 indexes from Finding 2.9 + 2.12 + 2.13. Consider `staged: true` for large tables.
4. **Mutation logic changes** to populate new fields (write-path updates only)
5. **Helper extraction** for `rebuildLeadSocialHandles` (Finding 2.8)
6. **Query rewrites** replacing `.filter()` with `withIndex()` (Finding 2.15)

### Breaking changes (need widen-migrate-narrow)

1. **`leads.customFields`**: Changing from `v.any()` to a structured validator (Finding 2.6) — requires data migration to normalize existing values
2. **`leads.status`**: Making required instead of optional (Finding 2.11) — requires backfill of `"active"` on all existing leads with undefined status
3. **`customers.totalPaid` / `totalPaymentCount`**: If made required (Finding 2.10) — add as optional, backfill, then narrow

### New tables (non-breaking additions)

1. **`statusChanges`**: Append-only audit trail (Finding 2.1) — new table, no existing data impact
2. **`tenantMetrics`**: Per-tenant summary counters (Finding 2.2) — new table, requires backfill computation

### Deferred structural changes

1. **`tenantCalendlyTokens` extraction**: Splitting OAuth data from tenants (Finding 2.14) — significant refactor touching OAuth, token refresh, webhook setup, and health check flows. Plan for a dedicated phase.

---

## 6. Remediation Plan

### Immediate — correctness and data integrity

| #   | Action                                                                                                                                                                                                                                                                                     | Findings | Effort |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ |
| 1   | **Add `statusChanges` audit trail table** and wire into all status-transitioning mutations (`markAsLost`, `startMeeting`, `markNoShow`, `logPayment`, pipeline handlers, `updateCustomerStatus`, follow-up transitions). This is the single most impactful change for analytics readiness. | 2.1      | Medium |
| 2   | **Fix `rebuildLeadSocialHandles` drift** — extract helper and call from `mergeLead` and any identifier mutation paths.                                                                                                                                                                     | 2.8      | Small  |
| 3   | **Fix customer snapshot drift** — when `updateLead` patches lead data, also patch linked customer if one exists.                                                                                                                                                                           | 2.7      | Small  |
| 4   | **Replace `.filter()` with `withIndex()` in `listExpiredInvites`**.                                                                                                                                                                                                                        | 2.15     | Small  |

### Next — performance and analytics readiness

| #   | Action                                                                                                                                                                                   | Findings        | Effort       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------ |
| 5   | **Add analytics timestamp fields** (`lostAt`, `canceledAt`, `paymentReceivedAt`, `completedAt`, `verifiedAt`, `churnedAt`, `bookedAt`) as optional fields. Update mutations to set them. | 2.4             | Small-Medium |
| 6   | **Add user attribution fields** (`lostByUserId`, `noShowMarkedByUserId`, `verifiedByUserId`) as optional fields. Update mutations to set them.                                           | 2.5             | Small        |
| 7   | **Add analytics indexes** (11 new indexes from the matrix in Section 3). Deploy with `staged: true` if any table exceeds ~50k docs.                                                      | 2.9, 2.12, 2.13 | Small        |
| 8   | **Replace dashboard full-table scans** — create `tenantMetrics` summary table, maintain counters in mutations, rewrite `getAdminDashboardStats` to read summary docs.                    | 2.2             | Medium-Large |
| 9   | **Bound closer pipeline queries** — add `.take(N)` guards or pagination to `listMyOpportunities`, `getPipelineSummary`, `getNextMeeting`.                                                | 2.3             | Small        |
| 10  | **Denormalize `totalPaid` on customers** — add optional field, backfill, wire into payment mutations, remove `.collect()` aggregation from `listCustomers`.                              | 2.10            | Medium       |

### Later — structural improvements for scale

| #   | Action                                                                                                                              | Findings | Effort       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------ |
| 11  | **Migrate `leads.customFields` from `v.any()` to structured validator** using widen-migrate-narrow.                                 | 2.6      | Medium       |
| 12  | **Backfill `leads.status`** to `"active"` for all undefined values, then make the field required.                                   | 2.11     | Small-Medium |
| 13  | **Extract `tenantCalendlyTokens`** into separate table to isolate OAuth token refresh churn from tenant profile reads.              | 2.14     | Large        |
| 14  | **Consider per-closer summary documents** for `getPipelineSummary` if closer-level dashboard performance becomes an issue at scale. | 2.3      | Medium       |

---

## Audit Checklist

- [x] Read the local Convex guidelines and docs first
- [x] Inventory every table, index, and major function path (~149 functions across 14 tables)
- [x] Confirm document boundaries are bounded and intentional
- [x] Confirm relationships use explicit `Id` references or junction tables
- [x] Check that important invariants are enforced in mutations
- [x] Check that public functions validate arguments and auth
- [x] Check that hot reads use `withIndex`, `take`, or `paginate`
- [x] Check for `.filter()`, broad `.collect()`, and `.collect().length`
- [x] Check for redundant or missing indexes
- [x] Check for denormalized fields and whether their write paths maintain them
- [x] Check for high-churn fields mixed into stable documents
- [x] Identify any changes that require migration planning

---

## Appendix A: Current Index Inventory (53 indexes across 14 tables)

| Table                  | Index                                  | Fields                                                              |
| ---------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| `tenants`              | `by_contactEmail`                      | `["contactEmail"]`                                                  |
| `tenants`              | `by_workosOrgId`                       | `["workosOrgId"]`                                                   |
| `tenants`              | `by_status`                            | `["status"]`                                                        |
| `tenants`              | `by_inviteTokenHash`                   | `["inviteTokenHash"]`                                               |
| `tenants`              | `by_status_and_inviteExpiresAt`        | `["status", "inviteExpiresAt"]`                                     |
| `users`                | `by_tenantId`                          | `["tenantId"]`                                                      |
| `users`                | `by_workosUserId`                      | `["workosUserId"]`                                                  |
| `users`                | `by_tenantId_and_email`                | `["tenantId", "email"]`                                             |
| `users`                | `by_tenantId_and_calendlyUserUri`      | `["tenantId", "calendlyUserUri"]`                                   |
| `rawWebhookEvents`     | `by_tenantId_and_eventType`            | `["tenantId", "eventType"]`                                         |
| `rawWebhookEvents`     | `by_calendlyEventUri`                  | `["calendlyEventUri"]`                                              |
| `rawWebhookEvents`     | `by_processed`                         | `["processed"]`                                                     |
| `rawWebhookEvents`     | `by_processed_and_receivedAt`          | `["processed", "receivedAt"]`                                       |
| `calendlyOrgMembers`   | `by_tenantId`                          | `["tenantId"]`                                                      |
| `calendlyOrgMembers`   | `by_tenantId_and_calendlyUserUri`      | `["tenantId", "calendlyUserUri"]`                                   |
| `calendlyOrgMembers`   | `by_tenantId_and_matchedUserId`        | `["tenantId", "matchedUserId"]`                                     |
| `calendlyOrgMembers`   | `by_tenantId_and_lastSyncedAt`         | `["tenantId", "lastSyncedAt"]`                                      |
| `leads`                | `by_tenantId`                          | `["tenantId"]`                                                      |
| `leads`                | `by_tenantId_and_email`                | `["tenantId", "email"]`                                             |
| `leads`                | `by_tenantId_and_status`               | `["tenantId", "status"]`                                            |
| `leads`                | `search_leads` (search)                | searchField: `"searchText"`, filterFields: `["tenantId", "status"]` |
| `leadIdentifiers`      | `by_tenantId_and_type_and_value`       | `["tenantId", "type", "value"]`                                     |
| `leadIdentifiers`      | `by_leadId`                            | `["leadId"]`                                                        |
| `leadIdentifiers`      | `by_tenantId_and_value`                | `["tenantId", "value"]`                                             |
| `leadMergeHistory`     | `by_tenantId`                          | `["tenantId"]`                                                      |
| `leadMergeHistory`     | `by_sourceLeadId`                      | `["sourceLeadId"]`                                                  |
| `leadMergeHistory`     | `by_targetLeadId`                      | `["targetLeadId"]`                                                  |
| `opportunities`        | `by_tenantId`                          | `["tenantId"]`                                                      |
| `opportunities`        | `by_tenantId_and_leadId`               | `["tenantId", "leadId"]`                                            |
| `opportunities`        | `by_tenantId_and_assignedCloserId`     | `["tenantId", "assignedCloserId"]`                                  |
| `opportunities`        | `by_tenantId_and_status`               | `["tenantId", "status"]`                                            |
| `meetings`             | `by_opportunityId`                     | `["opportunityId"]`                                                 |
| `meetings`             | `by_tenantId_and_scheduledAt`          | `["tenantId", "scheduledAt"]`                                       |
| `meetings`             | `by_tenantId_and_calendlyEventUri`     | `["tenantId", "calendlyEventUri"]`                                  |
| `closerUnavailability` | `by_tenantId_and_date`                 | `["tenantId", "date"]`                                              |
| `closerUnavailability` | `by_closerId_and_date`                 | `["closerId", "date"]`                                              |
| `meetingReassignments` | `by_tenantId`                          | `["tenantId"]`                                                      |
| `meetingReassignments` | `by_meetingId`                         | `["meetingId"]`                                                     |
| `meetingReassignments` | `by_toCloserId`                        | `["toCloserId"]`                                                    |
| `meetingReassignments` | `by_fromCloserId`                      | `["fromCloserId"]`                                                  |
| `meetingReassignments` | `by_unavailabilityId`                  | `["unavailabilityId"]`                                              |
| `eventTypeConfigs`     | `by_tenantId`                          | `["tenantId"]`                                                      |
| `eventTypeConfigs`     | `by_tenantId_and_calendlyEventTypeUri` | `["tenantId", "calendlyEventTypeUri"]`                              |
| `customers`            | `by_tenantId`                          | `["tenantId"]`                                                      |
| `customers`            | `by_tenantId_and_leadId`               | `["tenantId", "leadId"]`                                            |
| `customers`            | `by_tenantId_and_status`               | `["tenantId", "status"]`                                            |
| `customers`            | `by_tenantId_and_convertedAt`          | `["tenantId", "convertedAt"]`                                       |
| `paymentRecords`       | `by_opportunityId`                     | `["opportunityId"]`                                                 |
| `paymentRecords`       | `by_tenantId`                          | `["tenantId"]`                                                      |
| `paymentRecords`       | `by_tenantId_and_closerId`             | `["tenantId", "closerId"]`                                          |
| `paymentRecords`       | `by_customerId`                        | `["customerId"]`                                                    |
| `followUps`            | `by_tenantId`                          | `["tenantId"]`                                                      |
| `followUps`            | `by_opportunityId`                     | `["opportunityId"]`                                                 |
| `followUps`            | `by_tenantId_and_closerId`             | `["tenantId", "closerId"]`                                          |
| `followUps`            | `by_tenantId_and_closerId_and_status`  | `["tenantId", "closerId", "status"]`                                |

---

## Appendix B: Proposed `statusChanges` Table Schema

```ts
statusChanges: defineTable({
	tenantId: v.id("tenants"),
	entityType: v.union(
		v.literal("opportunity"),
		v.literal("meeting"),
		v.literal("lead"),
		v.literal("customer"),
		v.literal("followUp"),
	),
	entityId: v.string(), // The _id of the entity (string because it spans multiple tables)
	fromStatus: v.string(),
	toStatus: v.string(),
	changedByUserId: v.optional(v.id("users")), // Optional for webhook-triggered changes
	changedBySource: v.union(
		v.literal("closer"),
		v.literal("admin"),
		v.literal("pipeline"),
		v.literal("system"),
	),
	changedAt: v.number(),
	reason: v.optional(v.string()), // Lost reason, cancellation reason, etc.
	metadata: v.optional(v.string()), // JSON string for additional context
})
	.index("by_entityId", ["entityId"])
	.index("by_tenantId_and_entityType_and_changedAt", [
		"tenantId",
		"entityType",
		"changedAt",
	])
	.index("by_tenantId_and_changedAt", ["tenantId", "changedAt"])
	.index("by_tenantId_and_changedByUserId", ["tenantId", "changedByUserId"]);
```

This table enables:

- **Funnel analysis**: How many opps went from `scheduled` → `in_progress` → `payment_received` vs `scheduled` → `canceled`
- **Stage duration**: Average time in `in_progress` before payment or loss
- **Closer performance**: Which closer has the fastest cycle time, lowest no-show rate
- **Trend analysis**: Status change velocity over time by tenant
- **Audit trail**: Who changed what, when, and why

### Helper function pattern

```ts
// convex/lib/statusChangeLogger.ts
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

type EntityType = "opportunity" | "meeting" | "lead" | "customer" | "followUp";
type ChangeSource = "closer" | "admin" | "pipeline" | "system";

export async function logStatusChange(
	ctx: MutationCtx,
	opts: {
		tenantId: Id<"tenants">;
		entityType: EntityType;
		entityId: string;
		fromStatus: string;
		toStatus: string;
		changedByUserId?: Id<"users">;
		changedBySource: ChangeSource;
		reason?: string;
		metadata?: string;
	},
): Promise<void> {
	await ctx.db.insert("statusChanges", {
		...opts,
		changedAt: Date.now(),
	});
}
```

Usage in mutations:

```ts
// In markAsLost mutation, after patching the opportunity:
await logStatusChange(ctx, {
	tenantId,
	entityType: "opportunity",
	entityId: opportunityId,
	fromStatus: opportunity.status,
	toStatus: "lost",
	changedByUserId: userId,
	changedBySource: "closer",
	reason: normalizedReason,
});
```

---

## Appendix C: Proposed `tenantMetrics` Table Schema

```ts
tenantMetrics: defineTable({
	tenantId: v.id("tenants"),
	// Team
	totalTeamMembers: v.number(),
	totalClosers: v.number(),
	unmatchedClosers: v.number(),
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

The dashboard query becomes a single `ctx.db.get()` instead of four full-table scans.
