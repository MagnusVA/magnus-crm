"use client";

import { useMemo, useCallback, Suspense } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { redirect } from "next/navigation";
import { usePageTitle } from "@/hooks/use-page-title";
import { PipelineFilters } from "./_components/pipeline-filters";
import { OpportunitiesTable } from "./_components/opportunities-table";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DownloadIcon } from "lucide-react";
import { downloadCSV } from "@/lib/export-csv";
import { format } from "date-fns";

type OpportunityStatus =
  | "scheduled"
  | "in_progress"
  | "payment_received"
  | "follow_up_scheduled"
  | "lost"
  | "canceled"
  | "no_show";

function TableSkeleton() {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex flex-col gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// Wrap page in Suspense for useSearchParams (Next.js requirement)
export default function PipelinePage() {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <PipelineContent />
    </Suspense>
  );
}

function PipelineContent() {
  usePageTitle("Pipeline");
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const statusFilter = searchParams.get("status") ?? "all";
  const closerFilter = searchParams.get("closer") ?? "all";

  // Sync filter changes to URL
  const setStatusFilter = useCallback((value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value && value !== "all") {
      params.set("status", value);
    } else {
      params.delete("status");
    }
    const qs = params.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [searchParams, router, pathname]);

  const setCloserFilter = useCallback((value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value && value !== "all") {
      params.set("closer", value);
    } else {
      params.delete("closer");
    }
    const qs = params.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [searchParams, router, pathname]);

  const currentUser = useQuery(api.users.queries.getCurrentUser);
  const isAdmin =
    currentUser?.role === "tenant_master" || currentUser?.role === "tenant_admin";

  // Build query args — only pass defined filters to the backend
  const queryArgs = useMemo(() => {
    const args: {
      statusFilter?: OpportunityStatus;
      assignedCloserId?: Id<"users">;
    } = {};

    if (statusFilter !== "all") {
      args.statusFilter = statusFilter as OpportunityStatus;
    }
    if (closerFilter !== "all") {
      args.assignedCloserId = closerFilter as Id<"users">;
    }

    return args;
  }, [statusFilter, closerFilter]);

  // Fetch opportunities with server-side filtering
  const opportunities = useQuery(
    api.opportunities.queries.listOpportunitiesForAdmin,
    isAdmin ? queryArgs : "skip",
  );

  // Fetch team members for closer filter dropdown
  const teamMembers = useQuery(
    api.users.queries.listTeamMembers,
    isAdmin ? {} : "skip",
  );

  const closersForFilter = useMemo(() => {
    if (!teamMembers) return [];
    return teamMembers.filter((m) => m.role === "closer");
  }, [teamMembers]);

  if (currentUser === undefined) {
    return <TableSkeleton />;
  }

  if (currentUser === null) {
    return null;
  }

  if (currentUser.role === "closer") {
    redirect("/workspace/closer");
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Pipeline</h1>
          <p className="mt-2 text-muted-foreground">
            View all opportunities across your team
          </p>
        </div>
        {opportunities && opportunities.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              downloadCSV(
                `pipeline-${format(new Date(), "yyyy-MM-dd")}`,
                ["Lead", "Email", "Closer", "Status", "Created"],
                opportunities.map((opp) => [
                  opp.leadName ?? "",
                  opp.leadEmail ?? "",
                  opp.closerName ?? "Unassigned",
                  opp.status,
                  format(opp.createdAt, "yyyy-MM-dd HH:mm"),
                ]),
              );
            }}
          >
            <DownloadIcon data-icon="inline-start" />
            Export CSV
          </Button>
        )}
      </div>

      {teamMembers === undefined ? (
        <TableSkeleton />
      ) : (
        <PipelineFilters
          statusFilter={statusFilter}
          closerFilter={closerFilter}
          closers={closersForFilter}
          onStatusChange={setStatusFilter}
          onCloserChange={setCloserFilter}
        />
      )}

      {opportunities === undefined ? (
        <TableSkeleton />
      ) : (
        <OpportunitiesTable opportunities={opportunities} />
      )}
    </div>
  );
}
