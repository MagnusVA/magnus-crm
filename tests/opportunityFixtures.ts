import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import { replaceOpportunityAggregate } from "../convex/reporting/writeHooks";

// Puts an opportunity into a fixture state, including statuses that no
// transition reaches, and keeps its aggregates and projections in sync.
// Production code changes status only through transitionOpportunity.
export async function forceOpportunityState(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  patch: Partial<Omit<Doc<"opportunities">, "_id" | "_creationTime">>,
): Promise<Doc<"opportunities">> {
  const before = await ctx.db.get("opportunities", opportunityId);
  if (!before) {
    throw new Error("Opportunity not found");
  }
  await ctx.db.patch("opportunities", opportunityId, patch);
  return await replaceOpportunityAggregate(ctx, before, opportunityId);
}
