import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";
import {
  isMissedMeetingLoss,
  legacyStatus,
  loadPendingRescheduleLink,
  type MissedMeeting,
} from "../opportunities/dealState";
import {
  assertStageMove,
  dealStageOf,
  targetStageAndOutcome,
  type DealTarget,
  type OpportunityStatus,
  type StageTransitionException,
} from "../opportunities/stages";
import { rebuildQualificationRowsForOpportunity } from "../operations/projections";
import { replaceOpportunityAggregate } from "../reporting/writeHooks";
import { upsertOpportunitySearchProjection } from "./opportunitySearch";
import { emitDomainEvent, type DomainEventSource } from "./domainEvents";
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

/**
 * Every opportunity field except identity, the stage and outcome, which only
 * the stage machine moves, and the status, which follows them.
 */
export type OpportunityFieldsPatch = Partial<
  Omit<
    Doc<"opportunities">,
    "_id" | "_creationTime" | "tenantId" | "status" | "stage" | "outcome"
  >
>;

// Only transitionOpportunity writes the stage and outcome; the status follows
// them and the deal's tasks (writeDealAndStatus).
const TRANSITION_ONLY_FIELDS = ["status", "stage", "outcome"] as const;

// The fields besides the stage and outcome that `legacyStatus` reads: a loss
// the system wrote is a missed meeting's status, a person's is `lost`.
const LEGACY_STATUS_FIELDS = ["lostReason", "lostByUserId"] as const;

// Inputs to the sort keys and eligibility of the status and stage aggregates
// and the Slack qualification aggregates (reporting/aggregates.ts). The
// aggregate rewrites its entry on every replace, so replace only when one
// changes.
const AGGREGATE_KEY_FIELDS = [
  "status",
  "stage",
  "outcome",
  "assignedCloserId",
  "createdAt",
  "source",
  "qualifiedBy",
] as const;

