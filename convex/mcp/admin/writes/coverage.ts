import { v } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import { internalMutation } from "../../../_generated/server";
import { rejectRequest } from "../../../lib/observability/errors";
import { unavailabilityReasonValidator } from "../../../lib/unavailabilityValidation";
import {
  applyCoveragePlanCore,
  checkCoveragePlan,
  coveragePlanPins,
  type CoveragePlanArgs,
  loadCoverageInput,
} from "../../../unavailability/coverage";
import { planCoverage } from "../../../unavailability/planner";
import { getDayRange } from "../../../unavailability/shared";
import { loadInTenant, mcpCallerValidator, requireMcpAdmin } from "../../guard";
import { formatLocal, formatLocalTime } from "../../time";
import { appLink, preparePlan, type Committer } from "../prepare";
import { actorOf, asAgentError, closerZone, parseLocal, personName } from "./common";

/**
 * `magnus_cover_closer` (docs/plans/admin-assistant.md §2, tool 13): a
 * closer's affected calls and who is free, and, with `mode: "plan"`, an
 * absence plus a frozen plan (one new owner per deal) that a person approves
 * in Magnus. `preview` writes nothing; it shares this mutation only so one
 * tool serves both.
 */

export const coverageCommitter: Committer<CoveragePlanArgs> = {
  tool: "magnus_cover_closer",
  family: "coverage",
  kind: "plan",
  permission: "reassignment:execute",
  pins: (ctx, actor, args) => coveragePlanPins(ctx, actor.tenantId, args),
  check: (ctx, actor, args) => checkCoveragePlan(ctx, actor, args),
  apply: async (ctx, actor, args, provenance) => {
    const out = await asAgentError(() => applyCoveragePlanCore(ctx, actor, args, provenance));
    return { ...out, openInMagnus: appLink(`/workspace/team/redistribute/${out.unavailabilityId}`) };
  },
  size: (args) => Math.max(1, args.deals.length),
};

export const coverCloserArgs = {
  caller: mcpCallerValidator,
  closerId: v.id("users"),
  date: v.string(),
  fullDay: v.optional(v.boolean()),
  from: v.optional(v.string()),
  to: v.optional(v.string()),
  reason: v.optional(unavailabilityReasonValidator),
  candidateCloserIds: v.optional(v.array(v.id("users"))),
  mode: v.union(v.literal("preview"), v.literal("plan")),
};

const WIZARD_HOME = "/workspace/team";

