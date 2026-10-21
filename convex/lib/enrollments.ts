import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { listPersonEnrollments } from "../enrollments/read";
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";
import { emitDomainEvent, type DomainEventSource } from "./domainEvents";
import { countsAsLead } from "./leadLifecycle";
import { validateLeadTransition } from "./statusTransitions";
import { updateTenantStats } from "./tenantStatsHelper";

// A person's enrollments come from their payments, and this module is the one
// place that derives and writes them (docs/plans/phase-4-customers.md §4.1).
// Every payment write path and the assert call it. A person with an
// enrollment is a customer: the sync also keeps `leads.status` and the
// customer counters in step (§4.2, §4.3).

// The largest person in production has 19 deals. Past these limits the
// derivation would read part of the payments, so it throws instead.
export const ENROLLMENT_DEAL_LIMIT = 100;
export const ENROLLMENT_PAYMENTS_PER_DEAL_LIMIT = 50;

/** What one program's earliest counting payment says its enrollment holds. */
export type DerivedEnrollment = {
  programId: Id<"tenantPrograms">;
  opportunityId: Id<"opportunities">;
  enrolledAt: number;
  firstPaymentId: Id<"paymentRecords">;
};

type PaymentOrder = Pick<Doc<"paymentRecords">, "recordedAt" | "_creationTime">;

/** Earliest first: by `recordedAt`, then creation order. */
function byPaymentOrder(left: PaymentOrder, right: PaymentOrder) {
  return left.recordedAt - right.recordedAt || left._creationTime - right._creationTime;
}

function byEnrollmentOrder(left: Doc<"enrollments">, right: Doc<"enrollments">) {
  return left.enrolledAt - right.enrolledAt || left._creationTime - right._creationTime;
}

/** Whether a payment counts toward an enrollment: every status but disputed. */
export function paymentCounts(payment: Pick<Doc<"paymentRecords">, "status">) {
  return payment.status !== "disputed";
}

/** The earliest of these payments that counts, by `recordedAt`, then creation order. */
export function earliestCountingPayment<T extends PaymentOrder & Pick<Doc<"paymentRecords">, "status">>(
  payments: readonly T[],
): T | undefined {
  return payments.filter(paymentCounts).sort(byPaymentOrder)[0];
}

