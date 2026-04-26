import type { Doc } from "../_generated/dataModel";
import type { CommissionableOrigin } from "./paymentTypes";

export type OpportunitySource = "calendly" | "side_deal";

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

const SIDE_DEAL_ORIGINS: ReadonlySet<CommissionableOrigin> = new Set([
  "closer_side_deal",
  "admin_side_deal",
]);

export function isSideDealOrigin(origin: string | undefined | null): boolean {
  return origin !== undefined && origin !== null
    ? SIDE_DEAL_ORIGINS.has(origin as CommissionableOrigin)
    : false;
}
