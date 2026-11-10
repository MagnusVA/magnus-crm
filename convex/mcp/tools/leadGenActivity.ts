import { v, type Infer } from "convex/values";
import { z } from "zod";
import { DEFAULT_BUSINESS_DAY, businessDateForInstant } from "../../../lib/businessDay";
import { answerCoversDays, answerDays, dashboardRangePlan, type AnalyticsRange } from "../../../lib/analyticsRange";
import { internal } from "../../_generated/api";
import { internalAction, internalMutation, internalQuery } from "../../_generated/server";
import { reportDefinitionFor, resolveReportRequest } from "../../analytics/keys";
import { mergeMyActivitySummary } from "../../analytics/merge/leadGen";
import { findResult, registerRequest, resultState } from "../../analytics/results";
import { analyticsRangeValidator } from "../../analytics/schema";
import { deriveOverviewRange, toPublicOverviewRange } from "../../dashboard/overviewRange";
import { getMyActivitySummaryCore, getOwnLeadGenProfile, leadGenProfileValidator, listMyRecentSubmissionsCore } from "../../leadGen/activity";
import { leadGenBusinessDayBlocked } from "../../lib/businessDayRebuildState";
import { rejectRequest } from "../../lib/observability/errors";
import { McpProjectionBudget, mcpPersonTextValidator } from "../../lib/respark/mcp";
import { LEAD_GEN_ROLES, mcpCallerValidator, requireMcpUser, type McpUser } from "../guard";
import { leadGenRangeArgs, resolveLeadGenRange, type LeadGenActionCaller, type LeadGenRangeArgs } from "../leadGenShared";
import { formatLocal } from "../time";

export const myActivityArgs = { ...leadGenRangeArgs, cursor: v.optional(v.string()) };
const nullableNumber = v.union(v.number(), v.null());
const rangeValidator = v.object({ startBusinessDate: v.string(), endBusinessDateInclusive: v.string(),
  endBusinessDateExclusive: v.string(), dayCount: v.number(), label: v.string(), operationsBoundary: v.literal("tenant_business_day") });
const summaryValidator = v.object({ range: rangeValidator, submissions: v.number(), resparks: v.number(), entries: v.number(),
  notAFit: v.number(), scheduledHours: v.number(), leadsPerHour: nullableNumber });
type Summary = Infer<typeof summaryValidator>;
const metricsValidator = v.object({ rawLeads: v.number(), resparks: v.number(), entries: v.number(), notAFit: v.number(),
  scheduledHours: v.number(), leadsPerHour: nullableNumber });
const recentRowValidator = v.object({ id: v.string(), submittedAt: v.number(), type: v.string(), source: v.string(),
  originKind: v.string(), originValue: v.union(mcpPersonTextValidator, v.null()), handle: v.union(v.string(), v.null()), voided: v.boolean() });
const activityReadResultValidator = v.object({ state: v.union(v.literal("ready"), v.literal("pending"), v.literal("failed")),
  profile: leadGenProfileValidator, range: rangeValidator, source: v.union(v.literal("live"), v.literal("warehouse")),
  asOf: nullableNumber, isPartial: v.boolean(), textTruncated: v.boolean(), numbers: v.union(metricsValidator, v.null()),
  recent: v.array(recentRowValidator), cursor: v.union(v.string(), v.null()) });
const activityResultValidator = v.object({ ...activityReadResultValidator.fields,
  asOf: v.union(v.string(), v.null()),
  recent: v.array(v.object({ ...recentRowValidator.fields, submittedAt: v.string() })),
});
type ActivityResult = Infer<typeof activityResultValidator>;
type ActivityReadResult = Infer<typeof activityReadResultValidator>;
type ActivityRead = { result: ActivityReadResult; todaySummary: Summary | null; history: AnalyticsRange | null };

function activityPlan(me: McpUser, args: LeadGenRangeArgs) {
  const day = me.tenant.businessDay ?? DEFAULT_BUSINESS_DAY;
  const today = businessDateForInstant(Date.now(), day);
  const dates = resolveLeadGenRange(args, today, { maxDays: 120 });
  const range = { kind: "custom" as const, startBusinessDate: dates.startDayKey, endBusinessDateInclusive: dates.endDayKey };
  const plan = dashboardRangePlan(range, today);
  const warehouse = plan.kind !== "live" && me.tenant.analyticsReports?.includes("my_activity") === true;
  const history = plan.kind === "live" || !warehouse ? null : plan.kind === "split" ? plan.history : plan.range;
  return { today, range, plan, history, source: warehouse ? "warehouse" as const : "live" as const, day };
}

