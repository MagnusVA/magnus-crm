import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import {
  addBusinessDays,
  businessDateToUtcStart,
  countBusinessDays,
  timestampToBusinessDateKey,
} from "../reporting/lib/hondurasBusinessTime";
import { requireTenantUser } from "../requireTenantUser";
import {
  isRankableLeadGenOrigin,
  normalizeLeadGenOrigin,
} from "./normalization";
import {
  getSharedDmTeam,
  type LeadGenTeamId,
  type SharedDmTeam,
} from "./sharedTeams";
import {
  loadCurrentScheduledHoursByWorkerDay,
  scheduledHoursForDailyStat,
} from "./schedules";
import { leadGenSourceValidator } from "./validators";

type LeadGenSource = Doc<"leadGenDailyStats">["source"];
type DailyStatsRow = Doc<"leadGenDailyStats">;
type SubmissionRow = Doc<"leadGenSubmissions">;
type TeamOriginStatsRow = Doc<"leadGenTeamOriginStats">;

const DAILY_STATS_READ_LIMIT = 500;
const ORIGIN_STATS_READ_LIMIT = 500;
const ORIGIN_SUBMISSIONS_READ_LIMIT = 5000;
const TEAM_ORIGIN_STATS_READ_LIMIT = 1000;
const MAX_REPORT_DAYS = 120;
const MAX_TOP_ORIGINS = 25;
const MAX_TOP_ORIGINS_PER_TEAM = 10;
const LEAD_GEN_SOURCES: LeadGenSource[] = ["instagram", "meta_business"];

const reportFiltersValidator = {
  startDayKey: v.string(),
  endDayKey: v.string(),
  teamId: v.optional(v.id("attributionTeams")),
  workerId: v.optional(v.id("leadGenWorkers")),
  source: v.optional(leadGenSourceValidator),
};

function validateDayRange(args: { startDayKey: string; endDayKey: string }) {
  businessDateToUtcStart(args.startDayKey);
  businessDateToUtcStart(args.endDayKey);
  if (args.startDayKey > args.endDayKey) {
    throw new Error("Start date must be on or before end date");
  }

  const days = countBusinessDays(
    args.startDayKey,
    addBusinessDays(args.endDayKey, 1),
  );
  if (days > MAX_REPORT_DAYS) {
    throw new Error(`Report date range cannot exceed ${MAX_REPORT_DAYS} days`);
  }
}

function normalizeLimit(limit: number | undefined, max: number) {
  if (limit === undefined) return max;
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new Error(`Limit must be an integer between 1 and ${max}`);
  }
  return limit;
}

async function validateFilterIds(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    teamId?: LeadGenTeamId;
    workerId?: Id<"leadGenWorkers">;
  },
) {
  if (args.teamId) {
    const team = await getSharedDmTeam(ctx, {
      tenantId: args.tenantId,
      teamId: args.teamId,
    });
    if (!team) {
      throw new Error("DM team not found");
    }
  }

  if (args.workerId) {
    const worker = await ctx.db.get(args.workerId);
    if (!worker || worker.tenantId !== args.tenantId) {
      throw new Error("Lead-gen worker not found");
    }
  }
}

function filterDailyStatsRows(
  rows: DailyStatsRow[],
  args: {
    teamId?: LeadGenTeamId;
    workerId?: Id<"leadGenWorkers">;
    source?: LeadGenSource;
  },
) {
  return rows.filter((row) => {
    if (args.teamId && row.teamId !== args.teamId) return false;
    if (args.workerId && row.workerId !== args.workerId) return false;
    if (args.source && row.source !== args.source) return false;
    return true;
  });
}

function filterTopOriginSubmissionRows(
  rows: SubmissionRow[],
  args: {
    teamId?: LeadGenTeamId;
    workerId?: Id<"leadGenWorkers">;
    source?: LeadGenSource;
  },
) {
  return rows.filter((row) => {
    if (row.voidedAt !== undefined) return false;
    if (!row.originRankable || !row.originValue) return false;
    if (!isRankableLeadGenOrigin(row.originKind)) return false;
    if (args.teamId && row.teamId !== args.teamId) return false;
    if (args.workerId && row.workerId !== args.workerId) return false;
    if (args.source && row.source !== args.source) return false;
    return true;
  });
}

