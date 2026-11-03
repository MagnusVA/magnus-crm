import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { isPortalBookable } from "../eventTypeBookability";
import { log } from "../observability/log";
import {
  cellIssue,
  resolveTeamCell,
  schedulingModeOf,
  type SchedulingMode,
} from "./coverage";

type Ctx = QueryCtx | MutationCtx;

// Programs × 2 modes, the same bound as team routes.
export const MAX_SHARED_PROGRAM_EVENT_TYPES = 400;
const MAX_TEAMS = 200;
const MAX_EVENT_TYPES = 500;
const MAX_TEAM_ROUTES = 2000;

export function isCoverageMigrated(tenant: Pick<Doc<"tenants">, "bookingCoverageMigratedAt">) {
  return tenant.bookingCoverageMigratedAt !== undefined;
}

export function teamUsesShared(team: Pick<Doc<"attributionTeams">, "usesSharedEventTypes">) {
  return team.usesSharedEventTypes ?? true;
}

export async function listSharedRoutes(ctx: Ctx, tenantId: Id<"tenants">) {
  return await ctx.db
    .query("sharedProgramEventTypes")
    .withIndex("by_tenantId_and_programId_and_mode", (q) =>
      q.eq("tenantId", tenantId),
    )
    .take(MAX_SHARED_PROGRAM_EVENT_TYPES);
}

export async function findTeamRoute(
  ctx: Ctx,
  args: {
    tenantId: Id<"tenants">;
    teamId: Id<"attributionTeams">;
    programId: Id<"tenantPrograms">;
    mode: SchedulingMode;
  },
) {
  return await ctx.db
    .query("teamProgramEventTypes")
    .withIndex("by_tenantId_and_teamId_and_programId_and_mode", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("teamId", args.teamId)
        .eq("programId", args.programId)
        .eq("mode", args.mode),
    )
    .unique();
}

export async function findSharedRoute(
  ctx: Ctx,
  args: {
    tenantId: Id<"tenants">;
    programId: Id<"tenantPrograms">;
    mode: SchedulingMode;
  },
) {
  return await ctx.db
    .query("sharedProgramEventTypes")
    .withIndex("by_tenantId_and_programId_and_mode", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("programId", args.programId)
        .eq("mode", args.mode),
    )
    .unique();
}

// The coverage rule for one team and one event type, for a migrated tenant.
// Mirrors linkableEventTypeIdsForTeam without loading every route.
export async function canTeamLinkEventType(
  ctx: Ctx,
  args: {
    tenantId: Id<"tenants">;
    team: Doc<"attributionTeams">;
    eventTypeConfig: Doc<"eventTypeConfigs">;
  },
): Promise<boolean> {
  const programId = args.eventTypeConfig.bookingProgramId;
  if (!programId) {
    return false;
  }
  const mode = schedulingModeOf(args.eventTypeConfig);
  const [ownRoute, sharedRoute] = await Promise.all([
    findTeamRoute(ctx, {
      tenantId: args.tenantId,
      teamId: args.team._id,
      programId,
      mode,
    }),
    findSharedRoute(ctx, { tenantId: args.tenantId, programId, mode }),
  ]);
  const cell = resolveTeamCell({
    usesShared: teamUsesShared(args.team),
    ownRoute: ownRoute ?? undefined,
    sharedRoute: sharedRoute ?? undefined,
    eventTypesById: new Map([[args.eventTypeConfig._id, args.eventTypeConfig]]),
  });
  return (
    cell.kind !== "none" &&
    cell.eventTypeConfigId === args.eventTypeConfig._id &&
    cell.issue === null
  );
}

// ---------------------------------------------------------------------------
// Migration to booking coverage
// ---------------------------------------------------------------------------

export type CoverageMigrationPlan = {
  alreadyMigrated: boolean;
  // Teams with any route keep seeing only their routes: Shared off.
  teamsUsingShared: Array<Id<"attributionTeams">>;
  teamsNotUsingShared: Array<Id<"attributionTeams">>;
  // Routes to event types hidden from the portal never produced links. Under
  // coverage a route publishes, so these are removed.
  routesToRemove: Array<Id<"teamProgramEventTypes">>;
  sharedCells: Array<{
    programId: Id<"tenantPrograms">;
    mode: SchedulingMode;
    eventTypeConfigId: Id<"eventTypeConfigs">;
    // Other shared event types for the same program and mode. The portal
    // offered all of them; coverage keeps one, the most recently edited.
    dropped: Array<Id<"eventTypeConfigs">>;
  }>;
};

