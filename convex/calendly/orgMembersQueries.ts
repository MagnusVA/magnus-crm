import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

/**
 * Get a specific Calendly org member by ID.
 * Internal query used by user management actions.
 */
export const getMember = internalQuery({
  args: { memberId: v.id("calendlyOrgMembers") },
  handler: async (ctx, { memberId }) => {
    return await ctx.db.get(memberId);
  },
});