function normalizeTopOriginSubmission(row: SubmissionRow) {
  try {
    return normalizeLeadGenOrigin({
      originKind: row.originKind,
      originUrlOrLabel: row.originValue,
    });
  } catch {
    return {};
  }
}

async function readDailyStatsRows(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    startDayKey: string;
    endDayKey: string;
    teamId?: LeadGenTeamId;
    workerId?: Id<"leadGenWorkers">;
    source?: LeadGenSource;
    limit: number;
  },
) {
  const readLimit = args.limit + 1;
  let rows: DailyStatsRow[];

  if (args.workerId) {
    rows = await ctx.db
      .query("leadGenDailyStats")
      .withIndex("by_tenantId_and_workerId_and_dayKey", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("workerId", args.workerId!)
          .gte("dayKey", args.startDayKey)
          .lte("dayKey", args.endDayKey),
      )
      .take(readLimit);
  } else if (args.teamId) {
    rows = await ctx.db
      .query("leadGenDailyStats")
      .withIndex("by_tenantId_and_teamId_and_dayKey", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("teamId", args.teamId!)
          .gte("dayKey", args.startDayKey)
          .lte("dayKey", args.endDayKey),
      )
      .take(readLimit);
  } else if (args.source) {
    rows = await ctx.db
      .query("leadGenDailyStats")
      .withIndex("by_tenantId_and_source_and_dayKey", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("source", args.source!)
          .gte("dayKey", args.startDayKey)
          .lte("dayKey", args.endDayKey),
      )
      .take(readLimit);
  } else {
    rows = await ctx.db
      .query("leadGenDailyStats")
      .withIndex("by_tenantId_and_dayKey", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .gte("dayKey", args.startDayKey)
          .lte("dayKey", args.endDayKey),
      )
      .take(readLimit);
  }

  if (rows.length > args.limit) {
    throw new Error("Report range is too large. Narrow the filters.");
  }

  return filterDailyStatsRows(rows, args);
}

async function readTopOriginSubmissionRows(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    startDayKey: string;
    endDayKey: string;
    teamId?: LeadGenTeamId;
    workerId?: Id<"leadGenWorkers">;
    source?: LeadGenSource;
  },
) {
  const startTimestamp = businessDateToUtcStart(args.startDayKey);
  const endTimestamp =
    businessDateToUtcStart(addBusinessDays(args.endDayKey, 1)) - 1;
  const readLimit = ORIGIN_SUBMISSIONS_READ_LIMIT + 1;
  let rows: SubmissionRow[];

  if (args.workerId) {
    rows = await ctx.db
      .query("leadGenSubmissions")
      .withIndex("by_tenantId_and_workerId_and_submittedAt", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("workerId", args.workerId!)
          .gte("submittedAt", startTimestamp)
          .lte("submittedAt", endTimestamp),
      )
      .take(readLimit);
  } else if (args.teamId) {
    rows = await ctx.db
      .query("leadGenSubmissions")
      .withIndex("by_tenantId_and_teamId_and_submittedAt", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("teamId", args.teamId!)
          .gte("submittedAt", startTimestamp)
          .lte("submittedAt", endTimestamp),
      )
      .take(readLimit);
  } else if (args.source) {
    rows = await ctx.db
      .query("leadGenSubmissions")
      .withIndex("by_tenantId_and_source_and_submittedAt", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("source", args.source!)
          .gte("submittedAt", startTimestamp)
          .lte("submittedAt", endTimestamp),
      )
      .take(readLimit);
  } else {
    rows = await ctx.db
      .query("leadGenSubmissions")
      .withIndex("by_tenantId_and_submittedAt", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .gte("submittedAt", startTimestamp)
          .lte("submittedAt", endTimestamp),
      )
      .take(readLimit);
  }

  if (rows.length > ORIGIN_SUBMISSIONS_READ_LIMIT) {
    throw new Error("Origin report range is too large. Narrow the filters.");
  }

  return filterTopOriginSubmissionRows(rows, args);
}

