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
import { formatAmountMinor } from "@/lib/format-currency";

type DmCloserRow = FunctionReturnType<
  typeof api.operations.bookedCallsDashboard.getBookedCallsDashboard
>["dmClosers"][number];

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

const decimalFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

const tooltips = {
  section:
    "DM closers ranked by booked calls in the selected range. Scheduled closers appear even with zero bookings.",
  dmCloser: "DM closer the booking is attributed to via Calendly UTM values.",
  team: "DM team this closer belongs to in the attribution registry.",
  booked: "New-classification meetings booked by this DM closer in the range.",
  leadsPerHour:
    "Booked ÷ scheduled hours. Shows — when no DM closer schedule is configured for the range.",
  rate: "Hourly contract rate. Edit it in Configuration.",
} as const;

function formatBookedPerHour(value: number | null) {
  return value === null ? "—" : decimalFormatter.format(value);
}

function formatHourlyRate(value: number | null) {
  return value === null ? "—" : `${formatAmountMinor(value, "USD")}/hr`;
}

export function DmCloserContributionsTable({
  rows,
}: {
  rows: DmCloserRow[] | undefined;
}) {
  return (
    <Card className="min-w-0" size="sm">
      <CardHeader>
        <CardTitle>
          <OverviewHelpTooltip
            description={tooltips.section}
            label="DM Closer Contributions"
          >
            DM Closer Contributions
          </OverviewHelpTooltip>
        </CardTitle>
        <CardDescription className="text-xs">
          Booked calls per DM closer for the selected range.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows === undefined ? (
          <Skeleton className="h-[280px] w-full" />
        ) : rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No DM Closer Activity</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              No booked calls or scheduled DM closers in this range.
            </EmptyContent>
          </Empty>
        ) : (
          <div className="rounded-lg border">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-[34%] font-semibold text-foreground/80">
                    <OverviewHelpTooltip
                      description={tooltips.dmCloser}
                      label="DM Closer"
                    >
                      DM Closer
                    </OverviewHelpTooltip>
                  </TableHead>
                  <TableHead className="w-[20%] font-semibold text-foreground/80">
                    <OverviewHelpTooltip description={tooltips.team} label="Team">
                      Team
                    </OverviewHelpTooltip>
                  </TableHead>
                  <TableHead className="text-right font-semibold text-foreground/80">
                    <OverviewHelpTooltip
                      description={tooltips.booked}
                      label="Booked"
                      triggerClassName="w-full justify-end"
                    >
                      Booked
                    </OverviewHelpTooltip>
                  </TableHead>
                  <TableHead className="text-right font-semibold text-foreground/80">
                    <OverviewHelpTooltip
                      description={tooltips.leadsPerHour}
                      label="Booked per hour"
                      triggerClassName="w-full justify-end"
                    >
                      LP/H
                    </OverviewHelpTooltip>
                  </TableHead>
                  <TableHead className="w-[18%] text-right font-semibold text-foreground/80">
                    <OverviewHelpTooltip
                      description={tooltips.rate}
                      label="Hourly contract rate"
                      triggerClassName="w-full justify-end"
                    >
                      Rate
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
                    <TableCell className="max-w-0 truncate text-xs text-muted-foreground">
                      {row.teamLabel ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-sm font-semibold tabular-nums">
                      {numberFormatter.format(row.booked)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatBookedPerHour(row.bookedPerHour)}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                      {formatHourlyRate(row.hourlyRateMinor)}
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
