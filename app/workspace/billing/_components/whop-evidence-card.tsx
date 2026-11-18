"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { ArrowUpRightIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DetailCard, detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { formatAmountMinor } from "@/lib/format-currency";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { FIGURE } from "./billing-format";
import { PaidAt } from "./paid-at";
import { ADVERSE_STATE_LABELS } from "./whop-format";

/**
 * The Whop payment that backs this CRM payment, when one is linked. Whop's
 * amount is shown beside the CRM's, never in place of it.
 */
export function WhopEvidenceCard({
  paymentRecordId,
  amountMinor,
  currency,
  now,
}: {
  paymentRecordId: Id<"paymentRecords">;
  amountMinor: number;
  currency: string;
  now: number;
}) {
  const evidence = useQuery(api.payments.review.getLinkedProviderPayment, { paymentRecordId });
  if (!evidence) return null;

  const whopAmount =
    evidence.totalMinor !== undefined ? formatAmountMinor(evidence.totalMinor, evidence.currency) : null;
  const differs = evidence.currency !== currency || evidence.totalMinor !== amountMinor;
  const product = [evidence.productTitle, evidence.variantTitle].filter(Boolean).join(" · ");
  const adverse = ADVERSE_STATE_LABELS[evidence.adverseState];
  const active = evidence.paymentRecordId === paymentRecordId;

  return (
    <DetailCard
      title="Whop evidence"
      meta={
        <div className="flex flex-wrap items-center gap-2">
          {evidence.environment === "sandbox" ? <Badge variant="outline">Sandbox</Badge> : null}
          <Link href={`/workspace/billing/whop/${evidence._id}`} className={cn(detailLinkClass, "gap-0.5")}>
            Open in Billing
            <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
          </Link>
        </div>
      }
    >
      {!evidence.sourceConnected ? (
        <p className="border-b px-4 py-2 text-[13px] text-muted-foreground">Whop account disconnected</p>
      ) : null}
      <dl className="py-1">
        <Row label="Collected">
          {evidence.paidAt !== undefined ? (
            <span className={FIGURE}>
              <PaidAt at={evidence.paidAt} now={now} />
            </span>
          ) : (
            <span className="text-muted-foreground">Not collected</span>
          )}
        </Row>
        <Row label="Whop amount">
          {whopAmount ? <span className={FIGURE}>{whopAmount}</span> : <span className="text-muted-foreground">Not readable</span>}
          {differs ? (
            <span className="ml-2 text-[13px] font-medium text-warning-ink">
              Differs from the CRM&apos;s {formatAmountMinor(amountMinor, currency)}
            </span>
          ) : (
            <span className="ml-2 text-[13px] text-muted-foreground">Same as the CRM</span>
          )}
        </Row>
        <Row label="Product">
          {product ? <span translate="no">{product}</span> : <span className="text-muted-foreground">None</span>}
        </Row>
        {adverse ? (
          <Row label="Refund or dispute">
            <span className="font-medium text-danger-ink">{adverse}</span>
          </Row>
        ) : null}
        {!active ? (
          <Row label="Link">
            <span className="text-muted-foreground">Kept as history. This payment no longer counts for it.</span>
          </Row>
        ) : null}
      </dl>
    </DetailCard>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-8 grid-cols-[6.875rem_minmax(0,1fr)] items-baseline gap-x-3 px-4 py-1.5">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 wrap-break-word">{children}</dd>
    </div>
  );
}
