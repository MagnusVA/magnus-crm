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
import { SlackMetricsSection } from "./slack-metrics-section";
import { StatsRow } from "./stats-row";
import { SystemHealth } from "./system-health";
import { SlackMetricsSkeleton } from "./skeletons/slack-metrics-skeleton";
import {
  TimePeriodFilter,
  useDateRange,
  getPeriodLabel,
  type TimePeriod,
} from "./time-period-filter";

function DashboardSkeleton() {
  return (
    <div
      className="mx-auto flex w-full max-w-[1500px] flex-col gap-5"
      role="status"
      aria-label="Loading dashboard"
    >
      <div className="flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-full max-w-md" />
        </div>
        <Skeleton className="h-8 w-44" />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-[minmax(20rem,1.35fr)_repeat(3,minmax(0,1fr))]">
        <Card>
          <CardHeader className="pb-2">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-28" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-12 w-24" />
            <Skeleton className="mt-4 h-2 w-full" />
          </CardContent>
        </Card>
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} size="sm">
            <CardHeader className="pb-1">
              <Skeleton className="h-4 w-28" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-7 w-16" />
              <Skeleton className="mt-2 h-3 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="border-b">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-72" />
        </CardHeader>
        <CardContent className="pt-4">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(18rem,1.15fr)_repeat(2,minmax(0,1fr))]">
            <Skeleton className="min-h-40 rounded-lg lg:row-span-2" />
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-32 rounded-lg" />
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-5 2xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,0.65fr)]">
        <SlackMetricsSkeleton />
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-36" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-20 w-full" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-32" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-28 w-full" />
            </CardContent>
          </Card>
        </div>
      </div>
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
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-5">
      <div className="flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold">Dashboard</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Welcome back, {currentUser.fullName ?? currentUser.email}
          </p>
        </div>
        <div className="shrink-0">
          <TimePeriodFilter value={period} onValueChange={setPeriod} />
        </div>
      </div>

      <StatsRow
        stats={stats}
        periodStats={periodStats ?? null}
        periodLabel={periodLabel}
      />

      <div className="grid grid-cols-1 gap-5 2xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,0.65fr)]">
        <SlackMetricsSection />
        <div className="flex min-w-0 flex-col gap-5">
          <PipelineSummary stats={stats} />
          <SystemHealth />
        </div>
      </div>
    </div>
  );
}
