"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ActivityIcon,
  PhoneIcon,
  PercentIcon,
  Repeat2Icon,
  DollarSignIcon,
  TrendingDownIcon,
  TrendingUpIcon,
} from "lucide-react";
import type {
  ActionsPerCloserMetrics,
  DerivedOutcomes,
  TeamTotals,
} from "./team-report-types";
import {
  formatCompactCurrency,
  formatRate,
} from "./team-report-formatters";

interface TeamKpiSummaryCardsProps {
  totals: TeamTotals;
  derivedOutcomes: DerivedOutcomes;
  actionsPerCloser: ActionsPerCloserMetrics;
}

export function TeamKpiSummaryCards({
  totals,
  derivedOutcomes,
  actionsPerCloser,
}: TeamKpiSummaryCardsProps) {
  const totalBooked = totals.newBookedCalls + totals.followUpBookedCalls;
  const totalShowed = totals.newShowed + totals.followUpShowed;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card size="sm">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Total Booked
              </CardTitle>
              <PhoneIcon className="size-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{totalBooked}</div>
            <p className="text-xs text-muted-foreground">
              {totals.newBookedCalls} new, {totals.followUpBookedCalls} follow-up
            </p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Show-Up Rate
              </CardTitle>
              <PercentIcon className="size-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {formatRate(totals.overallShowUpRate)}
            </div>
            <p className="text-xs text-muted-foreground">
              {totalShowed} showed of {totals.overallConfirmedDenominator} eligible
            </p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Cash Collected
              </CardTitle>
              <DollarSignIcon className="size-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {formatCompactCurrency(totals.totalRevenueMinor)}
            </div>
            <p className="text-xs text-muted-foreground">
              {totals.totalSales} deal{totals.totalSales === 1 ? "" : "s"}
            </p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Close Rate
              </CardTitle>
              <TrendingUpIcon className="size-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {formatRate(totals.overallCloseRate)}
            </div>
            <p className="text-xs text-muted-foreground">
              {totals.totalSales} sales / {totalShowed} showed
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card size="sm">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Lost Deals
              </CardTitle>
              <TrendingDownIcon className="size-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {derivedOutcomes.lostDeals}
            </div>
            <p className="text-xs text-muted-foreground">
              Opportunities that resolved as lost in this range
            </p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Rebook Rate
              </CardTitle>
              <Repeat2Icon className="size-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {formatRate(derivedOutcomes.rebookRate)}
            </div>
            <p className="text-xs text-muted-foreground">
              {derivedOutcomes.rebookNumerator} rebooked of{" "}
              {derivedOutcomes.rebookDenominator} missed
            </p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Actions / Closer / Day
              </CardTitle>
              <ActivityIcon className="size-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {actionsPerCloser.actionsPerCloserPerDay !== null
                ? actionsPerCloser.actionsPerCloserPerDay.toFixed(1)
                : "\u2014"}
            </div>
            <p className="text-xs text-muted-foreground">
              {actionsPerCloser.distinctCloserActors} active closer
              {actionsPerCloser.distinctCloserActors === 1 ? "" : "s"} across{" "}
              {actionsPerCloser.daySpanDays} day
              {actionsPerCloser.daySpanDays === 1 ? "" : "s"}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
