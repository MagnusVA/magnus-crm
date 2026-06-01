# Phase 3 — Outcome Mutations

**Goal:** Ship three new Convex mutations in a single file (`convex/closer/reminderOutcomes.ts`) that move a `manual_reminder` follow-up from `pending → completed` while correctly transitioning the parent opportunity and updating reporting aggregates: `logReminderPayment` (→ `payment_received`), `markReminderLost` (→ `lost`), `markReminderNoResponse` (completes the reminder and optionally → `lost` or schedules a new reminder). After this phase, the backend surface is complete: the UI in Phases 4–5 can wire buttons to these mutations directly.

**Prerequisite:** Phase 1 deployed. `validateTransition("follow_up_scheduled", "payment_received"|"lost")` must already return `true`; `followUps.completionOutcome` must already accept the five new literals.

**Runs in PARALLEL with:** Phase 2 (reminder detail query). Different files, no shared imports beyond `requireTenantUser.ts` and `statusTransitions.ts` (which both sides only read).

> **Critical path:** This phase is on the critical path (Phase 1 → **Phase 3** → Phase 5 → Phase 6). Phase 5's dialogs cannot exist as real UI until these mutations are callable; start 3A as soon as Phase 1's `convex dev` is green.

**Skills to invoke:**
- `convex-performance-audit` — Each mutation performs multiple `ctx.db.get` + `ctx.db.patch` + aggregate + domain-event writes. Audit that no `.collect()` creeps in, all reads are bounded, and the order of operations does not re-read the same doc twice.
- `convex-create-component` — Not to create a separate component, but to apply the same "clear boundaries, explicit contract" discipline to the shared helper extraction step (3A) so each mutation body stays skinny and readable.

**Acceptance Criteria:**
1. `api.closer.reminderOutcomes.logReminderPayment` exists and accepts `{ followUpId, amount, currency, provider, referenceCode?, proofFileId? }`.
2. Calling `logReminderPayment` on a pending manual reminder owned by the caller: inserts a `paymentRecords` row, patches the opportunity to `payment_received`, patches the follow-up to `completed` with `completionOutcome: "payment_received"`, runs `executeConversion`, emits three domain events (`payment.recorded`, `opportunity.status_changed`, `followUp.completed`), and returns the new `paymentId`.
3. `api.closer.reminderOutcomes.markReminderLost` exists and accepts `{ followUpId, reason? }`. On success: patches opportunity to `lost`, patches follow-up to `completed` with `completionOutcome: "lost"`, updates tenant stats, emits two domain events.
4. `api.closer.reminderOutcomes.markReminderNoResponse` exists and accepts `{ followUpId, nextStep, note?, newReminder? }` where `nextStep` is one of `"schedule_new" | "give_up" | "close_only"`. On success: always completes the current follow-up with the matching `no_response_*` outcome; conditionally transitions opportunity (`give_up`) or inserts a new `manual_reminder` follow-up (`schedule_new`).
5. All three mutations throw a descriptive `Error` when: (a) follow-up not found, (b) follow-up belongs to a different tenant, (c) follow-up owned by a different closer, (d) follow-up `type !== "manual_reminder"`, (e) follow-up `status !== "pending"`, (f) the status transition is invalid per `validateTransition`.
6. `logReminderPayment` resolves `meetingId` from `opportunity.latestMeetingId` server-side (caller never passes `meetingId`). When `latestMeetingId` is absent, the payment is still inserted with `meetingId: undefined` (schema permits).
7. `markReminderNoResponse` with `nextStep: "schedule_new"` requires a `newReminder` object; missing `newReminder` throws. A `newReminder.reminderScheduledAt <= now` also throws.
8. `markReminderNoResponse` with `nextStep: "give_up"` validates `follow_up_scheduled → lost` and patches tenant stats (`activeOpportunities -1`, `lostDeals +1`).
9. `markReminderNoResponse` with `nextStep: "close_only"` does NOT transition the opportunity — it remains in `follow_up_scheduled`.
10. A double-submit (second call to the same mutation on the same `followUpId`) fails with `"Reminder is not pending"` — the first call wins.
11. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (file shell + shared helper) ────┐
                                    ├── 3B (logReminderPayment)   ─┐
                                    ├── 3C (markReminderLost)     ─┤── (co-located in one file; see note)
                                    └── 3D (markReminderNoResponse) ┘
