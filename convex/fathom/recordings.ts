import { v } from "convex/values";
import {
  query,
  mutation,
  internalQuery,
  type QueryCtx,
  type MutationCtx,
} from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireTenantUser } from "../requireTenantUser";
import type { CrmRole } from "../lib/roleMapping";
import { rejectRequest } from "../lib/observability/errors";
import { emitDomainEvent } from "../lib/domainEvents";
import { readLiveQueryRows } from "../lib/liveQueryBounds";
import { actionItem } from "./validators";

export type RecordingActor = {
  tenantId: Id<"tenants">;
  userId: Id<"users">;
  role: CrmRole;
};
export const recordingView = v.object({
  recordingId: v.id("callRecordings"),
  meetingId: v.optional(v.id("meetings")),
  title: v.string(),
  url: v.string(),
  recordedAt: v.number(),
  minutes: v.number(),
  summary: v.optional(v.string()),
  actionItems: v.array(actionItem),
  matchMethod: v.optional(
    v.union(
      v.literal("time_email"),
      v.literal("time_url"),
      v.literal("time_only"),
      v.literal("manual"),
    ),
  ),
  transcriptPageCount: v.number(),
  transcriptDeletedAt: v.optional(v.number()),
  recordedByUserId: v.optional(v.id("users")),
});
export function toRecordingView(row: Doc<"callRecordings">) {
  return {
    recordingId: row._id,
    meetingId: row.meetingId,
    title: row.title,
    url: row.shareUrl || row.url,
    recordedAt: row.recordingStartAt,
    minutes: Math.max(0, (row.recordingEndAt - row.recordingStartAt) / 60_000),
    summary: row.summaryMarkdown,
    actionItems: row.actionItems ?? [],
    matchMethod: row.matchMethod,
    transcriptPageCount: row.transcriptStorageId
      ? Math.ceil((row.transcriptLineCount ?? 0) / 100)
      : 0,
    transcriptDeletedAt: row.transcriptDeletedAt,
    recordedByUserId: row.recordedByUserId,
  };
}
export type RecordingView = ReturnType<typeof toRecordingView>;

