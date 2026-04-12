# Phase 1 --- Schema Widen + New Tables

**Goal:** Deploy all schema additions from the v0.5b specification: 5 new tables, ~20 new optional fields on 6 existing tables, and 24 new indexes across 10 tables. Zero behavioral changes. Zero breaking changes. Purely additive.

**Prerequisite:** None --- Phase 1 has no dependencies and begins immediately. This phase is on the critical path for all subsequent v0.5b work.

**Runs in PARALLEL with:** Nothing --- Phase 2 (backfill), Phase 3 (mutations), Phase 4 (queries), Phase 5 (OAuth extraction), Phase 6 (narrow), and Phase 7 (frontend) all depend on Phase 1 completing first.

**Skills to invoke:**
- `convex-migration-helper` --- for widen-migrate-narrow schema discipline; confirms that all additions are optional/additive before deployment

---

## Acceptance Criteria

1. Five new tables exist in `convex/schema.ts`: `domainEvents`, `tenantStats`, `meetingFormResponses`, `eventTypeFieldCatalog`, `tenantCalendlyConnections` --- each with all fields and indexes matching the v0.5b specification Section 12.
2. `users` table has two new optional fields: `deletedAt: v.optional(v.number())` and `isActive: v.optional(v.boolean())`.
3. `meetings` table has four new optional fields: `assignedCloserId`, `completedAt`, `canceledAt`, `noShowMarkedByUserId`.
4. `opportunities` table has five new optional fields: `lostAt`, `canceledAt`, `noShowAt`, `paymentReceivedAt`, `lostByUserId`.
5. `paymentRecords` table has five new optional fields: `amountMinor`, `verifiedAt`, `verifiedByUserId`, `statusChangedAt`, `contextType`.
6. `customers` table has five new optional fields: `totalPaidMinor`, `totalPaymentCount`, `paymentCurrency`, `churnedAt`, `pausedAt`.
7. `followUps` table has one new optional field: `bookedAt`.
8. Twenty-four new indexes exist across 10 tables: 8 correctness indexes, 14 analytics indexes, 1 closer dimension index, 1 user soft-delete index --- all with names matching their field lists per project convention.
9. Schema deployment via `npx convex dev` completes without errors; Convex builds all 24 indexes successfully (at ~700 records, index backfill is near-instant).
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (New table definitions: 5 tables)
  |
  v
1B (New optional fields on 6 existing tables)
  |
  v
1C (New indexes: 24 across 10 tables)
  |
  v
1D (Deploy, verify, and validate)
```

**Why sequential, not parallel:** Subphases 1A, 1B, and 1C all modify the same file (`convex/schema.ts`). They cannot run in parallel. However, conceptually separating them helps the implementer understand what each change set accomplishes and verify each category independently before moving to the next.

**Practical note:** An experienced implementer may choose to apply 1A + 1B + 1C as a single editing session, then deploy once in 1D. The subphase separation exists for clarity and review, not for separate deployments.

**Estimated time:** 1.5--2 hours (1A = 30 min, 1B = 20 min, 1C = 30 min, 1D = 20 min)

---

## Subphases

### 1A --- New Table Definitions (5 tables)

**Type:** Backend (schema only)
**Parallelizable:** No --- this is the first step; 1B, 1C, and 1D depend on it.

**What:** Add five new table definitions to `convex/schema.ts`: `domainEvents`, `tenantStats`, `meetingFormResponses`, `eventTypeFieldCatalog`, and `tenantCalendlyConnections`.

**Why:** These tables are required by v0.5b Findings 1, 2, 4, and 14. Adding them as empty tables with no consumers is the first step of the widen-migrate-narrow discipline --- the schema widens to accept new data shapes before any code changes.

- `domainEvents` (F1): Append-only business event history for audit trail, replacing the current pattern of in-place status overwrites with no history.
- `tenantStats` (F4): Precomputed dashboard summary document per tenant, replacing 4+ full table scans on every reactive render.
- `meetingFormResponses` (F2): Normalized per-meeting booking answers, replacing the untyped `leads.customFields` blob that loses per-interaction provenance.
- `eventTypeFieldCatalog` (F2): Stable field registry per event type, tracking which Calendly form questions have been seen and their labels.
- `tenantCalendlyConnections` (F14): Extracted OAuth/webhook state from `tenants`, eliminating 16 reactive invalidations/day from token refresh.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Add `domainEvents` table**

Insert after the `followUps` table definition (after the current line 521 closing `});`, but before the schema closing). Place it as a new section after the `followUps` block:

```typescript
// Path: convex/schema.ts

  // === v0.5b: Domain Events (Finding 1) ===
  // Append-only business event history. Every status transition, user action, and
  // pipeline event is recorded here for audit, analytics, and debugging.
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
    entityId: v.string(), // String (not v.id) because it may reference any table
    eventType: v.string(), // e.g. "opportunity.status_changed", "meeting.started"
    occurredAt: v.number(), // Unix ms timestamp
    actorUserId: v.optional(v.id("users")), // Who triggered the event; undefined for system/pipeline events
    source: v.union(
      v.literal("closer"),
      v.literal("admin"),
      v.literal("pipeline"),
      v.literal("system"),
    ),
    fromStatus: v.optional(v.string()), // Previous status (for transitions)
    toStatus: v.optional(v.string()), // New status (for transitions)
    reason: v.optional(v.string()), // Human-readable reason (e.g., lost reason, no-show reason)
    metadata: v.optional(v.string()), // JSON-serialized event-specific payload
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
  // === End v0.5b: Domain Events ===
