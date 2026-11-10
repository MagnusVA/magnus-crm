import { v } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "../../../_generated/server";
import {
  adminCancelPendingFollowUpCore,
  adminCreateFollowUpCore,
  adminCreateManualReminderCore,
  adminCreateRescheduleLinkCore,
  checkAdminCancelPendingFollowUpAllowed,
  checkAdminManualReminderAllowed,
  checkAdminRescheduleLinkAllowed,
} from "../../../admin/meetingActions";
import { adminCancelTaskCore, checkAdminCancelTaskAllowed } from "../../../admin/dealActions";
import { resolveFollowUpStart } from "../../../lib/followUpStart";
import { rejectRequest } from "../../../lib/observability/errors";
import { toCheckResult, type CheckResult } from "../../../lib/outcomeCores";
import { mcpCallerValidator, requireMcpAdmin, loadInTenant } from "../../guard";
import { formatLocal } from "../../time";
import { appLink, prepareSingle, type AdminActor, type Committer, type Pins } from "../prepare";
import { actorOf, asAgentError, closerZone, dealPins, meetingPins, parseLocal, startedCheck } from "./common";

/**
 * `magnus_next_step` (docs/plans/admin-assistant.md §2, tool 9): what happens
 * next on a deal. Marking a call held is its own arm, `held_with_callback`, so
 * a stage never moves by accident. Times are read in the closer's zone.
 */

type Action =
  | { kind: "callback"; method: "call" | "text"; at: number; note?: string }
  | { kind: "held_with_callback"; meetingId: Id<"meetings">; method: "call" | "text"; at: number; note?: string }
  | { kind: "scheduling_link" }
  | { kind: "reschedule_link"; meetingId: Id<"meetings"> }
  | { kind: "cancel_task"; followUpId: Id<"followUps"> };

type NextStepArgs = { opportunityId: Id<"opportunities">; action: Action };

async function pins(ctx: QueryCtx | MutationCtx, actor: AdminActor, args: NextStepArgs): Promise<Pins> {
  const deal = await ctx.db.get("opportunities", args.opportunityId);
  if (!deal || deal.tenantId !== actor.tenantId) return { deal: "missing" };
  const out: Pins = { ...dealPins(deal) };
  const a = args.action;
  if (a.kind === "held_with_callback" || a.kind === "reschedule_link") {
    Object.assign(out, meetingPins(await ctx.db.get("meetings", a.meetingId)));
  }
  if (a.kind === "cancel_task") {
    const task = await ctx.db.get("followUps", a.followUpId);
    out["task.status"] = task?.status ?? "missing";
    out["task.opportunityId"] = task?.opportunityId ?? null;
  }
  return out;
}

async function check(ctx: QueryCtx | MutationCtx, actor: AdminActor, args: NextStepArgs): Promise<CheckResult<object>> {
  const a = args.action;
  switch (a.kind) {
    case "callback":
    case "held_with_callback": {
      if (a.at <= Date.now()) return { ok: false, code: "next_step.past", message: "Choose a time in the future." };
      if (a.kind === "held_with_callback") {
        const meeting = await ctx.db.get("meetings", a.meetingId);
        if (!meeting || meeting.tenantId !== actor.tenantId) return { ok: false, code: "mcp.not_found", message: "Magnus can't find that meeting." };
        const { timeZone } = await closerZone(ctx, actor.tenantId, meeting.assignedCloserId);
        const started = startedCheck(meeting, timeZone);
        if (!started.ok) return started;
      }
      return (await checkAdminManualReminderAllowed(ctx, actor, {
        opportunityId: args.opportunityId,
        ...(a.kind === "held_with_callback" ? { meetingId: a.meetingId } : {}),
        contactMethod: a.method,
        reminderScheduledAt: a.at,
        ...(a.note ? { reminderNote: a.note } : {}),
      })) as CheckResult<object>;
    }
    case "scheduling_link":
      // The read-only refusals of `adminCreateFollowUpCore`, in its order.
      return await toCheckResult(async () => {
        const deal = await ctx.db.get("opportunities", args.opportunityId);
        if (!deal || deal.tenantId !== actor.tenantId) throw new Error("Opportunity not found");
        await resolveFollowUpStart(ctx, deal, null, "Cannot create follow-up");
        const closer = deal.assignedCloserId ? await ctx.db.get("users", deal.assignedCloserId) : null;
        if (!deal.assignedCloserId) throw new Error("No closer assigned to this opportunity");
        if (!closer?.personalEventTypeUri) throw new Error("Assigned closer has no personal event type URI configured");
        return {};
      });
    case "reschedule_link":
      return (await checkAdminRescheduleLinkAllowed(ctx, actor, { opportunityId: args.opportunityId, meetingId: a.meetingId })) as CheckResult<object>;
    case "cancel_task": {
      const task = await ctx.db.get("followUps", a.followUpId);
      if (!task || task.tenantId !== actor.tenantId || task.opportunityId !== args.opportunityId)
        return { ok: false, code: "mcp.not_found", message: "Magnus can't find that task on this deal." };
      return (await checkAdminCancelTaskAllowed(ctx, actor, { followUpId: a.followUpId })) as CheckResult<object>;
    }
  }
}

