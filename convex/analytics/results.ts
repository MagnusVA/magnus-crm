import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { env, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { businessDateForInstant, type BusinessDaySetting } from "../../lib/businessDay";
import { analyticsRangeDates, type ResolvedAnalyticsRange } from "../../lib/analyticsRange";
import { isClickHouseConfigured } from "./clickhouse";
import { analyticsPool } from "./pool";
import { getReportDefinition } from "./registry";
import { analyticsRangeValidator } from "./schema";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
/** `lastRequestedAt` moves at most this often, so reads rarely write. */
export const REQUEST_TOUCH_INTERVAL_MS = HOUR_MS;
/** A run that began executing this long ago is treated as lost and may start again. */
export const RUN_STALE_MS = 10 * 60 * 1000;
/** A run still waiting on `analyticsPool` this long is treated as lost. */
export const QUEUED_RUN_STALE_MS = HOUR_MS;
/** A failed answer waits this long before a page's request retries it. */
export const FAILURE_RETRY_MS = 5 * 60 * 1000;
/** Keys the post-sync batch refreshes: opened in the last 7 days. */
export const RECENT_KEY_WINDOW_MS = 7 * DAY_MS;
/** Keys nobody opened for this long are deleted. */
export const KEY_TTL_MS = 14 * DAY_MS;
/** UTF-8 bytes of an answer: under Convex's 1 MB document limit. */
export const MAX_PAYLOAD_BYTES = 900_000;
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

export async function resultState(
  ctx: QueryCtx,
  row: Doc<"analyticsResults"> | null,
): Promise<AnalyticsResultState> {
  if (!row) return { state: "missing", payloadJson: null, answer: null, errorMessage: null };
  const payload = row.payloadId ? await ctx.db.get("analyticsPayloads", row.payloadId) : null;
  return {
    state: row.status,
    payloadJson: payload?.json ?? null,
    answer: row.answer ?? null,
    errorMessage: row.status === "failed" ? (row.errorMessage ?? null) : null,
  };
}

/** Deletes a key and its answer. */
export async function deleteResult(ctx: MutationCtx, row: Doc<"analyticsResults">) {
  if (row.payloadId) await ctx.db.delete("analyticsPayloads", row.payloadId);
  await ctx.db.delete("analyticsResults", row._id);
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
  if (row.status !== "pending" || row.run === undefined) return false;
  // Time on the pool's queue isn't a sign the run was lost.
  return row.run.executingAt !== undefined
    ? now - row.run.executingAt < RUN_STALE_MS
    : now - row.run.startedAt < QUEUED_RUN_STALE_MS;
}

/**
 * Runs a tenant's pages and API callers may start in 24 hours (§5), from
 * `ANALYTICS_DAILY_RUN_BUDGET`. Unset, or not a whole number, means no limit.
 */
export function dailyRunBudget(): number | null {
  const value = env.ANALYTICS_DAILY_RUN_BUDGET?.trim();
  if (!value) return null;
  const budget = Number(value);
  return Number.isInteger(budget) && budget >= 0 ? budget : null;
}

export async function readSyncRow(ctx: QueryCtx) {
  return await ctx.db.query("analyticsSync").first();
}

/**
 * Runs pages and API callers started in the last day, every run counted, so a
 * key that keeps failing uses the budget too. A key's count covers its
 * current window, which can start up to a day before its latest run.
 */
export async function countRecentMisses(ctx: QueryCtx, tenantId: Id<"tenants">, now: number, budget: number) {
  const rows = await ctx.db
    .query("analyticsResults")
    .withIndex("by_tenantId_and_missedAt", (q) =>
      q.eq("tenantId", tenantId).gte("missedAt", now - DAY_MS),
    )
    .take(budget + 1);
  return rows.reduce((total, row) => total + (row.missCount ?? 1), 0);
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
  const windowOpen = row.missWindowStart !== undefined && args.now - row.missWindowStart < DAY_MS;
  await ctx.db.patch("analyticsResults", row._id, {
    status: "pending",
    run: { id: runId, watermark: args.watermark, startedAt: args.now },
    ...(args.miss
      ? {
          missedAt: args.now,
          missWindowStart: windowOpen ? row.missWindowStart : args.now,
          missCount: windowOpen ? (row.missCount ?? 0) + 1 : 1,
        }
      : {}),
  });
  return runId;
}

/**
 * Registers a key someone opened (a page or an API caller) for the post-sync
 * batch, and runs it now only when no answer covers the current sync and
 * period, within the tenant's daily budget. Concurrent calls for one key
 * insert one row and start one run.
 */
export async function registerRequest(
  ctx: MutationCtx,
  input: {
    tenantId: Id<"tenants">;
    reportId: string;
    argsKey: string;
    filtersJson: string;
    range: Doc<"analyticsResults">["range"];
    day: BusinessDaySetting;
  },
): Promise<{ started: boolean; resultId: Id<"analyticsResults"> }> {
  const now = Date.now();
  const sync = await readSyncRow(ctx);
  const watermark = sync?.watermark ?? 0;

  let row = await findResult(ctx, input.tenantId, input.reportId, input.argsKey);
  if (!row) {
    const resultId = await ctx.db.insert("analyticsResults", {
      tenantId: input.tenantId,
      reportId: input.reportId,
      argsKey: input.argsKey,
      filtersJson: input.filtersJson,
      range: input.range,
      timeZone: input.day.timeZone,
      dayStartHour: input.day.dayStartHour,
      status: "queued",
      lastRequestedAt: now,
    });
    row = (await ctx.db.get("analyticsResults", resultId))!;
  } else if (now - row.lastRequestedAt >= REQUEST_TOUCH_INTERVAL_MS) {
    await ctx.db.patch("analyticsResults", row._id, { lastRequestedAt: now });
  }
  const idle = { started: false, resultId: row._id };

  if (!isClickHouseConfigured()) {
    if (row.status !== "failed") {
      await ctx.db.patch("analyticsResults", row._id, {
        status: "failed",
        errorMessage: "The reporting database isn't configured on this deployment.",
        failedAt: now,
      });
    }
    return idle;
  }
  if (runIsInFlight(row, now)) return idle;
  const current =
    row.answer !== undefined && row.answer.watermark >= watermark && answerCoversPeriod(row, now);
  if (row.status === "ready" && current) return idle;
  if (row.status === "failed" && row.failedAt !== undefined && now - row.failedAt < FAILURE_RETRY_MS) {
    return idle;
  }
  const budget = dailyRunBudget();
  if (budget !== null && (await countRecentMisses(ctx, input.tenantId, now, budget)) >= budget) {
    // The next post-sync batch answers it. A stale run is dropped, so its
    // action, if it still waits on the pool, finds no run and doesn't query.
    // A pending row becomes queued even with an answer, so callers show that
    // answer instead of waiting for a run that won't come.
    const queue = row.status === "pending" || (row.status !== "queued" && !row.payloadId);
    if (queue || row.run !== undefined) {
      await ctx.db.patch("analyticsResults", row._id, {
        ...(queue ? { status: "queued" as const } : {}),
        run: undefined,
      });
    }
    return idle;
  }

  const runId = await startRun(ctx, row, { watermark, now, miss: true });
  await analyticsPool.enqueueAction(ctx, internal.analytics.run.runReport, { resultId: row._id, runId });
  return { started: true, resultId: row._id };
}

/**
 * Marks the run as executing and returns its inputs, or null when a newer run
 * replaced it.
 */
export const beginRun = internalMutation({
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
    await ctx.db.patch("analyticsResults", resultId, { run: { ...row.run, executingAt: Date.now() } });
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
    if (new TextEncoder().encode(payloadJson).byteLength > MAX_PAYLOAD_BYTES) {
      await ctx.db.patch("analyticsResults", row._id, {
        status: "failed",
        run: undefined,
        errorMessage: "This range is too large to show. Choose a shorter range.",
        failedAt: now,
      });
      return { saved: false };
    }
    const payloadId = await ctx.db.insert("analyticsPayloads", { tenantId: row.tenantId, json: payloadJson });
    if (row.payloadId) await ctx.db.delete("analyticsPayloads", row.payloadId);
    await ctx.db.patch("analyticsResults", row._id, {
      status: "ready",
      payloadId,
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
