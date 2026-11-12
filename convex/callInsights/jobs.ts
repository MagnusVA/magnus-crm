import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { log } from "../lib/observability/log";
import { toMicroUsd } from "./budget";
import {
  TRANSCRIPT_RETENTION_MS,
  transcriptExpiresAt,
  transcriptGone,
} from "./retention";
import { effectiveSettings, servingConfig } from "./settings";
import { headerFor, queueRead } from "./trigger";
import type { CallInsightsSettings } from "./validators";

/**
 * Batches an admin approved: reading calls matched before the feature was
 * switched on (`backfill`), reading calls again with today's prompt and model
 * (`rerun`), and eval batches. A job freezes its list of calls when it starts,
 * works through it soonest transcript expiry first, two at a time, and never
 * spends more than its ceiling.
 */

/** Items of one job that may be running at once. */
export const JOB_PARALLEL = 2;
/** The most calls one job may hold. */
export const MAX_JOB_ITEMS = 500;
/** What one call is assumed to cost when sizing a job: a long call on Sonnet plus Jev. */
export const ESTIMATE_PER_CALL_MICRO_USD = 125_000;
/** A job stops before an item that could push it past its ceiling by this much. */
const WORST_CASE_PER_CALL_MICRO_USD = 450_000;

export type BackfillScope = "unread" | "unread_and_outdated";

type Candidate = {
  recordingId: Id<"callRecordings">;
  expiresAt: number;
  outdated: boolean;
};

/** Matched recordings one backfill scan looks at. */
const BACKFILL_SCAN = 1_500;

/**
 * The calls a backfill would read now: matched, transcript still there, and
 * either never read or (when asked) read with an older prompt, model or
 * thresholds. It walks the tenant's recordings oldest first, because those
 * lose their transcript first, and decides from each recording's small header
 * row, never from a run. Capped at MAX_JOB_ITEMS; `capped` says more exist.
 */
export async function backfillCandidates(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
  settings: CallInsightsSettings,
  scope: BackfillScope,
  now: number,
): Promise<{ candidates: Candidate[]; expired: number; capped: boolean }> {
  const current = servingConfig(settings);
  const candidates: Candidate[] = [];
  let expired = 0;
  let scanned = 0;
  let capped = false;
  // A transcript older than the retention window is gone, so the scan starts there.
  const recordings = ctx.db
    .query("callRecordings")
    .withIndex("by_tenantId_and_matchStatus_and_createdAt", (q) =>
      q
        .eq("tenantId", tenantId)
        .eq("matchStatus", "matched")
        .gte("createdAt", now - TRANSCRIPT_RETENTION_MS - 7 * 86_400_000),
    );
  for await (const recording of recordings) {
    if (candidates.length === MAX_JOB_ITEMS || scanned === BACKFILL_SCAN) {
      capped = true;
      break;
    }
    scanned++;
    if (!recording.meetingId) continue;
    const expiresAt = transcriptExpiresAt(recording);
    if (transcriptGone(recording, now)) {
      expired++;
      continue;
    }
    const header = await headerFor(ctx, recording._id);
    if (!header || header.latestRunId === undefined) {
      candidates.push({
        recordingId: recording._id,
        expiresAt,
        outdated: false,
      });
      continue;
    }
    if (header.latestStatus === "failed") {
      candidates.push({
        recordingId: recording._id,
        expiresAt,
        outdated: false,
      });
      continue;
    }
    // A read that is in flight or waiting for budget will finish by itself,
    // and a skipped one would be skipped again.
    if (header.latestStatus !== "answered") continue;
    const sameAsNow =
      header.model === current.model &&
      header.promptVersion === current.promptVersion &&
      header.taxonomyVersion === current.taxonomyVersion &&
      header.thresholdsVersion === current.thresholdsVersion &&
      header.itemCheck === current.itemCheck;
    if (scope === "unread_and_outdated" && !sameAsNow)
      candidates.push({
        recordingId: recording._id,
        expiresAt,
        outdated: true,
      });
  }
  candidates.sort((a, b) => a.expiresAt - b.expiresAt);
  return { candidates, expired, capped };
}

export type BackfillPreview = {
  total: number;
  unread: number;
  outdated: number;
  expired: number;
  estimateUsd: number;
  soonestExpiryAt: number | null;
  capped: boolean;
};

