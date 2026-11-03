import { CELL_ISSUE_LABEL } from "@/convex/lib/bookingSetup/coverage";
import {
  SCHEDULING_MODES,
  type Board,
  type Coverage,
  type CoverageEventType,
  type CoverageProgram,
  type CoverageTeam,
  type SchedulingMode,
} from "../booking-model";

/**
 * What a team's DM closers get in one program and lane, in concept B's words:
 * their own route, the Shared link, nothing because Shared is empty, nothing
 * because the team doesn't use Shared, or a link that can't book.
 */
export type LaneAccess =
  | { word: "own" | "shared"; eventType: CoverageEventType | undefined }
  | { word: "broken"; eventType: CoverageEventType | undefined; inherited: boolean; reason: string }
  | { word: "no_link" | "not_offered" };

export const ACCESS_WORD: Record<LaneAccess["word"], string> = {
  own: "Own route",
  shared: "From Shared",
  broken: "Broken",
  no_link: "No link",
  not_offered: "Not offered",
};

export const ACCESS_TONE: Record<LaneAccess["word"], string> = {
  own: "text-foreground",
  shared: "text-muted-foreground",
  broken: "text-danger-ink",
  no_link: "text-warning-ink",
  not_offered: "text-muted-foreground",
};

export function laneAccess(board: Board, team: CoverageTeam, programId: string, mode: SchedulingMode): LaneAccess {
  const cell = board.teamCell(team, programId, mode);
  if (cell.kind === "none") return { word: cell.reason === "empty" ? "no_link" : "not_offered" };
  const eventType = board.eventTypesById.get(cell.eventTypeConfigId);
  if (cell.issue) {
    return {
      word: "broken",
      eventType,
      inherited: cell.kind === "inherited",
      reason: `${cell.kind === "inherited" ? "Shared: " : ""}${CELL_ISSUE_LABEL[cell.issue]}`,
    };
  }
  return { word: cell.kind === "own" ? "own" : "shared", eventType };
}

export function canBook(access: LaneAccess) {
  return access.word === "own" || access.word === "shared";
}

export type ProgramAccess = {
  program: CoverageProgram;
  lanes: Record<SchedulingMode, LaneAccess>;
  bookable: boolean;
};

/** Every active program with both lanes for one team, and what that adds up to. */
export function teamAccess(board: Board, coverage: Coverage, team: CoverageTeam) {
  const rows: ProgramAccess[] = board.programs.map((program) => {
    const lanes = {
      normal: laneAccess(board, team, program._id, "normal"),
      extended: laneAccess(board, team, program._id, "extended"),
    };
    return { program, lanes, bookable: SCHEDULING_MODES.some((mode) => canBook(lanes[mode])) };
  });
  const programIds = new Set(board.programs.map((program) => program._id as string));
  const ownRoutes = coverage.teamRoutes.filter(
    (route) => route.teamId === team._id && programIds.has(route.programId),
  ).length;
  const bookable = rows.filter((row) => row.bookable).length;
  return { rows, bookable, total: rows.length, ownRoutes };
}

export type TeamAccess = ReturnType<typeof teamAccess>;

/** The second line under "7 of 7 programs" on the teams table. */
export function routesLine(access: TeamAccess, usesShared: boolean) {
  if (access.ownRoutes === 0) return usesShared ? "Shared links only" : "No routes and no Shared";
  const routes = `${access.ownRoutes} own ${access.ownRoutes === 1 ? "route" : "routes"}`;
  return usesShared ? routes : `Own routes only · ${access.ownRoutes}`;
}
