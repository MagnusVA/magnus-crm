"use client";

import { useState } from "react";
import { ChevronRightIcon, LinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { LookalikeGroup } from "@/lib/booking-setup/event-type-intel";
import { CalendlyDot } from "../../_components/calendly-dot";
import { modeLabel, type Board, type CoverageEventType, type Placement } from "../../_components/booking-model";
import { WORD } from "./event-types-parts";

/**
 * LOOK-ALIKES: Calendly copies with slightly different names and emoji,
 * grouped. Each group says which variants coverage uses; unused copies with
 * almost no bookings can be folded (marked Not a sales call) in one go.
 */
export function LookAlikesView({
  groups,
  board,
  programName,
  teamName,
  onFold,
  onOpen,
  query,
}: {
  groups: LookalikeGroup[];
  board: Board;
  programName: (id: string) => string;
  teamName: (id: string) => string;
  onFold: (group: LookalikeGroup, ids: string[]) => Promise<void>;
  onOpen: (id: string) => void;
  query: string;
}) {
  const shown = query
    ? groups.filter(
        (group) =>
          group.label.toLowerCase().includes(query) ||
          group.members.some((member) => member.eventType.name.toLowerCase().includes(query)),
      )
    : groups;
  // The first group with copies to fold starts open.
  const [open, setOpen] = useState<string | null>(() => groups.find((group) => group.foldable.length > 0)?.key ?? null);

  if (shown.length === 0) {
    return (
      <p className="px-4 py-7 text-[13.5px] text-muted-foreground">
        {query ? "No look-alikes match." : "No look-alikes. Every event type has a name of its own."}
      </p>
    );
  }

  return (
    <div>
      {shown.map((group) => (
        <Group
          key={group.key}
          group={group}
          open={open === group.key}
          onToggle={() => setOpen((current) => (current === group.key ? null : group.key))}
          board={board}
          programName={programName}
          teamName={teamName}
          onFold={onFold}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

function Group({
  group,
  open,
  onToggle,
  board,
  programName,
  teamName,
  onFold,
  onOpen,
}: {
  group: LookalikeGroup;
  open: boolean;
  onToggle: () => void;
  board: Board;
  programName: (id: string) => string;
  teamName: (id: string) => string;
  onFold: (group: LookalikeGroup, ids: string[]) => Promise<void>;
  onOpen: (id: string) => void;
}) {
  const foldIds = group.foldable.map((member) => member.eventType.id);
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [folding, setFolding] = useState<ReadonlySet<string>>(new Set());
  const chosen = foldIds.filter((id) => !unchecked.has(id));
  const programs = group.programIds.map(programName);
  const notSales = group.members.filter((member) => member.eventType.status === "not_sales_call").length;
  const bodyId = `look-${group.key.replace(/\W+/g, "-")}`;

  async function fold() {
    setFolding(new Set(chosen));
    try {
      await onFold(group, chosen);
    } finally {
      setFolding(new Set());
      setUnchecked(new Set());
    }
  }

  return (
    <section className="border-b border-border" aria-label={group.label}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 bg-card px-4 py-2.5 text-left outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        <ChevronRightIcon className={cn("size-3.5 text-muted-foreground transition-transform duration-200", open && "rotate-90")} aria-hidden="true" />
        <span className="text-sm font-semibold">{group.label}</span>
        <span className="text-[12.5px] text-muted-foreground">
          {group.members.length} variants · {programs.length > 0 ? programs.join(", ") : "Unsorted"}
        </span>
        <span className="ml-auto">
          {group.foldable.length > 0 ? (
            <Chip tone="amber">
              {group.foldable.length} unused {group.foldable.length === 1 ? "copy" : "copies"}
            </Chip>
          ) : notSales > 0 ? (
            <Chip tone="line">{notSales} set aside</Chip>
          ) : (
            <Chip tone="line">All in use</Chip>
          )}
        </span>
      </button>
      {open ? (
        <div id={bodyId} className="bg-background px-4 pt-0.5 pb-3 @2xl/et:pl-10">
          {group.members.map(({ eventType: member, foldInto }) => {
            const row = board.eventTypesById.get(member.id) as CoverageEventType | undefined;
            const placements = board.placements.get(member.id) ?? [];
            const isFolding = folding.has(member.id);
            return (
              <div
                key={member.id}
                className={cn(
                  "grid min-h-9 grid-cols-[22px_minmax(0,1fr)_44px] items-center gap-2.5 border-b border-border text-[13px] transition-[background-color,opacity] duration-500 @2xl/et:grid-cols-[22px_minmax(0,2.2fr)_80px_minmax(0,2fr)_50px]",
                  isFolding && "bg-stage-booked/12 opacity-50",
                )}
              >
                {foldInto ? (
                  <input
                    type="checkbox"
                    className="size-4 cursor-pointer accent-foreground"
                    aria-label={`Fold ${member.name}`}
                    checked={!unchecked.has(member.id)}
                    onChange={(event) =>
                      setUnchecked((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.delete(member.id);
                        else next.add(member.id);
                        return next;
                      })
                    }
                  />
                ) : (
                  <span>{placements.length > 0 ? <LinkIcon className="size-3.5 text-muted-foreground" aria-label="In use" /> : null}</span>
                )}
                <button
                  type="button"
                  onClick={() => onOpen(member.id)}
                  className="flex min-w-0 items-center gap-1.5 truncate rounded-[5px] text-left outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <CalendlyDot color={row?.calendlyColor} />
                  <span className="truncate">{member.name}</span>
                </button>
                <span className={cn(WORD, "hidden text-stage-held @2xl/et:block")}>{modeLabel(member.mode)}</span>
                <span className="hidden truncate text-xs text-muted-foreground @2xl/et:block">
                  {roleText(member.status, placements, foldInto?.name ?? null, teamName)}
                </span>
                <span
                  className={cn(
                    "text-right font-condensed text-[15px] leading-none font-semibold tabular-nums",
                    member.bookings30d === 0 && "text-stage-held",
                  )}
                >
                  {member.bookings30d}
                </span>
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-3 pt-2.5 text-[12.5px] text-muted-foreground">
            <span className="max-w-[72ch]">
              {group.foldable.length > 0
                ? "Routed variants are separate round-robin pools and stay. Folding marks the unused copies Not a sales call: they leave pickers and triage, and stray bookings on them stop counting for a program."
                : "Every variant is in use or already set aside: these are separate round-robin pools, not duplicates."}
            </span>
            {group.foldable.length > 0 ? (
              <Button
                className="ml-auto bg-foreground text-background hover:bg-foreground/85"
                disabled={chosen.length === 0 || folding.size > 0}
                onClick={() => void fold()}
              >
                Fold {chosen.length} into {chosen.length === 1 ? "its twin" : "their twins"}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function roleText(status: string, placements: readonly Placement[], foldInto: string | null, teamName: (id: string) => string) {
  if (status === "not_sales_call") return "Not a sales call";
  if (status === "gone") return "Gone from Calendly";
  if (placements.length > 0) {
    return `In use · ${placements
      .map((placement) => `${placement.teamId === null ? "Shared" : teamName(placement.teamId)} ${modeLabel(placement.mode)}`)
      .join(", ")}`;
  }
  if (foldInto) return `Unused · fold into ${foldInto}`;
  return status === "unsorted" ? "Unused · unsorted" : "Unused";
}

function Chip({ tone, children }: { tone: "amber" | "line"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-[4px] px-1.5 font-condensed text-[11px] leading-none font-bold tracking-[0.1em] whitespace-nowrap uppercase",
        tone === "amber" ? "bg-warning-surface text-warning-ink" : "border border-input text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}
