"use client";

import { Suspense, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { usePreloadedQuery, type Preloaded } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useRouter } from "next/navigation";
import { PencilIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { MeetingComments } from "@/app/workspace/closer/meetings/_components/meeting-comments";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { PageBand } from "@/app/workspace/_components/page-band";
import { usePageTitle } from "@/hooks/use-page-title";
import { useNow } from "@/hooks/use-now";
import { BillingEventHistory } from "./billing-event-history";
import { BAND_BUTTON_CLASS, PAYMENT_TYPE_LABELS } from "./billing-format";
import { PaymentFacts, PaymentFigures, paymentTitle } from "./billing-payment-facts";
import { PaidAt } from "./paid-at";
import { BillingProofPreview } from "./billing-proof-preview";
import { BillingReviewActions } from "./billing-review-actions";
import { CopyBillingPayloadButton } from "./copy-billing-payload-button";
import { ReusedProofCard } from "./payment-provenance-markers";
import { SlackContributorTimeline } from "./slack-contributor-timeline";

const CorrectionDialog = dynamic(() =>
  import("./correction-dialog").then((m) => ({ default: m.CorrectionDialog })),
);

const BACK = { href: "/workspace/billing", label: "Billing" };
const PAGE = "@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3";

function BillingMeetingComments({ meetingId }: { meetingId: Id<"meetings"> | null }) {
  if (meetingId) {
    return <MeetingComments meetingId={meetingId} />;
  }
  return (
    <DetailCard title="Comments">
      <SectionEmpty title="No linked meeting.">Comments appear here when the payment is tied to a meeting.</SectionEmpty>
    </DetailCard>
  );
}

type BillingPayment = NonNullable<FunctionReturnType<typeof api.billing.queries.getPaymentDetail>>["payment"];

/**
 * "Correct payment" and its dialog. The dialog's code and its programs query
 * load on the first opening; each opening remounts it (a new `key`) so the
 * form starts from the payment as it is now.
 */
function CorrectPaymentButton({ payment }: { payment: BillingPayment }) {
  const router = useRouter();
  const [dialog, setDialog] = useState({ open: false, key: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (payment.status === "disputed") {
    return null;
  }

  return (
    <>
      <Button
        ref={triggerRef}
        variant="outline"
        className={BAND_BUTTON_CLASS}
        aria-haspopup="dialog"
        aria-expanded={dialog.open}
        onClick={() => setDialog((prev) => ({ open: true, key: prev.key + 1 }))}
      >
        <PencilIcon aria-hidden="true" data-icon="inline-start" />
        Correct payment
      </Button>
      {/* The dialog suspends on its first render; this boundary keeps that
          wait to the dialog. */}
      <Suspense fallback={null}>
        {dialog.key > 0 ? (
          <CorrectionDialog
            key={dialog.key}
            payment={payment}
            open={dialog.open}
            onOpenChange={(open) => setDialog((prev) => ({ ...prev, open }))}
            triggerRef={triggerRef}
            onCorrected={(result) => {
              toast.success(
                !result.changed
                  ? "No payment changes to save."
                  : result.returnedToReview
                    ? "Payment corrected and returned to review."
                    : "Payment corrected.",
              );
              router.refresh();
            }}
          />
        ) : null}
      </Suspense>
    </>
  );
}

export function BillingReviewPageClient({
  preloadedPayment,
}: {
  preloadedPayment: Preloaded<typeof api.billing.queries.getPaymentDetail>;
}) {
  const now = useNow();
  const detail = usePreloadedQuery(preloadedPayment);
  const titleName = detail?.customer.fullName ?? detail?.customer.email ?? detail?.payment.id ?? "Payment";
  usePageTitle(`Billing — ${titleName}`);

  if (!detail) {
    return (
      <div className={PAGE}>
        <PageBand back={BACK} title="Payment not found" description="Billing can’t show this payment." />
        <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
          <SectionEmpty title="This payment doesn’t exist in this workspace.">
            It may have been removed, or the link points to another workspace.
          </SectionEmpty>
        </div>
      </div>
    );
  }

  const { payment } = detail;
  const needsReview = payment.status === "recorded";

  return (
    <div className={PAGE}>
      <PageBand
        back={BACK}
        title={<span translate="no">{paymentTitle(detail)}</span>}
        description={
          <>
            Paid <PaidAt at={payment.recordedAt} now={now} /> · {payment.programName} ·{" "}
            {PAYMENT_TYPE_LABELS[payment.paymentType]}
          </>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <CopyBillingPayloadButton detail={detail} className={BAND_BUTTON_CLASS} />
            <CorrectPaymentButton payment={payment} />
            {needsReview ? (
              <BillingReviewActions
                paymentRecordId={payment.id}
                status={payment.status}
                className="h-[34px] rounded-[7px] px-3 text-[13px] font-semibold"
              />
            ) : null}
          </div>
        }
      >
        <PaymentFigures detail={detail} />
      </PageBand>

      {/*
        From @4xl a main column (the fact cards with the proof, then History)
        and a 24rem rail (Comments, then Slack contributors). Narrower, one
        column: facts, comments, history, Slack contributors.
      */}
      <div className="grid min-w-0 items-start gap-x-[18px] gap-y-3.5 @4xl:grid-cols-[minmax(0,1fr)_24rem] short:gap-y-3">
        <div className="order-1 min-w-0 @4xl:col-start-1 @4xl:row-start-1">
          <PaymentFacts
            detail={detail}
            now={now}
            proof={
              <>
                <BillingProofPreview proof={detail.proof} owed={needsReview} />
                <ReusedProofCard detail={detail} now={now} />
              </>
            }
          />
        </div>
        <div className="contents @4xl:col-start-2 @4xl:row-span-2 @4xl:row-start-1 @4xl:flex @4xl:min-w-0 @4xl:flex-col @4xl:gap-3.5 short:@4xl:gap-3">
          <div className="order-2 min-w-0">
            <BillingMeetingComments meetingId={detail.meeting.id} />
          </div>
          <div className="order-4 min-w-0">
            <SlackContributorTimeline events={detail.slackContributorTimeline} now={now} />
          </div>
        </div>
        <div className="order-3 min-w-0 @4xl:col-start-1 @4xl:row-start-2">
          <BillingEventHistory events={detail.events} now={now} />
        </div>
      </div>
    </div>
  );
}
