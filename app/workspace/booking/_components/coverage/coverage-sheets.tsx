"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import posthog from "@/lib/posthog-browser";
import { toast } from "sonner";
import { AlertTriangleIcon, EyeIcon, XIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { cn } from "@/lib/utils";
import { eventTypeFacts, linkIssue, modeLabel, modeOf, SCHEDULING_MODES, type CoverageProgram, type CoverageTeam } from "../booking-model";
import { CoverageHalf, EventTypeMark } from "../coverage-cell";
import { ProgramFormDialog } from "../program-form-dialog";
import { useCoverage } from "./coverage-context";
import { eventTypesOfProgram, ISSUE_WORD, looksLikeEventTypeName, plural, usesSharedDelta } from "./coverage-model";
import { ArchiveProgramDialog } from "./coverage-matrix";

const H3 = "mb-2.5 flex items-center gap-2 font-condensed text-[11px] leading-none font-semibold tracking-[0.14em] text-muted-foreground uppercase";
const TH = "border-b border-border px-2 py-1.5 text-left font-condensed text-[11px] leading-none font-semibold tracking-[0.14em] text-muted-foreground uppercase";
const WORD = "font-condensed text-[12px] leading-none font-bold tracking-[0.08em] uppercase";

function SheetShell({
  open,
  onClose,
  label,
  title,
  sub,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  title: string;
  sub: React.ReactNode;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        showCloseButton={false}
        className="w-[min(600px,100vw)] gap-0 border-border bg-card p-0 sm:max-w-none data-[side=right]:w-[min(600px,100vw)] data-[side=right]:sm:max-w-none"
      >
        <div className="dark relative flex-none bg-board px-[18px] py-3.5 text-board-foreground">
          <div className="font-condensed text-[11px] leading-none font-semibold tracking-[0.14em] text-board-muted uppercase">{label}</div>
          <SheetTitle className="mt-1.5 pr-9 text-[21px] leading-[1.2] font-semibold text-board-foreground">{title}</SheetTitle>
          <SheetDescription className="mt-1 text-[12.5px] text-board-muted">{sub}</SheetDescription>
          <SheetClose asChild>
            <button
              type="button"
              aria-label="Close"
              className="absolute top-3 right-3 grid size-[30px] place-items-center rounded-[7px] text-board-muted outline-none hover:bg-board-raised hover:text-board-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <XIcon aria-hidden className="size-4" />
            </button>
          </SheetClose>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
        <div className="flex flex-none items-center gap-2 border-t border-border bg-card px-[18px] py-2.5">{footer}</div>
      </SheetContent>
    </Sheet>
  );
}

function Section({ title, aside, children, className }: { title: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("border-b border-border px-[18px] py-3.5", className)}>
      <h3 className={H3}>
        {title}
        {aside ? <span className="ml-auto font-sans text-[12.5px] font-medium tracking-normal normal-case">{aside}</span> : null}
      </h3>
      {children}
    </section>
  );
}

function Fact({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[12.5px] font-medium text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 truncate text-[14px]", mono && "font-mono text-[12.5px]")}>{children}</span>
    </div>
  );
}

