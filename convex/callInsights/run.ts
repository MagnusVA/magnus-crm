import { v, type ObjectType } from "convex/values";
import { getServiceToken } from "convex/server";
import type { Doc } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import {
  businessDateForInstant,
  DEFAULT_BUSINESS_DAY,
} from "../../lib/businessDay";
import { log, reportError } from "../lib/observability/log";
import { normalizeEmail } from "../lib/normalization";
import { callDecisions } from "../secondOpinion/jev";
import { isOtherProspectsCall } from "../secondOpinion/trigger";
import type { PartialAnswers } from "../secondOpinion/verdict";
import {
  reserve,
  secondOpinionSpendUsd,
  settle,
  settleAllAtReservation,
  type ReceiptCost,
} from "./budget";
import { callGenericDecisions } from "./decisions";
import {
  buildReadingRequests,
  buildResultCheck,
  combineReadingAnswers,
} from "./earlyReading";
import { buildMessagesRequest, callMessages, maxCostMicroUsd } from "./gateway";
import { applyItemCheck, buildItemCheck } from "./itemCheck";
import { jobOpenReservationsMicroUsd } from "./jobs";
import { measureAttendance } from "./noShow/measures";
import { noShowTier, shadowTiers } from "./noShow/tier";
import { parseAttendanceOnly, parseExtraction } from "./parse";
import {
  ATTENDANCE_SCHEMA,
  ATTENDANCE_SYSTEM,
  EXTRACTION_SCHEMA,
  EXTRACTION_SYSTEM,
  buildUserMessage,
} from "./prompt";
import { projectRun, storeSuggestion } from "./publish";
import { transcriptGone } from "./retention";
import { effectiveSettings } from "./settings";
import { deriveSuggestion } from "./suggest/derive";
import { CERTAIN_AFTER_SLOT_MS, upsertSuggestion } from "./suggest/state";
import {
  MAX_TRANSCRIPT_TOKENS,
  parseStoredTranscript,
  prepareTranscript,
  renderLines,
  type PreparedTranscript,
} from "./transcriptPrep";
import { headerFor, latestServingRun, requeueIfMoved } from "./trigger";
import { validateAttendance, validateExtraction } from "./validate";
import {
  attendanceEvidenceValidator,
  attendanceMeasuresValidator,
  droppedCountsValidator,
  earlyReadingValidator,
  insightItemValidator,
  resultEvidenceValidator,
  runConfigValidator,
  runReasonValidator,
  type AttendanceMeasures,
  type EarlyReading,
  type InsightItem,
  type RunReason,
} from "./validators";

/** How long one claim of a run lasts before the sweep may hand it to another worker. */
export const LEASE_MS = 10 * 60_000;
/** Claims a run may make before it fails for good. */
export const MAX_ATTEMPTS = 4;
/** Times the Jev stage is retried alone before the run publishes without the missing answers. */
export const MAX_CHECK_RETRIES = 3;
/** Waits before a retry: after the first, second and third busy answer. */
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000];
/** How long a run that found the month's limit full waits before trying again. */
export const CAP_RETRY_MS = 60 * 60_000;
const EARLY_SLACK_MS = 5_000;
export const MAX_OUTPUT_TOKENS = 8_000;
/** A recording must run this long past the scheduled start before silence means anything. */
export const MIN_WAIT_SECONDS = 5 * 60;
const JEV_ITEM_MICRO_USD = 500;
const JEV_READING_MICRO_USD = 20_000;
const JEV_RESULT_MICRO_USD = 2_000;
/** Jev requests in flight at once for one run. */
const JEV_PARALLEL = 8;

const costValidator = v.object({
  costUsd: v.optional(v.number()),
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  gatewayRequestId: v.optional(v.string()),
});

const idArgs = { runId: v.id("callInsightRuns") };

function backoffMs(attempt: number, retryAfterSeconds?: number): number {
  const base =
    BACKOFF_MS[Math.min(Math.max(attempt - 1, 0), BACKOFF_MS.length - 1)];
  return Math.max(base, (retryAfterSeconds ?? 0) * 1000);
}

/** The reservation for a run's Jev requests: one lump for items, readings and the result check. */
export function jevReserveMicroUsd(items: number, readings: number): number {
  return (
    items * JEV_ITEM_MICRO_USD +
    readings * JEV_READING_MICRO_USD +
    JEV_RESULT_MICRO_USD
  );
}

const loadedValidator = v.object({
  tenantId: v.id("tenants"),
  recordingId: v.id("callRecordings"),
  meetingId: v.id("meetings"),
  purpose: v.union(v.literal("serve"), v.literal("eval")),
  status: v.union(
    v.literal("queued"),
    v.literal("waiting"),
    v.literal("checking"),
  ),
  attempt: v.number(),
  config: runConfigValidator,
  timeZone: v.string(),
  transcriptStorageId: v.id("_storage"),
  recordingStartAt: v.number(),
  recordingEndAt: v.number(),
  scheduledAt: v.number(),
  scheduledEndAt: v.number(),
  recordedByEmail: v.string(),
  recorderNames: v.array(v.string()),
  inviteeEmails: v.array(v.string()),
  summary: v.optional(v.string()),
  actionItems: v.array(v.string()),
  callKind: v.union(v.literal("new call"), v.literal("follow-up call")),
  program: v.optional(v.string()),
  programs: v.array(v.object({ id: v.id("tenantPrograms"), name: v.string() })),
  recorderIsAssignedCloser: v.boolean(),
  matchStrong: v.boolean(),
  otherRecordings: v.array(v.object({ hasLines: v.boolean() })),
  traceCoversWindow: v.boolean(),
  newerBooking: v.boolean(),
  // A run resuming its Jev stage carries what Claude already said.
  items: v.optional(v.array(insightItemValidator)),
  result: v.optional(resultEvidenceValidator),
  checkRetries: v.number(),
});