// The cursor belongs to one caller and one resolved range, including across midnight.
function cursorKey(me: McpUser, range: unknown) { return JSON.stringify([me.tenantId, me.userId, range]); }
function readCursor(cursor: string | undefined, key: string) {
  if (!cursor) return null;
  try {
    const value: unknown = JSON.parse(cursor);
    if (value && typeof value === "object" && "key" in value && value.key === key && "cursor" in value && typeof value.cursor === "string") return value.cursor;
  } catch { /* Treat malformed and foreign cursors alike. */ }
  throw rejectRequest("activity.invalid_cursor", "Use a cursor from your activity for this same range.");
}

export const readActivity = internalQuery({
  args: { caller: mcpCallerValidator, ...myActivityArgs },
  returns: v.object({ result: activityReadResultValidator, todaySummary: v.union(summaryValidator, v.null()), history: v.union(analyticsRangeValidator, v.null()) }),
  handler: async (ctx, { caller, ...args }): Promise<ActivityRead> => {
    const me = await requireMcpUser(ctx, caller, LEAD_GEN_ROLES);
    const info = activityPlan(me, args);
    const { worker, profile } = await getOwnLeadGenProfile(ctx, me);
    const budget = new McpProjectionBudget();
    if (profile.team) profile.team.name = budget.text(profile.team.name);
    const publicRange = toPublicOverviewRange(deriveOverviewRange(info.range, Date.now(), info.day));
    const key = cursorKey(me, info.range);
    const cursor = readCursor(args.cursor, key);
    const base: ActivityReadResult = { profile, range: publicRange, state: "ready", source: info.source, asOf: Date.now(),
      numbers: null, recent: [], cursor: null, isPartial: false, textTruncated: budget.textTruncated };
    if (!worker || !worker.isActive || profile.noTeam) return { result: { ...base, isPartial: true }, todaySummary: null, history: null };
    if (await leadGenBusinessDayBlocked(ctx, me.tenantId)) return { result: { ...base, state: "pending", isPartial: true, asOf: null }, todaySummary: null, history: null };
    const recent = await listMyRecentSubmissionsCore(ctx, me, { range: info.range, paginationOpts: { cursor, numItems: 25 } }, { includeVoided: true });
    const rows = recent.page.map(row => ({ id: row._id, submittedAt: row.submittedAt, type: row.type, source: row.source,
      originKind: row.originKind, originValue: row.originValue ? budget.personText(row.originValue) : null,
      handle: row.prospect?.normalizedHandle ? budget.text(row.prospect.normalizedHandle) : null, voided: row.voided ?? false }));
    const liveRange = info.history ? info.plan.kind === "split" ? { kind: "custom" as const, startBusinessDate: info.today, endBusinessDateInclusive: info.today } : null : info.range;
    const summary = liveRange ? await getMyActivitySummaryCore(ctx, me, { range: liveRange }) : null;
    return { result: { ...base, numbers: !info.history && summary ? metrics(summary) : null,
      recent: rows, cursor: recent.isDone ? null : JSON.stringify({ key, cursor: recent.continueCursor }),
      isPartial: !recent.isDone || budget.isPartial, textTruncated: budget.textTruncated },
      todaySummary: info.history ? summary : null, history: info.history };
  },
});

const reportArgs = { caller: mcpCallerValidator, ...leadGenRangeArgs };
export const requestHistory = internalMutation({
  args: reportArgs,
  returns: v.null(),
  handler: async (ctx, { caller, ...args }) => {
    const me = await requireMcpUser(ctx, caller, LEAD_GEN_ROLES);
    const { history } = activityPlan(me, args);
    if (!history) return null;
    const request = await resolveReportRequest(ctx, { reportId: "my_activity.summary", filters: {}, range: history, timeZone: me.timeZone }, reportDefinitionFor("my_activity.summary"), me);
    await registerRequest(ctx, { tenantId: me.tenantId, reportId: request.definition.id, argsKey: request.argsKey,
      filtersJson: request.filtersJson, range: history, day: request.day });
    return null;
  },
});

