"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, SearchIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Id } from "@/convex/_generated/dataModel";
import { eventTypeFacts, linkIssue, modeLabel, modeOf, type CoverageEventType } from "../booking-model";
import { EventTypeMark } from "../coverage-cell";
import { useCoverage } from "./coverage-context";
import {
  faceOf,
  inheritorsOf,
  ISSUE_WORD,
  ISSUE_WHY,
  ownRouteId,
  pickerSections,
  plural,
  resolveRef,
  usedByNames,
  type CellRef,
} from "./coverage-model";

const SECTION = "px-4 pt-3 pb-1.5 font-condensed text-[11px] leading-none font-semibold tracking-[0.14em] text-muted-foreground uppercase";
const NOW_WORD = "font-condensed text-[12px] font-bold tracking-[0.08em] text-board-danger uppercase";

/** The cell picker over the page: `?cell=<team|shared>.<programId>.<priority|standard>`. */
export function CellPicker() {
  const { cell, openCell } = useCoverage();
  return (
    <Dialog open={cell !== null} onOpenChange={(open) => !open && openCell(null)}>
      {cell ? <PickerBody key={`${cell.teamId}|${cell.programId}|${cell.mode}`} cellRef={cell} /> : null}
    </Dialog>
  );
}

type Option = {
  id: string;
  eventType: CoverageEventType;
  // Runs on ↵ or the row's button; undefined: the row can't be used here.
  run?: () => void;
};

