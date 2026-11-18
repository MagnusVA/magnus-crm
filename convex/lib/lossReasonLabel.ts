import type { Id } from "../_generated/dataModel";
import {
  isReservedLossReason,
  isSystemLossReason,
  RESERVED_LOSS_REASONS,
  RESERVED_LOSS_REASON_LABELS,
  SYSTEM_LOSS_REASON_LABELS,
  type ReservedLossReason,
} from "../opportunities/stages";

/**
 * The words for a stored loss reason, wherever one is printed. A system code
 * and a reserved code get their label; anything else is what a person typed.
 * Returns null when there is no reason.
 */
export function lossReasonLabel(
  reason: string | undefined | null,
): string | null {
  if (!reason) return null;
  if (isSystemLossReason(reason)) return SYSTEM_LOSS_REASON_LABELS[reason];
  if (isReservedLossReason(reason))
    return RESERVED_LOSS_REASON_LABELS[
      reason.trim().toLowerCase() as ReservedLossReason
    ];
  return reason;
}

/**
 * For a server result that has always carried the stored reason: a reserved
 * code becomes its label, and everything else, system codes included, stays as
 * stored, so existing rows read exactly as before. Screens label the rest.
 */
export function maskReservedLossReason(
  reason: string | undefined | null,
): string | null {
  if (!reason) return null;
  return isReservedLossReason(reason) ? lossReasonLabel(reason) : reason;
}

/** Who closed the deal: the person who recorded the loss, if any. */
export type LossActor = {
  lostByUserId?: Id<"users"> | null;
  lostByName?: string | null;
};

function isCallRefusal(reason: string | undefined | null): boolean {
  return reason?.trim().toLowerCase() === RESERVED_LOSS_REASONS.call_refusal;
}

/**
 * The byline for a call refusal on a screen whose headline already shows the
 * reason: "confirmed by Dee" when a person recorded it, "recorded
 * automatically" when nobody did. Null for any other reason. It reads only
 * the reason and who recorded it.
 */
export function refusalByline(
  reason: string | undefined | null,
  who: LossActor,
): string | null {
  if (!isCallRefusal(reason)) return null;
  if (!who.lostByUserId) return "recorded automatically";
  return `confirmed by ${who.lostByName?.trim() || "a team member"}`;
}

/**
 * The loss reason with its byline for a call refusal ("Refused on the call ·
 * confirmed by Dee"); any other reason reads as `lossReasonLabel`.
 */
export function lossReasonText(
  reason: string | undefined | null,
  who: LossActor,
): string | null {
  const label = lossReasonLabel(reason);
  const byline = refusalByline(reason, who);
  return label && byline ? `${label} · ${byline}` : label;
}
