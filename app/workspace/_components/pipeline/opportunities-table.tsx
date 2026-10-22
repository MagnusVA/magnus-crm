"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SortableHeader } from "@/components/sortable-header";
import { DealStageBadge } from "@/components/status-badge";
import { useTableSort } from "@/hooks/use-table-sort";
import type { Id } from "@/convex/_generated/dataModel";
import type { CloserNextStep } from "@/convex/closer/pipeline";
import { dealPositionLabel } from "@/convex/opportunities/stageLabels";
import {
  DEAL_POSITIONS,
  type DealPosition,
  type SystemLossReason,
} from "@/convex/opportunities/stages";
import { ExternalLinkIcon, InboxIcon } from "lucide-react";

export interface PipelineOpportunity {
  _id: Id<"opportunities">;
  leadId: Id<"leads">;
  position: DealPosition;
  /** The loss the system wrote on a Lost deal, such as a no-show, if it did. */
  systemLoss: SystemLossReason | null;
  /** What a Follow-up deal waits on, if anything. */
  nextStep: CloserNextStep | null;
  leadName: string;
  leadEmail?: string;
  nextMeetingId?: Id<"meetings"> | null;
  nextMeetingAt?: number | null;
  latestMeetingId?: Id<"meetings"> | null;
  latestMeetingAt?: number | null;
  createdAt: number;
}

export interface OpportunitiesTableProps {
  opportunities: PipelineOpportunity[];
  canLoadMore: boolean;
  isLoadingMore?: boolean;
  onLoadMore: () => void;
  /** Optional custom empty state. Falls back to a generic "No opportunities" card. */
  emptyState?: React.ReactNode;
}

function nextStepLabel(nextStep: CloserNextStep): string {
  return nextStep.kind === "reschedule_link_sent"
    ? "Reschedule link sent"
    : `Reminder ${format(nextStep.reminderScheduledAt, "MMM d, h:mm a")}`;
}

function formatDate(timestamp: number) {
  const date = new Date(timestamp);
  const now = new Date();

  // Today — show time only
  if (
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear()
  ) {
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }

  // Within 7 days — show weekday + date
  const daysDiff = Math.floor(
    (now.getTime() - date.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (daysDiff >= 0 && daysDiff < 7) {
    return date.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function OpportunitiesTable({
  opportunities,
  canLoadMore,
  isLoadingMore = false,
  onLoadMore,
  emptyState,
}: OpportunitiesTableProps) {
  const [now, setNow] = useState(() => Date.now());

  const comparators = useMemo(
    () => ({
      lead: (a: PipelineOpportunity, b: PipelineOpportunity) =>
        a.leadName.localeCompare(b.leadName),
      // By the badge: the pipeline's order, then a loss's kind.
      stage: (a: PipelineOpportunity, b: PipelineOpportunity) =>
        DEAL_POSITIONS.indexOf(a.position) - DEAL_POSITIONS.indexOf(b.position) ||
        dealPositionLabel(a.position, a.systemLoss).localeCompare(
          dealPositionLabel(b.position, b.systemLoss),
        ),
      meeting: (a: PipelineOpportunity, b: PipelineOpportunity) =>
        (a.nextMeetingAt ?? a.latestMeetingAt ?? 0) -
        (b.nextMeetingAt ?? b.latestMeetingAt ?? 0),
      created: (a: PipelineOpportunity, b: PipelineOpportunity) =>
        a.createdAt - b.createdAt,
    }),
    [],
  );

  const { sorted, sort, toggle } = useTableSort(opportunities, comparators);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 60_000);

    return () => {
      window.clearInterval(interval);
    };
  }, []);

  if (opportunities.length === 0) {
    if (emptyState) {
      return <>{emptyState}</>;
    }
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <InboxIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No opportunities found</EmptyTitle>
          <EmptyDescription>
            No opportunities match your current filters. Try adjusting your
            filters or check back later.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHeader
                label="Lead"
                sortKey="lead"
                sort={sort}
                onToggle={toggle}
              />
              <SortableHeader
                label="Stage"
                sortKey="stage"
                sort={sort}
                onToggle={toggle}
              />
              <SortableHeader
                label="Next Meeting"
                sortKey="meeting"
                sort={sort}
                onToggle={toggle}
              />
              <SortableHeader
                label="Created"
                sortKey="created"
                sort={sort}
                onToggle={toggle}
              />
              <TableHead className="text-right font-semibold">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((opp) => {
              const displayMeetingAt =
                opp.nextMeetingAt && opp.nextMeetingAt > now
                  ? opp.nextMeetingAt
                  : opp.latestMeetingAt;
              return (
                <TableRow key={opp._id}>
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium">{opp.leadName}</span>
                      {opp.leadEmail && (
                        <span className="text-xs text-muted-foreground">
                          {opp.leadEmail}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <DealStageBadge
                        position={opp.position}
                        systemLoss={opp.systemLoss}
                      />
                      {opp.nextStep ? (
                        <span className="text-xs text-muted-foreground">
                          {nextStepLabel(opp.nextStep)}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-sm tabular-nums text-muted-foreground">
                    {displayMeetingAt ? formatDate(displayMeetingAt) : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-sm tabular-nums text-muted-foreground">
                    {formatDate(opp.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      asChild
                      aria-label={`View opportunity for ${opp.leadName}`}
                    >
                      <Link
                        href={`/workspace/leads-customers/${opp.leadId}?opportunityId=${opp._id}`}
                      >
                        View
                        <ExternalLinkIcon
                          aria-hidden="true"
                          data-icon="inline-end"
                        />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {canLoadMore && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={onLoadMore}
            disabled={isLoadingMore}
          >
            {isLoadingMore ? (
              <>
                <Spinner data-icon="inline-start" />
                Loading…
              </>
            ) : (
              "Load more"
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
