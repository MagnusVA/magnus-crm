"use client";

import { FigureZone, ReportFigures } from "@/app/workspace/reports/_components/report-ui";
import { formatAmountMinor } from "@/lib/format-currency";
import { formatCount, formatPercent, getPendingReminderCount, type ReminderReportData } from "./reminders-report-config";

// The band's figures: how many manual reminders were set and completed, and
// the cash recorded when a reminder was resolved (final and deposit payments,
// not disputed). The reader returns this cash in USD.

export function ReminderFigures({
  data,
  rangePhrase,
  reloading,
}: {
  data: ReminderReportData | undefined;
  rangePhrase: string;
  reloading?: boolean;
}) {
  return (
    <ReportFigures reloading={reloading}>
      <FigureZone
        label="Created"
        figure={data ? formatCount(data.totalCreated) : undefined}
        proof={
          data && data.totalCreated === 0
            ? `No manual reminders ${rangePhrase}`
            : data && `${formatCount(getPendingReminderCount(data))} still open`
        }
      />
      <FigureZone
        label="Completed"
        figure={data ? formatCount(data.totalCompleted) : undefined}
        proof={data && (data.completionRate === null ? "Nothing to complete yet" : `${formatPercent(data.completionRate)} of created`)}
      />
      <FigureZone
        label="Final revenue"
        help="Final payments recorded while resolving a reminder, by closers or admins. Disputed payments are left out."
        figure={data ? formatAmountMinor(data.reminderDrivenFinalRevenueMinor, "USD") : undefined}
        figureClassName="text-primary"
        proof={data && (data.reminderDrivenFinalRevenueMinor === 0 ? "No final payments from reminders" : "From reminders, not disputed")}
      />
      <FigureZone
        label="Deposits"
        figure={data ? formatAmountMinor(data.reminderDrivenDepositRevenueMinor, "USD") : undefined}
        proof={
          data &&
          `${formatCount(data.reminderDrivenPaymentCount)} ${data.reminderDrivenPaymentCount === 1 ? "payment" : "payments"} in all${
            data.isReminderRevenueTruncated ? " · capped at 2,000" : ""
          }`
        }
      />
    </ReportFigures>
  );
}
