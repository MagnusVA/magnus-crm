"use client";

import {
  BanknoteIcon,
  CalculatorIcon,
  PhoneCallIcon,
  TargetIcon,
  UserCheckIcon,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { OverviewHelpTooltip } from "@/app/workspace/_components/overview-help-tooltip";
import { formatAmountMinor } from "@/lib/format-currency";

export type SalesCallsStats = {
  totalCalls: number;
  showed: number;
  canceled: number;
  noShows: number;
  showUpRate: number | null;
  cashCollectedMinor: number;
  paymentSalesCount: number;
  closeRate: number | null;
  avgCashPerSaleMinor: number | null;
};

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

const percentFormatter = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});

function formatRateOrDash(value: number | null) {
  return value === null || !Number.isFinite(value)
    ? "—"
    : percentFormatter.format(value);
}

/**
 * Stat cards row for the Phone Sales Ops page: four compact cards plus the
 * wide AVG-cash-collected card from the NIM-20 wireframe. All values come from
 * getSalesCallsDashboard.stats; nulls render as an em-dash.
 */
export function SalesCallsStatCards({
  stats,
}: {
  stats: SalesCallsStats | undefined;
}) {
  const cards = [
    {
      label: "Total Calls",
      description:
        "Meetings scheduled in the selected range, across every status (scheduled, completed, canceled, no-show).",
      value:
        stats === undefined
          ? undefined
          : numberFormatter.format(stats.totalCalls),
      icon: PhoneCallIcon,
    },
    {
      label: "Show-up Rate",
      description:
        "Showed ÷ (total calls − canceled). Shows — when there are no non-canceled calls in the range.",
      value:
        stats === undefined ? undefined : formatRateOrDash(stats.showUpRate),
      icon: UserCheckIcon,
    },
    {
      label: "Cash Collected",
      description:
        "Commissionable final payments recorded in the range — deposits and disputed payments excluded, matching the Revenue report.",
      value:
        stats === undefined
          ? undefined
          : formatAmountMinor(stats.cashCollectedMinor, "USD"),
      icon: BanknoteIcon,
    },
    {
      label: "Close Rate",
      description:
        "Payment sales ÷ showed calls. Shows — when no calls showed in the range.",
      value: stats === undefined ? undefined : formatRateOrDash(stats.closeRate),
      icon: TargetIcon,
    },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="grid min-w-0 grid-cols-2 gap-2 lg:grid-cols-4">
        {cards.map(({ label, description, value, icon: Icon }) => (
          <Card className="min-w-0" key={label} size="sm">
            <CardHeader className="flex flex-row items-center justify-between gap-2 pb-0">
              <CardTitle className="min-w-0 truncate text-xs font-medium text-muted-foreground">
                <OverviewHelpTooltip description={description} label={label}>
                  {label}
                </OverviewHelpTooltip>
              </CardTitle>
              <Icon aria-hidden="true" className="text-muted-foreground" />
            </CardHeader>
            <CardContent className="pt-0">
              {value === undefined ? (
                <Skeleton className="h-7 w-16" />
              ) : (
                <p className="truncate text-2xl font-semibold tracking-normal tabular-nums">
                  {value}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
      <Card className="min-w-0" size="sm">
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-0">
          <CardTitle className="min-w-0 truncate text-xs font-medium text-muted-foreground">
            <OverviewHelpTooltip
              description="Cash collected divided by the number of commissionable final payments in the range. Shows — when there are no payment sales."
              label="AVG Cash Collected"
            >
              AVG Cash Collected
            </OverviewHelpTooltip>
          </CardTitle>
          <CalculatorIcon aria-hidden="true" className="text-muted-foreground" />
        </CardHeader>
        <CardContent className="pt-0">
          {stats === undefined ? (
            <Skeleton className="h-7 w-28" />
          ) : (
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
              <p className="truncate text-2xl font-semibold tracking-normal tabular-nums">
                {stats.avgCashPerSaleMinor === null
                  ? "—"
                  : formatAmountMinor(
                      Math.round(stats.avgCashPerSaleMinor),
                      "USD",
                    )}
              </p>
              <p className="text-xs text-muted-foreground">
                total sales ÷ sales quantity
                {stats.paymentSalesCount > 0 ? (
                  <span className="tabular-nums">
                    {" "}
                    — {formatAmountMinor(stats.cashCollectedMinor, "USD")} ÷{" "}
                    {numberFormatter.format(stats.paymentSalesCount)} payment
                    sale{stats.paymentSalesCount === 1 ? "" : "s"}
                  </span>
                ) : null}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