/** What a backfill would read and roughly cost. Reads only; calls no model. */
export async function previewBackfill(
  ctx: QueryCtx | MutationCtx,
  tenant: Doc<"tenants">,
  scope: BackfillScope,
  now: number,
): Promise<BackfillPreview | null> {
  const settings = effectiveSettings(tenant);
  if (!settings) return null;
  const found = await backfillCandidates(ctx, tenant._id, settings, scope, now);
  const outdated = found.candidates.filter((c) => c.outdated).length;
  return {
    total: found.candidates.length,
    unread: found.candidates.length - outdated,
    outdated,
    expired: found.expired,
    estimateUsd: (found.candidates.length * ESTIMATE_PER_CALL_MICRO_USD) / 1e6,
    soonestExpiryAt: found.candidates[0]?.expiresAt ?? null,
    capped: found.capped,
  };
}

async function runningJob(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
) {
  const recent = await ctx.db
    .query("callInsightJobs")
    .withIndex("by_tenantId_and_createdAt", (q) => q.eq("tenantId", tenantId))
    .order("desc")
    .take(20);
  return recent.find((job) => job.status === "running") ?? null;
}

/**
 * Starts a backfill over the calls the preview shows now. One job runs per
 * tenant at a time. Returns null when there is nothing to read or another job
 * is running.
 */
export async function startBackfill(
  ctx: MutationCtx,
  args: {
    tenant: Doc<"tenants">;
    userId: Id<"users">;
    scope: BackfillScope;
    ceilingUsd: number;
  },
): Promise<Id<"callInsightJobs"> | null> {
  const now = Date.now();
  const settings = effectiveSettings(args.tenant);
  if (!settings) return null;
  if (await runningJob(ctx, args.tenant._id)) return null;
  const found = await backfillCandidates(
    ctx,
    args.tenant._id,
    settings,
    args.scope,
    now,
  );
  if (found.candidates.length === 0) return null;
  const jobId = await ctx.db.insert("callInsightJobs", {
    tenantId: args.tenant._id,
    kind: args.scope === "unread" ? "backfill" : "rerun",
    status: "running",
    ceilingMicroUsd: toMicroUsd(args.ceilingUsd),
    spentMicroUsd: 0,
    estimateMicroUsd: found.candidates.length * ESTIMATE_PER_CALL_MICRO_USD,
    total: found.candidates.length,
    done: 0,
    failed: 0,
    skipped: 0,
    createdByUserId: args.userId,
    createdAt: now,
  });
  for (const candidate of found.candidates)
    await ctx.db.insert("callInsightJobItems", {
      tenantId: args.tenant._id,
      jobId,
      recordingId: candidate.recordingId,
      order: candidate.expiresAt,
      status: "pending",
    });
  await ctx.scheduler.runAfter(0, internal.callInsights.jobs.advance, {
    jobId,
  });
  log.info("call_insights.job_started", {
    tenantId: args.tenant._id,
    jobId,
    kind: args.scope,
    total: found.candidates.length,
  });
  return jobId;
}

/** Stops a job: calls not started are canceled, calls being read finish. */
export async function cancelJob(
  ctx: MutationCtx,
  job: Doc<"callInsightJobs">,
): Promise<void> {
  if (job.status !== "running") return;
  const pending = await ctx.db
    .query("callInsightJobItems")
    .withIndex("by_jobId_and_status_and_order", (q) =>
      q.eq("jobId", job._id).eq("status", "pending"),
    )
    .take(MAX_JOB_ITEMS);
  for (const item of pending)
    await ctx.db.patch("callInsightJobItems", item._id, { status: "canceled" });
  await ctx.db.patch("callInsightJobs", job._id, {
    status: "canceled",
    skipped: job.skipped + pending.length,
    finishedAt: Date.now(),
  });
}

/**
 * What a job's calls hold reserved right now, leaving one run out. A job's
 * spend plus this is the most it has committed to.
 */
export async function jobOpenReservationsMicroUsd(
  ctx: Pick<QueryCtx, "db">,
  jobId: Id<"callInsightJobs">,
  exceptRunId: Id<"callInsightRuns">,
): Promise<number> {
  const running = await ctx.db
    .query("callInsightJobItems")
    .withIndex("by_jobId_and_status_and_order", (q) =>
      q.eq("jobId", jobId).eq("status", "running"),
    )
    .take(JOB_PARALLEL * 4);
  let open = 0;
  for (const item of running) {
    if (!item.runId || item.runId === exceptRunId) continue;
    const run = await ctx.db.get("callInsightRuns", item.runId);
    for (const receipt of run?.receipts ?? [])
      if (receipt.settledAt === undefined) open += receipt.reservedMicroUsd;
  }
  return open;
}

