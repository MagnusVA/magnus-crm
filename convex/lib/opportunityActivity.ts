import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";
import { isMissedMeetingLoss, type MissedMeeting } from "../opportunities/dealState";
import {
  assertStageMove,
  dealStageOf,
  targetStageAndOutcome,
  type DealTarget,
  type StageTransitionException,
} from "../opportunities/stages";
import { rebuildQualificationRowsForOpportunity } from "../operations/projections";
import { replaceOpportunityAggregate } from "../reporting/writeHooks";
import { upsertOpportunitySearchProjection } from "./opportunitySearch";
import { emitDomainEvent, type DomainEventSource } from "./domainEvents";

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
 * the stage machine moves, and the status, which nothing writes from PR 9
 * (docs/plans/phase-5-deal-status.md §9).
 */
export type OpportunityFieldsPatch = Partial<
  Omit<
    Doc<"opportunities">,
    "_id" | "_creationTime" | "tenantId" | "status" | "stage" | "outcome"
  >
>;

// Only transitionOpportunity writes the stage and outcome, and nothing writes
// the status; the clear unsets it (migrations.ts, clearDealStatus).
const TRANSITION_ONLY_FIELDS = ["status", "stage", "outcome"] as const;

// Inputs to the sort keys and eligibility of the stage aggregate and the
// Slack qualification aggregates (reporting/aggregates.ts). The aggregate
// rewrites its entry on every replace, so replace only when one changes.
const AGGREGATE_KEY_FIELDS = [
  "stage",
  "outcome",
  "assignedCloserId",
  "createdAt",
  "source",
  "qualifiedBy",
] as const;

// Fields copied into operationsQualificationRows (operations/projections.ts).
const QUALIFICATION_ROW_FIELDS = [
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
    // Also rebuilds both search rows.
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
 * Patch an opportunity's fields, other than the stage and outcome, and keep
 * its aggregates and projections in sync. Stage changes go through
 * `transitionOpportunity`.
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
  return await writeOpportunity(ctx, before, patch);
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
 * and `fields`, and owns everything a stage change implies: the reporting
 * aggregates, the search and qualification projections, and the domain
 * event. It writes no status and no tenant counter (§9, D13), and asks for
 * no meeting projection, which carries no deal field.
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
  const after = await writeOpportunity(ctx, before, {
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
 * late bookings are held for review). A deal event records the change,
 * closed to closed, so the booking history
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
