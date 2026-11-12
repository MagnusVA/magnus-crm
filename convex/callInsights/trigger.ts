import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { ITEM_KINDS } from "../../lib/callInsights/taxonomy";
import { log, reportError } from "../lib/observability/log";
import { effectiveSettings, servingConfig } from "./settings";
import type { RunConfig } from "./validators";

export type ReadTrigger = Doc<"callInsightRuns">["trigger"];
type CallHeader = Extract<Doc<"callInsightFacts">, { kind: "call" }>;

/** A run that has not finished: a second read of the same recording waits for it. */
const IN_FLIGHT = new Set<Doc<"callInsightRuns">["status"]>([
  "queued",
  "waiting",
  "running",
  "checking",
]);

/**
 * The one call the Fathom match hook makes. It never throws and never writes:
 * with Call insights off it returns after two reads; otherwise it schedules
 * `onMatched`, so a failure here can't undo the recording's match.
 */
export async function onRecordingMatchedForInsights(
  ctx: MutationCtx,
  args: { recordingId: Id<"callRecordings"> },
): Promise<void> {
  try {
    const recording = await ctx.db.get("callRecordings", args.recordingId);
    if (!recording) return;
    const tenant = await ctx.db.get("tenants", recording.tenantId);
    if (!effectiveSettings(tenant)) return;
    await ctx.scheduler.runAfter(0, internal.callInsights.trigger.onMatched, {
      recordingId: args.recordingId,
    });
  } catch (error) {
    reportError("call_insights.match_hook_failed", error, {
      recordingId: args.recordingId,
      severity: "warning",
    });
  }
}

export async function headerFor(
  ctx: Pick<QueryCtx, "db">,
  recordingId: Id<"callRecordings">,
) {
  const row = await ctx.db
    .query("callInsightFacts")
    .withIndex("by_recordingId_and_kind", (q) =>
      q.eq("recordingId", recordingId).eq("kind", "call"),
    )
    .first();
  return row && row.kind === "call" ? row : null;
}

export async function latestServingRun(
  ctx: Pick<QueryCtx, "db">,
  recordingId: Id<"callRecordings">,
): Promise<Doc<"callInsightRuns"> | null> {
  return await ctx.db
    .query("callInsightRuns")
    .withIndex("by_recordingId_and_purpose_and_generation", (q) =>
      q.eq("recordingId", recordingId).eq("purpose", "serve"),
    )
    .order("desc")
    .first();
}

/** Creates the recording's permanent header if it has none, and returns it. */
async function ensureHeader(
  ctx: MutationCtx,
  recording: Doc<"callRecordings">,
  meeting: Doc<"meetings">,
  now: number,
) {
  const existing = await headerFor(ctx, recording._id);
  if (existing) return existing;
  const id = await ctx.db.insert("callInsightFacts", {
    kind: "call",
    tenantId: recording.tenantId,
    recordingId: recording._id,
    meetingId: meeting._id,
    active: true,
    publicationRevision: 0,
    latestStatus: "queued",
    expectedItemCount: 0,
    scheduledAt: meeting.scheduledAt,
    createdAt: now,
    updatedAt: now,
  });
  const created = await ctx.db.get("callInsightFacts", id);
  if (!created || created.kind !== "call")
    throw new Error("Header vanished after insert");
  return created;
}

/**
 * Queues a serving read of a recording and returns the run, or null when
 * nothing was queued: the feature is off, the recording isn't matched, or
 * (for the match hook and the sweep) the recording already has a run.
 *
 * `read_again`, `rerun` and `backfill` start a new generation when the latest
 * run has finished. The published generation stays visible until the new one
 * publishes.
 */
