import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

export const listExpiringInstallationIds = internalQuery({
  args: { withinMs: v.number() },
  handler: async (ctx, args) => {
    const cutoff = Date.now() + args.withinMs;
    const rows = await ctx.db
      .query("slackInstallations")
      .withIndex("by_status_and_tokenExpiresAt", (q) =>
        q.eq("status", "active").lt("tokenExpiresAt", cutoff),
      )
      .take(200);
    return rows.map((row) => row._id);
  },
});
