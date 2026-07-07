"use client";

import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MemberIdentity } from "@/app/workspace/_components/member-identity";
import { OverviewHelpTooltip } from "@/app/workspace/_components/overview-help-tooltip";

type SetterRow = FunctionReturnType<
  typeof api.operations.qualificationsDashboard.getQualificationsDashboard
>["openers"][number];

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

const decimalFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

const lastEventFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const tooltips = {
  section:
    "Openers ranked by qualified leads in the selected range. Scheduled openers appear even with zero events.",
  setter: "Slack opener who submitted the accepted qualification events.",
  qualified: "Accepted qualification events for this opener in the range.",
  leadsPerHour:
    "Qualified ÷ scheduled hours in the range. Shows — when no qualifier schedule is configured.",
  lastEvent:
    "When this opener's most recent qualification event in the range was submitted.",
} as const;

function formatLeadsPerHour(value: number | null) {
  return value === null ? "—" : decimalFormatter.format(value);
}

function formatLastEvent(value: number | null) {
  return value === null ? "—" : lastEventFormatter.format(new Date(value));
}

export function SetterContributionsTable({
  rows,
}: {
  rows: SetterRow[] | undefined;
}) {
  return (
    <Card className="min-w-0" size="sm">
      <CardHeader>
        <CardTitle>
          <OverviewHelpTooltip
            description={tooltips.section}
            label="Setter Contributions"
          >
            Setter Contributions
          </OverviewHelpTooltip>
        </CardTitle>
        <CardDescription className="text-xs">
          Qualified leads per opener for the selected range.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows === undefined ? (
          <Skeleton className="h-[280px] w-full" />
        ) : rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No Setter Activity</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              No qualification events or scheduled openers in this range.
            </EmptyContent>
          </Empty>
        ) : (
          <div className="rounded-lg border">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-[45%] font-semibold text-foreground/80">
                    <OverviewHelpTooltip
                      description={tooltips.setter}
                      label="Setter"
                    >
                      Setter
                    </OverviewHelpTooltip>
                  </TableHead>
                  <TableHead className="text-right font-semibold text-foreground/80">
                    <OverviewHelpTooltip
                      description={tooltips.qualified}
                      label="Qualified"
                      triggerClassName="w-full justify-end"
                    >
                      Qualified
                    </OverviewHelpTooltip>
                  </TableHead>
                  <TableHead className="text-right font-semibold text-foreground/80">
                    <OverviewHelpTooltip
                      description={tooltips.leadsPerHour}
                      label="Qualified per hour"
                      triggerClassName="w-full justify-end"
                    >
                      LP/H
                    </OverviewHelpTooltip>
                  </TableHead>
                  <TableHead className="w-[22%] text-right font-semibold text-foreground/80">
                    <OverviewHelpTooltip
                      description={tooltips.lastEvent}
                      label="Last event"
                      triggerClassName="w-full justify-end"
                    >
                      Last event
                    </OverviewHelpTooltip>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.key}>
                    <TableCell className="max-w-0">
                      <MemberIdentity identity={row.avatar} />
                    </TableCell>
                    <TableCell className="text-right text-sm font-semibold tabular-nums">
                      {numberFormatter.format(row.qualified)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatLeadsPerHour(row.qualifiedPerHour)}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                      {formatLastEvent(row.lastEventAt)}
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
