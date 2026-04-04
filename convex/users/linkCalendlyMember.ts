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
    console.log("[Users:CalendlyLink] linkCloserToCalendlyMember called", { userId, calendlyMemberId });
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    const user = await ctx.db.get(userId);
    console.log("[Users:CalendlyLink] user validation", { found: !!user, role: user?.role, currentCalendlyUri: !!user?.calendlyUserUri });
    if (!user || user.tenantId !== tenantId) {
      console.error("[Users:CalendlyLink] Invalid user", { userId });
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
        console.log("[Users:CalendlyLink] unlinking previous member", { prevMemberId: prevMember._id });
        await ctx.db.patch(prevMember._id, { matchedUserId: undefined });
      }
    }

    if (calendlyMemberId === null) {
      console.log("[Users:CalendlyLink] unlinking user (no new member)", { userId });
      // Clear both the URI and the denormalized name when unlinking
      await ctx.db.patch(userId, {
        calendlyUserUri: undefined,
        calendlyMemberName: undefined,
      });
      return;
    }

    const member = await ctx.db.get(calendlyMemberId);
    if (!member || member.tenantId !== tenantId) {
      console.error("[Users:CalendlyLink] Invalid Calendly member", { calendlyMemberId });
      throw new Error("Invalid Calendly member");
    }
    console.log("[Users:CalendlyLink] new member validated", { calendlyMemberId });

    // Ensure the Calendly member isn't already linked to a DIFFERENT user
    if (member.matchedUserId && member.matchedUserId !== userId) {
      console.warn("[Users:CalendlyLink] Conflict: member already linked to another user", { calendlyMemberId, existingUserId: member.matchedUserId });
      throw new Error("This Calendly member is already linked to another user");
    }

    // Link the new Calendly member to the user
    // Denormalize the Calendly member's name onto the user document to avoid
    // double-table scans in queries like listTeamMembers (see @plans/caching/caching.md)
    await ctx.db.patch(userId, {
      calendlyUserUri: member.calendlyUserUri,
      calendlyMemberName: member.name,
    });
    await ctx.db.patch(calendlyMemberId, { matchedUserId: userId });
    console.log("[Users:CalendlyLink] linked successfully", { userId, calendlyMemberId, calendlyUserUri: member.calendlyUserUri, calendlyMemberName: member.name });
  },
});
