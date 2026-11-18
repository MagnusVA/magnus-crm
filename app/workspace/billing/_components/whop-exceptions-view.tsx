"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { AlertTriangleIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { isWhopSweepFresh, MAX_PROVIDER_PAYMENT_AGE_MS } from "@/convex/payments/reviewTiming";
import { useRole } from "@/components/auth/role-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { TranslatableText } from "@/components/translatable-text";
import { formatAmountMinor } from "@/lib/format-currency";
import { cn } from "@/lib/utils";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { FIGURE, formatPaidAt } from "./billing-format";
import { QueueRowsSkeleton } from "./billing-queue-rows";
import { paymentCommandSentence } from "./payment-command-words";
import {
  ADVERSE_STATE_LABELS,
  dealStageLabel,
  formatSince,
  formatWaitAge,
  INTEGRATIONS_HREF,
  MAPPING_REASONS,
  NOT_CASH_NOTE,
  providerErrorMessage,
  reasonAction,
  reasonSentence,
  UNKNOWN_PAYER_NOTE,
  UNKNOWN_PAYER_REASONS,
  WHOP_SETTINGS_HREF,
} from "./whop-format";

const PAGE_SIZE = 25;

type ExceptionRow = FunctionReturnType<typeof api.payments.review.listProviderExceptions>["page"][number];

type Counts = FunctionReturnType<typeof api.payments.review.getProviderExceptionCounts>;
type AdverseRow = FunctionReturnType<typeof api.payments.review.listAdverseOnResolved>["page"][number];

const FILTERS = [
  { state: "needs_person", label: "Waiting", empty: "No Whop payments are waiting for review." },
  { state: "linked", label: "Linked", empty: "No Whop payments are linked." },
  { state: "dismissed", label: "Dismissed", empty: "No Whop payments have been dismissed." },
  { state: "historical", label: "History", empty: "No historical Whop payments." },
  { state: "not_my_sale", label: "Not my sale", empty: "No closer has said a Whop payment isn't their sale." },
] as const;

/** "500+" when the count reached the cap. */
export function formatExceptionCount(counts: Pick<Counts, "count" | "capped"> & Partial<Pick<Counts, "adverseCount" | "adverseCapped">>) {
  const count = (counts.count + (counts.adverseCount ?? 0)).toLocaleString("en-US");
  return counts.capped || counts.adverseCapped ? `${count}+` : count;
}

export function WhopExceptionsView({
  id,
  labelledBy,
  now,
}: {
  id: string;
  labelledBy: string;
  now: number;
}) {
  const counts = useQuery(api.payments.review.getProviderExceptionCounts, {});

  return (
    <section id={id} role="tabpanel" aria-labelledby={labelledBy} className="flex min-w-0 flex-col gap-3.5">
      {counts === undefined ? (
        <div className="overflow-hidden rounded-xl border border-border bg-card"><QueueRowsSkeleton rows={4} /></div>
      ) : counts.connected ? (
        <Fragment key={counts.environment}>
          <PaymentQueue counts={counts} now={now} />
          <AdverseQueue counts={counts} />
        </Fragment>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <SectionEmpty title="No Whop account is connected.">
            <Link href={INTEGRATIONS_HREF} className={cn(detailLinkClass, "mt-1 text-[13px]")}>
              Connect Whop in Settings › Integrations
            </Link>
          </SectionEmpty>
        </div>
      )}
    </section>
  );
}

