import { v } from "convex/values";
import { internal } from "../../_generated/api";
import { internalAction } from "../../_generated/server";

// One periodic owner, sequential bounded transactions, no recursive schedules.
// A crash leaves durable cursors/cleanup flags for the next sweep.
export const run = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const started = Date.now();
    const deadline = started + 60_000;
    const cleanup = internal.operations.reports.cleanup;
    await ctx.runMutation(cleanup.expireReadyJobs, {});
    for (let page = 0; page < 100 && Date.now() < started + 30_000; page++) {
      const result = await ctx.runMutation(
        cleanup.reconcileOrphanReservations,
        {},
      );
      if (!result.progressed) break;
    }
    await ctx.runMutation(
      internal.operations.reports.recovery.recoverStaleReports,
      {},
    );
    const pending = await ctx.runQuery(cleanup.pendingCleanupJobs, {
      now: Date.now(),
    });
    // Round-robin prevents one large legacy report from starving other jobs.
    for (
      let page = 0;
      page < 200 && pending.length && Date.now() < deadline;
      page++
    ) {
      const jobId = pending.shift()!;
      const result = await ctx.runMutation(cleanup.cleanupTerminalJobs, {
        jobId,
      });
      if (result.deletedChildren > 0) pending.push(jobId);
    }
    await ctx.runMutation(cleanup.purgeExpiredMetadata, {});
    return null;
  },
});
