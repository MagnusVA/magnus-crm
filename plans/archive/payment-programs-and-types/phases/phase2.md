# Phase 2 — Payment / Customer / Stats Schema Rewrite (Destructive)

**Goal:** Rewrite `paymentRecords` (drop `closerId` / `provider` / `loggedByAdminUserId`; add `attributedCloserId`, `recordedByUserId`, `commissionable`, `originatingOpportunityId`, `programId`, `programName`, `paymentType`; expand the `origin` union; add 4 new indexes), reshape `customers` (drop freeform `programType`; add required `programId` + `programName`), widen `tenantStats` additively with four split counters, re-key the `paymentSums` aggregate to `[attributedCloserId, recordedAt]`, and update the `writeHooks` / operational tooling so the new semantics are enforced from the first deploy. Because every environment has zero rows in `paymentRecords` and `customers`, this ships as a single destructive schema push — no widen/migrate/narrow.

**Prerequisite:**
- **Pre-flight verification (blocking):** `paymentRecords` count === 0 and `customers` count === 0 in every environment (dev / preview / prod). `npx convex data --prod paymentRecords --limit 1` must return an empty array. Abort if non-zero.
- Phase 1's `tenantPrograms` table is either already live OR lands in the same deploy (the `tenantPrograms` `Id` is required by the `paymentRecords.programId` field). The phases run in parallel; this phase's merge into `convex/schema.ts` must be coordinated with Phase 1A.
- `convex/reporting/writeHooks.ts::insertPaymentAggregate` and `replacePaymentAggregate` exist in their current form (they do).
- `convex/reporting/aggregates.ts::paymentSums` exists with `Namespace: Id<"tenants">` + `sortKey: [closerId, recordedAt]` (it does).
- `convex/lib/tenantStatsHelper.ts::updateTenantStats` already handles `undefined → number` delta transitions additively (it does; the 4 new fields are optional and initialize to undefined → first write becomes `+amount`).

**Runs in PARALLEL with:** Phase 1 (Programs Registry Backend). Different tables / different files — coordinated only at `convex/schema.ts` merge. No file-level conflict because Phase 1 adds a NEW table block and Phase 2 modifies EXISTING blocks.

> **Critical path:** This phase is on the critical path (Phase 2 → Phase 3 → Phase 4 → Phase 5 → all frontend phases). Every payment write path and every reporting helper consumes the new shape; nothing compiles until this lands. Start as early as possible in parallel with Phase 1.

**Skills to invoke:**
- `convex-migration-helper` — confirm the "destructive on empty tables" decision is the correct choice; the skill reference will help document the pre-flight verification steps.
- `convex-performance-audit` — audit the new indexes to confirm they replace (not duplicate) the old closerId indexes; verify `by_tenantId_and_commissionable_and_recordedAt` doesn't explode cardinality (it has only two values — `true` / `false` — so the secondary sort by `recordedAt` stays sharded).

**Acceptance Criteria:**
1. `paymentRecords` has the new shape in `convex/schema.ts`: `closerId`, `provider`, `loggedByAdminUserId` are removed; `attributedCloserId` (optional), `recordedByUserId` (required), `commissionable` (required), `originatingOpportunityId` (optional), `programId` (required), `programName` (required), `paymentType` (required union of 4 literals) are added; `origin` is required and expanded to 7 literals.
2. `paymentRecords` has exactly these indexes: `by_opportunityId`, `by_originatingOpportunityId`, `by_tenantId`, `by_customerId`, `by_customerId_and_recordedAt`, `by_tenantId_and_recordedAt`, `by_tenantId_and_status_and_recordedAt`, `by_tenantId_and_attributedCloserId_and_recordedAt`, `by_tenantId_and_commissionable_and_recordedAt`, `by_tenantId_and_origin_and_recordedAt`, `by_tenantId_and_programId_and_recordedAt`, `by_tenantId_and_paymentType_and_recordedAt`. The legacy `by_tenantId_and_closerId` and `by_tenantId_and_closerId_and_recordedAt` are removed.
3. `customers` has `programId: v.id("tenantPrograms")` (required), `programName: v.string()` (required), a new index `by_tenantId_and_programId`, and no `programType` field.
4. `tenantStats` gains four optional fields: `totalCommissionableFinalRevenueMinor`, `totalCommissionableDepositRevenueMinor`, `totalNonCommissionableFinalRevenueMinor`, `totalNonCommissionableDepositRevenueMinor`. `totalRevenueMinor` stays required. All existing rows keep their current `totalRevenueMinor` value; the new counters default to `undefined` until the first write.
5. `paymentSums` aggregate is re-keyed to `sortKey: (doc) => [doc.attributedCloserId!, doc.recordedAt]` with unchanged `Namespace: Id<"tenants">` and `sumValue` (disputed → 0).
6. `convex/reporting/writeHooks.ts::insertPaymentAggregate` early-returns for non-commissionable rows (does NOT call `paymentSums.insert`).
7. `convex/reporting/writeHooks.ts::replacePaymentAggregate` correctly handles commissionable → non-commissionable transitions (removes old aggregate entry), non-commissionable → commissionable transitions (inserts), and commissionable → commissionable transitions (replace).
8. `convex/tenantPrograms/sync.ts::syncRenamedProgram` is updated with the now-live body (paginated patches over `paymentRecords.programName` and `customers.programName`) — no longer a no-op.
9. Operational tooling (`convex/reporting/backfill.ts`, `convex/reporting/verification.ts`, `convex/admin/migrations.ts`) no longer references `paymentRecords.closerId`, `paymentRecords.provider`, `paymentRecords.loggedByAdminUserId`, or `customers.programType`.
10. `npx convex dev` deploys the new schema without errors on an empty database. Re-running it is idempotent.
11. `pnpm tsc --noEmit` passes without errors. All call sites that previously referenced dropped fields are fixed in this phase or the phase that rewrites them (Phase 3 / Phase 5).
12. A grep sweep confirms: `grep -R "paymentRecords.closerId" convex/ app/` returns zero matches; same for `.provider`, `.loggedByAdminUserId`, and `customers.programType`.

