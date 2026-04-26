"use client";

import { StatsCard } from "./stats-card";
import { formatCurrency } from "@/lib/format-currency";
import {
  UsersIcon,
  TrendingUpIcon,
  CalendarIcon,
  TrophyIcon,
  DollarSignIcon,
  HandCoinsIcon,
  CoinsIcon,
  LinkIcon,
  WalletIcon,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/** All-time aggregate stats from tenantStats summary doc. */
interface StaticStats {
  totalClosers: number;
  unmatchedClosers: number;
  totalTeamMembers: number;
  activeOpportunities: number;
  totalOpportunities: number;
}

/** Time-period scoped stats from getTimePeriodStats. */
interface PeriodStats {
  newOpportunities: number;
  meetingsInPeriod: number;
  wonDealsInPeriod: number;
  revenueInPeriod: number;
  closedWonInPeriod: number;
  depositsInPeriod: number;
  postConversionInPeriod: number;
  postConversionDepositsInPeriod: number;
  sideDealRevenueInPeriod: number;
  sideDealCountInPeriod: number;
  paymentCountInPeriod: number;
  newCustomers: number;
}

interface StatsRowProps {
  stats: StaticStats;
  periodStats: PeriodStats | null;
  periodLabel: string;
}

function PeriodStatCardSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="size-5 rounded" />
        </div>
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-12" />
        <Skeleton className="mt-2 h-3 w-28" />
      </CardContent>
    </Card>
  );
}

export function StatsRow({ stats, periodStats, periodLabel }: StatsRowProps) {
  const activePercent =
    stats.totalOpportunities > 0
      ? Math.round(
          (stats.activeOpportunities / stats.totalOpportunities) * 100,
        )
      : 0;
  const periodSuffix = periodLabel.toLowerCase();

  return (
    <div className="flex flex-col gap-4" aria-live="polite" aria-atomic="true">
      {/* Row 1 — static + period meetings / won deals */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatsCard
          icon={UsersIcon}
          label="Total Closers"
          value={stats.totalClosers}
          subtext={
            stats.unmatchedClosers > 0
              ? `${stats.unmatchedClosers} unmatched`
              : "All matched"
          }
          variant={stats.unmatchedClosers > 0 ? "warning" : "default"}
        />

        <StatsCard
          icon={TrendingUpIcon}
          label="Active Opportunities"
          value={stats.activeOpportunities}
          subtext={`${activePercent}% of ${stats.totalOpportunities} total`}
        />

        {periodStats ? (
          <StatsCard
            icon={CalendarIcon}
            label="Meetings"
            value={periodStats.meetingsInPeriod}
            subtext={periodLabel}
          />
        ) : (
          <PeriodStatCardSkeleton />
        )}

        {periodStats ? (
          <StatsCard
            icon={TrophyIcon}
            label="Won Deals"
            value={periodStats.wonDealsInPeriod}
            subtext={periodLabel}
            variant={periodStats.wonDealsInPeriod > 0 ? "success" : "default"}
          />
        ) : (
          <PeriodStatCardSkeleton />
        )}
      </div>

      {/* Row 2 — Commissionable Final / Commissionable Deposits / Post-Conversion Final / Post-Conversion Deposits */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {periodStats ? (
          <StatsCard
            icon={DollarSignIcon}
            label="Commissionable Final"
            value={formatCurrency(periodStats.closedWonInPeriod, "USD")}
            subtext={`Closed-won revenue ${periodSuffix}`}
            variant={periodStats.closedWonInPeriod > 0 ? "primary" : "default"}
          />
        ) : (
          <PeriodStatCardSkeleton />
        )}

        {periodStats ? (
          <StatsCard
            icon={HandCoinsIcon}
            label="Commissionable Deposits"
            value={formatCurrency(periodStats.depositsInPeriod, "USD")}
            subtext={`Deposits collected ${periodSuffix}`}
          />
        ) : (
          <PeriodStatCardSkeleton />
        )}

        {periodStats ? (
          <StatsCard
            icon={CoinsIcon}
            label="Post-Conversion Final"
            value={formatCurrency(periodStats.postConversionInPeriod, "USD")}
            subtext={`Customer-direct revenue ${periodSuffix}`}
            variant="muted"
          />
        ) : (
          <PeriodStatCardSkeleton />
        )}

        {periodStats ? (
          <StatsCard
            icon={WalletIcon}
            label="Post-Conversion Deposits"
            value={formatCurrency(
              periodStats.postConversionDepositsInPeriod,
              "USD",
            )}
            subtext={`Customer deposits ${periodSuffix}`}
            variant="muted"
          />
        ) : (
          <PeriodStatCardSkeleton />
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {periodStats ? (
          <StatsCard
            icon={LinkIcon}
            label="Side-Deal Revenue"
            value={formatCurrency(periodStats.sideDealRevenueInPeriod, "USD")}
            subtext={`${periodStats.sideDealCountInPeriod} side-deal${
              periodStats.sideDealCountInPeriod === 1 ? "" : "s"
            } ${periodSuffix}`}
            variant={
              periodStats.sideDealRevenueInPeriod > 0 ? "primary" : "default"
            }
          />
        ) : (
          <PeriodStatCardSkeleton />
        )}
      </div>
    </div>
  );
}
