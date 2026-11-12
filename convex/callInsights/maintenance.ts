import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { log } from "../lib/observability/log";
import { settleAllAtReservation } from "./budget";
import { MAX_ATTEMPTS, MAX_CHECK_RETRIES } from "./run";
import { headerFor } from "./trigger";
import type { FoundQuote } from "./validators";

/** Runs handled per status per sweep. The sweep reschedules itself when a batch was full. */
const BATCH = 25;
/** A queued run whose scheduled read is this late is assumed lost and scheduled again. */
const LOST_SCHEDULE_MS = 20 * 60_000;

/**
 * Starts a run's worker again. Opus's judge and inventory runs share the runs
 * table but have their own action; everything else is an extraction.
 */
async function scheduleWorker(ctx: MutationCtx, run: Doc<"callInsightRuns">) {
  if (
    run.purpose === "eval" &&
    (run.evalRole === "judge" || run.evalRole === "inventory")
  ) {
    if (!run.evalCaseId) return;
    const item = await ctx.db
      .query("callInsightJobItems")
      .withIndex("by_runId", (q) => q.eq("runId", run._id))
      .first();
    await ctx.scheduler.runAfter(
      0,
      internal.callInsights.eval.judge.judgeCase,
      {
        caseId: run.evalCaseId,
        jobId: run.jobId,
        jobItemId: item?._id,
      },
    );
    return;
  }
  await ctx.scheduler.runAfter(0, internal.callInsights.run.read, {
    runId: run._id,
  });
}

async function recoverExpiredLease(
  ctx: MutationCtx,
  run: Doc<"callInsightRuns">,
  now: number,
) {
  // The worker died or timed out. What it spent is unknown, so its open
  // reservations are kept as spent.
  const receipts = await settleAllAtReservation(ctx, {
    tenantId: run.tenantId,
    jobId: run.jobId,
    receipts: run.receipts,
    now,
  });
  // A run stuck in its Jev stage gets one more try than the stage's own retries.
  const retry =
    run.status === "checking"
      ? (run.checkRetries ?? 0) <= MAX_CHECK_RETRIES
      : run.attempt < MAX_ATTEMPTS;
  const status = retry
    ? run.status === "checking"
      ? "checking"
      : "queued"
    : "failed";
  await ctx.db.patch("callInsightRuns", run._id, {
    status,
    reason: "lease_expired",
    receipts,
    claimToken: undefined,
    leaseUntil: undefined,
    nextAttemptAt: retry ? now : undefined,
    finishedAt: retry ? undefined : now,
  });
  if (run.purpose === "serve") {
    const header = await headerFor(ctx, run.recordingId);
    if (header && header.latestRunId === run._id)
      await ctx.db.patch("callInsightFacts", header._id, {
        latestStatus: status,
        reasonCode: "lease_expired",
        updatedAt: now,
      });
  }
  if (retry) await scheduleWorker(ctx, run);
  else if (run.jobId)
    await ctx.scheduler.runAfter(0, internal.callInsights.jobs.itemFinished, {
      jobId: run.jobId,
      runId: run._id,
      outcome: "failed",
    });
  log.warn("call_insights.lease_expired", {
    tenantId: run.tenantId,
    runId: run._id,
    attempt: run.attempt,
    retry,
  });
}

const sweepCursorValidator = v.object({
  waiting: v.optional(v.number()),
  queued: v.optional(v.number()),
  checking: v.optional(v.number()),
});

/**
 * Every 15 minutes: hands runs whose worker died to a new worker, and starts
 * runs that are due (waiting for room under the monthly limit, or queued with
 * a read that never fired). Does nothing when no run is in those states.
 *
 * A due run keeps its `nextAttemptAt`: `run.begin` refuses a run that isn't
 * due yet, so pushing the time forward here would make the worker give up.
 * When a batch is full the sweep continues after the last run it handled
 * (`after`), so one pass covers every due run once and never loops on runs
 * whose worker hasn't claimed them yet.
 */