export const nextStepCommitter: Committer<NextStepArgs> = {
  tool: "magnus_next_step",
  family: "results",
  kind: "single",
  permission: "pipeline:view-all",
  pins,
  check,
  apply: async (ctx, actor, args, provenance) => {
    const a = args.action;
    switch (a.kind) {
      case "callback":
      case "held_with_callback": {
        const out = await asAgentError(() =>
          adminCreateManualReminderCore(
            ctx,
            actor,
            {
              opportunityId: args.opportunityId,
              ...(a.kind === "held_with_callback" ? { meetingId: a.meetingId } : {}),
              contactMethod: a.method,
              reminderScheduledAt: a.at,
              ...(a.note ? { reminderNote: a.note } : {}),
            },
            provenance,
          ),
        );
        return { taskId: out.followUpId, deal: "Follow-up", meeting: a.kind === "held_with_callback" ? "held" : null };
      }
      case "scheduling_link": {
        const out = await asAgentError(() => adminCreateFollowUpCore(ctx as MutationCtx, actor, { opportunityId: args.opportunityId }, provenance));
        return { taskId: out.followUpId, schedulingLinkUrl: out.schedulingLinkUrl, deal: "Follow-up" };
      }
      case "reschedule_link": {
        const out = await asAgentError(() =>
          adminCreateRescheduleLinkCore(ctx, actor, { opportunityId: args.opportunityId, meetingId: a.meetingId }, provenance),
        );
        return { taskId: out.followUpId, schedulingLinkUrl: out.schedulingLinkUrl, deal: "Follow-up" };
      }
      case "cancel_task": {
        const task = await ctx.db.get("followUps", a.followUpId);
        // A task still waiting on its call's result is expired through the
        // follow-up path; any other open task through the deal's.
        if (task?.type === "scheduling_link" || task?.status === "pending") {
          const allowed = await checkAdminCancelPendingFollowUpAllowed(ctx, actor, { followUpId: a.followUpId });
          if (allowed.ok) {
            await asAgentError(() => adminCancelPendingFollowUpCore(ctx, actor, { followUpId: a.followUpId }, provenance));
            return { taskId: a.followUpId, task: "expired" };
          }
        }
        await asAgentError(() => adminCancelTaskCore(ctx, actor, { followUpId: a.followUpId }, provenance));
        return { taskId: a.followUpId, task: "expired" };
      }
    }
  },
};

const actionArg = v.union(
  v.object({ kind: v.literal("callback"), method: v.union(v.literal("call"), v.literal("text")), date: v.string(), time: v.string(), note: v.optional(v.string()) }),
  v.object({
    kind: v.literal("held_with_callback"),
    meetingId: v.id("meetings"),
    method: v.union(v.literal("call"), v.literal("text")),
    date: v.string(),
    time: v.string(),
    note: v.optional(v.string()),
  }),
  v.object({ kind: v.literal("scheduling_link") }),
  v.object({ kind: v.literal("reschedule_link"), meetingId: v.id("meetings") }),
  v.object({ kind: v.literal("cancel_task"), followUpId: v.id("followUps") }),
);

export const nextStepArgs = { caller: mcpCallerValidator, opportunityId: v.id("opportunities"), action: actionArg };

