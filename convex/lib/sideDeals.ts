import type { Doc } from "../_generated/dataModel";
import type { PaymentOrigin } from "./paymentTypes";

export type OpportunitySource =
  | "calendly"
  | "side_deal"
  | "slack_qualified";

export function normalizeOpportunitySource(
  opportunity: Pick<Doc<"opportunities">, "source">,
): OpportunitySource {
  return opportunity.source ?? "calendly";
}

export function isSideDeal(
  opportunity: Pick<Doc<"opportunities">, "source">,
): boolean {
  return normalizeOpportunitySource(opportunity) === "side_deal";
}

// Additional payments on a won side deal stay in their own correction path.
const ADDITIONAL_PAYMENT_ORIGINS: ReadonlySet<PaymentOrigin> = new Set([
  "closer_additional",
  "admin_additional",
]);

/**
 * Whether a payment is a side deal's own payment, voidable through the
 * side-deal void: a payment on that side deal, recognised by the deal's
 * source, since a payment confirmed from Whop has `origin: "provider"`.
 * Additional payments are not.
 */
export function isSideDealPayment(
  payment: Pick<Doc<"paymentRecords">, "opportunityId" | "origin">,
  opportunity: Pick<Doc<"opportunities">, "_id" | "source">,
): boolean {
  return (
    payment.opportunityId === opportunity._id &&
    isSideDeal(opportunity) &&
    !(payment.origin !== undefined && ADDITIONAL_PAYMENT_ORIGINS.has(payment.origin))
  );
}
