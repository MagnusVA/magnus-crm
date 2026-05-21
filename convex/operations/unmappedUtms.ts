import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const listRecentUnmappedUtms = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const meetings = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q.eq("tenantId", tenantId).gte("scheduledAt", since),
      )
      .order("desc")
      .take(200);

    return meetings
      .filter((meeting) => meeting.attributionResolution === "unmapped")
      .map((meeting) => ({
        meetingId: meeting._id,
        scheduledAt: meeting.scheduledAt,
        utmSource: meeting.utmParams?.utm_source ?? null,
        utmMedium: meeting.utmParams?.utm_medium ?? null,
        utmCampaign: meeting.utmParams?.utm_campaign ?? null,
      }))
      .slice(0, 25);
  },
});
