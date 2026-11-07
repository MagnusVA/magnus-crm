import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type MutationCtx } from "../_generated/server";
import { schedulingModeOf } from "../lib/bookingSetup/coverage";
import {
  findSharedRoute,
  findTeamRoute,
  isCoverageMigrated,
  migrateTenantToCoverage,
} from "../lib/bookingSetup/coverageData";
import { rejectRequest } from "../lib/observability/errors";
import { log } from "../lib/observability/log";
import { requireTenantUser } from "../requireTenantUser";

const ADMIN_ROLES = ["tenant_master", "tenant_admin"] as const;

const modeValidator = v.union(v.literal("normal"), v.literal("extended"));

const sortingValidator = v.union(
  v.object({
    kind: v.literal("program"),
    programId: v.id("tenantPrograms"),
    mode: modeValidator,
  }),
  v.object({ kind: v.literal("unsorted") }),
  v.object({ kind: v.literal("not_sales_call") }),
);

type Sorting =
  | { kind: "program"; programId: Id<"tenantPrograms">; mode: "normal" | "extended" }
  | { kind: "unsorted" }
  | { kind: "not_sales_call" };

async function assertCoverageTenant(ctx: MutationCtx, tenantId: Id<"tenants">) {
  const tenant = await ctx.db.get("tenants", tenantId);
  if (!tenant || !isCoverageMigrated(tenant)) {
    throw rejectRequest(
      "booking_setup.not_migrated",
      "Open Booking setup once to finish moving to the new layout, then try again.",
      { tenantId },
    );
  }
}

// Moves the caller's tenant to booking coverage. The booking setup page calls
// it on load; it does nothing once the tenant is migrated.
export const ensureCoverage = mutation({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [...ADMIN_ROLES]);
    const result = await migrateTenantToCoverage(ctx, tenantId);
    return result.migrated;
  },
});

// Sets one cell of the coverage board. `teamId: null` is the Shared column;
// `eventTypeConfigId: null` clears the cell. Returns the previous event type
// so the board can undo. `restore` is Undo: it puts back what the cell held
// even if that event type no longer matches the program or mode.
export const setCell = mutation({
  args: {
    teamId: v.union(v.id("attributionTeams"), v.null()),
    programId: v.id("tenantPrograms"),
    mode: modeValidator,
    eventTypeConfigId: v.union(v.id("eventTypeConfigs"), v.null()),
    restore: v.optional(v.boolean()),
  },
  returns: v.object({
    previousEventTypeConfigId: v.union(v.id("eventTypeConfigs"), v.null()),
  }),
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [...ADMIN_ROLES]);
    await assertCoverageTenant(ctx, tenantId);

    const [team, program] = await Promise.all([
      args.teamId ? ctx.db.get("attributionTeams", args.teamId) : null,
      ctx.db.get("tenantPrograms", args.programId),
    ]);
    if (args.teamId && (!team || team.tenantId !== tenantId)) {
      throw rejectRequest("booking_setup.team_not_found", "Team not found.", { tenantId });
    }
    if (!program || program.tenantId !== tenantId) {
      throw rejectRequest("booking_setup.program_not_found", "Program not found.", { tenantId });
    }

    const existing = args.teamId
      ? await findTeamRoute(ctx, {
          tenantId,
          teamId: args.teamId,
          programId: args.programId,
          mode: args.mode,
        })
      : await findSharedRoute(ctx, {
          tenantId,
          programId: args.programId,
          mode: args.mode,
        });
    const previousEventTypeConfigId = existing?.eventTypeConfigId ?? null;
    const table = args.teamId ? "teamProgramEventTypes" : "sharedProgramEventTypes";
    const logAttrs = {
      tenantId,
      teamId: args.teamId ?? "shared",
      programId: args.programId,
      mode: args.mode,
    };

    if (args.eventTypeConfigId === null) {
      if (existing) {
        await ctx.db.delete(table, existing._id);
        log.info("booking_setup.cell.cleared", logAttrs);
      }
      return { previousEventTypeConfigId };
    }

    if (program.archivedAt !== undefined) {
      throw rejectRequest(
        "booking_setup.program_archived",
        "Archived programs can't get new event types.",
        { tenantId },
      );
    }
    const config = await ctx.db.get("eventTypeConfigs", args.eventTypeConfigId);
    if (!config || config.tenantId !== tenantId) {
      throw rejectRequest("booking_setup.event_type_not_found", "Event type not found.", {
        tenantId,
      });
    }
    if (
      !args.restore &&
      (config.bookingProgramId !== args.programId ||
        config.bookingProgramMappingStatus !== "mapped")
    ) {
      throw rejectRequest(
        "booking_setup.event_type_program_mismatch",
        `${config.displayName} counts for another program. Sort it into ${program.name} first.`,
        { tenantId },
      );
    }
    if (!args.restore && schedulingModeOf(config) !== args.mode) {
      throw rejectRequest(
        "booking_setup.event_type_mode_mismatch",
        args.mode === "extended"
          ? `${config.displayName} is a Priority event type.`
          : `${config.displayName} is a Standard event type.`,
        { tenantId },
      );
    }

    const now = Date.now();
    if (existing) {
      if (existing.eventTypeConfigId !== config._id) {
        await ctx.db.patch(table, existing._id, {
          eventTypeConfigId: config._id,
          updatedAt: now,
        });
      }
    } else if (args.teamId) {
      await ctx.db.insert("teamProgramEventTypes", {
        tenantId,
        teamId: args.teamId,
        programId: args.programId,
        mode: args.mode,
        eventTypeConfigId: config._id,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("sharedProgramEventTypes", {
        tenantId,
        programId: args.programId,
        mode: args.mode,
        eventTypeConfigId: config._id,
        createdAt: now,
        updatedAt: now,
      });
    }
    log.info("booking_setup.cell.set", { ...logAttrs, eventTypeConfigId: config._id });
    return { previousEventTypeConfigId };
  },
});