```

**Optimal execution:**
1. **3A** first — it is small (≈60 lines) and establishes the shared guard helper `assertOwnedPendingReminder(...)` that 3B/3C/3D all call. Without it, each mutation duplicates 20 lines of guard code.
2. Once 3A compiles, **3B**, **3C**, and **3D** are logically independent mutation bodies. They are co-located in one file, so true file-level parallelism requires splitting into feature branches (one per mutation) and re-merging — worth doing only on a multi-developer team. On a single developer, write them sequentially in that order (easiest → hardest) so momentum builds: 3B reuses the most existing code (`logPayment` is the template), 3C is a 40-line clone of `markAsLost`, 3D is the new branching logic.
3. After all three exist, spot-check via the Convex dashboard function runner with a real follow-up id before closing the phase.

**Estimated time:** 1–1.5 days. 3A is ~1 hour. 3B is ~4 hours (includes reviewing `logPayment` + `executeConversion`). 3C is ~1 hour. 3D is ~3 hours (the branching + new-follow-up insert). Add ~1 hour for dashboard verification.

---

## Subphases

### 3A — File shell, shared helper, and imports

**Type:** Backend
**Parallelizable:** No — blocks 3B/3C/3D (they import the shared helper).

**What:** Create `convex/closer/reminderOutcomes.ts` with all shared imports and a single exported-for-internal-use helper `assertOwnedPendingReminder(ctx, followUpId)` that does the five-step guard chain (load, tenant, ownership, type, pending status) and returns `{ followUp, opportunity, tenantId, userId }`. No public mutation yet — this subphase is scaffolding.

**Why:** The three outcome mutations share 80% of their preamble. Extracting it forces consistency (a guard tweak in the future touches one helper, not three call sites) and keeps each mutation body under 100 lines so code review is tractable.

**Where:**
- `convex/closer/reminderOutcomes.ts` (new)

**How:**

**Step 1: Create the file and the full import list. Every mutation needs these, so paying the import cost once keeps 3B/3C/3D skinny.**

```typescript
// Path: convex/closer/reminderOutcomes.ts

import { v } from "convex/values";
import { mutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireTenantUser } from "../requireTenantUser";
import { validateTransition } from "../lib/statusTransitions";
import { executeConversion } from "../customers/conversion";
import { emitDomainEvent } from "../lib/domainEvents";
import { toAmountMinor, validateCurrency } from "../lib/formatMoney";
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

> **Import-set rationale:** These are the exact same modules `convex/closer/payments.ts` and `convex/closer/meetingActions.ts` use. We are doing the same work on the same tables; reusing the helpers keeps reporting accurate.

**Step 2: Write the shared guard helper. It performs every check each mutation needs in the same order, returns the loaded docs, and throws with consistent messages.**

```typescript
// Path: convex/closer/reminderOutcomes.ts

/**
 * Loads and validates a pending manual reminder owned by the calling
 * closer. Throws with a descriptive message on any failure. Returns
 * `{ followUp, opportunity, tenantId, userId }` which the caller
 * mutation uses for its own business logic.
 *
 * This helper is intentionally NOT exported from the module — keeping
 * it file-scoped keeps the public Convex API surface small (only the
 * three mutations). Future reminder mutations added to this file reuse
 * it directly.
 */
async function assertOwnedPendingReminder(
  ctx: MutationCtx,
  followUpId: Id<"followUps">,
): Promise<{
  followUp: Doc<"followUps">;
  opportunity: Doc<"opportunities">;
  tenantId: Id<"tenants">;
  userId: Id<"users">;
}> {
  const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

  const followUp = await ctx.db.get(followUpId);
  if (!followUp) throw new Error("Reminder not found");
  if (followUp.tenantId !== tenantId) throw new Error("Access denied");
  if (followUp.closerId !== userId) throw new Error("Not your reminder");
  if (followUp.type !== "manual_reminder") {
    throw new Error(
      "Only manual reminders can be resolved on this page",
    );
  }
  if (followUp.status !== "pending") {
    throw new Error("Reminder is not pending");
  }

  const opportunity = await ctx.db.get(followUp.opportunityId);
  if (!opportunity || opportunity.tenantId !== tenantId) {
    throw new Error("Opportunity not found");
  }

  return { followUp, opportunity, tenantId, userId };
}
```

