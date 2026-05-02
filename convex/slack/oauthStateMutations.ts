import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

export const insertState = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    workosUserId: v.string(),
    stateHash: v.string(),
    nonceHash: v.string(),
    issuedAt: v.number(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("slackOAuthStates", {
      tenantId: args.tenantId,
      workosUserId: args.workosUserId,
      stateHash: args.stateHash,
      nonceHash: args.nonceHash,
      issuedAt: args.issuedAt,
      expiresAt: args.expiresAt,
    });
  },
});

export const consumeState = internalMutation({
  args: {
    stateHash: v.string(),
    nonceHash: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("slackOAuthStates")
      .withIndex("by_stateHash", (q) => q.eq("stateHash", args.stateHash))
      .unique();

    if (!row) return false;
    if (row.consumedAt) return false;
    if (row.nonceHash !== args.nonceHash) return false;
    if (row.expiresAt <= Date.now()) return false;

    await ctx.db.patch(row._id, { consumedAt: Date.now() });
    return true;
  },
});
