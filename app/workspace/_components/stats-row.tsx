"use client";

import { StatsCard } from "./stats-card";
import { formatCurrency } from "@/lib/format-currency";
import {
  UsersIcon,
  TrendingUpIcon,
  CalendarIcon,
  TrophyIcon,
  DollarSignIcon,
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

  return (
    <div
      className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-5"
      aria-live="polite"
      aria-atomic="true"
    >
      {/* Static: current team size */}
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

      {/* Static: current pipeline state */}
      <StatsCard
        icon={TrendingUpIcon}
        label="Active Opportunities"
        value={stats.activeOpportunities}
        subtext={`${activePercent}% of ${stats.totalOpportunities} total`}
      />

      {/* Period-scoped: meetings in selected window */}
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

      {/* Period-scoped: won deals in selected window */}
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

      {/* Period-scoped: revenue in selected window */}
      {periodStats ? (
        periodStats.revenueInPeriod > 0 ? (
          <StatsCard
            icon={DollarSignIcon}
            label="Revenue"
            value={formatCurrency(periodStats.revenueInPeriod, "USD")}
            subtext={`${periodStats.paymentCountInPeriod} payment${periodStats.paymentCountInPeriod !== 1 ? "s" : ""} ${periodLabel.toLowerCase()}`}
            variant="success"
          />
        ) : (
          <StatsCard
            icon={DollarSignIcon}
            label="Revenue"
            value={formatCurrency(0, "USD")}
            subtext={periodLabel}
          />
        )
      ) : (
        <PeriodStatCardSkeleton />
      )}
    </div>
  );
}
