import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import {
  cellIssue,
  indexRoutes,
  isCalendlyBookable,
  linkIssue,
  resolveSharedCell,
  resolveTeamCell,
  SCHEDULING_MODES,
  type CellIssue,
  type ResolvedCell,
  type SchedulingMode,
} from "@/convex/lib/bookingSetup/coverage";

export type Coverage = FunctionReturnType<typeof api.bookingSetup.queries.getCoverage>;
export type CoverageProgram = Coverage["programs"][number];
export type CoverageTeam = Coverage["teams"][number];
export type CoverageEventType = Coverage["eventTypes"][number];

export type { CellIssue, ResolvedCell, SchedulingMode };
export { SCHEDULING_MODES, cellIssue, linkIssue };

/** Where an event type stands in booking setup. */
export type EventTypeStatus =
  | "unsorted" // needs a decision: in the inbox
  | "sorted" // counts for a program
  | "not_sales_call" // sorted out on purpose
  | "gone"; // inactive, deleted or no longer returned by Calendly, never sorted

export function eventTypeStatus(eventType: CoverageEventType): EventTypeStatus {
  if (eventType.notSalesCallAt !== undefined) return "not_sales_call";
  if (eventType.bookingProgramMappingStatus === "mapped" && eventType.bookingProgramId) {
    return "sorted";
  }
  return isCalendlyBookable(eventType) ? "unsorted" : "gone";
}

export function eventTypeName(eventType: Pick<CoverageEventType, "displayName">) {
  return eventType.displayName;
}

export function modeOf(eventType: Pick<CoverageEventType, "isExtended">): SchedulingMode {
  return eventType.isExtended === true ? "extended" : "normal";
}

export type BoardCell = {
  programId: CoverageProgram["_id"];
  mode: SchedulingMode;
  // null: the Shared column.
  teamId: CoverageTeam["_id"] | null;
  resolved: ResolvedCell;
};

/** The board's state, derived once per coverage snapshot. */
export function buildBoard(coverage: Coverage) {
  const eventTypesById = new Map(coverage.eventTypes.map((eventType) => [eventType._id as string, eventType]));
  const sharedByKey = indexRoutes(coverage.sharedRoutes);
  const routesByTeam = new Map<string, typeof coverage.teamRoutes>();
  for (const route of coverage.teamRoutes) {
    const list = routesByTeam.get(route.teamId) ?? [];
    list.push(route);
    routesByTeam.set(route.teamId, list);
  }
  const teamRouteIndex = new Map(
    [...routesByTeam.entries()].map(([teamId, routes]) => [teamId, indexRoutes(routes)]),
  );
  const programs = coverage.programs.filter((program) => program.archivedAt === undefined);
  const teams = coverage.teams.filter((team) => team.isActive);

  const key = (programId: string, mode: SchedulingMode) => `${programId}:${mode}`;

  function sharedCell(programId: string, mode: SchedulingMode): ResolvedCell {
    return resolveSharedCell(sharedByKey.get(key(programId, mode)), eventTypesById);
  }

  function teamCell(team: CoverageTeam, programId: string, mode: SchedulingMode): ResolvedCell {
    return resolveTeamCell({
      usesShared: team.usesShared,
      ownRoute: teamRouteIndex.get(team._id)?.get(key(programId, mode)),
      sharedRoute: sharedByKey.get(key(programId, mode)),
      eventTypesById,
    });
  }

  // Header figures: every team cell (active teams × active programs × 2).
  let covered = 0;
  let broken = 0;
  let noLink = 0;
  for (const program of programs) {
    for (const mode of SCHEDULING_MODES) {
      const shared = sharedCell(program._id, mode);
      if (shared.kind !== "none" && shared.issue) broken += 1;
      for (const team of teams) {
        const cell = teamCell(team, program._id, mode);
        if (cell.kind === "none") {
          if (cell.reason === "empty") noLink += 1;
        } else if (cell.issue) {
          if (cell.kind === "own") broken += 1;
          else noLink += 1;
        } else {
          covered += 1;
        }
      }
    }
  }

  // Event type id -> the cells that point at it (own cells only).
  const placements = new Map<string, Array<{ teamId: string | null; programId: string; mode: SchedulingMode }>>();
  const addPlacement = (eventTypeConfigId: string, placement: { teamId: string | null; programId: string; mode: SchedulingMode }) => {
    const list = placements.get(eventTypeConfigId) ?? [];
    list.push(placement);
    placements.set(eventTypeConfigId, list);
  };
  for (const route of coverage.sharedRoutes) {
    addPlacement(route.eventTypeConfigId, { teamId: null, programId: route.programId, mode: route.mode });
  }
  for (const route of coverage.teamRoutes) {
    addPlacement(route.eventTypeConfigId, { teamId: route.teamId, programId: route.programId, mode: route.mode });
  }

  const inbox = coverage.eventTypes.filter((eventType) => eventTypeStatus(eventType) === "unsorted");

  return {
    programs,
    teams,
    eventTypesById,
    sharedCell,
    teamCell,
    placements,
    inbox,
    figures: {
      cells: programs.length * SCHEDULING_MODES.length * teams.length,
      covered,
      noLink,
      broken,
      unsorted: inbox.length,
    },
  };
}

