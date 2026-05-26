import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import {
  addBusinessDays,
  businessDateToUtcStart,
  countBusinessDays,
} from "../reporting/lib/hondurasBusinessTime";
import { requireTenantUser } from "../requireTenantUser";
import {
  getSharedDmTeam,
  type LeadGenTeamId,
  type SharedDmTeam,
} from "./sharedTeams";
import {
  loadCurrentScheduledHoursByWorkerDay,
  scheduledHoursForDailyStat,
} from "./schedules";
import { buildExcelReportData } from "./reportBuilders";
import { leadGenSourceValidator } from "./validators";

type LeadGenSource = Doc<"leadGenDailyStats">["source"];
type SubmissionRow = Doc<"leadGenSubmissions">;

const SUMMARY_EXPORT_LIMIT = 1000;
const RAW_EXPORT_HARD_LIMIT = 5000;
const RAW_EXPORT_PAGE_LIMIT = 500;
const MAX_EXPORT_DAYS = 120;
const DEFAULT_RAW_EXPORT_MAX_ROWS = 5000;

const exportFiltersValidator = {
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
  if (days > MAX_EXPORT_DAYS) {
    throw new Error(`Export date range cannot exceed ${MAX_EXPORT_DAYS} days`);
  }
}

function validateTimestampRange(args: {
  startTimestamp: number;
  endTimestamp: number;
}) {
  if (
    !Number.isFinite(args.startTimestamp) ||
    !Number.isFinite(args.endTimestamp)
  ) {
    throw new Error("Export timestamps must be finite numbers");
  }
  if (args.endTimestamp < args.startTimestamp) {
    throw new Error("Export end timestamp must be after start timestamp");
  }
}

async function getTenantRawExportLimit(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
) {
  const settings = await ctx.db
    .query("leadGenSettings")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .unique();

  return Math.min(
    settings?.rawExportMaxRows ?? DEFAULT_RAW_EXPORT_MAX_ROWS,
    RAW_EXPORT_HARD_LIMIT,
  );
}

function validateRequestedRawLimit(args: {
  requestedLimit: number | undefined;
  tenantLimit: number;
}) {
  const limit = args.requestedLimit ?? args.tenantLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > args.tenantLimit) {
    throw new Error(
      `Raw export limit must be an integer between 1 and ${args.tenantLimit}`,
    );
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

function filterDailyStat(
  row: Doc<"leadGenDailyStats">,
  args: {
    teamId?: LeadGenTeamId;
    workerId?: Id<"leadGenWorkers">;
    source?: LeadGenSource;
  },
) {
  if (args.teamId && row.teamId !== args.teamId) return false;
  if (args.workerId && row.workerId !== args.workerId) return false;
  if (args.source && row.source !== args.source) return false;
  return true;
}

function filterSubmission(
  row: SubmissionRow,
  args: {
    teamId?: LeadGenTeamId;
    workerId?: Id<"leadGenWorkers">;
    source?: LeadGenSource;
  },
) {
  if (args.teamId && row.teamId !== args.teamId) return false;
  if (args.workerId && row.workerId !== args.workerId) return false;
  if (args.source && row.source !== args.source) return false;
  return true;
}

async function readDailyStatsRows(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    startDayKey: string;
    endDayKey: string;
    source?: LeadGenSource;
    teamId?: LeadGenTeamId;
    workerId?: Id<"leadGenWorkers">;
  },
) {
  const rows = args.workerId
    ? await ctx.db
        .query("leadGenDailyStats")
        .withIndex("by_tenantId_and_workerId_and_dayKey", (q) =>
          q
            .eq("tenantId", args.tenantId)
            .eq("workerId", args.workerId!)
            .gte("dayKey", args.startDayKey)
            .lte("dayKey", args.endDayKey),
        )
        .take(SUMMARY_EXPORT_LIMIT + 1)
    : args.teamId
      ? await ctx.db
          .query("leadGenDailyStats")
          .withIndex("by_tenantId_and_teamId_and_dayKey", (q) =>
            q
              .eq("tenantId", args.tenantId)
              .eq("teamId", args.teamId!)
              .gte("dayKey", args.startDayKey)
              .lte("dayKey", args.endDayKey),
          )
          .take(SUMMARY_EXPORT_LIMIT + 1)
      : args.source
        ? await ctx.db
            .query("leadGenDailyStats")
            .withIndex("by_tenantId_and_source_and_dayKey", (q) =>
              q
                .eq("tenantId", args.tenantId)
                .eq("source", args.source!)
                .gte("dayKey", args.startDayKey)
                .lte("dayKey", args.endDayKey),
            )
            .take(SUMMARY_EXPORT_LIMIT + 1)
        : await ctx.db
            .query("leadGenDailyStats")
            .withIndex("by_tenantId_and_dayKey", (q) =>
              q
                .eq("tenantId", args.tenantId)
                .gte("dayKey", args.startDayKey)
                .lte("dayKey", args.endDayKey),
            )
            .take(SUMMARY_EXPORT_LIMIT + 1);

  if (rows.length > SUMMARY_EXPORT_LIMIT) {
    throw new Error("Summary export is too large. Narrow the filters.");
  }

  return rows.filter((row) => filterDailyStat(row, args));
}

