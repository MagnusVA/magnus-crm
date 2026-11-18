"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useMutation, usePreloadedQuery, useQuery, type Preloaded } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { CheckIcon, CopyIcon, LinkIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useRole } from "@/components/auth/role-context";
import { TranslatableText } from "@/components/translatable-text";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { usePageTitle } from "@/hooks/use-page-title";
import { useNow } from "@/hooks/use-now";
import { formatAmountMinor } from "@/lib/format-currency";
import { getErrorCode } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { PageBand } from "@/app/workspace/_components/page-band";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { DetailCard, detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { LeadCombobox } from "@/app/workspace/opportunities/new/_components/lead-combobox";
import { FIGURE, formatPaidAt, PAYMENT_TYPE_LABELS, STATUS_WORD } from "../../_components/billing-format";
import { PaidAt } from "../../_components/paid-at";
import {
  ADVERSE_STATE_LABELS,
  dealStageLabel,
  DISMISS_REASON_LABELS,
  MAPPING_REASONS,
  paymentMethodLabel,
  PROVIDER_STATUS_LABELS,
  providerErrorMessage,
  reasonSentence,
  UNKNOWN_PAYER_NOTE,
  WHOP_SETTINGS_HREF,
  WHOP_VIEW_HREF,
  type ProviderDismissReason,
  type ProviderReviewReason,
} from "../../_components/whop-format";

const BACK = { href: WHOP_VIEW_HREF, label: "From Whop" };
const PAGE = "@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3";
const MONO = "font-mono text-[12.5px] tracking-[-0.01em]";
const NOT_A_CRM_PAYMENT = "This is not a CRM payment yet and is in no cash total.";

type Detail = NonNullable<FunctionReturnType<typeof api.payments.review.getProviderPayment>>;
type ProviderPayment = Detail["payment"];
type ManualPayment = Detail["manualPayments"][number];

function whopAmount(payment: Pick<Doc<"providerPayments">, "totalMinor" | "currency">) {
  return payment.totalMinor !== undefined ? formatAmountMinor(payment.totalMinor, payment.currency) : null;
}

/** The reason the payment waits, from the matcher's answer now, else the stored one. */
function currentReason(detail: Detail): ProviderReviewReason | null {
  const { classification, payment } = detail;
  if (classification.kind === "ready") return "ready";
  if (classification.kind === "needs_person") return classification.reason;
  return payment.reviewReason ?? null;
}

/** Who took the last review action, by name, from the team list. */
function useResolverName(userId: Id<"users"> | undefined) {
  const members = useQuery(api.users.queries.listTeamMembers, userId ? {} : "skip");
  if (!userId) return null;
  if (members === undefined) return undefined;
  const member = members.find((row) => row._id === userId);
  return member ? member.fullName?.trim() || member.email : null;
}

export function WhopPaymentPageClient({
  preloadedPayment,
}: {
  preloadedPayment: Preloaded<typeof api.payments.review.getProviderPayment>;
}) {
  const now = useNow();
  const detail = usePreloadedQuery(preloadedPayment);
  const amount = detail ? (whopAmount(detail.payment) ?? detail.payment.currency.toUpperCase()) : null;
  usePageTitle(`Billing · Whop ${amount ?? "payment"}`);

  if (!detail) {
    return (
      <div className={PAGE}>
        <PageBand back={BACK} title="Whop payment not found" description="Billing can’t show this Whop payment." />
        <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
          <SectionEmpty title="This Whop payment doesn’t exist in this workspace.">
            The link may point to another workspace.
          </SectionEmpty>
        </div>
      </div>
    );
  }

  const { payment } = detail;
  const product = [payment.productTitle, payment.variantTitle].filter(Boolean).join(" · ");

  return (
    <div className={PAGE}>
      <PageBand
        back={BACK}
        title={`${amount} from Whop`}
        description={
          <>
            {payment.paidAt !== undefined ? (
              <>
                Collected <PaidAt at={payment.paidAt} now={now} />
              </>
            ) : (
              <>
                Reported <PaidAt at={payment.firstSeenAt} now={now} />
              </>
            )}
            {product ? (
              <>
                {" · "}
                <span translate="no">{product}</span>
              </>
            ) : null}
            {" · "}
            {payment.paymentRecordId ? "Evidence for a CRM payment" : "Not a CRM payment, in no cash total"}
          </>
        }
      />

      {/*
        From @4xl a main column (Where it stands, then Link) and a 24rem rail
        (What Whop reports, then Not CRM money). Narrower, one column in
        reading order: what Whop reports, where it stands, link, dismiss.
      */}
      <div className="grid min-w-0 items-start gap-x-[18px] gap-y-3.5 @4xl:grid-cols-[minmax(0,1fr)_24rem] short:gap-y-3">
        <div className="contents @4xl:col-start-2 @4xl:row-start-1 @4xl:flex @4xl:min-w-0 @4xl:flex-col @4xl:gap-3.5 short:@4xl:gap-3">
          <div className="order-1 min-w-0">
            <WhopReportsCard payment={payment} now={now} />
          </div>
          <div className="order-4 min-w-0">
            <NotCrmMoneyCard payment={payment} now={now} />
          </div>
        </div>
        <div className="contents @4xl:col-start-1 @4xl:row-start-1 @4xl:flex @4xl:min-w-0 @4xl:flex-col @4xl:gap-3.5 short:@4xl:gap-3">
          <div className="order-2 min-w-0">
            <WhereItStandsCard detail={detail} now={now} />
          </div>
          <div className="order-3 min-w-0">
            <LinkCard detail={detail} now={now} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Facts ──────────────────────────────────────────────────────────────

function None({ children = "None" }: { children?: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function Facts({ children }: { children: ReactNode }) {
  return <dl className="border-b py-1 last:border-b-0">{children}</dl>;
}

function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-h-8 grid-cols-[6.875rem_minmax(0,1fr)] items-baseline gap-x-3 px-4 py-1.5">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 wrap-break-word">{children}</dd>
    </div>
  );
}

function CopyIdButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success("Copied the Whop payment ID.");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy. Select the ID and copy it by hand.");
    }
  };
  return (
    <Button type="button" variant="outline" size="xs" onClick={() => void copy()} aria-label="Copy the Whop payment ID">
      {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
      <TranslatableText>{copied ? "Copied" : "Copy"}</TranslatableText>
    </Button>
  );
}

/** (1) What Whop reports: the fact as Whop states it. */
function WhopReportsCard({ payment, now }: { payment: ProviderPayment; now: number }) {
  const amount = whopAmount(payment);
  const adverse = ADVERSE_STATE_LABELS[payment.adverseState];
  const method = paymentMethodLabel(payment.paymentMethodType);
  const charged =
    payment.buyerChargedMinor !== undefined && payment.buyerChargedCurrency && payment.buyerChargedCurrency !== payment.currency
      ? formatAmountMinor(payment.buyerChargedMinor, payment.buyerChargedCurrency)
      : null;

  return (
    <DetailCard title="What Whop reports">
      <Facts>
        <Fact label="Amount">
          {amount ? (
            <span className={FIGURE}>{amount}</span>
          ) : (
            <None>Not readable in {payment.currency.toUpperCase()}</None>
          )}{" "}
          <span className="text-[13px] text-muted-foreground">{payment.currency.toUpperCase()}</span>
          {charged ? <p className="text-[13px] text-muted-foreground">The buyer was charged {charged}.</p> : null}
        </Fact>
        <Fact label="Collected">
          {payment.paidAt !== undefined ? (
            <span className={FIGURE}>
              <PaidAt at={payment.paidAt} now={now} />
            </span>
          ) : (
            <None>Not collected</None>
          )}
        </Fact>
        <Fact label="Status">
          {PROVIDER_STATUS_LABELS[payment.status]}
          {payment.failedAttemptCount > 0 ? (
            <span className="text-muted-foreground">
              {" · "}
              {payment.failedAttemptCount === 1 ? "1 failed attempt" : `${payment.failedAttemptCount} failed attempts`}
            </span>
          ) : null}
        </Fact>
        {adverse ? (
          <Fact label="Refund or dispute">
            <span className="font-medium text-danger-ink">{adverse}</span>
            {payment.refundedMinor > 0 ? (
              <span className="text-muted-foreground">
                {" · "}
                <span className={FIGURE}>{formatAmountMinor(payment.refundedMinor, payment.currency)}</span> refunded
              </span>
            ) : null}
          </Fact>
        ) : null}
      </Facts>
      <Facts>
        <Fact label="Product">{payment.productTitle ? <span translate="no">{payment.productTitle}</span> : <None />}</Fact>
        <Fact label="Price">{payment.variantTitle ? <span translate="no">{payment.variantTitle}</span> : <None />}</Fact>
        <Fact label="Paid with">
          {method ?? <None>Not shown</None>}
          {payment.financingInstallmentsCount ? (
            <span className="text-muted-foreground"> · financed over {payment.financingInstallmentsCount} instalments</span>
          ) : null}
        </Fact>
        {payment.lineItemCount > 1 ? <Fact label="Items">{payment.lineItemCount} items in one checkout</Fact> : null}
      </Facts>
      <Facts>
        <Fact label="Payer email">
          {payment.payerEmail ? (
            <span className="[overflow-wrap:anywhere]" translate="no">
              {payment.payerEmail}
            </span>
          ) : payment.payerDetailsClearedAt !== undefined ? (
            <None>Cleared 90 days after review</None>
          ) : (
            <None>Not sent</None>
          )}
        </Fact>
        <Fact label="Whop ID">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className={cn(MONO, "break-all text-muted-foreground")}>{payment.externalPaymentId}</span>
            <CopyIdButton value={payment.externalPaymentId} />
          </span>
        </Fact>
      </Facts>
    </DetailCard>
  );
}

// ─── Where it stands ────────────────────────────────────────────────────

const STATE_WORDS: Record<ProviderPayment["reviewState"], { word: string; ink: string }> = {
  needs_person: { word: "Needs a person", ink: "text-warning-ink" },
  linked: { word: "Linked", ink: "text-muted-foreground" },
  recorded: { word: "Recorded", ink: "text-muted-foreground" },
  dismissed: { word: "Dismissed", ink: "text-muted-foreground" },
  not_actionable: { word: "Nothing to do", ink: "text-muted-foreground" },
  historical: { word: "History", ink: "text-muted-foreground" },
};

function CandidateDeals({ detail, now }: { detail: Detail; now: number }) {
  const { candidatePerson, candidateDeals } = detail;
  if (!candidatePerson) return null;
  return (
    <div className="border-t py-1">
      <div className="flex min-h-8 flex-wrap items-baseline gap-x-2 px-4 py-1.5">
        <span className="text-[13px] text-muted-foreground">Person</span>
        <Link href={`/workspace/leads-customers/${candidatePerson.leadId}`} className={detailLinkClass} translate="no">
          {candidatePerson.displayName}
        </Link>
      </div>
      {candidateDeals.length > 0 ? (
        <ul aria-label="Candidate deals">
          {candidateDeals.map((deal) => (
            <li key={deal.opportunityId} className="flex min-h-8 flex-wrap items-baseline gap-x-2 px-4 py-1.5">
              <Link href={`/workspace/opportunities/${deal.opportunityId}`} className={detailLinkClass}>
                {dealStageLabel(deal.stage, deal.outcome)}
                {deal.programName ? ` · ${deal.programName}` : ""}
              </Link>
              <span className="text-[13px] text-muted-foreground">
                {deal.latestMeetingAt !== null ? (
                  <>
                    call <span className="font-condensed text-[14px] font-semibold tabular-nums">{formatPaidAt(deal.latestMeetingAt, now)}</span>
                  </>
                ) : (
                  <>
                    created <span className="font-condensed text-[14px] font-semibold tabular-nums">{formatPaidAt(deal.createdAt, now)}</span>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-1.5 text-[13px] text-muted-foreground">No candidate deal.</p>
      )}
    </div>
  );
}

/** (2) Where it stands: why it waits, or how it was settled. */
function WhereItStandsCard({ detail, now }: { detail: Detail; now: number }) {
  const { payment } = detail;
  const state = STATE_WORDS[payment.reviewState];
  const resolver = useResolverName(payment.resolvedByUserId);
  const reason = currentReason(detail);

  const byLine =
    payment.resolvedAt !== undefined ? (
      <p className="text-[13px] text-muted-foreground">
        {resolver ? <span translate="no">{resolver}</span> : resolver === undefined ? "…" : "Someone"}
        {" · "}
        <span className="font-condensed text-[14px] font-semibold tabular-nums">
          <PaidAt at={payment.resolvedAt} now={now} />
        </span>
      </p>
    ) : null;

  let body: ReactNode;
  switch (payment.reviewState) {
    case "needs_person":
      body = (
        <>
          <p className="text-[15px] font-medium">
            {reasonSentence(reason)}
            {reason && MAPPING_REASONS.has(reason) ? (
              <>
                {" "}
                <Link href={WHOP_SETTINGS_HREF} className={cn(detailLinkClass, "inline font-normal")}>
                  Map it in Settings › Whop
                </Link>
              </>
            ) : null}
          </p>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{NOT_A_CRM_PAYMENT}</p>
        </>
      );
      break;
    case "linked":
      body = (
        <>
          <p className="text-[15px] font-medium">This Whop payment is the evidence for a payment a person recorded.</p>
          {byLine}
          <LinkedPaymentLine payment={payment} />
        </>
      );
      break;
    case "recorded":
      body = (
        <>
          <p className="text-[15px] font-medium">A CRM payment was recorded from this Whop payment.</p>
          {byLine}
          <LinkedPaymentLine payment={payment} />
        </>
      );
      break;
    case "dismissed":
      body = (
        <>
          <p className="text-[15px] font-medium">
            Dismissed: {payment.dismissReason ? DISMISS_REASON_LABELS[payment.dismissReason].toLowerCase() : "no reason given"}.
          </p>
          {byLine}
        </>
      );
      break;
    case "historical":
      body = (
        <p className="text-[15px] font-medium">
          Whop collected this before the account was connected. It is shown here and never proposed.
        </p>
      );
      break;
    default:
      body = (
        <p className="text-[15px] font-medium">
          {payment.status === "paid"
            ? "Whop reports nothing collected, so there is nothing to do."
            : "Whop has not marked this paid, so there is nothing to do yet."}
        </p>
      );
  }

  return (
    <DetailCard title="Where it stands" meta={<span className={cn(STATUS_WORD, state.ink)}>{state.word}</span>}>
      <div className="px-4 py-3">{body}</div>
      {payment.reviewState === "needs_person" ? <CandidateDeals detail={detail} now={now} /> : null}
    </DetailCard>
  );
}

/** The linked CRM payment, and Unlink for a link a person made. */
function LinkedPaymentLine({ payment }: { payment: ProviderPayment }) {
  const { hasPermission } = useRole();
  const unlink = useMutation(api.payments.review.unlinkPaymentRecord);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!payment.paymentRecordId) return null;
  const canUnlink = payment.reviewState === "linked" && hasPermission("billing:correct");

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      await unlink({ providerPaymentId: payment._id });
      toast.success("Unlinked. The CRM payment no longer has this Whop payment as evidence.");
      setConfirming(false);
    } catch (caught) {
      setError(providerErrorMessage(caught, "Couldn't unlink. Try again."));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link href={`/workspace/billing/${payment.paymentRecordId}`} className={cn(detailLinkClass, "gap-1")}>
          <LinkIcon aria-hidden="true" className="size-3.5" />
          Open the CRM payment
        </Link>
        {canUnlink && !confirming ? (
          <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => setConfirming(true)}>
            Unlink
          </Button>
        ) : null}
      </div>
      {canUnlink && confirming ? (
        <div className="flex flex-col gap-2 rounded-[7px] border bg-muted/40 p-3">
          <p className="text-[13px]">
            Unlinking changes no amount, date, credit or report. The CRM payment keeps counting, and this Whop payment goes back to the list.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="destructive" disabled={pending} onClick={() => void submit()}>
              {pending ? <Spinner data-icon="inline-start" /> : null}
              <TranslatableText>Unlink</TranslatableText>
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-[13px] text-danger-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ─── Link to a payment already recorded ─────────────────────────────────

/** (3) Link: pick the person's CRM payment this Whop payment proves. */
function LinkCard({ detail, now }: { detail: Detail; now: number }) {
  const { hasPermission } = useRole();
  const { payment, candidatePerson } = detail;
  const [choosingOther, setChoosingOther] = useState(false);
  const [pickedLeadId, setPickedLeadId] = useState<Id<"leads"> | undefined>(undefined);

  const open = payment.reviewState === "needs_person" || payment.reviewState === "historical";
  if (!open || payment.status !== "paid" || payment.paymentRecordId || !hasPermission("billing:review")) return null;

  const picking = candidatePerson === null || choosingOther;
  const leadId = picking ? pickedLeadId : candidatePerson.leadId;

  return (
    <DetailCard title="Link to a payment already recorded">
      <div className="flex flex-col gap-3 px-4 py-3">
        {picking ? (
          <Field>
            <FieldLabel htmlFor={`whop-person-${payment._id}`}>Person</FieldLabel>
            <LeadCombobox id={`whop-person-${payment._id}`} value={pickedLeadId} onChange={setPickedLeadId} />
            <FieldDescription className="text-[13px]">{UNKNOWN_PAYER_NOTE}</FieldDescription>
            {candidatePerson ? (
              <button
                type="button"
                className={cn(detailLinkClass, "w-fit text-[13px] font-normal")}
                onClick={() => {
                  setChoosingOther(false);
                  setPickedLeadId(undefined);
                }}
              >
                Back to {candidatePerson.displayName}
              </button>
            ) : null}
          </Field>
        ) : (
          <p className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-muted-foreground">
            <span>
              Payments recorded for{" "}
              <span className="font-medium text-foreground" translate="no">
                {candidatePerson.displayName}
              </span>{" "}
              with no Whop evidence yet.
            </span>
            <button type="button" className={cn(detailLinkClass, "font-normal")} onClick={() => setChoosingOther(true)}>
              Pick someone else
            </button>
          </p>
        )}
      </div>
      {leadId ? (
        <ManualPaymentChoice
          key={leadId}
          detail={detail}
          leadId={leadId}
          fromPage={!picking}
          now={now}
        />
      ) : (
        <p className="border-t px-4 py-3 text-[13px] text-muted-foreground">
          Pick the person to see the payments recorded for them.
        </p>
      )}
    </DetailCard>
  );
}

function ManualPaymentChoice({
  detail,
  leadId,
  fromPage,
  now,
}: {
  detail: Detail;
  leadId: Id<"leads">;
  /** True for the candidate person, whose payments came with the page. */
  fromPage: boolean;
  now: number;
}) {
  const { payment } = detail;
  const picked = useQuery(
    api.payments.review.getProviderPayment,
    fromPage ? "skip" : { providerPaymentId: payment._id, leadId },
  );
  const source = fromPage ? detail : picked;
  const link = useMutation(api.payments.review.linkToPaymentRecord);
  const [selected, setSelected] = useState<Id<"paymentRecords"> | null>(null);
  const [mismatch, setMismatch] = useState<ManualPayment | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const whop = whopAmount(payment);

  if (source === undefined) {
    return (
      <p role="status" className="border-t px-4 py-3 text-[13px] text-muted-foreground">
        Loading the payments recorded for this person…
      </p>
    );
  }
  if (source === null) {
    return (
      <p role="alert" className="border-t px-4 py-3 text-[13px] text-danger-ink">
        This Whop payment is no longer in this workspace.
      </p>
    );
  }

  const options = source.manualPayments;
  const choice = options.find((row) => row.paymentRecordId === selected) ?? null;

  const submit = async (acknowledgeAmountDifference: boolean) => {
    if (!choice) return;
    setPending(true);
    setError(null);
    try {
      await link({ providerPaymentId: payment._id, paymentRecordId: choice.paymentRecordId, acknowledgeAmountDifference });
      setMismatch(null);
      toast.success("Linked. The CRM payment now has this Whop payment as its evidence.");
    } catch (caught) {
      if (getErrorCode(caught) === "provider_payment.amount_mismatch" && !acknowledgeAmountDifference) {
        setMismatch(choice);
      } else {
        setMismatch(null);
        setError(providerErrorMessage(caught, "Couldn't link. Try again."));
      }
    } finally {
      setPending(false);
    }
  };

  if (options.length === 0) {
    return (
      <SectionEmpty className="border-t" title="This person has no recorded payment without Whop evidence.">
        A payment someone recorded by hand shows here until it has Whop evidence. Disputed payments are left out.
      </SectionEmpty>
    );
  }

  return (
    <div className="border-t">
      <RadioGroup
        value={selected ?? ""}
        onValueChange={(value) => {
          setSelected(value as Id<"paymentRecords">);
          setMismatch(null);
          setError(null);
        }}
        aria-label="CRM payment to link"
        className="gap-0"
      >
        {options.map((row) => {
          const id = `whop-link-${row.paymentRecordId}`;
          const differs =
            row.currency !== payment.currency
              ? "Different currency"
              : payment.totalMinor !== undefined && row.amountMinor !== payment.totalMinor
                ? "Different amount"
                : null;
          return (
            <label
              key={row.paymentRecordId}
              htmlFor={id}
              className="flex min-h-12 cursor-pointer items-start gap-3 border-b px-4 py-2.5 hover:bg-muted/60 has-[[data-state=checked]]:bg-muted/60"
            >
              <RadioGroupItem value={row.paymentRecordId} id={id} className="mt-1" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className={FIGURE}>{formatAmountMinor(row.amountMinor, row.currency)}</span>
                  <span>{PAYMENT_TYPE_LABELS[row.paymentType]}</span>
                  <span className="text-muted-foreground" translate="no">
                    · {row.programName}
                  </span>
                  {differs ? <span className="text-[13px] font-medium text-warning-ink">{differs}</span> : null}
                </span>
                <span className="text-[13px] text-muted-foreground">
                  Recorded{" "}
                  <span className="font-condensed text-[14px] font-semibold tabular-nums">{formatPaidAt(row.recordedAt, now)}</span>
                  {row.recordedByName ? (
                    <>
                      {" by "}
                      <span translate="no">{row.recordedByName}</span>
                    </>
                  ) : null}
                </span>
              </span>
            </label>
          );
        })}
      </RadioGroup>
      {source.manualPaymentsCapped ? (
        <p className="border-b px-4 py-2 text-[13px] text-muted-foreground">
          Showing the most recent payments. Older ones are not listed.
        </p>
      ) : null}

      <div className="flex flex-col gap-2.5 px-4 py-3">
        {mismatch ? (
          <div role="alert" className="flex flex-col gap-2.5 rounded-[7px] border border-warning/60 bg-warning-surface p-3">
            <p className="text-[14px] font-medium">
              Whop collected <span className={FIGURE}>{whop ?? payment.currency.toUpperCase()}</span>. The CRM payment says{" "}
              <span className={FIGURE}>{formatAmountMinor(mismatch.amountMinor, mismatch.currency)}</span>.
            </p>
            <p className="text-[13px] text-muted-foreground">
              Linking keeps the CRM amount. It records that this Whop payment is the proof for that payment.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={pending} onClick={() => void submit(true)} className="font-semibold">
                {pending ? <Spinner data-icon="inline-start" /> : null}
                <TranslatableText>Link anyway</TranslatableText>
              </Button>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setMismatch(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-[13px] text-muted-foreground">
              Linking changes no amount, date, credit or report. It records that this Whop payment is the proof for that payment.
            </p>
            <Button
              type="button"
              className="w-fit font-semibold"
              disabled={!choice || pending}
              onClick={() => void submit(false)}
            >
              {pending ? <Spinner data-icon="inline-start" /> : <LinkIcon aria-hidden="true" data-icon="inline-start" />}
              <TranslatableText>Link as evidence</TranslatableText>
            </Button>
          </>
        )}
        {error ? (
          <p role="alert" className="text-[13px] text-danger-ink">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ─── Not CRM money ──────────────────────────────────────────────────────

const DISMISS_REASONS = Object.keys(DISMISS_REASON_LABELS) as ProviderDismissReason[];

/** (4) Not CRM money: dismiss it, or reopen a dismissed one. */
function NotCrmMoneyCard({ payment, now }: { payment: ProviderPayment; now: number }) {
  const { hasPermission } = useRole();
  const dismiss = useMutation(api.payments.review.dismissProviderPayment);
  const reopen = useMutation(api.payments.review.reopenProviderPayment);
  const resolver = useResolverName(payment.reviewState === "dismissed" ? payment.resolvedByUserId : undefined);
  const [reason, setReason] = useState<ProviderDismissReason | "">("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canDismiss = payment.reviewState === "needs_person" && !payment.paymentRecordId && hasPermission("billing:review");
  const dismissed = payment.reviewState === "dismissed";
  if (!canDismiss && !dismissed) return null;
  const canReopen = dismissed && hasPermission("billing:correct");

  const run = async (action: () => Promise<unknown>, done: string, fallback: string) => {
    setPending(true);
    setError(null);
    try {
      await action();
      toast.success(done);
      setReason("");
    } catch (caught) {
      setError(providerErrorMessage(caught, fallback));
    } finally {
      setPending(false);
    }
  };

  const selectId = `whop-dismiss-${payment._id}`;

  return (
    <DetailCard title="Not CRM money">
      <div className="flex flex-col gap-2.5 px-4 py-3">
        {dismissed ? (
          <>
            <p className="text-[14px]">
              Dismissed by{" "}
              <span className="font-medium" translate="no">
                {resolver ?? (resolver === undefined ? "…" : "someone")}
              </span>
              {payment.resolvedAt !== undefined ? (
                <>
                  {" · "}
                  <span className="font-condensed text-[15px] font-semibold tabular-nums">
                    <PaidAt at={payment.resolvedAt} now={now} />
                  </span>
                </>
              ) : null}
            </p>
            <p className="text-[13px] text-muted-foreground">
              {payment.dismissReason ? DISMISS_REASON_LABELS[payment.dismissReason] : "No reason given"}.
            </p>
            {canReopen ? (
              <Button
                type="button"
                variant="outline"
                className="w-fit"
                disabled={pending}
                onClick={() =>
                  void run(
                    () => reopen({ providerPaymentId: payment._id }),
                    "Reopened. The Whop payment is back on the list.",
                    "Couldn't reopen. Try again.",
                  )
                }
              >
                {pending ? <Spinner data-icon="inline-start" /> : null}
                <TranslatableText>Reopen</TranslatableText>
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <p className="text-[13px] text-muted-foreground">
              Dismiss a payment that is not money for a deal here. It stays on record, leaves the list, and can be reopened.
            </p>
            <Field>
              <FieldLabel htmlFor={selectId}>Reason</FieldLabel>
              <Select value={reason} onValueChange={(value) => setReason(value as ProviderDismissReason)}>
                <SelectTrigger id={selectId} className="w-full">
                  <SelectValue placeholder="Choose a reason" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {DISMISS_REASONS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {DISMISS_REASON_LABELS[value]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Button
              type="button"
              variant="outline"
              className="w-fit"
              disabled={reason === "" || pending}
              onClick={() => {
                if (reason === "") return;
                void run(
                  () => dismiss({ providerPaymentId: payment._id, reason }),
                  "Dismissed. The Whop payment left the list.",
                  "Couldn't dismiss. Try again.",
                );
              }}
            >
              {pending ? <Spinner data-icon="inline-start" /> : null}
              <TranslatableText>Dismiss</TranslatableText>
            </Button>
          </>
        )}
        {error ? (
          <p role="alert" className="text-[13px] text-danger-ink">
            {error}
          </p>
        ) : null}
      </div>
    </DetailCard>
  );
}
