import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

/**
 * Grace period after invite expiry before marking as expired.
 * Gives admins time to notice and regenerate.
 */
const GRACE_PERIOD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export const listExpiredInvites = internalQuery({
  args: {},
  handler: async (ctx) => {
    console.log("[invite-cleanup] listExpiredInvites called");
    const cutoff = Date.now() - GRACE_PERIOD_MS;
    console.log("[invite-cleanup] listExpiredInvites cutoff", {
      cutoff,
      gracePeriodDays: 14,
    });

    const expired = await ctx.db
      .query("tenants")
      .withIndex("by_status_and_inviteExpiresAt", (q) =>
        q.eq("status", "pending_signup").lt("inviteExpiresAt", cutoff),
      )
      .take(500);

    console.log("[invite-cleanup] listExpiredInvites completed", {
      resultCount: expired.length,
    });

    return expired.map((t) => ({
      tenantId: t._id,
      companyName: t.companyName,
      inviteExpiresAt: t.inviteExpiresAt,
    }));
  },
});

export const markInviteExpired = internalMutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    console.log("[invite-cleanup] markInviteExpired called", { tenantId });
    const tenant = await ctx.db.get(tenantId);
    if (!tenant || tenant.status !== "pending_signup") {
      console.warn("[invite-cleanup] markInviteExpired skipped", {
        tenantId,
        found: Boolean(tenant),
        status: tenant?.status ?? "n/a",
      });
      return;
    }

    await ctx.db.patch(tenantId, {
      status: "invite_expired",
      inviteTokenHash: undefined,
    });
    console.log("[invite-cleanup] markInviteExpired completed", { tenantId });
  },
});