---

## Subphase Dependency Graph

```
2A (paymentRecords schema rewrite) ─────────┐
                                            │
2B (customers schema reshape) ──────────────┤── Schema deploy (npx convex dev) ─┐
                                            │                                   │
2C (tenantStats additive counters) ─────────┘                                   │
                                                                                │
                                             ┌──────────────────────────────────┤
                                             │                                  │
                     ┌───────────────────────┤                                  │
                     │                       │                                  │
                     ├── 2D (paymentSums aggregate re-keying + writeHooks)     │
                     │                                                          │
                     ├── 2E (tenantPrograms/sync.ts body — now live)           │
                     │                                                          │
                     └── 2F (operational tooling — backfill/verification/       │
                              admin/migrations field rename)                    │
                                                                                ▼
                                                                           Phase 3
```

**Optimal execution:**
1. **Start 2A, 2B, 2C in parallel.** They all modify different table definitions in the same file (`convex/schema.ts`); editors can stage their changes in the same commit. One engineer can do them sequentially in ~30 min.
2. Deploy the schema with `npx convex dev` to generate the new dataModel types. All downstream edits need the new `Id<"tenantPrograms">` + `paymentRecords.attributedCloserId?` types.
3. **Start 2D, 2E, 2F in parallel** — they touch different files and have no cross-dependencies.

**Estimated time:** 1 day (solo), 0.5 day with 2 parallel streams after the schema deploys.

---

## Subphases

### 2A — `paymentRecords` Schema Rewrite

**Type:** Backend
**Parallelizable:** Yes — co-located with 2B, 2C in `convex/schema.ts`; edits are to DIFFERENT table blocks so there's no textual merge conflict.

**What:** Replace the `paymentRecords` table definition with the new shape: drop `closerId`, `provider`, `loggedByAdminUserId`; add `attributedCloserId`, `recordedByUserId`, `commissionable`, `originatingOpportunityId`, `programId`, `programName`, `paymentType`; expand `origin` from 4 literals to 7 and make it required; keep `referenceCode`, `meetingId`, `opportunityId`, `customerId`, `contextType` unchanged. Replace the index set accordingly.

**Why:** This is the foundation of every downstream change. Reporting helpers read `commissionable` + `attributedCloserId` directly (Phase 5); write helpers assert invariants on these fields (Phase 3); payment dialogs submit `programId` + `paymentType` (Phase 7). Without the schema change, nothing in the new architecture typechecks.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Replace the `paymentRecords` table block**

Open `convex/schema.ts`, find the current `paymentRecords: defineTable({ ... })` block, and replace it wholesale with the new definition.

**Before (current shape):**

```typescript
// Path: convex/schema.ts (BEFORE)
paymentRecords: defineTable({
  tenantId: v.id("tenants"),
  opportunityId: v.optional(v.id("opportunities")),
  meetingId: v.optional(v.id("meetings")),
  closerId: v.id("users"),
  amountMinor: v.number(),
  currency: v.string(),
  provider: v.string(),
  referenceCode: v.optional(v.string()),
  proofFileId: v.optional(v.id("_storage")),
  status: v.union(
    v.literal("recorded"),
    v.literal("verified"),
    v.literal("disputed"),
  ),
  verifiedAt: v.optional(v.number()),
  verifiedByUserId: v.optional(v.id("users")),
  statusChangedAt: v.optional(v.number()),
  recordedAt: v.number(),
  customerId: v.optional(v.id("customers")),
  contextType: v.union(v.literal("opportunity"), v.literal("customer")),
  origin: v.optional(v.union(
    v.literal("closer_meeting"),
    v.literal("closer_reminder"),
    v.literal("admin_meeting"),
    v.literal("customer_flow"),
  )),
  loggedByAdminUserId: v.optional(v.id("users")),
})
  .index("by_opportunityId", ["opportunityId"])
  .index("by_tenantId", ["tenantId"])
  .index("by_tenantId_and_closerId", ["tenantId", "closerId"])
  .index("by_customerId", ["customerId"])
  .index("by_tenantId_and_recordedAt", ["tenantId", "recordedAt"])
  .index("by_tenantId_and_status_and_recordedAt",
    ["tenantId", "status", "recordedAt"])
  .index("by_customerId_and_recordedAt", ["customerId", "recordedAt"])
  .index("by_tenantId_and_closerId_and_recordedAt",
    ["tenantId", "closerId", "recordedAt"])
  .index("by_tenantId_and_origin_and_recordedAt",
    ["tenantId", "origin", "recordedAt"]),
```

**After:**

