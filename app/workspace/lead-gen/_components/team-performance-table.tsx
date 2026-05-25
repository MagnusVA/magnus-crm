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

type TeamRow = {
  teamId?: string | null;
  teamName?: string | null;
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

export function TeamPerformanceTable({
  rows,
}: {
  rows: TeamRow[] | undefined;
}) {
  return (
    <Card className="min-w-0" size="sm">
      <CardHeader>
        <CardTitle>Team Performance</CardTitle>
      </CardHeader>
      <CardContent>
        {rows === undefined ? (
          <Skeleton className="h-[320px] w-full" />
        ) : rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No Team Activity</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>No aggregate rows match these filters.</EmptyContent>
          </Empty>
        ) : (
          <div className="rounded-lg border">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[38%]">Team</TableHead>
                  <TableHead className="text-right">Subs</TableHead>
                  <TableHead className="text-right">Unique</TableHead>
                  <TableHead className="text-right">Dupes</TableHead>
                  <TableHead className="text-right">L/Hr</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.teamId ?? "none"}>
                    <TableCell className="max-w-0 font-medium">
                      <span className="block truncate">
                        {row.teamName ?? "No Team"}
                      </span>
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
                ))}
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
