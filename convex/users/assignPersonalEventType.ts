import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

/**
 * Assign a personal Calendly event type URI to a closer.
 * Called by admins from the Team page.
 *
 * The URI is the closer's personal Calendly booking page URL
 * (e.g., "https://calendly.com/john-doe/30min").
 * Used by createSchedulingLinkFollowUp to construct scheduling links with UTM params.
 */
export const assignPersonalEventType = mutation({
  args: {
    userId: v.id("users"),
    personalEventTypeUri: v.string(),
  },
  handler: async (ctx, { userId, personalEventTypeUri }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const targetUser = await ctx.db.get(userId);
    if (!targetUser || targetUser.tenantId !== tenantId) {
      throw new Error("User not found");
    }
    if (targetUser.role !== "closer") {
      throw new Error(
        "Personal event types can only be assigned to closers"
      );
    }

    // Basic URL validation
    try {
      const url = new URL(personalEventTypeUri);
      if (!url.hostname.includes("calendly.com")) {
        throw new Error("URL must be a Calendly booking page");
      }
    } catch (e) {
      if (
        e instanceof Error &&
        e.message === "URL must be a Calendly booking page"
      ) {
        throw e;
      }
      throw new Error("Invalid URL format");
    }

    await ctx.db.patch(userId, { personalEventTypeUri });

    console.log("[Users] assignPersonalEventType", {
      userId,
      personalEventTypeUri: personalEventTypeUri.substring(0, 60),
    });
  },
});
