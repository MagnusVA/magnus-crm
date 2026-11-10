import { v } from "convex/values";
import { getServiceToken } from "convex/server";
import { z } from "zod";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import schema from "../schema";
import { log, reportError } from "../lib/observability/log";
import { buildDecisionsRequest, callDecisions } from "./jev";
import { buildState, labelSpeakers, measureEvidence } from "./transcript";
import { computeVerdict } from "./verdict";
import { monthQuery } from "./month";

const idArgs = { secondOpinionId: v.id("secondOpinions") };
const fields = schema.tables.secondOpinions.validator.fields;
export const load = internalQuery({
  args: idArgs,
  returns: v.union(
    v.null(),
    v.object({
      claim: v.optional(v.string()),
      record: fields.record,
      recording: v.object({
        transcriptStorageId: v.optional(v.id("_storage")),
        recordingStartAt: v.number(),
        recordingEndAt: v.number(),
        recordedByEmail: v.string(),
        recorderName: v.optional(v.string()),
        inviteeEmails: v.array(v.string()),
        summary: v.optional(v.string()),
        actionItems: v.array(v.string()),
      }),
      callKind: v.union(v.literal("new call"), v.literal("follow-up call")),
      program: v.optional(v.string()),
      tenantId: v.id("tenants"),
      monthlyCapUsd: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("secondOpinions", args.secondOpinionId);
    if (!row || row.status !== "queued") return null;
    const [tenant, meeting, recording] = await Promise.all([
      ctx.db.get("tenants", row.tenantId),
      ctx.db.get("meetings", row.meetingId),
      ctx.db.get("callRecordings", row.recordingId),
    ]);
    if (
      !tenant ||
      !meeting ||
      !recording ||
      meeting.tenantId !== row.tenantId ||
      recording.tenantId !== row.tenantId ||
      recording.meetingId !== meeting._id ||
      recording.matchStatus !== "matched"
    )
      return null;
    const recorder = recording.recordedByUserId
      ? await ctx.db.get("users", recording.recordedByUserId)
      : null;
    return {
      claim: row.claim,
      record: row.record,
      tenantId: row.tenantId,
      monthlyCapUsd: tenant.secondOpinion?.monthlyCapUsd ?? 40,
      callKind:
        meeting.callClassification === "follow_up"
          ? ("follow-up call" as const)
          : ("new call" as const),
      program: meeting.bookingProgramName,
      recording: {
        transcriptStorageId: recording.transcriptStorageId,
        recordingStartAt: recording.recordingStartAt,
        recordingEndAt: recording.recordingEndAt,
        recordedByEmail: recording.recordedByEmail,
        recorderName:
          recorder?.tenantId === row.tenantId ? recorder.fullName : undefined,
        inviteeEmails: recording.inviteeEmails,
        summary: recording.summaryMarkdown,
        actionItems: (recording.actionItems ?? []).map(
          (item) => item.description,
        ),
      },
    };
  },
});

/** Page the exact cost sum. Each action-side read stays within transaction limits. */
export const costPage = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    now: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({
    costUsd: v.number(),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const page = await monthQuery(ctx, args.tenantId, args.now).paginate({
      cursor: args.cursor,
      numItems: 100,
      maximumBytesRead: 512_000,
    });
    return {
      costUsd: page.page.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});

/** Atomic attempt claim prevents duplicate scheduled actions calling the gateway twice. */
export const begin = internalMutation({
  args: { ...idArgs, attempt: v.number(), monthCostUsd: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("secondOpinions", args.secondOpinionId);
    if (!row || row.status !== "queued" || row.attempts !== args.attempt)
      return false;
    const tenant = await ctx.db.get("tenants", row.tenantId);
    const recording = await ctx.db.get("callRecordings", row.recordingId);
    const failure =
      !tenant?.secondOpinion || tenant.secondOpinion.mode === "off"
        ? ("disabled" as const)
        : args.monthCostUsd >= tenant.secondOpinion.monthlyCapUsd
          ? ("cap_reached" as const)
          : !recording?.transcriptStorageId ||
              recording.transcriptDeletedAt !== undefined ||
              recording.recordingStartAt + 90 * 86400_000 <= Date.now()
            ? ("no_transcript" as const)
            : undefined;
    if (failure) {
      await ctx.db.patch("secondOpinions", row._id, {
        status: "skipped",
        failure,
      });
      return false;
    }
    await ctx.db.patch("secondOpinions", row._id, {
      attempts: row.attempts + 1,
    });
    return true;
  },
});

export const save = internalMutation({
  args: {
    ...idArgs,
    attempt: v.number(),
    answers: fields.answers,
    evidence: fields.evidence,
    gatewayRequestId: v.optional(v.string()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    costUsd: v.optional(v.number()),
    durationMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("secondOpinions", args.secondOpinionId);
    if (
      !row ||
      row.status !== "queued" ||
      row.attempts !== args.attempt ||
      !args.answers
    )
      return null;
    const verdict = computeVerdict(row.record, args.answers);
    await ctx.db.patch("secondOpinions", row._id, {
      status: "answered",
      answeredAt: Date.now(),
      answers: args.answers,
      evidence: args.evidence,
      verdict,
      reviewState: verdict === "disagrees" ? "open" : undefined,
      gatewayRequestId: args.gatewayRequestId,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      costUsd: args.costUsd,
    });
    log.info("second_opinion.ran", {
      tenantId: row.tenantId,
      secondOpinionId: row._id,
      verdict,
      durationMs: args.durationMs,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      costUsd: args.costUsd,
    });
    return null;
  },
});

export const fail = internalMutation({
  args: {
    ...idArgs,
    attempt: v.number(),
    failure: fields.failure,
    retryable: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("secondOpinions", args.secondOpinionId);
    if (!row || row.status !== "queued" || row.attempts !== args.attempt)
      return null;
    const retry = args.retryable && row.attempts < 3;
    if (retry)
      await ctx.scheduler.runAfter(
        row.attempts === 1 ? 60_000 : 300_000,
        internal.secondOpinion.run.run,
        { secondOpinionId: row._id, attempt: row.attempts },
      );
    else
      await ctx.db.patch("secondOpinions", row._id, {
        status: "failed",
        failure: args.failure,
      });
    log.warn("second_opinion.failed", {
      tenantId: row.tenantId,
      secondOpinionId: row._id,
      failure: args.failure,
      attempt: row.attempts,
      retry,
    });
    return null;
  },
});

const storedTranscript = z.array(
  z.object({
    speaker: z.string(),
    email: z.string().optional(),
    timestamp: z.string().regex(/^(?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?$/),
    text: z.string(),
  }),
);
/** A deleted or detached input must not leave a check queued forever. */
export const discardUnavailable = internalMutation({
  args: { ...idArgs, attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("secondOpinions", args.secondOpinionId);
    if (!row || row.status !== "queued" || row.attempts !== args.attempt)
      return null;
    await ctx.db.patch("secondOpinions", row._id, {
      status: "skipped",
      failure: "no_transcript",
    });
    log.warn("second_opinion.failed", {
      tenantId: row.tenantId,
      secondOpinionId: row._id,
      failure: "no_transcript",
    });
    return null;
  },
});

export const run = internalAction({
  args: { ...idArgs, attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const startedAt = Date.now();
    const input = await ctx.runQuery(internal.secondOpinion.run.load, {
      secondOpinionId: args.secondOpinionId,
    });
    if (!input) {
      await ctx.runMutation(
        internal.secondOpinion.run.discardUnavailable,
        args,
      );
      return null;
    }
    let cursor: string | null = null;
    let costUsd = 0;
    do {
      const page: { costUsd: number; cursor: string | null } =
        await ctx.runQuery(internal.secondOpinion.run.costPage, {
          tenantId: input.tenantId,
          now: startedAt,
          cursor,
        });
      costUsd += page.costUsd;
      cursor = page.cursor;
    } while (cursor !== null && costUsd < input.monthlyCapUsd);
    if (
      !(await ctx.runMutation(internal.secondOpinion.run.begin, {
        ...args,
        monthCostUsd: costUsd,
      }))
    )
      return null;
    const attempt = args.attempt + 1;
    try {
      const recording = input.recording;
      const blob = recording.transcriptStorageId
        ? await ctx.storage.get(recording.transcriptStorageId)
        : null;
      if (!blob) {
        await ctx.runMutation(internal.secondOpinion.run.fail, {
          secondOpinionId: args.secondOpinionId,
          attempt,
          failure: "no_transcript",
          retryable: false,
        });
        return null;
      }
      const raw = storedTranscript.parse(JSON.parse(await blob.text()));
      const lines = labelSpeakers(
        raw.map((line) => ({
          atSeconds: line.timestamp
            .split(":")
            .reduce((n, part) => n * 60 + Number(part), 0),
          speakerName: line.speaker,
          speakerEmail: line.email,
          text: line.text,
        })),
        { email: recording.recordedByEmail, name: recording.recorderName },
        recording.inviteeEmails,
      );
      const evidence = measureEvidence(
        lines,
        recording.recordingStartAt,
        recording.recordingEndAt,
      );
      const state = buildState({
        callKind: input.callKind,
        program: input.program,
        recordedMinutes: Math.max(
          0,
          (recording.recordingEndAt - recording.recordingStartAt) / 60_000,
        ),
        summary: recording.summary,
        actionItems: recording.actionItems,
        lines,
      });
      const result = await callDecisions(
        buildDecisionsRequest(state, input.claim),
        () => getServiceToken("ai-gateway"),
      );
      if (result.kind === "ok") {
        const parsed = result.parsed;
        await ctx.runMutation(internal.secondOpinion.run.save, {
          secondOpinionId: args.secondOpinionId,
          attempt,
          answers: parsed.answers,
          evidence,
          gatewayRequestId: parsed.id,
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
          costUsd: parsed.costUsd,
          durationMs: Date.now() - startedAt,
        });
      } else {
        if (result.kind === "format_changed")
          reportError(
            "second_opinion.format_changed",
            new Error("Decisions response failed validation"),
            {
              tenantId: input.tenantId,
              secondOpinionId: args.secondOpinionId,
              integration: "ai-gateway",
            },
          );
        await ctx.runMutation(internal.secondOpinion.run.fail, {
          secondOpinionId: args.secondOpinionId,
          attempt,
          failure: result.kind === "retryable" ? "upstream_error" : result.kind,
          retryable: result.kind === "retryable",
        });
      }
    } catch {
      // Never log transcript text, gateway bodies, or service tokens.
      reportError(
        "second_opinion.failed",
        new Error("Second opinion could not read or process its input"),
        { secondOpinionId: args.secondOpinionId, tenantId: input.tenantId },
      );
      await ctx.runMutation(internal.secondOpinion.run.fail, {
        secondOpinionId: args.secondOpinionId,
        attempt,
        failure: "no_transcript",
        retryable: false,
      });
    }
    return null;
  },
});