export async function requireRecordingMeeting(
  ctx: QueryCtx | MutationCtx,
  actor: RecordingActor,
  meetingId: Id<"meetings">,
) {
  const meeting = await ctx.db.get("meetings", meetingId);
  if (
    !meeting ||
    meeting.tenantId !== actor.tenantId ||
    actor.role === "lead_generator" ||
    (actor.role === "closer" && meeting.assignedCloserId !== actor.userId)
  ) {
    throw rejectRequest(
      "fathom.meeting_forbidden",
      "You cannot access this meeting.",
    );
  }
  return meeting;
}
/** Internal read core. Authorizes the meeting before returning any recording content. Pages contain 100 lines. */
export async function getRecordingForMeeting(
  ctx: QueryCtx | MutationCtx,
  actor: RecordingActor,
  meetingId: Id<"meetings">,
): Promise<RecordingView | null> {
  await requireRecordingMeeting(ctx, actor, meetingId);
  const row = await ctx.db
    .query("callRecordings")
    .withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId))
    .first();
  return row && row.tenantId === actor.tenantId && row.matchStatus === "matched"
    ? toRecordingView(row)
    : null;
}
/** The second opinion will hook in here. Every automatic and manual match calls this function. */
export async function onRecordingMatched(
  _ctx: MutationCtx,
  _args: { meetingId: Id<"meetings">; recordingId: Id<"callRecordings"> },
): Promise<void> {
  // The second opinion will hook in here.
}
export async function recordMatch(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    meetingId: Id<"meetings">;
    recordingId: Id<"callRecordings">;
    actorUserId?: Id<"users">;
  },
) {
  await emitDomainEvent(ctx, {
    tenantId: args.tenantId,
    entityType: "meeting",
    entityId: args.meetingId,
    eventType: "meeting.recording_matched",
    source: "system",
    actorUserId: args.actorUserId,
    metadata: { recordingId: args.recordingId },
  });
  await onRecordingMatched(ctx, args);
}
export const attachArgs = {
  recordingId: v.id("callRecordings"),
  meetingId: v.optional(v.id("meetings")),
  notASalesCall: v.optional(v.boolean()),
};
export type AttachArgs = {
  recordingId: Id<"callRecordings">;
  meetingId?: Id<"meetings">;
  notASalesCall?: boolean;
};
/** Mutation core for the web UI and MCP. A closer may only resolve their own unmatched recording. */
export async function attachRecordingCore(
  ctx: MutationCtx,
  actor: RecordingActor,
  args: AttachArgs,
): Promise<null> {
  if (Boolean(args.meetingId) === Boolean(args.notASalesCall))
    throw rejectRequest(
      "fathom.invalid_assignment",
      "Choose a meeting or Not a sales call.",
    );
  const row = await ctx.db.get("callRecordings", args.recordingId);
  const admin = actor.role === "tenant_master" || actor.role === "tenant_admin";
  if (
    !row ||
    row.tenantId !== actor.tenantId ||
    (!admin &&
      (actor.role !== "closer" ||
        row.recordedByUserId !== actor.userId ||
        row.matchStatus !== "unmatched"))
  ) {
    throw rejectRequest(
      "fathom.recording_forbidden",
      "You cannot assign this recording.",
    );
  }
  if (args.notASalesCall) {
    await ctx.db.patch("callRecordings", row._id, {
      meetingId: undefined,
      matchStatus: "ignored",
      matchMethod: "manual",
      matchedByUserId: actor.userId,
      matchedAt: Date.now(),
    });
    return null;
  }
  const meetingId = args.meetingId!;
  await requireRecordingMeeting(ctx, actor, meetingId);
  const existing = await ctx.db
    .query("callRecordings")
    .withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId))
    .first();
  if (existing && existing._id !== row._id)
    throw rejectRequest(
      "fathom.meeting_has_recording",
      "This meeting already has a recording. Reassign it first.",
    );
  if (row.meetingId === meetingId && row.matchStatus === "matched") return null;
  await ctx.db.patch("callRecordings", row._id, {
    meetingId,
    matchStatus: "matched",
    matchMethod: "manual",
    matchedAt: Date.now(),
    matchedByUserId: actor.userId,
  });
  await recordMatch(ctx, {
    tenantId: actor.tenantId,
    meetingId,
    recordingId: row._id,
    actorUserId: actor.userId,
  });
  return null;
}
export async function listUnmatchedRecordings(
  ctx: QueryCtx | MutationCtx,
  actor: RecordingActor,
): Promise<{ recordings: RecordingView[]; capped: boolean }> {
  if (actor.role === "lead_generator")
    throw rejectRequest(
      "fathom.recording_forbidden",
      "You cannot access recordings.",
    );
  const result = await readLiveQueryRows(
    ctx.db
      .query("callRecordings")
      .withIndex("by_tenantId_and_recordedByUserId_and_matchStatus", (q) =>
        q
          .eq("tenantId", actor.tenantId)
          .eq("recordedByUserId", actor.userId)
          .eq("matchStatus", "unmatched"),
      ),
    50,
  );
  return {
    recordings: result.rows.map(toRecordingView),
    capped: result.capped,
  };
}
export const forMeeting = query({
  args: { meetingId: v.id("meetings") },
  returns: v.union(v.null(), recordingView),
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);
    return getRecordingForMeeting(ctx, actor, args.meetingId);
  },
});
export const unmatched = query({
  args: {},
  returns: v.object({
    recordings: v.array(recordingView),
    capped: v.boolean(),
  }),
  handler: async (ctx) => {
    const actor = await requireTenantUser(ctx, [
      "closer",
      "tenant_admin",
      "tenant_master",
    ]);
    return listUnmatchedRecordings(ctx, actor);
  },
});
export const attach = mutation({
  args: attachArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [
      "closer",
      "tenant_admin",
      "tenant_master",
    ]);
    return attachRecordingCore(ctx, actor, args);
  },
});
export const assignmentMeetings = query({
  args: { recordedAt: v.number(), userId: v.optional(v.id("users")) },
  returns: v.object({
    meetings: v.array(
      v.object({
        meetingId: v.id("meetings"),
        label: v.string(),
        scheduledAt: v.number(),
      }),
    ),
    capped: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [
      "closer",
      "tenant_admin",
      "tenant_master",
    ]);
    const since = args.recordedAt - 30 * 86400_000;
    const until = args.recordedAt + 30 * 86400_000;
    const userId = actor.role === "closer" ? actor.userId : args.userId;
    const meetingsQuery = userId
      ? ctx.db
          .query("meetings")
          .withIndex("by_tenantId_and_assignedCloserId_and_scheduledAt", (q) =>
            q
              .eq("tenantId", actor.tenantId)
              .eq("assignedCloserId", userId)
              .gte("scheduledAt", since)
              .lte("scheduledAt", until),
          )
      : ctx.db
          .query("meetings")
          .withIndex("by_tenantId_and_scheduledAt", (q) =>
            q
              .eq("tenantId", actor.tenantId)
              .gte("scheduledAt", since)
              .lte("scheduledAt", until),
          );
    const result = await readLiveQueryRows(meetingsQuery.order("desc"), 200);
    return {
      meetings: result.rows
        .filter(
          (m) => actor.role !== "closer" || m.assignedCloserId === actor.userId,
        )
        .filter((m) => !args.userId || m.assignedCloserId === args.userId)
        .map((m) => ({
          meetingId: m._id,
          label: m.leadName ?? "Sales call",
          scheduledAt: m.scheduledAt,
        })),
      capped: result.capped,
    };
  },
});
export const transcriptAccess = internalQuery({
  args: { recordingId: v.id("callRecordings") },
  returns: v.union(
    v.null(),
    v.object({
      storageId: v.optional(v.id("_storage")),
      expiresAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("callRecordings", args.recordingId);
    return row
      ? {
          storageId: row.transcriptStorageId,
          expiresAt: row.recordingStartAt + 90 * 86400_000,
        }
      : null;
  },
});