export const readHistory = internalQuery({
  args: reportArgs,
  returns: v.object({ state: v.union(v.literal("ready"), v.literal("pending"), v.literal("failed")), summary: v.union(summaryValidator, v.null()), asOf: nullableNumber, wait: v.boolean() }),
  handler: async (ctx, { caller, ...args }) => {
    const me = await requireMcpUser(ctx, caller, LEAD_GEN_ROLES);
    const info = activityPlan(me, args);
    if (!info.history) return { state: "pending" as const, summary: null, asOf: null, wait: false };
    const request = await resolveReportRequest(ctx, { reportId: "my_activity.summary", filters: {}, range: info.history, timeZone: me.timeZone }, reportDefinitionFor("my_activity.summary"), me);
    const state = await resultState(ctx, await findResult(ctx, me.tenantId, request.definition.id, request.argsKey));
    if (state.state === "failed") return { state: "failed" as const, summary: null, asOf: null, wait: false };
    if (state.state !== "ready" || !state.payloadJson || !answerCoversDays(state.answer, answerDays(info.plan, true)))
      return { state: "pending" as const, summary: null, asOf: null, wait: state.state !== "queued" };
    // Stored warehouse payloads are JSON. Validate their numbers before exposing them.
    const number = z.number().finite().nonnegative();
    let payload: unknown;
    try { payload = JSON.parse(state.payloadJson); }
    catch { return { state: "failed" as const, summary: null, asOf: null, wait: false }; }
    const parsed = z.object({ submissions: number, resparks: number, entries: number, notAFit: number,
      scheduledHours: number, leadsPerHour: number.nullable() }).safeParse(payload);
    if (!parsed.success || !state.answer) return { state: "failed" as const, summary: null, asOf: null, wait: false };
    const range = toPublicOverviewRange(deriveOverviewRange({ kind: "custom", startBusinessDate: state.answer.startDate,
      endBusinessDateInclusive: state.answer.endDateInclusive }, Date.now(), info.day));
    return { state: "ready" as const, summary: { ...parsed.data, range }, asOf: state.answer.watermark, wait: false };
  },
});

function metrics(summary: Summary) { return { rawLeads: summary.submissions, resparks: summary.resparks,
  entries: summary.entries, notAFit: summary.notAFit, scheduledHours: summary.scheduledHours, leadsPerHour: summary.leadsPerHour }; }

export const myActivity = internalAction({
  args: { caller: mcpCallerValidator, ...myActivityArgs },
  returns: activityResultValidator,
  handler: async (ctx, { caller, ...args }): Promise<ActivityResult> => {
    const deadline = Date.now() + 25_000;
    const authArgs = { caller, roles: [...LEAD_GEN_ROLES] };
    const first: LeadGenActionCaller = await ctx.runQuery(internal.mcp.leadGenShared.authorizeCaller, authArgs);
    const fixedArgs = resolveLeadGenRange(args, first.todayDayKey, { maxDays: 120 });
    const dated = { startDate: fixedArgs.startDayKey, endDate: fixedArgs.endDayKey };
    const read: ActivityRead = await ctx.runQuery(internal.mcp.tools.leadGenActivity.readActivity, { caller, ...dated, cursor: args.cursor });
    let result = read.result;
    if (read.history) {
      await ctx.runMutation(internal.mcp.tools.leadGenActivity.requestHistory, { caller, ...dated });
      for (;;) {
        const state: { state: "ready" | "pending" | "failed"; summary: Summary | null; asOf: number | null; wait: boolean } = await ctx.runQuery(internal.mcp.tools.leadGenActivity.readHistory, { caller, ...dated });
        if (state.state === "ready" && state.summary) {
          const summary = read.todaySummary ? mergeMyActivitySummary(state.summary, read.todaySummary) : state.summary;
          result = { ...read.result, state: "ready", numbers: metrics(summary), asOf: state.asOf };
          break;
        }
        result = { ...result, state: state.state === "failed" ? "failed" : "pending", numbers: null, recent: [], cursor: null, asOf: null, isPartial: true };
        if (state.state === "failed" || !state.wait || Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(1_500, Math.max(0, deadline - Date.now()))));
      }
    }
    await ctx.runQuery(internal.mcp.leadGenShared.authorizeCaller, authArgs);
    return { ...result, asOf: result.asOf === null ? null : formatLocal(result.asOf, first.timeZone),
      recent: result.recent.map(row => ({ ...row, submittedAt: formatLocal(row.submittedAt, first.timeZone) })) };
  },
});