```typescript
// Path: convex/schema.ts (AFTER)
paymentRecords: defineTable({
  tenantId: v.id("tenants"),

  // === Context links ===
  opportunityId: v.optional(v.id("opportunities")),
  meetingId: v.optional(v.id("meetings")),
  customerId: v.optional(v.id("customers")),
  // NEW — audit pointer from a non-commissionable payment back to the
  // opportunity on which the customer was originally won. Set only for
  // customer_direct / bookkeeper_direct origins; undefined for commissionable
  // rows (they carry opportunityId on the same link).
  originatingOpportunityId: v.optional(v.id("opportunities")),

  // === Attribution ===
  // Commission recipient. Set IFF commissionable === true.
  // Invariant enforced by `assertPaymentRow` in Phase 3.
  attributedCloserId: v.optional(v.id("users")),
  // Who clicked "Log payment". Always set (closer self, admin on behalf, or
  // future bookkeeper).
  recordedByUserId: v.id("users"),
  // Explicit flag; reporting helpers read this instead of deriving from origin.
  commissionable: v.boolean(),

  // === Money ===
  amountMinor: v.number(),
  currency: v.string(),
  // NEW — program foreign key + denormalized name cache.
  programId: v.id("tenantPrograms"),
  programName: v.string(),
  // NEW — business intent of the payment. Distinct from `status` which is
  // the processing state.
  paymentType: v.union(
    v.literal("monthly"),
    v.literal("split"),
    v.literal("pif"),
    v.literal("deposit"),
  ),

  // === Provenance ===
  origin: v.union(
    v.literal("closer_meeting"),
    v.literal("closer_reminder"),
    v.literal("admin_meeting"),
    v.literal("admin_reminder"),           // NEW
    v.literal("admin_review_resolution"),  // NEW
    v.literal("customer_direct"),          // RENAMED (was customer_flow)
    v.literal("bookkeeper_direct"),        // RESERVED for future role
  ),
  contextType: v.union(v.literal("opportunity"), v.literal("customer")),

  // === Status & audit ===
  status: v.union(
    v.literal("recorded"),
    v.literal("verified"),
    v.literal("disputed"),
  ),
  verifiedAt: v.optional(v.number()),
  verifiedByUserId: v.optional(v.id("users")),
  statusChangedAt: v.optional(v.number()),
  recordedAt: v.number(),

  // === Retained ===
  referenceCode: v.optional(v.string()),
  proofFileId: v.optional(v.id("_storage")),

  // REMOVED: closerId, provider, loggedByAdminUserId
})
  .index("by_opportunityId", ["opportunityId"])
  // NEW — tenant-agnostic lookup for "all post-conversion payments
  // traceable to this opportunity". Expected cardinality < 20 per opp.
  .index("by_originatingOpportunityId", ["originatingOpportunityId"])
  .index("by_tenantId", ["tenantId"])
  .index("by_customerId", ["customerId"])
  .index("by_customerId_and_recordedAt", ["customerId", "recordedAt"])
  .index("by_tenantId_and_recordedAt", ["tenantId", "recordedAt"])
  .index("by_tenantId_and_status_and_recordedAt",
    ["tenantId", "status", "recordedAt"])
  // NEW — per-closer commissionable scan; non-commissionable rows have
  // attributedCloserId === undefined and are excluded by range match.
  .index("by_tenantId_and_attributedCloserId_and_recordedAt",
    ["tenantId", "attributedCloserId", "recordedAt"])
  // NEW — top-level commissionable/non-commissionable split for the
  // Revenue report's four-card KPI.
  .index("by_tenantId_and_commissionable_and_recordedAt",
    ["tenantId", "commissionable", "recordedAt"])
  // KEPT (name unchanged, values expanded) — remindersReporting uses this.
  .index("by_tenantId_and_origin_and_recordedAt",
    ["tenantId", "origin", "recordedAt"])
  // NEW — Program filter on Revenue report.
  .index("by_tenantId_and_programId_and_recordedAt",
    ["tenantId", "programId", "recordedAt"])
  // NEW — Payment Type filter on Revenue report.
  .index("by_tenantId_and_paymentType_and_recordedAt",
    ["tenantId", "paymentType", "recordedAt"]),
  // REMOVED: by_tenantId_and_closerId, by_tenantId_and_closerId_and_recordedAt
```

**Step 2: Remove all old index references at once**

Grep the codebase for `"by_tenantId_and_closerId"` usages (there are call sites in `convex/reporting/revenue.ts`, `convex/reporting/teamPerformance.ts`, etc.). Phase 5 rewrites those; Phase 2 only confirms that removing them doesn't leave stray references after the schema deploys.

**Step 3: Push the schema**

```bash
# Pre-flight: confirm zero rows (per design §18.1)
npx convex run admin:data:count '{ "table": "paymentRecords" }'  # → 0
npx convex run admin:data:count '{ "table": "customers" }'       # → 0

# Push the schema
npx convex dev
```

Verify in the Convex dashboard:
- `paymentRecords` now shows the new columns in the schema viewer.
- The old indexes `by_tenantId_and_closerId` and `by_tenantId_and_closerId_and_recordedAt` are gone.
- The three new NEW indexes (`by_originatingOpportunityId`, `by_tenantId_and_attributedCloserId_and_recordedAt`, `by_tenantId_and_commissionable_and_recordedAt`, `by_tenantId_and_programId_and_recordedAt`, `by_tenantId_and_paymentType_and_recordedAt`) are present.

**Key implementation notes:**
- **Destructive on empty tables only.** The design (§5.1) explicitly states this is safe because `paymentRecords` count is zero. The pre-flight check is non-negotiable.
- `closerId → attributedCloserId` is a RENAME in spirit but a DROP + ADD in schema terms. Since there are no rows, this is equivalent.
- `origin` goes from `v.optional(v.union(...))` to required `v.union(...)` with 7 literals. Again, empty table means zero migration work.
- The new `by_originatingOpportunityId` index is single-column (no tenant prefix) because the cardinality is low (< 20 post-conv payments per opp). If we scale past that we'll add `by_tenantId_and_originatingOpportunityId`; see Open Question #11.
- `by_tenantId_and_commissionable_and_recordedAt` may look oversized (commissionable is binary), but the second key enables efficient "give me all commissionable payments since X" scans and the third key inherits the 2,500-row bound from `getNonDisputedPaymentsInRange`.
- Do NOT add `by_tenantId_and_attributedCloserId` (without the `_recordedAt` suffix). Every consumer that filters by closer also filters by time range; the two-key variant has no consumer and just duplicates storage.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Replace `paymentRecords` block; drop 2 legacy indexes, add 5 new indexes. |

