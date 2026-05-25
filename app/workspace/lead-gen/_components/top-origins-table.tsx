import { ExternalLinkIcon } from "lucide-react";
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

type OriginRow = {
  _id?: string;
  originKey: string;
  originKind: "post" | "reel" | string;
  originValue: string;
  source: "instagram" | "meta_business";
  submissions: number;
  uniqueProspectsSubmitted?: number;
};

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

export function TopOriginsTable({ rows }: { rows: OriginRow[] | undefined }) {
  return (
    <Card className="min-w-0" size="sm">
      <CardHeader>
        <CardTitle>Top Posts & Reels</CardTitle>
      </CardHeader>
      <CardContent>
        {rows === undefined ? (
          <Skeleton className="h-[320px] w-full" />
        ) : rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No Rankable Origins</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>Post and reel submissions will rank here.</EmptyContent>
          </Empty>
        ) : (
          <div className="rounded-lg border">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[62%]">Origin</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead className="text-right">Subs</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row._id ?? row.originKey}>
                    <TableCell className="max-w-0">
                      <a
                        className="flex min-w-0 items-center gap-2 truncate text-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        href={row.originValue}
                        rel="noreferrer"
                        target="_blank"
                        title={row.originValue}
                      >
                        <span className="truncate">
                          {formatOriginValue(row.originValue)}
                        </span>
                        <ExternalLinkIcon aria-hidden="true" />
                      </a>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{formatOrigin(row.originKind)}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {numberFormatter.format(row.submissions)}
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

function formatOrigin(originKind: string) {
  return originKind.charAt(0).toUpperCase() + originKind.slice(1);
}

function formatOriginValue(originValue: string) {
  try {
    const url = new URL(originValue);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname}`;
  } catch {
    return originValue;
  }
}
