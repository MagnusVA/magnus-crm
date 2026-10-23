"use client";

import type { FunctionReturnType } from "convex/server";
import { DollarSignIcon, HandCoinsIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { StatsCard } from "@/app/workspace/_components/stats-card";
import { formatAmountMinor } from "@/lib/format-currency";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

type RevenueMetrics = FunctionReturnType<
  typeof api.reporting.revenue.getRevenueMetrics
>;

interface RevenueKpiCardsProps {
  metrics: RevenueMetrics | undefined;
}

function KpiCardSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="size-5 rounded" />
        </div>
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-24" />
        <Skeleton className="mt-2 h-3 w-32" />
      </CardContent>
    </Card>
  );
}

export function RevenueKpiCards({ metrics }: RevenueKpiCardsProps) {
  if (metrics === undefined) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {Array.from({ length: 2 }).map((_, index) => (
          <KpiCardSkeleton key={index} />
        ))}
      </div>
    );
  }

  const { revenue } = metrics;
  const finalSubtext = (() => {
    if (revenue.totalDeals === 0) {
      return "No closed-won deals yet";
    }
    const avg =
      revenue.avgDealMinor !== null
        ? formatAmountMinor(revenue.avgDealMinor, "USD")
        : "\u2014";
    return `${revenue.totalDeals} deal${
      revenue.totalDeals === 1 ? "" : "s"
    } · avg ${avg}`;
  })();

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <StatsCard
        icon={DollarSignIcon}
        label="Final revenue"
        value={formatAmountMinor(revenue.finalRevenueMinor, "USD")}
        subtext={finalSubtext}
        variant="primary"
      />
      <StatsCard
        icon={HandCoinsIcon}
        label="Deposits"
        value={formatAmountMinor(revenue.depositRevenueMinor, "USD")}
        subtext="Deposits logged from meetings, reminders, and side deals"
      />
    </div>
  );
}
