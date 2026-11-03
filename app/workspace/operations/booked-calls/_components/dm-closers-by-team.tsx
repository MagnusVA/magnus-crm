import { UserRoundXIcon } from "lucide-react";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { MemberAvatar } from "@/app/workspace/_components/member-avatar";
import { formatDecimal, formatWholeNumber } from "@/app/workspace/_components/overview-formatters";
import { Skeleton } from "@/components/ui/skeleton";
import { formatAmountMinor } from "@/lib/format-currency";
import { bookingPaceWord } from "@/lib/operations-reports/booking-pace";
import type { DmCloserViewModel } from "@/lib/operations-reports/booked-dashboard";
import { cn } from "@/lib/utils";
import { PACE_TONE, type BookingTeam } from "./booking-teams";

// DM closers ranked inside their own team: each team is a section headed by
// its pace, and the ranks start again at 1. Booked bars share one scale
// across the page so teams compare, and take their team's pace colour.
// The card is its own container (@container/closers): four columns from
// @lg, and below that the bar moves under the name.

const ROW = "grid items-center gap-x-3 px-4 grid-cols-[1.125rem_minmax(0,1fr)_auto] @lg/closers:grid-cols-[1.125rem_minmax(0,1fr)_minmax(7rem,11rem)_4.25rem]";
const HEAD = "font-condensed text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase";

function hoursLine(closer: DmCloserViewModel) {
  const hours =
    closer.scheduledHours !== null && closer.scheduledHours > 0
      ? `${Number.isInteger(closer.scheduledHours) ? closer.scheduledHours : formatDecimal(closer.scheduledHours)} h scheduled`
      : "No schedule";
  const rate = closer.hourlyRateMinor === null ? null : `${formatAmountMinor(closer.hourlyRateMinor, "USD")}/h rate`;
  return rate ? `${hours} · ${rate}` : hours;
}

function PerHour({ value }: { value: number | null }) {
  if (value === null) return <span className="text-[13px] whitespace-nowrap text-muted-foreground">No schedule</span>;
  return (
    <span className="font-condensed text-[15px] font-semibold whitespace-nowrap tabular-nums">
      {formatDecimal(value)}
      <span className="ml-0.5 font-sans text-[13px] font-medium text-muted-foreground">/h</span>
    </span>
  );
}

function BookedBar({ booked, max, fill }: { booked: number; max: number; fill: string }) {
  const width = max > 0 ? (booked / max) * 100 : 0;
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        {booked > 0 ? (
          <div
            className={cn("h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none", fill)}
            style={{ width: `${Math.max(width, 4)}%` }}
          />
        ) : null}
      </div>
      <span
        className={cn(
          "w-7 shrink-0 text-right font-condensed text-[15px] font-semibold tabular-nums",
          booked === 0 && "text-muted-foreground",
        )}
      >
        {formatWholeNumber(booked)}
      </span>
    </div>
  );
}

type TeamOnly = NonNullable<BookingTeam["teamOnly"]>;

function UtmPart({ label, value }: { label: string; value: string | null }) {
  return value === null ? (
    <span>no {label}</span>
  ) : (
    <span>
      {label} <span className="font-mono text-[12px] text-foreground">{value}</span>
    </span>
  );
}

/**
 * Bookings through the team's links that name no DM closer: they count
 * toward the team's goal (D9) but toward nobody below, so the closers plus
 * this row add up to the team's figure. Each UTM combination they came with
 * is listed under it.
 */
