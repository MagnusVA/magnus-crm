import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { env, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { businessDateForInstant, type BusinessDaySetting } from "../../lib/businessDay";
import {
  analyticsRangeDates,
  analyticsRangeIsEmpty,
  type ResolvedAnalyticsRange,
} from "../../lib/analyticsRange";
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
/** UTF-8 bytes in one stored part of an answer: under Convex's 1 MiB document limit. */
export const PAYLOAD_PART_BYTES = 900_000;
/**
 * UTF-8 bytes of a whole answer, across its parts. Under the 16 MiB a query
 * may return and a transaction may read or write (both measured on the dev
 * deployment in November 2026). People's lead gen answer is the largest:
 * about 5 MB for a year.
 */
export const MAX_ANSWER_BYTES = 12_000_000;
/**
 * Rows a report may hand to `finalize` in the `complete` mutation. Reports
 * with more build in a Node action instead (`definition.node`).
 */
export const MAX_ROWS_JSON_CHARS = 4_000_000;
/** Parts one `deletePayloadParts` run deletes, so it reads well under 16 MiB. */
const PARTS_PER_DELETE = 6;
/**
 * Pause between deletion batches. A deployment has a write budget per second
 * (8 MiB on dev, measured), shared with every user's writes.
 */
const DELETE_BATCH_DELAY_MS = 1_000;
export const ANSWER_TOO_LARGE = "This range is too large to show. Choose a shorter range.";

export function answerBytes(json: string) {
  return new TextEncoder().encode(json).byteLength;
}

/**
 * Splits an answer into parts of at most `maxBytes` UTF-8 bytes, never
 * inside a character, so joining the parts gives back the same string.
 */
export function splitPayload(json: string, maxBytes = PAYLOAD_PART_BYTES): string[] {
  const parts: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let index = 0; index < json.length; ) {
    const code = json.codePointAt(index)!;
    const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + width > maxBytes) {
      parts.push(json.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += width;
    index += code > 0xffff ? 2 : 1;
  }
  parts.push(json.slice(start));
  return parts;
}

/** Whether every part fits a document and the whole answer fits the cap. */
function partsFit(parts: readonly string[]) {
  let total = 0;
  for (const part of parts) {
    const bytes = answerBytes(part);
    if (bytes > PAYLOAD_PART_BYTES) return false;
    total += bytes;
  }
  return total <= MAX_ANSWER_BYTES;
}

/** An answer's parts, in order: `payloadId` first, then `payloadPartIds`. */
export function payloadIdsOf(row: Doc<"analyticsResults">): Id<"analyticsPayloads">[] {
  return row.payloadId ? [row.payloadId, ...(row.payloadPartIds ?? [])] : [];
}

/**
 * Deletes parts no row points to any more, a few per transaction: a delete
 * reads the document, and an answer can be 12 MB.
 */
async function scheduleDeleteParts(ctx: MutationCtx, ids: Id<"analyticsPayloads">[], delayMs = 0) {
  if (ids.length > 0) await ctx.scheduler.runAfter(delayMs, internal.analytics.results.deletePayloadParts, { ids });
}

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
  const parts = await Promise.all(payloadIdsOf(row).map((id) => ctx.db.get("analyticsPayloads", id)));
  return {
    state: row.status,
    payloadJson: parts.length > 0 && parts.every((part) => part !== null) ? parts.map((part) => part!.json).join("") : null,
    answer: row.answer ?? null,
    errorMessage: row.status === "failed" ? (row.errorMessage ?? null) : null,
  };
}

/**
 * Deletes a key now and its answer's parts in later transactions, including
 * parts a crashed run stored and never saved.
 */
