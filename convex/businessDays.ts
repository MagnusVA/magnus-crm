import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, mutation, type MutationCtx } from "./_generated/server";
import { BUSINESS_DAY_REBUILD_MESSAGE, validateBusinessDay } from "../lib/businessDay";
import { businessDayValidator } from "./businessDaySchema";
import { requireTenantUser } from "./requireTenantUser";
import { PERMISSIONS } from "./lib/permissions";
import { runningBusinessDayRebuild } from "./lib/businessDayRebuildState";
import { enqueueTenantMeetingProjectionPage } from "./operations/meetingStats";
import { assertMeetingProjection, assertMeetingProjectionBucket, assertMeetingProjectionSource } from "./operations/meetingProjectionChecks";
import { releaseAdmission } from "./operations/reports/admission";
import { activeReportStatuses, REPORT_JOB_METADATA_RETENTION_MS } from "./operations/reports/contracts";
import { reportError } from "./lib/observability/log";

export const updateBusinessDay = mutation({
  args: { setting: businessDayValidator },
  returns: v.id("businessDayRebuilds"),
  handler: async (ctx, { setting }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [...PERMISSIONS["settings:manage"]]);
    validateBusinessDay(setting);
    if (await runningBusinessDayRebuild(ctx, tenantId)) throw new Error(BUSINESS_DAY_REBUILD_MESSAGE);
    const tenant = await ctx.db.get("tenants", tenantId);
    if (!tenant) throw new Error(`${tenantId}`);
    const version = (tenant.businessDayVersion ?? 0) + 1;
    await ctx.db.patch("tenants", tenantId, { businessDay: setting, businessDayVersion: version });
    // Fence in-flight reports before changing any totals. Their next checkpoint
    // cannot publish under a range definition that no longer matches the data.
    for (const status of activeReportStatuses) {
      const jobs = await ctx.db.query("operationsReportJobs").withIndex("by_tenantId_and_status", q => q.eq("tenantId", tenantId).eq("status", status)).take(3);
      for (const job of jobs) {
        const now = Date.now();
        await releaseAdmission(ctx, job);
        await ctx.db.patch("operationsReportJobs", job._id, {
          status: "canceled", phase: "cleanup", canceledAt: now, completedAt: now, expiresAt: now,
          purgeAt: now + REPORT_JOB_METADATA_RETENTION_MS, cleanupPending: true, cleanupNextAttemptAt: now,
          leaseGeneration: job.leaseGeneration + 1, leaseOwner: undefined, leaseExpiresAt: undefined,
        });
      }
    }
    const rebuildId = await ctx.db.insert("businessDayRebuilds", {
      tenantId, version, requestedByUserId: userId, requestedAt: Date.now(), state: "running", phase: "meetings", cursor: null,
      pass: 1, sourceRevision: 0, computedRevision: 0, meetingsEnqueued: 0, leadGenRowsComputed: 0, leadGenRowsSwapped: 0,
      leadGenAudited: 0, meetingsAsserted: 0, bucketsAsserted: 0, sourcesAsserted: 0, leadGenDone: false,
    });
    await ctx.scheduler.runAfter(0, internal.businessDays.runRebuild, { rebuildId });
    return rebuildId;
  },
});

type Rebuild = Doc<"businessDayRebuilds">;
type Phase = Rebuild["phase"];
async function move(ctx: MutationCtx, job: Rebuild, phase: Phase, cursor: string | null = null) {
  await ctx.db.patch("businessDayRebuilds", job._id, { phase, cursor });
}
async function projectionsPending(ctx: MutationCtx, tenantId: Id<"tenants">) {
  for (const table of ["meetingProjections", "opportunityProjectionJobs"] as const) {
    const failed = await ctx.db.query(table).withIndex("by_tenantId_and_status_and_requestedAt", q => q.eq("tenantId", tenantId).eq("status", "failed")).first();
    if (failed) throw new Error(`${failed._id}`);
    const queued = await ctx.db.query(table).withIndex("by_tenantId_and_status_and_requestedAt", q => q.eq("tenantId", tenantId).eq("status", "queued")).first();
    if (queued) return true;
  }
  return false;
}