function summarizeRows(
  rows: DailyStatsRow[],
  currentScheduledHoursByWorkerDay: Map<string, number>,
) {
  const scheduledHoursByWorkerDay = new Map<string, number>();
  const totals = {
    submissions: 0,
    uniqueProspects: 0,
    duplicates: 0,
  };

  for (const row of rows) {
    totals.submissions += row.submissions;
    totals.uniqueProspects += row.uniqueProspectsSubmitted;
    totals.duplicates += row.duplicateProspectSubmissions;

    const scheduledKey = `${row.workerId}:${row.dayKey}`;
    if (!scheduledHoursByWorkerDay.has(scheduledKey)) {
      scheduledHoursByWorkerDay.set(
        scheduledKey,
        scheduledHoursForDailyStat(row, currentScheduledHoursByWorkerDay),
      );
    }
  }

  const scheduledHours = [...scheduledHoursByWorkerDay.values()].reduce(
    (sum, hours) => sum + hours,
    0,
  );

  return {
    ...totals,
    scheduledHours,
    leadsPerHour:
      scheduledHours > 0 ? totals.submissions / scheduledHours : null,
  };
}

async function loadWorkers(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  workerIds: Id<"leadGenWorkers">[],
) {
  const workers = new Map<Id<"leadGenWorkers">, Doc<"leadGenWorkers">>();
  for (const workerId of workerIds) {
    const worker = await ctx.db.get(workerId);
    if (worker && worker.tenantId === tenantId) {
      workers.set(worker._id, worker);
    }
  }
  return workers;
}

async function loadTeams(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  teamIds: LeadGenTeamId[],
) {
  const teams = new Map<LeadGenTeamId, SharedDmTeam>();
  for (const teamId of teamIds) {
    const team = await getSharedDmTeam(ctx, { tenantId, teamId });
    if (team) {
      teams.set(team._id, team);
    }
  }
  return teams;
}

function isRankableOriginKind(
  originKind: Doc<"leadGenSubmissions">["originKind"],
): originKind is "post" | "reel" {
  return originKind === "post" || originKind === "reel";
}

function compareTopOriginRows(
  a: {
    uniqueProspects: number;
    submissions: number;
    originValue: string;
  },
  b: {
    uniqueProspects: number;
    submissions: number;
    originValue: string;
  },
) {
  if (a.uniqueProspects !== b.uniqueProspects) {
    return b.uniqueProspects - a.uniqueProspects;
  }
  if (a.submissions !== b.submissions) {
    return b.submissions - a.submissions;
  }
  return a.originValue.localeCompare(b.originValue);
}

async function readTeamOriginStatRows(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    startDayKey: string;
    endDayKey: string;
    teamId?: LeadGenTeamId;
    source?: LeadGenSource;
    limit: number;
  },
) {
  const readLimit = args.limit + 1;
  let rows: TeamOriginStatsRow[];

  if (args.teamId && args.source) {
    rows = await ctx.db
      .query("leadGenTeamOriginStats")
      .withIndex("by_tenantId_and_teamId_and_source_and_dayKey", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("teamId", args.teamId!)
          .eq("source", args.source!)
          .gte("dayKey", args.startDayKey)
          .lte("dayKey", args.endDayKey),
      )
      .take(readLimit);
  } else if (args.teamId) {
    rows = await ctx.db
      .query("leadGenTeamOriginStats")
      .withIndex("by_tenantId_and_teamId_and_dayKey", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("teamId", args.teamId!)
          .gte("dayKey", args.startDayKey)
          .lte("dayKey", args.endDayKey),
      )
      .take(readLimit);
  } else if (args.source) {
    rows = await ctx.db
      .query("leadGenTeamOriginStats")
      .withIndex("by_tenantId_and_source_and_dayKey", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("source", args.source!)
          .gte("dayKey", args.startDayKey)
          .lte("dayKey", args.endDayKey),
      )
      .take(readLimit);
  } else {
    rows = await ctx.db
      .query("leadGenTeamOriginStats")
      .withIndex("by_tenantId_and_dayKey", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .gte("dayKey", args.startDayKey)
          .lte("dayKey", args.endDayKey),
      )
      .take(readLimit);
  }

  if (rows.length > args.limit) {
    throw new Error(
      "Posts by team report is too large. Narrow the filters.",
    );
  }

  return rows.filter((row) => isRankableOriginKind(row.originKind));
}

