import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const insert = internalMutation({
  args: {
    tenantId: v.optional(v.id("tenants")),
    teamId: v.string(),
    apiAppId: v.optional(v.string()),
    eventType: v.string(),
    payloadRedacted: v.string(),
    requestHash: v.string(),
    slackEventId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("rawSlackEvents")
      .withIndex("by_requestHash", (q) =>
        q.eq("requestHash", args.requestHash),
      )
      .first();
    if (existing) {
      return existing._id;
    }

    const now = Date.now();
    return await ctx.db.insert("rawSlackEvents", {
      tenantId: args.tenantId,
      teamId: args.teamId,
      apiAppId: args.apiAppId,
      eventType: args.eventType,
      payloadRedacted: args.payloadRedacted,
      requestHash: args.requestHash,
      slackEventId: args.slackEventId,
      receivedAt: now,
      expiresAt: now + RETENTION_MS,
      processed: true,
      processingError: undefined,
    });
  },
});
