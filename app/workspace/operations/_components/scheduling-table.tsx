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
import { MemberIdentity } from "@/app/workspace/_components/member-identity";
import type { MemberAvatarIdentity } from "@/app/workspace/_components/member-avatar";

export type SchedulingRow = {
  _id: Id<"operationsQualificationRows">;
  opportunityId?: Id<"opportunities">;
  leadId?: Id<"leads">;
  slackUserId: string;
  firstBookedAt?: number;
  firstMeetingId?: Id<"meetings">;
  firstMeetingAt?: number;
  bookingProgramName?: string;
  bookingProgramMappingStatus?: "mapped" | "unmapped" | "internal" | "not_configured";
  soldProgramName?: string;
  opportunityStatus?: string;
  attributionResolution: "mapped" | "unmapped" | "internal" | "none";
  leadLabel: string;
  slackUserLabel?: string;
  attributionTeamName?: string;
  dmCloserName?: string;
  dmCloser?: MemberAvatarIdentity | null;
  assignedCloserName?: string;
  assignedCloser: MemberAvatarIdentity;
  slackUser: MemberAvatarIdentity;
};

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDate(value?: number) {
  return value ? DATE_FORMATTER.format(new Date(value)) : "-";
}

function formatStatus(value?: string) {
  if (!value) return "Unlinked";
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function attributionLabel(row: SchedulingRow) {
  if (row.attributionResolution === "mapped") {
    return [row.attributionTeamName, row.dmCloserName].filter(Boolean).join(" / ");
  }
  return row.attributionResolution;
}

function SchedulingTableSkeleton() {
  return (
    <div className="rounded-lg border">
      <div className="flex flex-col gap-2 p-4" role="status" aria-label="Loading scheduling rows">
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}

export function SchedulingTable({
  rows,
  isLoading,
}: {
  rows: SchedulingRow[];
  isLoading: boolean;
}) {
  if (isLoading) {
    return <SchedulingTableSkeleton />;
  }

  if (rows.length === 0) {
    return (
      <Empty className="min-h-64">
        <EmptyHeader>
          <EmptyTitle>No scheduled qualifications</EmptyTitle>
          <EmptyDescription>
            Qualified leads appear here once their first meeting is scheduled.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table className="min-w-[1080px]">
        <TableHeader>
          <TableRow>
            <TableHead>Lead</TableHead>
            <TableHead>Scheduled</TableHead>
            <TableHead>Booked</TableHead>
            <TableHead>Qualifier</TableHead>
            <TableHead>Phone Closer</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Booked Program</TableHead>
            <TableHead>Sold Program</TableHead>
            <TableHead>Attribution</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row._id}>
              <TableCell className="max-w-56">
                <span className="truncate font-medium">{row.leadLabel}</span>
              </TableCell>
              <TableCell>{formatDate(row.firstMeetingAt)}</TableCell>
              <TableCell>{formatDate(row.firstBookedAt)}</TableCell>
              <TableCell>
                <MemberIdentity identity={row.slackUser} />
              </TableCell>
              <TableCell>
                <MemberIdentity identity={row.assignedCloser} />
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
                {row.dmCloser ? (
                  <MemberIdentity identity={row.dmCloser} />
                ) : (
                  <Badge
                    variant={
                      row.attributionResolution === "mapped"
                        ? "secondary"
                        : "outline"
                    }
                  >
                    {attributionLabel(row)}
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-right">
                {row.firstMeetingId ? (
                  <Button asChild variant="ghost" size="sm">
                    <Link href={`/workspace/pipeline/meetings/${row.firstMeetingId}`}>
                      Meeting
                      <ArrowUpRightIcon data-icon="inline-end" />
                    </Link>
                  </Button>
                ) : row.opportunityId ? (
                  <Button asChild variant="ghost" size="sm">
                    <Link
                      href={
                        row.leadId
                          ? `/workspace/leads-customers/${row.leadId}?opportunityId=${row.opportunityId}`
                          : `/workspace/opportunities/${row.opportunityId}`
                      }
                    >
                      Opportunity
                      <ArrowUpRightIcon data-icon="inline-end" />
                    </Link>
                  </Button>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
