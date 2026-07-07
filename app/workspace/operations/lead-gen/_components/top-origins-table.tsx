import {
  Card,
  CardContent,
  CardDescription,
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
  OverviewHelpTooltip,
  overviewTooltips,
} from "@/app/workspace/_components/overview-help-tooltip";
import {
  TopOriginsOverviewTable,
  type TopOriginOverviewRow,
} from "@/app/workspace/_components/top-origins-overview-table";

export function TopOriginsTable({
  rows,
}: {
  rows: TopOriginOverviewRow[] | undefined;
}) {
  return (
    <Card className="min-w-0" size="sm">
      <CardHeader>
        <CardTitle>
          <OverviewHelpTooltip
            description={overviewTooltips.topOrigins.section}
            label="Top Posts & Reels"
          >
            Top Posts & Reels
          </OverviewHelpTooltip>
        </CardTitle>
        <CardDescription className="text-xs">
          Ranked by submissions for the selected range.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows === undefined ? (
          <Skeleton className="h-[320px] w-full" />
        ) : rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No Rankable Origins</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              Post and reel submissions will rank here.
            </EmptyContent>
          </Empty>
        ) : (
          <TopOriginsOverviewTable rows={rows} />
        )}
      </CardContent>
    </Card>
  );
}
