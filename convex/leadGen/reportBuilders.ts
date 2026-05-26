import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  addBusinessDays,
  businessDateToUtcStart,
  timestampToBusinessDateKey,
} from "../reporting/lib/hondurasBusinessTime";
import {
  isRankableLeadGenOrigin,
  normalizeLeadGenOrigin,
} from "./normalization";
import {
  getSharedDmTeam,
  type LeadGenTeamId,
  type SharedDmTeam,
} from "./sharedTeams";
import { scheduledHoursForDailyStat } from "./schedules";

type LeadGenSource = Doc<"leadGenDailyStats">["source"];
type DailyStatsRow = Doc<"leadGenDailyStats">;
type SubmissionRow = Doc<"leadGenSubmissions">;
type TeamOriginStatsRow = Doc<"leadGenTeamOriginStats">;
type RankableOriginKind = "post" | "reel";

const LEAD_GEN_SOURCES: LeadGenSource[] = ["instagram", "meta_business"];
const ORIGIN_SUBMISSIONS_READ_LIMIT = 5000;
const TEAM_ORIGIN_STATS_READ_LIMIT = 1000;

export type ExcelReportFilters = {
  startDayKey: string;
  endDayKey: string;
  teamId?: LeadGenTeamId;
  workerId?: Id<"leadGenWorkers">;
  source?: LeadGenSource;
};

export type ExcelWorkerPerformanceRow = {
  workerId: Id<"leadGenWorkers">;
  displayName: string;
  email: string | null;
  teamId: LeadGenTeamId | null;
  teamName: string | null;
  isActive: boolean;
  submissions: number;
  uniqueProspects: number;
  duplicates: number;
  scheduledHours: number;
  leadsPerHour: number | null;
};

export type ExcelSourcePerformanceRow = {
  source: LeadGenSource;
  submissions: number;
  uniqueProspects: number;
  duplicates: number;
  scheduledHours: number;
  leadsPerHour: number | null;
};

export type ExcelOriginRow = {
  originKey: string;
  source: LeadGenSource;
  originKind: RankableOriginKind;
  originValue: string;
  uniqueProspects: number;
  submissions: number;
  dayCount: number;
};

export type LeadGenExcelReportData = {
  generatedAt: number;
  reportTitle: string;
  filters: {
    startDayKey: string;
    endDayKey: string;
    source: LeadGenSource | null;
    teamName: string | null;
    workerName: string | null;
  };
  sheets: Array<{
    sheetKey: string;
    sheetName: string;
    scopeKind: "team" | "worker";
    scopeLabel: string;
    summary: {
      submissions: number;
      uniqueProspects: number;
      duplicates: number;
      scheduledHours: number;
      leadsPerHour: number | null;
    };
    topLeadGenerators: ExcelWorkerPerformanceRow[];
    topPosts: ExcelOriginRow[];
    workerPerformance: ExcelWorkerPerformanceRow[];
    sourcePerformance: ExcelSourcePerformanceRow[];
    postDetail: ExcelOriginRow[];
  }>;
};

type WorkerMap = Map<Id<"leadGenWorkers">, Doc<"leadGenWorkers">>;
type TeamMap = Map<LeadGenTeamId, SharedDmTeam>;

function isRankableOriginKind(
  originKind: Doc<"leadGenSubmissions">["originKind"],
): originKind is RankableOriginKind {
  return isRankableLeadGenOrigin(originKind);
}

function compareWorkerPerformanceRows(
  a: ExcelWorkerPerformanceRow,
  b: ExcelWorkerPerformanceRow,
) {
  if (a.submissions !== b.submissions) return b.submissions - a.submissions;
  if (a.uniqueProspects !== b.uniqueProspects) {
    return b.uniqueProspects - a.uniqueProspects;
  }
  return a.displayName.localeCompare(b.displayName);
}

function compareTopOriginRows(a: ExcelOriginRow, b: ExcelOriginRow) {
  if (a.uniqueProspects !== b.uniqueProspects) {
    return b.uniqueProspects - a.uniqueProspects;
  }
  if (a.submissions !== b.submissions) return b.submissions - a.submissions;
  return a.originValue.localeCompare(b.originValue);
}

function teamLabelForRows(
  teamIds: Set<LeadGenTeamId | null>,
  teams: TeamMap,
) {
  if (teamIds.size === 0) return { teamId: null, teamName: null };
  if (teamIds.size > 1) return { teamId: null, teamName: "Multiple Teams" };

  const [teamId] = [...teamIds];
  if (teamId === null) return { teamId: null, teamName: "Unassigned" };

  return {
    teamId,
    teamName: teams.get(teamId)?.name ?? "Unknown team",
  };
}

