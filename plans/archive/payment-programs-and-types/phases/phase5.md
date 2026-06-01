# Phase 5 — Reporting & Read-Surface Backend Queries

**Goal:** Rewrite every read-surface and reporting query so it consumes the new `paymentRecords` shape — `attributedCloserId`, `commissionable`, `programId`, `programName`, `paymentType`, expanded `origin` enum — and produce the four-way split (commissionable × final/deposit) that the reporting UI, dashboard cards, and detail pages need. This is the last backend phase in the reporting/read-surface spine; it hard-unlocks Phases 8 and 9 and provides the final read contracts that the frontend converges on.

Seven files rewritten, one file created:

1. **`convex/reporting/lib/helpers.ts`** — new `splitPaymentsForRevenueReporting` + `RevenueSplit` / `RevenueBucket` types; `attributePaymentsToClosers` collapses to a trivial passthrough (no more DB reads).
2. **`convex/reporting/revenue.ts`** — rewritten `getRevenueMetrics` + `getRevenueDetails` signatures (new filters `programId`, `paymentType`, `revenueSlice`); returns four-way split KPIs, per-program breakdowns, payment-type breakdowns, origin breakdown scoped to commissionable origins.
3. **`convex/reporting/revenueTrend.ts`** — rewritten `getRevenueTrend` to emit four parallel series per period.
4. **`convex/reporting/remindersReporting.ts`** — broadened origin filter to include `admin_reminder`, new program / paymentType filters, final-vs-deposit split in the reminder revenue subtotal.
5. **`convex/reporting/teamPerformance.ts`** — "Cash Collected" / "Avg Deal" per closer now use **commissionable-final only**; drops the `loggedByAdminUserId` path (source field removed in Phase 4); admin-logged revenue now keyed on `recordedByUserId !== attributedCloserId`.
6. **`convex/dashboard/adminStats.ts`** — reads the four new split counters from `tenantStats`; `getTimePeriodStats` uses `splitPaymentsForRevenueReporting`; deprecates the single `revenueInPeriod` field (still returned for rollout compat).
7. **`convex/reporting/activityFeed.ts`** — surfaces `programName`, `paymentType`, `commissionable`, `attributedCloserId` on `payment.recorded` / `payment.disputed` / `payment.verified` events via the enriched domain event metadata, and extends `getActivityFeed` with optional `programId?` / `paymentType?` filters for payment-event narrowing.
8. **Read-surface queries rewritten to expose new fields:**
   - `convex/closer/meetingDetail.ts::getMeetingDetail`
   - `convex/closer/reminderDetail.ts::getReminderDetail`
   - `convex/customers/queries.ts::listCustomers` + `getCustomerDetail` (+ delete the deprecated `getCustomerTotalPaid`)
   - `convex/reviews/queries.ts::getReviewDetail`

**Prerequisites:**

- **Phase 1 merged** — `tenantPrograms` table + `ensureInitialProgramForTenant` bootstrap.
- **Phase 2 merged** — `paymentRecords` rewritten (new fields + dropped fields + new indexes `by_tenantId_and_commissionable_and_recordedAt`, `by_tenantId_and_programId_and_recordedAt`, `by_tenantId_and_paymentType_and_recordedAt`, `by_tenantId_and_attributedCloserId_and_recordedAt`); `paymentSums` re-keyed to `attributedCloserId` with the commissionable-only guard in `replacePaymentAggregate`.
- **Phase 3 merged** — `convex/lib/paymentTypes.ts` exports `CommissionableOrigin` / `NonCommissionableOrigin` / `PaymentType`; `tenantStatsHelper.ts` widened with the four split counters + `applyPaymentStatsDelta`; `convex/lib/paymentHelpers.ts` exports `assertPaymentRow` + `requireActiveProgram`.
- **Phase 4 merged** — all five payment mutations (`logPayment`, `logReminderPayment`, `recordCustomerPayment`, `createPaymentRecord`, `resolveReview` dispute branch) write the new row shape **AND** route through `applyPaymentStatsDelta`. **Without Phase 4 merged, Phase 5's reads return `undefined` for `commissionable` / `attributedCloserId` and the report math collapses to NaN.** This is the hard gate — Phase 5 is a thin veneer over Phase 4 semantics.

