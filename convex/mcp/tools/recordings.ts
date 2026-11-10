import { v } from "convex/values";
import { internal } from "../../_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../../_generated/server";
import {
  attachRecordingCore,
  getRecordingForMeeting,
  recordingView,
  requireRecordingMeeting,
  toRecordingView,
  type RecordingView,
} from "../../fathom/recordings";
import { readTranscriptPage } from "../../fathom/transcript";
import { rejectRequest } from "../../lib/observability/errors";
import { mcpCallerValidator, requireMcpUser, requireMcpAdmin, loadInTenant, normalizeMcpId } from "../guard";
import { formatLocal } from "../time";

/**
 * `magnus_get_recording` and `magnus_attach_recording`
 * (docs/plans/closer-assistant.md §6.2, §6.5). A recording's summary and
 * transcript came from the call, so they go out marked personSupplied, and
 * a recording never records attendance (§5.4).
 */
const TRANSCRIPT_PAGE_LINES = 100;

export const authorizeRecording = internalQuery({
  args: {
    caller: mcpCallerValidator,
    meetingId: v.optional(v.string()),
    recordingId: v.optional(v.string()),
  },
  returns: v.object({ recording: v.union(recordingView, v.null()), timeZone: v.string(), savedFathomLink: v.union(v.string(), v.null()) }),
  handler: async (ctx, { caller, meetingId: rawMeetingId, recordingId: rawRecordingId }) => {
    const identity = await requireMcpUser(ctx, caller, ["closer", "tenant_master", "tenant_admin"]);
    const me = identity.role === "closer" ? identity : await requireMcpAdmin(ctx, caller);
    const meetingId = rawMeetingId === undefined ? undefined : normalizeMcpId(ctx, "meetings", rawMeetingId, "meetingId");
    const recordingId = rawRecordingId === undefined ? undefined : normalizeMcpId(ctx, "callRecordings", rawRecordingId, "recordingId");
    if (me.role !== "closer") {
      if (meetingId) await loadInTenant(ctx, me, "meetings", meetingId);
      if (recordingId) await loadInTenant(ctx, me, "callRecordings", recordingId);
    }
    if (Boolean(meetingId) === Boolean(recordingId)) {
      throw rejectRequest("recording.target_required", "Pass a meetingId or a recordingId.");
    }
    if (meetingId) {
      const meeting = await requireRecordingMeeting(ctx, me, meetingId);
      return { recording: await getRecordingForMeeting(ctx, me, meetingId), timeZone: me.timeZone, savedFathomLink: meeting.fathomLink ?? null };
    }
    const row = await ctx.db.get("callRecordings", recordingId!);
    if (!row || row.tenantId !== me.tenantId) {
      throw rejectRequest("recording.not_found", "That recording isn't one of yours.");
    }
    // A closer reads their own recordings, matched to their meetings or not.
    if (row.meetingId) await requireRecordingMeeting(ctx, me, row.meetingId);
    else if (me.role === "closer" && row.recordedByUserId !== me.userId) {
      throw rejectRequest("recording.not_found", "That recording isn't one of yours.");
    }
    return { recording: toRecordingView(row), timeZone: me.timeZone, savedFathomLink: null };
  },
});

