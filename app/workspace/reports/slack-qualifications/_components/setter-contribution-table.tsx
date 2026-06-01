"use client";

import type { FunctionReturnType } from "convex/server";
import { UsersIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MemberIdentity } from "@/app/workspace/_components/member-identity";

type Report = FunctionReturnType<
  typeof api.reporting.slackQualifications.getQualificationReport
>;
export type SetterContributionRow = Report["users"][number];

type SetterContributionTableProps = {
  rows: SetterContributionRow[];
};

export function SetterContributionTable({
  rows,
}: SetterContributionTableProps) {
  if (rows.length === 0) {
    return (
      <Empty className="min-h-56 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UsersIcon />
          </EmptyMedia>
          <EmptyTitle>No Slack setters found.</EmptyTitle>
          <EmptyDescription>
            Setters appear here after they submit or sync from Slack.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <Table className="min-w-[56rem]">
        <TableHeader>
          <TableRow>
            <TableHead>Setter</TableHead>
            <TableHead className="text-right">Events</TableHead>
            <TableHead className="text-right">Unique opps</TableHead>
            <TableHead className="text-right">Created</TableHead>
            <TableHead className="text-right">Duplicate / booked</TableHead>
            <TableHead className="text-right">Share</TableHead>
            <TableHead className="text-right">Last event</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.slackUserId}>
              <TableCell>
                <MemberIdentity
                  identity={row.setter}
                  badge={
                    row.isDeleted ? (
                      <Badge variant="muted">Deactivated</Badge>
                    ) : null
                  }
                />
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">
                {row.qualificationEventCount.toLocaleString()}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.uniqueSlackOpportunityCount.toLocaleString()}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.createdOpportunityEvents.toLocaleString()}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {(
                  row.duplicatePendingEvents + row.alreadyBookedEvents
                ).toLocaleString()}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatPercent(row.contributionShare)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatTimestamp(row.lastQualifiedAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function formatPercent(value: number | null): string {
  return value === null
    ? "-"
    : `${(value * 100).toLocaleString(undefined, {
        maximumFractionDigits: 1,
      })}%`;
}

function formatTimestamp(value: number | null): string {
  if (value === null) {
    return "-";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
