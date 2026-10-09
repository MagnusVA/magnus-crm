"use node";

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { log } from "../lib/observability/log";

export const cleanupExpiredInvites = internalAction({
  args: {},
  handler: async (ctx) => {
    const startedAt = Date.now();

    const expired = await ctx.runQuery(
      internal.admin.inviteCleanupMutations.listExpiredInvites,
    );

    for (const { tenantId } of expired) {
      await ctx.runMutation(
        internal.admin.inviteCleanupMutations.markInviteExpired,
        { tenantId },
      );
    }

    log.info("tenant.invite_cleanup.completed", {
      expiredCount: expired.length,
      durationMs: Date.now() - startedAt,
    });
  },
});
