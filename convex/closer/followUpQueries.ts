import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const getActiveReminders = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId, userId } = await requireTenantUser(ctx, ["closer"]);

    const pendingFollowUps = await ctx.db
      .query("followUps")
      .withIndex("by_tenantId_and_closerId_and_status", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("closerId", userId)
          .eq("status", "pending"),
      )
      .take(50);

    const reminders = pendingFollowUps.filter(
      (followUp) => followUp.type === "manual_reminder",
    );

    const enriched = await Promise.all(
      reminders.map(async (reminder) => {
        const lead = await ctx.db.get(reminder.leadId);

        return {
          ...reminder,
          leadName: lead?.fullName ?? lead?.email ?? "Unknown",
          leadPhone: lead?.phone ?? null,
        };
      }),
    );

    enriched.sort((a, b) => {
      const aTime = a.reminderScheduledAt ?? Number.POSITIVE_INFINITY;
      const bTime = b.reminderScheduledAt ?? Number.POSITIVE_INFINITY;
      return aTime - bTime;
    });

    console.log("[Closer:FollowUp] getActiveReminders", {
      userId,
      count: enriched.length,
    });

    return enriched;
  },
});
