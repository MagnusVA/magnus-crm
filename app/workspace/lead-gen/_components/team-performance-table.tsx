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
    <Card>
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
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Team</TableHead>
                  <TableHead className="text-right">Submissions</TableHead>
                  <TableHead className="text-right">Unique</TableHead>
                  <TableHead className="text-right">Duplicates</TableHead>
                  <TableHead className="text-right">Leads/Hour</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.teamId ?? "none"}>
                    <TableCell className="min-w-48 font-medium">
                      {row.teamName ?? "No Team"}
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
