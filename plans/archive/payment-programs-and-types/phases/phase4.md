# Phase 4 — Payment Write Paths + Admin Reminder Query

**Goal:** Rewrite every payment mutation so it consumes Phase 3's helpers (`assertPaymentRow`, `requireActiveProgram`, `applyPaymentStatsDelta`), accepts the new `programId` + `paymentType` args, drops the legacy `provider` field everywhere, drops `referenceCode` on the meeting/reminder flows while preserving it on the customer-direct and review-resolution flows where it remains valid, computes commissionability + attribution at write time (never read-time inference), and routes every dollar delta into the correct split counter. Ship alongside a new `getAdminReminderDetail` query so admins can view reminder detail pages as part of extending `logReminderPayment` to admin callers.

Five mutations rewritten:
1. `convex/closer/payments.ts::logPayment` (meeting flow — closer + admin on behalf)
2. `convex/closer/reminderOutcomes.ts::logReminderPayment` (reminder flow — closer self; **extended to admin callers with new `admin_reminder` origin**)
3. `convex/customers/mutations.ts::recordCustomerPayment` (**admin-only**, non-commissionable, `customer_direct` origin)
4. `convex/lib/outcomeHelpers.ts::createPaymentRecord` (helper used by `resolveReview`'s `log_payment` action → `admin_review_resolution` origin)
5. `convex/reviews/mutations.ts::resolveReview` dispute branch (updated to call `applyPaymentStatsDelta` instead of raw `updateTenantStats`)

One new query:
- `convex/pipeline/reminderDetail.ts::getAdminReminderDetail` (mirrors the closer version but authorizes any tenant admin)

**Prerequisite:**
- **Phases 1–3 merged.** `tenantPrograms`, the rewritten `paymentRecords` schema, `paymentSums` re-keyed, and the new helpers (`assertPaymentRow`, `requireActiveProgram`, `applyPaymentStatsDelta`) must all be in place. Phase 4 consumes them everywhere.
- `convex/lib/paymentTypes.ts` (created in 3A amendment) exports `CommissionableOrigin`, `NonCommissionableOrigin`, `PaymentType`, `AssertablePaymentShape`.
- `convex/reporting/writeHooks.ts::insertPaymentAggregate` already has the commissionable-only guard (Phase 2D).
- `convex/reporting/writeHooks.ts::replacePaymentAggregate` already handles the 4-state transition matrix (Phase 2D).

**Runs in PARALLEL with:** Nothing before it completes. Phase 4 can run in **partial parallel** with itself — subphases 4A, 4B, 4C, 4E all touch different files and are safe to stream concurrently. 4D overlaps 4A/4B/4C only if a dev takes care with `convex/reviews/mutations.ts` (a single file with many branches; a single owner keeps merge hygiene simple).

> **Critical path:** Phase 4 sits between helper infrastructure (Phase 3) and the reporting rewrite (Phase 5) / payment-dialog frontend work (Phases 7–9). Phase 6 remains independent because it only reads `tenantPrograms`. This is also where the frontend breaks most visibly — a Phase 4 deploy without a matching Phase 7/8 UI deploy means payment dialogs submit payloads the backend rejects. The parallelization strategy (see the dedicated doc) locks the rewritten payment-mutation backend and matching frontend dialog rollout together inside the same coordinated release window.

**Skills to invoke:**
- `convex-performance-audit` — confirm none of the rewritten mutations leaks an unbounded `.collect()` on a heavy table; every read path is already bounded via `take(N)` or `.first()`.
- `convex-migration-helper` — sanity-check the "breaking frontend args" concern: all four mutations drop / rename args, and the Convex arg validator rejects unknown keys. Phase 4 + Phase 7 must deploy together to production, or preview stacks must deploy both before promoting. Document the deploy ordering in the rollout checklist.
- `workos` (reference only) — `recordCustomerPayment` is now admin-only; confirm the Convex RBAC check (`requireTenantUser(ctx, ["tenant_master", "tenant_admin"])`) aligns with the WorkOS role mapping in `convex/lib/roleMapping.ts`. No code change needed in Phase 4, just a callout for QA.

**Acceptance Criteria:**
1. `logPayment` accepts `programId: v.id("tenantPrograms")` + `paymentType: v.union(monthly|split|pif|deposit)`, rejects `provider`, rejects `referenceCode` (they're no longer declared in the validator), calls `requireActiveProgram`, computes `attributedCloserId` from `role` + `opportunity.assignedCloserId`, throws `"Assign a closer before logging a commissionable payment"` when role≠closer and `assignedCloserId` is undefined, calls `assertPaymentRow` before insert, inserts the new payment row shape (including `programId`, `programName`, `paymentType`, `commissionable: true`, `recordedByUserId`, `origin`), and calls `applyPaymentStatsDelta` with the correct `wonDealDelta` + `activeOpportunityDelta`.
2. `logReminderPayment` accepts the same new args, authorizes `closer`, `tenant_master`, `tenant_admin` (extended from closer-only), normalizes `opportunity.assignedCloserId = followUp.closerId` when they have drifted, computes `attributedCloserId = role === "closer" ? userId : followUp.closerId`, and sets `origin` to `closer_reminder` or `admin_reminder` accordingly.
3. `recordCustomerPayment` authorizes ONLY `tenant_master`, `tenant_admin` (closer access removed), sets `commissionable: false`, `attributedCloserId: undefined`, `origin: "customer_direct"`, `originatingOpportunityId: customer.winningOpportunityId`, `contextType: "customer"`, calls `assertPaymentRow` (invariant I4 catches missing `customerId`), and calls `applyPaymentStatsDelta` with only the `commissionable: false, paymentType, amountMinorDelta` keys (no `wonDealDelta`, no `activeOpportunityDelta`).
4. `createPaymentRecord` accepts `programId` + `paymentType` in its args type, looks up the program, sets `origin: "admin_review_resolution"` + `commissionable: true`, throws `"Assign a closer before logging a commissionable payment"` when the opportunity is unassigned, calls `assertPaymentRow`, calls `applyPaymentStatsDelta`, and delegates auto-conversion to `executeConversion`.
5. `resolveReview` dispute branch (action `dispute`) replaces the current raw `updateTenantStats` call with `applyPaymentStatsDelta({ commissionable: disputedPayment.commissionable, paymentType: disputedPayment.paymentType, amountMinorDelta: -disputedPayment.amountMinor, wonDealDelta: disputedPayment.commissionable ? -1 : 0, activeOpportunityDelta: disputedPayment.commissionable ? 1 : 0 })`, and calls `replacePaymentAggregate` with the `oldPayment`/`updatedPayment` pair (unchanged API shape; Phase 2D handles the 4-state transition internally).
6. `resolveReview` `log_payment` action branch forwards the admin-submitted `programId` + `paymentType` to `createPaymentRecord` (the `log_payment` review form gains these fields in Phase 7, but the backend arg wiring lands here).
7. `convex/pipeline/reminderDetail.ts::getAdminReminderDetail` exists, authorizes `tenant_master` + `tenant_admin` only, accepts `followUpId: v.id("followUps")`, loads the followUp row and validates tenant ownership (not closer ownership), returns the same shape the closer version returns (`{ followUp, opportunity, lead, latestMeeting, payments, paymentLinks }`), and is callable via `api.pipeline.reminderDetail.getAdminReminderDetail`.
8. All five write paths log payment inserts with the `[Payment]` / `[Closer:Payment]` / `[Customer]` / `[Review]` domain tag showing the resolved `programId`, `paymentType`, `commissionable`, and `attributedCloserId` values.
9. `pnpm tsc --noEmit` passes with zero errors. Every removed field (`provider`, `referenceCode` on outcome paths, `closerId`, `loggedByAdminUserId`) produces zero grep hits in `convex/closer/**`, `convex/customers/**`, `convex/reviews/**`, `convex/lib/outcomeHelpers.ts`.
10. End-to-end smoke test (per `TESTING.MD`): seed a program via Phase 1's `ensureInitialProgramForTenant`, book a test invitee, start a meeting, submit a payment from both a closer identity and an admin identity → confirm one `paymentRecords` row with the correct commissionable/attribution shape, one `paymentSums` row when commissionable, `tenantStats.totalCommissionableFinalRevenueMinor` incremented by exactly `amountMinor`.
11. Dispute smoke test: log a commissionable payment, then `resolveReview` → `dispute` that payment → confirm `tenantStats.totalCommissionableFinalRevenueMinor` decremented by `amountMinor`, `wonDeals -1`, `activeOpportunities +1`, `paymentSums` entry still present but `sumValue` now 0 (status === "disputed" branch).

---

## Subphase Dependency Graph

```
4A (logPayment) ──────┐
                      │
4B (logReminderPayment + admin) ──┤
                      │
4C (recordCustomerPayment) ───────┼── Phase 4 complete ───▶ Phase 5
                      │
4D (createPaymentRecord + resolveReview) ─┤
                      │
4E (getAdminReminderDetail) ──────┘
```

All five subphases are **independent** at the file level:
- 4A → `convex/closer/payments.ts`
- 4B → `convex/closer/reminderOutcomes.ts`
- 4C → `convex/customers/mutations.ts`
- 4D → `convex/lib/outcomeHelpers.ts` + `convex/reviews/mutations.ts`
- 4E → `convex/pipeline/reminderDetail.ts` (new file; `convex/pipeline/` directory may need creation)

**Optimal execution:**
1. **Start 4A, 4B, 4C, 4D, 4E in parallel** — five files, five streams. Three engineers can comfortably own them in one or two-file bundles (4A + 4E for one dev, 4B for another, 4C + 4D for a third).
2. After all land, run the `tsc --noEmit` + grep sweep together. Individual passes can show transient errors (e.g., 4A removes `provider` from `logPayment`, but the Phase 7 frontend still sends it; `tsc` catches the arg-validator mismatch at the Convex boundary only at runtime, not compile time).

**Estimated time:** 1.5 days solo, 0.75 day with 3 parallel streams.

---

## Subphases

### 4A — `logPayment` Rewrite (Meeting Flow)

**Type:** Backend
**Parallelizable:** Yes — independent of 4B/4C/4D/4E. Owns `convex/closer/payments.ts`.

**What:** Replace the `logPayment` mutation's args, auth check, payment-row construction, and stats update with the new shape documented in design §7.2. Drop `provider` and `referenceCode` from the validator. Add `programId` and `paymentType`. Compute `attributedCloserId` and `origin` based on `role`. Call `requireActiveProgram` + `assertPaymentRow` + `applyPaymentStatsDelta`.

**Why:** This is the primary closer entry point for payment logging and the most frequently-exercised write path. Getting it right validates every Phase 3 helper in one pass. It also sets the template that 4B, 4C, 4D follow.

**Where:**
- `convex/closer/payments.ts` (modify)

**How:**

**Step 1: Update imports**

**Before (lines 1–17):**

```typescript
// Path: convex/closer/payments.ts (BEFORE)
import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { validateTransition } from "../lib/statusTransitions";
import { executeConversion } from "../customers/conversion";
import { emitDomainEvent } from "../lib/domainEvents";
import { toAmountMinor, validateCurrency } from "../lib/formatMoney";
import { assertOverranReviewStillPending } from "../lib/overranReviewGuards";
import { syncCustomerPaymentSummary } from "../lib/paymentHelpers";
import {
  insertPaymentAggregate,
  replaceOpportunityAggregate,
} from "../reporting/writeHooks";
import {
  isActiveOpportunityStatus,
  updateTenantStats,
} from "../lib/tenantStatsHelper";
```

**After:**

```typescript
// Path: convex/closer/payments.ts (AFTER)
import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { validateTransition } from "../lib/statusTransitions";
import { executeConversion } from "../customers/conversion";
import { emitDomainEvent } from "../lib/domainEvents";
import { toAmountMinor, validateCurrency } from "../lib/formatMoney";
import { assertOverranReviewStillPending } from "../lib/overranReviewGuards";
import {
  assertPaymentRow,
  requireActiveProgram,
  syncCustomerPaymentSummary,
  type CommissionableOrigin,
} from "../lib/paymentHelpers";
import {
  insertPaymentAggregate,
  replaceOpportunityAggregate,
} from "../reporting/writeHooks";
import {
  applyPaymentStatsDelta,
  isActiveOpportunityStatus,
} from "../lib/tenantStatsHelper";
// REMOVED: updateTenantStats — applyPaymentStatsDelta supersedes it here.
```

**Step 2: Replace the args validator**

**Before:**

```typescript
// Path: convex/closer/payments.ts (BEFORE — args block)
args: {
  opportunityId: v.id("opportunities"),
  meetingId: v.id("meetings"),
  amount: v.number(),
  currency: v.string(),
  provider: v.string(),
  referenceCode: v.optional(v.string()),
  proofFileId: v.optional(v.id("_storage")),
},
```

**After:**

```typescript
// Path: convex/closer/payments.ts (AFTER)
args: {
  opportunityId: v.id("opportunities"),
  meetingId: v.id("meetings"),
  amount: v.number(),
  currency: v.string(),
  // NEW — program FK + display cache resolved via requireActiveProgram.
  programId: v.id("tenantPrograms"),
  // NEW — business intent; deposit routes to a separate counter.
  paymentType: v.union(
    v.literal("monthly"),
    v.literal("split"),
    v.literal("pif"),
    v.literal("deposit"),
  ),
  // REMOVED: provider, referenceCode — meeting-flow payments no longer
  // collect a provider string or manual reference code.
  proofFileId: v.optional(v.id("_storage")),
},
```

**Step 3: Rewrite the handler body (insert → aggregate → conversion)**

Replace the handler body from the point of validation through the tenant-stats update. The existing opportunity/meeting validation blocks (role check, meeting-belongs-to-opp check, overran-review guard, status transition, amount guard, currency validation) stay unchanged — they're already correct.

Insert right after the existing `const amountMinor = toAmountMinor(args.amount);` line:

```typescript
// Path: convex/closer/payments.ts (INSERT — after currency/amount validation)

// === Program resolution ===
const program = await requireActiveProgram(ctx, tenantId, args.programId);
const now = Date.now();

// === Attribution decision (always commissionable for logPayment) ===
// Closer self-logs: attributedCloserId = userId, origin = "closer_meeting"
// Admin on behalf:  attributedCloserId = opportunity.assignedCloserId,
//                   origin = "admin_meeting"
// There is no admin fallback — commissionable money must be attributed to a
// real closer, so orphaned opportunities must be assigned before logging.
if (role !== "closer" && !opportunity.assignedCloserId) {
  throw new Error(
    "Assign a closer before logging a commissionable payment",
  );
}
const attributedCloserId =
  role === "closer" ? userId : opportunity.assignedCloserId!;
const origin: CommissionableOrigin =
  role === "closer" ? "closer_meeting" : "admin_meeting";

const row = {
  tenantId,
  opportunityId: args.opportunityId,
  meetingId: args.meetingId,
  attributedCloserId,
  recordedByUserId: userId,
  commissionable: true as const,
  amountMinor,
  currency,
  programId: args.programId,
  programName: program.name,
  paymentType: args.paymentType,
  proofFileId: args.proofFileId ?? undefined,
  status: "recorded" as const,
  statusChangedAt: now,
  recordedAt: now,
  contextType: "opportunity" as const,
  origin,
  // customerId is backfilled after executeConversion runs (see below).
  customerId: undefined,
};
assertPaymentRow(row);

console.log("[Closer:Payment] logPayment → inserting row", {
  opportunityId: args.opportunityId,
  attributedCloserId,
  recordedByUserId: userId,
  commissionable: true,
  programId: args.programId,
  programName: program.name,
  paymentType: args.paymentType,
  origin,
});

const paymentId = await ctx.db.insert("paymentRecords", row);
await insertPaymentAggregate(ctx, paymentId);
```

**Step 4: Replace the opportunity transition + stats update**

**Before (current code — approx. lines 155–195):**

```typescript
// Path: convex/closer/payments.ts (BEFORE — the transition + stats block)
await ctx.db.patch(args.opportunityId, {
  status: "payment_received",
  paymentReceivedAt: now,
  updatedAt: now,
});
await replaceOpportunityAggregate(ctx, opportunity, args.opportunityId);

await updateTenantStats(ctx, tenantId, {
  totalPaymentRecords: 1,
  totalRevenueMinor: amountMinor,
  wonDeals: 1,
  activeOpportunities: isActiveOpportunityStatus(opportunity.status) ? -1 : 0,
});
```

**After:**

```typescript
// Path: convex/closer/payments.ts (AFTER)
await ctx.db.patch(args.opportunityId, {
  status: "payment_received",
  paymentReceivedAt: now,
  updatedAt: now,
});
await replaceOpportunityAggregate(ctx, opportunity, args.opportunityId);

// === Tenant stats — split counter + legacy lockstep ===
// applyPaymentStatsDelta routes to the correct (commissionable × final/deposit)
// counter AND keeps legacy totalRevenueMinor consistent for rollout compat.
await applyPaymentStatsDelta(ctx, tenantId, {
  commissionable: true,
  paymentType: args.paymentType,
  amountMinorDelta: amountMinor,
  wonDealDelta: 1,
  activeOpportunityDelta: isActiveOpportunityStatus(opportunity.status)
    ? -1
    : 0,
});
```

**Step 5: Update the `payment.recorded` domain event**

**Before:**

```typescript
// Path: convex/closer/payments.ts (BEFORE — emit domain event)
await emitDomainEvent(ctx, {
  tenantId,
  entityType: "payment",
  entityId: paymentId,
  eventType: "payment.recorded",
  source: role === "closer" ? "closer" : "admin",
  actorUserId: userId,
  toStatus: "recorded",
  metadata: {
    opportunityId: args.opportunityId,
    meetingId: args.meetingId,
    amountMinor,
    currency,
    provider: args.provider,
    origin: role === "closer" ? "closer_meeting" : "admin_meeting",
    loggedByAdminUserId: role !== "closer" ? userId : undefined,
  },
  occurredAt: now,
});
```

**After:**

```typescript
// Path: convex/closer/payments.ts (AFTER)
await emitDomainEvent(ctx, {
  tenantId,
  entityType: "payment",
  entityId: paymentId,
  eventType: "payment.recorded",
  source: role === "closer" ? "closer" : "admin",
  actorUserId: userId,
  toStatus: "recorded",
  metadata: {
    opportunityId: args.opportunityId,
    meetingId: args.meetingId,
    amountMinor,
    currency,
    // NEW — canonical program + payment type for activity feed badges.
    programId: args.programId,
    programName: program.name,
    paymentType: args.paymentType,
    // NEW — explicit attribution + commissionability for audit.
    attributedCloserId,
    recordedByUserId: userId,
    commissionable: true,
    origin,
    // REMOVED: provider, loggedByAdminUserId (replaced by recordedByUserId).
  },
  occurredAt: now,
});
```

**Step 6: Keep the auto-conversion block and customerId backfill**

The auto-conversion block (existing `executeConversion` call, customer lookup fallback) doesn't change — Phase 3C updated `executeConversion` to drop `programType`. Phase 4A removes the `programType: undefined` arg forwarding (it already wasn't passed from `logPayment`, so this is a confirmation step, not an edit).

```typescript
// Path: convex/closer/payments.ts (confirmation — no change vs. current)
const customerId = await executeConversion(ctx, {
  tenantId,
  leadId: opportunity.leadId,
  convertedByUserId: userId,
  winningOpportunityId: args.opportunityId,
  winningMeetingId: args.meetingId,
  // REMOVED: programType — executeConversion resolves from this payment now.
});
if (customerId) {
  await ctx.db.patch(paymentId, { customerId });
  await syncCustomerPaymentSummary(ctx, customerId);
} else {
  // Returning-customer case (existing customer on the same lead).
  const existing = await ctx.db
    .query("customers")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", opportunity.leadId),
    )
    .first();
  if (existing) {
    await ctx.db.patch(paymentId, { customerId: existing._id });
    await syncCustomerPaymentSummary(ctx, existing._id);
  }
}

return paymentId;
```

**Step 7: Typecheck**

```bash
pnpm tsc --noEmit
```

Expected errors:
- `payment-form-dialog.tsx` (frontend) still passes `provider: values.provider` and `referenceCode: ...`. This typechecks at the Convex client boundary but fails at runtime (arg validator rejects extraneous keys). Phase 7 fixes the frontend. Mark these as known Phase 4 → Phase 7 deploy-lockstep breakage; do NOT "temporarily re-add" `provider` to keep the frontend working.
- `app/workspace/pipeline/meetings/[meetingId]/_components/admin-meeting-detail-client.tsx` (admin admin detail page) — no args change (admin doesn't call `logPayment` directly; admin uses `resolveReview`), so no breakage.

**Key implementation notes:**
- **`row` object literal with `as const` assertions.** TypeScript infers `string` instead of the literal when passed to Convex; the `as const` suffix on `commissionable`, `status`, `contextType` narrows to literals that match the schema union. Without it, `assertPaymentRow`'s param type `AssertablePaymentShape` might reject the row.
- **`customerId: undefined` in the initial row.** Set explicitly so the row object literal matches `AssertablePaymentShape`'s `customerId: Id<"customers"> | undefined` requirement. Without it, TypeScript's excess-property check fails when assertPaymentRow is called.
- **The `attributedCloserId!` non-null assertion in Step 3** is safe because the explicit `if (role !== "closer" && !opportunity.assignedCloserId)` throw above guarantees that, by the time we reach the ternary, either `role === "closer"` (and we use `userId`) or `opportunity.assignedCloserId` is defined. The assertion signals to TypeScript what it can't derive from the flow.
- **Don't collapse the `role === "closer" ? userId : opportunity.assignedCloserId!` branch into the `assertPaymentRow` call** — keeping it as a named variable makes the row literal readable and lets the domain event re-use the same value.
- **No `provider` → `programName` migration.** The fields represent different concepts: `provider` was "who processed the payment" (Stripe, manual, etc.); `programName` is "which program is the customer buying into." Dropping `provider` is a true deletion, not a rename.
- **`statusChangedAt: now` on insert** matches the existing pattern in `paymentRecords`; it's always set on first write and patched on every status change.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/payments.ts` | Modify | `logPayment`: new args; handler rewrite to use Phase 3 helpers. |

---

### 4B — `logReminderPayment` Rewrite + Admin Extension

**Type:** Backend
**Parallelizable:** Yes — independent of 4A/4C/4D/4E. Owns `convex/closer/reminderOutcomes.ts`.

**What:** Mirror the `logPayment` rewrite plus three additions:
1. Authorize `tenant_master` and `tenant_admin` in addition to `closer`.
2. When admin logs on behalf, normalize `opportunity.assignedCloserId = followUp.closerId` if they've drifted (closers own reminders; opportunity assignment may have shifted later).
3. Set `origin = role === "closer" ? "closer_reminder" : "admin_reminder"`.

**Why:** Design §7.3 explicitly calls for admin-reminder support. Without this, admins who need to log reminder-driven payments on behalf of a closer have no path. The `admin_reminder` origin distinguishes these rows in reports from meeting-driven ones.

**Where:**
- `convex/closer/reminderOutcomes.ts` (modify)

**How:**

**Step 1: Update imports**

```typescript
// Path: convex/closer/reminderOutcomes.ts (MODIFY imports)
import {
  assertPaymentRow,
  requireActiveProgram,
  syncCustomerPaymentSummary,
  type CommissionableOrigin,
} from "../lib/paymentHelpers";
import {
  applyPaymentStatsDelta,
  isActiveOpportunityStatus,
} from "../lib/tenantStatsHelper";
// Same transition: drop `updateTenantStats` import; keep validateCurrency,
// toAmountMinor, and the existing insert helpers.
```

**Step 2: Rewrite the args validator**

```typescript
// Path: convex/closer/reminderOutcomes.ts (AFTER)
args: {
  followUpId: v.id("followUps"),
  amount: v.number(),
  currency: v.string(),
  programId: v.id("tenantPrograms"),
  paymentType: v.union(
    v.literal("monthly"),
    v.literal("split"),
    v.literal("pif"),
    v.literal("deposit"),
  ),
  // REMOVED: provider, referenceCode.
  proofFileId: v.optional(v.id("_storage")),
},
```

**Step 3: Extend the authorization**

**Before:**

```typescript
// Path: convex/closer/reminderOutcomes.ts (BEFORE)
const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

const followUp = await ctx.db.get(args.followUpId);
if (!followUp || followUp.tenantId !== tenantId) {
  throw new Error("Reminder not found");
}
if (followUp.closerId !== userId) {
  throw new Error("Not your reminder");
}
```

**After:**

```typescript
// Path: convex/closer/reminderOutcomes.ts (AFTER)
const { userId, tenantId, role } = await requireTenantUser(ctx, [
  "closer",
  "tenant_master",
  "tenant_admin",
]);

const followUp = await ctx.db.get(args.followUpId);
if (!followUp || followUp.tenantId !== tenantId) {
  throw new Error("Reminder not found");
}
// Closer authorization: only own reminders. Admins: any reminder in the tenant.
if (role === "closer" && followUp.closerId !== userId) {
  throw new Error("Not your reminder");
}
```

**Step 4: Add the opportunity assignment normalization**

Insert after the existing `followUp.type !== "manual_reminder"` guard and the opportunity lookup:

```typescript
// Path: convex/closer/reminderOutcomes.ts (INSERT after opportunity validation)

const program = await requireActiveProgram(ctx, tenantId, args.programId);
const now = Date.now();
const amountMinor = toAmountMinor(args.amount);

// === Opportunity assignment normalization ===
// Reminder owner is the authoritative closer for reminder-driven wins. If
// the reminder owner and opportunity assignment have drifted, normalize the
// opportunity so conversion, customer detail, and lead-conversion reporting
// all point at the same closer.
if (opportunity.assignedCloserId !== followUp.closerId) {
  console.log(
    "[Closer:Reminder] normalizing opportunity assignment",
    {
      opportunityId: opportunity._id,
      previousAssigned: opportunity.assignedCloserId,
      newAssigned: followUp.closerId,
    },
  );
  await ctx.db.patch(opportunity._id, {
    assignedCloserId: followUp.closerId,
    updatedAt: now,
  });
}

// === Attribution decision ===
// Always commissionable; always attributed to the reminder OWNER (not the
// admin clicking "log payment"). Admin + reminder_owner identity check:
//   role=closer  → origin=closer_reminder, attributedCloserId=userId (must === followUp.closerId)
//   role=admin   → origin=admin_reminder,  attributedCloserId=followUp.closerId
const attributedCloserId =
  role === "closer" ? userId : followUp.closerId;
const origin: CommissionableOrigin =
  role === "closer" ? "closer_reminder" : "admin_reminder";

const meetingId = opportunity.latestMeetingId ?? undefined;

const row = {
  tenantId,
  opportunityId: opportunity._id,
  meetingId,
  attributedCloserId,
  recordedByUserId: userId,
  commissionable: true as const,
  amountMinor,
  currency: validateCurrency(args.currency),
  programId: args.programId,
  programName: program.name,
  paymentType: args.paymentType,
  proofFileId: args.proofFileId ?? undefined,
  status: "recorded" as const,
  statusChangedAt: now,
  recordedAt: now,
  contextType: "opportunity" as const,
  origin,
  customerId: undefined,
};
assertPaymentRow(row);

const paymentId = await ctx.db.insert("paymentRecords", row);
await insertPaymentAggregate(ctx, paymentId);
```

**Step 5: Keep the existing opportunity transition + followUp patch + conversion block**

Replace the existing `updateTenantStats` call with `applyPaymentStatsDelta`:

```typescript
// Path: convex/closer/reminderOutcomes.ts (MODIFY the stats call)

// Transition the opportunity (unchanged).
await ctx.db.patch(opportunity._id, {
  status: "payment_received",
  paymentReceivedAt: now,
  updatedAt: now,
});
await replaceOpportunityAggregate(ctx, opportunity, opportunity._id);

// Resolve the followUp (unchanged pattern — mark completed, emit event).
await ctx.db.patch(args.followUpId, {
  status: "completed",
  completedAt: now,
  resolvedAt: now,
  // ...other existing followUp completion fields unchanged...
});

// Stats — split counter (replaces updateTenantStats).
await applyPaymentStatsDelta(ctx, tenantId, {
  commissionable: true,
  paymentType: args.paymentType,
  amountMinorDelta: amountMinor,
  wonDealDelta: 1,
  activeOpportunityDelta: isActiveOpportunityStatus(opportunity.status)
    ? -1
    : 0,
});

// Domain event for payment.recorded (same shape as logPayment in 4A).
await emitDomainEvent(ctx, {
  tenantId,
  entityType: "payment",
  entityId: paymentId,
  eventType: "payment.recorded",
  source: role === "closer" ? "closer" : "admin",
  actorUserId: userId,
  toStatus: "recorded",
  metadata: {
    opportunityId: opportunity._id,
    followUpId: args.followUpId,
    amountMinor,
    currency: row.currency,
    programId: args.programId,
    programName: program.name,
    paymentType: args.paymentType,
    attributedCloserId,
    recordedByUserId: userId,
    commissionable: true,
    origin,
  },
  occurredAt: now,
});

// Auto-conversion (unchanged call; executeConversion resolves program from
// this payment).
const customerId = await executeConversion(ctx, {
  tenantId,
  leadId: opportunity.leadId,
  convertedByUserId: userId,
  winningOpportunityId: opportunity._id,
  winningMeetingId: meetingId,
});
if (customerId) {
  await ctx.db.patch(paymentId, { customerId });
  await syncCustomerPaymentSummary(ctx, customerId);
} else {
  const existing = await ctx.db
    .query("customers")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", opportunity.leadId),
    )
    .first();
  if (existing) {
    await ctx.db.patch(paymentId, { customerId: existing._id });
    await syncCustomerPaymentSummary(ctx, existing._id);
  }
}

return paymentId;
```

**Step 6: Smoke test**

After the matching Phase 7 admin reminder route ships, invoke `logReminderPayment` as an admin identity via the Convex dashboard:

```bash
npx convex run closer:reminderOutcomes:logReminderPayment \
  '{ "followUpId": "<id>", "amount": 50000, "currency": "USD",
     "programId": "<id>", "paymentType": "pif" }'
```

Expected outcome: `paymentRecords` row with `origin === "admin_reminder"`, `attributedCloserId` matching `followUp.closerId`, `recordedByUserId` matching the admin. `tenantStats.totalCommissionableFinalRevenueMinor` incremented.

**Key implementation notes:**
- **Normalization happens BEFORE the payment insert** so the payment row's `attributedCloserId` and the post-insert `opportunity.assignedCloserId` agree. If an admin is logging on behalf of the closer and the opportunity was previously reassigned, the reminder drives the re-attribution.
- **The `meetingId` is optional** — reminders can fire without a preceding meeting (the closer may have manually scheduled a reminder without holding a meeting first). We read `opportunity.latestMeetingId ?? undefined`, which accepts either.
- **`attributedCloserId` for admin path is `followUp.closerId`, not `opportunity.assignedCloserId`.** The reminder's owner is the authoritative closer; opportunity assignment is a downstream consequence (which we then normalize in Step 4). Not reversing these two is the difference between correct attribution and silently attributing revenue to the admin.
- **`followUp.type === "manual_reminder"` guard is unchanged** — only manual reminders can be resolved via this mutation. Other `followUp.type` values (e.g., `reschedule_link_expired`) have their own resolution paths.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/reminderOutcomes.ts` | Modify | `logReminderPayment`: new args + admin role + assignment normalization + helper integration. |

---

### 4C — `recordCustomerPayment` Rewrite (Admin-Only, Non-Commissionable)

**Type:** Backend
**Parallelizable:** Yes — independent. Owns a contiguous section of `convex/customers/mutations.ts`.

**What:** Narrow `recordCustomerPayment` to admins only (`tenant_master`, `tenant_admin`). Replace the current commissionable-style write with a non-commissionable one: `commissionable: false`, `attributedCloserId: undefined`, `origin: "customer_direct"`, `originatingOpportunityId: customer.winningOpportunityId`, `contextType: "customer"`. Call `requireActiveProgram`, `assertPaymentRow`, `applyPaymentStatsDelta` with `commissionable: false`.

**Why:** Design §8.3 makes post-conversion payments admin-only. Closers retain read access to customer pages for context but never write post-conversion revenue. Non-commissionable payments don't trigger conversion (the customer already exists) and don't touch the opportunity state machine.

**Where:**
- `convex/customers/mutations.ts` (modify — only the `recordCustomerPayment` function)

**How:**

**Step 1: Update imports**

```typescript
// Path: convex/customers/mutations.ts (MODIFY imports)
import {
  assertPaymentRow,
  requireActiveProgram,
  syncCustomerPaymentSummary,
} from "../lib/paymentHelpers";
import { applyPaymentStatsDelta } from "../lib/tenantStatsHelper";
// Drop: updateTenantStats (applyPaymentStatsDelta replaces); keep
// insertPaymentAggregate, emitDomainEvent, toAmountMinor, validateCurrency.
```

**Step 2: Narrow the args + authorization**

**Before:**

```typescript
// Path: convex/customers/mutations.ts (BEFORE — args + auth)
args: {
  customerId: v.id("customers"),
  amount: v.number(),
  currency: v.string(),
  provider: v.string(),
  referenceCode: v.optional(v.string()),
  proofFileId: v.optional(v.id("_storage")),
},
handler: async (ctx, args) => {
  console.log("[Customer] recordCustomerPayment called", {
    customerId: args.customerId,
    amount: args.amount,
  });
  const { userId, tenantId, role } = await requireTenantUser(ctx, [
    "closer",
    "tenant_master",
    "tenant_admin",
  ]);

  const customer = await ctx.db.get(args.customerId);
  if (!customer || customer.tenantId !== tenantId) {
    throw new Error("Customer not found");
  }

  // Closer authorization: can only record payments on their own customers
  if (role === "closer" && customer.convertedByUserId !== userId) {
    throw new Error("Not your customer");
  }
  // ...
```

**After:**

```typescript
// Path: convex/customers/mutations.ts (AFTER)
args: {
  customerId: v.id("customers"),
  amount: v.number(),
  currency: v.string(),
  // NEW — program FK + cache.
  programId: v.id("tenantPrograms"),
  paymentType: v.union(
    v.literal("monthly"),
    v.literal("split"),
    v.literal("pif"),
    v.literal("deposit"),
  ),
  // KEPT — referenceCode is still useful for customer-direct (admin notes
  // the Stripe ref / manual transaction number).
  referenceCode: v.optional(v.string()),
  // REMOVED: provider — retired across all payment paths.
  proofFileId: v.optional(v.id("_storage")),
},
handler: async (ctx, args) => {
  console.log("[Customer] recordCustomerPayment called", {
    customerId: args.customerId,
    amount: args.amount,
    programId: args.programId,
    paymentType: args.paymentType,
  });
  // Admin-only in v0.5.1. Closers have read access on customer pages but
  // never write post-conversion revenue.
  const { userId, tenantId } = await requireTenantUser(ctx, [
    "tenant_master",
    "tenant_admin",
  ]);

  const customer = await ctx.db.get(args.customerId);
  if (!customer || customer.tenantId !== tenantId) {
    throw new Error("Customer not found");
  }
  // Removed: closer convertedByUserId ownership check — closers don't reach
  // this mutation at all anymore.
```

**Step 3: Replace the payment-row construction**

**Before:**

```typescript
// Path: convex/customers/mutations.ts (BEFORE — row insert)
const loggedByAdminUserId = role === "closer" ? undefined : userId;
const paymentId = await ctx.db.insert("paymentRecords", {
  tenantId,
  closerId: userId,
  customerId: args.customerId,
  amountMinor,
  currency,
  provider,
  referenceCode: args.referenceCode?.trim() || undefined,
  proofFileId: args.proofFileId ?? undefined,
  status: "recorded",
  statusChangedAt: now,
  recordedAt: now,
  contextType: "customer",
  origin: "customer_flow",
  loggedByAdminUserId,
});
```

**After:**

```typescript
// Path: convex/customers/mutations.ts (AFTER)
const currency = validateCurrency(args.currency);
const program = await requireActiveProgram(ctx, tenantId, args.programId);
const now = Date.now();
const amountMinor = toAmountMinor(args.amount);

// === Non-commissionable row ===
// No attributedCloserId. recordedByUserId = admin clicking the button.
// originatingOpportunityId copies customer.winningOpportunityId so audit
// tooling doesn't need to walk the customer row to trace revenue back to
// the won deal.
const row = {
  tenantId,
  opportunityId: undefined,
  customerId: args.customerId,
  originatingOpportunityId: customer.winningOpportunityId,
  attributedCloserId: undefined,
  recordedByUserId: userId,
  commissionable: false as const,
  amountMinor,
  currency,
  programId: args.programId,
  programName: program.name,
  paymentType: args.paymentType,
  referenceCode: args.referenceCode?.trim() || undefined,
  proofFileId: args.proofFileId ?? undefined,
  status: "recorded" as const,
  statusChangedAt: now,
  recordedAt: now,
  contextType: "customer" as const,
  origin: "customer_direct" as const,
};
assertPaymentRow(row);

const paymentId = await ctx.db.insert("paymentRecords", row);
// Note: insertPaymentAggregate early-returns for non-commissionable rows
// (Phase 2D guard), so this is a safe no-op here — but we still call it
// to keep the write-path shape uniform across mutations.
await insertPaymentAggregate(ctx, paymentId);
await syncCustomerPaymentSummary(ctx, args.customerId);
```

**Step 4: Replace `updateTenantStats` with `applyPaymentStatsDelta`**

**Before:**

```typescript
// Path: convex/customers/mutations.ts (BEFORE)
await updateTenantStats(ctx, tenantId, {
  totalPaymentRecords: 1,
  totalRevenueMinor: amountMinor,
});
```

**After:**

```typescript
// Path: convex/customers/mutations.ts (AFTER)
// Non-commissionable counter only. No wonDealDelta (already won).
// No activeOpportunityDelta (opportunity already in terminal state).
await applyPaymentStatsDelta(ctx, tenantId, {
  commissionable: false,
  paymentType: args.paymentType,
  amountMinorDelta: amountMinor,
});
```

**Step 5: Update the domain event**

**Before:**

```typescript
// Path: convex/customers/mutations.ts (BEFORE)
await emitDomainEvent(ctx, {
  tenantId,
  entityType: "payment",
  entityId: paymentId,
  eventType: "payment.recorded",
  source: role === "closer" ? "closer" : "admin",
  actorUserId: userId,
  toStatus: "recorded",
  metadata: {
    customerId: args.customerId,
    amountMinor,
    currency,
    origin: "customer_flow",
    ...(loggedByAdminUserId ? { loggedByAdminUserId } : {}),
  },
  occurredAt: now,
});
```

**After:**

```typescript
// Path: convex/customers/mutations.ts (AFTER)
await emitDomainEvent(ctx, {
  tenantId,
  entityType: "payment",
  entityId: paymentId,
  eventType: "payment.recorded",
  source: "admin",
  actorUserId: userId,
  toStatus: "recorded",
  metadata: {
    customerId: args.customerId,
    originatingOpportunityId: customer.winningOpportunityId,
    amountMinor,
    currency,
    programId: args.programId,
    programName: program.name,
    paymentType: args.paymentType,
    attributedCloserId: null, // null in event metadata signals non-commissionable
    recordedByUserId: userId,
    commissionable: false,
    origin: "customer_direct",
  },
  occurredAt: now,
});
```

**Key implementation notes:**
- **The customer-owned payments summary block** (existing lines 188–205 — `customerPayments = await ctx.db.query(...).take(100)`, etc.) is REPLACED by the single `syncCustomerPaymentSummary` call in Step 3. `syncCustomerPaymentSummary` does exactly the same thing (query by customerId, filter non-disputed, patch totals + currency) and is reused everywhere else. Removing the inline duplicate is a cleanup win.
- **`null` in the domain event's `attributedCloserId`** is a convention to signal non-commissionable. The downstream activity feed consumer (Phase 5 / Phase 9) reads this metadata and renders a "Post-conversion" badge when `attributedCloserId === null`.
- **Closer-access removal is a hard break.** The `record-payment-dialog.tsx` frontend still shows a "Record Payment" button on customer pages for closers. Phase 8 hides the CTA for closers; until that ships, the button throws `"Not your customer" / role-missing-permission` — a loud, visible failure. Document in the rollout checklist that Phase 4C + Phase 8 deploy in lockstep.
- **`originatingOpportunityId` is set unconditionally.** Every customer in v0.5 has a `winningOpportunityId` (set at conversion time in `executeConversion`). If a future path creates a customer without one, `originatingOpportunityId` would be `undefined` — the schema allows this (it's optional). No defensive guard needed.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/customers/mutations.ts` | Modify | `recordCustomerPayment`: narrow to admin; non-commissionable rewrite. |

---

### 4D — `createPaymentRecord` Helper + `resolveReview` Dispute Branch

**Type:** Backend
**Parallelizable:** Partially — touches two files. One engineer owns both to keep review resolution semantics coherent.

**What:**
- Rewrite `convex/lib/outcomeHelpers.ts::createPaymentRecord` to accept `programId` + `paymentType`, validate via `requireActiveProgram` + `assertPaymentRow`, use `applyPaymentStatsDelta`, emit the new metadata shape, and set `origin: "admin_review_resolution"`.
- Update `convex/reviews/mutations.ts::resolveReview` in two places:
  1. `log_payment` action branch — forward new args (`programId`, `paymentType`) from the form submission to `createPaymentRecord`.
  2. `dispute` action branch — replace the current raw `updateTenantStats` call with `applyPaymentStatsDelta` that correctly routes the reversal to the disputed payment's `(commissionable × paymentType)` counter.

**Why:**
1. `createPaymentRecord` is the admin-only review-resolution code path. Every disputed-meeting review that's resolved with "log payment now" runs through it. Without the rewrite, admin-resolved payments would be created with the old shape (missing `programId`/`paymentType`) and fail Phase 2's required-field schema.
2. The dispute branch currently decrements `totalRevenueMinor` unconditionally. Post-Phase 2, it must also decrement the correct split counter — otherwise the dashboard shows `totalRevenueMinor = X` but split counters sum to `X + disputed_amount`, violating the rollout invariant.

**Where:**
- `convex/lib/outcomeHelpers.ts` (modify — rewrite `createPaymentRecord`)
- `convex/reviews/mutations.ts` (modify — `log_payment` action args + `dispute` action stats)

**How:**

**Step 1: Rewrite `createPaymentRecord` args type and signature**

**Before:**

```typescript
// Path: convex/lib/outcomeHelpers.ts (BEFORE — args type)
type CreatePaymentRecordArgs = {
  tenantId: Id<"tenants">;
  opportunityId: Id<"opportunities">;
  meetingId: Id<"meetings">;
  actorUserId: Id<"users">;
  amount: number;
  currency: string;
  provider: string;
  referenceCode?: string;
  proofFileId?: Id<"_storage">;
};
```

**After:**

```typescript
// Path: convex/lib/outcomeHelpers.ts (AFTER)
import type { PaymentType, CommissionableOrigin } from "./paymentHelpers";

type CreatePaymentRecordArgs = {
  tenantId: Id<"tenants">;
  opportunityId: Id<"opportunities">;
  meetingId: Id<"meetings">;
  actorUserId: Id<"users">; // the admin resolving the review
  amount: number;
  currency: string;
  // NEW — canonical program + business intent; carried into the
  // payment row as programId / programName / paymentType.
  programId: Id<"tenantPrograms">;
  paymentType: PaymentType;
  // KEPT — admins typically note a Stripe / manual reference for audit.
  referenceCode?: string;
  proofFileId?: Id<"_storage">;
  // REMOVED: provider.
};
```

**Step 2: Rewrite the handler body**

```typescript
// Path: convex/lib/outcomeHelpers.ts (AFTER — handler)
import {
  assertPaymentRow,
  requireActiveProgram,
  syncCustomerPaymentSummary,
} from "./paymentHelpers";
import { applyPaymentStatsDelta } from "./tenantStatsHelper";
import { insertPaymentAggregate } from "../reporting/writeHooks";

export async function createPaymentRecord(
  ctx: MutationCtx,
  args: CreatePaymentRecordArgs,
): Promise<Id<"paymentRecords">> {
  if (args.amount <= 0) throw new Error("Payment amount must be positive");

  const opportunity = await ctx.db.get(args.opportunityId);
  if (!opportunity || opportunity.tenantId !== args.tenantId) {
    throw new Error("Opportunity not found");
  }

  const currency = validateCurrency(args.currency);
  const program = await requireActiveProgram(ctx, args.tenantId, args.programId);
  const now = Date.now();
  const amountMinor = toAmountMinor(args.amount);

  // Commissionable review resolution: always attribute to the opportunity's
  // assigned closer. No admin fallback — opportunities must have a closer.
  if (!opportunity.assignedCloserId) {
    throw new Error("Assign a closer before logging a commissionable payment");
  }
  const attributedCloserId = opportunity.assignedCloserId;
  const origin: CommissionableOrigin = "admin_review_resolution";

  const row = {
    tenantId: args.tenantId,
    opportunityId: args.opportunityId,
    meetingId: args.meetingId,
    attributedCloserId,
    recordedByUserId: args.actorUserId,
    commissionable: true as const,
    amountMinor,
    currency,
    programId: args.programId,
    programName: program.name,
    paymentType: args.paymentType,
    referenceCode: args.referenceCode?.trim() || undefined,
    proofFileId: args.proofFileId ?? undefined,
    status: "recorded" as const,
    statusChangedAt: now,
    recordedAt: now,
    contextType: "opportunity" as const,
    origin,
    customerId: undefined,
  };
  assertPaymentRow(row);
  const paymentId = await ctx.db.insert("paymentRecords", row);
  await insertPaymentAggregate(ctx, paymentId);

  await emitDomainEvent(ctx, {
    tenantId: args.tenantId,
    entityType: "payment",
    entityId: paymentId,
    eventType: "payment.recorded",
    source: "admin",
    actorUserId: args.actorUserId,
    toStatus: "recorded",
    occurredAt: now,
    metadata: {
      opportunityId: args.opportunityId,
      meetingId: args.meetingId,
      amountMinor,
      currency,
      attributedCloserId,
      recordedByUserId: args.actorUserId,
      commissionable: true,
      programId: args.programId,
      programName: program.name,
      paymentType: args.paymentType,
      origin,
    },
  });

  await applyPaymentStatsDelta(ctx, args.tenantId, {
    commissionable: true,
    paymentType: args.paymentType,
    amountMinorDelta: amountMinor,
    wonDealDelta: 1,
    // Review resolution typically happens after the opportunity is already
    // in `meeting_overran` or similar → caller's responsibility. We pass 0
    // by default and let downstream pass an override if needed.
  });

  // Conversion (same shape as logPayment — resolves program from this payment).
  const customerId = await executeConversion(ctx, {
    tenantId: args.tenantId,
    leadId: opportunity.leadId,
    convertedByUserId: args.actorUserId,
    winningOpportunityId: args.opportunityId,
    winningMeetingId: args.meetingId,
  });
  if (customerId) {
    await ctx.db.patch(paymentId, { customerId });
    await syncCustomerPaymentSummary(ctx, customerId);
  } else {
    const existing = await ctx.db
      .query("customers")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", args.tenantId).eq("leadId", opportunity.leadId),
      )
      .first();
    if (existing) {
      await ctx.db.patch(paymentId, { customerId: existing._id });
      await syncCustomerPaymentSummary(ctx, existing._id);
    }
  }
  return paymentId;
}
```

**Step 3: Update `resolveReview`'s `log_payment` action branch**

Find the `log_payment` branch in `convex/reviews/mutations.ts` (around lines 524–537 in the current file). The branch currently calls `createPaymentRecord` with the old arg shape. Update it to forward the new `programId` + `paymentType` from the review form submission:

**Before:**

```typescript
// Path: convex/reviews/mutations.ts (BEFORE — log_payment action)
case "log_payment": {
  // ... existing validations ...
  const paymentId = await createPaymentRecord(ctx, {
    tenantId,
    opportunityId: review.opportunityId,
    meetingId: review.meetingId,
    actorUserId: userId,
    amount: args.amount!,
    currency: args.currency!,
    provider: args.provider!, // OLD
    referenceCode: args.referenceCode,
    proofFileId: args.proofFileId,
  });
  // ... downstream review resolution patch ...
}
```

**After:**

```typescript
// Path: convex/reviews/mutations.ts (AFTER)
case "log_payment": {
  // ... existing validations ...
  if (!args.programId) {
    throw new Error("programId is required to log a review-resolved payment");
  }
  if (!args.paymentType) {
    throw new Error("paymentType is required to log a review-resolved payment");
  }
  const paymentId = await createPaymentRecord(ctx, {
    tenantId,
    opportunityId: review.opportunityId,
    meetingId: review.meetingId,
    actorUserId: userId,
    amount: args.amount!,
    currency: args.currency!,
    programId: args.programId,
    paymentType: args.paymentType,
    referenceCode: args.referenceCode,
    proofFileId: args.proofFileId,
  });
  // ... downstream review resolution patch unchanged ...
}
```

Extend the `resolveReview` args validator to accept `programId` and `paymentType` as optional (they're required only for `log_payment` action — the runtime check above enforces):

```typescript
// Path: convex/reviews/mutations.ts (MODIFY args validator)
args: {
  reviewId: v.id("reviews"),
  action: v.union(
    v.literal("log_payment"),
    v.literal("mark_lost"),
    v.literal("reschedule"),
    v.literal("dispute"),
  ),
  // ... existing optional fields (amount, currency, reason, ...) ...
  // NEW — only consumed by the log_payment branch.
  programId: v.optional(v.id("tenantPrograms")),
  paymentType: v.optional(
    v.union(
      v.literal("monthly"),
      v.literal("split"),
      v.literal("pif"),
      v.literal("deposit"),
    ),
  ),
  // DROPPED: provider (was also only relevant for log_payment).
},
```

**Step 4: Update `resolveReview`'s `dispute` action branch**

Find the dispute branch (around lines 265–376). The current code patches the payment row's `status: "disputed"` and calls `updateTenantStats` with `totalRevenueMinor: -disputedPayment.amountMinor, wonDeals: -1, activeOpportunities: +1`. Replace that call with `applyPaymentStatsDelta`:

**Before:**

```typescript
// Path: convex/reviews/mutations.ts (BEFORE — dispute branch stats update)
await updateTenantStats(ctx, tenantId, {
  totalPaymentRecords: -1,
  totalRevenueMinor: -disputedPayment.amountMinor,
  wonDeals: -1,
  activeOpportunities: 1,
});
```

**After:**

```typescript
// Path: convex/reviews/mutations.ts (AFTER)
// Route the reversal to the correct (commissionable × paymentType) counter.
// Non-commissionable disputes (hypothetical — customer_direct rows can be
// disputed too) reverse the non-commissionable counter and do NOT touch
// wonDeals / activeOpportunities (they never incremented those on insert).
await applyPaymentStatsDelta(ctx, tenantId, {
  commissionable: disputedPayment.commissionable,
  paymentType: disputedPayment.paymentType,
  amountMinorDelta: -disputedPayment.amountMinor, // negative reverses
  wonDealDelta: disputedPayment.commissionable ? -1 : 0,
  activeOpportunityDelta: disputedPayment.commissionable ? 1 : 0,
});
```

**Step 5: Verify `replacePaymentAggregate` is still called**

The dispute branch also calls `replacePaymentAggregate(ctx, previousPayment, disputedPayment._id)` after patching the status to `"disputed"`. This call is unchanged in its args; Phase 2D updated the function body to handle the 4-state transition matrix. Confirm the call is still present and passes the pre-patch row as `previousPayment`:

```typescript
// Path: convex/reviews/mutations.ts (CONFIRMATION — no args change)
// Capture the payment row BEFORE patching the status (for aggregate replace).
const previousPayment = { ...disputedPayment };
await ctx.db.patch(disputedPayment._id, {
  status: "disputed",
  statusChangedAt: now,
});
const updatedPayment = await ctx.db.get(disputedPayment._id);
if (updatedPayment) {
  await replacePaymentAggregate(ctx, previousPayment, updatedPayment._id);
}
```

**Key implementation notes:**
- **The `log_payment` review action now has four required inputs**: `amount`, `currency`, `programId`, `paymentType`. Mark both of the new ones as optional in the Convex args validator but enforce runtime presence in the branch. This keeps the args schema permissive for the other three branches (`mark_lost`, `reschedule`, `dispute`) that don't need them.
- **`disputedPayment.commissionable` is always defined** post-Phase 2 (the field is required on the schema). The `? -1 : 0` ternary ensures correctness even for the theoretical non-commissionable dispute path.
- **Why `activeOpportunityDelta: disputedPayment.commissionable ? 1 : 0`**: disputing a commissionable payment re-opens the opportunity (it goes back from `payment_received` → `meeting_overran` or similar, which is active). Non-commissionable disputes don't touch the opportunity state machine (the opportunity was already terminal when the customer_direct payment landed).
- **Don't try to resolve the "revived to which exact status" question** in Phase 4. The current dispute branch has its own status-revival logic (if the opportunity had other context, it transitions to `meeting_overran`; otherwise to `scheduled`). Phase 4 doesn't change that — it only corrects the stats routing.
- **Deposit disputes ARE handled.** When a commissionable deposit is disputed, the reversal decrements `totalCommissionableDepositRevenueMinor` — correctly, since the original insert incremented exactly that counter. The routing logic in `applyPaymentStatsDelta` is symmetric.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/outcomeHelpers.ts` | Modify | `createPaymentRecord`: add programId/paymentType args; rewrite handler. |
| `convex/reviews/mutations.ts` | Modify | `log_payment` action: forward new args; `dispute` action: applyPaymentStatsDelta replaces updateTenantStats; args validator widens. |

---

### 4E — `getAdminReminderDetail` Query

**Type:** Backend
**Parallelizable:** Yes — brand new file; independent of 4A/4B/4C/4D.

**What:** Create `convex/pipeline/reminderDetail.ts` exporting a `getAdminReminderDetail` query that mirrors the closer version (`convex/closer/reminderDetail.ts`) but authorizes `tenant_master` / `tenant_admin` and skips the closer-ownership check (admins can view any reminder in their tenant).

**Why:** Design §7.3 pairs the `logReminderPayment` admin extension with an admin-visible reminder detail page. Without this query, the new route `app/workspace/pipeline/reminders/[followUpId]/page.tsx` (Phase 7) has no data source. The admin version must return the SAME shape the closer version returns so the page client component can be reused or trivially extended.

**Where:**
- `convex/pipeline/reminderDetail.ts` (new — create the file; the `convex/pipeline/` directory may already exist, and if not, this creates it)

**How:**

**Step 1: Verify the closer version's shape**

Read `convex/closer/reminderDetail.ts` to confirm the return shape. Expected (from the closer query's handler):

```typescript
// Path: convex/closer/reminderDetail.ts (EXISTING — reference shape only)
return {
  followUp,
  opportunity,
  lead,
  latestMeeting, // Doc<"meetings"> | null
  payments,      // Doc<"paymentRecords">[]
  paymentLinks,  // { id, url }[] (storage URLs)
};
```

Phase 4E replicates this shape exactly.

**Step 2: Create the new file**

```typescript
// Path: convex/pipeline/reminderDetail.ts (NEW)
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

/**
 * Admin-side reminder detail query. Mirrors convex/closer/reminderDetail.ts
 * but authorizes tenant admins (not closer ownership). Returns the same
 * shape so the admin page client can reuse the closer page's composition
 * without branching.
 *
 * Used by app/workspace/pipeline/reminders/[followUpId]/page.tsx
 * (shipped in Phase 7).
 */
export const getAdminReminderDetail = query({
  args: { followUpId: v.id("followUps") },
  handler: async (ctx, { followUpId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const followUp = await ctx.db.get(followUpId);
    if (!followUp || followUp.tenantId !== tenantId) {
      // Admins can see any reminder in their tenant, but cross-tenant reads
      // are rejected with the same generic error as closer version.
      throw new Error("Reminder not found");
    }

    const opportunity = await ctx.db.get(followUp.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    const lead = await ctx.db.get(opportunity.leadId);
    // lead is allowed to be null only if a race deleted it — defensive read.

    const latestMeeting = opportunity.latestMeetingId
      ? await ctx.db.get(opportunity.latestMeetingId)
      : null;

    // Read opportunity payments (bounded — typical opp has < 10).
    const payments = await ctx.db
      .query("paymentRecords")
      .withIndex("by_opportunityId", (q) =>
        q.eq("opportunityId", followUp.opportunityId),
      )
      .take(50);

    // Generate short-lived storage URLs for any payment proofs.
    const paymentLinks = await Promise.all(
      payments
        .filter((payment) => payment.proofFileId)
        .map(async (payment) => ({
          id: payment._id,
          url: await ctx.storage.getUrl(payment.proofFileId!),
        })),
    );

    return {
      followUp,
      opportunity,
      lead,
      latestMeeting,
      payments,
      paymentLinks,
    };
  },
});
```

**Step 3: Verify the `api` handle**

After `npx convex dev` regenerates the API file:

```bash
pnpm tsc --noEmit
# Confirm the import `api.pipeline.reminderDetail.getAdminReminderDetail`
# is available (Phase 7's page will consume it).
```

**Step 4: Smoke test**

```bash
# As an admin identity (via Convex dashboard sign-in):
npx convex run pipeline:reminderDetail:getAdminReminderDetail \
  '{ "followUpId": "<id>" }'
```

Expected: same output shape as the closer version, no authorization error.

**Key implementation notes:**
- **Don't add a `source` discriminator to the return shape.** The admin and closer queries return structurally identical objects. Phase 7's admin client can reuse the closer page's composition primitives or define its own; either approach is unblocked by matching shapes.
- **`convex/pipeline/` directory** may be new. The existing `convex/pipeline/processor.ts` (v0.5 webhook processor) lives in a different logical subtree — create the directory alongside it. No other file in `convex/pipeline/` is touched by this phase.
- **Don't reuse the closer query.** The closer version's body enforces `followUp.closerId === userId` via `requireTenantUser` with `["closer"]` and an explicit check. Calling it from an admin context would either widen the auth roles on the closer query (wrong — closer query is a closer surface) or duplicate its body with a role override. A separate admin query is the cleanest cut.
- **`paymentLinks` generation** uses `ctx.storage.getUrl(...)` which is cheap (no pre-signed URL cost like S3; Convex file storage has no per-URL cost). Safe to generate on every query invocation.
- **`take(50)` bound on payments** matches the closer version. An opportunity with > 50 payments is vanishingly rare (the highest tenant has single-digit payments per opportunity). If we hit the bound, downstream display truncates — acceptable for v0.5.1.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/reminderDetail.ts` | Create | New query `getAdminReminderDetail`; admin-only; mirrors closer shape. |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/closer/payments.ts` | Modify | 4A |
| `convex/closer/reminderOutcomes.ts` | Modify | 4B |
| `convex/customers/mutations.ts` | Modify | 4C |
| `convex/lib/outcomeHelpers.ts` | Modify | 4D |
| `convex/reviews/mutations.ts` | Modify | 4D |
| `convex/pipeline/reminderDetail.ts` | Create | 4E |
