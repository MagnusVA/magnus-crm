"use client";

import { cn } from "@/lib/utils";
import { modeLabel } from "./booking-model";
import { useCoverage, useHighlight } from "./coverage/coverage-context";
import {
  faceOf,
  faceSignature,
  ISSUE_WORD,
  isProblem,
  plural,
  refKey,
  resolveRef,
  type CellFace,
  type CellRef,
} from "./coverage/coverage-model";
import { useChanged } from "./coverage/coverage-motion";
import { useCellTip } from "./coverage/cell-tip";

const WORD = "shrink-0 font-condensed text-[11px] leading-none font-bold tracking-[0.08em] uppercase";

const FACE_CLASS: Record<CellFace["kind"], string> = {
  own: "border-border bg-card text-foreground",
  inherited: "border-transparent bg-muted text-muted-foreground",
  gap: "cov-glow border-dashed border-destructive/70 bg-destructive/5 text-danger-ink",
  broken: "border-destructive/50 bg-destructive/12 text-danger-ink",
  off: "cov-hatch border-transparent text-stage-held-ink",
  empty: "border-dashed border-input text-stage-held-ink",
};

/** Calendly's colour for the event type, as a small square-ish dot. */
export function EventTypeMark({ color }: { color: string | undefined }) {
  return (
    <span
      aria-hidden
      className="size-2.5 shrink-0 rounded-[3px] border border-foreground/10"
      style={{ backgroundColor: color ?? "var(--color-stage-held)" }}
    />
  );
}

/** What the half says, in words, for screen readers and the tip. */
export function describeFace(face: CellFace, shared: boolean) {
  switch (face.kind) {
    case "own":
      return face.eventType?.displayName ?? "Missing event type";
    case "inherited":
      return `From Shared: ${face.eventType?.displayName ?? "Missing event type"}`;
    case "broken":
      return `Broken (${ISSUE_WORD[face.issue]}): ${face.inherited ? "from Shared, " : ""}${face.eventType?.displayName ?? "missing event type"}`;
    case "gap":
      return shared ? `Empty, ${plural(face.inheritors, "team")} inherit it and get no link` : "No link";
    case "off":
      return "Not offered";
    default:
      return "Empty";
  }
}

function FaceInner({ face, shared }: { face: CellFace; shared: boolean }) {
  switch (face.kind) {
    case "own":
      return (
        <>
          <EventTypeMark color={face.eventType?.calendlyColor} />
          <span className="min-w-0 truncate">{face.eventType?.displayName ?? "Missing event type"}</span>
        </>
      );
    case "inherited":
      return (
        <>
          <span aria-hidden className="shrink-0 font-semibold text-stage-held-ink">↳</span>
          <EventTypeMark color={face.eventType?.calendlyColor} />
          <span className="min-w-0 truncate">{face.eventType?.displayName ?? "Missing event type"}</span>
        </>
      );
    case "broken":
      return (
        <>
          <span className={WORD}>{ISSUE_WORD[face.issue]}</span>
          <span className="min-w-0 truncate text-danger-ink/80">
            {face.inherited ? "↳ " : ""}
            {face.eventType?.displayName ?? "missing"}
          </span>
        </>
      );
    case "gap":
      return shared ? (
        <>
          <span className={WORD}>Empty</span>
          <span className="min-w-0 truncate">→ {plural(face.inheritors, "team")}</span>
        </>
      ) : (
        <span className={WORD}>No link</span>
      );
    case "off":
      return <span className={WORD}>Not offered</span>;
    default:
      return <span className="min-w-0 truncate">—</span>;
  }
}

/**
 * One half of a matrix cell: a team's (or Shared's) Priority or Standard
 * link for a program, drawn as concept C draws it. It flips when what it
 * shows changes; clicking it opens the cell picker.
 */
export function CoverageHalf({
  cellRef,
  programName,
  size = "matrix",
}: {
  cellRef: CellRef;
  programName: string;
  size?: "matrix" | "mini";
}) {
  const { board, problemsOnly, openCell, setHover, setLitTile, previewTeamId, disabled } = useCoverage();
  const tip = useCellTip();
  const face = faceOf(board, resolveRef(board, cellRef), cellRef);
  const shared = cellRef.teamId === null;
  const [flipping, doneFlipping] = useChanged(faceSignature(face));
  const key = refKey(cellRef);
  // Lit from the phone tile this cell feeds.
  const lit = useHighlight((highlight) => highlight.litCell === key);
  const teamName = shared ? "Shared" : (board.teams.find((team) => team._id === cellRef.teamId)?.displayName ?? "Team");
  // Lights the phone tile this cell feeds, when it feeds the previewed closer.
  const feedsPreview =
    previewTeamId !== null &&
    (cellRef.teamId === previewTeamId ||
      (shared &&
        board.teams.some(
          (team) => team._id === previewTeamId && team.usesShared && board.teamCell(team, cellRef.programId, cellRef.mode).kind !== "own",
        )));

  return (
    <button
      type="button"
      disabled={disabled}
      data-cell={key}
      aria-label={`${teamName}, ${programName}, ${modeLabel(cellRef.mode)}: ${describeFace(face, shared)}`}
      onClick={() => openCell(cellRef)}
      onMouseEnter={(event) => {
        if (size === "matrix") setHover({ programId: cellRef.programId, column: cellRef.teamId ?? "shared" });
        if (feedsPreview) setLitTile(`${cellRef.programId}|${cellRef.mode}`);
        tip.show(event.currentTarget, cellRef);
      }}
      onMouseLeave={() => {
        if (size === "matrix") setHover(null);
        setLitTile(null);
        tip.hide();
      }}
      onFocus={(event) => tip.show(event.currentTarget, cellRef)}
      onBlur={() => tip.hide()}
      onAnimationEnd={(event) => {
        if (event.animationName === "cov-flip") doneFlipping();
      }}
      className={cn(
        "relative flex w-full min-w-0 origin-top items-center gap-1 rounded-[5px] border px-1.5 text-left font-condensed text-[13px] leading-none font-medium backface-hidden",
        "outline-none hover:z-[2] hover:shadow-[0_0_0_2px_var(--color-foreground)] focus-visible:z-[2] focus-visible:shadow-[0_0_0_2px_var(--color-foreground)]",
        "disabled:cursor-default disabled:hover:shadow-none",
        size === "matrix" ? "h-5" : "h-6",
        FACE_CLASS[face.kind],
        flipping && "cov-flip",
        lit && "z-[2] shadow-[0_0_0_2px_var(--color-stage-booked)]",
        problemsOnly && !isProblem(face) && "opacity-[0.22]",
        "transition-opacity duration-200",
      )}
    >
      <FaceInner face={face} shared={shared} />
    </button>
  );
}
