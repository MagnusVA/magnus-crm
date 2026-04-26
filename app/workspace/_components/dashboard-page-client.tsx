"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { useRole } from "@/components/auth/role-context";
import { PipelineSummary } from "./pipeline-summary";
import { StatsRow } from "./stats-row";
import { SystemHealth } from "./system-health";
import {
  TimePeriodFilter,
  useDateRange,
  getPeriodLabel,
  type TimePeriod,
} from "./time-period-filter";

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
      </div>

      <div className="flex flex-col gap-4">
        <DashboardStatsSkeletonGrid count={4} />
        <DashboardStatsSkeletonGrid count={4} />
        <DashboardStatsSkeletonGrid count={1} />
      </div>

      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}

function DashboardStatsSkeletonGrid({ count }: { count: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i}>
          <CardHeader className="pb-3">
            <Skeleton className="h-4 w-24" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-8 w-16" />
            <Skeleton className="mt-2 h-3 w-32" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function DashboardPageClient() {
  usePageTitle("Dashboard");
  const router = useRouter();
  const { isAdmin } = useRole();

  const [period, setPeriod] = useState<TimePeriod>("today");
  const dateRange = useDateRange(period);
  const periodLabel = getPeriodLabel(period);

  const currentUser = useQuery(
    api.users.queries.getCurrentUser,
    isAdmin ? {} : "skip",
  );

  // All-time aggregate stats (totalClosers, activeOpportunities, etc.)
  const stats = useQuery(
    api.dashboard.adminStats.getAdminDashboardStats,
    isAdmin ? {} : "skip",
  );

  // Time-period scoped stats (new opps, meetings, revenue in period)
  const periodStats = useQuery(
    api.dashboard.adminStats.getTimePeriodStats,
    isAdmin
      ? { periodStart: dateRange.periodStart, periodEnd: dateRange.periodEnd }
      : "skip",
  );

  useEffect(() => {
    if (!isAdmin) {
      router.replace("/workspace/closer");
    }
  }, [isAdmin, router]);

  if (!isAdmin || stats === undefined || !currentUser) {
    return <DashboardSkeleton />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="mt-2 text-muted-foreground">
            Welcome back, {currentUser.fullName ?? currentUser.email}
          </p>
        </div>
        <TimePeriodFilter value={period} onValueChange={setPeriod} />
      </div>

      <StatsRow
        stats={stats}
        periodStats={periodStats ?? null}
        periodLabel={periodLabel}
      />
      <PipelineSummary stats={stats} />
      <SystemHealth />
    </div>
  );
}
