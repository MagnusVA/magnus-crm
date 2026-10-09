import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { log } from "../lib/observability/log";

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

    if (!row) {
      log.warn("slack.oauth_state.rejected", { reason: "state_not_found" });
      return false;
    }
    if (row.consumedAt) {
      log.warn("slack.oauth_state.rejected", {
        reason: "already_consumed",
        stateId: row._id,
        tenantId: row.tenantId,
        consumedAt: row.consumedAt,
      });
      return false;
    }
    if (row.nonceHash !== args.nonceHash) {
      log.warn("slack.oauth_state.rejected", {
        reason: "nonce_mismatch",
        stateId: row._id,
        tenantId: row.tenantId,
      });
      return false;
    }
    const now = Date.now();
    if (row.expiresAt <= now) {
      log.warn("slack.oauth_state.rejected", {
        reason: "expired",
        stateId: row._id,
        tenantId: row.tenantId,
        expiredForMs: now - row.expiresAt,
      });
      return false;
    }

    await ctx.db.patch("slackOAuthStates", row._id, { consumedAt: now });
    return true;
  },
});