**Step 3: Typecheck.** Because this file exports nothing yet, TypeScript only verifies the imports resolve. That still catches typos in paths.

```bash
pnpm tsc --noEmit
```

**Key implementation notes:**
- **Do not export the helper.** Keeping it file-private matches the pattern in `meetingActions.ts` and `noShowActions.ts`. If a fourth mutation in a different file ever needs it, we refactor then — not now.
- **Throw with consistent messages.** Phase 5 dialogs surface these via `toast.error(err.message)`. Consistent phrasing keeps the UX calm.
- **Tenant check is redundant with `requireTenantUser`'s own scoping but cheap.** If any future refactor weakens `requireTenantUser`, this check saves us from a cross-tenant leak. Defence in depth costs ~2 lines.
- **`MutationCtx` type import.** The helper signature needs it to compile. Alternatively we could `import type { MutationCtx }` inline — the separate line reads cleaner.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/reminderOutcomes.ts` | Create | Imports + private `assertOwnedPendingReminder` helper. No public exports yet. |

---

### 3B — `logReminderPayment` mutation

**Type:** Backend
**Parallelizable:** Co-located with 3C/3D in the same file. On a multi-dev team, split into a feature branch per mutation; on a solo dev, write sequentially.

**What:** The mutation that records a sale from a reminder-driven call. Inserts a `paymentRecords` row, patches the opportunity to `payment_received`, completes the follow-up, runs `executeConversion` (lead → customer), syncs customer payment summary, updates tenant stats, and emits three domain events.

**Why:** This is the happy path the closer is dreaming of — they called, the lead paid, and the opportunity is done. Every other outcome is a derivation or consolation. Encoding it as a first-class mutation (not a thin wrapper around `logPayment`) keeps the caller API clean: the dialog passes only `{ followUpId, amount, currency, provider, ... }`; the mutation figures out the meeting and opportunity from the follow-up server-side.

**Where:**
- `convex/closer/reminderOutcomes.ts` (modify — append after 3A's helper)

**How:**

**Step 1: Add the export. Keep the guard helper's return destructured at the top and ride it through the rest of the body.**

```typescript
// Path: convex/closer/reminderOutcomes.ts