```

**Step 2: Add `tenantStats` table**

Insert immediately after `domainEvents`:

```typescript
// Path: convex/schema.ts

  // === v0.5b: Tenant Stats (Finding 4) ===
  // Pre-computed dashboard summary document. One row per tenant, maintained
  // atomically by mutations that change source data. The admin dashboard reads
  // 1 document instead of scanning 4+ tables.
  tenantStats: defineTable({
    tenantId: v.id("tenants"),
    totalTeamMembers: v.number(),
    totalClosers: v.number(),
    totalOpportunities: v.number(),
    activeOpportunities: v.number(),
    wonDeals: v.number(),
    lostDeals: v.number(),
    totalRevenueMinor: v.number(), // Integer cents
    totalPaymentRecords: v.number(),
    totalLeads: v.number(),
    totalCustomers: v.number(),
    lastUpdatedAt: v.number(), // Unix ms timestamp of last counter update
  }).index("by_tenantId", ["tenantId"]),
  // === End v0.5b: Tenant Stats ===
```

**Step 3: Add `meetingFormResponses` table**

Insert immediately after `tenantStats`:

```typescript
// Path: convex/schema.ts

  // === v0.5b: Meeting Form Responses (Finding 2) ===
  // Normalized per-meeting booking answer facts. Each row is one question-answer
  // pair from a Calendly booking form, linked to meeting, opportunity, lead, and
  // optionally the event type config and field catalog entry.
  meetingFormResponses: defineTable({
    tenantId: v.id("tenants"),
    meetingId: v.id("meetings"),
    opportunityId: v.id("opportunities"),
    leadId: v.id("leads"),
    eventTypeConfigId: v.optional(v.id("eventTypeConfigs")),
    fieldCatalogId: v.optional(v.id("eventTypeFieldCatalog")),
    fieldKey: v.string(), // Normalized key derived from the question text
    questionLabelSnapshot: v.string(), // The question label at capture time
    answerText: v.string(), // The respondent's answer
    capturedAt: v.number(), // Unix ms timestamp
  })
    .index("by_meetingId", ["meetingId"])
    .index("by_tenantId_and_eventTypeConfigId", [
      "tenantId",
      "eventTypeConfigId",
    ])
    .index("by_tenantId_and_fieldKey", ["tenantId", "fieldKey"])
    .index("by_leadId", ["leadId"]),
  // === End v0.5b: Meeting Form Responses ===
```

**Step 4: Add `eventTypeFieldCatalog` table**

Insert immediately after `meetingFormResponses`:

```typescript
// Path: convex/schema.ts

  // === v0.5b: Event Type Field Catalog (Finding 2) ===
  // Stable field registry per event type. Tracks which Calendly form questions
  // have been seen for each event type, their current labels, and when they were
  // first/last observed. Used as a dimension table for meetingFormResponses.
  eventTypeFieldCatalog: defineTable({
    tenantId: v.id("tenants"),
    eventTypeConfigId: v.id("eventTypeConfigs"),
    fieldKey: v.string(), // Normalized key derived from the question text
    currentLabel: v.string(), // Most recently observed question label
    firstSeenAt: v.number(), // Unix ms timestamp
    lastSeenAt: v.number(), // Unix ms timestamp
    valueType: v.optional(v.string()), // Optional type hint (e.g., "email", "phone", "text")
  })
    .index("by_tenantId_and_eventTypeConfigId", [
      "tenantId",
      "eventTypeConfigId",
    ])
    .index("by_tenantId_and_fieldKey", ["tenantId", "fieldKey"]),
  // === End v0.5b: Event Type Field Catalog ===
```

**Step 5: Add `tenantCalendlyConnections` table**

Insert immediately after `eventTypeFieldCatalog`:

```typescript
// Path: convex/schema.ts

  // === v0.5b: Tenant Calendly Connections (Finding 14) ===
  // Extracted OAuth/webhook state from the tenants table. Separates high-churn
  // token refresh writes from stable tenant identity reads, eliminating ~16
  // reactive subscription invalidations/day per tenant.
  tenantCalendlyConnections: defineTable({
    tenantId: v.id("tenants"),
    // OAuth tokens
    calendlyAccessToken: v.optional(v.string()),
    calendlyRefreshToken: v.optional(v.string()),
    calendlyTokenExpiresAt: v.optional(v.number()),
    calendlyRefreshLockUntil: v.optional(v.number()),
    lastTokenRefreshAt: v.optional(v.number()),
    codeVerifier: v.optional(v.string()), // Temporary: PKCE code verifier during OAuth
    // Organization URIs
    calendlyOrganizationUri: v.optional(v.string()),
    calendlyUserUri: v.optional(v.string()),
    // Webhook config
    calendlyWebhookUri: v.optional(v.string()),
    calendlyWebhookSigningKey: v.optional(v.string()),
    // Connection health
    connectionStatus: v.optional(
      v.union(
        v.literal("connected"),
        v.literal("disconnected"),
        v.literal("token_expired"),
      ),
    ),
    lastHealthCheckAt: v.optional(v.number()),
  }).index("by_tenantId", ["tenantId"]),
  // === End v0.5b: Tenant Calendly Connections ===