// Fields copied into operationsQualificationRows (operations/projections.ts).
const QUALIFICATION_ROW_FIELDS = [
  "status",
  "stage",
  "outcome",
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

// Every opportunity write ends here. Keeps the aggregates and every
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

// Mirrors how seedTenantStatsInternal counts: active, won and lost are pure
// functions of status. A deal without one (after PR 9's clear) counts in
// none of them.
function statusStatsDelta(from: OpportunityStatus | undefined, to: OpportunityStatus) {
  return {
    activeOpportunities:
      Number(isActiveOpportunityStatus(to)) -
      Number(from !== undefined && isActiveOpportunityStatus(from)),
    wonDeals: Number(to === "payment_received") - Number(from === "payment_received"),
    lostDeals: Number(to === "lost") - Number(from === "lost"),
  };
}

/**
 * Writes `patch` with the status PR 7 would have written for the deal it
 * leaves: `legacyStatus` of its stage, outcome, loss and pending reschedule
 * link (docs/plans/phase-5-deal-status.md §9, §12), and moves the tenant
 * counters from the old status to it. `opportunityByStatus` follows through
 * the aggregate rewrite, on its IfExists methods.
 */
async function writeDealAndStatus(
  ctx: MutationCtx,
  before: Doc<"opportunities">,
  patch: Partial<Doc<"opportunities">>,
): Promise<Doc<"opportunities">> {
  const { count } = await loadPendingRescheduleLink(ctx, before._id);
  const status = legacyStatus({ ...before, ...patch }, { hasPendingRescheduleLink: count > 0 });
  const after = await writeOpportunity(
    ctx,
    before,
    status === before.status ? patch : { ...patch, status },
  );
  const statsDelta = statusStatsDelta(before.status, status);
  // tenantStats is one contended document per tenant; skip no-op writes.
  if (Object.values(statsDelta).some((value) => value !== 0)) {
    await updateTenantStats(ctx, before.tenantId, statsDelta);
  }
  return after;
}

/**
 * Patch an opportunity's fields, other than the stage and outcome, and keep
 * its aggregates and projections in sync. A patch to the loss, such as
 * Calendly turning a no-show into a cancellation, rewrites the status with
 * it. Stage changes go through `transitionOpportunity`.
 */
export async function patchOpportunityLifecycle(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  patch: OpportunityFieldsPatch,
): Promise<Doc<"opportunities">> {
  // Runtime guard for callers that build the patch outside the type system.
  const field = TRANSITION_ONLY_FIELDS.find((name) => name in patch);
  if (field) {
    throw new Error(`Use transitionOpportunity to change an opportunity's ${field}`);
  }
  const before = await getOpportunityOrThrow(ctx, opportunityId);
  if (changesAny(before, patch, LEGACY_STATUS_FIELDS)) {
    return await writeDealAndStatus(ctx, before, patch);
  }
  return await writeOpportunity(ctx, before, patch);
}

/**
 * Rewrites the deal's status after a change that moves `legacyStatus`
 * without a stage move: a reschedule link created, booked or expired on a
 * Follow-up deal. Keeps `updatedAt` and `latestActivityAt`, since the write
 * that changed the task is the one somebody did. A no-op when the status
 * already agrees.
 */
export async function syncLegacyStatus(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<Doc<"opportunities">> {
  const before = await getOpportunityOrThrow(ctx, opportunityId);
  const { count } = await loadPendingRescheduleLink(ctx, opportunityId);
  if (legacyStatus(before, { hasPendingRescheduleLink: count > 0 }) === before.status) {
    return before;
  }
  return await writeDealAndStatus(ctx, before, {
    updatedAt: before.updatedAt,
    latestActivityAt: before.latestActivityAt ?? computeLatestActivityAt(before),
  });
}

export type OpportunityTransition = {
  /** The stage the deal moves to, with its outcome when it closes. */
  to: DealTarget;
  /**
   * Fields that change with the stage, such as `lostReason`, `lostAt` or
   * `noShowAt`. A loss the system writes (a missed meeting, the Slack
   * expiry) names no `lostByUserId`.
   */
  fields?: OpportunityFieldsPatch;
  source: DomainEventSource;
  actorUserId?: Id<"users">;
  /** The event's reason. A loss defaults to its `lostReason`. */
  reason?: string;
  metadata?: Record<string, unknown>;
  occurredAt?: number;
  /** A move the stage machine allows only for its named caller (stages.ts). */
  exception?: StageTransitionException;
};

/**
 * The one way to change a deal's stage. It checks the move against the stage
 * machine in `convex/opportunities/stages.ts`, writes the stage, the outcome
 * and `fields`, and owns everything a stage change implies: the status, as
 * `legacyStatus` of the deal it leaves, the reporting aggregates, the search
 * and qualification projections, the meeting status mirror, the tenant
 * counters for active, won and lost deals, and the domain event.
 *
 * A move to Closed lost writes `lostAt` (the caller's, else the move's
 * time); a move out of it to an open stage clears the loss. Throws on a move
 * the stage machine forbids, including a move to where the deal is.
 */
export async function transitionOpportunity(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  transition: OpportunityTransition,
): Promise<Doc<"opportunities">> {
  const before = await getOpportunityOrThrow(ctx, opportunityId);
  assertStageMove(before, transition.to, transition.exception);
  const from = dealStageOf(before);
  const to = targetStageAndOutcome(transition.to);
  const isLoss = to.outcome === "lost";
  const loss: OpportunityFieldsPatch = isLoss
    ? { lostAt: transition.fields?.lostAt ?? transition.occurredAt ?? Date.now() }
    : from.outcome === "lost"
      ? { lostReason: undefined, lostAt: undefined, lostByUserId: undefined }
      : {};
  const after = await writeDealAndStatus(ctx, before, {
    ...transition.fields,
    ...loss,
    stage: to.stage,
    outcome: to.outcome,
  });
  await emitDomainEvent(ctx, {
    tenantId: before.tenantId,
    entityType: "opportunity",
    entityId: opportunityId,
    eventType: isLoss ? "opportunity.marked_lost" : "opportunity.stage_changed",
    source: transition.source,
    actorUserId: transition.actorUserId,
    // From PR 8 a deal event holds stages, with the outcomes in its metadata
    // (docs/plans/phase-5-deal-status.md §4.7).
    fromStatus: from.stage,
    toStatus: to.stage,
    reason: transition.reason ?? (isLoss ? after.lostReason : undefined),
    metadata: { ...transition.metadata, fromOutcome: from.outcome, toOutcome: to.outcome },
    occurredAt: transition.occurredAt,
  });
  return after;
}

/**
 * The loss a missed meeting writes on its deal (§4.3): the reason
 * `no_show` or `canceled`, at the time of the no-show or cancellation, and
 * no person, since the system wrote it.
 */
export function missedMeetingLoss(
  reason: MissedMeeting,
  at: number,
): Pick<OpportunityFieldsPatch, "lostReason" | "lostAt" | "lostByUserId"> {
  return { lostReason: reason, lostAt: at, lostByUserId: undefined };
}

/**
 * Calendly turns the no-show that closed a deal into a cancellation, or the
 * reverse (§4.4): the deal stays Closed lost and its reason changes, with
 * `fields` (the times Calendly sent, and `updatedAt`, which decides which
 * late bookings are held for review). The status follows the reason, and a
 * deal event records the change, closed to closed, so the booking history
 * (pipeline/bookingHistory.ts) reads a chain that ends where the deal is.
 */
export async function changeMissedMeetingLoss(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  change: {
    reason: MissedMeeting;
    at: number;
    fields: OpportunityFieldsPatch;
    source: DomainEventSource;
    occurredAt?: number;
  },
): Promise<Doc<"opportunities">> {
  const before = await getOpportunityOrThrow(ctx, opportunityId);
  const missed = isMissedMeetingLoss(before);
  if (!missed || missed === change.reason) {
    throw new Error(
      `Cannot change a missed meeting's loss to "${change.reason}" on a deal closed with "${missed ?? "no missed meeting"}"`,
    );
  }
  const after = await patchOpportunityLifecycle(ctx, opportunityId, {
    ...change.fields,
    ...missedMeetingLoss(change.reason, change.at),
  });
  await emitDomainEvent(ctx, {
    tenantId: after.tenantId,
    entityType: "opportunity",
    entityId: opportunityId,
    eventType: "opportunity.stage_changed",
    source: change.source,
    fromStatus: "closed",
    toStatus: "closed",
    reason: change.reason,
    metadata: { fromOutcome: "lost", toOutcome: "lost" },
    occurredAt: change.occurredAt,
  });
  return after;
}
