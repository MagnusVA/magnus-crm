"use client";

import { format } from "date-fns";
import { CheckCircle2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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

function formatStatus(status: string): string {
  return status
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

interface StalePipelineListProps {
  staleCount: number;
  staleOpps: Array<{
    opportunityId: string;
    status: string;
    ageDays: number;
    nextMeetingAt: number | null;
    assignedCloserId: string | null;
    assignedCloserName: string | null;
    leadId: string;
    leadName: string | null;
  }>;
}

export function StalePipelineList({
  staleCount,
  staleOpps,
}: StalePipelineListProps) {
  const isShowingSubset = staleOpps.length < staleCount;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Stale Opportunities ({staleCount.toLocaleString()})
        </CardTitle>
        <CardDescription>
          {isShowingSubset
            ? `Showing the stalest ${staleOpps.length.toLocaleString()} opportunities by age.`
            : "Opportunities with no upcoming meetings or overdue next meetings."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {staleOpps.length === 0 ? (
          <Empty className="border bg-muted/20 py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CheckCircle2Icon className="size-4" />
              </EmptyMedia>
              <EmptyTitle>No stale opportunities</EmptyTitle>
              <EmptyDescription>
                The active pipeline has upcoming meetings scheduled and no
                overdue next steps.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lead</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Closer</TableHead>
                <TableHead className="text-right">Age</TableHead>
                <TableHead className="text-right">Next Meeting</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {staleOpps.map((opp) => (
                <TableRow key={opp.opportunityId}>
                  <TableCell className="font-medium">
                    {opp.leadName || "Unknown"}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {formatStatus(opp.status)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {opp.assignedCloserName || "Unassigned"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {opp.ageDays} days
                  </TableCell>
                  <TableCell className="text-right">
                    {opp.nextMeetingAt !== null
                      ? format(new Date(opp.nextMeetingAt), "MMM d, yyyy")
                      : "None"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
