import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { deleteOpportunitySearchProjection } from "../lib/opportunitySearch";
import { isSideDeal } from "../lib/sideDeals";
import { updateTenantStats } from "../lib/tenantStatsHelper";
import { requireTenantUser } from "../requireTenantUser";
import { opportunityByStatus } from "../reporting/aggregates";

export const deleteEmptyOpportunity = mutation({
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
    const isAdmin = role === "tenant_master" || role === "tenant_admin";
    const now = Date.now();
    const trimmedReason = reason?.trim() || undefined;
    if (trimmedReason && trimmedReason.length > 500) {
      throw new Error("Reason must be under 500 characters.");
    }

    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found.");
    }
    if (!isSideDeal(opportunity)) {
      throw new Error("Only side-deal opportunities can be deleted.");
    }
    if (opportunity.status !== "in_progress") {
      throw new Error(
        `Cannot delete an opportunity in "${opportunity.status}" status.`,
      );
    }
    if (!isAdmin && opportunity.assignedCloserId !== userId) {
      throw new Error("You are not the assigned closer for this opportunity.");
    }

    const [payment, meeting, bookedFollowUp, completedFollowUp, followUps] =
      await Promise.all([
        ctx.db
          .query("paymentRecords")
          .withIndex("by_opportunityId", (q) =>
            q.eq("opportunityId", opportunityId),
          )
          .first(),
        ctx.db
          .query("meetings")
          .withIndex("by_opportunityId", (q) =>
            q.eq("opportunityId", opportunityId),
          )
          .first(),
        ctx.db
          .query("followUps")
          .withIndex("by_opportunityId_and_status", (q) =>
            q.eq("opportunityId", opportunityId).eq("status", "booked"),
          )
          .first(),
        ctx.db
          .query("followUps")
          .withIndex("by_opportunityId_and_status", (q) =>
            q.eq("opportunityId", opportunityId).eq("status", "completed"),
          )
          .first(),
        ctx.db
          .query("followUps")
          .withIndex("by_opportunityId", (q) =>
            q.eq("opportunityId", opportunityId),
          )
          .take(50),
      ]);

    if (payment) {
      throw new Error(
        "This opportunity has a payment record. Void the payment first, or mark it lost.",
      );
    }
    if (meeting) {
      throw new Error(
        "This opportunity has a meeting attached. Mark it lost instead.",
      );
    }
    if (bookedFollowUp || completedFollowUp) {
      throw new Error(
        "This opportunity has follow-up work attached. Mark it lost instead.",
      );
    }
    if (followUps.length === 50) {
      throw new Error("Too many follow-ups are attached to delete safely.");
    }
    if (
      followUps.some(
        (followUp) => followUp.reason !== "stale_opportunity_nudge",
      )
    ) {
      throw new Error(
        "This opportunity has a follow-up attached. Mark it lost instead.",
      );
    }

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: opportunityId,
      eventType: "opportunity.deleted",
      source: isAdmin ? "admin" : "closer",
      actorUserId: userId,
      reason: trimmedReason,
      occurredAt: now,
      metadata: {
        source: "side_deal",
        ageMs: now - opportunity.createdAt,
        assignedCloserId: opportunity.assignedCloserId,
        staleNudgeCount: followUps.length,
      },
    });

    for (const followUp of followUps) {
      await ctx.db.delete(followUp._id);
    }
    await opportunityByStatus.delete(ctx, opportunity);
    await updateTenantStats(ctx, tenantId, {
      totalOpportunities: -1,
      activeOpportunities: -1,
    });
    await deleteOpportunitySearchProjection(ctx, opportunityId);
    await ctx.db.delete(opportunityId);

    return null;
  },
});