/** A program row's mini matrix: Shared and every team, Priority and Standard. */
function ProgramCells({ program }: { program: CoverageProgram }) {
  const { board } = useCoverage();
  return (
    <table className="w-full border-collapse text-[13px]">
      <thead>
        <tr>
          <th className={TH}>Team</th>
          <th className={TH}>Priority</th>
          <th className={TH}>Standard</th>
        </tr>
      </thead>
      <tbody>
        {[null, ...board.teams].map((team) => (
          <tr key={team?._id ?? "shared"}>
            <td className="border-b border-border px-2 py-[5px] align-middle">{team?.displayName ?? "Shared"}</td>
            {SCHEDULING_MODES.map((mode) => (
              <td key={mode} className="w-[34%] border-b border-border px-2 py-[5px] align-middle">
                <CoverageHalf size="mini" cellRef={{ teamId: team?._id ?? null, programId: program._id, mode }} programName={program.name} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ProgramSheet() {
  const { coverage, board, tally, bookings, activityLoaded, programId, openProgram } = useCoverage();
  const program = coverage.programs.find((candidate) => candidate._id === programId) ?? null;
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState<CoverageProgram | null>(null);
  const restoreProgram = useMutation(api.tenantPrograms.mutations.restoreProgram);
  const close = () => openProgram(null);

  if (!program) return <Sheet open={false} />;
  const archived = program.archivedAt !== undefined;
  const row = tally.programs.get(program._id);
  const eventTypes = eventTypesOfProgram(coverage, program._id).sort(
    (left, right) => (bookings[right._id] ?? 0) - (bookings[left._id] ?? 0) || left.displayName.localeCompare(right.displayName),
  );
  const onBoard = board.programs.some((candidate) => candidate._id === program._id);

  async function restore() {
    if (!program) return;
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
    <SheetShell
      open
      onClose={close}
      label="Program"
      title={program.name}
      sub={
        archived
          ? "Archived · not on the board or in the portal"
          : row && row.working > 0
            ? `${row.working} of ${row.total} cells have a working link · ${plural(eventTypes.length, "event type")}`
            : `Not offered in the portal · ${plural(eventTypes.length, "event type")}`
      }
      footer={
        <>
          {archived ? (
            <Button variant="outline" onClick={() => void restore()}>
              Restore
            </Button>
          ) : (
            <Button variant="outline" className="text-danger-ink" onClick={() => setArchiving(program)}>
              Archive program
            </Button>
          )}
          <span className="flex-1" />
          <Button onClick={close} className="bg-foreground text-background hover:bg-foreground/85">
            Done
          </Button>
        </>
      }
    >
      {looksLikeEventTypeName(coverage, program) ? (
        <div className="border-b border-border px-[18px] py-3.5">
          <div className="flex items-start gap-2.5 rounded-[7px] bg-warning-surface px-3 py-2.5 text-[13px] text-warning-ink">
            <AlertTriangleIcon aria-hidden className="mt-0.5 size-4 flex-none" />
            <div>
              <b className="font-semibold">This looks like an event type’s name, not an offer.</b>
              <br />
              {plural(eventTypes.length, "event type")} count for it. Rename it to the offer it sells, or archive it.
            </div>
          </div>
        </div>
      ) : null}

      <Section
        title="Details"
        aside={
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            Rename or edit
          </Button>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Fact label="Name">{program.name}</Fact>
          </div>
          <Fact label="Default currency">{program.defaultCurrency ?? "Not set"}</Fact>
          <div className="flex flex-col gap-1">
            <span className="text-[12.5px] font-medium text-muted-foreground">Reports</span>
            <span className="text-[12px] text-muted-foreground">Payments, enrollments and revenue split by this program.</span>
          </div>
          <div className="col-span-2 flex flex-col gap-1">
            <span className="text-[12.5px] font-medium text-muted-foreground">Description</span>
            <span className={cn("text-[14px] text-pretty", !program.description && "text-muted-foreground")}>
              {program.description || "No description. Say what the offer is, for the team."}
            </span>
          </div>
        </div>
      </Section>

      {onBoard ? (
        <Section title="Where it can be booked" aside={<span className="text-muted-foreground">Click a cell to change it</span>}>
          <ProgramCells program={program} />
        </Section>
      ) : null}

      <Section title={`Event types that count for it · ${eventTypes.length}`}>
        {eventTypes.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            None yet. Pick one in any cell of this row, or sort one into it from Event types.
          </p>
        ) : (
          <table className="w-full border-collapse text-[13px]">
            <tbody>
              {eventTypes.map((eventType) => {
                const issue = linkIssue(eventType);
                return (
                  <tr key={eventType._id} className="group/et">
                    <td className="border-b border-border py-[7px] pr-2.5">
                      <Link
                        href={`/workspace/booking/event-types?eventType=${eventType._id}`}
                        className="flex min-w-0 items-center gap-2 outline-none group-hover/et:underline focus-visible:underline"
                      >
                        <EventTypeMark color={eventType.calendlyColor} />
                        <span className="truncate">{eventType.displayName}</span>
                      </Link>
                      <span className="block pl-[18px] text-[12px] text-muted-foreground">{eventTypeFacts(eventType)}</span>
                    </td>
                    <td className="border-b border-border px-2.5 py-[7px]">
                      <span className={cn(WORD, "text-stage-held-ink")}>{modeLabel(modeOf(eventType))}</span>
                    </td>
                    <td className="border-b border-border px-2.5 py-[7px]">
                      <span className={cn(WORD, issue ? "text-danger-ink" : "text-foreground")}>{issue ? ISSUE_WORD[issue] : "Ready"}</span>
                    </td>
                    <td className="border-b border-border py-[7px] pl-2.5 text-right font-condensed text-[13px] whitespace-nowrap text-muted-foreground tabular-nums">
                      {activityLoaded ? `${bookings[eventType._id] ?? 0} in 30 days` : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>

      <ProgramFormDialog open={editing} onOpenChange={setEditing} program={program} />
      <ArchiveProgramDialog program={archiving} onDone={() => setArchiving(null)} />
    </SheetShell>
  );
}

/** A team's column as a list: every program, Priority and Standard. */
function TeamCells({ team }: { team: CoverageTeam }) {
  const { board } = useCoverage();
  if (board.programs.length === 0) return <p className="text-[13px] text-muted-foreground">No programs yet.</p>;
  return (
    <table className="w-full border-collapse text-[13px]">
      <thead>
        <tr>
          <th className={TH}>Program</th>
          <th className={TH}>Priority</th>
          <th className={TH}>Standard</th>
        </tr>
      </thead>
      <tbody>
        {board.programs.map((program) => (
          <tr key={program._id}>
            <td className="max-w-0 truncate border-b border-border px-2 py-[5px] align-middle">{program.name}</td>
            {SCHEDULING_MODES.map((mode) => (
              <td key={mode} className="w-[34%] border-b border-border px-2 py-[5px] align-middle">
                <CoverageHalf size="mini" cellRef={{ teamId: team._id, programId: program._id, mode }} programName={program.name} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TeamSheet() {
  const { coverage, board, tally, teamId, openTeam, closers, actions, disabled, setPreviewCloser, previewCloserId } = useCoverage();
  const team = board.teams.find((candidate) => candidate._id === teamId) ?? coverage.teams.find((candidate) => candidate._id === teamId);
  const close = () => openTeam(null);
  if (!team) return <Sheet open={false} />;

  const active = team.isActive;
  const count = tally.teams.get(team._id) ?? { working: 0, problems: 0, total: 0 };
  const delta = active ? usesSharedDelta(board, coverage, team) : 0;
  const roster = (closers ?? []).filter((closer) => closer.teamId === team._id);
  const consequence =
    delta === 0 ? (
      "changes no links"
    ) : delta > 0 ? (
      <b className="font-semibold text-foreground">fills {plural(delta, "cell")}</b>
    ) : (
      <b className="font-semibold text-danger-ink">empties {plural(-delta, "cell")}</b>
    );

  return (
    <SheetShell
      open
      onClose={close}
      label="DM team"
      title={team.displayName}
      sub={
        active
          ? `${count.working} of ${count.total} cells have a working link · ${plural(team.activeDmClosers, "active DM closer")}`
          : "Disabled · no column on the board"
      }
      footer={
        <>
          <span className="text-[12.5px] text-muted-foreground">DM closers don’t get CRM logins; they only carry UTM values.</span>
          <span className="flex-1" />
          <Button variant="outline" asChild>
            <Link href={`/workspace/team/teams/${team._id}`}>Edit team</Link>
          </Button>
          <Button onClick={close} className="bg-foreground text-background hover:bg-foreground/85">
            Done
          </Button>
        </>
      }
    >
      <Section title="Team">
        <div className="grid grid-cols-2 gap-3">
          <Fact label="Name">{team.displayName}</Fact>
          <Fact label="utm_source" mono>
            {team.utmSource}
          </Fact>
          <div className="flex flex-col gap-1">
            <Fact label="Booked-calls goal per business day">{team.bookingDailyQuota ?? "No goal"}</Fact>
            <span className="text-[12px] text-muted-foreground">Drives the goal rings on Booked Calls.</span>
          </div>
          <Fact label="Active">{active ? "Shown in the matrix and the portal" : "Hidden"}</Fact>
        </div>
      </Section>

      {active ? (
        <Section title="Empty cells">
          <label className="flex items-start gap-3">
            <Switch
              className="mt-0.5"
              checked={team.usesShared}
              disabled={disabled}
              onCheckedChange={(checked) => void actions.setUsesShared(team, checked)}
            />
            <span className="text-[13.5px]">
              <b className="font-semibold">Empty cells use Shared</b>
              <span className="mt-0.5 block text-[12.5px] text-muted-foreground">
                {team.usesShared
                  ? `On: any program and mode ${team.displayName} doesn’t route lands on the Shared link. A broken cell of its own doesn’t fall back.`
                  : `Off: ${team.displayName}’s DM closers only get the cells routed for this team.`}{" "}
                Turning it {team.usesShared ? "off" : "on"} {consequence}.
              </span>
            </span>
          </label>
        </Section>
      ) : null}

      {active ? (
        <Section title="Cells" aside={<span className="text-muted-foreground">Click a cell to change it</span>}>
          <TeamCells team={team} />
        </Section>
      ) : null}

      <Section
        title={`DM closers · ${roster.length}`}
        aside={
          <Link href={`/workspace/team/teams/${team._id}`} className="text-primary-ink hover:underline">
            Manage on Team › Teams
          </Link>
        }
      >
        {closers === undefined ? (
          <p className="text-[13px] text-muted-foreground">Loading DM closers…</p>
        ) : roster.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No active DM closers yet. Add one on the team’s page so they get links.</p>
        ) : (
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={TH}>DM closer</th>
                <th className={TH}>utm_medium</th>
                <th className={TH}>Status</th>
                <th className={TH}>
                  <span className="sr-only">Preview</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {roster.map((closer) => (
                <tr key={closer._id}>
                  <td className="border-b border-border px-2 py-[7px] font-medium">{closer.displayName}</td>
                  <td className="border-b border-border px-2 py-[7px] font-mono text-[12px]">{closer.utmMedium}</td>
                  <td className="border-b border-border px-2 py-[7px]">
                    <span className={WORD}>Active</span>
                  </td>
                  <td className="border-b border-border px-2 py-[7px] text-right">
                    {active ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Preview ${closer.displayName}’s portal`}
                        title={`Preview ${closer.displayName}’s portal`}
                        className={cn(previewCloserId === closer._id && "text-stage-booked-ink")}
                        onClick={() => {
                          setPreviewCloser(closer._id);
                          close();
                        }}
                      >
                        <EyeIcon aria-hidden />
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </SheetShell>
  );
}