/**
 * Everything the action needs to read one recording, or the reason it must be
 * skipped before any money is spent. Null when the run can't be worked on.
 */
export const load = internalQuery({
  args: idArgs,
  returns: v.union(
    v.null(),
    v.object({ skip: runReasonValidator }),
    v.object({ input: loadedValidator }),
  ),
  handler: async (ctx, args) => {
    const run = await ctx.db.get("callInsightRuns", args.runId);
    if (!run) return null;
    // Opus's judge and inventory runs live in this table too; they are not extractions.
    if (run.purpose === "eval" && run.evalRole !== "candidate") return null;
    if (
      run.status !== "queued" &&
      run.status !== "waiting" &&
      run.status !== "checking"
    )
      return null;
    const now = Date.now();
    const tenant = await ctx.db.get("tenants", run.tenantId);
    const settings = effectiveSettings(tenant);
    if (!tenant || !settings) return { skip: "disabled" as const };
    const recording = await ctx.db.get("callRecordings", run.recordingId);
    if (!recording || recording.tenantId !== run.tenantId)
      return { skip: "recording_moved" as const };
    if (!recording.transcriptStorageId || transcriptGone(recording, now))
      return { skip: "no_transcript" as const };
    if (
      recording.matchStatus !== "matched" ||
      recording.meetingId !== run.meetingId
    )
      return { skip: "recording_moved" as const };
    const meeting = await ctx.db.get("meetings", run.meetingId);
    if (!meeting || meeting.tenantId !== run.tenantId)
      return { skip: "recording_moved" as const };
    if (await isOtherProspectsCall(ctx, meeting, recording))
      return { skip: "other_prospect" as const };

    const deal = await ctx.db.get("opportunities", meeting.opportunityId);
    const lead = deal ? await ctx.db.get("leads", deal.leadId) : null;
    const identifiers = deal
      ? await ctx.db
          .query("leadIdentifiers")
          .withIndex("by_leadId", (q) => q.eq("leadId", deal.leadId))
          .take(50)
      : [];
    const prospectEmails = new Set(
      [
        lead?.email,
        ...identifiers.filter((i) => i.type === "email").map((i) => i.value),
      ]
        .map((email) => (email ? normalizeEmail(email) : undefined))
        .filter((email): email is string => Boolean(email)),
    );
    const invitees = recording.inviteeEmails.map((email) =>
      email.toLowerCase(),
    );
    const prospectInvited = invitees.some((email) => {
      const normalized = normalizeEmail(email);
      return normalized !== undefined && prospectEmails.has(normalized);
    });
    const matchStrong =
      recording.matchMethod === "time_email" ||
      recording.matchMethod === "time_url" ||
      recording.matchMethod === "manual" ||
      (recording.matchMethod === "time_only" && prospectInvited);

    const recorderEmail = recording.recordedByEmail.toLowerCase();
    const recorderUser = recording.recordedByUserId
      ? await ctx.db.get("users", recording.recordedByUserId)
      : null;
    const rosterMember = await ctx.db
      .query("fathomOrgMembers")
      .withIndex("by_tenantId_and_email", (q) =>
        q.eq("tenantId", run.tenantId).eq("email", recorderEmail),
      )
      .first();
    const recorderNames = [
      recorderUser?.tenantId === run.tenantId
        ? recorderUser.fullName
        : undefined,
      rosterMember?.name,
    ].filter((name): name is string => Boolean(name && name.trim()));

    // Any other recording the same person made around this meeting, stored or
    // dropped at ingest, means this recording may not be the whole story.
    const scheduledEndAt =
      meeting.scheduledAt + Math.max(0, meeting.durationMinutes) * 60_000;
    const windowStart = meeting.scheduledAt - 30 * 60_000;
    const windowEnd = recording.recordingEndAt + 60 * 60_000;
    const overlaps = (start: number | undefined, end: number | undefined) =>
      start !== undefined &&
      end !== undefined &&
      start <= windowEnd &&
      end >= windowStart;
    const otherRecordings: Array<{ hasLines: boolean }> = [];
    // A scan that hit its cap may have missed a recording, so it proves nothing.
    const SCAN = 200;
    let scanCapped = false;
    for (const matchStatus of ["matched", "unmatched", "ignored"] as const) {
      const rows = await ctx.db
        .query("callRecordings")
        .withIndex("by_tenantId_and_matchStatus_and_createdAt", (q) =>
          q
            .eq("tenantId", run.tenantId)
            .eq("matchStatus", matchStatus)
            .gte("createdAt", windowStart - 86_400_000)
            .lte("createdAt", windowEnd + 7 * 86_400_000),
        )
        .take(SCAN);
      scanCapped ||= rows.length === SCAN;
      for (const row of rows) {
        if (row._id === recording._id) continue;
        if (row.recordedByEmail.toLowerCase() !== recorderEmail) continue;
        if (!overlaps(row.recordingStartAt, row.recordingEndAt)) continue;
        otherRecordings.push({ hasLines: (row.transcriptLineCount ?? 0) > 0 });
      }
    }
    const dropped = await ctx.db
      .query("fathomWebhookEvents")
      .withIndex("by_tenantId_and_status_and_receivedAt", (q) =>
        q
          .eq("tenantId", run.tenantId)
          .eq("status", "dropped")
          .gte("receivedAt", windowStart),
      )
      .take(SCAN);
    scanCapped ||= dropped.length === SCAN;
    for (const event of dropped) {
      if (event.droppedRecordedByEmail?.toLowerCase() !== recorderEmail)
        continue;
      if (!overlaps(event.droppedRecordingStartAt, event.droppedRecordingEndAt))
        continue;
      otherRecordings.push({ hasLines: false });
    }
    // The dropped-recording trace exists only since the feature was enabled
    // and only for 7 days, so it can vouch for a window only inside both.
    const traceCoversWindow =
      !scanCapped &&
      settings.enabledAt <= windowStart &&
      now <= windowEnd + 6 * 86_400_000;

    const programs = await ctx.db
      .query("tenantPrograms")
      .withIndex("by_tenantId_and_normalizedName", (q) =>
        q.eq("tenantId", run.tenantId),
      )
      .take(100);

    return {
      input: {
        tenantId: run.tenantId,
        recordingId: recording._id,
        meetingId: meeting._id,
        purpose: run.purpose,
        status: run.status,
        attempt: run.attempt,
        config: run.config,
        timeZone: (tenant.businessDay ?? DEFAULT_BUSINESS_DAY).timeZone,
        transcriptStorageId: recording.transcriptStorageId,
        recordingStartAt: recording.recordingStartAt,
        recordingEndAt: recording.recordingEndAt,
        scheduledAt: meeting.scheduledAt,
        scheduledEndAt,
        recordedByEmail: recorderEmail,
        recorderNames,
        inviteeEmails: invitees,
        summary: recording.summaryMarkdown,
        actionItems: (recording.actionItems ?? []).map(
          (item) => item.description,
        ),
        callKind:
          meeting.callClassification === "follow_up"
            ? ("follow-up call" as const)
            : ("new call" as const),
        program: meeting.bookingProgramName,
        programs: programs
          .filter((program) => program.archivedAt === undefined)
          .map((program) => ({ id: program._id, name: program.name })),
        recorderIsAssignedCloser:
          recording.recordedByUserId !== undefined &&
          recording.recordedByUserId === meeting.assignedCloserId,
        matchStrong,
        otherRecordings,
        traceCoversWindow,
        newerBooking:
          (deal?.latestMeetingId !== undefined &&
            deal.latestMeetingId !== meeting._id) ||
          (deal?.nextMeetingId !== undefined &&
            deal.nextMeetingId !== meeting._id),
        items: run.status === "checking" ? run.items : undefined,
        result: run.status === "checking" ? run.result : undefined,
        checkRetries: run.checkRetries ?? 0,
      },
    };
  },
});

