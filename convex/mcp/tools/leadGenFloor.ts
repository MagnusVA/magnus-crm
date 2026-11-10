import { v } from "convex/values";
import { internalQuery } from "../../_generated/server";
import {
  decodeLeadGenCursor,
  encodeLeadGenCursor,
  readLeadGenFloor,
  trimLeadGenText,
} from "../../leadGen/floor";
import {
  listTeamsCore,
  listWorkersCore,
  listWorkerSchedulesCore,
} from "../../leadGen/workers";
import { getResparkSettingsCore } from "../../respark/settings";
import { resparkSettingsValidator } from "../../lib/respark/settings";
import { tenantBusinessToday } from "../../lib/tenantBusinessDay";
import {
  mcpCallerValidator,
  requireMcpAdmin,
  normalizeMcpId,
  withMcpCursorErrors,
} from "../guard";
import { formatLocal } from "../time";

export const floorArgs = {
  teamId: v.optional(v.string()),
  cursor: v.optional(v.string()),
};

export const floor = internalQuery({
  args: { caller: mcpCallerValidator, ...floorArgs },
  returns: v.object({
    timeZone: v.string(),
    dayKey: v.string(),
    asOf: v.string(),
    isPartial: v.boolean(),
    cursor: v.union(v.string(), v.null()),
    specialists: v.array(
      v.object({
        workerId: v.id("leadGenWorkers"),
        name: v.string(),
        active: v.boolean(),
        teamId: v.union(v.id("attributionTeams"), v.null()),
        team: v.union(v.string(), v.null()),
        scheduledHours: v.number(),
        captures: v.number(),
        unique: v.number(),
        dupes: v.number(),
        resparks: v.number(),
        notAFit: v.number(),
        lastCaptureAt: v.union(v.string(), v.null()),
        openBatch: v.union(
          v.object({
            batchId: v.id("resparkBatches"),
            size: v.number(),
            worked: v.number(),
            heldUntil: v.string(),
          }),
          v.null(),
        ),
        flags: v.array(
          v.union(
            v.literal("scheduled_no_entries"),
            v.literal("no_team"),
            v.literal("inactive_with_schedule"),
          ),
        ),
        isPartial: v.boolean(),
        textTruncated: v.boolean(),
      }),
    ),
  }),
  handler: async (ctx, { caller, ...args }) => {
    const me = await requireMcpAdmin(ctx, caller, { permission: "lead-gen:view-all" });
    const now = Date.now();
    const result = await withMcpCursorErrors("lead_gen.invalid_cursor", () => readLeadGenFloor(ctx, {
      tenantId: me.tenantId,
      ...args,
      teamId: args.teamId === undefined ? undefined : normalizeMcpId(ctx, "attributionTeams", args.teamId, "teamId"),
      now,
    }));
    return {
      ...result,
      timeZone: me.timeZone,
      asOf: formatLocal(now, me.timeZone),
      specialists: result.specialists.map((row) => ({
        ...row,
        // A specialist without a display name falls back to an email on the
        // web; contact details stay out of assistant answers.
        name: row.name.includes("@") ? "Unnamed specialist" : row.name,
        lastCaptureAt:
          row.lastCaptureAt === null
            ? null
            : formatLocal(row.lastCaptureAt, me.timeZone),
        openBatch: row.openBatch
          ? {
              ...row.openBatch,
              heldUntil: formatLocal(row.openBatch.heldUntil, me.timeZone),
            }
          : null,
      })),
    };
  },
});

export const rosterArgs = {
  includeInactive: v.optional(v.boolean()),
  cursor: v.optional(v.string()),
};