export async function planCoverageMigration(
  ctx: Ctx,
  tenantId: Id<"tenants">,
): Promise<CoverageMigrationPlan> {
  const tenant = await ctx.db.get("tenants", tenantId);
  if (!tenant) {
    throw new Error("Tenant not found.");
  }
  const [teams, routes, eventTypes, programs] = await Promise.all([
    ctx.db
      .query("attributionTeams")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(MAX_TEAMS),
    ctx.db
      .query("teamProgramEventTypes")
      .withIndex("by_tenantId_and_teamId_and_programId_and_mode", (q) =>
        q.eq("tenantId", tenantId),
      )
      .take(MAX_TEAM_ROUTES),
    ctx.db
      .query("eventTypeConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(MAX_EVENT_TYPES),
    ctx.db
      .query("tenantPrograms")
      .withIndex("by_tenantId_and_archivedAt", (q) =>
        q.eq("tenantId", tenantId).eq("archivedAt", undefined),
      )
      .take(200),
  ]);

  const routedTeamIds = new Set(routes.map((route) => route.teamId));
  const routedEventTypeIds = new Set(
    routes.map((route) => route.eventTypeConfigId),
  );
  const eventTypesById = new Map(eventTypes.map((config) => [config._id, config]));
  const activeProgramIds = new Set(programs.map((program) => program._id));

  // Legacy shared event types: portal-visible and bookable, no team routed.
  const candidates = new Map<string, Array<Doc<"eventTypeConfigs">>>();
  for (const config of eventTypes) {
    if (
      !isPortalBookable(config) ||
      routedEventTypeIds.has(config._id) ||
      !config.bookingProgramId ||
      !activeProgramIds.has(config.bookingProgramId)
    ) {
      continue;
    }
    const key = `${config.bookingProgramId}:${schedulingModeOf(config)}`;
    const list = candidates.get(key) ?? [];
    list.push(config);
    candidates.set(key, list);
  }

  const sharedCells: CoverageMigrationPlan["sharedCells"] = [];
  for (const list of candidates.values()) {
    list.sort(
      (left, right) =>
        (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt) ||
        right._creationTime - left._creationTime,
    );
    const [winner, ...rest] = list;
    if (!winner?.bookingProgramId) {
      continue;
    }
    sharedCells.push({
      programId: winner.bookingProgramId,
      mode: schedulingModeOf(winner),
      eventTypeConfigId: winner._id,
      dropped: rest.map((config) => config._id),
    });
  }

  return {
    alreadyMigrated: isCoverageMigrated(tenant),
    teamsUsingShared: teams
      .filter((team) => !routedTeamIds.has(team._id))
      .map((team) => team._id),
    teamsNotUsingShared: teams
      .filter((team) => routedTeamIds.has(team._id))
      .map((team) => team._id),
    routesToRemove: routes
      .filter((route) => eventTypesById.get(route.eventTypeConfigId)?.linkPortalEnabled !== true)
      .map((route) => route._id),
    sharedCells,
  };
}

export async function migrateTenantToCoverage(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
) {
  const plan = await planCoverageMigration(ctx, tenantId);
  if (plan.alreadyMigrated) {
    return { migrated: false as const };
  }
  const now = Date.now();
  for (const teamId of plan.teamsUsingShared) {
    await ctx.db.patch("attributionTeams", teamId, { usesSharedEventTypes: true });
  }
  for (const teamId of plan.teamsNotUsingShared) {
    await ctx.db.patch("attributionTeams", teamId, { usesSharedEventTypes: false });
  }
  for (const routeId of plan.routesToRemove) {
    await ctx.db.delete("teamProgramEventTypes", routeId);
  }
  // Rerunning after a partial failure is safe: the transaction is atomic, and
  // a tenant with the marker set returns above.
  for (const cell of plan.sharedCells) {
    await ctx.db.insert("sharedProgramEventTypes", {
      tenantId,
      programId: cell.programId,
      mode: cell.mode,
      eventTypeConfigId: cell.eventTypeConfigId,
      createdAt: now,
      updatedAt: now,
    });
  }
  await ctx.db.patch("tenants", tenantId, { bookingCoverageMigratedAt: now });
  log.info("booking_coverage.migrated", {
    tenantId,
    teamsUsingShared: plan.teamsUsingShared.length,
    teamsNotUsingShared: plan.teamsNotUsingShared.length,
    routesRemoved: plan.routesToRemove.length,
    sharedCells: plan.sharedCells.length,
    sharedEventTypesDropped: plan.sharedCells.reduce(
      (sum, cell) => sum + cell.dropped.length,
      0,
    ),
  });
  return { migrated: true as const, plan };
}

// Used by the assert migration: the tenant is marked, and every Shared cell
// points at an event type that exists.
export async function assertTenantOnCoverage(ctx: Ctx, tenantId: Id<"tenants">) {
  const tenant = await ctx.db.get("tenants", tenantId);
  if (!tenant || !isCoverageMigrated(tenant)) {
    throw new Error(`Tenant ${tenantId} is not on booking coverage`);
  }
  const shared = await listSharedRoutes(ctx, tenantId);
  for (const route of shared) {
    const config = await ctx.db.get("eventTypeConfigs", route.eventTypeConfigId);
    const issue = cellIssue(route, config ?? undefined);
    if (issue === "missing_event_type") {
      throw new Error(`Shared cell ${route._id} points at a missing event type`);
    }
  }
}
