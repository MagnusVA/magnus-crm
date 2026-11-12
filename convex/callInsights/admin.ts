import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireTenantUser } from "../requireTenantUser";
import { rejectRequest } from "../lib/observability/errors";
import { log } from "../lib/observability/log";
import { insightsViewer } from "./access";
import { initialSettings } from "./settings";
import { queueRead } from "./trigger";
import {
  cancelJob as cancelJobCore,
  startBackfill as startBackfillCore,
} from "./jobs";
import { callInsightsModeValidator } from "./validators";
import { transcriptGone } from "./retention";

export const scopeValidator = v.union(
  v.literal("unread"),
  v.literal("unread_and_outdated"),
);

export const enable = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const actor = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const tenant = await ctx.db.get("tenants", actor.tenantId);
    if (!tenant)
      throw rejectRequest(
        "call_insights.tenant_missing",
        "Workspace not found.",
      );
    const previous = tenant.callInsights;
    if (!previous || previous.mode === "off") {
      const now = Date.now();
      await ctx.db.patch("tenants", tenant._id, {
        callInsights: {
          ...initialSettings(actor.userId, now),
          ...previous,
          mode: "shadow",
          changedAt: now,
          changedByUserId: actor.userId,
        },
      });
      log.info("call_insights.settings_changed", {
        tenantId: tenant._id,
        actorUserId: actor.userId,
        keys: ["mode"],
      });
    }
    return null;
  },
});

export const updateSettings = mutation({
  args: {
    mode: v.optional(callInsightsModeValidator),
    suggestions: v.optional(
      v.union(v.literal("off"), v.literal("hidden"), v.literal("on")),
    ),
    amountPrefill: v.optional(v.boolean()),
    noShowCertain: v.optional(v.boolean()),
    noShowWaitMinutes: v.optional(v.union(v.number(), v.null())),
    monthlyCapUsd: v.optional(v.number()),
    evalMonthlyUsd: v.optional(v.number()),
    itemCheck: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const tenant = await ctx.db.get("tenants", actor.tenantId);
    if (!tenant?.callInsights)
      throw rejectRequest(
        "call_insights.not_enabled",
        "Enable Call insights first.",
      );
    const { noShowWaitMinutes, ...rest } = args;
    const defined = Object.fromEntries(
      Object.entries(rest).filter(([, value]) => value !== undefined),
    );
    const next = {
      ...tenant.callInsights,
      ...defined,
      ...(noShowWaitMinutes !== undefined
        ? { noShowWaitMinutes: noShowWaitMinutes ?? undefined }
        : {}),
      changedAt: Date.now(),
      changedByUserId: actor.userId,
    };
    if (
      !Number.isFinite(next.monthlyCapUsd) ||
      next.monthlyCapUsd < 1 ||
      next.monthlyCapUsd > 10_000
    )
      throw rejectRequest(
        "call_insights.invalid_cap",
        "Set a monthly limit from $1 to $10,000.",
      );
    if (
      !Number.isFinite(next.evalMonthlyUsd) ||
      next.evalMonthlyUsd < 0 ||
      next.evalMonthlyUsd > next.monthlyCapUsd
    )
      throw rejectRequest(
        "call_insights.invalid_eval_cap",
        "Set an eval allowance between zero and the monthly limit.",
      );
    if (
      next.noShowWaitMinutes !== undefined &&
      ![5, 7, 10].includes(next.noShowWaitMinutes)
    )
      throw rejectRequest(
        "call_insights.invalid_wait",
        "Choose a wait of 5, 7 or 10 minutes.",
      );
    await ctx.db.patch("tenants", tenant._id, { callInsights: next });
    log.info("call_insights.settings_changed", {
      tenantId: tenant._id,
      actorUserId: actor.userId,
      keys: Object.keys(args).filter(
        (key) => args[key as keyof typeof args] !== undefined,
      ),
    });
    return null;
  },
});

export const readAgain = mutation({
  args: { recordingId: v.id("callRecordings") },
  returns: v.union(v.id("callInsightRuns"), v.null()),
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const recording = await ctx.db.get("callRecordings", args.recordingId);
    if (!recording || recording.tenantId !== actor.tenantId)
      throw rejectRequest(
        "call_insights.recording_missing",
        "Recording not found.",
      );
    if (transcriptGone(recording, Date.now()))
      throw rejectRequest(
        "call_insights.no_transcript",
        "The transcript is no longer available.",
      );
    return await queueRead(ctx, {
      recordingId: recording._id,
      trigger: "read_again",
    });
  },
});

export const reviewItem = mutation({
  args: {
    runId: v.id("callInsightRuns"),
    itemKey: v.string(),
    decision: v.union(v.literal("restore"), v.literal("dismiss")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const run = await ctx.db.get("callInsightRuns", args.runId);
    const review = await ctx.db
      .query("callInsightItemReviews")
      .withIndex("by_runId_and_itemKey", (q) =>
        q.eq("runId", args.runId).eq("itemKey", args.itemKey),
      )
      .first();
    if (
      !run ||
      run.tenantId !== actor.tenantId ||
      !review ||
      review.tenantId !== actor.tenantId
    )
      throw rejectRequest(
        "call_insights.review_missing",
        "Item review not found.",
      );
    const state = args.decision === "restore" ? "restored" : "dismissed";
    if (review.state === state) return null;
    if (review.state === "superseded")
      throw rejectRequest(
        "call_insights.review_superseded",
        "This review has been replaced by a newer reading.",
      );
    if (args.decision === "restore") {
      if (!run.items?.some((item) => item.key === args.itemKey))
        throw rejectRequest("call_insights.item_missing", "Item not found.");
      await ctx.db.patch("callInsightRuns", run._id, {
        items: run.items.map((item) =>
          item.key === args.itemKey
            ? { ...item, check: "restored" as const }
            : item,
        ),
      });
      await ctx.scheduler.runAfter(0, internal.callInsights.publish.reproject, {
        recordingId: run.recordingId,
      });
    }
    await ctx.db.patch("callInsightItemReviews", review._id, {
      state,
      decidedAt: Date.now(),
      decidedByUserId: actor.userId,
    });
    return null;
  },
});

export const startBackfill = mutation({
  args: { scope: scopeValidator, ceilingUsd: v.number() },
  returns: v.id("callInsightJobs"),
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const viewer = await insightsViewer(ctx, actor);
    if (!viewer?.settings)
      throw rejectRequest(
        "call_insights.disabled",
        "Enable Call insights first.",
      );
    if (
      !Number.isFinite(args.ceilingUsd) ||
      args.ceilingUsd < 1 ||
      args.ceilingUsd > viewer.settings.monthlyCapUsd
    )
      throw rejectRequest(
        "call_insights.invalid_ceiling",
        "Set a job limit between $1 and the monthly limit.",
      );
    const jobId = await startBackfillCore(ctx, {
      ...args,
      tenant: viewer.tenant,
      userId: actor.userId,
    });
    if (!jobId)
      throw rejectRequest(
        "call_insights.backfill_unavailable",
        "There is nothing to read, or a job is already running.",
      );
    return jobId;
  },
});

export const cancelJob = mutation({
  args: { jobId: v.id("callInsightJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const job = await ctx.db.get("callInsightJobs", args.jobId);
    if (!job || job.tenantId !== actor.tenantId)
      throw rejectRequest("call_insights.job_missing", "Job not found.");
    await cancelJobCore(ctx, job);
    return null;
  },
});
