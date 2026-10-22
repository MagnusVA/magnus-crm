import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { transitionOpportunity } from "../lib/opportunityActivity";
import { isSideDeal } from "../lib/sideDeals";
import { expirePendingStaleOpportunityNudges } from "../lib/staleOpportunityNudges";
import { canMarkLost, describeDealState, loadDealTasks } from "../opportunities/dealGuards";
import { requireTenantUser } from "../requireTenantUser";

export const markLost = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    reason: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { opportunityId, reason }) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const now = Date.now();
    const isAdmin = role === "tenant_master" || role === "tenant_admin";

    const opportunity = await ctx.db.get("opportunities", opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found.");
    }
    if (!isSideDeal(opportunity)) {
      throw new Error("This mutation only accepts side-deal opportunities.");
    }
    if (!isAdmin && opportunity.assignedCloserId !== userId) {
      throw new Error("You are not the assigned closer for this opportunity.");
    }
    if (!canMarkLost(opportunity, await loadDealTasks(ctx, opportunityId))) {
      throw new Error(`A deal at "${describeDealState(opportunity)}" can't be marked lost.`);
    }

    const trimmedReason = reason?.trim() || undefined;
    await transitionOpportunity(ctx, opportunityId, {
      to: { stage: "closed", outcome: "lost" },
      fields: {
        lostAt: now,
        lostByUserId: userId,
        lostReason: trimmedReason,
        updatedAt: now,
      },
      source: isAdmin ? "admin" : "closer",
      actorUserId: userId,
      reason: trimmedReason,
      occurredAt: now,
      metadata: { source: "side_deal" },
    });
    await expirePendingStaleOpportunityNudges(ctx, opportunityId);

    return null;
  },
});
