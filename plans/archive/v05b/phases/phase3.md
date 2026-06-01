# Phase 3 — Backend Mutation Updates

**Goal:** All write paths populate new fields. Domain events emitted at every status-changing mutation. Lifecycle timestamps, user attribution, and money model corrections enforced. Soft-delete replaces hard-delete. Tenant offboarding cascades all 19 tables.

**Prerequisite:** Phase 2 complete (all backfills done). Specifically:
- `leads.status` backfilled to `"active"` before code assumes it is always defined
- `users.isActive` backfilled to `true` before `requireTenantUser` starts checking it
- `meetings.assignedCloserId` backfilled before queries read it
- `paymentRecords.amountMinor` backfilled before dual-write logic relies on it
- `tenantStats` seeded before counter mutations begin incrementing

**Runs in PARALLEL with:** Nothing. Phase 4 depends on Phase 3 completing.

**Skills to invoke:**
- `convex-performance-audit` -- for validating mutation transaction limits after adding domain event writes
- `convex-migration-helper` -- if any in-flight data needs patching during rollout

**Acceptance Criteria:**

1. Every status-changing mutation in `closer/meetingActions.ts`, `closer/noShowActions.ts`, `closer/payments.ts`, `closer/followUpMutations.ts`, `pipeline/inviteeCreated.ts`, `pipeline/inviteeCanceled.ts`, `pipeline/inviteeNoShow.ts`, `customers/conversion.ts`, `leads/merge.ts`, and `workos/userMutations.ts` emits at least one domain event via `emitDomainEvent()`.
2. All lifecycle timestamp fields (`lostAt`, `canceledAt`, `paymentReceivedAt`, `completedAt`, `bookedAt`, `verifiedAt`, `churnedAt`, `pausedAt`) are set atomically alongside their corresponding status patches.
3. All attribution fields (`lostByUserId`, `noShowMarkedByUserId`, `verifiedByUserId`) are set in their respective mutations.
4. `logPayment` computes `amountMinor = Math.round(amount * 100)`, validates currency as 3-character uppercase, and writes both `amount` (backward compat) and `amountMinor` to `paymentRecords`.
5. `removeUser` in `workos/userMutations.ts` patches `{ deletedAt, isActive: false }` instead of calling `ctx.db.delete()`, and throws `ConvexError` if the user has active opportunities.
6. `requireTenantUser` rejects users with `isActive === false` before the role check.
7. All user creation paths (`createUserWithCalendlyLink`, `createInvitedUser`) set `isActive: true`.
8. `deleteTenantRuntimeDataBatch` cascades all 19 tenant-scoped tables with self-scheduling for large data sets.
9. `persistRawEvent` in `webhooks/calendlyMutations.ts` uses a compound index lookup for deduplication instead of the `for await` scan.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
                        3A (Helper Modules)
                              |
        ┌─────────┬──────────┼──────────┬──────────┐
        v         v          v          v          v
       3B        3C         3D         3E         3F
   (Domain     (Money +   (User      (Pipeline  (Data
    Events +   TenantStats Soft-Del) Enhance-   Integrity)
    Timestamps              ments)
    + Attrib)
        |         |          |          |          |
        └─────────┴──────────┴──────────┴──────────┘
                              |
                              v
                        3G (Integration Testing)
```

**Optimal execution:**

1. Complete 3A first (foundation for all other subphases).
2. Run 3B, 3C, 3D, 3E, 3F in parallel (they touch different files).
3. Complete 3G last to verify all mutation paths end-to-end.

**Estimated time:** 3-4 days (3A = 2-3 hours, 3B-3F = 1 day each in parallel, 3G = half day)

---

## Subphases

### 3A -- Helper Modules

**Type:** Backend (new files)
**Parallelizable:** No -- all other subphases depend on these helpers.

**What:** Create four new utility modules under `convex/lib/` that provide shared logic for domain event emission, tenant stats maintenance, money validation, and customer snapshot synchronization.

**Why:** These helpers are called from 17+ mutation functions across 10 files. Centralizing the logic prevents duplication, ensures consistent event shapes, and makes it possible to evolve the event schema in one place.

**Where:**
- `convex/lib/domainEvents.ts` (new)
- `convex/lib/tenantStatsHelper.ts` (new)
- `convex/lib/formatMoney.ts` (new)
- `convex/lib/syncCustomerSnapshot.ts` (new)

**How:**

**Step 1: Create `convex/lib/domainEvents.ts`**

```typescript
// Path: convex/lib/domainEvents.ts
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export type DomainEventEntityType =
  | "opportunity"
  | "meeting"
  | "lead"
  | "customer"
  | "followUp"
  | "user"
  | "payment";

export type DomainEventSource = "closer" | "admin" | "pipeline" | "system";

export type EmitDomainEventParams = {
  tenantId: Id<"tenants">;
  entityType: DomainEventEntityType;
  entityId: string;
  eventType: string;
  source: DomainEventSource;
  actorUserId?: Id<"users">;
  fromStatus?: string;
  toStatus?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Insert an append-only domain event record.
 *
 * Call from any mutation that changes business state.
 * The `metadata` object is JSON-serialized into a string field
 * so Convex does not need to validate arbitrary shapes.
 */
export async function emitDomainEvent(
  ctx: MutationCtx,
  params: EmitDomainEventParams,
): Promise<Id<"domainEvents">> {
  const {
    tenantId,
    entityType,
    entityId,
    eventType,
    source,
    actorUserId,
    fromStatus,
    toStatus,
    reason,
    metadata,
  } = params;

  const eventId = await ctx.db.insert("domainEvents", {
    tenantId,
    entityType,
    entityId,
    eventType,
    occurredAt: Date.now(),
    source,
    actorUserId,
    fromStatus,
    toStatus,
    reason,
    metadata: metadata ? JSON.stringify(metadata) : undefined,
  });

  console.log(`[DomainEvent] ${entityType}.${eventType}`, {
    eventId,
    entityId,
    fromStatus,
    toStatus,
    source,
  });

  return eventId;
}
```

**Step 2: Create `convex/lib/tenantStatsHelper.ts`**

```typescript
// Path: convex/lib/tenantStatsHelper.ts
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Delta object for atomic counter updates on the tenantStats document.
 * Each key is a counter field name; the value is the signed delta (+1, -1, +amount, etc).
 */
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

/**
 * Atomically apply counter deltas to a tenant's stats document.
 *
 * If the tenantStats document does not exist (e.g. tenant was created
 * before Phase 2 seeding), this is a no-op with a warning log.
 * The missing document will be created by the next backfill run.
 */
export async function updateTenantStats(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  delta: TenantStatsDelta,
): Promise<void> {
  const stats = await ctx.db
    .query("tenantStats")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .unique();

  if (!stats) {
    console.warn("[TenantStats] No stats document found, skipping update", {
      tenantId,
    });
    return;
  }

  const patch: Record<string, number> = { lastUpdatedAt: Date.now() };
  for (const [key, value] of Object.entries(delta)) {
    if (value === undefined || value === 0) continue;
    const current = (stats as Record<string, number>)[key] ?? 0;
    patch[key] = current + value;
  }

  await ctx.db.patch(stats._id, patch);
  console.log("[TenantStats] Updated", { tenantId, delta });
}
```

**Step 3: Create `convex/lib/formatMoney.ts`**

```typescript
// Path: convex/lib/formatMoney.ts

/**
 * Validate that an amount in minor units (cents) is a non-negative integer.
 * Returns the validated integer or throws.
 */
export function validateAmountMinor(amountMinor: number): number {
  if (!Number.isFinite(amountMinor) || amountMinor < 0) {
    throw new Error(
      `Invalid amount: ${amountMinor}. Must be a non-negative number.`,
    );
  }
  const rounded = Math.round(amountMinor);
  if (rounded !== amountMinor) {
    throw new Error(
      `Amount in minor units must be an integer, got ${amountMinor}.`,
    );
  }
  return rounded;
}

/**
 * Convert a display amount (e.g. 149.99) to minor units (14999).
 * Rounds to the nearest integer to handle floating-point imprecision.
 */
export function toAmountMinor(displayAmount: number): number {
  if (!Number.isFinite(displayAmount) || displayAmount < 0) {
    throw new Error(
      `Invalid display amount: ${displayAmount}. Must be a non-negative number.`,
    );
  }
  return Math.round(displayAmount * 100);
}

// ISO 4217 currencies commonly used in fitness/coaching businesses.
// Extend as needed -- the key constraint is 3-char uppercase.
const SUPPORTED_CURRENCIES = new Set([
  "USD", "EUR", "GBP", "CAD", "AUD", "NZD", "MXN", "BRL",
  "COP", "ARS", "CLP", "PEN", "SGD", "HKD", "JPY", "KRW",
  "INR", "ZAR", "AED", "CHF", "SEK", "NOK", "DKK", "PLN",
]);

/**
 * Validate and normalize a currency code.
 * Returns the 3-character uppercase code or throws.
 */
export function validateCurrency(currency: string): string {
  const normalized = currency.trim().toUpperCase();
  if (normalized.length !== 3 || !/^[A-Z]{3}$/.test(normalized)) {
    throw new Error(
      `Invalid currency code "${currency}". Must be a 3-letter ISO 4217 code.`,
    );
  }
  if (!SUPPORTED_CURRENCIES.has(normalized)) {
    console.warn(
      `[Money] Currency "${normalized}" not in known list. Allowing but flagging.`,
    );
  }
  return normalized;
}
```

**Step 4: Create `convex/lib/syncCustomerSnapshot.ts`**

```typescript
// Path: convex/lib/syncCustomerSnapshot.ts
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Synchronize a customer's denormalized snapshot fields from the linked lead.
 *
 * Call after any mutation that changes lead identity fields (fullName, email, phone, socialHandles).
 * If no customer is linked to the lead, this is a no-op.
 */
export async function syncCustomerSnapshot(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
): Promise<void> {
  const lead = await ctx.db.get(leadId);
  if (!lead || lead.tenantId !== tenantId) {
    return;
  }

  const customer = await ctx.db
    .query("customers")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId),
    )
    .first();

  if (!customer) {
    return;
  }

  const needsUpdate =
    customer.fullName !== (lead.fullName ?? lead.email) ||
    customer.email !== lead.email ||
    customer.phone !== lead.phone ||
    JSON.stringify(customer.socialHandles) !==
      JSON.stringify(lead.socialHandles);

  if (!needsUpdate) {
    return;
  }

  await ctx.db.patch(customer._id, {
    fullName: lead.fullName ?? lead.email,
    email: lead.email,
    phone: lead.phone,
    socialHandles: lead.socialHandles,
  });

  console.log("[CustomerSnapshot] Synced from lead", {
    customerId: customer._id,
    leadId,
  });
}
```

**Key implementation notes:**
- `emitDomainEvent` serializes `metadata` to JSON string so the `domainEvents` table does not need `v.any()` -- it uses `v.optional(v.string())`.
- `updateTenantStats` is intentionally a no-op when the stats document is missing, rather than creating it on the fly. This prevents partial seeding and keeps the backfill path as the single source of truth for initial values.
- `validateCurrency` uses a known-set warning rather than a hard reject to avoid blocking payments in currencies we haven't explicitly listed.
- All helpers accept `MutationCtx` as the first argument, matching the Convex pattern for shared mutation logic.

**Files touched:**

| File | Action | Lines changed (est.) |
|------|--------|---------------------|
| `convex/lib/domainEvents.ts` | New | ~70 |
| `convex/lib/tenantStatsHelper.ts` | New | ~60 |
| `convex/lib/formatMoney.ts` | New | ~70 |
| `convex/lib/syncCustomerSnapshot.ts` | New | ~50 |

---

### 3B -- Domain Event Emission + Lifecycle Timestamps + Attribution

**Type:** Backend (modify existing mutations)
**Parallelizable:** Yes -- after 3A. Runs in parallel with 3C, 3D, 3E, 3F.

**What:** Wire `emitDomainEvent()` into all 17 mutation functions at ~25 emission sites. Simultaneously set lifecycle timestamps and user attribution fields on the same status-changing patches.

**Why:** Without domain events, the system has no durable audit trail -- status transitions overwrite in place and historical context is lost. The timestamps and attribution fields enable analytics queries like "average time from in_progress to payment_received" and "which closer marked this as lost."

**Where:**
- `convex/closer/meetingActions.ts` (modify)
- `convex/closer/noShowActions.ts` (modify)
- `convex/closer/payments.ts` (modify)
- `convex/closer/followUpMutations.ts` (modify)
- `convex/pipeline/inviteeCreated.ts` (modify)
- `convex/pipeline/inviteeCanceled.ts` (modify)
- `convex/pipeline/inviteeNoShow.ts` (modify)
- `convex/customers/conversion.ts` (modify)
- `convex/leads/merge.ts` (modify)

**How:**

**Step 1: Wire domain events into `closer/meetingActions.ts`**

In `startMeeting`, after the status patches (lines 96-104), add two domain events:

```typescript
// Path: convex/closer/meetingActions.ts
// Inside startMeeting handler, after the patches and before updateOpportunityMeetingRefs:

