"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import posthog from "posthog-js";
import { toast } from "sonner";
import { ChevronDownIcon, ChevronRightIcon, EyeIcon, MoreHorizontalIcon, PlusIcon, SmartphoneIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { cn } from "@/lib/utils";
import { SCHEDULING_MODES, type CoverageProgram, type CoverageTeam } from "../booking-model";
import { CoverageHalf } from "../coverage-cell";
import { ProgramFormDialog } from "../program-form-dialog";
import { useCoverage } from "./coverage-context";
import { eventTypesOfProgram, looksLikeEventTypeName, plural } from "./coverage-model";
import { TickingNumber } from "./coverage-motion";

const LABEL = "font-condensed text-[11px] leading-none font-semibold tracking-[0.14em] text-muted-foreground uppercase";
const RAIL = 38;
const MIN_COLUMN = 96;

/**
 * Concept C's coverage matrix: one row per program, the Shared column, one
 * column per active DM team, each cell split into Priority over Standard.
 */
export function CoverageMatrix({ onOpenPreview }: { onOpenPreview: () => void }) {
  const ctx = useCoverage();
  const { coverage, board, tally, problemsOnly, setProblemsOnly, disabled } = ctx;
  const [showUnoffered, setShowUnoffered] = useState(false);
  const [creating, setCreating] = useState(false);
  const [knownIds, setKnownIds] = useState<Set<string> | null>(null);
  const [editing, setEditing] = useState<CoverageProgram | null>(null);
  const [archiving, setArchiving] = useState<CoverageProgram | null>(null);

  const { figures } = board;
  const problems = figures.noLink + figures.broken;
  const justAdded = knownIds ? board.programs.find((program) => !knownIds.has(program._id))?._id ?? null : null;
  const unrouted = board.programs.filter((program) => !tally.programs.get(program._id)?.routed);
  const expandFold = showUnoffered || problemsOnly;
  const shown = board.programs.filter(
    (program) => tally.programs.get(program._id)?.routed || expandFold || program._id === justAdded,
  );
  const folded = unrouted.filter((program) => !shown.includes(program));
  const archived = coverage.programs.filter((program) => program.archivedAt !== undefined);
  const usingShared = board.teams.filter((team) => team.usesShared).length;
  const columns = board.teams.length + 1;
  const template = `var(--rh) repeat(${columns}, minmax(${MIN_COLUMN}px, 1fr)) ${RAIL}px`;
  const rowMinWidth = `calc(var(--rh) + ${columns * MIN_COLUMN + RAIL}px)`;

  function startCreating() {
    setKnownIds(new Set(coverage.programs.map((program) => program._id as string)));
    setCreating(true);
  }

  return (
    <section
      aria-labelledby="coverage-title"
      className="@container/mx flex min-w-0 flex-col overflow-hidden rounded-[10px] border border-border bg-card [--rh:146px] @5xl/mx:[--rh:166px]"
    >
      <div className="flex min-h-11 flex-none items-center gap-3 border-b border-border px-4 py-1.5">
        <h2 id="coverage-title" className="text-[15px] font-semibold whitespace-nowrap">Coverage</h2>
        <p className="min-w-0 truncate text-[13px] text-muted-foreground">
          Where each team’s portal link lands ·{" "}
          <TickingNumber value={figures.covered} /> of {figures.cells} cells have a working link
        </p>
        <div className="ml-auto flex flex-none items-center gap-2">
          <Button variant="outline" size="sm" className="@[62rem]/coverage:hidden" onClick={onOpenPreview}>
            <SmartphoneIcon aria-hidden />
            Preview
          </Button>
          <div role="group" aria-label="Filter cells" className="inline-flex flex-none rounded-[7px] bg-muted p-0.5">
            {[false, true].map((on) => (
              <button
                key={String(on)}
                type="button"
                aria-pressed={problemsOnly === on}
                onClick={() => {
                  setProblemsOnly(on);
                  posthog.capture("booking_coverage_filter_set", { problemsOnly: on });
                }}
                className={cn(
                  "h-7 rounded-[5.6px] px-2.5 text-[13px] whitespace-nowrap text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  problemsOnly === on && "bg-card font-medium text-foreground shadow-[0_1px_1px_rgba(20,26,40,.14)]",
                )}
              >
                {on ? (
                  <>
                    Problems only · <TickingNumber value={problems} />
                  </>
                ) : (
                  "All cells"
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      <Legend />

      {!coverage.migrated ? (
        <p className="border-b border-border bg-warning-surface px-4 py-2 text-[13px] text-warning-ink">
          Moving this workspace to the new booking layout. Every DM closer keeps the links they have today; cells unlock when it’s done.
        </p>
      ) : null}

      <div className="relative max-h-[max(22rem,calc(100dvh-20.5rem))] min-h-0 flex-1 overflow-auto overscroll-contain">
        <div role="table" aria-labelledby="coverage-title" aria-rowcount={shown.length + 1}>
          <div
            role="row"
            className="sticky top-0 z-[4] grid border-b border-border bg-card"
            style={{ gridTemplateColumns: template, minWidth: rowMinWidth }}
          >
            <div role="columnheader" className="sticky left-0 z-[1] flex flex-col justify-end gap-[5px] bg-card px-3 pt-2.5 pb-[9px]">
              <span className={LABEL}>Program</span>
              <span className="text-[12px] leading-[1.3] text-muted-foreground">PRI over STD in every cell. Click one to change it.</span>
            </div>
            <SharedHead usingShared={usingShared} filled={tally.sharedFilled} />
            {board.teams.map((team) => (
              <TeamHead key={team._id} team={team} />
            ))}
            <Link
              href="/workspace/team/teams?new=team"
              title="Add a team (Team › Teams)"
              className="grid place-items-center border-l border-dashed border-input text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              <span className={cn(LABEL, "flex rotate-180 items-center gap-1.5 [writing-mode:vertical-rl]")}>
                <PlusIcon aria-hidden className="size-3.5 rotate-90" />
                Team
              </span>
              <span className="sr-only">Add a DM team</span>
            </Link>
          </div>

          {board.programs.length === 0 ? (
            <div className="px-4 py-8 text-center text-[14px] text-muted-foreground" style={{ minWidth: rowMinWidth }}>
              <p className="font-medium text-foreground">No programs yet.</p>
              <p className="mt-1">A program is what a booking counts for. Add one, then fill its cells to make it bookable.</p>
            </div>
          ) : null}

          {problemsOnly && problems === 0 && board.programs.length > 0 ? (
            <div className="border-b border-border px-4 py-3 text-[13px] text-muted-foreground" style={{ minWidth: rowMinWidth }}>
              <span className="font-medium text-foreground">Nothing to fix.</span> Every cell that should have a link has a working one.
            </div>
          ) : null}

          {shown.map((program) => (
            <ProgramRow
              key={program._id}
              program={program}
              template={template}
              minWidth={rowMinWidth}
              entering={program._id === justAdded}
              onEdit={() => setEditing(program)}
              onArchive={() => setArchiving(program)}
            />
          ))}

          {unrouted.length > 0 || archived.length > 0 ? (
            <FoldRow
              open={expandFold}
              folded={expandFold ? unrouted : folded}
              archived={archived}
              minWidth={rowMinWidth}
              onToggle={() => setShowUnoffered((open) => !open)}
              locked={problemsOnly}
            />
          ) : null}

          <div className="flex items-center gap-2.5 px-3 py-1.5" style={{ minWidth: rowMinWidth }}>
            <Button variant="outline" className="border-dashed" disabled={disabled} onClick={startCreating}>
              <PlusIcon aria-hidden />
              Program
            </Button>
            <span className="text-[12.5px] text-muted-foreground">
              A new program starts with no link anywhere. Fill its cells to make it bookable.
            </span>
          </div>
        </div>
      </div>

      <ProgramFormDialog open={creating} onOpenChange={setCreating} />
      <ProgramFormDialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)} program={editing ?? undefined} />
      <ArchiveProgramDialog program={archiving} onDone={() => setArchiving(null)} />
    </section>
  );
}

function Legend() {
  const swatch = "inline-block h-[11px] w-[18px] rounded-[3px] border";
  return (
    <div className="flex flex-none flex-wrap gap-x-3.5 gap-y-1 border-b border-border bg-background px-4 py-1.5 text-[12px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <i aria-hidden className={cn(swatch, "border-border bg-card")} />
        Team’s own route
      </span>
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <i aria-hidden className={cn(swatch, "border-transparent bg-muted")} />↳ From Shared
      </span>
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <i aria-hidden className={cn(swatch, "border-dashed border-destructive/70 bg-destructive/5")} />
        No link
      </span>
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <i aria-hidden className={cn(swatch, "border-destructive/50 bg-destructive/12")} />
        Broken
      </span>
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <i aria-hidden className={cn(swatch, "cov-hatch border-transparent")} />
        Not offered
      </span>
    </div>
  );
}

function SharedHead({ usingShared, filled }: { usingShared: number; filled: number }) {
  const { hover } = useCoverage();
  return (
    <div
      role="columnheader"
      title="Shared cells are the fallback for teams whose empty cells use Shared"
      className={cn(
        "flex min-w-0 flex-col border-r-2 border-l border-r-[color-mix(in_oklab,var(--color-border)_60%,var(--color-stage-held))] border-l-border bg-muted px-2.5 pt-[9px] pb-2 transition-colors",
        hover?.column === "shared" && "bg-[color-mix(in_oklab,var(--color-muted)_70%,var(--color-stage-held))]",
      )}
    >
      <span className="font-condensed text-[14px] leading-[1.1] font-bold tracking-[0.1em] uppercase">Shared</span>
      <span className="mt-0.5 truncate text-[12px] text-muted-foreground">Fallback · {plural(usingShared, "team")}</span>
      <span className="mt-[5px] flex min-h-5 items-center gap-[5px] font-condensed text-[14px] leading-none font-semibold">
        <TickingNumber value={filled} />
        <span className="text-[12.5px] text-muted-foreground">{filled === 1 ? "cell filled" : "cells filled"}</span>
      </span>
    </div>
  );
}

function TeamHead({ team }: { team: CoverageTeam }) {
  const { tally, hover, openTeam, xray, previewTeamId, closers, setPreviewCloser } = useCoverage();
  const count = tally.teams.get(team._id) ?? { working: 0, problems: 0, total: 0 };
  const full = count.total > 0 && count.working === count.total;
  const pct = count.total ? Math.round((count.working / count.total) * 100) : 0;
  const firstCloser = closers?.find((closer) => closer.teamId === team._id);
  const xrayed = xray && previewTeamId === team._id;

  return (
    <div
      role="columnheader"
      className={cn(
        "group/head relative flex min-w-0 flex-col border-l border-border px-2.5 pt-[9px] pb-2 text-left transition-colors hover:bg-background",
        hover?.column === team._id && "bg-background",
        xrayed && "bg-stage-booked/8 shadow-[inset_0_3px_0_var(--color-stage-booked)]",
      )}
    >
      <button
        type="button"
        onClick={() => openTeam(team._id)}
        title={`${team.displayName} · utm_source=${team.utmSource}`}
        className="peer min-w-0 truncate pr-5 text-left text-[13.5px] leading-[1.2] font-semibold outline-none after:absolute after:inset-0 group-hover/head:underline group-hover/head:underline-offset-3 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
      >
        {team.displayName}
      </button>
      <span className="mt-0.5 truncate text-[12px] text-muted-foreground">{team.usesShared ? "↳ Uses Shared" : "Own routes only"}</span>
      <span className="mt-[5px] flex min-h-5 items-center gap-[5px] font-condensed text-[14px] leading-none font-semibold">
        {full ? (
          <span className="inline-flex h-5 items-center rounded-[4px] bg-primary px-1.5 text-[11px] font-bold tracking-[0.1em] text-primary-foreground uppercase">
            All covered
          </span>
        ) : (
          <>
            <TickingNumber value={count.working} className={count.problems > 0 ? "text-danger-ink" : undefined} />
            <span className="text-[12.5px] text-muted-foreground">/{count.total}</span>
            <span className="h-1 min-w-4 flex-1 overflow-hidden rounded-[2px] bg-muted">
              <i className="block h-full bg-muted-foreground transition-[width] duration-600" style={{ width: `${pct}%` }} />
            </span>
          </>
        )}
      </span>
      {firstCloser ? (
        <button
          type="button"
          onClick={() => setPreviewCloser(firstCloser._id)}
          title={`Preview a ${team.displayName} DM closer`}
          aria-label={`Preview ${firstCloser.displayName}’s portal`}
          className="absolute top-[7px] right-1.5 z-[1] grid size-6 place-items-center rounded-[5px] text-muted-foreground opacity-0 outline-none group-hover/head:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <EyeIcon aria-hidden className="size-[15px]" />
        </button>
      ) : null}
    </div>
  );
}

function ProgramRow({
  program,
  template,
  minWidth,
  entering,
  onEdit,
  onArchive,
}: {
  program: CoverageProgram;
  template: string;
  minWidth: string;
  entering: boolean;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const { coverage, board, tally, hover, openProgram, problemsOnly, xray, previewTeamId } = useCoverage();
  const row = tally.programs.get(program._id) ?? { working: 0, problems: 0, total: 0, routed: false };
  const eventTypeCount = eventTypesOfProgram(coverage, program._id).length;
  const lookalike = looksLikeEventTypeName(coverage, program);

  return (
    <div
      role="row"
      className={cn("grid border-b border-border", entering && "cov-row-in")}
      style={{ gridTemplateColumns: template, minWidth }}
    >
      <div
        role="rowheader"
        className={cn(
          "group/row sticky left-0 z-[3] grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1 bg-card py-1 pr-1.5 pl-3 transition-[background-color,opacity]",
          hover?.programId === program._id && "bg-background",
          problemsOnly && row.problems === 0 && "opacity-60",
        )}
      >
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => openProgram(program._id)}
            title={`Open ${program.name}`}
            className="block max-w-full truncate text-left text-[13.5px] leading-[1.2] font-semibold outline-none hover:underline hover:underline-offset-3 focus-visible:underline"
          >
            {program.name}
          </button>
          <div className="mt-0.5 flex items-center gap-1 overflow-hidden text-[12px] whitespace-nowrap text-muted-foreground">
            {lookalike ? (
              <span className="text-warning-ink" title="Named like an event type">
                ⚠
              </span>
            ) : null}
            {row.problems > 0 ? (
              <span className="text-danger-ink">{row.problems} to fix</span>
            ) : row.working > 0 ? (
              <span className="text-foreground">
                <span aria-hidden className="mr-[5px] inline-block size-1.5 rounded-full bg-primary align-middle" />
                Covered
              </span>
            ) : (
              <span>Not offered</span>
            )}
            <span>· {eventTypeCount} ET</span>
            <ProgramMenu program={program} onEdit={onEdit} onArchive={onArchive} />
          </div>
        </div>
        <div aria-hidden className="flex flex-col gap-0.5 text-right font-condensed text-[11px] leading-5 font-semibold tracking-[0.1em] text-stage-held-ink">
          <span>PRI</span>
          <span>STD</span>
        </div>
      </div>
      <div
        role="cell"
        className="flex min-w-0 flex-col gap-0.5 border-r-2 border-l border-r-[color-mix(in_oklab,var(--color-border)_60%,var(--color-stage-held))] border-l-border bg-muted/55 px-1 py-[3px]"
      >
        {SCHEDULING_MODES.map((mode) => (
          <CoverageHalf key={mode} cellRef={{ teamId: null, programId: program._id, mode }} programName={program.name} />
        ))}
      </div>
      {board.teams.map((team) => (
        <div
          role="cell"
          key={team._id}
          className={cn(
            "flex min-w-0 flex-col gap-0.5 border-l border-border px-1 py-[3px]",
            xray && previewTeamId === team._id && "bg-stage-booked/6",
          )}
        >
          {SCHEDULING_MODES.map((mode) => (
            <CoverageHalf key={mode} cellRef={{ teamId: team._id, programId: program._id, mode }} programName={program.name} />
          ))}
        </div>
      ))}
      <div aria-hidden className="border-l border-dashed border-input" />
    </div>
  );
}

function ProgramMenu({ program, onEdit, onArchive }: { program: CoverageProgram; onEdit: () => void; onArchive: () => void }) {
  const { openProgram } = useCoverage();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${program.name} actions`}
          className="ml-auto grid h-[18px] w-[22px] flex-none place-items-center rounded-[5px] text-muted-foreground opacity-55 outline-none group-hover/row:opacity-100 hover:bg-muted focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:opacity-100"
        >
          <MoreHorizontalIcon aria-hidden className="size-[15px]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => openProgram(program._id)}>Open program</DropdownMenuItem>
        <DropdownMenuItem onSelect={onEdit}>Rename or edit</DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={`/workspace/booking/event-types?q=${encodeURIComponent(program.name)}`}>Its event types</Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onArchive}>
          Archive
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FoldRow({
  open,
  folded,
  archived,
  minWidth,
  onToggle,
  locked,
}: {
  open: boolean;
  folded: CoverageProgram[];
  archived: CoverageProgram[];
  minWidth: string;
  onToggle: () => void;
  locked: boolean;
}) {
  const restoreProgram = useMutation(api.tenantPrograms.mutations.restoreProgram);
  const { openProgram } = useCoverage();

  async function restore(program: CoverageProgram) {
    try {
      await restoreProgram({ programId: program._id as Id<"tenantPrograms"> });
      posthog.capture("program_restored", { programId: program._id });
      toast.success(`${program.name} is back on the board`);
    } catch (error) {
      reportClientError(error, { flow: "booking_program_restore" });
      toast.error(getErrorMessage(error, "Couldn't restore this program."));
    }
  }

  return (
    <div className="border-b border-border bg-background/60 text-[12.5px] text-muted-foreground" style={{ minWidth }}>
      <button
        type="button"
        onClick={onToggle}
        disabled={locked}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default"
      >
        {open ? <ChevronDownIcon aria-hidden className="size-3.5" /> : <ChevronRightIcon aria-hidden className="size-3.5" />}
        <span className="min-w-0 truncate">
          {folded.length > 0 ? (
            <>
              <b className="font-semibold text-foreground">{folded.length} not offered in the portal</b>
              {open ? ": no cell anywhere yet" : `: ${folded.map((program) => program.name).join(" · ")}`}
            </>
          ) : (
            <b className="font-semibold text-foreground">Every program has a cell</b>
          )}
          {archived.length > 0 ? ` · ${archived.length} archived` : ""}
        </span>
      </button>
      {open && archived.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2 pl-9">
          <span className={LABEL}>Archived</span>
          {archived.map((program) => (
            <span key={program._id} className="inline-flex items-center gap-1">
              <button type="button" className="hover:underline" onClick={() => openProgram(program._id)}>
                {program.name}
              </button>
              <Button variant="link" size="xs" className="h-6 px-1 text-primary-ink" onClick={() => void restore(program)}>
                Restore
              </Button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ArchiveProgramDialog({ program, onDone }: { program: CoverageProgram | null; onDone: () => void }) {
  const archiveProgram = useMutation(api.tenantPrograms.mutations.archiveProgram);
  const restoreProgram = useMutation(api.tenantPrograms.mutations.restoreProgram);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (!program) return;
    const programId = program._id as Id<"tenantPrograms">;
    setBusy(true);
    try {
      await archiveProgram({ programId });
      posthog.capture("program_archived", { programId });
      toast.success(`${program.name} archived`, {
        description: "Its row left the board. Payments and reports keep it.",
        action: {
          label: "Undo",
          onClick: () => {
            restoreProgram({ programId }).catch((error: unknown) => {
              reportClientError(error, { flow: "booking_program_archive_undo" });
              toast.error(getErrorMessage(error, "Couldn't undo that change."));
            });
          },
        },
      });
      onDone();
    } catch (error) {
      reportClientError(error, { flow: "booking_program_archive" });
      toast.error(getErrorMessage(error, "Couldn't archive this program."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={program !== null} onOpenChange={(open) => !open && onDone()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive {program?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its row leaves the board and DM closers can’t copy links for it. Payments and reports keep it, and you can restore it from
            the foot of the board.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={(event) => {
              event.preventDefault();
              void confirm();
            }}
          >
            Archive
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
