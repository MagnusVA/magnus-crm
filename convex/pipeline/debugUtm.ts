import { internalQuery } from "../_generated/server";
import { v } from "convex/values";

/**
 * Debug query: list recent meetings and their UTM status.
 * DEVELOPMENT ONLY — Use from Convex dashboard to verify UTM extraction is working.
 * This query is not part of the production API.
 */
export const recentMeetingUtms = internalQuery({
  args: { tenantId: v.id("tenants"), limit: v.optional(v.number()) },
  handler: async (ctx, { tenantId, limit }) => {
    const meetings = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q.eq("tenantId", tenantId),
      )
      .order("desc")
      .take(limit ?? 10);

    return meetings.map((m) => ({
      _id: m._id,
      scheduledAt: new Date(m.scheduledAt).toISOString(),
      leadName: m.leadName,
      hasUtm: !!m.utmParams,
      utmParams: m.utmParams ?? null,
    }));
  },
});
