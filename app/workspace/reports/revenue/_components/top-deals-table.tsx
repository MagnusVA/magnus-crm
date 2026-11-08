"use client";

import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { getMemberDisplayName, type MemberAvatarIdentity } from "@/app/workspace/_components/member-avatar";
import { formatCash } from "@/lib/closer-pipeline";
import { cn } from "@/lib/utils";
import { COLUMN_HEAD, FIGURE_15, ReportCard, RowsSkeleton } from "../../_components/report-ui";
import { REVENUE_CURRENCY } from "./revenue-format";

const PAYMENT_TYPE_LABELS: Record<string, string> = { pif: "PIF", split: "Split", monthly: "Monthly", deposit: "Deposit" };

type TopDeal = {
  paymentRecordId: string;
  amountMinor: number;
  currency?: string;
  attributedCloser: MemberAvatarIdentity;
  recordedAt: number;
  programName?: string | null;
  paymentType?: string | null;
};

function paymentTypeLabel(paymentType: string | null | undefined) {
  if (!paymentType) return "—";
  return PAYMENT_TYPE_LABELS[paymentType] ?? paymentType.charAt(0).toUpperCase() + paymentType.slice(1);
}

/** "Sep 18", with the year only outside this year. */
function dayLabel(timestamp: number) {
  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

// The ten largest final payments, each in its own currency, in one ruled
// table. Below @3xl/deals each deal folds to two lines.
export function TopDealsTable({
  deals,
  rangePhrase,
  reloading,
}: {
  deals: TopDeal[] | undefined;
  rangePhrase: string;
  reloading?: boolean;
}) {
  return (
    <ReportCard title="Top 10 deals" meta="Largest final payments" container="@container/deals" reloading={reloading}>
      {deals === undefined ? (
        <RowsSkeleton rows={10} label="Loading the top deals" />
      ) : deals.length === 0 ? (
        <SectionEmpty title={`No deals ${rangePhrase}.`} />
      ) : (
        <>
          <table className="hidden w-full table-fixed border-collapse @3xl/deals:table">
            <caption className="sr-only">The ten largest final payments</caption>
            <colgroup>
              <col className="w-12" />
              <col className="w-[8rem]" />
              <col />
              <col className="w-[6.5rem]" />
              <col className="w-[30%]" />
              <col className="w-[7.5rem]" />
            </colgroup>
            <thead>
              <tr className="border-b">
                <th scope="col" className={cn(COLUMN_HEAD, "pl-4 text-left")}>
                  #
                </th>
                <th scope="col" className={cn(COLUMN_HEAD, "pr-5 text-right")}>
                  Amount
                </th>
                <th scope="col" className={cn(COLUMN_HEAD, "text-left")}>
                  Payment program
                </th>
                <th scope="col" className={cn(COLUMN_HEAD, "text-left")}>
                  Type
                </th>
                <th scope="col" className={cn(COLUMN_HEAD, "text-left")}>
                  Closer
                </th>
                <th scope="col" className={cn(COLUMN_HEAD, "pr-4 text-right")}>
                  Date
                </th>
              </tr>
            </thead>
            <tbody>
              {deals.map((deal, index) => {
                const closer = getMemberDisplayName(deal.attributedCloser);
                return (
                  <tr key={deal.paymentRecordId} className="h-11 border-b last:border-b-0">
                    <td className={cn(FIGURE_15, "pl-4 text-muted-foreground")}>{index + 1}</td>
                    <th scope="row" className={cn(FIGURE_15, "pr-5 text-right whitespace-nowrap")}>
                      {formatCash(deal.amountMinor, deal.currency ?? REVENUE_CURRENCY)}
                    </th>
                    <td title={deal.programName ?? undefined} className="truncate px-2.5 font-medium">
                      {deal.programName ?? <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="truncate px-2.5">{paymentTypeLabel(deal.paymentType)}</td>
                    <td title={closer} className="truncate px-2.5">
                      {closer}
                    </td>
                    <td className={cn(FIGURE_15, "pr-4 text-right font-medium whitespace-nowrap text-muted-foreground")}>
                      {dayLabel(deal.recordedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <ol aria-label="The ten largest final payments" className="flex flex-col @3xl/deals:hidden">
            {deals.map((deal, index) => (
              <li key={deal.paymentRecordId} className="flex gap-3 border-b px-4 py-2.5 last:border-b-0">
                <span className={cn(FIGURE_15, "w-5 shrink-0 text-muted-foreground")}>{index + 1}</span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-baseline gap-3">
                    <span className="min-w-0 flex-1 truncate font-medium">{deal.programName ?? "No program"}</span>
                    <span className={cn(FIGURE_15, "shrink-0")}>
                      {formatCash(deal.amountMinor, deal.currency ?? REVENUE_CURRENCY)}
                    </span>
                  </span>
                  <span className="truncate text-[13px] text-muted-foreground">
                    {paymentTypeLabel(deal.paymentType)} · {getMemberDisplayName(deal.attributedCloser)} · {dayLabel(deal.recordedAt)}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </ReportCard>
  );
}
