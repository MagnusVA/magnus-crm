import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { OpportunityStatus } from "../lib/statusTransitions";

// Where a deal is (CONTEXT.md, "Deal stage") and how it ended, defined once
// (docs/plans/phase-5-deal-status.md §4.1). Until the narrow, `stage` and
// `outcome` are written beside `opportunities.status` from the mapping below
// (§4.2), and nothing reads them yet.

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
 * Today's status as a stage and an outcome (§4.2). A deal with no source is a
 * Calendly deal, as everywhere else. The scheduled side deal has no meeting,
 * so it is Call held.
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

/**
 * The deal's stage and outcome. Until the backfill has written them on every
 * deal, a deal without them takes them from its status, so a reader (or an
 * aggregate key) gets the same answer before and after the backfill.
 */
export function dealStageOf(
  deal: Pick<Doc<"opportunities">, "status" | "source" | "stage" | "outcome">,
): DealStageAndOutcome {
  const mapped = stageForStatus(deal.status, deal.source);
  return {
    stage: deal.stage ?? mapped.stage,
    outcome: deal.outcome ?? mapped.outcome,
  };
}

/** The reason a missed meeting writes on its deal: its status's code. */
export function missedMeetingLossReason(
  status: OpportunityStatus,
): typeof SYSTEM_LOSS_REASONS.canceled | typeof SYSTEM_LOSS_REASONS.no_show | undefined {
  switch (status) {
    case "canceled":
      return SYSTEM_LOSS_REASONS.canceled;
    case "no_show":
      return SYSTEM_LOSS_REASONS.no_show;
    default:
      return undefined;
  }
}
