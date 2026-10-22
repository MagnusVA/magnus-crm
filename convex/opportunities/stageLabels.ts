import type { OpportunityStatus } from "./stages";
import { isMissedMeetingLoss, type DealStateFields, type MissedMeeting } from "./dealState";
import {
  DEAL_OUTCOMES,
  DEAL_POSITION_LABELS,
  DEAL_STAGE_CONFIG,
  DEAL_STAGES,
  SYSTEM_LOSS_REASONS,
  dealPosition,
  dealStageOf,
  isAllowedStageOutcome,
  type DealOutcome,
  type DealPosition,
  type DealStage,
  type SystemLossReason,
} from "./stages";

// What screens, Slack and search say about a deal, read from its stage and
// outcome (docs/plans/phase-5-deal-status.md §4.1, §6.1), and the labels of
// the deal events, old and new (§4.7). The server and the UI both import it.

/** The deal's stage, outcome and position, and the loss the system wrote on it. */
export type DealLabel = {
  stage: DealStage;
  outcome: DealOutcome;
  position: DealPosition;
  /**
   * The reason, when the system closed the deal lost: the Slack expiry
   * (`stale`) or a missed meeting (`no_show`, `canceled`). Null otherwise,
   * and on a loss a person recorded, whatever its text.
   */
  systemLoss: SystemLossReason | null;
};

/** The loss the system wrote: Closed lost with no `lostByUserId` and a system code. */
export function systemLossOf(deal: DealStateFields): SystemLossReason | null {
  const missedMeeting = isMissedMeetingLoss(deal);
  if (missedMeeting) {
    return missedMeeting;
  }
  const { stage, outcome } = dealStageOf(deal);
  return stage === "closed" &&
    outcome === "lost" &&
    deal.lostByUserId === undefined &&
    deal.lostReason === SYSTEM_LOSS_REASONS.stale
    ? SYSTEM_LOSS_REASONS.stale
    : null;
}

/** The fields a payload carries for a deal's badge. Throws on a pair the stage doesn't allow. */
export function dealLabelOf(deal: DealStateFields): DealLabel {
  const { stage, outcome } = dealStageOf(deal);
  return {
    stage,
    outcome,
    position: dealPosition(stage, outcome),
    systemLoss: systemLossOf(deal),
  };
}

/** The same fields for a record that shows its deal's, such as a meeting. */
export function meetingDealLabelOf(deal: DealStateFields) {
  const { stage, outcome, position, systemLoss } = dealLabelOf(deal);
  return {
    dealStage: stage,
    dealOutcome: outcome,
    dealPosition: position,
    dealSystemLoss: systemLoss,
  };
}

// The badge's suffix for a loss the system wrote: "Lost: no-show".
const SYSTEM_LOSS_BADGE_LABELS: Record<SystemLossReason, string> = {
  stale: "expired",
  no_show: "no-show",
  canceled: "canceled",
};

/** What a badge says: the position, with the system's reason on a loss it wrote. */
export function dealPositionLabel(
  position: DealPosition,
  systemLoss?: SystemLossReason | null,
): string {
  if (position === "lost" && systemLoss) {
    return `${DEAL_POSITION_LABELS.lost}: ${SYSTEM_LOSS_BADGE_LABELS[systemLoss]}`;
  }
  return DEAL_POSITION_LABELS[position];
}

const MISSED_MEETING_SEARCH_WORDS: Record<MissedMeeting, string> = {
  no_show: "no show",
  canceled: "canceled",
};

/**
 * The words a person's search row holds for one of their deals (§4.8). The
 * row is rebuilt inside every write to the deal, so a pair the stage doesn't
 * allow, which assertDealStages reports, still gives words instead of
 * failing the write.
 */
export function dealSearchWords(deal: DealStateFields): string[] {
  const { stage, outcome } = dealStageOf(deal);
  if (!isAllowedStageOutcome(stage, outcome)) {
    return [DEAL_STAGE_CONFIG[stage].label, outcome];
  }
  const position = DEAL_POSITION_LABELS[dealPosition(stage, outcome)];
  const missedMeeting = isMissedMeetingLoss(deal);
  return missedMeeting ? [position, MISSED_MEETING_SEARCH_WORDS[missedMeeting]] : [position];
}

// ─── Deal events (§4.7) ───────────────────────────────────────────────

/**
 * Today's statuses, as the old events recorded them. Frozen: nothing writes
 * a status into an event after PR 8, and the 5,488 `opportunity.status_changed`
 * and 4,540 `opportunity.marked_lost` events keep theirs.
 */
export const LEGACY_STATUS_LABELS: Record<OpportunityStatus, string> = {
  qualified_pending: "Qualified, not booked",
  scheduled: "Scheduled",
  follow_up_scheduled: "Follow-up scheduled",
  reschedule_link_sent: "Reschedule link sent",
  payment_received: "Payment received",
  lost: "Lost",
  canceled: "Canceled",
  no_show: "No-show",
};

function isDealStage(value: string): value is DealStage {
  return (DEAL_STAGES as readonly string[]).includes(value);
}

function isDealOutcome(value: unknown): value is DealOutcome {
  return typeof value === "string" && (DEAL_OUTCOMES as readonly string[]).includes(value);
}

function isLegacyStatus(value: string): value is OpportunityStatus {
  return Object.hasOwn(LEGACY_STATUS_LABELS, value);
}

/**
 * What a deal event's `fromStatus` or `toStatus` says. An old event holds a
 * status; from PR 8 an event holds a stage, with its outcome in the
 * metadata, so a Closed stage says how it closed: "Closed (won)". The two
 * lists share no value. Anything else shows as it is.
 */
export function dealEventStateLabel(
  value: string | null | undefined,
  outcome?: DealOutcome | null,
): string | null {
  if (!value) {
    return null;
  }
  if (isDealStage(value)) {
    const label = DEAL_STAGE_CONFIG[value].label;
    return value === "closed" && outcome && outcome !== "open" ? `${label} (${outcome})` : label;
  }
  if (isLegacyStatus(value)) {
    return LEGACY_STATUS_LABELS[value];
  }
  return value;
}

export type DealEventOutcomes = {
  fromOutcome: DealOutcome | null;
  toOutcome: DealOutcome | null;
};

/** The outcomes a new deal event records in its metadata; none on an old event. */
export function dealEventOutcomes(
  metadata: Record<string, unknown> | null | undefined,
): DealEventOutcomes {
  const fromOutcome = metadata?.fromOutcome;
  const toOutcome = metadata?.toOutcome;
  return {
    fromOutcome: isDealOutcome(fromOutcome) ? fromOutcome : null,
    toOutcome: isDealOutcome(toOutcome) ? toOutcome : null,
  };
}

/** The same, from the metadata string `domainEvents` stores. */
export function parseDealEventOutcomes(metadata: string | undefined): DealEventOutcomes {
  if (!metadata) {
    return dealEventOutcomes(null);
  }
  try {
    const parsed: unknown = JSON.parse(metadata);
    return dealEventOutcomes(
      parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null,
    );
  } catch {
    return dealEventOutcomes(null);
  }
}