async function readSubmissionRows(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    startTimestamp: number;
    endTimestamp: number;
    source?: LeadGenSource;
    teamId?: LeadGenTeamId;
    workerId?: Id<"leadGenWorkers">;
    limit: number;
  },
) {
  const rows = args.workerId
    ? await ctx.db
        .query("leadGenSubmissions")
        .withIndex("by_tenantId_and_workerId_and_submittedAt", (q) =>
          q
            .eq("tenantId", args.tenantId)
            .eq("workerId", args.workerId!)
            .gte("submittedAt", args.startTimestamp)
            .lte("submittedAt", args.endTimestamp),
        )
        .take(args.limit + 1)
    : args.teamId
      ? await ctx.db
          .query("leadGenSubmissions")
          .withIndex("by_tenantId_and_teamId_and_submittedAt", (q) =>
            q
              .eq("tenantId", args.tenantId)
              .eq("teamId", args.teamId!)
              .gte("submittedAt", args.startTimestamp)
              .lte("submittedAt", args.endTimestamp),
          )
          .take(args.limit + 1)
      : args.source
        ? await ctx.db
            .query("leadGenSubmissions")
            .withIndex("by_tenantId_and_source_and_submittedAt", (q) =>
              q
                .eq("tenantId", args.tenantId)
                .eq("source", args.source!)
                .gte("submittedAt", args.startTimestamp)
                .lte("submittedAt", args.endTimestamp),
            )
            .take(args.limit + 1)
        : await ctx.db
            .query("leadGenSubmissions")
            .withIndex("by_tenantId_and_submittedAt", (q) =>
              q
                .eq("tenantId", args.tenantId)
                .gte("submittedAt", args.startTimestamp)
                .lte("submittedAt", args.endTimestamp),
            )
            .take(args.limit + 1);

  if (rows.length > args.limit) {
    throw new Error("Raw export is too large. Narrow the date range.");
  }

  return rows.filter((row) => filterSubmission(row, args));
}

