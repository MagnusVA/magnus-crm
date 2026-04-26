import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export async function expirePendingStaleOpportunityNudges(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<number> {
  const nudges = await ctx.db
    .query("followUps")
    .withIndex("by_opportunityId_and_status_and_reason", (q) =>
      q
        .eq("opportunityId", opportunityId)
        .eq("status", "pending")
        .eq("reason", "stale_opportunity_nudge"),
    )
    .take(50);

  for (const nudge of nudges) {
    await ctx.db.patch(nudge._id, { status: "expired" });
  }

  return nudges.length;
}
