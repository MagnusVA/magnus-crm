import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { log } from "../lib/observability/log";

/**
 * Get a specific Calendly org member by ID.
 * Internal query used by user management actions.
 */
export const getMember = internalQuery({
  args: { memberId: v.id("calendlyOrgMembers") },
  handler: async (ctx, { memberId }) => {
    const member = await ctx.db.get("calendlyOrgMembers", memberId);
    return member;
  },
});

export const listMemberUserUrisForTenant = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const members = await ctx.db
      .query("calendlyOrgMembers")
      .withIndex("by_tenantId_and_calendlyUserUri", (q) => q.eq("tenantId", tenantId))
      .take(500);

    if (members.length >= 500) {
      log.warn("calendly.org_members.list_bound_reached", {
        tenantId,
        count: members.length,
      });
    }

    return members.map((member) => member.calendlyUserUri);
  },
});