async function paginateSubmissionRows(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    startTimestamp: number;
    endTimestamp: number;
    source?: LeadGenSource;
    teamId?: LeadGenTeamId;
    workerId?: Id<"leadGenWorkers">;
    paginationOpts: {
      numItems: number;
      cursor: string | null;
    };
  },
) {
  if (args.workerId) {
    return await ctx.db
      .query("leadGenSubmissions")
      .withIndex("by_tenantId_and_workerId_and_submittedAt", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("workerId", args.workerId!)
          .gte("submittedAt", args.startTimestamp)
          .lte("submittedAt", args.endTimestamp),
      )
      .paginate(args.paginationOpts);
  }

  if (args.teamId) {
    return await ctx.db
      .query("leadGenSubmissions")
      .withIndex("by_tenantId_and_teamId_and_submittedAt", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("teamId", args.teamId!)
          .gte("submittedAt", args.startTimestamp)
          .lte("submittedAt", args.endTimestamp),
      )
      .paginate(args.paginationOpts);
  }

  if (args.source) {
    return await ctx.db
      .query("leadGenSubmissions")
      .withIndex("by_tenantId_and_source_and_submittedAt", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("source", args.source!)
          .gte("submittedAt", args.startTimestamp)
          .lte("submittedAt", args.endTimestamp),
      )
      .paginate(args.paginationOpts);
  }

  return await ctx.db
    .query("leadGenSubmissions")
    .withIndex("by_tenantId_and_submittedAt", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .gte("submittedAt", args.startTimestamp)
        .lte("submittedAt", args.endTimestamp),
    )
    .paginate(args.paginationOpts);
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

async function loadProspects(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  prospectIds: Id<"leadGenProspects">[],
) {
  const prospects = new Map<Id<"leadGenProspects">, Doc<"leadGenProspects">>();
  for (const prospectId of prospectIds) {
    const prospect = await ctx.db.get(prospectId);
    if (prospect && prospect.tenantId === tenantId) {
      prospects.set(prospect._id, prospect);
    }
  }
  return prospects;
}

async function hydrateRawSubmissionRows(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  rows: SubmissionRow[],
) {
  const workers = await loadWorkers(
    ctx,
    tenantId,
    [...new Set(rows.map((row) => row.workerId))],
  );
  const teams = await loadTeams(
    ctx,
    tenantId,
    [
      ...new Set(
        rows
          .map((row) => row.teamId)
          .filter(
            (teamId): teamId is LeadGenTeamId => teamId !== undefined,
          ),
      ),
    ],
  );
  const prospects = await loadProspects(
    ctx,
    tenantId,
    [...new Set(rows.map((row) => row.prospectId))],
  );

  return rows.map((row) => {
    const worker = workers.get(row.workerId);
    const team = row.teamId ? teams.get(row.teamId) : null;
    const prospect = prospects.get(row.prospectId);

    return {
      submissionId: row._id,
      prospectId: row.prospectId,
      submittedAt: row.submittedAt,
      createdAt: row.createdAt,
      workerId: row.workerId,
      workerDisplayName: worker?.displayName ?? worker?.email ?? null,
      workerEmail: worker?.email ?? null,
      teamId: row.teamId ?? null,
      teamName: team?.name ?? null,
      source: row.source,
      normalizedHandle: prospect?.normalizedHandle ?? null,
      rawHandle: prospect?.rawHandle ?? null,
      profileUrl: prospect?.profileUrl ?? null,
      originKind: row.originKind,
      originValue: row.originValue ?? null,
      originRankable: row.originRankable,
      clientSubmissionKey: row.clientSubmissionKey ?? null,
      voidedAt: row.voidedAt ?? null,
      voidReason: row.voidReason ?? null,
    };
  });
}

async function hydrateSummaryExportRows(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  rows: Doc<"leadGenDailyStats">[],
) {
  const workers = await loadWorkers(
    ctx,
    tenantId,
    [...new Set(rows.map((row) => row.workerId))],
  );
  const teams = await loadTeams(
    ctx,
    tenantId,
    [
      ...new Set(
        rows
          .map((row) => row.teamId)
          .filter(
            (teamId): teamId is LeadGenTeamId => teamId !== undefined,
          ),
      ),
    ],
  );
  const currentScheduledHoursByWorkerDay =
    await loadCurrentScheduledHoursByWorkerDay(ctx, { tenantId, rows });

  return rows.map((row) => {
    const worker = workers.get(row.workerId);
    const team = row.teamId ? teams.get(row.teamId) : null;

    return {
      dayKey: row.dayKey,
      workerId: row.workerId,
      workerDisplayName: worker?.displayName ?? worker?.email ?? null,
      workerEmail: worker?.email ?? null,
      teamId: row.teamId ?? null,
      teamName: team?.name ?? null,
      source: row.source,
      submissions: row.submissions,
      uniqueProspects: row.uniqueProspectsSubmitted,
      duplicates: row.duplicateProspectSubmissions,
      scheduledHours: scheduledHoursForDailyStat(
        row,
        currentScheduledHoursByWorkerDay,
      ),
    };
  });
}

export const getSummaryExportRows = query({
  args: exportFiltersValidator,
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    validateDayRange(args);
    await validateFilterIds(ctx, { tenantId, ...args });
    const rows = await readDailyStatsRows(ctx, { tenantId, ...args });

    return await hydrateSummaryExportRows(ctx, tenantId, rows);
  },
});