export async function queueRead(
  ctx: MutationCtx,
  args: {
    recordingId: Id<"callRecordings">;
    trigger: ReadTrigger;
    jobId?: Id<"callInsightJobs">;
    /** Read with this configuration instead of the tenant's. Jobs only. */
    config?: RunConfig;
  },
): Promise<Id<"callInsightRuns"> | null> {
  const now = Date.now();
  const recording = await ctx.db.get("callRecordings", args.recordingId);
  if (!recording || recording.matchStatus !== "matched" || !recording.meetingId)
    return null;
  const tenant = await ctx.db.get("tenants", recording.tenantId);
  const settings = effectiveSettings(tenant);
  if (!settings) return null;
  const meeting = await ctx.db.get("meetings", recording.meetingId);
  if (!meeting || meeting.tenantId !== recording.tenantId) return null;

  let header = await ensureHeader(ctx, recording, meeting, now);
  const latest = await latestServingRun(ctx, recording._id);
  const moved = header.meetingId !== meeting._id;
  // True when the header's rows are off: the recording was unmatched or moved.
  const detached = moved || !header.active;
  if (detached) {
    // The recording belongs to this meeting now. Whatever was published for
    // another meeting comes off before the header counts for this one.
    if (moved) await detachHeader(ctx, header, now);
    await ctx.db.patch("callInsightFacts", header._id, {
      active: true,
      meetingId: meeting._id,
      scheduledAt: meeting.scheduledAt,
      updatedAt: now,
    });
    header = {
      ...header,
      active: true,
      meetingId: meeting._id,
      scheduledAt: meeting.scheduledAt,
    };
  }
  if (latest) {
    // A run in flight for another meeting ends itself as "recording moved" and
    // then queues the read for this one (see `requeueIfMoved`).
    if (IN_FLIGHT.has(latest.status)) return latest._id;
    if (args.trigger === "recording_matched" || args.trigger === "sweep") {
      const published = header.publishedRunId
        ? await ctx.db.get("callInsightRuns", header.publishedRunId)
        : null;
      const shown = published ?? latest;
      const forThisMeeting = shown.meetingId === meeting._id;
      // A full reading is about what was said, so it can be shown on whichever
      // meeting the recording belongs to. No model is called again.
      if (
        shown.status === "answered" &&
        (forThisMeeting || shown.kind === "full")
      ) {
        if (detached || !forThisMeeting)
          await ctx.scheduler.runAfter(
            0,
            internal.callInsights.publish.reproject,
            {
              recordingId: recording._id,
            },
          );
        return null;
      }
      if (latest.meetingId === meeting._id) return null;
      // An attendance-only reading, a skip and a failure all depended on the
      // old meeting's time or prospect, so this meeting gets its own read and
      // nothing published for the old one stays on the header.
      await ctx.db.patch("callInsightFacts", header._id, {
        publishedRunId: undefined,
        publishedGeneration: undefined,
        readKind: undefined,
        analyzedAt: undefined,
      });
    }
  }
  const generation = (latest?.generation ?? 0) + 1;
  const inputKey = `${recording._id}:serve:${generation}`;
  const duplicate = await ctx.db
    .query("callInsightRuns")
    .withIndex("by_tenantId_and_inputKey", (q) =>
      q.eq("tenantId", recording.tenantId).eq("inputKey", inputKey),
    )
    .first();
  if (duplicate) return duplicate._id;

  const runId = await ctx.db.insert("callInsightRuns", {
    tenantId: recording.tenantId,
    recordingId: recording._id,
    meetingId: meeting._id,
    purpose: "serve",
    jobId: args.jobId,
    generation,
    inputKey,
    trigger: args.trigger,
    kind: "full",
    status: "queued",
    attempt: 0,
    config: args.config ?? servingConfig(settings),
    receipts: [],
    // Due now, so the sweep finds the run if its scheduled read is lost.
    nextAttemptAt: now,
    quotesExpireAt: recording.transcriptExpiresAt,
    createdAt: now,
  });
  await ctx.db.patch("callInsightFacts", header._id, {
    latestStatus: "queued",
    reasonCode: undefined,
    latestRunId: runId,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.callInsights.run.read, { runId });
  log.info("call_insights.queued", {
    tenantId: recording.tenantId,
    recordingId: recording._id,
    runId,
    trigger: args.trigger,
    generation,
  });
  return runId;
}

/**
 * Takes a recording's published rows off the meeting it was read for: its item
 * rows, its no-show tier and its unused suggestion go, and the header stops
 * counting. The runs keep everything, so a later match can show it again.
 */
async function detachHeader(ctx: MutationCtx, header: CallHeader, now: number) {
  for (const kind of ITEM_KINDS) {
    const rows = await ctx.db
      .query("callInsightFacts")
      .withIndex("by_recordingId_and_kind", (q) =>
        q.eq("recordingId", header.recordingId).eq("kind", kind),
      )
      .take(60);
    for (const row of rows) await ctx.db.delete("callInsightFacts", row._id);
  }
  await ctx.db.patch("callInsightFacts", header._id, {
    active: false,
    expectedItemCount: 0,
    rejectedCount: undefined,
    primaryBlocker: undefined,
    noShowTier: undefined,
    shadowTiers: undefined,
    updatedAt: now,
  });
  const suggestions = await ctx.db
    .query("resultSuggestionStates")
    .withIndex("by_recordingId", (q) => q.eq("recordingId", header.recordingId))
    .take(5);
  for (const row of suggestions)
    if (row.usedAt === undefined)
      await ctx.db.delete("resultSuggestionStates", row._id);
}

/**
 * Called when a run ended as "recording moved". If its recording is matched to
 * a meeting now, that meeting's read is queued; the run that just ended is no
 * longer in flight, so `queueRead` starts a new one.
 */
export async function requeueIfMoved(
  ctx: MutationCtx,
  run: Pick<Doc<"callInsightRuns">, "recordingId" | "purpose">,
): Promise<void> {
  if (run.purpose !== "serve") return;
  const recording = await ctx.db.get("callRecordings", run.recordingId);
  if (!recording || recording.matchStatus !== "matched" || !recording.meetingId)
    return;
  await ctx.scheduler.runAfter(0, internal.callInsights.trigger.onMatched, {
    recordingId: run.recordingId,
  });
}

/**
 * The one call the Fathom attach path makes when a recording stops belonging
 * to a meeting: an admin marked it "not a sales call", or moved it. The call's
 * rows stop counting in reports and on the person page until it is matched
 * again. Like the match hook, it never throws; with Call insights never used
 * for the recording it returns after one read.
 */
export async function onRecordingUnmatchedForInsights(
  ctx: MutationCtx,
  args: { recordingId: Id<"callRecordings"> },
): Promise<void> {
  try {
    const header = await headerFor(ctx, args.recordingId);
    if (!header || !header.active) return;
    await detachHeader(ctx, header, Date.now());
  } catch (error) {
    reportError("call_insights.unmatch_hook_failed", error, {
      recordingId: args.recordingId,
      severity: "warning",
    });
  }
}

/** Scheduled by the Fathom match hook. */
export const onMatched = internalMutation({
  args: { recordingId: v.id("callRecordings") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await queueRead(ctx, {
      recordingId: args.recordingId,
      trigger: "recording_matched",
    });
    return null;
  },
});
