"use client";

import { createContext, useContext, useMemo, useRef, useState } from "react";
import { modeLabel } from "../booking-model";
import { useCoverage } from "./coverage-context";
import { faceOf, inheritorsOf, ISSUE_WORD, ISSUE_WHY, resolveRef, type CellRef } from "./coverage-model";

type TipApi = { show: (anchor: HTMLElement, ref: CellRef) => void; hide: () => void };
type TipState = { ref: CellRef; left: number; top: number; below: boolean } | null;

const TipContext = createContext<TipApi>({ show: () => {}, hide: () => {} });

export function useCellTip() {
  return useContext(TipContext);
}

/** One navy tip for every half-cell: what the cell holds, who it reaches, and why it's broken. */
export function CellTipProvider({ children }: { children: React.ReactNode }) {
  const [tip, setTip] = useState<TipState>(null);
  const timer = useRef<number | null>(null);

  const api = useMemo<TipApi>(
    () => ({
      show(anchor, ref) {
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
          const rect = anchor.getBoundingClientRect();
          const below = rect.bottom + 150 < window.innerHeight;
          setTip({
            ref,
            left: Math.min(Math.max(8, rect.left), window.innerWidth - 310),
            top: below ? rect.bottom + 8 : rect.top - 8,
            below,
          });
        }, 260);
      },
      hide() {
        if (timer.current) window.clearTimeout(timer.current);
        setTip(null);
      },
    }),
    [],
  );

  return (
    <TipContext.Provider value={api}>
      {children}
      {tip ? <Tip state={tip} /> : null}
    </TipContext.Provider>
  );
}

function Tip({ state }: { state: NonNullable<TipState> }) {
  const { board } = useCoverage();
  const { ref } = state;
  const program = board.programs.find((candidate) => candidate._id === ref.programId);
  if (!program) return null;
  const team = ref.teamId ? board.teams.find((candidate) => candidate._id === ref.teamId) : null;
  const scope = team?.displayName ?? "Shared";
  const mode = modeLabel(ref.mode);
  const face = faceOf(board, resolveRef(board, ref), ref);

  let body: React.ReactNode;
  switch (face.kind) {
    case "own": {
      const reach = ref.teamId === null ? inheritorsOf(board, ref.programId, ref.mode).map((t) => t.displayName) : [];
      body = (
        <>
          <b className="font-semibold">{face.eventType?.displayName}</b>
          {face.eventType?.bookingBaseUrl ? (
            <span className="block truncate font-mono text-[11.5px] text-board-muted">
              {face.eventType.bookingBaseUrl.replace(/^https?:\/\//, "")}
            </span>
          ) : null}
          <span className="block">
            {ref.teamId === null
              ? reach.length > 0
                ? `Inherited by ${reach.join(", ")}`
                : "No team inherits it"
              : "Own route · ready"}
          </span>
        </>
      );
      break;
    }
    case "inherited":
      body = (
        <>
          ↳ From Shared: <b className="font-semibold">{face.eventType?.displayName}</b>
          <span className="block">Pick an event type to give {scope} its own route.</span>
        </>
      );
      break;
    case "gap":
      body =
        ref.teamId === null ? (
          <>
            <b className="font-semibold text-board-danger">Empty.</b> {face.inheritors === 1 ? "1 team inherits this cell, so it gets no" : `${face.inheritors} teams inherit this cell, so they get no`}{" "}
            {mode} link for {program.name}.
          </>
        ) : (
          <>
            <b className="font-semibold text-board-danger">No link.</b> Shared is empty here, so {scope} inherits nothing.
          </>
        );
      break;
    case "broken":
      body = (
        <>
          <b className="font-semibold text-board-danger">{ISSUE_WORD[face.issue]}.</b>{" "}
          {face.inherited ? "↳ Shared points" : "Points"} at <b className="font-semibold">{face.eventType?.displayName ?? "an event type"}</b>,
          but {ISSUE_WHY[face.issue]}.
          {face.inherited ? <span className="block">A broken Shared cell doesn’t fall back; fix it in Shared or give {scope} its own.</span> : null}
        </>
      );
      break;
    case "off":
      body = (
        <>
          Not offered: {scope} uses its own routes only and has none here, so its DM closers get no {mode} link for {program.name}.
        </>
      );
      break;
    default:
      body = <>Empty. No team inherits this cell.</>;
  }

  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-[70] w-max max-w-[300px] rounded-[7px] bg-board px-[11px] py-[9px] text-[12.5px] leading-[1.4] text-board-foreground shadow-lg"
      style={{ left: state.left, top: state.top, transform: state.below ? undefined : "translateY(-100%)" }}
    >
      <div className="mb-[5px] font-condensed text-[11px] leading-none font-semibold tracking-[0.12em] text-board-muted uppercase">
        {scope} · {program.name} · {mode}
      </div>
      {body}
      <div className="mt-[5px] text-[12px] text-board-muted">Click to change</div>
    </div>
  );
}