---

### 2B — `customers` Schema Reshape

**Type:** Backend
**Parallelizable:** Yes — co-located with 2A, 2C in `convex/schema.ts`; edits are to DIFFERENT table blocks.

**What:** Replace `customers.programType: v.optional(v.string())` with required `programId: v.id("tenantPrograms")` and denormalized `programName: v.string()`. Add a new `by_tenantId_and_programId` index.

**Why:** The freeform string is inconsistent (sometimes filled from `eventTypeConfig.displayName`, sometimes empty) and uncallable in filter queries. The foreign key pins each customer to a canonical program from the first deploy, and `programName` is kept as a display cache with rename-sync (Phase 1D / 2E).

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Update the `customers` block**

Find the `customers: defineTable({ ... })` block and replace the `programType` line with two new lines (`programId` + `programName`). Add the new index.

**Before:**

```typescript
// Path: convex/schema.ts (BEFORE — only the programType line + indexes shown)
customers: defineTable({
  // ... all other fields unchanged ...
  programType: v.optional(v.string()),
  // ... other fields ...
})
  // ... existing indexes (by_tenantId, by_tenantId_and_leadId, by_tenantId_and_status,
  //     by_tenantId_and_convertedAt, by_tenantId_and_convertedByUserId,
  //     by_tenantId_and_convertedByUserId_and_status) ...
```

**After:**

```typescript
// Path: convex/schema.ts (AFTER — only the changed lines shown)
customers: defineTable({
  // ... all other fields unchanged ...

  // REMOVED: programType: v.optional(v.string()),

  // NEW — canonical foreign key to the tenantPrograms registry.
  // Required from the first deploy (empty table, no backfill needed).
  programId: v.id("tenantPrograms"),
  // NEW — denormalized display cache; kept in sync by
  // internal.tenantPrograms.sync.syncRenamedProgram when the program is renamed.
  programName: v.string(),

  // ... other fields ...
})
  // ... existing indexes ...
  // NEW — enables "list all customers on program X" for reports and
  // admin review of program rollups.
  .index("by_tenantId_and_programId", ["tenantId", "programId"]),
```

**Step 2: Verify after `npx convex dev`**

- The Convex dashboard shows `customers.programId` and `customers.programName` as columns.
- The new `by_tenantId_and_programId` index appears.
- `customers.programType` is gone.
- Row count is still zero.

**Key implementation notes:**
- **Destructive only because the table is empty.** If a customer row existed, this deploy would fail schema validation — the pre-flight check catches that.
- `programName` is a **denormalized display cache**, not an immutable snapshot. Rename-sync keeps it consistent (§8.6 of the design). A reader who hits a stale `programName` is degraded but not broken — the `programId` is still authoritative.
- Do NOT overload `programId` with "post-conversion program" semantics — `customers.programId` stays pinned to the conversion-winning program forever. Post-conversion payments may reference a different `paymentRecords.programId` (for upsells), but the customer row doesn't change (§8.5 of the design).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Replace `customers.programType` with `programId` + `programName`; add `by_tenantId_and_programId` index. |

---

### 2C — `tenantStats` Additive Widening

**Type:** Backend
**Parallelizable:** Yes — co-located with 2A, 2B in `convex/schema.ts`; different block.

**What:** Add four optional number fields to `tenantStats`: `totalCommissionableFinalRevenueMinor`, `totalCommissionableDepositRevenueMinor`, `totalNonCommissionableFinalRevenueMinor`, `totalNonCommissionableDepositRevenueMinor`. Keep `totalRevenueMinor` required (used by legacy dashboard paths for rollout compat; removed in a follow-up deploy once all consumers switch).

**Why:** Every revenue-bearing KPI now splits along two axes (commissionable × final/deposit). Rather than deriving the split from scratch on every dashboard read, we maintain four incremental counters and update them atomically on each payment write (Phase 3, `applyPaymentStatsDelta`). All-time totals become O(1) reads.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Update the `tenantStats` block**

```typescript
// Path: convex/schema.ts (only added fields shown)
tenantStats: defineTable({
  tenantId: v.id("tenants"),
  totalTeamMembers: v.number(),
  totalClosers: v.number(),
  totalOpportunities: v.number(),
  activeOpportunities: v.number(),
  wonDeals: v.number(),
  lostDeals: v.number(),

  // KEPT for rollout compat. Callers that want split semantics should
  // read one of the 4 new fields instead. Removed in a later deploy.
  totalRevenueMinor: v.number(),

  totalPaymentRecords: v.number(),
  totalLeads: v.number(),
  totalCustomers: v.number(),
  lastUpdatedAt: v.number(),

  // NEW — 4-way split counters used by all-time dashboard KPIs.
  // Optional so existing tenantStats rows don't fail schema validation;
  // `applyPaymentStatsDelta` initializes them lazily via `updateTenantStats`,
  // which already handles undefined→number delta transitions (+delta = delta
  // when the current value is undefined).
  totalCommissionableFinalRevenueMinor: v.optional(v.number()),
  totalCommissionableDepositRevenueMinor: v.optional(v.number()),
  totalNonCommissionableFinalRevenueMinor: v.optional(v.number()),
  totalNonCommissionableDepositRevenueMinor: v.optional(v.number()),
})
  .index("by_tenantId", ["tenantId"]),
```

**Step 2: Verify existing rows survive**

