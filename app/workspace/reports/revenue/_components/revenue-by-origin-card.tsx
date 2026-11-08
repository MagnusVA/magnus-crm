"use client";

import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";
import { BarList, ReportCard, RowsSkeleton } from "../../_components/report-ui";
import { AmountShare, wholeShare } from "./amount-share";
import { dollars } from "./revenue-format";

type RevenueByOrigin = FunctionReturnType<typeof api.reporting.revenue.getRevenueMetrics>["revenue"]["byOrigin"];
type RevenueOrigin = keyof RevenueByOrigin;

// The first word says who recorded the payment. Every origin counts as
// revenue and is credited to the assigned closer, whoever recorded it.
const ORIGIN_LABELS = {
  closer_meeting: "Closer · Meeting",
  closer_reminder: "Closer · Reminder",
  closer_side_deal: "Closer · Side deal",
  closer_additional: "Closer · Additional",
  admin_meeting: "Admin · Meeting",
  admin_reminder: "Admin · Reminder",
  admin_side_deal: "Admin · Side deal",
  admin_additional: "Admin · Additional",
  admin_review_resolution: "Admin · Legacy outcome",
} satisfies Record<RevenueOrigin, string>;

const ORIGIN_HELP =
  "Closer or Admin is who recorded the payment, from a meeting, a reminder, a side deal or an additional payment. All of it counts as revenue and is credited to the assigned closer.";

export function RevenueByOriginCard({
  byOrigin,
  totalMinor,
  rangePhrase,
  reloading,
}: {
  byOrigin: RevenueByOrigin | undefined;
  totalMinor: number;
  rangePhrase: string;
  reloading?: boolean;
}) {
  const rows = byOrigin
    ? (Object.keys(ORIGIN_LABELS) as RevenueOrigin[])
        .map((origin) => ({ origin, amountMinor: byOrigin[origin] }))
        .filter((row) => row.amountMinor > 0)
        .sort((left, right) => right.amountMinor - left.amountMinor)
    : undefined;

  return (
    <ReportCard
      title={<HelpTip tip={ORIGIN_HELP}>Revenue by origin</HelpTip>}
      meta="Share of final revenue"
      reloading={reloading}
    >
      {rows === undefined ? (
        <RowsSkeleton rows={6} label="Loading revenue by origin" />
      ) : rows.length === 0 ? (
        <SectionEmpty title={`No final revenue ${rangePhrase}.`} />
      ) : (
        <BarList
          label="Final revenue by origin"
          labelColumn="12rem"
          rows={rows.map((row) => ({
            key: row.origin,
            label: ORIGIN_LABELS[row.origin],
            value: row.amountMinor,
            display: <AmountShare amount={dollars(row.amountMinor)} share={wholeShare(row.amountMinor, totalMinor)} />,
          }))}
        />
      )}
    </ReportCard>
  );
}
