"use client";

import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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

  // Highlight setters. Read the highlight itself with useHighlight.
  setHover: (hover: Hover) => void;
  setLitCell: (key: string | null) => void;
  setLitTile: (key: string | null) => void;

  // Teams the last change reached, when the previewed closer isn't on one.
  hint: string[] | null;
  dismissHint: () => void;
};

const CoverageContext = createContext<CoverageContextValue | null>(null);

export function useCoverage() {
  const value = use(CoverageContext);
  if (!value) throw new Error("useCoverage must be used inside CoverageProvider");
  return value;
}

/**
 * What the pointer lights up: the hovered cell's row and column, a cell lit
 * from the phone (refKey), or a phone tile lit from the matrix ("programId|mode").
 */
type Highlight = { hover: Hover; litCell: string | null; litTile: string | null };

const NO_HIGHLIGHT: Highlight = { hover: null, litCell: null, litTile: null };

// Highlight changes on every pointer move, so it lives outside the context
// value: each reader subscribes to just the part it shows.
function createHighlightStore() {
  let state = NO_HIGHLIGHT;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(change: Partial<Highlight>) {
      state = { ...state, ...change };
      for (const listener of listeners) listener();
    },
  };
}

type HighlightStore = ReturnType<typeof createHighlightStore>;

const HighlightContext = createContext<HighlightStore | null>(null);

/** Reads one piece of the highlight. Return a primitive, so a reader re-renders only when its piece changes. */
export function useHighlight<T extends string | boolean | null>(select: (highlight: Highlight) => T): T {
  const store = use(HighlightContext);
  if (!store) throw new Error("useHighlight must be used inside CoverageProvider");
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.get()),
    () => select(NO_HIGHLIGHT),
  );
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

  const [highlight] = useState(createHighlightStore);
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

  const problemsOnly = searchParams.get("show") === "problems";
  const previewCloserId = previewCloser?._id ?? null;

  const openCell = useCallback((ref: CellRef | null) => write({ cell: ref ? cellParam(ref) : null }), [write]);
  const openProgram = useCallback((id: string | null) => write({ program: id, team: null }), [write]);
  const openTeam = useCallback((id: string | null) => write({ team: id, program: null }), [write]);
  const setProblemsOnly = useCallback((on: boolean) => write({ show: on ? "problems" : null }), [write]);
  const setPreviewCloser = useCallback(
    (closerId: string) => {
      setHint(null);
      write({ closer: closerId });
    },
    [write],
  );
  const dismissHint = useCallback(() => setHint(null), []);
  const setHover = useCallback((hover: Hover) => highlight.set({ hover }), [highlight]);
  const setLitCell = useCallback((litCell: string | null) => highlight.set({ litCell }), [highlight]);
  const setLitTile = useCallback((litTile: string | null) => highlight.set({ litTile }), [highlight]);

  const value = useMemo<CoverageContextValue>(
    () => ({
      coverage,
      board,
      tally,
      bookings,
      activityLoaded,
      closers: closers === undefined ? undefined : activeClosers,
      disabled: !coverage.migrated,
      actions,
      cell,
      openCell,
      programId,
      openProgram,
      teamId,
      openTeam,
      problemsOnly,
      setProblemsOnly,
      previewCloserId,
      setPreviewCloser,
      previewTeamId,
      xray,
      setXray,
      setHover,
      setLitCell,
      setLitTile,
      hint,
      dismissHint,
    }),
    [
      coverage,
      board,
      tally,
      bookings,
      activityLoaded,
      closers,
      activeClosers,
      actions,
      cell,
      openCell,
      programId,
      openProgram,
      teamId,
      openTeam,
      problemsOnly,
      setProblemsOnly,
      previewCloserId,
      setPreviewCloser,
      previewTeamId,
      xray,
      setHover,
      setLitCell,
      setLitTile,
      hint,
      dismissHint,
    ],
  );

  return (
    <HighlightContext value={highlight}>
      <CoverageContext value={value}>{children}</CoverageContext>
    </HighlightContext>
  );
}
