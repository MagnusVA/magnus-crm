"use client";

import type { ReactNode } from "react";
import type { FunctionReturnType } from "convex/server";
import { ArrowUpRightIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { MemberIdentity } from "@/app/workspace/_components/member-identity";
import { DetailCard, detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";
import { formatAmountMinor } from "@/lib/format-currency";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";
import {
  customerName,
  FIGURE,
  formatBytes,
  formatPaidAt,
  PAYMENT_TYPE_LABELS,
  proofTypeLabel,
  STATUS_LABELS,
} from "./billing-format";

// The payment page's facts: the band's figure row (amount, status, proof,
// closer) and the fact-list cards under it, grouped as payment, customer,
// meeting, attribution and review.

export type BillingPaymentDetail = NonNullable<FunctionReturnType<typeof api.billing.queries.getPaymentDetail>>;

const ORIGIN_LABELS: Record<string, string> = {
  closer_meeting: "Closer, from a meeting",
  closer_reminder: "Closer, from a reminder",
  admin_meeting: "Admin, from a meeting",
  admin_reminder: "Admin, from a reminder",
  admin_review_resolution: "Admin, from a review",
  closer_side_deal: "Closer, side deal",
  admin_side_deal: "Admin, side deal",
  closer_additional: "Closer, additional payment",
  admin_additional: "Admin, additional payment",
};

function formatOrigin(origin: string) {
  return ORIGIN_LABELS[origin] ?? origin.replaceAll("_", " ");
}

/**
 * The payment's own Fathom link first (additional payments on a won deal
 * may have no meeting), then the meeting's.
 */
export function fathomLinkFor(detail: BillingPaymentDetail) {
  const own = detail.payment.fathomLink?.trim();
  if (own) return own;
  const meeting = detail.meeting.fathomLink?.trim();
  return meeting ? meeting : null;
}

// ─── The band's figure row ──────────────────────────────────────────────

const ZONE_LABEL = "font-condensed text-[11px] font-semibold tracking-[0.14em] text-board-muted uppercase";
const ZONE_FIGURE = "font-condensed text-[30px] leading-[1.05] font-semibold tabular-nums";
const ZONE_WORD = "font-condensed text-[22px] leading-[1.3] font-bold tracking-[0.04em] whitespace-nowrap uppercase @lg:text-[26px] @lg:leading-[1.15]";
const ZONE_PROOF = "text-[13px] text-board-foreground/75";

const STATUS_BOARD_INK = {
  recorded: "text-warning",
  verified: "text-board-foreground",
  disputed: "text-board-danger",
} as const;

function Zone({ label, tip, children }: { label: string; tip: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-board px-4 py-3 @lg:px-[18px] @lg:pb-3.5">
      <p className={ZONE_LABEL}>
        <HelpTip tip={tip}>{label}</HelpTip>
      </p>
      {children}
    </div>
  );
}

function statusProof(detail: BillingPaymentDetail, now: number) {
  if (detail.payment.status === "verified") {
    const who = detail.review.reviewerName;
    const when = detail.review.reviewedAt ? formatPaidAt(detail.review.reviewedAt, now) : null;
    return [who ? `By ${who}` : null, when].filter(Boolean).join(" · ") || "Reviewed";
  }
  if (detail.payment.status === "disputed") return "Voided, no longer counts as revenue";
  return "Nobody has checked it yet";
}

export function PaymentFigures({ detail, now }: { detail: BillingPaymentDetail; now: number }) {
  const { payment, proof } = detail;
  const proofSize = formatBytes(proof.size);
  const hasProof = proof.url !== null;
  const closer = detail.phoneCloser.identity?.name ?? detail.phoneCloser.name;

  return (
    <div
      role="group"
      aria-label="Payment figures"
      className="-mx-4 grid grid-cols-2 gap-px border-t border-board-line bg-board-line @lg:-mx-[18px] @4xl:grid-cols-4"
    >
      <Zone label="Amount" tip="What the customer paid, in the payment's own currency.">
        <p className={ZONE_FIGURE}>{formatAmountMinor(payment.amountMinor, payment.currency)}</p>
        <p className={ZONE_PROOF}>
          {payment.currency.toUpperCase()} · {payment.referenceCode ? `Ref ${payment.referenceCode}` : "No reference code"}
        </p>
      </Zone>
      <Zone
        label="Status"
        tip="Needs review: nobody has checked it yet. Reviewed: checked and ready for external billing. Disputed: voided, so it no longer counts as revenue."
      >
        <p className={cn(ZONE_WORD, STATUS_BOARD_INK[payment.status])}>{STATUS_LABELS[payment.status]}</p>
        <p className={ZONE_PROOF}>{statusProof(detail, now)}</p>
      </Zone>
      <Zone label="Proof" tip="The receipt or screenshot attached when the payment was recorded.">
        {/* Missing proof is owed only while the payment still needs review. */}
        <p className={cn(ZONE_WORD, hasProof ? "text-board-foreground" : payment.status === "recorded" ? "text-warning" : "text-board-muted")}>{hasProof ? "Attached" : "Missing"}</p>
        <p className={ZONE_PROOF}>
          {hasProof ? `${proofTypeLabel(proof.contentType)}${proofSize ? ` · ${proofSize}` : ""}` : "No file on record"}
        </p>
      </Zone>
      <Zone label="Closer" tip="The phone closer credited with the sale.">
        <p className="truncate pt-0.5 text-[20px] leading-[1.3] font-semibold" translate="no">
          {closer ?? <span className="text-board-muted">No closer</span>}
        </p>
        <p className={cn(ZONE_PROOF, "truncate")}>Entered by {detail.enteredBy.name}</p>
      </Zone>
    </div>
  );
}

// ─── Fact-list cards ────────────────────────────────────────────────────

function None({ children = "None" }: { children?: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-baseline gap-3 py-[5px]">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 wrap-break-word">{children}</dd>
    </div>
  );
}

function FactCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <DetailCard title={title} className="mb-3.5 break-inside-avoid">
      <dl className="px-4 py-2">{children}</dl>
    </DetailCard>
  );
}