async function patchHeaderStatus(
  ctx: MutationCtx,
  run: Doc<"callInsightRuns">,
  status: Doc<"callInsightRuns">["status"],
  reason: RunReason | undefined,
  now: number,
) {
  if (run.purpose !== "serve") return;
  const header = await headerFor(ctx, run.recordingId);
  if (!header || header.latestRunId !== run._id) return;
  await ctx.db.patch("callInsightFacts", header._id, {
    latestStatus: status,
    reasonCode: reason,
    updatedAt: now,
  });
}

/** Tells the run's job, if it has one, that its item finished. */
async function noteJobItem(
  ctx: MutationCtx,
  run: Doc<"callInsightRuns">,
  outcome: "done" | "failed" | "skipped",
) {
  if (!run.jobId) return;
  await ctx.scheduler.runAfter(0, internal.callInsights.jobs.itemFinished, {
    jobId: run.jobId,
    runId: run._id,
    outcome,
  });
}

/**
 * Atomic claim. Reserves the most this attempt could cost, then hands the
 * worker a fresh token and a 10-minute lease. Returns null when the run can't
 * start now: it was taken, the feature was switched off, or the month's limit
 * has no room (the run then waits and the sweep tries again).
 */
export const begin = internalMutation({
  args: {
    ...idArgs,
    kind: v.union(v.literal("full"), v.literal("attendance_only")),
    /**
     * The stage the worker loaded the run in. A worker that loaded it before
     * another worker moved it on must not claim it: it would call Claude again
     * with nothing reserved for the call.
     */
    expect: v.union(v.literal("extract"), v.literal("check")),
    claudeMicroUsd: v.number(),
    jevMicroUsd: v.number(),
    secondOpinionSpentUsd: v.number(),
  },
  returns: v.union(
    v.null(),
    v.object({ claimToken: v.string(), attempt: v.number() }),
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const run = await ctx.db.get("callInsightRuns", args.runId);
    if (!run) return null;
    const resuming = run.status === "checking";
    if (run.status !== "queued" && run.status !== "waiting" && !resuming)
      return null;
    if (resuming !== (args.expect === "check")) return null;
    if (run.leaseUntil !== undefined && run.leaseUntil > now) return null;
    // A retry waits out its backoff even if something schedules it early. The
    // slack covers a scheduled read firing a moment before the time it was given.
    if (
      run.nextAttemptAt !== undefined &&
      run.nextAttemptAt > now + EARLY_SLACK_MS
    )
      return null;
    const tenant = await ctx.db.get("tenants", run.tenantId);
    const settings = effectiveSettings(tenant);
    if (!tenant || !settings) {
      await ctx.db.patch("callInsightRuns", run._id, {
        status: "skipped",
        reason: "disabled",
        finishedAt: now,
      });
      await patchHeaderStatus(ctx, run, "skipped", "disabled", now);
      await noteJobItem(ctx, run, "skipped");
      return null;
    }
    if (run.jobId) {
      const job = await ctx.db.get("callInsightJobs", run.jobId);
      // A job never commits more than its ceiling: what it spent, what its
      // other calls still hold reserved, and this attempt's reservation.
      const overCeiling =
        job !== null &&
        job.spentMicroUsd +
          (await jobOpenReservationsMicroUsd(ctx, job._id, run._id)) +
          args.claudeMicroUsd +
          args.jevMicroUsd >
          job.ceilingMicroUsd;
      if (!job || job.status !== "running" || overCeiling) {
        await ctx.db.patch("callInsightRuns", run._id, {
          status: "skipped",
          reason: "canceled",
          claimToken: undefined,
          leaseUntil: undefined,
          nextAttemptAt: undefined,
          finishedAt: now,
        });
        await patchHeaderStatus(ctx, run, "skipped", "canceled", now);
        await noteJobItem(ctx, run, "skipped");
        return null;
      }
    }
    const attempt = resuming ? run.attempt : run.attempt + 1;
    const pool =
      run.purpose === "eval" ? ("eval" as const) : ("serve" as const);
    const suffix = resuming
      ? `${attempt}:${(run.checkRetries ?? 0) + 1}`
      : `${attempt}`;
    const wanted = [
      ...(resuming
        ? []
        : [
            {
              key: `claude:${suffix}`,
              origin: "claude" as const,
              amount: args.claudeMicroUsd,
            },
          ]),
      {
        key: `jev:${suffix}`,
        origin: "jev_item" as const,
        amount: args.jevMicroUsd,
      },
    ];
    // One admission for the whole attempt: both reservations fit or neither is made.
    const total = wanted.reduce((sum, w) => sum + w.amount, 0);
    const lump = await reserve(ctx, {
      tenant,
      settings,
      now,
      key: "admission",
      origin: "claude",
      pool,
      amountMicroUsd: total,
      secondOpinionSpentUsd: args.secondOpinionSpentUsd,
    });
    if (!lump) {
      await ctx.db.patch("callInsightRuns", run._id, {
        status: resuming ? "checking" : "waiting",
        reason: "cap_reached",
        nextAttemptAt: now + CAP_RETRY_MS,
        leaseUntil: undefined,
        claimToken: undefined,
      });
      await patchHeaderStatus(
        ctx,
        run,
        resuming ? "checking" : "waiting",
        "cap_reached",
        now,
      );
      log.info("call_insights.waiting", {
        tenantId: run.tenantId,
        runId: run._id,
      });
      return null;
    }
    const receipts = wanted.map((w) => ({
      key: w.key,
      origin: w.origin,
      monthKey: lump.monthKey,
      pool,
      reservedMicroUsd: Math.max(0, Math.ceil(w.amount)),
    }));
    const claimToken = crypto.randomUUID();
    await ctx.db.patch("callInsightRuns", run._id, {
      status: resuming ? "checking" : "running",
      reason: undefined,
      kind: resuming ? run.kind : args.kind,
      attempt,
      claimToken,
      leaseUntil: now + LEASE_MS,
      nextAttemptAt: undefined,
      checkRetries: resuming ? (run.checkRetries ?? 0) + 1 : run.checkRetries,
      receipts: [...run.receipts, ...receipts],
      startedAt: run.startedAt ?? now,
    });
    await patchHeaderStatus(
      ctx,
      run,
      resuming ? "checking" : "running",
      undefined,
      now,
    );
    return { claimToken, attempt };
  },
});

