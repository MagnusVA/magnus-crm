import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { businessDateForInstant } from "../../lib/businessDay";
import { analyticsRangeDates, type ResolvedAnalyticsRange } from "../../lib/analyticsRange";
import { getReportDefinition } from "./registry";
import { analyticsRangeValidator } from "./schema";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
/** `lastRequestedAt` moves at most this often, so reads rarely write. */
export const REQUEST_TOUCH_INTERVAL_MS = HOUR_MS;
/** A pending run older than this is treated as lost and may start again. */
export const RUN_STALE_MS = 10 * 60 * 1000;
/** A failed answer waits this long before a page's request retries it. */
export const FAILURE_RETRY_MS = 5 * 60 * 1000;
/** Runs a page may start per tenant in 24 hours (§5). The batch doesn't count. */
export const DAILY_MISS_BUDGET = 30;
/** Keys the post-sync batch refreshes: opened in the last 7 days. */
export const RECENT_KEY_WINDOW_MS = 7 * DAY_MS;
/** Keys nobody opened for this long are deleted. */
export const KEY_TTL_MS = 14 * DAY_MS;
/** Stays under Convex's 1 MB document limit with the row's other fields. */
export const MAX_PAYLOAD_CHARS = 900_000;
/** Rows a report may hand to `finalize`. Templates aggregate in SQL. */
export const MAX_ROWS_JSON_CHARS = 4_000_000;

export const resolvedRangeValidator = v.object({
  startDate: v.string(),
  endDateInclusive: v.string(),
  fromMs: v.number(),
  toMs: v.number(),
  timeZone: v.string(),
  dayStartHour: v.number(),
});

export type AnalyticsResultState = {
  state: "missing" | "queued" | "pending" | "ready" | "failed";
  payloadJson: string | null;
  answer: NonNullable<Doc<"analyticsResults">["answer"]> | null;
  errorMessage: string | null;
};

export function resultState(row: Doc<"analyticsResults"> | null): AnalyticsResultState {
  if (!row) return { state: "missing", payloadJson: null, answer: null, errorMessage: null };
  return {
    state: row.status,
    payloadJson: row.payloadJson ?? null,
    answer: row.answer ?? null,
    errorMessage: row.status === "failed" ? (row.errorMessage ?? null) : null,
  };
}

export async function findResult(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  reportId: string,
  argsKey: string,
) {
  return await ctx.db
    .query("analyticsResults")
    .withIndex("by_tenantId_and_reportId_and_argsKey", (q) =>
      q.eq("tenantId", tenantId).eq("reportId", reportId).eq("argsKey", argsKey),
    )
    .unique();
}

/**
 * Whether a saved answer still covers the period its preset means at `now`.
 * "This month" computed last night still starts on the 1st; "yesterday"
 * computed yesterday doesn't.
 */
export function answerCoversPeriod(row: Doc<"analyticsResults">, now: number) {
  if (!row.answer) return false;
  if (row.range.kind === "custom") return true;
  const today = businessDateForInstant(now, {
    timeZone: row.timeZone,
    dayStartHour: row.dayStartHour,
  });
  const expected = analyticsRangeDates(row.range, today);
  if (expected.startDate !== row.answer.startDate) return false;
  const fixedEnd = row.range.preset === "yesterday" || row.range.preset === "last_month";
  return !fixedEnd || expected.endDateInclusive === row.answer.endDateInclusive;
}

export function runIsInFlight(row: Doc<"analyticsResults">, now: number) {
  return row.status === "pending" && row.run !== undefined && now - row.run.startedAt < RUN_STALE_MS;
}

export async function readSyncRow(ctx: QueryCtx) {
  return await ctx.db.query("analyticsSync").first();
}

export async function countRecentMisses(ctx: QueryCtx, tenantId: Id<"tenants">, now: number) {
  const misses = await ctx.db
    .query("analyticsResults")
    .withIndex("by_tenantId_and_missedAt", (q) =>
      q.eq("tenantId", tenantId).gte("missedAt", now - DAY_MS),
    )
    .take(DAILY_MISS_BUDGET + 1);
  return misses.length;
}

