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
  const formattedRevenue = `$${(data.reminderDrivenRevenueMinor / 100).toLocaleString(
    undefined,
    {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    },
  )}`;

  return (
    <Card className="bg-linear-to-br from-card via-card to-muted/40">
      <CardHeader>
        <Badge variant="outline" className="w-fit">
          Live attribution
        </Badge>
        <CardTitle>Reminder-Driven Revenue</CardTitle>
        <CardDescription>
          Non-disputed payments recorded from reminder resolution in this range.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex h-full flex-col gap-4">
        <div className="rounded-2xl border bg-background/80 p-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-[0.22em] text-muted-foreground">
              Revenue captured
            </span>
            <div className="flex items-end justify-between gap-3">
              <span className="text-3xl font-semibold tabular-nums">
                {formattedRevenue}
              </span>
              <span
                className="h-2 w-14 rounded-full"
                style={{
                  backgroundColor: OUTCOME_META.payment_received.color,
                }}
              />
            </div>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            {formatCount(data.reminderDrivenPaymentCount)} payment
            {data.reminderDrivenPaymentCount === 1 ? "" : "s"} logged from the
            reminder flow.
            {data.isReminderRevenueTruncated
              ? " Results were capped at 2,000 payments."
              : ""}
          </p>
        </div>

        <div className="rounded-2xl border bg-background/80 p-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-[0.22em] text-muted-foreground">
              Leading signal
            </span>
            <div className="flex items-end justify-between gap-3">
              <span className="text-3xl font-semibold tabular-nums">
                {formatCount(paymentReceivedCount)}
              </span>
              <span
                className="h-2 w-14 rounded-full"
                style={{
                  backgroundColor: OUTCOME_META.payment_received.color,
                }}
              />
            </div>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            reminders already ended with a structured
            `payment_received` outcome in this range.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