```

**Key implementation notes:**

- All five tables follow existing project conventions: `tenantId` on every table for multi-tenant isolation, descriptive inline comments, section markers (`=== v0.5b: ... ===`).
- `domainEvents.entityId` is `v.string()` not `v.id()` because it may reference documents in any table. The `entityType` discriminator identifies which table to resolve against.
- `domainEvents.metadata` is `v.optional(v.string())` for JSON-serialized payloads, not `v.any()` --- this avoids the `v.any()` anti-pattern identified in Finding 2 while still supporting arbitrary event-specific data.
- `tenantStats` uses all required fields (not optional) because the table starts empty and Phase 2 seeds it with correct values. Documents are only created with all fields populated.
- `tenantCalendlyConnections` mirrors the OAuth-related fields currently on `tenants` but with slightly different field names (e.g., `calendlyOrganizationUri` vs `calendlyOrgUri`) to make the extraction explicit. Phase 5 handles the actual data migration.
- All new tables are within Convex's 32-index-per-table limit. Most-indexed new table: `domainEvents` with 5 indexes.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add 5 new table definitions with all fields and table-specific indexes |

---

### 1B --- New Optional Fields on Existing Tables (6 tables modified)

**Type:** Backend (schema only)
**Parallelizable:** No --- modifies `convex/schema.ts`, same file as 1A. Must be applied after 1A.

**What:** Add ~20 new optional fields to 6 existing tables: `users`, `meetings`, `opportunities`, `paymentRecords`, `customers`, and `followUps`.

**Why:** These fields support soft-delete (F8), lifecycle timestamps (F16), user attribution (F17), the money model fix (F3), closer dimension denormalization (F12), dashboard aggregation (F4), and polymorphism disambiguation (F18). All are `v.optional()` to maintain backward compatibility with existing documents --- the widen step of widen-migrate-narrow.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Add soft-delete fields to `users` table**

Locate the `users` table definition (lines 53-81). Add the two new fields after the `personalEventTypeUri` field, before the closing `})`):

```typescript
// Path: convex/schema.ts (within users table definition, after personalEventTypeUri)

    // Personal Calendly booking page URL used for follow-up scheduling links.
    personalEventTypeUri: v.optional(v.string()),

    // === v0.5b: User Soft-Delete (Finding 8) ===
    // Users are never physically deleted. These fields support soft-delete:
    // deletedAt = timestamp of deactivation; isActive = query-friendly boolean.
    // undefined treated as "active" during migration window (Phase 2 backfills true).
    deletedAt: v.optional(v.number()),
    isActive: v.optional(v.boolean()),
    // === End v0.5b: User Soft-Delete ===
  })
```

**Step 2: Add closer dimension and lifecycle fields to `meetings` table**

Locate the `meetings` table definition (lines 255-338). Add the new fields after the `rescheduledFromMeetingId` field, before the closing `})`:

```typescript
// Path: convex/schema.ts (within meetings table definition, after rescheduledFromMeetingId)

    // === End Feature B: Reschedule Chain ===

    // === v0.5b: Closer Dimension + Lifecycle Timestamps + Attribution ===
    // Direct closer reference on meetings (Finding 12). Eliminates O(n*m) join
    // through opportunities. Set on creation, updated on reassignment.
    assignedCloserId: v.optional(v.id("users")),
    // Lifecycle timestamps (Finding 16). Set by status-changing mutations.
    completedAt: v.optional(v.number()),
    canceledAt: v.optional(v.number()),
    // User attribution (Finding 17). Who performed this action.
    noShowMarkedByUserId: v.optional(v.id("users")),
    // === End v0.5b ===
  })
```

**Step 3: Add lifecycle timestamps and attribution to `opportunities` table**

Locate the `opportunities` table definition (lines 208-253). Add the new fields after the `potentialDuplicateLeadId` field, before the closing `})`:

```typescript
// Path: convex/schema.ts (within opportunities table definition, after potentialDuplicateLeadId)

    // === End Feature E ===

    // === v0.5b: Lifecycle Timestamps + Attribution (Findings 16, 17) ===
    // Timestamps set by status-changing mutations. Enable "when did X happen?" queries.
    lostAt: v.optional(v.number()),
    canceledAt: v.optional(v.number()),
    noShowAt: v.optional(v.number()),
    paymentReceivedAt: v.optional(v.number()),
    // Attribution: who performed this action.
    lostByUserId: v.optional(v.id("users")),
    // === End v0.5b ===
  })
```

**Step 4: Add money model, lifecycle, attribution, and context fields to `paymentRecords` table**

Locate the `paymentRecords` table definition (lines 456-479). Add the new fields after the `customerId` field, before the closing `})`:

```typescript
// Path: convex/schema.ts (within paymentRecords table definition, after customerId)

    // === End Feature D ===

    // === v0.5b: Money Model + Lifecycle + Attribution + Context (Findings 3, 16, 17, 18) ===
    // Integer cents representation (Finding 3). Replaces float `amount` after migration.
    amountMinor: v.optional(v.number()),
    // Lifecycle timestamps (Finding 16).
    verifiedAt: v.optional(v.number()),
    statusChangedAt: v.optional(v.number()),
    // User attribution (Finding 17).
    verifiedByUserId: v.optional(v.id("users")),
    // Context discriminant (Finding 18). Distinguishes opportunity-linked vs customer-linked payments.
    contextType: v.optional(
      v.union(v.literal("opportunity"), v.literal("customer")),
    ),
    // === End v0.5b ===
  })
```

**Step 5: Add denormalized totals and lifecycle timestamps to `customers` table**

Locate the `customers` table definition (lines 422-453). Add the new fields after the `createdAt` field, before the closing `})`:

```typescript
// Path: convex/schema.ts (within customers table definition, after createdAt)

    createdAt: v.number(),

    // === v0.5b: Denormalized Totals + Lifecycle Timestamps (Findings 4, 16) ===
    // Pre-computed payment aggregates (Finding 4). Updated atomically on payment record/verify.
    totalPaidMinor: v.optional(v.number()), // Sum of amountMinor across verified payments
    totalPaymentCount: v.optional(v.number()),
    paymentCurrency: v.optional(v.string()), // ISO 4217 code (e.g., "USD")
    // Lifecycle timestamps (Finding 16). Set by status-changing mutations.
    churnedAt: v.optional(v.number()),
    pausedAt: v.optional(v.number()),
    // === End v0.5b ===
  })
```

**Step 6: Add lifecycle timestamp to `followUps` table**

Locate the `followUps` table definition (lines 481-520). Add the new field after the `createdAt` field, before the closing `})`:

```typescript
// Path: convex/schema.ts (within followUps table definition, after createdAt)

    createdAt: v.number(),

    // === v0.5b: Lifecycle Timestamp (Finding 16) ===
    // When the follow-up was confirmed as booked (scheduling link was used).
    bookedAt: v.optional(v.number()),
    // === End v0.5b ===
  })
