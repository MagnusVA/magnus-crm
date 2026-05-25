import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type MutationCtx } from "../_generated/server";

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;
const MAX_TARGET_WORKERS_TO_LOAD = 500;

type TargetWorkerArgs = {
  tenantId: Id<"tenants">;
  teamId: Id<"attributionTeams">;
  workerIds?: Id<"leadGenWorkers">[];
  workerEmails?: string[];
  includeInactive?: boolean;
};

type LeadGenSource = Doc<"leadGenDailyStats">["source"];

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function clampPageSize(value: number | undefined) {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isFinite(value) || value < 1) {
    throw new Error("limit must be a positive number");
  }
  return Math.min(Math.floor(value), MAX_PAGE_SIZE);
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

function matchesWorkerFilters(
  worker: Doc<"leadGenWorkers">,
  args: TargetWorkerArgs,
  workerIdFilter: Set<Id<"leadGenWorkers">> | null,
  emailFilter: Set<string> | null,
) {
  if (worker.tenantId !== args.tenantId) return false;
  if (!args.includeInactive && !worker.isActive) return false;
  if (workerIdFilter && !workerIdFilter.has(worker._id)) return false;
  if (emailFilter && !emailFilter.has(normalizeEmail(worker.email))) {
    return false;
  }
  return true;
}

async function loadTargetWorkerIds(
  ctx: MutationCtx,
  args: TargetWorkerArgs,
) {
  const workerIdFilter = args.workerIds?.length
    ? new Set(args.workerIds)
    : null;
  const emailFilter = args.workerEmails?.length
    ? new Set(args.workerEmails.map(normalizeEmail))
    : null;
  const targetWorkerIds = new Set<Id<"leadGenWorkers">>();

  if (workerIdFilter) {
    for (const workerId of workerIdFilter) {
      const worker = await ctx.db.get(workerId);
      if (!worker) {
        throw new Error(`Lead-gen worker not found: ${workerId}`);
      }
      if (
        matchesWorkerFilters(worker, args, workerIdFilter, emailFilter) &&
        (worker.teamId === undefined || worker.teamId === args.teamId)
      ) {
        targetWorkerIds.add(worker._id);
      }
    }
    return targetWorkerIds;
  }

  const workers = await ctx.db
    .query("leadGenWorkers")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId))
    .take(MAX_TARGET_WORKERS_TO_LOAD);

  for (const worker of workers) {
    if (
      matchesWorkerFilters(worker, args, null, emailFilter) &&
      (worker.teamId === undefined || worker.teamId === args.teamId)
    ) {
      targetWorkerIds.add(worker._id);
    }
  }

  return targetWorkerIds;
}

async function validateTargetTeam(
  ctx: MutationCtx,
  args: { tenantId: Id<"tenants">; teamId: Id<"attributionTeams"> },
) {
  const tenant = await ctx.db.get(args.tenantId);
  if (!tenant) {
    throw new Error("Tenant not found");
  }

  const team = await ctx.db.get(args.teamId);
  if (!team || team.tenantId !== args.tenantId) {
    throw new Error("Team not found for tenant");
  }
  if (!team.isActive) {
    throw new Error("Team must be active");
  }

  return team;
}

