# Phase 1 — Schema Foundation

**Goal:** Establish the multi-identifier lead model by creating the `leadIdentifiers` table and adding optional fields to `leads` and `opportunities` for tracking lead status, merges, and potential duplicates. All fields are optional (non-breaking deployment), enabling parallel work on normalization and pipeline logic.

**Prerequisite:** Features F (Event Type Field Mappings) and G (UTM Tracking) deployed; existing Convex schema accessible.

**Runs in PARALLEL with:** Phase 2 (Normalization Utilities) — zero shared files.

**Skills to invoke:**
- `convex-migration-helper` — for post-deploy backfill of `leads.status` to `"active"` (deferred, not blocking Phase 1 deployment)

**Acceptance Criteria:**

1. New `leadIdentifiers` table exists with all fields (`tenantId`, `leadId`, `type`, `value`, `rawValue`, `source`, `sourceMeetingId`, `confidence`, `createdAt`) and indexes (`by_tenantId_and_type_and_value`, `by_leadId`, `by_tenantId_and_value`).
2. `leads` table has optional `status` field (union of `"active"`, `"converted"`, `"merged"`), `mergedIntoLeadId` optional reference, and `socialHandles` optional array.
3. `opportunities` table has optional `potentialDuplicateLeadId` field.
4. Schema deployment via `npx convex deploy` completes without errors.
5. Convex dashboard shows all three tables with their indexes visible.
6. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (Schema Modification)
    ↓
1B (Post-Deploy Migration Plan)
```

**Optimal execution:**

1. Start 1A and complete schema modifications.
2. Deploy schema changes (`npx convex deploy`).
3. After deployment, execute post-deploy migration (1B) to backfill existing leads.

**Estimated time:** 1-2 hours (1A = 30 min, 1B = 30-60 min post-deployment)

---

## Subphases

### 1A — Schema Modification & Validation

**Type:** Backend
**Parallelizable:** No — this is a blocking phase. All subsequent phases depend on the schema being deployed.

**What:** Modify `convex/schema.ts` to add the `leadIdentifiers` table and extend `leads` and `opportunities` tables with new optional fields, then validate the schema and ensure it deploys cleanly.

**Why:** The multi-identifier model requires a separate, indexed table to avoid unbounded document growth and enable efficient identity resolution queries. Optional fields on existing tables support backward compatibility with pre-Feature-E data while allowing new data to flow through the pipeline.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Add the new `leadIdentifiers` table**

```typescript
// Path: convex/schema.ts

// Add this new table definition to the schema alongside existing tables:
leadIdentifiers: defineTable({
  tenantId: v.id("tenants"),
  leadId: v.id("leads"),
  type: v.union(
    v.literal("email"),
    v.literal("phone"),
    v.literal("instagram"),
    v.literal("tiktok"),
    v.literal("twitter"),
    v.literal("facebook"),
    v.literal("linkedin"),
    v.literal("other_social"),
  ),
  value: v.string(),           // Normalized: lowercased, trimmed, @ stripped, E.164 for phone
  rawValue: v.string(),        // Original value as received from the source
  source: v.union(
    v.literal("calendly_booking"),  // Extracted from a Calendly webhook payload
    v.literal("manual_entry"),      // Manually entered by a CRM user (Feature C)
    v.literal("merge"),             // Created during a lead merge operation (Feature C)
  ),
  sourceMeetingId: v.optional(v.id("meetings")),  // Which meeting provided this identifier
  confidence: v.union(
    v.literal("verified"),     // Direct input by the lead (email from Calendly, phone from Calendly)
    v.literal("inferred"),     // Extracted from a form field via customFieldMappings
    v.literal("suggested"),    // Heuristic/AI suggestion, unconfirmed
  ),
  createdAt: v.number(),       // Unix ms, for sorting and auditing
})
  .index("by_tenantId_and_type_and_value", ["tenantId", "type", "value"])
  .index("by_leadId", ["leadId"])
  .index("by_tenantId_and_value", ["tenantId", "value"]),
```

**Step 2: Extend the `leads` table with optional Feature E fields**

Locate the existing `leads: defineTable({ ... })` in `schema.ts` and add these fields **after** existing fields:

```typescript
// Path: convex/schema.ts (within the leads table definition)

// Add these fields to the leads table (shown as additions):
leads: defineTable({
  // ... existing fields (tenantId, email, fullName, phone, customFields, firstSeenAt, updatedAt) ...

  // NEW (Feature E): Lead lifecycle status for merge and conversion tracking.
  // "active" = normal operating state (default for all existing + new leads).
  // "merged" = this lead was merged into another lead; mergedIntoLeadId points to the target.
  // "converted" = lead became a customer (Feature D).
  status: v.optional(v.union(
    v.literal("active"),
    v.literal("converted"),
    v.literal("merged"),
  )),

  // NEW (Feature E): When status === "merged", points to the lead this was merged into.
  // Undefined for active and converted leads.
  mergedIntoLeadId: v.optional(v.id("leads")),

  // NEW (Feature E): Denormalized social handles for display in lead info panels.
  // Updated when leadIdentifier records change. Array of { type, handle } pairs.
  socialHandles: v.optional(v.array(v.object({
    type: v.string(),
    handle: v.string(),
  }))),
})
// ... keep existing indexes ...
```

**Step 3: Extend the `opportunities` table with Feature E field**

Locate the existing `opportunities: defineTable({ ... })` and add:

```typescript
// Path: convex/schema.ts (within the opportunities table definition)

