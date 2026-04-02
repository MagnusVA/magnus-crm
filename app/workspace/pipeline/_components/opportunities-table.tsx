"use client";

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
import { StatusBadge } from "./status-badge";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { ExternalLinkIcon, InboxIcon } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";

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
  if (opportunities.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <InboxIcon />
          </EmptyMedia>
          <EmptyTitle>No opportunities found</EmptyTitle>
          <EmptyDescription>
            No opportunities match your current filters
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
            <TableHead className="font-semibold">Lead</TableHead>
            <TableHead className="font-semibold">Closer</TableHead>
            <TableHead className="font-semibold">Status</TableHead>
            <TableHead className="font-semibold">Next Meeting</TableHead>
            <TableHead className="font-semibold">Created</TableHead>
            <TableHead className="text-right font-semibold">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {opportunities.map((opp) => (
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
              <TableCell className="text-sm text-muted-foreground">
                {opp.nextMeetingAt
                  ? formatDate(opp.nextMeetingAt)
                  : opp.latestMeetingAt
                    ? formatDate(opp.latestMeetingAt)
                    : "—"}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
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
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
