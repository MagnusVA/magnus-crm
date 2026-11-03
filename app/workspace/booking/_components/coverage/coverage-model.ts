import { CELL_ISSUE_LABEL, cellKey, resolveTeamCell } from "@/convex/lib/bookingSetup/coverage";
import {
  eventTypeStatus,
  linkIssue,
  modeLabel,
  modeOf,
  SCHEDULING_MODES,
  type Board,
  type CellIssue,
  type Coverage,
  type CoverageEventType,
  type CoverageProgram,
  type CoverageTeam,
  type ResolvedCell,
  type SchedulingMode,
} from "../booking-model";

export { CELL_ISSUE_LABEL, modeLabel };

/** A cell of the matrix: a team's (or Shared's) Priority or Standard link for a program. */
export type CellRef = {
  // null: the Shared column.
  teamId: string | null;
  programId: string;
  mode: SchedulingMode;
};

export function refKey(ref: CellRef) {
  return `${ref.teamId ?? "shared"}|${ref.programId}|${ref.mode}`;
}

const MODE_SLUG: Record<SchedulingMode, string> = { normal: "priority", extended: "standard" };

/** `?cell=shared.<programId>.priority`, `?cell=<teamId>.<programId>.standard`. */
export function cellParam(ref: CellRef) {
  return `${ref.teamId ?? "shared"}.${ref.programId}.${MODE_SLUG[ref.mode]}`;
}

export function parseCellParam(value: string | null, board: Board): CellRef | null {
  if (!value) return null;
  const [scope, programId, modeSlug] = value.split(".");
  const mode: SchedulingMode | null =
    modeSlug === "priority" || modeSlug === "normal" ? "normal" : modeSlug === "standard" || modeSlug === "extended" ? "extended" : null;
  if (!scope || !programId || !mode) return null;
  if (!board.programs.some((program) => program._id === programId)) return null;
  if (scope === "shared") return { teamId: null, programId, mode };
  if (!board.teams.some((team) => team._id === scope)) return null;
  return { teamId: scope, programId, mode };
}

/** Short words for a broken cell's chip. */
export const ISSUE_WORD: Record<CellIssue, string> = {
  missing_event_type: "Gone",
  wrong_program: "Other program",
  wrong_mode: "Wrong mode",
  calendly_unavailable: "Inactive",
  missing_url: "No URL",
};

/** Why a broken cell can't build a link, as the end of a sentence. */
export const ISSUE_WHY: Record<CellIssue, string> = {
  missing_event_type: "the event type no longer exists",
  wrong_program: "it now counts for another program",
  wrong_mode: "its scheduling mode doesn’t match this cell",
  calendly_unavailable: "it is inactive or deleted in Calendly, so nobody can book it",
  missing_url: "it has no booking URL, so the portal can’t build a link",
};

/** What a half-cell shows. */
export type CellFace =
  | { kind: "own"; eventType: CoverageEventType | undefined }
  | { kind: "inherited"; eventType: CoverageEventType | undefined }
  | { kind: "broken"; eventType: CoverageEventType | undefined; issue: CellIssue; inherited: boolean }
  // Shared: empty and teams inherit it. Team: uses Shared and Shared is empty.
  | { kind: "gap"; inheritors: number }
  | { kind: "off" }
  // Shared: empty and no team inherits it.
  | { kind: "empty" };

export function faceOf(board: Board, resolved: ResolvedCell, ref: CellRef): CellFace {
  if (resolved.kind === "none") {
    if (resolved.reason === "not_offered") return { kind: "off" };
    if (ref.teamId === null) {
      const inheritors = inheritorsOf(board, ref.programId, ref.mode).length;
      return inheritors > 0 ? { kind: "gap", inheritors } : { kind: "empty" };
    }
    return { kind: "gap", inheritors: 0 };
  }
  const eventType = board.eventTypesById.get(resolved.eventTypeConfigId);
  if (resolved.issue) {
    return { kind: "broken", eventType, issue: resolved.issue, inherited: resolved.kind === "inherited" };
  }
  return { kind: resolved.kind, eventType };
}

export function isProblem(face: CellFace) {
  return face.kind === "gap" || face.kind === "broken";
}

export function isWorking(face: CellFace) {
  return face.kind === "own" || face.kind === "inherited";
}

/** A short signature, so a half can flip when what it shows changes. */
export function faceSignature(face: CellFace) {
  switch (face.kind) {
    case "own":
    case "inherited":
      return `${face.kind}:${face.eventType?._id ?? ""}`;
    case "broken":
      return `broken:${face.eventType?._id ?? ""}:${face.issue}`;
    case "gap":
      return `gap:${face.inheritors}`;
    default:
      return face.kind;
  }
}

