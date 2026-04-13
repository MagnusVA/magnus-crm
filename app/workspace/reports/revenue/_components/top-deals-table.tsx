"use client";

import { format } from "date-fns";
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
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface TopDealsTableProps {
  deals: Array<{
    paymentRecordId: string;
    amountMinor: number;
    closerName: string;
    recordedAt: number;
    contextType: string;
  }>;
}

function formatCurrency(minor: number): string {
  return `$${(minor / 100).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

function formatSource(contextType: string): string {
  if (!contextType) return "\u2014";
  return contextType.charAt(0).toUpperCase() + contextType.slice(1);
}

export function TopDealsTable({ deals }: TopDealsTableProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top 10 Deals</CardTitle>
      </CardHeader>
      <CardContent>
        {deals.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No deals recorded in this period
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Closer</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deals.map((deal, index) => (
                <TableRow key={deal.paymentRecordId}>
                  <TableCell>{index + 1}</TableCell>
                  <TableCell className="text-right">
                    {formatCurrency(deal.amountMinor)}
                  </TableCell>
                  <TableCell>{deal.closerName}</TableCell>
                  <TableCell>
                    {format(deal.recordedAt, "MMM d, yyyy")}
                  </TableCell>
                  <TableCell>{formatSource(deal.contextType)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