await emitDomainEvent(ctx, {
  tenantId,
  entityType: "opportunity",
  entityId: opportunity._id,
  eventType: "opportunity.status_changed",
  source: "closer",
  actorUserId: userId,
  fromStatus: opportunity.status,
  toStatus: "in_progress",
});

await emitDomainEvent(ctx, {
  tenantId,
  entityType: "meeting",
  entityId: meetingId,
  eventType: "meeting.started",
  source: "closer",
  actorUserId: userId,
  fromStatus: meeting.status,
  toStatus: "in_progress",
});
```

In `markAsLost`, extend the patch to include `lostAt` and `lostByUserId`, then emit:

```typescript
// Path: convex/closer/meetingActions.ts
// Inside markAsLost handler, replace the patch object construction:

const now = Date.now();
const normalizedReason = reason?.trim();
const patch: Partial<Doc<"opportunities">> = {
  status: "lost",
  updatedAt: now,
  lostAt: now,
  lostByUserId: userId,
};
if (normalizedReason) {
  patch.lostReason = normalizedReason;
}

await ctx.db.patch(opportunityId, patch);

await emitDomainEvent(ctx, {
  tenantId,
  entityType: "opportunity",
  entityId: opportunityId,
  eventType: "opportunity.marked_lost",
  source: "closer",
  actorUserId: userId,
  fromStatus: opportunity.status,
  toStatus: "lost",
  reason: normalizedReason,
});
```

**Step 2: Wire domain events into `closer/noShowActions.ts`**

In `markNoShow`, after the patches (lines 66-78), add `noShowMarkedByUserId` to the meeting patch and emit two events:

```typescript
// Path: convex/closer/noShowActions.ts
// Inside markNoShow handler, extend the meeting patch:

await ctx.db.patch(meetingId, {
  status: "no_show",
  noShowMarkedAt: now,
  noShowWaitDurationMs: waitDurationMs,
  noShowReason: reason,
  noShowNote: normalizedNote,
  noShowSource: "closer",
  noShowMarkedByUserId: userId,  // NEW: attribution
});