export const logReminderPayment = mutation({
  args: {
    followUpId: v.id("followUps"),
    amount: v.number(),
    currency: v.string(),
    provider: v.string(),
    referenceCode: v.optional(v.string()),
    proofFileId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    // --- Guard chain (shared) ---
    const { followUp, opportunity, tenantId, userId } =
      await assertOwnedPendingReminder(ctx, args.followUpId);

    // --- Transition validation ---
    if (!validateTransition(opportunity.status, "payment_received")) {
      throw new Error(
        `Cannot log payment from status "${opportunity.status}"`,
      );
    }

    // --- Input validation ---
    if (args.amount <= 0) throw new Error("Payment amount must be positive");
    const currency = validateCurrency(args.currency);
    const provider = args.provider.trim();
    if (!provider) throw new Error("Provider is required");

    const now = Date.now();
    const amountMinor = toAmountMinor(args.amount);

    // Resolve meeting anchor from the denormalized opportunity ref.
    // paymentRecords.meetingId is v.optional(...) so undefined is legal
    // (e.g., opportunities created via backfill with no meeting).
    const meetingId = opportunity.latestMeetingId ?? undefined;

    // --- Inserts & patches (order matters for reporting) ---
    // 1. Insert payment first — aggregate hook reads amountMinor/currency.
    const paymentId = await ctx.db.insert("paymentRecords", {
      tenantId,
      opportunityId: opportunity._id,
      meetingId,
      closerId: userId,
      amountMinor,
      currency,
      provider,
      referenceCode: args.referenceCode?.trim() || undefined,
      proofFileId: args.proofFileId,
      status: "recorded",
      statusChangedAt: now,
      recordedAt: now,
      contextType: "opportunity",
    });
    await insertPaymentAggregate(ctx, paymentId);

    // 2. Patch opportunity — aggregate + tenant stats read from
    //    previous status, so update them BEFORE patching to new status.
    const previousOpportunityStatus = opportunity.status;
    await ctx.db.patch(opportunity._id, {
      status: "payment_received",
      paymentReceivedAt: now,
      updatedAt: now,
    });
    await replaceOpportunityAggregate(ctx, opportunity, opportunity._id);
    await updateTenantStats(ctx, tenantId, {
      activeOpportunities: isActiveOpportunityStatus(previousOpportunityStatus)
        ? -1
        : 0,
      wonDeals: 1,
      totalPaymentRecords: 1,
      totalRevenueMinor: amountMinor,
    });

    // 3. Complete the follow-up with the structured outcome tag.
    await ctx.db.patch(args.followUpId, {
      status: "completed",
      completedAt: now,
      completionOutcome: "payment_received",
    });

    // --- Domain events (fire-and-forget, order loosely documents intent) ---
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "payment",
      entityId: paymentId,
      eventType: "payment.recorded",
      source: "closer",
      actorUserId: userId,
      toStatus: "recorded",
      metadata: {
        opportunityId: opportunity._id,
        meetingId,
        followUpId: args.followUpId,
        amountMinor,
        currency,
        origin: "reminder",
      },
      occurredAt: now,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: opportunity._id,
      eventType: "opportunity.status_changed",
      source: "closer",
      actorUserId: userId,
      fromStatus: previousOpportunityStatus,
      toStatus: "payment_received",
      occurredAt: now,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "followUp",
      entityId: args.followUpId,
      eventType: "followUp.completed",
      source: "closer",
      actorUserId: userId,
      fromStatus: "pending",
      toStatus: "completed",
      metadata: { outcome: "payment_received" },
      occurredAt: now,
    });

    // --- Customer auto-conversion (Feature D — mirror `logPayment`) ---
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
    }

    console.log("[Closer:Reminder] logReminderPayment done", {
      followUpId: args.followUpId,
      paymentId,
      opportunityId: opportunity._id,
      customerId,
    });

    return paymentId;
  },
});
```

**Step 2: Smoke-test via the Convex dashboard. Pick a pending `manual_reminder` follow-up whose parent opportunity is in `follow_up_scheduled`. Call the mutation with a small amount.** Expect:

- `paymentRecords` row inserted with `status: "recorded"`.
- `opportunities.<id>.status` patched to `"payment_received"`.
- `followUps.<id>.status` = `"completed"`, `.completionOutcome` = `"payment_received"`.
- `customers` row appears (or is updated).

**Step 3: Negative test.** Call the mutation with the same `followUpId` again — should throw `"Reminder is not pending"`.

**Key implementation notes:**
- **`previousOpportunityStatus` snapshot.** We pass the *original* status to `emitDomainEvent`'s `fromStatus` and to `isActiveOpportunityStatus(...)`. If the domain event fired after the patch, the "from" reading would be wrong. Minor bug, easy to miss.
- **Why not call `logPayment` internally?** `logPayment` insists on a `meetingId` arg and does not touch the follow-up. Wrapping it would require a pre-call patch (to clear the meeting requirement) and a post-call patch (to close the follow-up), plus a separate transaction boundary. Inline is safer and clearer.
- **Customer conversion is NOT optional.** The `executeConversion` call is identical to `logPayment`'s — we want the same lead→customer flow regardless of whether the payment came from a meeting or a reminder.
- **`proofFileId` is passed through but not validated.** The client generated the storage URL via `api.closer.payments.generateUploadUrl` (reused); by the time the id reaches us it is a valid `_storage` reference or `undefined`.
- **Order of aggregate calls is load-bearing.** Insert payment → `insertPaymentAggregate` → patch opportunity → `replaceOpportunityAggregate` → `updateTenantStats`. This matches `logPayment` exactly; changing the order risks double-counting revenue.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/reminderOutcomes.ts` | Modify | Append `logReminderPayment` public mutation. |

---

### 3C — `markReminderLost` mutation

**Type:** Backend
**Parallelizable:** Co-located with 3B/3D.

**What:** Transitions the opportunity to `lost` and completes the follow-up with `completionOutcome: "lost"`. Also writes the optional reason to both `opportunity.lostReason` and `followUp.completionNote` so either surface can display it.

