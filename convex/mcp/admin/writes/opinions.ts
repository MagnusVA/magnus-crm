import { v } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import { internalMutation } from "../../../_generated/server";
import { checkSecondOpinionCheckAllowed, secondOpinionCheckCore } from "../../../secondOpinion";
import { rejectRequest } from "../../../lib/observability/errors";
import type { CheckResult } from "../../../lib/outcomeCores";
import { mcpCallerValidator, requireMcpAdmin, loadInTenant } from "../../guard";
import { formatLocal } from "../../time";
import { appLink, prepareSingle, type Committer, type Pins } from "../prepare";
import { actorOf, asAgentError, closerZone, meetingPins, parseLocal } from "./common";

/** `magnus_decide_second_opinion` (docs/plans/admin-assistant.md §2, tool 10). */

type Outcome = "closer_right" | "second_opinion_right";
type DecideArgs = { secondOpinionId: Id<"secondOpinions">; outcome: Outcome; reopen?: { date: string; time: string } };

export const decideOpinionCommitter: Committer<DecideArgs> = {
  tool: "magnus_decide_second_opinion",
  family: "opinions",
  kind: "single",
  pins: async (ctx, actor, args): Promise<Pins> => {
    const row = await ctx.db.get("secondOpinions", args.secondOpinionId);
    if (!row || row.tenantId !== actor.tenantId) return { opinion: "missing" };
    return {
      "opinion.reviewState": row.reviewState ?? null,
      "opinion.status": row.status,
      "opinion.verdict": row.verdict ?? null,
      ...meetingPins(await ctx.db.get("meetings", row.meetingId)),
    };
  },
  check: (ctx, actor, args) => checkSecondOpinionCheckAllowed(ctx, actor, args) as Promise<CheckResult<object>>,
  apply: async (ctx, actor, args, provenance) => {
    await asAgentError(() => secondOpinionCheckCore(ctx, actor, args, provenance));
    return { opinion: "checked", outcome: args.outcome, reopened: Boolean(args.reopen) };
  },
};

export const decideOpinionArgs = {
  caller: mcpCallerValidator,
  secondOpinionId: v.id("secondOpinions"),
  outcome: v.union(v.literal("closer_right"), v.literal("second_opinion_right")),
  reopen: v.optional(v.object({ date: v.string(), time: v.string() })),
};

export const prepareDecideSecondOpinion = internalMutation({
  args: decideOpinionArgs,
  returns: v.any(),
  handler: async (ctx, { caller, ...args }) => {
    const me = await requireMcpAdmin(ctx, caller, { family: "opinions" });
    const row = await loadInTenant(ctx, me, "secondOpinions", args.secondOpinionId, "that second opinion");
    if (row.reviewState !== "open") throw rejectRequest("second_opinion.decided", "That second opinion was already decided.");
    if (args.reopen && args.outcome !== "second_opinion_right") {
      throw rejectRequest("second_opinion.reopen_invalid", "Only a disproved no-show can be reopened as a call-back.");
    }
    const actor = actorOf(me);
    const allowed = await checkSecondOpinionCheckAllowed(ctx, actor, args);
    if (!allowed.ok) throw rejectRequest(allowed.code, allowed.message);
    const meeting = await ctx.db.get("meetings", row.meetingId);
    const { timeZone, closerName } = await closerZone(ctx, me.tenantId, row.closerUserId);
    const who = meeting?.leadName ?? "this person";
    const when = meeting ? formatLocal(meeting.scheduledAt, timeZone) : "";
    const reopenAt = args.reopen ? formatLocal(parseLocal(args.reopen.date, args.reopen.time, timeZone), timeZone) : null;
    const verdict = args.outcome === "closer_right" ? `${closerName} was right` : "The second opinion was right";
    return await prepareSingle(ctx, actor, decideOpinionCommitter, args, {
      action: "decide_second_opinion",
      target: { kind: "second_opinion", id: row._id, label: `${who} · ${when}` },
      summary: `${who} · ${verdict}${reopenAt ? ` · reopen as a call-back ${reopenAt}` : ""}`,
      preview: {
        call: { person: { text: who, by: "person" }, closer: closerName, when },
        recorded: row.record?.kind ?? null,
        decision: verdict,
        ...(reopenAt ? { reopen: `Call-back ${reopenAt}, ${closerName}'s time. The deal moves to Follow-up.` } : {}),
        openInMagnus: appLink(`/workspace/second-opinions/${row._id}`),
      },
    });
  },
});
