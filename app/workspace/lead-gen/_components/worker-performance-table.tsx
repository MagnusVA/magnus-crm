import type { Doc } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
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

type PerformanceRow = {
  workerId: string;
  submissions: number;
  uniqueProspects: number;
  duplicates: number;
  scheduledHours?: number;
  leadsPerHour?: number | null;
};

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

const decimalFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

export function WorkerPerformanceTable({
  rows,
  workers,
}: {
  rows: PerformanceRow[] | undefined;
  workers: Doc<"leadGenWorkers">[] | undefined;
}) {
  const workerById = new Map(
    (workers ?? []).map((worker) => [worker._id, worker]),
  );

  return (
    <Card className="min-w-0" size="sm">
      <CardHeader>
        <CardTitle>Worker Performance</CardTitle>
      </CardHeader>
      <CardContent>
        {rows === undefined ? (
          <Skeleton className="h-[320px] w-full" />
        ) : rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No Worker Activity</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>No aggregate rows match these filters.</EmptyContent>
          </Empty>
        ) : (
          <div className="rounded-lg border">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[38%]">Worker</TableHead>
                  <TableHead className="text-right">Subs</TableHead>
                  <TableHead className="text-right">Unique</TableHead>
                  <TableHead className="text-right">Dupes</TableHead>
                  <TableHead className="text-right">L/Hr</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const worker = workerById.get(
                    row.workerId as Doc<"leadGenWorkers">["_id"],
                  );
                  return (
                    <TableRow key={row.workerId}>
                      <TableCell className="max-w-0">
                        <div className="flex min-w-0 flex-col gap-1">
                          <span className="truncate font-medium">
                            {worker?.displayName ?? worker?.email ?? row.workerId}
                          </span>
                          {worker && !worker.isActive ? (
                            <Badge className="w-fit" variant="outline">
                              Inactive
                            </Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <NumberCell value={row.submissions} />
                      <NumberCell value={row.uniqueProspects} />
                      <NumberCell value={row.duplicates} />
                      <TableCell className="text-right tabular-nums">
                        {row.leadsPerHour == null
                          ? "-"
                          : decimalFormatter.format(row.leadsPerHour)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function NumberCell({ value }: { value: number }) {
  return (
    <TableCell className="text-right tabular-nums">
      {numberFormatter.format(value)}
    </TableCell>
  );
}
