// Booking coverage: which event type each DM team's portal links use, per
// program and scheduling mode. Pure, so the portal, the copy check and the
// admin board all apply the same rule.
//
// A team's cell resolves to its own route when it has one. Without one, a
// team that uses Shared gets the Shared cell for that program and mode; a team
// that doesn't gets nothing there.

export type SchedulingMode = "normal" | "extended";

export const SCHEDULING_MODES: readonly SchedulingMode[] = [
  "normal",
  "extended",
];

export const SCHEDULING_MODE_LABEL: Record<SchedulingMode, string> = {
  normal: "Priority",
  extended: "Standard",
};

export type CoverageEventType = {
  _id: string;
  bookingProgramId?: string;
  bookingProgramMappingStatus?: "mapped" | "unmapped";
  isExtended?: boolean;
  bookingBaseUrl?: string;
  bookingUrlSource?: "admin_entered" | "imported_sheet" | "calendly_synced";
  calendlySchedulingUrl?: string;
  calendlySyncStatus?: "active" | "inactive" | "deleted" | "not_returned";
};

export type CoverageRoute<Id extends string = string> = {
  programId: Id;
  mode: SchedulingMode;
  eventTypeConfigId: Id;
};

// Why a cell's event type can't produce a working link.
export type CellIssue =
  | "missing_event_type"
  | "wrong_program"
  | "wrong_mode"
  | "calendly_unavailable"
  | "missing_url";

export const CELL_ISSUE_LABEL: Record<CellIssue, string> = {
  missing_event_type: "Event type no longer exists",
  wrong_program: "Event type now counts for another program",
  wrong_mode: "Event type changed scheduling mode",
  calendly_unavailable: "Inactive or deleted in Calendly",
  missing_url: "No booking URL",
};

export function schedulingModeOf(config: {
  isExtended?: boolean;
}): SchedulingMode {
  return config.isExtended === true ? "extended" : "normal";
}

export function isCalendlyBookable(config: {
  calendlySyncStatus?: CoverageEventType["calendlySyncStatus"];
}) {
  return (
    config.calendlySyncStatus === undefined ||
    config.calendlySyncStatus === "active"
  );
}

// Whether the event type can produce a link at all, wherever it is placed.
export function linkIssue(
  config: CoverageEventType,
): "calendly_unavailable" | "missing_url" | null {
  if (!isCalendlyBookable(config)) {
    return "calendly_unavailable";
  }
  const hasTrustedBaseUrl =
    config.bookingUrlSource !== "calendly_synced" ||
    Boolean(config.calendlySchedulingUrl);
  if (!config.bookingBaseUrl || !hasTrustedBaseUrl) {
    return "missing_url";
  }
  return null;
}

export function cellIssue(
  route: CoverageRoute,
  config: CoverageEventType | undefined,
): CellIssue | null {
  if (!config) {
    return "missing_event_type";
  }
  if (
    config.bookingProgramMappingStatus !== "mapped" ||
    config.bookingProgramId !== route.programId
  ) {
    return "wrong_program";
  }
  if (schedulingModeOf(config) !== route.mode) {
    return "wrong_mode";
  }
  return linkIssue(config);
}

export type ResolvedCell =
  | {
      // The team's own route, or the Shared column's own cell.
      kind: "own" | "inherited";
      eventTypeConfigId: string;
      issue: CellIssue | null;
    }
  | {
      // "empty": nothing set here (or in Shared, for a team that uses it).
      // "not_offered": the team doesn't use Shared and has no route here.
      kind: "none";
      reason: "empty" | "not_offered";
    };

export function cellKey(programId: string, mode: SchedulingMode) {
  return `${programId}:${mode}`;
}

export function indexRoutes<R extends CoverageRoute>(routes: readonly R[]) {
  return new Map(
    routes.map((route) => [cellKey(route.programId, route.mode), route]),
  );
}

export function resolveSharedCell(
  sharedRoute: CoverageRoute | undefined,
  eventTypesById: ReadonlyMap<string, CoverageEventType>,
): ResolvedCell {
  if (!sharedRoute) {
    return { kind: "none", reason: "empty" };
  }
  return {
    kind: "own",
    eventTypeConfigId: sharedRoute.eventTypeConfigId,
    issue: cellIssue(
      sharedRoute,
      eventTypesById.get(sharedRoute.eventTypeConfigId),
    ),
  };
}

export function resolveTeamCell(args: {
  usesShared: boolean;
  ownRoute: CoverageRoute | undefined;
  sharedRoute: CoverageRoute | undefined;
  eventTypesById: ReadonlyMap<string, CoverageEventType>;
}): ResolvedCell {
  const { usesShared, ownRoute, sharedRoute, eventTypesById } = args;
  if (ownRoute) {
    return {
      kind: "own",
      eventTypeConfigId: ownRoute.eventTypeConfigId,
      issue: cellIssue(ownRoute, eventTypesById.get(ownRoute.eventTypeConfigId)),
    };
  }
  if (!usesShared) {
    return { kind: "none", reason: "not_offered" };
  }
  const shared = resolveSharedCell(sharedRoute, eventTypesById);
  return shared.kind === "none"
    ? shared
    : { ...shared, kind: "inherited" };
}

// The event types a team's DM closers can generate links for: every cell that
// resolves to an event type with no issue.
export function linkableEventTypeIdsForTeam(args: {
  usesShared: boolean;
  teamRoutes: readonly CoverageRoute[];
  sharedRoutes: readonly CoverageRoute[];
  eventTypesById: ReadonlyMap<string, CoverageEventType>;
}): Set<string> {
  const own = indexRoutes(args.teamRoutes);
  const shared = indexRoutes(args.sharedRoutes);
  const keys = new Set([...own.keys(), ...(args.usesShared ? shared.keys() : [])]);
  const result = new Set<string>();
  for (const key of keys) {
    const cell = resolveTeamCell({
      usesShared: args.usesShared,
      ownRoute: own.get(key),
      sharedRoute: shared.get(key),
      eventTypesById: args.eventTypesById,
    });
    if (cell.kind !== "none" && cell.issue === null) {
      result.add(cell.eventTypeConfigId);
    }
  }
  return result;
}