export const prepareCoverCloser = internalMutation({
  args: coverCloserArgs,
  returns: v.any(),
  handler: async (ctx, { caller, ...args }) => {
    const me = await requireMcpAdmin(ctx, caller, { family: "coverage", permission: "reassignment:execute" });
    const closer = await loadInTenant(ctx, me, "users", args.closerId, "that closer");
    if (closer.role !== "closer") throw rejectRequest("coverage.not_closer", "Only a closer's calls can be covered.");
    const { timeZone, closerName } = await closerZone(ctx, me.tenantId, closer._id);

    const partial = args.from !== undefined || args.to !== undefined;
    if (args.fullDay && partial) throw rejectRequest("coverage.window_invalid", "Send fullDay: true, or from and to, not both.");
    if (!args.fullDay && (args.from === undefined || args.to === undefined)) {
      throw rejectRequest("coverage.window_invalid", 'Send fullDay: true, or both from and to ("HH:MM" in the closer\'s zone).');
    }
    const date = parseLocal(args.date, "00:00", timeZone);
    const startTime = args.fullDay ? undefined : parseLocal(args.date, args.from!, timeZone);
    const endTime = args.fullDay ? undefined : parseLocal(args.date, args.to!, timeZone);
    if (startTime !== undefined && endTime !== undefined && startTime >= endTime) {
      throw rejectRequest("coverage.window_invalid", "from must be before to.");
    }
    const { dayStart, dayEnd } = getDayRange(date);
    const rangeStart = startTime ?? dayStart;
    const rangeEnd = endTime ?? dayEnd;

    const existing = await ctx.db
      .query("closerUnavailability")
      .withIndex("by_closerId_and_date", (q) => q.eq("closerId", closer._id).eq("date", date))
      .first();
    const wizard = appLink(existing ? `/workspace/team/redistribute/${existing._id}` : WIZARD_HOME);

    const now = Date.now();
    const input = await loadCoverageInput(ctx, {
      tenantId: me.tenantId,
      closerId: closer._id,
      rangeStart,
      rangeEnd,
      candidateCloserIds: args.candidateCloserIds,
      now,
    });
    if (!input.ok) throw rejectRequest(input.code, `${input.message} ${wizard}`);
    const result = planCoverage({ deals: input.deals, candidates: input.candidates, now });

    const nameOf = new Map(input.candidates.map((c) => [c.closerId, c.name]));
    const ownerOf = new Map(result.assigned.map((a) => [a.opportunityId, a.toCloserId]));
    const when = (ms: number) => formatLocal(ms, timeZone);
    const startOf = new Map(input.deals.flatMap((d) => d.meetings.map((m) => [m.meetingId, m.scheduledAt] as const)));
    const calls = input.deals
      .flatMap((d) =>
        d.affectedMeetingIds.map((id) => {
          const m = d.meetings.find((x) => x.meetingId === id)!;
          const to = ownerOf.get(d.opportunityId);
          return {
            meetingId: id,
            opportunityId: d.opportunityId,
            person: personName(d.personName),
            when: when(m.scheduledAt),
            durationMinutes: m.durationMinutes,
            alsoMovesWithDeal: d.meetings.length - d.affectedMeetingIds.length,
            proposedOwner: to ? { closerId: to, name: nameOf.get(to) ?? "" } : null,
          };
        }),
      )
      .sort((a, b) => startOf.get(a.meetingId)! - startOf.get(b.meetingId)!);
    const window = args.fullDay
      ? `${args.date}, all day (${timeZone})`
      : `${when(startTime!)} to ${formatLocalTime(endTime!, timeZone)}`;

    if (args.mode === "preview") {
      return {
        closer: { closerId: closer._id, name: closerName },
        window,
        calls,
        candidates: result.candidates.map((c) => ({
          closerId: c.closerId,
          name: c.name,
          freeForEveryDeal: c.freeFor.length === input.deals.length,
          freeForDeals: c.freeFor.length,
          of: input.deals.length,
        })),
        unassigned: result.unassigned,
        leftOut: input.skipped,
        existingAbsence: existing ? { unavailabilityId: existing._id, openInMagnus: wizard } : null,
        openInMagnus: wizard,
        note: "Nothing has changed. Each deal keeps all its calls with one closer. Call again with mode \"plan\" to prepare the absence and these reassignments for approval in Magnus.",
      };
    }

    if (existing) {
      throw rejectRequest("coverage.absence_exists", `${closerName} already has an absence that day. Reassign the calls in the redistribute wizard: ${wizard}`);
    }
    if (input.deals.length > 0 && result.assigned.length === 0) {
      throw rejectRequest("coverage.nobody_free", `No candidate is free for every call on any of these deals. Use the redistribute wizard: ${wizard}`);
    }

    const dealsById = new Map(input.deals.map((d) => [d.opportunityId, d]));
    const planDeals: CoveragePlanArgs["deals"] = result.assigned.map((a) => {
      const d = dealsById.get(a.opportunityId)!;
      return {
        opportunityId: a.opportunityId,
        toCloserId: a.toCloserId,
        affectedMeetingIds: d.affectedMeetingIds,
        meetings: d.meetings.map((m) => ({
          meetingId: m.meetingId,
          scheduledAt: m.scheduledAt,
          durationMinutes: m.durationMinutes,
          status: m.status,
        })),
      };
    });
    const planArgs: CoveragePlanArgs = {
      closerId: closer._id,
      date,
      isFullDay: Boolean(args.fullDay),
      ...(args.fullDay ? {} : { startTime, endTime }),
      reason: args.reason ?? "other",
      deals: planDeals,
    };

    const rows: string[][] = [];
    for (const pd of planDeals) {
      const d = dealsById.get(pd.opportunityId)!;
      const inWindow = new Set<Id<"meetings">>(pd.affectedMeetingIds);
      for (const m of d.meetings) {
        const tag = inWindow.has(m.meetingId) ? "" : m.status === "scheduled" ? " · moves with the deal" : ` · ${m.status}, moves with the deal`;
        rows.push([personName(d.personName).text, `${when(m.scheduledAt)}${tag}`, closerName, nameOf.get(pd.toCloserId) ?? ""]);
      }
    }
    const upcoming = planDeals
      .flatMap((d) => d.meetings)
      .filter((m) => m.status === "scheduled" && m.scheduledAt > now)
      .map((m) => m.scheduledAt);
    const expiresAt = upcoming.length ? Math.min(...upcoming) : undefined;
    const left = result.unassigned.length + input.skipped.length;

    return await preparePlan(ctx, actorOf(me), coverageCommitter, planArgs, {
      title: `Cover ${closerName}'s calls`,
      summary: `${closerName} away ${window} · ${planDeals.length} ${planDeals.length === 1 ? "deal" : "deals"} to ${new Set(planDeals.map((d) => d.toCloserId)).size} ${new Set(planDeals.map((d) => d.toCloserId)).size === 1 ? "closer" : "closers"}`,
      target: { kind: "closer", id: closer._id, label: closerName },
      columns: ["Person", "Call", "From", "To"],
      rows,
      footnote: left
        ? `${left} ${left === 1 ? "deal stays" : "deals stay"} with ${closerName}: no one is free for all their calls, or they moved. Resolve them in the redistribute wizard.`
        : undefined,
      preview: {
        closer: { closerId: closer._id, name: closerName },
        window,
        calls,
        unassigned: result.unassigned,
        leftOut: input.skipped,
      },
      expiresAt,
    });
  },
});
