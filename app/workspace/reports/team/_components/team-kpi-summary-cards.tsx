"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  PhoneIcon,
  PercentIcon,
  DollarSignIcon,
  TrendingUpIcon,
} from "lucide-react";

interface TeamTotals {
  newBookedCalls: number;
  newCanceled: number;
  newNoShows: number;
  newShowed: number;
  followUpBookedCalls: number;
  followUpCanceled: number;
  followUpNoShows: number;
  followUpShowed: number;
  totalSales: number;
  totalRevenue: number;
  totalRevenueMinor: number;
  newShowUpRate: number | null;
  followUpShowUpRate: number | null;
  overallShowUpRate: number | null;
  overallCloseRate: number | null;
  avgCashCollectedMinor: number | null;
  excludedRevenueMinor: number;
  excludedSales: number;
}

interface TeamKpiSummaryCardsProps {
  totals: TeamTotals;
}

function formatRate(rate: number | null): string {
  if (rate === null) return "\u2014";
  return `${(rate * 100).toFixed(1)}%`;
}

function formatCurrency(minorUnits: number): string {
  return `$${(minorUnits / 100).toLocaleString()}`;
}

export function TeamKpiSummaryCards({ totals }: TeamKpiSummaryCardsProps) {
  const totalBooked = totals.newBookedCalls + totals.followUpBookedCalls;
  const totalShowed = totals.newShowed + totals.followUpShowed;
  const totalBookedMinusCanceled =
    totalBooked - totals.newCanceled - totals.followUpCanceled;

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {/* Total Booked */}
      <Card size="sm">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Booked
            </CardTitle>
            <PhoneIcon className="h-4 w-4 text-muted-foreground" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{totalBooked}</div>
          <p className="text-xs text-muted-foreground">
            {totals.newBookedCalls} new, {totals.followUpBookedCalls} follow-up
          </p>
        </CardContent>
      </Card>

      {/* Show-Up Rate */}
      <Card size="sm">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Show-Up Rate
            </CardTitle>
            <PercentIcon className="h-4 w-4 text-muted-foreground" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">
            {formatRate(totals.overallShowUpRate)}
          </div>
          <p className="text-xs text-muted-foreground">
            {totalShowed} showed of {totalBookedMinusCanceled} eligible
          </p>
        </CardContent>
      </Card>

      {/* Cash Collected */}
      <Card size="sm">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Cash Collected
            </CardTitle>
            <DollarSignIcon className="h-4 w-4 text-muted-foreground" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">
            {formatCurrency(totals.totalRevenueMinor)}
          </div>
          <p className="text-xs text-muted-foreground">
            {totals.totalSales} deals
          </p>
        </CardContent>
      </Card>

      {/* Close Rate */}
      <Card size="sm">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Close Rate
            </CardTitle>
            <TrendingUpIcon className="h-4 w-4 text-muted-foreground" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">
            {formatRate(totals.overallCloseRate)}
          </div>
          <p className="text-xs text-muted-foreground">
            {totals.totalSales} sales / {totalShowed} showed
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
