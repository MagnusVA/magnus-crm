import { v } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../../_generated/server";
import { checkCallbackTaskAllowed, createCallbackTask } from "../../closer/followUpMutations";
import { checkMeetingLossAllowed, recordMeetingLoss } from "../../closer/meetingActions";
import { checkNoShowAllowed, noShowReasonValidator, recordNoShow } from "../../closer/noShowActions";
import { checkTaskLossAllowed, recordTaskLoss } from "../../closer/reminderOutcomes";
import { isExpectedError, rejectRequest } from "../../lib/observability/errors";
import { issueConfirmation, markConfirmationUsed, redeemConfirmation } from "../confirm";
import { mcpCallerValidator, requireMcpUser, type McpUser } from "../guard";
import { formatLocal, parseLocalDateTime } from "../time";

/**
 * The agent's outcome writes (docs/plans/closer-assistant.md §6.2, §6.3):
 * a call-back, a no-show and a loss, each on the same core the web uses.
 * No-shows and losses last, so they preview first and commit with a token
 * (decision 17).
 */

/**
 * The cores refuse with plain `Error`s, as the web always did; the gateway
 * would send those as "Tool execution failed". Rethrow them as `ConvexError`
 * so the agent reads the same sentence a closer sees (§6.8).
 */
export async function withAgentErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isExpectedError(error)) throw error;
    if (error instanceof Error && error.name === "Error") {
      throw rejectRequest("outcome.refused", error.message);
    }
    throw error;
  }
}

function refuse(result: { ok: false; code: string; message: string }): never {
  throw rejectRequest(result.code, result.message);
}

export async function loadOwnMeeting(ctx: MutationCtx, me: McpUser, meetingId: Id<"meetings">) {
  const meeting = await ctx.db.get("meetings", meetingId);
  if (!meeting || meeting.tenantId !== me.tenantId || meeting.assignedCloserId !== me.userId) {
    throw rejectRequest("meeting.not_yours", "That isn't one of your meetings.");
  }
  return meeting;
}

export async function loadOwnTask(ctx: MutationCtx, me: McpUser, taskId: Id<"followUps">) {
  const task = await ctx.db.get("followUps", taskId);
  if (!task || task.tenantId !== me.tenantId || task.closerId !== me.userId) {
    throw rejectRequest("task.not_yours", "That isn't one of your tasks.");
  }
  return task;
}

function personOf(meeting: Doc<"meetings">) {
  return meeting.leadName ?? "this person";
}

// ── magnus_set_callback ─────────────────────────────────────────────