// Whether a team's empty cells fall back to the Shared column.
export const setTeamUsesShared = mutation({
  args: {
    teamId: v.id("attributionTeams"),
    usesShared: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, { teamId, usesShared }) => {
    const { tenantId } = await requireTenantUser(ctx, [...ADMIN_ROLES]);
    await assertCoverageTenant(ctx, tenantId);
    const team = await ctx.db.get("attributionTeams", teamId);
    if (!team || team.tenantId !== tenantId) {
      throw rejectRequest("booking_setup.team_not_found", "Team not found.", { tenantId });
    }
    await ctx.db.patch("attributionTeams", teamId, {
      usesSharedEventTypes: usesShared,
      updatedAt: Date.now(),
    });
    log.info("booking_setup.team_uses_shared.set", { tenantId, teamId, usesShared });
    return null;
  },
});

function sortingOf(config: Doc<"eventTypeConfigs">): Sorting {
  if (config.notSalesCallAt !== undefined) {
    return { kind: "not_sales_call" };
  }
  if (config.bookingProgramMappingStatus === "mapped" && config.bookingProgramId) {
    return {
      kind: "program",
      programId: config.bookingProgramId,
      mode: schedulingModeOf(config),
    };
  }
  return { kind: "unsorted" };
}

// Sorts an event type: into a program with a scheduling mode, back to the
// inbox, or out of booking setup as not a sales call. Cells that pointed at it
// and no longer match show as broken on the board. Returns the previous
// sorting so the inbox can undo.
export const sortEventType = mutation({
  args: {
    eventTypeConfigId: v.id("eventTypeConfigs"),
    sorting: sortingValidator,
  },
  returns: sortingValidator,
  handler: async (ctx, { eventTypeConfigId, sorting }) => {
    const { tenantId } = await requireTenantUser(ctx, [...ADMIN_ROLES]);
    const config = await ctx.db.get("eventTypeConfigs", eventTypeConfigId);
    if (!config || config.tenantId !== tenantId) {
      throw rejectRequest("booking_setup.event_type_not_found", "Event type not found.", {
        tenantId,
      });
    }
    const previous = sortingOf(config);
    const now = Date.now();

    if (sorting.kind === "program") {
      const program = await ctx.db.get("tenantPrograms", sorting.programId);
      if (!program || program.tenantId !== tenantId || program.archivedAt !== undefined) {
        throw rejectRequest("booking_setup.program_not_found", "Program not found.", {
          tenantId,
        });
      }
      await ctx.db.patch("eventTypeConfigs", eventTypeConfigId, {
        bookingProgramId: program._id,
        bookingProgramName: program.name,
        bookingProgramMappingStatus: "mapped",
        isExtended: sorting.mode === "extended",
        notSalesCallAt: undefined,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch("eventTypeConfigs", eventTypeConfigId, {
        bookingProgramId: undefined,
        bookingProgramName: undefined,
        bookingProgramMappingStatus: "unmapped",
        notSalesCallAt: sorting.kind === "not_sales_call" ? now : undefined,
        updatedAt: now,
      });
    }
    log.info("booking_setup.event_type.sorted", {
      tenantId,
      eventTypeConfigId,
      from: previous.kind,
      to: sorting.kind,
    });
    return previous;
  },
});

// Sets (or clears) an event type's booking URL from the coverage picker or
// the event type sheet, without touching its other details. An admin's URL is
// `admin_entered`; Undo passes `restoreSource` to put back where the old URL
// came from (a Calendly-synced URL keeps syncing).
export const setEventTypeBookingUrl = mutation({
  args: {
    eventTypeConfigId: v.id("eventTypeConfigs"),
    bookingBaseUrl: v.union(v.string(), v.null()),
    restoreSource: v.optional(
      v.union(
        v.literal("admin_entered"),
        v.literal("imported_sheet"),
        v.literal("calendly_synced"),
      ),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { eventTypeConfigId, bookingBaseUrl, restoreSource }) => {
    const { tenantId } = await requireTenantUser(ctx, [...ADMIN_ROLES]);
    const config = await ctx.db.get("eventTypeConfigs", eventTypeConfigId);
    if (!config || config.tenantId !== tenantId) {
      throw rejectRequest("booking_setup.event_type_not_found", "Event type not found.", {
        tenantId,
      });
    }
    const trimmed = bookingBaseUrl?.trim() || undefined;
    if (trimmed) {
      let parsed: URL | null = null;
      try {
        parsed = new URL(trimmed);
      } catch {
        parsed = null;
      }
      if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
        throw rejectRequest(
          "booking_setup.invalid_booking_url",
          "Booking URL must be a full http or https link.",
          { tenantId },
        );
      }
    }
    await ctx.db.patch("eventTypeConfigs", eventTypeConfigId, {
      bookingBaseUrl: trimmed,
      bookingUrlSource: trimmed ? (restoreSource ?? "admin_entered") : undefined,
      updatedAt: Date.now(),
    });
    log.info("booking_setup.event_type.booking_url_set", {
      tenantId,
      eventTypeConfigId,
      cleared: trimmed === undefined,
    });
    return null;
  },
});