```

**Key implementation notes:**

- Every new field is `v.optional()` --- this is the "widen" step. Existing documents remain valid without any data migration. Phase 2 backfills these fields; Phase 6 narrows selected fields to required.
- `meetings.assignedCloserId` is `v.optional(v.id("users"))` now, but will become required in Phase 6 after all existing meetings are backfilled. This field eliminates the O(n*m) join pattern across 5+ query paths (F5, F12).
- `paymentRecords.amountMinor` will coexist with the existing `amount` field during migration. Phase 3 dual-writes both; Phase 4 switches reads to `amountMinor`; Phase 6 removes `amount`.
- `users.isActive` is `v.optional(v.boolean())` --- `undefined` is treated as `true` during the migration window. Phase 2 backfills all existing users to `isActive: true`; Phase 3 adds the `isActive` check to `requireTenantUser`.
- Field ordering within each table follows the existing pattern: group by concern, with section markers for clarity.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add ~20 optional fields across 6 existing tables |

---

### 1C --- New Indexes (24 indexes across 10 tables)

**Type:** Backend (schema only)
**Parallelizable:** No --- modifies `convex/schema.ts`, same file as 1A and 1B. Must be applied after 1B.

**What:** Add 24 new indexes across 10 tables, grouped into four categories: 8 correctness indexes, 14 analytics indexes, 1 closer dimension index, and 1 user soft-delete index.

**Why:** The correctness indexes (F5, F9, F10, F11) fix broken query shapes where post-paginate/post-search JavaScript filtering produces incomplete results or O(n) scans. The analytics indexes (F13) enable date-range and status-filtered reporting queries without full table scans. The closer dimension index (F12) supports the new `meetings.assignedCloserId` field. The user soft-delete index (F8) enables efficient "active users only" queries.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Add correctness and analytics indexes to `opportunities` table**

Locate the `opportunities` table index block (currently lines 250-253). Add the new indexes after the existing ones:

```typescript
// Path: convex/schema.ts (opportunities table index chain)

  })
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_leadId", ["tenantId", "leadId"])
    .index("by_tenantId_and_assignedCloserId", ["tenantId", "assignedCloserId"])
    .index("by_tenantId_and_status", ["tenantId", "status"])
    // v0.5b correctness indexes (F5, F10, F11)
    .index("by_tenantId_and_assignedCloserId_and_status", [
      "tenantId",
      "assignedCloserId",
      "status",
    ])
    .index("by_tenantId_and_potentialDuplicateLeadId", [
      "tenantId",
      "potentialDuplicateLeadId",
    ])
    .index("by_tenantId_and_eventTypeConfigId", [
      "tenantId",
      "eventTypeConfigId",
    ])
    // v0.5b analytics indexes (F13)
    .index("by_tenantId_and_createdAt", ["tenantId", "createdAt"])
    .index("by_tenantId_and_status_and_createdAt", [
      "tenantId",
      "status",
      "createdAt",
    ]),
```

**Step 2: Add correctness, analytics, and closer dimension indexes to `meetings` table**

Locate the `meetings` table index block (currently lines 336-338). Add the new indexes after the existing ones:

```typescript
// Path: convex/schema.ts (meetings table index chain)

  })
    .index("by_opportunityId", ["opportunityId"])
    .index("by_tenantId_and_scheduledAt", ["tenantId", "scheduledAt"])
    .index("by_tenantId_and_calendlyEventUri", ["tenantId", "calendlyEventUri"])
    // v0.5b analytics indexes (F13)
    .index("by_tenantId_and_status_and_scheduledAt", [
      "tenantId",
      "status",
      "scheduledAt",
    ])
    .index("by_tenantId_and_meetingOutcome_and_scheduledAt", [
      "tenantId",
      "meetingOutcome",
      "scheduledAt",
    ])
    .index("by_opportunityId_and_scheduledAt", [
      "opportunityId",
      "scheduledAt",
    ])
    .index("by_tenantId_and_status", ["tenantId", "status"])
    // v0.5b closer dimension index (F12)
    .index("by_tenantId_and_assignedCloserId_and_scheduledAt", [
      "tenantId",
      "assignedCloserId",
      "scheduledAt",
    ]),
```

**Step 3: Add correctness indexes to `customers` table**

Locate the `customers` table index block (currently lines 450-453). Add the new indexes after the existing ones:

```typescript
// Path: convex/schema.ts (customers table index chain)

  })
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_leadId", ["tenantId", "leadId"])
    .index("by_tenantId_and_status", ["tenantId", "status"])
    .index("by_tenantId_and_convertedAt", ["tenantId", "convertedAt"])
    // v0.5b correctness indexes (F10)
    .index("by_tenantId_and_convertedByUserId", [
      "tenantId",
      "convertedByUserId",
    ])
    .index("by_tenantId_and_convertedByUserId_and_status", [
      "tenantId",
      "convertedByUserId",
      "status",
    ]),
```

**Step 4: Add correctness and analytics indexes to `followUps` table**

Locate the `followUps` table index block (currently lines 514-520). Add the new indexes after the existing ones:

```typescript
// Path: convex/schema.ts (followUps table index chain)

  })
    .index("by_tenantId", ["tenantId"])
    .index("by_opportunityId", ["opportunityId"])
    .index("by_tenantId_and_closerId", ["tenantId", "closerId"])
    .index(
      "by_tenantId_and_closerId_and_status",
      ["tenantId", "closerId", "status"],
    )
    // v0.5b correctness indexes (F10, F11)
    .index("by_tenantId_and_leadId_and_createdAt", [
      "tenantId",
      "leadId",
      "createdAt",
    ])
    .index(
      "by_tenantId_and_closerId_and_type_and_status_reminderScheduledAt",
      ["tenantId", "closerId", "type", "status", "reminderScheduledAt"],
    )
    // v0.5b analytics indexes (F13)
    .index("by_tenantId_and_status_and_createdAt", [
      "tenantId",
      "status",
      "createdAt",
    ])
    .index("by_opportunityId_and_status", ["opportunityId", "status"]),