export function resolveRef(board: Board, ref: CellRef): ResolvedCell {
  if (ref.teamId === null) return board.sharedCell(ref.programId, ref.mode);
  const team = board.teams.find((candidate) => candidate._id === ref.teamId);
  return team ? board.teamCell(team, ref.programId, ref.mode) : { kind: "none", reason: "empty" };
}

/** Teams that use Shared and have nothing of their own in this cell. */
export function inheritorsOf(board: Board, programId: string, mode: SchedulingMode) {
  return board.teams.filter((team) => team.usesShared && board.teamCell(team, programId, mode).kind !== "own");
}

/** The team's own event type in this cell, if it has one. */
export function ownRouteId(board: Board, ref: CellRef) {
  const resolved = resolveRef(board, ref);
  return resolved.kind === "own" ? resolved.eventTypeConfigId : null;
}

export type Tally = { working: number; problems: number; total: number };

/** Working and problem cells per team, per program, and for the Shared column. */
export function tallies(board: Board) {
  const teams = new Map<string, Tally>();
  const programs = new Map<string, Tally & { routed: boolean }>();
  for (const team of board.teams) teams.set(team._id, { working: 0, problems: 0, total: 0 });
  let sharedFilled = 0;
  for (const program of board.programs) {
    const row = { working: 0, problems: 0, total: 0, routed: false };
    for (const mode of SCHEDULING_MODES) {
      const shared = board.sharedCell(program._id, mode);
      if (shared.kind !== "none") {
        sharedFilled += 1;
        row.routed = true;
        if (shared.issue) row.problems += 1;
      }
      for (const team of board.teams) {
        const tally = teams.get(team._id)!;
        const cell = board.teamCell(team, program._id, mode);
        tally.total += 1;
        row.total += 1;
        if (cell.kind === "own") row.routed = true;
        if (cell.kind === "none") {
          if (cell.reason === "empty") {
            tally.problems += 1;
            row.problems += 1;
          }
        } else if (cell.issue) {
          tally.problems += 1;
          row.problems += 1;
        } else {
          tally.working += 1;
          row.working += 1;
        }
      }
    }
    programs.set(program._id, row);
  }
  return { teams, programs, sharedFilled };
}

/** Event types sorted into a program (not "Not a sales call"). */
export function eventTypesOfProgram(coverage: Coverage, programId: string) {
  return coverage.eventTypes.filter(
    (eventType) => eventTypeStatus(eventType) === "sorted" && eventType.bookingProgramId === programId,
  );
}

/** How many cells a team gains (positive) or loses if its "uses Shared" switch flips. */
export function usesSharedDelta(board: Board, coverage: Coverage, team: CoverageTeam) {
  const eventTypesById = board.eventTypesById;
  const shared = new Map(coverage.sharedRoutes.map((route) => [cellKey(route.programId, route.mode), route]));
  const own = new Map(
    coverage.teamRoutes.filter((route) => route.teamId === team._id).map((route) => [cellKey(route.programId, route.mode), route]),
  );
  let delta = 0;
  for (const program of board.programs) {
    for (const mode of SCHEDULING_MODES) {
      const args = { ownRoute: own.get(cellKey(program._id, mode)), sharedRoute: shared.get(cellKey(program._id, mode)), eventTypesById };
      const works = (cell: ResolvedCell) => cell.kind !== "none" && cell.issue === null;
      const now = works(resolveTeamCell({ ...args, usesShared: team.usesShared }));
      const flipped = works(resolveTeamCell({ ...args, usesShared: !team.usesShared }));
      if (now !== flipped) delta += flipped ? 1 : -1;
    }
  }
  return delta;
}

/** Where coverage puts an event type: "Shared, DmTeam1". */
export function usedByNames(board: Board, eventTypeConfigId: string) {
  const placements = board.placements.get(eventTypeConfigId) ?? [];
  const names = new Set<string>();
  for (const placement of placements) {
    if (placement.teamId === null) names.add("Shared");
    else {
      const team = board.teams.find((candidate) => candidate._id === placement.teamId);
      if (team) names.add(team.displayName);
    }
  }
  return [...names];
}

// ---------------------------------------------------------------------------
// What a DM closer's portal gives them
// ---------------------------------------------------------------------------

export type CloserLink = {
  mode: SchedulingMode;
  face: CellFace;
  // Where the link comes from: the team's own cell or the Shared cell.
  source: "own" | "shared" | null;
};

export type CloserProgramLinks = { program: CoverageProgram; links: CloserLink[] };