function NoDmCloserRow({ teamOnly, max, teamLabel }: { teamOnly: TeamOnly; max: number; teamLabel: string }) {
  return (
    <li className="border-t border-dashed bg-muted/25">
      <div className={cn(ROW, "py-2")}>
        <span aria-hidden="true" className="row-start-1 text-muted-foreground @lg/closers:row-start-auto">
          –
        </span>
        <div className="row-start-1 flex min-w-0 items-center gap-2.5 @lg/closers:row-start-auto">
          <span
            aria-hidden="true"
            className="grid size-6 shrink-0 place-items-center rounded-full border border-dashed border-muted-foreground/50 text-muted-foreground"
          >
            <UserRoundXIcon className="size-3.5" />
          </span>
          <div className="min-w-0">
            <p className="truncate font-medium">No DM closer</p>
            <p className="truncate text-[13px] text-muted-foreground">
              Counted toward {teamLabel}, credited to nobody
            </p>
          </div>
        </div>
        <div className="col-span-2 col-start-2 row-start-2 pt-1.5 @lg/closers:col-span-1 @lg/closers:col-start-auto @lg/closers:row-start-auto @lg/closers:pt-0">
          <BookedBar booked={teamOnly.booked} max={max} fill="bg-stage-held" />
        </div>
        <span className="col-start-3 row-start-1 @lg/closers:col-start-auto @lg/closers:row-start-auto" />
      </div>
      {teamOnly.sources === null ? (
        <p className="px-4 pb-2 pl-[calc(1.125rem+2.75rem+0.75rem)] text-[13px] text-muted-foreground">
          UTMs aren&apos;t broken down for this range.
        </p>
      ) : (
        <ul aria-label={`UTMs of ${teamLabel} bookings with no DM closer`} className="pb-2">
          {teamOnly.sources.map((source) => (
            <li
              key={JSON.stringify([source.utmSource, source.utmMedium, source.utmCampaign])}
              className="flex items-baseline gap-3 px-4 py-0.5 pl-[calc(1rem+1.125rem+0.75rem+2.125rem)] text-[13px] text-muted-foreground"
            >
              <span className="min-w-0 flex-1 truncate">
                <UtmPart label="medium" value={source.utmMedium} /> · <UtmPart label="campaign" value={source.utmCampaign} /> ·{" "}
                <UtmPart label="source" value={source.utmSource} />
              </span>
              <span className="shrink-0 font-condensed text-[14px] font-semibold text-foreground tabular-nums">
                {formatWholeNumber(source.booked)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function TeamSection({ team, max }: { team: BookingTeam; max: number }) {
  const tone = PACE_TONE[team.pace.kind];
  const headingId = `closers-team-${team.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const teamOnlyShown = (team.teamOnly?.booked ?? 0) > 0;
  return (
    <section aria-labelledby={headingId} className="border-b last:border-b-0">
      <div className="flex min-h-10 flex-wrap items-center gap-x-2.5 gap-y-0.5 bg-muted/50 px-4 py-2">
        <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", tone.fill)} />
        <h3 id={headingId} className="font-semibold">
          {team.label}
        </h3>
        {team.unassigned ? null : (
          <span className={cn("font-condensed text-[13px] font-bold tracking-[0.08em] uppercase", tone.ink)}>
            {bookingPaceWord(team.pace)}
          </span>
        )}
        <span className="ml-auto text-[13px] text-muted-foreground">
          <span className="font-condensed text-[15px] font-semibold text-foreground tabular-nums">
            {formatWholeNumber(team.pace.booked)}
          </span>{" "}
          {team.pace.goal === null ? "booked" : <>of {formatWholeNumber(team.pace.goal)} booked</>}
        </span>
      </div>
      {team.closers.length === 0 && !teamOnlyShown ? (
        <p className="border-t px-4 py-2.5 text-[13px] text-muted-foreground">No DM closer booked or was scheduled.</p>
      ) : (
        <ol aria-label={`${team.label} DM closers, most booked first`}>
          {team.closers.map((closer, index) => (
            <li key={closer.key} className={cn(ROW, "border-t py-2")}>
              <span className="row-start-1 font-condensed text-[15px] font-semibold text-muted-foreground tabular-nums @lg/closers:row-start-auto">
                {index + 1}
              </span>
              <div className="row-start-1 flex min-w-0 items-center gap-2.5 @lg/closers:row-start-auto">
                <MemberAvatar identity={closer.avatar} size="sm" />
                <div className="min-w-0">
                  <p className="truncate font-medium">{closer.label}</p>
                  <p className="truncate text-[13px] text-muted-foreground">{hoursLine(closer)}</p>
                </div>
              </div>
              <div className="col-span-2 col-start-2 row-start-2 pt-1.5 @lg/closers:col-span-1 @lg/closers:col-start-auto @lg/closers:row-start-auto @lg/closers:pt-0">
                <BookedBar booked={closer.booked} max={max} fill={tone.fill} />
              </div>
              <div className="col-start-3 row-start-1 text-right @lg/closers:col-start-auto @lg/closers:row-start-auto">
                <PerHour value={closer.bookedPerHour} />
              </div>
            </li>
          ))}
          {teamOnlyShown && team.teamOnly ? <NoDmCloserRow teamOnly={team.teamOnly} max={max} teamLabel={team.label} /> : null}
        </ol>
      )}
    </section>
  );
}

export function DmClosersByTeam({ teams, rangePhrase }: { teams: BookingTeam[]; rangePhrase: string }) {
  const closerCount = teams.reduce((sum, team) => sum + team.closers.length, 0);
  const max = Math.max(
    0,
    ...teams.flatMap((team) => [...team.closers.map((closer) => closer.booked), team.teamOnly?.booked ?? 0]),
  );
  return (
    <DetailCard title="DM closers by team" meta="Ranked within each team" className="min-w-0">
      {closerCount === 0 && teams.every((team) => team.pace.booked === 0) ? (
        <SectionEmpty title={`No DM closer booked or was scheduled ${rangePhrase}.`}>
          DM closers appear when a booking is attributed to them or they have a schedule.
        </SectionEmpty>
      ) : (
        <div className="@container/closers">
          <div aria-hidden="true" className={cn(ROW, "hidden min-h-7 border-b @lg/closers:grid")}>
            <span className={HEAD}>#</span>
            <span className={HEAD}>DM closer</span>
            <span className={HEAD}>Booked</span>
            <span className={cn(HEAD, "text-right")}>Per hour</span>
          </div>
          {teams.map((team) => (
            <TeamSection key={team.key} team={team} max={max} />
          ))}
        </div>
      )}
    </DetailCard>
  );
}

export function DmClosersByTeamSkeleton() {
  return (
    <DetailCard title="DM closers by team" meta="Ranked within each team" className="min-w-0">
      <div role="status" aria-label="Loading DM closers">
        {Array.from({ length: 2 }, (_, team) => (
          <div key={team} className="border-b last:border-b-0">
            <div className="flex min-h-10 items-center gap-2.5 bg-muted/50 px-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="ml-auto h-4 w-20" />
            </div>
            {Array.from({ length: 2 }, (_, row) => (
              <div key={row} className="flex h-[52px] items-center gap-3 border-t px-4">
                <Skeleton className="size-6 rounded-full" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="h-3 w-40" />
                </div>
                <Skeleton className="h-2 w-32" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </DetailCard>
  );
}