export const sweep = internalMutation({
  args: { after: v.optional(sweepCursorValidator) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    let full = false;

    // Recovery changes the run's status or lease, so a recovered run leaves this range.
    for (const status of ["running", "checking"] as const) {
      const expired = await ctx.db
        .query("callInsightRuns")
        .withIndex("by_status_and_leaseUntil", (q) =>
          q.eq("status", status).gt("leaseUntil", 0).lt("leaseUntil", now),
        )
        .take(BATCH);
      full ||= expired.length === BATCH;
      for (const run of expired) await recoverExpiredLease(ctx, run, now);
    }

    const after = { ...args.after };
    for (const status of ["waiting", "queued", "checking"] as const) {
      // Waiting runs have no scheduled read: the sweep is what retries them.
      // Queued and checking runs do; the sweep only covers one that was lost.
      const dueBefore = status === "waiting" ? now : now - LOST_SCHEDULE_MS;
      const due = await ctx.db
        .query("callInsightRuns")
        .withIndex("by_status_and_nextAttemptAt", (q) =>
          q
            .eq("status", status)
            .gt("nextAttemptAt", after[status] ?? 0)
            .lte("nextAttemptAt", dueBefore),
        )
        .take(BATCH);
      full ||= due.length === BATCH;
      after[status] =
        due.length === BATCH
          ? (due[BATCH - 1].nextAttemptAt ?? dueBefore)
          : dueBefore;
      for (const run of due) {
        if (run.leaseUntil !== undefined && run.leaseUntil > now) continue;
        await scheduleWorker(ctx, run);
      }
    }

    if (full)
      await ctx.scheduler.runAfter(0, internal.callInsights.maintenance.sweep, {
        after,
      });
    return null;
  },
});

const blankQuote = <T extends FoundQuote>(quote: T): T => ({
  ...quote,
  quote: "",
});

const IN_FLIGHT = new Set<Doc<"callInsightRuns">["status"]>([
  "queued",
  "waiting",
  "running",
  "checking",
]);

/**
 * Blanks one run's text. A run still in flight is ended here: its worker's
 * later writes then find no claim and save nothing, so text can't come back
 * after the cleanup. What it reserved is kept as spent, since nobody will
 * report its real cost.
 */
async function purgeRun(
  ctx: MutationCtx,
  run: Doc<"callInsightRuns">,
  now: number,
) {
  const inFlight = IN_FLIGHT.has(run.status);
  if (run.quotesPurgedAt !== undefined && !inFlight) return;
  const receipts = inFlight
    ? await settleAllAtReservation(ctx, {
        tenantId: run.tenantId,
        jobId: run.jobId,
        receipts: run.receipts,
        now,
      })
    : run.receipts;
  await ctx.db.patch("callInsightRuns", run._id, {
    items: run.items?.map((item) => ({
      ...item,
      statement: "",
      quote: "",
      resolutionQuote: item.resolutionQuote === undefined ? undefined : "",
      deadline: item.deadline === undefined ? undefined : "",
    })),
    result: run.result && {
      ...run.result,
      quotes: run.result.quotes.map(blankQuote),
      programHeard: undefined,
    },
    attendance: run.attendance && {
      ...run.attendance,
      waiting: run.attendance.waiting.map(blankQuote),
      leaving: run.attendance.leaving.map(blankQuote),
      triedToReach: run.attendance.triedToReach.map(blankQuote),
      someoneThere: run.attendance.someoneThere.map(blankQuote),
      secondPerson: run.attendance.secondPerson.map(blankQuote),
      notSalesCall: run.attendance.notSalesCall.map(blankQuote),
    },
    judgeOutput: undefined,
    quotesPurgedAt: now,
    ...(inFlight
      ? {
          status: "skipped" as const,
          reason: "no_transcript" as const,
          receipts,
          claimToken: undefined,
          leaseUntil: undefined,
          nextAttemptAt: undefined,
          finishedAt: now,
        }
      : {}),
  });
  if (!inFlight) return;
  if (run.purpose === "serve") {
    const header = await headerFor(ctx, run.recordingId);
    if (header && header.latestRunId === run._id)
      await ctx.db.patch("callInsightFacts", header._id, {
        latestStatus: "skipped",
        reasonCode: "no_transcript",
        updatedAt: now,
      });
  }
  if (run.jobId)
    await ctx.scheduler.runAfter(0, internal.callInsights.jobs.itemFinished, {
      jobId: run.jobId,
      runId: run._id,
      outcome: "skipped",
    });
}

