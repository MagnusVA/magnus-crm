"use client";

import { useEffect, useRef, type ReactNode } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import posthog from "@/lib/posthog-browser";
import { ExternalLinkIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { SectionError } from "@/app/workspace/closer/_components/section-state";
import { Skeleton } from "@/components/ui/skeleton";
import { usePageTitle } from "@/hooks/use-page-title";
import { cn } from "@/lib/utils";
import { formatHours, SHORT_DAY, weekTotal } from "../schedule-editor";
import { listDays, listWords } from "../schedules/schedule-model";
import { CARD, CardHead, HelpTip, plural } from "../team-ui";
import { GoalBars } from "./goal-bars";
import { GoalInput } from "./goal-input";
import {
  bookedGroups,
  bookedRatesByTeam,
  estimate,
  formatEstimate,
  formatRate,
  qualifiedGroup,
  qualifiedRate,
  type Estimate,
  type GoalGroup,
} from "./goal-model";
import { useGoalsData } from "./use-goals-data";

const ESTIMATE_TIP =
  "The group’s hours on each counted weekday, from the weeks in force today, times what each scheduled hour produced over the last 30 finished days. It assumes the coming weeks look like the last 30 days, and leaves out people with no schedule.";

/**
 * Team › Goals: the qualified-leads goal for the workspace (#qualified) and
 * each active team's booked-calls goal (#booked), each beside what the
 * schedules produce at the last 30 days' pace. Goals save as they change,
 * with Undo.
 */
export function GoalsPageClient() {
  usePageTitle("Goals");
  return (
    <>
      <SectionErrorBoundary sectionName="team_goals_qualified" fallback={<FailedCard id="qualified" title="Qualified leads a day" />}>
        <QualifiedCard />
      </SectionErrorBoundary>
      <SectionErrorBoundary sectionName="team_goals_booked" fallback={<FailedCard id="booked" title="Booked calls a day" />}>
        <BookedCard />
      </SectionErrorBoundary>
    </>
  );
}

/** Scroll to #qualified or #booked once the section has rendered its rows. */
function useScrollToHash(id: string, ready: boolean) {
  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;
    if (window.location.hash === `#${id}`) {
      document.getElementById(id)?.scrollIntoView({ block: "start" });
    }
  }, [id, ready]);
}

function EstimateChip() {
  return (
    <span className="rounded-[4px] border border-border px-1.5 py-0.5 font-condensed text-[11px] font-bold tracking-[0.12em] text-muted-foreground uppercase">
      <HelpTip tip={ESTIMATE_TIP} className="no-underline">
        Estimate
      </HelpTip>
    </span>
  );
}

// One goal row: who and what, the goal, the bars, the verdict. Folds to two
// rows (who + goal, then bars + verdict) in narrow cards.
const ROW =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 gap-y-3 border-b border-border px-4 py-3.5 last:border-b-0 @4xl/goals:grid-cols-[minmax(190px,1fr)_auto_minmax(240px,1.5fr)_minmax(200px,1fr)]";

function QualifiedCard() {
  const { directory, qualifications } = useGoalsData();
  const setGoal = useMutation(api.reporting.slackQualifications.setTeamDailyGoal);
  const ready = directory !== undefined && qualifications !== undefined;
  useScrollToHash("qualified", ready);

  if (!directory || !qualifications) {
    return <LoadingCard id="qualified" title="Qualified leads a day" rows={1} />;
  }
  const group = qualifiedGroup(directory);
  const goal = qualifications.goal.dailyQuota;
  const rate = qualifications.capped ? "capped" : qualifiedRate(qualifications.openers);
  const result = estimate(group, rate);
  const leftOut = qualifications.capped
    ? []
    : qualifications.openers.filter((opener) => opener.qualified > 0 && !opener.scheduledHours);

  return (
    <section id="qualified" aria-labelledby="qualified-title" className={cn(CARD, "@container/goals scroll-mt-4")}>
      <CardHead
        title={<span id="qualified-title">Qualified leads a day</span>}
        meta="Slack qualifiers, one goal for the whole workspace"
      >
        <EstimateChip />
      </CardHead>
      <div className={ROW}>
        <div className="min-w-0">
          <p className="text-[14px] font-semibold">Qualified leads</p>
          <p className="text-[12.5px] text-muted-foreground">
            Whole workspace · {plural(group.people, "Slack qualifier")} ·{" "}
            <Link
              href="/workspace/operations/qualifications"
              className="inline-flex items-center gap-0.5 rounded-sm underline decoration-current/40 underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              Qualifications
              <ExternalLinkIcon className="size-3" aria-hidden="true" />
            </Link>
          </p>
          <CountedDays group={group} who="some Slack qualifier works" none="no Slack qualifier has hours yet" />
        </div>
        <GoalInput
          value={goal}
          label="Qualified leads goal a day, for the whole workspace"
          what={(next) => (next === null ? "The workspace has no qualified-leads goal" : `Qualified leads goal: ${next} a day`)}
          flow="team_goals_qualified_set"
          save={async (next) => {
            await setGoal({ dailyTeamQualificationGoal: next });
            posthog.capture("qualified_goal_set", { hasGoal: next !== null, from: "team_goals" });
          }}
        />
        <Plot result={result} goal={goal} />
        <Verdict
          result={result}
          goal={goal}
          unit="qualified"
          noHoursNow={
            <>
              No Slack qualifier has hours, so there’s nothing to estimate.{" "}
              <ScheduleLink href="/workspace/team/schedules?role=slack">Set their weeks</ScheduleLink>
            </>
          }
          noResults="Scheduled qualifiers qualified no leads in the last 30 days, so there’s no rate yet."
          capped="The last 30 days hold more qualifications than this page reads, so it can’t estimate here."
        />
      </div>
      {leftOut.length ? (
        <p className="border-t border-border px-4 py-2.5 text-[13px] text-muted-foreground">
          {leftOutLine(leftOut.map((opener) => opener.label))} qualified leads in the last 30 days with no schedule, so
          the estimate leaves those leads out.
        </p>
      ) : null}
    </section>
  );
}

