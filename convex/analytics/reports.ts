import { v } from "convex/values";
import { internal } from "../_generated/api";
import { mutation, query } from "../_generated/server";
import { isClickHouseConfigured } from "./clickhouse";
import { requireTenantUser } from "../requireTenantUser";
import { reportDefinitionFor, reportRequestArgs, resolveReportRequest } from "./keys";
import {
  answerCoversPeriod,
  countRecentMisses,
  DAILY_MISS_BUDGET,
  FAILURE_RETRY_MS,
  findResult,
  readSyncRow,
  REQUEST_TOUCH_INTERVAL_MS,
  resultState,
  runIsInFlight,
  startRun,
} from "./results";

const answerValidator = v.object({
  watermark: v.number(),
  startDate: v.string(),
  endDateInclusive: v.string(),
  completedAt: v.number(),
});

const resultStateValidator = v.object({
  state: v.union(
    v.literal("missing"),
    v.literal("queued"),
    v.literal("pending"),
    v.literal("ready"),
    v.literal("failed"),
  ),
  payloadJson: v.union(v.string(), v.null()),
  answer: v.union(answerValidator, v.null()),
  errorMessage: v.union(v.string(), v.null()),
});

/**
 * The newest answer for a report key. A page subscribes to this for every
 * range other than Today; it never reads `analyticsSync`, so the heartbeat
 * re-runs nothing (§8.2).
 */
export const get = query({
  args: reportRequestArgs,
  returns: resultStateValidator,
  handler: async (ctx, args) => {
    const definition = reportDefinitionFor(args.reportId);
    const viewer = await requireTenantUser(ctx, [...definition.roles]);
    const request = await resolveReportRequest(ctx, args, definition, viewer);
    const row = await findResult(
      ctx,
      request.viewer.tenantId,
      request.definition.id,
      request.argsKey,
    );
    return resultState(row);
  },
});

/**
 * Called when a page opens a key. Registers it for the post-sync batch, and
 * runs it now only when no answer covers the current sync and period, within
 * the tenant's daily budget. Concurrent calls for one key insert one row and
 * start one run.
 */
export const request = mutation({
  args: reportRequestArgs,
  returns: v.object({ started: v.boolean() }),
  handler: async (ctx, args) => {
    const definition = reportDefinitionFor(args.reportId);
    const viewer = await requireTenantUser(ctx, [...definition.roles]);
    const request = await resolveReportRequest(ctx, args, definition, viewer);
    const { tenantId } = viewer;
    const now = Date.now();
    const sync = await readSyncRow(ctx);
    const watermark = sync?.watermark ?? 0;

    let row = await findResult(ctx, tenantId, request.definition.id, request.argsKey);
    if (!row) {
      const resultId = await ctx.db.insert("analyticsResults", {
        tenantId,
        reportId: request.definition.id,
        argsKey: request.argsKey,
        filtersJson: request.filtersJson,
        range: args.range,
        timeZone: request.day.timeZone,
        dayStartHour: request.day.dayStartHour,
        status: "queued",
        lastRequestedAt: now,
      });
      row = (await ctx.db.get("analyticsResults", resultId))!;
    } else if (now - row.lastRequestedAt >= REQUEST_TOUCH_INTERVAL_MS) {
      await ctx.db.patch("analyticsResults", row._id, { lastRequestedAt: now });
    }

    if (!isClickHouseConfigured()) {
      if (row.status !== "failed") {
        await ctx.db.patch("analyticsResults", row._id, {
          status: "failed",
          errorMessage: "The reporting database isn't configured on this deployment.",
          failedAt: now,
        });
      }
      return { started: false };
    }
    if (runIsInFlight(row, now)) return { started: false };
    const current =
      row.answer !== undefined &&
      row.answer.watermark >= watermark &&
      answerCoversPeriod(row, now);
    if (row.status === "ready" && current) return { started: false };
    if (row.status === "failed" && row.failedAt !== undefined && now - row.failedAt < FAILURE_RETRY_MS) {
      return { started: false };
    }
    if ((await countRecentMisses(ctx, tenantId, now)) >= DAILY_MISS_BUDGET) {
      // The next post-sync batch answers it.
      if (row.status !== "queued" && !row.payloadJson) {
        await ctx.db.patch("analyticsResults", row._id, { status: "queued" });
      }
      return { started: false };
    }

    const runId = await startRun(ctx, row, { watermark, now, miss: true });
    await ctx.scheduler.runAfter(0, internal.analytics.run.runReport, {
      resultId: row._id,
      runId,
    });
    return { started: true };
  },
});