export const prepareNextStep = internalMutation({
  args: nextStepArgs,
  returns: v.any(),
  handler: async (ctx, { caller, opportunityId, action }) => {
    const me = await requireMcpAdmin(ctx, caller, { family: "results", permission: "pipeline:view-all" });
    const deal = await loadInTenant(ctx, me, "opportunities", opportunityId, "that deal");
    const lead = await ctx.db.get("leads", deal.leadId);
    const who = lead?.fullName ?? "this person";
    const { timeZone, closerName } = await closerZone(ctx, me.tenantId, deal.assignedCloserId);
    const actor = actorOf(me);
    const target = { kind: "deal", id: deal._id, label: who };
    const link = appLink(`/workspace/opportunities/${deal._id}`);
    const note = "note" in action && action.note?.trim() ? action.note.trim().slice(0, 500) : undefined;

    if (action.kind === "callback" || action.kind === "held_with_callback") {
      const at = parseLocal(action.date, action.time, timeZone);
      const due = formatLocal(at, timeZone);
      if (action.kind === "held_with_callback") await loadInTenant(ctx, me, "meetings", action.meetingId, "that meeting");
      // A matching pending call-back is returned as it is, never duplicated.
      const pending = await ctx.db
        .query("followUps")
        .withIndex("by_opportunityId_and_status_and_reason", (q) => q.eq("opportunityId", opportunityId).eq("status", "pending"))
        .take(20);
      const same = pending.find(
        (t) => t.type === "manual_reminder" && t.reminderScheduledAt === at && (t.contactMethod ?? "call") === action.method,
      );
      if (same && action.kind === "callback") {
        return { alreadyExists: true, taskId: same._id, due, closer: closerName, message: "That call-back already exists. Nothing to prepare." };
      }
      const args: NextStepArgs = {
        opportunityId,
        action:
          action.kind === "callback"
            ? { kind: "callback", method: action.method, at, ...(note ? { note } : {}) }
            : { kind: "held_with_callback", meetingId: action.meetingId, method: action.method, at, ...(note ? { note } : {}) },
      };
      const verb = action.method === "call" ? "Call-back" : "Text-back";
      return await prepareSingle(ctx, actor, nextStepCommitter, args, {
        action: action.kind,
        target,
        summary: `${who} · ${action.kind === "held_with_callback" ? "call marked held · " : ""}${verb.toLowerCase()} ${due}, ${closerName}'s time`,
        preview: {
          person: { text: who, by: "person" },
          ...(action.kind === "held_with_callback" ? { meeting: "Marked held", deal: `${deal.stage} → follow_up` } : {}),
          task: `${verb} · ${due} · ${closerName} · ${timeZone}`,
          ...(note ? { note } : {}),
          openInMagnus: link,
        },
      });
    }
    if (action.kind === "scheduling_link") {
      return await prepareSingle(ctx, actor, nextStepCommitter, { opportunityId, action: { kind: "scheduling_link" } }, {
        action: "scheduling_link",
        target,
        summary: `${who} · scheduling link on ${closerName}'s calendar`,
        preview: { person: { text: who, by: "person" }, task: `Scheduling link on ${closerName}'s calendar`, deal: "Moves to Follow-up", openInMagnus: link },
      });
    }
    if (action.kind === "reschedule_link") {
      await loadInTenant(ctx, me, "meetings", action.meetingId, "that meeting");
      return await prepareSingle(ctx, actor, nextStepCommitter, { opportunityId, action }, {
        action: "reschedule_link",
        target,
        summary: `${who} · reschedule link after the no-show`,
        preview: { person: { text: who, by: "person" }, task: `Reschedule link on ${closerName}'s calendar`, deal: "Lost (no-show) → Follow-up", openInMagnus: link },
      });
    }
    const task = await loadInTenant(ctx, me, "followUps", action.followUpId, "that task");
    if (task.opportunityId !== opportunityId) throw rejectRequest("next_step.mismatch", "That task belongs to another deal.");
    return await prepareSingle(ctx, actor, nextStepCommitter, { opportunityId, action }, {
      action: "cancel_task",
      target,
      summary: `${who} · cancel the open ${task.type === "scheduling_link" ? "scheduling link" : "call-back"}`,
      preview: { person: { text: who, by: "person" }, task: "Expired, with its history kept", openInMagnus: link },
    });
  },
});
