"use client";

import type { FunctionReturnType } from "convex/server";
import { ArrowRightIcon, GitCompareArrowsIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
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
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatAmountMinor } from "@/lib/format-currency";

type Matrix = FunctionReturnType<
  typeof api.reporting.bookedVsSold.getBookedVsSoldMatrix
>;

export function BookedVsSoldMatrix({ matrix }: { matrix: Matrix }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Booked to Sold Program</CardTitle>
            <CardDescription>
              Payment-program revenue grouped by the originally booked program.
            </CardDescription>
          </div>
          {matrix.truncated ? (
            <Badge variant="destructive">Payment sample capped</Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {matrix.rows.length === 0 ? (
          <Empty className="min-h-56 border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GitCompareArrowsIcon />
              </EmptyMedia>
              <EmptyTitle>No booked-to-sold movement.</EmptyTitle>
              <EmptyDescription>
                Matrix rows appear after payments are recorded in this range.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table className="min-w-[44rem]">
              <TableHeader>
                <TableRow>
                  <TableHead>Booked program</TableHead>
                  <TableHead>Sold program</TableHead>
                  <TableHead className="text-right">Payments</TableHead>
                  <TableHead className="text-right">Payment revenue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {matrix.rows.map((row) => (
                  <TableRow
                    key={`${row.bookingProgramId}:${row.soldProgramId}`}
                  >
                    <TableCell>
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate">
                          {row.bookingProgramName}
                        </span>
                        <ArrowRightIcon
                          className="size-3 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                      </div>
                    </TableCell>
                    <TableCell>{row.soldProgramName}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.paymentCount.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatAmountMinor(row.totalAmountMinor, "USD")}
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
