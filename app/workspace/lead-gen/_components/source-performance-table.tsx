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

type SourceRow = {
  source: "instagram" | "meta_business";
  submissions: number;
  uniqueProspects: number;
  duplicates: number;
};

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

export function SourcePerformanceTable({
  rows,
}: {
  rows: SourceRow[] | undefined;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Source Split</CardTitle>
      </CardHeader>
      <CardContent>
        {rows === undefined ? (
          <Skeleton className="h-[320px] w-full" />
        ) : rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No Source Activity</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>No aggregate rows match these filters.</EmptyContent>
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Submissions</TableHead>
                  <TableHead className="text-right">Unique</TableHead>
                  <TableHead className="text-right">Duplicates</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.source}>
                    <TableCell>
                      <Badge variant="secondary">
                        {row.source === "meta_business"
                          ? "Meta Business"
                          : "Instagram"}
                      </Badge>
                    </TableCell>
                    <NumberCell value={row.submissions} />
                    <NumberCell value={row.uniqueProspects} />
                    <NumberCell value={row.duplicates} />
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