async function itemsWithStatus(
  ctx: MutationCtx,
  jobId: Id<"callInsightJobs">,
  status: Doc<"callInsightJobItems">["status"],
  limit: number,
) {
  return await ctx.db
    .query("callInsightJobItems")
    .withIndex("by_jobId_and_status_and_order", (q) =>
      q.eq("jobId", jobId).eq("status", status),
    )
    .take(limit);
}

/**
 * Keeps a job moving: starts pending calls until two are running, and closes
 * the job when none are left. A job whose next call could pass its ceiling
 * stops there.
 */
export const advance = internalMutation({
  args: { jobId: v.id("callInsightJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get("callInsightJobs", args.jobId);
    if (!job || job.status !== "running") return null;
    let running = (
      await itemsWithStatus(ctx, job._id, "running", JOB_PARALLEL + 1)
    ).length;
    let { skipped } = job;
    let started = 0;
    while (running < JOB_PARALLEL) {
      const [next] = await itemsWithStatus(ctx, job._id, "pending", 1);
      if (!next) break;
      const inFlight = (running + started) * WORST_CASE_PER_CALL_MICRO_USD;
      if (
        job.spentMicroUsd + inFlight + WORST_CASE_PER_CALL_MICRO_USD >
        job.ceilingMicroUsd
      ) {
        // Out of approved money: what hasn't started is canceled.
        const rest = await itemsWithStatus(
          ctx,
          job._id,
          "pending",
          MAX_JOB_ITEMS,
        );
        for (const item of rest)
          await ctx.db.patch("callInsightJobItems", item._id, {
            status: "canceled",
          });
        skipped += rest.length;
        break;
      }
      if (job.kind === "backfill" || job.kind === "rerun") {
        const runId = await queueRead(ctx, {
          recordingId: next.recordingId,
          trigger: job.kind === "backfill" ? "backfill" : "rerun",
          jobId: job._id,
        });
        const run = runId ? await ctx.db.get("callInsightRuns", runId) : null;
        // A run this job didn't start (another read is already in flight) reports to nobody here.
        if (!run || run.jobId !== job._id) {
          await ctx.db.patch("callInsightJobItems", next._id, {
            status: "skipped",
          });
          skipped++;
          continue;
        }
        await ctx.db.patch("callInsightJobItems", next._id, {
          status: "running",
          runId: run._id,
        });
      } else {
        await ctx.db.patch("callInsightJobItems", next._id, {
          status: "running",
        });
        await ctx.scheduler.runAfter(
          0,
          internal.callInsights.eval.runner.startItem,
          {
            jobId: job._id,
            jobItemId: next._id,
          },
        );
      }
      running++;
      started++;
    }
    const left =
      running + (await itemsWithStatus(ctx, job._id, "pending", 1)).length;
    await ctx.db.patch("callInsightJobs", job._id, {
      skipped,
      ...(left === 0
        ? { status: "done" as const, finishedAt: Date.now() }
        : {}),
    });
    if (left === 0) {
      log.info("call_insights.job_done", {
        tenantId: job.tenantId,
        jobId: job._id,
      });
      if (job.kind === "eval_judge" || job.kind === "eval_regression")
        await ctx.scheduler.runAfter(
          0,
          internal.callInsights.eval.runner.jobFinished,
          {
            jobId: job._id,
          },
        );
    }
    return null;
  },
});

/** Called when a job's call finished, however it ended. Counts it and starts the next. */
export const itemFinished = internalMutation({
  args: {
    jobId: v.id("callInsightJobs"),
    runId: v.optional(v.id("callInsightRuns")),
    jobItemId: v.optional(v.id("callInsightJobItems")),
    outcome: v.union(
      v.literal("done"),
      v.literal("failed"),
      v.literal("skipped"),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get("callInsightJobs", args.jobId);
    if (!job) return null;
    const runId = args.runId;
    const item = args.jobItemId
      ? await ctx.db.get("callInsightJobItems", args.jobItemId)
      : runId
        ? await ctx.db
            .query("callInsightJobItems")
            .withIndex("by_runId", (q) => q.eq("runId", runId))
            .first()
        : null;
    if (!item || item.jobId !== job._id || item.status !== "running")
      return null;
    await ctx.db.patch("callInsightJobItems", item._id, {
      status: args.outcome,
    });
    await ctx.db.patch("callInsightJobs", job._id, {
      done: job.done + (args.outcome === "done" ? 1 : 0),
      failed: job.failed + (args.outcome === "failed" ? 1 : 0),
      skipped: job.skipped + (args.outcome === "skipped" ? 1 : 0),
    });
    if (job.status === "running")
      await ctx.scheduler.runAfter(0, internal.callInsights.jobs.advance, {
        jobId: job._id,
      });
    return null;
  },
});