// After the opportunity patch:
await emitDomainEvent(ctx, {
  tenantId,
  entityType: "meeting",
  entityId: meetingId,
  eventType: "meeting.no_show",
  source: "closer",
  actorUserId: userId,
  fromStatus: meeting.status,
  toStatus: "no_show",
  metadata: { reason, waitDurationMs },
});

await emitDomainEvent(ctx, {
  tenantId,
  entityType: "opportunity",
  entityId: opportunity._id,
  eventType: "opportunity.status_changed",
  source: "closer",
  actorUserId: userId,
  fromStatus: opportunity.status,
  toStatus: "no_show",
});
```

In `createNoShowRescheduleLink`, after the opportunity patch (line 179), emit:

```typescript
// Path: convex/closer/noShowActions.ts
// Inside createNoShowRescheduleLink handler, after opportunity patch:

await emitDomainEvent(ctx, {
  tenantId,
  entityType: "opportunity",
  entityId: opportunityId,
  eventType: "opportunity.status_changed",
  source: "closer",
  actorUserId: userId,
  fromStatus: "no_show",
  toStatus: "reschedule_link_sent",
  metadata: { followUpId, originalMeetingId: meetingId },
});
```

**Step 3: Wire domain events into `closer/payments.ts`**

In `logPayment`, after the opportunity patch (line 133) and before auto-conversion, add `paymentReceivedAt` to the opportunity patch and emit two events:

```typescript
// Path: convex/closer/payments.ts
// Inside logPayment handler, extend the opportunity patch:

const now = Date.now();

// Transition opportunity to payment_received (terminal state)
await ctx.db.patch(args.opportunityId, {
  status: "payment_received",
  updatedAt: now,
  paymentReceivedAt: now,  // NEW: lifecycle timestamp
});

await emitDomainEvent(ctx, {
  tenantId,
  entityType: "payment",
  entityId: paymentId,
  eventType: "payment.recorded",
  source: "closer",
  actorUserId: userId,
  metadata: {
    opportunityId: args.opportunityId,
    meetingId: args.meetingId,
    amount: args.amount,
    amountMinor,
    currency,
    provider,
  },
});

await emitDomainEvent(ctx, {
  tenantId,
  entityType: "opportunity",
  entityId: args.opportunityId,
  eventType: "opportunity.status_changed",
  source: "closer",
  actorUserId: userId,
  fromStatus: opportunity.status,
  toStatus: "payment_received",
});
```

**Step 4: Wire domain events into `closer/followUpMutations.ts`**

In `transitionToFollowUp`, after the patch (line 62):

```typescript
// Path: convex/closer/followUpMutations.ts
// Inside transitionToFollowUp handler, after the patch:

await emitDomainEvent(ctx, {
  tenantId: opportunity.tenantId,
  entityType: "opportunity",
  entityId: opportunityId,
  eventType: "opportunity.status_changed",
  source: "system",
  fromStatus: opportunity.status,
  toStatus: "follow_up_scheduled",
});
```

In `confirmFollowUpScheduled`, after the patch (line 204), set `bookedAt` on the linked follow-up and emit:

```typescript
// Path: convex/closer/followUpMutations.ts
// Inside confirmFollowUpScheduled handler, after the opportunity patch:

// Find and update the pending follow-up with bookedAt
const pendingFollowUp = await ctx.db
  .query("followUps")
  .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
  .order("desc")
  .first();
if (pendingFollowUp && pendingFollowUp.status === "pending") {
  await ctx.db.patch(pendingFollowUp._id, { bookedAt: Date.now() });
}

await emitDomainEvent(ctx, {
  tenantId,
  entityType: "opportunity",
  entityId: opportunityId,
  eventType: "opportunity.status_changed",
  source: "closer",
  actorUserId: userId,
  fromStatus: opportunity.status,
  toStatus: "follow_up_scheduled",
});
```

In `createManualReminderFollowUpPublic`, after the opportunity patch (line 258):

```typescript
// Path: convex/closer/followUpMutations.ts
// Inside createManualReminderFollowUpPublic handler, after patches:

await emitDomainEvent(ctx, {
  tenantId,
  entityType: "followUp",
  entityId: followUpId,
  eventType: "followUp.created",
  source: "closer",
  actorUserId: userId,
  metadata: {
    type: "manual_reminder",
    contactMethod: args.contactMethod,
    reminderScheduledAt: args.reminderScheduledAt,
  },
});

await emitDomainEvent(ctx, {
  tenantId,
  entityType: "opportunity",
  entityId: args.opportunityId,
  eventType: "opportunity.status_changed",
  source: "closer",
  actorUserId: userId,
  fromStatus: opportunity.status,
  toStatus: "follow_up_scheduled",
});
```

**Step 5: Wire domain events into pipeline handlers**

In `pipeline/inviteeCanceled.ts`, after the meeting and opportunity patches:

```typescript
// Path: convex/pipeline/inviteeCanceled.ts
// Inside process handler, after meeting status patch:

if (meeting.status !== "canceled") {
  await ctx.db.patch(meeting._id, {
    status: "canceled",
    canceledAt: now,  // NEW: lifecycle timestamp
  });
  // ... existing updateOpportunityMeetingRefs call ...

  await emitDomainEvent(ctx, {
    tenantId,
    entityType: "meeting",
    entityId: meeting._id,
    eventType: "meeting.canceled",
    source: "pipeline",
    fromStatus: meeting.status,
    toStatus: "canceled",
  });
}

// After opportunity patch:
if (opportunity && shouldMarkCanceled) {
  const oppNow = Date.now();
  await ctx.db.patch(opportunity._id, {
    status: "canceled",
    cancellationReason,
    canceledBy,
    canceledAt: oppNow,  // NEW: lifecycle timestamp
    updatedAt: oppNow,
  });

  await emitDomainEvent(ctx, {
    tenantId,
    entityType: "opportunity",
    entityId: opportunity._id,
    eventType: "opportunity.status_changed",
    source: "pipeline",
    fromStatus: opportunity.status,
    toStatus: "canceled",
    reason: cancellationReason,
  });
}
```

In `pipeline/inviteeNoShow.ts`, both `process` and `revert` handlers:

```typescript
// Path: convex/pipeline/inviteeNoShow.ts
// Inside process handler, after meeting patch:

await emitDomainEvent(ctx, {
  tenantId,
  entityType: "meeting",
  entityId: meeting._id,
  eventType: "meeting.no_show",
  source: "pipeline",
  fromStatus: meeting.status,
  toStatus: "no_show",
});

// After opportunity patch:
await emitDomainEvent(ctx, {
  tenantId,
  entityType: "opportunity",
  entityId: opportunity._id,
  eventType: "opportunity.status_changed",
  source: "pipeline",
  fromStatus: opportunity.status,
  toStatus: "no_show",
});

// Inside revert handler, after meeting patch:
await emitDomainEvent(ctx, {
  tenantId,
  entityType: "meeting",
  entityId: meeting._id,
  eventType: "meeting.reverted",
  source: "pipeline",
  fromStatus: "no_show",
  toStatus: "scheduled",
});

// After opportunity revert patch:
await emitDomainEvent(ctx, {
  tenantId,
  entityType: "opportunity",
  entityId: opportunity._id,
  eventType: "opportunity.status_changed",
  source: "pipeline",
  fromStatus: "no_show",
  toStatus: "scheduled",
});
```

In `pipeline/inviteeCreated.ts`, emit at each of the 5 code paths where opportunities/meetings are created. The pattern is the same at each site -- after each `ctx.db.insert("meetings", ...)` and opportunity creation/patch:

```typescript
// Path: convex/pipeline/inviteeCreated.ts
// After each meeting insert (4 sites at ~1104, ~1305, ~1436 and the UTM-linking path):

