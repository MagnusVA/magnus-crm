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
    const cutoff = Date.now() - GRACE_PERIOD_MS;

    const expired = await ctx.db
      .query("tenants")
      .withIndex("by_status_and_inviteExpiresAt", (q) =>
        q.eq("status", "pending_signup").lt("inviteExpiresAt", cutoff),
      )
      .take(500);

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
    const tenant = await ctx.db.get(tenantId);
    if (!tenant || tenant.status !== "pending_signup") return;

    await ctx.db.patch(tenantId, {
      status: "invite_expired",
      inviteTokenHash: undefined,
    });
  },
});
