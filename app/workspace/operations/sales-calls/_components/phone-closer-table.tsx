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
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MemberIdentity } from "@/app/workspace/_components/member-identity";
import { OverviewHelpTooltip } from "@/app/workspace/_components/overview-help-tooltip";
import { formatAmountMinor } from "@/lib/format-currency";

type SalesCallsDashboard = FunctionReturnType<
  typeof api.operations.salesCallsDashboard.getSalesCallsDashboard
>;
type CloserRow = SalesCallsDashboard["closers"][number];
type TeamTotal = SalesCallsDashboard["teamTotal"];

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

const percentFormatter = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});

function formatCount(value: number) {
  return numberFormatter.format(value);
}

function formatRate(value: number | null) {
  return value === null || !Number.isFinite(value)
    ? "—"
    : percentFormatter.format(value);
}

function formatMoney(value: number) {
  return formatAmountMinor(Math.round(value), "USD");
}

function formatMoneyOrDash(value: number | null) {
  return value === null ? "—" : formatMoney(value);
}

const tooltips = {
  section:
    "Phone closers ranked by payment revenue in the selected range. Active closers appear even with zero calls; removed closers keep their history.",
  closer: "CRM user assigned to take the sales call.",
  booked: "Meetings scheduled for this closer in the range, across every status.",
  canceled: "Meetings marked canceled for this closer in the range.",
  noShows: "Meetings marked no-show for this closer in the range.",
  showed: "Meetings marked completed for this closer in the range.",
  showUpRate: "Showed ÷ (booked − canceled). Shows — with no non-canceled calls.",
  paymentSales:
    "Commissionable final payments attributed to this closer in the range.",
  paymentRevenue: "Sum of those payments' amounts.",
  paymentCloseRate: "Payment sales ÷ showed. Shows — with no showed calls.",
  avgPaymentDeal:
    "Payment revenue ÷ payment sales. Shows — with no payment sales.",
  teamTotal:
    "Sums of the closer rows above, with rates recomputed from the sums. Payments not attributed to any closer are excluded here, so the Cash Collected card can exceed this revenue total.",
} as const;

const NUMERIC_COLUMNS: Array<{
  key: string;
  label: string;
  tooltip: string;
  render: (totals: CloserRow | TeamTotal) => string;
  emphasized?: boolean;
}> = [
  {
    key: "booked",
    label: "Booked",
    tooltip: tooltips.booked,
    render: (t) => formatCount(t.booked),
  },
  {
    key: "canceled",
    label: "Canceled",
    tooltip: tooltips.canceled,
    render: (t) => formatCount(t.canceled),
  },
  {
    key: "noShows",
    label: "No Shows",
    tooltip: tooltips.noShows,
    render: (t) => formatCount(t.noShows),
  },
  {
    key: "showed",
    label: "Showed",
    tooltip: tooltips.showed,
    render: (t) => formatCount(t.showed),
  },
  {
    key: "showUpRate",
    label: "Show-Up Rate",
    tooltip: tooltips.showUpRate,
    render: (t) => formatRate(t.showUpRate),
  },
  {
    key: "paymentSales",
    label: "Payment Sales",
    tooltip: tooltips.paymentSales,
    render: (t) => formatCount(t.paymentSales),
  },
  {
    key: "paymentRevenueMinor",
    label: "Payment Revenue",
    tooltip: tooltips.paymentRevenue,
    render: (t) => formatMoney(t.paymentRevenueMinor),
    emphasized: true,
  },
  {
    key: "paymentCloseRate",
    label: "Payment Close Rate",
    tooltip: tooltips.paymentCloseRate,
    render: (t) => formatRate(t.paymentCloseRate),
  },
  {
    key: "avgPaymentDealMinor",
    label: "Avg Payment Deal",
    tooltip: tooltips.avgPaymentDeal,
    render: (t) => formatMoneyOrDash(t.avgPaymentDealMinor),
  },
];

/**
 * Phone-closer performance table for the Phone Sales Ops page, with an
 * emphasized Team Total footer row computed server-side from the closer rows.
 */
export function PhoneCloserTable({
  rows,
  teamTotal,
}: {
  rows: CloserRow[] | undefined;
  teamTotal: TeamTotal | undefined;
}) {
  return (
    <Card className="min-w-0" size="sm">
      <CardHeader>
        <CardTitle>
          <OverviewHelpTooltip
            description={tooltips.section}
            label="Phone Closers"
          >
            Phone Closers
          </OverviewHelpTooltip>
        </CardTitle>
        <CardDescription className="text-xs">
          Call outcomes and payment performance per phone closer for the
          selected range.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows === undefined || teamTotal === undefined ? (
          <Skeleton className="h-[280px] w-full" />
        ) : rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No Phone Closer Activity</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              No sales calls, payments, or active closers in this range.
            </EmptyContent>
          </Empty>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table className="min-w-[1080px]">
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="min-w-52 font-semibold text-foreground/80">
                    <OverviewHelpTooltip
                      description={tooltips.closer}
                      label="Phone Closer"
                    >
                      Phone Closer
                    </OverviewHelpTooltip>
                  </TableHead>
                  {NUMERIC_COLUMNS.map((column) => (
                    <TableHead
                      key={column.key}
                      className="text-right font-semibold text-foreground/80"
                    >
                      <OverviewHelpTooltip
                        description={column.tooltip}
                        label={column.label}
                        triggerClassName="w-full justify-end"
                      >
                        {column.label}
                      </OverviewHelpTooltip>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.closerId}>
                    <TableCell>
                      <MemberIdentity identity={row.avatar} />
                    </TableCell>
                    {NUMERIC_COLUMNS.map((column) => (
                      <TableCell
                        key={column.key}
                        className={
                          column.emphasized
                            ? "text-right text-sm font-semibold tabular-nums"
                            : "text-right text-sm tabular-nums"
                        }
                      >
                        {column.render(row)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow className="border-t-2 bg-muted/60 font-semibold hover:bg-muted/60">
                  <TableCell>
                    <OverviewHelpTooltip
                      description={tooltips.teamTotal}
                      label="Team Total"
                    >
                      <span className="text-sm font-semibold">Team Total</span>
                    </OverviewHelpTooltip>
                  </TableCell>
                  {NUMERIC_COLUMNS.map((column) => (
                    <TableCell
                      key={column.key}
                      className="text-right text-sm font-semibold tabular-nums"
                    >
                      {column.render(teamTotal)}
                    </TableCell>
                  ))}
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
