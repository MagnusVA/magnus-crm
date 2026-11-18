"use client";

import Link from "next/link";
import { usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { AlertTriangleIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { formatAmountMinor } from "@/lib/format-currency";
import { cn } from "@/lib/utils";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { FIGURE, formatPaidAt } from "./billing-format";
import { QueueRowsSkeleton } from "./billing-queue-rows";
import {
  dealStageLabel,
  formatSince,
  INTEGRATIONS_HREF,
  MAPPING_REASONS,
  NOT_CASH_NOTE,
  reasonAction,
  reasonSentence,
  UNKNOWN_PAYER_NOTE,
  UNKNOWN_PAYER_REASONS,
  WHOP_SETTINGS_HREF,
} from "./whop-format";

const PAGE_SIZE = 25;
const SWEEP_FRESHNESS_MS = 15 * 60 * 1000;

type ExceptionRow = FunctionReturnType<typeof api.payments.review.listProviderExceptions>["page"][number];

/** "500+" when the count reached the cap. */
export function formatExceptionCount(counts: { count: number; capped: boolean }) {
  return counts.capped ? `${counts.count.toLocaleString("en-US")}+` : counts.count.toLocaleString("en-US");
}

/**
 * Whether a Whop account is connected, in either environment. Undefined while
 * it loads.
 */
function useWhopConnected() {
  const live = useQuery(api.payments.connection.getConnection, { environment: "live" });
  const sandbox = useQuery(api.payments.connection.getConnection, { environment: "sandbox" });
  if (live === undefined || sandbox === undefined) return { connected: undefined, connection: null };
  const connection = [live, sandbox].find((row) => row && row.status !== "disconnected") ?? null;
  return { connected: connection !== null, connection };
}

/** The Whop payments with no CRM payment yet, oldest first. */
export function WhopExceptionsView({
  id,
  labelledBy,
  now,
}: {
  id: string;
  labelledBy: string;
  now: number;
}) {
  const queue = usePaginatedQuery(api.payments.review.listProviderExceptions, {}, { initialNumItems: PAGE_SIZE });
  const counts = useQuery(api.payments.review.getProviderExceptionCounts, {});
  const { connected, connection } = useWhopConnected();

  const rows = queue.status === "LoadingFirstPage" ? undefined : queue.results;
  // Every row carries its connection's freshness; with none, ask the connection.
  const first = rows?.[0];
  const lastRead = first ? first.lastSuccessfulSweepAt : (connection?.lastSuccessfulSweepAt ?? null);
  const fresh = first
    ? first.sweepFresh
    : connection?.status === "connected" && lastRead !== null && now - lastRead <= SWEEP_FRESHNESS_MS;
  const showFreshness = rows !== undefined && (rows.length > 0 || connected === true);

  return (
    <section
      id={id}
      role="tabpanel"
      aria-labelledby={labelledBy}
      className="min-w-0 overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2">
        <h2 className="mr-auto text-[15px] font-semibold">From Whop, not yet in the CRM</h2>
        {showFreshness ? (
          fresh ? (
            <span className="text-[13px] text-muted-foreground">
              Oldest first · Whop read {lastRead !== null ? formatSince(lastRead, now) : "just now"}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-warning-ink">
              <AlertTriangleIcon aria-hidden="true" className="size-3.5 shrink-0" />
              {lastRead !== null ? `Whop has not been read since ${formatPaidAt(lastRead, now)}` : "Whop has not been read yet"}
            </span>
          )
        ) : null}
      </div>

      {rows === undefined || (rows.length === 0 && connected === undefined) ? (
        <QueueRowsSkeleton rows={4} />
      ) : rows.length === 0 ? (
        connected ? (
          <SectionEmpty title="Every Whop payment has a CRM payment or was dismissed.">
            Whop payments that need a person appear here.
          </SectionEmpty>
        ) : (
          <SectionEmpty title="No Whop account is connected.">
            <Link href={INTEGRATIONS_HREF} className={cn(detailLinkClass, "mt-1 text-[13px]")}>
              Connect Whop in Settings › Integrations
            </Link>
          </SectionEmpty>
        )
      ) : (
        <ul aria-label="Whop payments not yet in the CRM">
          {rows.map((row) => (
            <ExceptionRowItem key={row.providerPaymentId} row={row} now={now} />
          ))}
        </ul>
      )}

      {rows !== undefined && (rows.length > 0 || connected) ? (
        <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-1.5 text-[13px] text-muted-foreground">
          <span>{NOT_CASH_NOTE}</span>
          <span role="status" className="ml-auto font-condensed text-[14px] font-semibold tabular-nums">
            {counts ? `${formatExceptionCount(counts)} open` : "Counting…"}
          </span>
          {queue.status === "CanLoadMore" || queue.status === "LoadingMore" ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7"
              disabled={queue.status === "LoadingMore"}
              onClick={() => queue.loadMore(PAGE_SIZE)}
            >
              {queue.status === "LoadingMore" ? "Loading…" : `Show ${PAGE_SIZE} more`}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
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

function ExceptionRowItem({ row, now }: { row: ExceptionRow; now: number }) {
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
          {product ? (
            <span className="text-muted-foreground">
              {" · "}
              <span translate="no">{product}</span>
            </span>
          ) : null}
        </p>
        <p className="text-[14px] font-medium">
          {reasonSentence(row.reviewReason)}
          {row.reviewReason && MAPPING_REASONS.has(row.reviewReason) ? (
            <>
              {" "}
              <Link href={WHOP_SETTINGS_HREF} className={cn(detailLinkClass, "inline font-normal")}>
                Map it in Settings › Whop
              </Link>
            </>
          ) : null}
        </p>
        {decide ? <p className="mt-0.5 text-[13px] text-muted-foreground">{decide}</p> : null}
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
