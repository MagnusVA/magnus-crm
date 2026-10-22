import { v, type Infer } from "convex/values";
import { isMissedMeetingLoss, type DealStateFields, type MissedMeeting } from "./dealState";
import {
  DEAL_POSITION_LABELS,
  SYSTEM_LOSS_REASON_LABELS,
  dealPosition,
  dealStageOf,
  type DealOutcome,
  type DealPosition,
  type DealStage,
} from "./stages";

// What the reports and operations screens show of a deal: its position, and
// for a deal a missed meeting closed, which one (docs/plans/phase-5-deal-status.md
// §4.1, §6.6). Pure, so the screens can label with it too.

export const dealPositionValidator = v.union(
  v.literal("qualified"),
  v.literal("booked"),
  v.literal("call_held"),
  v.literal("follow_up"),
  v.literal("won"),
  v.literal("lost"),
);

export const missedMeetingValidator = v.union(v.literal("no_show"), v.literal("canceled"));

// The validators name exactly the module's positions and missed meetings.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const positionsMatch: Same<Infer<typeof dealPositionValidator>, DealPosition> = true;
const missedMeetingsMatch: Same<Infer<typeof missedMeetingValidator>, MissedMeeting> = true;
void positionsMatch;
void missedMeetingsMatch;

export type DealPositionDisplay = {
  position: DealPosition;
  /** The missed meeting that closed the deal, when one did. */
  missedMeeting: MissedMeeting | null;
};

/** The deal's position, and the missed meeting that closed it, if one did. */
export function dealPositionOf(deal: DealStateFields): DealPositionDisplay {
  const { stage, outcome } = dealStageOf(deal);
  return { position: dealPosition(stage, outcome), missedMeeting: isMissedMeetingLoss(deal) };
}

/** A copied stage and outcome's position, or null when the copy has none. */
export function positionOfCopy(
  stage: DealStage | undefined,
  outcome: DealOutcome | undefined,
): DealPosition | null {
  return stage === undefined || outcome === undefined ? null : dealPosition(stage, outcome);
}

/** "Booked", "Won", or for a missed meeting's loss "Lost: no-show". */
export function dealPositionLabel(
  position: DealPosition,
  missedMeeting: MissedMeeting | null = null,
): string {
  const label = DEAL_POSITION_LABELS[position];
  return position === "lost" && missedMeeting
    ? `${label}: ${SYSTEM_LOSS_REASON_LABELS[missedMeeting].toLowerCase()}`
    : label;
}
