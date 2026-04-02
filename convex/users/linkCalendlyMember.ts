import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

/**
 * Link a CRM user to a Calendly org member.
 * Handles unlinking the previous member (if any) and linking the new one.
 *
 * Only callable by tenant_master or tenant_admin.
 */
export const linkCloserToCalendlyMember = mutation({
  args: {
    userId: v.id("users"),
    calendlyMemberId: v.union(v.id("calendlyOrgMembers"), v.null()),
  },
  handler: async (ctx, { userId, calendlyMemberId }) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    const user = await ctx.db.get(userId);
    if (!user || user.tenantId !== tenantId) {
      throw new Error("Invalid user");
    }

    if (user.role !== "closer") {
      throw new Error("Only closers can be linked to Calendly members");
    }

    // Unlink previous Calendly member (if the user was linked to someone else)
    if (user.calendlyUserUri) {
      const prevMember = await ctx.db
        .query("calendlyOrgMembers")
        .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
          q.eq("tenantId", tenantId).eq("calendlyUserUri", user.calendlyUserUri!)
        )
        .unique();
      if (prevMember) {
        await ctx.db.patch(prevMember._id, { matchedUserId: undefined });
      }
    }

    if (calendlyMemberId === null) {
      await ctx.db.patch(userId, { calendlyUserUri: undefined });
      return;
    }

    const member = await ctx.db.get(calendlyMemberId);
    if (!member || member.tenantId !== tenantId) {
      throw new Error("Invalid Calendly member");
    }

    // Ensure the Calendly member isn't already linked to a DIFFERENT user
    if (member.matchedUserId && member.matchedUserId !== userId) {
      throw new Error("This Calendly member is already linked to another user");
    }

    // Link the new Calendly member to the user
    await ctx.db.patch(userId, { calendlyUserUri: member.calendlyUserUri });
    await ctx.db.patch(calendlyMemberId, { matchedUserId: userId });
  },
});
