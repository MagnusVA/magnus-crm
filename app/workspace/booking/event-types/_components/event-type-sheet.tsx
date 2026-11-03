"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useMutation } from "convex/react";
import { formatDistanceToNowStrict } from "date-fns";
import { CheckIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import posthog from "posthog-js";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { cn } from "@/lib/utils";
import {
  cellIssue,
  modeLabel,
  modeOf,
  poolingLabel,
  SCHEDULING_MODES,
  type Board,
  type CoverageProgram,
} from "../../_components/booking-model";
import { coverageCellHref, type EventTypeRow } from "../../_components/event-types/event-type-rows";
import { CountsForSelect, LABEL, TONE, WORD } from "./event-types-parts";
import type { SortTarget } from "./event-types-table";

const EventTypeConfigDialog = dynamic(
  () => import("../../_components/event-type-config-dialog").then((module) => module.EventTypeConfigDialog),
  { ssr: false },
);

type FullConfig = Doc<"eventTypeConfigs">;

/**
 * One event type in a right-hand sheet (`?eventType=<id>`): whether the portal
 * can book it, what it counts for, its booking URL, payment links and form
 * fields, where coverage uses it, and what Calendly says about it.
 */
export function EventTypeSheet({
  row,
  config,
  board,
  programs,
  teamName,
  onClose,
  onSort,
}: {
  row: EventTypeRow | null;
  config: FullConfig | undefined;
  board: Board;
  programs: readonly CoverageProgram[];
  teamName: (id: string) => string;
  onClose: () => void;
  onSort: (row: EventTypeRow, target: SortTarget) => void;
}) {
  return (
    <Sheet open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" showCloseButton={false} className="w-full gap-0 p-0 sm:max-w-[600px]">
        {row ? (
          <SheetBody key={row.eventType._id} row={row} config={config} board={board} programs={programs} teamName={teamName} onClose={onClose} onSort={onSort} />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function SheetBody({
  row,
  config,
  board,
  programs,
  teamName,
  onClose,
  onSort,
}: {
  row: EventTypeRow;
  config: FullConfig | undefined;
  board: Board;
  programs: readonly CoverageProgram[];
  teamName: (id: string) => string;
  onClose: () => void;
  onSort: (row: EventTypeRow, target: SortTarget) => void;
}) {
  const { eventType } = row;
  const [editorOpen, setEditorOpen] = useState(false);
  const mode = modeOf(eventType);
  const sorted = row.status === "sorted";
  const urlOk = Boolean(eventType.bookingBaseUrl);
  const calendlyOk = eventType.calendlySyncStatus === undefined || eventType.calendlySyncStatus === "active";

  const checks: Array<[boolean, string]> = [
    [sorted, sorted ? `Counts for ${row.programName}` : row.status === "not_sales_call" ? "Marked Not a sales call" : "Doesn’t count for a program"],
    [urlOk, urlOk ? "Has a booking URL" : "No booking URL"],
    [
      calendlyOk,
      calendlyOk
        ? "Bookable in Calendly"
        : eventType.calendlySyncStatus === "inactive"
          ? "Switched off in Calendly"
          : "Calendly no longer returns it",
    ],
  ];

  const facts = [
    eventType.calendlyDurationMinutes !== undefined ? `${eventType.calendlyDurationMinutes} min` : null,
    eventType.calendlyKind === "group" ? "group event" : poolingLabel(eventType.calendlyPoolingType).toLowerCase(),
  ].filter(Boolean);

  return (
    <>
      <header className="relative shrink-0 bg-board px-[18px] py-3.5 text-board-foreground">
        <span className={cn(LABEL, "text-board-muted")}>Event type</span>
        <SheetTitle className="mt-1.5 pr-9 text-[21px] leading-tight font-semibold text-board-foreground [overflow-wrap:anywhere]">
          {eventType.displayName}
        </SheetTitle>
        <SheetDescription className="mt-1 text-[12.5px] text-board-muted">
          Calendly: {eventType.calendlyName ?? eventType.displayName}
          {facts.length ? ` · ${facts.join(" · ")}` : ""}
        </SheetDescription>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3 right-3 grid size-[30px] place-items-center rounded-[7px] text-board-muted outline-none hover:bg-board-raised hover:text-board-foreground focus-visible:ring-3 focus-visible:ring-primary/50"
        >
          <XIcon className="size-4" aria-hidden="true" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="Bookable in the portal?" right={<span className={cn(WORD, TONE[row.bookable.tone])}>{row.bookable.word}</span>}>
          <ul className="flex flex-col gap-1.5">
            {checks.map(([ok, text]) => (
              <li key={text} className="flex items-center gap-2.5 text-[13.5px]">
                <span
                  className={cn(
                    "grid size-[18px] shrink-0 place-items-center rounded-full",
                    ok ? "bg-foreground text-background" : "bg-warning-surface text-warning-ink",
                  )}
                  aria-hidden="true"
                >
                  {ok ? <CheckIcon className="size-3" strokeWidth={3} /> : <span className="font-condensed text-xs font-bold">!</span>}
                </span>
                <span className={cn(!ok && "text-warning-ink")}>{text}</span>
              </li>
            ))}
          </ul>
          {row.warning ? (
            <p className="mt-2 flex items-start gap-1.5 text-[12.5px] text-warning-ink">
              <TriangleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
              {row.warning}
            </p>
          ) : null}
          {row.group ? (
            <p className="mt-2 text-[12.5px] text-muted-foreground">
              Look-alike of {row.group.label}, one of {row.group.members.length} variants.{" "}
              <Link className="font-semibold text-foreground underline decoration-foreground/40 underline-offset-[3px] hover:decoration-foreground" href="/workspace/booking/event-types?filter=looks">
                See look-alikes
              </Link>
            </p>
          ) : null}
        </Section>

        <Section title="Basics">
          <div className="grid gap-x-3 gap-y-3.5 @container sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Counts for</span>
              <div className="rounded-[7px] border border-input">
                <CountsForSelect
                  row={row}
                  programs={programs}
                  label="Counts for"
                  onChange={(value) => onSort(row, value.kind === "program" ? { kind: "program", programId: value.programId, mode } : value)}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium" id="sheet-scheduling">
                Scheduling
              </span>
              <div role="group" aria-labelledby="sheet-scheduling" className="inline-flex gap-0.5 rounded-[7px] bg-muted p-0.5">
                {SCHEDULING_MODES.map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={mode === option}
                    disabled={!sorted}
                    title={sorted ? undefined : "File it under a program first"}
                    onClick={() =>
                      sorted && eventType.bookingProgramId && mode !== option
                        ? onSort(row, { kind: "program", programId: eventType.bookingProgramId, mode: option })
                        : undefined
                    }
                    className={cn(
                      "h-7 flex-1 rounded-[5px] px-3 font-condensed text-[12.5px] font-semibold tracking-[0.1em] uppercase outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60",
                      mode === option ? "bg-card text-foreground shadow-[0_1px_2px_rgb(20_26_40/0.12)]" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {modeLabel(option)}
                  </button>
                ))}
              </div>
            </div>
            <BookingUrlField row={row} />
          </div>
        </Section>

        <Section
          title={`Payment links · ${eventType.paymentLinkCount}`}
          right={
            <Button variant="outline" size="sm" className="h-7 bg-card" onClick={() => setEditorOpen(true)} disabled={!config}>
              Edit payment links
            </Button>
          }
        >
          {config?.paymentLinks && config.paymentLinks.length > 0 ? (
            <ul className="overflow-hidden rounded-[7px] border border-border">
              {config.paymentLinks.map((link) => (
                <li key={`${link.provider}:${link.url}`} className="grid grid-cols-[80px_minmax(0,1fr)_minmax(0,1.4fr)] gap-2.5 border-t border-border px-3 py-2 text-[13px] first:border-t-0">
                  <span className="capitalize">{link.provider}</span>
                  <span className="truncate">{link.label}</span>
                  <span className="truncate font-mono text-[12.5px] text-muted-foreground">{link.url}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted-foreground">None. Phone closers see these on the meeting page to send a checkout link.</p>
          )}
        </Section>

        <Section
          title="Form fields"
          right={
            <Button variant="outline" size="sm" className="h-7 bg-card" onClick={() => setEditorOpen(true)} disabled={!config}>
              Map fields
            </Button>
          }
        >
          <dl className="grid grid-cols-[150px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 text-[13px]">
            <dt className="text-muted-foreground">Social handle question</dt>
            <dd className={cn("min-w-0 [overflow-wrap:anywhere]", !config?.customFieldMappings?.socialHandleField && "text-warning-ink")}>
              {config?.customFieldMappings?.socialHandleField ?? "Not mapped: bookings won’t match the lead’s DMs"}
            </dd>
            <dt className="text-muted-foreground">Platform</dt>
            <dd>{platformLabel(config?.customFieldMappings?.socialHandleType)}</dd>
            <dt className="text-muted-foreground">Phone question</dt>
            <dd className="truncate">{config?.customFieldMappings?.phoneField ?? "Calendly’s phone field"}</dd>
          </dl>
          <p className="mt-2 text-[12.5px] text-muted-foreground">
            Questions are discovered from incoming bookings ({eventType.formQuestionCount} so far).
          </p>
        </Section>

        <WhereItLands row={row} board={board} teamName={teamName} />

        <Section title="From Calendly · read only">
          <dl className="grid grid-cols-[150px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 text-[13px]">
            <dt className="text-muted-foreground">Status</dt>
            <dd>
              {calendlyStatus(eventType.calendlySyncStatus)}
              {eventType.lastCalendlySyncedAt
                ? ` · synced ${formatDistanceToNowStrict(eventType.lastCalendlySyncedAt, { addSuffix: true })}`
                : ""}
            </dd>
            <dt className="text-muted-foreground">Pool</dt>
            <dd>
              {eventType.calendlyKind === "group" ? "Group event" : poolingLabel(eventType.calendlyPoolingType)}, managed in Calendly
            </dd>
            {config?.calendlyProfileName ? (
              <>
                <dt className="text-muted-foreground">Owner</dt>
                <dd className="truncate">{config.calendlyProfileName}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Bookings</dt>
            <dd>{row.bookings} in 30 days</dd>
            {eventType.calendlySchedulingUrl ? (
              <>
                <dt className="text-muted-foreground">Scheduling page</dt>
                <dd className="truncate font-mono text-[12.5px]">
                  <a href={eventType.calendlySchedulingUrl} target="_blank" rel="noreferrer" className="hover:underline">
                    {eventType.calendlySchedulingUrl.replace(/^https?:\/\//, "")}
                  </a>
                </dd>
              </>
            ) : null}
          </dl>
        </Section>
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-border bg-card px-[18px] py-2.5">
        {row.status === "not_sales_call" ? (
          <Button variant="outline" className="bg-card" onClick={() => onSort(row, { kind: "unsorted" })}>
            Bring back to the inbox
          </Button>
        ) : (
          <Button variant="outline" className="bg-card" onClick={() => onSort(row, { kind: "not_sales_call" })}>
            Not a sales call
          </Button>
        )}
        <span className="flex-1" />
        <Button className="bg-foreground text-background hover:bg-foreground/85" onClick={onClose}>
          Done
        </Button>
      </footer>

      {config && editorOpen ? (
        <EventTypeConfigDialog open={editorOpen} onOpenChange={setEditorOpen} config={config} />
      ) : null}
    </>
  );
}

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-b border-border px-[18px] py-3.5">
      <h3 className={cn(LABEL, "mb-2.5 flex min-h-5 items-center gap-2")}>
        {title}
        {right ? <span className="ml-auto tracking-normal normal-case">{right}</span> : null}
      </h3>
      {children}
    </section>
  );
}

function BookingUrlField({ row }: { row: EventTypeRow }) {
  const { eventType } = row;
  const saved = eventType.bookingBaseUrl ?? "";
  const [value, setValue] = useState(saved);
  const [saving, setSaving] = useState(false);
  const setUrl = useMutation(api.bookingSetup.mutations.setEventTypeBookingUrl);
  const dirty = value.trim() !== saved;

  async function save(next: string | null, previous: string | null) {
    // Undo restores where the old URL came from too, so a Calendly-synced
    // URL keeps syncing after an undone edit.
    const previousSource = eventType.bookingUrlSource;
    setSaving(true);
    try {
      await setUrl({ eventTypeConfigId: eventType._id as Id<"eventTypeConfigs">, bookingBaseUrl: next });
      posthog.capture("booking_event_type_url_set", { cleared: next === null, source: "event_type_sheet" });
      toast.success(next ? "Booking URL saved." : "Booking URL cleared.", {
        action: {
          label: "Undo",
          onClick: () => {
            setValue(previous ?? "");
            void setUrl({
              eventTypeConfigId: eventType._id as Id<"eventTypeConfigs">,
              bookingBaseUrl: previous,
              restoreSource: previous ? previousSource : undefined,
            }).catch((error: unknown) => {
              reportClientError(error, { flow: "booking_event_type_url_undo" });
              toast.error(getErrorMessage(error, "Couldn't undo. Set the URL again."));
            });
          },
        },
      });
    } catch (error) {
      reportClientError(error, { flow: "booking_event_type_url_set" });
      toast.error(getErrorMessage(error, "Couldn't save the booking URL."));
    } finally {
      setSaving(false);
    }
  }

  const help = !saved
    ? "Needed before the portal can build a link."
    : eventType.bookingUrlSource === "admin_entered"
      ? "Entered by an admin. The portal adds the UTMs."
      : eventType.bookingUrlSource === "imported_sheet"
        ? "Imported from a sheet. The portal adds the UTMs."
        : "Synced from Calendly. The portal adds the UTMs.";

  return (
    <form
      className="flex flex-col gap-1.5 sm:col-span-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty) void save(value.trim() || null, saved || null);
      }}
    >
      <label htmlFor="sheet-booking-url" className="text-[13px] font-medium">
        Booking URL
      </label>
      <div className="flex gap-2">
        <input
          id="sheet-booking-url"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="https://calendly.com/d/…"
          spellCheck={false}
          className={cn(
            "h-8 min-w-0 flex-1 rounded-[7px] border border-input bg-transparent px-2.5 font-mono text-[13px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
            !saved && "border-danger-ink/50",
          )}
        />
        {dirty ? (
          <>
            <Button type="button" variant="ghost" onClick={() => setValue(saved)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </>
        ) : null}
      </div>
      <span className={cn("text-[12.5px]", saved ? "text-muted-foreground" : "text-danger-ink")}>{help}</span>
    </form>
  );
}

function WhereItLands({ row, board, teamName }: { row: EventTypeRow; board: Board; teamName: (id: string) => string }) {
  const { eventType, placements } = row;
  const teams = new Set(placements.flatMap((placement) => (placement.teamId ? [placement.teamId] : [])));
  // Teams that inherit a Shared cell this event type fills.
  const inheritedBy = (programId: string, mode: "normal" | "extended") =>
    board.teams.filter((team) => {
      const cell = board.teamCell(team, programId, mode);
      return cell.kind === "inherited" && cell.eventTypeConfigId === eventType._id;
    }).length;

  return (
    <section className="border-b border-border px-[18px] py-3.5">
      <h3 className={cn(LABEL, "mb-2.5 flex items-center gap-2")}>
        Where it lands · {teams.size} {teams.size === 1 ? "team" : "teams"}
        {placements.some((placement) => placement.teamId === null) ? " + Shared" : ""}
      </h3>
      {placements.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          {row.status === "sorted" && row.bookable.word === "Ready"
            ? "In no cell yet. It is ready: pick it in a Coverage cell to offer it."
            : "In no cell. Fix what’s missing above before placing it."}
        </p>
      ) : (
        <ul className="overflow-hidden rounded-[7px] border border-border">
          {placements.map((placement) => {
            const issue = cellIssue({ programId: placement.programId, mode: placement.mode, eventTypeConfigId: eventType._id }, eventType);
            const inherited = placement.teamId === null ? inheritedBy(placement.programId, placement.mode) : 0;
            const program = board.programs.find((candidate) => candidate._id === placement.programId)?.name ?? "A removed program";
            return (
              <li key={`${placement.teamId ?? "shared"}:${placement.programId}:${placement.mode}`} className="border-t border-border first:border-t-0">
                <Link
                  href={coverageCellHref(placement)}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_76px_auto] items-center gap-2.5 px-3 py-2 text-[13px] outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
                >
                  <span className="truncate">{placement.teamId === null ? "Shared" : teamName(placement.teamId)}</span>
                  <span className="truncate">{program}</span>
                  <span className={cn(WORD, "text-stage-held")}>{modeLabel(placement.mode)}</span>
                  <span className="truncate">
                    {issue ? (
                      <span className={cn(WORD, "text-danger-ink")}>Broken</span>
                    ) : (
                      <span className={cn(WORD, "text-foreground")}>Own route</span>
                    )}
                    {inherited > 0 ? <span className="text-xs text-muted-foreground"> · inherited by {inherited}</span> : null}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function calendlyStatus(status: string | undefined) {
  if (status === "inactive") return "Switched off";
  if (status === "deleted") return "Deleted";
  if (status === "not_returned") return "Not returned";
  return "Active";
}

function platformLabel(value: string | undefined) {
  switch (value) {
    case "instagram":
      return "Instagram";
    case "tiktok":
      return "TikTok";
    case "twitter":
      return "X";
    case "other_social":
      return "Other";
    default:
      return "—";
  }
}

