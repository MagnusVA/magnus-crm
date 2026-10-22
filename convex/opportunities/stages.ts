import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";

// Where a deal is (CONTEXT.md, "Deal stage") and how it ended, defined once
// (docs/plans/phase-5-deal-status.md §4.1), with the stage machine every
// move goes through (§4.4). `opportunities.status` is gone; the old statuses
// below only read old events (§4.7).

export const DEAL_STAGES = [
  "qualified",
  "booked",
  "call_held",
  "follow_up",
  "closed",
] as const;

export type DealStage = (typeof DEAL_STAGES)[number];

export const DEAL_OUTCOMES = ["open", "won", "lost"] as const;

export type DealOutcome = (typeof DEAL_OUTCOMES)[number];

export const dealStageValidator = v.union(
  v.literal("qualified"),
  v.literal("booked"),
  v.literal("call_held"),
  v.literal("follow_up"),
  v.literal("closed"),
);

export const dealOutcomeValidator = v.union(
  v.literal("open"),
  v.literal("won"),
  v.literal("lost"),
);

// Each stage's label and the outcomes it allows: a deal is open until it is
// Closed, and a Closed deal is won or lost.
export const DEAL_STAGE_CONFIG: Record<
  DealStage,
  { label: string; outcomes: readonly DealOutcome[] }
> = {
  qualified: { label: "Qualified", outcomes: ["open"] },
  booked: { label: "Booked", outcomes: ["open"] },
  call_held: { label: "Call held", outcomes: ["open"] },
  follow_up: { label: "Follow-up", outcomes: ["open"] },
  closed: { label: "Closed", outcomes: ["won", "lost"] },
};

export function isAllowedStageOutcome(
  stage: DealStage,
  outcome: DealOutcome,
): boolean {
  return DEAL_STAGE_CONFIG[stage].outcomes.includes(outcome);
}

/** The one check that a stage and outcome pair is allowed. */
export function assertStageOutcome(stage: DealStage, outcome: DealOutcome): void {
  if (!isAllowedStageOutcome(stage, outcome)) {
    throw new Error(`Deal stage "${stage}" doesn't allow outcome "${outcome}"`);
  }
}

// The six places a screen shows a deal, in order: the four open stages, then
// Closed split by its outcome.
export const DEAL_POSITIONS = [
  "qualified",
  "booked",
  "call_held",
  "follow_up",
  "won",
  "lost",
] as const;

export type DealPosition = (typeof DEAL_POSITIONS)[number];

export const DEAL_POSITION_LABELS: Record<DealPosition, string> = {
  qualified: "Qualified",
  booked: "Booked",
  call_held: "Call held",
  follow_up: "Follow-up",
  won: "Won",
  lost: "Lost",
};

export function dealPosition(stage: DealStage, outcome: DealOutcome): DealPosition {
  assertStageOutcome(stage, outcome);
  if (stage !== "closed") {
    return stage;
  }
  return outcome === "won" ? "won" : "lost";
}

/** The stage and outcome a position shows, such as for an aggregate prefix. */
export function stageOfPosition(position: DealPosition): DealStageAndOutcome {
  switch (position) {
    case "won":
    case "lost":
      return { stage: "closed", outcome: position };
    default:
      return { stage: position, outcome: "open" };
  }
}

// The loss reasons the system writes. A loss the system writes has no
// `lostByUserId`; a loss a person records has one, with free text or no
// reason (§4.1).
export const SYSTEM_LOSS_REASONS = {
  // The Slack expiry closes a qualified deal that never booked
  // (slack/staleExpiry.ts).
  stale: "stale",
  // A missed meeting closes the deal (§4.3, D16).
  no_show: "no_show",
  canceled: "canceled",
} as const;

export type SystemLossReason =
  (typeof SYSTEM_LOSS_REASONS)[keyof typeof SYSTEM_LOSS_REASONS];

export const SYSTEM_LOSS_REASON_LABELS: Record<SystemLossReason, string> = {
  stale: "Slack qualification expired",
  no_show: "No-show",
  canceled: "Canceled",
};

export function isSystemLossReason(
  reason: string | undefined,
): reason is SystemLossReason {
  return (
    reason !== undefined &&
    (Object.values(SYSTEM_LOSS_REASONS) as string[]).includes(reason)
  );
}

export type DealSource = NonNullable<Doc<"opportunities">["source"]>;

export type DealStageAndOutcome = { stage: DealStage; outcome: DealOutcome };

/**
 * The old statuses, frozen. The old deal events recorded them (§4.7);
 * nothing writes one any more, and no new code reads or adds one (ADR 0001,
 * rule 1).
 */
export const OPPORTUNITY_STATUSES = [
  "qualified_pending",
  "scheduled",
  "payment_received",
  "follow_up_scheduled",
  "reschedule_link_sent",
  "lost",
  "canceled",
  "no_show",
] as const;

export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

/**
 * An old status as a stage and an outcome (§4.2), for reading old events. A
 * deal with no source is a Calendly deal, as everywhere else. The scheduled
 * side deal has no meeting, so it is Call held.
 */
export function stageForStatus(
  status: OpportunityStatus,
  source: DealSource | undefined,
): DealStageAndOutcome {
  switch (status) {
    case "qualified_pending":
      return { stage: "qualified", outcome: "open" };
    case "scheduled":
      return source === "side_deal"
        ? { stage: "call_held", outcome: "open" }
        : { stage: "booked", outcome: "open" };
    case "follow_up_scheduled":
    case "reschedule_link_sent":
      return { stage: "follow_up", outcome: "open" };
    case "canceled":
    case "no_show":
    case "lost":
      return { stage: "closed", outcome: "lost" };
    case "payment_received":
      return { stage: "closed", outcome: "won" };
  }
}

