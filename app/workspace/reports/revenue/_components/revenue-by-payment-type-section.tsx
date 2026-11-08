"use client";

import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { BarList, ReportCard, RowsSkeleton } from "../../_components/report-ui";
import { AmountShare, wholeShare } from "./amount-share";
import { dollars } from "./revenue-format";

type PaymentTypeBreakdown = { pif: number; split: number; monthly: number; deposit: number };

const TYPE_LABELS: Record<keyof PaymentTypeBreakdown, string> = {
  pif: "PIF (paid in full)",
  split: "Split",
  monthly: "Monthly",
  deposit: "Deposit",
};

/** Every payment's amount by payment type, deposits included, largest first. */
export function RevenueByPaymentTypeSection({
  byPaymentType,
  rangePhrase,
  reloading,
}: {
  byPaymentType: PaymentTypeBreakdown | undefined;
  rangePhrase: string;
  reloading?: boolean;
}) {
  const total = byPaymentType
    ? byPaymentType.pif + byPaymentType.split + byPaymentType.monthly + byPaymentType.deposit
    : 0;
  const rows = byPaymentType
    ? (Object.keys(TYPE_LABELS) as Array<keyof PaymentTypeBreakdown>)
        .map((key) => ({ key, amountMinor: byPaymentType[key] }))
        .sort((left, right) => right.amountMinor - left.amountMinor)
    : undefined;

  return (
    <ReportCard title="Revenue by payment type" meta="Deposits included" reloading={reloading}>
      {rows === undefined ? (
        <RowsSkeleton rows={4} label="Loading revenue by payment type" />
      ) : total === 0 ? (
        <SectionEmpty title={`No payments ${rangePhrase}.`} />
      ) : (
        <BarList
          label="Payments by payment type"
          rows={rows.map((row) => ({
            key: row.key,
            label: TYPE_LABELS[row.key],
            value: row.amountMinor,
            display: <AmountShare amount={dollars(row.amountMinor)} share={wholeShare(row.amountMinor, total)} />,
          }))}
        />
      )}
    </ReportCard>
  );
}
