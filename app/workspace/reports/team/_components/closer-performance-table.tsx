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

interface CallMetrics {
  bookedCalls: number;
  canceledCalls: number;
  noShows: number;
  callsShowed: number;
  showUpRate: number | null;
}

interface CloserData {
  closerId: string;
  closerName: string;
  newCalls: CallMetrics;
  followUpCalls: CallMetrics;
  sales: number;
  cashCollectedMinor: number;
  closeRate: number | null;
  avgCashCollectedMinor: number | null;
}

interface TeamTotals {
  newBookedCalls: number;
  newCanceled: number;
  newNoShows: number;
  newShowed: number;
  followUpBookedCalls: number;
  followUpCanceled: number;
  followUpNoShows: number;
  followUpShowed: number;
  totalSales: number;
  totalRevenue: number;
  totalRevenueMinor: number;
  newShowUpRate: number | null;
  followUpShowUpRate: number | null;
  overallShowUpRate: number | null;
  overallCloseRate: number | null;
  avgCashCollectedMinor: number | null;
  excludedRevenueMinor: number;
  excludedSales: number;
}

interface CloserPerformanceTableProps {
  closers: CloserData[];
  callType: "new" | "follow_up";
  teamTotals: TeamTotals;
}

function formatRate(rate: number | null): string {
  if (rate === null) return "\u2014";
  return `${(rate * 100).toFixed(1)}%`;
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
      callsShowed: teamTotals.newShowed,
      showUpRate: teamTotals.newShowUpRate,
    };
  }
  return {
    bookedCalls: teamTotals.followUpBookedCalls,
    canceledCalls: teamTotals.followUpCanceled,
    noShows: teamTotals.followUpNoShows,
    callsShowed: teamTotals.followUpShowed,
    showUpRate: teamTotals.followUpShowUpRate,
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

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Closer</TableHead>
          <TableHead className="text-right">Booked</TableHead>
          <TableHead className="text-right">Canceled</TableHead>
          <TableHead className="text-right">No Shows</TableHead>
          <TableHead className="text-right">Showed</TableHead>
          <TableHead className="text-right">Show-Up Rate</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {closers.map((closer) => {
          const calls = getCallMetrics(closer, callType);
          return (
            <TableRow key={closer.closerId}>
              <TableCell>{closer.closerName}</TableCell>
              <TableCell className="text-right">{calls.bookedCalls}</TableCell>
              <TableCell className="text-right">
                {calls.canceledCalls}
              </TableCell>
              <TableCell className="text-right">{calls.noShows}</TableCell>
              <TableCell className="text-right">{calls.callsShowed}</TableCell>
              <TableCell className="text-right">
                {formatRate(calls.showUpRate)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell className="font-bold">Team Total</TableCell>
          <TableCell className="text-right font-bold">
            {footer.bookedCalls}
          </TableCell>
          <TableCell className="text-right font-bold">
            {footer.canceledCalls}
          </TableCell>
          <TableCell className="text-right font-bold">
            {footer.noShows}
          </TableCell>
          <TableCell className="text-right font-bold">
            {footer.callsShowed}
          </TableCell>
          <TableCell className="text-right font-bold">
            {formatRate(footer.showUpRate)}
          </TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  );
}
