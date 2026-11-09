import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import schema from "../schema";
import {
  meetingSchema,
  recordingFields,
  recordingInput,
  parseTranscript,
} from "./validators";
import { matchRecording } from "./matching";
import { recordMatch } from "./recordings";
import { log, reportError } from "../lib/observability/log";
import { fathomFetch, FathomRetry } from "./client";
import { summarySchema } from "./validators";
import { z } from "zod";

const eventDoc = v.object({
  ...schema.tables.fathomWebhookEvents.validator.fields,
  _id: v.id("fathomWebhookEvents"),
  _creationTime: v.number(),
});
export const ingest = internalMutation({
  args: {
    connectionId: v.id("tenantFathomConnections"),
    webhookMessageId: v.string(),
    payloadStorageId: v.optional(v.id("_storage")),
    payload: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, a) => {
    const c = await ctx.db.get("tenantFathomConnections", a.connectionId);
    if (!c || c.connectionStatus !== "connected") return false;
    const duplicate = await ctx.db
      .query("fathomWebhookEvents")
      .withIndex("by_tenantId_and_webhookMessageId", (q) =>
        q.eq("tenantId", c.tenantId).eq("webhookMessageId", a.webhookMessageId),
      )
      .unique();
    if (duplicate) return false;
    const eventId = await ctx.db.insert("fathomWebhookEvents", {
      tenantId: c.tenantId,
      connectionId: c._id,
      webhookMessageId: a.webhookMessageId,
      payload: a.payload ?? "",
      payloadStorageId: a.payloadStorageId,
      receivedAt: Date.now(),
      status: "pending",
    });
    if (!a.webhookMessageId.startsWith("reconcile:"))
      await ctx.db.patch("tenantFathomConnections", c._id, {
        lastWebhookAt: Date.now(),
      });
    await ctx.scheduler.runAfter(0, internal.fathom.processor.process, {
      eventId,
    });
    return true;
  },
});
export const event = internalQuery({
  args: { eventId: v.id("fathomWebhookEvents") },
  returns: v.union(v.null(), eventDoc),
  handler: (ctx, a) => ctx.db.get("fathomWebhookEvents", a.eventId),
});
export const classify = internalMutation({
  args: {
    eventId: v.id("fathomWebhookEvents"),
    email: v.string(),
    hasExternalInvitee: v.boolean(),
  },
  returns: v.union(v.null(), v.id("users")),
  handler: async (ctx, a) => {
    const e = await ctx.db.get("fathomWebhookEvents", a.eventId);
    if (
      !e ||
      (e.status !== "pending" && e.status !== "held" && e.status !== "failed")
    )
      return null;
    const member = await ctx.db
      .query("fathomOrgMembers")
      .withIndex("by_tenantId_and_email", (q) =>
        q.eq("tenantId", e.tenantId).eq("email", a.email),
      )
      .unique();
    if (member?.ignored || !a.hasExternalInvitee) {
      if (e.payloadStorageId) await ctx.storage.delete(e.payloadStorageId);
      await ctx.db.patch("fathomWebhookEvents", e._id, {
        status: "dropped",
        payload: "",
        payloadStorageId: undefined,
        processedAt: Date.now(),
      });
      const c = await ctx.db.get("tenantFathomConnections", e.connectionId);
      if (c)
        await ctx.db.patch("tenantFathomConnections", c._id, {
          droppedCount: (c.droppedCount ?? 0) + 1,
        });
      log.info("fathom.event.dropped", {
        tenantId: e.tenantId,
        reason: member?.ignored ? "ignored_member" : "internal_only",
      });
      return null;
    }
    const user = member?.matchedUserId
      ? await ctx.db.get("users", member.matchedUserId)
      : null;
    if (!user?.isActive || user.tenantId !== e.tenantId) {
      await ctx.db.patch("fathomWebhookEvents", e._id, {
        status: "held",
        holdUntil: e.receivedAt + 7 * 86400_000,
      });
      log.info("fathom.event.held", {
        tenantId: e.tenantId,
        reason: "unlinked_member",
      });
      return null;
    }
    if (e.holdUntil && e.holdUntil <= Date.now()) return null;
    return user._id;
  },
});
export const commit = internalMutation({
  args: {
    eventId: v.id("fathomWebhookEvents"),
    data: recordingInput,
    transcriptStorageId: v.optional(v.id("_storage")),
    transcriptLineCount: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, a) => {
    const e = await ctx.db.get("fathomWebhookEvents", a.eventId);
    if (!e || e.status === "processed" || e.status === "dropped") return false;
    const c = await ctx.db.get("tenantFathomConnections", e.connectionId);
    if (!c || c.connectionStatus !== "connected") return false;
    const member = await ctx.db
      .query("fathomOrgMembers")
      .withIndex("by_tenantId_and_email", (q) =>
        q.eq("tenantId", e.tenantId).eq("email", a.data.recordedByEmail),
      )
      .unique();
    const user = member?.matchedUserId
      ? await ctx.db.get("users", member.matchedUserId)
      : null;
    if (member?.ignored || !user?.isActive || user.tenantId !== e.tenantId)
      return false;
    const existing = await ctx.db
      .query("callRecordings")
      .withIndex("by_tenantId_and_fathomRecordingId", (q) =>
        q
          .eq("tenantId", e.tenantId)
          .eq("fathomRecordingId", a.data.fathomRecordingId),
      )
      .unique();
    await ctx.db.patch("fathomWebhookEvents", e._id, {
      status: "processed",
      processedAt: Date.now(),
      error: undefined,
    });
    if (existing) return false;
    const match = await matchRecording(ctx, {
      tenantId: e.tenantId,
      userId: user._id,
      ...a.data,
    });
    const occupied = match
      ? await ctx.db
          .query("callRecordings")
          .withIndex("by_meetingId", (q) => q.eq("meetingId", match.meetingId))
          .first()
      : null;
    const acceptedMatch = occupied ? null : match;
    const { hasExternalInvitee: _external, meetingUrl: _url, ...data } = a.data;
    const recordingId = await ctx.db.insert("callRecordings", {
      tenantId: e.tenantId,
      connectionId: e.connectionId,
      recordedByUserId: user._id,
      ...data,
      transcriptStorageId: a.transcriptStorageId,
      transcriptLineCount: a.transcriptLineCount,
      ...(data.recordingStartAt + 90 * 86400_000 <= Date.now()
        ? { transcriptDeletedAt: Date.now() }
        : {}),
      ...(a.transcriptStorageId
        ? { transcriptExpiresAt: data.recordingStartAt + 90 * 86400_000 }
        : {}),
      matchStatus: acceptedMatch ? "matched" : "unmatched",
      ...acceptedMatch,
      matchedAt: acceptedMatch ? Date.now() : undefined,
      rawEventId: e._id,
      createdAt: Date.now(),
    });
    if (acceptedMatch)
      await recordMatch(ctx, {
        tenantId: e.tenantId,
        meetingId: acceptedMatch.meetingId,
        recordingId,
      });
    log.info("fathom.recording.processed", {
      tenantId: e.tenantId,
      recordingId,
      matched: Boolean(acceptedMatch),
    });
    return true;
  },
});
export const fail = internalMutation({
  args: {
    eventId: v.id("fathomWebhookEvents"),
    retryMs: v.number(),
    retryable: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const e = await ctx.db.get("fathomWebhookEvents", a.eventId);
    if (!e || e.status === "processed" || e.status === "dropped") return null;
    const attempts = (e.attempts ?? 0) + 1;
    await ctx.db.patch("fathomWebhookEvents", e._id, {
      status: "failed",
      attempts,
      error: "Processing failed. Retry scheduled until retention expires.",
    });
    if (
      (a.retryable || attempts < 8) &&
      e.receivedAt + 7 * 86400_000 > Date.now()
    )
      await ctx.scheduler.runAfter(
        a.retryMs,
        internal.fathom.processor.process,
        { eventId: e._id },
      );
    return null;
  },
});
export const process = internalAction({
  args: { eventId: v.id("fathomWebhookEvents") },
  returns: v.null(),
  handler: async (ctx, a) => {
    const e = await ctx.runQuery(internal.fathom.processor.event, a);
    if (
      !e ||
      e.status === "processed" ||
      e.status === "dropped" ||
      (e.holdUntil && e.holdUntil <= Date.now())
    )
      return null;
    let transcriptStorageId;
    try {
      const raw = e.payloadStorageId
        ? await (await ctx.storage.get(e.payloadStorageId))?.text()
        : e.payload;
      if (!raw) throw new Error("Fathom payload missing");
      const rawData: unknown = JSON.parse(raw);
      const data = meetingSchema.parse(rawData),
        fields = recordingFields(data);
      const userId = await ctx.runMutation(internal.fathom.processor.classify, {
        eventId: e._id,
        email: fields.recordedByEmail,
        hasExternalInvitee: fields.hasExternalInvitee,
      });
      if (!userId) return null;
      const c = await ctx.runQuery(internal.fathom.state.connection, {
        connectionId: e.connectionId,
      });
      if (!c || c.connectionStatus !== "connected") return null;
      // Reconciliation payloads deliberately omit heavy content. Fetch it through the recording endpoints.
      const already = await ctx.runQuery(internal.fathom.processor.exists, {
        tenantId: e.tenantId,
        fathomRecordingId: data.recording_id,
      });
      // Synchronous response: https://developers.fathom.ai/api-reference/recordings/get-summary
      if (!already && !data.default_summary) {
        const response = await fathomFetch(
          ctx,
          c._id,
          c.apiKey,
          `/recordings/${data.recording_id}/summary`,
        );
        // A recording Fathom didn't summarize returns { summary: null }.
        fields.summaryMarkdown =
          z
            .object({ summary: summarySchema.nullish() })
            .parse(await response.json()).summary?.markdown_formatted ??
          undefined;
      }
      let lines = data.transcript ? parseTranscript(data.transcript) : [];
      const expired = fields.recordingStartAt + 90 * 86400_000 <= Date.now();
      // Speaker and timestamp shape: https://developers.fathom.ai/api-reference/recordings/get-transcript
      if (!already && !expired && data.transcript == null) {
        const response = await fathomFetch(
          ctx,
          c._id,
          c.apiKey,
          `/recordings/${data.recording_id}/transcript`,
        );
        const result = z
          .object({ transcript: z.unknown() })
          .parse(await response.json());
        // Fathom returns [] for a silent recording; treat null the same way.
        lines = parseTranscript(result.transcript ?? []);
      }
      if (!already && !expired && lines.length)
        transcriptStorageId = await ctx.storage.store(
          new Blob([JSON.stringify(lines)], { type: "application/json" }),
        );
      const used = await ctx.runMutation(internal.fathom.processor.commit, {
        eventId: e._id,
        data: fields,
        transcriptStorageId,
        transcriptLineCount: lines.length,
      });
      if (!used && transcriptStorageId)
        await ctx.storage.delete(transcriptStorageId);
    } catch (error) {
      if (transcriptStorageId) await ctx.storage.delete(transcriptStorageId);
      // Never log a validation error: it can contain transcript or invitee text.
      reportError(
        "fathom.event.failed",
        new Error(
          error instanceof FathomRetry
            ? error.message
            : "Fathom event processing failed",
        ),
        { tenantId: e.tenantId, eventId: e._id, integration: "fathom" },
      );
      await ctx.runMutation(internal.fathom.processor.fail, {
        eventId: e._id,
        retryMs: error instanceof FathomRetry ? error.delayMs : 60_000,
        retryable: error instanceof FathomRetry,
      });
    }
    return null;
  },
});
export const exists = internalQuery({
  args: { tenantId: v.id("tenants"), fathomRecordingId: v.number() },
  returns: v.boolean(),
  handler: async (ctx, a) =>
    Boolean(
      await ctx.db
        .query("callRecordings")
        .withIndex("by_tenantId_and_fathomRecordingId", (q) =>
          q
            .eq("tenantId", a.tenantId)
            .eq("fathomRecordingId", a.fathomRecordingId),
        )
        .unique(),
    ),
});
export const retryHeld = internalMutation({
  args: { tenantId: v.id("tenants"), cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, a) => {
    const page = await ctx.db
      .query("fathomWebhookEvents")
      .withIndex("by_tenantId_and_status_and_receivedAt", (q) =>
        q.eq("tenantId", a.tenantId).eq("status", "held"),
      )
      .paginate({ cursor: a.cursor, numItems: 20, maximumBytesRead: 256_000 });
    for (const e of page.page)
      if ((e.holdUntil ?? 0) > Date.now())
        await ctx.scheduler.runAfter(0, internal.fathom.processor.process, {
          eventId: e._id,
        });
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.fathom.processor.retryHeld, {
        ...a,
        cursor: page.continueCursor,
      });
    return null;
  },
});