export type Board = ReturnType<typeof buildBoard>;

/**
 * A suggested program and mode for an unsorted event type, from its name.
 * Program names are matched as whole words after normalising (case, emoji,
 * punctuation); "extended" or "standard" in the name suggests Standard.
 */
export function suggestSorting(
  eventType: Pick<CoverageEventType, "displayName" | "calendlyName">,
  programs: ReadonlyArray<Pick<CoverageProgram, "_id" | "name">>,
): { programId: CoverageProgram["_id"]; mode: SchedulingMode; reason: string } | null {
  const name = normalizeWords(`${eventType.displayName} ${eventType.calendlyName ?? ""}`);
  let best: { program: (typeof programs)[number]; score: number } | null = null;
  for (const program of programs) {
    const words = normalizeWords(program.name).split(" ").filter(Boolean);
    if (words.length === 0) continue;
    const phrase = ` ${words.join(" ")} `;
    const score = ` ${name} `.includes(phrase) ? words.join(" ").length : 0;
    if (score > 0 && (!best || score > best.score)) best = { program, score };
  }
  if (!best) return null;
  const extended = /\b(extended|standard|ext)\b/.test(name);
  return {
    programId: best.program._id,
    mode: extended ? "extended" : "normal",
    reason: `Name contains "${best.program.name}"${extended ? ` and "${/\bstandard\b/.test(name) ? "standard" : "extended"}"` : ""}`,
  };
}

function normalizeWords(value: string) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Sorting an event type (Inbox and Event types)
// ---------------------------------------------------------------------------

/** What `sortEventType` takes and returns. */
export type EventTypeSorting =
  | { kind: "program"; programId: CoverageProgram["_id"]; mode: SchedulingMode }
  | { kind: "unsorted" }
  | { kind: "not_sales_call" };

const MODE_WORD: Record<SchedulingMode, string> = { normal: "Priority", extended: "Standard" };

/** "Priority" or "Standard". */
export function modeLabel(mode: SchedulingMode) {
  return MODE_WORD[mode];
}

/** The event type's row as `sortEventType` will leave it, for optimistic updates. */
export function withSorting(eventType: CoverageEventType, sorting: EventTypeSorting, now: number): CoverageEventType {
  if (sorting.kind === "program") {
    return {
      ...eventType,
      bookingProgramId: sorting.programId,
      bookingProgramMappingStatus: "mapped",
      isExtended: sorting.mode === "extended",
      notSalesCallAt: undefined,
    };
  }
  return {
    ...eventType,
    bookingProgramId: undefined,
    bookingProgramMappingStatus: "unmapped",
    notSalesCallAt: sorting.kind === "not_sales_call" ? now : undefined,
  };
}

/** "25K Accelerator · Priority", "Not a sales call" or "the inbox". */
export function sortingLabel(
  sorting: EventTypeSorting,
  programsById: ReadonlyMap<string, Pick<CoverageProgram, "name">>,
) {
  if (sorting.kind === "program") {
    return `${programsById.get(sorting.programId)?.name ?? "a program"} · ${modeLabel(sorting.mode)}`;
  }
  return sorting.kind === "not_sales_call" ? "Not a sales call" : "the inbox";
}

const POOLING_LABEL: Record<string, string> = {
  round_robin: "Round robin",
  collective: "Collective",
  multi_pool: "Multi-pool",
};

/** Calendly's pooling type in words: "Round robin", or "One host" when it has none. */
export function poolingLabel(poolingType: string | undefined) {
  if (!poolingType) return "One host";
  return POOLING_LABEL[poolingType] ?? poolingType.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** "30 min · Round robin", the meta line under an event type's name. */
export function eventTypeFacts(eventType: Pick<CoverageEventType, "calendlyDurationMinutes" | "calendlyPoolingType">) {
  const parts: string[] = [];
  if (eventType.calendlyDurationMinutes !== undefined) parts.push(`${eventType.calendlyDurationMinutes} min`);
  parts.push(poolingLabel(eventType.calendlyPoolingType));
  return parts.join(" · ");
}

/** Calendly's name when the admin renamed the event type, else null. */
export function calendlyNameIfDifferent(eventType: Pick<CoverageEventType, "displayName" | "calendlyName">) {
  const calendlyName = eventType.calendlyName?.trim();
  return calendlyName && calendlyName !== eventType.displayName.trim() ? calendlyName : null;
}

export type Placement = { teamId: string | null; programId: string; mode: SchedulingMode };

/** Where coverage uses an event type: "Shared + 2 teams", "1 team", or null when nowhere. */
export function usedInLabel(placements: readonly Placement[] | undefined) {
  if (!placements || placements.length === 0) return null;
  const shared = placements.some((placement) => placement.teamId === null);
  const teams = new Set(placements.flatMap((placement) => (placement.teamId === null ? [] : [placement.teamId]))).size;
  const teamWords = teams === 0 ? null : `${teams} ${teams === 1 ? "team" : "teams"}`;
  if (shared && teamWords) return `Shared + ${teamWords}`;
  return shared ? "Shared" : teamWords;
}
