import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { reportDefinitionFor, reportRequestArgs, resolveReportRequest } from "./keys";
import { findResult, registerRequest, resultState } from "./results";

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
    return await resultState(ctx, row);
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
    const { started } = await registerRequest(ctx, {
      tenantId: viewer.tenantId,
      reportId: definition.id,
      argsKey: request.argsKey,
      filtersJson: request.filtersJson,
      range: args.range,
      day: request.day,
    });
    return { started };
  },
});
