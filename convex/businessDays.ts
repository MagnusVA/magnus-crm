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
    return await startRebuild(ctx, tenantId, version, true, userId);
  },
});

/** Deploy-time cutover without changing the tenant's day definition. */
export const beginBusinessDayCutover = internalMutation({
  args: { tenantId: v.id("tenants"), rebuildLeadGen: v.boolean() },
  returns: v.id("businessDayRebuilds"),
  handler: async (ctx, { tenantId, rebuildLeadGen }) => {
    if (await runningBusinessDayRebuild(ctx, tenantId)) throw new Error(BUSINESS_DAY_REBUILD_MESSAGE);
    const tenant = await ctx.db.get("tenants", tenantId);
    if (!tenant) throw new Error(`${tenantId}`);
    const version = (tenant.businessDayVersion ?? 0) + 1;
    await ctx.db.patch("tenants", tenantId, { businessDayVersion: version });
    return await startRebuild(ctx, tenantId, version, rebuildLeadGen);
  },
});

async function cancelActiveReports(ctx: MutationCtx, tenantId: Id<"tenants">) {
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
}

async function startRebuild(ctx: MutationCtx, tenantId: Id<"tenants">, version: number, rebuildLeadGen: boolean, userId?: Id<"users">) {
  await cancelActiveReports(ctx, tenantId);
  const rebuildId = await ctx.db.insert("businessDayRebuilds", {
    tenantId, version, requestedByUserId: userId, rebuildLeadGen, requestedAt: Date.now(), state: "running", phase: "meetings", cursor: null,
    pass: 1, sourceRevision: 0, computedRevision: 0, meetingsEnqueued: 0, leadGenRowsComputed: 0, leadGenRowsSwapped: 0,
    leadGenAudited: 0, meetingsAsserted: 0, bucketsAsserted: 0, sourcesAsserted: 0, leadGenDone: !rebuildLeadGen,
  });
  await ctx.scheduler.runAfter(0, internal.businessDays.runRebuild, { rebuildId });
  return rebuildId;
}

