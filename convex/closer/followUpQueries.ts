import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const getActiveReminders = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId, userId } = await requireTenantUser(ctx, ["closer"]);

    const reminders = await ctx.db
      .query("followUps")
      .withIndex(
        "by_tenantId_and_closerId_and_type_and_status_reminderScheduledAt",
        (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("closerId", userId)
            .eq("type", "manual_reminder")
            .eq("status", "pending"),
      )
      .take(50);

    const leadIds = [...new Set(reminders.map((reminder) => reminder.leadId))];
    const leads = await Promise.all(
      leadIds.map(async (leadId) => ({
        leadId,
        lead: await ctx.db.get(leadId),
      })),
    );
    const leadById = new Map(
      leads.map(({ leadId, lead }) => [leadId, lead]),
    );

    const enriched = reminders.map((reminder) => {
      const lead = leadById.get(reminder.leadId);
      return {
        ...reminder,
        leadName: lead?.fullName ?? lead?.email ?? "Unknown",
        leadPhone: lead?.phone ?? null,
      };
    });

    console.log("[Closer:FollowUp] getActiveReminders", {
      userId,
      count: enriched.length,
    });

    return enriched;
  },
});
