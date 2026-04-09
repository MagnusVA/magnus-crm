"use client";

import { useEffect } from "react";
import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { usePollingQuery } from "@/hooks/use-polling-query";
import { useRole } from "@/components/auth/role-context";
import { PipelineSummary } from "./pipeline-summary";
import { StatsRow } from "./stats-row";
import { SystemHealth } from "./system-health";

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
      </div>

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

export function DashboardPageClient() {
  usePageTitle("Dashboard");
  const router = useRouter();
  const { isAdmin } = useRole();
  const currentUser = useQuery(
    api.users.queries.getCurrentUser,
    isAdmin ? {} : "skip",
  );

  const stats = usePollingQuery(
    api.dashboard.adminStats.getAdminDashboardStats,
    isAdmin ? {} : "skip",
    { intervalMs: 60_000 },
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
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="mt-2 text-muted-foreground">
          Welcome back, {currentUser.fullName ?? currentUser.email}
        </p>
      </div>

      <StatsRow stats={stats} />
      <PipelineSummary stats={stats} />
      <SystemHealth />
    </div>
  );
}
