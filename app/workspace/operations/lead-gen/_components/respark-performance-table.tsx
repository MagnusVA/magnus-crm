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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { MemberIdentity } from "@/app/workspace/_components/member-identity";

type Report = FunctionReturnType<
  typeof api.leadGen.resparkReports.listResparkPerformance
>;
const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});
const percentFormatter = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});
const columns = [
  "Raw Leads",
  "Resparks",
  "Entries",
  "Not a fit",
  "Not a fit share",
  "Resparked, then booked",
];

export function ResparkPerformanceTable({
  report,
}: {
  report: Report | undefined;
}) {
  return (
    <Card className="min-w-0" size="sm">
      <CardHeader>
        <CardTitle>Respark</CardTitle>
        <CardDescription className="text-xs">
          Entries = Raw Leads + Resparks. Raw Leads follows the source filter;
          resparks cover all sources. Not a fit share is not a fit ÷ (resparks +
          not a fit). Resparked, then booked counts respark credit rows dated in
          this range whose deal has booked, including later bookings.
          {report?.capped
            ? " Showing only the specialists covered by one live read, up to 500 specialists."
            : null}
          {report?.rawLeadsCapped
            ? " Raw Leads and Entries are unavailable: daily stats exceed one live read. Narrow the range."
            : null}
          {report?.bookedCapped
            ? " Resparked, then booked is partial: credit rows or deal details exceed one live read. Narrow the range."
            : null}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {report === undefined ? (
          <Skeleton className="h-[240px] w-full" />
        ) : report.rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No specialists</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lead Gen Specialist</TableHead>
                  {columns.map((column) => (
                    <TableHead key={column} className="text-right">
                      {column}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.rows.map((row) => (
                  <TableRow key={row.workerId}>
                    <TableCell className="min-w-48">
                      <MemberIdentity identity={row.worker} />
                    </TableCell>
                    {[row.rawLeads, row.resparks, row.entries, row.notAFit].map(
                      (value, index) => (
                        <TableCell
                          key={index}
                          className="text-right tabular-nums"
                        >
                          {value === null ? "–" : numberFormatter.format(value)}
                        </TableCell>
                      ),
                    )}
                    <TableCell className="text-right tabular-nums">
                      {row.notAFitShare === null
                        ? "–"
                        : percentFormatter.format(row.notAFitShare)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {numberFormatter.format(row.resparkedThenBooked)}
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