function PaymentQueue({ counts, now }: { counts: Counts; now: number }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>(FILTERS[0]);
  const [asOf, setAsOf] = useState(now);
  const queue = usePaginatedQuery(api.payments.review.listProviderExceptions, { state: filter.state, asOf }, { initialNumItems: PAGE_SIZE });
  const rows = queue.results;
  // Keep the loaded pages while the clock ticks. Refresh them when a
  // visible payment actually crosses the age cutoff.
  if (filter.state === "needs_person" && rows.some(({ paidAt }) =>
    paidAt !== null && asOf - paidAt <= MAX_PROVIDER_PAYMENT_AGE_MS &&
    now - paidAt > MAX_PROVIDER_PAYMENT_AGE_MS
  )) {
    setAsOf(now);
  }
  const lastRead = rows[0]?.lastSuccessfulSweepAt ?? counts.lastSuccessfulSweepAt;
  const fresh = isWhopSweepFresh(lastRead, now);

  return (
    <section aria-label="Whop payments" className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2">
        <h2 className="mr-auto text-[15px] font-semibold">Whop payments</h2>
        {fresh && lastRead !== null ? (
          <span className="text-[13px] text-muted-foreground">Oldest first · Whop read {formatSince(lastRead, now)}</span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-warning-ink">
            <AlertTriangleIcon aria-hidden="true" className="size-3.5 shrink-0" />
            {lastRead !== null ? `Whop has not been read since ${formatPaidAt(lastRead, now)}` : "Whop has not been read yet"}
          </span>
        )}
      </div>
      <div role="group" aria-label="Filter Whop payments" className="flex flex-wrap gap-1 border-b px-4 py-2">
        {FILTERS.map((option) => (
          <Button
            key={option.state}
            type="button"
            size="sm"
            variant={filter === option ? "secondary" : "ghost"}
            aria-pressed={filter === option}
            className="h-7"
            onClick={() => setFilter(option)}
          >
            {option.label}
            {option.state === "not_my_sale" && counts.notMySaleCount > 0 ? (
              <span className="font-condensed text-[14px] font-semibold tabular-nums">
                <span aria-hidden="true">{" · "}</span>
                <span className="sr-only">, </span>
                {formatExceptionCount({ count: counts.notMySaleCount, capped: counts.notMySaleCapped })}
              </span>
            ) : null}
          </Button>
        ))}
      </div>
      {queue.status === "LoadingFirstPage" ? (
        <QueueRowsSkeleton rows={4} />
      ) : rows.length === 0 ? (
        <SectionEmpty title={filter.empty} />
      ) : (
        <ul aria-label={`${filter.label} Whop payments`}>
          {rows.map((row) => (
            <ExceptionRowItem
              key={row.providerPaymentId}
              row={row}
              now={now}
              linked={filter.state === "linked"}
              waiting={filter.state === "needs_person"}
            />
          ))}
        </ul>
      )}
      {filter.state === "needs_person" || queue.status === "CanLoadMore" || queue.status === "LoadingMore" ? (
        <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-1.5 text-[13px] text-muted-foreground">
          {filter.state === "needs_person" ? (
            <>
              <span>{NOT_CASH_NOTE}</span>
              <span role="status" className="ml-auto font-condensed text-[14px] font-semibold tabular-nums">
                {formatExceptionCount({ count: counts.count, capped: counts.capped })} open
              </span>
            </>
          ) : null}
          {queue.status === "CanLoadMore" || queue.status === "LoadingMore" ? (
            <Button type="button" size="sm" variant="outline" className="h-7" disabled={queue.isLoading} onClick={() => queue.loadMore(PAGE_SIZE)}>
              {queue.isLoading ? "Loading…" : `Show ${PAGE_SIZE} more`}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function AdverseQueue({ counts }: { counts: Counts }) {
  const queue = usePaginatedQuery(api.payments.review.listAdverseOnResolved, {}, { initialNumItems: PAGE_SIZE });
  return (
    <section aria-labelledby="whop-adverse-heading" className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2">
        <h2 id="whop-adverse-heading" className="mr-auto text-[15px] font-semibold">Refunds and disputes on linked payments</h2>
        <span className="text-[13px] text-muted-foreground">
          {formatExceptionCount({ count: counts.adverseCount, capped: counts.adverseCapped })} to review
        </span>
      </div>
      {queue.status === "LoadingFirstPage" ? (
        <QueueRowsSkeleton rows={2} />
      ) : queue.results.length === 0 ? (
        <SectionEmpty title="No refunds or disputes to review." />
      ) : (
        <ul aria-label="Refunds and disputes to review">
          {queue.results.map((row) => <AdverseRowItem key={row.providerPaymentId} row={row} />)}
        </ul>
      )}
      {queue.status === "CanLoadMore" || queue.status === "LoadingMore" ? (
        <div className="flex justify-end border-t px-4 py-2">
          <Button type="button" size="sm" variant="outline" className="h-7" disabled={queue.isLoading} onClick={() => queue.loadMore(PAGE_SIZE)}>
            {queue.isLoading ? "Loading…" : `Show ${PAGE_SIZE} more`}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function AdverseRowItem({ row }: { row: AdverseRow }) {
  const { hasPermission } = useRole();
  const acknowledge = useMutation(api.payments.review.acknowledgeAdverse);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amount = row.totalMinor !== null
    ? formatAmountMinor(row.totalMinor, row.currency)
    : `${row.currency.toUpperCase()}, amount not readable`;

  async function markSeen() {
    setPending(true);
    setError(null);
    try {
      await acknowledge({
        providerPaymentId: row.providerPaymentId,
        expectedPaymentRecordId: row.paymentRecordId,
        expectedAdverseReviewRevision: row.adverseReviewRevision,
      });
    } catch (caught) {
      setError(providerErrorMessage(caught, "Couldn't mark this as seen. Try again."));
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-2.5 last:border-b-0">
      <div className="min-w-0">
        <p className="flex flex-wrap items-baseline gap-x-2 leading-6">
          <span className={FIGURE}>{amount}</span>
          {row.environment === "sandbox" ? <Badge variant="outline">Sandbox</Badge> : null}
        </p>
        <p className="text-[14px] font-medium">{ADVERSE_STATE_LABELS[row.adverseState]}</p>
        {error ? <p role="alert" className="text-[13px] text-danger-ink">{error}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/workspace/billing/${row.paymentRecordId}`} className={detailLinkClass}>Open CRM payment</Link>
        {hasPermission("billing:review") ? (
          <Button type="button" size="sm" variant="outline" className="h-8" disabled={pending} onClick={() => void markSeen()}>
            {pending ? "Saving…" : "Seen"}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** What helps decide: the candidate person and deal, or a note on the unknown payer. */
function decideLine(row: ExceptionRow, now: number) {
  const { candidatePerson, candidateDeal } = row;
  if (candidatePerson) {
    const deal = candidateDeal
      ? [
          dealStageLabel(candidateDeal.stage, candidateDeal.outcome),
          candidateDeal.programName,
          candidateDeal.latestMeetingAt !== null ? `call ${formatPaidAt(candidateDeal.latestMeetingAt, now)}` : null,
        ]
          .filter(Boolean)
          .join(", ")
      : null;
    return (
      <>
        <span className="font-medium text-foreground" translate="no">
          {candidatePerson.displayName}
        </span>
        {deal ? ` · ${deal}` : null}
      </>
    );
  }
  if (row.reviewReason && UNKNOWN_PAYER_REASONS.has(row.reviewReason)) {
    return (
      <>
        {row.payerEmail ? (
          <>
            Payer{" "}
            <span className="font-medium text-foreground" translate="no">
              {row.payerEmail}
            </span>
            .{" "}
          </>
        ) : null}
        {UNKNOWN_PAYER_NOTE}
      </>
    );
  }
  return row.payerEmail ? (
    <>
      Payer{" "}
      <span className="font-medium text-foreground" translate="no">
        {row.payerEmail}
      </span>
    </>
  ) : null;
}

/** "Waiting on Dee Moreno · 3 hours", or "Waiting on Billing · 2 days". */
function WaitingLine({ row, now }: { row: ExceptionRow; now: number }) {
  const who = row.waitsOn === "closer" ? row.closerName ?? "the closer" : "Billing";
  return (
    <p className="mt-0.5 text-[13px] text-muted-foreground">
      Waiting on{" "}
      <span className="font-medium text-foreground" translate={row.waitsOn === "closer" ? "no" : undefined}>
        {who}
      </span>
      {" · "}
      <span className="font-condensed text-[14px] font-semibold tabular-nums">{formatWaitAge(row.waitingSince, now)}</span>
    </p>
  );
}

/** A closer said this isn't their sale: take it off the deal, or clear the flag. */
function NotMySaleLine({ row }: { row: ExceptionRow }) {
  const { hasPermission } = useRole();
  const clear = useMutation(api.payments.notMySale.clearNotMySale);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function itIsTheirSale() {
    setPending(true);
    setError(null);
    try {
      const result = await clear({ providerPaymentId: row.providerPaymentId });
      if (result.ok) toast.success(result.alreadyApplied ? "The flag was already cleared." : "Cleared. The sale stays with the closer.");
      else setError(paymentCommandSentence(result.code));
    } catch (caught) {
      setError(providerErrorMessage(caught, "Couldn't clear the flag. Try again."));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      <p className="text-[14px] font-medium text-warning-ink">
        {row.closerName ? <span translate="no">{row.closerName}</span> : "The closer"} says this isn&apos;t their sale.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {hasPermission("billing:correct") ? (
          <Button asChild size="sm" variant="outline" className="h-8">
            <Link href={`/workspace/billing/whop/${row.providerPaymentId}?takeOut=wrong_match`}>Take it off this deal</Link>
          </Button>
        ) : null}
        {hasPermission("billing:review") ? (
          <Button type="button" size="sm" variant="outline" className="h-8" disabled={pending} onClick={() => void itIsTheirSale()}>
            {pending ? <Spinner data-icon="inline-start" /> : null}
            <TranslatableText>It is their sale</TranslatableText>
          </Button>
        ) : null}
      </div>
      {error ? <p role="alert" className="text-[13px] text-danger-ink">{error}</p> : null}
    </div>
  );
}

function ExceptionRowItem({ row, now, linked, waiting }: { row: ExceptionRow; now: number; linked: boolean; waiting: boolean }) {
  const amount =
    row.totalMinor !== null ? formatAmountMinor(row.totalMinor, row.currency) : `${row.currency.toUpperCase()}, amount not readable`;
  const when = row.paidAt !== null ? `collected ${formatPaidAt(row.paidAt, now)}` : `reported ${formatPaidAt(row.firstSeenAt, now)}`;
  const product = [row.productTitle, row.variantTitle].filter(Boolean).join(" · ");
  const decide = decideLine(row, now);
  const action = reasonAction(row.reviewReason);

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 border-b px-4 py-2.5 last:border-b-0">
      <div className="min-w-0">
        <p className="leading-6">
          <span className={FIGURE}>{amount}</span>
          <span className="text-muted-foreground"> · {when}</span>
          {row.environment === "sandbox" ? <Badge variant="outline" className="ml-2">Sandbox</Badge> : null}
          {product ? (
            <span className="text-muted-foreground">
              {" · "}
              <span translate="no">{product}</span>
            </span>
          ) : null}
        </p>
        <p className="text-[14px] font-medium">
          {linked ? "Linked to a CRM payment." : row.notMySaleAt !== null ? "Counts as a CRM payment." : reasonSentence(row.reviewReason)}
          {row.reviewReason && MAPPING_REASONS.has(row.reviewReason) ? (
            <>
              {" "}
              <Link href={WHOP_SETTINGS_HREF} className={cn(detailLinkClass, "inline font-normal")}>
                Map it in Settings › Whop
              </Link>
            </>
          ) : null}
        </p>
        {row.classificationDeferred ? (
          <p className="mt-0.5 text-[13px] text-muted-foreground">Open this payment to check its latest match.</p>
        ) : null}
        {decide ? <p className="mt-0.5 text-[13px] text-muted-foreground">{decide}</p> : null}
        {waiting ? <WaitingLine row={row} now={now} /> : null}
        {row.notMySaleAt !== null ? <NotMySaleLine row={row} /> : null}
      </div>
      <Button asChild size="sm" variant="outline" className="h-8 shrink-0">
        <Link href={`/workspace/billing/whop/${row.providerPaymentId}`}>
          {action}
          <span className="sr-only">
            {" "}
            {amount} {when}
          </span>
        </Link>
      </Button>
    </li>
  );
}