**Why:** Lost-from-reminder is the most common negative outcome. The closer called, the lead is not buying. Keeping the reason free-text on both records avoids making Phase 4's history panel choose a single source of truth.

**Where:**
- `convex/closer/reminderOutcomes.ts` (modify — append after 3B)

**How:**

**Step 1: Add the export. Structurally mirror `convex/closer/meetingActions.ts → markAsLost`, but also complete the follow-up.**

```typescript
// Path: convex/closer/reminderOutcomes.ts

export const markReminderLost = mutation({
  args: {
    followUpId: v.id("followUps"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { followUpId, reason }) => {
    const { followUp, opportunity, tenantId, userId } =
      await assertOwnedPendingReminder(ctx, followUpId);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    void followUp; // kept for future telemetry; silence unused warning

    if (!validateTransition(opportunity.status, "lost")) {
      throw new Error(`Cannot mark lost from "${opportunity.status}"`);
    }

    const now = Date.now();
    const trimmedReason = reason?.trim();
    const previousOpportunityStatus = opportunity.status;

    // 1. Patch opportunity — mirror meetingActions.markAsLost.
    await ctx.db.patch(opportunity._id, {
      status: "lost",
      lostAt: now,
      lostByUserId: userId,
      ...(trimmedReason ? { lostReason: trimmedReason } : {}),
      updatedAt: now,
    });
    await replaceOpportunityAggregate(ctx, opportunity, opportunity._id);
    await updateTenantStats(ctx, tenantId, {
      activeOpportunities: isActiveOpportunityStatus(previousOpportunityStatus)
        ? -1
        : 0,
      lostDeals: 1,
    });

    // 2. Complete the follow-up with the structured outcome.
    //    Write `completionNote` from the same reason so the history
    //    panel can show it without a secondary lookup.
    await ctx.db.patch(followUpId, {
      status: "completed",
      completedAt: now,
      completionOutcome: "lost",
      ...(trimmedReason ? { completionNote: trimmedReason } : {}),
    });

    // 3. Domain events.
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: opportunity._id,
      eventType: "opportunity.marked_lost",
      source: "closer",
      actorUserId: userId,
      fromStatus: previousOpportunityStatus,
      toStatus: "lost",
      reason: trimmedReason,
      metadata: { origin: "reminder", followUpId },
      occurredAt: now,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "followUp",
      entityId: followUpId,
      eventType: "followUp.completed",
      source: "closer",
      actorUserId: userId,
      fromStatus: "pending",
      toStatus: "completed",
      metadata: { outcome: "lost" },
      occurredAt: now,
    });

    console.log("[Closer:Reminder] markReminderLost done", {
      followUpId,
      opportunityId: opportunity._id,
      hasReason: Boolean(trimmedReason),
    });
  },
});
```

**Step 2: Smoke-test.** Pick another pending reminder. Call `markReminderLost` with `reason: "Went with a competitor"`. Confirm:
- `opportunities.<id>.status = "lost"`, `.lostReason = "Went with a competitor"`.
- `followUps.<id>.status = "completed"`, `.completionOutcome = "lost"`, `.completionNote = "Went with a competitor"`.
- `domainEvents` has two new rows tagged `origin: "reminder"`.

**Key implementation notes:**
- **No return value.** The caller does not need an id — the mutation's success is signal enough. Matches `markAsLost`.
- **`metadata.origin: "reminder"` is how reporting distinguishes reminder-driven losses from meeting-driven ones.** Phase 5 PostHog events also key off the same word.
- **Do not call `executeConversion`.** `lost` terminates the deal. No customer.
- **`void followUp` is a small ergonomic hack.** The helper returns it because Phase 3D uses it; here we tolerate the unused variable for signature symmetry. Remove the `void` if your lint config does not complain.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/reminderOutcomes.ts` | Modify | Append `markReminderLost` public mutation. |

---

### 3D — `markReminderNoResponse` mutation

**Type:** Backend
**Parallelizable:** Co-located with 3B/3C.

**What:** The branching mutation. Always completes the current reminder with a `no_response_*` tag and a free-text note. Branches on `nextStep`:
- `"schedule_new"` — opportunity stays `follow_up_scheduled`; a brand-new `manual_reminder` follow-up is inserted with the `newReminder` payload.
- `"give_up"` — validates and executes the `follow_up_scheduled → lost` transition. No new follow-up.
- `"close_only"` — no opportunity transition, no new follow-up. Just completes the current reminder.

**Why:** "No response" is the closer's reality check — dialled, didn't pick up, now they have to decide what's next. Forcing a commit (must pick lost or must pick new reminder) would lie about the state of the world; deferring (`close_only`) is a legitimate third option when the closer wants to think. Encoding all three branches in one mutation avoids splitting the decision across three dialogs.

**Where:**
- `convex/closer/reminderOutcomes.ts` (modify — append after 3C)

**How:**

**Step 1: Add the export. Handle the three branches in order: `give_up` (opportunity transition) first, then follow-up completion (always), then `schedule_new` (new follow-up insert).**

```typescript
// Path: convex/closer/reminderOutcomes.ts