async function groupTeamOriginRows(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    rows: TeamOriginStatsRow[];
    limitPerTeam: number;
  },
) {
  const byTeam = new Map<
    string,
    {
      teamId: LeadGenTeamId | null;
      totalUniqueProspects: number;
      totalSubmissions: number;
      origins: Map<
        string,
        {
          originKey: string;
          source: LeadGenSource;
          originKind: "post" | "reel";
          originValue: string;
          uniqueProspects: number;
          submissions: number;
          dayCount: number;
        }
      >;
    }
  >();

  for (const row of args.rows) {
    if (!isRankableOriginKind(row.originKind)) continue;

    const teamKey = row.teamId ?? "unassigned";
    const currentTeam =
      byTeam.get(teamKey) ??
      {
        teamId: row.teamId ?? null,
        totalUniqueProspects: 0,
        totalSubmissions: 0,
        origins: new Map(),
      };

    const originMapKey = `${row.source}:${row.originKey}`;
    const currentOrigin =
      currentTeam.origins.get(originMapKey) ??
      {
        originKey: row.originKey,
        source: row.source,
        originKind: row.originKind,
        originValue: row.originValue,
        uniqueProspects: 0,
        submissions: 0,
        dayCount: 0,
      };

    currentOrigin.uniqueProspects += row.uniqueProspectsSubmitted;
    currentOrigin.submissions += row.submissions;
    currentOrigin.dayCount += 1;
    currentTeam.totalUniqueProspects += row.uniqueProspectsSubmitted;
    currentTeam.totalSubmissions += row.submissions;
    currentTeam.origins.set(originMapKey, currentOrigin);
    byTeam.set(teamKey, currentTeam);
  }

  const teamIds = [...byTeam.values()]
    .map((row) => row.teamId)
    .filter((teamId): teamId is LeadGenTeamId => teamId !== null);
  const teams = await loadTeams(ctx, args.tenantId, teamIds);

  return [...byTeam.values()]
    .map((row) => {
      const team = row.teamId ? teams.get(row.teamId) : null;
      return {
        teamId: row.teamId,
        teamName: team?.name ?? "Unassigned",
        isActive: team?.isActive ?? (row.teamId ? false : null),
        totalUniqueProspects: row.totalUniqueProspects,
        totalSubmissions: row.totalSubmissions,
        origins: [...row.origins.values()]
          .sort(compareTopOriginRows)
          .slice(0, args.limitPerTeam),
      };
    })
    .sort((a, b) => {
      if (a.totalUniqueProspects !== b.totalUniqueProspects) {
        return b.totalUniqueProspects - a.totalUniqueProspects;
      }
      if (a.totalSubmissions !== b.totalSubmissions) {
        return b.totalSubmissions - a.totalSubmissions;
      }
      return a.teamName.localeCompare(b.teamName);
    });
}

