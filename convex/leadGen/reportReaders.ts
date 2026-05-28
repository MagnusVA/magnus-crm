import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  getSharedDmTeam,
  type LeadGenTeamId,
  type SharedDmTeam,
} from "./sharedTeams";
import { DAILY_STATS_READ_LIMIT, ORIGIN_STATS_READ_LIMIT } from "./reportLimits";

type DailyStatsRow = Doc<"leadGenDailyStats">;
type OriginStatsRow = Doc<"leadGenOriginStats">;

export async function readLeadGenDailyRowsForDashboard(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    startDayKey: string;
    endDayKey: string;
    limit?: number;
  },
): Promise<DailyStatsRow[]> {
  const limit = args.limit ?? DAILY_STATS_READ_LIMIT;
  const rows = await ctx.db
    .query("leadGenDailyStats")
    .withIndex("by_tenantId_and_dayKey", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .gte("dayKey", args.startDayKey)
        .lte("dayKey", args.endDayKey),
    )
    .take(limit + 1);

  if (rows.length > limit) {
    throw new Error("Lead Gen range is too large. Narrow the date range.");
  }

  return rows;
}

export async function readLeadGenOriginRowsForDashboard(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    startDayKey: string;
    endDayKey: string;
    limit?: number;
  },
): Promise<OriginStatsRow[]> {
  const limit = args.limit ?? ORIGIN_STATS_READ_LIMIT;
  const rows = await ctx.db
    .query("leadGenOriginStats")
    .withIndex("by_tenantId_and_dayKey", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .gte("dayKey", args.startDayKey)
        .lte("dayKey", args.endDayKey),
    )
    .take(limit + 1);

  if (rows.length > limit) {
    throw new Error("Top posts range is too large. Narrow the date range.");
  }

  return rows;
}

export async function loadLeadGenWorkersForRows(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  rows: Pick<DailyStatsRow, "workerId">[],
) {
  const workerIds = [...new Set(rows.map((row) => row.workerId))];
  const workers = new Map<Id<"leadGenWorkers">, Doc<"leadGenWorkers">>();

  for (const workerId of workerIds) {
    const worker = await ctx.db.get(workerId);
    if (worker && worker.tenantId === tenantId) {
      workers.set(worker._id, worker);
    }
  }

  return workers;
}

export async function loadLeadGenTeamsForRows(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  rows: Pick<DailyStatsRow, "teamId">[],
) {
  const teamIds = [
    ...new Set(
      rows
        .map((row) => row.teamId)
        .filter((teamId): teamId is LeadGenTeamId => teamId !== undefined),
    ),
  ];
  const teams = new Map<LeadGenTeamId, SharedDmTeam>();

  for (const teamId of teamIds) {
    const team = await getSharedDmTeam(ctx, { tenantId, teamId });
    if (team) {
      teams.set(team._id, team);
    }
  }

  return teams;
}
