import type { Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import type { OpportunityStatus } from "../convex/lib/statusTransitions";

// PR 6 of Phase 5 (docs/plans/phase-5-deal-status.md §6.5, §6.6): the reports
// and operations screens read the deal's stage and outcome.

/**
 * Rewrites only the deal's stored status, leaving its stage and outcome: a
 * screen that reads the stage shows the deal as before, one that reads the
 * status doesn't.
 */
export async function setStoredStatus(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  status: OpportunityStatus,
): Promise<void> {
  await ctx.db.patch("opportunities", opportunityId, { status });
}
