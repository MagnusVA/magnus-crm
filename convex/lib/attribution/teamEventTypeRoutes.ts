import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";

export type SchedulingMode = "normal" | "extended";

// Teams × programs × 2 modes. Matches the 200-team cap in listTeams.
export const MAX_TEAM_PROGRAM_EVENT_TYPES = 2000;

type RoutedEventType = Pick<
  Doc<"eventTypeConfigs">,
  "_id" | "bookingProgramId" | "isExtended"
>;

type Route = Pick<
  Doc<"teamProgramEventTypes">,
  "teamId" | "programId" | "mode" | "eventTypeConfigId"
>;

export function schedulingModeForEventType(config: {
  isExtended?: boolean;
}): SchedulingMode {
  return config.isExtended === true ? "extended" : "normal";
}

// A route goes stale when its event type is remapped to another program or
// flips between normal and extended after the route was saved.
export function routeMatchesEventType(
  route: Route,
  config: RoutedEventType,
): boolean {
  return (
    route.eventTypeConfigId === config._id &&
    route.programId === config.bookingProgramId &&
    route.mode === schedulingModeForEventType(config)
  );
}

export type PortalEventTypeRouting = {
  // Teams with at least one route. They see only their routed event types.
  routedTeamIds: Set<Id<"attributionTeams">>;
  // Event types no team is routed to. Teams without routes see these.
  isShared: (eventTypeConfigId: Id<"eventTypeConfigs">) => boolean;
  // Teams whose current, non-stale route points at the event type.
  teamsForEventType: (
    config: RoutedEventType,
  ) => Array<Id<"attributionTeams">>;
};

export function buildPortalEventTypeRouting(
  routes: Route[],
): PortalEventTypeRouting {
  const routedTeamIds = new Set<Id<"attributionTeams">>();
  const routesByEventType = new Map<Id<"eventTypeConfigs">, Route[]>();

  for (const route of routes) {
    routedTeamIds.add(route.teamId);
    const existing = routesByEventType.get(route.eventTypeConfigId);
    if (existing) {
      existing.push(route);
    } else {
      routesByEventType.set(route.eventTypeConfigId, [route]);
    }
  }

  return {
    routedTeamIds,
    isShared: (eventTypeConfigId) => !routesByEventType.has(eventTypeConfigId),
    teamsForEventType: (config) =>
      (routesByEventType.get(config._id) ?? [])
        .filter((route) => routeMatchesEventType(route, config))
        .map((route) => route.teamId),
  };
}

export async function listTeamProgramEventTypesForTenant(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
) {
  return await ctx.db
    .query("teamProgramEventTypes")
    .withIndex("by_tenantId_and_teamId_and_programId_and_mode", (q) =>
      q.eq("tenantId", tenantId),
    )
    .take(MAX_TEAM_PROGRAM_EVENT_TYPES);
}

// Applies the same rule as the portal bootstrap for a single team and event
// type, so a copied link can't use another team's round-robin pool.
export async function canTeamUseEventType(
  ctx: QueryCtx | MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    teamId: Id<"attributionTeams">;
    eventTypeConfig: RoutedEventType;
  },
): Promise<boolean> {
  const teamRoute = await ctx.db
    .query("teamProgramEventTypes")
    .withIndex("by_tenantId_and_teamId_and_programId_and_mode", (q) =>
      q.eq("tenantId", args.tenantId).eq("teamId", args.teamId),
    )
    .first();

  if (teamRoute) {
    const programId = args.eventTypeConfig.bookingProgramId;
    if (!programId) {
      return false;
    }
    const route = await ctx.db
      .query("teamProgramEventTypes")
      .withIndex("by_tenantId_and_teamId_and_programId_and_mode", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("teamId", args.teamId)
          .eq("programId", programId)
          .eq("mode", schedulingModeForEventType(args.eventTypeConfig)),
      )
      .unique();
    return route !== null && routeMatchesEventType(route, args.eventTypeConfig);
  }

  const anyRoute = await ctx.db
    .query("teamProgramEventTypes")
    .withIndex("by_tenantId_and_eventTypeConfigId", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("eventTypeConfigId", args.eventTypeConfig._id),
    )
    .first();
  return anyRoute === null;
}
