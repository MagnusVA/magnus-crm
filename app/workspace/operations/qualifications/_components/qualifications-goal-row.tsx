"use client";

import { PencilIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatWholeNumber } from "@/app/workspace/_components/overview-formatters";
import type {
  QualificationDashboardViewModel,
  QualificationOpenerViewModel,
} from "@/lib/operations-reports/qualification-dashboard";

type Goal = QualificationDashboardViewModel["goal"];

/** The band's board-tone outline button: Schedules, Export, Set goal. */
export const BAND_BUTTON_CLASS =
  "h-[34px] rounded-[7px] border-board-foreground/15 bg-board-raised px-3 text-[13px] text-board-foreground hover:bg-board-foreground/10 hover:text-board-foreground dark:border-board-foreground/15 dark:bg-board-raised dark:hover:bg-board-foreground/10";

const linkClass =
  "inline-flex min-h-6 items-center rounded-sm text-[13px] font-semibold text-board-foreground underline decoration-board-foreground/40 underline-offset-[3px] outline-none hover:decoration-board-foreground focus-visible:ring-2 focus-visible:ring-ring";

function quotaWords(goal: Goal) {
  if (goal.dailyQuota === null) return null;
  const days = goal.businessDayCount;
  return `${formatWholeNumber(goal.dailyQuota)} a day × ${formatWholeNumber(days)} business day${days === 1 ? "" : "s"}`;
}

/**
 * The goal under the band's title: the qualified count against the team
 * goal, and one bar built from each setter's share, so "are we on goal" and
 * "who got us there" read in the same line. A selected setter keeps its
 * segment full while the rest drop back.
 */
export function QualificationsGoalRow({
  goal,
  reloading,
  failed,
  setters,
  selectedSetter,
  onEditGoal,
}: {
  goal: Goal | undefined;
  /** The figures belong to the last range while the new one loads. */
  reloading: boolean;
  /** The report failed with nothing kept; the notice below the band says why. */
  failed: boolean;
  setters: QualificationOpenerViewModel[] | undefined;
  selectedSetter: string | null;
  onEditGoal: () => void;
}) {
  return (
    <div
      aria-busy={reloading}
      className={cn(
        "-mx-4 flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-board-line px-4 pt-3 pb-3.5 transition-opacity duration-200 motion-reduce:transition-none @lg:-mx-[18px] @lg:px-[18px] @lg:pb-4",
        reloading && "opacity-60",
      )}
    >
      {goal !== undefined ? (
        <GoalFigures goal={goal} setters={setters ?? []} selectedSetter={selectedSetter} onEditGoal={onEditGoal} />
      ) : failed ? (
        <div>
          <p className="font-condensed text-[11px] font-semibold tracking-[0.14em] text-board-muted uppercase">Team goal</p>
          <p className="py-1.5 text-[13px] text-board-muted">Progress can&apos;t show until the report loads.</p>
        </div>
      ) : (
        <GoalRowSkeleton />
      )}
    </div>
  );
}

function GoalFigures({
  goal,
  setters,
  selectedSetter,
  onEditGoal,
}: {
  goal: Goal;
  setters: QualificationOpenerViewModel[];
  selectedSetter: string | null;
  onEditGoal: () => void;
}) {
  const target = goal.target !== null && goal.target > 0 ? goal.target : null;
  const progress = goal.progress;
  const quota = quotaWords(goal);

  if (target === null) {
    return (
      <>
        <div>
          <p className="font-condensed text-[11px] font-semibold tracking-[0.14em] text-board-muted uppercase">Team goal</p>
          <p className="font-condensed text-[30px] leading-[1.05] font-semibold tabular-nums">
            {formatWholeNumber(progress)}{" "}
            <span className="text-[17px] text-board-muted">qualified · no goal set</span>
          </p>
        </div>
        <Button type="button" variant="outline" className={cn(BAND_BUTTON_CLASS, "ml-auto")} onClick={onEditGoal}>
          <PencilIcon data-icon="inline-start" aria-hidden="true" />
          Set goal
        </Button>
      </>
    );
  }

  const percent = Math.round((progress / target) * 100);
  // Past the goal, the bar scales to the count and marks where the goal was.
  const scale = Math.max(target, progress, 1);
  const segments = setters.filter((setter) => setter.qualified > 0);
  const rest = Math.max(0, progress - segments.reduce((sum, setter) => sum + setter.qualified, 0));

  return (
    <>
      <div className="flex items-end gap-5">
        <div>
          <p className="font-condensed text-[11px] font-semibold tracking-[0.14em] text-board-muted uppercase">Team goal</p>
          <p className="font-condensed text-[30px] leading-[1.05] font-semibold whitespace-nowrap tabular-nums">
            {formatWholeNumber(progress)}{" "}
            <span className="text-[17px] text-board-muted">of {formatWholeNumber(target)}</span>
          </p>
        </div>
        <p className="font-condensed text-[26px] leading-[1.05] font-semibold tabular-nums">
          {formatWholeNumber(percent)}%
        </p>
      </div>
      <div className="relative order-last flex h-3.5 min-w-full flex-1 gap-0.5 overflow-hidden rounded-[3px] bg-board-raised @3xl:order-none @3xl:min-w-48" aria-hidden="true">
        {segments.map((setter, index) => (
          <span
            key={setter.key}
            title={`${setter.label} · ${formatWholeNumber(setter.qualified)}`}
            className={cn(
              "h-full shrink-0 transition-opacity duration-200 motion-reduce:transition-none",
              index % 2 === 0 ? "bg-board-foreground/80" : "bg-board-foreground/55",
              selectedSetter !== null && selectedSetter !== setter.key && "opacity-35",
            )}
            style={{ width: `${(setter.qualified / scale) * 100}%` }}
          />
        ))}
        {rest > 0 ? <span className="h-full shrink-0 bg-board-foreground/40" style={{ width: `${(rest / scale) * 100}%` }} /> : null}
        {progress > target ? (
          <span className="absolute inset-y-0 w-0.5 bg-board" style={{ left: `${(target / scale) * 100}%` }} />
        ) : null}
      </div>
      <p className="sr-only">
        {formatWholeNumber(progress)} of {formatWholeNumber(target)} qualified, {formatWholeNumber(percent)}% of the team goal.
      </p>
      <div className="ml-auto flex items-center gap-3 text-[13px] whitespace-nowrap text-board-muted @3xl:ml-0">
        {percent >= 100 ? <span className="font-medium text-board-foreground">Goal reached</span> : null}
        {quota ? <span>{quota}</span> : null}
        <button type="button" className={linkClass} onClick={onEditGoal}>
          Edit goal
        </button>
      </div>
    </>
  );
}

function GoalRowSkeleton() {
  return (
    <div role="status" aria-label="Loading the team goal" className="flex w-full items-center gap-5">
      <div className="flex flex-col gap-1.5">
        <span className="h-2.5 w-16 animate-pulse rounded bg-board-foreground/10" />
        <span className="h-8 w-24 animate-pulse rounded bg-board-foreground/10" />
      </div>
      <span className="h-3.5 flex-1 animate-pulse rounded-[3px] bg-board-foreground/10" />
      <span className="hidden h-3.5 w-48 animate-pulse rounded bg-board-foreground/10 @3xl:block" />
    </div>
  );
}