/** The deal's stage and outcome, which the schema requires. */
export function dealStageOf(
  deal: Pick<Doc<"opportunities">, "stage" | "outcome">,
): DealStageAndOutcome {
  return { stage: deal.stage, outcome: deal.outcome };
}

// ─── The stage machine (§4.4) ─────────────────────────────────────────

/** Where a move takes a deal: an open stage, or Closed with how it ended. */
export type DealTarget =
  | { stage: Exclude<DealStage, "closed"> }
  | { stage: "closed"; outcome: Exclude<DealOutcome, "open"> };

export function targetStageAndOutcome(target: DealTarget): DealStageAndOutcome {
  return target.stage === "closed"
    ? { stage: "closed", outcome: target.outcome }
    : { stage: target.stage, outcome: "open" };
}

/**
 * The moves a deal makes between positions. A Closed deal stays closed,
 * except through a named exception below.
 */
export const VALID_STAGE_TRANSITIONS: Record<DealPosition, readonly DealPosition[]> = {
  qualified: ["booked", "lost"],
  booked: ["follow_up", "won", "lost"],
  call_held: ["follow_up", "won", "lost"],
  follow_up: ["booked", "won", "lost"],
  won: [],
  lost: [],
};

/**
 * Moves the stage machine doesn't allow, permitted only for the caller that
 * names them. Each reopens, or recloses, only the deal it was written for:
 * `loss` lists the codes the system must have closed the deal with (no
 * `lostByUserId`), so a person's loss never reopens, whatever its text.
 */
export const STAGE_TRANSITION_EXCEPTIONS = {
  // Voiding a side deal's payment closes the deal as lost.
  payment_voided: { from: "won", to: "lost", loss: null },
  // A booking that happened inside the Slack join window but was processed
  // after the stale expiry closed the deal (a retried blocked delivery)
  // reopens it. See wasStaleExpiredAfter in pipeline/slackJoinLookup.ts.
  slack_stale_rejoin: { from: "lost", to: "booked", loss: [SYSTEM_LOSS_REASONS.stale] },
  // The closer or an admin sends a reschedule link or sets a follow-up after
  // a no-show or a cancellation (§4.3).
  missed_meeting_next_step: {
    from: "lost",
    to: "follow_up",
    loss: [SYSTEM_LOSS_REASONS.no_show, SYSTEM_LOSS_REASONS.canceled],
  },
  // Calendly withdraws the no-show it reported.
  no_show_withdrawn: { from: "lost", to: "booked", loss: [SYSTEM_LOSS_REASONS.no_show] },
} as const satisfies Record<
  string,
  { from: DealPosition; to: DealPosition; loss: readonly SystemLossReason[] | null }
>;

export type StageTransitionException = keyof typeof STAGE_TRANSITION_EXCEPTIONS;

/** The deal fields the stage machine reads. */
export type StageMachineDeal = Pick<
  Doc<"opportunities">,
  "source" | "stage" | "outcome" | "lostReason" | "lostByUserId"
>;

/** The code the system closed the deal lost with, or null: a person's loss has a `lostByUserId`. */
export function systemLossReasonOf(deal: StageMachineDeal): SystemLossReason | null {
  const { stage, outcome } = dealStageOf(deal);
  return stage === "closed" &&
    outcome === "lost" &&
    deal.lostByUserId === undefined &&
    isSystemLossReason(deal.lostReason)
    ? deal.lostReason
    : null;
}

/** Whether the named exception, on its own, allows the move. */
export function exceptionAllows(
  exception: StageTransitionException,
  deal: StageMachineDeal,
  to: DealPosition,
): boolean {
  const rule: { from: DealPosition; to: DealPosition; loss: readonly SystemLossReason[] | null } =
    STAGE_TRANSITION_EXCEPTIONS[exception];
  const { stage, outcome } = dealStageOf(deal);
  if (!isAllowedStageOutcome(stage, outcome)) return false;
  if (dealPosition(stage, outcome) !== rule.from || to !== rule.to) return false;
  if (rule.loss === null) return true;
  const loss = systemLossReasonOf(deal);
  return loss !== null && rule.loss.includes(loss);
}

/**
 * Whether the deal may move to `target`: the stage machine allows it, or the
 * named exception does. A move to where the deal already is never is, and
 * neither is any move from a pair the stage doesn't allow.
 */
export function stageMoveAllowed(
  deal: StageMachineDeal,
  target: DealTarget,
  exception?: StageTransitionException,
): boolean {
  const from = dealStageOf(deal);
  const to = targetStageAndOutcome(target);
  if (!isAllowedStageOutcome(from.stage, from.outcome)) return false;
  const fromPosition = dealPosition(from.stage, from.outcome);
  const toPosition = dealPosition(to.stage, to.outcome);
  if (VALID_STAGE_TRANSITIONS[fromPosition].includes(toPosition)) return true;
  return exception !== undefined && exceptionAllows(exception, deal, toPosition);
}

function describePair({ stage, outcome }: DealStageAndOutcome): string {
  return stage === "closed" ? `closed ${outcome}` : stage;
}

/** Throws on a move `stageMoveAllowed` refuses, naming both ends. */
export function assertStageMove(
  deal: StageMachineDeal,
  target: DealTarget,
  exception?: StageTransitionException,
): void {
  if (!stageMoveAllowed(deal, target, exception)) {
    throw new Error(
      `Cannot move deal from "${describePair(dealStageOf(deal))}" to "${describePair(
        targetStageAndOutcome(target),
      )}"${exception ? ` with "${exception}"` : ""}`,
    );
  }
}
