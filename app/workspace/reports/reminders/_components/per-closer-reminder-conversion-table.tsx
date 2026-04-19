"use client";

import { Badge } from "@/components/ui/badge";
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
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatCount,
  formatPercent,
  type ReminderReportData,
} from "./reminders-report-config";

interface PerCloserReminderConversionTableProps {
  data: ReminderReportData;
}

export function PerCloserReminderConversionTable({
  data,
}: PerCloserReminderConversionTableProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Per-Closer Reminder Conversion</CardTitle>
        <CardDescription>
          Compare reminder volume, completion rate, and reminder-attributed
          payment wins across closers in the current window.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Closer</TableHead>
              <TableHead className="text-right">Created</TableHead>
              <TableHead className="text-right">Completed</TableHead>
              <TableHead className="text-right">Completion %</TableHead>
              <TableHead className="text-right">Payment Received</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.perCloser.map((row) => (
              <TableRow key={row.closerId}>
                <TableCell className="font-medium">{row.closerName}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCount(row.created)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <div className="flex flex-col items-end gap-1">
                    <span>{formatCount(row.completed)}</span>
                    {row.completedWithoutOutcomeCount > 0 ? (
                      <span className="text-xs text-muted-foreground">
                        {formatCount(row.completedWithoutOutcomeCount)} unlabeled
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatPercent(row.completionRate)}
                </TableCell>
                <TableCell className="text-right">
                  <Badge
                    variant={
                      row.paymentReceivedCount > 0 ? "secondary" : "outline"
                    }
                    className="tabular-nums"
                  >
                    {formatCount(row.paymentReceivedCount)}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="font-bold">Team Total</TableCell>
              <TableCell className="text-right font-bold tabular-nums">
                {formatCount(data.totalCreated)}
              </TableCell>
              <TableCell className="text-right font-bold tabular-nums">
                {formatCount(data.totalCompleted)}
              </TableCell>
              <TableCell className="text-right font-bold tabular-nums">
                {formatPercent(data.completionRate)}
              </TableCell>
              <TableCell className="text-right font-bold">
                <Badge variant="secondary" className="tabular-nums">
                  {formatCount(data.outcomeMix.payment_received)}
                </Badge>
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </CardContent>
    </Card>
  );
}
