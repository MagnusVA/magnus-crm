"use client";

import Link from "next/link";
import { EllipsisIcon, ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  calendlyNameIfDifferent,
  eventTypeFacts,
  linkIssue,
  modeLabel,
  modeOf,
  usedInLabel,
  type CoverageEventType,
  type EventTypeSorting,
  type EventTypeStatus,
  type Placement,
} from "../../_components/booking-model";
import { CalendlyDot } from "../../_components/calendly-dot";
import { COL_LINK, COL_PAYMENT, COL_PROGRAM, COL_USED_IN, ROW_GRID } from "./event-types-layout";

export type EventTypeRow = {
  eventType: CoverageEventType;
  status: EventTypeStatus;
  placements: Placement[];
};

export type EventTypeGroup = {
  key: string;
  /** The 26px heading; null when the filter already names the rows. */
  label: string | null;
  rows: EventTypeRow[];
};

const HEAD = "font-condensed text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase";
const WORD = "font-condensed text-[13px] font-bold tracking-[0.08em] uppercase";

export function EventTypesTable({
  groups,
  programName,
  onEdit,
  onSort,
}: {
  groups: readonly EventTypeGroup[];
  programName: (programId: string) => string;
  onEdit: (row: EventTypeRow) => void;
  onSort: (row: EventTypeRow, sorting: EventTypeSorting) => void;
}) {
  return (
    <div>
      <div aria-hidden="true" className={cn(ROW_GRID, "hidden min-h-8 border-b px-4 @2xl/et:grid")}>
        <span className={HEAD}>Event type</span>
        <span className={cn(HEAD, COL_PROGRAM)}>Program</span>
        <span className={cn(HEAD, COL_USED_IN)}>Used in</span>
        <span className={cn(HEAD, COL_LINK)}>Link</span>
        <span className={cn(HEAD, COL_PAYMENT)}>Payment</span>
        <span />
      </div>
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label ?? undefined}>
          {group.label ? (
            <h3 className={cn(HEAD, "flex min-h-[26px] items-center border-b bg-muted/40 px-4")}>
              {group.label} · {group.rows.length}
            </h3>
          ) : null}
          <ul>
            {group.rows.map((row) => (
              <EventTypeRowView key={row.eventType._id} row={row} programName={programName} onEdit={onEdit} onSort={onSort} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function EventTypeRowView({
  row,
  programName,
  onEdit,
  onSort,
}: {
  row: EventTypeRow;
  programName: (programId: string) => string;
  onEdit: (row: EventTypeRow) => void;
  onSort: (row: EventTypeRow, sorting: EventTypeSorting) => void;
}) {
  const { eventType, status, placements } = row;
  const calendlyName = calendlyNameIfDifferent(eventType);
  const gone = status === "gone";
  const program = <ProgramCell row={row} programName={programName} />;
  const link = <LinkWord row={row} />;

  return (
    <li
      className={cn(
        ROW_GRID,
        "relative min-h-11 border-b px-4 py-1.5 transition-colors last:border-b-0 hover:bg-muted/60",
        gone && "text-muted-foreground",
      )}
    >
      <div className="min-w-0">
        <button
          type="button"
          onClick={() => onEdit(row)}
          className="flex max-w-full min-w-0 items-center gap-2 rounded-sm text-left outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
        >
          <CalendlyDot color={gone ? undefined : eventType.calendlyColor} />
          <span className={cn("truncate", gone ? "font-normal" : "font-medium")}>{eventType.displayName}</span>
        </button>
        {/* From @2xl the facts; narrower, the program and link in words. */}
        <p className="hidden truncate pl-4 text-[13px] text-muted-foreground @2xl/et:block">
          {eventTypeFacts(eventType)}
          {calendlyName ? ` · Calendly: ${calendlyName}` : null}
        </p>
        <p className="flex min-w-0 items-center gap-1.5 truncate pl-4 text-[13px] text-muted-foreground @2xl/et:hidden">
          {program}
          <span aria-hidden="true">·</span>
          {link}
        </p>
      </div>
      <div className={cn(COL_PROGRAM, "min-w-0")}>{program}</div>
      <div className={cn(COL_USED_IN, "min-w-0 truncate text-sm")}>
        <UsedIn status={status} placements={placements} />
      </div>
      <div className={cn(COL_LINK, "min-w-0")}>{link}</div>
      <div className={cn(COL_PAYMENT, "text-sm")}>
        {eventType.paymentLinkCount > 0 ? (
          <>
            <span className="font-condensed text-[15px] font-semibold tabular-nums">{eventType.paymentLinkCount}</span>{" "}
            {eventType.paymentLinkCount === 1 ? "link" : "links"}
          </>
        ) : (
          <span className="text-muted-foreground">None</span>
        )}
      </div>
      <RowMenu row={row} onEdit={onEdit} onSort={onSort} />
    </li>
  );
}

function ProgramCell({ row, programName }: { row: EventTypeRow; programName: (programId: string) => string }) {
  const { eventType, status } = row;
  if (status === "sorted" && eventType.bookingProgramId) {
    return (
      <span className="inline-flex min-w-0 items-baseline gap-1.5">
        <span className="truncate text-sm text-foreground">{programName(eventType.bookingProgramId)}</span>
        <span className={cn(WORD, "shrink-0 text-[11px] text-muted-foreground")}>{modeLabel(modeOf(eventType))}</span>
      </span>
    );
  }
  if (status === "unsorted") return <span className={cn(WORD, "text-warning-ink")}>Unsorted</span>;
  if (status === "not_sales_call") return <span className="text-sm text-muted-foreground">Not a sales call</span>;
  return <span className="text-sm text-muted-foreground">Gone from Calendly</span>;
}

function LinkWord({ row }: { row: EventTypeRow }) {
  const { eventType, status, placements } = row;
  if (status === "not_sales_call" || status === "gone") {
    return <span className="text-sm text-muted-foreground">—</span>;
  }
  const issue = linkIssue(eventType);
  if (issue === null) return <span className={cn(WORD, "text-foreground")}>Ready</span>;
  if (issue === "missing_url") return <span className={cn(WORD, "text-warning-ink")}>No booking URL</span>;
  return (
    <span className={cn(WORD, placements.length > 0 ? "text-danger-ink" : "text-muted-foreground")}>
      Inactive in Calendly
    </span>
  );
}

function UsedIn({ status, placements }: { status: EventTypeStatus; placements: readonly Placement[] }) {
  const label = usedInLabel(placements);
  if (!label) return <span className="text-muted-foreground">Not in coverage</span>;
  // Cells still pointing at an event type that no longer counts for a program are broken.
  if (status !== "sorted") return <span className="text-danger-ink">{label} · broken</span>;
  return <span>{label}</span>;
}

function RowMenu({
  row,
  onEdit,
  onSort,
}: {
  row: EventTypeRow;
  onEdit: (row: EventTypeRow) => void;
  onSort: (row: EventTypeRow, sorting: EventTypeSorting) => void;
}) {
  const { eventType, status, placements } = row;
  const cells = placements.length;
  const breaks =
    status === "sorted" && cells > 0
      ? `${cells} coverage ${cells === 1 ? "cell uses" : "cells use"} it and will show as broken.`
      : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="relative z-10 justify-self-end"
          aria-label={`Actions for ${eventType.displayName}`}
        >
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem onSelect={() => onEdit(row)}>Edit details</DropdownMenuItem>
        {status === "sorted" ? (
          <>
            <MenuChoice detail={breaks} onSelect={() => onSort(row, { kind: "unsorted" })}>
              Move to inbox
            </MenuChoice>
            <MenuChoice detail={breaks} onSelect={() => onSort(row, { kind: "not_sales_call" })}>
              Not a sales call
            </MenuChoice>
          </>
        ) : null}
        {status === "unsorted" ? (
          <>
            <DropdownMenuItem asChild>
              <Link href={`/workspace/booking/inbox?id=${eventType._id}`}>Sort in the inbox</Link>
            </DropdownMenuItem>
            <MenuChoice
              detail="Bookings on it stay out of booking setup."
              onSelect={() => onSort(row, { kind: "not_sales_call" })}
            >
              Not a sales call
            </MenuChoice>
          </>
        ) : null}
        {status === "gone" ? (
          <MenuChoice detail="Files it away; it stays here under Not a sales call." onSelect={() => onSort(row, { kind: "not_sales_call" })}>
            Not a sales call
          </MenuChoice>
        ) : null}
        {status === "not_sales_call" ? (
          <MenuChoice detail="It goes back to the inbox to be sorted." onSelect={() => onSort(row, { kind: "unsorted" })}>
            Bring back
          </MenuChoice>
        ) : null}
        {eventType.calendlySchedulingUrl ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a href={eventType.calendlySchedulingUrl} target="_blank" rel="noopener noreferrer">
                Open in Calendly
                <ExternalLinkIcon className="ml-auto" aria-hidden="true" />
              </a>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A menu item that says its consequence under its name. */
function MenuChoice({
  detail,
  onSelect,
  children,
}: {
  detail: string | null;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect} className="flex-col items-start gap-0">
      <span>{children}</span>
      {detail ? <span className="text-[12px] text-muted-foreground">{detail}</span> : null}
    </DropdownMenuItem>
  );
}
