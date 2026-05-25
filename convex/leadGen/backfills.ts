import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type MutationCtx } from "../_generated/server";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1_000;

type LeadGenSource = Doc<"leadGenDailyStats">["source"];

function clampLimit(value: number | undefined) {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(value) || value < 1) {
    throw new Error("limit must be a positive number");
  }
  return Math.min(Math.floor(value), MAX_LIMIT);
}

function dailyStatKey(args: {
  dayKey: string;
  workerId: Id<"leadGenWorkers">;
  teamId?: Id<"attributionTeams">;
  source: LeadGenSource;
}) {
  return [
    args.dayKey,
    args.workerId,
    args.teamId ?? "none",
    args.source,
  ].join(":");
}

async function loadWorkersById(ctx: MutationCtx, limit: number) {
  const workers = await ctx.db.query("leadGenWorkers").take(limit);
  return new Map(workers.map((worker) => [worker._id, worker]));
}

function getWorkerTeamId(
  workerById: Map<Id<"leadGenWorkers">, Doc<"leadGenWorkers">>,
  workerId: Id<"leadGenWorkers">,
) {
  return workerById.get(workerId)?.teamId;
}

// Temporary operational backfill: intentionally public/non-auth-gated so it can
// be run from the Convex CLI during the Lead Gen Ops rollout.
export const backfillUnassignedWorkersToTeam = mutation({
  args: {
    dryRun: v.boolean(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit);
    const now = Date.now();
    const workerById = await loadWorkersById(ctx, limit);

    const submissionRows = await ctx.db
      .query("leadGenSubmissions")
      .take(limit);
    const submissions = {
      scanned: submissionRows.length,
      alreadyCorrect: 0,
      missingWorker: 0,
      workerMissingTeam: 0,
      updated: 0,
      wouldUpdate: 0,
    };

    for (const submission of submissionRows) {
      const teamId = getWorkerTeamId(workerById, submission.workerId);
      if (!workerById.has(submission.workerId)) {
        submissions.missingWorker += 1;
        continue;
      }
      if (teamId === undefined) {
        submissions.workerMissingTeam += 1;
        continue;
      }
      if (submission.teamId === teamId) {
        submissions.alreadyCorrect += 1;
        continue;
      }

      if (args.dryRun) {
        submissions.wouldUpdate += 1;
      } else {
        await ctx.db.patch(submission._id, { teamId });
        submissions.updated += 1;
      }
    }

    const dailyStatsRows = await ctx.db
      .query("leadGenDailyStats")
      .take(limit);
    const dailyStats = {
      scanned: dailyStatsRows.length,
      alreadyCorrect: 0,
      missingWorker: 0,
      workerMissingTeam: 0,
      patched: 0,
      wouldPatch: 0,
      merged: 0,
      wouldMerge: 0,
    };

    for (const stat of dailyStatsRows) {
      const teamId = getWorkerTeamId(workerById, stat.workerId);
      if (!workerById.has(stat.workerId)) {
        dailyStats.missingWorker += 1;
        continue;
      }
      if (teamId === undefined) {
        dailyStats.workerMissingTeam += 1;
        continue;
      }

      const nextStatKey = dailyStatKey({
        dayKey: stat.dayKey,
        workerId: stat.workerId,
        teamId,
        source: stat.source,
      });
      if (stat.teamId === teamId && stat.statKey === nextStatKey) {
        dailyStats.alreadyCorrect += 1;
        continue;
      }

      const existing = await ctx.db
        .query("leadGenDailyStats")
        .withIndex("by_tenantId_and_statKey", (q) =>
          q.eq("tenantId", stat.tenantId).eq("statKey", nextStatKey),
        )
        .unique();

      if (existing && existing._id !== stat._id) {
        if (args.dryRun) {
          dailyStats.wouldMerge += 1;
        } else {
          await ctx.db.patch(existing._id, {
            submissions: existing.submissions + stat.submissions,
            uniqueProspectsSubmitted:
              existing.uniqueProspectsSubmitted +
              stat.uniqueProspectsSubmitted,
            duplicateProspectSubmissions:
              existing.duplicateProspectSubmissions +
              stat.duplicateProspectSubmissions,
            scheduledHours: Math.max(
              existing.scheduledHours,
              stat.scheduledHours,
            ),
            updatedAt: now,
          });
          await ctx.db.delete(stat._id);
          dailyStats.merged += 1;
        }
        continue;
      }

      if (args.dryRun) {
        dailyStats.wouldPatch += 1;
      } else {
        await ctx.db.patch(stat._id, {
          teamId,
          statKey: nextStatKey,
          updatedAt: now,
        });
        dailyStats.patched += 1;
      }
    }

    return {
      dryRun: args.dryRun,
      limit,
      workersLoaded: workerById.size,
      submissions,
      dailyStats,
    };
  },
});
