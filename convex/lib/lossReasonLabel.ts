import {
  isReservedLossReason,
  isSystemLossReason,
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
