"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { redirect } from "next/navigation";
import { usePageTitle } from "@/hooks/use-page-title";
import { usePollingQuery } from "@/hooks/use-polling-query";
import { StatsRow } from "./_components/stats-row";
import { PipelineSummary } from "./_components/pipeline-summary";
import { SystemHealth } from "./_components/system-health";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

type AdminDashboardStats = {
  totalTeamMembers: number;
  totalClosers: number;
  unmatchedClosers: number;
  totalOpportunities: number;
  activeOpportunities: number;
  meetingsToday: number;
  wonDeals: number;
  revenueLogged: number;
  totalRevenue: number;
  paymentRecordsLogged: number;
};

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
      </div>

      {/* Stats Row Skeleton */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
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

      {/* Pipeline Summary Skeleton */}
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

      {/* System Health Skeleton */}
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

export default function AdminDashboardPage() {
  usePageTitle("Dashboard");

  const user = useQuery(api.users.queries.getCurrentUser);

  // One-shot fetch with 60s polling for admin stats to avoid stale "meetings today"
  // results when time passes and midnight boundaries shift (Date.now() is not cached)
  const stats = usePollingQuery(
    api.dashboard.adminStats.getAdminDashboardStats,
    user && user.role !== "closer" ? {} : "skip",
    { intervalMs: 60_000 },
  );

  if (user === undefined) {
    return <DashboardSkeleton />;
  }

  if (user === null) return null;

  if (user.role === "closer") {
    redirect("/workspace/closer");
  }

  if (stats === undefined) {
    return <DashboardSkeleton />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="mt-2 text-muted-foreground">
          Welcome back, {user.fullName ?? user.email}
        </p>
      </div>

      <StatsRow stats={stats} />
      <PipelineSummary stats={stats} />
      <SystemHealth />
    </div>
  );
}
