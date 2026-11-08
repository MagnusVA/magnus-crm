"use client";

import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { ATTENDANCE_COUNTS_PARTIAL_HELP, SHOW_RATE_HELP } from "@/app/workspace/_components/results-recorded";
import { cn } from "@/lib/utils";
import { FigureUnit, FigureZone, ReportFigures } from "../../_components/report-ui";

// The band's six figures. The first three follow the range and the band's
// filters (booked calls and their show rate); the last three are the
// pipeline right now, whatever the range.

type ShowRate = FunctionReturnType<typeof api.reporting.pipelineHealth.getSchedulingShowRateByOperationsDimensions>;
type Backlog = FunctionReturnType<typeof api.reporting.pipelineHealth.getPipelineBacklogAndLoss>;
type Aging = FunctionReturnType<typeof api.reporting.pipelineHealth.getPipelineAging>;

const wholeNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });

export function formatCount(value: number) {
  return wholeNumber.format(value);
}

/** A rate, or "—" when it has no base. */
export function formatRate(value: number | null) {
  return value === null || !Number.isFinite(value) ? "—" : percent.format(value);
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

const NOW_HELP = "Right now, whatever the range.";
const FILTER_HELP = "Follows the range and the program, team and DM closer filters.";

export function PipelineFigures({
  showRate,
  showRateReloading,
  rebuilding,
  aging,
  reminders,
}: {
  showRate: ShowRate | undefined;
  /** The range figures dim while the next range loads; the live ones don't. */
  showRateReloading: boolean;
  /** The day totals are being rebuilt, so the range figures wait. */
  rebuilding: boolean;
  aging: Aging | undefined;
  reminders: Backlog | undefined;
}) {
  const range = rebuilding ? null : showRate;
  const dim = cn("transition-opacity duration-200", showRateReloading && !rebuilding && "opacity-60");
  const waiting = "Waiting for the day totals";
  const partial = range?.attendanceCountsPartial;
  return (
    <ReportFigures columns="grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-6">
      <FigureZone
        label="Booked calls"
        help={`Calls booked in the range. ${FILTER_HELP}`}
        className={dim}
        figure={range === null ? "—" : range === undefined ? undefined : formatCount(range.scheduled)}
        proof={
          range === null
            ? waiting
            : range && (
                <>
                  {formatCount(range.shown)} shown · {formatCount(range.canceled)} canceled
                  {range.truncated ? " · capped, counts partial" : null}
                </>
              )
        }
      />
      <FigureZone
        label="Show rate"
        help={`${SHOW_RATE_HELP} ${FILTER_HELP}`}
        className={dim}
        figure={range === null ? "—" : range === undefined ? undefined : formatRate(range.showRate)}
        proof={
          range === null ? (
            waiting
          ) : range === undefined ? undefined : range.pastCalls === 0 && !partial ? (
            "No past calls yet"
          ) : (
            <span title={partial ? ATTENDANCE_COUNTS_PARTIAL_HELP : undefined}>
              {formatCount(range.resultsRecorded)} of {formatCount(range.pastCalls)} past calls have a result
              {partial ? " (partial)" : null}
            </span>
          )
        }
      />
      <FigureZone
        label="No-show rate"
        help={`No-shows ÷ (held + no-show). ${FILTER_HELP}`}
        className={dim}
        figure={range === null ? "—" : range === undefined ? undefined : formatRate(range.noShowRate)}
        proof={
          range === null
            ? waiting
            : range && (range.noShowRate === null ? "No held or missed calls yet" : plural(range.noShows, "no-show"))
        }
      />
      <FigureZone
        label="Stale deals"
        help={`Open deals with no call booked, or whose booked call is more than 14 days past. ${NOW_HELP}`}
        figure={aging === undefined ? undefined : formatCount(aging.staleCount)}
        proof={aging && (aging.staleCount === 0 ? "Every open deal has a call" : "Open, no call in 14 days")}
      />
      <FigureZone
        label="Open reminders"
        help={`Manual reminders nobody has resolved yet, by who set them. ${NOW_HELP}`}
        figure={
          reminders === undefined
            ? undefined
            : `${formatCount(reminders.unresolvedRemindersCount)}${reminders.isUnresolvedRemindersTruncated ? "+" : ""}`
        }
        proof={
          reminders &&
          (reminders.unresolvedRemindersCount === 0
            ? "None open now"
            : [
                `Closers ${formatCount(reminders.unresolvedReminderSplit.closer)}`,
                `admins ${formatCount(reminders.unresolvedReminderSplit.admin)}`,
                ...(reminders.unresolvedReminderSplit.system > 0
                  ? [`system ${formatCount(reminders.unresolvedReminderSplit.system)}`]
                  : []),
              ].join(" · "))
        }
      />
      <FigureZone
        label="Velocity"
        help={`Average days from a deal's creation to its payment, over won deals created in the last 90 days. ${NOW_HELP}`}
        figure={
          aging === undefined ? undefined : aging.velocityDays === null ? (
            "—"
          ) : (
            <>
              {aging.velocityDays.toFixed(1)}
              <FigureUnit>days</FigureUnit>
            </>
          )
        }
        proof={aging && (aging.velocityDays === null ? "No won deals in 90 days" : "Created to paid, 90 days")}
      />
    </ReportFigures>
  );
}