async function listTopOriginsByTeamFromBoundedSubmissions(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    startDayKey: string;
    endDayKey: string;
    teamId?: LeadGenTeamId;
    workerId?: Id<"leadGenWorkers">;
    source?: LeadGenSource;
    limitPerTeam: number;
  },
) {
  const rows = await readTopOriginSubmissionRows(ctx, args);
  const byTeam = new Map<
    string,
    {
      teamId: LeadGenTeamId | null;
      origins: Map<
        string,
        {
          originKey: string;
          source: LeadGenSource;
          originKind: "post" | "reel";
          originValue: string;
          submissions: number;
          uniqueProspectDayKeys: Set<string>;
          dayKeys: Set<string>;
        }
      >;
    }
  >();

  for (const row of rows) {
    if (!isRankableOriginKind(row.originKind)) continue;
    const origin = normalizeTopOriginSubmission(row);
    if (!origin.originKey || !origin.originValue) continue;

    const teamKey = row.teamId ?? "unassigned";
    const currentTeam =
      byTeam.get(teamKey) ??
      {
        teamId: row.teamId ?? null,
        origins: new Map(),
      };
    const originMapKey = `${row.source}:${origin.originKey}`;
    const currentOrigin =
      currentTeam.origins.get(originMapKey) ??
      {
        originKey: origin.originKey,
        source: row.source,
        originKind: row.originKind,
        originValue: origin.originValue,
        submissions: 0,
        uniqueProspectDayKeys: new Set<string>(),
        dayKeys: new Set<string>(),
      };
    const dayKey = timestampToBusinessDateKey(row.submittedAt);

    currentOrigin.submissions += 1;
    currentOrigin.uniqueProspectDayKeys.add(`${row.prospectId}:${dayKey}`);
    currentOrigin.dayKeys.add(dayKey);
    currentTeam.origins.set(originMapKey, currentOrigin);
    byTeam.set(teamKey, currentTeam);
  }

  const teamIds = [...byTeam.values()]
    .map((row) => row.teamId)
    .filter((teamId): teamId is LeadGenTeamId => teamId !== null);
  const teams = await loadTeams(ctx, args.tenantId, teamIds);

  return [...byTeam.values()]
    .map((row) => {
      const team = row.teamId ? teams.get(row.teamId) : null;
      const origins = [...row.origins.values()]
        .map((origin) => ({
          originKey: origin.originKey,
          source: origin.source,
          originKind: origin.originKind,
          originValue: origin.originValue,
          uniqueProspects: origin.uniqueProspectDayKeys.size,
          submissions: origin.submissions,
          dayCount: origin.dayKeys.size,
        }))
        .sort(compareTopOriginRows);

      return {
        teamId: row.teamId,
        teamName: team?.name ?? "Unassigned",
        isActive: team?.isActive ?? (row.teamId ? false : null),
        totalUniqueProspects: origins.reduce(
          (sum, origin) => sum + origin.uniqueProspects,
          0,
        ),
        totalSubmissions: origins.reduce(
          (sum, origin) => sum + origin.submissions,
          0,
        ),
        origins: origins.slice(0, args.limitPerTeam),
      };
    })
    .sort((a, b) => {
      if (a.totalUniqueProspects !== b.totalUniqueProspects) {
        return b.totalUniqueProspects - a.totalUniqueProspects;
      }
      if (a.totalSubmissions !== b.totalSubmissions) {
        return b.totalSubmissions - a.totalSubmissions;
      }
      return a.teamName.localeCompare(b.teamName);
    });
}

export const getOverview = query({
  args: reportFiltersValidator,
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    validateDayRange(args);
    await validateFilterIds(ctx, { tenantId, ...args });
    const rows = await readDailyStatsRows(ctx, {
      tenantId,
      ...args,
      limit: DAILY_STATS_READ_LIMIT,
    });
    const currentScheduledHoursByWorkerDay =
      await loadCurrentScheduledHoursByWorkerDay(ctx, { tenantId, rows });

    return summarizeRows(rows, currentScheduledHoursByWorkerDay);
  },
});

