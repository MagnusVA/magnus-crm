"use client";

import Link from "next/link";
import { AlertTriangleIcon, ArrowUpRightIcon } from "lucide-react";
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

export type QualificationRow = {
  _id: Id<"operationsQualificationRows">;
  qualificationEventId: Id<"slackQualificationEvents">;
  opportunityId?: Id<"opportunities">;
  leadId?: Id<"leads">;
  slackUserId: string;
  slackTeamId: string;
  resultKind:
    | "created_opportunity"
    | "duplicate_pending"
    | "already_booked"
    | "unlinked";
  opportunityStatus?: string;
  bookingProgramName?: string;
  soldProgramName?: string;
  qualifiedAt: number;
  firstMeetingAt?: number;
  firstMeetingId?: Id<"meetings">;
  attributionResolution: "mapped" | "unmapped" | "internal" | "none";
  leadLabel: string;
  fullNameSnapshot: string;
  handleSnapshot: string;
  platform: string;
  slackUserLabel?: string;
  attributionTeamName?: string;
  dmCloserName?: string;
  assignedCloserName?: string;
};

type QualificationTableProps = {
  rows: QualificationRow[];
  isLoading: boolean;
  onOpenRepair: (row: QualificationRow) => void;
};

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDate(value?: number) {
  return value ? DATE_FORMATTER.format(new Date(value)) : "-";
}

function formatStatus(value?: string) {
  if (!value) {
    return "Unlinked";
  }
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resultKindLabel(value: QualificationRow["resultKind"]) {
  if (value === "created_opportunity") return "Created";
  if (value === "duplicate_pending") return "Duplicate";
  if (value === "already_booked") return "Already booked";
  return "Unlinked";
}

function attributionLabel(row: QualificationRow) {
  if (row.attributionResolution === "mapped") {
    return [row.attributionTeamName, row.dmCloserName].filter(Boolean).join(" / ");
  }
  return row.attributionResolution;
}

function QualificationTableSkeleton() {
  return (
    <div className="rounded-lg border">
      <div className="flex flex-col gap-2 p-4" role="status" aria-label="Loading qualification rows">
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}

export function QualificationTable({
  rows,
  isLoading,
  onOpenRepair,
}: QualificationTableProps) {
  if (isLoading) {
    return <QualificationTableSkeleton />;
  }

  if (rows.length === 0) {
    return (
      <Empty className="min-h-64">
        <EmptyHeader>
          <EmptyTitle>No qualification rows</EmptyTitle>
          <EmptyDescription>
            Accepted Slack qualifications will appear here once the projection is populated.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table className="min-w-[980px]">
        <TableHeader>
          <TableRow>
            <TableHead>Lead</TableHead>
            <TableHead>Qualified</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Booked Program</TableHead>
            <TableHead>Sold Program</TableHead>
            <TableHead>Scheduled</TableHead>
            <TableHead>Attribution</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row._id}>
              <TableCell className="max-w-56">
                <div className="flex flex-col gap-1">
                  <span className="truncate font-medium">{row.leadLabel}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {row.handleSnapshot ? `${row.handleSnapshot} / ${row.platform}` : row.platform}
                  </span>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-1">
                  <span>{row.slackUserLabel ?? row.slackUserId}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(row.qualifiedAt)}
                  </span>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-1">
                  <Badge variant={row.opportunityStatus ? "secondary" : "outline"}>
                    {formatStatus(row.opportunityStatus)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {resultKindLabel(row.resultKind)}
                  </span>
                </div>
              </TableCell>
              <TableCell>{row.bookingProgramName ?? "Unmapped"}</TableCell>
              <TableCell>{row.soldProgramName ?? "-"}</TableCell>
              <TableCell>{formatDate(row.firstMeetingAt)}</TableCell>
              <TableCell>
                <Badge variant={row.attributionResolution === "mapped" ? "secondary" : "outline"}>
                  {attributionLabel(row) || row.attributionResolution}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                {row.opportunityId ? (
                  <Button asChild variant="ghost" size="sm">
                    <Link href={`/workspace/opportunities/${row.opportunityId}`}>
                      Open
                      <ArrowUpRightIcon data-icon="inline-end" />
                    </Link>
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onOpenRepair(row)}
                  >
                    <AlertTriangleIcon data-icon="inline-start" />
                    Repair
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
