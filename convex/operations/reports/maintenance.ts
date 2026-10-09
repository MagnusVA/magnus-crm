import { v } from "convex/values";
import { internal } from "../../_generated/api";
import { internalAction } from "../../_generated/server";
import { log, reportError } from "../../lib/observability/log";

type MaintenanceStep =
  | "expire_ready_jobs"
  | "reconcile_orphan_reservations"
  | "recover_stale_reports"
  | "cleanup_terminal_jobs"
  | "purge_expired_metadata";

// One periodic owner, sequential bounded transactions, no recursive schedules.
// A crash leaves durable cursors/cleanup flags for the next sweep. Each step
// runs even when an earlier one fails, so one stuck step doesn't block the
// rest of the sweep.
export const run = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const started = Date.now();
    const deadline = started + 60_000;
    const cleanup = internal.operations.reports.cleanup;
    const failedSteps: MaintenanceStep[] = [];
    const counts = {
      expired: 0,
      reservationsReconciled: 0,
      recovered: 0,
      cleanupPasses: 0,
      childrenDeleted: 0,
      purged: 0,
    };

    async function step(name: MaintenanceStep, fn: () => Promise<void>) {
      try {
        await fn();
      } catch (error) {
        failedSteps.push(name);
        reportError("reports.maintenance.step_failed", error, {
          fingerprint: `reports.maintenance.step_failed:${name}`,
          step: name,
        });
      }
    }

    await step("expire_ready_jobs", async () => {
      const result = await ctx.runMutation(cleanup.expireReadyJobs, {});
      counts.expired = result.expired;
    });

    await step("reconcile_orphan_reservations", async () => {
      for (
        let page = 0;
        page < 100 && Date.now() < started + 30_000;
        page++
      ) {
        const result = await ctx.runMutation(
          cleanup.reconcileOrphanReservations,
          {},
        );
        if (!result.progressed) break;
        counts.reservationsReconciled += result.examined;
      }
    });

    await step("recover_stale_reports", async () => {
      const result = await ctx.runMutation(
        internal.operations.reports.recovery.recoverStaleReports,
        {},
      );
      counts.recovered = result.recovered;
    });

    await step("cleanup_terminal_jobs", async () => {
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
        counts.cleanupPasses += result.examined;
        counts.childrenDeleted += result.deletedChildren;
        if (result.deletedChildren > 0) pending.push(jobId);
      }
    });

    await step("purge_expired_metadata", async () => {
      const result = await ctx.runMutation(cleanup.purgeExpiredMetadata, {});
      counts.purged = result.purged;
    });

    const workHappened = Object.values(counts).some((count) => count > 0);
    if (workHappened || failedSteps.length > 0) {
      log.info("reports.maintenance.completed", {
        ...counts,
        failedSteps,
        durationMs: Date.now() - started,
      });
    }
    return null;
  },
});
