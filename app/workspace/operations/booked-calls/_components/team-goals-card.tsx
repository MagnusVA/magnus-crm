import { ArrowUpRightIcon } from "lucide-react";
import { DetailCard, detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { formatWholeNumber } from "@/app/workspace/_components/overview-formatters";
import { bookingPaceWord, type BookingPace } from "@/lib/operations-reports/booking-pace";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { TeamPageLink, TipLink, teamHref } from "../../_components/team-links";
import { PACE_TONE, type BookingTeam } from "./booking-teams";

const GOALS_TIP =
  "Each team's booked calls per day, set in Team › Goals. The target counts only the days someone on the team works.";

// The page's first read: one goal ring per DM team, filled in the team's
// pace colour, with the count, the pace word and what the pace is measured
// against. The ring is the same number as the words beside it.

const RING_SIZE = 64;
const RING_STROKE = 7;
const RADIUS = (RING_SIZE - RING_STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function GoalRing({ pace }: { pace: BookingPace }) {
  const share = pace.share ?? 0;
  const tone = PACE_TONE[pace.kind];
  return (
    <div className="relative grid size-16 shrink-0 place-items-center" aria-hidden="true">
      <svg viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} className="absolute inset-0 -rotate-90">
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={RING_STROKE}
          className="stroke-muted"
        />
        {share > 0 ? (
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={RING_STROKE}
            strokeLinecap={share < 1 ? "round" : "butt"}
            strokeDasharray={`${share * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            className={cn(tone.stroke, "transition-[stroke-dasharray] duration-500 ease-out motion-reduce:transition-none")}
          />
        ) : null}
      </svg>
      <span className="font-condensed text-[17px] leading-none font-semibold tabular-nums">
        {pace.goal === null ? formatWholeNumber(pace.booked) : `${Math.floor(share * 100)}%`}
      </span>
    </div>
  );
}

/** "70 a day × 5 days someone works", or "70 a day" when the answer doesn't count work days. */
function goalWords(team: BookingTeam) {
  if (team.dailyQuota === null) return null;
  const perDay = `${formatWholeNumber(team.dailyQuota)} a day`;
  const days = team.goalDayCount;
  return days === undefined ? perDay : `${perDay} × ${formatWholeNumber(days)} day${days === 1 ? "" : "s"} someone works`;
}

/** Where the team stands against the pace, in one slate line; the goal itself is on the line below. */
function paceBasis(team: BookingTeam) {
  const { pace } = team;
  switch (pace.kind) {
    case "no_goal":
    case "met":
      return null;
    case "missed":
      return "Range ended";
    default:
      return pace.expected
        ? `${formatWholeNumber(pace.expected)} due by yesterday · ${formatWholeNumber(pace.toGo ?? 0)} to go`
        : `${formatWholeNumber(pace.toGo ?? 0)} to go today`;
  }
}

function TeamTile({ team }: { team: BookingTeam }) {
  const { pace } = team;
  const basis = paceBasis(team);
  return (
    <li className="flex min-w-0 items-center gap-3 border-r border-b px-4 py-3">
      {team.teamId ? (
        <TipLink
          href={teamHref.team(team.teamId)}
          tip={`Opens ${team.label} in Team › Teams.`}
          aria-label={`${team.label} team page`}
          className="rounded-full"
        >
          <GoalRing pace={pace} />
        </TipLink>
      ) : (
        <GoalRing pace={pace} />
      )}
      <div className="min-w-0">
        <p className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-semibold">{team.label}</span>
          {team.teamId ? <TeamPageLink teamId={team.teamId} teamName={team.label} className="shrink-0" /> : null}
        </p>
        <p className="text-[13px] text-muted-foreground">
          <span className="font-condensed text-xl leading-none font-semibold text-foreground tabular-nums">
            {formatWholeNumber(pace.booked)}
          </span>{" "}
          {pace.goal === null ? "booked" : <>of {formatWholeNumber(pace.goal)}</>}
        </p>
        <p className={cn("font-condensed text-[13px] leading-tight font-bold tracking-[0.08em] uppercase", PACE_TONE[pace.kind].ink)}>
          {bookingPaceWord(pace)}
        </p>
        {basis ? <p className="truncate text-[13px] text-muted-foreground">{basis}</p> : null}
        {team.unassigned ? null : (
          <p className="truncate text-[13px] text-muted-foreground">
            <TipLink
              href={teamHref.goals("booked")}
              tip={GOALS_TIP}
              className="underline decoration-current/40 decoration-dotted underline-offset-[3px] hover:text-foreground hover:decoration-current"
            >
              {goalWords(team) ?? "Set a goal"}
            </TipLink>
          </p>
        )}
        {team.teamOnly && team.teamOnly.booked > 0 ? (
          <p className="truncate text-[13px] text-muted-foreground">
            <span className="font-condensed text-[14px] font-semibold text-foreground tabular-nums">
              {formatWholeNumber(team.teamOnly.booked)}
            </span>{" "}
            with no DM closer
          </p>
        ) : null}
      </div>
    </li>
  );
}

export function TeamGoalsCard({
  teams,
  rangePhrase,
}: {
  teams: BookingTeam[];
  rangePhrase: string;
}) {
  // DM closers with no team have no goal to read, so they show only when
  // they booked.
  const shown = teams.filter((team) => !team.unassigned || team.pace.booked > 0);
  return (
    <DetailCard
      title="Team goals"
      meta={
        <>
          <span className="hidden @2xl:inline">Daily goal × days someone on the team works</span>
          <TipLink href={teamHref.goals("booked")} tip={GOALS_TIP} className={detailLinkClass}>
            Goals
            <ArrowUpRightIcon aria-hidden="true" className="ml-0.5 size-3.5" />
          </TipLink>
        </>
      }
      className="min-w-0"
    >
      {shown.length === 0 ? (
        <SectionEmpty title={`No DM teams booked or had a goal ${rangePhrase}.`}>
          Set a daily goal per team in Team › Goals.
        </SectionEmpty>
      ) : (
        <div className="overflow-hidden">
          <ul
            aria-label="Team goals"
            className="-mr-px -mb-px grid grid-cols-1 @xl:grid-cols-2 @4xl:grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]"
          >
            {shown.map((team) => (
              <TeamTile key={team.key} team={team} />
            ))}
          </ul>
        </div>
      )}
    </DetailCard>
  );
}

export function TeamGoalsSkeletonRows() {
  return (
    <div role="status" aria-label="Loading team goals" className="overflow-hidden">
      <div className="-mr-px -mb-px grid grid-cols-1 @xl:grid-cols-2 @4xl:grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex items-center gap-3 border-r border-b px-4 py-3">
            <Skeleton className="size-16 shrink-0 rounded-full" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-3 w-28" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