```

**Step 5: Add correctness index to `rawWebhookEvents` table**

Locate the `rawWebhookEvents` table index block (currently lines 91-94). Add the new index after the existing ones:

```typescript
// Path: convex/schema.ts (rawWebhookEvents table index chain)

  })
    .index("by_tenantId_and_eventType", ["tenantId", "eventType"])
    .index("by_calendlyEventUri", ["calendlyEventUri"])
    .index("by_processed", ["processed"])
    .index("by_processed_and_receivedAt", ["processed", "receivedAt"])
    // v0.5b correctness index (F9, F11)
    .index("by_tenantId_and_eventType_and_calendlyEventUri", [
      "tenantId",
      "eventType",
      "calendlyEventUri",
    ]),
```

**Step 6: Add analytics indexes to `paymentRecords` table**

Locate the `paymentRecords` table index block (currently lines 476-479). Add the new indexes after the existing ones:

```typescript
// Path: convex/schema.ts (paymentRecords table index chain)

  })
    .index("by_opportunityId", ["opportunityId"])
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_closerId", ["tenantId", "closerId"])
    .index("by_customerId", ["customerId"])
    // v0.5b analytics indexes (F13)
    .index("by_tenantId_and_recordedAt", ["tenantId", "recordedAt"])
    .index("by_tenantId_and_status_and_recordedAt", [
      "tenantId",
      "status",
      "recordedAt",
    ])
    .index("by_customerId_and_recordedAt", ["customerId", "recordedAt"])
    .index("by_tenantId_and_closerId_and_recordedAt", [
      "tenantId",
      "closerId",
      "recordedAt",
    ]),
```

**Step 7: Add analytics index to `leads` table**

Locate the `leads` table index block (currently lines 150-156). Add the new index after the existing `by_tenantId_and_status` index, before the search index:

```typescript
// Path: convex/schema.ts (leads table index chain)

  })
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_email", ["tenantId", "email"])
    .index("by_tenantId_and_status", ["tenantId", "status"])
    // v0.5b analytics index (F13)
    .index("by_tenantId_and_firstSeenAt", ["tenantId", "firstSeenAt"])
    .searchIndex("search_leads", {
      searchField: "searchText",
      filterFields: ["tenantId", "status"],
    }),
```

**Step 8: Add analytics index to `meetingReassignments` table**

Locate the `meetingReassignments` table index block (currently lines 372-376). Add the new index after the existing ones:

```typescript
// Path: convex/schema.ts (meetingReassignments table index chain)

  })
    .index("by_tenantId", ["tenantId"])
    .index("by_meetingId", ["meetingId"])
    .index("by_toCloserId", ["toCloserId"])
    .index("by_fromCloserId", ["fromCloserId"])
    .index("by_unavailabilityId", ["unavailabilityId"])
    // v0.5b analytics index (F13)
    .index("by_tenantId_and_reassignedAt", ["tenantId", "reassignedAt"]),
```

**Step 9: Add user soft-delete index to `users` table**

Locate the `users` table index block (currently lines 78-81). Add the new index after the existing ones:

```typescript
// Path: convex/schema.ts (users table index chain)

  })
    .index("by_tenantId", ["tenantId"])
    .index("by_workosUserId", ["workosUserId"])
    .index("by_tenantId_and_email", ["tenantId", "email"])
    .index("by_tenantId_and_calendlyUserUri", ["tenantId", "calendlyUserUri"])
    // v0.5b user soft-delete index (F8)
    .index("by_tenantId_and_isActive", ["tenantId", "isActive"]),
