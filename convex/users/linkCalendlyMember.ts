import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { rejectRequest } from "../lib/observability/errors";
import { log } from "../lib/observability/log";
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

    const user = await ctx.db.get("users", userId);
    if (!user || user.tenantId !== tenantId) {
      throw new Error("Invalid user");
    }

    if (user.role !== "closer") {
      throw new Error("Only closers can be linked to Calendly members");
    }

    // Unlink previous Calendly member (if the user was linked to someone else)
    let previousMemberId: string | undefined;
    if (user.calendlyUserUri) {
      const prevMember = await ctx.db
        .query("calendlyOrgMembers")
        .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
          q.eq("tenantId", tenantId).eq("calendlyUserUri", user.calendlyUserUri!)
        )
        .unique();
      if (prevMember) {
        previousMemberId = prevMember._id;
        await ctx.db.patch("calendlyOrgMembers", prevMember._id, { matchedUserId: undefined });
      }
    }

    if (calendlyMemberId === null) {
      // Clear both the URI and the denormalized name when unlinking
      await ctx.db.patch("users", userId, {
        calendlyUserUri: undefined,
        calendlyMemberName: undefined,
      });
      log.info("user.calendly_member.unlinked", {
        tenantId,
        userId,
        previousMemberId,
        reason: "admin_unlinked",
      });
      return;
    }

    const member = await ctx.db.get("calendlyOrgMembers", calendlyMemberId);
    if (!member || member.tenantId !== tenantId) {
      throw new Error("Invalid Calendly member");
    }

    // Ensure the Calendly member isn't already linked to a DIFFERENT user
    if (member.matchedUserId && member.matchedUserId !== userId) {
      throw rejectRequest(
        "calendly_member.already_linked",
        "This Calendly member is already linked to another user",
        {
          tenantId,
          userId,
          calendlyMemberId,
          existingUserId: member.matchedUserId,
        },
      );
    }

    // Link the new Calendly member to the user
    // Denormalize the Calendly member's name onto the user document to avoid
    // double-table scans in queries like listTeamMembers
    await ctx.db.patch("users", userId, {
      calendlyUserUri: member.calendlyUserUri,
      calendlyMemberName: member.name,
    });
    await ctx.db.patch("calendlyOrgMembers", calendlyMemberId, { matchedUserId: userId });
    log.info("user.calendly_member.linked", {
      tenantId,
      userId,
      calendlyMemberId,
      previousMemberId,
      source: "admin_link",
    });
  },
});
