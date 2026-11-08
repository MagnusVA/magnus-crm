"use client";

import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { dealPositionLabel } from "@/convex/opportunities/stageLabels";
import type { OpenPipelineStage } from "@/convex/reporting/pipelineHealth";
import { cn } from "@/lib/utils";
import { COLUMN_HEAD, FIGURE_15, ReportCard, RowsSkeleton } from "../../_components/report-ui";
import { formatCount } from "./pipeline-figures";

// The open stages a closer works. Qualified is computed and left out, as it
// was when the table showed statuses.
const SHOWN_STAGES = ["booked", "call_held", "follow_up"] as const satisfies ReadonlyArray<OpenPipelineStage>;

type AgingByStage = Record<
  OpenPipelineStage,
  { averageAgeDays: number | null; count: number; oldestAgeDays: number | null }
>;

function days(value: number) {
  return `${value} day${value === 1 ? "" : "s"}`;
}

export function PipelineAgingTable({ agingByStage }: { agingByStage: AgingByStage | undefined }) {
  const hasData = agingByStage !== undefined && SHOWN_STAGES.some((stage) => agingByStage[stage].count > 0);

  return (
    <ReportCard title="Aging by stage" meta="Now · open deals" container="@container/aging">
      {agingByStage === undefined ? (
        <RowsSkeleton rows={3} label="Loading aging by stage" />
      ) : !hasData ? (
        <SectionEmpty title="No open deals right now." />
      ) : (
        <table className="w-full border-collapse">
          <caption className="sr-only">Open deals by stage, with their average and oldest age in days</caption>
          <thead>
            <tr className="border-b">
              <th scope="col" className={cn(COLUMN_HEAD, "pl-4 text-left")}>
                Stage
              </th>
              <th scope="col" className={cn(COLUMN_HEAD, "text-right")}>
                Deals
              </th>
              <th scope="col" className={cn(COLUMN_HEAD, "text-right")}>
                Average age
              </th>
              <th scope="col" className={cn(COLUMN_HEAD, "pr-4 text-right")}>
                Oldest
              </th>
            </tr>
          </thead>
          <tbody>
            {SHOWN_STAGES.map((stage) => {
              const entry = agingByStage[stage];
              const quiet = entry.count === 0;
              return (
                <tr key={stage} className="h-11 border-b last:border-b-0">
                  <th scope="row" className="pr-3 pl-4 text-left font-medium">
                    {dealPositionLabel(stage)}
                  </th>
                  <td className={cn(FIGURE_15, "px-2.5 text-right", quiet && "text-muted-foreground")}>
                    {formatCount(entry.count)}
                  </td>
                  <td className={cn(FIGURE_15, "px-2.5 text-right whitespace-nowrap", quiet && "text-muted-foreground")}>
                    {entry.averageAgeDays === null ? "—" : `${entry.averageAgeDays.toFixed(1)} days`}
                  </td>
                  <td className={cn(FIGURE_15, "pr-4 pl-2.5 text-right whitespace-nowrap", quiet && "text-muted-foreground")}>
                    {entry.oldestAgeDays === null ? "—" : days(Math.round(entry.oldestAgeDays))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </ReportCard>
  );
}