/** Ends a run that must not be read, before anything was claimed or paid for. */
export const skip = internalMutation({
  args: {
    ...idArgs,
    reason: runReasonValidator,
    failed: v.optional(v.boolean()),
    measures: v.optional(attendanceMeasuresValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const run = await ctx.db.get("callInsightRuns", args.runId);
    if (!run) return null;
    // A run between Jev retries holds no claim and can be ended like a queued one.
    const idleCheck = run.status === "checking" && run.claimToken === undefined;
    if (run.status !== "queued" && run.status !== "waiting" && !idleCheck)
      return null;
    const status = args.failed ? ("failed" as const) : ("skipped" as const);
    // An unclaimed run has nothing open; if it somehow does, the cost is unknown.
    const receipts = await settleAllAtReservation(ctx, {
      tenantId: run.tenantId,
      jobId: run.jobId,
      receipts: run.receipts,
      now,
    });
    await ctx.db.patch("callInsightRuns", run._id, {
      status,
      reason: args.reason,
      measures: args.measures ?? run.measures,
      receipts,
      leaseUntil: undefined,
      finishedAt: now,
      nextAttemptAt: undefined,
    });
    await patchHeaderStatus(ctx, run, status, args.reason, now);
    if (args.reason === "recording_moved") await requeueIfMoved(ctx, run);
    if (args.measures && run.purpose === "serve")
      await recordAttendanceOnly(ctx, { ...run, measures: args.measures }, now);
    await noteJobItem(ctx, run, args.failed ? "failed" : "skipped");
    log.info("call_insights.skipped", {
      tenantId: run.tenantId,
      runId: run._id,
      reason: args.reason,
    });
    return null;
  },
});

/**
 * A recording nobody but the closer is on, or with no lines at all, gets no
 * model reading, but its measurements still decide whether it reads as an
 * empty recording and feed the wait study.
 */
async function recordAttendanceOnly(
  ctx: MutationCtx,
  run: Doc<"callInsightRuns"> & { measures: AttendanceMeasures },
  now: number,
) {
  const header = await headerFor(ctx, run.recordingId);
  const tenant = await ctx.db.get("tenants", run.tenantId);
  const settings = effectiveSettings(tenant);
  if (!header || !settings) return;
  const tierInput = {
    eligible: true,
    now: Math.max(now, run.measures.slotEndedAt + CERTAIN_AFTER_SLOT_MS),
    measures: run.measures,
  };
  const tier = noShowTier({
    ...tierInput,
    waitMinutes: settings.noShowWaitMinutes,
  });
  await ctx.db.patch("callInsightFacts", header._id, {
    startOffsetSeconds: run.measures.startOffsetSeconds,
    endOffsetSeconds: run.measures.endOffsetSeconds,
    prospectFirstLineOffsetSeconds: run.measures.prospectFirstLineOffsetSeconds,
    firstOtherLineOffsetSeconds: run.measures.firstOtherLineOffsetSeconds,
    noShowTier: tier.tier,
    shadowTiers: shadowTiers(tierInput),
    updatedAt: now,
  });
  await upsertSuggestion(ctx, {
    tenantId: run.tenantId,
    meetingId: run.meetingId,
    recordingId: run.recordingId,
    runId: run._id,
    derived: deriveSuggestion({ noShow: tier }),
    waitedSeconds: run.measures.endOffsetSeconds,
    now,
  });
}

const saveExtractionArgs = {
  ...idArgs,
  claimToken: v.string(),
  items: v.array(insightItemValidator),
  dropped: v.optional(droppedCountsValidator),
  primaryBlockerExtracted: v.optional(v.string()),
  speakerUncertain: v.boolean(),
  result: v.optional(resultEvidenceValidator),
  attendance: attendanceEvidenceValidator,
  measures: attendanceMeasuresValidator,
  cost: costValidator,
};
type SaveExtractionArgs = ObjectType<typeof saveExtractionArgs>;

/** Saves what Claude said, after code validation, and moves the run to its Jev stage. */
export const saveExtraction = internalMutation({
  args: saveExtractionArgs,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const run = await ctx.db.get("callInsightRuns", args.runId);
    if (!run || run.status !== "running" || run.claimToken !== args.claimToken)
      return false;
    const receipts = await settle(ctx, {
      tenantId: run.tenantId,
      jobId: run.jobId,
      receipts: run.receipts,
      costs: { [`claude:${run.attempt}`]: args.cost },
      now,
    });
    // The transcript went while Claude was reading: keep the cost, save no words.
    const recording = await ctx.db.get("callRecordings", run.recordingId);
    if (
      !recording ||
      transcriptGone(recording, now) ||
      run.quotesPurgedAt !== undefined
    ) {
      const closed = await settle(ctx, {
        tenantId: run.tenantId,
        jobId: run.jobId,
        receipts,
        costs: Object.fromEntries(
          receipts
            .filter((r) => r.settledAt === undefined)
            .map((r) => [r.key, { costUsd: 0 }]),
        ),
        now,
      });
      await ctx.db.patch("callInsightRuns", run._id, {
        status: "skipped",
        reason: "no_transcript",
        receipts: closed,
        claimToken: undefined,
        leaseUntil: undefined,
        finishedAt: now,
      });
      await patchHeaderStatus(ctx, run, "skipped", "no_transcript", now);
      await noteJobItem(ctx, run, "skipped");
      return false;
    }
    await ctx.db.patch("callInsightRuns", run._id, {
      status: "checking",
      items: args.items,
      dropped: args.dropped,
      primaryBlockerExtracted: args.primaryBlockerExtracted,
      speakerUncertain: args.speakerUncertain,
      result: args.result,
      attendance: args.attendance,
      measures: args.measures,
      receipts,
      leaseUntil: now + LEASE_MS,
    });
    await patchHeaderStatus(ctx, run, "checking", undefined, now);
    return true;
  },
});

