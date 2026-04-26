import {
  CreditCardIcon,
  ReceiptTextIcon,
} from "lucide-react";
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
import type { Id } from "@/convex/_generated/dataModel";
import { formatAmountMinor } from "@/lib/format-currency";

type Payment = {
  _id: Id<"paymentRecords">;
  amountMinor: number;
  currency: string;
  programName: string;
  paymentType: "monthly" | "split" | "pif" | "deposit";
  origin: string;
  status: "recorded" | "verified" | "disputed";
  recordedAt: number;
};

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

const PAYMENT_TYPE_LABELS: Record<Payment["paymentType"], string> = {
  monthly: "Monthly",
  split: "Split",
  pif: "Paid in Full",
  deposit: "Deposit",
};

const PAYMENT_STATUS_LABELS: Record<Payment["status"], string> = {
  recorded: "Recorded",
  verified: "Verified",
  disputed: "Disputed",
};

const ORIGIN_LABELS: Record<string, string> = {
  closer_meeting: "Closer meeting",
  closer_reminder: "Closer reminder",
  admin_meeting: "Admin meeting",
  admin_reminder: "Admin reminder",
  admin_review_resolution: "Admin review",
  closer_side_deal: "Closer side deal",
  admin_side_deal: "Admin side deal",
  customer_direct: "Customer direct",
  bookkeeper_direct: "Bookkeeper direct",
};

function formatOrigin(origin: string) {
  return ORIGIN_LABELS[origin] ?? origin.replaceAll("_", " ");
}

export function OpportunityPaymentsList({ payments }: { payments: Payment[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Payments</CardTitle>
        <CardDescription>
          Commissionable payments recorded against this opportunity.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {payments.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ReceiptTextIcon aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No payments recorded</EmptyTitle>
              <EmptyDescription>
                Payments will appear here after a closer or admin records one.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Amount</TableHead>
                <TableHead>Program</TableHead>
                <TableHead>Payment type</TableHead>
                <TableHead>Origin</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Recorded</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((payment) => (
                <TableRow key={payment._id}>
                  <TableCell className="font-medium">
                    <span className="inline-flex items-center gap-2">
                      <CreditCardIcon
                        aria-hidden="true"
                        className="size-4 text-muted-foreground"
                      />
                      {formatAmountMinor(payment.amountMinor, payment.currency)}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {payment.programName}
                  </TableCell>
                  <TableCell>{PAYMENT_TYPE_LABELS[payment.paymentType]}</TableCell>
                  <TableCell>{formatOrigin(payment.origin)}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {PAYMENT_STATUS_LABELS[payment.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {dateTimeFormatter.format(new Date(payment.recordedAt))}
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