// Temporary operational backfill: intentionally public/non-auth-gated so it can
// be run from the Convex CLI during the Lead Gen Ops rollout.
export const backfillUnassignedWorkersToTeam = mutation({
  args: {
    tenantId: v.id("tenants"),
    teamId: v.id("attributionTeams"),
    dryRun: v.boolean(),
    limit: v.optional(v.number()),
    workersCursor: v.optional(v.string()),
    submissionsCursor: v.optional(v.string()),
    dailyStatsCursor: v.optional(v.string()),
    workerIds: v.optional(v.array(v.id("leadGenWorkers"))),
    workerEmails: v.optional(v.array(v.string())),
    includeInactive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const team = await validateTargetTeam(ctx, args);
    const pageSize = clampPageSize(args.limit);
    const workerIdFilter = args.workerIds?.length
      ? new Set(args.workerIds)
      : null;
    const emailFilter = args.workerEmails?.length
      ? new Set(args.workerEmails.map(normalizeEmail))
      : null;
    const targetWorkerIds = await loadTargetWorkerIds(ctx, args);
    const now = Date.now();

    const workersPage = await ctx.db
      .query("leadGenWorkers")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId))
      .paginate({
        numItems: pageSize,
        cursor: args.workersCursor ?? null,
      });

    const workers = {
      scanned: workersPage.page.length,
      matched: 0,
      alreadyInTeam: 0,
      skippedInactive: 0,
      skippedDifferentTeam: 0,
      updated: 0,
      wouldUpdate: 0,
    };

    for (const worker of workersPage.page) {
      if (!args.includeInactive && !worker.isActive) {
        workers.skippedInactive += 1;
        continue;
      }
      if (!matchesWorkerFilters(worker, args, workerIdFilter, emailFilter)) {
        continue;
      }
      workers.matched += 1;

      if (worker.teamId === args.teamId) {
        workers.alreadyInTeam += 1;
        continue;
      }
      if (worker.teamId !== undefined) {
        workers.skippedDifferentTeam += 1;
        continue;
      }

      if (args.dryRun) {
        workers.wouldUpdate += 1;
      } else {
        await ctx.db.patch(worker._id, {
          teamId: args.teamId,
          updatedAt: now,
        });
        workers.updated += 1;
      }
    }

    const submissionsPage = await ctx.db
      .query("leadGenSubmissions")
      .withIndex("by_tenantId_and_submittedAt", (q) =>
        q.eq("tenantId", args.tenantId),
      )
      .paginate({
        numItems: pageSize,
        cursor: args.submissionsCursor ?? null,
      });

    const submissions = {
      scanned: submissionsPage.page.length,
      missingTeam: 0,
      skippedNoTargetWorker: 0,
      skippedAlreadyAssigned: 0,
      updated: 0,
      wouldUpdate: 0,
    };

    for (const submission of submissionsPage.page) {
      if (submission.teamId !== undefined) {
        submissions.skippedAlreadyAssigned += 1;
        continue;
      }
      submissions.missingTeam += 1;

      if (!targetWorkerIds.has(submission.workerId)) {
        submissions.skippedNoTargetWorker += 1;
        continue;
      }

      if (args.dryRun) {
        submissions.wouldUpdate += 1;
      } else {
        await ctx.db.patch(submission._id, {
          teamId: args.teamId,
        });
        submissions.updated += 1;
      }
    }

    const dailyStatsPage = await ctx.db
      .query("leadGenDailyStats")
      .withIndex("by_tenantId_and_dayKey", (q) =>
        q.eq("tenantId", args.tenantId),
      )
      .paginate({
        numItems: pageSize,
        cursor: args.dailyStatsCursor ?? null,
      });

    const dailyStats = {
      scanned: dailyStatsPage.page.length,
      missingTeam: 0,
      skippedNoTargetWorker: 0,
      skippedAlreadyAssigned: 0,
      patched: 0,
      wouldPatch: 0,
      merged: 0,
      wouldMerge: 0,
    };

    for (const stat of dailyStatsPage.page) {
      if (stat.teamId !== undefined) {
        dailyStats.skippedAlreadyAssigned += 1;
        continue;
      }
      dailyStats.missingTeam += 1;

      if (!targetWorkerIds.has(stat.workerId)) {
        dailyStats.skippedNoTargetWorker += 1;
        continue;
      }

      const nextStatKey = dailyStatKey({
        dayKey: stat.dayKey,
        workerId: stat.workerId,
        teamId: args.teamId,
        source: stat.source,
      });
      const existing = await ctx.db
        .query("leadGenDailyStats")
        .withIndex("by_tenantId_and_statKey", (q) =>
          q.eq("tenantId", args.tenantId).eq("statKey", nextStatKey),
        )
        .unique();

      if (existing) {
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
          teamId: args.teamId,
          statKey: nextStatKey,
          updatedAt: now,
        });
        dailyStats.patched += 1;
      }
    }

    return {
      dryRun: args.dryRun,
      team: {
        teamId: team._id,
        displayName: team.displayName,
      },
      pageSize,
      targetWorkersLoaded: targetWorkerIds.size,
      workers,
      submissions,
      dailyStats,
      cursors: {
        workers: workersPage.isDone ? null : workersPage.continueCursor,
        submissions: submissionsPage.isDone
          ? null
          : submissionsPage.continueCursor,
        dailyStats: dailyStatsPage.isDone
          ? null
          : dailyStatsPage.continueCursor,
      },
      isDone: {
        workers: workersPage.isDone,
        submissions: submissionsPage.isDone,
        dailyStats: dailyStatsPage.isDone,
      },
    };
  },
});
