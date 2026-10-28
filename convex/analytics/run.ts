import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import { reportError } from "../lib/observability/log";
import { resolveAnalyticsRange } from "../../lib/analyticsRange";
import {
  ClickHouseNotConfiguredError,
  queryTenantClickHouse,
  queryWatermark,
  type SqlRow,
} from "./clickhouse";
import type { AnyReportDefinition, ReportInput, AnalyticsFilters } from "./definition";
import { getReportDefinition } from "./registry";
import { MAX_ROWS_JSON_CHARS, RECENT_KEY_WINDOW_MS } from "./results";

const BATCH_PAGE_SIZE = 20;
const BATCH_CONCURRENCY = 2;
/** At current volumes a tenant has a few dozen keys; this bounds a bad week. */
const MAX_KEYS_PER_TENANT = 300;

class WaitingForFirstSyncError extends Error {
  constructor() {
    super("Reporting data arrives after the first sync. Check back in a few hours.");
    this.name = "WaitingForFirstSyncError";
  }
}

class RowsTooLargeError extends Error {
  constructor() {
    super("This range is too large to show. Choose a shorter range.");
    this.name = "RowsTooLargeError";
  }
}

function userMessage(error: unknown) {
  if (
    error instanceof ClickHouseNotConfiguredError ||
    error instanceof WaitingForFirstSyncError ||
    error instanceof RowsTooLargeError
  ) {
    return error.message;
  }
  return "The reporting database couldn't answer this range. It tries again after the next refresh.";
}

/**
 * Runs a report's queries one after another and returns the rows as JSON.
 * magnus_app may run 4 queries at once: the batch runs 2 reports at a time,
 * and `analyticsPool` the 2 others.
 */
export async function fetchReportRows(
  definition: AnyReportDefinition,
  input: ReportInput<AnalyticsFilters>,
): Promise<string> {
  const rows: Record<string, SqlRow[]> = {};
  for (const [name, query] of Object.entries(definition.sql(input))) {
    rows[name] = await queryTenantClickHouse(input.tenantId, query);
  }
  const rowsJson = JSON.stringify(rows);
  if (rowsJson.length > MAX_ROWS_JSON_CHARS) throw new RowsTooLargeError();
  return rowsJson;
}

async function executeRun(
  ctx: ActionCtx,
  args: { resultId: Id<"analyticsResults">; runId: string },
  known: { watermark?: number } = {},
) {
  const job = await ctx.runMutation(internal.analytics.results.beginRun, args);
  if (!job) return;
  try {
    const definition = getReportDefinition(job.reportId);
    const watermark = known.watermark ?? (await queryWatermark());
    if (watermark === null) throw new WaitingForFirstSyncError();
    const range = resolveAnalyticsRange(
      job.range,
      { timeZone: job.timeZone, dayStartHour: job.dayStartHour },
      Date.now(),
    );
    const rowsJson = await fetchReportRows(definition, {
      tenantId: job.tenantId,
      filters: JSON.parse(job.filtersJson) as AnalyticsFilters,
      range,
    });
    await ctx.runMutation(internal.analytics.results.complete, {
      ...args,
      watermark,
      range,
      rowsJson,
    });
  } catch (error) {
    if (!(error instanceof WaitingForFirstSyncError || error instanceof ClickHouseNotConfiguredError)) {
      reportError("analytics.report_failed", error, {
        reportId: job.reportId,
        tenantId: job.tenantId,
        fingerprint: `analytics.report_failed:${job.reportId}`,
      });
    }
    await ctx.runMutation(internal.analytics.results.fail, {
      ...args,
      errorMessage: userMessage(error),
    });
  }
}

/** One key a page opened with no current answer (`reports.request`). */
export const runReport = internalAction({
  args: { resultId: v.id("analyticsResults"), runId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await executeRun(ctx, args);
    return null;
  },
});

/**
 * After each sync, while ClickHouse is still awake: read the watermark, then
 * rerun every key opened in the last 7 days, two at a time (§8.3). Started by
 * the Fivetran webhook. To run it by hand:
 * `npx convex run --prod analytics/run:runPostSyncBatch '{"force":true}'`.
 */
export const runPostSyncBatch = internalAction({
  args: {
    force: v.optional(v.boolean()),
    watermark: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
    keysPerTenant: v.optional(v.record(v.string(), v.number())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    let watermark = args.watermark;
    if (watermark === undefined) {
      let fromClickHouse: number | null;
      try {
        fromClickHouse = await queryWatermark();
      } catch (error) {
        reportError("analytics.batch_failed", error, { fingerprint: "analytics.batch_failed" });
        return null;
      }
      if (fromClickHouse === null) {
        await ctx.runMutation(internal.analytics.sync.finishBatch, {});
        return null;
      }
      const { changed } = await ctx.runMutation(internal.analytics.sync.startBatch, {
        watermark: fromClickHouse,
      });
      if (!changed && !args.force) {
        await ctx.runMutation(internal.analytics.sync.finishBatch, {});
        return null;
      }
      watermark = fromClickHouse;
    }

    const page = await ctx.runQuery(internal.analytics.sync.recentKeys, {
      since: Date.now() - RECENT_KEY_WINDOW_MS,
      paginationOpts: { cursor: args.cursor ?? null, numItems: BATCH_PAGE_SIZE },
    });
    const keysPerTenant = { ...args.keysPerTenant };
    const resultIds: Id<"analyticsResults">[] = [];
    for (const key of page.keys) {
      const count = keysPerTenant[key.tenantId] ?? 0;
      if (count >= MAX_KEYS_PER_TENANT) continue;
      keysPerTenant[key.tenantId] = count + 1;
      resultIds.push(key.resultId);
    }
    for (let index = 0; index < resultIds.length; index += BATCH_CONCURRENCY) {
      await Promise.all(
        resultIds.slice(index, index + BATCH_CONCURRENCY).map(async (resultId) => {
          const runId = await ctx.runMutation(internal.analytics.sync.startBatchRun, {
            resultId,
            watermark,
          });
          if (runId !== null) await executeRun(ctx, { resultId, runId }, { watermark });
        }),
      );
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.analytics.run.runPostSyncBatch, {
        watermark,
        cursor: page.continueCursor,
        keysPerTenant,
      });
      return null;
    }
    await ctx.runMutation(internal.analytics.sync.finishBatch, {});
    return null;
  },
});
