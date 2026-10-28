import { v } from "convex/values";
import { internalMutation, internalQuery } from "../../_generated/server";
import { getTenantBusinessDay } from "../../lib/tenantBusinessDay";
import {
  addBusinessDays,
  businessDateForInstant,
  businessDayStart,
  validateBusinessDay,
  type BusinessDaySetting,
} from "../../../lib/businessDay";
import { browserDay } from "../../../lib/analyticsRange";
import { analyticsArgsKey, assertValidAnalyticsRange, canonicalJson } from "../keys";
import { findResult, readSyncRow, registerRequest, resultState } from "../results";
import { analyticsRangeValidator } from "../schema";
import { liveMetrics, parseApiMetricsFilters } from "./metrics";

// Internal reads behind `/api/v1` (convex/analytics/api/http.ts). The HTTP
// layer authenticates the key first and passes its tenant; nothing here
// takes a tenant from the request.

const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

const metricsArgs = {
  metrics: v.string(),
  granularity: v.string(),
  groupBy: v.string(),
};

function apiDay(tenantDay: BusinessDaySetting, timeZone: string | undefined) {
  const day = timeZone ? browserDay(timeZone) : tenantDay;
  validateBusinessDay(day);
  return day;
}

function filtersFrom(args: { metrics: string; granularity: string; groupBy: string }) {
  return parseApiMetricsFilters({ metrics: args.metrics, granularity: args.granularity, group_by: args.groupBy });
}

/** Registers an API metrics key and starts its run when nothing current answers it. */
export const requestMetrics = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    ...metricsArgs,
    range: analyticsRangeValidator,
    timeZone: v.optional(v.string()),
  },
  returns: v.object({ argsKey: v.string(), started: v.boolean() }),
  handler: async (ctx, args) => {
    const filters = filtersFrom(args);
    assertValidAnalyticsRange(args.range);
    const day = apiDay(await getTenantBusinessDay(ctx, args.tenantId), args.timeZone);
    const argsKey = analyticsArgsKey({ filters, range: args.range, day });
    const { started } = await registerRequest(ctx, {
      tenantId: args.tenantId,
      reportId: "api.metrics",
      argsKey,
      filtersJson: canonicalJson(filters),
      range: args.range,
      day,
    });
    return { argsKey, started };
  },
});

export const metricsAnswer = internalQuery({
  args: { tenantId: v.id("tenants"), argsKey: v.string() },
  returns: v.object({
    state: v.string(),
    payloadJson: v.union(v.string(), v.null()),
    watermark: v.union(v.number(), v.null()),
    errorMessage: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { tenantId, argsKey }) => {
    const state = await resultState(ctx, await findResult(ctx, tenantId, "api.metrics", argsKey));
    return {
      state: state.state,
      payloadJson: state.payloadJson,
      watermark: state.answer?.watermark ?? null,
      errorMessage: state.errorMessage,
    };
  },
});

/** The same metrics from Convex for any window. `/api/v1/today` and parity use it. */
export const liveMetricsForWindow = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    ...metricsArgs,
    fromMs: v.number(),
    toMs: v.number(),
    timeZone: v.string(),
    dayStartHour: v.number(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const answer = await liveMetrics(ctx, args.tenantId, filtersFrom(args), {
      fromMs: args.fromMs,
      toMs: args.toMs,
      day: { timeZone: args.timeZone, dayStartHour: args.dayStartHour },
    });
    return JSON.stringify(answer);
  },
});

/** Today's metrics, read live: the tenant's business day, or `timeZone` midnight to midnight. */
export const todayMetrics = internalQuery({
  args: { tenantId: v.id("tenants"), ...metricsArgs, timeZone: v.optional(v.string()) },
  returns: v.object({ date: v.string(), answerJson: v.string() }),
  handler: async (ctx, args) => {
    const day = apiDay(await getTenantBusinessDay(ctx, args.tenantId), args.timeZone);
    const date = businessDateForInstant(Date.now(), day);
    const answer = await liveMetrics(ctx, args.tenantId, filtersFrom(args), {
      fromMs: businessDayStart(date, day),
      toMs: businessDayStart(addBusinessDays(date, 1), day),
      day,
    });
    return { date, answerJson: JSON.stringify(answer) };
  },
});

const DIMENSION_LIMIT = 500;

export const dimensions = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    kind: v.union(v.literal("team-members"), v.literal("teams"), v.literal("programs")),
  },
  returns: v.array(v.object({ id: v.string(), name: v.string(), active: v.boolean() })),
  handler: async (ctx, { tenantId, kind }) => {
    if (kind === "team-members") {
      const rows = await ctx.db
        .query("teamMembers")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .take(DIMENSION_LIMIT);
      return rows.map((row) => ({ id: row._id, name: row.displayName, active: true }));
    }
    if (kind === "teams") {
      const rows = await ctx.db
        .query("attributionTeams")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .take(DIMENSION_LIMIT);
      return rows.map((row) => ({ id: row._id, name: row.displayName, active: row.isActive }));
    }
    const rows = await ctx.db
      .query("tenantPrograms")
      .withIndex("by_tenantId_and_archivedAt", (q) => q.eq("tenantId", tenantId))
      .take(DIMENSION_LIMIT);
    return rows.map((row) => ({ id: row._id, name: row.name, active: row.archivedAt === undefined }));
  },
});

export const freshness = internalQuery({
  args: {},
  returns: v.object({
    asOf: v.union(v.number(), v.null()),
    lastSyncEndedAt: v.union(v.number(), v.null()),
    nextExpectedRefresh: v.union(v.number(), v.null()),
  }),
  handler: async (ctx) => {
    const sync = await readSyncRow(ctx);
    const lastSyncEndedAt = sync?.lastSyncEndedAt ?? null;
    return {
      asOf: sync?.watermark ?? null,
      lastSyncEndedAt,
      nextExpectedRefresh: lastSyncEndedAt === null ? null : lastSyncEndedAt + SYNC_INTERVAL_MS,
    };
  },
});
