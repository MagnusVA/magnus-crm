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
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

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
    <Card size="sm">
      <CardHeader className="pb-1">
        <div className="flex items-start justify-between">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="size-4 rounded" />
        </div>
      </CardHeader>
      <CardContent>
        <Skeleton className="h-7 w-12" />
        <Skeleton className="mt-2 h-3 w-28" />
      </CardContent>
    </Card>
  );
}

function RevenueMetricSkeleton({ featured = false }: { featured?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-muted/30 p-4",
        featured && "min-h-40 lg:row-span-2",
      )}
    >
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="size-5 rounded" />
      </div>
      <Skeleton className="mt-8 h-8 w-28" />
      <Skeleton className="mt-2 h-3 w-40" />
    </div>
  );
}

interface RevenueMetricProps {
  icon: LucideIcon;
  label: string;
  value: string;
  subtext: string;
  featured?: boolean;
  muted?: boolean;
}

function RevenueMetric({
  icon: Icon,
  label,
  value,
  subtext,
  featured = false,
  muted = false,
}: RevenueMetricProps) {
  return (
    <div
      className={cn(
        "rounded-lg border p-4",
        muted ? "bg-muted/30" : "bg-background",
        featured &&
          "flex min-h-40 flex-col justify-between border-primary/30 bg-primary/5 ring-1 ring-primary/10 lg:row-span-2",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          {!featured && (
            <p className="text-xs text-muted-foreground">{subtext}</p>
          )}
        </div>
        <Icon
          className={cn(
            "size-5 shrink-0",
            featured ? "text-primary" : "text-muted-foreground/60",
          )}
          aria-hidden
        />
      </div>
      <div className={cn(featured ? "mt-6" : "mt-5")}>
        <div
          className={cn(
            "font-mono font-bold tabular-nums",
            featured ? "text-4xl" : "text-2xl",
          )}
        >
          {value}
        </div>
        {featured && (
          <p className="mt-2 text-sm text-muted-foreground">{subtext}</p>
        )}
      </div>
    </div>
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
    <section
      className="flex flex-col gap-4"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-[minmax(20rem,1.35fr)_repeat(3,minmax(0,1fr))]">
        <Card className="border-primary/25 bg-primary/5 ring-1 ring-primary/10">
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Active Opportunities
                </CardTitle>
                <CardDescription>
                  {stats.totalOpportunities.toLocaleString()} total in pipeline
                </CardDescription>
              </div>
              <TrendingUpIcon className="size-5 text-primary" aria-hidden />
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-end justify-between gap-3">
              <div className="font-mono text-5xl font-bold tabular-nums">
                {stats.activeOpportunities.toLocaleString()}
              </div>
              <Badge variant="outline">{activePercent}% active</Badge>
            </div>
            <Progress
              className="mt-4"
              value={activePercent}
              aria-label={`${activePercent}% of opportunities are active`}
            />
          </CardContent>
        </Card>

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
          size="sm"
        />

        {periodStats ? (
          <StatsCard
            icon={CalendarIcon}
            label="Meetings"
            value={periodStats.meetingsInPeriod}
            subtext={periodLabel}
            size="sm"
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
            size="sm"
          />
        ) : (
          <PeriodStatCardSkeleton />
        )}
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Revenue Snapshot</CardTitle>
          <CardDescription>
            Commissionable and customer-direct revenue for {periodSuffix}.
          </CardDescription>
          <CardAction>
            <Badge variant="secondary">{periodLabel}</Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="pt-4">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(18rem,1.15fr)_repeat(2,minmax(0,1fr))]">
            {periodStats ? (
              <RevenueMetric
                icon={DollarSignIcon}
                label="Commissionable Final"
                value={formatCurrency(periodStats.closedWonInPeriod, "USD")}
                subtext={`Closed-won revenue ${periodSuffix}`}
                featured
              />
            ) : (
              <RevenueMetricSkeleton featured />
            )}

            {periodStats ? (
              <RevenueMetric
                icon={HandCoinsIcon}
                label="Commissionable Deposits"
                value={formatCurrency(periodStats.depositsInPeriod, "USD")}
                subtext={`Deposits collected ${periodSuffix}`}
              />
            ) : (
              <RevenueMetricSkeleton />
            )}

            {periodStats ? (
              <RevenueMetric
                icon={CoinsIcon}
                label="Post-Conversion Final"
                value={formatCurrency(
                  periodStats.postConversionInPeriod,
                  "USD",
                )}
                subtext={`Customer-direct revenue ${periodSuffix}`}
                muted
              />
            ) : (
              <RevenueMetricSkeleton />
            )}

            {periodStats ? (
              <RevenueMetric
                icon={WalletIcon}
                label="Post-Conversion Deposits"
                value={formatCurrency(
                  periodStats.postConversionDepositsInPeriod,
                  "USD",
                )}
                subtext={`Customer deposits ${periodSuffix}`}
                muted
              />
            ) : (
              <RevenueMetricSkeleton />
            )}

            {periodStats ? (
              <RevenueMetric
                icon={LinkIcon}
                label="Side-Deal Revenue"
                value={formatCurrency(
                  periodStats.sideDealRevenueInPeriod,
                  "USD",
                )}
                subtext={`${periodStats.sideDealCountInPeriod} side-deal${
                  periodStats.sideDealCountInPeriod === 1 ? "" : "s"
                } ${periodSuffix}`}
              />
            ) : (
              <RevenueMetricSkeleton />
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