export const markReminderNoResponse = mutation({
  args: {
    followUpId: v.id("followUps"),
    nextStep: v.union(
      v.literal("schedule_new"), // Close this, start a new one
      v.literal("give_up"), // Close this + mark opp lost
      v.literal("close_only"), // Close this only, leave opp as-is
    ),
    note: v.optional(v.string()),

    // Only used when nextStep === "schedule_new"
    newReminder: v.optional(
      v.object({
        contactMethod: v.union(v.literal("call"), v.literal("text")),
        reminderScheduledAt: v.number(),
        reminderNote: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { followUpId, nextStep, note, newReminder }) => {
    const { followUp, opportunity, tenantId, userId } =
      await assertOwnedPendingReminder(ctx, followUpId);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    void followUp;

    const now = Date.now();
    const trimmedNote = note?.trim();

    // --- Branch A: give_up — transition opportunity to lost. ---
    // Run BEFORE completing the follow-up so the tenant stats
    // update works off the correct prior status.
    if (nextStep === "give_up") {
      if (!validateTransition(opportunity.status, "lost")) {
        throw new Error(`Cannot mark lost from "${opportunity.status}"`);
      }
      const previousOpportunityStatus = opportunity.status;
      await ctx.db.patch(opportunity._id, {
        status: "lost",
        lostAt: now,
        lostByUserId: userId,
        lostReason: trimmedNote ?? "No response to outreach",
        updatedAt: now,
      });
      await replaceOpportunityAggregate(ctx, opportunity, opportunity._id);
      await updateTenantStats(ctx, tenantId, {
        activeOpportunities: isActiveOpportunityStatus(previousOpportunityStatus)
          ? -1
          : 0,
        lostDeals: 1,
      });
      await emitDomainEvent(ctx, {
        tenantId,
        entityType: "opportunity",
        entityId: opportunity._id,
        eventType: "opportunity.marked_lost",
        source: "closer",
        actorUserId: userId,
        fromStatus: previousOpportunityStatus,
        toStatus: "lost",
        reason: trimmedNote ?? "No response to outreach",
        metadata: {
          origin: "reminder",
          followUpId,
          trigger: "no_response_given_up",
        },
        occurredAt: now,
      });
    }

    // --- Always: complete the current follow-up with outcome tag. ---
    const outcomeTag =
      nextStep === "schedule_new"
        ? ("no_response_rescheduled" as const)
        : nextStep === "give_up"
          ? ("no_response_given_up" as const)
          : ("no_response_close_only" as const);

    await ctx.db.patch(followUpId, {
      status: "completed",
      completedAt: now,
      completionOutcome: outcomeTag,
      ...(trimmedNote ? { completionNote: trimmedNote } : {}),
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "followUp",
      entityId: followUpId,
      eventType: "followUp.completed",
      source: "closer",
      actorUserId: userId,
      fromStatus: "pending",
      toStatus: "completed",
      metadata: { outcome: outcomeTag },
      occurredAt: now,
    });

    // --- Branch B: schedule_new — insert the replacement reminder. ---
    // Opportunity stays in follow_up_scheduled. No transition call.
    let newFollowUpId: Id<"followUps"> | null = null;
    if (nextStep === "schedule_new") {
      if (!newReminder) {
        throw new Error(
          "newReminder required when nextStep = schedule_new",
        );
      }
      if (newReminder.reminderScheduledAt <= now) {
        throw new Error("Reminder time must be in the future");
      }
      newFollowUpId = await ctx.db.insert("followUps", {
        tenantId,
        opportunityId: opportunity._id,
        leadId: opportunity.leadId,
        closerId: userId,
        type: "manual_reminder",
        contactMethod: newReminder.contactMethod,
        reminderScheduledAt: newReminder.reminderScheduledAt,
        reminderNote: newReminder.reminderNote?.trim() || undefined,
        reason: "closer_initiated",
        status: "pending",
        createdAt: now,
      });
      await emitDomainEvent(ctx, {
        tenantId,
        entityType: "followUp",
        entityId: newFollowUpId,
        eventType: "followUp.created",
        source: "closer",
        actorUserId: userId,
        toStatus: "pending",
        metadata: {
          type: "manual_reminder",
          opportunityId: opportunity._id,
          origin: "reminder_chain",
          previousFollowUpId: followUpId,
        },
        occurredAt: now,
      });
    }

    console.log("[Closer:Reminder] markReminderNoResponse done", {
      followUpId,
      nextStep,
      newFollowUpId,
      opportunityId: opportunity._id,
    });

    return { newFollowUpId };
  },
});
```

**Step 2: Smoke-test all three branches.**

```
# Branch A — give_up
{
  followUpId: "<pending reminder id>",
  nextStep: "give_up",
  note: "No answer after 3 attempts"
}
→ opportunity.status = "lost"
→ followUp.completionOutcome = "no_response_given_up"

# Branch B — schedule_new
{
  followUpId: "<pending reminder id>",
  nextStep: "schedule_new",
  note: "Tried at 2pm, no answer",
  newReminder: {
    contactMethod: "text",
    reminderScheduledAt: <now + 2 days>,
    reminderNote: "Try SMS since the call didn't work"
  }
}
→ old followUp.completionOutcome = "no_response_rescheduled"
→ NEW manual_reminder follow-up exists on same opportunity
→ opportunity.status UNCHANGED (still follow_up_scheduled)

# Branch C — close_only
{
  followUpId: "<pending reminder id>",
  nextStep: "close_only",
  note: "Will decide tomorrow"
}
→ followUp.completionOutcome = "no_response_close_only"
→ opportunity.status UNCHANGED
→ No new follow-up inserted
```

**Step 3: Negative tests.**
- `nextStep: "schedule_new"` with `newReminder` omitted → throws `"newReminder required when nextStep = schedule_new"`.
- `nextStep: "schedule_new"` with `newReminder.reminderScheduledAt = now - 1000` → throws `"Reminder time must be in the future"`.

**Key implementation notes:**
- **Branch order matters.** Opportunity patch runs BEFORE follow-up patch so `replaceOpportunityAggregate` sees the correct prior status. If we completed the follow-up first, the aggregate snapshot would still read the un-patched opportunity — correct for this mutation but confusing to debug.
- **`as const` on the outcome tag.** Without it, TypeScript widens to `string` and the `ctx.db.patch` validator complains. A tiny annotation, huge error-message clarity.
- **`close_only` still fires the `followUp.completed` event.** Reporting wants to know that *every* reminder reached a completion state, regardless of opportunity fate.
- **`schedule_new` inserts with `reason: "closer_initiated"`.** Matches the existing `createManualReminderFollowUpPublic` semantics — this is a closer choosing to retry, not an automated system creating a follow-up.
- **`newFollowUpId` return.** The dialog can optionally push the user to the new reminder detail page if it wants (design doc open question — currently we just `router.push("/workspace/closer")`). Returning the id keeps the option open without a schema change later.
- **Do NOT touch `opportunity.latestMeetingId` / `nextMeetingId`.** These denormalized refs are meeting-centric; follow-ups don't appear in them.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/reminderOutcomes.ts` | Modify | Append `markReminderNoResponse` public mutation. Phase 3 file is now complete. |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/closer/reminderOutcomes.ts` | Create | 3A |
| `convex/closer/reminderOutcomes.ts` | Modify | 3B |
| `convex/closer/reminderOutcomes.ts` | Modify | 3C |
| `convex/closer/reminderOutcomes.ts` | Modify | 3D |