After `npx convex dev`:

```bash
# Row count must be preserved (non-empty for active tenants).
npx convex data tenantStats --limit 3
```

Every existing `tenantStats` row must still be present, with the 4 new optional fields showing as `undefined` in the data viewer.

**Step 3: Widen the `TenantStatsDelta` type**

Phase 3 (Subphase 3B) adds the new delta keys to `convex/lib/tenantStatsHelper.ts`. For Phase 2, confirm that the existing `TenantStatsDelta` type supports `Partial<Record<keyof TenantStatsRow, number>>` — if it does (it does today as individual optional number fields), no Phase 2 change is needed here. If it doesn't, widen the type with the 4 new keys.

**Key implementation notes:**
- **Additive, not destructive.** The 4 new fields are `v.optional(v.number())` — existing rows don't need backfill; they'll gain values at the first payment write.
- `totalRevenueMinor` stays required for rollout compat. The invariant `totalRevenueMinor === sum(4 new fields)` holds only after the first payment writes land under the new regime — it's a soft invariant, not a schema constraint.
- The field names are **long on purpose.** `totalCommissionableFinalRevenueMinor` is clearer at call sites than `commFinal` and the extra bytes don't matter in practice.
- Do NOT alias the old `totalRevenueMinor` to a computed property. Keep it as a stored field with its existing write path; Phase 3 will `applyPaymentStatsDelta` update BOTH the legacy field and the new split counter so the dashboard doesn't flicker during rollout.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add 4 optional number fields to `tenantStats`. |

---

### 2D — `paymentSums` Aggregate Re-Keying + Write-Hook Guard

**Type:** Backend
**Parallelizable:** Yes — runs after the schema deploys (2A/B/C) but is independent of 2E and 2F.

**What:** Re-key the `paymentSums` TableAggregate in `convex/reporting/aggregates.ts` from `sortKey: (doc) => [doc.closerId, doc.recordedAt]` to `sortKey: (doc) => [doc.attributedCloserId!, doc.recordedAt]`, preserving `Namespace: Id<"tenants">` and `sumValue: disputed → 0`. Update `convex/reporting/writeHooks.ts::insertPaymentAggregate` to early-return when `commissionable === false` (non-commissionable rows never contribute to per-closer sums). Update `replacePaymentAggregate` to handle the four transition matrix states correctly.

**Why:**
1. With `closerId` removed from the schema (Subphase 2A), the existing `sortKey` no longer compiles.
2. `paymentSums.sum()` is not called anywhere today, but we keep the aggregate consistent so future per-closer scan optimizations can trust it.
3. Non-commissionable rows must never appear in `paymentSums` — they carry `attributedCloserId: undefined`, which the `!` non-null assertion would crash on. The write-hook guard prevents `paymentSums.insert` from running for these rows.

**Where:**
- `convex/reporting/aggregates.ts` (modify)
- `convex/reporting/writeHooks.ts` (modify)

**How:**

**Step 1: Update `paymentSums` sortKey**

**Before:**

```typescript
// Path: convex/reporting/aggregates.ts (BEFORE)
export const paymentSums = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [Id<"users">, number];
  DataModel: DataModel;
  TableName: "paymentRecords";
}>(components.paymentSums, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => [doc.closerId, doc.recordedAt],
  sumValue: (doc) => (doc.status === "disputed" ? 0 : doc.amountMinor),
});
```

**After:**

```typescript
// Path: convex/reporting/aggregates.ts (AFTER)
export const paymentSums = new TableAggregate<{
  Namespace: Id<"tenants">;
  // Key kept as [Id<"users">, number] — attributedCloserId is optional in
  // the schema, but the write-hook guard ensures only rows WITH a defined
  // attributedCloserId reach paymentSums.insert. The `!` is safe because of
  // the guard in writeHooks.ts (commissionable === true → attributedCloserId
  // defined, enforced by assertPaymentRow in Phase 3).
  Key: [Id<"users">, number];
  DataModel: DataModel;
  TableName: "paymentRecords";
}>(components.paymentSums, {
  namespace: (doc) => doc.tenantId,
  // Commissionable-only aggregate. Non-commissionable rows (attributedCloserId
  // undefined) are filtered out BEFORE this function is reached, so the `!` is
  // guaranteed safe. The design's invariant assertPaymentRow catches any drift.
  sortKey: (doc) => [doc.attributedCloserId!, doc.recordedAt],
  // Disputed rows contribute 0 to the sum (unchanged).
  sumValue: (doc) => (doc.status === "disputed" ? 0 : doc.amountMinor),
});
```

**Step 2: Update `insertPaymentAggregate`**

**Before:**

```typescript
// Path: convex/reporting/writeHooks.ts (BEFORE)
export async function insertPaymentAggregate(
  ctx: MutationCtx,
  paymentId: Id<"paymentRecords">,
): Promise<Doc<"paymentRecords">> {
  const payment = await getPaymentOrThrow(ctx, paymentId);
  await paymentSums.insert(ctx, payment);
  return payment;
}
```

**After:**

```typescript
// Path: convex/reporting/writeHooks.ts (AFTER)
/**
 * Inserts the payment into paymentSums ONLY if it's commissionable.
 * Non-commissionable rows are excluded from the aggregate entirely —
 * they never contribute to per-closer "cash collected" totals.
 *
 * Returns the fetched payment doc for convenience (used by callers
 * that need to read back the full row after insert).
 */
export async function insertPaymentAggregate(
  ctx: MutationCtx,
  paymentId: Id<"paymentRecords">,
): Promise<Doc<"paymentRecords">> {
  const payment = await getPaymentOrThrow(ctx, paymentId);
  if (!payment.commissionable) {
    // Non-commissionable row — skip aggregate write.
    // attributedCloserId is undefined here and paymentSums.insert would crash.
    return payment;
  }
  await paymentSums.insert(ctx, payment);
  return payment;
}
```

