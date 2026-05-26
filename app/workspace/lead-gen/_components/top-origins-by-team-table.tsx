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

type TopOriginsByTeamRow = {
  teamId?: string | null;
  teamName: string;
  isActive?: boolean | null;
  totalUniqueProspects: number;
  totalSubmissions: number;
  origins: Array<{
    originKey: string;
    source: "instagram" | "meta_business";
    originKind: "post" | "reel";
    originValue: string;
    uniqueProspects: number;
    submissions: number;
    dayCount?: number;
  }>;
};

type OriginRow = TopOriginsByTeamRow["origins"][number];

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

export function TopOriginsByTeamTable({
  rows,
}: {
  rows: TopOriginsByTeamRow[] | undefined;
}) {
  return (
    <Card className="min-w-0" size="sm">
      <CardHeader>
        <CardTitle>Top Posts by Team</CardTitle>
      </CardHeader>
      <CardContent>
        {rows === undefined ? (
          <Skeleton className="h-[360px] w-full" />
        ) : rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No Rankable Posts</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              No rankable posts or reels match these filters.
            </EmptyContent>
          </Empty>
        ) : (
          <div className="rounded-lg border">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[22%]">Team</TableHead>
                  <TableHead className="w-[34%]">#1 Post/Reel</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                  <TableHead className="text-right">Subs</TableHead>
                  <TableHead className="w-[28%]">Other top posts</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const topOrigin = row.origins[0];
                  return (
                    <TableRow key={row.teamId ?? "unassigned"}>
                      <TableCell className="max-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-medium">
                            {row.teamName || "Unassigned"}
                          </span>
                          {row.isActive === false ? (
                            <Badge variant="secondary">Inactive</Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-0">
                        {topOrigin ? (
                          <OriginLink origin={topOrigin} />
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <NumberCell value={topOrigin?.uniqueProspects ?? 0} />
                      <NumberCell value={topOrigin?.submissions ?? 0} />
                      <TableCell className="max-w-0">
                        <OtherOrigins origins={row.origins.slice(1, 3)} />
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

function OriginLink({ origin }: { origin: OriginRow }) {
  return (
    <a
      className="flex min-w-0 items-center gap-2 truncate text-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      href={origin.originValue}
      rel="noreferrer"
      target="_blank"
      title={origin.originValue}
    >
      <Badge className="shrink-0" variant="outline">
        {formatOrigin(origin.originKind)}
      </Badge>
      <span className="truncate">{formatOriginValue(origin.originValue)}</span>
      <ExternalLinkIcon aria-hidden="true" className="shrink-0" />
    </a>
  );
}

function OtherOrigins({ origins }: { origins: OriginRow[] }) {
  if (origins.length === 0) {
    return <span className="text-muted-foreground">-</span>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {origins.map((origin) => (
        <a
          className="flex min-w-0 items-center justify-between gap-2 text-xs underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          href={origin.originValue}
          key={`${origin.source}:${origin.originKey}`}
          rel="noreferrer"
          target="_blank"
          title={origin.originValue}
        >
          <span className="min-w-0 truncate">
            {formatOriginValue(origin.originValue)}
          </span>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {numberFormatter.format(origin.uniqueProspects)}
          </span>
        </a>
      ))}
    </div>
  );
}

function NumberCell({ value }: { value: number }) {
  return (
    <TableCell className="text-right tabular-nums">
      {numberFormatter.format(value)}
    </TableCell>
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
