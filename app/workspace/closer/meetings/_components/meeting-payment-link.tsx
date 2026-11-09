"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";
import { isAwaitingOutcome } from "@/lib/deal-controls";
import { usePaymentLink } from "@/app/workspace/closer/_components/use-payment-link";
import type { MeetingDetail } from "./meeting-detail-types";

const PaymentFormDialog = dynamic(() =>
  import("./payment-form-dialog").then((m) => ({ default: m.PaymentFormDialog })),
);

/**
 * Opens the meeting's payment dialog with a payment link's values
 * (`/workspace/closer/meetings/<id>?logPayment=1&amount=…`,
 * docs/plans/closer-assistant.md §6.3). Mount once on the closer's meeting
 * page.
 */
export function MeetingPaymentLink(props: {
  detail: MeetingDetail;
  onStatusChanged?: () => Promise<void>;
}) {
  // useSearchParams needs a boundary of its own.
  return (
    <Suspense fallback={null}>
      <MeetingPaymentLinkDialog {...props} />
    </Suspense>
  );
}

function MeetingPaymentLinkDialog({
  detail,
  onStatusChanged,
}: {
  detail: MeetingDetail;
  onStatusChanged?: () => Promise<void>;
}) {
  const { meeting, opportunity, lead, activeFollowUp } = detail;
  // As the outcome section decides; the mutation checks the deal again.
  const canPay =
    meeting.status === "scheduled" && isAwaitingOutcome(opportunity) && activeFollowUp === null;
  const { prefill, close } = usePaymentLink(canPay);
  if (!prefill) return null;

  return (
    <PaymentFormDialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      opportunityId={opportunity._id}
      meetingId={meeting._id}
      onSuccess={onStatusChanged}
      leadName={lead.fullName ?? lead.email ?? null}
      defaultProgramId={meeting.bookingProgramId ?? opportunity.firstBookingProgramId ?? null}
      prefill={prefill}
    />
  );
}
