import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

function hashPrefix(value: string) {
  return value.slice(0, 12);
}

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
    console.log("[Slack:OAuthState] insertState", {
      tenantId: args.tenantId,
      workosUserId: args.workosUserId,
      stateHashPrefix: hashPrefix(args.stateHash),
      nonceHashPrefix: hashPrefix(args.nonceHash),
      issuedAt: args.issuedAt,
      expiresAt: args.expiresAt,
    });

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
    console.log("[Slack:OAuthState] consumeState lookup", {
      stateHashPrefix: hashPrefix(args.stateHash),
      nonceHashPrefix: hashPrefix(args.nonceHash),
    });

    const row = await ctx.db
      .query("slackOAuthStates")
      .withIndex("by_stateHash", (q) => q.eq("stateHash", args.stateHash))
      .unique();

    if (!row) {
      console.warn("[Slack:OAuthState] consumeState failed: row missing", {
        stateHashPrefix: hashPrefix(args.stateHash),
      });
      return false;
    }
    if (row.consumedAt) {
      console.warn("[Slack:OAuthState] consumeState failed: already consumed", {
        stateId: row._id,
        tenantId: row.tenantId,
        consumedAt: row.consumedAt,
      });
      return false;
    }
    if (row.nonceHash !== args.nonceHash) {
      console.warn("[Slack:OAuthState] consumeState failed: nonce mismatch", {
        stateId: row._id,
        tenantId: row.tenantId,
        expectedNonceHashPrefix: hashPrefix(row.nonceHash),
        receivedNonceHashPrefix: hashPrefix(args.nonceHash),
      });
      return false;
    }
    const now = Date.now();
    if (row.expiresAt <= now) {
      console.warn("[Slack:OAuthState] consumeState failed: expired", {
        stateId: row._id,
        tenantId: row.tenantId,
        expiresAt: row.expiresAt,
        now,
      });
      return false;
    }

    await ctx.db.patch(row._id, { consumedAt: now });
    console.log("[Slack:OAuthState] consumeState success", {
      stateId: row._id,
      tenantId: row.tenantId,
      workosUserId: row.workosUserId,
      consumedAt: now,
    });
    return true;
  },
});
