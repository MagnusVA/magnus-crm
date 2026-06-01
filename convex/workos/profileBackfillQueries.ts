import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

const batchSize = 10;

export const listUsersForProfileBackfill = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_tenantId_and_isActive", (q) =>
        q.eq("tenantId", args.tenantId).eq("isActive", true),
      )
      .paginate({ cursor: args.cursor, numItems: batchSize });
  },
});
