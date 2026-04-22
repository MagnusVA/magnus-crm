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

type PaymentTypeLiteral = "pif" | "split" | "monthly" | "deposit";

const PAYMENT_TYPE_LABELS: Record<PaymentTypeLiteral, string> = {
  pif: "PIF",
  split: "Split",
  monthly: "Monthly",
  deposit: "Deposit",
};

interface TopDealsTableProps {
  deals: Array<{
    paymentRecordId: string;
    amountMinor: number;
    attributedCloserName: string;
    recordedAt: number;
    contextType: string;
    programId?: string | null;
    programName?: string | null;
    paymentType?: string | null;
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

function formatPaymentType(paymentType: string | null | undefined): string {
  if (!paymentType) return "\u2014";
  return (
    PAYMENT_TYPE_LABELS[paymentType as PaymentTypeLiteral] ??
    paymentType.charAt(0).toUpperCase() + paymentType.slice(1)
  );
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
                <TableHead>Program</TableHead>
                <TableHead>Payment Type</TableHead>
                <TableHead>Closer</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deals.map((deal, index) => (
                <TableRow key={deal.paymentRecordId}>
                  <TableCell>{index + 1}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(deal.amountMinor)}
                  </TableCell>
                  <TableCell>{deal.programName ?? "\u2014"}</TableCell>
                  <TableCell>{formatPaymentType(deal.paymentType)}</TableCell>
                  <TableCell>{deal.attributedCloserName}</TableCell>
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