/**
 * Ends an attempt that didn't finish. A busy gateway puts the run back in the
 * queue with a delay while it has attempts left; anything else fails it. Every
 * open receipt is settled with what the attempt was billed.
 */
export const release = internalMutation({
  args: {
    ...idArgs,
    claimToken: v.string(),
    reason: runReasonValidator,
    retry: v.boolean(),
    retryAfterSeconds: v.optional(v.number()),
    /** Costs by receipt key. An open receipt with no entry settles at zero: the request was never billed. */
    costs: v.record(v.string(), costValidator),
    /** The attempt died somewhere unknown: open receipts settle at their full reservation. */
    costUnknown: v.optional(v.boolean()),
    /** Jev answers that did arrive, kept so a retry asks only for the rest. */
    items: v.optional(v.array(insightItemValidator)),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const run = await ctx.db.get("callInsightRuns", args.runId);
    if (!run || run.claimToken !== args.claimToken) return null;
    if (run.status !== "running" && run.status !== "checking") return null;
    const costs: Record<string, ReceiptCost> = {};
    for (const receipt of run.receipts)
      if (receipt.settledAt === undefined)
        costs[receipt.key] =
          args.costs[receipt.key] ?? (args.costUnknown ? {} : { costUsd: 0 });
    const receipts = await settle(ctx, {
      tenantId: run.tenantId,
      jobId: run.jobId,
      receipts: run.receipts,
      costs,
      now,
    });
    const inJevStage = run.status === "checking";
    const canRetry =
      args.retry &&
      (inJevStage
        ? (run.checkRetries ?? 0) < MAX_CHECK_RETRIES
        : run.attempt < MAX_ATTEMPTS);
    if (canRetry) {
      const delay = backoffMs(
        inJevStage ? (run.checkRetries ?? 0) + 1 : run.attempt,
        args.retryAfterSeconds,
      );
      await ctx.db.patch("callInsightRuns", run._id, {
        status: inJevStage ? "checking" : "queued",
        reason: args.reason,
        receipts,
        items:
          run.quotesPurgedAt === undefined
            ? (args.items ?? run.items)
            : run.items,
        claimToken: undefined,
        leaseUntil: undefined,
        nextAttemptAt: now + delay,
      });
      await patchHeaderStatus(
        ctx,
        run,
        inJevStage ? "checking" : "queued",
        args.reason,
        now,
      );
      await ctx.scheduler.runAfter(delay, internal.callInsights.run.read, {
        runId: run._id,
      });
    } else {
      await ctx.db.patch("callInsightRuns", run._id, {
        status: "failed",
        reason: args.reason,
        receipts,
        claimToken: undefined,
        leaseUntil: undefined,
        nextAttemptAt: undefined,
        finishedAt: now,
      });
      await patchHeaderStatus(ctx, run, "failed", args.reason, now);
      await noteJobItem(ctx, run, "failed");
    }
    log.warn("call_insights.attempt_ended", {
      tenantId: run.tenantId,
      runId: run._id,
      reason: args.reason,
      attempt: run.attempt,
      retry: canRetry,
    });
    return null;
  },
});