export const listWorkerPerformance = query({
  args: reportFiltersValidator,
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    validateDayRange(args);
    await validateFilterIds(ctx, { tenantId, ...args });
    const rows = await readDailyStatsRows(ctx, {
      tenantId,
      ...args,
      limit: DAILY_STATS_READ_LIMIT,
    });
    const currentScheduledHoursByWorkerDay =
      await loadCurrentScheduledHoursByWorkerDay(ctx, { tenantId, rows });

    const byWorker = new Map<
      Id<"leadGenWorkers">,
      {
        workerId: Id<"leadGenWorkers">;
        submissions: number;
        uniqueProspects: number;
        duplicates: number;
        scheduledHours: number;
        scheduledKeys: Set<string>;
      }
    >();

    for (const row of rows) {
      const current =
        byWorker.get(row.workerId) ??
        {
          workerId: row.workerId,
          submissions: 0,
          uniqueProspects: 0,
          duplicates: 0,
          scheduledHours: 0,
          scheduledKeys: new Set<string>(),
        };

      current.submissions += row.submissions;
      current.uniqueProspects += row.uniqueProspectsSubmitted;
      current.duplicates += row.duplicateProspectSubmissions;

      const scheduledKey = `${row.workerId}:${row.dayKey}`;
      if (!current.scheduledKeys.has(scheduledKey)) {
        current.scheduledKeys.add(scheduledKey);
        current.scheduledHours += scheduledHoursForDailyStat(
          row,
          currentScheduledHoursByWorkerDay,
        );
      }

      byWorker.set(row.workerId, current);
    }

    const workers = await loadWorkers(ctx, tenantId, [...byWorker.keys()]);
    return [...byWorker.values()]
      .map((row) => {
        const worker = workers.get(row.workerId);
        return {
          workerId: row.workerId,
          displayName: worker?.displayName ?? worker?.email ?? "Unknown worker",
          email: worker?.email ?? null,
          teamId: worker?.teamId ?? null,
          isActive: worker?.isActive ?? false,
          submissions: row.submissions,
          uniqueProspects: row.uniqueProspects,
          duplicates: row.duplicates,
          scheduledHours: row.scheduledHours,
          leadsPerHour:
            row.scheduledHours > 0
              ? row.submissions / row.scheduledHours
              : null,
        };
      })
      .sort((a, b) => b.submissions - a.submissions);
  },
});

export const listTeamPerformance = query({
  args: reportFiltersValidator,
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    validateDayRange(args);
    await validateFilterIds(ctx, { tenantId, ...args });
    const rows = await readDailyStatsRows(ctx, {
      tenantId,
      ...args,
      limit: DAILY_STATS_READ_LIMIT,
    });
    const currentScheduledHoursByWorkerDay =
      await loadCurrentScheduledHoursByWorkerDay(ctx, { tenantId, rows });

    const byTeam = new Map<
      string,
      {
        teamId: LeadGenTeamId | null;
        submissions: number;
        uniqueProspects: number;
        duplicates: number;
        scheduledHours: number;
        workerIds: Set<Id<"leadGenWorkers">>;
        scheduledKeys: Set<string>;
      }
    >();

    for (const row of rows) {
      const teamKey = row.teamId ?? "unassigned";
      const current =
        byTeam.get(teamKey) ??
        {
          teamId: row.teamId ?? null,
          submissions: 0,
          uniqueProspects: 0,
          duplicates: 0,
          scheduledHours: 0,
          workerIds: new Set<Id<"leadGenWorkers">>(),
          scheduledKeys: new Set<string>(),
        };

      current.submissions += row.submissions;
      current.uniqueProspects += row.uniqueProspectsSubmitted;
      current.duplicates += row.duplicateProspectSubmissions;
      current.workerIds.add(row.workerId);

      const scheduledKey = `${teamKey}:${row.workerId}:${row.dayKey}`;
      if (!current.scheduledKeys.has(scheduledKey)) {
        current.scheduledKeys.add(scheduledKey);
        current.scheduledHours += scheduledHoursForDailyStat(
          row,
          currentScheduledHoursByWorkerDay,
        );
      }

      byTeam.set(teamKey, current);
    }

    const teamIds = [...byTeam.values()]
      .map((row) => row.teamId)
      .filter((teamId): teamId is LeadGenTeamId => teamId !== null);
    const teams = await loadTeams(ctx, tenantId, teamIds);

    return [...byTeam.values()]
      .map((row) => {
        const team = row.teamId ? teams.get(row.teamId) : null;
        return {
          teamId: row.teamId,
          teamName: team?.name ?? "Unassigned",
          isActive: team?.isActive ?? (row.teamId ? false : null),
          workerCount: row.workerIds.size,
          submissions: row.submissions,
          uniqueProspects: row.uniqueProspects,
          duplicates: row.duplicates,
          scheduledHours: row.scheduledHours,
          leadsPerHour:
            row.scheduledHours > 0
              ? row.submissions / row.scheduledHours
              : null,
        };
      })
      .sort((a, b) => b.submissions - a.submissions);
  },
});