/** Restart a failed pass under the same day definition and report-cache version. */
export const retryBusinessDayRebuild = mutation({
  args: {}, returns: v.id("businessDayRebuilds"),
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [...PERMISSIONS["settings:manage"]]);
    if (await runningBusinessDayRebuild(ctx, tenantId)) throw new Error(BUSINESS_DAY_REBUILD_MESSAGE);
    const tenant = await ctx.db.get("tenants", tenantId);
    const job = await ctx.db.query("businessDayRebuilds")
      .withIndex("by_tenantId_and_state", q => q.eq("tenantId", tenantId).eq("state", "failed"))
      .order("desc").first();
    if (!job || job.version !== tenant?.businessDayVersion) throw new Error("No failed business day rebuild to retry.");
    // Lead gen may have finished before meeting verification failed, allowing
    // reports to be admitted. Fence them before this retry resets its counters.
    await cancelActiveReports(ctx, tenantId);
    await ctx.db.patch("businessDayRebuilds", job._id, {
      state: "running", phase: "restart_cleanup", cursor: null, pass: job.pass + 1,
      computedRevision: job.sourceRevision, projectionWaitAttempts: 0,
      meetingsEnqueued: 0, leadGenRowsComputed: 0, leadGenRowsSwapped: 0,
      leadGenAudited: 0, meetingsAsserted: 0, bucketsAsserted: 0, sourcesAsserted: 0,
      leadGenDone: job.rebuildLeadGen === false, error: undefined, finishedAt: undefined,
      watermark: undefined, lowerWatermark: undefined, catchUpPasses: 0, computedCorrectionRevision: undefined,
    });
    await ctx.scheduler.runAfter(0, internal.businessDays.runRebuild, { rebuildId: job._id });
    return job._id;
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

// Allow the roughly twenty-minute production replay to finish, but never poll
// forever if a projection loses its worker. The budget spans all drain visits.
async function waitForProjections(ctx: MutationCtx, job: Rebuild): Promise<number | null> {
  if (!(await projectionsPending(ctx, job.tenantId))) return null;
  const attempts = job.projectionWaitAttempts ?? 0;
  if (attempts >= 120) throw new Error(`Meeting projections did not finish after 120 checks. Rebuild ${job._id}`);
  await ctx.db.patch("businessDayRebuilds", job._id, { projectionWaitAttempts: attempts + 1 });
  return Math.min(1000 * 2 ** Math.min(attempts, 5), 30_000);
}

/** One bounded transaction per step; the action records failures outside rollback. */
export const rebuildStep = internalMutation({
  args: { rebuildId: v.id("businessDayRebuilds") }, returns: v.union(v.number(), v.null()),
  handler: async (ctx, { rebuildId }): Promise<number | null> => {
    const job = await ctx.db.get("businessDayRebuilds", rebuildId);
    if (!job || job.state !== "running") return null;
    const tenant = await ctx.db.get("tenants", job.tenantId);
    if (!tenant || tenant.businessDayVersion !== job.version) throw new Error(`${job.tenantId}`);
    if (job.phase === "restart_cleanup") {
      if (!(await cleanStagingPage(ctx, rebuildId, job.pass - 1))) return 0;
      await move(ctx, job, "meetings");
    } else if (job.phase === "meetings") {
      const page = await enqueueTenantMeetingProjectionPage(ctx, job.tenantId, job.cursor);
      await ctx.db.patch("businessDayRebuilds", rebuildId, { meetingsEnqueued: job.meetingsEnqueued + page.page.length });
      await move(ctx, job, page.isDone ? (job.rebuildLeadGen === false ? "drain" : "seed_daily") : "meetings", page.isDone ? null : page.continueCursor);
    } else if (job.phase.startsWith("seed_") || ["compute", "swap", "audit_lead_gen"].includes(job.phase)) {
      await ctx.runMutation(internal.leadGen.businessDayRebuild.rebuildLeadGenDayStats, { tenantId: job.tenantId, rebuildId });
    } else if (job.phase === "drain") {
      const delay = await waitForProjections(ctx, job);
      if (delay !== null) return delay;
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
      const delay = await waitForProjections(ctx, job);
      if (delay !== null) { await move(ctx, job, "drain"); return delay; }
      if (!(await cleanStagingPage(ctx, rebuildId, job.pass))) return 0;
      await ctx.db.patch("tenants", job.tenantId, { businessDayAppliedVersion: job.version });
      await ctx.db.patch("businessDayRebuilds", rebuildId, { state: "done", finishedAt: Date.now() });
      return null;
    }
    return 0;
  },
});

/** Bound cleanup and fence it to old passes so a concurrent retry is safe. */
async function cleanStagingPage(ctx: MutationCtx, rebuildId: Id<"businessDayRebuilds">, throughPass: number) {
  for (const table of ["businessDayRebuildRows", "businessDayRebuildSeen"] as const) {
    const rows = await ctx.db.query(table).withIndex("by_rebuildId_and_pass_and_key", q => q.eq("rebuildId", rebuildId).lte("pass", throughPass)).take(200);
    for (const row of rows) await ctx.db.delete(table, row._id);
    if (rows.length) return false;
  }
  return true;
}
export const cleanupFailedStaging = internalMutation({
  args: { rebuildId: v.id("businessDayRebuilds"), throughPass: v.number() }, returns: v.null(),
  handler: async (ctx, args) => {
    if (!(await cleanStagingPage(ctx, args.rebuildId, args.throughPass))) {
      await ctx.scheduler.runAfter(0, internal.businessDays.cleanupFailedStaging, args);
    }
    return null;
  },
});

export const failRebuild = internalMutation({
  args: { rebuildId: v.id("businessDayRebuilds"), error: v.string() }, returns: v.null(),
  handler: async (ctx, { rebuildId, error }) => {
    const job = await ctx.db.get("businessDayRebuilds", rebuildId);
    if (job?.state === "running") {
      await ctx.db.patch("businessDayRebuilds", rebuildId, { state: "failed", error, finishedAt: Date.now() });
      await ctx.scheduler.runAfter(0, internal.businessDays.cleanupFailedStaging, { rebuildId, throughPass: job.pass });
    }
    return null;
  },
});
export const runRebuild = internalAction({
  args: { rebuildId: v.id("businessDayRebuilds") }, returns: v.null(),
  handler: async (ctx, { rebuildId }): Promise<null> => {
    try {
      const delay: number | null = await ctx.runMutation(internal.businessDays.rebuildStep, { rebuildId });
      if (delay !== null) await ctx.scheduler.runAfter(Math.max(delay, 1), internal.businessDays.runRebuild, { rebuildId });
    } catch (error) {
      reportError("business_day.rebuild.failed", error, { rebuildId });
      await ctx.runMutation(internal.businessDays.failRebuild, { rebuildId, error: error instanceof Error ? error.message : "Rebuild failed" });
    }
    return null;
  },
});