/**
 * The one place a reading becomes visible. It publishes only if the worker
 * still holds the run, the run is the recording's newest serving read, the
 * recording is still matched to the same meeting and its transcript is still
 * there. Then it saves Jev's answers, rebuilds the text-free rows, stores the
 * suggested result and settles what the Jev stage cost.
 */
export const publish = internalMutation({
  args: {
    ...idArgs,
    claimToken: v.string(),
    items: v.array(insightItemValidator),
    earlyReading: earlyReadingValidator,
    jevCost: costValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const run = await ctx.db.get("callInsightRuns", args.runId);
    if (!run || run.status !== "checking" || run.claimToken !== args.claimToken)
      return null;
    const costs: Record<string, ReceiptCost> = {};
    for (const receipt of run.receipts)
      if (receipt.settledAt === undefined) costs[receipt.key] = args.jevCost;
    const receipts = await settle(ctx, {
      tenantId: run.tenantId,
      jobId: run.jobId,
      receipts: run.receipts,
      costs,
      now,
    });
    const end = async (status: "skipped", reason: RunReason) => {
      await ctx.db.patch("callInsightRuns", run._id, {
        status,
        reason,
        receipts,
        claimToken: undefined,
        leaseUntil: undefined,
        finishedAt: now,
      });
      await patchHeaderStatus(ctx, run, status, reason, now);
      await noteJobItem(ctx, run, "skipped");
      if (reason === "recording_moved") await requeueIfMoved(ctx, run);
      return null;
    };

    const recording = await ctx.db.get("callRecordings", run.recordingId);
    if (
      !recording ||
      recording.matchStatus !== "matched" ||
      recording.meetingId !== run.meetingId
    )
      return await end("skipped", "recording_moved");
    // Nothing with the prospect's words is saved once the transcript is gone.
    if (transcriptGone(recording, now) || run.quotesPurgedAt !== undefined)
      return await end("skipped", "no_transcript");
    const meeting = await ctx.db.get("meetings", run.meetingId);
    const tenant = await ctx.db.get("tenants", run.tenantId);
    const settings = effectiveSettings(tenant);
    if (!meeting || !settings) return await end("skipped", "disabled");

    const primaryBlockerExtracted = run.primaryBlockerExtracted;
    const survived = args.items.filter((item) => item.check !== "rejected");
    const finished = {
      status: "answered" as const,
      reason: undefined,
      items: args.items,
      earlyReading: args.earlyReading,
      primaryBlocker:
        primaryBlockerExtracted &&
        survived.some(
          (item) =>
            item.kind === "objection" &&
            item.category === primaryBlockerExtracted,
        )
          ? primaryBlockerExtracted
          : undefined,
      receipts,
      claimToken: undefined,
      leaseUntil: undefined,
      nextAttemptAt: undefined,
      finishedAt: now,
    };
    await ctx.db.patch("callInsightRuns", run._id, finished);

    if (run.purpose === "serve") {
      const latest = await latestServingRun(ctx, run.recordingId);
      if (
        latest &&
        latest._id !== run._id &&
        latest.generation > run.generation
      ) {
        // A newer read was started while this one ran. Its result stays private.
        await ctx.db.patch("callInsightRuns", run._id, {
          reason: "superseded",
        });
        await noteJobItem(ctx, run, "done");
        return null;
      }
      const header = await headerFor(ctx, run.recordingId);
      if (header) {
        const published = { ...run, ...finished };
        await projectRun(ctx, {
          header,
          run: published,
          meeting,
          now,
          analyzedAt: now,
        });
        await storeSuggestion(ctx, {
          header,
          run: published,
          meeting,
          settings,
          now,
        });
      }
    }
    await noteJobItem(ctx, run, "done");
    log.info("call_insights.published", {
      tenantId: run.tenantId,
      runId: run._id,
      purpose: run.purpose,
      kind: run.kind,
      items: args.items.length,
      rejected: args.items.length - survived.length,
      attempt: run.attempt,
    });
    return null;
  },
});

function sumCost(costs: Array<number | undefined>): number | undefined {
  const known = costs.filter(
    (cost): cost is number => typeof cost === "number",
  );
  return known.length ? known.reduce((a, b) => a + b, 0) : undefined;
}

async function inChunks<T, R>(
  values: T[],
  size: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let start = 0; start < values.length; start += size)
    out.push(
      ...(await Promise.all(values.slice(start, start + size).map(work))),
    );
  return out;
}

/**
 * Reads one recording: Claude extracts, code validates, Jev checks each item
 * and reads the call itself, then one fenced mutation publishes. Convex never
 * retries an action, so every retry is scheduled by `release`.
 */
