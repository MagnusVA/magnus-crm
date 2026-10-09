import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { log } from "../lib/observability/log";

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
    const tenant = await ctx.db.get("tenants", tenantId);
    if (!tenant || tenant.status !== "pending_signup") {
      log.warn("tenant.invite_cleanup.skipped", {
        tenantId,
        reason: tenant ? "status_changed" : "tenant_missing",
        status: tenant?.status,
      });
      return;
    }

    await ctx.db.patch("tenants", tenantId, {
      status: "invite_expired",
      inviteTokenHash: undefined,
    });
  },
});