await emitDomainEvent(ctx, {
  tenantId,
  entityType: "meeting",
  entityId: meetingId,
  eventType: "meeting.created",
  source: "pipeline",
  toStatus: "scheduled",
  metadata: {
    calendlyEventUri,
    scheduledAt,
    rescheduledFromMeetingId,
  },
});

// After each new opportunity insert:
await emitDomainEvent(ctx, {
  tenantId,
  entityType: "opportunity",
  entityId: opportunityId,
  eventType: "opportunity.created",
  source: "pipeline",
  toStatus: "scheduled",
  metadata: {
    leadId: lead._id,
    assignedCloserId,
    utmSource: utmParams?.utm_source,
  },
});

// After each opportunity re-link (existing opp transitions to "scheduled"):
await emitDomainEvent(ctx, {
  tenantId,
  entityType: "opportunity",
  entityId: reschedOpportunityId,
  eventType: "opportunity.status_changed",
  source: "pipeline",
  fromStatus: previousOpportunityStatus,
  toStatus: "scheduled",
  metadata: { triggerType: "reschedule" },
});
```

**Step 6: Wire domain events into `customers/conversion.ts`**

After the customer insert and lead status patch:

```typescript
// Path: convex/customers/conversion.ts
// Inside executeConversion, after customer creation and lead patch:

await emitDomainEvent(ctx, {
  tenantId,
  entityType: "customer",
  entityId: customerId,
  eventType: "customer.converted",
  source: "system",
  actorUserId: convertedByUserId,
  metadata: {
    leadId,
    winningOpportunityId,
    winningMeetingId,
    programType: resolvedProgramType,
  },
});

await emitDomainEvent(ctx, {
  tenantId,
  entityType: "lead",
  entityId: leadId,
  eventType: "lead.status_changed",
  source: "system",
  actorUserId: convertedByUserId,
  fromStatus: currentStatus,
  toStatus: "converted",
});
```

**Step 7: Wire domain events into `leads/merge.ts`**

After the merge completion:

```typescript
// Path: convex/leads/merge.ts
// Inside executeMerge, after leadMergeHistory insert:

await emitDomainEvent(ctx, {
  tenantId,
  entityType: "lead",
  entityId: sourceLeadId,
  eventType: "lead.merged",
  source: "admin",
  actorUserId: userId,
  fromStatus: "active",
  toStatus: "merged",
  metadata: {
    targetLeadId,
    identifiersMoved,
    opportunitiesMoved: sourceOpportunities.length,
    meetingsMoved,
  },
});
```

**Key implementation notes:**
- Add `import { emitDomainEvent } from "../lib/domainEvents";` to every file touched.
- Each `emitDomainEvent` call adds one document insert per invocation. A mutation that emits 2 events adds 2 writes to the transaction. At ~25 total emission sites across 17 functions, no single mutation exceeds Convex's 8192 document write limit.
- Lifecycle timestamps (`lostAt`, `canceledAt`, `paymentReceivedAt`) are included in the same `ctx.db.patch()` call as the status change -- not as a separate write -- to ensure atomicity.
- Attribution fields (`lostByUserId`, `noShowMarkedByUserId`) are only set in user-initiated mutations, not pipeline-driven ones (pipeline events have no `actorUserId`).

**Files touched:**

| File | Action | Lines changed (est.) |
|------|--------|---------------------|
| `convex/closer/meetingActions.ts` | Modify | ~40 |
| `convex/closer/noShowActions.ts` | Modify | ~35 |
| `convex/closer/payments.ts` | Modify | ~30 |
| `convex/closer/followUpMutations.ts` | Modify | ~50 |
| `convex/pipeline/inviteeCreated.ts` | Modify | ~60 |
| `convex/pipeline/inviteeCanceled.ts` | Modify | ~30 |
| `convex/pipeline/inviteeNoShow.ts` | Modify | ~40 |
| `convex/customers/conversion.ts` | Modify | ~25 |
| `convex/leads/merge.ts` | Modify | ~20 |

---

### 3C -- Money Model + TenantStats Maintenance

**Type:** Backend (modify existing mutations)
**Parallelizable:** Yes -- after 3A. Runs in parallel with 3B, 3D, 3E, 3F.

**What:** Update `logPayment` to dual-write `amountMinor`, validate currency codes, and atomically maintain `customers.totalPaidMinor` and `tenantStats` counters. Wire `updateTenantStats` into all mutations that change counted values.

**Why:** The current payment model uses floating-point `amount` which is unsafe for aggregation. Mixed-currency sums produce nonsensical totals. Denormalized counters in `tenantStats` eliminate 4+ full table scans on every admin dashboard render.

**Where:**
- `convex/closer/payments.ts` (modify)
- `convex/customers/conversion.ts` (modify)
- `convex/closer/meetingActions.ts` (modify -- for `markAsLost` stats)
- `convex/pipeline/inviteeCreated.ts` (modify -- for opportunity/lead/meeting counters)
- `convex/leads/merge.ts` (modify -- for lead counter)

**How:**

**Step 1: Update `logPayment` for dual-write money model**

```typescript
// Path: convex/closer/payments.ts
// Inside logPayment handler, after validation (around line 98):

import { toAmountMinor, validateCurrency } from "../lib/formatMoney";
import { updateTenantStats } from "../lib/tenantStatsHelper";

// Validate and compute amountMinor
const validatedCurrency = validateCurrency(args.currency);
const amountMinor = toAmountMinor(args.amount);

// Create payment record with both amount (backward compat) and amountMinor
const paymentId = await ctx.db.insert("paymentRecords", {
  tenantId,
  opportunityId: args.opportunityId,
  meetingId: args.meetingId,
  closerId: userId,
  amount: args.amount,         // Keep for Phase 6 removal
  amountMinor,                 // NEW: integer cents
  currency: validatedCurrency, // Normalized
  provider,
  referenceCode: referenceCode || undefined,
  proofFileId: args.proofFileId ?? undefined,
  status: "recorded",
  recordedAt: Date.now(),
  contextType: "opportunity",  // NEW: explicit context discriminator
});
```

**Step 2: Update customer totals after payment**

```typescript
// Path: convex/closer/payments.ts
// Inside logPayment handler, after auto-conversion logic:

// Update customer payment totals (Finding 4)
const linkedCustomerId = customerId ?? existingCustomer?._id;
if (linkedCustomerId) {
  const customer = await ctx.db.get(linkedCustomerId);
  if (customer) {
    await ctx.db.patch(linkedCustomerId, {
      totalPaidMinor: (customer.totalPaidMinor ?? 0) + amountMinor,
      totalPaymentCount: (customer.totalPaymentCount ?? 0) + 1,
      paymentCurrency: validatedCurrency,
    });
  }
}

// Update tenant stats (Finding 4)
await updateTenantStats(ctx, tenantId, {
  wonDeals: 1,
  totalRevenueMinor: amountMinor,
  totalPaymentRecords: 1,
});
```

**Step 3: Wire tenantStats into `markAsLost`**

```typescript
// Path: convex/closer/meetingActions.ts
// Inside markAsLost handler, after the patch:

await updateTenantStats(ctx, tenantId, {
  lostDeals: 1,
  activeOpportunities: -1,
});
```

**Step 4: Wire tenantStats into pipeline opportunity creation**

```typescript
// Path: convex/pipeline/inviteeCreated.ts
// After each new opportunity insert (not reuse/relink paths):

