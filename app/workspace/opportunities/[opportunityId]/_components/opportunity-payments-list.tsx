"use client";

import { ArrowUpRightIcon } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import { formatCash, leadingWith, mainCurrency, type CurrencyAmount } from "@/lib/closer-pipeline";
import type { BusinessDaySetting } from "@/lib/businessDay";
import { cn } from "@/lib/utils";
import { formatDealDate } from "./deal-format";
import { VoidPaymentDialog } from "./void-payment-dialog";

export type DealPayment = {
  _id: Id<"paymentRecords">;
  amountMinor: number;
  currency: string;
  programName: string;
  paymentType: "monthly" | "split" | "pif" | "deposit";
  origin: string;
  status: "recorded" | "verified" | "disputed";
  recordedAt: number;
  fathomLink?: string | null;
  hasProofFile?: boolean;
};

const PAYMENT_TYPE_LABELS: Record<DealPayment["paymentType"], string> = {
  monthly: "Monthly",
  split: "Split",
  pif: "Paid in full",
  deposit: "Deposit",
};

const PAYMENT_STATUS: Record<DealPayment["status"], { label: string; ink: string }> = {
  recorded: { label: "Recorded", ink: "text-muted-foreground" },
  verified: { label: "Verified", ink: "text-stage-won-ink" },
  disputed: { label: "Disputed", ink: "text-danger-ink" },
};

/**
 * What the deal has been paid, one sum per currency, the currency with the
 * most payments first. A disputed (voided) payment doesn't count, and
 * currencies are never added together.
 */
export function dealPaidTotals(payments: DealPayment[]): CurrencyAmount[] {
  const byCurrency = new Map<string, CurrencyAmount>();
  for (const payment of payments) {
    if (payment.status === "disputed") continue;
    const currency = payment.currency.toUpperCase();
    const entry = byCurrency.get(currency) ?? { currency, amountMinor: 0, paymentCount: 0 };
    entry.amountMinor += payment.amountMinor;
    entry.paymentCount = (entry.paymentCount ?? 0) + 1;
    byCurrency.set(currency, entry);
  }
  const totals = [...byCurrency.values()];
  return leadingWith(totals, mainCurrency(totals));
}

/**
 * The deal's payments as ruled two-line rows, newest first: the amount in
 * condensed figures with its status word, then program, type and date.
 * An admin voids the side-deal payment from its row.
 */
export function OpportunityPaymentsList({
  payments,
  setting,
  now,
  voidablePaymentId,
}: {
  payments: DealPayment[];
  setting: BusinessDaySetting;
  now: number;
  /** The one payment an admin may void (an active side-deal payment on a won side deal). */
  voidablePaymentId?: Id<"paymentRecords"> | null;
}) {
  return (
    <ul>
      {payments.map((payment) => {
        const status = PAYMENT_STATUS[payment.status];
        const disputed = payment.status === "disputed";
        return (
          <li
            key={payment._id}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-t px-4 py-2 first:border-t-0 sm:px-5"
          >
            <span
              className={cn(
                "font-condensed text-[1.0625rem] leading-tight font-semibold tabular-nums",
                disputed && "text-muted-foreground line-through",
              )}
            >
              {formatCash(payment.amountMinor, payment.currency)}
            </span>
            <span
              className={cn(
                "justify-self-end font-condensed text-[0.8125rem] leading-none font-bold tracking-[0.08em] uppercase",
                status.ink,
              )}
            >
              {status.label}
            </span>
            <span className="min-w-0 truncate text-[0.8125rem] text-muted-foreground">
              <span translate="no">{payment.programName}</span>
              {" · "}
              {PAYMENT_TYPE_LABELS[payment.paymentType]}
              {" · "}
              <span className="font-condensed text-sm tabular-nums">
                {formatDealDate(payment.recordedAt, setting, now)}
              </span>
              {payment.fathomLink ? (
                <>
                  {" · "}
                  <a
                    href={payment.fathomLink}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 rounded-sm text-foreground underline decoration-foreground/40 underline-offset-[3px] hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    Fathom
                    <ArrowUpRightIcon aria-hidden="true" className="size-3" />
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </>
              ) : null}
            </span>
            <span className="justify-self-end">
              {voidablePaymentId === payment._id && !disputed ? (
                <VoidPaymentDialog paymentId={payment._id} />
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** "$1,500 · €200": the deal's paid totals, each currency on its own. */
export function DealPaidTotals({ totals }: { totals: CurrencyAmount[] }) {
  if (totals.length === 0) return null;
  return (
    <span className="font-condensed text-[0.9375rem] font-semibold text-foreground tabular-nums">
      {totals.map((total, index) => (
        <span key={total.currency}>
          {index > 0 ? <span className="px-1 font-sans font-normal text-muted-foreground">·</span> : null}
          {formatCash(total.amountMinor, total.currency)}
        </span>
      ))}
      <span className="sr-only"> paid</span>
    </span>
  );
}
