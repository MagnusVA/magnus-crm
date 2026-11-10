import type { ReaderArgs } from "../../analytics/assistantTypes";
import { assertLeadGenBusinessDayReady } from "../../lib/businessDayRebuildState";
import { getTenantBusinessDay } from "../../lib/tenantBusinessDay";
import type { Doc, Id } from "../../_generated/dataModel";
import { type QueryCtx } from "../../_generated/server";
import { addBusinessDays, businessDateToUtcStart, countBusinessDays, timestampToBusinessDateKey } from "../../reporting/lib/hondurasBusinessTime";
import { isRankableLeadGenOrigin, normalizeLeadGenOrigin } from "../../leadGen/normalization";
import { DAILY_STATS_READ_LIMIT, MAX_REPORT_DAYS, MAX_TOP_ORIGINS_PER_TEAM, ORIGIN_STATS_READ_LIMIT, ORIGIN_SUBMISSIONS_READ_LIMIT, TEAM_ORIGIN_STATS_READ_LIMIT } from "../../leadGen/reportLimits";
import { getSharedDmTeam, type LeadGenTeamId } from "../../leadGen/sharedTeams";
import { readLiveQueryRows } from "../../lib/liveQueryBounds";
import { buildLeadGenOverview, buildWorkerPerformance, buildTeamPerformance, buildSourcePerformance, buildTopOriginsByTeam } from "../../leadGen/reporting";
import type { getOverview, listWorkerPerformance, listTeamPerformance, listSourcePerformance, listTopOriginsByTeam } from "../../leadGen/reporting";
// Trusted tenant readers. Copied load steps preserve page semantics; builders stay shared.
type LeadGenSource = Doc<"leadGenDailyStats">["source"];
type DailyStatsRow = Doc<"leadGenDailyStats">;
type SubmissionRow = Doc<"leadGenSubmissions">;
type TeamOriginStatsRow = Doc<"leadGenTeamOriginStats">;
function validateDayRange(args: {
    startDayKey: string;
    endDayKey: string;
}) {
    businessDateToUtcStart(args.startDayKey);
    businessDateToUtcStart(args.endDayKey);
    if (args.startDayKey > args.endDayKey) {
        throw new Error("Start date must be on or before end date");
    }
    const days = countBusinessDays(args.startDayKey, addBusinessDays(args.endDayKey, 1));
    if (days > MAX_REPORT_DAYS) {
        throw new Error(`Report date range cannot exceed ${MAX_REPORT_DAYS} days`);
    }
}
function normalizeLimit(limit: number | undefined, max: number) {
    if (limit === undefined)
        return max;
    if (!Number.isInteger(limit) || limit < 1 || limit > max) {
        throw new Error(`Limit must be an integer between 1 and ${max}`);
    }
    return limit;
}
async function validateFilterIds(ctx: QueryCtx, args: {
    tenantId: Id<"tenants">;
    teamId?: LeadGenTeamId;
    workerId?: Id<"leadGenWorkers">;
}) {
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
        const worker = await ctx.db.get("leadGenWorkers", args.workerId);
        if (!worker || worker.tenantId !== args.tenantId) {
            throw new Error("Lead-gen worker not found");
        }
    }
}
function filterDailyStatsRows(rows: DailyStatsRow[], args: {
    teamId?: LeadGenTeamId;
    workerId?: Id<"leadGenWorkers">;
    source?: LeadGenSource;
}) {
    return rows.filter((row) => {
        if (args.teamId && row.teamId !== args.teamId)
            return false;
        if (args.workerId && row.workerId !== args.workerId)
            return false;
        if (args.source && row.source !== args.source)
            return false;
        return true;
    });
}
function filterTopOriginSubmissionRows(rows: SubmissionRow[], args: {
    teamId?: LeadGenTeamId;
    workerId?: Id<"leadGenWorkers">;
    source?: LeadGenSource;
}) {
    return rows.filter((row) => {
        if (row.voidedAt !== undefined)
            return false;
        if (!row.originRankable || !row.originValue)
            return false;
        if (!isRankableLeadGenOrigin(row.originKind))
            return false;
        if (args.teamId && row.teamId !== args.teamId)
            return false;
        if (args.workerId && row.workerId !== args.workerId)
            return false;
        if (args.source && row.source !== args.source)
            return false;
        return true;
    });
}
function normalizeTopOriginSubmission(row: SubmissionRow) {
    try {
        return normalizeLeadGenOrigin({
            originKind: row.originKind,
            originUrlOrLabel: row.originValue,
        });
    }
    catch {
        return {};
    }
}
async function readDailyStatsRows(ctx: QueryCtx, args: {
    tenantId: Id<"tenants">;
    startDayKey: string;
    endDayKey: string;
    teamId?: LeadGenTeamId;
    workerId?: Id<"leadGenWorkers">;
    source?: LeadGenSource;
    limit: number;
}) {
    const result = await readDailyStatsRowsBounded(ctx, args);
    if (result.capped) {
        throw new Error("Report range is too large. Narrow the filters.");
    }
    return result.rows;
}
async function readDailyStatsRowsBounded(ctx: QueryCtx, args: {
    tenantId: Id<"tenants">;
    startDayKey: string;
    endDayKey: string;
    teamId?: LeadGenTeamId;
    workerId?: Id<"leadGenWorkers">;
    source?: LeadGenSource;
    limit: number;
}) {
    let result: {
        rows: DailyStatsRow[];
        capped: boolean;
    };
    if (args.workerId) {
        result = await readLiveQueryRows(ctx.db
            .query("leadGenDailyStats")
            .withIndex("by_tenantId_and_workerId_and_dayKey", (q) => q
            .eq("tenantId", args.tenantId)
            .eq("workerId", args.workerId!)
            .gte("dayKey", args.startDayKey)
            .lte("dayKey", args.endDayKey)), args.limit);
    }
    else if (args.teamId) {
        result = await readLiveQueryRows(ctx.db
            .query("leadGenDailyStats")
            .withIndex("by_tenantId_and_teamId_and_dayKey", (q) => q
            .eq("tenantId", args.tenantId)
            .eq("teamId", args.teamId!)
            .gte("dayKey", args.startDayKey)
            .lte("dayKey", args.endDayKey)), args.limit);
    }
    else if (args.source) {
        result = await readLiveQueryRows(ctx.db
            .query("leadGenDailyStats")
            .withIndex("by_tenantId_and_source_and_dayKey", (q) => q
            .eq("tenantId", args.tenantId)
            .eq("source", args.source!)
            .gte("dayKey", args.startDayKey)
            .lte("dayKey", args.endDayKey)), args.limit);
    }
    else {
        result = await readLiveQueryRows(ctx.db
            .query("leadGenDailyStats")
            .withIndex("by_tenantId_and_dayKey", (q) => q
            .eq("tenantId", args.tenantId)
            .gte("dayKey", args.startDayKey)
            .lte("dayKey", args.endDayKey)), args.limit);
    }
    return {
        rows: filterDailyStatsRows(result.rows, args),
        capped: result.capped,
    };
}
async function isTopOriginsReadCapped(ctx: QueryCtx, args: {
    tenantId: Id<"tenants">;
    startDayKey: string;
    endDayKey: string;
    teamId?: LeadGenTeamId;
    workerId?: Id<"leadGenWorkers">;
    source?: LeadGenSource;
}) {
    if (args.workerId) {
        const startTimestamp = businessDateToUtcStart(args.startDayKey, await getTenantBusinessDay(ctx, args.tenantId));
        const endTimestamp = businessDateToUtcStart(addBusinessDays(args.endDayKey, 1), await getTenantBusinessDay(ctx, args.tenantId)) - 1;
        const result = await readLiveQueryRows(ctx.db
            .query("leadGenSubmissions")
            .withIndex("by_tenantId_and_workerId_and_submittedAt", (q) => q
            .eq("tenantId", args.tenantId)
            .eq("workerId", args.workerId!)
            .gte("submittedAt", startTimestamp)
            .lte("submittedAt", endTimestamp)), ORIGIN_STATS_READ_LIMIT);
        return result.capped;
    }
    const result = await readTeamOriginStatRowsBounded(ctx, {
        ...args,
        limit: TEAM_ORIGIN_STATS_READ_LIMIT,
    });
    return result.capped;
}
async function readTopOriginSubmissionRows(ctx: QueryCtx, args: {
    tenantId: Id<"tenants">;
    startDayKey: string;
    endDayKey: string;
    teamId?: LeadGenTeamId;
    workerId?: Id<"leadGenWorkers">;
    source?: LeadGenSource;
}) {
    const startTimestamp = businessDateToUtcStart(args.startDayKey, await getTenantBusinessDay(ctx, args.tenantId));
    const endTimestamp = businessDateToUtcStart(addBusinessDays(args.endDayKey, 1), await getTenantBusinessDay(ctx, args.tenantId)) - 1;
    const readLimit = ORIGIN_SUBMISSIONS_READ_LIMIT + 1;
    let rows: SubmissionRow[];
    if (args.workerId) {
        rows = await ctx.db
            .query("leadGenSubmissions")
            .withIndex("by_tenantId_and_workerId_and_submittedAt", (q) => q
            .eq("tenantId", args.tenantId)
            .eq("workerId", args.workerId!)
            .gte("submittedAt", startTimestamp)
            .lte("submittedAt", endTimestamp))
            .take(readLimit);
    }
    else if (args.teamId) {
        rows = await ctx.db
            .query("leadGenSubmissions")
            .withIndex("by_tenantId_and_teamId_and_submittedAt", (q) => q
            .eq("tenantId", args.tenantId)
            .eq("teamId", args.teamId!)
            .gte("submittedAt", startTimestamp)
            .lte("submittedAt", endTimestamp))
            .take(readLimit);
    }
    else if (args.source) {
        rows = await ctx.db
            .query("leadGenSubmissions")
            .withIndex("by_tenantId_and_source_and_submittedAt", (q) => q
            .eq("tenantId", args.tenantId)
            .eq("source", args.source!)
            .gte("submittedAt", startTimestamp)
            .lte("submittedAt", endTimestamp))
            .take(readLimit);
    }
    else {
        rows = await ctx.db
            .query("leadGenSubmissions")
            .withIndex("by_tenantId_and_submittedAt", (q) => q
            .eq("tenantId", args.tenantId)
            .gte("submittedAt", startTimestamp)
            .lte("submittedAt", endTimestamp))
            .take(readLimit);
    }
    if (rows.length > ORIGIN_SUBMISSIONS_READ_LIMIT) {
        throw new Error("Origin report range is too large. Narrow the filters.");
    }
    return filterTopOriginSubmissionRows(rows, args);
}
function isRankableOriginKind(originKind: Doc<"leadGenSubmissions">["originKind"]): originKind is "post" | "reel" {
    return originKind === "post" || originKind === "reel";
}
async function readTeamOriginStatRowsBounded(ctx: QueryCtx, args: {
    tenantId: Id<"tenants">;
    startDayKey: string;
    endDayKey: string;
    teamId?: LeadGenTeamId;
    source?: LeadGenSource;
    limit: number;
}) {
    let result: {
        rows: TeamOriginStatsRow[];
        capped: boolean;
    };
    if (args.teamId && args.source) {
        result = await readLiveQueryRows(ctx.db
            .query("leadGenTeamOriginStats")
            .withIndex("by_tenantId_and_teamId_and_source_and_dayKey", (q) => q
            .eq("tenantId", args.tenantId)
            .eq("teamId", args.teamId!)
            .eq("source", args.source!)
            .gte("dayKey", args.startDayKey)
            .lte("dayKey", args.endDayKey)), args.limit);
    }
    else if (args.teamId) {
        result = await readLiveQueryRows(ctx.db
            .query("leadGenTeamOriginStats")
            .withIndex("by_tenantId_and_teamId_and_dayKey", (q) => q
            .eq("tenantId", args.tenantId)
            .eq("teamId", args.teamId!)
            .gte("dayKey", args.startDayKey)
            .lte("dayKey", args.endDayKey)), args.limit);
    }
    else if (args.source) {
        result = await readLiveQueryRows(ctx.db
            .query("leadGenTeamOriginStats")
            .withIndex("by_tenantId_and_source_and_dayKey", (q) => q
            .eq("tenantId", args.tenantId)
            .eq("source", args.source!)
            .gte("dayKey", args.startDayKey)
            .lte("dayKey", args.endDayKey)), args.limit);
    }
    else {
        result = await readLiveQueryRows(ctx.db
            .query("leadGenTeamOriginStats")
            .withIndex("by_tenantId_and_dayKey", (q) => q
            .eq("tenantId", args.tenantId)
            .gte("dayKey", args.startDayKey)
            .lte("dayKey", args.endDayKey)), args.limit);
    }
    return result;
}
async function groupTeamOriginRows(ctx: QueryCtx, args: {
    tenantId: Id<"tenants">;
    rows: TeamOriginStatsRow[];
    limitPerTeam: number;
    sortBy?: "uniqueProspects" | "submissions";
}) {
    const byTeam = new Map<string, {
        teamId: LeadGenTeamId | null;
        totalUniqueProspects: number;
        totalSubmissions: number;
        origins: Map<string, {
            originKey: string;
            source: LeadGenSource;
            originKind: "post" | "reel";
            originValue: string;
            uniqueProspects: number;
            submissions: number;
            dayCount: number;
        }>;
    }>();
    for (const row of args.rows) {
        if (!isRankableOriginKind(row.originKind) || row.submissions <= 0)
            continue;
        const teamKey = row.teamId ?? "unassigned";
        const currentTeam = byTeam.get(teamKey) ??
            {
                teamId: row.teamId ?? null,
                totalUniqueProspects: 0,
                totalSubmissions: 0,
                origins: new Map(),
            };
        const originMapKey = `${row.source}:${row.originKey}`;
        const currentOrigin = currentTeam.origins.get(originMapKey) ??
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
    return await buildTopOriginsByTeam(ctx, {
        tenantId: args.tenantId,
        groups: [...byTeam.values()].map((row) => ({
            teamId: row.teamId,
            totalUniqueProspects: row.totalUniqueProspects,
            totalSubmissions: row.totalSubmissions,
            origins: [...row.origins.values()],
        })),
        limitPerTeam: args.limitPerTeam,
        sortBy: args.sortBy,
    });
}
async function listTopOriginsByTeamFromBoundedSubmissions(ctx: QueryCtx, args: {
    tenantId: Id<"tenants">;
    startDayKey: string;
    endDayKey: string;
    teamId?: LeadGenTeamId;
    workerId?: Id<"leadGenWorkers">;
    source?: LeadGenSource;
    limitPerTeam: number;
    sortBy?: "uniqueProspects" | "submissions";
}) {
    const rows = await readTopOriginSubmissionRows(ctx, args);
    const byTeam = new Map<string, {
        teamId: LeadGenTeamId | null;
        origins: Map<string, {
            originKey: string;
            source: LeadGenSource;
            originKind: "post" | "reel";
            originValue: string;
            submissions: number;
            uniqueProspectDayKeys: Set<string>;
            dayKeys: Set<string>;
        }>;
    }>();
    for (const row of rows) {
        if (!isRankableOriginKind(row.originKind))
            continue;
        const origin = normalizeTopOriginSubmission(row);
        if (!origin.originKey || !origin.originValue)
            continue;
        const teamKey = row.teamId ?? "unassigned";
        const currentTeam = byTeam.get(teamKey) ??
            {
                teamId: row.teamId ?? null,
                origins: new Map(),
            };
        const originMapKey = `${row.source}:${origin.originKey}`;
        const currentOrigin = currentTeam.origins.get(originMapKey) ??
            {
                originKey: origin.originKey,
                source: row.source,
                originKind: row.originKind,
                originValue: origin.originValue,
                submissions: 0,
                uniqueProspectDayKeys: new Set<string>(),
                dayKeys: new Set<string>(),
            };
        const dayKey = timestampToBusinessDateKey(row.submittedAt, await getTenantBusinessDay(ctx, args.tenantId));
        currentOrigin.submissions += 1;
        currentOrigin.uniqueProspectDayKeys.add(`${row.prospectId}:${dayKey}`);
        currentOrigin.dayKeys.add(dayKey);
        currentTeam.origins.set(originMapKey, currentOrigin);
        byTeam.set(teamKey, currentTeam);
    }
    return await buildTopOriginsByTeam(ctx, {
        tenantId: args.tenantId,
        groups: [...byTeam.values()].map((row) => {
            const origins = [...row.origins.values()].map((origin) => ({
                originKey: origin.originKey,
                source: origin.source,
                originKind: origin.originKind,
                originValue: origin.originValue,
                uniqueProspects: origin.uniqueProspectDayKeys.size,
                submissions: origin.submissions,
                dayCount: origin.dayKeys.size,
            }));
            return {
                teamId: row.teamId,
                totalUniqueProspects: origins.reduce((sum, origin) => sum + origin.uniqueProspects, 0),
                totalSubmissions: origins.reduce((sum, origin) => sum + origin.submissions, 0),
                origins,
            };
        }),
        limitPerTeam: args.limitPerTeam,
        sortBy: args.sortBy,
    });
}
export async function readGetOverview(ctx: QueryCtx, tenantId: Id<"tenants">, args: ReaderArgs<typeof getOverview>) {
    await assertLeadGenBusinessDayReady(ctx, tenantId);
    validateDayRange(args);
    await validateFilterIds(ctx, { tenantId, ...args });
    const [dailyResult, originsCapped] = await Promise.all([
        readDailyStatsRowsBounded(ctx, {
            tenantId,
            ...args,
            limit: DAILY_STATS_READ_LIMIT,
        }),
        isTopOriginsReadCapped(ctx, { tenantId, ...args }),
    ]);
    return await buildLeadGenOverview(ctx, tenantId, {
        rows: dailyResult.rows,
        capped: dailyResult.capped || originsCapped,
    }, args);
}
export async function readListWorkerPerformance(ctx: QueryCtx, tenantId: Id<"tenants">, args: ReaderArgs<typeof listWorkerPerformance>) {
    await assertLeadGenBusinessDayReady(ctx, tenantId);
    validateDayRange(args);
    await validateFilterIds(ctx, { tenantId, ...args });
    const rows = await readDailyStatsRows(ctx, {
        tenantId,
        ...args,
        limit: DAILY_STATS_READ_LIMIT,
    });
    return await buildWorkerPerformance(ctx, tenantId, rows);
}
export async function readListTeamPerformance(ctx: QueryCtx, tenantId: Id<"tenants">, args: ReaderArgs<typeof listTeamPerformance>) {
    await assertLeadGenBusinessDayReady(ctx, tenantId);
    validateDayRange(args);
    await validateFilterIds(ctx, { tenantId, ...args });
    const rows = await readDailyStatsRows(ctx, {
        tenantId,
        ...args,
        limit: DAILY_STATS_READ_LIMIT,
    });
    return await buildTeamPerformance(ctx, tenantId, rows);
}
export async function readListSourcePerformance(ctx: QueryCtx, tenantId: Id<"tenants">, args: ReaderArgs<typeof listSourcePerformance>) {
    await assertLeadGenBusinessDayReady(ctx, tenantId);
    validateDayRange(args);
    await validateFilterIds(ctx, { tenantId, ...args });
    const rows = await readDailyStatsRows(ctx, {
        tenantId,
        ...args,
        limit: DAILY_STATS_READ_LIMIT,
    });
    return await buildSourcePerformance(ctx, tenantId, args, rows);
}
export async function readListTopOriginsByTeam(ctx: QueryCtx, tenantId: Id<"tenants">, args: ReaderArgs<typeof listTopOriginsByTeam>) {
    const limitPerTeam = normalizeLimit(args.limitPerTeam, MAX_TOP_ORIGINS_PER_TEAM);
    await assertLeadGenBusinessDayReady(ctx, tenantId);
    validateDayRange(args);
    await validateFilterIds(ctx, { tenantId, ...args });
    if (args.workerId) {
        return await listTopOriginsByTeamFromBoundedSubmissions(ctx, {
            tenantId,
            ...args,
            limitPerTeam,
        });
    }
    const result = await readTeamOriginStatRowsBounded(ctx, {
        tenantId,
        ...args,
        limit: TEAM_ORIGIN_STATS_READ_LIMIT,
    });
    if (result.capped) {
        throw new Error("Posts by team report is too large. Narrow the filters.");
    }
    return await groupTeamOriginRows(ctx, {
        tenantId,
        rows: result.rows.filter((row) => isRankableOriginKind(row.originKind)),
        limitPerTeam,
        sortBy: args.sortBy,
    });
}
