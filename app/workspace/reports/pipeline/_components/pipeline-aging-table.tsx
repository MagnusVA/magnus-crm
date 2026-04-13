"use client";

import {
  Card,
  CardContent,
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

const ACTIVE_STATUSES = [
  "scheduled",
  "in_progress",
  "follow_up_scheduled",
  "reschedule_link_sent",
] as const;

function formatStatus(status: string): string {
  return status
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

interface PipelineAgingTableProps {
  agingByStatus: Record<
    string,
    {
      averageAgeDays: number | null;
      count: number;
      oldestAgeDays: number | null;
    }
  >;
}

export function PipelineAgingTable({ agingByStatus }: PipelineAgingTableProps) {
  const activeEntries = ACTIVE_STATUSES.filter(
    (status) => agingByStatus[status] !== undefined,
  );

  const hasData = activeEntries.some(
    (status) => agingByStatus[status].count > 0,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pipeline Aging by Status</CardTitle>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No active opportunities to display aging data
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Count</TableHead>
                <TableHead className="text-right">Avg Age (days)</TableHead>
                <TableHead className="text-right">Oldest (days)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activeEntries.map((status) => {
                const entry = agingByStatus[status];
                return (
                  <TableRow key={status}>
                    <TableCell className="font-medium">
                      {formatStatus(status)}
                    </TableCell>
                    <TableCell className="text-right">{entry.count}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {entry.averageAgeDays !== null
                        ? entry.averageAgeDays.toFixed(1)
                        : "\u2014"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {entry.oldestAgeDays !== null
                        ? Math.round(entry.oldestAgeDays)
                        : "\u2014"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