export const read = internalAction({
  args: idArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const loaded = await ctx.runQuery(internal.callInsights.run.load, args);
    if (!loaded) return null;
    if (loaded.skip !== undefined) {
      await ctx.runMutation(internal.callInsights.run.skip, {
        runId: args.runId,
        reason: loaded.skip,
      });
      return null;
    }
    const input = loaded.input;
    if (!input) return null;
    const now = Date.now();

    let transcript: PreparedTranscript;
    try {
      const blob = await ctx.storage.get(input.transcriptStorageId);
      if (!blob) throw new Error("Transcript file is missing");
      transcript = prepareTranscript(
        parseStoredTranscript(JSON.parse(await blob.text())),
        { email: input.recordedByEmail, names: input.recorderNames },
        input.inviteeEmails,
      );
    } catch {
      // Never log transcript text.
      reportError(
        "call_insights.transcript_unreadable",
        new Error("Transcript could not be read"),
        {
          tenantId: input.tenantId,
          runId: args.runId,
        },
      );
      await ctx.runMutation(internal.callInsights.run.skip, {
        runId: args.runId,
        reason: "no_transcript",
      });
      return null;
    }

    const measures = measureAttendance({
      lines: transcript.lines,
      scheduledAt: input.scheduledAt,
      scheduledEndAt: input.scheduledEndAt,
      recordingStartAt: input.recordingStartAt,
      recordingEndAt: input.recordingEndAt,
      recorderIsAssignedCloser: input.recorderIsAssignedCloser,
      matchStrong: input.matchStrong,
      otherRecordings: input.otherRecordings,
      traceCoversWindow: input.traceCoversWindow,
      newerBooking: input.newerBooking,
      inviteeEmails: input.inviteeEmails,
    });
    const resuming = input.status === "checking";

    if (!resuming) {
      if (transcript.lines.length === 0) {
        await ctx.runMutation(internal.callInsights.run.skip, {
          runId: args.runId,
          reason: "no_prospect_speech",
          measures,
        });
        return null;
      }
      if (transcript.estimatedTokens > MAX_TRANSCRIPT_TOKENS) {
        await ctx.runMutation(internal.callInsights.run.skip, {
          runId: args.runId,
          reason: "input_too_large",
          failed: true,
        });
        return null;
      }
      if (
        transcript.closerOnly &&
        measures.endOffsetSeconds < MIN_WAIT_SECONDS
      ) {
        await ctx.runMutation(internal.callInsights.run.skip, {
          runId: args.runId,
          reason: "no_prospect_speech",
          measures,
        });
        return null;
      }
    }
    const kind = transcript.closerOnly
      ? ("attendance_only" as const)
      : ("full" as const);
    // Seconds from the recording's start to the scheduled start; negative when it started late.
    const scheduledStartOffsetSeconds = Math.round(
      (input.scheduledAt - input.recordingStartAt) / 1000,
    );
    const recordingLengthSeconds = Math.round(
      (input.recordingEndAt - input.recordingStartAt) / 1000,
    );
    const readingsWanted = kind === "full" ? 4 : 2;
    const itemsBound = resuming
      ? (input.items?.length ?? 0)
      : kind === "full"
        ? 44
        : 0;

    const claim = await ctx.runMutation(internal.callInsights.run.begin, {
      runId: args.runId,
      kind,
      expect: resuming ? "check" : "extract",
      claudeMicroUsd: resuming
        ? 0
        : maxCostMicroUsd(
            input.config.model,
            transcript.estimatedTokens,
            MAX_OUTPUT_TOKENS,
          ),
      jevMicroUsd: jevReserveMicroUsd(
        input.config.itemCheck ? itemsBound : 0,
        readingsWanted,
      ),
      secondOpinionSpentUsd: await secondOpinionSpendUsd(
        ctx,
        input.tenantId,
        now,
      ),
    });
    if (!claim) return null;
    const { claimToken } = claim;
    const claudeKey = `claude:${claim.attempt}`;
    const getToken = () => getServiceToken("ai-gateway");

    try {
      let items: InsightItem[];
      let result = input.result;
      if (resuming) {
        items = input.items ?? [];
      } else {
        const rendered = renderLines(transcript.lines);
        const response = await callMessages(
          buildMessagesRequest({
            model: input.config.model,
            system: kind === "full" ? EXTRACTION_SYSTEM : ATTENDANCE_SYSTEM,
            user: buildUserMessage({
              rendered,
              scheduledStartOffsetSeconds,
              // "Tomorrow at three" counts from the day of the call where
              // the tenant is, not from the UTC date of this read.
              todayIso: businessDateForInstant(input.recordingStartAt, {
                timeZone: input.timeZone,
                dayStartHour: 0,
              }),
              timeZone: input.timeZone,
            }),
            schema: kind === "full" ? EXTRACTION_SCHEMA : ATTENDANCE_SCHEMA,
            maxTokens: MAX_OUTPUT_TOKENS,
            effort: "low",
          }),
          getToken,
        );
        if (response.kind !== "ok") {
          // A refusal or an unusable answer is billed. A request that never got
          // an answer (status 0) may have been: its cost is unknown, so its
          // reservation is kept. A busy answer with a status was not billed.
          const billed: Record<string, ReceiptCost> =
            response.kind === "refused" || response.kind === "format_changed"
              ? { [claudeKey]: { costUsd: response.costUsd } }
              : response.kind === "busy" && response.status === 0
                ? { [claudeKey]: {} }
                : {};
          if (response.kind === "format_changed")
            reportError(
              "call_insights.format_changed",
              new Error("Messages response failed validation"),
              {
                tenantId: input.tenantId,
                runId: args.runId,
                integration: "ai-gateway",
              },
            );
          await ctx.runMutation(internal.callInsights.run.release, {
            runId: args.runId,
            claimToken,
            reason:
              response.kind === "busy"
                ? "upstream_error"
                : response.kind === "refused"
                  ? "refused"
                  : response.kind === "rejected"
                    ? "rejected"
                    : "format_changed",
            retry: response.kind === "busy",
            retryAfterSeconds:
              response.kind === "busy" ? response.retryAfterSeconds : undefined,
            costs: billed,
          });
          return null;
        }
        const cost = {
          costUsd: response.costUsd,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          gatewayRequestId: response.id,
        };
        let saved: SaveExtractionArgs;
        try {
          if (kind === "full") {
            const raw = parseExtraction(response.text);
            const validated = validateExtraction(raw, transcript, {
              timeZone: input.timeZone,
              now,
            });
            const programHeard = validated.result.programHeard
              ?.trim()
              .toLowerCase();
            const program = programHeard
              ? input.programs.find(
                  (p) => p.name.trim().toLowerCase() === programHeard,
                )
              : undefined;
            saved = {
              runId: args.runId,
              claimToken,
              items: validated.items,
              dropped: validated.dropped,
              primaryBlockerExtracted: validated.primaryBlockerExtracted,
              speakerUncertain: validated.speakerUncertain,
              result: {
                ...validated.result,
                values: { ...validated.result.values, programId: program?.id },
              },
              // The timing rules for waiting and leaving quotes need the
              // recording's offsets, which the item validator doesn't have.
              attendance: validateAttendance(
                raw.attendance,
                transcript,
                scheduledStartOffsetSeconds,
                recordingLengthSeconds,
              ),
              measures,
              cost,
            };
          } else {
            saved = {
              runId: args.runId,
              claimToken,
              items: [],
              speakerUncertain: transcript.speakerUncertain,
              attendance: validateAttendance(
                parseAttendanceOnly(response.text),
                transcript,
                scheduledStartOffsetSeconds,
                recordingLengthSeconds,
              ),
              measures,
              cost,
            };
          }
        } catch {
          reportError(
            "call_insights.format_changed",
            new Error("Model output did not match the expected shape"),
            {
              tenantId: input.tenantId,
              runId: args.runId,
              integration: "ai-gateway",
            },
          );
          await ctx.runMutation(internal.callInsights.run.release, {
            runId: args.runId,
            claimToken,
            reason: "format_changed",
            retry: false,
            costs: { [claudeKey]: cost },
          });
          return null;
        }
        if (
          !(await ctx.runMutation(
            internal.callInsights.run.saveExtraction,
            saved,
          ))
        )
          return null;
        items = saved.items;
        result = saved.result;
      }

      // Jev: one request per item that has no answer yet, the call read twice
      // with and without Fathom's summary, and one check of the proposed result.
      const jevCosts: Array<number | undefined> = [];
      // True once a request's cost can't be known: it answered without one, or
      // it never got an answer and may still have been billed.
      let jevCostUnknown = false;
      const noteFailure = (status: number) => {
        if (status === 0) jevCostUnknown = true;
      };
      let missing = false;
      const checked = input.config.itemCheck
        ? await inChunks(items, JEV_PARALLEL, async (item) => {
            if (item.check !== "unchecked" || item.score !== undefined)
              return item;
            const answer = await callGenericDecisions(
              buildItemCheck(item, transcript.lines),
              getToken,
            );
            if (answer.kind !== "ok") {
              missing = true;
              if (answer.kind === "busy") noteFailure(answer.status);
              return item;
            }
            jevCosts.push(answer.costUsd);
            return applyItemCheck(item, answer.answers);
          })
        : items;

      const readingRequests = buildReadingRequests({
        kind,
        callKind: input.callKind,
        program: input.program,
        recordedMinutes: Math.max(
          0,
          (input.recordingEndAt - input.recordingStartAt) / 60_000,
        ),
        summary: input.summary,
        actionItems: input.actionItems,
        lines: transcript.lines,
      });
      const parsedReadings: Array<{ key: string; answers: PartialAnswers }> =
        [];
      let readingIncomplete = false;
      await Promise.all(
        readingRequests.map(async ({ key, request }) => {
          const answer = await callDecisions(request, getToken);
          if (answer.kind !== "ok") {
            readingIncomplete = true;
            if (answer.kind === "retryable") noteFailure(answer.status);
            return;
          }
          jevCosts.push(answer.parsed.costUsd);
          parsedReadings.push({ key, answers: answer.parsed.answers });
        }),
      );
      let earlyReading: EarlyReading = combineReadingAnswers(
        parsedReadings,
        readingIncomplete,
      );
      const resultCheck = result
        ? buildResultCheck(result, transcript.lines)
        : null;
      if (resultCheck) {
        const answer = await callGenericDecisions(resultCheck, getToken);
        if (answer.kind === "ok") {
          jevCosts.push(answer.costUsd);
          earlyReading = {
            ...earlyReading,
            resultCheck: answer.answers.result?.noul,
          };
        } else {
          earlyReading = { ...earlyReading, incomplete: true };
          if (answer.kind === "busy") noteFailure(answer.status);
        }
      }
      // With any cost unknown the whole Jev reservation is kept as spent.
      const jevCost: ReceiptCost =
        jevCostUnknown || jevCosts.some((cost) => cost === undefined)
          ? {}
          : { costUsd: sumCost(jevCosts) ?? 0 };

      const checkRetries = input.checkRetries + (resuming ? 1 : 0);
      if (
        (missing || earlyReading.incomplete) &&
        checkRetries < MAX_CHECK_RETRIES
      ) {
        // Keep the answers that arrived; a later attempt asks only for the rest.
        const open: Record<string, ReceiptCost> = {};
        open[
          resuming
            ? `jev:${claim.attempt}:${input.checkRetries + 1}`
            : `jev:${claim.attempt}`
        ] = jevCost;
        await ctx.runMutation(internal.callInsights.run.release, {
          runId: args.runId,
          claimToken,
          reason: "upstream_error",
          retry: true,
          costs: open,
          items: checked,
        });
        return null;
      }

      await ctx.runMutation(internal.callInsights.run.publish, {
        runId: args.runId,
        claimToken,
        // Out of retries: an item Jev never answered reads "Not confirmed".
        items: checked.map((item) =>
          input.config.itemCheck && item.check === "unchecked"
            ? applyItemCheck(item, undefined)
            : item,
        ),
        earlyReading,
        jevCost,
      });
    } catch {
      // Never log transcript text, model output or tokens.
      reportError(
        "call_insights.read_failed",
        new Error("Call insights read failed"),
        {
          tenantId: input.tenantId,
          runId: args.runId,
        },
      );
      await ctx.runMutation(internal.callInsights.run.release, {
        runId: args.runId,
        claimToken,
        reason: "upstream_error",
        retry: true,
        costs: {},
        costUnknown: true,
      });
    }
    return null;
  },
});
