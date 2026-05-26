import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type MutationCtx } from "../_generated/server";
import {
  addBusinessDays,
  businessDateToUtcStart,
  timestampToBusinessDateKey,
} from "../reporting/lib/hondurasBusinessTime";
import { requireTenantUser } from "../requireTenantUser";
import { teamOriginStatKey } from "./aggregates";
import {
  isRankableLeadGenOrigin,
  normalizeLeadGenOrigin,
} from "./normalization";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1_000;
const TEAM_ORIGIN_REBUILD_LIMIT = 1_000;

type LeadGenSource = Doc<"leadGenDailyStats">["source"];
type LeadGenOriginKind = Doc<"leadGenSubmissions">["originKind"];
type TeamOriginStatInsert = {
  tenantId: Id<"tenants">;
  statKey: string;
  dayKey: string;
  teamId?: Id<"attributionTeams">;
  source: LeadGenSource;
  originKind: LeadGenOriginKind;
  originKey: string;
  originValue: string;
  submissions: number;
  uniqueProspectsSubmitted: number;
  updatedAt: number;
};

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

function validateTeamOriginRebuildRange(args: {
  startDayKey: string;
  endDayKey: string;
}) {
  businessDateToUtcStart(args.startDayKey);
  businessDateToUtcStart(args.endDayKey);
  if (args.startDayKey > args.endDayKey) {
    throw new Error("Start date must be on or before end date");
  }
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

async function readRankableSubmissionsForTeamOriginRange(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    startDayKey: string;
    endDayKey: string;
  },
) {
  const startTimestamp = businessDateToUtcStart(args.startDayKey);
  const endTimestamp =
    businessDateToUtcStart(addBusinessDays(args.endDayKey, 1)) - 1;
  const rows = await ctx.db
    .query("leadGenSubmissions")
    .withIndex("by_tenantId_and_submittedAt", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .gte("submittedAt", startTimestamp)
        .lte("submittedAt", endTimestamp),
    )
    .take(TEAM_ORIGIN_REBUILD_LIMIT + 1);

  if (rows.length > TEAM_ORIGIN_REBUILD_LIMIT) {
    throw new Error("Team-origin rebuild range is too large");
  }

  return rows.filter(
    (row) =>
      row.voidedAt === undefined &&
      row.originRankable &&
      row.originValue !== undefined &&
      isRankableLeadGenOrigin(row.originKind),
  );
}

function groupSubmissionsIntoTeamOriginStats(
  rows: Doc<"leadGenSubmissions">[],
  updatedAt: number,
) {
  const byStatKey = new Map<
    string,
    Omit<TeamOriginStatInsert, "uniqueProspectsSubmitted"> & {
      prospectIds: Set<Id<"leadGenProspects">>;
    }
  >();

  for (const row of rows) {
    if (!row.originValue || !isRankableLeadGenOrigin(row.originKind)) {
      continue;
    }

    const origin = normalizeLeadGenOrigin({
      originKind: row.originKind,
      originUrlOrLabel: row.originValue,
    });
    if (!origin.originKey || !origin.originValue) continue;

    const dayKey = timestampToBusinessDateKey(row.submittedAt);
    const statKey = teamOriginStatKey({
      dayKey,
      teamId: row.teamId,
      source: row.source,
      originKey: origin.originKey,
    });
    const current =
      byStatKey.get(statKey) ??
      {
        tenantId: row.tenantId,
        statKey,
        dayKey,
        teamId: row.teamId,
        source: row.source,
        originKind: row.originKind,
        originKey: origin.originKey,
        originValue: origin.originValue,
        submissions: 0,
        prospectIds: new Set<Id<"leadGenProspects">>(),
        updatedAt,
      };

    current.submissions += 1;
    current.prospectIds.add(row.prospectId);
    byStatKey.set(statKey, current);
  }

  return [...byStatKey.values()].map((row) => ({
    tenantId: row.tenantId,
    statKey: row.statKey,
    dayKey: row.dayKey,
    teamId: row.teamId,
    source: row.source,
    originKind: row.originKind,
    originKey: row.originKey,
    originValue: row.originValue,
    submissions: row.submissions,
    uniqueProspectsSubmitted: row.prospectIds.size,
    updatedAt: row.updatedAt,
  }));
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

export const rebuildTeamOriginStatsRange = mutation({
  args: {
    startDayKey: v.string(),
    endDayKey: v.string(),
    dryRun: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    validateTeamOriginRebuildRange(args);

    const existing = await ctx.db
      .query("leadGenTeamOriginStats")
      .withIndex("by_tenantId_and_dayKey", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("dayKey", args.startDayKey)
          .lte("dayKey", args.endDayKey),
      )
      .take(TEAM_ORIGIN_REBUILD_LIMIT + 1);

    if (existing.length > TEAM_ORIGIN_REBUILD_LIMIT) {
      throw new Error("Team-origin rebuild range has too many existing rows");
    }

    const submissions = await readRankableSubmissionsForTeamOriginRange(ctx, {
      tenantId,
      startDayKey: args.startDayKey,
      endDayKey: args.endDayKey,
    });
    const rebuiltRows = groupSubmissionsIntoTeamOriginStats(
      submissions,
      Date.now(),
    );

    if (!args.dryRun) {
      for (const row of existing) {
        await ctx.db.delete(row._id);
      }
      for (const row of rebuiltRows) {
        await ctx.db.insert("leadGenTeamOriginStats", row);
      }
    }

    return {
      dryRun: args.dryRun,
      deletedRows: args.dryRun ? 0 : existing.length,
      wouldDeleteRows: existing.length,
      insertedRows: args.dryRun ? 0 : rebuiltRows.length,
      wouldInsertRows: rebuiltRows.length,
      sourceSubmissions: submissions.length,
    };
  },
});