await updateTenantStats(ctx, tenantId, {
  totalOpportunities: 1,
  activeOpportunities: 1,
});

// After each new lead creation (inside resolveLeadIdentity or after):
await updateTenantStats(ctx, tenantId, {
  totalLeads: 1,
});
```

**Step 5: Wire tenantStats into customer conversion**

```typescript
// Path: convex/customers/conversion.ts
// Inside executeConversion, after customer creation:

await updateTenantStats(ctx, tenantId, {
  totalCustomers: 1,
});
```

**Step 6: Wire tenantStats into lead merge (net -1 active lead)**

```typescript
// Path: convex/leads/merge.ts
// Inside executeMerge, after source lead is marked merged:

await updateTenantStats(ctx, tenantId, {
  totalLeads: -1,
});
```

**Key implementation notes:**
- `amount` is kept on `paymentRecords` during Phase 3 for backward compatibility. Phase 6 removes it.
- `contextType` is set to `"opportunity"` for standard payments. Customer-initiated payments (if/when added) will use `"customer"`.
- `updateTenantStats` is intentionally idempotent -- if the stats doc is missing, it no-ops. This means the very first payment after deployment won't crash even if Phase 2 seeding hasn't run yet.
- The `activeOpportunities` delta is `-1` when an opportunity reaches a terminal state (`lost`, `canceled`, `payment_received`). Only `markAsLost` and `logPayment` decrement it in this phase; pipeline cancellation is handled separately.

**Files touched:**

| File | Action | Lines changed (est.) |
|------|--------|---------------------|
| `convex/closer/payments.ts` | Modify | ~35 |
| `convex/closer/meetingActions.ts` | Modify | ~5 |
| `convex/pipeline/inviteeCreated.ts` | Modify | ~15 |
| `convex/customers/conversion.ts` | Modify | ~5 |
| `convex/leads/merge.ts` | Modify | ~5 |

---

### 3D -- User Soft-Delete + Auth Guard

**Type:** Backend (modify existing mutations + auth guard)
**Parallelizable:** Yes -- after 3A. Runs in parallel with 3B, 3C, 3E, 3F.

**What:** Replace the hard-delete in `removeUser` with a soft-delete (`isActive: false`, `deletedAt`). Add `isActive` check to `requireTenantUser`. Add `isActive: true` to all user creation paths.

**Why:** Hard-deleting users breaks referential integrity -- opportunities, payments, meetings, and domain events all reference user IDs. A soft-deleted user's historical data remains valid while preventing them from authenticating.

**Where:**
- `convex/workos/userMutations.ts` (modify)
- `convex/requireTenantUser.ts` (modify)

**How:**

**Step 1: Replace hard delete with soft delete in `removeUser`**

Replace the entire `removeUser` handler (lines 432-460):

```typescript
// Path: convex/workos/userMutations.ts
import { ConvexError } from "convex/values";
import { emitDomainEvent } from "../lib/domainEvents";
import { updateTenantStats } from "../lib/tenantStatsHelper";

export const removeUser = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    console.log("[WorkOS:Users] removeUser called", { userId });
    const user = await ctx.db.get(userId);
    if (!user) {
      console.warn("[WorkOS:Users] removeUser user not found", { userId });
      return;
    }

    // Already soft-deleted -- idempotent
    if (user.isActive === false) {
      console.log("[WorkOS:Users] removeUser: already deactivated", { userId });
      return;
    }

    // Check for active opportunity assignments
    const activeOpps = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId", (q) =>
        q.eq("tenantId", user.tenantId).eq("assignedCloserId", userId),
      )
      .take(10);

    const hasActiveOpps = activeOpps.some(
      (o) =>
        !["lost", "canceled", "payment_received"].includes(o.status),
    );

    if (hasActiveOpps) {
      throw new ConvexError(
        "Cannot remove user with active opportunities. Reassign them first.",
      );
    }

    // Soft-delete: mark inactive, preserve record
    const now = Date.now();
    await ctx.db.patch(userId, {
      deletedAt: now,
      isActive: false,
    });

    // Unlink Calendly org member (if linked) -- keep the member, just clear the match
    if (user.calendlyUserUri) {
      const member = await ctx.db
        .query("calendlyOrgMembers")
        .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
          q
            .eq("tenantId", user.tenantId)
            .eq("calendlyUserUri", user.calendlyUserUri!),
        )
        .unique();
      if (member) {
        await ctx.db.patch(member._id, { matchedUserId: undefined });
      }
    }

    // Emit domain event
    await emitDomainEvent(ctx, {
      tenantId: user.tenantId,
      entityType: "user",
      entityId: userId,
      eventType: "user.deactivated",
      source: "admin",
      metadata: { email: user.email, role: user.role },
    });

    // Update tenant stats
    const statsDelta: Record<string, number> = { totalTeamMembers: -1 };
    if (user.role === "closer") {
      statsDelta.totalClosers = -1;
    }
    await updateTenantStats(ctx, user.tenantId, statsDelta);

    console.log("[WorkOS:Users] removeUser soft-deleted", {
      userId,
      role: user.role,
    });
  },
});
```

**Step 2: Add `isActive: true` to user creation paths**

In `createUserWithCalendlyLink` (line 90-98), add `isActive: true` to the insert:

```typescript
// Path: convex/workos/userMutations.ts
// Inside createUserWithCalendlyLink handler, in the insert:

const userId = await ctx.db.insert("users", {
  tenantId,
  workosUserId: canonicalWorkosUserId,
  email,
  fullName,
  role,
  calendlyUserUri: resolvedCalendlyUserUri,
  calendlyMemberName: resolvedCalendlyMemberName,
  isActive: true,  // NEW
});
```

In `createInvitedUser` (line 191-202), add `isActive: true` to the insert:

```typescript
// Path: convex/workos/userMutations.ts
// Inside createInvitedUser handler, in the insert:

const userId = await ctx.db.insert("users", {
  tenantId,
  workosUserId,
  email,
  fullName,
  role,
  calendlyUserUri: resolvedCalendlyUserUri,
  calendlyMemberName: resolvedCalendlyMemberName,
  invitationStatus,
  workosInvitationId,
  isActive: true,  // NEW
});
```

**Step 3: Add domain events for user invitation and role changes**

In `updateRole` (line 391-405):

```typescript
// Path: convex/workos/userMutations.ts
// Inside updateRole handler, after the patch:

const user = await ctx.db.get(userId);
if (user) {
  await emitDomainEvent(ctx, {
    tenantId: user.tenantId,
    entityType: "user",
    entityId: userId,
    eventType: "user.role_changed",
    source: "admin",
    fromStatus: user.role,  // Previous role was just overwritten, but logged before patch
    toStatus: role,
  });
}
```

Note: To capture the previous role, read the user before the patch and pass `previousRole` to the event. Restructure as:

```typescript
// Path: convex/workos/userMutations.ts
export const updateRole = internalMutation({
  args: {
    userId: v.id("users"),
    role: v.union(
      v.literal("tenant_master"),
      v.literal("tenant_admin"),
      v.literal("closer"),
    ),
  },
  handler: async (ctx, { userId, role }) => {
    console.log("[WorkOS:Users] updateRole called", { userId, role });
    const user = await ctx.db.get(userId);
    if (!user) {
      console.warn("[WorkOS:Users] updateRole: user not found", { userId });
      return;
    }
    const previousRole = user.role;
    await ctx.db.patch(userId, { role });

    await emitDomainEvent(ctx, {
      tenantId: user.tenantId,
      entityType: "user",
      entityId: userId,
      eventType: "user.role_changed",
      source: "admin",
      fromStatus: previousRole,
      toStatus: role,
    });

    console.log("[WorkOS:Users] updateRole completed", { userId, previousRole, role });
  },
});
```

**Step 4: Add `isActive` check to `requireTenantUser`**

```typescript
// Path: convex/requireTenantUser.ts
// After the user is found (line 76) and before the tenant check (line 83):

