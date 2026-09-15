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
import { OverviewHelpTooltip } from "@/app/workspace/_components/overview-help-tooltip";
import { TopOriginsOverviewTable } from "@/app/workspace/_components/top-origins-overview-table";
import type { LeadDashboardOriginTeam } from "@/lib/operations-reports/lead-dashboard";

export function TopOriginsTable({
  groups,
}: {
  groups: LeadDashboardOriginTeam[] | undefined;
}) {
  return (
    <Card className="min-w-0" size="sm">
      <CardHeader>
        <CardTitle>
          <OverviewHelpTooltip
            description="Top posts and reels ranked by submissions within each team. Counts use the team assigned when the submission was captured."
            label="Top Posts & Reels"
          >
            Top Posts & Reels
          </OverviewHelpTooltip>
        </CardTitle>
        <CardDescription className="text-xs">
          Top 10 per team, ranked by submissions for the selected range.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {groups === undefined ? (
          <Skeleton
            className="h-[320px] w-full"
            role="status"
            aria-label="Loading top posts and reels by team"
          />
        ) : groups.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No Rankable Origins</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              Post and reel submissions will rank here.
            </EmptyContent>
          </Empty>
        ) : (
          <div className="flex flex-col gap-4">
            {groups.map((group) => (
              <section
                key={group.teamId ?? "unassigned"}
                aria-label={`${group.teamName} top posts and reels`}
                className="flex min-w-0 flex-col gap-2"
              >
                <h3 className="rounded-md bg-muted/40 px-2 py-2 text-sm font-semibold">
                  {group.teamName}
                </h3>
                <TopOriginsOverviewTable rows={group.origins} />
              </section>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
