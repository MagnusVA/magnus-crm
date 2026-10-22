import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isSideDeal } from "../lib/sideDeals";
import {
  isMissedMeetingLoss,
  loadPendingRescheduleLink,
  type DealStateFields,
} from "./dealState";
import { dealPositionLabel, systemLossOf } from "./stageLabels";
import {
  DEAL_STAGE_CONFIG,
  dealPosition,
  dealStageOf,
  isAllowedStageOutcome,
  type DealStage,
} from "./stages";

// Where each action on a deal is allowed, read from the stage, the outcome,
// the loss and the tasks (docs/plans/phase-5-deal-status.md §4.6, §6.4,
// §6.8 to §6.10). Each predicate answers as the status check it replaced did
// on every deal: `scheduled` is Booked, or Call held for a side deal;
// `follow_up_scheduled` and `reschedule_link_sent` are Follow-up without and
// with a pending reschedule link; `canceled` and `no_show` are Closed lost
// by a missed meeting; `payment_received` is Closed won. The transitions
// still take a status until PR 8.

/** The tasks a guard reads: whether the deal has a pending reschedule link (§4.5). */
export type DealTasks = { hasPendingRescheduleLink: boolean };

/** The deal's tasks, with one indexed read. */
export async function loadDealTasks(
  ctx: QueryCtx | MutationCtx,
  dealId: Id<"opportunities">,
): Promise<DealTasks> {
  const { count } = await loadPendingRescheduleLink(ctx, dealId);
  return { hasPendingRescheduleLink: count > 0 };
}

function isOpenAt(deal: DealStateFields, stages: readonly DealStage[]): boolean {
  const { stage, outcome } = dealStageOf(deal);
  return outcome === "open" && stages.includes(stage);
}

// ─── What the deal is ─────────────────────────────────────────────────

/** Not Closed: today's active statuses. A missed meeting closes the deal (D16). */
export function isOpenDeal(deal: DealStateFields): boolean {
  return dealStageOf(deal).outcome === "open";
}

/** Qualified in Slack and not booked yet (`qualified_pending`). */
export function isQualifiedDeal(deal: DealStateFields): boolean {
  return isOpenAt(deal, ["qualified"]);
}

/** A Slack deal at Qualified, the one a booking can join and the expiry closes. */
export function isQualifiedSlackDeal(deal: DealStateFields): boolean {
  return deal.source === "slack_qualified" && isQualifiedDeal(deal);
}

/**
 * The call is booked, or held for a side deal, and nothing came of it yet
 * (`scheduled`): Booked or Call held.
 */
export function awaitsCallResult(deal: DealStateFields): boolean {
  return isOpenAt(deal, ["booked", "call_held"]);
}

/**
 * At Follow-up with a reminder, an ordinary scheduling link or no next step,
 * but no pending reschedule link (`follow_up_scheduled`).
 */
export function isFollowUpWithoutRescheduleLink(deal: DealStateFields, tasks: DealTasks): boolean {
  return isOpenAt(deal, ["follow_up"]) && !tasks.hasPendingRescheduleLink;
}

/** A side deal at Call held, waiting for a payment, a loss or its deletion. */
export function isSideDealAtCallHeld(deal: DealStateFields): boolean {
  return isSideDeal(deal) && isOpenAt(deal, ["call_held"]);
}

/** Closed won (`payment_received`). */
export function isWonDeal(deal: DealStateFields): boolean {
  const { stage, outcome } = dealStageOf(deal);
  return stage === "closed" && outcome === "won";
}

// ─── What can happen to it ────────────────────────────────────────────

/** The meeting outcome bar's deal check (lib/outcomeEligibility.ts). */
export function canRecordMeetingOutcome(deal: DealStateFields): boolean {
  return awaitsCallResult(deal);
}

/** A payment without a meeting outcome: a reminder's or a side deal's. */
export function canTakePayment(deal: DealStateFields, tasks: DealTasks): boolean {
  return awaitsCallResult(deal) || isFollowUpWithoutRescheduleLink(deal, tasks);
}

/**
 * A person marks the deal lost: Qualified, Booked, Call held, or Follow-up
 * with no reschedule link. A deal waiting on its reschedule link closes
 * only through a booking.
 */
export function canMarkLost(deal: DealStateFields, tasks: DealTasks): boolean {
  return isQualifiedDeal(deal) || canTakePayment(deal, tasks);
}

/** A follow-up or reminder: from Booked or Call held, or from a missed meeting (§4.3). */
export function canStartFollowUp(deal: DealStateFields): boolean {
  return awaitsCallResult(deal) || isMissedMeetingLoss(deal) !== null;
}

/** A reschedule link: only on a deal a no-show closed. */
export function canSendRescheduleLink(deal: DealStateFields): boolean {
  return isMissedMeetingLoss(deal) === "no_show";
}

/** An admin cancels a closer's meeting for their unavailability: the deal closes only from Booked or Call held. */
export function canCancelForUnavailability(deal: DealStateFields): boolean {
  return awaitsCallResult(deal);
}

/**
 * Whether an earlier deal of the person stops a new Slack qualification:
 * any open deal, except a Qualified one from before the join cutoff, which
 * no booking can join and the expiry closes.
 */
export function blocksNewQualification(
  deal: DealStateFields & { createdAt: number },
  joinCutoff: number,
): boolean {
  return isOpenDeal(deal) && !(isQualifiedDeal(deal) && deal.createdAt <= joinCutoff);
}

/** The stages at which a closer's deal stops their removal. */
export const USER_REMOVAL_BLOCKING_STAGES = [
  "booked",
  "call_held",
  "follow_up",
] as const satisfies readonly DealStage[];

/** A closer with this deal can't be removed. */
export function blocksUserRemoval(deal: DealStateFields): boolean {
  return isOpenAt(deal, USER_REMOVAL_BLOCKING_STAGES);
}

/** Whether the user has a deal that stops their removal: one indexed read per stage. */
export async function hasDealBlockingUserRemoval(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
  userId: Id<"users">,
): Promise<boolean> {
  for (const stage of USER_REMOVAL_BLOCKING_STAGES) {
    const deal = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_assignedCloserId_stage_outcome_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("assignedCloserId", userId).eq("stage", stage).eq("outcome", "open"),
      )
      .first();
    if (deal) {
      return true;
    }
  }
  return false;
}

/**
 * What an error says the deal is: its badge's words, such as "Booked" or
 * "Lost: no-show". A pair the stage doesn't allow, which assertDealStages
 * reports, is named instead of failing the error.
 */
export function describeDealState(deal: DealStateFields): string {
  const { stage, outcome } = dealStageOf(deal);
  if (!isAllowedStageOutcome(stage, outcome)) {
    return `${DEAL_STAGE_CONFIG[stage].label} (${outcome})`;
  }
  return dealPositionLabel(dealPosition(stage, outcome), systemLossOf(deal));
}
