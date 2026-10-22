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
import { DEAL_STAGE_CONFIG } from "@/convex/opportunities/stages";
import type { OpenPipelineStage } from "@/convex/reporting/pipelineHealth";

// The open stages a closer works. Qualified is computed and left out, as it
// was when the table showed statuses.
const SHOWN_STAGES = [
  "booked",
  "call_held",
  "follow_up",
] as const satisfies ReadonlyArray<OpenPipelineStage>;

interface PipelineAgingTableProps {
  agingByStage: Record<
    OpenPipelineStage,
    {
      averageAgeDays: number | null;
      count: number;
      oldestAgeDays: number | null;
    }
  >;
}

export function PipelineAgingTable({ agingByStage }: PipelineAgingTableProps) {
  const hasData = SHOWN_STAGES.some((stage) => agingByStage[stage].count > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pipeline Aging by Stage</CardTitle>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No open deals to display aging data
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Stage</TableHead>
                <TableHead className="text-right">Count</TableHead>
                <TableHead className="text-right">Avg Age (days)</TableHead>
                <TableHead className="text-right">Oldest (days)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {SHOWN_STAGES.map((stage) => {
                const entry = agingByStage[stage];
                return (
                  <TableRow key={stage}>
                    <TableCell className="font-medium">
                      {DEAL_STAGE_CONFIG[stage].label}
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
