import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { dealStageOf } from "../opportunities/stages";
import { describeDealState } from "../opportunities/dealGuards";
import { requireTenantUser } from "../requireTenantUser";

/**
 * An admin cancels a deal's open task (a call-back, text-back or scheduling
 * link) from the person page. The task expires and the deal stays where it
 * is, open and without that step, so someone sets the next one. A link
 * expired here no longer moves the deal when booked through
 * (pipeline/bookingTargets.ts treats it as closed).
 */
export const adminCancelTask = mutation({
  args: { followUpId: v.id("followUps") },
  returns: v.null(),
  handler: async (ctx, { followUpId }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const followUp = await ctx.db.get("followUps", followUpId);
    if (!followUp || followUp.tenantId !== tenantId) {
      throw new Error("Task not found");
    }
    if (followUp.status !== "pending") {
      throw new Error("This task is already closed");
    }
    const opportunity = await ctx.db.get("opportunities", followUp.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Deal not found");
    }
    if (dealStageOf(opportunity).outcome !== "open") {
      throw new Error(
        `Only a task on an open deal can be canceled; the deal is "${describeDealState(opportunity)}"`,
      );
    }

    const now = Date.now();
    await ctx.db.patch("followUps", followUpId, { status: "expired" });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "followUp",
      entityId: followUpId,
      eventType: "followUp.expired",
      source: "admin",
      actorUserId: userId,
      fromStatus: "pending",
      toStatus: "expired",
      metadata: {
        type: followUp.type,
        reason: followUp.reason,
        opportunityId: opportunity._id,
        origin: "admin_task_canceled",
      },
      occurredAt: now,
    });
    return null;
  },
});
