import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import {
  listTeamProgramEventTypesForTenant,
  schedulingModeForEventType,
} from "../lib/attribution/teamEventTypeRoutes";
import { rejectRequest } from "../lib/observability/errors";
import { log } from "../lib/observability/log";
import { requireTenantUser } from "../requireTenantUser";

const schedulingModeValidator = v.union(
  v.literal("normal"),
  v.literal("extended"),
);

export const listTeamProgramEventTypes = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    return await listTeamProgramEventTypesForTenant(ctx, tenantId);
  },
});

// Sets which event type a team's portal links use for one program and mode.
// Pass null to remove the route.
export const setTeamProgramEventType = mutation({
  args: {
    teamId: v.id("attributionTeams"),
    programId: v.id("tenantPrograms"),
    mode: schedulingModeValidator,
    eventTypeConfigId: v.union(v.id("eventTypeConfigs"), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const [team, program] = await Promise.all([
      ctx.db.get("attributionTeams", args.teamId),
      ctx.db.get("tenantPrograms", args.programId),
    ]);
    if (!team || team.tenantId !== tenantId) {
      throw rejectRequest("attribution.team_not_found", "Team not found.", {
        tenantId,
      });
    }
    if (!program || program.tenantId !== tenantId) {
      throw rejectRequest(
        "attribution.program_not_found",
        "Program not found.",
        { tenantId },
      );
    }

    const existing = await ctx.db
      .query("teamProgramEventTypes")
      .withIndex("by_tenantId_and_teamId_and_programId_and_mode", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("teamId", args.teamId)
          .eq("programId", args.programId)
          .eq("mode", args.mode),
      )
      .unique();

    if (args.eventTypeConfigId === null) {
      if (existing) {
        await ctx.db.delete("teamProgramEventTypes", existing._id);
        log.info("attribution.team_event_type.cleared", {
          tenantId,
          teamId: args.teamId,
          programId: args.programId,
          mode: args.mode,
        });
      }
      return null;
    }

    if (program.archivedAt !== undefined) {
      throw rejectRequest(
        "attribution.program_archived",
        "Archived programs can't get new event types.",
        { tenantId },
      );
    }

    const eventTypeConfig = await ctx.db.get(
      "eventTypeConfigs",
      args.eventTypeConfigId,
    );
    if (!eventTypeConfig || eventTypeConfig.tenantId !== tenantId) {
      throw rejectRequest(
        "attribution.event_type_not_found",
        "Event type not found.",
        { tenantId },
      );
    }
    if (
      eventTypeConfig.bookingProgramId !== args.programId ||
      eventTypeConfig.bookingProgramMappingStatus !== "mapped"
    ) {
      throw rejectRequest(
        "attribution.event_type_program_mismatch",
        `${eventTypeConfig.displayName} is not mapped to ${program.name}.`,
        { tenantId },
      );
    }
    if (schedulingModeForEventType(eventTypeConfig) !== args.mode) {
      throw rejectRequest(
        "attribution.event_type_mode_mismatch",
        args.mode === "extended"
          ? `${eventTypeConfig.displayName} is not a Standard event type.`
          : `${eventTypeConfig.displayName} is not a Priority event type.`,
        { tenantId },
      );
    }

    const now = Date.now();
    if (existing) {
      if (existing.eventTypeConfigId !== args.eventTypeConfigId) {
        await ctx.db.patch("teamProgramEventTypes", existing._id, {
          eventTypeConfigId: args.eventTypeConfigId,
          updatedAt: now,
        });
      }
    } else {
      await ctx.db.insert("teamProgramEventTypes", {
        tenantId,
        teamId: args.teamId,
        programId: args.programId,
        mode: args.mode,
        eventTypeConfigId: args.eventTypeConfigId,
        createdAt: now,
        updatedAt: now,
      });
    }

    log.info("attribution.team_event_type.set", {
      tenantId,
      teamId: args.teamId,
      programId: args.programId,
      mode: args.mode,
      eventTypeConfigId: args.eventTypeConfigId,
    });
    return null;
  },
});