export const listSourcePerformance = query({
  args: reportFiltersValidator,
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    validateDayRange(args);
    await validateFilterIds(ctx, { tenantId, ...args });
    const rows = await readDailyStatsRows(ctx, {
      tenantId,
      ...args,
      limit: DAILY_STATS_READ_LIMIT,
    });
    const currentScheduledHoursByWorkerDay =
      await loadCurrentScheduledHoursByWorkerDay(ctx, { tenantId, rows });

    const bySource = new Map<
      LeadGenSource,
      {
        source: LeadGenSource;
        submissions: number;
        uniqueProspects: number;
        duplicates: number;
        scheduledHours: number;
        scheduledKeys: Set<string>;
      }
    >();

    for (const source of LEAD_GEN_SOURCES) {
      if (!args.source || args.source === source) {
        bySource.set(source, {
          source,
          submissions: 0,
          uniqueProspects: 0,
          duplicates: 0,
          scheduledHours: 0,
          scheduledKeys: new Set<string>(),
        });
      }
    }

    for (const row of rows) {
      const current = bySource.get(row.source);
      if (!current) continue;

      current.submissions += row.submissions;
      current.uniqueProspects += row.uniqueProspectsSubmitted;
      current.duplicates += row.duplicateProspectSubmissions;

      const scheduledKey = `${row.source}:${row.workerId}:${row.dayKey}`;
      if (!current.scheduledKeys.has(scheduledKey)) {
        current.scheduledKeys.add(scheduledKey);
        current.scheduledHours += scheduledHoursForDailyStat(
          row,
          currentScheduledHoursByWorkerDay,
        );
      }
    }

    return [...bySource.values()].map((row) => ({
      source: row.source,
      submissions: row.submissions,
      uniqueProspects: row.uniqueProspects,
      duplicates: row.duplicates,
      scheduledHours: row.scheduledHours,
      leadsPerHour:
        row.scheduledHours > 0 ? row.submissions / row.scheduledHours : null,
    }));
  },
});