function leftOutLine(names: string[]) {
  if (names.length <= 3) return listWords(names);
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;
}

function BookedCard() {
  const { directory, booked } = useGoalsData();
  const setQuota = useMutation(api.attribution.teams.setTeamBookingQuota);
  const ready = directory !== undefined && booked !== undefined;
  useScrollToHash("booked", ready);

  if (!directory || !booked) return <LoadingCard id="booked" title="Booked calls a day" rows={3} />;
  const teams = bookedGroups(directory);
  const rates = booked.capped ? null : bookedRatesByTeam(directory, booked.dmClosers);

  return (
    <section id="booked" aria-labelledby="booked-title" className={cn(CARD, "@container/goals scroll-mt-4")}>
      <CardHead title={<span id="booked-title">Booked calls a day</span>} meta="Per team, read on Booked Calls’ goal rings">
        <EstimateChip />
      </CardHead>
      {teams.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13.5px] text-muted-foreground">
          No active teams.{" "}
          <Link href="/workspace/team/teams" className="underline underline-offset-2 hover:text-foreground">
            Create one in Teams
          </Link>
          ; each team gets its own booked-calls goal.
        </p>
      ) : (
        teams.map(({ team, group }) => {
          const goal = team.bookingDailyQuota;
          const rate = rates === null ? "capped" : (rates.get(team.teamId) ?? { results: 0, hours: 0 });
          const result = estimate(group, rate);
          const perHour = rate !== "capped" && rate.hours > 0 ? rate.results / rate.hours : null;
          return (
            <div key={team.teamId} className={ROW}>
              <div className="min-w-0">
                <Link
                  href={`/workspace/team/teams/${team.teamId}`}
                  className="rounded-sm text-[14px] font-semibold underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {team.name}
                </Link>
                <p className="text-[12.5px] text-muted-foreground">
                  {plural(group.people, "DM closer")} · {formatHours(weekTotal(group.byDay))} h a week
                  {perHour !== null ? ` · ${formatRate(perHour)} booked/h` : null}
                </p>
                <CountedDays group={group} who="one of its DM closers works" none="none of its DM closers has hours yet" />
              </div>
              <GoalInput
                value={goal}
                label={`Booked calls goal a day for ${team.name}`}
                what={(next) => (next === null ? `${team.name} has no booked goal` : `${team.name}: ${next} booked a day`)}
                flow="team_goals_booked_set"
                save={async (next) => {
                  await setQuota({ teamId: team.teamId, bookingDailyQuota: next });
                  posthog.capture("booking_team_goal_set", { hasGoal: next !== null, from: "team_goals" });
                }}
              />
              <Plot result={result} goal={goal} />
              <Verdict
                result={result}
                goal={goal}
                unit="booked"
                noHoursNow={
                  <>
                    {group.people === 0 ? "The team has no active DM closers" : "None of its DM closers has hours"}, so
                    there’s nothing to estimate.{" "}
                    <ScheduleLink href={`/workspace/team/teams/${team.teamId}`}>Team page</ScheduleLink>
                  </>
                }
                noResults="Its scheduled DM closers booked no calls in the last 30 days, so there’s no rate yet."
                capped="The last 30 days hold more bookings than this page reads, so it can’t estimate here."
              />
            </div>
          );
        })
      )}
      <p className="border-t border-border px-4 py-2.5 text-[13px] text-muted-foreground">
        Lead gen has no goal: Lead Gen reads captures per scheduled hour instead.
      </p>
    </section>
  );
}

function ScheduleLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="underline decoration-current/40 underline-offset-2 hover:text-foreground">
      {children}
    </Link>
  );
}

/** "Counts 6 days a week: the days some Slack qualifier works. Skips Sun." */
function CountedDays({ group, who, none }: { group: GoalGroup; who: string; none: string }) {
  const tip = group.noHours
    ? `Until someone in the group has hours, the goal counts every day, as goals did before schedules decided it.`
    : `A day counts toward the goal’s target when someone in the group is scheduled to work it, in the weeks in force today. Days nobody works don’t count, so they never read as short.`;
  return (
    <p className="mt-1 text-[12.5px] text-muted-foreground">
      <HelpTip tip={tip}>
        {group.noHours ? "Counts every day" : `Counts ${plural(group.counted.length, "day")} a week`}
      </HelpTip>
      {group.noHours ? `: ${none}.` : `: the days ${who}.`}
      {group.skipped.length ? ` Skips ${listDays(group.skipped, SHORT_DAY)}.` : null}
    </p>
  );
}

function Plot({ result, goal }: { result: Estimate; goal: number | null }) {
  // With no estimate the verdict takes the chart's place and says why.
  if (!result.ok) return null;
  return <GoalBars byDay={result.byDay} goal={goal} className="col-span-2 @4xl/goals:col-span-1" />;
}

function Verdict({
  result,
  goal,
  unit,
  noHoursNow,
  noResults,
  capped,
}: {
  result: Estimate;
  goal: number | null;
  unit: string;
  noHoursNow: ReactNode;
  noResults: string;
  capped: string;
}) {
  const word = "font-condensed text-[14px] leading-tight font-bold tracking-[0.08em] uppercase";
  if (!result.ok) {
    const reason =
      result.reason === "loading"
        ? "Working out the estimate…"
        : result.reason === "capped"
          ? capped
          : result.reason === "no_hours_now"
            ? noHoursNow
            : result.reason === "no_hours_before"
              ? "Nobody in the group had hours in the last 30 days, so there’s no rate yet."
              : noResults;
    return (
      <div className="col-span-2 flex flex-col gap-0.5 text-[13px] text-muted-foreground">
        <span className={cn(word, "text-muted-foreground")}>No estimate</span>
        <span>{reason}</span>
      </div>
    );
  }
  const pace = `${formatEstimate(result.perDay)} a day at the last 30 days’ pace`;
  const rateLine = `${formatRate(result.perHour)} ${unit} an hour, ${formatHours(result.hoursPerDay)} h on an average counted day`;
  if (goal === null) {
    return (
      <div className="col-span-2 flex flex-col gap-0.5 text-[13px] text-muted-foreground @4xl/goals:col-span-1">
        <span className={cn(word, "text-muted-foreground")}>No goal</span>
        <span>{pace}</span>
        <span>{rateLine}</span>
      </div>
    );
  }
  const gap = goal - result.perDay;
  const short = gap > goal * 0.05 && gap >= 0.5;
  const moreHours = short ? Math.ceil((gap / result.perHour) * 4) / 4 : 0;
  return (
    <div className="col-span-2 flex flex-col gap-0.5 text-[13px] text-muted-foreground @4xl/goals:col-span-1">
      <span className={cn(word, short ? "text-warning-ink" : "text-stage-follow-up-ink")}>
        {short ? "Short of the goal" : "Schedule covers it"}
      </span>
      <span>
        {pace}
        {short ? ` · short ${formatEstimate(gap)}` : null}
      </span>
      <span>
        {short ? `≈ ${formatHours(moreHours)} more hours a counted day at this rate` : rateLine}
      </span>
    </div>
  );
}

function LoadingCard({ id, title, rows }: { id: string; title: string; rows: number }) {
  return (
    <section id={id} className={cn(CARD, "scroll-mt-4")} role="status" aria-label={`Loading ${title.toLowerCase()}`}>
      <CardHead title={title} />
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-[124px] items-center gap-5 border-b border-border px-4 last:border-b-0">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-9 w-[76px]" />
          <Skeleton className="h-16 flex-1" />
          <Skeleton className="h-10 w-48" />
        </div>
      ))}
    </section>
  );
}

function FailedCard({ id, title }: { id: string; title: string }) {
  return (
    <section id={id} className={CARD}>
      <CardHead title={title} />
      <SectionError what={title.toLowerCase()} />
    </section>
  );
}

