"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { formatCurrency } from "@/lib/format-currency";
import type { Id } from "@/convex/_generated/dataModel";

interface Payment {
  _id: Id<"paymentRecords">;
  amount: number;
  currency: string;
  provider: string;
  status: "recorded" | "verified" | "disputed";
  recordedAt: number;
  referenceCode?: string;
}

const statusConfig = {
  recorded: {
    label: "Recorded",
    className: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/25",
  },
  verified: {
    label: "Verified",
    className: "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/25",
  },
  disputed: {
    label: "Disputed",
    className: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/25",
  },
} as const;

interface PaymentHistoryTableProps {
  payments: Payment[];
}

export function PaymentHistoryTable({ payments }: PaymentHistoryTableProps) {
  if (payments.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4">
        No payments recorded yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Provider</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {payments.map((payment) => {
            const cfg = statusConfig[payment.status];
            return (
              <TableRow key={payment._id}>
                <TableCell className="text-sm">
                  {format(new Date(payment.recordedAt), "MMM d, yyyy")}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {formatCurrency(payment.amount, payment.currency)}
                </TableCell>
                <TableCell className="text-sm">{payment.provider}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {payment.referenceCode ?? "—"}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={cfg.className}>
                    {cfg.label}
                  </Badge>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