export const setCallback = internalMutation({
  args: {
    caller: mcpCallerValidator,
    meetingId: v.optional(v.id("meetings")),
    opportunityId: v.optional(v.id("opportunities")),
    method: v.union(v.literal("call"), v.literal("text")),
    date: v.string(),
    time: v.string(),
    note: v.optional(v.string()),
  },
  returns: v.object({
    taskId: v.id("followUps"),
    due: v.string(),
    meeting: v.union(v.literal("held"), v.null()),
    deal: v.string(),
    alreadyExisted: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const me = await requireMcpUser(ctx, args.caller, ["closer"]);
    let opportunityId = args.opportunityId;
    if (args.meetingId) {
      const meeting = await loadOwnMeeting(ctx, me, args.meetingId);
      if (opportunityId && opportunityId !== meeting.opportunityId) {
        throw rejectRequest("callback.mismatch", "That meeting belongs to another deal.");
      }
      opportunityId = meeting.opportunityId;
    }
    if (!opportunityId) {
      throw rejectRequest("callback.target_required", "Pass the meetingId the call-back follows, or the deal's opportunityId.");
    }
    const reminderScheduledAt = parseLocalDateTime(args.date, args.time, me.timeZone);
    const due = formatLocal(reminderScheduledAt, me.timeZone);

    // A retry with the same deal, time and method returns the pending one (§6.8).
    const pending = await ctx.db
      .query("followUps")
      .withIndex("by_opportunityId_and_status_and_reason", (q) =>
        q.eq("opportunityId", opportunityId).eq("status", "pending"),
      )
      .take(20);
    const same = pending.find(
      (task) =>
        task.closerId === me.userId &&
        task.type === "manual_reminder" &&
        task.reminderScheduledAt === reminderScheduledAt &&
        (task.contactMethod ?? "call") === args.method,
    );
    if (same) {
      return { taskId: same._id, due, meeting: null, deal: "Follow-up", alreadyExisted: true };
    }

    const coreArgs = {
      opportunityId,
      ...(args.meetingId ? { meetingId: args.meetingId } : {}),
      contactMethod: args.method,
      reminderScheduledAt,
      ...(args.note?.trim() ? { reminderNote: args.note.trim().slice(0, 500) } : {}),
    };
    const check = await checkCallbackTaskAllowed(ctx, me, coreArgs);
    if (!check.ok) refuse(check);
    const { followUpId } = await withAgentErrors(() =>
      createCallbackTask(ctx, me, coreArgs, { via: "mcp", agentClient: me.agentClient }),
    );
    return {
      taskId: followUpId,
      due,
      meeting: args.meetingId ? ("held" as const) : null,
      deal: "Follow-up",
      alreadyExisted: false,
    };
  },
});

// ── magnus_mark_no_show ─────────────────────────────────────────────

const confirmArgs = {
  confirm: v.boolean(),
  confirmToken: v.optional(v.string()),
};

type OutcomeResult = {
  ok: true;
  message: string;
  meeting?: string;
  deal: string;
  alreadyDone: boolean;
};

const previewOrResult = v.union(
  v.object({
    preview: v.string(),
    confirmToken: v.string(),
    expiresInSeconds: v.number(),
  }),
  v.object({
    ok: v.literal(true),
    message: v.string(),
    meeting: v.optional(v.string()),
    deal: v.string(),
    alreadyDone: v.boolean(),
  }),
);

export const markNoShow = internalMutation({
  args: {
    caller: mcpCallerValidator,
    meetingId: v.id("meetings"),
    reason: noShowReasonValidator,
    note: v.optional(v.string()),
    ...confirmArgs,
  },
  returns: previewOrResult,
  handler: async (ctx, { caller, meetingId, reason, note, confirm, confirmToken }) => {
    const me = await requireMcpUser(ctx, caller, ["closer"]);
    const meeting = await loadOwnMeeting(ctx, me, meetingId);
    const coreArgs = { meetingId, reason, ...(note?.trim() ? { note: note.trim().slice(0, 500) } : {}) };
    const when = formatLocal(meeting.scheduledAt, me.timeZone);

    if (!confirm) {
      const check = await checkNoShowAllowed(ctx, me, coreArgs);
      if (!check.ok) refuse(check);
      return await issueConfirmation(
        ctx,
        me,
        "magnus_mark_no_show",
        coreArgs,
        `Mark ${personOf(meeting)}'s call on ${when} a no-show. This closes the deal as lost with the reason no-show. A reschedule link from the meeting page can still reopen it.`,
      );
    }

    const redeemed = await redeemConfirmation(ctx, me, "magnus_mark_no_show", confirmToken, coreArgs);
    if (redeemed.kind === "replay") return { ...(redeemed.result as OutcomeResult), alreadyDone: true };
    await withAgentErrors(() => recordNoShow(ctx, me, coreArgs, { via: "mcp", agentClient: me.agentClient }));
    const result = {
      ok: true as const,
      message: `Marked ${personOf(meeting)}'s ${when} call a no-show. If they write back, send a reschedule link from the meeting page and the deal reopens at Follow-up.`,
      meeting: "no_show",
      deal: "Closed · lost · no-show",
      alreadyDone: false,
    };
    await markConfirmationUsed(ctx, redeemed.confirmationId, result);
    return result;
  },
});

// ── magnus_mark_lost ────────────────────────────────────────────────

/** Decision 22: a short list that matches how admins read losses, plus text. */
export const LOSS_CATEGORIES = {
  not_a_fit: "Not a fit",
  price: "Price",
  timing: "Timing",
  went_quiet: "Went quiet",
  other: "Other",
} as const;

const lossCategoryValidator = v.union(
  v.literal("not_a_fit"),
  v.literal("price"),
  v.literal("timing"),
  v.literal("went_quiet"),
  v.literal("other"),
);

export const markLost = internalMutation({
  args: {
    caller: mcpCallerValidator,
    meetingId: v.optional(v.id("meetings")),
    taskId: v.optional(v.id("followUps")),
    category: v.optional(lossCategoryValidator),
    reason: v.optional(v.string()),
    ...confirmArgs,
  },
  returns: previewOrResult,
  handler: async (ctx, args) => {
    const me = await requireMcpUser(ctx, args.caller, ["closer"]);
    if (Boolean(args.meetingId) === Boolean(args.taskId)) {
      throw rejectRequest("loss.target_required", "Pass the meetingId of the call, or the taskId of the call-back.");
    }
    const detail = args.reason?.trim() ?? "";
    // Unlike the web, a loss from an agent needs a reason of a few words.
    if (detail.split(/\s+/).filter(Boolean).length < 2) {
      throw rejectRequest("loss.reason_required", "A loss needs a reason. Ask why the deal was lost.");
    }
    const category = args.category ?? "other";
    const lostReason = `${LOSS_CATEGORIES[category]}: ${detail}`.slice(0, 500);
    const hashed = { meetingId: args.meetingId, taskId: args.taskId, lostReason };

    if (args.meetingId) {
      const meeting = await loadOwnMeeting(ctx, me, args.meetingId);
      const coreArgs = { opportunityId: meeting.opportunityId, meetingId: meeting._id, reason: lostReason };
      const when = formatLocal(meeting.scheduledAt, me.timeZone);
      if (!args.confirm) {
        const check = await checkMeetingLossAllowed(ctx, me, coreArgs);
        if (!check.ok) refuse(check);
        return await issueConfirmation(
          ctx,
          me,
          "magnus_mark_lost",
          hashed,
          `Mark ${personOf(meeting)}'s deal lost: "${lostReason}". The ${when} call counts as held. This can't be undone.`,
        );
      }
      const redeemed = await redeemConfirmation(ctx, me, "magnus_mark_lost", args.confirmToken, hashed);
      if (redeemed.kind === "replay") return { ...(redeemed.result as OutcomeResult), alreadyDone: true };
      await withAgentErrors(() => recordMeetingLoss(ctx, me, coreArgs, { via: "mcp", agentClient: me.agentClient }));
      const result = {
        ok: true as const,
        message: `Done. ${personOf(meeting)}'s deal is lost, with the reason "${lostReason}". The ${when} call counts as held.`,
        meeting: "held",
        deal: "Closed · lost",
        alreadyDone: false,
      };
      await markConfirmationUsed(ctx, redeemed.confirmationId, result);
      return result;
    }

    const task = await loadOwnTask(ctx, me, args.taskId!);
    const coreArgs = { followUpId: task._id, reason: lostReason };
    if (!args.confirm) {
      const check = await checkTaskLossAllowed(ctx, me, coreArgs);
      if (!check.ok) refuse(check);
      const lead = await ctx.db.get("leads", task.leadId);
      return await issueConfirmation(
        ctx,
        me,
        "magnus_mark_lost",
        hashed,
        `Mark ${lead?.fullName ?? "this person"}'s deal lost from their call-back: "${lostReason}". The call-back is completed. This can't be undone.`,
      );
    }
    const redeemed = await redeemConfirmation(ctx, me, "magnus_mark_lost", args.confirmToken, hashed);
    if (redeemed.kind === "replay") return { ...(redeemed.result as OutcomeResult), alreadyDone: true };
    await withAgentErrors(() => recordTaskLoss(ctx, me, coreArgs, { via: "mcp", agentClient: me.agentClient }));
    const result = {
      ok: true as const,
      message: `Done. The deal is lost, with the reason "${lostReason}", and the call-back is completed.`,
      deal: "Closed · lost",
      alreadyDone: false,
    };
    await markConfirmationUsed(ctx, redeemed.confirmationId, result);
    return result;
  },
});
