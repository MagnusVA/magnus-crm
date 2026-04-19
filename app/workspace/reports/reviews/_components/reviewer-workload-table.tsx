"use client";

import { ArrowUpDownIcon, UsersIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { useTableSort, type SortState } from "@/hooks/use-table-sort";
import { formatDurationMs, type ReviewerWorkloadRow } from "./reviews-report-lib";

type ReviewerSortKey = "reviewerName" | "resolved" | "avgLatencyMs";

function getAriaSort(
  columnKey: ReviewerSortKey,
  sort: SortState<ReviewerSortKey>,
): "ascending" | "descending" | "none" {
  if (sort.key !== columnKey || sort.direction === null) {
    return "none";
  }

  return sort.direction === "asc" ? "ascending" : "descending";
}

export function ReviewerWorkloadTable({
  reviewers,
}: {
  reviewers: ReviewerWorkloadRow[];
}) {
  const { sorted, sort, toggle } = useTableSort<
    ReviewerWorkloadRow,
    ReviewerSortKey
  >(reviewers, {
    reviewerName: (left, right) =>
      left.reviewerName.localeCompare(right.reviewerName, undefined, {
        sensitivity: "base",
      }),
    resolved: (left, right) => left.resolved - right.resolved,
    avgLatencyMs: (left, right) =>
      (left.avgLatencyMs ?? -1) - (right.avgLatencyMs ?? -1),
  });

  return (
    <Card className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
      <CardHeader>
        <CardTitle>Reviewer Workload</CardTitle>
        <CardDescription>
          One row per reviewer, with sortable columns for resolved volume and
          average latency.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <Empty className="min-h-[220px] border-border/60 bg-muted/10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UsersIcon />
              </EmptyMedia>
              <EmptyTitle>No reviewer workload to show</EmptyTitle>
              <EmptyDescription>
                Workload appears once reviews have been resolved inside the
                selected date range.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead aria-sort={getAriaSort("reviewerName", sort)}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="-ml-2 h-auto px-2 text-foreground"
                    onClick={() => toggle("reviewerName")}
                  >
                    Reviewer
                    <ArrowUpDownIcon data-icon="inline-end" />
                  </Button>
                </TableHead>
                <TableHead
                  className="text-right"
                  aria-sort={getAriaSort("resolved", sort)}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-auto px-2 text-foreground"
                    onClick={() => toggle("resolved")}
                  >
                    Resolved Count
                    <ArrowUpDownIcon data-icon="inline-end" />
                  </Button>
                </TableHead>
                <TableHead
                  className="text-right"
                  aria-sort={getAriaSort("avgLatencyMs", sort)}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-auto px-2 text-foreground"
                    onClick={() => toggle("avgLatencyMs")}
                  >
                    Avg Resolve Latency
                    <ArrowUpDownIcon data-icon="inline-end" />
                  </Button>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((reviewer) => (
                <TableRow key={reviewer.userId}>
                  <TableCell className="font-medium">
                    {reviewer.reviewerName}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {reviewer.resolved.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatDurationMs(reviewer.avgLatencyMs)}
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
