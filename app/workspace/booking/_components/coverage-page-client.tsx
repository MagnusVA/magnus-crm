"use client";

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import posthog from "posthog-js";
import { MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { usePageTitle } from "@/hooks/use-page-title";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { cn } from "@/lib/utils";
import { BandFigure, BOOKING_ROOT, BookingBand } from "./booking-band";
import { buildBoard, SCHEDULING_MODES, type Board, type Coverage, type CoverageProgram, type CoverageTeam } from "./booking-model";
import { CoverageCell } from "./coverage-cell";
import { ProgramFormDialog } from "./program-form-dialog";

const LABEL = "font-condensed text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase";
const MODE_LABEL = { normal: "Priority", extended: "Standard" } as const;

export function CoveragePageClient() {
  usePageTitle("Booking setup");
  const coverage = useQuery(api.bookingSetup.queries.getCoverage, {});
  const board = useMemo(() => (coverage ? buildBoard(coverage) : null), [coverage]);
  const [creating, setCreating] = useState(false);

  return (
    <div className={BOOKING_ROOT}>
      <BookingBand
        description="Which event type each DM team's links book, for every program. Changes go live in the portal right away."
        actions={
          <Button onClick={() => setCreating(true)}>
            <PlusIcon aria-hidden />
            New program
          </Button>
        }
      >
        {board ? <Figures board={board} /> : <div className="h-[60px]" />}
      </BookingBand>

      {coverage && board ? (
        <>
          {!coverage.migrated ? (
            <p className="rounded-lg border border-border bg-card px-4 py-3 text-[13px] text-muted-foreground">
              Moving this workspace to the new booking layout. Every DM closer keeps the links they have today.
            </p>
          ) : null}
          <CoverageCard coverage={coverage} board={board} />
        </>
      ) : (
        <CoverageSkeleton />
      )}

      <ProgramFormDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function Figures({ board }: { board: Board }) {
  const { figures } = board;
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-3 border-t border-board-line py-3.5">
      <BandFigure
        value={
          <>
            {figures.covered}
            <span className="text-[17px] text-board-muted"> / {figures.cells}</span>
          </>
        }
        label="Team links working"
      />
      <BandFigure value={figures.noLink} label="No link" tone={figures.noLink ? "warning" : "default"} />
      <BandFigure value={figures.broken} label="Broken" tone={figures.broken ? "danger" : "default"} />
      <Link href="/workspace/booking/inbox" className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <BandFigure value={figures.unsorted} label="Unsorted event types" tone={figures.unsorted ? "warning" : "default"} />
      </Link>
    </div>
  );
}

function CoverageCard({ coverage, board }: { coverage: Coverage; board: Board }) {
  const archived = coverage.programs.filter((program) => program.archivedAt !== undefined);
  const inactiveTeams = coverage.teams.filter((team) => !team.isActive);
  const disabled = !coverage.migrated;

  return (
    <section aria-labelledby="coverage-title" className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2">
        <h2 id="coverage-title" className="text-[15px] font-semibold">Coverage</h2>
        <p className="text-[13px] text-muted-foreground">
          A team with nothing of its own in a cell gets Shared, if it uses Shared.
        </p>
      </div>

      {board.programs.length === 0 ? (
        <p className="px-4 py-6 text-[14px] text-muted-foreground">No programs yet. Create one to start routing links.</p>
      ) : (
        <div className="overflow-x-auto">
          <table aria-labelledby="coverage-title" className="w-full min-w-[56rem] table-fixed border-collapse text-left">
            <colgroup>
              <col className="w-[12rem]" />
              <col className="w-[5.5rem]" />
              <col />
              {board.teams.map((team) => (
                <col key={team._id} />
              ))}
            </colgroup>
            <thead>
              <tr className="border-b border-border align-bottom">
                <th scope="col" className={cn(LABEL, "sticky left-0 z-10 bg-card px-4 py-2")}>Program</th>
                <th scope="col" className={cn(LABEL, "px-2 py-2")}>Mode</th>
                <th scope="col" className="border-l border-border bg-muted/40 px-3 py-2 font-normal">
                  <span className="block text-[14px] font-semibold">Shared</span>
                  <span className="block text-[12px] text-muted-foreground">For teams that use it</span>
                </th>
                {board.teams.map((team) => (
                  <TeamHeader key={team._id} team={team} disabled={disabled} />
                ))}
              </tr>
            </thead>
            <tbody>
              {board.programs.map((program) => (
                <Fragment key={program._id}>
                  {SCHEDULING_MODES.map((mode, index) => (
                    <tr key={mode} className={cn("border-border", index === 1 ? "border-b" : "border-b border-dashed")}>
                      {index === 0 ? (
                        <th scope="rowgroup" rowSpan={2} className="sticky left-0 z-10 border-b border-border bg-card px-4 py-2 align-top font-normal">
                          <ProgramHeader program={program} />
                        </th>
                      ) : null}
                      <td className={cn(LABEL, "px-2 align-middle")}>{MODE_LABEL[mode]}</td>
                      <td className="border-l border-border bg-muted/40 p-0">
                        <CoverageCell
                          board={board}
                          placement={{ program, mode, team: null }}
                          resolved={board.sharedCell(program._id, mode)}
                          disabled={disabled}
                        />
                      </td>
                      {board.teams.map((team) => (
                        <td key={team._id} className="border-l border-border p-0">
                          <CoverageCell
                            board={board}
                            placement={{ program, mode, team }}
                            resolved={board.teamCell(team, program._id, mode)}
                            disabled={disabled}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <footer className="flex flex-col gap-2 border-t border-border px-4 py-3 text-[13px] text-muted-foreground">
        <Legend />
        {inactiveTeams.length > 0 ? (
          <p>
            Disabled teams have no column: {inactiveTeams.map((team) => team.displayName).join(", ")}.{" "}
            <Link href="/workspace/booking/teams" className="font-semibold text-foreground underline decoration-foreground/40 underline-offset-2 hover:decoration-foreground">
              DM teams
            </Link>
          </p>
        ) : null}
        {archived.length > 0 ? <ArchivedPrograms programs={archived} /> : null}
      </footer>
    </section>
  );
}

function Legend() {
  const word = "font-condensed text-[11px] font-bold tracking-[0.1em] uppercase";
  return (
    <p className="flex flex-wrap gap-x-5 gap-y-1">
      <span><span className="font-medium text-foreground">Name</span>: the team’s own event type</span>
      <span><span className={cn(word, "text-muted-foreground")}>From Shared</span>: the Shared cell, inherited</span>
      <span><span className={cn(word, "text-warning-ink")}>No link</span>: the team uses Shared, and Shared is empty</span>
      <span><span className={cn(word, "text-danger-ink")}>Broken</span>: the event type can’t book (hover for why)</span>
      <span>Not offered: the team doesn’t use Shared</span>
    </p>
  );
}

function TeamHeader({ team, disabled }: { team: CoverageTeam; disabled: boolean }) {
  const setTeamUsesShared = useMutation(api.bookingSetup.mutations.setTeamUsesShared);
  const switchId = `uses-shared-${team._id}`;

  async function toggle(usesShared: boolean) {
    try {
      await setTeamUsesShared({ teamId: team._id, usesShared });
      posthog.capture("booking_team_uses_shared_set", { usesShared });
      toast.success(
        usesShared ? `${team.displayName} now uses Shared in empty cells` : `${team.displayName} no longer uses Shared`,
        {
          action: {
            label: "Undo",
            onClick: () => {
              setTeamUsesShared({ teamId: team._id, usesShared: !usesShared }).catch((error: unknown) => {
                reportClientError(error, { flow: "booking_team_uses_shared_undo" });
                toast.error(getErrorMessage(error, "Couldn't undo that change."));
              });
            },
          },
        },
      );
    } catch (error) {
      reportClientError(error, { flow: "booking_team_uses_shared_set" });
      toast.error(getErrorMessage(error, "Couldn't change this team."));
    }
  }

  return (
    <th scope="col" className="border-l border-border px-3 py-2 align-bottom font-normal">
      <span className="block truncate text-[14px] font-semibold" title={team.displayName}>{team.displayName}</span>
      <span className="block truncate font-mono text-[12px] text-muted-foreground" title={`utm_source=${team.utmSource}`}>
        {team.utmSource}
      </span>
      <span className="block text-[12px] text-muted-foreground">
        {team.activeDmClosers} DM {team.activeDmClosers === 1 ? "closer" : "closers"}
      </span>
      <label htmlFor={switchId} className="mt-1.5 flex items-center gap-2 text-[12px] whitespace-nowrap text-muted-foreground">
        <Switch id={switchId} checked={team.usesShared} disabled={disabled} onCheckedChange={toggle} />
        Uses Shared
      </label>
    </th>
  );
}

function ProgramHeader({ program }: { program: CoverageProgram }) {
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const archiveProgram = useMutation(api.tenantPrograms.mutations.archiveProgram);

  async function confirmArchive() {
    try {
      await archiveProgram({ programId: program._id });
      posthog.capture("program_archived", { programId: program._id });
      toast.success(`${program.name} archived`);
      setArchiving(false);
    } catch (error) {
      reportClientError(error, { flow: "booking_program_archive" });
      toast.error(getErrorMessage(error, "Couldn't archive this program."));
    }
  }

  return (
    <div className="flex items-start gap-1">
      <div className="min-w-0 flex-1">
        <span className="block text-[14px] leading-snug font-semibold text-pretty">{program.name}</span>
        {program.defaultCurrency ? (
          <span className="font-condensed text-[12px] tracking-[0.06em] text-muted-foreground">{program.defaultCurrency}</span>
        ) : null}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={`${program.name} actions`}>
            <MoreHorizontalIcon aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => setEditing(true)}>Rename or edit</DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={`/workspace/booking/event-types?filter=sorted&q=${encodeURIComponent(program.name)}`}>Event types</Link>
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => setArchiving(true)}>Archive</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ProgramFormDialog open={editing} onOpenChange={setEditing} program={program} />
      <AlertDialog open={archiving} onOpenChange={setArchiving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {program.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its row leaves the board and DM closers can’t copy links for it. Payments and reports keep it, and you can restore it from the foot of the board.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={(event) => { event.preventDefault(); void confirmArchive(); }}>
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ArchivedPrograms({ programs }: { programs: CoverageProgram[] }) {
  const restoreProgram = useMutation(api.tenantPrograms.mutations.restoreProgram);

  async function restore(program: CoverageProgram) {
    try {
      await restoreProgram({ programId: program._id });
      posthog.capture("program_restored", { programId: program._id });
      toast.success(`${program.name} restored`);
    } catch (error) {
      reportClientError(error, { flow: "booking_program_restore" });
      toast.error(getErrorMessage(error, "Couldn't restore this program."));
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className={LABEL}>Archived</span>
      {programs.map((program) => (
        <span key={program._id} className="inline-flex items-center gap-1">
          {program.name}
          <Button variant="link" size="xs" className="h-6 px-1" onClick={() => void restore(program)}>
            Restore
          </Button>
        </span>
      ))}
    </div>
  );
}

export function CoverageSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card" role="status" aria-label="Loading coverage">
      <div className="h-11 border-b border-border" />
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex h-[88px] items-center gap-4 border-b border-border px-4">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 flex-1" />
        </div>
      ))}
    </div>
  );
}
