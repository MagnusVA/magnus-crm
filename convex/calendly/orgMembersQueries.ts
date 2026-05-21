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

export const listMemberUserUrisForTenant = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const members = await ctx.db
      .query("calendlyOrgMembers")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(500);

    if (members.length >= 500) {
      console.warn("[org-sync] listMemberUserUrisForTenant reached MVP bound", {
        tenantId,
        count: members.length,
      });
    }

    return members.map((member) => member.calendlyUserUri);
  },
});