async function loadWorkers(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  workerIds: Id<"leadGenWorkers">[],
) {
  const workers: WorkerMap = new Map();
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
  const teams: TeamMap = new Map();
  for (const teamId of teamIds) {
    const team = await getSharedDmTeam(ctx, { tenantId, teamId });
    if (team) {
      teams.set(team._id, team);
    }
  }
  return teams;
}

async function loadFilterLabels(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    filters: ExcelReportFilters;
  },
) {
  const team = args.filters.teamId
    ? await getSharedDmTeam(ctx, {
        tenantId: args.tenantId,
        teamId: args.filters.teamId,
      })
    : null;
  const worker = args.filters.workerId
    ? await ctx.db.get(args.filters.workerId)
    : null;

  return {
    teamName: team?.name ?? null,
    workerName:
      worker && worker.tenantId === args.tenantId
        ? worker.displayName ?? worker.email
        : null,
  };
}

export function summarizeDailyRows(
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

export function buildWorkerPerformanceRows(args: {
  rows: DailyStatsRow[];
  currentScheduledHoursByWorkerDay: Map<string, number>;
  workers: WorkerMap;
  teams: TeamMap;
}) {
  const byWorker = new Map<
    Id<"leadGenWorkers">,
    {
      workerId: Id<"leadGenWorkers">;
      submissions: number;
      uniqueProspects: number;
      duplicates: number;
      scheduledHours: number;
      scheduledKeys: Set<string>;
      teamIds: Set<LeadGenTeamId | null>;
    }
  >();

  for (const row of args.rows) {
    const current =
      byWorker.get(row.workerId) ??
      {
        workerId: row.workerId,
        submissions: 0,
        uniqueProspects: 0,
        duplicates: 0,
        scheduledHours: 0,
        scheduledKeys: new Set<string>(),
        teamIds: new Set<LeadGenTeamId | null>(),
      };

    current.submissions += row.submissions;
    current.uniqueProspects += row.uniqueProspectsSubmitted;
    current.duplicates += row.duplicateProspectSubmissions;
    current.teamIds.add(row.teamId ?? null);

    const scheduledKey = `${row.workerId}:${row.dayKey}`;
    if (!current.scheduledKeys.has(scheduledKey)) {
      current.scheduledKeys.add(scheduledKey);
      current.scheduledHours += scheduledHoursForDailyStat(
        row,
        args.currentScheduledHoursByWorkerDay,
      );
    }

    byWorker.set(row.workerId, current);
  }

  return [...byWorker.values()]
    .map((row): ExcelWorkerPerformanceRow => {
      const worker = args.workers.get(row.workerId);
      const team = teamLabelForRows(row.teamIds, args.teams);

      return {
        workerId: row.workerId,
        displayName: worker?.displayName ?? worker?.email ?? "Unknown worker",
        email: worker?.email ?? null,
        teamId: team.teamId,
        teamName: team.teamName,
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
    .sort(compareWorkerPerformanceRows);
}

export function buildSourcePerformanceRows(args: {
  rows: DailyStatsRow[];
  currentScheduledHoursByWorkerDay: Map<string, number>;
  source?: LeadGenSource;
}) {
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

  for (const row of args.rows) {
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
        args.currentScheduledHoursByWorkerDay,
      );
    }
  }

  return [...bySource.values()].map((row): ExcelSourcePerformanceRow => ({
    source: row.source,
    submissions: row.submissions,
    uniqueProspects: row.uniqueProspects,
    duplicates: row.duplicates,
    scheduledHours: row.scheduledHours,
    leadsPerHour:
      row.scheduledHours > 0 ? row.submissions / row.scheduledHours : null,
  }));
}

function filterTopOriginSubmissionRows(
  rows: SubmissionRow[],
  args: {
    teamId?: LeadGenTeamId | null;
    workerId?: Id<"leadGenWorkers">;
    source?: LeadGenSource;
  },
) {
  return rows.filter((row) => {
    if (row.voidedAt !== undefined) return false;
    if (!row.originRankable || !row.originValue) return false;
    if (!isRankableOriginKind(row.originKind)) return false;
    if (args.teamId !== undefined && (row.teamId ?? null) !== args.teamId) {
      return false;
    }
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

async function readTopOriginSubmissionRows(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    startDayKey: string;
    endDayKey: string;
    teamId?: LeadGenTeamId | null;
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
  } else if (args.teamId !== undefined) {
    rows = await ctx.db
      .query("leadGenSubmissions")
      .withIndex("by_tenantId_and_teamId_and_submittedAt", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("teamId", args.teamId ?? undefined)
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

async function readTeamOriginStatRows(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    startDayKey: string;
    endDayKey: string;
    teamId?: LeadGenTeamId | null;
    source?: LeadGenSource;
    limit: number;
  },
) {
  const readLimit = args.limit + 1;
  let rows: TeamOriginStatsRow[];

  if (args.teamId !== undefined && args.source) {
    rows = await ctx.db
      .query("leadGenTeamOriginStats")
      .withIndex("by_tenantId_and_teamId_and_source_and_dayKey", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("teamId", args.teamId ?? undefined)
          .eq("source", args.source!)
          .gte("dayKey", args.startDayKey)
          .lte("dayKey", args.endDayKey),
      )
      .take(readLimit);
  } else if (args.teamId !== undefined) {
    rows = await ctx.db
      .query("leadGenTeamOriginStats")
      .withIndex("by_tenantId_and_teamId_and_dayKey", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("teamId", args.teamId ?? undefined)
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
    throw new Error("Posts by team report is too large. Narrow the filters.");
  }

  return rows.filter((row) => isRankableOriginKind(row.originKind));
}

function groupOriginStatsRows(rows: TeamOriginStatsRow[], limit: number) {
  const byOrigin = new Map<
    string,
    {
      originKey: string;
      source: LeadGenSource;
      originKind: RankableOriginKind;
      originValue: string;
      submissions: number;
      uniqueProspects: number;
      dayCount: number;
    }
  >();

  for (const row of rows) {
    if (!isRankableOriginKind(row.originKind)) continue;

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

  return [...byOrigin.values()].sort(compareTopOriginRows).slice(0, limit);
}

async function listTopOriginsFromTeamOriginStats(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    startDayKey: string;
    endDayKey: string;
    teamId?: LeadGenTeamId | null;
    source?: LeadGenSource;
    limit: number;
  },
) {
  const rows = await readTeamOriginStatRows(ctx, {
    ...args,
    limit: TEAM_ORIGIN_STATS_READ_LIMIT,
  });

  return groupOriginStatsRows(rows, args.limit);
}

async function listTopOriginsFromBoundedSubmissions(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    startDayKey: string;
    endDayKey: string;
    teamId?: LeadGenTeamId | null;
    workerId?: Id<"leadGenWorkers">;
    source?: LeadGenSource;
    limit: number;
  },
) {
  const rows = await readTopOriginSubmissionRows(ctx, args);
  const byOrigin = new Map<
    string,
    {
      originKey: string;
      source: LeadGenSource;
      originKind: RankableOriginKind;
      originValue: string;
      submissions: number;
      uniqueProspectDayKeys: Set<string>;
      dayKeys: Set<string>;
    }
  >();

  for (const row of rows) {
    if (!isRankableOriginKind(row.originKind)) continue;
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
    .map(
      (row): ExcelOriginRow => ({
        originKey: row.originKey,
        source: row.source,
        originKind: row.originKind,
        originValue: row.originValue,
        submissions: row.submissions,
        uniqueProspects: row.uniqueProspectDayKeys.size,
        dayCount: row.dayKeys.size,
      }),
    )
    .sort(compareTopOriginRows)
    .slice(0, args.limit);
}

export async function listTopOriginsForScope(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    startDayKey: string;
    endDayKey: string;
    teamId?: LeadGenTeamId | null;
    workerId?: Id<"leadGenWorkers">;
    source?: LeadGenSource;
    limit: number;
  },
) {
  if (args.workerId) {
    return await listTopOriginsFromBoundedSubmissions(ctx, args);
  }

  return await listTopOriginsFromTeamOriginStats(ctx, args);
}

function getSheetGroups(args: {
  filters: ExcelReportFilters;
  dailyRows: DailyStatsRow[];
  teams: TeamMap;
  selectedWorkerName: string | null;
}) {
  if (args.filters.workerId) {
    return [
      {
        scopeKind: "worker" as const,
        key: `worker:${args.filters.workerId}`,
        workerId: args.filters.workerId,
        teamId: args.filters.teamId,
        label: args.selectedWorkerName ?? "Unknown worker",
        sheetName: args.selectedWorkerName ?? "Worker",
      },
    ];
  }

  if (args.filters.teamId) {
    const teamName = args.teams.get(args.filters.teamId)?.name ?? "Unknown team";
    return [
      {
        scopeKind: "team" as const,
        key: `team:${args.filters.teamId}`,
        teamId: args.filters.teamId,
        label: teamName,
        sheetName: teamName,
      },
    ];
  }

  const teamIds = new Set<LeadGenTeamId | null>(
    args.dailyRows.map((row) => row.teamId ?? null),
  );

  return [...teamIds]
    .map((teamId) => {
      const teamName =
        teamId === null ? "Unassigned" : args.teams.get(teamId)?.name;
      return {
        scopeKind: "team" as const,
        key: `team:${teamId ?? "unassigned"}`,
        teamId,
        label: teamName ?? "Unknown team",
        sheetName: teamName ?? "Unknown team",
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function filterRowsForGroup(
  rows: DailyStatsRow[],
  group: {
    scopeKind: "team" | "worker";
    workerId?: Id<"leadGenWorkers">;
    teamId?: LeadGenTeamId | null;
  },
) {
  if (group.scopeKind === "worker") {
    return rows.filter((row) => {
      if (row.workerId !== group.workerId) return false;
      if (group.teamId !== undefined && (row.teamId ?? null) !== group.teamId) {
        return false;
      }
      return true;
    });
  }

  return rows.filter((row) => (row.teamId ?? null) === group.teamId);
}

export async function buildExcelReportData(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    filters: ExcelReportFilters;
    dailyRows: DailyStatsRow[];
    currentScheduledHoursByWorkerDay: Map<string, number>;
    topOriginLimit: number;
  },
): Promise<LeadGenExcelReportData> {
  const filterLabels = await loadFilterLabels(ctx, {
    tenantId: args.tenantId,
    filters: args.filters,
  });
  const workerIds = [
    ...new Set(
      [
        ...args.dailyRows.map((row) => row.workerId),
        args.filters.workerId,
      ].filter(
        (workerId): workerId is Id<"leadGenWorkers"> =>
          workerId !== undefined,
      ),
    ),
  ];
  const teamIds = [
    ...new Set(
      [
        ...args.dailyRows.map((row) => row.teamId),
        args.filters.teamId,
      ].filter(
        (teamId): teamId is LeadGenTeamId => teamId !== undefined,
      ),
    ),
  ];
  const workers = await loadWorkers(ctx, args.tenantId, workerIds);
  const teams = await loadTeams(ctx, args.tenantId, teamIds);
  const generatedAt = Date.now();

  if (args.dailyRows.length === 0) {
    return {
      generatedAt,
      reportTitle: "Lead Gen Ops Report",
      filters: {
        startDayKey: args.filters.startDayKey,
        endDayKey: args.filters.endDayKey,
        source: args.filters.source ?? null,
        teamName: filterLabels.teamName,
        workerName: filterLabels.workerName,
      },
      sheets: [
        {
          sheetKey: "no-activity",
          sheetName: "No Activity",
          scopeKind: args.filters.workerId ? "worker" : "team",
          scopeLabel:
            filterLabels.workerName ??
            filterLabels.teamName ??
            "No matching activity",
          summary: summarizeDailyRows(
            [],
            args.currentScheduledHoursByWorkerDay,
          ),
          topLeadGenerators: [],
          topPosts: [],
          workerPerformance: [],
          sourcePerformance: [],
          postDetail: [],
        },
      ],
    };
  }

  const groups = getSheetGroups({
    filters: args.filters,
    dailyRows: args.dailyRows,
    teams,
    selectedWorkerName: filterLabels.workerName,
  });
  const sheets: LeadGenExcelReportData["sheets"] = [];

  for (const group of groups) {
    const sheetRows = filterRowsForGroup(args.dailyRows, group);
    const workerPerformance = buildWorkerPerformanceRows({
      rows: sheetRows,
      currentScheduledHoursByWorkerDay: args.currentScheduledHoursByWorkerDay,
      workers,
      teams,
    });
    const postDetail = await listTopOriginsForScope(ctx, {
      tenantId: args.tenantId,
      startDayKey: args.filters.startDayKey,
      endDayKey: args.filters.endDayKey,
      teamId: group.teamId,
      workerId: group.scopeKind === "worker" ? group.workerId : undefined,
      source: args.filters.source,
      limit: args.topOriginLimit,
    });

    sheets.push({
      sheetKey: group.key,
      sheetName: group.sheetName,
      scopeKind: group.scopeKind,
      scopeLabel: group.label,
      summary: summarizeDailyRows(
        sheetRows,
        args.currentScheduledHoursByWorkerDay,
      ),
      topLeadGenerators: workerPerformance.slice(0, 3),
      topPosts: postDetail.slice(0, 3),
      workerPerformance,
      sourcePerformance: buildSourcePerformanceRows({
        rows: sheetRows,
        currentScheduledHoursByWorkerDay:
          args.currentScheduledHoursByWorkerDay,
        source: args.filters.source,
      }),
      postDetail,
    });
  }

  return {
    generatedAt,
    reportTitle: "Lead Gen Ops Report",
    filters: {
      startDayKey: args.filters.startDayKey,
      endDayKey: args.filters.endDayKey,
      source: args.filters.source ?? null,
      teamName: filterLabels.teamName,
      workerName: filterLabels.workerName,
    },
    sheets,
  };
}