function Member({ identity, name }: { identity: Parameters<typeof MemberIdentity>[0]["identity"] | null; name: string | null }) {
  if (identity) return <MemberIdentity identity={identity} className="gap-2" textClassName="[&>p]:hidden" />;
  return name ? <span>{name}</span> : <None />;
}

const MONO = "font-mono text-[12.5px] tracking-[-0.01em]";

export function PaymentFacts({ detail, now }: { detail: BillingPaymentDetail; now: number }) {
  const { payment, customer, meeting, review, dmAttribution, slackContributorSummary } = detail;
  const fathomLink = fathomLinkFor(detail);

  return (
    // Two columns of cards once the main column has room, filled top to bottom.
    <div className="@container/facts">
      <div className="gap-3.5 @xl/facts:columns-2 -mb-3.5">
        <FactCard title="Payment">
          <Fact label="Amount">
            <span className={FIGURE}>{formatAmountMinor(payment.amountMinor, payment.currency)}</span>{" "}
            <span className="font-condensed text-[13px] font-semibold tracking-[0.04em] text-muted-foreground">
              {payment.currency.toUpperCase()}
            </span>
          </Fact>
          <Fact label="Type">{PAYMENT_TYPE_LABELS[payment.paymentType]}</Fact>
          <Fact label="Program">{payment.programName}</Fact>
          <Fact label="Paid">
            <span className={FIGURE}>{formatPaidAt(payment.recordedAt, now)}</span>
          </Fact>
          <Fact label="Reference">
            {payment.referenceCode ? <span className={MONO}>{payment.referenceCode}</span> : <None />}
          </Fact>
          <Fact label={<HelpTip tip="Who recorded the payment, and from where in the app.">Recorded</HelpTip>}>
            {formatOrigin(payment.origin)}
          </Fact>
          <Fact label="Internal note">
            {payment.note ? <span className="whitespace-pre-wrap">{payment.note}</span> : <None />}
          </Fact>
          <Fact label="Payment ID">
            <span className={cn(MONO, "break-all text-muted-foreground")}>{payment.id}</span>
          </Fact>
        </FactCard>

        <FactCard title="Customer">
          <Fact label="Name">{customer.fullName ? <span translate="no">{customer.fullName}</span> : <None>Missing</None>}</Fact>
          <Fact label="Email">
            {customer.email ? (
              <a className={cn(detailLinkClass, "inline font-normal [overflow-wrap:anywhere]")} href={`mailto:${customer.email}`} translate="no">
                {/* A long address breaks at the @ before it breaks a word. */}
                {customer.email.split("@")[0]}
                <wbr />@{customer.email.split("@").slice(1).join("@")}
              </a>
            ) : (
              <None />
            )}
          </Fact>
          <Fact label="Phone">
            {customer.phone ? (
              <span className="font-condensed text-[15px] font-semibold tabular-nums">{formatPhone(customer.phone)}</span>
            ) : (
              <None />
            )}
          </Fact>
        </FactCard>

        <FactCard title="Meeting">
          <Fact label="Scheduled">
            {meeting.scheduledAt ? <span className={FIGURE}>{formatPaidAt(meeting.scheduledAt, now)}</span> : <None>No meeting</None>}
          </Fact>
          <Fact label="Recording">
            {fathomLink ? (
              <a className={cn(detailLinkClass, "gap-0.5")} href={fathomLink} rel="noreferrer" target="_blank">
                Open in Fathom
                <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
              </a>
            ) : (
              <None>No Fathom link</None>
            )}
          </Fact>
        </FactCard>

        <FactCard title="Attribution">
          <Fact label="Entered by">
            <Member identity={detail.enteredBy.identity} name={detail.enteredBy.name} />
          </Fact>
          <Fact label="Phone closer">
            <Member identity={detail.phoneCloser.identity} name={detail.phoneCloser.name} />
          </Fact>
          <Fact label={<HelpTip tip="The DM team credited through the booking's utm_source.">DM team</HelpTip>}>
            {dmAttribution.teamName ?? <None />}
          </Fact>
          <Fact label="DM closer">
            <Member identity={dmAttribution.dmCloser} name={dmAttribution.dmCloserName} />
          </Fact>
          <Fact label={<HelpTip tip="The setter who qualified the lead in Slack most recently, and how many setters did in all.">Slack</HelpTip>}>
            {slackContributorSummary.count > 0 ? (
              <>
                {slackContributorSummary.latestLabel}{" "}
                <span className="text-muted-foreground">
                  · <span className="font-condensed text-[15px] font-semibold tabular-nums">{slackContributorSummary.count}</span> in all
                </span>
              </>
            ) : (
              <None />
            )}
          </Fact>
        </FactCard>

        <FactCard title="Review">
          <Fact label="Reviewer">
            <Member identity={review.reviewer} name={review.reviewerName} />
          </Fact>
          <Fact label="Reviewed at">
            {review.reviewedAt ? <span className={FIGURE}>{formatPaidAt(review.reviewedAt, now)}</span> : <None>Not yet</None>}
          </Fact>
        </FactCard>
      </div>
    </div>
  );
}

/** The h1: the customer's name, then email, then "Missing customer". */
export function paymentTitle(detail: BillingPaymentDetail) {
  return customerName({ fullName: detail.customer.fullName, email: detail.customer.email }) ?? "Missing customer";
}
