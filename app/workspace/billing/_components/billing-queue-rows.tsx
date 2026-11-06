"use client";

import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
import { ChevronRightIcon, FileCheckIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatAmountMinor } from "@/lib/format-currency";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";
import {
  customerName,
  FIGURE,
  formatPaidAt,
  LABEL,
  PAYMENT_TYPE_LABELS,
  STATUS_INK,
  STATUS_LABELS,
  STATUS_WORD,
} from "./billing-format";

// The queue's ruled column rows, one 44px line each. The card is the
// container they fold by: every column from @4xl; under it PROGRAM and TYPE
// share one cell; under @2xl a row is two lines (customer and amount; paid ·
// program · type, then the proof icon and the status).

export type BillingQueueRow = FunctionReturnType<typeof api.billing.queries.listPayments>["page"][number];

/** PAID · CUSTOMER · PROGRAM · TYPE · AMOUNT · PROOF · STATUS · chevron. */
const COLUMNS =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 @2xl/payments:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)_6.5rem_2.75rem_6rem_1rem] @2xl/payments:gap-x-3 @4xl/payments:grid-cols-[8.25rem_minmax(0,1.6fr)_minmax(0,1.15fr)_6.5rem_8rem_2.75rem_6.5rem_1rem] @4xl/payments:gap-x-4";

const ROW_LINK =
  "outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring";

export function QueueHeads() {
  return (
    <div className={cn(COLUMNS, "hidden min-h-7 border-b px-4 pt-2 pb-1.5 @2xl/payments:grid", LABEL)}>
      <span>
        <HelpTip tip="When the payment was made, in your browser's time zone. Newest first.">Paid</HelpTip>
      </span>
      <span>Customer</span>
      <span>
        Program<span className="@4xl/payments:hidden"> · Type</span>
      </span>
      <span className="hidden @4xl/payments:block">Type</span>
      <span className="text-right">
        <HelpTip tip="In the payment's own currency. Amounts in different currencies are never added together.">
          Amount
        </HelpTip>
      </span>
      <span className="text-center">
        <HelpTip tip="The file icon means a receipt or screenshot is attached. Open the payment to see it.">Proof</HelpTip>
      </span>
      <span>
        <HelpTip tip="Needs review: nobody has checked it yet. Reviewed: checked and ready for external billing. Disputed: voided, so it no longer counts as revenue.">
          Status
        </HelpTip>
      </span>
      <span />
    </div>
  );
}

export function QueueRow({ row, now }: { row: BillingQueueRow; now: number }) {
  const { payment, customer } = row;
  // The name, else the email, else the phone; nothing under it.
  const name = customerName({ ...customer, phone: customer.phone ? formatPhone(customer.phone) : null });
  const paid = formatPaidAt(payment.recordedAt, now);
  const type = PAYMENT_TYPE_LABELS[payment.paymentType];

  return (
    <li
      className={cn(
        COLUMNS,
        "relative min-h-[52px] border-b px-4 py-2 last:border-b-0 hover:bg-muted/60 @2xl/payments:min-h-11 @2xl/payments:py-1.5",
      )}
    >
      <time dateTime={new Date(payment.recordedAt).toISOString()} className={cn(FIGURE, "hidden whitespace-nowrap @2xl/payments:block")}>
        {paid}
      </time>
      <div className="min-w-0">
        <Link
          href={`/workspace/billing/${payment.id}`}
          className={cn(ROW_LINK, "block truncate leading-5 font-semibold", name === null && "text-warning-ink")}
          translate="no"
        >
          {name ?? "Missing customer"}
        </Link>
        <p className="truncate text-[13px] leading-[18px] text-muted-foreground @2xl/payments:hidden">
          <span className="font-condensed text-[14px] font-semibold tabular-nums">{paid}</span> · {payment.programName} · {type}
        </p>
      </div>
      <p className="hidden truncate @2xl/payments:block">
        {payment.programName}
        <span className="text-muted-foreground @4xl/payments:hidden"> · {type}</span>
      </p>
      <span className="hidden truncate @4xl/payments:block">{type}</span>
      {/* Phone: the amount over the proof icon and status. From @2xl each is its own column. */}
      <div className="grid grid-cols-[auto_auto] items-center justify-end justify-items-end gap-x-1.5 gap-y-1 @2xl/payments:contents">
        <span className={cn(FIGURE, "col-span-2 text-right whitespace-nowrap @2xl/payments:col-auto")}>
          {formatAmountMinor(payment.amountMinor, payment.currency)}
        </span>
        <span className="flex justify-center @2xl/payments:justify-self-stretch">
          {payment.hasProofFile ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  role="img"
                  aria-label="Proof file attached"
                  className="relative z-10 inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <FileCheckIcon className="size-3.5" aria-hidden="true" />
                </span>
              </TooltipTrigger>
              <TooltipContent>Proof file attached</TooltipContent>
            </Tooltip>
          ) : null}
        </span>
        <span className={cn(STATUS_WORD, STATUS_INK[payment.status], "@2xl/payments:justify-self-start")}>
          {STATUS_LABELS[payment.status]}
        </span>
      </div>
      <ChevronRightIcon className="hidden size-4 text-muted-foreground @2xl/payments:block" aria-hidden="true" />
    </li>
  );
}

/** Rows at the real height (44px, two-line 52px on a phone) while the first page loads. */
export function QueueRowsSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading payments">
      <div className="hidden min-h-7 items-end gap-4 border-b px-4 pb-1.5 @2xl/payments:flex">
        <Skeleton className="h-2.5 w-10" />
        <Skeleton className="ml-24 h-2.5 w-16" />
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <QueueRowSkeleton key={index} />
      ))}
    </div>
  );
}

/** One row's bones; the page skeleton draws the same. */
export function QueueRowSkeleton() {
  return (
    <div className="flex min-h-[52px] items-center gap-4 border-b px-4 py-2 last:border-b-0 @2xl/payments:min-h-11 @2xl/payments:py-1.5">
      <Skeleton className="hidden h-4 w-24 @2xl/payments:block" />
      <div className="flex flex-1 flex-col gap-1.5">
        <Skeleton className="h-3.5 w-40 max-w-full" />
        <Skeleton className="h-3 w-52 max-w-full @2xl/payments:hidden" />
      </div>
      <Skeleton className="hidden h-3.5 w-28 @2xl/payments:block" />
      <div className="flex flex-col items-end gap-1.5">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-3 w-16 @2xl/payments:hidden" />
      </div>
      <Skeleton className="hidden h-3 w-20 @2xl/payments:block" />
    </div>
  );
}
