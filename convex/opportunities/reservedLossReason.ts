import { expectedError } from "../lib/observability/errors";
import { isReservedLossReason } from "./stages";

/**
 * Every path where a person types a loss reason calls this first. A reserved
 * code names a loss a CRM core wrote, and a stage exception can reopen such a
 * loss, so a typed reason must never equal one.
 */
export function assertTypedLossReason(reason: string | undefined | null): void {
  if (isReservedLossReason(reason))
    throw expectedError(
      "deal.reserved_loss_reason",
      "That reason is reserved. Describe the loss in your own words.",
    );
}
