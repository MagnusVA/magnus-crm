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

export function StalePipelineList({ staleOpps }: StalePipelineListProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Stale Opportunities</CardTitle>
        <CardDescription>
          Opportunities with no upcoming meetings or overdue next meetings
        </CardDescription>
      </CardHeader>
      <CardContent>
        {staleOpps.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-emerald-600 dark:text-emerald-400">
            <CheckCircle2Icon className="h-4 w-4" />
            No stale opportunities found — pipeline is healthy!
          </div>
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
