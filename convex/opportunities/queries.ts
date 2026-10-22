import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

export const getById = internalQuery({
  args: { opportunityId: v.id("opportunities") },
  handler: async (ctx, { opportunityId }) => {
    return await ctx.db.get("opportunities", opportunityId);
  },
});