if (user.isActive === false) {
  console.error("[Auth] requireTenantUser failed: user deactivated", {
    userId: user._id,
    workosUserId,
  });
  throw new Error("Account deactivated — contact your administrator");
}
```

**Step 5: Wire tenantStats into user creation**

```typescript
// Path: convex/workos/userMutations.ts
// Inside createUserWithCalendlyLink, after successful insert (not update):

await updateTenantStats(ctx, tenantId, {
  totalTeamMembers: 1,
  ...(role === "closer" ? { totalClosers: 1 } : {}),
});

// Same in createInvitedUser after successful insert:
await updateTenantStats(ctx, tenantId, {
  totalTeamMembers: 1,
  ...(role === "closer" ? { totalClosers: 1 } : {}),
});
```

**Key implementation notes:**
- The `isActive` check in `requireTenantUser` uses `=== false` (not `!user.isActive`), because `undefined` means "not yet backfilled" and should be treated as active. After Phase 6 narrows the field to required, this can change to `!user.isActive`.
- `ConvexError` is used (not plain `Error`) for the active-opportunities guard so the frontend can detect and display a user-friendly error message.
- The Calendly member unlink is preserved from the original `removeUser` -- we still want to free up the Calendly member for reassignment.
- `tenantStats` updates for user creation are only called on the `insert` path, not the `patch existing` (idempotent) path.

**Files touched:**

| File | Action | Lines changed (est.) |
|------|--------|---------------------|
| `convex/workos/userMutations.ts` | Modify | ~80 |
| `convex/requireTenantUser.ts` | Modify | ~10 |

---

### 3E -- Pipeline Enhancements

**Type:** Backend (modify pipeline mutations)
**Parallelizable:** Yes -- after 3A. Runs in parallel with 3B, 3C, 3D, 3F.

**What:** Set `assignedCloserId` on every meeting insert. Extract per-meeting booking answers into `meetingFormResponses` and `eventTypeFieldCatalog` tables. Wire from the existing `extractQuestionsAndAnswers` output.

**Why:** Without `assignedCloserId` on meetings, closer-specific queries require an O(n*m) join through opportunities. Without normalized booking answers, form field analysis requires parsing raw webhook payloads and loses data after the 30-day retention cleanup.

**Where:**
- `convex/pipeline/inviteeCreated.ts` (modify -- 4 meeting insert sites)

**How:**

**Step 1: Add `assignedCloserId` to all meeting inserts**

There are 4 meeting insert sites in `inviteeCreated.ts` (at approximately lines 1104, 1305, 1436, and the UTM-linking path). At each site, add `assignedCloserId` from the resolved or inherited closer:

```typescript
// Path: convex/pipeline/inviteeCreated.ts
// At each of the 4 meeting insert sites, add assignedCloserId:

const meetingId = await ctx.db.insert("meetings", {
  tenantId,
  opportunityId,
  calendlyEventUri,
  calendlyInviteeUri,
  zoomJoinUrl: meetingLocation.zoomJoinUrl,
  meetingJoinUrl: meetingLocation.meetingJoinUrl,
  meetingLocationType: meetingLocation.meetingLocationType,
  scheduledAt,
  durationMinutes,
  status: "scheduled",
  notes: meetingNotes,
  leadName: lead.fullName ?? lead.email,
  createdAt: now,
  utmParams,
  rescheduledFromMeetingId,
  assignedCloserId: assignedCloserId ?? undefined,  // NEW: copy from opportunity
});
```

For the reuse/relink paths where the opportunity has an existing `assignedCloserId`, use the resolved value:

```typescript
// For UTM-linking path (~line 1104):
assignedCloserId: assignedCloserId ?? targetOpportunity.assignedCloserId ?? undefined,

// For heuristic reschedule path (~line 1305):
assignedCloserId: nextAssignedCloserId ?? undefined,

// For follow-up reuse path (~line 1436):
assignedCloserId: assignedCloserId ?? existingFollowUp.assignedCloserId ?? undefined,
```

**Step 2: Extract booking answers into `meetingFormResponses`**

Create a helper function and call it after each meeting insert:

```typescript
// Path: convex/pipeline/inviteeCreated.ts
// New helper function (add near the top of the file, after existing helpers):

async function persistBookingAnswers(
  ctx: MutationCtx,
  params: {
    tenantId: Id<"tenants">;
    meetingId: Id<"meetings">;
    opportunityId: Id<"opportunities">;
    leadId: Id<"leads">;
    eventTypeConfigId: Id<"eventTypeConfigs"> | undefined;
    customFields: Record<string, string> | undefined;
    now: number;
  },
): Promise<void> {
  const {
    tenantId,
    meetingId,
    opportunityId,
    leadId,
    eventTypeConfigId,
    customFields,
    now,
  } = params;

  if (!customFields || Object.keys(customFields).length === 0) {
    return;
  }

  for (const [fieldKey, answerText] of Object.entries(customFields)) {
    // Upsert eventTypeFieldCatalog entry
    let fieldCatalogId: Id<"eventTypeFieldCatalog"> | undefined;
    if (eventTypeConfigId) {
      const existingField = await ctx.db
        .query("eventTypeFieldCatalog")
        .withIndex("by_tenantId_and_fieldKey", (q) =>
          q.eq("tenantId", tenantId).eq("fieldKey", fieldKey),
        )
        .first();

      if (existingField && existingField.eventTypeConfigId === eventTypeConfigId) {
        fieldCatalogId = existingField._id;
        // Update lastSeenAt
        await ctx.db.patch(existingField._id, {
          lastSeenAt: now,
          currentLabel: fieldKey,
        });
      } else if (!existingField) {
        fieldCatalogId = await ctx.db.insert("eventTypeFieldCatalog", {
          tenantId,
          eventTypeConfigId,
          fieldKey,
          currentLabel: fieldKey,
          firstSeenAt: now,
          lastSeenAt: now,
        });
      }
    }

    // Insert meetingFormResponse
    await ctx.db.insert("meetingFormResponses", {
      tenantId,
      meetingId,
      opportunityId,
      leadId,
      eventTypeConfigId,
      fieldCatalogId,
      fieldKey,
      questionLabelSnapshot: fieldKey,
      answerText,
      capturedAt: now,
    });
  }

  console.log("[Pipeline] Booking answers persisted", {
    meetingId,
    fieldCount: Object.keys(customFields).length,
  });
}
```

**Step 3: Call `persistBookingAnswers` after each meeting insert**

At each of the 4 meeting creation sites, add the call after the meeting insert and after `updateOpportunityMeetingRefs`:

```typescript
// Path: convex/pipeline/inviteeCreated.ts
// After each meeting insert + updateOpportunityMeetingRefs:

