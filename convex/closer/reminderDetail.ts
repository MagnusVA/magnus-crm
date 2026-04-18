import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const getReminderDetail = query({
  args: { followUpId: v.id("followUps") },
  handler: async (ctx, { followUpId }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, ["closer"]);

    const followUp = await ctx.db.get(followUpId);
    if (!followUp) {
      return null;
    }
    if (followUp.tenantId !== tenantId) {
      return null;
    }
    if (followUp.closerId !== userId) {
      return null;
    }
    if (followUp.type !== "manual_reminder") {
      return null;
    }

    const [opportunity, lead] = await Promise.all([
      ctx.db.get(followUp.opportunityId),
      ctx.db.get(followUp.leadId),
    ]);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      return null;
    }
    if (!lead || lead.tenantId !== tenantId) {
      return null;
    }

    const [latestMeeting, payments, eventTypeConfig] = await Promise.all([
      opportunity.latestMeetingId
        ? ctx.db.get(opportunity.latestMeetingId)
        : Promise.resolve(null),
      ctx.db
        .query("paymentRecords")
        .withIndex("by_opportunityId", (q) =>
          q.eq("opportunityId", opportunity._id),
        )
        .order("desc")
        .take(10),
      opportunity.eventTypeConfigId
        ? ctx.db.get(opportunity.eventTypeConfigId)
        : Promise.resolve(null),
    ]);

    const paymentLinks =
      eventTypeConfig && eventTypeConfig.tenantId === tenantId
        ? (eventTypeConfig.paymentLinks ?? [])
        : [];

    console.log("[Closer:Reminder] getReminderDetail", {
      followUpId,
      opportunityStatus: opportunity.status,
      followUpStatus: followUp.status,
      hasLatestMeeting: Boolean(latestMeeting),
      paymentCount: payments.length,
      paymentLinkCount: paymentLinks.length,
    });

    return {
      followUp,
      opportunity,
      lead,
      latestMeeting:
        latestMeeting && latestMeeting.tenantId === tenantId
          ? latestMeeting
          : null,
      payments,
      paymentLinks,
    };
  },
});
