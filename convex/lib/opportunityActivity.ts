import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";
import { rebuildQualificationRowsForOpportunity } from "../operations/projections";
import { replaceOpportunityAggregate } from "../reporting/writeHooks";
import { upsertOpportunitySearchProjection } from "./opportunitySearch";
import { emitDomainEvent, type DomainEventSource } from "./domainEvents";
import { type OpportunityStatus, validateTransition } from "./statusTransitions";
import {
  isActiveOpportunityStatus,
  updateTenantStats,
} from "./tenantStatsHelper";

type ActivityShape = Pick<
  Doc<"opportunities">,
  "paymentReceivedAt" | "lostAt" | "latestMeetingAt" | "updatedAt" | "createdAt"
>;

export function computeLatestActivityAt(opportunity: ActivityShape): number {
  return Math.max(
    opportunity.paymentReceivedAt ?? 0,
    opportunity.lostAt ?? 0,
    opportunity.latestMeetingAt ?? 0,
    opportunity.updatedAt,
    opportunity.createdAt,
  );
}

/** Every opportunity field except identity and status. */
export type OpportunityFieldsPatch = Partial<
  Omit<Doc<"opportunities">, "_id" | "_creationTime" | "tenantId" | "status">
>;

// Inputs to the sort keys and eligibility of the status aggregate and the
// Slack qualification aggregates (reporting/aggregates.ts). The aggregate
// rewrites its entry on every replace, so replace only when one changes.
const AGGREGATE_KEY_FIELDS = [
  "status",
  "assignedCloserId",
  "createdAt",
  "source",
  "qualifiedBy",
] as const;

// Fields copied into operationsQualificationRows (operations/projections.ts).
const QUALIFICATION_ROW_FIELDS = [
  "status",
  "leadId",
  "assignedCloserId",
  "firstBookingProgramId",
  "firstBookingProgramName",
  "firstBookingProgramMappingStatus",
  "soldProgramId",
  "soldProgramName",
  "firstBookedAt",
  "firstMeetingId",
  "firstMeetingAt",
] as const;

function changesAny(
  before: Doc<"opportunities">,
  patch: Partial<Doc<"opportunities">>,
  fields: readonly (keyof Doc<"opportunities">)[],
): boolean {
  return fields.some(
    (field) =>
      field in patch &&
      JSON.stringify(patch[field]) !== JSON.stringify(before[field]),
  );
}

