import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Recomputes where an unresolved provider payment stands (`reviewState`,
 * `reviewReason` and the candidate person and deal) from the current CRM
 * records. Never changes a payment that is linked, recorded or dismissed.
 * Intake calls it after every stored read of a payment.
 */
export async function refreshProviderPaymentReview(
  _ctx: MutationCtx,
  _providerPaymentId: Id<"providerPayments">,
): Promise<void> {
  throw new Error("refreshProviderPaymentReview is not implemented yet");
}
