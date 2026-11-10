import { v } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import { internalMutation } from "../../../_generated/server";
import {
  adminMarkLostCore,
  adminMarkNoShowCore,
  checkAdminMarkLostAllowed,
  checkAdminMarkNoShowAllowed,
} from "../../../admin/meetingActions";
import { rejectRequest } from "../../../lib/observability/errors";
import type { CheckResult } from "../../../lib/outcomeCores";
import { mcpCallerValidator, requireMcpAdmin, loadInTenant } from "../../guard";
import { formatLocal } from "../../time";
import { appLink, preparePlan, prepareSingle, type Committer } from "../prepare";
import { actorOf, asAgentError, closerZone, dealPins, meetingPins, startedCheck } from "./common";

/**
 * `magnus_record_result` (docs/plans/admin-assistant.md §2, tool 8): the result
 * of a closer's call that has started. A no-show is committed in chat; a loss a
 * person records never reopens, so it is approved in Magnus.
 */

const noShowReason = v.union(
  v.literal("no_response"),
  v.literal("late_cancel"),
  v.literal("technical_issues"),
  v.literal("other"),
);
const lossCategory = v.union(
  v.literal("not_a_fit"),
  v.literal("price"),
  v.literal("timing"),
  v.literal("went_quiet"),
  v.literal("other"),
);
const LOSS_LABEL = { not_a_fit: "Not a fit", price: "Price", timing: "Timing", went_quiet: "Went quiet", other: "Other" } as const;

type NoShowArgs = { meetingId: Id<"meetings">; reason: "no_response" | "late_cancel" | "technical_issues" | "other"; note?: string };
type LossArgs = { meetingId: Id<"meetings">; opportunityId: Id<"opportunities">; reason: string };

async function pinsFor(ctx: Parameters<Committer<NoShowArgs>["pins"]>[0], meetingId: Id<"meetings">, tenantId: Id<"tenants">) {
  const meeting = await ctx.db.get("meetings", meetingId);
  if (!meeting || meeting.tenantId !== tenantId) return { meeting: "missing" };
  const deal = await ctx.db.get("opportunities", meeting.opportunityId);
  return { ...meetingPins(meeting), ...dealPins(deal) };
}

async function startedFor(
  ctx: Parameters<Committer<NoShowArgs>["pins"]>[0],
  meetingId: Id<"meetings">,
  tenantId: Id<"tenants">,
): Promise<CheckResult<object>> {
  const meeting = await ctx.db.get("meetings", meetingId);
  if (!meeting || meeting.tenantId !== tenantId) return { ok: false, code: "mcp.not_found", message: "Magnus can't find that meeting." };
  const { timeZone } = await closerZone(ctx, tenantId, meeting.assignedCloserId);
  return startedCheck(meeting, timeZone);
}

export const noShowCommitter: Committer<NoShowArgs> = {
  tool: "magnus_record_result.no_show",
  family: "results",
  kind: "single",
  permission: "pipeline:view-all",
  pins: (ctx, actor, args) => pinsFor(ctx, args.meetingId, actor.tenantId),
  check: async (ctx, actor, args) => {
    const started = await startedFor(ctx, args.meetingId, actor.tenantId);
    if (!started.ok) return started;
    return (await checkAdminMarkNoShowAllowed(ctx, actor, args)) as CheckResult<object>;
  },
  apply: async (ctx, actor, args, provenance) => {
    await asAgentError(() => adminMarkNoShowCore(ctx, actor, args, provenance));
    return { meeting: "no_show", deal: "Closed · lost · no-show" };
  },
};

export const lossCommitter: Committer<LossArgs> = {
  tool: "magnus_record_result.lost",
  family: "results",
  kind: "plan",
  permission: "pipeline:view-all",
  pins: (ctx, actor, args) => pinsFor(ctx, args.meetingId, actor.tenantId),
  check: async (ctx, actor, args) => {
    const started = await startedFor(ctx, args.meetingId, actor.tenantId);
    if (!started.ok) return started;
    return (await checkAdminMarkLostAllowed(ctx, actor, {
      opportunityId: args.opportunityId,
      meetingId: args.meetingId,
      reason: args.reason,
    })) as CheckResult<object>;
  },
  apply: async (ctx, actor, args, provenance) => {
    await asAgentError(() =>
      adminMarkLostCore(ctx, actor, { opportunityId: args.opportunityId, meetingId: args.meetingId, reason: args.reason }, provenance),
    );
    return { meeting: "held", deal: "Closed · lost" };
  },
};

export const recordResultArgs = {
  caller: mcpCallerValidator,
  meetingId: v.id("meetings"),
  result: v.union(
    v.object({ kind: v.literal("no_show"), reason: noShowReason, note: v.optional(v.string()) }),
    v.object({ kind: v.literal("lost"), category: lossCategory, reason: v.string() }),
  ),
};

export const prepareRecordResult = internalMutation({
  args: recordResultArgs,
  returns: v.any(),
  handler: async (ctx, { caller, meetingId, result }) => {
    const me = await requireMcpAdmin(ctx, caller, { family: "results", permission: "pipeline:view-all" });
    const meeting = await loadInTenant(ctx, me, "meetings", meetingId, "that meeting");
    const { timeZone, closerName } = await closerZone(ctx, me.tenantId, meeting.assignedCloserId);
    const started = startedCheck(meeting, timeZone);
    if (!started.ok) throw rejectRequest(started.code, started.message);
    const who = meeting.leadName ?? "this person";
    const when = formatLocal(meeting.scheduledAt, timeZone);
    const actor = actorOf(me);
    const link = appLink(`/workspace/pipeline/meetings/${meeting._id}`);

    if (result.kind === "no_show") {
      const args: NoShowArgs = { meetingId, reason: result.reason, ...(result.note?.trim() ? { note: result.note.trim().slice(0, 500) } : {}) };
      return await prepareSingle(ctx, actor, noShowCommitter, args, {
        action: "record_no_show",
        target: { kind: "meeting", id: meeting._id, label: `${who} · ${when}` },
        summary: `${who} · ${closerName}'s ${when} call · no-show`,
        preview: {
          meeting: { person: { text: who, by: "person" }, closer: closerName, when },
          result: `No-show · ${result.reason.replace(/_/g, " ")}`,
          effect: "The deal closes as lost, no-show. A reschedule link can still reopen it.",
          openInMagnus: link,
        },
      });
    }

    const detail = result.reason.trim();
    if (detail.split(/\s+/).filter(Boolean).length < 2) {
      throw rejectRequest("loss.reason_required", "A loss needs a reason of a few words. Ask why the deal was lost.");
    }
    const reason = `${LOSS_LABEL[result.category]}: ${detail}`.slice(0, 500);
    const args: LossArgs = { meetingId, opportunityId: meeting.opportunityId, reason };
    return await preparePlan(ctx, actor, lossCommitter, args, {
      title: `Mark ${who}'s deal lost`,
      summary: `${who} · ${closerName}'s ${when} call · lost · ${reason}`,
      target: { kind: "deal", id: meeting.opportunityId, label: who },
      columns: ["Person", "Call", "Closer", "Reason"],
      rows: [[who, when, closerName, reason]],
      footnote: "The call counts as held. A loss a person records can't be reopened.",
      preview: {
        person: { text: who, by: "person" },
        call: when,
        closer: closerName,
        reason,
        effect: "The deal closes as lost and the call counts as held. This can't be undone.",
        openInMagnus: link,
      },
    });
  },
});
