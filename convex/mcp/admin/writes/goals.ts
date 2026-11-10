import { v } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../../../_generated/server";
import { setTeamBookingQuotaCore } from "../../../attribution/teams";
import { setTeamDailyGoalCore } from "../../../reporting/slackQualifications";
import { rejectRequest } from "../../../lib/observability/errors";
import { mcpCallerValidator, requireMcpAdmin, loadInTenant } from "../../guard";
import { appLink, prepareSingle, type Committer, type Pins } from "../prepare";
import { actorOf, asAgentError } from "./common";

/** `magnus_set_goal` (docs/plans/admin-assistant.md §2, tool 17). `null` clears a goal. */

type GoalArgs =
  | { kind: "daily_qualifications"; value: number | null }
  | { kind: "team_booking_quota"; teamId: Id<"attributionTeams">; value: number | null };

const show = (n: number | null | undefined) => (n === null || n === undefined ? "no goal" : String(n));

export const goalCommitter: Committer<GoalArgs> = {
  tool: "magnus_set_goal",
  family: "goals",
  kind: "single",
  permission: "settings:manage",
  pins: async (ctx, actor, args): Promise<Pins> => {
    if (args.kind === "daily_qualifications") {
      const tenant = await ctx.db.get("tenants", actor.tenantId);
      return { "goal.before": tenant?.slackQualificationDailyTeamQuota ?? null };
    }
    const team = await ctx.db.get("attributionTeams", args.teamId);
    if (!team || team.tenantId !== actor.tenantId) return { team: "missing" };
    return { "goal.before": team.bookingDailyQuota ?? null, "team.isActive": team.isActive };
  },
  apply: async (ctx, actor, args, provenance) => {
    const mctx = ctx as MutationCtx;
    if (args.kind === "daily_qualifications") {
      await asAgentError(() => setTeamDailyGoalCore(mctx, actor, { dailyTeamQualificationGoal: args.value }, provenance));
    } else {
      await asAgentError(() => setTeamBookingQuotaCore(mctx, actor, { teamId: args.teamId, bookingDailyQuota: args.value }, provenance));
    }
    return { goal: args.value };
  },
};

export const setGoalArgs = {
  caller: mcpCallerValidator,
  kind: v.union(v.literal("daily_qualifications"), v.literal("team_booking_quota")),
  teamId: v.optional(v.id("attributionTeams")),
  value: v.union(v.number(), v.null()),
};

export const prepareSetGoal = internalMutation({
  args: setGoalArgs,
  returns: v.any(),
  handler: async (ctx, { caller, kind, teamId, value }) => {
    const me = await requireMcpAdmin(ctx, caller, { family: "goals", permission: "settings:manage" });
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 1000)) {
      throw rejectRequest("goal.invalid", "A goal is a whole number from 0 to 1000, or null to clear it.");
    }
    const actor = actorOf(me);
    if (kind === "daily_qualifications") {
      if (teamId) throw rejectRequest("goal.invalid", "The daily qualification goal is for the whole team. Leave teamId out.");
      const before = me.tenant.slackQualificationDailyTeamQuota ?? null;
      if (before === value) throw rejectRequest("goal.unchanged", `The goal is already ${show(value)}.`);
      return await prepareSingle(ctx, actor, goalCommitter, { kind, value }, {
        action: "set_goal",
        target: { kind: "goal", id: "daily_qualifications", label: "Daily qualification goal" },
        summary: `Daily qualification goal · ${show(before)} → ${show(value)}`,
        preview: { goal: "Daily qualification goal", before: show(before), after: show(value), openInMagnus: appLink("/workspace/team/goals") },
      });
    }
    if (!teamId) throw rejectRequest("goal.invalid", "Name the DM team, by ID from magnus_team.");
    const team = await loadInTenant(ctx, me, "attributionTeams", teamId, "that DM team");
    const before = team.bookingDailyQuota ?? null;
    if (before === value) throw rejectRequest("goal.unchanged", `${team.displayName}'s quota is already ${show(value)}.`);
    return await prepareSingle(ctx, actor, goalCommitter, { kind, teamId, value }, {
      action: "set_goal",
      target: { kind: "team", id: team._id, label: team.displayName },
      summary: `${team.displayName} daily booking quota · ${show(before)} → ${show(value)}`,
      preview: { team: team.displayName, before: show(before), after: show(value), openInMagnus: appLink("/workspace/team/goals") },
    });
  },
});