/** Every payment on one deal; throws past the limit rather than return part. */
export async function readDealPayments(
  ctx: QueryCtx | MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<Doc<"paymentRecords">[]> {
  const payments = await ctx.db
    .query("paymentRecords")
    .withIndex("by_opportunityId_and_recordedAt", (q) => q.eq("opportunityId", opportunityId))
    .take(ENROLLMENT_PAYMENTS_PER_DEAL_LIMIT + 1);
  if (payments.length > ENROLLMENT_PAYMENTS_PER_DEAL_LIMIT) {
    throw new Error(
      `Opportunity ${opportunityId} has more than ${ENROLLMENT_PAYMENTS_PER_DEAL_LIMIT} payments; its person's enrollments can't be derived from part of them`,
    );
  }
  return payments;
}

/**
 * The enrollments a person's payments call for: for each program, the
 * earliest payment on any of the person's deals that isn't disputed, by
 * `recordedAt`, then creation order. Oldest first.
 *
 * A payment with no deal doesn't count. Only the retired
 * `recordCustomerPayment` wrote one, and it never ran in production.
 */
export async function derivePersonEnrollments(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
): Promise<DerivedEnrollment[]> {
  const deals = await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", tenantId).eq("leadId", leadId))
    .take(ENROLLMENT_DEAL_LIMIT + 1);
  if (deals.length > ENROLLMENT_DEAL_LIMIT) {
    throw new Error(
      `Person ${leadId} has more than ${ENROLLMENT_DEAL_LIMIT} deals; their enrollments can't be derived from part of them`,
    );
  }

  const firstByProgram = new Map<Id<"tenantPrograms">, Doc<"paymentRecords"> & { opportunityId: Id<"opportunities"> }>();
  for (const deal of deals) {
    for (const payment of await readDealPayments(ctx, deal._id)) {
      if (payment.tenantId !== tenantId || !paymentCounts(payment)) {
        continue;
      }
      const current = firstByProgram.get(payment.programId);
      if (!current || byPaymentOrder(payment, current) < 0) {
        firstByProgram.set(payment.programId, { ...payment, opportunityId: deal._id });
      }
    }
  }

  return [...firstByProgram.values()].sort(byPaymentOrder).map((payment) => ({
    programId: payment.programId,
    opportunityId: payment.opportunityId,
    enrolledAt: payment.recordedAt,
    firstPaymentId: payment._id,
  }));
}

export type EnrollmentChange = { before: Doc<"enrollments">; after: Doc<"enrollments"> };

/** Why an enrollment was deleted. A merge deletes the source's copy of a program the target has (§4.7). */
export type EnrollmentRemovalReason = "no_payment" | "duplicate" | "merge";

export type EnrollmentSyncResult = {
  /** Inserted as `active`, one per program that had none. */
  created: Doc<"enrollments">[];
  /** Same program; the deal or time moved to its earliest counting payment. */
  updated: EnrollmentChange[];
  /** Moved to a program with no enrollment, keeping ID and status (D13). */
  repointed: EnrollmentChange[];
  removed: Array<{ enrollment: Doc<"enrollments">; reason: "no_payment" | "duplicate" }>;
  hadEnrollments: boolean;
  hasEnrollments: boolean;
};

/** Who caused a sync, for the events it emits. */
export type EnrollmentSyncActor = {
  source: DomainEventSource;
  /** Missing for a system write; may name a user whose row is gone. */
  actorUserId?: Id<"users">;
};

export type PersonEnrollmentSyncResult = EnrollmentSyncResult & {
  /**
   * How `leads.status` moved: `converted` when a person with an enrollment
   * was `active`, `reverted` when a person with none was `converted`.
   */
  leadStatusChange: "converted" | "reverted" | null;
};

/**
 * Pairs the enrollments left with no counting payment with the programs that
 * have one and no enrollment, which is what a billing program correction
 * leaves (D13). Each pair keeps the enrollment and moves it to the program.
 *
 * Pairing is deterministic. First an enrollment pairs with the program whose
 * earliest payment is the one it followed (same deal and time): that payment
 * changed program. The rest pair in order, oldest with oldest: enrollments by
 * `enrolledAt`, then creation; programs by their earliest payment.
 */
function pairRepoints(orphans: Doc<"enrollments">[], unmatched: DerivedEnrollment[]) {
  const restOrphans = [...orphans].sort(byEnrollmentOrder);
  const restPrograms: DerivedEnrollment[] = [];
  const pairs: Array<{ enrollment: Doc<"enrollments">; derived: DerivedEnrollment }> = [];
  for (const derived of unmatched) {
    const index = restOrphans.findIndex(
      (orphan) => orphan.opportunityId === derived.opportunityId && orphan.enrolledAt === derived.enrolledAt,
    );
    if (index === -1) {
      restPrograms.push(derived);
    } else {
      pairs.push({ enrollment: restOrphans[index], derived });
      restOrphans.splice(index, 1);
    }
  }
  const paired = Math.min(restOrphans.length, restPrograms.length);
  for (let index = 0; index < paired; index += 1) {
    pairs.push({ enrollment: restOrphans[index], derived: restPrograms[index] });
  }
  return { pairs, orphans: restOrphans.slice(paired), programs: restPrograms.slice(paired) };
}

/**
 * Writes the difference between a person's enrollments and what their
 * payments call for (§4.1), and nothing else.
 *
 * - A program with a counting payment and no enrollment gets one, `active`.
 * - An enrollment whose deal or time differs from its program's earliest
 *   counting payment moves to it, keeping its status.
 * - An enrollment whose program has no counting payment left is deleted,
 *   unless a program with no enrollment appeared at the same time: then it
 *   moves to that program (`pairRepoints`).
 * - Two enrollments for one program: the oldest stays, the others go.
 */
async function writeEnrollmentDifference(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
  now: number,
): Promise<EnrollmentSyncResult> {
  const derived = await derivePersonEnrollments(ctx, tenantId, leadId);
  const existing = await listPersonEnrollments(ctx, tenantId, leadId);
  const result: EnrollmentSyncResult = {
    created: [],
    updated: [],
    repointed: [],
    removed: [],
    hadEnrollments: existing.length > 0,
    hasEnrollments: derived.length > 0,
  };

  const kept = new Map<Id<"tenantPrograms">, Doc<"enrollments">>();
  for (const enrollment of [...existing].sort((left, right) => left._creationTime - right._creationTime)) {
    if (kept.has(enrollment.programId)) {
      await ctx.db.delete("enrollments", enrollment._id);
      result.removed.push({ enrollment, reason: "duplicate" });
    } else {
      kept.set(enrollment.programId, enrollment);
    }
  }

  const derivedByProgram = new Map(derived.map((entry) => [entry.programId, entry]));
  const orphans: Doc<"enrollments">[] = [];
  for (const enrollment of kept.values()) {
    const target = derivedByProgram.get(enrollment.programId);
    if (!target) {
      orphans.push(enrollment);
    } else if (target.opportunityId !== enrollment.opportunityId || target.enrolledAt !== enrollment.enrolledAt) {
      const patch = { opportunityId: target.opportunityId, enrolledAt: target.enrolledAt };
      await ctx.db.patch("enrollments", enrollment._id, patch);
      result.updated.push({ before: enrollment, after: { ...enrollment, ...patch } });
    }
  }

  const repoints = pairRepoints(
    orphans,
    derived.filter((entry) => !kept.has(entry.programId)),
  );
  for (const { enrollment, derived: target } of repoints.pairs) {
    const patch = {
      programId: target.programId,
      opportunityId: target.opportunityId,
      enrolledAt: target.enrolledAt,
    };
    await ctx.db.patch("enrollments", enrollment._id, patch);
    result.repointed.push({ before: enrollment, after: { ...enrollment, ...patch } });
  }
  for (const target of repoints.programs) {
    const enrollmentId = await ctx.db.insert("enrollments", {
      tenantId,
      leadId,
      programId: target.programId,
      opportunityId: target.opportunityId,
      enrolledAt: target.enrolledAt,
      status: "active",
      createdAt: now,
    });
    const created = await ctx.db.get("enrollments", enrollmentId);
    if (created) {
      result.created.push(created);
    }
  }
  for (const enrollment of repoints.orphans) {
    await ctx.db.delete("enrollments", enrollment._id);
    result.removed.push({ enrollment, reason: "no_payment" });
  }
  return result;
}

/**
 * The enrollment rows only, for migrations: no event, counter or lead
 * status (§10). It rebuilds the person's search row, which is a projection
 * of the rows it writes.
 */
export async function writePersonEnrollments(
  ctx: MutationCtx,
  args: { tenantId: Id<"tenants">; leadId: Id<"leads">; now?: number },
): Promise<EnrollmentSyncResult> {
  const result = await writeEnrollmentDifference(ctx, args.tenantId, args.leadId, args.now ?? Date.now());
  await rebuildLeadCustomerSearchRow(ctx, args.tenantId, args.leadId);
  return result;
}

/**
 * An `enrollment.*` event. Its metadata names the person, program and deal,
 * so the event finds the person after the enrollment is gone (§4.10). None
 * is a touch.
 */
export async function emitEnrollmentEvent(
  ctx: MutationCtx,
  enrollment: Doc<"enrollments">,
  event: EnrollmentSyncActor & {
    eventType: "enrollment.created" | "enrollment.removed" | "enrollment.status_changed";
    occurredAt: number;
    reason?: string;
    fromStatus?: string;
    toStatus?: string;
  },
): Promise<void> {
  await emitDomainEvent(ctx, {
    tenantId: enrollment.tenantId,
    entityType: "enrollment",
    entityId: enrollment._id,
    eventType: event.eventType,
    source: event.source,
    actorUserId: event.actorUserId,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    reason: event.reason,
    occurredAt: event.occurredAt,
    metadata: {
      leadId: enrollment.leadId,
      programId: enrollment.programId,
      opportunityId: enrollment.opportunityId,
    },
  });
}

/**
 * Keeps `leads.status` equal to whether the person has an enrollment. The
 * state comes from the lead, not from what the sync found before, so a
 * person left `converted` with no counting payment goes back too.
 */
async function syncLeadConversion(
  ctx: MutationCtx,
  args: { tenantId: Id<"tenants">; leadId: Id<"leads">; now: number; hasEnrollments: boolean } & EnrollmentSyncActor,
): Promise<PersonEnrollmentSyncResult["leadStatusChange"]> {
  const lead = await ctx.db.get("leads", args.leadId);
  // A merged person's deals and enrollments have moved to the target.
  if (!lead || lead.tenantId !== args.tenantId || lead.status === "merged") {
    return null;
  }
  const to = args.hasEnrollments ? "converted" : "active";
  if (lead.status === to) {
    return null;
  }
  if (!validateLeadTransition(lead.status, to)) {
    throw new Error(`Person ${lead._id} can't move from ${lead.status} to ${to}`);
  }
  await ctx.db.patch("leads", lead._id, { status: to, updatedAt: args.now });
  // `totalLeads` counts active people past Prospect (`countsAsLead`).
  await updateTenantStats(
    ctx,
    args.tenantId,
    args.hasEnrollments
      ? { totalCustomers: 1, totalLeads: countsAsLead(lead) ? -1 : 0 }
      : { totalCustomers: -1, totalLeads: countsAsLead({ ...lead, status: to }) ? 1 : 0 },
  );
  await emitDomainEvent(ctx, {
    tenantId: args.tenantId,
    entityType: "lead",
    entityId: lead._id,
    eventType: "lead.status_changed",
    source: args.source,
    actorUserId: args.actorUserId,
    fromStatus: lead.status,
    toStatus: to,
    reason: args.hasEnrollments ? "enrolled" : "no_enrollment",
    occurredAt: args.now,
  });
  return args.hasEnrollments ? "converted" : "reverted";
}

/**
 * Brings a person's enrollments, customer state and search row up to date
 * with their payments. Every live write that adds a payment, disputes one,
 * changes its program or time, or moves its deal to another person calls it
 * once, inside its own mutation, so a retried or concurrent write finds what
 * this one wrote (§4.8).
 *
 * After writing the enrollments (`writeEnrollmentDifference`), it emits
 * `enrollment.created` and `enrollment.removed` for each row it inserted or
 * deleted; moving one to another payment or program emits nothing. Then a
 * person with an enrollment who is `active` becomes `converted`, and one
 * with none who is `converted` goes back to `active`, with the customer and
 * lead counters and a `lead.status_changed` event (§4.2, §4.3). The
 * lifecycle stage is not its business: `recordPayment` and
 * `correctLeadLifecycle` move it.
 *
 * It rebuilds the search row on every call: an additional payment or an
 * amount correction changes the total without changing an enrollment.
 */
export async function syncPersonEnrollments(
  ctx: MutationCtx,
  args: { tenantId: Id<"tenants">; leadId: Id<"leads">; now?: number } & EnrollmentSyncActor,
): Promise<PersonEnrollmentSyncResult> {
  const { tenantId, leadId } = args;
  const now = args.now ?? Date.now();
  const actor = { source: args.source, actorUserId: args.actorUserId };
  const result = await writeEnrollmentDifference(ctx, tenantId, leadId, now);
  for (const { enrollment, reason } of result.removed) {
    await emitEnrollmentEvent(ctx, enrollment, { ...actor, eventType: "enrollment.removed", reason, occurredAt: now });
  }
  for (const enrollment of result.created) {
    await emitEnrollmentEvent(ctx, enrollment, { ...actor, eventType: "enrollment.created", occurredAt: now });
  }
  const leadStatusChange = await syncLeadConversion(ctx, {
    tenantId,
    leadId,
    now,
    hasEnrollments: result.hasEnrollments,
    ...actor,
  });
  await rebuildLeadCustomerSearchRow(ctx, tenantId, leadId);
  return { ...result, leadStatusChange };
}
