import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

/**
 * Get a specific Calendly org member by ID.
 * Internal query used by user management actions.
 */
export const getMember = internalQuery({
  args: { memberId: v.id("calendlyOrgMembers") },
  handler: async (ctx, { memberId }) => {
    console.log(`[org-sync] getMember: looking up memberId=${memberId}`);
    const member = await ctx.db.get(memberId);
    console.log(`[org-sync] getMember: memberId=${memberId}, found=${Boolean(member)}`);
    return member;
  },
});