export const getRecording = internalAction({
  args: {
    caller: mcpCallerValidator,
    meetingId: v.optional(v.string()),
    recordingId: v.optional(v.string()),
    page: v.optional(v.number()),
  },
  returns: v.union(v.object({
    status: v.literal("no_matched_recording"),
    meetingId: v.string(),
    fathomUrl: v.string(),
    message: v.string(),
  }), v.object({
    recordingId: v.id("callRecordings"),
    meetingId: v.union(v.id("meetings"), v.null()),
    title: v.string(),
    recordedAt: v.string(),
    minutes: v.number(),
    summary: v.optional(v.object({ text: v.union(v.string(), v.null()), personSupplied: v.literal(true) })),
    actionItems: v.optional(v.array(v.string())),
    transcript: v.object({
      page: v.number(),
      pageCount: v.number(),
      personSupplied: v.literal(true),
      lines: v.array(v.object({ at: v.string(), speaker: v.string(), text: v.string() })),
      deleted: v.boolean(),
    }),
    fathomUrl: v.string(),
  })),
  handler: async (ctx, { caller, meetingId, recordingId, page }) => {
    // Annotated: a same-file runQuery would otherwise make the generated API
    // type circular.
    const authorized: { recording: RecordingView | null; timeZone: string; savedFathomLink: string | null } = await ctx.runQuery(
      internal.mcp.tools.recordings.authorizeRecording,
      {
      caller,
      ...(meetingId ? { meetingId } : {}),
      ...(recordingId ? { recordingId } : {}),
      },
    );
    const { recording, timeZone } = authorized;
    if (!recording) {
      if (page !== undefined && (!Number.isSafeInteger(page) || page !== 1)) throw rejectRequest("fathom.invalid_page", "No matched transcript is available. Request page 1 for the saved recording link.");
      if (authorized.savedFathomLink) return {
        status: "no_matched_recording" as const, meetingId: meetingId!, fathomUrl: authorized.savedFathomLink,
        message: "No matched Fathom recording is available. This is the recording link saved on the meeting; its summary and transcript are not available in Magnus.",
      };
      throw rejectRequest(
        "recording.none",
        "This meeting has no matched Fathom recording. Admins can check magnus_queue unmatched_recordings; closers can check magnus_today recordingsWithoutMeeting.",
      );
    }
    const pageNumber = page ?? 1;
    const transcript = await readTranscriptPage(ctx, recording.recordingId, pageNumber, TRANSCRIPT_PAGE_LINES);
    if (pageNumber > Math.max(1, transcript.pageCount)) throw rejectRequest("fathom.invalid_page", `This transcript has ${transcript.pageCount} pages. Request page 1 for recording details or an existing transcript page.`);
    return {
      recordingId: recording.recordingId,
      meetingId: recording.meetingId ?? null,
      title: recording.title,
      recordedAt: formatLocal(recording.recordedAt, timeZone),
      minutes: Math.round(recording.minutes),
      ...(pageNumber === 1 ? {
        summary: { text: recording.summary ?? null, personSupplied: true as const },
        actionItems: recording.actionItems.map((item) => item.description),
      } : {}),
      transcript: {
        page: pageNumber,
        pageCount: transcript.pageCount,
        personSupplied: true as const,
        lines: transcript.lines.map((line) => ({ at: line.timestamp, speaker: line.speaker, text: line.text })),
        deleted: recording.transcriptDeletedAt !== undefined,
      },
      fathomUrl: recording.url,
    };
  },
});

export const attachRecording = internalMutation({
  args: {
    caller: mcpCallerValidator,
    recordingId: v.id("callRecordings"),
    meetingId: v.optional(v.id("meetings")),
    notASalesCall: v.optional(v.boolean()),
  },
  returns: v.object({
    ok: v.literal(true),
    recordingId: v.id("callRecordings"),
    meeting: v.union(v.string(), v.null()),
    matchMethod: v.literal("manual"),
    message: v.string(),
  }),
  handler: async (ctx, { caller, recordingId, meetingId, notASalesCall }) => {
    const me = await requireMcpUser(ctx, caller, ["closer"]);
    await attachRecordingCore(ctx, me, {
      recordingId,
      ...(meetingId ? { meetingId } : {}),
      ...(notASalesCall ? { notASalesCall } : {}),
    });
    if (!meetingId) {
      return {
        ok: true as const,
        recordingId,
        meeting: null,
        matchMethod: "manual" as const,
        message: "Marked as not a sales call. It no longer waits on Today.",
      };
    }
    const meeting = await ctx.db.get("meetings", meetingId);
    const label = meeting
      ? `${meeting.leadName ?? "Unknown"} · ${formatLocal(meeting.scheduledAt, me.timeZone)}`
      : null;
    return {
      ok: true as const,
      recordingId,
      meeting: label,
      matchMethod: "manual" as const,
      message: `Attached to ${label ?? "the meeting"}. The recording shows on the meeting page now.`,
    };
  },
});
