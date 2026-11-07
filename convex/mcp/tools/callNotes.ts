import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";
import { emitDomainEvent } from "../../lib/domainEvents";
import { rejectRequest } from "../../lib/observability/errors";
import { sha256Hex, stableJson } from "../confirm";
import { mcpCallerValidator, requireMcpUser } from "../guard";
import { financingProviderValidator } from "../schema";
import { formatLocal } from "../time";

export const callNoteArgs = {
  opportunityId: v.optional(v.id("opportunities")),
  meetingId: v.optional(v.id("meetings")),
  taskId: v.optional(v.id("followUps")),
  currentSituation: v.string(),
  goal: v.string(),
  bottleneck: v.string(),
  objection: v.string(),
  nextAction: v.optional(v.string()),
  financingProvider: v.optional(financingProviderValidator),
  recordingId: v.optional(v.id("callRecordings")),
};

function noteText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1000) {
    throw rejectRequest(
      "call_note.invalid_text",
      `${field} must have between 1 and 1,000 characters.`,
    );
  }
  return trimmed;
}

export const run = internalMutation({
  args: { caller: mcpCallerValidator, ...callNoteArgs },
  returns: v.object({
    callNoteId: v.id("callNotes"),
    savedAt: v.string(),
    timeZone: v.string(),
    alreadySaved: v.boolean(),
  }),
  handler: async (ctx, { caller, ...args }) => {
    const me = await requireMcpUser(ctx, caller, ["closer"]);
    const [meeting, task] = await Promise.all([
      args.meetingId ? ctx.db.get("meetings", args.meetingId) : null,
      args.taskId ? ctx.db.get("followUps", args.taskId) : null,
    ]);
    const refuse = () =>
      rejectRequest("call_note.not_yours", "That isn't one of your deals.");
    if (
      args.meetingId &&
      (!meeting ||
        meeting.tenantId !== me.tenantId ||
        meeting.assignedCloserId !== me.userId)
    )
      throw refuse();
    if (
      args.taskId &&
      (!task || task.tenantId !== me.tenantId || task.closerId !== me.userId)
    )
      throw refuse();
    const opportunityId =
      args.opportunityId ?? meeting?.opportunityId ?? task?.opportunityId;
    if (!opportunityId)
      throw rejectRequest(
        "call_note.deal_required",
        "Pass a meeting, task or deal ID for this note.",
      );
    const deal = await ctx.db.get("opportunities", opportunityId);
    if (
      !deal ||
      deal.tenantId !== me.tenantId ||
      deal.assignedCloserId !== me.userId
    )
      throw refuse();
    if (
      (meeting && meeting.opportunityId !== opportunityId) ||
      (task && task.opportunityId !== opportunityId)
    ) {
      throw rejectRequest(
        "call_note.deal_mismatch",
        "The meeting and task must belong to this deal.",
      );
    }
    if (args.recordingId) {
      const recording = await ctx.db.get("callRecordings", args.recordingId);
      const recordedMeeting = recording?.meetingId
        ? await ctx.db.get("meetings", recording.meetingId)
        : null;
      if (
        !recording ||
        recording.tenantId !== me.tenantId ||
        recording.recordedByUserId !== me.userId ||
        !recordedMeeting ||
        recordedMeeting.tenantId !== me.tenantId ||
        recordedMeeting.opportunityId !== opportunityId ||
        (meeting && recordedMeeting._id !== meeting._id)
      ) {
        throw rejectRequest(
          "call_note.recording_mismatch",
          "That recording isn't attached to this deal's call.",
        );
      }
    }
    const fields = {
      currentSituation: noteText(args.currentSituation, "Current situation"),
      goal: noteText(args.goal, "Goal"),
      bottleneck: noteText(args.bottleneck, "Bottleneck"),
      objection: noteText(args.objection, "Objection"),
      nextAction:
        args.nextAction === undefined
          ? undefined
          : noteText(args.nextAction, "Next action"),
      financingProvider: args.financingProvider,
    };
    // Context IDs and client names are not content: a retry may resolve the
    // same deal by its meeting instead of its ID, or reconnect another client.
    const contentHash = await sha256Hex(stableJson(fields));
    const now = Date.now();
    const recent = await ctx.db
      .query("callNotes")
      .withIndex("by_tenantId_and_opportunityId_and_createdAt", (q) =>
        q
          .eq("tenantId", me.tenantId)
          .eq("opportunityId", opportunityId)
          .gte("createdAt", now - 120_000),
      )
      .order("asc")
      .take(121);
    // More than a user's rate limit across two minutes means the bounded
    // retry check cannot be trusted. Refuse instead of silently duplicating.
    if (recent.length === 121)
      throw rejectRequest(
        "call_note.too_many",
        "Too many notes on this deal. Try again shortly.",
      );
    const existing = recent.find(
      (note) =>
        note.authorUserId === me.userId && note.contentHash === contentHash,
    );
    if (existing)
      return {
        callNoteId: existing._id,
        savedAt: formatLocal(existing.createdAt, me.timeZone),
        timeZone: me.timeZone,
        alreadySaved: true,
      };
    const callNoteId = await ctx.db.insert("callNotes", {
      tenantId: me.tenantId,
      opportunityId,
      authorUserId: me.userId,
      meetingId: args.meetingId,
      followUpId: args.taskId,
      recordingId: args.recordingId,
      ...fields,
      agentClient: me.agentClient,
      contentHash,
      createdAt: now,
    });
    await emitDomainEvent(ctx, {
      tenantId: me.tenantId,
      entityType: "opportunity",
      entityId: opportunityId,
      eventType: "opportunity.call_note_added",
      source: "closer",
      actorUserId: me.userId,
      metadata: {
        callNoteId,
        meetingId: args.meetingId,
        via: "mcp",
        agentClient: me.agentClient,
      },
      occurredAt: now,
    });
    return {
      callNoteId,
      savedAt: formatLocal(now, me.timeZone),
      timeZone: me.timeZone,
      alreadySaved: false,
    };
  },
});
