"use node";

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

export const cleanupExpiredInvites = internalAction({
  args: {},
  handler: async (ctx) => {
    console.log("[invite-cleanup] cleanupExpiredInvites started");

    const expired = await ctx.runQuery(
      internal.admin.inviteCleanupMutations.listExpiredInvites,
    );

    console.log("[invite-cleanup] Expired invites found", {
      totalCount: expired.length,
    });

    for (const { tenantId, companyName } of expired) {
      await ctx.runMutation(
        internal.admin.inviteCleanupMutations.markInviteExpired,
        { tenantId },
      );
      console.log(
        `[invite-cleanup] Marked invite expired for "${companyName}" (${tenantId})`,
      );
    }

    if (expired.length > 0) {
      console.log(
        `[invite-cleanup] Processed ${expired.length} expired invites.`,
      );
    }
  },
});
