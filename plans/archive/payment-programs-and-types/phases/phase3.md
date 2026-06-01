# Phase 3 — Shared Payment Helpers & Conversion

**Goal:** Land the shared write-time invariants and delta-routing helpers that every Phase 4 payment write path will consume, rewrite the lead → customer conversion code paths so they resolve the canonical program from the winning payment (instead of the legacy `eventTypeConfig.displayName` fallback), and extract the shared payment-origin / payment-type literal unions into a tiny `convex/lib/paymentTypes.ts` source of truth so the helper modules stay acyclic. Functionally this phase still centers on four changes: `assertPaymentRow` + `requireActiveProgram` in `convex/lib/paymentHelpers.ts`, `applyPaymentStatsDelta` + widened `TenantStatsDelta` in `convex/lib/tenantStatsHelper.ts`, a rewritten `executeConversion` in `convex/customers/conversion.ts`, and a slimmer `convertLeadToCustomer` in `convex/customers/mutations.ts`. No payment write path is actually rewired yet — that lands in Phase 4.

**Prerequisite:**
- **Phase 1 is merged** — `internal.tenantPrograms.*` handles compile. `requireActiveProgram` calls `ctx.db.get(programId)` on a program the caller supplied; no typegen dependency on Phase 1 mutations, just on the `tenantPrograms` table type.
- **Phase 2 is merged** — the new `paymentRecords` schema (with `commissionable`, `attributedCloserId`, `programId`, `programName`, `paymentType`, `originatingOpportunityId`, expanded `origin`) and the 4 new `tenantStats` counter fields are live. Without Phase 2's schema, `applyPaymentStatsDelta`'s key computation and `executeConversion`'s `programId` resolution don't typecheck.
- `convex/lib/paymentHelpers.ts`, `convex/lib/tenantStatsHelper.ts`, `convex/customers/conversion.ts`, and `convex/customers/mutations.ts` all exist in the current repo; this phase modifies each of them and adds one tiny new shared-literals file, `convex/lib/paymentTypes.ts`, to avoid a helper import cycle.

**Runs in PARALLEL with:** Nothing — Phase 3 is the critical-path bridge between the schema (Phase 1+2) and the mutation rewrites (Phase 4). No other phase can start until this phase ships, because every Phase 4 write path imports from these files.

> **Critical path:** Phase 3 is the narrowest point on the entire critical path. A delay here blocks the four payment write paths, the admin review resolution branch, every downstream report rewrite (Phase 5), and the frontend phases that depend on the rewritten write/read contracts (Phases 7–9). Phase 6 remains independently executable off Phase 1. The good news: it's small (4 subphases, ~250 LOC total) and mechanical.

**Skills to invoke:**
- `convex-performance-audit` — confirm `applyPaymentStatsDelta` produces a single `ctx.db.patch` per call (not 4 patches for 4 counters); confirm `executeConversion`'s new payment-lookup does NOT scan unbounded (it takes one row via `.order("desc").first()`).
- `convex-migration-helper` — cross-check that dropping `programType` from `convertLeadToCustomer` and `executeConversion` stays deployment-safe. The current manual-conversion dialog already omits this arg, so any stray caller uncovered during implementation should be fixed in the same PR rather than tolerated as a temporary runtime break.

