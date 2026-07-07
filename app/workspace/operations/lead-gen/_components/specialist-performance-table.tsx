import { Fragment } from "react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
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

type SpecialistRow = FunctionReturnType<
  typeof api.leadGen.reporting.listWorkerPerformance
>[number];

type TeamOption = {
  _id: Id<"attributionTeams">;
  name: string;
};

type TeamGroup = {
  key: string;
  teamName: string;
  rows: SpecialistRow[];
  submissions: number;
  scheduledHours: number;
};

const NO_TEAM_KEY = "no-team";

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

const decimalFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

const tooltips = {
  section:
    "Lead gen specialists grouped by team for the selected range. Team rows subtotal their members; the Total row aggregates every specialist.",
  subs: "Raw lead form submissions in the range, including duplicate prospects.",
  leadsPerHour:
    "Submissions divided by scheduled hours in the range. Shows — when no schedule is configured.",
  total:
    "All specialists combined: total submissions, and total submissions divided by total scheduled hours.",
} as const;

function formatLeadsPerHour(value: number | null) {
  return value == null ? "—" : decimalFormatter.format(value);
}

function leadsPerHour(submissions: number, scheduledHours: number) {
  return scheduledHours > 0 ? submissions / scheduledHours : null;
}

function groupRowsByTeam(
  rows: SpecialistRow[],
  teams: TeamOption[] | undefined,
): TeamGroup[] {
  const teamNameById = new Map(
    (teams ?? []).map((team) => [team._id, team.name]),
  );
  const groups = new Map<string, TeamGroup>();

  for (const row of rows) {
    const key = row.teamId ?? NO_TEAM_KEY;
    const group =
      groups.get(key) ??
      {
        key,
        teamName: row.teamId
          ? (teamNameById.get(row.teamId) ?? "Unknown team")
          : "No team",
        rows: [],
        submissions: 0,
        scheduledHours: 0,
      };

    group.rows.push(row);
    group.submissions += row.submissions;
    group.scheduledHours += row.scheduledHours;
    groups.set(key, group);
  }

  return [...groups.values()].sort((a, b) => {
    if (a.key === NO_TEAM_KEY) return 1;
    if (b.key === NO_TEAM_KEY) return -1;
    if (a.submissions !== b.submissions) return b.submissions - a.submissions;
    return a.teamName.localeCompare(b.teamName);
  });
}

export function SpecialistPerformanceTable({
  rows,
  teams,
}: {
  rows: SpecialistRow[] | undefined;
  teams: TeamOption[] | undefined;
}) {
  const groups = rows === undefined ? [] : groupRowsByTeam(rows, teams);
  const totalSubmissions = groups.reduce(
    (sum, group) => sum + group.submissions,
    0,
  );
  const totalScheduledHours = groups.reduce(
    (sum, group) => sum + group.scheduledHours,
    0,
  );

  return (
    <Card className="min-w-0" size="sm">
      <CardHeader>
        <CardTitle>
          <OverviewHelpTooltip
            description={tooltips.section}
            label="Specialist Performance"
          >
            Specialist Performance
          </OverviewHelpTooltip>
        </CardTitle>
        <CardDescription className="text-xs">
          Lead gen specialists grouped by team for the selected range.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows === undefined ? (
          <Skeleton className="h-[320px] w-full" />
        ) : rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No Specialist Activity</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              No lead gen specialist activity matches these filters.
            </EmptyContent>
          </Empty>
        ) : (
          <div className="rounded-lg border">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-[55%] font-semibold text-foreground/80">
                    Lead Gen Specialist
                  </TableHead>
                  <TableHead className="text-right font-semibold text-foreground/80">
                    <OverviewHelpTooltip
                      description={tooltips.subs}
                      label="Subs"
                      triggerClassName="w-full justify-end"
                    >
                      Subs
                    </OverviewHelpTooltip>
                  </TableHead>
                  <TableHead className="text-right font-semibold text-foreground/80">
                    <OverviewHelpTooltip
                      description={tooltips.leadsPerHour}
                      label="Leads per hour"
                      triggerClassName="w-full justify-end"
                    >
                      L/Hr
                    </OverviewHelpTooltip>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((group) => (
                  <Fragment key={group.key}>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableCell className="max-w-0">
                        <span className="flex min-w-0 items-baseline gap-1.5">
                          <span className="truncate text-sm font-semibold">
                            {group.teamName}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {group.rows.length} specialist
                            {group.rows.length === 1 ? "" : "s"}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">
                        {numberFormatter.format(group.submissions)}
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">
                        {formatLeadsPerHour(
                          leadsPerHour(group.submissions, group.scheduledHours),
                        )}
                      </TableCell>
                    </TableRow>
                    {group.rows.map((row) => (
                      <TableRow key={row.workerId}>
                        <TableCell className="max-w-0 pl-4">
                          <MemberIdentity
                            badge={
                              !row.isActive ? (
                                <Badge className="w-fit" variant="outline">
                                  Inactive
                                </Badge>
                              ) : null
                            }
                            identity={row.worker}
                          />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {numberFormatter.format(row.submissions)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatLeadsPerHour(row.leadsPerHour)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </Fragment>
                ))}
                <TableRow className="border-t-2 bg-muted/60 hover:bg-muted/60">
                  <TableCell className="max-w-0">
                    <OverviewHelpTooltip
                      description={tooltips.total}
                      label="Total"
                    >
                      <span className="text-sm font-semibold">Total</span>
                    </OverviewHelpTooltip>
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {numberFormatter.format(totalSubmissions)}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {formatLeadsPerHour(
                      leadsPerHour(totalSubmissions, totalScheduledHours),
                    )}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