```

**Key implementation notes:**

- All index names follow the project convention of including all field names: `by_field1_and_field2_and_field3`.
- The 5-field compound index on `followUps` (`by_tenantId_and_closerId_and_type_and_status_reminderScheduledAt`) is the deepest in the codebase. It supports the `getActiveReminders` query which currently post-filters by `type` and `status` after a shallower index scan, producing short/incomplete pages (F10).
- After this step, the index counts per table are:
  - `opportunities`: 4 existing + 5 new = 9 (limit: 32)
  - `meetings`: 3 existing + 5 new = 8 (limit: 32)
  - `customers`: 4 existing + 2 new = 6 (limit: 32)
  - `followUps`: 4 existing + 4 new = 8 (limit: 32)
  - `rawWebhookEvents`: 4 existing + 1 new = 5 (limit: 32)
  - `paymentRecords`: 4 existing + 4 new = 8 (limit: 32)
  - `leads`: 3 existing + 1 new + 1 search = 5 (limit: 32)
  - `meetingReassignments`: 5 existing + 1 new = 6 (limit: 32)
  - `users`: 4 existing + 1 new = 5 (limit: 32)
  - `domainEvents`: 5 new = 5 (new table, defined in 1A)
- All well within Convex's 32-index-per-table limit.
- Convex builds indexes asynchronously after deployment. At ~700 total records across all tables, index backfill is near-instant (sub-second).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add 24 new indexes across 10 tables (8 correctness + 14 analytics + 1 closer dimension + 1 soft-delete) |

---

### 1D --- Deploy, Verify, and Validate

**Type:** DevOps / Verification
**Parallelizable:** No --- depends on 1A, 1B, and 1C all being complete.

**What:** Deploy the schema changes to the Convex development environment, verify all tables and indexes are created, confirm TypeScript compilation passes, and validate that existing functionality is unaffected.

**Why:** The widen-migrate-narrow discipline requires verifying that schema additions deploy cleanly before any behavioral changes. This step confirms the schema is valid, existing data is compatible, and the codebase compiles.

**Where:**
- No file modifications --- this is a verification-only subphase.

**How:**

**Step 1: TypeScript compilation check**

Run the TypeScript compiler to verify the schema changes produce valid types and the rest of the codebase compiles without errors:

```bash
pnpm tsc --noEmit
```

Expected: zero errors. The new tables and fields generate new types in `convex/_generated/dataModel.d.ts`, but since no code references them yet, there should be no type conflicts.

**Step 2: Deploy to development**

Deploy the schema to the Convex development environment:

```bash
npx convex dev
```

Expected: successful schema push with messages confirming:
- 5 new tables created
- 24 new indexes being built
- No schema validation errors (all new fields are optional; all new tables are empty)

**Step 3: Verify in Convex dashboard**

Open the Convex dashboard and confirm:

1. **New tables visible**: `domainEvents`, `tenantStats`, `meetingFormResponses`, `eventTypeFieldCatalog`, `tenantCalendlyConnections` --- all empty, all with correct indexes.
2. **Existing tables**: `users`, `meetings`, `opportunities`, `paymentRecords`, `customers`, `followUps`, `rawWebhookEvents`, `leads`, `meetingReassignments` --- all show new indexes alongside existing ones.
3. **Index status**: All 24 new indexes show "Ready" status (at ~700 records, backfill completes within seconds).

**Step 4: Verify existing functionality**

Run through the critical path to confirm nothing is broken:

1. Admin dashboard loads without errors (reads existing tables with existing indexes)
2. Closer dashboard loads without errors
3. Pipeline still processes webhook events (can verify via Convex function logs)
4. Team page lists users correctly
5. No TypeScript errors in the dev server console

**Step 5: Verify new table schemas via Convex dashboard**

For each new table, click into the table in the dashboard and verify the field definitions match the specification. Pay particular attention to:

- `domainEvents.entityType` union has all 7 literals
- `domainEvents.source` union has all 4 literals
- `tenantStats` has all 11 numeric fields + `lastUpdatedAt`
- `meetingFormResponses` has both optional ID fields (`eventTypeConfigId`, `fieldCatalogId`)
- `tenantCalendlyConnections.connectionStatus` union has all 3 literals

**Key implementation notes:**

- If `npx convex dev` reports a schema validation error, it means an existing document doesn't conform to a modified table's schema. Since all additions are `v.optional()`, this should not happen. If it does, check that no field was accidentally made required.
- If `pnpm tsc --noEmit` reports errors in existing code, they are likely caused by stricter generated types from the new schema. Check the error location --- it will almost certainly be in `convex/_generated/` files that need regeneration (which `npx convex dev` handles).
- The Convex dev server continuously syncs schema changes. If using `npx convex dev` in watch mode (the default), the schema deploys automatically on file save.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| (none) | Verify only | TypeScript compilation, Convex deployment, dashboard verification |

---

## Phase Summary

| File | Action | Subphase | Notes |
|---|---|---|---|
| `convex/schema.ts` | Modify | 1A, 1B, 1C | 5 new tables, ~20 optional fields on 6 tables, 24 new indexes |

---

## Complete Before/After: `convex/schema.ts`

Below is the complete set of changes to `convex/schema.ts`, organized by location in the file. Each block shows the exact current code that will be modified and the replacement.

### users table: new fields + new index

**Current** (lines 53-81):

```typescript
// Path: convex/schema.ts

  users: defineTable({
    tenantId: v.id("tenants"),
    workosUserId: v.string(),
    email: v.string(),
    fullName: v.optional(v.string()),
    role: v.union(
      v.literal("tenant_master"),
      v.literal("tenant_admin"),
      v.literal("closer"),
    ),
    calendlyUserUri: v.optional(v.string()),
    calendlyMemberName: v.optional(v.string()),
    invitationStatus: v.optional(
      v.union(v.literal("pending"), v.literal("accepted")),
    ),
    workosInvitationId: v.optional(v.string()),
    personalEventTypeUri: v.optional(v.string()),
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_workosUserId", ["workosUserId"])
    .index("by_tenantId_and_email", ["tenantId", "email"])
    .index("by_tenantId_and_calendlyUserUri", ["tenantId", "calendlyUserUri"]),
```

**After:**

```typescript
// Path: convex/schema.ts

  users: defineTable({
    tenantId: v.id("tenants"),
    workosUserId: v.string(),
    email: v.string(),
    fullName: v.optional(v.string()),
    role: v.union(
      v.literal("tenant_master"),
      v.literal("tenant_admin"),
      v.literal("closer"),
    ),
    calendlyUserUri: v.optional(v.string()),
    calendlyMemberName: v.optional(v.string()),
    invitationStatus: v.optional(
      v.union(v.literal("pending"), v.literal("accepted")),
    ),
    workosInvitationId: v.optional(v.string()),
    personalEventTypeUri: v.optional(v.string()),

    // === v0.5b: User Soft-Delete (Finding 8) ===
    deletedAt: v.optional(v.number()),
    isActive: v.optional(v.boolean()),
    // === End v0.5b: User Soft-Delete ===
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_workosUserId", ["workosUserId"])
    .index("by_tenantId_and_email", ["tenantId", "email"])
    .index("by_tenantId_and_calendlyUserUri", ["tenantId", "calendlyUserUri"])
    // v0.5b user soft-delete index (F8)
    .index("by_tenantId_and_isActive", ["tenantId", "isActive"]),
```

### rawWebhookEvents table: new index

**Current** (lines 83-94):

```typescript
// Path: convex/schema.ts

  rawWebhookEvents: defineTable({
    tenantId: v.id("tenants"),
    calendlyEventUri: v.string(),
    eventType: v.string(),
    payload: v.string(),
    processed: v.boolean(),
    receivedAt: v.number(),
  })
    .index("by_tenantId_and_eventType", ["tenantId", "eventType"])
    .index("by_calendlyEventUri", ["calendlyEventUri"])
    .index("by_processed", ["processed"])
    .index("by_processed_and_receivedAt", ["processed", "receivedAt"]),
```

**After:**

```typescript
// Path: convex/schema.ts

  rawWebhookEvents: defineTable({
    tenantId: v.id("tenants"),
    calendlyEventUri: v.string(),
    eventType: v.string(),
    payload: v.string(),
    processed: v.boolean(),
    receivedAt: v.number(),
  })
    .index("by_tenantId_and_eventType", ["tenantId", "eventType"])
    .index("by_calendlyEventUri", ["calendlyEventUri"])
    .index("by_processed", ["processed"])
    .index("by_processed_and_receivedAt", ["processed", "receivedAt"])
    // v0.5b correctness index (F9, F11)
    .index("by_tenantId_and_eventType_and_calendlyEventUri", [
      "tenantId",
      "eventType",
      "calendlyEventUri",
    ]),
```

### leads table: new index

**Current** (lines 150-156):

```typescript
// Path: convex/schema.ts

  })
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_email", ["tenantId", "email"])
    .index("by_tenantId_and_status", ["tenantId", "status"])
    .searchIndex("search_leads", {
      searchField: "searchText",
      filterFields: ["tenantId", "status"],
    }),
```

**After:**

```typescript
// Path: convex/schema.ts

  })
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_email", ["tenantId", "email"])
    .index("by_tenantId_and_status", ["tenantId", "status"])
    // v0.5b analytics index (F13)
    .index("by_tenantId_and_firstSeenAt", ["tenantId", "firstSeenAt"])
    .searchIndex("search_leads", {
      searchField: "searchText",
      filterFields: ["tenantId", "status"],
    }),
