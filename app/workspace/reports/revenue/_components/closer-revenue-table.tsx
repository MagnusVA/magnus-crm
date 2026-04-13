"use client";

import {
  Card,
  CardContent,
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

interface CloserRevenueTableProps {
  byCloser: Array<{
    closerId: string;
    closerName: string;
    revenueMinor: number;
    dealCount: number;
    avgDealMinor: number | null;
    revenuePercent: number;
  }>;
  totalRevenueMinor: number;
  totalDeals: number;
  avgDealMinor: number | null;
}

function formatCurrency(minor: number): string {
  return `$${(minor / 100).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

export function CloserRevenueTable({
  byCloser,
  totalRevenueMinor,
  totalDeals,
  avgDealMinor,
}: CloserRevenueTableProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue by Closer</CardTitle>
      </CardHeader>
      <CardContent>
        {byCloser.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No closer revenue data for this period
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Closer</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">% of Total</TableHead>
                <TableHead className="text-right">Deals</TableHead>
                <TableHead className="text-right">Avg Deal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byCloser.map((closer) => (
                <TableRow key={closer.closerId}>
                  <TableCell>{closer.closerName}</TableCell>
                  <TableCell className="text-right">
                    {formatCurrency(closer.revenueMinor)}
                  </TableCell>
                  <TableCell className="text-right">
                    {closer.revenuePercent.toFixed(1)}%
                  </TableCell>
                  <TableCell className="text-right">
                    {closer.dealCount}
                  </TableCell>
                  <TableCell className="text-right">
                    {closer.avgDealMinor !== null
                      ? formatCurrency(closer.avgDealMinor)
                      : "\u2014"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="font-bold">Total</TableCell>
                <TableCell className="text-right font-bold">
                  {formatCurrency(totalRevenueMinor)}
                </TableCell>
                <TableCell className="text-right font-bold">100%</TableCell>
                <TableCell className="text-right font-bold">
                  {totalDeals}
                </TableCell>
                <TableCell className="text-right font-bold">
                  {avgDealMinor !== null ? formatCurrency(avgDealMinor) : "\u2014"}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
