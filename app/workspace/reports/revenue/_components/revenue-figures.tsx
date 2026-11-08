"use client";

import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { FigureZone, ReportFigures } from "../../_components/report-ui";
import { countWords, dollars, formatCount } from "./revenue-format";

type RevenueMetrics = FunctionReturnType<typeof api.reporting.revenue.getRevenueMetrics>;

/**
 * The band's four figures: final revenue (the cash figure, lime on the
 * navy), deposits, deals and the average deal. Undefined metrics draw the
 * zones' loading bones.
 */
export function RevenueFigures({
  metrics,
  rangePhrase,
  reloading,
}: {
  metrics: RevenueMetrics | undefined;
  /** "today", "this week", "in this range". */
  rangePhrase: string;
  reloading?: boolean;
}) {
  const revenue = metrics?.revenue;
  const closersWithDeals = revenue?.byCloser.filter((closer) => closer.dealCount > 0).length ?? 0;

  return (
    <ReportFigures reloading={reloading}>
      <FigureZone
        label="Final revenue"
        figure={revenue ? dollars(revenue.finalRevenueMinor) : undefined}
        figureClassName="text-primary"
        proof={revenue && revenue.totalDeals > 0 ? "PIF, split and monthly payments" : `No final payments ${rangePhrase}`}
      />
      <FigureZone
        label="Deposits"
        figure={revenue ? dollars(revenue.depositRevenueMinor) : undefined}
        proof={revenue && revenue.depositRevenueMinor > 0 ? "Kept out of final revenue" : `No deposits ${rangePhrase}`}
      />
      <FigureZone
        label="Deals"
        figure={revenue ? formatCount(revenue.totalDeals) : undefined}
        proof={
          revenue && revenue.totalDeals > 0
            ? closersWithDeals > 0
              ? `Across ${countWords(closersWithDeals, "closer")}`
              : "None credited to a closer"
            : "One per final payment"
        }
      />
      <FigureZone
        label="Average deal"
        figure={revenue ? (revenue.avgDealMinor === null ? "—" : dollars(revenue.avgDealMinor)) : undefined}
        proof={
          revenue && revenue.avgDealMinor !== null
            ? `${dollars(revenue.finalRevenueMinor)} ÷ ${countWords(revenue.totalDeals, "deal")}`
            : "No deals to average"
        }
      />
    </ReportFigures>
  );
}
