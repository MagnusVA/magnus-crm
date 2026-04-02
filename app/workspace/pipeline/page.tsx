"use client";

import { useState, useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PipelineFilters } from "./_components/pipeline-filters";
import { OpportunitiesTable } from "./_components/opportunities-table";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

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

export default function PipelinePage() {
  const [statusFilter, setStatusFilter] = useState("all");
  const [closerFilter, setCloserFilter] = useState("all");

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
    queryArgs,
  );

  // Fetch team members for closer filter dropdown
  const teamMembers = useQuery(api.users.queries.listTeamMembers);

  const closersForFilter = useMemo(() => {
    if (!teamMembers) return [];
    return teamMembers.filter((m) => m.role === "closer");
  }, [teamMembers]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Pipeline</h1>
        <p className="mt-2 text-muted-foreground">
          View all opportunities across your team
        </p>
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