**Acceptance Criteria:**
1. `convex/lib/paymentTypes.ts` is the source of truth for `CommissionableOrigin` (union of 5 literals), `NonCommissionableOrigin` (union of 2 literals), `PaymentType` (union of 4 literals), and `AssertablePaymentShape`; `convex/lib/paymentHelpers.ts` re-exports the public types that Phase 4 callers consume.
2. `convex/lib/paymentHelpers.ts` exports `assertPaymentRow(row: AssertablePaymentShape): void` that throws a domain-tagged `[Payments]` error when any of the five invariants in §5.4 of the design are violated (commissionable ↔ attributedCloserId pairing; contextType/opportunityId coherence; contextType/customerId coherence; origin ↔ commissionable consistency).
3. `convex/lib/paymentHelpers.ts` exports `requireActiveProgram(ctx, tenantId, programId): Promise<Doc<"tenantPrograms">>` that fetches the program, validates `program.tenantId === tenantId`, throws `"Program not found"` (generic) on mismatch/missing, and throws `'Program "<name>" is archived and cannot accept new payments. Restore it in Settings → Programs first.'` when archived. Returns the program doc (narrow, non-nullable) on success.
4. `convex/lib/tenantStatsHelper.ts` widens `TenantStatsDelta` with the four new optional numeric keys (`totalCommissionableFinalRevenueMinor`, `totalCommissionableDepositRevenueMinor`, `totalNonCommissionableFinalRevenueMinor`, `totalNonCommissionableDepositRevenueMinor`) and appends all four to `TENANT_STATS_FIELDS`.
5. `convex/lib/tenantStatsHelper.ts` exports `PaymentStatsDelta` type and `applyPaymentStatsDelta(ctx, tenantId, delta): Promise<void>` that routes `amountMinorDelta` to the correct split counter based on `(commissionable, paymentType === "deposit")`, increments `totalPaymentRecords` by `Math.sign(amountMinorDelta)`, keeps legacy `totalRevenueMinor` in lockstep (same `amountMinorDelta`), and applies optional `wonDealDelta` / `activeOpportunityDelta` when provided.
6. `convex/customers/conversion.ts::executeConversion` no longer accepts `programType?: string`; instead it queries `paymentRecords` by `by_opportunityId` (desc by `_creationTime`), takes the first (winning) row, resolves `programId` + `programName` from that payment, validates the program exists and belongs to the tenant, and inserts `customers.programId` + `customers.programName` (not `customers.programType`).
7. `executeConversion` throws `"Cannot convert lead to customer: no payment found on winning opportunity"` when no payment exists on the winning opportunity, and throws `"Program not found on winning payment"` when the program referenced is missing or cross-tenant.
8. `convex/customers/mutations.ts::convertLeadToCustomer` removes the `programType: v.optional(v.string())` arg from its validator and no longer forwards it to `executeConversion`.
9. `pnpm tsc --noEmit` passes. Every consumer of `executeConversion` and `convertLeadToCustomer` still compiles; the auto-conversion path keeps omitting `programType`, and the existing manual-conversion dialog already calls `convertLeadToCustomer` without a `programType` arg.
10. A grep sweep confirms: `grep -R "programType" convex/` returns zero matches outside of legacy comments documenting the removed field (and Phase 2's schema file is already clean).
11. `convex/customers/mutations.ts::recordCustomerPayment` still type-checks — its schema-level references to removed fields (`closerId`, `provider`, `loggedByAdminUserId`, `origin: "customer_flow"`) will be rewritten in Phase 4, but Phase 3's helper additions must not break its compilation. If Phase 2's destructive schema rewrite dropped fields the current body still references, add a `// TODO(phase4): rewrite` stub that matches the new schema shape enough to compile — do NOT attempt the full rewrite in Phase 3.
12. No payment write path is rewritten yet — `logPayment`, `logReminderPayment`, `createPaymentRecord`, and `recordCustomerPayment` are still in their current shape (modulo the Phase 2 schema pass). Phase 4 owns those rewrites.

---

## Subphase Dependency Graph

```
3A (paymentHelpers.ts — assertPaymentRow + requireActiveProgram) ──┐
                                                                   │
3B (tenantStatsHelper.ts — applyPaymentStatsDelta + widened type) ─┤
                                                                   ├──▶ Phase 4
3C (conversion.ts — executeConversion rewrite) ────────────────────┤    (payment writes)
                                                                   │
3D (mutations.ts — convertLeadToCustomer arg drop) ────────────────┘
       └── depends on 3C only
```

**Optimal execution:**
1. **Start 3A, 3B, 3C in parallel.** Three independent files; no cross-imports between them at this phase. One engineer can knock them out sequentially in ~2 hrs; two engineers cut it in half.
2. **Start 3D after 3C lands.** 3D's only backend consumer is `executeConversion`; dropping the arg must match the signature 3C ships.
3. Do NOT attempt to rewrite Phase 4's payment write paths here even if a tempting slot opens up — Phase 4's scope is large enough to need its own phase doc for review/parallelization purposes.

**Estimated time:** 0.5 day solo. 3A/3B/3C have minimal prose and heavy mechanical copying.

---

## Subphases

### 3A — `paymentHelpers.ts`: `assertPaymentRow` + `requireActiveProgram`

**Type:** Backend
**Parallelizable:** Yes — independent of 3B, 3C, 3D. One file; append-only additions (existing helpers `syncCustomerPaymentSummary`, `expirePendingFollowUpsForOpportunity`, `rollbackCustomerConversionIfEmpty` are untouched).

**What:** Add four exports to `convex/lib/paymentHelpers.ts`:
1. `CommissionableOrigin` type (5 literals: `closer_meeting`, `closer_reminder`, `admin_meeting`, `admin_reminder`, `admin_review_resolution`)
2. `NonCommissionableOrigin` type (2 literals: `customer_direct`, `bookkeeper_direct`)
3. `PaymentType` type (4 literals: `monthly`, `split`, `pif`, `deposit`)
4. `AssertablePaymentShape` type + `assertPaymentRow` function enforcing the §5.4 invariants
5. `requireActiveProgram` async function that fetches + validates + returns the program doc

**Why:** These are the write-time invariants that shift attribution from read-time inference (the current `attributePaymentsToClosers` in `convex/reporting/lib/helpers.ts:94-158`) to a structural guarantee enforced at insert. Every Phase 4 write path will call both helpers; centralizing them here keeps the origin → commissionable → attributed-closer mapping defined in one place. Without these, Phase 4's four mutation rewrites would each carry a private copy of the invariant checks and drift over time.

The paired types (`CommissionableOrigin` and `NonCommissionableOrigin`) are exported so Phase 4 payment write paths can narrow their `origin` typed arg to exactly the set of values each path is allowed to produce (e.g., `logPayment` only ever produces `closer_meeting | admin_meeting`, never `customer_direct`).

**Where:**
- `convex/lib/paymentHelpers.ts` (modify — append new types + functions)

**How:**

**Step 1: Add the type exports at the top of the file (after imports)**

```typescript
// Path: convex/lib/paymentHelpers.ts (APPEND below existing imports)

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
// (existing imports stay as-is: emitDomainEvent, updateTenantStats, deleteCustomerAggregate)

// ============================================================================
// Payment row invariants (new in Phase 3)
// ============================================================================

/**
 * Origins that produce a commission-eligible payment. The mapping between
 * an origin and the `commissionable` flag is 1:1 — these five origins always
 * set `commissionable: true` and always populate `attributedCloserId`.
 *
 * Exported so Phase 4 write paths can narrow their `origin` arg to exactly
 * the set of values they're allowed to produce.
 */
export type CommissionableOrigin =
  | "closer_meeting"
  | "closer_reminder"
  | "admin_meeting"
  | "admin_reminder"
  | "admin_review_resolution";

/**
 * Origins that produce a non-commission-eligible payment. These always set
 * `commissionable: false` and leave `attributedCloserId` undefined.
 *
 * `bookkeeper_direct` is RESERVED for a future role; no current caller
 * produces it, but the literal is reserved in the schema (Phase 2) to
 * avoid a second destructive migration when the bookkeeper role ships.
 */
export type NonCommissionableOrigin =
  | "customer_direct"
  | "bookkeeper_direct";

/**
 * Payment type — the business intent of the money. Distinct from `status`
 * (which is the processing state: recorded / verified / disputed).
 */
export type PaymentType = "monthly" | "split" | "pif" | "deposit";

/**
 * Structural shape accepted by `assertPaymentRow`. This is a SUBSET of the
 * full `Doc<"paymentRecords">` that covers only the invariant-bearing fields.
 *
 * The shape mirrors the payment-row insert payload produced by every Phase 4
 * write path BEFORE ctx.db.insert. `undefined` is the only valid "absent"
 * value; null / missing keys are rejected by the type system.
 */
export type AssertablePaymentShape = {
  tenantId: Id<"tenants">;
  commissionable: boolean;
  attributedCloserId: Id<"users"> | undefined;
  recordedByUserId: Id<"users">;
  origin: CommissionableOrigin | NonCommissionableOrigin;
  contextType: "opportunity" | "customer";
  opportunityId: Id<"opportunities"> | undefined;
  customerId: Id<"customers"> | undefined;
  programId: Id<"tenantPrograms">;
};
```

**Step 2: Add `assertPaymentRow`**

```typescript
// Path: convex/lib/paymentHelpers.ts (APPEND below the type exports)

/**
 * Enforces the payment-row invariants (design §5.4). Called by every Phase 4
 * payment write path BEFORE ctx.db.insert. Throws a domain-tagged [Payments]
 * error on the first violation.
 *
 * Invariants enforced:
 *   (I1) commissionable=true  ⇒ attributedCloserId defined
 *   (I2) commissionable=false ⇒ attributedCloserId undefined
 *   (I3) commissionable=true  ⇒ contextType="opportunity" AND opportunityId defined
 *   (I4) commissionable=false ⇒ contextType="customer"    AND customerId defined
 *   (I5) origin set membership matches commissionable flag:
 *        origin ∈ nonCommissionableOrigins ⇔ commissionable=false
 *
 * The errors are developer-facing (not surfaced in the UI), so the messages
 * focus on which rule fired rather than suggesting a user action.
 */
export function assertPaymentRow(row: AssertablePaymentShape): void {
  // (I1) commissionable row must carry an attributed closer.
  if (row.commissionable && !row.attributedCloserId) {
    throw new Error(
      "[Payments] invariant: commissionable row must have attributedCloserId",
    );
  }
  // (I2) non-commissionable row must NOT carry an attributed closer.
  if (!row.commissionable && row.attributedCloserId) {
    throw new Error(
      "[Payments] invariant: non-commissionable row must not carry attributedCloserId",
    );
  }
  // (I3) commissionable rows are always opportunity-linked.
  if (row.commissionable && (row.contextType !== "opportunity" || !row.opportunityId)) {
    throw new Error(
      "[Payments] invariant: commissionable row must link to an opportunity",
    );
  }
  // (I4) non-commissionable rows are always customer-linked.
  if (!row.commissionable && (row.contextType !== "customer" || !row.customerId)) {
    throw new Error(
      "[Payments] invariant: non-commissionable row must link to a customer",
    );
  }
  // (I5) origin set membership ⇔ commissionable flag.
  // Using Set.has() because the literal unions are small; the XOR logic below
  // reads as: "row.commissionable EQUAL nonCommissionableOrigins.has(origin)"
  // is only true when they contradict each other (both true or both false of
  // the opposite expectation). The correct relation is:
  //   commissionable === !nonCommissionableOrigins.has(origin)
  // which we rewrite as a direct contradiction check for clarity:
  const nonCommissionableOrigins = new Set<string>([
    "customer_direct",
    "bookkeeper_direct",
  ]);
  const originIsNonCommissionable = nonCommissionableOrigins.has(row.origin);
  if (row.commissionable === originIsNonCommissionable) {
    // commissionable=true  AND origin ∈ nonComm set  → contradiction
    // commissionable=false AND origin ∉ nonComm set  → contradiction
    throw new Error(
      `[Payments] invariant: origin "${row.origin}" contradicts commissionable=${row.commissionable}`,
    );
  }
}
```

**Step 3: Add `requireActiveProgram`**

```typescript
// Path: convex/lib/paymentHelpers.ts (APPEND below assertPaymentRow)

/**
 * Resolves a program ID to its row, verifying:
 *   - The program exists
 *   - The program belongs to the caller's tenant
 *   - The program is not archived
 *
 * Returns the narrowed program doc. Throws on any failure.
 *
 * Cross-tenant probes are answered with the generic "Program not found"
 * message — never leak the fact that a program exists in another tenant.
 *
 * Called by every Phase 4 payment write path (logPayment, logReminderPayment,
 * recordCustomerPayment, createPaymentRecord via resolveReview).
 */
export async function requireActiveProgram(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  programId: Id<"tenantPrograms">,
): Promise<Doc<"tenantPrograms">> {
  const program = await ctx.db.get(programId);
  if (!program || program.tenantId !== tenantId) {
    // Generic message — do not reveal whether the program exists elsewhere.
    throw new Error("Program not found");
  }
  if (program.archivedAt !== undefined) {
    // Specific message — the program exists and is owned by the tenant, but
    // is archived. The UI surfaces this verbatim with a link to Settings.
    throw new Error(
      `Program "${program.name}" is archived and cannot accept new payments. Restore it in Settings → Programs first.`,
    );
  }
  return program;
}
```

**Step 4: Smoke-test the helpers via a throwaway scratch mutation**

A proper integration test lands in Phase 4 (every payment write path exercises both). For Phase 3, verify type-only:

```bash
pnpm tsc --noEmit
# Expected: zero errors. If `Doc<"tenantPrograms">` is flagged as unknown,
# Phase 1's schema hasn't landed yet — fix the prerequisite before proceeding.
```

Also verify `assertPaymentRow`'s five error paths by mental simulation:

| Input | Expected throw |
|---|---|
| `{ commissionable: true, attributedCloserId: undefined, ... }` | (I1) "commissionable row must have attributedCloserId" |
| `{ commissionable: false, attributedCloserId: "user_xyz", ... }` | (I2) "non-commissionable row must not carry attributedCloserId" |
| `{ commissionable: true, contextType: "customer", opportunityId: undefined, ... }` | (I3) "commissionable row must link to an opportunity" |
| `{ commissionable: false, contextType: "opportunity", customerId: undefined, ... }` | (I4) "non-commissionable row must link to a customer" |
| `{ commissionable: true, origin: "customer_direct", ... }` | (I5) `origin "customer_direct" contradicts commissionable=true` |

**Key implementation notes:**
- **No transaction state in `assertPaymentRow`.** It's a pure sync function that throws. This lets Phase 4 callers test invariants cheaply before spending a transaction budget on an insert.
- **`originIsNonCommissionable` expressiveness.** The original expression `row.commissionable === nonCommissionableOrigins.has(row.origin)` is correct but subtle. The comment in the code explains the relation. If you prefer a more explicit form: `if ((row.commissionable && originIsNonCommissionable) || (!row.commissionable && !originIsNonCommissionable))` — these are equivalent.
- **`Id<"tenantPrograms">` is available from Phase 1.** If TypeScript cannot resolve it, Phase 1 hasn't merged; do not downgrade the helper to `Id<"unknown">` or any escape hatch.
- **Don't export `nonCommissionableOrigins` as a value.** It's a local Set inside `assertPaymentRow`. Exporting would tempt other code paths to duplicate the invariant check.
- **`requireActiveProgram` takes `MutationCtx`, not `QueryCtx`.** Read-side queries (Phase 5) do NOT call this; they tolerate archived programs (historical reports need to resolve names even when the program is archived). This is a deliberate write-side-only guard.
- **Don't combine `assertPaymentRow` and `requireActiveProgram` into one helper.** Callers already have a `program` doc in scope by the time they call `assertPaymentRow` — re-fetching inside the assert would waste a read budget.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/paymentHelpers.ts` | Modify | Append 3 type exports, `AssertablePaymentShape`, `assertPaymentRow`, `requireActiveProgram`. Existing exports untouched. |

---

### 3B — `tenantStatsHelper.ts`: `applyPaymentStatsDelta` + widened `TenantStatsDelta`

**Type:** Backend
**Parallelizable:** Yes — independent of 3A, 3C, 3D. Same "one file, append-only" pattern.

**What:** Widen `TenantStatsDelta` with the four new optional numeric keys that Phase 2 added to the `tenantStats` schema, extend `TENANT_STATS_FIELDS` with those four keys so `updateTenantStats` honors them on patch, and add a new `applyPaymentStatsDelta` helper that routes payment deltas to the correct split counter while keeping the legacy `totalRevenueMinor` in lockstep for rollout compat.

**Why:** Every payment insert (Phase 4) and every dispute reversal (Phase 5's `resolveReview` dispute branch) needs to mutate four counters atomically: `totalPaymentRecords`, `totalRevenueMinor` (legacy), one of the four split counters (commissionable × final/deposit), and sometimes `wonDeals` / `activeOpportunities`. Rather than hand-writing the routing at every call site, we centralize it here. This also means the rollout-compat policy ("legacy `totalRevenueMinor` is maintained alongside the 4 new counters") lives in one function — the day we remove the legacy field, it's a single-file delete.

**Where:**
- `convex/lib/tenantStatsHelper.ts` (modify — widen type, extend field list, append new helper)

**How:**

**Step 1: Widen `TenantStatsDelta`**

**Before:**

```typescript
// Path: convex/lib/tenantStatsHelper.ts (BEFORE — lines 4-15)
export type TenantStatsDelta = {
  totalTeamMembers?: number;
  totalClosers?: number;
  totalOpportunities?: number;
  activeOpportunities?: number;
  wonDeals?: number;
  lostDeals?: number;
  totalRevenueMinor?: number;
  totalPaymentRecords?: number;
  totalLeads?: number;
  totalCustomers?: number;
};
```

**After:**

```typescript
// Path: convex/lib/tenantStatsHelper.ts (AFTER)
export type TenantStatsDelta = {
  totalTeamMembers?: number;
  totalClosers?: number;
  totalOpportunities?: number;
  activeOpportunities?: number;
  wonDeals?: number;
  lostDeals?: number;
  totalRevenueMinor?: number;
  totalPaymentRecords?: number;
  totalLeads?: number;
  totalCustomers?: number;
  // NEW (Phase 3) — 4-way split counters. `updateTenantStats` initializes
  // them lazily (undefined current + delta → delta). Paired with Phase 2's
  // optional schema fields; the legacy `totalRevenueMinor` stays required
  // for rollout compat and receives the same amount delta.
  totalCommissionableFinalRevenueMinor?: number;
  totalCommissionableDepositRevenueMinor?: number;
  totalNonCommissionableFinalRevenueMinor?: number;
  totalNonCommissionableDepositRevenueMinor?: number;
};
```

**Step 2: Extend `TENANT_STATS_FIELDS`**

**Before:**

```typescript
// Path: convex/lib/tenantStatsHelper.ts (BEFORE — lines 19-30)
const TENANT_STATS_FIELDS: TenantStatsField[] = [
  "totalTeamMembers",
  "totalClosers",
  "totalOpportunities",
  "activeOpportunities",
  "wonDeals",
  "lostDeals",
  "totalRevenueMinor",
  "totalPaymentRecords",
  "totalLeads",
  "totalCustomers",
];
```

**After:**

```typescript
// Path: convex/lib/tenantStatsHelper.ts (AFTER)
const TENANT_STATS_FIELDS: TenantStatsField[] = [
  "totalTeamMembers",
  "totalClosers",
  "totalOpportunities",
  "activeOpportunities",
  "wonDeals",
  "lostDeals",
  "totalRevenueMinor",
  "totalPaymentRecords",
  "totalLeads",
  "totalCustomers",
  // NEW (Phase 3)
  "totalCommissionableFinalRevenueMinor",
  "totalCommissionableDepositRevenueMinor",
  "totalNonCommissionableFinalRevenueMinor",
  "totalNonCommissionableDepositRevenueMinor",
];
```

**Step 3: Verify the auto-create path in `updateTenantStats`**

The existing `updateTenantStats` body (lines 46–95) already iterates `TENANT_STATS_FIELDS` for both the auto-create initialization (line 76) and the patch path (line 86). Extending the list is sufficient — no handler changes needed. Re-read the body mentally to confirm:
- Auto-create: sets `initial[field] = Math.max(0, value)` for any present delta field. The new fields are NOT pre-seeded with 0 in the `initial` base object (lines 62–74); they'll land only if the caller's first write touches them. **That's correct** — a tenant with no payments yet has `undefined` in all 4 counters, matching Phase 2's `v.optional(v.number())` schema.
- Patch path: `patch[field] = (stats[field] ?? 0) + value` — the `?? 0` already handles `undefined` baseline correctly.

**Step 4: Add `applyPaymentStatsDelta`**

```typescript
// Path: convex/lib/tenantStatsHelper.ts (APPEND at bottom of file)

import type { PaymentType } from "./paymentHelpers";

/**
 * Shape of a single payment stat delta — produced by every payment write
 * path (insert, dispute reversal) and consumed by `applyPaymentStatsDelta`.
 *
 * `amountMinorDelta` is the SIGNED amount:
 *   +amount for a new/restored payment
 *   -amount for a disputed payment (dispute zeroes a payment's contribution)
 */
export type PaymentStatsDelta = {
  commissionable: boolean;
  paymentType: PaymentType;
  amountMinorDelta: number;
  /**
   * Optional deltas for opportunity-state-machine hooks that ride alongside
   * the payment write. `logPayment` sets `wonDealDelta: 1` and
   * `activeOpportunityDelta: -1` on the first payment (transition to
   * payment_received); `resolveReview`'s dispute branch sets
   * `wonDealDelta: -1` + `activeOpportunityDelta: 1` to reverse.
   */
  wonDealDelta?: number;
  activeOpportunityDelta?: number;
};

/**
 * Routes a payment stat delta into the correct 4-way split counter, keeping
 * legacy `totalRevenueMinor` in lockstep. This is the SOLE place where the
 * (commissionable, paymentType) → counter name routing is defined.
 *
 * Routing rule (Phase 2 §7.6):
 *   commissionable=true,  paymentType="deposit"  → totalCommissionableDepositRevenueMinor
 *   commissionable=true,  paymentType=anything else → totalCommissionableFinalRevenueMinor
 *   commissionable=false, paymentType="deposit"  → totalNonCommissionableDepositRevenueMinor
 *   commissionable=false, paymentType=anything else → totalNonCommissionableFinalRevenueMinor
 *
 * Every call produces exactly ONE ctx.db.patch (via updateTenantStats), which
 * touches all the relevant counters atomically.
 */
export async function applyPaymentStatsDelta(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  delta: PaymentStatsDelta,
): Promise<void> {
  const splitKey: TenantStatsField = delta.commissionable
    ? delta.paymentType === "deposit"
      ? "totalCommissionableDepositRevenueMinor"
      : "totalCommissionableFinalRevenueMinor"
    : delta.paymentType === "deposit"
      ? "totalNonCommissionableDepositRevenueMinor"
      : "totalNonCommissionableFinalRevenueMinor";

  await updateTenantStats(ctx, tenantId, {
    [splitKey]: delta.amountMinorDelta,
    // `totalPaymentRecords` is incremented by ±1 for ±amountMinorDelta.
    // Dispute reversal re-uses this with a negative amount → count decrements.
    totalPaymentRecords: Math.sign(delta.amountMinorDelta),
    // Legacy combined total — kept in lockstep for rollout compat. Removed in
    // a follow-up once every consumer has switched to the split counters.
    totalRevenueMinor: delta.amountMinorDelta,
    ...(delta.wonDealDelta ? { wonDeals: delta.wonDealDelta } : {}),
    ...(delta.activeOpportunityDelta
      ? { activeOpportunities: delta.activeOpportunityDelta }
      : {}),
  });
}
```

**Step 5: Typecheck**

```bash
pnpm tsc --noEmit
```

The expected error surface is zero. If the compiler complains that `TenantStatsField` doesn't include the new keys, re-check Step 2 (the field list extension). If it complains about `[splitKey]: delta.amountMinorDelta` being a wider type than `number | undefined`, wrap the call:

```typescript
const patch: TenantStatsDelta = {
  [splitKey]: delta.amountMinorDelta,
  // ...
};
await updateTenantStats(ctx, tenantId, patch);
```

**Key implementation notes:**
- **Single `ctx.db.patch` per call.** `updateTenantStats` does one patch for all keys in its delta; `applyPaymentStatsDelta` passes one combined delta, so one patch lands. Do NOT call `updateTenantStats` four times — that would multiply the transaction-write budget for no reason.
- **`Math.sign()` not `amountMinorDelta > 0 ? 1 : -1`.** They behave identically for non-zero inputs, but `Math.sign(0) === 0`, which is what we want if someone ever passes a zero delta (no-op rather than a decrement).
- **`splitKey` is computed from `(commissionable, paymentType)`, not `origin`.** This is intentional — the routing logic must match the schema invariant, and `paymentType` is the authoritative dimension. Two separate `commissionable` payments both originating from `closer_meeting` can route to different counters if one is `deposit` and the other is `pif`.
- **`PaymentStatsDelta` is imported, not re-exported.** Phase 4's write paths will import `{ applyPaymentStatsDelta, PaymentStatsDelta }` from `tenantStatsHelper`. The `PaymentType` import from `paymentHelpers` is a circular-dependency risk only if `paymentHelpers.ts` imports from `tenantStatsHelper.ts` — currently it imports `updateTenantStats` (line 4 of the existing file), so **this edit introduces a new import edge `tenantStatsHelper → paymentHelpers`** which creates a cycle. Resolve by either:
  - **Option A (recommended):** Move `PaymentType` into its own tiny file `convex/lib/paymentTypes.ts` and have both helpers import from there.
  - **Option B:** Inline the literal union in `PaymentStatsDelta` (`paymentType: "monthly" | "split" | "pif" | "deposit"`). Works but duplicates the source of truth.
  - **Option C:** Type-only import — TypeScript's `import type` can sometimes break cycles; confirm by running `pnpm tsc --noEmit` and checking for the cycle warning.

  **Decision:** Use **Option A**. Create `convex/lib/paymentTypes.ts` exporting `CommissionableOrigin`, `NonCommissionableOrigin`, `PaymentType`, and `AssertablePaymentShape`; have `paymentHelpers.ts` re-export the first three (for backwards compat with Phase 4 callers that already import from `paymentHelpers`). This keeps the cycle broken and the public import path stable. Amend Subphase 3A's Step 1 accordingly.

- **The legacy `totalRevenueMinor` stays required in the schema.** `applyPaymentStatsDelta` always passes an `amountMinorDelta` for it, so every payment write keeps it current. The day we drop it, this function is the only place that needs to change.
- **Don't let `wonDealDelta` / `activeOpportunityDelta` be 0.** The `...(delta.wonDealDelta ? ...)` spread skips 0 and `undefined` alike; `updateTenantStats` also skips 0, so this is belt-and-suspenders correct.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/tenantStatsHelper.ts` | Modify | Widen `TenantStatsDelta` with 4 new optional fields; extend `TENANT_STATS_FIELDS`; append `PaymentStatsDelta` type + `applyPaymentStatsDelta` function. |
| `convex/lib/paymentTypes.ts` | Create | New tiny file exporting `CommissionableOrigin`, `NonCommissionableOrigin`, `PaymentType`, `AssertablePaymentShape`. Breaks potential import cycle between paymentHelpers and tenantStatsHelper. |
| `convex/lib/paymentHelpers.ts` | Modify | Re-export types from `paymentTypes.ts` so existing / planned callers can keep importing from `paymentHelpers`. (Amends Subphase 3A to use `paymentTypes.ts` as the source of truth.) |

---

### 3C — `executeConversion`: Resolve Program from the Winning Payment

**Type:** Backend
**Parallelizable:** Yes — independent of 3A and 3B. Depends only on Phase 2's schema.

**What:** Rewrite `convex/customers/conversion.ts::executeConversion` to:
1. Drop the `programType?: string` arg from the function signature.
2. Remove the `eventTypeConfig.displayName` fallback (lines 78–85 of current file).
3. Query `paymentRecords` by `by_opportunityId` to locate the winning payment (latest row).
4. Resolve `program = await ctx.db.get(winningPayment.programId)` and validate tenant ownership.
5. Insert the customer with `programId` + `programName` (instead of `programType`).
6. Throw domain-specific errors when the winning payment or program is missing.

**Why:** The design (§8.3) removes the ambiguous `programType` freeform string in favor of a canonical foreign key. Conversion is the single point where `customers.programId` is set, so this is where the canonical resolution must happen — reading from the winning payment ensures the customer row's program matches the exact program the closer selected when logging the winning payment. The old fallback to `eventTypeConfig.displayName` was structurally wrong (event type config is about meeting geometry, not programs) and inconsistently filled.

The query `.order("desc").first()` returns the most recently-recorded payment on the winning opportunity. In the current architecture, that IS the winning payment — when `logPayment` transitions the opportunity to `payment_received`, it writes the only payment on that opportunity. Future multi-payment opportunities (installments inside one opp) would carry the same `programId` on every row, so reading any of them yields the same program.

**Where:**
- `convex/customers/conversion.ts` (modify)

**How:**

**Step 1: Update the function signature and early block**

**Before:**

```typescript
// Path: convex/customers/conversion.ts (BEFORE — lines 17-37)
export async function executeConversion(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
    convertedByUserId: Id<"users">;
    winningOpportunityId: Id<"opportunities">;
    winningMeetingId?: Id<"meetings">;
    programType?: string;
    notes?: string;
  },
): Promise<Id<"customers"> | null> {
  const {
    tenantId,
    leadId,
    convertedByUserId,
    winningOpportunityId,
    winningMeetingId,
    programType,
    notes,
  } = args;
```

**After:**

```typescript
// Path: convex/customers/conversion.ts (AFTER)
export async function executeConversion(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
    convertedByUserId: Id<"users">;
    winningOpportunityId: Id<"opportunities">;
    winningMeetingId?: Id<"meetings">;
    // REMOVED: programType?: string — resolved from the winning payment now.
    notes?: string;
  },
): Promise<Id<"customers"> | null> {
  const {
    tenantId,
    leadId,
    convertedByUserId,
    winningOpportunityId,
    winningMeetingId,
    notes,
  } = args;
```

**Step 2: Remove the `eventTypeConfig.displayName` fallback (lines 78–85)**

Delete the entire block:

```typescript
// Path: convex/customers/conversion.ts (DELETE — lines 78-85)
  // 5. Resolve program type from event type config if not provided
  let resolvedProgramType = programType;
  if (!resolvedProgramType && opportunity.eventTypeConfigId) {
    const config = await ctx.db.get(opportunity.eventTypeConfigId);
    if (config) {
      resolvedProgramType = config.displayName ?? undefined;
    }
  }
```

**Step 3: Insert the new winning-payment → program resolution block**

In place of the deleted block, insert:

```typescript
// Path: convex/customers/conversion.ts (INSERT — replaces deleted block)

  // 5. Resolve the canonical program from the winning payment.
  // Every Phase 4 payment carries `programId` (required on the schema), so the
  // winning payment's `programId` is the authoritative source for the
  // customer's program. `.order("desc").first()` returns the most recently
  // recorded payment on the opportunity — in today's architecture that IS the
  // sole winning payment (logPayment transitions to payment_received on the
  // first insert). Future multi-payment opportunities carry the same
  // `programId` on every row, so any payment yields the same program.
  const winningPayment = await ctx.db
    .query("paymentRecords")
    .withIndex("by_opportunityId", (q) =>
      q.eq("opportunityId", winningOpportunityId),
    )
    .order("desc")
    .first();

  if (!winningPayment) {
    throw new Error(
      "Cannot convert lead to customer: no payment found on winning opportunity",
    );
  }

  const program = await ctx.db.get(winningPayment.programId);
  if (!program || program.tenantId !== tenantId) {
    throw new Error("Program not found on winning payment");
  }
```

**Step 4: Update the customer insert to use `programId` + `programName`**

**Before:**

```typescript
// Path: convex/customers/conversion.ts (BEFORE — lines 89-107)
  // 6. Create customer record with denormalized lead data
  const customerId = await ctx.db.insert("customers", {
    tenantId,
    leadId,
    fullName: lead.fullName ?? lead.email,
    email: lead.email,
    phone: lead.phone,
    socialHandles: lead.socialHandles,
    convertedAt: now,
    convertedByUserId,
    winningOpportunityId,
    winningMeetingId,
    programType: resolvedProgramType,
    notes,
    status: "active",
    totalPaidMinor: 0,
    totalPaymentCount: 0,
    createdAt: now,
  });
```

**After:**

```typescript
// Path: convex/customers/conversion.ts (AFTER)
  // 6. Create customer record with denormalized lead data + canonical program.
  const customerId = await ctx.db.insert("customers", {
    tenantId,
    leadId,
    fullName: lead.fullName ?? lead.email,
    email: lead.email,
    phone: lead.phone,
    socialHandles: lead.socialHandles,
    convertedAt: now,
    convertedByUserId,
    winningOpportunityId,
    winningMeetingId,
    // REPLACED: programType — now resolved from the winning payment as a
    // canonical FK + denormalized display cache.
    programId: program._id,
    programName: program.name,
    notes,
    status: "active",
    totalPaidMinor: 0,
    totalPaymentCount: 0,
    createdAt: now,
  });
```

**Step 5: Add a log line for observability**

Right after the customer insert (existing line 109 area), extend the log:

```typescript
// Path: convex/customers/conversion.ts (MODIFY — existing log line)
  console.log("[Customer] Customer created", {
    customerId,
    leadId,
    winningOpportunityId,
    // NEW — so the log shows which program was pinned at conversion.
    programId: program._id,
    programName: program.name,
  });
```

**Step 6: Verify the rest of the function is untouched**

The remaining steps (lead transition, `updateTenantStats`, domain events, payment backfill, customer summary sync) don't reference `programType` and don't need changes. Confirm by grepping within the file:

```bash
grep -n "programType" convex/customers/conversion.ts  # → zero hits expected
```

**Step 7: Typecheck**

```bash
pnpm tsc --noEmit
```

Expected surface: one or two call-site errors in `convex/customers/mutations.ts::convertLeadToCustomer` (still passes `programType` to the now-argless function). Subphase 3D fixes those in the same merge.

**Key implementation notes:**
- **Order of validation matters.** The existing function already validates the opportunity (step 4, lines 70–76) BEFORE the program lookup. Keep that order — a missing opportunity should error before a missing payment, because the opportunity check's error message is more actionable ("winning opportunity does not belong to this lead" vs. "no payment found").
- **`order("desc")` uses `_creationTime`, not `recordedAt`.** Convex's default ordering sorts by `_creationTime` unless an index is specified. `recordedAt` is a denormalized field that usually equals `_creationTime` but can drift for backfilled rows. For MVP this is fine (all payments are created via Convex mutations, so `_creationTime ≈ recordedAt`). If we later backfill historical payments with different `recordedAt` values, switch to an indexed `order("desc")` over a dedicated `by_opportunityId_and_recordedAt` index (not in this phase).
- **"No payment found" vs. "payment_received" status check.** The caller (`convertLeadToCustomer`) already validates `opportunity.status === "payment_received"` before calling `executeConversion`, so the "no payment" branch is practically unreachable when conversion fires after a successful `logPayment`. But the branch is defensive — an admin calling `convertLeadToCustomer` after manually flipping an opportunity's status (not possible in the UI but possible via direct DB writes) would hit this error.
- **`program.archivedAt` is NOT checked here.** A customer can be converted even when the program has been archived between when the winning payment was logged and when the conversion runs (e.g., admin archived the program, then an auto-conversion fires later). Archiving a program doesn't invalidate historical payments — it only prevents NEW payments from landing on it. `requireActiveProgram` is the write-side guard; conversion is a read-and-resolve operation.
- **Does auto-conversion still work?** The auto-conversion path in `convex/closer/payments.ts::logPayment` calls `executeConversion` right after inserting the winning payment. Phase 4 rewrites `logPayment` — it will continue to omit `programType` (already does; always passed `undefined` because the current code doesn't plumb it). So dropping the arg is a no-op for the auto-conversion caller.
- **Does manual admin conversion still work?** `convertLeadToCustomer` is the other caller. Subphase 3D drops `programType` there too, matching 3C's signature change.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/customers/conversion.ts` | Modify | Drop `programType` arg; replace `eventTypeConfig.displayName` fallback with winning-payment → program resolution; insert `programId` + `programName` on customers. |

---

### 3D — `convertLeadToCustomer`: Drop `programType` Arg

**Type:** Backend
**Parallelizable:** No — **depends on 3C** (the `executeConversion` signature change). Run after 3C lands.

**What:** Remove the `programType: v.optional(v.string())` arg from `convex/customers/mutations.ts::convertLeadToCustomer` and stop forwarding it to `executeConversion`.

**Why:** Phase 3C removed the arg from `executeConversion`. If 3D doesn't follow, the backend interface keeps advertising an input that no longer affects anything, and callers can drift back toward the deleted freeform-program model. The current manual-conversion UI already omits `programType`, so this is a clean contract simplification rather than a planned breakage window.

**Where:**
- `convex/customers/mutations.ts` (modify)

**How:**

**Step 1: Remove the arg from the validator**

**Before:**

```typescript
// Path: convex/customers/mutations.ts (BEFORE — lines 16-24)
export const convertLeadToCustomer = mutation({
  args: {
    leadId: v.id("leads"),
    winningOpportunityId: v.id("opportunities"),
    winningMeetingId: v.optional(v.id("meetings")),
    programType: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
```

**After:**

```typescript
// Path: convex/customers/mutations.ts (AFTER)
export const convertLeadToCustomer = mutation({
  args: {
    leadId: v.id("leads"),
    winningOpportunityId: v.id("opportunities"),
    winningMeetingId: v.optional(v.id("meetings")),
    // REMOVED: programType — resolved canonically from the winning payment.
    // The current manual-conversion UI already omits this arg.
    notes: v.optional(v.string()),
  },
```

**Step 2: Remove the forwarding to `executeConversion`**

**Before:**

```typescript
// Path: convex/customers/mutations.ts (BEFORE — lines 46-54)
    const customerId = await executeConversion(ctx, {
      tenantId,
      leadId: args.leadId,
      convertedByUserId: userId,
      winningOpportunityId: args.winningOpportunityId,
      winningMeetingId: args.winningMeetingId,
      programType: args.programType,
      notes: args.notes,
    });
```

**After:**

```typescript
// Path: convex/customers/mutations.ts (AFTER)
    const customerId = await executeConversion(ctx, {
      tenantId,
      leadId: args.leadId,
      convertedByUserId: userId,
      winningOpportunityId: args.winningOpportunityId,
      winningMeetingId: args.winningMeetingId,
      // REMOVED: programType — executeConversion resolves this from the
      // winning payment (see Phase 3C).
      notes: args.notes,
    });
```

**Step 3: Verify compilation**

```bash
pnpm tsc --noEmit
```

Expected: zero errors. If TypeScript complains about a mismatch between the Convex validator and the handler args, either the validator removal or the handler forwarding wasn't updated. Both changes are sequential in the same file so this is a single-edit sanity check.

**Step 4: Grep sweep**

```bash
grep -R "programType" convex/ app/
```

Expected output:
- `convex/schema.ts` — zero hits (Phase 2 removed the field).
- `convex/customers/conversion.ts` — zero hits (Phase 3C removed the arg and fallback).
- `convex/customers/mutations.ts` — zero hits (Phase 3D just removed the arg).
- `app/workspace/leads/**/*` — zero hits expected. The current manual-conversion dialog already omits `programType`; if any hit appears here during implementation, fix it in the same PR instead of accepting a broken preview window.

If the frontend hit list is surprising (more than 1–2 files or touches production-critical paths), flag it in the pre-Phase-4 review and decide whether to block 3D's merge on a UI fix or let it ride with a known-broken manual-conversion path for the interim.

**Key implementation notes:**
- **This is the ONLY caller of `executeConversion` besides auto-conversion.** The auto-conversion path in `logPayment` never passed `programType` (it's already `undefined` today). So once 3D lands, no backend caller references the removed arg.
- **No planned frontend breakage window.** The current manual-conversion dialog already omits `programType`. If implementation uncovers a stray frontend caller, patch it in the same change set rather than accepting a temporary runtime rejection.
- **No domain event changes.** The `customer.converted` domain event doesn't carry `programType` today, so removing it here doesn't affect activity feeds. Phase 9 adds a new `programName` badge to the activity row, but the read-side already has `customer.programName` available from 3C.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/customers/mutations.ts` | Modify | Remove `programType` arg from validator; stop forwarding to `executeConversion`. |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/lib/paymentTypes.ts` | Create | 3A (amended by 3B cycle note) |
| `convex/lib/paymentHelpers.ts` | Modify | 3A |
| `convex/lib/tenantStatsHelper.ts` | Modify | 3B |
| `convex/customers/conversion.ts` | Modify | 3C |
| `convex/customers/mutations.ts` | Modify | 3D |
