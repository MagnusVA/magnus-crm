"use client";

import { useId } from "react";
import Link from "next/link";
import type { MissedMeetingRow } from "@/convex/operations/missedMeetings";
import type { MissedMeeting } from "@/convex/opportunities/dealState";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { dealHref, ROW_LINK } from "@/app/workspace/closer/pipeline/_components/deal-cells";
import { formatWholeNumber } from "@/app/workspace/_components/overview-formatters";
import { CARD, HelpTip, LABEL } from "@/app/workspace/team/_components/team-ui";
import { businessDateForInstant, type BusinessDaySetting } from "@/lib/businessDay";
import { DEAL_SOURCE_LABELS, MISSED_MEETINGS_EXPORT_CAP } from "@/lib/operations-reports/missed-meetings-export";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";

// The results card: the deals a missed meeting closed, newest first, as
// ruled column rows. Each row links to the deal on the person's page. The
// rows fold before they stack: below @5xl of the card Source and Setter ride
// the person's meta line, and below @3xl each deal is two lines.

export type KindFilter = MissedMeeting | "all";

export type ListState =
  | { kind: "complete"; truncated: boolean }
  | { kind: "loading"; soFar: number };

const COLUMNS =
  "@3xl/missed:grid @3xl/missed:grid-cols-[6.5rem_minmax(0,1.35fr)_minmax(0,1.25fr)_minmax(0,0.9fr)_minmax(0,1fr)_5.5rem] @5xl/missed:grid-cols-[6.5rem_minmax(0,1.3fr)_minmax(0,1.3fr)_5.5rem_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1fr)_5.5rem]";

const STATUS_WORD = "font-condensed text-[13px] leading-none font-bold tracking-[0.08em] whitespace-nowrap uppercase";

const TABS: ReadonlyArray<{ value: KindFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "no_show", label: "No-shows" },
  { value: "canceled", label: "Canceled" },
];

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
function dateFormatter(timeZone: string, withYear: boolean) {
  const key = `${timeZone}|${withYear}`;
  let cached = dateFormatters.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      ...(withYear ? { year: "numeric" } : {}),
    });
    dateFormatters.set(key, cached);
  }
  return cached;
}
const clockFormatters = new Map<string, Intl.DateTimeFormat>();
function clockFormatter(timeZone: string) {
  let cached = clockFormatters.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
    clockFormatters.set(timeZone, cached);
  }
  return cached;
}

/** "Nov 4" and "2:15 PM" in the tenant's time zone, the year only outside this one. */
function whenParts(at: number, setting: BusinessDaySetting, thisYear: string) {
  const withYear = businessDateForInstant(at, setting).slice(0, 4) !== thisYear;
  return { date: dateFormatter(setting.timeZone, withYear).format(at), clock: clockFormatter(setting.timeZone).format(at) };
}

function displayName(row: MissedMeetingRow) {
  return row.personName ?? row.email ?? (row.instagramHandle ? `@${row.instagramHandle}` : "Unnamed person");
}

function Dash() {
  return <span className="text-muted-foreground">—</span>;
}

function StatusWord({ kind }: { kind: MissedMeeting }) {
  return kind === "no_show" ? (
    <span className={cn(STATUS_WORD, "text-danger-ink")}>No-show</span>
  ) : (
    <span className={cn(STATUS_WORD, "text-muted-foreground")}>Canceled</span>
  );
}

function BookedAgainChip() {
  return (
    <span className="inline-flex h-[18px] shrink-0 items-center rounded-[4px] bg-muted px-1.5 font-condensed text-[11px] leading-none font-bold tracking-[0.1em] whitespace-nowrap text-muted-foreground uppercase">
      Booked again
    </span>
  );
}