export const roster = internalQuery({
  args: { caller: mcpCallerValidator, ...rosterArgs },
  returns: v.object({
    timeZone: v.string(),
    asOf: v.string(),
    isPartial: v.boolean(),
    cursor: v.union(v.string(), v.null()),
    specialists: v.array(
      v.object({
        workerId: v.id("leadGenWorkers"),
        name: v.string(),
        active: v.boolean(),
        teamId: v.union(v.id("attributionTeams"), v.null()),
        team: v.union(v.string(), v.null()),
        weeklyScheduledHours: v.number(),
        textTruncated: v.boolean(),
      }),
    ),
    teams: v.array(
      v.object({
        teamId: v.id("attributionTeams"),
        name: v.string(),
        active: v.boolean(),
        textTruncated: v.boolean(),
      }),
    ),
    resparkRules: resparkSettingsValidator,
  }),
  handler: async (ctx, { caller, includeInactive, cursor }) => {
    const me = await requireMcpAdmin(ctx, caller, { permission: "lead-gen:view-all" });
    const now = Date.now();
    const scope = JSON.stringify([
      "roster",
      me.tenantId,
      includeInactive ?? false,
    ]);
    const position = decodeLeadGenCursor(cursor, scope);
    // One native paginate per query: teams follow specialists in the same cursor stream.
    const teamsPhase = position?.startsWith("teams:") ?? false;
    const { settings } = await getResparkSettingsCore(ctx, {
      tenantId: me.tenantId,
      now,
    });
    const base = {
      timeZone: me.timeZone,
      asOf: formatLocal(now, me.timeZone),
      resparkRules: settings,
    };
    if (teamsPhase) {
      const page = await withMcpCursorErrors("lead_gen.invalid_cursor", () => listTeamsCore(ctx, {
        tenantId: me.tenantId,
        includeInactive,
        paginationOpts: { cursor: position!.slice(6) || null },
      }));
      return {
        ...base,
        specialists: [],
        teams: page.page.map((team) => ({
          teamId: team._id,
          name: trimLeadGenText(team.displayName),
          active: team.isActive,
          textTruncated: trimLeadGenText(team.displayName) !== team.displayName,
        })),
        isPartial: !page.isDone,
        cursor: page.isDone
          ? null
          : encodeLeadGenCursor(scope, `teams:${page.continueCursor}`),
      };
    }
    const page = await withMcpCursorErrors("lead_gen.invalid_cursor", () => listWorkersCore(ctx, {
      tenantId: me.tenantId,
      includeInactive,
      paginationOpts: { cursor: position, numItems: 25 },
    }));
    // A bounded take can accompany the worker pagination without a second native paginate.
    const preview = await ctx.db.query("attributionTeams").withIndex("by_tenantId", q => q.eq("tenantId", me.tenantId)).take(26);
    const teamsFit = preview.length <= 25;
    const firstTeams = teamsFit && cursor === undefined ? (await Promise.all(preview.map(async team => {
      if (!includeInactive && !team.isActive) return null;
      const worker = await ctx.db.query("leadGenWorkers").withIndex("by_tenantId_and_teamId", q => q.eq("tenantId", me.tenantId).eq("teamId", team._id)).first();
      return worker ? { teamId: team._id, name: trimLeadGenText(team.displayName), active: team.isActive, textTruncated: trimLeadGenText(team.displayName) !== team.displayName } : null;
    }))).filter(team => team !== null) : [];
    const next = !page.isDone ? encodeLeadGenCursor(scope, page.continueCursor) : teamsFit ? null : encodeLeadGenCursor(scope, "teams:");
    const today = await tenantBusinessToday(ctx, me.tenantId);
    const schedules = await listWorkerSchedulesCore(ctx, {
      tenantId: me.tenantId,
      workerIds: page.page.map((worker) => worker._id),
      today,
    });
    const specialists = await Promise.all(
      page.page.map(async (worker) => {
        const team = worker.teamId
          ? await ctx.db.get("attributionTeams", worker.teamId)
          : null;
        const teamName =
          team?.tenantId === me.tenantId ? team.displayName : null;
        const name = worker.displayName ?? "Unnamed specialist";
        return {
          workerId: worker._id,
          name: trimLeadGenText(name),
          active: worker.isActive,
          teamId: team?.tenantId === me.tenantId ? team._id : null,
          team: teamName === null ? null : trimLeadGenText(teamName),
          weeklyScheduledHours: schedules.rows
            .filter((row) => row.workerId === worker._id)
            .reduce((sum, row) => sum + row.scheduledHours, 0),
          textTruncated:
            trimLeadGenText(name) !== name ||
            (teamName !== null && trimLeadGenText(teamName) !== teamName),
        };
      }),
    );
    return {
      ...base,
      specialists,
      teams: firstTeams,
      isPartial: schedules.capped || next !== null,
      cursor: next,
    };
  },
});
