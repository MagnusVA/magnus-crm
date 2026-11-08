"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";
import { LABEL, ReportCard, ReportNote } from "@/app/workspace/reports/_components/report-ui";
import { cn } from "@/lib/utils";
import { formatCount, formatPercent, OUTCOME_META, type ReminderReportData } from "./reminders-report-config";

// Where completed reminders ended, in the Conversion Strip's grammar: one
// white cell per outcome in a grid ruled by 1px gaps, each with its count, its
// share of the completed reminders and a slate share bar. These are outcomes,
// not deal stages, so they never take the stage scale.

const GRID = "grid grid-cols-2 gap-px bg-border @lg/outcomes:grid-cols-3 @4xl/outcomes:grid-cols-5";
// The last of five cells fills its row when the row isn't full.
const LAST_CELL = "col-span-2 @4xl/outcomes:col-span-1";

export function ReminderOutcomeStrip({
  data,
  rangePhrase,
  reloading,
}: {
  data: ReminderReportData | undefined;
  rangePhrase: string;
  reloading: boolean;
}) {
  return (
    <ReportCard
      title="Outcomes"
      meta={
        data && data.totalCompleted > 0 ? (
          <>
            Of{" "}
            <span className="font-condensed text-[14px] font-semibold tabular-nums">{formatCount(data.totalCompleted)}</span>{" "}
            completed reminders
          </>
        ) : undefined
      }
      container="@container/outcomes"
      reloading={reloading}
    >
      {data === undefined ? (
        <StripSkeleton />
      ) : data.totalCreated === 0 ? (
        <SectionEmpty title={`No manual reminders ${rangePhrase}.`}>
          Outcomes, chains and closers show here once closers set reminders.
        </SectionEmpty>
      ) : (
        <>
          {data.isTruncated ? (
            <ReportNote lead="Capped.">
              This range has more than 2,000 reminders, so the counts stop there. Narrow the range for the full funnel.
            </ReportNote>
          ) : null}
          {data.completedWithoutOutcomeCount > 0 ? (
            <ReportNote lead="Untagged.">
              {formatCount(data.completedWithoutOutcomeCount)} completed{" "}
              {data.completedWithoutOutcomeCount === 1 ? "reminder has" : "reminders have"} no outcome yet.
            </ReportNote>
          ) : null}
          <ul aria-label="Outcomes of completed reminders" className={GRID}>
            {data.outcomeBreakdown.map((entry, index) => {
              const meta = OUTCOME_META[entry.outcome];
              const share = entry.percentOfCompleted ?? 0;
              return (
                <li
                  key={entry.outcome}
                  className={cn(
                    "flex min-w-0 flex-col gap-1 bg-card px-4 py-3",
                    index === data.outcomeBreakdown.length - 1 && LAST_CELL,
                  )}
                >
                  <p className={LABEL}>
                    <HelpTip tip={meta.description}>{meta.label}</HelpTip>
                  </p>
                  <p
                    className={cn(
                      "font-condensed text-[30px] leading-[1.05] font-semibold tabular-nums",
                      entry.count === 0 && "text-muted-foreground",
                    )}
                  >
                    {formatCount(entry.count)}
                  </p>
                  <p className="text-[13px] text-muted-foreground">
                    {entry.percentOfCompleted === null
                      ? "None completed yet"
                      : `${formatPercent(entry.percentOfCompleted)} of completed`}
                  </p>
                  <div aria-hidden="true" className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-muted-foreground"
                      style={{ width: entry.count > 0 ? `max(3px, ${share * 100}%)` : 0 }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </ReportCard>
  );
}

function StripSkeleton() {
  return (
    <div role="status" aria-label="Loading outcomes" className={GRID}>
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className={cn("flex flex-col gap-1.5 bg-card px-4 py-3", index === 4 && LAST_CELL)}>
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-8 w-14" />
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="mt-1 h-1.5 w-full rounded-full" />
        </div>
      ))}
    </div>
  );
}