opportunities: defineTable({
  // ... existing fields ...

  // NEW (Feature E): When the pipeline detects a fuzzy match during identity resolution,
  // it creates a new lead but stores the ID of the suspected duplicate lead here.
  // Surfaces as a banner on the meeting detail page: "This lead might be the same as [Name]."
  // Cleared when a merge is performed (Feature C) or manually dismissed.
  potentialDuplicateLeadId: v.optional(v.id("leads")),
})
// ... keep existing indexes ...
```

**Step 4: Validate and deploy schema**

```bash
# Verify the schema syntax is correct
npx convex dev

# The dev server will validate schema changes and report errors if any.
# Once validation passes, you can deploy:
npx convex deploy
```

Check the Convex dashboard to confirm:
- `leadIdentifiers` table is visible with 3 indexes
- `leads` table shows the new optional fields
- `opportunities` table shows the new optional field

**Key implementation notes:**

- All new fields on `leads` and `opportunities` are `v.optional()` to maintain backward compatibility. Existing documents will not have these fields, but queries and mutations can safely treat them as undefined.
- The `value` field in `leadIdentifiers` stores normalized values (lowercase email, E.164 phone, stripped social handles). This is the primary lookup key in the `by_tenantId_and_type_and_value` index.
- The `rawValue` field preserves the original input for audit/logging purposes. Do not use for identity resolution lookups.
- Index naming follows convention: `by_<field1>_and_<field2>`. The three indexes are chosen to support: (1) exact multi-type lookup during pipeline identity resolution, (2) all identifiers for a lead (used in Detail pages), (3) cross-type search for Lead Manager dedup.
- `sourceMeetingId` being optional accommodates future manual entry (Feature C) where no meeting is associated.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add `leadIdentifiers` table; extend `leads` and `opportunities` with optional fields |

---

### 1B — Post-Deploy Migration (Optional, Non-Blocking)

**Type:** Backend / Migration
**Parallelizable:** No — must run after schema deployment, but does not block Phase 2, 3, or 4. Can run in parallel with Phase 2 and 3 work.

**What:** Create a migration plan for backfilling `leads.status = "active"` on all existing leads in the database. This is deferred to after Phase 1 deployment to allow non-breaking schema changes to ship first.

**Why:** Making `status` optional avoids a mandatory backfill before deployment. Once the schema is live, a post-deployment migration backfills all existing leads. Until that migration runs, queries and code treat `undefined` status as equivalent to `"active"` (the default).

**Where:**
- Migration script (separate concern, deferred)

**How:**

**Step 1: Plan the migration**

This is an informational step documenting the migration approach. The actual execution is deferred to a post-deploy window (typically 1-3 days after Phase 1 ships).

Migration strategy:
- Use `convex-migration-helper` skill to design a safe widen-migrate-narrow migration.
- Widen: Add `status` field as optional (already done in Phase 1A).
- Migrate: Iterate over all documents in the `leads` table in batches (e.g., 100 at a time), set `status: "active"` on each.
- Narrow: No narrowing step needed; the field remains optional and `"active"` is the permanent default for legacy leads.

**Step 2: Defer execution**

Document that this migration will be executed post-Phase 1 deployment, using the `convex-migration-helper` skill at that time. For now, the schema is live and backward-compatible.

**Key implementation notes:**

- During Phase 2, 3, and 4 implementation, all code that reads `leads.status` should treat `undefined` as equivalent to `"active"`. E.g., `lead.status ?? "active" === "active"`.
- The backfill can run asynchronously; it does not block any user-facing feature.
- If the post-deploy migration is delayed or missed, the system continues to function correctly; queries will just return `undefined` for the status field until explicitly set.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| _(Migration deferred)_ | Plan | Document approach for post-deploy backfill using `convex-migration-helper` |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modify | 1A |

---

## Notes for Implementer

- **Non-breaking deployment:** All schema changes are optional fields, so deployment is safe even if production data exists. No downtime or data migration required before deployment.
- **Backward compatibility:** Code in Phases 2, 3, and 4 should handle `status: undefined` as equivalent to `"active"`. TypeScript will flag this; use the nullish coalescing operator (`??`) to provide the default.
- **Index naming convention:** Always include all fields in the index name. E.g., `by_tenantId_and_type_and_value` includes all three fields.
- **Next phase:** After Phase 1A deploys successfully, Phase 2 (Normalization Utilities) can begin in parallel. Phase 1B (migration) is independent and can be scheduled separately.