async function getOpportunityOrThrow(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<Doc<"opportunities">> {
  const opportunity = await ctx.db.get("opportunities", opportunityId);
  if (!opportunity) {
    throw new Error("Opportunity not found");
  }
  return opportunity;
}

// The only write of an opportunity's status. Keeps the aggregates and every
// projection that copies opportunity fields in sync with the patch.
async function writeOpportunity(
  ctx: MutationCtx,
  before: Doc<"opportunities">,
  patch: Partial<Doc<"opportunities">>,
): Promise<Doc<"opportunities">> {
  const updatedAt = patch.updatedAt ?? Date.now();
  const nextShape = { ...before, ...patch, updatedAt };
  await ctx.db.patch("opportunities", before._id, {
    ...patch,
    updatedAt,
    // A caller can keep the activity time, for a write nobody did, such as
    // a system expiry.
    latestActivityAt: patch.latestActivityAt ?? computeLatestActivityAt(nextShape),
  });

  let after: Doc<"opportunities">;
  if (changesAny(before, patch, AGGREGATE_KEY_FIELDS)) {
    // Also rebuilds both search rows, and mirrors a new status onto the
    // opportunity's meetings.
    after = await replaceOpportunityAggregate(ctx, before, before._id);
  } else {
    after = await getOpportunityOrThrow(ctx, before._id);
    // Every write moves latestActivityAt, which the search row sorts by.
    await upsertOpportunitySearchProjection(ctx, before._id);
    await rebuildLeadCustomerSearchRow(ctx, after.tenantId, after.leadId);
  }
  if (after.leadId !== before.leadId) {
    await rebuildLeadCustomerSearchRow(ctx, before.tenantId, before.leadId);
  }
  if (changesAny(before, patch, QUALIFICATION_ROW_FIELDS)) {
    await rebuildQualificationRowsForOpportunity(ctx, before._id);
  }
  return after;
}

/**
 * Patch an opportunity's fields, other than status, and keep its aggregates
 * and projections in sync. Status changes go through `transitionOpportunity`.
 */
export async function patchOpportunityLifecycle(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  patch: OpportunityFieldsPatch,
): Promise<Doc<"opportunities">> {
  // Runtime guard for callers that build the patch outside the type system.
  if ("status" in patch) {
    throw new Error("Use transitionOpportunity to change an opportunity's status");
  }
  const before = await getOpportunityOrThrow(ctx, opportunityId);
  return await writeOpportunity(ctx, before, patch);
}

/**
 * Moves the state machine in `statusTransitions.ts` does not allow, permitted
 * only for the caller that names them. Keep this list short: each entry is a
 * place where the status means something the state machine can't express.
 */
const TRANSITION_EXCEPTIONS = {
  // Calendly reports what happened to a booking, in whatever order it
  // happened: a cancellation can follow a no-show mark, and the reverse.
  calendly_webhook: {
    no_show: ["canceled"],
    canceled: ["no_show"],
  },
  // Voiding a side deal's payment closes the deal as lost.
  payment_voided: {
    payment_received: ["lost"],
  },
  // A booking that happened inside the Slack join window but was processed
  // after the stale expiry closed the deal (a retried blocked delivery)
  // reopens it. See wasStaleExpiredAfter in pipeline/slackJoinLookup.ts.
  slack_stale_rejoin: {
    lost: ["scheduled"],
  },
} satisfies Record<
  string,
  Partial<Record<OpportunityStatus, OpportunityStatus[]>>
>;

export type OpportunityTransitionException = keyof typeof TRANSITION_EXCEPTIONS;

export type OpportunityTransition = {
  to: OpportunityStatus;
  /** Fields that change with the status, such as `lostAt` or `noShowAt`. */
  fields?: OpportunityFieldsPatch;
  source: DomainEventSource;
  actorUserId?: Id<"users">;
  /** Defaults to `opportunity.status_changed`. */
  eventType?: "opportunity.status_changed" | "opportunity.marked_lost";
  reason?: string;
  metadata?: Record<string, unknown>;
  occurredAt?: number;
  exception?: OpportunityTransitionException;
};

/** Whether the named exception, on its own, allows the move. */
export function exceptionAllows(
  exception: OpportunityTransitionException,
  from: OpportunityStatus,
  to: OpportunityStatus,
): boolean {
  const allowed: Partial<Record<OpportunityStatus, readonly OpportunityStatus[]>> =
    TRANSITION_EXCEPTIONS[exception];
  return allowed[from]?.includes(to) ?? false;
}

function isAllowedTransition(
  from: OpportunityStatus,
  to: OpportunityStatus,
  exception: OpportunityTransitionException | undefined,
): boolean {
  if (validateTransition(from, to)) {
    return true;
  }
  if (!exception) {
    return false;
  }
  return exceptionAllows(exception, from, to);
}

// Mirrors how seedTenantStatsInternal counts: active, won and lost are pure
// functions of status.
function statusStatsDelta(from: OpportunityStatus, to: OpportunityStatus) {
  return {
    activeOpportunities:
      Number(isActiveOpportunityStatus(to)) -
      Number(isActiveOpportunityStatus(from)),
    wonDeals: Number(to === "payment_received") - Number(from === "payment_received"),
    lostDeals: Number(to === "lost") - Number(from === "lost"),
  };
}

/**
 * The one way to change an opportunity's status. It checks the move against
 * the state machine, writes the status with `fields`, and owns everything a
 * status change implies: the reporting aggregates, the search and
 * qualification projections, the meeting status mirror, the tenant counters
 * for active, won and lost deals, and the domain event.
 *
 * Callers still validate first when they want a user-facing message; this
 * throws on a move the state machine forbids, including a move to the current
 * status.
 */
export async function transitionOpportunity(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  transition: OpportunityTransition,
): Promise<Doc<"opportunities">> {
  const before = await getOpportunityOrThrow(ctx, opportunityId);
  const from = before.status;
  const { to } = transition;
  if (!isAllowedTransition(from, to, transition.exception)) {
    throw new Error(`Cannot transition opportunity from "${from}" to "${to}"`);
  }

  const after = await writeOpportunity(ctx, before, {
    ...transition.fields,
    status: to,
  });
  const statsDelta = statusStatsDelta(from, to);
  // tenantStats is one contended document per tenant; skip no-op writes.
  if (Object.values(statsDelta).some((value) => value !== 0)) {
    await updateTenantStats(ctx, before.tenantId, statsDelta);
  }
  await emitDomainEvent(ctx, {
    tenantId: before.tenantId,
    entityType: "opportunity",
    entityId: opportunityId,
    eventType: transition.eventType ?? "opportunity.status_changed",
    source: transition.source,
    actorUserId: transition.actorUserId,
    fromStatus: from,
    toStatus: to,
    reason: transition.reason,
    metadata: transition.metadata,
    occurredAt: transition.occurredAt,
  });
  return after;
}
