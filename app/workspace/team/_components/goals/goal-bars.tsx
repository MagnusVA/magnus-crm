import { cn } from "@/lib/utils";
import { SHORT_DAY, WEEKDAYS, type Weekday } from "../schedule-editor";
import { formatEstimate } from "./goal-model";

const PLOT = 64; // px: the tallest bar or the goal line, whichever is higher.

/**
 * Goal against estimate, one small bar per weekday: the estimate on each day
 * the goal counts, a dashed line at the goal, and the part of the goal a day's
 * estimate falls short of in amber outline. Days the goal skips show "Off".
 */
export function GoalBars({
  byDay,
  goal,
  className,
}: {
  /** The estimate per weekday; null on a day the goal skips. */
  byDay: Record<Weekday, number | null>;
  goal: number | null;
  className?: string;
}) {
  const top = Math.max(goal ?? 0, ...WEEKDAYS.map((day) => byDay[day] ?? 0), 1) * 1.08;
  const px = (value: number) => Math.round((value / top) * PLOT);
  const summary = WEEKDAYS.map((day) => {
    const value = byDay[day];
    return `${SHORT_DAY[day]} ${value === null ? "off" : formatEstimate(value).replace("≈ ", "about ")}`;
  }).join(", ");
  return (
    <div
      role="img"
      aria-label={`Estimate a day: ${summary}${goal !== null ? `. Goal ${goal} a day.` : ". No goal."}`}
      className={cn("relative grid grid-cols-7 gap-1.5 pt-4", className)}
    >
      {goal !== null ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-dashed border-foreground/70"
          style={{ bottom: px(goal) + 13 }}
        >
          <span className="absolute -top-[15px] right-0 bg-card px-1 font-condensed text-[10.5px] leading-none font-bold tracking-[0.08em] text-foreground uppercase">
            Goal {goal}
          </span>
        </span>
      ) : null}
      {WEEKDAYS.map((day) => {
        const value = byDay[day];
        const off = value === null;
        const short = !off && goal !== null && value < goal * 0.95;
        return (
          <div key={day} aria-hidden="true" className="flex min-w-0 flex-col items-center justify-end" style={{ height: PLOT + 32 }}>
            <span
              className={cn(
                "mb-[3px] font-condensed text-[12px] leading-none font-semibold tabular-nums",
                off && "font-medium text-muted-foreground",
              )}
            >
              {off ? "Off" : formatEstimate(value).replace(" ", "")}
            </span>
            {short ? (
              <span
                className="w-full max-w-[28px] rounded-t-[3px] border-[1.5px] border-b-0 border-dashed border-warning bg-warning-surface/70"
                style={{ height: px(goal) - px(value) }}
              />
            ) : null}
            {off ? (
              <span className="h-[3px] w-full max-w-[28px] border-t border-dashed border-border" />
            ) : (
              <span
                className={cn("w-full max-w-[28px] bg-foreground/70", short ? "" : "rounded-t-[3px]")}
                style={{ height: Math.max(2, px(value)) }}
              />
            )}
            <span
              className={cn(
                "mt-[3px] font-condensed text-[10px] leading-none font-semibold tracking-[0.08em] text-muted-foreground uppercase",
              )}
            >
              {SHORT_DAY[day].slice(0, 2)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
