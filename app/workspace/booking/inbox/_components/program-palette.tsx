"use client";

import { useMemo, useState } from "react";
import { PlusIcon, SearchIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { normalizeWords, paletteMatch, type IntelMode } from "@/lib/booking-setup/event-type-intel";
import { KeyHint } from "../../_components/event-types/key-hint";
import { modeLabel, SCHEDULING_MODES } from "../../_components/booking-model";

type Option =
  | { kind: "lane"; programId: string; programName: string; mode: IntelMode; note: string }
  | { kind: "new"; name: string };

/**
 * "Other program…": a command palette over every program × Priority/Standard.
 * Typing filters by word starts ("give std" finds Giveaways · Standard), ↑↓
 * move, ↵ files, and a name no program has offers to create it.
 */
export function ProgramPalette({
  open,
  onOpenChange,
  programs,
  laneCount,
  onPick,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  programs: ReadonlyArray<{ id: string; name: string }>;
  laneCount: (programId: string, mode: IntelMode) => number;
  onPick: (programId: string, mode: IntelMode) => void;
  onCreate: (name: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[18%] max-w-[min(560px,calc(100%-2rem))] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-[560px]"
      >
        <DialogTitle className="sr-only">File under a program</DialogTitle>
        <DialogDescription className="sr-only">Type to find a program and lane, then press Enter.</DialogDescription>
        {open ? <PaletteBody programs={programs} laneCount={laneCount} onPick={onPick} onCreate={onCreate} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PaletteBody({
  programs,
  laneCount,
  onPick,
  onCreate,
  onClose,
}: {
  programs: ReadonlyArray<{ id: string; name: string }>;
  laneCount: (programId: string, mode: IntelMode) => number;
  onPick: (programId: string, mode: IntelMode) => void;
  onCreate: (name: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const options = useMemo<Option[]>(() => {
    const lanes: Option[] = programs.flatMap((program) =>
      SCHEDULING_MODES.map((mode) => {
        const count = laneCount(program.id, mode);
        return {
          kind: "lane" as const,
          programId: program.id,
          programName: program.name,
          mode,
          note: count === 0 ? "new lane" : `${count} event ${count === 1 ? "type" : "types"}`,
        };
      }),
    );
    const matches = lanes.filter((option) => option.kind === "lane" && paletteMatch(query, `${option.programName} · ${modeLabel(option.mode)}`));
    const typed = query.trim();
    const exists = programs.some((program) => normalizeWords(program.name) === normalizeWords(typed));
    return typed && !exists ? [...matches, { kind: "new", name: typed }] : matches;
  }, [programs, laneCount, query]);

  const current = Math.min(active, Math.max(options.length - 1, 0));

  function choose(option: Option | undefined) {
    if (!option) return;
    if (option.kind === "new") onCreate(option.name);
    else onPick(option.programId, option.mode);
  }

  return (
    <div
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActive(Math.min(options.length - 1, current + 1));
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          setActive(Math.max(0, current - 1));
        } else if (event.key === "Enter") {
          event.preventDefault();
          choose(options[current]);
        }
      }}
    >
      <label className="flex items-center gap-2.5 border-b border-border px-3.5 text-muted-foreground">
        <SearchIcon className="size-4" aria-hidden="true" />
        <span className="sr-only">Program and lane</span>
        <input
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          placeholder="Program and lane, or a new program’s name"
          role="combobox"
          aria-expanded="true"
          aria-controls="inbox-palette-list"
          aria-activedescendant={options[current] ? `inbox-palette-${current}` : undefined}
          className="h-[50px] min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
        />
      </label>
      <div id="inbox-palette-list" role="listbox" aria-label="Programs and lanes" className="max-h-[340px] overflow-y-auto p-1.5">
        {options.length === 0 ? (
          <p className="px-2.5 py-2 text-sm text-muted-foreground">No program matches. Type a name to create one.</p>
        ) : (
          options.map((option, index) => (
            <div
              key={option.kind === "new" ? "new" : `${option.programId}:${option.mode}`}
              id={`inbox-palette-${index}`}
              role="option"
              aria-selected={index === current}
              onMouseMove={() => setActive(index)}
              onClick={() => choose(option)}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 rounded-[7px] px-2.5 py-[9px] text-sm",
                index === current ? "bg-foreground text-background" : "text-foreground",
              )}
            >
              {option.kind === "new" ? (
                <>
                  <PlusIcon className="size-4" aria-hidden="true" />
                  <span>
                    New program “{option.name}”
                  </span>
                  <small className={cn("ml-auto text-[12.5px]", index === current ? "text-background/70" : "text-muted-foreground")}>
                    files it under Priority
                  </small>
                </>
              ) : (
                <>
                  <span className="font-semibold">{option.programName}</span>
                  <span>· {modeLabel(option.mode)}</span>
                  <small className={cn("ml-auto text-[12.5px]", index === current ? "text-background/70" : "text-muted-foreground")}>
                    {option.note}
                  </small>
                </>
              )}
            </div>
          ))
        )}
      </div>
      <div className="flex items-center gap-1 border-t border-border px-3.5 py-2 text-[12.5px] text-muted-foreground">
        <KeyHint>↑</KeyHint>
        <KeyHint className="ml-1">↓</KeyHint>
        <span className="mr-2 ml-1">move</span>
        <KeyHint>↵</KeyHint>
        <span className="mr-2 ml-1">file</span>
        <KeyHint>Esc</KeyHint>
        <button type="button" className="ml-1 hover:text-foreground" onClick={onClose}>
          close
        </button>
      </div>
    </div>
  );
}
