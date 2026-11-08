"use client";

import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { dealPositionLabel } from "@/convex/opportunities/stageLabels";
import type { DealPosition } from "@/convex/opportunities/stages";
import { BarList, ReportCard, RowsSkeleton, STAGE_FILL } from "../../_components/report-ui";
import { formatCount } from "./pipeline-figures";

// Every deal by its stage right now, in stage order, each bar in its stage's
// fill (The One Scale Rule). Qualified borrows Held's slate.
const POSITION_FILL: Record<DealPosition, string> = {
  qualified: STAGE_FILL.held,
  booked: STAGE_FILL.booked,
  call_held: STAGE_FILL.held,
  follow_up: STAGE_FILL.followUp,
  won: STAGE_FILL.won,
  lost: STAGE_FILL.lost,
};

const share = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 0 });

export function StageDistributionCard({
  distribution,
}: {
  distribution: Array<{ position: DealPosition; count: number }> | undefined;
}) {
  const total = distribution?.reduce((sum, entry) => sum + entry.count, 0) ?? 0;
  return (
    <ReportCard
      title="Deals by stage"
      meta={distribution === undefined ? "Now" : `Now · ${formatCount(total)} deal${total === 1 ? "" : "s"}`}
      container="@container/stages"
    >
      {distribution === undefined ? (
        <RowsSkeleton rows={6} label="Loading deals by stage" />
      ) : total === 0 ? (
        <SectionEmpty title="No deals yet.">Deals appear here once people book a call.</SectionEmpty>
      ) : (
        <BarList
          label="Deals by stage"
          labelColumn="9rem"
          rows={distribution.map((entry) => ({
            key: entry.position,
            label: dealPositionLabel(entry.position),
            meta: `${share.format(entry.count / total)} of deals`,
            value: entry.count,
            display: formatCount(entry.count),
            fill: POSITION_FILL[entry.position],
          }))}
        />
      )}
    </ReportCard>
  );
}