/** Eval cases deleted per pass; each has at most a few dozen labels. */
const CASE_BATCH = 5;
const LABEL_BATCH = 300;

/**
 * Deletes every prospect word Call insights kept for a recording. Scheduled
 * when the recording's transcript is deleted. Categories, checks and numbers
 * stay; statements, quotes, model output and the recording's eval cases go.
 * It pages through all of the recording's runs, then the rest, rescheduling
 * itself until nothing is left.
 */
export const purgeRecording = internalMutation({
  args: {
    recordingId: v.id("callRecordings"),
    /** Where the pass over runs continues. Absent on the first call. */
    cursor: v.optional(v.union(v.string(), v.null())),
    /** True once every run was handled and only suggestions and eval cases remain. */
    runsDone: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    if (!args.runsDone) {
      const page = await ctx.db
        .query("callInsightRuns")
        .withIndex("by_recordingId_and_purpose_and_generation", (q) =>
          q.eq("recordingId", args.recordingId),
        )
        .paginate({ cursor: args.cursor ?? null, numItems: BATCH });
      for (const run of page.page) await purgeRun(ctx, run, now);
      await ctx.scheduler.runAfter(
        0,
        internal.callInsights.maintenance.purgeRecording,
        {
          recordingId: args.recordingId,
          ...(page.isDone
            ? { runsDone: true }
            : { cursor: page.continueCursor }),
        },
      );
      return null;
    }

    // One suggestion per meeting the recording was ever matched to: a handful.
    const suggestions = await ctx.db
      .query("resultSuggestionStates")
      .withIndex("by_recordingId", (q) => q.eq("recordingId", args.recordingId))
      .take(100);
    for (const row of suggestions) {
      if (row.quotesPurgedAt !== undefined) continue;
      await ctx.db.patch("resultSuggestionStates", row._id, {
        quotes: row.quotes.map(blankQuote),
        quotesPurgedAt: now,
        updatedAt: now,
      });
    }

    const header = await headerFor(ctx, args.recordingId);
    if (header && header.quotesPurgedAt === undefined)
      await ctx.db.patch("callInsightFacts", header._id, {
        quotesPurgedAt: now,
        updatedAt: now,
      });

    // Eval cases hold no text, but their labels point at lines of a transcript
    // that no longer exists. Deleted rows drop out of the next pass's read.
    const cases = await ctx.db
      .query("callInsightEvalCases")
      .withIndex("by_recordingId_and_campaign", (q) =>
        q.eq("recordingId", args.recordingId),
      )
      .take(CASE_BATCH);
    let more = cases.length === CASE_BATCH;
    for (const evalCase of cases) {
      const labels = await ctx.db
        .query("callInsightEvalLabels")
        .withIndex("by_caseId_and_source", (q) => q.eq("caseId", evalCase._id))
        .take(LABEL_BATCH);
      for (const label of labels)
        await ctx.db.delete("callInsightEvalLabels", label._id);
      if (labels.length < LABEL_BATCH)
        await ctx.db.delete("callInsightEvalCases", evalCase._id);
      else more = true;
    }
    if (more)
      await ctx.scheduler.runAfter(
        0,
        internal.callInsights.maintenance.purgeRecording,
        {
          recordingId: args.recordingId,
          runsDone: true,
        },
      );
    return null;
  },
});
