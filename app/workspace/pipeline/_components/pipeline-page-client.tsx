"use client";

import { Suspense, useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import type { Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { usePageTitle } from "@/hooks/use-page-title";
import { downloadCSV } from "@/lib/export-csv";
import { format } from "date-fns";
import { DownloadIcon } from "lucide-react";
import { OpportunitiesTable } from "./opportunities-table";
import { PipelineFilters } from "./pipeline-filters";

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

export function PipelinePageClient() {
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

  const setStatusFilter = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value && value !== "all") {
        params.set("status", value);
      } else {
        params.delete("status");
      }
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const setCloserFilter = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value && value !== "all") {
        params.set("closer", value);
      } else {
        params.delete("closer");
      }
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

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
  }, [closerFilter, statusFilter]);

  const opportunities = useQuery(
    api.opportunities.queries.listOpportunitiesForAdmin,
    queryArgs,
  );
  const teamMembers = useQuery(api.users.queries.listTeamMembers, {});

  const closersForFilter = useMemo(() => {
    if (!teamMembers) {
      return [];
    }

    return teamMembers.filter((member) => member.role === "closer");
  }, [teamMembers]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Pipeline</h1>
          <p className="mt-2 text-muted-foreground">
            View all opportunities across your team
          </p>
        </div>
        {opportunities && opportunities.length > 0 ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              downloadCSV(
                `pipeline-${format(new Date(), "yyyy-MM-dd")}`,
                ["Lead", "Email", "Closer", "Status", "Created"],
                opportunities.map((opportunity) => [
                  opportunity.leadName ?? "",
                  opportunity.leadEmail ?? "",
                  opportunity.closerName === "Unassigned"
                    ? opportunity.hostCalendlyEmail
                      ? `Unassigned (${opportunity.hostCalendlyEmail})`
                      : "Unassigned"
                    : opportunity.closerName ?? "Unassigned",
                  opportunity.status,
                  format(opportunity.createdAt, "yyyy-MM-dd HH:mm"),
                ]),
              );
            }}
          >
            <DownloadIcon data-icon="inline-start" />
            Export CSV
          </Button>
        ) : null}
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
