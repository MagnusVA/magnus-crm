"use client";

import { format, formatDistanceToNow } from "date-fns";
import type { FunctionReturnType } from "convex/server";
import { InboxIcon, SearchIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { OpportunitySourceBadge } from "./opportunity-source-badge";

export type OpportunityListRow = FunctionReturnType<
  typeof api.opportunities.listQueries.searchOpportunities
>[number];

type OpportunitiesTableProps = {
  opportunities: OpportunityListRow[];
  isSearching: boolean;
  isLoading: boolean;
  canLoadMore: boolean;
  showCloserColumn: boolean;
  onLoadMore: () => void;
  onRowClick: (opportunityId: Id<"opportunities">) => void;
};

export function OpportunitiesTable({
  opportunities,
  isSearching,
  isLoading,
  canLoadMore,
  showCloserColumn,
  onLoadMore,
  onRowClick,
}: OpportunitiesTableProps) {
  if (isLoading) {
    return (
      <div
        className="overflow-hidden rounded-lg border"
        role="status"
        aria-label="Loading opportunity rows"
      >
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton
            key={index}
            className="h-14 w-full rounded-none border-b last:border-b-0"
          />
        ))}
      </div>
    );
  }

  if (opportunities.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            {isSearching ? <SearchIcon /> : <InboxIcon />}
          </EmptyMedia>
          <EmptyTitle>
            {isSearching ? "No opportunities found" : "No opportunities yet"}
          </EmptyTitle>
          <EmptyDescription>
            {isSearching
              ? "Try changing the search term or filters."
              : "Calendly bookings and manually created side deals will appear here."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-52">Lead</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Source</TableHead>
              {showCloserColumn ? <TableHead>Closer</TableHead> : null}
              <TableHead className="min-w-36">Latest activity</TableHead>
              <TableHead className="min-w-32">Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {opportunities.map((opportunity) => (
              <TableRow
                key={opportunity._id}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => onRowClick(opportunity._id)}
              >
                <TableCell>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate font-medium">
                      {opportunity.lead?.fullName ??
                        opportunity.lead?.email ??
                        "Unknown lead"}
                    </span>
                    {opportunity.lead?.email ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {opportunity.lead.email}
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge status={opportunity.status} />
                    {opportunity.hasPendingStaleNudge ? (
                      <Badge variant="outline">Stale</Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  <OpportunitySourceBadge source={opportunity.source} />
                </TableCell>
                {showCloserColumn ? (
                  <TableCell className="text-muted-foreground">
                    {opportunity.assignedCloser?.fullName ??
                      opportunity.assignedCloser?.email ??
                      "Unassigned"}
                  </TableCell>
                ) : null}
                <TableCell className="font-mono text-sm text-muted-foreground tabular-nums">
                  {opportunity.latestActivityAt
                    ? formatDistanceToNow(new Date(opportunity.latestActivityAt), {
                        addSuffix: true,
                      })
                    : "No activity"}
                </TableCell>
                <TableCell className="font-mono text-sm text-muted-foreground tabular-nums">
                  {format(new Date(opportunity.createdAt), "MMM d, yyyy")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {canLoadMore ? (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
