import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { patchOpportunityLifecycle } from "../lib/opportunityActivity";
import { isSideDeal } from "../lib/sideDeals";
import { expirePendingStaleOpportunityNudges } from "../lib/staleOpportunityNudges";
import { validateTransition } from "../lib/statusTransitions";
import {
  isActiveOpportunityStatus,
  updateTenantStats,
} from "../lib/tenantStatsHelper";
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

    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found.");
    }
    if (!isSideDeal(opportunity)) {
      throw new Error("This mutation only accepts side-deal opportunities.");
    }
    if (!isAdmin && opportunity.assignedCloserId !== userId) {
      throw new Error("You are not the assigned closer for this opportunity.");
    }
    if (!validateTransition(opportunity.status, "lost")) {
      throw new Error(
        `Opportunity status "${opportunity.status}" cannot transition to "lost".`,
      );
    }

    const trimmedReason = reason?.trim() || undefined;
    await patchOpportunityLifecycle(ctx, opportunityId, {
      status: "lost",
      lostAt: now,
      lostByUserId: userId,
      lostReason: trimmedReason,
      updatedAt: now,
    });
    await expirePendingStaleOpportunityNudges(ctx, opportunityId);
    await updateTenantStats(ctx, tenantId, {
      activeOpportunities: isActiveOpportunityStatus(opportunity.status)
        ? -1
        : 0,
      lostDeals: 1,
    });

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: opportunityId,
      eventType: "opportunity.marked_lost",
      source: isAdmin ? "admin" : "closer",
      actorUserId: userId,
      fromStatus: opportunity.status,
      toStatus: "lost",
      reason: trimmedReason,
      occurredAt: now,
      metadata: { source: "side_deal" },
    });

    return null;
  },
});