export function closerLinks(board: Board, team: CoverageTeam): CloserProgramLinks[] {
  return board.programs.map((program) => ({
    program,
    links: SCHEDULING_MODES.map((mode) => {
      const ref = { teamId: team._id, programId: program._id, mode };
      const resolved = board.teamCell(team, program._id, mode);
      const face = faceOf(board, resolved, ref);
      const source = resolved.kind === "own" ? "own" : resolved.kind === "inherited" ? "shared" : null;
      return { mode, face, source };
    }),
  }));
}

// ---------------------------------------------------------------------------
// The cell picker's groups
// ---------------------------------------------------------------------------

export type PickerFix =
  | { kind: "set_url" }
  | { kind: "switch_mode" }
  // Nothing to do from here: the reason says why.
  | { kind: "in_use" }
  | { kind: "calendly" };

export type PickerSections = {
  ready: CoverageEventType[];
  fix: Array<{ eventType: CoverageEventType; fix: PickerFix; why: string }>;
  unsorted: CoverageEventType[];
  unsortedMore: number;
  other: CoverageEventType[];
};

export function normalizeSearch(value: string) {
  return value.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function pickerSections(
  board: Board,
  ref: CellRef,
  query: string,
  bookings: Record<string, number>,
): PickerSections {
  const q = normalizeSearch(query);
  const matches = (eventType: CoverageEventType) =>
    !q || normalizeSearch(`${eventType.displayName} ${eventType.calendlyName ?? ""}`).includes(q);
  const pool = [...board.eventTypesById.values()].filter(matches);
  const rowIds = new Set(
    [null, ...board.teams.map((team) => team._id as string)]
      .map((teamId) => ownRouteId(board, { ...ref, teamId }))
      .filter(Boolean),
  );
  const byUse = (left: CoverageEventType, right: CoverageEventType) =>
    Number(rowIds.has(right._id)) - Number(rowIds.has(left._id)) ||
    (bookings[right._id] ?? 0) - (bookings[left._id] ?? 0) ||
    left.displayName.localeCompare(right.displayName);

  const inProgram = pool.filter(
    (eventType) => eventTypeStatus(eventType) === "sorted" && eventType.bookingProgramId === ref.programId,
  );
  const ready = inProgram.filter((eventType) => modeOf(eventType) === ref.mode && linkIssue(eventType) === null).sort(byUse);
  const fix = inProgram
    .filter((eventType) => !(modeOf(eventType) === ref.mode && linkIssue(eventType) === null))
    .sort(byUse)
    .map((eventType) => {
      const issue = linkIssue(eventType);
      if (issue === "calendly_unavailable") {
        return { eventType, fix: { kind: "calendly" } as const, why: ISSUE_WHY.calendly_unavailable };
      }
      if (issue === "missing_url") {
        // Saving a URL and then assigning only works in its own mode.
        if (modeOf(eventType) !== ref.mode) {
          return {
            eventType,
            fix: { kind: "in_use" } as const,
            why: `${ISSUE_WHY.missing_url}, and it is a ${modeLabel(modeOf(eventType))} event type`,
          };
        }
        return { eventType, fix: { kind: "set_url" } as const, why: ISSUE_WHY.missing_url };
      }
      const why = `it is a ${modeLabel(modeOf(eventType))} event type`;
      // Switching the mode would break every cell that already uses it in
      // its current mode, so only offer it for an event type nobody uses.
      const usedBy = usedByNames(board, eventType._id);
      if (usedBy.length > 0) {
        return {
          eventType,
          fix: { kind: "in_use" } as const,
          why: `${why}, used by ${usedBy.join(", ")}`,
        };
      }
      return { eventType, fix: { kind: "switch_mode" } as const, why };
    });
  const unsortedAll = pool.filter((eventType) => eventTypeStatus(eventType) === "unsorted").sort(byUse);
  const unsorted = q ? unsortedAll : unsortedAll.slice(0, 3);
  const other = q
    ? pool.filter((eventType) => eventTypeStatus(eventType) === "sorted" && eventType.bookingProgramId !== ref.programId)
    : [];
  return { ready, fix, unsorted, unsortedMore: unsortedAll.length - unsorted.length, other };
}

/** True when a program's name reads like an event type's (it was made from one). */
export function looksLikeEventTypeName(coverage: Coverage, program: CoverageProgram) {
  const name = normalizeSearch(program.name);
  if (!name) return false;
  return coverage.eventTypes.some(
    (eventType) => normalizeSearch(eventType.displayName) === name || normalizeSearch(eventType.calendlyName ?? "") === name,
  );
}

export function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

export function firstName(name: string) {
  return name.trim().split(/\s+/)[0] ?? name;
}
