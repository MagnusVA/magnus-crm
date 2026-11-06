"use client";

import { useId } from "react";
import Link from "next/link";
import type { MissedMeetingRow } from "@/convex/operations/missedMeetings";
import type { MissedMeeting } from "@/convex/opportunities/dealState";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { dealHref, ROW_LINK } from "@/app/workspace/closer/pipeline/_components/deal-cells";
import { formatWholeNumber } from "@/app/workspace/_components/overview-formatters";
import { CARD, HelpTip, LABEL, teamShortName } from "@/app/workspace/team/_components/team-ui";
import { businessDateForInstant, type BusinessDaySetting } from "@/lib/businessDay";
import { MISSED_MEETINGS_EXPORT_CAP } from "@/lib/operations-reports/missed-meetings-export";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";
import { kindTabId } from "./missed-kind-tabs";

// The results card: the deals a missed meeting closed, newest first, as
// ruled 44px column rows. Each row links to the deal on the person's page.
// Below @3xl of the card each deal is two lines. The band's tabs pick the
// kind; the source stays in the CSV.

export type KindFilter = MissedMeeting | "all";

export type KindCounts = Record<KindFilter, number>;

/** The card the band's tabs control. */
export const MISSED_DEALS_CARD_ID = "missed-deals";

export type ListState =
  | { kind: "complete"; truncated: boolean }
  | { kind: "loading"; soFar: number };

// WHEN · PERSON · CONTACT · CLOSER · BOOKED BY · STATUS.
const COLUMNS =
  "@3xl/missed:grid @3xl/missed:grid-cols-[7.5rem_minmax(0,1.1fr)_minmax(0,1.5fr)_minmax(0,0.8fr)_minmax(0,1.2fr)_5rem] @3xl/missed:gap-3";

const STATUS_WORD = "font-condensed text-[13px] leading-none font-bold tracking-[0.08em] whitespace-nowrap uppercase";

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

