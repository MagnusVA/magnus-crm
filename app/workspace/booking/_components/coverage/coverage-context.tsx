"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { Board, Coverage } from "../booking-model";
import { cellParam, parseCellParam, tallies, type CellRef } from "./coverage-model";
import { useCoverageActions, type CoverageActions } from "./use-coverage-actions";

export type DmCloser = FunctionReturnType<typeof api.attribution.dmClosers.listDmClosers>[number];

/** The cell under the pointer: its row and column light up. */
export type Hover = { programId: string; column: string } | null;

type CoverageContextValue = {
  coverage: Coverage;
  board: Board;
  tally: ReturnType<typeof tallies>;
  // Bookings in the last 30 days per event type id.
  bookings: Record<string, number>;
  activityLoaded: boolean;
  closers: DmCloser[] | undefined;
  disabled: boolean;
  actions: CoverageActions;

  cell: CellRef | null;
  openCell: (ref: CellRef | null) => void;
  programId: string | null;
  openProgram: (programId: string | null) => void;
  teamId: string | null;
  openTeam: (teamId: string | null) => void;
  problemsOnly: boolean;
  setProblemsOnly: (on: boolean) => void;

  previewCloserId: string | null;
  setPreviewCloser: (closerId: string) => void;
  previewTeamId: string | null;
  xray: boolean;
  setXray: (on: boolean) => void;

  hover: Hover;
  setHover: (hover: Hover) => void;
  // A cell lit from the phone (refKey), or a phone tile lit from the matrix ("programId|mode").
  litCell: string | null;
  setLitCell: (key: string | null) => void;
  litTile: string | null;
  setLitTile: (key: string | null) => void;

  // Teams the last change reached, when the previewed closer isn't on one.
  hint: string[] | null;
  dismissHint: () => void;
};

const CoverageContext = createContext<CoverageContextValue | null>(null);

export function useCoverage() {
  const value = useContext(CoverageContext);
  if (!value) throw new Error("useCoverage must be used inside CoverageProvider");
  return value;
}

/** Reads and writes the tab's URL state in place (`history.replaceState`), so nothing navigates. */
function useUrlState() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const write = useCallback(
    (changes: Record<string, string | null>) => {
      const params = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) params.delete(key);
        else params.set(key, value);
      }
      const search = params.toString();
      window.history.replaceState(null, "", `${pathname}${search ? `?${search}` : ""}`);
    },
    [pathname],
  );
  return { searchParams, write };
}

export function CoverageProvider({
  coverage,
  board,
  bookings,
  activityLoaded,
  closers,
  children,
}: {
  coverage: Coverage;
  board: Board;
  bookings: Record<string, number>;
  activityLoaded: boolean;
  closers: DmCloser[] | undefined;
  children: React.ReactNode;
}) {
  const { searchParams, write } = useUrlState();
  const tally = useMemo(() => tallies(board), [board]);

  const [hover, setHover] = useState<Hover>(null);
  const [litCell, setLitCell] = useState<string | null>(null);
  const [litTile, setLitTile] = useState<string | null>(null);
  const [xray, setXray] = useState(false);
  const [hint, setHint] = useState<string[] | null>(null);

  const activeClosers = useMemo(() => {
    const activeTeams = new Set(board.teams.map((team) => team._id as string));
    return (closers ?? []).filter((closer) => closer.isActive && activeTeams.has(closer.teamId));
  }, [closers, board.teams]);

  const closerParam = searchParams.get("closer");
  const previewCloser = useMemo(() => {
    const chosen = activeClosers.find((closer) => closer._id === closerParam);
    if (chosen) return chosen;
    // Default: the first DM closer of the first team that has one.
    for (const team of board.teams) {
      const closer = activeClosers.find((candidate) => candidate.teamId === team._id);
      if (closer) return closer;
    }
    return null;
  }, [activeClosers, closerParam, board.teams]);
  const previewTeamId = previewCloser?.teamId ?? null;

  const previewTeamRef = useRef(previewTeamId);
  const boardRef = useRef(board);
  useEffect(() => {
    previewTeamRef.current = previewTeamId;
    boardRef.current = board;
  });

  // After a change, say so when it reaches other teams but not the previewed closer's.
  const onCellChanged = useCallback((ref: CellRef) => {
    const current = boardRef.current;
    const reached =
      ref.teamId === null
        ? current.teams.filter((team) => team.usesShared && current.teamCell(team, ref.programId, ref.mode).kind !== "own")
        : current.teams.filter((team) => team._id === ref.teamId);
    const ids = reached.map((team) => team._id as string);
    setHint(ids.length > 0 && previewTeamRef.current && !ids.includes(previewTeamRef.current) ? ids : null);
  }, []);
  const actions = useCoverageActions(onCellChanged);

  const cell = useMemo(() => parseCellParam(searchParams.get("cell"), board), [searchParams, board]);
  const programParam = searchParams.get("program");
  const programId = programParam && coverage.programs.some((program) => program._id === programParam) ? programParam : null;
  const teamParam = searchParams.get("team");
  const teamId = teamParam && coverage.teams.some((team) => team._id === teamParam) ? teamParam : null;

  const value: CoverageContextValue = {
    coverage,
    board,
    tally,
    bookings,
    activityLoaded,
    closers: closers === undefined ? undefined : activeClosers,
    disabled: !coverage.migrated,
    actions,
    cell,
    openCell: (ref) => write({ cell: ref ? cellParam(ref) : null }),
    programId,
    openProgram: (id) => write({ program: id, team: null }),
    teamId,
    openTeam: (id) => write({ team: id, program: null }),
    problemsOnly: searchParams.get("show") === "problems",
    setProblemsOnly: (on) => write({ show: on ? "problems" : null }),
    previewCloserId: previewCloser?._id ?? null,
    setPreviewCloser: (closerId) => {
      setHint(null);
      write({ closer: closerId });
    },
    previewTeamId,
    xray,
    setXray,
    hover,
    setHover,
    litCell,
    setLitCell,
    litTile,
    setLitTile,
    hint,
    dismissHint: () => setHint(null),
  };

  return <CoverageContext.Provider value={value}>{children}</CoverageContext.Provider>;
}