export async function deleteResult(ctx: MutationCtx, row: Doc<"analyticsResults">) {
  await ctx.db.delete("analyticsResults", row._id);
  await scheduleDeleteParts(ctx, payloadIdsOf(row));
  await ctx.scheduler.runAfter(0, internal.analytics.results.sweepResultParts, { resultId: row._id });
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

function rowToday(row: Doc<"analyticsResults">, now: number) {
  return businessDateForInstant(now, {
    timeZone: row.timeZone,
    dayStartHour: row.dayStartHour,
  });
}

/**
 * Whether a saved answer still covers the period its preset means at `now`.
 * "This month" computed last night still starts on the 1st; "yesterday"
 * computed yesterday doesn't, and neither does "this month through
 * yesterday".
 */
export function answerCoversPeriod(row: Doc<"analyticsResults">, now: number) {
  if (!row.answer) return false;
  if (row.range.kind === "custom") return true;
  const expected = analyticsRangeDates(row.range, rowToday(row, now));
  if (expected.startDate !== row.answer.startDate) return false;
  const fixedEnd =
    row.range.throughYesterday === true ||
    row.range.preset === "yesterday" ||
    row.range.preset === "last_month";
  return !fixedEnd || expected.endDateInclusive === row.answer.endDateInclusive;
}

/**
 * A preset ended yesterday, on its first day ("this week through yesterday"
 * on Monday). It has nothing to run until tomorrow; pages read today live.
 */
export function rangeHasNoDays(row: Doc<"analyticsResults">, now: number) {
  if (row.range.kind === "custom" || row.range.throughYesterday !== true) return false;
  return analyticsRangeIsEmpty(row.range, rowToday(row, now));
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
  if (runIsInFlight(row, now) || rangeHasNoDays(row, now)) return idle;
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
    // answer instead of waiting for a run that won't come. So does a row
    // whose answer is for an earlier period (last month's "last month"):
    // pages don't show that answer, and say the key is queued instead.
    const queue =
      row.status === "pending" ||
      (row.status !== "queued" && (!row.payloadId || !answerCoversPeriod(row, now)));
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

/**
 * Stores one part of a Node-built answer for the current run, or returns null
 * when a newer run replaced it. The Node action writes an answer one part per
 * transaction, spaced out, so a large answer never spends the deployment's
 * write budget in one burst; `complete` then points the row at the parts.
 */
export const storePayloadPart = internalMutation({
  args: { resultId: v.id("analyticsResults"), runId: v.string(), json: v.string() },
  returns: v.union(v.id("analyticsPayloads"), v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("analyticsResults", args.resultId);
    if (!row || row.run?.id !== args.runId) return null;
    if (answerBytes(args.json) > PAYLOAD_PART_BYTES) throw new Error("An answer part is over 900 KB.");
    return await ctx.db.insert("analyticsPayloads", { tenantId: row.tenantId, json: args.json, resultId: row._id });
  },
});

/**
 * Saves a run's answer. Takes either the rows, which it finalizes and stores
 * here in parts of at most 900 KB, or the parts a Node-built run already
 * stored (`payloadPartIds`, in order). Ignores a run a newer one replaced,
 * before writing anything. The old parts are deleted afterwards, unreferenced.
 */
export const complete = internalMutation({
  args: {
    resultId: v.id("analyticsResults"),
    runId: v.string(),
    watermark: v.number(),
    range: resolvedRangeValidator,
    rowsJson: v.optional(v.string()),
    payloadPartIds: v.optional(v.array(v.id("analyticsPayloads"))),
  },
  returns: v.object({ saved: v.boolean() }),
  handler: async (ctx, args) => {
    if ((args.rowsJson === undefined) === (args.payloadPartIds === undefined)) {
      throw new Error("complete takes rowsJson or payloadPartIds.");
    }
    const row = await ctx.db.get("analyticsResults", args.resultId);
    if (!row || row.run?.id !== args.runId) return { saved: false };
    const now = Date.now();
    let ids: Id<"analyticsPayloads">[];
    if (args.payloadPartIds !== undefined) {
      // The Node action checked the answer's size before storing its parts.
      ids = args.payloadPartIds;
    } else {
      const parts = splitPayload(
        await finalizePayload(ctx, {
          reportId: row.reportId,
          tenantId: row.tenantId,
          filtersJson: row.filtersJson,
          range: args.range,
          rowsJson: args.rowsJson!,
        }),
      );
      if (!partsFit(parts)) {
        await ctx.db.patch("analyticsResults", row._id, {
          status: "failed",
          run: undefined,
          errorMessage: ANSWER_TOO_LARGE,
          failedAt: now,
        });
        return { saved: false };
      }
      ids = [];
      for (const json of parts) {
        ids.push(await ctx.db.insert("analyticsPayloads", { tenantId: row.tenantId, json, resultId: row._id }));
      }
    }
    if (ids.length === 0) throw new Error("An answer has at least one part.");
    await scheduleDeleteParts(ctx, payloadIdsOf(row));
    await ctx.db.patch("analyticsResults", row._id, {
      status: "ready",
      payloadId: ids[0],
      payloadPartIds: ids.length > 1 ? ids.slice(1) : undefined,
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

/**
 * The same finalize step as `complete`, without saving, and with the same
 * answer cap, so parity fails where storage would. For parity runs and tests.
 */
export const previewFinalize = internalQuery({
  args: {
    reportId: v.string(),
    tenantId: v.id("tenants"),
    filtersJson: v.string(),
    range: resolvedRangeValidator,
    rowsJson: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const payloadJson = await finalizePayload(ctx, args);
    if (answerBytes(payloadJson) > MAX_ANSWER_BYTES) throw new Error(ANSWER_TOO_LARGE);
    return payloadJson;
  },
});

/**
 * A Node-built report's context (`definition.node.context`), as JSON, for
 * `analytics/runNode.ts`. Reads only small lookup tables of the run's tenant.
 */
export const reportContext = internalQuery({
  args: {
    reportId: v.string(),
    tenantId: v.id("tenants"),
    filtersJson: v.string(),
    range: resolvedRangeValidator,
    keys: v.array(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const definition = getReportDefinition(args.reportId);
    if (!definition.node) throw new Error(`${args.reportId} doesn't build in Node.`);
    const context = await definition.node.context(
      ctx,
      { tenantId: args.tenantId, filters: JSON.parse(args.filtersJson), range: args.range },
      args.keys,
    );
    return JSON.stringify(context);
  },
});

/** Deletes answer parts no row points to, a few at a time. Skips parts already gone. */
export const deletePayloadParts = internalMutation({
  args: { ids: v.array(v.id("analyticsPayloads")) },
  returns: v.null(),
  handler: async (ctx, { ids }) => {
    for (const id of ids.slice(0, PARTS_PER_DELETE)) {
      if (await ctx.db.get("analyticsPayloads", id)) await ctx.db.delete("analyticsPayloads", id);
    }
    await scheduleDeleteParts(ctx, ids.slice(PARTS_PER_DELETE), DELETE_BATCH_DELAY_MS);
    return null;
  },
});

/**
 * After a key is deleted: deletes every part still tagged with it, such as
 * parts a crashed run stored and never saved. A few per transaction.
 */
export const sweepResultParts = internalMutation({
  args: { resultId: v.id("analyticsResults") },
  returns: v.null(),
  handler: async (ctx, { resultId }) => {
    const parts = await ctx.db
      .query("analyticsPayloads")
      .withIndex("by_resultId", (q) => q.eq("resultId", resultId))
      .take(PARTS_PER_DELETE);
    for (const part of parts) await ctx.db.delete("analyticsPayloads", part._id);
    if (parts.length === PARTS_PER_DELETE) {
      await ctx.scheduler.runAfter(DELETE_BATCH_DELAY_MS, internal.analytics.results.sweepResultParts, { resultId });
    }
    return null;
  },
});

/**
 * Before reverting to code that stores one part per answer: deletes every
 * key whose answer has several parts, up to 100 per call. Run it until
 * `remaining` is 0: `npx convex run --prod analytics/results:deleteMultipartResults`.
 */
export const deleteMultipartResults = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number(), remaining: v.boolean() }),
  handler: async (ctx) => {
    let deleted = 0;
    let remaining = false;
    for await (const row of ctx.db.query("analyticsResults")) {
      if (row.payloadPartIds === undefined) continue;
      if (deleted === 100) {
        remaining = true;
        break;
      }
      await deleteResult(ctx, row);
      deleted += 1;
    }
    return { deleted, remaining };
  },
});
