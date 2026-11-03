import { DetailCard, detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { formatWholeNumber } from "@/app/workspace/_components/overview-formatters";
import { bookingPaceWord, type BookingPace } from "@/lib/operations-reports/booking-pace";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { PACE_TONE, type BookingTeam } from "./booking-teams";

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

/** What the pace is measured against, in one slate line. */
function paceBasis(team: BookingTeam) {
  const { pace, dailyQuota } = team;
  const perDay = dailyQuota === null ? null : `${formatWholeNumber(dailyQuota)} a day`;
  switch (pace.kind) {
    case "no_goal":
      return "No daily goal set";
    case "met":
      return perDay;
    case "missed":
      return `${perDay} · range ended`;
    default:
      return pace.expected
        ? `${formatWholeNumber(pace.expected)} due by yesterday · ${formatWholeNumber(pace.toGo ?? 0)} to go`
        : `${formatWholeNumber(pace.toGo ?? 0)} to go today`;
  }
}

function TeamTile({ team }: { team: BookingTeam }) {
  const { pace } = team;
  return (
    <li className="flex min-w-0 items-center gap-3 border-r border-b px-4 py-3">
      <GoalRing pace={pace} />
      <div className="min-w-0">
        <p className="truncate font-semibold">{team.label}</p>
        <p className="text-[13px] text-muted-foreground">
          <span className="font-condensed text-xl leading-none font-semibold text-foreground tabular-nums">
            {formatWholeNumber(pace.booked)}
          </span>{" "}
          {pace.goal === null ? "booked" : <>of {formatWholeNumber(pace.goal)}</>}
        </p>
        <p className={cn("font-condensed text-[13px] leading-tight font-bold tracking-[0.08em] uppercase", PACE_TONE[pace.kind].ink)}>
          {bookingPaceWord(pace)}
        </p>
        <p className="truncate text-[13px] text-muted-foreground">{paceBasis(team)}</p>
      </div>
    </li>
  );
}

export function TeamGoalsCard({
  teams,
  rangePhrase,
  onEditGoals,
}: {
  teams: BookingTeam[];
  rangePhrase: string;
  onEditGoals: () => void;
}) {
  // DM closers with no team have no goal to read, so they show only when
  // they booked.
  const shown = teams.filter((team) => !team.unassigned || team.pace.booked > 0);
  return (
    <DetailCard
      title="Team goals"
      meta={
        <>
          <span className="hidden @2xl:inline">Daily goal × days in the range</span>
          <button type="button" onClick={onEditGoals} className={detailLinkClass}>
            Edit goals
          </button>
        </>
      }
      className="min-w-0"
    >
      {shown.length === 0 ? (
        <SectionEmpty title={`No DM teams booked or had a goal ${rangePhrase}.`}>
          Set a daily goal per team with Edit goals.
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
