import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { validateTransition } from "../lib/statusTransitions";

/**
 * Create a follow-up record.
 * Called by the createFollowUp action after generating the scheduling link.
 */
export const createFollowUpRecord = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    opportunityId: v.id("opportunities"),
    leadId: v.id("leads"),
    closerId: v.id("users"),
    schedulingLinkUrl: v.string(),
    reason: v.union(
      v.literal("closer_initiated"),
      v.literal("cancellation_follow_up"),
      v.literal("no_show_follow_up"),
    ),
  },
  handler: async (ctx, args) => {
    console.log("[Closer:FollowUp] createFollowUpRecord called", { opportunityId: args.opportunityId, reason: args.reason });
    const id = await ctx.db.insert("followUps", {
      tenantId: args.tenantId,
      opportunityId: args.opportunityId,
      leadId: args.leadId,
      closerId: args.closerId,
      schedulingLinkUrl: args.schedulingLinkUrl,
      reason: args.reason,
      status: "pending",
      createdAt: Date.now(),
    });
    console.log("[Closer:FollowUp] createFollowUpRecord inserted", { followUpId: id });
    return id;
  },
});

/**
 * Transition an opportunity to follow_up_scheduled.
 * Validates the transition is allowed from the current status.
 */
export const transitionToFollowUp = internalMutation({
  args: { opportunityId: v.id("opportunities") },
  handler: async (ctx, { opportunityId }) => {
    console.log("[Closer:FollowUp] transitionToFollowUp called", { opportunityId });
    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity) throw new Error("Opportunity not found");

    console.log("[Closer:FollowUp] transitionToFollowUp current status", { currentStatus: opportunity.status });
    const isValid = validateTransition(opportunity.status, "follow_up_scheduled");
    console.log("[Closer:FollowUp] transitionToFollowUp transition valid", { from: opportunity.status, to: "follow_up_scheduled", valid: isValid });
    if (!isValid) {
      throw new Error(
        `Cannot schedule follow-up from status "${opportunity.status}". ` +
          `Only "in_progress", "canceled", and "no_show" opportunities support follow-ups.`
      );
    }

    await ctx.db.patch(opportunityId, {
      status: "follow_up_scheduled",
      updatedAt: Date.now(),
    });
    console.log("[Closer:FollowUp] transitionToFollowUp patch applied", { opportunityId, newStatus: "follow_up_scheduled" });
  },
});

/**
 * Mark a follow-up as booked (called when pipeline detects the follow-up booking).
 * This could be wired into the invitee.created handler in Phase 3.
 */
export const markFollowUpBooked = internalMutation({
  args: {
    opportunityId: v.id("opportunities"),
    calendlyEventUri: v.string(),
  },
  handler: async (ctx, { opportunityId, calendlyEventUri }) => {
    console.log("[Closer:FollowUp] markFollowUpBooked called", { opportunityId });
    let followUpId: Id<"followUps"> | null = null;
    for await (const followUp of ctx.db
      .query("followUps")
      .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))) {
      if (followUp.status === "pending") {
        followUpId = followUp._id;
        break;
      }
    }

    if (followUpId) {
      console.log("[Closer:FollowUp] markFollowUpBooked: found pending follow-up", { followUpId });
      await ctx.db.patch(followUpId, {
        status: "booked",
        calendlyEventUri,
      });
      console.log("[Closer:FollowUp] markFollowUpBooked patch applied", { followUpId, newStatus: "booked" });
    } else {
      console.warn("[Closer:FollowUp] markFollowUpBooked: no pending follow-up found", { opportunityId });
    }
  },
});