```

### opportunities table: new fields + new indexes

**Current** (lines 208-253):

```typescript
// Path: convex/schema.ts

  opportunities: defineTable({
    // ... existing fields ...
    potentialDuplicateLeadId: v.optional(v.id("leads")),
    // === End Feature E ===
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_leadId", ["tenantId", "leadId"])
    .index("by_tenantId_and_assignedCloserId", ["tenantId", "assignedCloserId"])
    .index("by_tenantId_and_status", ["tenantId", "status"]),
```

**After:**

```typescript
// Path: convex/schema.ts

  opportunities: defineTable({
    // ... existing fields ...
    potentialDuplicateLeadId: v.optional(v.id("leads")),
    // === End Feature E ===

    // === v0.5b: Lifecycle Timestamps + Attribution (Findings 16, 17) ===
    lostAt: v.optional(v.number()),
    canceledAt: v.optional(v.number()),
    noShowAt: v.optional(v.number()),
    paymentReceivedAt: v.optional(v.number()),
    lostByUserId: v.optional(v.id("users")),
    // === End v0.5b ===
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_leadId", ["tenantId", "leadId"])
    .index("by_tenantId_and_assignedCloserId", ["tenantId", "assignedCloserId"])
    .index("by_tenantId_and_status", ["tenantId", "status"])
    // v0.5b correctness indexes (F5, F10, F11)
    .index("by_tenantId_and_assignedCloserId_and_status", [
      "tenantId",
      "assignedCloserId",
      "status",
    ])
    .index("by_tenantId_and_potentialDuplicateLeadId", [
      "tenantId",
      "potentialDuplicateLeadId",
    ])
    .index("by_tenantId_and_eventTypeConfigId", [
      "tenantId",
      "eventTypeConfigId",
    ])
    // v0.5b analytics indexes (F13)
    .index("by_tenantId_and_createdAt", ["tenantId", "createdAt"])
    .index("by_tenantId_and_status_and_createdAt", [
      "tenantId",
      "status",
      "createdAt",
    ]),
```

### meetings table: new fields + new indexes

**Current** (lines 255-338):

```typescript
// Path: convex/schema.ts

  meetings: defineTable({
    // ... existing fields ...
    rescheduledFromMeetingId: v.optional(v.id("meetings")),
    // === End Feature B: Reschedule Chain ===
  })
    .index("by_opportunityId", ["opportunityId"])
    .index("by_tenantId_and_scheduledAt", ["tenantId", "scheduledAt"])
    .index("by_tenantId_and_calendlyEventUri", ["tenantId", "calendlyEventUri"]),
```

**After:**

```typescript
// Path: convex/schema.ts

  meetings: defineTable({
    // ... existing fields ...
    rescheduledFromMeetingId: v.optional(v.id("meetings")),
    // === End Feature B: Reschedule Chain ===

    // === v0.5b: Closer Dimension + Lifecycle + Attribution (Findings 12, 16, 17) ===
    assignedCloserId: v.optional(v.id("users")),
    completedAt: v.optional(v.number()),
    canceledAt: v.optional(v.number()),
    noShowMarkedByUserId: v.optional(v.id("users")),
    // === End v0.5b ===
  })
    .index("by_opportunityId", ["opportunityId"])
    .index("by_tenantId_and_scheduledAt", ["tenantId", "scheduledAt"])
    .index("by_tenantId_and_calendlyEventUri", ["tenantId", "calendlyEventUri"])
    // v0.5b analytics indexes (F13)
    .index("by_tenantId_and_status_and_scheduledAt", [
      "tenantId",
      "status",
      "scheduledAt",
    ])
    .index("by_tenantId_and_meetingOutcome_and_scheduledAt", [
      "tenantId",
      "meetingOutcome",
      "scheduledAt",
    ])
    .index("by_opportunityId_and_scheduledAt", [
      "opportunityId",
      "scheduledAt",
    ])
    .index("by_tenantId_and_status", ["tenantId", "status"])
    // v0.5b closer dimension index (F12)
    .index("by_tenantId_and_assignedCloserId_and_scheduledAt", [
      "tenantId",
      "assignedCloserId",
      "scheduledAt",
    ]),
```

### meetingReassignments table: new index

**Current** (lines 361-377):

```typescript
// Path: convex/schema.ts

  meetingReassignments: defineTable({
    // ... existing fields ...
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_meetingId", ["meetingId"])
    .index("by_toCloserId", ["toCloserId"])
    .index("by_fromCloserId", ["fromCloserId"])
    .index("by_unavailabilityId", ["unavailabilityId"]),
```

**After:**

```typescript
// Path: convex/schema.ts

  meetingReassignments: defineTable({
    // ... existing fields ...
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_meetingId", ["meetingId"])
    .index("by_toCloserId", ["toCloserId"])
    .index("by_fromCloserId", ["fromCloserId"])
    .index("by_unavailabilityId", ["unavailabilityId"])
    // v0.5b analytics index (F13)
    .index("by_tenantId_and_reassignedAt", ["tenantId", "reassignedAt"]),
```

### customers table: new fields + new indexes

**Current** (lines 422-453):

```typescript
// Path: convex/schema.ts

  customers: defineTable({
    // ... existing fields ...
    createdAt: v.number(),
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_leadId", ["tenantId", "leadId"])
    .index("by_tenantId_and_status", ["tenantId", "status"])
    .index("by_tenantId_and_convertedAt", ["tenantId", "convertedAt"]),
```

**After:**

```typescript
// Path: convex/schema.ts

  customers: defineTable({
    // ... existing fields ...
    createdAt: v.number(),

    // === v0.5b: Denormalized Totals + Lifecycle Timestamps (Findings 4, 16) ===
    totalPaidMinor: v.optional(v.number()),
    totalPaymentCount: v.optional(v.number()),
    paymentCurrency: v.optional(v.string()),
    churnedAt: v.optional(v.number()),
    pausedAt: v.optional(v.number()),
    // === End v0.5b ===
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_leadId", ["tenantId", "leadId"])
    .index("by_tenantId_and_status", ["tenantId", "status"])
    .index("by_tenantId_and_convertedAt", ["tenantId", "convertedAt"])
    // v0.5b correctness indexes (F10)
    .index("by_tenantId_and_convertedByUserId", [
      "tenantId",
      "convertedByUserId",
    ])
    .index("by_tenantId_and_convertedByUserId_and_status", [
      "tenantId",
      "convertedByUserId",
      "status",
    ]),
```

### paymentRecords table: new fields + new indexes

**Current** (lines 456-479):

```typescript
// Path: convex/schema.ts

  paymentRecords: defineTable({
    // ... existing fields ...
    customerId: v.optional(v.id("customers")),
    // === End Feature D ===
  })
    .index("by_opportunityId", ["opportunityId"])
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_closerId", ["tenantId", "closerId"])
    .index("by_customerId", ["customerId"]),
```

**After:**

```typescript
// Path: convex/schema.ts

  paymentRecords: defineTable({
    // ... existing fields ...
    customerId: v.optional(v.id("customers")),
    // === End Feature D ===

    // === v0.5b: Money Model + Lifecycle + Attribution + Context (Findings 3, 16, 17, 18) ===
    amountMinor: v.optional(v.number()),
    verifiedAt: v.optional(v.number()),
    statusChangedAt: v.optional(v.number()),
    verifiedByUserId: v.optional(v.id("users")),
    contextType: v.optional(
      v.union(v.literal("opportunity"), v.literal("customer")),
    ),
    // === End v0.5b ===
  })
    .index("by_opportunityId", ["opportunityId"])
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_closerId", ["tenantId", "closerId"])
    .index("by_customerId", ["customerId"])
    // v0.5b analytics indexes (F13)
    .index("by_tenantId_and_recordedAt", ["tenantId", "recordedAt"])
    .index("by_tenantId_and_status_and_recordedAt", [
      "tenantId",
      "status",
      "recordedAt",
    ])
    .index("by_customerId_and_recordedAt", ["customerId", "recordedAt"])
    .index("by_tenantId_and_closerId_and_recordedAt", [
      "tenantId",
      "closerId",
      "recordedAt",
    ]),
```

### followUps table: new field + new indexes

**Current** (lines 481-521):

```typescript
// Path: convex/schema.ts

  followUps: defineTable({
    // ... existing fields ...
    createdAt: v.number(),
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_opportunityId", ["opportunityId"])
    .index("by_tenantId_and_closerId", ["tenantId", "closerId"])
    .index(
      "by_tenantId_and_closerId_and_status",
      ["tenantId", "closerId", "status"],
    ),
```

**After:**

```typescript
// Path: convex/schema.ts

  followUps: defineTable({
    // ... existing fields ...
    createdAt: v.number(),

    // === v0.5b: Lifecycle Timestamp (Finding 16) ===
    bookedAt: v.optional(v.number()),
    // === End v0.5b ===
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_opportunityId", ["opportunityId"])
    .index("by_tenantId_and_closerId", ["tenantId", "closerId"])
    .index(
      "by_tenantId_and_closerId_and_status",
      ["tenantId", "closerId", "status"],
    )
    // v0.5b correctness indexes (F10, F11)
    .index("by_tenantId_and_leadId_and_createdAt", [
      "tenantId",
      "leadId",
      "createdAt",
    ])
    .index(
      "by_tenantId_and_closerId_and_type_and_status_reminderScheduledAt",
      ["tenantId", "closerId", "type", "status", "reminderScheduledAt"],
    )
    // v0.5b analytics indexes (F13)
    .index("by_tenantId_and_status_and_createdAt", [
      "tenantId",
      "status",
      "createdAt",
    ])
    .index("by_opportunityId_and_status", ["opportunityId", "status"]),
```

### New tables (added at end of schema, before closing `});`)

After the `followUps` table and before the schema closing, add all 5 new tables as shown in subphase 1A (Steps 1-5 above).

---

## Notes for Implementer

- **Non-breaking deployment:** Every change in this phase is purely additive. Optional fields on existing tables, empty new tables, and new indexes on existing data. Zero risk to production functionality.
- **Single file, single deploy:** All subphases modify `convex/schema.ts`. The implementer should apply all changes (1A + 1B + 1C) in a single editing session and deploy once. The subphase separation is for understanding and review, not for separate deployments.
- **Index backfill time:** At ~700 total records across all tables, Convex builds all 24 indexes in under a second. For larger tenants in the future, index backfill runs asynchronously and does not block queries.
- **New table naming:** `tenantCalendlyConnections` uses slightly different field names than the current `tenants` OAuth fields (e.g., `calendlyOrganizationUri` vs `calendlyOrgUri`). This is intentional --- Phase 5 handles the mapping.
- **Phase 2 readiness:** Once this phase deploys successfully, Phase 2 (backfill) and Phase 5 (OAuth extraction) can begin immediately. Phase 2 populates the new optional fields; Phase 5 populates `tenantCalendlyConnections`.
- **Commit message suggestion:** `Add v0.5b Phase 1 schema widen: 5 new tables, 20 optional fields, 24 indexes`
