"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { InfoIcon } from "lucide-react";
import type { CallMetrics, CloserData, TeamTotals } from "./team-report-types";
import {
  formatCompactCurrency,
  formatRate,
} from "./team-report-formatters";

interface CloserPerformanceTableProps {
  closers: CloserData[];
  callType: "new" | "follow_up";
  teamTotals: TeamTotals;
}

function getCallMetrics(closer: CloserData, callType: "new" | "follow_up"): CallMetrics {
  return callType === "new" ? closer.newCalls : closer.followUpCalls;
}

function getTeamFooterData(
  teamTotals: TeamTotals,
  callType: "new" | "follow_up",
): CallMetrics {
  if (callType === "new") {
    return {
      bookedCalls: teamTotals.newBookedCalls,
      canceledCalls: teamTotals.newCanceled,
      noShows: teamTotals.newNoShows,
      reviewRequiredCalls: teamTotals.newReviewRequired,
      callsShowed: teamTotals.newShowed,
      showUpRate: teamTotals.newShowUpRate,
      confirmedAttendanceDenominator:
        teamTotals.newConfirmedAttendanceDenominator,
    };
  }
  return {
    bookedCalls: teamTotals.followUpBookedCalls,
    canceledCalls: teamTotals.followUpCanceled,
    noShows: teamTotals.followUpNoShows,
    reviewRequiredCalls: teamTotals.followUpReviewRequired,
    callsShowed: teamTotals.followUpShowed,
    showUpRate: teamTotals.followUpShowUpRate,
    confirmedAttendanceDenominator:
      teamTotals.followUpConfirmedAttendanceDenominator,
  };
}

export function CloserPerformanceTable({
  closers,
  callType,
  teamTotals,
}: CloserPerformanceTableProps) {
  if (closers.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No data for this period
      </p>
    );
  }

  const footer = getTeamFooterData(teamTotals, callType);
  const commercialTotals = {
    sales: teamTotals.totalSales,
    cashCollectedMinor: teamTotals.totalRevenueMinor,
    adminLoggedRevenueMinor: teamTotals.totalAdminLoggedRevenueMinor,
    closeRate: teamTotals.overallCloseRate,
    avgDealMinor:
      teamTotals.totalSales > 0
        ? teamTotals.totalRevenueMinor / teamTotals.totalSales
        : null,
  };

  return (
    <Table className="min-w-[76rem]">
      <TableHeader>
        <TableRow>
          <TableHead>Closer</TableHead>
          <TableHead className="text-right">Booked</TableHead>
          <TableHead className="text-right">Canceled</TableHead>
          <TableHead className="text-right">No Shows</TableHead>
          <TableHead
            className="text-right"
            title="Meetings flagged for review and excluded from show-up rate until resolved."
          >
            Review Req.
          </TableHead>
          <TableHead className="text-right">Showed</TableHead>
          <TableHead className="text-right">Show-Up Rate</TableHead>
          <TableHead className="border-l border-border/70 pl-4 text-right">
            Sales
          </TableHead>
          <TableHead className="text-right">Cash Collected</TableHead>
          <TableHead className="text-right">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1">
                  Admin On Behalf
                  <InfoIcon
                    aria-hidden
                    className="size-3 text-muted-foreground"
                  />
                  <span className="sr-only">
                    What does Admin On Behalf mean?
                  </span>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Payments logged by an admin on behalf of this closer (still
                attributed to the closer for commission).
              </TooltipContent>
            </Tooltip>
          </TableHead>
          <TableHead className="text-right">Close Rate</TableHead>
          <TableHead className="text-right">Avg Deal</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {closers.map((closer) => {
          const calls = getCallMetrics(closer, callType);
          return (
            <TableRow key={closer.closerId}>
              <TableCell className="font-medium">{closer.closerName}</TableCell>
              <TableCell className="text-right tabular-nums">
                {calls.bookedCalls}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {calls.canceledCalls}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {calls.noShows}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {calls.reviewRequiredCalls}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {calls.callsShowed}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex flex-col items-end gap-0.5">
                  <span className="tabular-nums">{formatRate(calls.showUpRate)}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {calls.callsShowed} / {calls.confirmedAttendanceDenominator}
                  </span>
                </div>
              </TableCell>
              <TableCell className="border-l border-border/70 pl-4 text-right tabular-nums">
                {closer.sales}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCompactCurrency(closer.cashCollectedMinor)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCompactCurrency(closer.adminLoggedRevenueMinor)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatRate(closer.closeRate)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {closer.avgCashCollectedMinor !== null
                  ? formatCompactCurrency(closer.avgCashCollectedMinor)
                  : "\u2014"}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell className="font-bold">Team Total</TableCell>
          <TableCell className="text-right font-bold tabular-nums">
            {footer.bookedCalls}
          </TableCell>
          <TableCell className="text-right font-bold tabular-nums">
            {footer.canceledCalls}
          </TableCell>
          <TableCell className="text-right font-bold tabular-nums">
            {footer.noShows}
          </TableCell>
          <TableCell className="text-right font-bold tabular-nums">
            {footer.reviewRequiredCalls}
          </TableCell>
          <TableCell className="text-right font-bold tabular-nums">
            {footer.callsShowed}
          </TableCell>
          <TableCell className="text-right font-bold tabular-nums">
            {formatRate(footer.showUpRate)}
          </TableCell>
          <TableCell className="border-l border-border/70 pl-4 text-right font-bold tabular-nums">
            {commercialTotals.sales}
          </TableCell>
          <TableCell className="text-right font-bold tabular-nums">
            {formatCompactCurrency(commercialTotals.cashCollectedMinor)}
          </TableCell>
          <TableCell className="text-right font-bold tabular-nums">
            {formatCompactCurrency(commercialTotals.adminLoggedRevenueMinor)}
          </TableCell>
          <TableCell className="text-right font-bold tabular-nums">
            {formatRate(commercialTotals.closeRate)}
          </TableCell>
          <TableCell className="text-right font-bold tabular-nums">
            {commercialTotals.avgDealMinor !== null
              ? formatCompactCurrency(commercialTotals.avgDealMinor)
              : "\u2014"}
          </TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  );
}