/** The setter(s), then the DM closer, then their DM team's short name (also alone). */
function bookedBy(row: MissedMeetingRow) {
  const team = row.dmTeamName ? teamShortName(row.dmTeamName) : null;
  const names = [row.setterName, row.dmCloserName].filter((name): name is string => name !== null);
  if (names.length === 0 && team === null) return null;
  const title = [
    row.setterName ? `Setter: ${row.setterName}` : null,
    row.dmCloserName
      ? `DM closer: ${row.dmCloserName}${row.dmTeamName ? `, ${row.dmTeamName}` : ""}`
      : row.dmTeamName
        ? `DM team: ${row.dmTeamName}`
        : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return { names: names.join(", "), team, title };
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
  kind,
  hideBookedAgain,
  onHideBookedAgainChange,
  listState,
  reloading,
  rangePhrase,
  setting,
  todayBusinessDate,
}: {
  /** The deals the band's tab shows; undefined before the first rows arrive. */
  rows: MissedMeetingRow[] | undefined;
  /** The band's tab, which labels the card. */
  kind: KindFilter;
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
    <section
      id={MISSED_DEALS_CARD_ID}
      role="tabpanel"
      aria-labelledby={kindTabId(kind)}
      className={cn(CARD, "@container/missed")}
    >
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2">
        <div className="mr-auto flex min-w-0 items-baseline gap-2.5">
          <h2 className="text-[15px] font-semibold">Deals</h2>
          <span className="truncate text-[13px] text-muted-foreground">
            {rows === undefined || count === 0 ? (
              "Newest first"
            ) : (
              <>
                <span className="font-condensed text-[14px] font-semibold tabular-nums">{formatWholeNumber(count)}</span>
                {" · newest first"}
              </>
            )}
          </span>
        </div>
        <div className="flex min-h-6 items-center gap-2">
          <Switch id={switchId} checked={hideBookedAgain} onCheckedChange={onHideBookedAgainChange} />
          <label htmlFor={switchId} className="cursor-pointer text-[13px]">
            Hide people who{" "}
            <HelpTip tip="People with a newer deal that has a booking. They already came back, so they're left out of the list and the export.">
              booked again
            </HelpTip>
          </label>
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
          <div className={cn("hidden min-h-7 items-end border-b border-border px-4 pb-1.5", COLUMNS, LABEL)}>
            <span>
              <HelpTip tip="When the missed call was booked for, in your workspace's time zone. The list runs by when the deal closed, newest first.">
                When
              </HelpTip>
            </span>
            <span>Person</span>
            <span>Contact</span>
            <span>
              <HelpTip tip="The closer the missed call was assigned to.">Closer</HelpTip>
            </span>
            <span>
              <HelpTip tip="The setter who qualified the person in Slack, and the DM closer who sent the booking link, with their team.">
                Booked by
              </HelpTip>
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

      {rows === undefined || (listState.kind === "complete" && !listState.truncated) ? null : (
        <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-4 py-2 text-[13px] text-muted-foreground">
          <p role="status" className="flex items-center gap-2">
            {listState.kind === "loading" ? (
              <>
                <Spinner aria-hidden="true" className="size-3.5" />
                Loading… {formatWholeNumber(listState.soFar)} so far
              </>
            ) : (
              <span className="text-foreground">
                This range holds more than {formatWholeNumber(MISSED_MEETINGS_EXPORT_CAP)} deals. The list and the export
                hold the newest {formatWholeNumber(MISSED_MEETINGS_EXPORT_CAP)}; narrow the range for the rest.
              </span>
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
  const handle = row.instagramHandle ? `@${row.instagramHandle}` : undefined;
  const phone = row.phone ? formatPhone(row.phone) : null;
  const credit = bookedBy(row);

  return (
    <li className="relative border-b border-border transition-colors last:border-b-0 hover:bg-muted/60">
      <div className={cn("flex flex-col gap-0.5 px-4 py-2 @3xl/missed:h-[43px] @3xl/missed:items-center @3xl/missed:py-0", COLUMNS)}>
        {/* WHEN, from @3xl */}
        <time
          dateTime={new Date(at).toISOString()}
          className="hidden truncate font-condensed text-[15px] font-semibold tabular-nums @3xl/missed:block"
        >
          {when.date} · {when.clock}
        </time>

        {/* PERSON; on narrow rows the status rides the same line */}
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Link
              href={dealHref(row.leadId, row.opportunityId)}
              title={handle}
              className={cn(ROW_LINK, "truncate font-semibold")}
            >
              {displayName(row)}
            </Link>
            {row.bookedAgain ? <BookedAgainChip /> : null}
          </div>
          <span className="@3xl/missed:hidden">
            <StatusWord kind={row.missedMeeting} />
          </span>
        </div>

        {/* Line 2 on narrow rows: when · phone (or email) */}
        <p className="truncate font-condensed text-[14px] text-muted-foreground tabular-nums @3xl/missed:hidden">
          {when.date} · {when.clock} · {phone ?? <span className="font-sans text-[13px]">{row.email ?? "No contact"}</span>}
        </p>

        {/* CONTACT: phone, then email */}
        <p className="hidden min-w-0 truncate text-[13px] @3xl/missed:block">
          {phone || row.email ? (
            <>
              {phone ? <span className="font-condensed text-[15px] font-semibold tabular-nums">{phone}</span> : null}
              {phone && row.email ? <span className="text-muted-foreground"> · </span> : null}
              {row.email}
            </>
          ) : (
            <Dash />
          )}
        </p>

        {/* CLOSER */}
        <p className="hidden truncate @3xl/missed:block">{row.closerName ?? <Dash />}</p>

        {/* BOOKED BY: setter, DM closer · team */}
        <p className="hidden truncate @3xl/missed:block" title={credit?.title}>
          {credit ? (
            <>
              {credit.names}
              {credit.team ? (
                <span className="text-muted-foreground">
                  {credit.names ? " · " : "DM team "}
                  {credit.team}
                </span>
              ) : null}
            </>
          ) : (
            <Dash />
          )}
        </p>

        {/* STATUS, from @3xl */}
        <span className="hidden @3xl/missed:block">
          <StatusWord kind={row.missedMeeting} />
        </span>
      </div>
    </li>
  );
}

/** The card's rows while the first page loads: 44px from @3xl, two lines narrower. */
function RowsSkeleton() {
  return (
    <div role="status" aria-label="Loading deals">
      <div className="hidden min-h-7 border-b border-border @3xl/missed:block" />
      {Array.from({ length: 10 }, (_, index) => (
        <div
          key={index}
          className="flex min-h-[55px] flex-col justify-center gap-1.5 border-b border-border px-4 py-2 last:border-b-0 @3xl/missed:h-11 @3xl/missed:min-h-0 @3xl/missed:flex-row @3xl/missed:items-center @3xl/missed:gap-3 @3xl/missed:py-0"
        >
          <Skeleton className="hidden h-3.5 w-[7.5rem] @3xl/missed:block" />
          <Skeleton className="h-4 w-40 max-w-full" />
          <Skeleton className="h-3 w-48 max-w-full @3xl/missed:hidden" />
          <Skeleton className="hidden h-3.5 w-[30%] @3xl/missed:block" />
          <Skeleton className="ml-auto hidden h-3.5 w-14 @3xl/missed:block" />
        </div>
      ))}
    </div>
  );
}
