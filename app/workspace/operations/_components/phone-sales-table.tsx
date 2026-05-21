"use client";

import Link from "next/link";
import { ArrowUpRightIcon } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
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

export type PhoneSalesRow = {
  meetingId: Id<"meetings">;
  opportunityId: Id<"opportunities">;
  leadId: Id<"leads"> | null;
  leadName: string;
  scheduledAt: number;
  meetingStatus: string;
  opportunityStatus: string | null;
  bookingProgramName: string | null;
  bookingProgramMappingStatus: string | null;
  soldProgramName: string | null;
  assignedCloserName: string;
  attributionResolution: "mapped" | "unmapped" | "internal" | "none";
  attributionTeamName: string | null;
  dmCloserName: string | null;
  slackUserId: string | null;
  slackUserLabel: string | null;
};

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDate(value: number) {
  return DATE_FORMATTER.format(new Date(value));
}

function formatStatus(value: string | null) {
  if (!value) return "-";
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function attributionLabel(row: PhoneSalesRow) {
  if (row.attributionResolution === "mapped") {
    return [row.attributionTeamName, row.dmCloserName].filter(Boolean).join(" / ");
  }
  return row.attributionResolution;
}

function PhoneSalesTableSkeleton() {
  return (
    <div className="rounded-lg border">
      <div className="flex flex-col gap-2 p-4" role="status" aria-label="Loading phone sales rows">
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}

export function PhoneSalesTable({
  rows,
  isLoading,
}: {
  rows: PhoneSalesRow[];
  isLoading: boolean;
}) {
  if (isLoading) {
    return <PhoneSalesTableSkeleton />;
  }

  if (rows.length === 0) {
    return (
      <Empty className="min-h-64">
        <EmptyHeader>
          <EmptyTitle>No phone sales meetings</EmptyTitle>
          <EmptyDescription>
            Meetings matching the selected period and primary filter will appear here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table className="min-w-[1160px]">
        <TableHeader>
          <TableRow>
            <TableHead>Lead</TableHead>
            <TableHead>Scheduled</TableHead>
            <TableHead>Phone Closer</TableHead>
            <TableHead>Meeting</TableHead>
            <TableHead>Opportunity</TableHead>
            <TableHead>Booked Program</TableHead>
            <TableHead>Sold Program</TableHead>
            <TableHead>DM Attribution</TableHead>
            <TableHead>Qualifier</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.meetingId}>
              <TableCell className="max-w-56">
                <span className="truncate font-medium">{row.leadName}</span>
              </TableCell>
              <TableCell>{formatDate(row.scheduledAt)}</TableCell>
              <TableCell>{row.assignedCloserName}</TableCell>
              <TableCell>
                <Badge variant="secondary">{formatStatus(row.meetingStatus)}</Badge>
              </TableCell>
              <TableCell>
                <Badge variant={row.opportunityStatus ? "secondary" : "outline"}>
                  {formatStatus(row.opportunityStatus)}
                </Badge>
              </TableCell>
              <TableCell>
                {row.bookingProgramName ?? (
                  <Badge variant="outline">Unmapped</Badge>
                )}
              </TableCell>
              <TableCell>{row.soldProgramName ?? "-"}</TableCell>
              <TableCell>
                <Badge variant={row.attributionResolution === "mapped" ? "secondary" : "outline"}>
                  {attributionLabel(row)}
                </Badge>
              </TableCell>
              <TableCell>{row.slackUserLabel ?? row.slackUserId ?? "-"}</TableCell>
              <TableCell className="text-right">
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/workspace/pipeline/meetings/${row.meetingId}`}>
                    Open
                    <ArrowUpRightIcon data-icon="inline-end" />
                  </Link>
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