await persistBookingAnswers(ctx, {
  tenantId,
  meetingId,
  opportunityId,  // or reschedOpportunityId, depending on the code path
  leadId: lead._id,
  eventTypeConfigId,
  customFields: latestCustomFields,
  now,
});
```

**Key implementation notes:**
- The `assignedCloserId` on meetings is a projection of the opportunity's closer at the time of meeting creation. Reassignment (Feature H) already updates meetings via `meetingReassignments` -- that code path also needs to patch `assignedCloserId` on affected meetings, but that is handled in Subphase 3F (denormalized field maintenance).
- `persistBookingAnswers` does not replace the existing `leads.customFields` merge -- both paths run in parallel during the transition period. `customFields` continues to be the UI's source; `meetingFormResponses` is the analytics source.
- The `eventTypeFieldCatalog` upsert uses a `first()` query filtered by `fieldKey` and then checks `eventTypeConfigId` in code. This is safe because field keys are unique per event type in practice.
- Each booking typically has 2-5 Q&A pairs, adding 2-5 document writes per webhook. Well within transaction limits.

**Files touched:**

| File | Action | Lines changed (est.) |
|------|--------|---------------------|
| `convex/pipeline/inviteeCreated.ts` | Modify | ~80 |

---

### 3F -- Data Integrity Fixes

**Type:** Backend (modify existing mutations)
**Parallelizable:** Yes -- after 3A. Runs in parallel with 3B, 3C, 3D, 3E.

**What:** Fix webhook deduplication to use compound index. Add event type config upsert guard. Expand tenant cascade to all 19 tables. Wire customer snapshot sync. Maintain `meetings.leadName` on lead update. Maintain `assignedCloserId` on meeting reassignment.

**Why:** The current webhook dedup scans all events for a tenant+type before comparing URIs in JS, creating O(n) reads and OCC conflict risk. The tenant cascade only covers 3 of 19 tables, leaving orphaned data. Customer snapshots drift from lead data after conversion.

**Where:**
- `convex/webhooks/calendlyMutations.ts` (modify)
- `convex/admin/tenantsMutations.ts` (modify)
- `convex/leads/mutations.ts` (modify)
- `convex/leads/merge.ts` (modify)

**How:**

**Step 1: Fix webhook dedup with compound index lookup**

Replace the `for await` scan in `persistRawEvent` (lines 15-29):

```typescript
// Path: convex/webhooks/calendlyMutations.ts
// Replace the entire dedup block:

export const persistRawEvent = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    calendlyEventUri: v.string(),
    eventType: v.string(),
    payload: v.string(),
  },
  handler: async (ctx, args) => {
    console.log(
      `[Webhook] persistRawEvent called: eventType=${args.eventType}, uri=${args.calendlyEventUri}`,
    );

    // O(1) compound index lookup (replaces O(n) scan-then-compare)
    const existing = await ctx.db
      .query("rawWebhookEvents")
      .withIndex("by_tenantId_and_eventType_and_calendlyEventUri", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("eventType", args.eventType)
          .eq("calendlyEventUri", args.calendlyEventUri),
      )
      .first();

    if (existing) {
      console.warn(
        `[Webhook] Duplicate detected: eventType=${args.eventType}, uri=${args.calendlyEventUri} -- skipping`,
      );
      return null;
    }

    const rawEventId = await ctx.db.insert("rawWebhookEvents", {
      ...args,
      processed: false,
      receivedAt: Date.now(),
    });

    console.log(
      `[Webhook] New event inserted: id=${rawEventId}, eventType=${args.eventType}`,
    );

    await ctx.scheduler.runAfter(
      0,
      internal.pipeline.processor.processRawEvent,
      { rawEventId },
    );

    console.log(
      `[Webhook] Pipeline processing scheduled for rawEventId=${rawEventId}`,
    );

    return rawEventId;
  },
});
```

Note: This requires the compound index `by_tenantId_and_eventType_and_calendlyEventUri` to already exist from Phase 1. Verify it is in `schema.ts` before deploying.

**Step 2: Expand tenant cascade to all 19 tables**

Replace the `deleteTenantRuntimeDataBatch` handler:

```typescript
// Path: convex/admin/tenantsMutations.ts
import { internal } from "../_generated/api";

const CLEANUP_BATCH_SIZE = 128;

// Tables in reverse-dependency order.
// Delete children before parents to avoid referential confusion.
const TENANT_SCOPED_TABLES = [
  "paymentRecords",
  "meetingFormResponses",
  "followUps",
  "meetingReassignments",
  "closerUnavailability",
  "meetings",
  "opportunities",
  "customers",
  "leadMergeHistory",
  "leadIdentifiers",
  "leads",
  "eventTypeConfigs",
  "eventTypeFieldCatalog",
  "domainEvents",
  "tenantStats",
  // tenantCalendlyConnections handled in Phase 5
  "rawWebhookEvents",
  "calendlyOrgMembers",
  "users", // Last: other tables reference users
] as const;

export const deleteTenantRuntimeDataBatch = internalMutation({
  args: {
    tenantId: v.id("tenants"),
  },
  handler: async (ctx, { tenantId }) => {
    console.log("[Admin] deleteTenantRuntimeDataBatch called", { tenantId });

    let totalDeleted = 0;
    let hasMore = false;

    for (const tableName of TENANT_SCOPED_TABLES) {
      const rows = await ctx.db
        .query(tableName)
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .take(CLEANUP_BATCH_SIZE);

      for (const row of rows) {
        // Delete proof files before deleting payment records
        if (
          tableName === "paymentRecords" &&
          "proofFileId" in row &&
          row.proofFileId
        ) {
          await ctx.storage.delete(row.proofFileId as any);
        }
        await ctx.db.delete(row._id);
      }

      totalDeleted += rows.length;
      if (rows.length === CLEANUP_BATCH_SIZE) {
        hasMore = true;
      }

      console.log(
        `[Admin] deleteTenantRuntimeDataBatch: ${tableName} deleted`,
        { tenantId, count: rows.length },
      );
    }

    // Self-schedule if more data remains
    if (hasMore) {
      await ctx.scheduler.runAfter(
        0,
        internal.admin.tenantsMutations.deleteTenantRuntimeDataBatch,
        { tenantId },
      );
      console.log(
        "[Admin] deleteTenantRuntimeDataBatch: scheduling continuation",
        { tenantId },
      );
    }

    console.log("[Admin] deleteTenantRuntimeDataBatch completed batch", {
      tenantId,
      totalDeleted,
      hasMore,
    });

    return { totalDeleted, hasMore };
  },
});
```

**Step 3: Wire customer snapshot sync into `updateLead`**

```typescript
// Path: convex/leads/mutations.ts
import { syncCustomerSnapshot } from "../lib/syncCustomerSnapshot";

// Inside updateLead handler, after the searchText update (around line 69):

// Sync customer snapshot if lead identity changed (Finding 15)
await syncCustomerSnapshot(ctx, tenantId, leadId);
```

**Step 4: Sync `meetings.leadName` on lead update**

```typescript
// Path: convex/leads/mutations.ts
// Inside updateLead handler, after syncCustomerSnapshot:

// Sync meetings.leadName (Finding 20)
if (fullName !== undefined) {
  const newLeadName = updatedLead.fullName ?? updatedLead.email;
  const leadOpportunities = await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId),
    )
    .take(50);

  for (const opp of leadOpportunities) {
    const meetings = await ctx.db
      .query("meetings")
      .withIndex("by_opportunityId", (q) =>
        q.eq("opportunityId", opp._id),
      )
      .take(50);

    for (const meeting of meetings) {
      if (meeting.leadName !== newLeadName) {
        await ctx.db.patch(meeting._id, { leadName: newLeadName });
      }
    }
  }
}
```

**Step 5: Update `assignedCloserId` on meeting reassignment**

In `convex/pipeline/inviteeCreated.ts`, when an opportunity is reassigned during reschedule/relink, also update any existing meetings:

```typescript
// Path: convex/pipeline/inviteeCreated.ts
// After each opportunity patch that changes assignedCloserId (relink paths):