export const listTopOrigins = query({
  args: {
    startDayKey: v.string(),
    endDayKey: v.string(),
    teamId: v.optional(v.id("attributionTeams")),
    workerId: v.optional(v.id("leadGenWorkers")),
    source: v.optional(leadGenSourceValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const limit = normalizeLimit(args.limit, MAX_TOP_ORIGINS);

    validateDayRange(args);
    await validateFilterIds(ctx, { tenantId, ...args });

    if (args.teamId || args.workerId) {
      const rows = await readTopOriginSubmissionRows(ctx, {
        tenantId,
        ...args,
      });
      const byOrigin = new Map<
        string,
        {
          originKey: string;
          source: LeadGenSource;
          originKind: Doc<"leadGenSubmissions">["originKind"];
          originValue: string;
          submissions: number;
          uniqueProspectDayKeys: Set<string>;
          dayKeys: Set<string>;
        }
      >();

      for (const row of rows) {
        const origin = normalizeTopOriginSubmission(row);
        if (!origin.originKey || !origin.originValue) continue;

        const key = `${row.source}:${origin.originKey}`;
        const current =
          byOrigin.get(key) ??
          {
            originKey: origin.originKey,
            source: row.source,
            originKind: row.originKind,
            originValue: origin.originValue,
            submissions: 0,
            uniqueProspectDayKeys: new Set<string>(),
            dayKeys: new Set<string>(),
          };
        const dayKey = timestampToBusinessDateKey(row.submittedAt);

        current.submissions += 1;
        current.uniqueProspectDayKeys.add(`${row.prospectId}:${dayKey}`);
        current.dayKeys.add(dayKey);
        byOrigin.set(key, current);
      }

      return [...byOrigin.values()]
        .map((row) => ({
          originKey: row.originKey,
          source: row.source,
          originKind: row.originKind,
          originValue: row.originValue,
          submissions: row.submissions,
          uniqueProspects: row.uniqueProspectDayKeys.size,
          dayCount: row.dayKeys.size,
        }))
        .sort((a, b) => b.submissions - a.submissions)
        .slice(0, limit);
    }

    const readLimit = ORIGIN_STATS_READ_LIMIT + 1;
    const rows = args.source
      ? await ctx.db
          .query("leadGenOriginStats")
          .withIndex("by_tenantId_and_source_and_dayKey", (q) =>
            q
              .eq("tenantId", tenantId)
              .eq("source", args.source!)
              .gte("dayKey", args.startDayKey)
              .lte("dayKey", args.endDayKey),
          )
          .take(readLimit)
      : await ctx.db
          .query("leadGenOriginStats")
          .withIndex("by_tenantId_and_dayKey", (q) =>
            q
              .eq("tenantId", tenantId)
              .gte("dayKey", args.startDayKey)
              .lte("dayKey", args.endDayKey),
          )
          .take(readLimit);

    if (rows.length > ORIGIN_STATS_READ_LIMIT) {
      throw new Error("Origin report range is too large. Narrow the filters.");
    }

    const byOrigin = new Map<
      string,
      {
        originKey: string;
        source: LeadGenSource;
        originKind: Doc<"leadGenOriginStats">["originKind"];
        originValue: string;
        submissions: number;
        uniqueProspects: number;
        dayCount: number;
      }
    >();

    for (const row of rows) {
      if (args.source && row.source !== args.source) continue;
      const key = `${row.source}:${row.originKey}`;
      const current =
        byOrigin.get(key) ??
        {
          originKey: row.originKey,
          source: row.source,
          originKind: row.originKind,
          originValue: row.originValue,
          submissions: 0,
          uniqueProspects: 0,
          dayCount: 0,
        };
      current.submissions += row.submissions;
      current.uniqueProspects += row.uniqueProspectsSubmitted;
      current.dayCount += 1;
      byOrigin.set(key, current);
    }

    return [...byOrigin.values()]
      .sort((a, b) => b.submissions - a.submissions)
      .slice(0, limit);
  },
});

export const listTopOriginsByTeam = query({
  args: {
    startDayKey: v.string(),
    endDayKey: v.string(),
    teamId: v.optional(v.id("attributionTeams")),
    workerId: v.optional(v.id("leadGenWorkers")),
    source: v.optional(leadGenSourceValidator),
    limitPerTeam: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const limitPerTeam = normalizeLimit(
      args.limitPerTeam,
      MAX_TOP_ORIGINS_PER_TEAM,
    );

    validateDayRange(args);
    await validateFilterIds(ctx, { tenantId, ...args });

    if (args.workerId) {
      return await listTopOriginsByTeamFromBoundedSubmissions(ctx, {
        tenantId,
        ...args,
        limitPerTeam,
      });
    }

    const rows = await readTeamOriginStatRows(ctx, {
      tenantId,
      ...args,
      limit: TEAM_ORIGIN_STATS_READ_LIMIT,
    });

    return await groupTeamOriginRows(ctx, {
      tenantId,
      rows,
      limitPerTeam,
    });
  },
});
