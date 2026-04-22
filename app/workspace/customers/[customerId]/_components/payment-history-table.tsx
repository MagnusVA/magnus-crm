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

// Matches the Phase 5 shape of `getCustomerDetail.payments[N]`.
interface Payment {
  _id: Id<"paymentRecords">;
  amount: number;
  currency: string;
  status: "recorded" | "verified" | "disputed";
  recordedAt: number;
  referenceCode?: string;
  programId?: Id<"tenantPrograms">;
  programName?: string | null;
  paymentType?: "pif" | "split" | "monthly" | "deposit" | null;
  commissionable?: boolean;
  attributedCloserId?: Id<"users">;
  attributedCloserName?: string | null;
  recordedByUserId?: Id<"users">;
  recordedByName?: string | null;
}

const statusConfig = {
  recorded: {
    label: "Recorded",
    className:
      "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/25",
  },
  verified: {
    label: "Verified",
    className:
      "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/25",
  },
  disputed: {
    label: "Disputed",
    className:
      "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/25",
  },
} as const;

const PAYMENT_TYPE_LABELS = {
  pif: "PIF",
  split: "Split",
  monthly: "Monthly",
  deposit: "Deposit",
} as const;

function formatPaymentType(
  paymentType: Payment["paymentType"],
): string {
  if (!paymentType) return "—";
  return PAYMENT_TYPE_LABELS[paymentType] ?? "—";
}

interface PaymentHistoryTableProps {
  payments: Payment[];
}

export function PaymentHistoryTable({ payments }: PaymentHistoryTableProps) {
  if (payments.length === 0) {
    return (
      <p
        className="py-4 text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
      >
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
            <TableHead>Program</TableHead>
            <TableHead>Payment Type</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead>Attribution</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {payments.map((payment) => {
            const statusCfg = statusConfig[payment.status];
            const isCommissionable = payment.commissionable !== false;
            const paymentTypeLabel = formatPaymentType(payment.paymentType);

            return (
              <TableRow key={payment._id}>
                <TableCell className="text-sm">
                  {format(new Date(payment.recordedAt), "MMM d, yyyy")}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {formatCurrency(payment.amount, payment.currency)}
                </TableCell>
                <TableCell className="text-sm">
                  {payment.programName ?? "—"}
                </TableCell>
                <TableCell className="text-sm">{paymentTypeLabel}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {payment.referenceCode ?? "—"}
                </TableCell>
                <TableCell className="text-sm">
                  {isCommissionable ? (
                    <div
                      aria-label={
                        payment.attributedCloserName
                          ? `Commissionable — attributed to ${payment.attributedCloserName}`
                          : "Commissionable"
                      }
                    >
                      <div className="font-medium text-foreground">
                        {payment.attributedCloserName ?? "—"}
                      </div>
                      <Badge
                        variant="outline"
                        className="mt-0.5 bg-muted/40 text-[10px] font-normal text-muted-foreground"
                      >
                        Commissionable
                      </Badge>
                    </div>
                  ) : (
                    <div aria-label="Post-conversion — not attributed to any closer">
                      <div className="italic text-muted-foreground">
                        Post-Conversion
                      </div>
                      <span className="mt-0.5 block text-[10px] text-muted-foreground">
                        Not attributed
                      </span>
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={statusCfg.className}>
                    {statusCfg.label}
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