**Step 3: Update `replacePaymentAggregate`**

**Before:**

```typescript
// Path: convex/reporting/writeHooks.ts (BEFORE)
export async function replacePaymentAggregate(
  ctx: MutationCtx,
  oldPayment: Doc<"paymentRecords">,
  paymentId: Id<"paymentRecords">,
): Promise<Doc<"paymentRecords">> {
  const payment = await getPaymentOrThrow(ctx, paymentId);
  await paymentSums.replace(ctx, oldPayment, payment);
  return payment;
}
```

**After:**

```typescript
// Path: convex/reporting/writeHooks.ts (AFTER)
/**
 * Handles the four transition states for commissionable flag:
 *   (T, T) — replace existing aggregate entry (normal update)
 *   (T, F) — remove old aggregate entry (commissionable → non-commissionable;
 *            happens e.g., if a row is re-classified via a future admin tool)
 *   (F, T) — insert new aggregate entry (non-commissionable → commissionable)
 *   (F, F) — skip entirely (never was in the aggregate)
 *
 * This covers the dispute-reversal path in `resolveReview`: a disputed
 * commissionable payment stays commissionable (T, T) but its `sumValue`
 * drops to 0 via the `status === "disputed"` branch of sumValue.
 */
export async function replacePaymentAggregate(
  ctx: MutationCtx,
  oldPayment: Doc<"paymentRecords">,
  paymentId: Id<"paymentRecords">,
): Promise<Doc<"paymentRecords">> {
  const payment = await getPaymentOrThrow(ctx, paymentId);

  // Case (F, F) — neither in aggregate. Skip.
  if (!oldPayment.commissionable && !payment.commissionable) {
    return payment;
  }

  // Case (T, F) — was commissionable, now isn't. Remove old entry.
  if (oldPayment.commissionable && !payment.commissionable) {
    await paymentSums.deleteIfExists(ctx, oldPayment).catch(() => undefined);
    return payment;
  }

  // Case (F, T) — wasn't commissionable, now is. Insert.
  if (!oldPayment.commissionable && payment.commissionable) {
    await paymentSums.insert(ctx, payment);
    return payment;
  }

  // Case (T, T) — normal update path.
  await paymentSums.replace(ctx, oldPayment, payment);
  return payment;
}
```

**Step 4: Verify type safety**

```bash
pnpm tsc --noEmit
```

The `attributedCloserId!` non-null assertion in `paymentSums.sortKey` must not produce a type error — the aggregate type allows `Id<"users">` and the runtime guard ensures the `!` is safe. If TypeScript complains, confirm that `attributedCloserId: v.optional(v.id("users"))` has generated the right Doc type.

**Key implementation notes:**
- `deleteIfExists` swallows "row not in aggregate" errors via `.catch(() => undefined)` — this is defensive and tolerates the edge case where the aggregate was never populated (e.g., the row was inserted before this code deployed).
- The `!` non-null assertion is safe at runtime because every call path that reaches `paymentSums.insert`/`.replace` is guarded by `commissionable === true` OR `assertPaymentRow` (Phase 3) which makes the pair (`commissionable: true`, `attributedCloserId: defined`) a structural invariant.
- Do NOT switch to `Key: [Id<"users"> | undefined, number]` — the aggregate doesn't support undefined keys cleanly, and we don't want non-commissionable rows in this aggregate anyway.
- The `sumValue` logic is unchanged — disputed rows still contribute 0. This preserves the dispute-reversal semantics.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/aggregates.ts` | Modify | Re-key `paymentSums` to `attributedCloserId`. |
| `convex/reporting/writeHooks.ts` | Modify | Guard `insertPaymentAggregate`; handle 4 transitions in `replacePaymentAggregate`. |

---

### 2E — `syncRenamedProgram` Body (now live)

**Type:** Backend
**Parallelizable:** Yes — independent of 2D and 2F.

**What:** Replace the Phase 1D skeleton body with a real paginated implementation that patches `paymentRecords.programName` and `customers.programName` for every row that references the renamed program. Uses `ctx.scheduler.runAfter(0, ...)` to self-reschedule with cursors until both tables are fully patched. Batch size of 200 rows per transaction to stay under Convex transaction write limits.

**Why:**
1. In Phase 1D the body was a no-op because `paymentRecords.programName` and `customers.programName` didn't exist yet. Now they do (Subphases 2A + 2B).
2. The rename-sync job is operationally critical: reports, dashboards, and detail pages show the denormalized `programName` cache; without this job, a renamed program displays stale names everywhere except the Settings tab itself.
3. Paginated batching is required by Convex's ~8,000-write transaction limit; at current scale a single tenant will have < 1,500 payment rows, so the first batch almost always completes synchronously, but the pagination is there for future-proofing.

**Where:**
- `convex/tenantPrograms/sync.ts` (modify)

**How:**

**Step 1: Replace the no-op body**

```typescript
// Path: convex/tenantPrograms/sync.ts (MODIFIED — body filled in)
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";

const BATCH_SIZE = 200;