/** One bounded transaction per step; the action records failures outside rollback. */
export const rebuildStep = internalMutation({
  args: { rebuildId: v.id("businessDayRebuilds") }, returns: v.union(v.number(), v.null()),
  handler: async (ctx, { rebuildId }): Promise<number | null> => {
    const job = await ctx.db.get("businessDayRebuilds", rebuildId);
    if (!job || job.state !== "running") return null;
    const tenant = await ctx.db.get("tenants", job.tenantId);
    if (!tenant || tenant.businessDayVersion !== job.version) throw new Error(`${job.tenantId}`);
    if (job.phase === "meetings") {
      const page = await enqueueTenantMeetingProjectionPage(ctx, job.tenantId, job.cursor);
      await ctx.db.patch("businessDayRebuilds", rebuildId, { meetingsEnqueued: job.meetingsEnqueued + page.page.length });
      await move(ctx, job, page.isDone ? "seed_daily" : "meetings", page.isDone ? null : page.continueCursor);
    } else if (job.phase.startsWith("seed_") || ["compute", "swap", "audit_lead_gen"].includes(job.phase)) {
      await ctx.runMutation(internal.leadGen.businessDayRebuild.rebuildLeadGenDayStats, { tenantId: job.tenantId, rebuildId });
    } else if (job.phase === "drain") {
      if (await projectionsPending(ctx, job.tenantId)) return 1000;
      await move(ctx, job, "assert_meetings");
    } else if (job.phase === "assert_meetings") {
      const page = await ctx.db.query("meetings").withIndex("by_tenantId_and_scheduledAt", q => q.eq("tenantId", job.tenantId)).paginate({ cursor: job.cursor, numItems: 200 });
      for (const row of page.page) await assertMeetingProjection(ctx, row);
      await ctx.db.patch("businessDayRebuilds", rebuildId, { meetingsAsserted: job.meetingsAsserted + page.page.length });
      await move(ctx, job, page.isDone ? "assert_buckets" : job.phase, page.isDone ? null : page.continueCursor);
    } else if (job.phase === "assert_buckets") {
      const page = await ctx.db.query("operationsMeetingStatsV2").withIndex("by_tenantId_and_dayKey", q => q.eq("tenantId", job.tenantId)).paginate({ cursor: job.cursor, numItems: 1 });
      for (const row of page.page) await assertMeetingProjectionBucket(ctx, row);
      await ctx.db.patch("businessDayRebuilds", rebuildId, { bucketsAsserted: job.bucketsAsserted + page.page.length });
      await move(ctx, job, page.isDone ? "assert_sources" : job.phase, page.isDone ? null : page.continueCursor);
    } else if (job.phase === "assert_sources") {
      const page = await ctx.db.query("meetingProjections").withIndex("by_tenantId_and_status_and_requestedAt", q => q.eq("tenantId", job.tenantId)).paginate({ cursor: job.cursor, numItems: 200 });
      for (const row of page.page) await assertMeetingProjectionSource(ctx, row);
      await ctx.db.patch("businessDayRebuilds", rebuildId, { sourcesAsserted: job.sourcesAsserted + page.page.length });
      await move(ctx, job, page.isDone ? "cleanup" : job.phase, page.isDone ? null : page.continueCursor);
    } else {
      // Recheck source changes after assertions too. No report can cache a stale pass.
      if (job.sourceRevision !== job.computedRevision) {
        await ctx.db.patch("businessDayRebuilds", rebuildId, { pass: job.pass + 1, leadGenDone: false });
        await move(ctx, job, "seed_daily");
        return 0;
      }
      if (await projectionsPending(ctx, job.tenantId)) { await move(ctx, job, "drain"); return 1000; }
      const rows = await ctx.db.query("businessDayRebuildRows").withIndex("by_rebuildId_and_pass_and_key", q => q.eq("rebuildId", rebuildId)).take(200);
      for (const row of rows) await ctx.db.delete("businessDayRebuildRows", row._id);
      if (rows.length) return 0;
      const seen = await ctx.db.query("businessDayRebuildSeen").withIndex("by_rebuildId_and_pass_and_key", q => q.eq("rebuildId", rebuildId)).take(200);
      for (const row of seen) await ctx.db.delete("businessDayRebuildSeen", row._id);
      if (seen.length) return 0;
      await ctx.db.patch("businessDayRebuilds", rebuildId, { state: "done", finishedAt: Date.now() });
      return null;
    }
    return 0;
  },
});

export const failRebuild = internalMutation({
  args: { rebuildId: v.id("businessDayRebuilds"), error: v.string() }, returns: v.null(),
  handler: async (ctx, { rebuildId, error }) => {
    const job = await ctx.db.get("businessDayRebuilds", rebuildId);
    if (job?.state === "running") await ctx.db.patch("businessDayRebuilds", rebuildId, { state: "failed", error, finishedAt: Date.now() });
    return null;
  },
});
export const runRebuild = internalAction({
  args: { rebuildId: v.id("businessDayRebuilds") }, returns: v.null(),
  handler: async (ctx, { rebuildId }): Promise<null> => {
    try {
      const delay: number | null = await ctx.runMutation(internal.businessDays.rebuildStep, { rebuildId });
      if (delay !== null) await ctx.scheduler.runAfter(delay, internal.businessDays.runRebuild, { rebuildId });
    } catch (error) {
      reportError("business_day.rebuild.failed", error, { rebuildId });
      await ctx.runMutation(internal.businessDays.failRebuild, { rebuildId, error: error instanceof Error ? error.message : "Rebuild failed" });
    }
    return null;
  },
});
