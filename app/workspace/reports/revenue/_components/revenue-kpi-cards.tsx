"use client";

import type { FunctionReturnType } from "convex/server";
import {
  CoinsIcon,
  DollarSignIcon,
  HandCoinsIcon,
  WalletIcon,
} from "lucide-react";
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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <KpiCardSkeleton key={index} />
        ))}
      </div>
    );
  }

  const { commissionable, nonCommissionable } = metrics;
  const commissionableFinalSubtext = (() => {
    if (commissionable.totalDeals === 0) {
      return "No closed-won deals yet";
    }
    const avg =
      commissionable.avgDealMinor !== null
        ? formatAmountMinor(commissionable.avgDealMinor, "USD")
        : "\u2014";
    return `${commissionable.totalDeals} deal${
      commissionable.totalDeals === 1 ? "" : "s"
    } · avg ${avg}`;
  })();

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatsCard
        icon={DollarSignIcon}
        label="Commissionable Final"
        value={formatAmountMinor(commissionable.finalRevenueMinor, "USD")}
        subtext={commissionableFinalSubtext}
        variant="primary"
      />
      <StatsCard
        icon={HandCoinsIcon}
        label="Commissionable Deposits"
        value={formatAmountMinor(commissionable.depositRevenueMinor, "USD")}
        subtext="Deposits logged from meetings, reminders, reviews"
      />
      <StatsCard
        icon={CoinsIcon}
        label="Post-Conversion Final"
        value={formatAmountMinor(nonCommissionable.finalRevenueMinor, "USD")}
        subtext={
          nonCommissionable.totalDeals === 0
            ? "No post-conversion payments in range"
            : `${nonCommissionable.totalDeals} post-conv. payment${
                nonCommissionable.totalDeals === 1 ? "" : "s"
              }`
        }
        variant="muted"
      />
      <StatsCard
        icon={WalletIcon}
        label="Post-Conversion Deposits"
        value={formatAmountMinor(nonCommissionable.depositRevenueMinor, "USD")}
        subtext="Customer-direct deposits recorded by admins"
        variant="muted"
      />
    </div>
  );
}
