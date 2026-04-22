"use client";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatAmountMinor } from "@/lib/format-currency";
import {
  formatCount,
  OUTCOME_META,
  type ReminderReportData,
} from "./reminders-report-config";

interface ReminderDrivenRevenueCardProps {
  data: ReminderReportData;
}

export function ReminderDrivenRevenueCard({
  data,
}: ReminderDrivenRevenueCardProps) {
  const paymentReceivedCount = data.outcomeMix.payment_received;
  const finalRevenue = data.reminderDrivenFinalRevenueMinor;
  const depositRevenue = data.reminderDrivenDepositRevenueMinor;

  return (
    <Card className="bg-linear-to-br from-card via-card to-muted/40">
      <CardHeader>
        <Badge variant="outline" className="w-fit">
          Live attribution
        </Badge>
        <CardTitle>Reminder-Driven Revenue</CardTitle>
        <CardDescription>
          Non-disputed payments recorded from closer + admin reminder resolution
          in this range.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex h-full flex-col gap-4">
        <div className="rounded-2xl border bg-background/80 p-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-[0.22em] text-muted-foreground">
              Final revenue from reminders
            </span>
            <div className="flex items-end justify-between gap-3">
              <span className="text-3xl font-semibold tabular-nums">
                {formatAmountMinor(finalRevenue, "USD")}
              </span>
              <span
                className="h-2 w-14 rounded-full"
                style={{ backgroundColor: OUTCOME_META.payment_received.color }}
              />
            </div>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            {formatCount(paymentReceivedCount)} reminder
            {paymentReceivedCount === 1 ? "" : "s"} ended with{" "}
            <code>payment_received</code>.
          </p>
        </div>

        <div className="rounded-2xl border bg-background/80 p-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-[0.22em] text-muted-foreground">
              Deposit revenue from reminders
            </span>
            <div className="flex items-end justify-between gap-3">
              <span className="text-3xl font-semibold tabular-nums">
                {formatAmountMinor(depositRevenue, "USD")}
              </span>
              <span
                className="h-2 w-14 rounded-full"
                style={{ backgroundColor: OUTCOME_META.payment_received.color }}
              />
            </div>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            {formatCount(data.reminderDrivenPaymentCount)} payment
            {data.reminderDrivenPaymentCount === 1 ? "" : "s"} logged total
            (final + deposit).
            {data.isReminderRevenueTruncated
              ? " Results were capped at 2,000 payments."
              : ""}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