export function MissedDealsCard({
  rows,
  counts,
  kind,
  onKindChange,
  hideBookedAgain,
  onHideBookedAgainChange,
  listState,
  reloading,
  rangePhrase,
  setting,
  todayBusinessDate,
}: {
  /** The deals the kind filter shows; undefined before the first rows arrive. */
  rows: MissedMeetingRow[] | undefined;
  /** Counts for the toggle, across both kinds. */
  counts: Record<KindFilter, number> | undefined;
  kind: KindFilter;
  onKindChange: (kind: KindFilter) => void;
  hideBookedAgain: boolean;
  onHideBookedAgainChange: (hide: boolean) => void;
  listState: ListState;
  /** Kept rows from the last range, dimmed while the new one loads. */
  reloading: boolean;
  /** "this month", "in the last 30 days". */
  rangePhrase: string;
  setting: BusinessDaySetting;
  todayBusinessDate: string;
}) {
  const switchId = useId();
  const thisYear = todayBusinessDate.slice(0, 4);
  const count = rows?.length ?? 0;
  const emptyTitle =
    kind === "no_show"
      ? `No no-shows ${rangePhrase}.`
      : kind === "canceled"
        ? `No canceled calls ${rangePhrase}.`
        : `No no-shows or cancellations ${rangePhrase}.`;

  return (
    <section aria-labelledby="missed-deals-title" className={cn(CARD, "@container/missed")}>
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2">
        <div className="mr-auto flex min-w-0 items-baseline gap-2.5">
          <h2 id="missed-deals-title" className="text-[15px] font-semibold">
            Deals
          </h2>
          <span className="truncate text-[13px] text-muted-foreground">
            {rows === undefined ? "Newest first" : `${formatWholeNumber(count)} ${count === 1 ? "deal" : "deals"} · newest first`}
          </span>
        </div>
        <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 @3xl/missed:w-auto">
          <ToggleGroup
            type="single"
            size="sm"
            value={kind}
            onValueChange={(next) => {
              const entry = TABS.find((tab) => tab.value === next);
              if (entry) onKindChange(entry.value);
            }}
            aria-label="Deals by missed meeting"
            className="rounded-[7px] border bg-background p-0.5"
          >
            {TABS.map((entry) => (
              <ToggleGroupItem
                key={entry.value}
                value={entry.value}
                className="h-6 gap-1 rounded-[5px]! px-2.5 text-[13px] text-muted-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-[0_1px_2px_rgb(20_26_40/0.12)]"
              >
                {entry.label}
                {counts ? (
                  <span className="font-condensed text-[14px] font-semibold tabular-nums">{formatWholeNumber(counts[entry.value])}</span>
                ) : null}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <div className="flex min-h-6 items-center gap-2">
            <Switch id={switchId} checked={hideBookedAgain} onCheckedChange={onHideBookedAgainChange} />
            <label htmlFor={switchId} className="cursor-pointer text-[13px]">
              Hide people who booked again
            </label>
          </div>
        </div>
      </div>

      {rows === undefined ? (
        <RowsSkeleton />
      ) : rows.length === 0 && listState.kind === "complete" ? (
        <SectionEmpty title={emptyTitle}>
          {hideBookedAgain ? (
            <>
              People who booked again are hidden.{" "}
              <button
                type="button"
                onClick={() => onHideBookedAgainChange(false)}
                className={cn(detailLinkClass, "text-[13px]")}
              >
                Show them
              </button>
            </>
          ) : (
            "Deals show here when a no-show or a cancellation closes them."
          )}
        </SectionEmpty>
      ) : (
        <>
          <div className={cn("hidden min-h-7 items-end gap-3 border-b border-border px-4 pb-1.5", COLUMNS, LABEL)}>
            <span>
              <HelpTip tip="When the missed call was booked for, in your workspace's time zone. The list runs by when the deal closed, newest first.">
                When
              </HelpTip>
            </span>
            <span>Person</span>
            <span>Contact</span>
            <span className="hidden @5xl/missed:block">
              <HelpTip tip="How the deal started: a Calendly booking, a lead qualified in Slack, or a side deal.">Source</HelpTip>
            </span>
            <span>
              <HelpTip tip="The closer the missed call was assigned to.">Closer</HelpTip>
            </span>
            <span className="hidden @5xl/missed:block">
              <HelpTip tip="Who qualified the lead in Slack, when someone did.">Setter</HelpTip>
            </span>
            <span>
              <HelpTip tip="The DM closer and team credited with the booking, from its link.">DM closer</HelpTip>
            </span>
            <span>Status</span>
          </div>
          <ul
            aria-label="Deals a missed meeting closed"
            aria-busy={reloading}
            className={cn("transition-opacity duration-200 motion-reduce:transition-none", reloading && "opacity-60")}
          >
            {rows.map((row) => (
              <DealRow key={row.opportunityId} row={row} setting={setting} thisYear={thisYear} />
            ))}
          </ul>
        </>
      )}

      {rows === undefined ? null : (
        <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-4 py-2 text-[13px] text-muted-foreground">
          <p role="status" className="flex items-center gap-2">
            {listState.kind === "loading" ? (
              <>
                <Spinner aria-hidden="true" className="size-3.5" />
                Loading… {formatWholeNumber(listState.soFar)} so far
              </>
            ) : listState.truncated ? (
              <span className="text-foreground">
                This range holds more than {formatWholeNumber(MISSED_MEETINGS_EXPORT_CAP)} deals. The list and the export
                hold the newest {formatWholeNumber(MISSED_MEETINGS_EXPORT_CAP)}; narrow the range for the rest.
              </span>
            ) : (
              `${formatWholeNumber(count)} ${count === 1 ? "deal" : "deals"}, all loaded`
            )}
          </p>
        </div>
      )}
    </section>
  );
}

function DealRow({ row, setting, thisYear }: { row: MissedMeetingRow; setting: BusinessDaySetting; thisYear: string }) {
  const at = row.meetingAt ?? row.lostAt;
  const when = whenParts(at, setting, thisYear);
  const handle = row.instagramHandle ? `@${row.instagramHandle}` : null;
  const source = DEAL_SOURCE_LABELS[row.source];
  const phone = row.phone ? formatPhone(row.phone) : null;

  return (
    <li className="relative border-b border-border transition-colors last:border-b-0 hover:bg-muted/60">
      <div className={cn("flex flex-col gap-0.5 px-4 py-2 @3xl/missed:min-h-12 @3xl/missed:items-center @3xl/missed:gap-3 @3xl/missed:py-1.5", COLUMNS)}>
        {/* WHEN, from @3xl */}
        <time
          dateTime={new Date(at).toISOString()}
          className="hidden font-condensed text-[15px] leading-tight font-semibold tabular-nums @3xl/missed:block"
        >
          {when.date}
          <span className="block text-muted-foreground">{when.clock}</span>
        </time>

        {/* PERSON; on narrow rows the status rides the same line */}
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <Link href={dealHref(row.leadId, row.opportunityId)} className={cn(ROW_LINK, "truncate font-semibold")}>
                {displayName(row)}
              </Link>
              {row.bookedAgain ? <BookedAgainChip /> : null}
            </div>
            <p className="hidden truncate text-[13px] text-muted-foreground @3xl/missed:block">
              {handle ?? "No handle"}
              <span className="@5xl/missed:hidden">
                {" · "}
                {source}
                {row.setterName ? ` · set by ${row.setterName}` : null}
              </span>
            </p>
          </div>
          <span className="@3xl/missed:hidden">
            <StatusWord kind={row.missedMeeting} />
          </span>
        </div>

        {/* Line 2 on narrow rows: when · contact · closer */}
        <p className="truncate text-[13px] text-muted-foreground @3xl/missed:hidden">
          <span className="font-condensed text-[14px] font-semibold text-foreground tabular-nums">
            {when.date} · {when.clock}
          </span>
          {" · "}
          {phone ? <span className="font-condensed text-[14px] tabular-nums">{phone}</span> : null}
          {phone && row.email ? " · " : null}
          {row.email ?? (phone ? null : "No contact")}
          {row.closerName ? ` · ${row.closerName}` : null}
        </p>

        {/* CONTACT */}
        <div className="hidden min-w-0 @3xl/missed:block">
          <p className="truncate text-[13px]">{row.email ?? <Dash />}</p>
          <p className="truncate font-condensed text-[15px] leading-tight font-semibold tabular-nums">
            {phone ?? <Dash />}
          </p>
        </div>

        {/* SOURCE, from @5xl */}
        <p className="hidden truncate @5xl/missed:block">{source}</p>

        {/* CLOSER */}
        <p className="hidden truncate @3xl/missed:block">{row.closerName ?? <Dash />}</p>

        {/* SETTER, from @5xl */}
        <p className="hidden truncate @5xl/missed:block">{row.setterName ?? <Dash />}</p>

        {/* DM CLOSER */}
        <div className="hidden min-w-0 @3xl/missed:block">
          <p className="truncate">{row.dmCloserName ?? <Dash />}</p>
          {row.dmTeamName ? <p className="truncate text-[13px] text-muted-foreground">{row.dmTeamName}</p> : null}
        </div>

        {/* STATUS, from @3xl */}
        <span className="hidden @3xl/missed:block">
          <StatusWord kind={row.missedMeeting} />
        </span>
      </div>
    </li>
  );
}

function RowsSkeleton() {
  return (
    <div role="status" aria-label="Loading deals">
      <div className="hidden min-h-7 border-b border-border @3xl/missed:block" />
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="flex min-h-[57px] items-center gap-4 border-b border-border px-4 py-2 last:border-b-0">
          <div className="hidden w-[6.5rem] flex-col gap-1.5 @3xl/missed:flex">
            <Skeleton className="h-3.5 w-12" />
            <Skeleton className="h-3.5 w-14" />
          </div>
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-40 max-w-full" />
            <Skeleton className="h-3 w-28" />
          </div>
          <Skeleton className="hidden h-4 w-[40%] @3xl/missed:block" />
          <Skeleton className="h-3.5 w-14" />
        </div>
      ))}
    </div>
  );
}