// Sync assignedCloserId to all meetings for this opportunity (Finding 12)
if (closerChanged && nextAssignedCloserId) {
  const existingMeetings = await ctx.db
    .query("meetings")
    .withIndex("by_opportunityId", (q) =>
      q.eq("opportunityId", reschedOpportunityId),
    )
    .take(50);

  for (const m of existingMeetings) {
    if (m.assignedCloserId !== nextAssignedCloserId) {
      await ctx.db.patch(m._id, {
        assignedCloserId: nextAssignedCloserId,
      });
    }
  }
}
```

**Step 6: Wire customer snapshot sync into lead merge**

```typescript
// Path: convex/leads/merge.ts
import { syncCustomerSnapshot } from "../lib/syncCustomerSnapshot";

// Inside executeMerge, after updating the target lead's socialHandles/searchText:

await syncCustomerSnapshot(ctx, tenantId, targetLeadId);
```

**Key implementation notes:**
- The webhook dedup fix requires the compound index `by_tenantId_and_eventType_and_calendlyEventUri` from Phase 1. If Phase 1 added a different index shape, adjust the field order in the `.withIndex()` call.
- The tenant cascade iterates all tables with `by_tenantId` index. Tables added in Phase 5 (`tenantCalendlyConnections`) should be added when Phase 5 deploys.
- Self-scheduling via `ctx.scheduler.runAfter(0, ...)` handles tables with more than `CLEANUP_BATCH_SIZE` rows without hitting transaction limits.
- `meetings.leadName` sync uses a bounded query chain (50 opps x 50 meetings max). For the current scale (1 tenant, ~200 leads), this is well within limits.
- The `assignedCloserId` sync on reassignment only runs when `closerChanged` is true, avoiding unnecessary writes.

**Files touched:**

| File | Action | Lines changed (est.) |
|------|--------|---------------------|
| `convex/webhooks/calendlyMutations.ts` | Modify | ~25 |
| `convex/admin/tenantsMutations.ts` | Modify | ~70 |
| `convex/leads/mutations.ts` | Modify | ~30 |
| `convex/leads/merge.ts` | Modify | ~5 |
| `convex/pipeline/inviteeCreated.ts` | Modify | ~15 |

---

### 3G -- Integration Testing

**Type:** Testing / verification
**Parallelizable:** No -- runs after 3B, 3C, 3D, 3E, 3F are all complete.

**What:** Verify all mutation paths end-to-end using `convex-test` + `vitest` tests. Confirm domain events are emitted, timestamps set, money model correct, soft-delete works, tenant cascade covers all tables, and `tsc --noEmit` passes.

**Why:** With ~25 emission sites across 17 functions and 10 files, manual verification is error-prone. Automated tests catch missing imports, type errors, and logic bugs before production deployment.

**Where:**
- `convex/tests/phase3.test.ts` (new, if test infrastructure exists)
- Manual verification via Convex dashboard otherwise

**How:**

**Step 1: Type check**

```bash
pnpm tsc --noEmit
```

All new helpers, modified mutations, and the schema must compile cleanly.

**Step 2: Verify domain events via Convex dashboard**

For each major code path, trigger the action and verify the `domainEvents` table contains the expected record:

| Action | Expected event(s) in `domainEvents` |
|--------|-------------------------------------|
| Start a meeting | `opportunity.status_changed` (scheduled -> in_progress), `meeting.started` |
| Mark as lost | `opportunity.marked_lost` (in_progress -> lost) |
| Mark no-show | `meeting.no_show`, `opportunity.status_changed` |
| Create reschedule link | `opportunity.status_changed` (no_show -> reschedule_link_sent) |
| Log payment | `payment.recorded`, `opportunity.status_changed` (in_progress -> payment_received) |
| Create follow-up | `followUp.created`, `opportunity.status_changed` |
| Pipeline: new booking | `opportunity.created`, `meeting.created` |
| Pipeline: cancellation | `meeting.canceled`, `opportunity.status_changed` |
| Customer conversion | `customer.converted`, `lead.status_changed` |
| Lead merge | `lead.merged` |
| Remove user (soft-delete) | `user.deactivated` |
| Change user role | `user.role_changed` |

**Step 3: Verify lifecycle timestamps**

For each status-changing action, check the corresponding timestamp field is set:

| Action | Field to verify |
|--------|----------------|
| `markAsLost` | `opportunities.lostAt` is set, `opportunities.lostByUserId` is set |
| Pipeline cancellation | `meetings.canceledAt` is set, `opportunities.canceledAt` is set |
| `logPayment` | `opportunities.paymentReceivedAt` is set |
| `markNoShow` | `meetings.noShowMarkedByUserId` is set |

**Step 4: Verify money model**

1. Log a payment with `amount: 149.99`, `currency: "usd"`.
2. Verify `paymentRecords.amountMinor === 14999`.
3. Verify `paymentRecords.currency === "USD"`.
4. Verify linked customer's `totalPaidMinor` increased by 14999.
5. Verify `tenantStats.totalRevenueMinor` increased by 14999.

**Step 5: Verify soft-delete**

1. Attempt to remove a user with active opportunities -- should throw `ConvexError`.
2. Remove a user with no active opportunities -- should set `isActive: false` and `deletedAt`.
3. Attempt to call a mutation as the soft-deleted user -- should be rejected by `requireTenantUser`.

**Step 6: Verify webhook dedup**

1. Send the same webhook event twice (same `tenantId`, `eventType`, `calendlyEventUri`).
2. Verify only one `rawWebhookEvents` record is created.
3. Verify the second call returns `null`.

**Step 7: Verify tenant cascade**

1. Call `deleteTenantRuntimeDataBatch` for a test tenant.
2. Verify all 19 tenant-scoped tables are empty for that tenant.
3. If data exceeds batch size, verify self-scheduling continues until complete.

**Key implementation notes:**
- If `convex-test` is set up, write tests in `convex/tests/phase3.test.ts` following the test pattern in `convex/_generated/ai/guidelines.md`.
- If no test infrastructure exists, manual verification via the Convex dashboard is acceptable for this single-tenant codebase. Document results in a checklist.
- Run `pnpm tsc --noEmit` as the final gate before marking Phase 3 complete.

**Files touched:**

| File | Action | Lines changed (est.) |
|------|--------|---------------------|
| `convex/tests/phase3.test.ts` | New (optional) | ~200 |

---

## Phase Summary -- All Files

| File | Subphase | Action |
|------|----------|--------|
| `convex/lib/domainEvents.ts` | 3A | New |
| `convex/lib/tenantStatsHelper.ts` | 3A | New |
| `convex/lib/formatMoney.ts` | 3A | New |
| `convex/lib/syncCustomerSnapshot.ts` | 3A | New |
| `convex/closer/meetingActions.ts` | 3B, 3C | Modify |
| `convex/closer/noShowActions.ts` | 3B | Modify |
| `convex/closer/payments.ts` | 3B, 3C | Modify |
| `convex/closer/followUpMutations.ts` | 3B | Modify |
| `convex/pipeline/inviteeCreated.ts` | 3B, 3C, 3E, 3F | Modify |
| `convex/pipeline/inviteeCanceled.ts` | 3B | Modify |
| `convex/pipeline/inviteeNoShow.ts` | 3B | Modify |
| `convex/customers/conversion.ts` | 3B, 3C | Modify |
| `convex/leads/merge.ts` | 3B, 3C, 3F | Modify |
| `convex/leads/mutations.ts` | 3F | Modify |
| `convex/workos/userMutations.ts` | 3D | Modify |
| `convex/requireTenantUser.ts` | 3D | Modify |
| `convex/webhooks/calendlyMutations.ts` | 3F | Modify |
| `convex/admin/tenantsMutations.ts` | 3F | Modify |
| `convex/tests/phase3.test.ts` | 3G | New (optional) |