export const syncRenamedProgram = internalMutation({
  args: {
    programId: v.id("tenantPrograms"),
    paymentCursor: v.optional(v.string()),
    customerCursor: v.optional(v.string()),
  },
  handler: async (ctx, { programId, paymentCursor, customerCursor }) => {
    console.log("[Programs] syncRenamedProgram tick", {
      programId,
      paymentCursor,
      customerCursor,
    });

    const program = await ctx.db.get(programId);
    if (!program) {
      console.warn(
        "[Programs] syncRenamedProgram: program vanished mid-sync",
        { programId },
      );
      return { done: true, patched: 0 };
    }

    let patched = 0;
    let nextPaymentCursor: string | null = paymentCursor ?? null;
    let nextCustomerCursor: string | null = customerCursor ?? null;
    let paymentsDone = false;
    let customersDone = false;

    // --- paymentRecords pagination ---
    if (nextPaymentCursor !== "__done__") {
      const payments = await ctx.db
        .query("paymentRecords")
        .withIndex("by_tenantId_and_programId_and_recordedAt", (q) =>
          q.eq("tenantId", program.tenantId).eq("programId", programId),
        )
        .paginate({ cursor: nextPaymentCursor, numItems: BATCH_SIZE });
      for (const p of payments.page) {
        if (p.programName !== program.name) {
          await ctx.db.patch(p._id, { programName: program.name });
          patched += 1;
        }
      }
      if (payments.isDone) {
        nextPaymentCursor = "__done__";
        paymentsDone = true;
      } else {
        nextPaymentCursor = payments.continueCursor;
      }
    } else {
      paymentsDone = true;
    }

    // --- customers pagination ---
    // Walk customers after payments so a single tick doesn't exceed the
    // transaction-write budget. Each tick patches at most 200 + 200 = 400 rows.
    if (paymentsDone && nextCustomerCursor !== "__done__") {
      const customers = await ctx.db
        .query("customers")
        .withIndex("by_tenantId_and_programId", (q) =>
          q.eq("tenantId", program.tenantId).eq("programId", programId),
        )
        .paginate({ cursor: nextCustomerCursor, numItems: BATCH_SIZE });
      for (const c of customers.page) {
        if (c.programName !== program.name) {
          await ctx.db.patch(c._id, { programName: program.name });
          patched += 1;
        }
      }
      if (customers.isDone) {
        nextCustomerCursor = "__done__";
        customersDone = true;
      } else {
        nextCustomerCursor = customers.continueCursor;
      }
    } else if (paymentsDone) {
      customersDone = true;
    }

    // --- Self-reschedule if more work pending ---
    if (!paymentsDone || !customersDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.tenantPrograms.sync.syncRenamedProgram,
        {
          programId,
          paymentCursor: nextPaymentCursor ?? undefined,
          customerCursor: nextCustomerCursor ?? undefined,
        },
      );
      return { done: false, patched };
    }

    console.log("[Programs] syncRenamedProgram: complete", {
      programId,
      patched,
    });
    return { done: true, patched };
  },
});
```

**Step 2: Verify via scenario**

```bash
# 1. Seed a program
npx convex run tenantPrograms:seed:ensureInitialProgramForTenant \
  '{ "tenantId": "<id>", "createdByUserId": "<id>", "name": "Launchpad" }'
# 2. Log a smoke-test payment (requires Phase 3 write paths; skip until then)
# 3. Rename the program
npx convex run tenantPrograms:upsertProgram \
  '{ "programId": "<id>", "name": "Launchpad 2.0" }'
# 4. Confirm the rename propagates
npx convex data paymentRecords --limit 10
# Every row for this program should show programName: "Launchpad 2.0"
```

The full scenario only runs end-to-end after Phase 3/4 land. Phase 2 unit-level verification: call `syncRenamedProgram` directly with a known programId + empty tables; expect `{ done: true, patched: 0 }`.

**Key implementation notes:**
- `__done__` sentinel for cursors because `paginate` returns a string cursor and we need a way to signal "we're past this table." An alternative is two boolean args, but the cursor-as-sentinel keeps the args schema tight.
- We patch `customers` only after `payments` completes so a single tick never exceeds the 8,000-write transaction cap. At BATCH_SIZE=200 for each, worst case is 400 patches per tick (well under the cap).
- The `if (p.programName !== program.name)` guard prevents no-op patches — patching a row to the same value still consumes a write budget.
- `ctx.scheduler.runAfter(0, ...)` self-reschedules onto a fresh transaction; cursors survive because they're part of the args validator.
- The internal reference path is `internal.tenantPrograms.sync.syncRenamedProgram` — same as the `upsertProgram` call site.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/tenantPrograms/sync.ts` | Modify | Replace no-op body with paginated real implementation. |

---

### 2F — Operational Tooling Alignment

**Type:** Backend
**Parallelizable:** Yes — independent of 2D and 2E. Small, mechanical edits.

**What:** Update three operational files so they reflect the new schema: remove references to `paymentRecords.closerId`, `paymentRecords.provider`, `paymentRecords.loggedByAdminUserId`, and `customers.programType`. Update `paymentSums` expectations in verification.

**Why:**
1. The design (§18.1) explicitly calls out: "Confirm operational/admin tooling is updated in the same patch set: `convex/reporting/backfill.ts`, `convex/reporting/verification.ts`, and `convex/admin/migrations.ts` must all reflect the new fields and the commissionable-only `paymentSums` semantics."
2. Leaving stale field references in operational tooling means any incident-response invocation would crash with "unknown field `closerId`" — exactly when you least want that.
3. `verification.ts` specifically had an invariant that `paymentSums` contains 1:1 rows from `paymentRecords`. After Phase 2, that invariant becomes "1:1 with commissionable rows only."

**Where:**
- `convex/reporting/backfill.ts` (modify)
- `convex/reporting/verification.ts` (modify)
- `convex/admin/migrations.ts` (modify)

**How:**

**Step 1: Sweep `backfill.ts`**

Grep for any read/write that still references `closerId`, `provider`, `loggedByAdminUserId`, or `customer_flow`. For each hit:

```typescript
// Path: convex/reporting/backfill.ts (MODIFIED — illustrative before/after)

// BEFORE
if (payment.closerId) {
  summary.closerStats[payment.closerId] ??= {
    revenueMinor: 0,
    dealCount: 0,
  };
  summary.closerStats[payment.closerId].revenueMinor += payment.amountMinor;
}

// AFTER
// Attribution is authoritative at write time. Non-commissionable rows are
// excluded from per-closer backfill stats; they land under the post-conv
// bucket instead.
if (payment.commissionable && payment.attributedCloserId) {
  summary.closerStats[payment.attributedCloserId] ??= {
    revenueMinor: 0,
    dealCount: 0,
  };
  summary.closerStats[payment.attributedCloserId].revenueMinor +=
    payment.amountMinor;
}
```

Also replace the legacy origin name `customer_flow` with `customer_direct` (if referenced).

**Step 2: Update `verification.ts`**

Find the `paymentSums` integrity check and narrow it to commissionable-only:

```typescript
// Path: convex/reporting/verification.ts (MODIFIED)

// BEFORE
const aggregateCount = await paymentSums.count(ctx, {
  namespace: tenantId,
  bounds: {},
});
const tableCount = await ctx.db.query("paymentRecords")
  .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
  .collect(); // (bad — unbounded — rewrite to .paginate if not already)
if (aggregateCount !== tableCount.length) {
  throw new Error("paymentSums aggregate out of sync");
}

// AFTER
// paymentSums now tracks commissionable rows only. Verification compares
// aggregate count with the count of commissionable paymentRecords.
const aggregateCount = await paymentSums.count(ctx, {
  namespace: tenantId,
  bounds: {},
});
// Use the new commissionable index; bound the scan.
let commissionableCount = 0;
let cursor: string | null = null;
while (true) {
  const page = await ctx.db
    .query("paymentRecords")
    .withIndex("by_tenantId_and_commissionable_and_recordedAt", (q) =>
      q.eq("tenantId", tenantId).eq("commissionable", true),
    )
    .paginate({ cursor, numItems: 500 });
  commissionableCount += page.page.length;
  if (page.isDone) break;
  cursor = page.continueCursor;
}
if (aggregateCount !== commissionableCount) {
  throw new Error(
    `paymentSums out of sync: aggregate=${aggregateCount} ` +
    `commissionable=${commissionableCount}`,
  );
}
```

**Step 3: Update `admin/migrations.ts`**

Swap `closerId` reads for `attributedCloserId` + `recordedByUserId`. Example:

```typescript
// Path: convex/admin/migrations.ts (MODIFIED)

// BEFORE
// Ops debug: "show me all payments logged by this user"
const logged = await ctx.db
  .query("paymentRecords")
  .withIndex("by_tenantId_and_closerId", (q) =>
    q.eq("tenantId", tenantId).eq("closerId", userId),
  )
  .collect();

// AFTER
// Two distinct questions now:
//   1. "Payments attributed to this closer" → by_tenantId_and_attributedCloserId_and_recordedAt
//   2. "Payments recorded (clicked by) this user" → full scan + filter OR
//      (Phase 5 adds by_recordedByUserId if needed; MVP doesn't)
const attributed = await ctx.db
  .query("paymentRecords")
  .withIndex("by_tenantId_and_attributedCloserId_and_recordedAt", (q) =>
    q.eq("tenantId", tenantId).eq("attributedCloserId", userId),
  )
  .take(500);

// "Recorded by" is rarer — use a bounded scan for now.
const recorded = await ctx.db
  .query("paymentRecords")
  .withIndex("by_tenantId_and_recordedAt", (q) => q.eq("tenantId", tenantId))
  .take(500);
const recordedByUser = recorded.filter((p) => p.recordedByUserId === userId);
```

**Step 4: Sweep grep**

```bash
# Must return zero hits:
grep -R "paymentRecords.closerId\|p\.closerId\|\.provider\|loggedByAdminUserId\|programType\|customer_flow" convex/ app/
```

If any hit exists, resolve it. Zero hits is an acceptance criterion (§AC 12).

**Key implementation notes:**
- These files are ops-only and rarely run — but they're the first tools an on-call engineer reaches for during an incident. Keeping them truthful is as important as keeping reports truthful.
- Replace `customer_flow` with `customer_direct` EVERYWHERE in one sweep; the origin literal is renamed in the schema (Subphase 2A) and the union would fail if a stale reference tried to construct an object with `origin: "customer_flow"`.
- For `admin/migrations.ts`, we explicitly split the old single "who logged it" concept into two distinct reads (`attributedCloserId` = commission recipient; `recordedByUserId` = who clicked). Comment this clearly so future readers understand the split.
- We do NOT add a `by_tenantId_and_recordedByUserId` index in MVP — the bounded scan is fine. If ops tooling becomes a hot path, add it in a follow-up.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/backfill.ts` | Modify | Swap `closerId` → `attributedCloserId` + `commissionable` check. |
| `convex/reporting/verification.ts` | Modify | `paymentSums` expected count now = commissionable count. |
| `convex/admin/migrations.ts` | Modify | Split `closerId` into `attributedCloserId` + `recordedByUserId`. |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modify | 2A, 2B, 2C |
| `convex/reporting/aggregates.ts` | Modify | 2D |
| `convex/reporting/writeHooks.ts` | Modify | 2D |
| `convex/tenantPrograms/sync.ts` | Modify | 2E |
| `convex/reporting/backfill.ts` | Modify | 2F |
| `convex/reporting/verification.ts` | Modify | 2F |
| `convex/admin/migrations.ts` | Modify | 2F |