function PickerBody({ cellRef }: { cellRef: CellRef }) {
  const { board, bookings, activityLoaded, actions, openCell } = useCoverage();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [fixing, setFixing] = useState<string | null>(null);
  const [url, setUrl] = useState("https://calendly.com/");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const program = board.programs.find((candidate) => candidate._id === cellRef.programId);
  const team = cellRef.teamId ? board.teams.find((candidate) => candidate._id === cellRef.teamId) : null;
  const scope = team?.displayName ?? "Shared";
  const mode = modeLabel(cellRef.mode);
  const programName = program?.name ?? "this program";
  const where = `${scope} · ${programName} · ${mode}`;
  const resolved = resolveRef(board, cellRef);
  const face = faceOf(board, resolved, cellRef);
  const currentId = ownRouteId(board, cellRef);
  const sections = useMemo(() => pickerSections(board, cellRef, query, bookings), [board, cellRef, query, bookings]);

  async function run(work: () => Promise<boolean>) {
    if (busy) return;
    setBusy(true);
    const ok = await work();
    setBusy(false);
    if (ok) openCell(null);
  }

  const reach = cellRef.teamId === null ? inheritorsOf(board, cellRef.programId, cellRef.mode).length : 1;
  const reachLine = cellRef.teamId === null ? (reach > 0 ? (reach === 1 ? "1 team inherits it" : `${reach} teams inherit it`) : "No team inherits it yet") : where;

  const assign = (eventType: CoverageEventType) =>
    run(() => actions.assign(cellRef, eventType._id, `${eventType.displayName} is in ${scope} · ${programName} · ${mode}`, reachLine));
  const sortAndAssign = (eventType: CoverageEventType, verb: string) =>
    run(() => actions.sortAndAssign(cellRef, eventType, `${eventType.displayName} ${verb} and is in this cell`, where));
  const mapOnly = (eventType: CoverageEventType) =>
    run(() =>
      actions.sortOnly(
        eventType,
        { kind: "program", programId: cellRef.programId as Id<"tenantPrograms">, mode: modeOf(eventType) },
        `${eventType.displayName} now counts for ${programName}. Fix it, then pick it here.`,
      ),
    );
  const saveUrl = (eventType: CoverageEventType) =>
    run(() => actions.setUrlAndAssign(cellRef, eventType, url, `${eventType.displayName} has a booking URL and is in this cell`, where));

  const options: Option[] = [
    ...sections.ready.map((eventType) => ({
      id: eventType._id,
      eventType,
      run: eventType._id === currentId ? undefined : () => void assign(eventType),
    })),
    ...sections.fix.map(({ eventType, fix }) => ({
      id: eventType._id,
      eventType,
      run:
        fix.kind === "set_url"
          ? () => setFixing(eventType._id)
          : fix.kind === "switch_mode"
            ? () => void sortAndAssign(eventType, `is now ${mode}`)
            : undefined,
    })),
    ...sections.unsorted.map((eventType) => ({
      id: eventType._id,
      eventType,
      run: linkIssue(eventType) === null
        ? () => void sortAndAssign(eventType, `now counts for ${programName}`)
        : () => void mapOnly(eventType),
    })),
  ];
  const usable = options.filter((option) => option.run);
  const activeIndex = Math.min(active, Math.max(0, usable.length - 1));
  const activeId = usable[activeIndex]?.id ?? null;

  useEffect(() => {
    listRef.current?.querySelector(`[data-opt="${activeId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  function onSearchKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (usable.length === 0) return;
      setActive((activeIndex + (event.key === "ArrowDown" ? 1 : -1) + usable.length) % usable.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      usable[activeIndex]?.run?.();
    }
  }

  const meta = (eventType: CoverageEventType) => {
    const used = usedByNames(board, eventType._id);
    const count = bookings[eventType._id] ?? 0;
    return [
      modeLabel(modeOf(eventType)),
      eventTypeFacts(eventType),
      activityLoaded ? `${plural(count, "booking")} in 30 days` : null,
      used.length > 0 ? `used by ${used.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };

  const row = (option: Option | undefined, eventType: CoverageEventType, sub: React.ReactNode, action: React.ReactNode, extra?: React.ReactNode) => {
    const isActive = option?.run !== undefined && option.id === activeId;
    return (
      <div
        key={eventType._id}
        data-opt={eventType._id}
        onMouseMove={() => {
          const index = usable.findIndex((candidate) => candidate.id === eventType._id);
          if (index >= 0 && index !== activeIndex) setActive(index);
        }}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button,input")) return;
          option?.run?.();
        }}
        className={cn(
          "grid min-h-[46px] grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-2.5 px-4 py-[7px]",
          option?.run ? "cursor-pointer" : "opacity-55",
          isActive && "bg-muted shadow-[inset_3px_0_0_var(--color-foreground)]",
        )}
      >
        <span className="grid place-items-center">
          <EventTypeMark color={eventType.calendlyColor} />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[14px] font-medium">{eventType.displayName}</div>
          <div className="truncate text-[12px] text-muted-foreground">{sub}</div>
        </div>
        <div className="flex items-center gap-1.5">{action}</div>
        {extra}
      </div>
    );
  };
  const optionFor = (id: string) => options.find((option) => option.id === id);

  const hasAny =
    sections.ready.length + sections.fix.length + sections.unsorted.length + sections.other.length > 0;

  return (
    <DialogPortal>
      <DialogOverlay className="bg-board/35 supports-backdrop-filter:backdrop-blur-none" />
      <DialogPrimitive.Content
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        searchRef.current?.focus();
      }}
      className="fixed top-[calc(3.25rem+8vh)] left-1/2 z-50 flex max-h-[calc(100dvh-3.25rem-12vh)] w-[min(620px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-[10px] bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-top-2 data-open:zoom-in-[0.98] data-closed:animate-out data-closed:fade-out-0"
    >
      <div className="dark bg-board px-4 py-3 text-board-foreground">
        <div className="flex flex-wrap items-center gap-2 font-condensed text-[12px] leading-none font-semibold tracking-[0.12em] text-board-muted uppercase">
          <DialogTitle className="contents font-condensed text-[12px] leading-none font-semibold">
            <b className="font-bold text-board-foreground">{scope}</b>
            <ChevronRightIcon aria-hidden className="size-3" />
            <b className="font-bold text-board-foreground">{programName}</b>
            <ChevronRightIcon aria-hidden className="size-3" />
            <b className="font-bold text-board-foreground">{mode}</b>
          </DialogTitle>
          <span className="ml-auto">{team ? (team.usesShared ? "Falls back to Shared" : "Own routes only") : "Fallback cell"}</span>
        </div>
        <DialogDescription className="mt-[7px] text-[13px] text-board-foreground">
          <NowLine cellRef={cellRef} face={face} scope={scope} />
        </DialogDescription>
      </div>

      <label className="flex h-[50px] flex-none items-center gap-2.5 border-b border-border px-4 text-muted-foreground">
        <SearchIcon aria-hidden className="size-4" />
        <input
          ref={searchRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onSearchKey}
          placeholder="Search event types by name"
          aria-label="Search event types"
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-[16px] text-foreground outline-none placeholder:text-muted-foreground"
        />
      </label>

      <div ref={listRef} className="min-h-0 flex-1 overflow-auto pt-1 pb-2" role="listbox" aria-label="Event types">
        {sections.ready.length > 0 ? (
          <>
            <div className={SECTION}>Counts for {programName} · Ready</div>
            {sections.ready.map((eventType) =>
              row(
                optionFor(eventType._id),
                eventType,
                meta(eventType),
                eventType._id === currentId ? (
                  <Chip>Current</Chip>
                ) : (
                  <>
                    {(board.placements.get(eventType._id)?.length ?? 0) === 0 ? <Chip tone="blue">Not in portal yet</Chip> : null}
                    <kbd className="rounded-[4px] border border-input bg-card px-[5px] py-0.5 font-condensed text-[11px] font-semibold text-muted-foreground">
                      ↵
                    </kbd>
                  </>
                ),
              ),
            )}
          </>
        ) : null}

        {sections.fix.length > 0 ? (
          <>
            <div className={SECTION}>Counts for {programName} · Needs a fix</div>
            {sections.fix.map(({ eventType, fix, why }) =>
              row(
                optionFor(eventType._id),
                eventType,
                `Can’t use yet: ${why}`,
                fix.kind === "set_url" ? (
                  fixing === eventType._id ? null : (
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => setFixing(eventType._id)}>
                      Set booking URL
                    </Button>
                  )
                ) : fix.kind === "switch_mode" ? (
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => void sortAndAssign(eventType, `is now ${mode}`)}>
                    Make it {mode} &amp; assign
                  </Button>
                ) : fix.kind === "in_use" ? null : (
                  <span className="font-condensed text-[12px] font-bold tracking-[0.08em] text-warning-ink uppercase">Turn it on in Calendly</span>
                ),
                fixing === eventType._id ? (
                  <form
                    className="col-start-2 col-end-4 flex gap-2 pt-1.5 pb-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveUrl(eventType);
                    }}
                  >
                    <Input
                      autoFocus
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.stopPropagation();
                          setFixing(null);
                          searchRef.current?.focus();
                        }
                      }}
                      aria-label={`Booking URL for ${eventType.displayName}`}
                      className="h-8 font-mono text-[12.5px]"
                    />
                    <Button type="submit" size="sm" disabled={busy || !/^https?:\/\/\S+\.\S+/.test(url.trim())}>
                      Save &amp; assign
                    </Button>
                  </form>
                ) : undefined,
              ),
            )}
          </>
        ) : null}

        {sections.unsorted.length > 0 ? (
          <>
            <div className={SECTION}>Unsorted · map it to {programName}</div>
            {sections.unsorted.map((eventType) => {
              const issue = linkIssue(eventType);
              const count = bookings[eventType._id] ?? 0;
              return row(
                optionFor(eventType._id),
                eventType,
                issue
                  ? `Map it, then fix: ${ISSUE_WHY[issue]}`
                  : `Doesn’t count for a program yet${activityLoaded ? ` · ${plural(count, "booking")} in 30 days` : ""}`,
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => (issue ? void mapOnly(eventType) : void sortAndAssign(eventType, `now counts for ${programName}`))}
                >
                  {issue ? `Map to ${programName}` : "Map & assign"}
                </Button>,
              );
            })}
            {sections.unsortedMore > 0 ? (
              <p className="px-4 pt-1 pl-11 text-[12px] text-muted-foreground">
                {sections.unsortedMore} more unsorted. Type to search them.
              </p>
            ) : null}
          </>
        ) : null}

        {sections.other.length > 0 ? (
          <>
            <div className={SECTION}>Counts for another program</div>
            {sections.other.map((eventType) => (
              <Fragment key={eventType._id}>
                {row(
                  undefined,
                  eventType,
                  `Counts for ${board.programs.find((p) => p._id === eventType.bookingProgramId)?.name ?? "another program"}. A route never changes which program a booking counts for.`,
                  null,
                )}
              </Fragment>
            ))}
          </>
        ) : null}

        {!hasAny ? (
          <p className="px-4 py-[18px] text-[13px] text-muted-foreground">
            {query
              ? `No event types match “${query}”. Calendly syncs every 15 minutes; new ones show up as unsorted.`
              : `No event type counts for ${programName} yet, and nothing is unsorted. Sort one into ${programName} from Event types.`}
          </p>
        ) : null}
      </div>

      <div className="flex flex-none flex-wrap items-center gap-2 border-t border-border bg-background px-4 py-[9px] text-[12px] text-muted-foreground">
        <span>↑↓ move · ↵ assign · esc close</span>
        <div className="ml-auto flex gap-1.5">
          {currentId ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  actions.assign(
                    cellRef,
                    null,
                    team ? (team.usesShared ? `${scope} uses Shared here again` : `${scope} has no route here now`) : "Shared cell cleared",
                    where,
                  ),
                )
              }
            >
              {team ? (team.usesShared ? "↳ Use Shared" : "Clear") : "Leave empty"}
            </Button>
          ) : null}
        </div>
      </div>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function Chip({ children, tone = "line" }: { children: React.ReactNode; tone?: "line" | "blue" }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-[4px] px-1.5 font-condensed text-[11px] leading-none font-bold tracking-[0.1em] whitespace-nowrap uppercase",
        tone === "blue" ? "bg-stage-booked/12 text-stage-booked-ink" : "border border-input text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function NowLine({ cellRef, face, scope }: { cellRef: CellRef; face: ReturnType<typeof faceOf>; scope: string }) {
  const { board } = useCoverage();
  switch (face.kind) {
    case "own": {
      const inheritors = cellRef.teamId === null ? inheritorsOf(board, cellRef.programId, cellRef.mode).length : 0;
      return (
        <>
          Now: <b className="font-semibold">{face.eventType?.displayName}</b>
          {cellRef.teamId === null ? ` · inherited by ${plural(inheritors, "team")}` : " · own route"}
        </>
      );
    }
    case "inherited":
      return (
        <>
          Now: ↳ from Shared, <b className="font-semibold">{face.eventType?.displayName}</b>. Pick one to give {scope} its own route.
        </>
      );
    case "gap":
      return cellRef.teamId === null ? (
        <>
          Now: <span className={NOW_WORD}>Empty</span> · {face.inheritors === 1 ? "1 team inherits this cell and gets no link" : `${face.inheritors} teams inherit this cell and get no link`}
        </>
      ) : (
        <>
          Now: <span className={NOW_WORD}>No link</span> · Shared is empty here too
        </>
      );
    case "broken":
      return (
        <>
          Now: <span className={NOW_WORD}>{ISSUE_WORD[face.issue]}</span> · {face.inherited ? "↳ Shared’s " : ""}
          {face.eventType?.displayName ?? "event type"}: {ISSUE_WHY[face.issue]}
        </>
      );
    case "off":
      return <>Now: <b className="font-semibold">Not offered</b> · {scope} uses its own routes only, so its DM closers get no link here</>;
    default:
      return <>Now: empty · no team inherits this cell</>;
  }
}
