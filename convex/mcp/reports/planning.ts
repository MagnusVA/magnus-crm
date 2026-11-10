import { v } from "convex/values";
import type { QueryCtx } from "../../_generated/server";
import { internalQuery } from "../../_generated/server";
import { requireMcpAdmin, loadInTenant, mcpCallerValidator } from "../guard";
import { analyticsArgsKey, canonicalJson } from "../../analytics/keys";
import { getTenantBusinessDay } from "../../lib/tenantBusinessDay";
import { findResult, readSyncRow, resultState } from "../../analytics/results";
import { isClickHouseConfigured } from "../../analytics/clickhouse";
import { planAssistantSources, cachedWindowFits, assertReportCells, rangePeriods, reportLimit, type SourceWindow, type AssistantRange } from "../../../lib/assistantReportPlan";
import { settledThroughDate, type ResolvedAnalyticsRange } from "../../../lib/analyticsRange";
import { addBusinessDays, businessDateForInstant, businessDayStart } from "../../../lib/businessDay";
import type { AnalyticsFilters } from "../../analytics/definition";
import { requestValidator, jobValidator, type ToolRequest, type ReportJob } from "./contracts";
import { assistantDefinition, REPORT_PANELS, CURRENT_REPORT_PAGES, LIVE_PANELS } from "./catalog";
import { apiFilters, assistantApiAnswer, metricPage } from "./metrics";
import { readFieldCatalog } from "../../reports/formFields";
import { readMemberProfile } from "../../reports/member";
export type PanelInput = {
    id: string;
    filters: AnalyticsFilters;
    period: "current" | "comparison";
    window: SourceWindow;
    job: ReportJob | null;
};
export type Prepared = {
    resolvedRange: ResolvedAnalyticsRange;
    businessDay: {
        timeZone: string;
        startHour: number;
    };
    inputs: PanelInput[];
    limit: number;
    syncWatermark: number;
    configured: boolean;
    path: string;
};
function comparisonRange(request: Extract<ToolRequest, {
    kind: "numbers";
}>, range: ResolvedAnalyticsRange): AssistantRange | null {
    if (!request.compareTo)
        return null;
    if (typeof request.compareTo !== "string")
        return request.compareTo;
    const days = rangePeriods(range);
    if (request.compareTo === "previous_period")
        return { kind: "custom", startDate: addBusinessDays(range.startDate, -days), endDateInclusive: addBusinessDays(range.startDate, -1) };
    if (request.compareTo === "same_period_last_week")
        return { kind: "custom", startDate: addBusinessDays(range.startDate, -7), endDateInclusive: addBusinessDays(range.endDateInclusive, -7) };
    const previousMonth = (date: string) => {
        const [y, m, d] = date.split("-").map(Number);
        const last = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
        return new Date(Date.UTC(y, m - 2, Math.min(d, last))).toISOString().slice(0, 10);
    };
    return { kind: "custom", startDate: previousMonth(range.startDate), endDateInclusive: previousMonth(range.endDateInclusive) };
}
export async function prepareReport(ctx: QueryCtx, caller: Parameters<typeof requireMcpAdmin>[1], request: ToolRequest): Promise<Prepared> {
    const me = await requireMcpAdmin(ctx, caller, { permission: "reports:view" });
    const limit = reportLimit(request.limit);
    const day = await getTenantBusinessDay(ctx, me.tenantId);
    const today = businessDateForInstant(Date.now(), day);
    const range = request.range ?? { kind: "preset" as const, preset: "today" as const };
    const sync = await readSyncRow(ctx);
    const syncWatermark = sync?.watermark ?? 0;
    const settledThrough = settledThroughDate(today, sync?.watermark ?? null, businessDayStart(today, day));
    const base = planAssistantSources({ range, day, now: Date.now(), page: "", warehousePages: [] });
    const compare = request.kind === "numbers" ? comparisonRange(request, base.resolvedRange) : null;
    // No data reader, cache lookup or job runs before this output-size check.
    const periods = request.kind === "numbers" && request.groupBy === "day" ? rangePeriods(base.resolvedRange) : 1;
    const groups = request.kind === "numbers" && request.groupBy && request.groupBy !== "day" ? limit + 1 : 1;
    assertReportCells(periods * (compare ? 2 : 1), groups);
    if (request.kind === "numbers") {
        if (!request.metrics.length || request.metrics.length > 17)
            throw new Error("Choose 1 to 17 metrics.");
        // Validate supported metric/group combinations before reading report inputs.
        apiFilters({ metrics: request.metrics.join(","), group_by: request.groupBy === "day" ? "none" : request.groupBy ?? "none", granularity: request.groupBy === "day" ? "day" : "total" });
    }
    else {
        if (request.programId && !["scorecard", "calls"].includes(request.report) || request.closerId && request.report !== "calls" || request.callType && request.report !== "calls" || request.memberId && request.report !== "people" || request.fieldKey && request.report !== "scorecard" || request.teamId && request.report !== "lead_gen")
            throw new Error("Choose filters supported by this report: programId for scorecard/calls, closerId and callType for calls, memberId for people, fieldKey for scorecard, teamId for lead_gen.");
        if (request.memberId) await loadInTenant(ctx, me, "teamMembers", request.memberId);
        if (request.programId)
            await loadInTenant(ctx, me, "tenantPrograms", request.programId);
        if (request.closerId)
            await loadInTenant(ctx, me, "users", request.closerId);
        if (request.teamId)
            await loadInTenant(ctx, me, "attributionTeams", request.teamId);
    }
    const inputs: PanelInput[] = [];
    let reportPanels: readonly string[] = request.kind === "report" ? REPORT_PANELS[request.report] : [];
    let fieldKey: string | undefined;
    if (request.kind === "report" && request.report === "scorecard") {
        const catalog = await readFieldCatalog(ctx, me.tenantId);
        // Same default selection as Scorecard's defaultAnswerField.
        fieldKey = request.fieldKey ?? (catalog.find(f => /income|revenue|earn|salary|budget|invest|make per/iu.test(f.currentLabel)) ?? catalog[0])?.fieldKey;
        if (!fieldKey) reportPanels = reportPanels.filter(id => id !== "scorecard.answers");
    }
    if (request.kind === "report" && request.report === "people" && request.memberId) {
        const profile = await readMemberProfile(ctx, me.tenantId, request.memberId);
        const rolePanels = { closer: "people.closers", setter: "people.setters", dm_closer: "people.dm_closers", lead_gen: "people.lead_gen" };
        reportPanels = ["people.profile", ...(profile?.roles ?? []).map(role => rolePanels[role])];
    }
    const panels = request.kind === "numbers"
        ? [...new Set(request.metrics.map(metricPage))].map(page => ({ id: "mcp.metrics", page, raw: { metrics: request.metrics.filter(m => metricPage(m) === page).join(","), group_by: request.groupBy === "day" ? "none" : request.groupBy ?? "none", granularity: request.groupBy === "day" ? "day" : "total" } as AnalyticsFilters }))
        : reportPanels.map(id => ({ id, page: id.split(".")[0], raw: { ...(request.programId ? { programId: request.programId } : {}), ...(request.teamId ? { teamId: request.teamId } : {}), ...(request.closerId ? { closerId: request.closerId } : {}), ...(request.memberId ? { memberId: request.memberId } : {}), ...(request.callType ? { callType: request.callType } : {}), ...(fieldKey ? { fieldKey } : {}) } as AnalyticsFilters }));
    for (const period of ["current", ...(compare ? ["comparison"] : [])] as Array<"current" | "comparison">) {
        for (const panel of panels) {
            const currentState = LIVE_PANELS.has(panel.id);
            const definition = currentState ? null : assistantDefinition(panel.id);
            const filters = definition ? await definition.parseFilters(ctx, panel.raw, me) : panel.raw;
            const plan = planAssistantSources({ range: period === "comparison" ? compare! : range, day, now: Date.now(), page: currentState ? "" : panel.page, warehousePages: currentState ? [] : me.tenant.analyticsReports ?? [], reportId: panel.id, ...(CURRENT_REPORT_PAGES.some(page => page === panel.page) ? { settledThrough } : {}) });
            for (const window of plan.windows) {
                const job = window.engine === "warehouse" ? {
                    key: canonicalJson({ report: panel.id, args: analyticsArgsKey({ filters, range: window.range, day }), from: window.window.startDate, to: window.window.endDateInclusive, syncWatermark }),
                    report: panel.id, filtersJson: canonicalJson(filters), range: window.range, window: window.window, syncWatermark,
                } : null;
                inputs.push({ id: panel.id, filters, period, window, job });
            }
        }
    }
    return { resolvedRange: base.resolvedRange, businessDay: { timeZone: day.timeZone, startHour: day.dayStartHour }, inputs, limit, syncWatermark, configured: isClickHouseConfigured(), path: request.kind === "numbers" ? "/workspace/reports/scorecard" : request.report === "lead_gen" || request.report === "qualifications" ? `/workspace/operations/${request.report === "lead_gen" ? "lead-gen" : "qualifications"}` : `/workspace/reports/${request.report}${request.report === "people" && request.memberId ? `/${request.memberId}` : ""}` };
}
export const prepare = internalQuery({ args: { caller: mcpCallerValidator, request: requestValidator }, returns: v.string(), handler: async (ctx, args) => JSON.stringify(await prepareReport(ctx, args.caller, args.request)) });
export type JobAnswer = {
    status: "ready" | "pending" | "failed" | "unavailable";
    data?: unknown;
    watermark?: number;
    reason?: string;
};
/** Reuse a fresh web-owned cache without updating even its lastRequestedAt. */
export async function readJob(ctx: QueryCtx, tenantId: Parameters<typeof findResult>[1], job: ReportJob): Promise<JobAnswer> {
    {
        const key = analyticsArgsKey({ filters: job.report === "mcp.metrics" ? apiFilters(JSON.parse(job.filtersJson)) : JSON.parse(job.filtersJson), range: job.range, day: { timeZone: job.window.timeZone, dayStartHour: job.window.dayStartHour } });
        const cached = await findResult(ctx, tenantId, job.report === "mcp.metrics" ? "api.metrics" : job.report, key);
        if (cached?.answer && cached.answer.watermark >= job.syncWatermark && cachedWindowFits(job.window, cached.answer)) {
            const state = await resultState(ctx, cached);
            if (state.payloadJson !== null)
                return { status: "ready", data: job.report === "mcp.metrics" ? assistantApiAnswer(JSON.parse(state.payloadJson), String(JSON.parse(job.filtersJson).metrics)) : JSON.parse(state.payloadJson), watermark: cached.answer.watermark };
        }
    }
    const row = await ctx.db.query("mcpReportRequests").withIndex("by_tenantId_and_key", q => q.eq("tenantId", tenantId).eq("key", job.key)).unique();
    if (!row || row.expiresAt <= Date.now())
        return { status: "pending" };
    if (row.status === "ready" && row.resultJson !== undefined)
        return { status: "ready", data: JSON.parse(row.resultJson), watermark: row.watermark };
    if (row.status === "failed")
        return { status: "failed", reason: row.error ?? "warehouse_failed" };
    return { status: "pending" };
}
export const jobStates = internalQuery({ args: { caller: mcpCallerValidator, jobs: v.array(jobValidator) }, returns: v.string(), handler: async (ctx, args) => {
        const me = await requireMcpAdmin(ctx, args.caller, { permission: "reports:view" });
        const answers = [];
        for (const job of args.jobs)
            answers.push(await readJob(ctx, me.tenantId, job));
        return JSON.stringify(answers);
    } });