function newRunId(now: number) {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Marks a row pending for a new run and returns the run id. */
export async function startRun(
  ctx: MutationCtx,
  row: Doc<"analyticsResults">,
  args: { watermark: number; now: number; miss: boolean },
) {
  const runId = newRunId(args.now);
  await ctx.db.patch("analyticsResults", row._id, {
    status: "pending",
    run: { id: runId, watermark: args.watermark, startedAt: args.now },
    ...(args.miss ? { missedAt: args.now } : {}),
  });
  return runId;
}

/** The run's inputs, or null when a newer run replaced it. */
export const loadRun = internalQuery({
  args: { resultId: v.id("analyticsResults"), runId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      tenantId: v.id("tenants"),
      reportId: v.string(),
      filtersJson: v.string(),
      range: analyticsRangeValidator,
      timeZone: v.string(),
      dayStartHour: v.number(),
    }),
  ),
  handler: async (ctx, { resultId, runId }) => {
    const row = await ctx.db.get("analyticsResults", resultId);
    if (!row || row.run?.id !== runId) return null;
    return {
      tenantId: row.tenantId,
      reportId: row.reportId,
      filtersJson: row.filtersJson,
      range: row.range,
      timeZone: row.timeZone,
      dayStartHour: row.dayStartHour,
    };
  },
});

async function finalizePayload(
  ctx: QueryCtx,
  args: {
    reportId: string;
    tenantId: Id<"tenants">;
    filtersJson: string;
    range: ResolvedAnalyticsRange;
    rowsJson: string;
  },
) {
  const definition = getReportDefinition(args.reportId);
  const output = await definition.finalize(ctx, {
    tenantId: args.tenantId,
    filters: JSON.parse(args.filtersJson),
    range: args.range,
    rows: JSON.parse(args.rowsJson),
  });
  return JSON.stringify(output);
}

/** Finalizes and saves a run's answer. Ignores a run a newer one replaced. */
export const complete = internalMutation({
  args: {
    resultId: v.id("analyticsResults"),
    runId: v.string(),
    watermark: v.number(),
    range: resolvedRangeValidator,
    rowsJson: v.string(),
  },
  returns: v.object({ saved: v.boolean() }),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("analyticsResults", args.resultId);
    if (!row || row.run?.id !== args.runId) return { saved: false };
    const payloadJson = await finalizePayload(ctx, {
      reportId: row.reportId,
      tenantId: row.tenantId,
      filtersJson: row.filtersJson,
      range: args.range,
      rowsJson: args.rowsJson,
    });
    const now = Date.now();
    if (payloadJson.length > MAX_PAYLOAD_CHARS) {
      await ctx.db.patch("analyticsResults", row._id, {
        status: "failed",
        run: undefined,
        errorMessage: "This range is too large to show. Choose a shorter range.",
        failedAt: now,
      });
      return { saved: false };
    }
    await ctx.db.patch("analyticsResults", row._id, {
      status: "ready",
      payloadJson,
      answer: {
        watermark: args.watermark,
        startDate: args.range.startDate,
        endDateInclusive: args.range.endDateInclusive,
        completedAt: now,
      },
      run: undefined,
      errorMessage: undefined,
      failedAt: undefined,
    });
    return { saved: true };
  },
});

/** Records a failed run. The previous answer, if any, stays. */
export const fail = internalMutation({
  args: {
    resultId: v.id("analyticsResults"),
    runId: v.string(),
    errorMessage: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("analyticsResults", args.resultId);
    if (!row || row.run?.id !== args.runId) return null;
    await ctx.db.patch("analyticsResults", row._id, {
      status: "failed",
      run: undefined,
      errorMessage: args.errorMessage,
      failedAt: Date.now(),
    });
    return null;
  },
});

/** The same finalize step as `complete`, without saving. For parity runs. */
export const previewFinalize = internalQuery({
  args: {
    reportId: v.string(),
    tenantId: v.id("tenants"),
    filtersJson: v.string(),
    range: resolvedRangeValidator,
    rowsJson: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => await finalizePayload(ctx, args),
});
