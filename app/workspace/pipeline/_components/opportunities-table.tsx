"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { SortableHeader } from "@/components/sortable-header";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { ExternalLinkIcon, InboxIcon } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import { useTableSort } from "@/hooks/use-table-sort";

type OpportunityStatus =
  | "scheduled"
  | "in_progress"
  | "payment_received"
  | "follow_up_scheduled"
  | "lost"
  | "canceled"
  | "no_show";

interface Opportunity {
  _id: Id<"opportunities">;
  status: OpportunityStatus;
  leadName: string;
  leadEmail?: string;
  closerName: string;
  closerEmail?: string;
  eventTypeName?: string | null;
  nextMeetingAt?: number | null;
  latestMeetingAt?: number | null;
  meetingStatus?: string | null;
  createdAt: number;
  updatedAt: number;
}

interface OpportunitiesTableProps {
  opportunities: Opportunity[];
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

export function OpportunitiesTable({ opportunities }: OpportunitiesTableProps) {
  const [now, setNow] = useState(() => Date.now());

  const comparators = useMemo(() => ({
    lead: (a: Opportunity, b: Opportunity) => a.leadName.localeCompare(b.leadName),
    closer: (a: Opportunity, b: Opportunity) => a.closerName.localeCompare(b.closerName),
    status: (a: Opportunity, b: Opportunity) => a.status.localeCompare(b.status),
    meeting: (a: Opportunity, b: Opportunity) => (a.nextMeetingAt ?? a.latestMeetingAt ?? 0) - (b.nextMeetingAt ?? b.latestMeetingAt ?? 0),
    created: (a: Opportunity, b: Opportunity) => a.createdAt - b.createdAt,
  }), []);

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
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <InboxIcon />
          </EmptyMedia>
          <EmptyTitle>No opportunities found</EmptyTitle>
          <EmptyDescription>
            No opportunities match your current filters. Try adjusting your filters or check back later.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
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
              label="Closer"
              sortKey="closer"
              sort={sort}
              onToggle={toggle}
            />
            <SortableHeader
              label="Status"
              sortKey="status"
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
            <TableHead className="text-right font-semibold">Actions</TableHead>
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
                <TableCell className="text-muted-foreground">
                  {opp.closerName === "Unassigned" ? (
                    <Badge variant="secondary">Unassigned</Badge>
                  ) : (
                    opp.closerName
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge status={opp.status} />
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
                    aria-label={`View details for ${opp.leadName}`}
                  >
                    View
                    <ExternalLinkIcon data-icon="inline-end" />
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