export const getExcelReportData = query({
  args: exportFiltersValidator,
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    validateDayRange(args);
    await validateFilterIds(ctx, { tenantId, ...args });
    const rows = await readDailyStatsRows(ctx, { tenantId, ...args });
    const currentScheduledHoursByWorkerDay =
      await loadCurrentScheduledHoursByWorkerDay(ctx, { tenantId, rows });

    return await buildExcelReportData(ctx, {
      tenantId,
      filters: args,
      dailyRows: rows,
      currentScheduledHoursByWorkerDay,
      topOriginLimit: 10,
    });
  },
});

export const getWorkerExportRows = query({
  args: exportFiltersValidator,
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    validateDayRange(args);
    await validateFilterIds(ctx, { tenantId, ...args });
    const rows = await readDailyStatsRows(ctx, { tenantId, ...args });
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
          workerDisplayName: worker?.displayName ?? worker?.email ?? null,
          workerEmail: worker?.email ?? null,
          teamId: worker?.teamId ?? null,
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

export const getRawSubmissionExportRows = query({
  args: {
    startTimestamp: v.number(),
    endTimestamp: v.number(),
    maxRows: v.optional(v.number()),
    teamId: v.optional(v.id("attributionTeams")),
    workerId: v.optional(v.id("leadGenWorkers")),
    source: v.optional(leadGenSourceValidator),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    validateTimestampRange(args);
    await validateFilterIds(ctx, { tenantId, ...args });
    const tenantLimit = await getTenantRawExportLimit(ctx, tenantId);
    const maxRows = validateRequestedRawLimit({
      requestedLimit: args.maxRows,
      tenantLimit,
    });
    const rows = await readSubmissionRows(ctx, {
      tenantId,
      ...args,
      limit: maxRows,
    });

    return await hydrateRawSubmissionRows(ctx, tenantId, rows);
  },
});

export const listRawSubmissionExportPage = query({
  args: {
    startTimestamp: v.number(),
    endTimestamp: v.number(),
    teamId: v.optional(v.id("attributionTeams")),
    workerId: v.optional(v.id("leadGenWorkers")),
    source: v.optional(leadGenSourceValidator),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    validateTimestampRange(args);
    await validateFilterIds(ctx, { tenantId, ...args });
    if (
      !Number.isInteger(args.paginationOpts.numItems) ||
      args.paginationOpts.numItems < 1 ||
      args.paginationOpts.numItems > RAW_EXPORT_PAGE_LIMIT
    ) {
      throw new Error(
        `Raw export page size must be between 1 and ${RAW_EXPORT_PAGE_LIMIT}`,
      );
    }

    const page = await paginateSubmissionRows(ctx, { tenantId, ...args });

    return {
      ...page,
      page: await hydrateRawSubmissionRows(
        ctx,
        tenantId,
        page.page.filter((row) => filterSubmission(row, args)),
      ),
      maxExportRows: await getTenantRawExportLimit(ctx, tenantId),
    };
  },
});
