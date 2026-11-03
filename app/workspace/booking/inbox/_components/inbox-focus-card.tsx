"use client";

import Link from "next/link";
import { ChevronDownIcon, ChevronUpIcon, CornerDownLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import {
  calendlyNameIfDifferent,
  modeLabel,
  poolingLabel,
  type CoverageProgram,
  type SchedulingMode,
} from "../../_components/booking-model";
import { CalendlyDot } from "../../_components/calendly-dot";
import type { InboxItem } from "./inbox-shared";

const LABEL = "font-condensed text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase";

const SEGMENT =
  "h-7 gap-1.5 rounded-[5px]! px-3 text-[13px] text-muted-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-[0_1px_2px_rgb(20_26_40/0.12)]";

const PROGRAM_CHOICE =
  "relative flex min-h-9 w-full items-center gap-2 rounded-[7px] border bg-card px-3 py-1.5 text-left text-sm outline-none transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 aria-checked:border-foreground/40 aria-checked:bg-muted/80 aria-checked:shadow-[inset_3px_0_0_var(--color-foreground)]";

const CALENDLY_STATUS: Record<string, string> = {
  active: "Active",
  inactive: "Inactive",
  deleted: "Deleted",
  not_returned: "Not returned by the last sync",
};

/**
 * The focused event type: what Calendly says about it, the suggestion and
 * why, then the decision. Every choice has a key (see the legend).
 */
export function InboxFocusCard({
  item,
  position,
  total,
  programs,
  programName,
  programId,
  mode,
  busy,
  onProgram,
  onMode,
  onSort,
  onNotSalesCall,
  onSkip,
  onMove,
}: {
  item: InboxItem;
  position: number;
  total: number;
  programs: readonly CoverageProgram[];
  programName: (programId: string) => string;
  programId: CoverageProgram["_id"] | null;
  mode: SchedulingMode;
  busy: boolean;
  onProgram: (programId: CoverageProgram["_id"]) => void;
  onMode: (mode: SchedulingMode) => void;
  onSort: () => void;
  onNotSalesCall: () => void;
  onSkip: () => void;
  onMove: (delta: 1 | -1) => void;
}) {
  const { eventType, suggestion } = item;
  const calendlyName = calendlyNameIfDifferent(eventType);
  const bookingUrl = eventType.bookingBaseUrl ?? eventType.calendlySchedulingUrl;
  const chosen = programId ? `${programName(programId)} · ${modeLabel(mode)}` : null;

  return (
    <section aria-labelledby="inbox-focus-title" className="flex min-h-0 flex-col">
      <div className="flex min-h-11 items-center gap-2 border-b px-4 py-2">
        <h2 className="text-[15px] font-semibold">Sort this event type</h2>
        <span className="ml-auto text-[13px] text-muted-foreground">
          <span className="font-condensed text-[15px] font-semibold text-foreground tabular-nums">{position}</span> of{" "}
          <span className="font-condensed text-[15px] font-semibold text-foreground tabular-nums">{total}</span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Previous event type (K)"
          disabled={position <= 1}
          onClick={() => onMove(-1)}
        >
          <ChevronUpIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Next event type (J)"
          disabled={position >= total}
          onClick={() => onMove(1)}
        >
          <ChevronDownIcon />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="flex flex-col gap-3 px-4 pt-4 pb-3 @4xl:px-5">
          <div className="min-w-0">
            <h3 id="inbox-focus-title" className="flex items-center gap-2 text-xl leading-tight font-semibold">
              <CalendlyDot color={eventType.calendlyColor} />
              <span className="min-w-0 break-words">{eventType.displayName}</span>
            </h3>
            {calendlyName ? (
              <p className="mt-1 pl-4 text-[13px] text-muted-foreground">Calendly calls it “{calendlyName}”</p>
            ) : null}
          </div>

          <dl className="grid grid-cols-2 overflow-hidden rounded-[7px] border @2xl:grid-cols-3">
            <Fact label="Length">
              {eventType.calendlyDurationMinutes !== undefined ? (
                <span className="font-condensed text-[15px] font-semibold tabular-nums">
                  {eventType.calendlyDurationMinutes} min
                </span>
              ) : (
                <span className="text-muted-foreground">Not synced</span>
              )}
            </Fact>
            <Fact label="Hosts">{poolingLabel(eventType.calendlyPoolingType)}</Fact>
            <Fact label="In Calendly">
              {eventType.calendlySyncStatus ? (CALENDLY_STATUS[eventType.calendlySyncStatus] ?? eventType.calendlySyncStatus) : "Not synced yet"}
            </Fact>
            <Fact label="Added">{formatDay(eventType._creationTime)}</Fact>
            <Fact label="Last synced">
              {eventType.lastCalendlySyncedAt ? formatDayTime(eventType.lastCalendlySyncedAt) : "Never"}
            </Fact>
            <Fact label="Booking URL" className="col-span-2 @2xl:col-span-3">
              {bookingUrl ? (
                <span className="block truncate font-mono text-[13px]" title={bookingUrl}>
                  {bookingUrl.replace(/^https?:\/\//, "")}
                </span>
              ) : (
                <span className="text-warning-ink">No booking URL</span>
              )}
            </Fact>
          </dl>

          {suggestion ? (
            <p className="text-[13px] text-muted-foreground">
              <span className={cn(LABEL, "mr-2")}>Suggested</span>
              <span className="text-sm font-semibold text-foreground">
                {programName(suggestion.programId)} · {modeLabel(suggestion.mode)}
              </span>
              <span> · {suggestion.reason}</span>
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-4 border-t bg-background px-4 py-4 @4xl:px-5">
          {programs.length === 0 ? (
            <p className="text-sm">
              <span className="font-medium">No programs yet.</span>{" "}
              <span className="text-muted-foreground">
                Event types are sorted into programs, so add one on{" "}
                <Link href="/workspace/booking" className="font-semibold text-foreground underline decoration-foreground/40 underline-offset-[3px] hover:decoration-foreground">
                  Coverage
                </Link>{" "}
                first. You can still set this one aside as not a sales call.
              </span>
            </p>
          ) : (
            <>
              <div role="radiogroup" aria-labelledby="inbox-program-label" className="flex flex-col gap-2">
                <span id="inbox-program-label" className={LABEL}>
                  Program
                </span>
                <div className="grid grid-cols-1 gap-2 @lg:grid-cols-2 @6xl:grid-cols-3">
                  {programs.map((program, index) => (
                    <button
                      key={program._id}
                      type="button"
                      role="radio"
                      aria-checked={program._id === programId}
                      data-inbox-choice=""
                      onClick={() => onProgram(program._id)}
                      className={PROGRAM_CHOICE}
                    >
                      <span className="min-w-0 flex-1 truncate font-medium">{program.name}</span>
                      {index < 9 ? <Kbd aria-hidden="true">{index + 1}</Kbd> : null}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <span id="inbox-mode-label" className={LABEL}>
                  Scheduling
                </span>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <ToggleGroup
                    type="single"
                    value={mode}
                    onValueChange={(next) => {
                      if (next === "normal" || next === "extended") onMode(next);
                    }}
                    aria-labelledby="inbox-mode-label"
                    className="rounded-[7px] border bg-card p-0.5"
                  >
                    <ToggleGroupItem value="normal" data-inbox-choice="" className={SEGMENT}>
                      Priority <Kbd aria-hidden="true">P</Kbd>
                    </ToggleGroupItem>
                    <ToggleGroupItem value="extended" data-inbox-choice="" className={SEGMENT}>
                      Standard <Kbd aria-hidden="true">S</Kbd>
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>
              </div>
            </>
          )}

          <div className="flex flex-col gap-2 border-t pt-4">
            <div className="flex flex-wrap items-center gap-2">
              {programs.length > 0 ? (
                <Button
                  type="button"
                  size="lg"
                  className="font-semibold"
                  disabled={!chosen || busy}
                  onClick={onSort}
                >
                  {chosen ? `Sort into ${chosen}` : "Choose a program"}
                  <Kbd aria-hidden="true" className="bg-primary-foreground/10 text-primary-foreground">
                    <CornerDownLeftIcon />
                  </Kbd>
                </Button>
              ) : null}
              <Button type="button" size="lg" variant="outline" disabled={busy} onClick={onNotSalesCall}>
                Not a sales call <Kbd aria-hidden="true">N</Kbd>
              </Button>
              <Button type="button" size="lg" variant="ghost" disabled={total <= 1} onClick={onSkip}>
                Skip <Kbd aria-hidden="true">J</Kbd>
              </Button>
            </div>
            <p className="text-[13px] text-muted-foreground">
              Not a sales call: bookings on it stay out of booking setup. You can bring it back from{" "}
              <Link
                href="/workspace/booking/event-types?filter=not_sales_call"
                className="font-semibold text-foreground underline decoration-foreground/40 underline-offset-[3px] hover:decoration-foreground"
              >
                Event types
              </Link>
              .
            </p>
          </div>
        </div>
      </div>

      <ShortcutLegend hasPrograms={programs.length > 0} />
    </section>
  );
}

function Fact({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("-mt-px -ml-px flex min-w-0 flex-col gap-0.5 border-t border-l px-3 py-2", className)}>
      <dt className={LABEL}>{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

function ShortcutLegend({ hasPrograms }: { hasPrograms: boolean }) {
  const keys: Array<[React.ReactNode, string]> = [
    ...(hasPrograms
      ? ([
          [<Kbd key="n">1–9</Kbd>, "program"],
          [
            <span key="ps" className="inline-flex gap-0.5">
              <Kbd>P</Kbd>
              <Kbd>S</Kbd>
            </span>,
            "scheduling",
          ],
          [
            <Kbd key="enter">
              <CornerDownLeftIcon />
            </Kbd>,
            "sort",
          ],
        ] satisfies Array<[React.ReactNode, string]>)
      : []),
    [<Kbd key="nsc">N</Kbd>, "not a sales call"],
    [
      <span key="jk" className="inline-flex gap-0.5">
        <Kbd>J</Kbd>
        <Kbd>K</Kbd>
      </span>,
      "next, previous",
    ],
  ];
  return (
    <div
      aria-hidden="true"
      className="hidden flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-[12px] text-muted-foreground @2xl:flex @4xl:px-5"
    >
      {keys.map(([key, label]) => (
        <span key={label} className="inline-flex items-center gap-1.5">
          {key}
          {label}
        </span>
      ))}
    </div>
  );
}

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const DAY_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

function formatDay(timestamp: number) {
  const date = new Date(timestamp);
  return (date.getFullYear() === new Date().getFullYear() ? DAY : DAY_YEAR).format(date);
}

function formatDayTime(timestamp: number) {
  return `${formatDay(timestamp)}, ${TIME.format(new Date(timestamp))}`;
}
