"use client";

import { plural } from "@/app/workspace/team/_components/team-ui";
import { BarList, ReportCard, RowsSkeleton } from "@/app/workspace/reports/_components/report-ui";
import { formatCount, type ReminderReportData } from "./reminders-report-config";

// How many manual reminders each deal took in the range, as ruled bar rows
// (one measure, ink at 75%).

export function ReminderChainLengthHistogram({
  data,
  reloading,
}: {
  data: ReminderReportData | undefined;
  reloading: boolean;
}) {
  return (
    <ReportCard
      title="Reminder chains"
      meta={
        data ? (
          <>
            Reminders per deal ·{" "}
            <span className="font-condensed text-[14px] font-semibold tabular-nums">
              {formatCount(data.opportunitiesWithReminderChains)}
            </span>{" "}
            {data.opportunitiesWithReminderChains === 1 ? "deal" : "deals"}
          </>
        ) : (
          "Reminders per deal"
        )
      }
      container="@container/chains"
      reloading={reloading}
    >
      {data === undefined ? (
        <RowsSkeleton rows={5} label="Loading reminder chains" />
      ) : (
        <BarList
          label="Deals by how many reminders they took"
          labelColumn="8rem"
          rows={data.chainLengthHistogram.map((entry) => ({
            key: entry.bucket,
            label: entry.bucket === "1" ? "1 reminder" : `${entry.bucket} reminders`,
            value: entry.count,
            display: plural(entry.count, "deal"),
          }))}
        />
      )}
    </ReportCard>
  );
}