**Runs in PARALLEL with:** Nothing before it. Phase 5 subphases 5A, 5B, 5C, 5D, 5E can run in partial parallel (five separate files, no cross-imports at function level — only 5A's helper is consumed by 5B/5C). See Subphase Dependency Graph below.

> **Critical path:** Phase 5 is the last backend gate before the read-heavy frontend phases. Phase 6 (Settings UI) can proceed on Phase 1 alone, and Phase 7 (payment dialogs) depends on the Phase 1–4 write path work, not on these query shapes. **Phases 8 and 9 consume Phase 5's return contracts directly** — Phase 8's customer detail page reads the new `customer.programName` + enriched payment history; Phase 9's reports bind to the new KPI / trend / per-program / per-paymentType slots. If Phase 5 lands with a shape bug, Phases 8 and 9 break on mount. Ship 5 + tsc + minimal smoke tests before opening Phase 8 / 9 PRs; Phase 6 / 7 can continue in parallel.

**Skills to invoke:**

- `convex-performance-audit` — `splitPaymentsForRevenueReporting` is called twice in `revenue.ts` (once to filter, once inside the per-origin loop) and once each in `revenueTrend`, `remindersReporting`, `adminStats`. Audit that the reads before each call are bounded (already are: `getNonDisputedPaymentsInRange` takes `MAX_PAYMENT_SCAN_ROWS + 1 = 2501`). Also confirm `attributePaymentsToClosers` no longer does DB reads (the trivial passthrough is the point — any regression re-introduces O(N) lookups against `opportunities` + `customers`).
- `convex-migration-helper` — Phase 5 only reads; there is no data migration. But: the report query **return shapes change** (e.g., `getRevenueMetrics` used to return `totalRevenueMinor`; now returns `commissionable.finalRevenueMinor` + `commissionable.depositRevenueMinor` + `nonCommissionable.finalRevenueMinor` + `nonCommissionable.depositRevenueMinor`). Every frontend reader breaks at tsc. Phase 9 lands these UI changes. For the rollout window, the preview environment should have both Phase 5 and Phase 9 deployed together; production follows the single coordinated release pattern in §18.2 of the design doc.
- `web-design-guidelines` — reference only. Phase 5 produces the data shape the dashboard cards (Phase 9) render; ensure new fields have labels that map cleanly to accessible KPI cards (commissionable / non-commissionable / deposit).

**Acceptance Criteria:**

1. `convex/reporting/lib/helpers.ts` exports `RevenueBucket`, `RevenueSplit`, and `splitPaymentsForRevenueReporting`, with the exact shape documented in design §9.2. `attributePaymentsToClosers` is now a pure-map passthrough (zero `ctx.db` reads).
2. `getRevenueMetrics` accepts `programId?`, `paymentType?`, `revenueSlice?` filter args; returns `{ commissionable: { finalRevenueMinor, depositRevenueMinor, totalDeals, avgDealMinor, byOrigin, byCloser, byProgram }, nonCommissionable: { finalRevenueMinor, depositRevenueMinor, totalDeals, byProgram }, byPaymentType, isPaymentDataTruncated }`. The `byOrigin` record keys exactly match `COMMISSIONABLE_ORIGINS` (`closer_meeting`, `closer_reminder`, `admin_meeting`, `admin_reminder`, `admin_review_resolution`) — no `customer_flow` / `customer_direct` / `unknown` keys.
3. `getRevenueDetails` returns `topDeals` scoped to commissionable-final only (deposits never appear in the top-deals list because they're tracked separately). The row shape drops `provider` (field removed in Phase 2); keeps `programName`, `paymentType`, `commissionable` for the UI to render badges.
4. `getRevenueTrend` emits four series keyed per period: `commissionableFinalMinor`, `commissionableDepositMinor`, `nonCommissionableFinalMinor`, `nonCommissionableDepositMinor`. Accepts the same `programId` / `paymentType` / `revenueSlice` filters as `getRevenueMetrics`.
5. `getReminderOutcomeFunnel` pages `paymentRecords` via TWO origin buckets (`closer_reminder` + `admin_reminder`) using the existing `by_tenantId_and_origin_and_recordedAt` index, merges them into a single reminder-revenue list, applies optional `programId` / `paymentType` filters, and returns split `reminderDrivenFinalRevenueMinor` + `reminderDrivenDepositRevenueMinor` (with `reminderDrivenRevenueMinor` kept as the sum for rollout compat). Includes a `console.warn` sanity assertion that `split.nonCommissionable.finalPayments.length === 0` (reminders are always commissionable — if any slipped through, the data is wrong).
6. `getTeamPerformanceMetrics` per-closer `cashCollectedMinor` = `splitPaymentsForRevenueReporting` `commissionable.finalPayments` filtered by `attributedCloserId === closer._id`; `adminLoggedRevenueMinor` = commissionable-final where `recordedByUserId !== attributedCloserId` (admin-on-behalf). No `loggedByAdminUserId` reference anywhere in the file — field was deleted from the schema in Phase 2. Team-level new field `postConversionRevenueMinor` = `nonCommissionable.finalRevenueMinor`.
7. `getAdminDashboardStats` returns `revenueLogged` = `stats.totalCommissionableFinalRevenueMinor / 100` (was `stats.totalRevenueMinor / 100`); new fields `postConversionRevenueLogged`, `depositsCollected`, `postConversionDepositsLogged`. `totalRevenue` kept as the sum of all four (rollout compat).
8. `getTimePeriodStats` returns `closedWonInPeriod`, `depositsInPeriod`, `postConversionInPeriod`, `postConversionDepositsInPeriod` (all minor→major converted); `revenueInPeriod` remains as the sum of all four.
9. `getMeetingDetail` returns the enriched payment array with `programName`, `paymentType`, `commissionable`, `attributedCloserId`, `attributedCloserName`, `recordedByUserId`, `recordedByName` populated from the new schema. `closerId` / `closerName` are renamed to `attributedCloserId` / `attributedCloserName` consistently (frontend breakpoint — Phase 7/8 land the UI rename).
10. `getReminderDetail` returns the same enriched payment fields as `getMeetingDetail` (program, payment type, commissionable, attribution).
11. `getReviewDetail` `paymentRecords` rows include `programName`, `paymentType`, `commissionable`, `attributedCloserId`, `recordedByUserId` — the review card in Phase 9 renders the audit row with proper attribution + program badges.
12. `listCustomers` + `getCustomerDetail` expose `customer.programName` (denormalized field added to the `customers` schema in Phase 2). `getCustomerDetail` returns payments enriched with `programName`, `paymentType`, `commissionable`, `attributedCloserId` (always `undefined` for customer-direct, but kept for consistency); the deprecated `getCustomerTotalPaid` is deleted.
13. `getActivityFeed` and `getActivitySummary` stay backwards-compatible for existing consumers: `event.metadata` remains the parsed metadata object, now enriched for `payment.recorded` / `payment.disputed` / `payment.verified` events with `{ programId, programName, paymentType, commissionable, attributedCloserId, originCategory }`. `getActivityFeed` also accepts optional `programId?` / `paymentType?` filters for payment-event narrowing, and may add an additive `paymentMetadata` convenience field for payment events so Phase 9 has a typed badge payload without having to re-narrow `metadata` at every call site.
14. `pnpm tsc --noEmit` passes with zero errors. Grep confirms:
    - Zero references to `payment.closerId` in `convex/reporting/**`, `convex/dashboard/**`, `convex/closer/**`, `convex/customers/**`, `convex/reviews/**`.
    - Zero references to `payment.loggedByAdminUserId` anywhere in the codebase.
    - Zero references to `payment.provider` outside `convex/schema.ts` backup comments (if any).
    - Zero references to the literal `"customer_flow"` (deprecated origin; renamed to `customer_direct` in Phase 2).
15. Smoke test (per `TESTING.MD`): with a tenant that has one program seeded (`Launchpad`), book one test invitee, start the meeting, submit one commissionable PIF payment, one commissionable deposit, and one admin-recorded customer-direct payment (after conversion). Open `/workspace/reports/revenue`, the workspace dashboard, the meeting detail page, and the customer detail page → every surface shows the payment with correct program name, payment type, commissionable badge, and attribution. Revenue KPIs show the PIF in Closed-Won, the deposit in Deposits, the customer-direct in Post-Conversion Revenue. No NaN, no `undefined`, no missing program name.

---

## Subphase Dependency Graph

```
5A (reporting/lib/helpers.ts)  ─┬─▶ 5B (revenue.ts + revenueTrend.ts)
                                │
                                ├─▶ 5C (remindersReporting.ts + teamPerformance.ts)
                                │
                                └─▶ 5D (adminStats.ts + activityFeed.ts)
                                           │
5E (read-surface queries)  ────────────────┘  (independent of 5A-D; can start in parallel)

Phase 5 complete ─▶ Phase 6 (Settings UI — parallel)
                  ─▶ Phase 7 (Payment Dialogs — parallel)
                  ─▶ Phase 8 (Customer read-surface UI — parallel)
                  ─▶ Phase 9 (Reporting UI — parallel)
```

**Edges explained:**

- **5A → 5B/5C/5D**: The `splitPaymentsForRevenueReporting` helper lives in 5A's file and is imported by every consumer. 5A must land before 5B, 5C, 5D compile. (5A is a small, self-contained change; one person can bang it out in an hour.)
- **5E parallel with all**: `getMeetingDetail`, `getReminderDetail`, `getCustomerDetail`, `getReviewDetail` just map new payment fields into their return shape. No dependency on the reporting helper. Different files, different concerns.

**Optimal execution:**

1. **Sprint 5A first** (serial gate, ~1 hour): Write the helper, the types, and the `attributePaymentsToClosers` passthrough replacement in one PR. Merge + tsc. This unblocks 5B/5C/5D.
2. **After 5A merges, start 5B + 5C + 5D + 5E in parallel** — four streams, four owners (or one dev serial). 5B is the largest (revenue.ts + revenueTrend.ts, ~400 LOC of changes). 5C is medium (remindersReporting.ts revenue scan + teamPerformance.ts attribution rewrite). 5D is small (adminStats.ts field-rename + activityFeed.ts passthrough). 5E is four small read-surface rewrites (meetingDetail, reminderDetail, customers/queries, reviews/queries).
3. **After all land, run `tsc --noEmit` + the grep sweep + smoke test.** No frontend phase should open a PR until Phase 5's smoke test is green on a preview deployment.

**Estimated time:** 1.5 days solo, 0.75 day with three parallel streams after 5A lands.

---

## Subphases

### 5A — Reporting Helper Passthrough + Split Helper

**Type:** Backend
**Parallelizable:** No — serial gate. 5B / 5C / 5D depend on this helper.

**What:** Rewrite `convex/reporting/lib/helpers.ts` to:
- Keep `AttributedPayment` as an alias (type compatibility for existing consumers) but redefine `effectiveCloserId` as `attributedCloserId ?? null` (was: derived from opportunity/customer owner).
- Collapse `attributePaymentsToClosers` into a trivial passthrough that does **zero DB reads**.
- Introduce new types: `RevenueBucket`, `RevenueSplit`.
- Introduce `splitPaymentsForRevenueReporting` — the single source of truth for "bucket payments by commissionable × final/deposit."
- Keep `summarizeAttributedPayments` for backwards compat with the Phase 4 intermediate state (it still counts deals + sums revenue keyed on `effectiveCloserId`), but it now receives filtered arrays from `splitPaymentsForRevenueReporting` instead of raw payments.

Leave `getUserDisplayName`, `getActiveClosers`, `assertValidDateRange`, `makeDateBounds`, `makeTupleDateBounds`, `getNonDisputedPaymentsInRange` unchanged — they're shared with team-outcomes / meeting-time reports that have no payment semantics to change.

**Why:** This is the lynchpin. Every downstream consumer (5B, 5C, 5D) converges on one helper so "commissionable vs. non-commissionable" and "final vs. deposit" mean the same thing across the dashboard, revenue report, reminder report, team report, and activity feed. Previously, revenue totals were computed five different ways in five different files; ambiguity at the field level let bugs slip through (e.g., `opportunities.find(o => o._id === payment.opportunityId)?.assignedCloserId ?? payment.closerId` — multiply that by five files and you get five subtly-different attribution rules). One helper, one rule.

**Where:**
- `convex/reporting/lib/helpers.ts` (modify)

**How:**

**Step 1: Update imports (top of file)**

Before (lines 1–9):

```typescript
// Path: convex/reporting/lib/helpers.ts (BEFORE)
import type { Value } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";

const MAX_PAYMENT_SCAN_ROWS = 2500;

export type AttributedPayment = Doc<"paymentRecords"> & {
  effectiveCloserId: Id<"users"> | null;
};
```

After:

```typescript
// Path: convex/reporting/lib/helpers.ts (AFTER)
import type { Value } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";

const MAX_PAYMENT_SCAN_ROWS = 2500;

/**
 * Payment enriched with the attribution resolution used by reporting code.
 * After Phase 5, `effectiveCloserId` is always `attributedCloserId ?? null` —
 * attribution is authoritative at write time (Phase 4). The type is kept for
 * backwards compatibility with existing call sites; new code should prefer
 * the raw `attributedCloserId` field directly.
 */
export type AttributedPayment = Doc<"paymentRecords"> & {
  effectiveCloserId: Id<"users"> | null;
};

/**
 * A bucket of payments pre-split into final (non-deposit) vs. deposit,
 * with running subtotals. Returned by `splitPaymentsForRevenueReporting`.
 */
export type RevenueBucket = {
  allPayments: Array<AttributedPayment>;
  finalPayments: Array<AttributedPayment>;
  depositPayments: Array<AttributedPayment>;
  finalRevenueMinor: number;
  depositRevenueMinor: number;
};

/**
 * The 2×2 split produced by `splitPaymentsForRevenueReporting`:
 * commissionable vs. non-commissionable, each broken into final vs. deposit.
 * Non-disputed rows only (disputed rows are filtered at the top).
 */
export type RevenueSplit = {
  filteredPayments: Array<AttributedPayment>;
  commissionable: RevenueBucket;
  nonCommissionable: RevenueBucket;
};
```

**Step 2: Replace `attributePaymentsToClosers` with the passthrough**

Before (lines 90–159) — the whole block that does `Promise.all` lookups on opportunities and customers:

```typescript
// Path: convex/reporting/lib/helpers.ts (BEFORE — DELETE THIS ENTIRE BLOCK)
/**
 * Payment rows are currently keyed by the recording user, which can be an admin.
 * For closer reports, attribute payments to the opportunity/customer owner instead.
 */
export async function attributePaymentsToClosers(
  ctx: QueryCtx,
  payments: Array<Doc<"paymentRecords">>,
): Promise<Array<AttributedPayment>> {
  if (payments.length === 0) {
    return [];
  }

  const opportunityIds = [
    /* ... Promise.all ... */
  ];
  const customerIds = [
    /* ... Promise.all ... */
  ];

  const [opportunities, customers] = await Promise.all([
    /* ... ctx.db.get ... */
  ]);

  const opportunityById = new Map<Id<"opportunities">, Doc<"opportunities"> | null>(opportunities);
  const customerById = new Map<Id<"customers">, Doc<"customers"> | null>(customers);

  return payments.map((payment) => {
    if (payment.contextType === "opportunity" && payment.opportunityId) {
      const effectiveCloserId =
        opportunityById.get(payment.opportunityId)?.assignedCloserId ??
        payment.closerId;
      return { ...payment, effectiveCloserId: effectiveCloserId ?? null };
    }

    if (payment.contextType === "customer" && payment.customerId) {
      const effectiveCloserId =
        customerById.get(payment.customerId)?.convertedByUserId ??
        payment.closerId;
      return { ...payment, effectiveCloserId: effectiveCloserId ?? null };
    }

    return { ...payment, effectiveCloserId: payment.closerId ?? null };
  });
}
```

After — trivial passthrough, no DB reads:

```typescript
// Path: convex/reporting/lib/helpers.ts (AFTER)
/**
 * Attribution is authoritative at write time (Phase 4 — `logPayment`,
 * `logReminderPayment`, `recordCustomerPayment`, `createPaymentRecord` all
 * resolve `attributedCloserId` before insert via `assertPaymentRow`'s
 * invariant I5). This helper is kept for backwards compatibility with call
 * sites that expect the `AttributedPayment` shape, but performs zero DB
 * reads.
 *
 * New code should prefer reading `payment.attributedCloserId` directly and
 * using `splitPaymentsForRevenueReporting` for final-vs-deposit semantics.
 */
export async function attributePaymentsToClosers(
  _ctx: QueryCtx,
  payments: Array<Doc<"paymentRecords">>,
): Promise<Array<AttributedPayment>> {
  return payments.map((payment) => ({
    ...payment,
    effectiveCloserId: payment.attributedCloserId ?? null,
  }));
}

/**
 * Split payments into the 2×2 matrix of (commissionable × final/deposit).
 * Disputed rows are filtered at the top so no consumer ever needs to
 * re-check `status` after calling this helper.
 *
 * Invariants (enforced by `assertPaymentRow` at write time):
 * - commissionable: true  ⇔  attributedCloserId !== undefined
 * - paymentType is one of: "monthly" | "split" | "pif" | "deposit"
 * - deposit is always non-final; everything else is final
 */
export function splitPaymentsForRevenueReporting(
  payments: Array<Doc<"paymentRecords">>,
): RevenueSplit {
  const filteredPayments = payments
    .filter((p) => p.status !== "disputed")
    .map<AttributedPayment>((p) => ({
      ...p,
      effectiveCloserId: p.attributedCloserId ?? null,
    }));

  return {
    filteredPayments,
    commissionable: bucket(filteredPayments.filter((p) => p.commissionable)),
    nonCommissionable: bucket(filteredPayments.filter((p) => !p.commissionable)),
  };
}

function bucket(subset: Array<AttributedPayment>): RevenueBucket {
  const finalPayments = subset.filter((p) => p.paymentType !== "deposit");
  const depositPayments = subset.filter((p) => p.paymentType === "deposit");
  return {
    allPayments: subset,
    finalPayments,
    depositPayments,
    finalRevenueMinor: finalPayments.reduce((s, p) => s + p.amountMinor, 0),
    depositRevenueMinor: depositPayments.reduce((s, p) => s + p.amountMinor, 0),
  };
}
```

**Step 3: Keep `summarizeAttributedPayments` but document the new usage**

This function stays unchanged in implementation (it counts deals + sums revenue keyed on `effectiveCloserId`), but the docstring makes the new expectation explicit: callers should pass in a *pre-filtered* array from `splitPaymentsForRevenueReporting` (usually `split.commissionable.finalPayments`), not raw payments. Update the comment block above the function:

```typescript
// Path: convex/reporting/lib/helpers.ts (docstring UPDATED; body unchanged)
/**
 * Summarize an array of attributed payments into a per-closer map.
 *
 * **Important:** This function does NOT filter by commissionable flag,
 * paymentType, or status. Callers should pass in a pre-filtered list from
 * `splitPaymentsForRevenueReporting` (typically `split.commissionable.finalPayments`
 * for the "Cash Collected" style metric). Passing raw payments will produce
 * nonsensical totals that mix commissionable and non-commissionable revenue.
 */
export function summarizeAttributedPayments(
  payments: Array<AttributedPayment>,
): {
  byCloser: Map<Id<"users">, { dealCount: number; revenueMinor: number }>;
  totalDealCount: number;
  totalRevenueMinor: number;
} {
  // body unchanged
  /* ... */
}
```

**Acceptance for 5A:**
- `attributePaymentsToClosers` body contains zero `ctx.db.` calls.
- `splitPaymentsForRevenueReporting` compiles with `Doc<"paymentRecords">` (so any `commissionable` / `paymentType` / `attributedCloserId` type mismatch surfaces at this seam).
- `pnpm tsc --noEmit` passes.

---

### 5B — Revenue Query Rewrite (`revenue.ts` + `revenueTrend.ts`)

**Type:** Backend
**Parallelizable:** Yes, after 5A merges. Owns `convex/reporting/revenue.ts` and `convex/reporting/revenueTrend.ts`.

**What:** Rewrite `getRevenueMetrics`, `getRevenueDetails`, and `getRevenueTrend` to:
- Accept new filter args `programId`, `paymentType`, `revenueSlice`.
- Route rows through `splitPaymentsForRevenueReporting`.
- Return a **four-way split** headline: `commissionable.finalRevenueMinor`, `commissionable.depositRevenueMinor`, `nonCommissionable.finalRevenueMinor`, `nonCommissionable.depositRevenueMinor`.
- Expose new per-program and per-payment-type breakdowns.
- Trim `byOrigin` to commissionable origins only (non-commissionable origins are represented in the non-commissionable program breakdown instead).

**Why:** Two reasons. First, the legacy `getRevenueMetrics` rolled all payments into a single total revenue figure that mixed closer commission revenue with customer-direct revenue — incorrect for every consumer that needs to see "how much commission is owed this month." Second, the existing `byOrigin` breakdown includes `customer_flow` (now `customer_direct`) which is, by definition, a non-commissionable origin; treating it as a revenue-bearing origin at the same level as `closer_meeting` was category-confused. The rewrite splits these cleanly.

**Where:**
- `convex/reporting/revenue.ts` (modify)
- `convex/reporting/revenueTrend.ts` (modify)

**How:**

**Step 1: Rewrite `getRevenueMetrics` in `convex/reporting/revenue.ts`**

Before (full file is 199 lines; key change is the handler, lines 30–112):

```typescript
// Path: convex/reporting/revenue.ts (BEFORE, handler body)
export const getRevenueMetrics = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, { startDate, endDate }) => {
    assertValidDateRange(startDate, endDate);
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    const closers = await getActiveClosers(ctx, tenantId);
    const paymentScan = await getNonDisputedPaymentsInRange(ctx, tenantId, startDate, endDate);
    const attributedPayments = await attributePaymentsToClosers(ctx, paymentScan.payments);
    const paymentSummary = summarizeAttributedPayments(attributedPayments);
    const byOrigin = Object.fromEntries(
      REVENUE_ORIGINS.map((origin) => [origin, 0]),
    ) as Record<(typeof REVENUE_ORIGINS)[number], number>;

    for (const payment of paymentScan.payments) {
      byOrigin[payment.origin ?? "unknown"] += payment.amountMinor;
    }

    const byCloser = closers.map(/* ... */);
    const totalRevenueMinor = byCloser.reduce(/* ... */);
    const totalDeals = byCloser.reduce(/* ... */);

    return {
      totalRevenueMinor,
      totalDeals,
      avgDealMinor: /* ... */,
      byOrigin,
      byCloser: /* ... */,
      excludedRevenueMinor: paymentSummary.totalRevenueMinor - totalRevenueMinor,
      excludedDealCount: paymentSummary.totalDealCount - totalDeals,
      isPaymentDataTruncated: paymentScan.isTruncated,
    };
  },
});
```

After — new filter args, new return shape:

```typescript
// Path: convex/reporting/revenue.ts (AFTER)
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import {
  assertValidDateRange,
  getActiveClosers,
  getNonDisputedPaymentsInRange,
  getUserDisplayName,
  splitPaymentsForRevenueReporting,
} from "./lib/helpers";

// Only commissionable origins are surfaced in the byOrigin breakdown.
// Non-commissionable origins (customer_direct, bookkeeper_direct) are
// surfaced via the byProgram breakdown in the nonCommissionable bucket.
const COMMISSIONABLE_ORIGINS = [
  "closer_meeting",
  "closer_reminder",
  "admin_meeting",
  "admin_reminder",
  "admin_review_resolution",
] as const satisfies ReadonlyArray<
  // ensures exhaustiveness with the schema literals
  | "closer_meeting"
  | "closer_reminder"
  | "admin_meeting"
  | "admin_reminder"
  | "admin_review_resolution"
>;

const DEAL_SIZE_BUCKETS = {
  over10k: { count: 0, label: "$10k+" },
  to10k: { count: 0, label: "$5k - $9,999" },
  to5k: { count: 0, label: "$2k - $4,999" },
  to2k: { count: 0, label: "$500 - $1,999" },
  under500: { count: 0, label: "Under $500" },
} as const;

const PAYMENT_TYPE_FILTER = v.union(
  v.literal("monthly"),
  v.literal("split"),
  v.literal("pif"),
  v.literal("deposit"),
);
const REVENUE_SLICE_FILTER = v.union(
  v.literal("commissionable"),
  v.literal("non_commissionable"),
);

export const getRevenueMetrics = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
    programId: v.optional(v.id("tenantPrograms")),
    paymentType: v.optional(PAYMENT_TYPE_FILTER),
    revenueSlice: v.optional(REVENUE_SLICE_FILTER),
  },
  handler: async (ctx, args) => {
    assertValidDateRange(args.startDate, args.endDate);
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const closers = await getActiveClosers(ctx, tenantId);
    const scan = await getNonDisputedPaymentsInRange(
      ctx,
      tenantId,
      args.startDate,
      args.endDate,
    );

    // Apply filters in-memory on the bounded scan.
    const rows = scan.payments.filter(
      (p) =>
        (!args.programId || p.programId === args.programId) &&
        (!args.paymentType || p.paymentType === args.paymentType) &&
        (!args.revenueSlice ||
          (args.revenueSlice === "commissionable") === p.commissionable),
    );
    const split = splitPaymentsForRevenueReporting(rows);

    // === Per-closer breakdown — commissionable FINAL only ===
    const byCloserMap = new Map<Id<"users">, { dealCount: number; revenueMinor: number }>();
    for (const p of split.commissionable.finalPayments) {
      if (!p.attributedCloserId) continue;
      const existing = byCloserMap.get(p.attributedCloserId) ?? { dealCount: 0, revenueMinor: 0 };
      existing.dealCount += 1;
      existing.revenueMinor += p.amountMinor;
      byCloserMap.set(p.attributedCloserId, existing);
    }
    const byCloser = closers
      .map((closer) => {
        const stats = byCloserMap.get(closer._id) ?? { dealCount: 0, revenueMinor: 0 };
        return {
          closerId: closer._id,
          closerName: getUserDisplayName(closer),
          revenueMinor: stats.revenueMinor,
          dealCount: stats.dealCount,
          avgDealMinor: stats.dealCount > 0 ? stats.revenueMinor / stats.dealCount : null,
        };
      })
      .sort(
        (left, right) =>
          right.revenueMinor - left.revenueMinor ||
          left.closerName.localeCompare(right.closerName),
      );

    // === Origin breakdown — commissionable FINAL only ===
    const byOrigin = Object.fromEntries(
      COMMISSIONABLE_ORIGINS.map((origin) => [origin, 0]),
    ) as Record<(typeof COMMISSIONABLE_ORIGINS)[number], number>;
    for (const p of split.commissionable.finalPayments) {
      // Only commissionable origins appear in split.commissionable — but
      // narrow defensively in case of bad data.
      if (p.origin in byOrigin) {
        byOrigin[p.origin as keyof typeof byOrigin] += p.amountMinor;
      }
    }

    // === Program breakdown — FINAL only, both slices tracked separately ===
    type ProgramRow = { revenueMinor: number; dealCount: number; name: string };
    const byProgramCommissionable = new Map<Id<"tenantPrograms">, ProgramRow>();
    const byProgramNonCommissionable = new Map<Id<"tenantPrograms">, ProgramRow>();

    for (const p of split.commissionable.finalPayments) {
      const row = byProgramCommissionable.get(p.programId) ?? {
        revenueMinor: 0,
        dealCount: 0,
        name: p.programName,
      };
      row.revenueMinor += p.amountMinor;
      row.dealCount += 1;
      byProgramCommissionable.set(p.programId, row);
    }
    for (const p of split.nonCommissionable.finalPayments) {
      const row = byProgramNonCommissionable.get(p.programId) ?? {
        revenueMinor: 0,
        dealCount: 0,
        name: p.programName,
      };
      row.revenueMinor += p.amountMinor;
      row.dealCount += 1;
      byProgramNonCommissionable.set(p.programId, row);
    }

    // === Payment-type breakdown — ALL payments (final + deposit), both slices ===
    const byPaymentType = {
      commissionable: { pif: 0, split: 0, monthly: 0, deposit: 0 },
      nonCommissionable: { pif: 0, split: 0, monthly: 0, deposit: 0 },
    };
    for (const p of split.commissionable.allPayments) {
      byPaymentType.commissionable[p.paymentType] += p.amountMinor;
    }
    for (const p of split.nonCommissionable.allPayments) {
      byPaymentType.nonCommissionable[p.paymentType] += p.amountMinor;
    }

    return {
      commissionable: {
        finalRevenueMinor: split.commissionable.finalRevenueMinor,
        depositRevenueMinor: split.commissionable.depositRevenueMinor,
        totalDeals: split.commissionable.finalPayments.length,
        avgDealMinor:
          split.commissionable.finalPayments.length > 0
            ? split.commissionable.finalRevenueMinor /
              split.commissionable.finalPayments.length
            : null,
        byOrigin,
        byCloser: byCloser.map((c) => ({
          ...c,
          revenuePercent:
            split.commissionable.finalRevenueMinor > 0
              ? (c.revenueMinor / split.commissionable.finalRevenueMinor) * 100
              : 0,
        })),
        byProgram: Array.from(byProgramCommissionable.entries())
          .map(([programId, v]) => ({
            programId,
            programName: v.name,
            revenueMinor: v.revenueMinor,
            dealCount: v.dealCount,
          }))
          .sort((a, b) => b.revenueMinor - a.revenueMinor),
      },
      nonCommissionable: {
        finalRevenueMinor: split.nonCommissionable.finalRevenueMinor,
        depositRevenueMinor: split.nonCommissionable.depositRevenueMinor,
        totalDeals: split.nonCommissionable.finalPayments.length,
        byProgram: Array.from(byProgramNonCommissionable.entries())
          .map(([programId, v]) => ({
            programId,
            programName: v.name,
            revenueMinor: v.revenueMinor,
            dealCount: v.dealCount,
          }))
          .sort((a, b) => b.revenueMinor - a.revenueMinor),
      },
      byPaymentType,
      isPaymentDataTruncated: scan.isTruncated,
    };
  },
});
```

**Step 2: Rewrite `getRevenueDetails` in the same file**

Before (lines 114–199) — returns `topDeals` from all non-disputed payments (mixed commissionable + non-commissionable), with `provider` field:

```typescript
// Path: convex/reporting/revenue.ts (BEFORE)
export const getRevenueDetails = query({
  args: { startDate: v.number(), endDate: v.number() },
  handler: async (ctx, { startDate, endDate }) => {
    /* ... scan ... */
    const topPayments = [...paymentScan.payments]
      .sort((l, r) => r.amountMinor - l.amountMinor || r.recordedAt - l.recordedAt)
      .slice(0, 10);
    /* ... attributePaymentsToClosers → closerDocs ... */
    return {
      topDeals: attributedTopPayments.map((payment) => ({
        paymentRecordId: payment._id,
        amountMinor: payment.amountMinor,
        closerId: payment.effectiveCloserId,
        closerName: /* ... */,
        contextType: payment.contextType,
        customerId: payment.customerId ?? null,
        meetingId: payment.meetingId ?? null,
        opportunityId: payment.opportunityId ?? null,
        provider: payment.provider, // ← field no longer exists
        recordedAt: payment.recordedAt,
      })),
      dealSizeDistribution,
      isPaymentDataTruncated: paymentScan.isTruncated,
    };
  },
});
```

After — topDeals scoped to commissionable-final, new fields for the UI to render program + payment type badges, `provider` removed:

```typescript
// Path: convex/reporting/revenue.ts (AFTER)
export const getRevenueDetails = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
    programId: v.optional(v.id("tenantPrograms")),
    paymentType: v.optional(PAYMENT_TYPE_FILTER),
    revenueSlice: v.optional(REVENUE_SLICE_FILTER),
  },
  handler: async (ctx, args) => {
    assertValidDateRange(args.startDate, args.endDate);
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const scan = await getNonDisputedPaymentsInRange(
      ctx,
      tenantId,
      args.startDate,
      args.endDate,
    );
    const rows = scan.payments.filter(
      (p) =>
        (!args.programId || p.programId === args.programId) &&
        (!args.paymentType || p.paymentType === args.paymentType) &&
        (!args.revenueSlice ||
          (args.revenueSlice === "commissionable") === p.commissionable),
    );
    const split = splitPaymentsForRevenueReporting(rows);

    // Top deals: commissionable-FINAL only. Deposits and post-conversion
    // revenue get their own sections in the UI — not the "top deals" list.
    const topPayments = [...split.commissionable.finalPayments]
      .sort((l, r) => r.amountMinor - l.amountMinor || r.recordedAt - l.recordedAt)
      .slice(0, 10);

    const closerIds = [
      ...new Set(
        topPayments
          .map((p) => p.attributedCloserId)
          .filter((id): id is Id<"users"> => id !== undefined),
      ),
    ];
    const closerDocs = await Promise.all(
      closerIds.map(async (id) => [id, await ctx.db.get(id)] as const),
    );
    const closerById = new Map(closerDocs);

    const dealSizeDistribution = {
      under500: { count: 0, label: "Under $500" as const },
      to2k: { count: 0, label: "$500 - $1,999" as const },
      to5k: { count: 0, label: "$2k - $4,999" as const },
      to10k: { count: 0, label: "$5k - $9,999" as const },
      over10k: { count: 0, label: "$10k+" as const },
    };

    // Deal-size distribution also uses commissionable-final (same as top deals).
    for (const payment of split.commissionable.finalPayments) {
      const amountDollars = payment.amountMinor / 100;
      if (amountDollars < 500) dealSizeDistribution.under500.count += 1;
      else if (amountDollars < 2000) dealSizeDistribution.to2k.count += 1;
      else if (amountDollars < 5000) dealSizeDistribution.to5k.count += 1;
      else if (amountDollars < 10000) dealSizeDistribution.to10k.count += 1;
      else dealSizeDistribution.over10k.count += 1;
    }

    return {
      topDeals: topPayments.map((payment) => ({
        paymentRecordId: payment._id,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        attributedCloserId: payment.attributedCloserId ?? null,
        attributedCloserName: getUserDisplayName(
          payment.attributedCloserId
            ? (closerById.get(payment.attributedCloserId) ?? null)
            : null,
        ),
        contextType: payment.contextType,
        customerId: payment.customerId ?? null,
        meetingId: payment.meetingId ?? null,
        opportunityId: payment.opportunityId ?? null,
        originatingOpportunityId: payment.originatingOpportunityId ?? null,
        programId: payment.programId,
        programName: payment.programName,
        paymentType: payment.paymentType,
        origin: payment.origin,
        recordedAt: payment.recordedAt,
      })),
      dealSizeDistribution,
      isPaymentDataTruncated: scan.isTruncated,
    };
  },
});
```

**Step 3: Rewrite `getRevenueTrend` in `convex/reporting/revenueTrend.ts`**

Before (the whole handler, lines 24–68) — emits one `revenueMinor` series:

```typescript
// Path: convex/reporting/revenueTrend.ts (BEFORE)
export const getRevenueTrend = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
    granularity: v.union(/* day | week | month */),
  },
  handler: async (ctx, { startDate, endDate, granularity }) => {
    /* ... scan ... */
    const trend = periods.map((period) => ({
      periodKey: period.key,
      revenueMinor: 0,  // ← single series
      dealCount: 0,
      start: period.start,
      end: period.end,
    }));
    for (const payment of paymentScan.payments) {
      const periodKey = getPeriodKey(payment.recordedAt, granularity);
      trend[index].revenueMinor += payment.amountMinor;
      trend[index].dealCount += 1;
    }
    return {
      trend: trend.map(({ start, end, ...period }) => period),
      isPaymentDataTruncated: paymentScan.isTruncated,
    };
  },
});
```

After — four parallel series + new filter args:

```typescript
// Path: convex/reporting/revenueTrend.ts (AFTER)
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import {
  assertValidDateRange,
  getNonDisputedPaymentsInRange,
  splitPaymentsForRevenueReporting,
} from "./lib/helpers";
import {
  getPeriodKey,
  getPeriodsInRange,
  type Granularity,
} from "./lib/periodBucketing";

const PAYMENT_TYPE_FILTER = v.union(
  v.literal("monthly"),
  v.literal("split"),
  v.literal("pif"),
  v.literal("deposit"),
);
const REVENUE_SLICE_FILTER = v.union(
  v.literal("commissionable"),
  v.literal("non_commissionable"),
);

type TrendBucket = {
  periodKey: string;
  commissionableFinalMinor: number;
  commissionableDepositMinor: number;
  nonCommissionableFinalMinor: number;
  nonCommissionableDepositMinor: number;
  commissionableFinalDealCount: number;
  nonCommissionableFinalDealCount: number;
};

export const getRevenueTrend = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
    granularity: v.union(
      v.literal("day"),
      v.literal("week"),
      v.literal("month"),
    ),
    programId: v.optional(v.id("tenantPrograms")),
    paymentType: v.optional(PAYMENT_TYPE_FILTER),
    revenueSlice: v.optional(REVENUE_SLICE_FILTER),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    assertValidDateRange(args.startDate, args.endDate);

    const periods = getPeriodsInRange(args.startDate, args.endDate, args.granularity);
    const trend: Array<TrendBucket> = periods.map((period) => ({
      periodKey: period.key,
      commissionableFinalMinor: 0,
      commissionableDepositMinor: 0,
      nonCommissionableFinalMinor: 0,
      nonCommissionableDepositMinor: 0,
      commissionableFinalDealCount: 0,
      nonCommissionableFinalDealCount: 0,
    }));

    if (trend.length === 0) {
      return { trend: [], isPaymentDataTruncated: false };
    }

    const indexByPeriodKey = new Map<string, number>(
      trend.map((period, index) => [period.periodKey, index]),
    );
    const scan = await getNonDisputedPaymentsInRange(
      ctx,
      tenantId,
      args.startDate,
      args.endDate,
    );
    const rows = scan.payments.filter(
      (p) =>
        (!args.programId || p.programId === args.programId) &&
        (!args.paymentType || p.paymentType === args.paymentType) &&
        (!args.revenueSlice ||
          (args.revenueSlice === "commissionable") === p.commissionable),
    );

    for (const payment of rows) {
      const periodKey = getPeriodKey(payment.recordedAt, args.granularity as Granularity);
      const index = indexByPeriodKey.get(periodKey);
      if (index === undefined) continue;

      const bucket = trend[index];
      const isDeposit = payment.paymentType === "deposit";
      if (payment.commissionable) {
        if (isDeposit) {
          bucket.commissionableDepositMinor += payment.amountMinor;
        } else {
          bucket.commissionableFinalMinor += payment.amountMinor;
          bucket.commissionableFinalDealCount += 1;
        }
      } else {
        if (isDeposit) {
          bucket.nonCommissionableDepositMinor += payment.amountMinor;
        } else {
          bucket.nonCommissionableFinalMinor += payment.amountMinor;
          bucket.nonCommissionableFinalDealCount += 1;
        }
      }
    }

    return {
      trend,
      isPaymentDataTruncated: scan.isTruncated,
    };
  },
});
```

**Acceptance for 5B:**
- `tsc --noEmit` passes after 5A + 5B.
- Grep `REVENUE_ORIGINS` returns zero hits (replaced by `COMMISSIONABLE_ORIGINS`).
- Grep `payment.provider` in `convex/reporting/revenue.ts` returns zero hits.
- Grep `.closerId` in `convex/reporting/revenue.ts` + `revenueTrend.ts` returns zero hits (all replaced with `attributedCloserId`).

---

### 5C — Reminders Report + Team Performance

**Type:** Backend
**Parallelizable:** Yes, after 5A merges. Owns `convex/reporting/remindersReporting.ts` and `convex/reporting/teamPerformance.ts`.

**What:** Update `getReminderOutcomeFunnel` to (a) page both `closer_reminder` AND `admin_reminder` origins, (b) apply optional `programId` / `paymentType` filters, (c) return `reminderDrivenFinalRevenueMinor` + `reminderDrivenDepositRevenueMinor` split, with a sanity warn if any non-commissionable rows leak in. Update `getTeamPerformanceMetrics` to use commissionable-final for per-closer cash-collected, replace the deleted `loggedByAdminUserId` field with the new "admin-logged revenue" computation (`recordedByUserId !== attributedCloserId`), and add a team-level `postConversionRevenueMinor` chip.

**Why:** In Phase 4, admin-on-behalf reminder payments got a new origin (`admin_reminder`) to distinguish them from closer-self reminders (`closer_reminder`) in the activity feed. The reminders report should treat both as "reminder-channel revenue" — they're functionally the same campaign. The team performance report must adapt to two schema-level changes: (1) the `loggedByAdminUserId` field is gone (replaced by `recordedByUserId` which is always set), and (2) "cash collected" should never include non-commissionable customer-direct payments (they're not the closer's doing).

**Where:**
- `convex/reporting/remindersReporting.ts` (modify)
- `convex/reporting/teamPerformance.ts` (modify)

**How:**

**Step 1: Rewrite the reminder-revenue loop in `getReminderOutcomeFunnel`**

Before (lines 96–141) — single-origin `closer_reminder` scan:

```typescript
// Path: convex/reporting/remindersReporting.ts (BEFORE)
const reminderRevenueRows: Array<Doc<"paymentRecords">> = [];
let reminderRevenueCursor: string | null = null;
let isReminderRevenueTruncated = false;

while (reminderRevenueRows.length <= MAX_REMINDER_REVENUE_SCAN_ROWS) {
  const page = await ctx.db
    .query("paymentRecords")
    .withIndex("by_tenantId_and_origin_and_recordedAt", (q) =>
      q
        .eq("tenantId", tenantId)
        .eq("origin", "closer_reminder")  // ← single origin
        .gte("recordedAt", startDate)
        .lt("recordedAt", endDate),
    )
    .paginate({ cursor: reminderRevenueCursor, numItems: 250 });

  for (const payment of page.page) {
    if (payment.status === "disputed") continue;
    reminderRevenueRows.push(payment);
    if (reminderRevenueRows.length > MAX_REMINDER_REVENUE_SCAN_ROWS) {
      isReminderRevenueTruncated = true;
      break;
    }
  }
  if (isReminderRevenueTruncated || page.isDone) break;
  reminderRevenueCursor = page.continueCursor;
}

const reminderRevenue = reminderRevenueRows.slice(0, MAX_REMINDER_REVENUE_SCAN_ROWS);
const reminderDrivenRevenueMinor = reminderRevenue.reduce(
  (sum, payment) => sum + payment.amountMinor, 0,
);
```

After — two-origin scan + optional filters + final-vs-deposit split:

```typescript
// Path: convex/reporting/remindersReporting.ts (AFTER — imports + args)
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import {
  assertValidDateRange,
  getUserDisplayName,
  splitPaymentsForRevenueReporting,
} from "./lib/helpers";

const MAX_FOLLOWUP_SCAN_ROWS = 2000;
const MAX_REMINDER_REVENUE_SCAN_ROWS = 2000;
// Both reminder origins — closer-self AND admin-on-behalf. Phase 4 introduced
// the admin_reminder origin to distinguish attribution in the activity feed;
// for reporting, both are "reminder-channel revenue."
const REMINDER_ORIGINS = ["closer_reminder", "admin_reminder"] as const;

const PAYMENT_TYPE_FILTER = v.union(
  v.literal("monthly"),
  v.literal("split"),
  v.literal("pif"),
  v.literal("deposit"),
);

export const getReminderOutcomeFunnel = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
    programId: v.optional(v.id("tenantPrograms")),
    paymentType: v.optional(PAYMENT_TYPE_FILTER),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    assertValidDateRange(args.startDate, args.endDate);

    // 1. Follow-ups scan (unchanged).
    const rows = await ctx.db
      .query("followUps")
      .withIndex("by_tenantId_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).gte("createdAt", args.startDate).lt("createdAt", args.endDate),
      )
      .take(MAX_FOLLOWUP_SCAN_ROWS);

    // 2. Reminder revenue — TWO origin buckets (closer_reminder, admin_reminder).
    //    Each uses the by_tenantId_and_origin_and_recordedAt index.
    const reminderRevenueRows: Array<Doc<"paymentRecords">> = [];
    let isReminderRevenueTruncated = false;

    outer: for (const origin of REMINDER_ORIGINS) {
      let cursor: string | null = null;
      while (reminderRevenueRows.length <= MAX_REMINDER_REVENUE_SCAN_ROWS) {
        const page = await ctx.db
          .query("paymentRecords")
          .withIndex("by_tenantId_and_origin_and_recordedAt", (q) =>
            q
              .eq("tenantId", tenantId)
              .eq("origin", origin)
              .gte("recordedAt", args.startDate)
              .lt("recordedAt", args.endDate),
          )
          .paginate({ cursor, numItems: 250 });

        for (const payment of page.page) {
          if (payment.status === "disputed") continue;
          // Apply optional filters in-memory.
          if (args.programId && payment.programId !== args.programId) continue;
          if (args.paymentType && payment.paymentType !== args.paymentType) continue;

          reminderRevenueRows.push(payment);
          if (reminderRevenueRows.length > MAX_REMINDER_REVENUE_SCAN_ROWS) {
            isReminderRevenueTruncated = true;
            break outer;
          }
        }
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
    }

    // Route through the shared split helper.
    const split = splitPaymentsForRevenueReporting(
      reminderRevenueRows.slice(0, MAX_REMINDER_REVENUE_SCAN_ROWS),
    );

    // Sanity check: reminders are ALWAYS commissionable. A non-commissionable
    // reminder row means the write path (Phase 4) has a bug — warn loudly.
    if (split.nonCommissionable.allPayments.length > 0) {
      console.warn(
        "[RemindersReport] Unexpected non-commissionable reminder payment found — data integrity issue",
        {
          tenantId,
          count: split.nonCommissionable.allPayments.length,
          firstRowId: split.nonCommissionable.allPayments[0]?._id,
        },
      );
    }

    const reminderDrivenFinalRevenueMinor = split.commissionable.finalRevenueMinor;
    const reminderDrivenDepositRevenueMinor = split.commissionable.depositRevenueMinor;
    const reminderDrivenRevenueMinor =
      reminderDrivenFinalRevenueMinor + reminderDrivenDepositRevenueMinor;

    // ... (existing follow-up outcome mix + per-closer bucket logic unchanged) ...

    return {
      // ... existing follow-up fields unchanged ...
      reminderDrivenRevenueMinor, // kept for rollout compat — sum of final + deposit
      reminderDrivenFinalRevenueMinor,
      reminderDrivenDepositRevenueMinor,
      reminderDrivenPaymentCount: split.commissionable.allPayments.length,
      isReminderRevenueTruncated,
      // ...
    };
  },
});
```

**Step 2: Rewrite the per-closer cash metric in `getTeamPerformanceMetrics`**

Before (lines 209–237 in `teamPerformance.ts`) — uses the legacy `loggedByAdminUserId` field:

```typescript
// Path: convex/reporting/teamPerformance.ts (BEFORE)
const paymentScan = await getNonDisputedPaymentsInRange(/* ... */);
const attributedPayments = await attributePaymentsToClosers(ctx, paymentScan.payments);
const paymentSummary = summarizeAttributedPayments(attributedPayments);
const activeCloserIds = new Set(closers.map((closer) => closer._id));
const adminLoggedRevenueByCloser = new Map<Id<"users">, number>();

for (const payment of attributedPayments) {
  if (
    payment.loggedByAdminUserId === undefined ||  // ← field no longer exists
    payment.effectiveCloserId === null ||
    !activeCloserIds.has(payment.effectiveCloserId)
  ) {
    continue;
  }
  adminLoggedRevenueByCloser.set(
    payment.effectiveCloserId,
    (adminLoggedRevenueByCloser.get(payment.effectiveCloserId) ?? 0) + payment.amountMinor,
  );
}

// Per-closer: uses summarized ALL non-disputed revenue (mixed commissionable +
// non-commissionable, mixed final + deposit). Wrong after Phase 4.
const paymentStats = paymentSummary.byCloser.get(closer._id) ?? { dealCount: 0, revenueMinor: 0 };
```

After — commissionable-final only, admin-logged derived from `recordedByUserId !== attributedCloserId`:

```typescript
// Path: convex/reporting/teamPerformance.ts (AFTER — imports)
import {
  assertValidDateRange,
  getActiveClosers,
  getNonDisputedPaymentsInRange,
  getUserDisplayName,
  makeTupleDateBounds,
  splitPaymentsForRevenueReporting,
} from "./lib/helpers";
// NOTE: `attributePaymentsToClosers` and `summarizeAttributedPayments` are no
// longer imported here. The four-way split is computed directly from the
// commissionable-final bucket.
```

Then replace the payment processing block (lines ~209–237) with:

```typescript
// Path: convex/reporting/teamPerformance.ts (AFTER — handler body excerpt)
const paymentScan = await getNonDisputedPaymentsInRange(
  ctx,
  tenantId,
  startDate,
  endDate,
);
const split = splitPaymentsForRevenueReporting(paymentScan.payments);
const activeCloserIds = new Set(closers.map((closer) => closer._id));

// Per-closer "Cash Collected" — commissionable FINAL only. Deposits are
// tracked separately at the team level. Non-commissionable post-conversion
// revenue never appears in a closer-scoped column.
const perCloserStats = new Map<
  Id<"users">,
  { dealCount: number; revenueMinor: number; adminLoggedRevenueMinor: number }
>(closers.map((c) => [c._id, { dealCount: 0, revenueMinor: 0, adminLoggedRevenueMinor: 0 }]));

for (const payment of split.commissionable.finalPayments) {
  if (!payment.attributedCloserId) continue;
  if (!activeCloserIds.has(payment.attributedCloserId)) continue;

  const stats = perCloserStats.get(payment.attributedCloserId);
  if (!stats) continue;

  stats.dealCount += 1;
  stats.revenueMinor += payment.amountMinor;

  // Admin-logged-on-behalf: the recorder was someone OTHER than the attributed
  // closer. This is the Phase-4-native signal — `loggedByAdminUserId` is gone.
  if (payment.recordedByUserId !== payment.attributedCloserId) {
    stats.adminLoggedRevenueMinor += payment.amountMinor;
  }
}

// Team-level post-conversion revenue (unattributed; explicitly NOT a closer KPI).
const postConversionRevenueMinor = split.nonCommissionable.finalRevenueMinor;
const postConversionDepositsMinor = split.nonCommissionable.depositRevenueMinor;
const teamDepositsCollectedMinor = split.commissionable.depositRevenueMinor;
```

Then update the closer-row construction (lines ~297–355):

```typescript
// Path: convex/reporting/teamPerformance.ts (AFTER — closer-row build)
const closerResults = closers.map((closer) => {
  const closerCounts = statusCountsByCloser.get(closer._id) ?? { /* ... */ };
  const stats = perCloserStats.get(closer._id) ?? {
    dealCount: 0, revenueMinor: 0, adminLoggedRevenueMinor: 0,
  };
  // ... (meeting-time, classification metrics unchanged) ...
  return {
    closerId: closer._id,
    closerName: getUserDisplayName(closer),
    newCalls,
    followUpCalls,
    meetingTime,
    sales: stats.dealCount,
    cashCollectedMinor: stats.revenueMinor, // commissionable FINAL only
    adminLoggedRevenueMinor: stats.adminLoggedRevenueMinor,
    closeRate: toRate(stats.dealCount, totalShowed),
    avgCashCollectedMinor:
      stats.dealCount > 0 ? stats.revenueMinor / stats.dealCount : null,
  };
});
```

And update the `teamTotals` return block to include the new chips:

```typescript
// Path: convex/reporting/teamPerformance.ts (AFTER — return)
return {
  closers: closerResults,
  teamTotals: {
    // ... existing fields ...
    totalRevenueMinor: teamTotals.totalRevenue, // still commissionable-final
    totalAdminLoggedRevenueMinor: teamTotals.totalAdminLoggedRevenueMinor,
    avgCashCollectedMinor: /* unchanged */,
    excludedRevenueMinor: 0, // dropped — splitPaymentsForRevenueReporting
                             // never excludes rows anymore (filtering is explicit)
    excludedSales: 0,
    // NEW — team-level chips that are explicitly NOT per-closer metrics:
    postConversionRevenueMinor,
    postConversionDepositsMinor,
    teamDepositsCollectedMinor,
  },
  teamMeetingTime: toMeetingTimeKpis(teamMeetingTimeTotals),
  isPaymentDataTruncated: paymentScan.isTruncated,
  isMeetingTimeTruncated,
};
```

**Acceptance for 5C:**
- `tsc --noEmit` passes.
- Grep `loggedByAdminUserId` returns zero hits across the codebase.
- Grep `attributePaymentsToClosers\|summarizeAttributedPayments` in `teamPerformance.ts` returns zero hits (the file no longer needs them).
- Grep `"closer_reminder"` returns exactly one hit (inside `REMINDER_ORIGINS` in `remindersReporting.ts`); zero standalone uses.

---

### 5D — Admin Stats + Activity Feed

**Type:** Backend
**Parallelizable:** Yes, after 5A merges. Owns `convex/dashboard/adminStats.ts` and `convex/reporting/activityFeed.ts`.

**What:**

- **`adminStats.ts`**: `getAdminDashboardStats` switches from `stats.totalRevenueMinor / 100` to `stats.totalCommissionableFinalRevenueMinor / 100`; exposes three new fields (`postConversionRevenueLogged`, `depositsCollected`, `postConversionDepositsLogged`); keeps `totalRevenue` as the sum of all four for rollout-compat. `getTimePeriodStats` uses `splitPaymentsForRevenueReporting` on the bounded scan and returns four new fields (`closedWonInPeriod`, `depositsInPeriod`, `postConversionInPeriod`, `postConversionDepositsInPeriod`).

- **`activityFeed.ts`**: The domain-event payload (JSON in `event.metadata`) now carries `{ programName, paymentType, commissionable, attributedCloserId, originCategory }` for `payment.recorded` / `payment.disputed` / `payment.verified` events (emitters land in Phase 4). Phase 5 also owns the additive `getActivityFeed({ programId?, paymentType? })` filter args that Phase 9's payment-only filter row depends on. Keep the query backwards-compatible for callers that omit both args.

**Why:** The workspace landing card is the first thing admins see. Showing `totalRevenueMinor / 100` now mixes closer-commissionable revenue with customer-direct revenue — incorrect and misleading (especially for tenants who do a lot of monthly recurring customer-direct payments that shouldn't count as "cash collected this month"). Splitting into commissionable-final + deposits + post-conversion gives the same all-time totals as the revenue report, eliminating the tenant-visible discrepancy.

**Where:**
- `convex/dashboard/adminStats.ts` (modify)
- `convex/reporting/activityFeed.ts` (modify — minor)

**How:**

**Step 1: Rewrite `getAdminDashboardStats`**

Before (the return block, lines 58–81):

```typescript
// Path: convex/dashboard/adminStats.ts (BEFORE)
const revenueLogged = stats.totalRevenueMinor / 100;

return {
  totalTeamMembers: stats.totalTeamMembers,
  totalClosers: stats.totalClosers,
  unmatchedClosers: 0,
  totalOpportunities: stats.totalOpportunities,
  activeOpportunities: stats.activeOpportunities,
  meetingsToday,
  wonDeals: stats.wonDeals,
  revenueLogged,
  totalRevenue: revenueLogged,
  paymentRecordsLogged: stats.totalPaymentRecords,
};
```

After:

```typescript
// Path: convex/dashboard/adminStats.ts (AFTER)
const commissionableFinalMinor = stats.totalCommissionableFinalRevenueMinor ?? 0;
const commissionableDepositMinor = stats.totalCommissionableDepositRevenueMinor ?? 0;
const nonCommissionableFinalMinor = stats.totalNonCommissionableFinalRevenueMinor ?? 0;
const nonCommissionableDepositMinor = stats.totalNonCommissionableDepositRevenueMinor ?? 0;

// Primary KPI: closer-commissionable cash collected (excludes deposits,
// excludes customer-direct). This is what shows up on the headline card.
const revenueLogged = commissionableFinalMinor / 100;
// Secondary KPIs surfaced as separate cards in Phase 9.
const depositsCollected = commissionableDepositMinor / 100;
const postConversionRevenueLogged = nonCommissionableFinalMinor / 100;
const postConversionDepositsLogged = nonCommissionableDepositMinor / 100;
// Rollout compat: sum of all four. Matches legacy `stats.totalRevenueMinor`
// exactly (Phase 3D's `applyPaymentStatsDelta` always increments both the
// split counter AND `totalRevenueMinor` so they stay in sync).
const totalRevenue =
  revenueLogged +
  depositsCollected +
  postConversionRevenueLogged +
  postConversionDepositsLogged;

console.log("[Dashboard] getAdminDashboardStats completed", {
  tenantId,
  totalTeamMembers: stats.totalTeamMembers,
  totalClosers: stats.totalClosers,
  totalOpportunities: stats.totalOpportunities,
  activeOpportunities: stats.activeOpportunities,
  meetingsToday,
  wonDeals: stats.wonDeals,
  revenueLogged,
  depositsCollected,
  postConversionRevenueLogged,
  postConversionDepositsLogged,
});

return {
  totalTeamMembers: stats.totalTeamMembers,
  totalClosers: stats.totalClosers,
  unmatchedClosers: 0,
  totalOpportunities: stats.totalOpportunities,
  activeOpportunities: stats.activeOpportunities,
  meetingsToday,
  wonDeals: stats.wonDeals,
  // Primary card — commissionable FINAL only.
  revenueLogged,
  // NEW breakout cards — Phase 9 renders them alongside the primary.
  depositsCollected,
  postConversionRevenueLogged,
  postConversionDepositsLogged,
  // Rollout compat — equals the sum.
  totalRevenue,
  paymentRecordsLogged: stats.totalPaymentRecords,
};
```

**Step 2: Rewrite `getTimePeriodStats`**

Before (the payment scan block, lines 128–147):

```typescript
// Path: convex/dashboard/adminStats.ts (BEFORE)
let revenueMinorInPeriod = 0;
let paymentCountInPeriod = 0;
const wonOpportunityIds = new Set<string>();
for await (const payment of ctx.db
  .query("paymentRecords")
  .withIndex("by_tenantId_and_recordedAt", (q) =>
    q.eq("tenantId", tenantId).gte("recordedAt", periodStart).lt("recordedAt", periodEnd),
  )) {
  if (payment.status !== "disputed") {
    revenueMinorInPeriod += payment.amountMinor;
    paymentCountInPeriod += 1;
  }
  if (payment.opportunityId) {
    wonOpportunityIds.add(payment.opportunityId);
  }
}

return {
  // ...
  wonDealsInPeriod: wonOpportunityIds.size,
  revenueInPeriod: revenueMinorInPeriod / 100,
  paymentCountInPeriod,
  // ...
};
```

After — bounded scan + split + four new fields:

```typescript
// Path: convex/dashboard/adminStats.ts (AFTER — imports)
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import {
  getNonDisputedPaymentsInRange,
  splitPaymentsForRevenueReporting,
} from "../reporting/lib/helpers";
```

Then the scan block becomes:

```typescript
// Path: convex/dashboard/adminStats.ts (AFTER — getTimePeriodStats body)
// 3. Payments in period — use bounded helper + shared split.
const paymentScan = await getNonDisputedPaymentsInRange(
  ctx,
  tenantId,
  periodStart,
  periodEnd,
);
const split = splitPaymentsForRevenueReporting(paymentScan.payments);

// Closed-won deals in period: distinct opportunityIds from commissionable FINAL.
// (Deposits don't count as "won" in this KPI; they're pre-win money.)
const wonOpportunityIds = new Set<string>();
for (const p of split.commissionable.finalPayments) {
  if (p.opportunityId) wonOpportunityIds.add(p.opportunityId);
}

const paymentCountInPeriod = split.filteredPayments.length;
const closedWonMinor = split.commissionable.finalRevenueMinor;
const depositsMinor = split.commissionable.depositRevenueMinor;
const postConversionMinor = split.nonCommissionable.finalRevenueMinor;
const postConversionDepositsMinor = split.nonCommissionable.depositRevenueMinor;
const totalRevenueMinor =
  closedWonMinor + depositsMinor + postConversionMinor + postConversionDepositsMinor;
```

And the return shape:

```typescript
// Path: convex/dashboard/adminStats.ts (AFTER — getTimePeriodStats return)
return {
  newOpportunities,
  meetingsInPeriod,
  wonDealsInPeriod: wonOpportunityIds.size,
  // New fields — Phase 9's StatsRow renders all four.
  closedWonInPeriod: closedWonMinor / 100,
  depositsInPeriod: depositsMinor / 100,
  postConversionInPeriod: postConversionMinor / 100,
  postConversionDepositsInPeriod: postConversionDepositsMinor / 100,
  // Kept for rollout compat — same value as the legacy return.
  revenueInPeriod: totalRevenueMinor / 100,
  paymentCountInPeriod,
  newCustomers,
  isPaymentDataTruncated: paymentScan.isTruncated,
};
```

**Step 3: Harden the activity feed metadata narrowing**

`convex/reporting/activityFeed.ts` already calls `parseEventMetadata(event.metadata)` and returns the parsed object as-is. Phase 4's mutations emit richer payment metadata. Add a narrow helper in the same file so the frontend (Phase 9) has a single typed shape to bind to:

```typescript
// Path: convex/reporting/activityFeed.ts (AFTER — new helper)
type ParsedPaymentMetadata = {
  programId?: string;
  programName?: string;
  paymentType?: "monthly" | "split" | "pif" | "deposit";
  commissionable?: boolean;
  attributedCloserId?: string;
  originCategory?: "commissionable" | "non_commissionable";
  amountMinor?: number;
  currency?: string;
};

/**
 * Narrow a parsed event metadata object to the fields that payment.* events
 * emit. Returns the same object — this is just a type assertion wrapper.
 * Non-payment events return null.
 */
function narrowPaymentMetadata(
  event: Doc<"domainEvents">,
  parsed: Record<string, unknown> | null,
): ParsedPaymentMetadata | null {
  if (parsed === null) return null;
  if (event.entityType !== "payment") return null;
  return parsed as ParsedPaymentMetadata;
}
```

Update the `getActivityFeed` return to use it:

```typescript
// Path: convex/reporting/activityFeed.ts (AFTER — return map)
return events.map((event) => {
  const parsedMetadata = parseEventMetadata(event.metadata);
  return {
    ...event,
    actorName: event.actorUserId
      ? getUserDisplayName(actorById.get(event.actorUserId) ?? null)
      : null,
    metadata: parsedMetadata,
    paymentMetadata: narrowPaymentMetadata(event, parsedMetadata), // NEW
  };
});
```

`getActivitySummary` gains a count of commissionable vs. non-commissionable payment events in `byOutcome`:

```typescript
// Path: convex/reporting/activityFeed.ts (AFTER — inside getActivitySummary loop)
if (event.entityType === "payment" && event.eventType === "payment.recorded") {
  const narrowed = narrowPaymentMetadata(event, parsedMetadata);
  if (narrowed?.commissionable === true) {
    byOutcome["payment_commissionable"] = (byOutcome["payment_commissionable"] ?? 0) + 1;
  } else if (narrowed?.commissionable === false) {
    byOutcome["payment_non_commissionable"] = (byOutcome["payment_non_commissionable"] ?? 0) + 1;
  }
}
```

**Acceptance for 5D:**
- `tsc --noEmit` passes.
- `getAdminDashboardStats` returns all seven fields (`revenueLogged`, `depositsCollected`, `postConversionRevenueLogged`, `postConversionDepositsLogged`, `totalRevenue`, `paymentRecordsLogged`, `wonDeals`).
- `getTimePeriodStats` returns the new `closedWonInPeriod`, `depositsInPeriod`, `postConversionInPeriod`, `postConversionDepositsInPeriod` fields.
- `getActivityFeed` accepts optional `programId?` / `paymentType?` args for payment-event filtering, and its return rows carry a `paymentMetadata: ParsedPaymentMetadata | null` field.

---

### 5E — Read-Surface Queries (Meeting, Reminder, Customer, Review Detail)

**Type:** Backend
**Parallelizable:** Yes — fully independent of 5A-D. Can start alongside 5A.

**What:** Update every query that returns payment records as part of a detail-page payload to surface the new fields (`programName`, `paymentType`, `commissionable`, `attributedCloserId`, `attributedCloserName`, `recordedByUserId`, `recordedByName`). Rename `closerId` / `closerName` in the return shapes to `attributedCloserId` / `attributedCloserName`.

Four queries touched:
- `convex/closer/meetingDetail.ts::getMeetingDetail`
- `convex/closer/reminderDetail.ts::getReminderDetail`
- `convex/customers/queries.ts::listCustomers` + `getCustomerDetail`
- `convex/reviews/queries.ts::getReviewDetail`

Also: delete the deprecated `getCustomerTotalPaid` query (noted as deprecated in source since Phase 4 prior work; nothing in the frontend still consumes it — grep `getCustomerTotalPaid` on the frontend to confirm before deletion).

**Why:** Every frontend detail page (meeting, reminder, customer, review) shows a payment history table or card. Post-Phase-4, the provider-driven metadata (`provider`, `referenceCode`) is gone and the closer attribution (`closerId`) has been replaced by explicit attribution (`attributedCloserId`) plus a distinct recorder (`recordedByUserId`). The UI needs to render: **Program • Payment Type • Commissionable badge • Attributed to / Recorded by** — and it can only do that if the queries expose those fields.

**Where:**
- `convex/closer/meetingDetail.ts` (modify)
- `convex/closer/reminderDetail.ts` (modify)
- `convex/customers/queries.ts` (modify)
- `convex/reviews/queries.ts` (modify)

**How:**

**Step 1: `convex/closer/meetingDetail.ts` — enriched payment array**

The current file computes `paymentCloserIds` from `payment.closerId` and joins to build a name map. Rewrite to use `attributedCloserId` AND `recordedByUserId` so both names are surfaced.

Before (lines 12–19 and 151–199):

```typescript
// Path: convex/closer/meetingDetail.ts (BEFORE — type + enrichment)
type EnrichedPayment = Omit<Doc<"paymentRecords">, "amount"> & {
  amount: number;
  proofFileUrl: string | null;
  proofFileContentType: string | null;
  proofFileSize: number | null;
  closerName: string | null;
};

// ...
const paymentCloserIds = [
  ...new Set(paymentRecordsRaw.map((payment) => payment.closerId)),
];
const paymentClosers = await Promise.all(/* ... */);
const paymentCloserNameById = new Map<Id<"users">, string | null>(/* ... */);

const payments: EnrichedPayment[] = await Promise.all(
  paymentRecordsRaw
    .filter((payment) => payment.tenantId === tenantId)
    .map(async (payment) => {
      /* ... proof file lookup ... */
      return {
        ...payment,
        amount: payment.amountMinor / 100,
        proofFileUrl,
        proofFileContentType,
        proofFileSize,
        closerName: paymentCloserNameById.get(payment.closerId) ?? null, // ← field gone
      };
    }),
);
```

After:

```typescript
// Path: convex/closer/meetingDetail.ts (AFTER — type)
type EnrichedPayment = Omit<Doc<"paymentRecords">, "amount"> & {
  amount: number;
  proofFileUrl: string | null;
  proofFileContentType: string | null;
  proofFileSize: number | null;
  // NEW — distinguishes attribution from recording actor.
  attributedCloserName: string | null;
  recordedByName: string | null;
};
```

Then the enrichment block:

```typescript
// Path: convex/closer/meetingDetail.ts (AFTER — enrichment)
// Collect every user ID we need names for (attributed closer + recorder).
// recordedByUserId is always set (Phase 4 invariant). attributedCloserId is
// set iff commissionable (Phase 3 invariant I5).
const userIdsForNames = new Set<Id<"users">>();
for (const payment of paymentRecordsRaw) {
  if (payment.tenantId !== tenantId) continue;
  if (payment.attributedCloserId) userIdsForNames.add(payment.attributedCloserId);
  userIdsForNames.add(payment.recordedByUserId);
}
const userDocs = await Promise.all(
  [...userIdsForNames].map(
    async (userId) => [userId, await ctx.db.get(userId)] as const,
  ),
);
const userNameById = new Map<Id<"users">, string | null>(
  userDocs.map(([userId, userDoc]) => [
    userId,
    userDoc && userDoc.tenantId === tenantId
      ? (userDoc.fullName ?? userDoc.email)
      : null,
  ]),
);

const payments: EnrichedPayment[] = await Promise.all(
  paymentRecordsRaw
    .filter((payment) => payment.tenantId === tenantId)
    .map(async (payment) => {
      let proofFileUrl: string | null = null;
      let proofFileContentType: string | null = null;
      let proofFileSize: number | null = null;

      if (payment.proofFileId) {
        const [url, fileMeta] = await Promise.all([
          ctx.storage.getUrl(payment.proofFileId),
          ctx.db.system.get("_storage", payment.proofFileId),
        ]);
        proofFileUrl = url;
        if (fileMeta) {
          proofFileContentType = fileMeta.contentType ?? null;
          proofFileSize = fileMeta.size ?? null;
        }
      }

      return {
        ...payment,
        amount: payment.amountMinor / 100,
        proofFileUrl,
        proofFileContentType,
        proofFileSize,
        attributedCloserName: payment.attributedCloserId
          ? (userNameById.get(payment.attributedCloserId) ?? null)
          : null,
        recordedByName: userNameById.get(payment.recordedByUserId) ?? null,
      };
    }),
);
payments.sort((a, b) => b.recordedAt - a.recordedAt);
```

The rest of `getMeetingDetail` (meeting history, reassignment, potential duplicate, reschedule chain, active follow-up) is **unchanged** — they don't touch payments.

**Step 2: `convex/closer/reminderDetail.ts` — enrichment + admin version mirror**

The closer version currently returns `payments` as raw `paymentRecords` rows. Enrich the same way as `getMeetingDetail` — add `attributedCloserName` + `recordedByName`. Phase 4E already created `getAdminReminderDetail` mirroring the closer version; Phase 5E updates BOTH to use the enriched shape.

Before (lines 35–49):

```typescript
// Path: convex/closer/reminderDetail.ts (BEFORE)
const [latestMeeting, payments, eventTypeConfig] = await Promise.all([
  opportunity.latestMeetingId ? ctx.db.get(opportunity.latestMeetingId) : Promise.resolve(null),
  ctx.db
    .query("paymentRecords")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunity._id))
    .order("desc")
    .take(10),
  opportunity.eventTypeConfigId ? ctx.db.get(opportunity.eventTypeConfigId) : Promise.resolve(null),
]);
// ...
return { followUp, opportunity, lead, latestMeeting, payments, paymentLinks };
```

After:

```typescript
// Path: convex/closer/reminderDetail.ts (AFTER)
const [latestMeeting, paymentRecordsRaw, eventTypeConfig] = await Promise.all([
  opportunity.latestMeetingId ? ctx.db.get(opportunity.latestMeetingId) : Promise.resolve(null),
  ctx.db
    .query("paymentRecords")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunity._id))
    .order("desc")
    .take(10),
  opportunity.eventTypeConfigId ? ctx.db.get(opportunity.eventTypeConfigId) : Promise.resolve(null),
]);

// Enrich payments with attributed/recorder names (mirrors getMeetingDetail).
const userIdsForNames = new Set<Id<"users">>();
for (const p of paymentRecordsRaw) {
  if (p.tenantId !== tenantId) continue;
  if (p.attributedCloserId) userIdsForNames.add(p.attributedCloserId);
  userIdsForNames.add(p.recordedByUserId);
}
const userDocs = await Promise.all(
  [...userIdsForNames].map(async (userId) => [userId, await ctx.db.get(userId)] as const),
);
const userNameById = new Map<Id<"users">, string | null>(
  userDocs.map(([userId, userDoc]) => [
    userId,
    userDoc && userDoc.tenantId === tenantId
      ? (userDoc.fullName ?? userDoc.email)
      : null,
  ]),
);
const payments = paymentRecordsRaw
  .filter((p) => p.tenantId === tenantId)
  .map((p) => ({
    ...p,
    amount: p.amountMinor / 100,
    attributedCloserName: p.attributedCloserId
      ? (userNameById.get(p.attributedCloserId) ?? null)
      : null,
    recordedByName: userNameById.get(p.recordedByUserId) ?? null,
  }));

// ... rest unchanged ...
return { followUp, opportunity, lead, latestMeeting, payments, paymentLinks };
```

**Identical enrichment must be applied in `convex/pipeline/reminderDetail.ts::getAdminReminderDetail`** (the new query from Phase 4E). Keep the two in lockstep — future maintenance should reuse a shared helper (see follow-up note in the subphase summary).

**Step 3: `convex/customers/queries.ts` — expose `programName` + enriched payments**

The `customers` schema gained `programId` + `programName` in Phase 2 (design §10.3). `listCustomers` already spreads `...customer` in its return block, so the new fields auto-pass through; no change needed there beyond confirming the type narrowing. `getCustomerDetail` needs the payment enrichment.

Before (lines 119–197):

```typescript
// Path: convex/customers/queries.ts (BEFORE — getCustomerDetail excerpt)
const [lead, winningOpportunity, winningMeeting, opportunities, paymentRecords, converter] =
  await Promise.all([
    /* ... */
    ctx.db
      .query("paymentRecords")
      .withIndex("by_customerId_and_recordedAt", (q) => q.eq("customerId", customer._id))
      .order("desc")
      .take(50),
    /* ... */
  ]);

const payments = paymentRecords.map((payment) => ({
  ...payment,
  amount: payment.amountMinor / 100,
}));
```

After:

```typescript
// Path: convex/customers/queries.ts (AFTER — getCustomerDetail excerpt)
const [lead, winningOpportunity, winningMeeting, opportunities, paymentRecordsRaw, converter] =
  await Promise.all([
    /* ... unchanged ... */
    ctx.db
      .query("paymentRecords")
      .withIndex("by_customerId_and_recordedAt", (q) => q.eq("customerId", customer._id))
      .order("desc")
      .take(50),
    /* ... */
  ]);

// Enrich payments — same pattern as meetingDetail / reminderDetail.
const userIdsForNames = new Set<Id<"users">>();
for (const p of paymentRecordsRaw) {
  if (p.tenantId !== tenantId) continue;
  if (p.attributedCloserId) userIdsForNames.add(p.attributedCloserId);
  userIdsForNames.add(p.recordedByUserId);
}
const userDocs = await Promise.all(
  [...userIdsForNames].map(async (userId) => [userId, await ctx.db.get(userId)] as const),
);
const userNameById = new Map<Id<"users">, string | null>(
  userDocs.map(([userId, userDoc]) => [
    userId,
    userDoc && userDoc.tenantId === tenantId
      ? (userDoc.fullName ?? userDoc.email)
      : null,
  ]),
);
const payments = paymentRecordsRaw
  .filter((p) => p.tenantId === tenantId)
  .map((p) => ({
    ...p,
    amount: p.amountMinor / 100,
    attributedCloserName: p.attributedCloserId
      ? (userNameById.get(p.attributedCloserId) ?? null)
      : null,
    recordedByName: userNameById.get(p.recordedByUserId) ?? null,
  }));
```

And delete the deprecated export (full file block):

```typescript
// Path: convex/customers/queries.ts (DELETE THIS WHOLE BLOCK — lines 199-223)
/**
 * @deprecated Use customer.totalPaidMinor directly.
 */
export const getCustomerTotalPaid = query({ /* ... */ });
```

Before deleting, confirm with `grep -r "getCustomerTotalPaid" app convex components hooks lib` that no caller remains. The deprecation note in the source file says it was retained "during the Phase 4-7 migration window" (earlier feature, not this one) — Phase 5 is where that window closes.

**Step 4: `convex/reviews/queries.ts` — enriched `paymentRecords` in `getReviewDetail`**

Before (lines 140–151):

```typescript
// Path: convex/reviews/queries.ts (BEFORE)
const [paymentRecords, lostByUser, noShowByUser] = await Promise.all([
  ctx.db
    .query("paymentRecords")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunity._id))
    .take(20),
  opportunity.lostByUserId ? ctx.db.get(opportunity.lostByUserId) : null,
  meeting.noShowMarkedByUserId ? ctx.db.get(meeting.noShowMarkedByUserId) : null,
]);

return {
  /* ... */
  paymentRecords,
  /* ... */
};
```

After — enrich with names:

```typescript
// Path: convex/reviews/queries.ts (AFTER)
const [paymentRecordsRaw, lostByUser, noShowByUser] = await Promise.all([
  ctx.db
    .query("paymentRecords")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunity._id))
    .take(20),
  opportunity.lostByUserId ? ctx.db.get(opportunity.lostByUserId) : null,
  meeting.noShowMarkedByUserId ? ctx.db.get(meeting.noShowMarkedByUserId) : null,
]);

const userIdsForNames = new Set<Id<"users">>();
for (const p of paymentRecordsRaw) {
  if (p.tenantId !== tenantId) continue;
  if (p.attributedCloserId) userIdsForNames.add(p.attributedCloserId);
  userIdsForNames.add(p.recordedByUserId);
}
const userDocs = await Promise.all(
  [...userIdsForNames].map(async (userId) => [userId, await ctx.db.get(userId)] as const),
);
const userNameById = new Map<Id<"users">, string | null>(
  userDocs.map(([userId, userDoc]) => [
    userId,
    userDoc && userDoc.tenantId === tenantId
      ? (userDoc.fullName ?? userDoc.email)
      : null,
  ]),
);
const paymentRecords = paymentRecordsRaw.map((p) => ({
  ...p,
  attributedCloserName: p.attributedCloserId
    ? (userNameById.get(p.attributedCloserId) ?? null)
    : null,
  recordedByName: userNameById.get(p.recordedByUserId) ?? null,
}));

return {
  /* ... */
  paymentRecords, // now enriched
  /* ... */
};
```

**Acceptance for 5E:**
- `tsc --noEmit` passes.
- Grep `payment.closerId` and `paymentCloserNameById` returns zero hits across `convex/closer/**`, `convex/customers/**`, `convex/reviews/**`.
- Grep `getCustomerTotalPaid` returns zero hits anywhere.
- `getMeetingDetail`, `getReminderDetail`, `getCustomerDetail`, `getReviewDetail` return payments with the full enriched shape (program + payment type + commissionable + attributed/recorded names).

> **Follow-up note** (defer to a cleanup PR after Phase 9 lands): extract the shared "enrich payment array with attributed + recorded names" loop into `convex/lib/paymentEnrichment.ts` so `meetingDetail`, `reminderDetail` (closer + admin variants), `getCustomerDetail`, and `getReviewDetail` all share one implementation. The loop is copy-pasted across five files in Phase 5E — this is a recognized tradeoff for parallelization (five devs can touch five files without stepping on each other), but the duplication should be collapsed once the feature ships. Add a TODO comment above each duplicated block pointing at the follow-up issue.

---

## Rollout Notes

1. **Deploy ordering:** Phase 5 must deploy atomically with Phase 4 (the write paths it reads from). A production deploy of Phase 5 without Phase 4 means every dashboard card shows zeros for the new split counters (the `applyPaymentStatsDelta` writes haven't started yet). A deploy of Phase 4 without Phase 5 means existing dashboard cards still read `totalRevenueMinor` and still show the correct all-time total (it stays in sync thanks to `applyPaymentStatsDelta`'s fallback) — but the new split counter fields return 0 and confuse anyone who deep-links to the report.

2. **Preview smoke test:** Seed one `tenantPrograms` row, log one commissionable PIF, one commissionable deposit, one admin-recorded customer-direct payment. Open `/workspace` (admin dashboard), `/workspace/reports/revenue`, `/workspace/reports/reminders`, `/workspace/reports/team`. Every KPI should show a non-zero, correctly-categorized amount. No NaN, no `undefined`, no missing program name. Activity feed shows the three payment events with `paymentMetadata` populated.

3. **Production rollout window** (24h post-deploy):
    - Monitor `[Payment]`, `[Dashboard]`, `[Reporting]` console tags in Convex logs for parse errors or missing-field warnings.
    - Run `npx convex data paymentRecords` and spot-check 5 rows — every row should have `programId`, `programName`, `paymentType`, `commissionable`, `attributedCloserId` (if commissionable), `recordedByUserId`. Any row missing these is a Phase 4 leak, not a Phase 5 bug.
    - Spot-check `tenantStats` — `totalCommissionableFinalRevenueMinor + totalCommissionableDepositRevenueMinor + totalNonCommissionableFinalRevenueMinor + totalNonCommissionableDepositRevenueMinor` should equal `totalRevenueMinor` exactly. Drift indicates an `applyPaymentStatsDelta` call path that bypassed `applyPaymentStatsDelta` — investigate which mutation wrote the row.

4. **Rollback trigger:** If the production dashboard shows a materially different "Revenue Logged" value than the pre-deploy value (not counting the expected split), rollback Phases 4 + 5 together. The ledger (`paymentRecords`) is intact and replayable — Phase 3's `tenantStats` counters can be recomputed from the ledger with a short internal action (to be written as part of the rollback plan).

---

## Smoke Test Script (per `TESTING.MD`)

**Setup** (Convex CLI):
1. Run `npx convex run testing/programs:seedTestProgram '{"tenantId": "<tenant>", "name": "Launchpad"}'` — seeds one `tenantPrograms` row.
2. Run `npx convex run testing/calendly:bookTestInvitee` to create a meeting.
3. Sign in as a test closer → start the meeting.

**Commissionable PIF:**
4. In the meeting detail UI, click "Log Payment" → select Launchpad → PIF → $3,000 → submit.
5. Check `npx convex data paymentRecords --limit 1` → confirm `commissionable: true`, `paymentType: "pif"`, `origin: "closer_meeting"`, `attributedCloserId` === closer user id.
6. Check `/workspace` → `revenueLogged` should be `3000` (commissionable final).

**Commissionable deposit:**
7. In a new meeting / new opportunity, log a payment with `paymentType: "deposit"`, $500.
8. Check `/workspace` → `depositsCollected` should be `500`. `revenueLogged` still `3000`.

**Admin customer-direct payment:**
9. Convert the first closed-won opportunity to customer.
10. Sign in as tenant_admin. Open the customer detail page. Click "Record Payment" → monthly → $199 → submit.
11. Check `/workspace` → `postConversionRevenueLogged` should be `199`. `revenueLogged` still `3000`.

**Report page cross-check:**
12. Open `/workspace/reports/revenue` → Closed-Won $3,000, Deposits $500, Post-Conversion $199. Filter by `programId = Launchpad` → same three values. Filter by `paymentType = deposit` → only $500 shows in Deposits card, everything else zero.

**Activity feed:**
13. Open `/workspace/reports/activity` → the three payment events show `Program • Payment Type • Commissionable?` badges. The PIF event shows "Launchpad • PIF • Commissionable (Alice Closer)". The customer-direct event shows "Launchpad • Monthly • Post-Conversion".

If all 13 steps pass, Phase 5 is green and Phases 6-9 can begin.
