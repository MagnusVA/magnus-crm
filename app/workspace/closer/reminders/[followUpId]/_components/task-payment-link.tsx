"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";
import { isReminderDealFinished } from "@/lib/deal-controls";
import { usePaymentLink } from "@/app/workspace/closer/_components/use-payment-link";
import type { TaskDetail } from "./task-detail-types";

const ReminderPaymentDialog = dynamic(() =>
  import("./reminder-payment-dialog").then((m) => ({ default: m.ReminderPaymentDialog })),
);

/**
 * Opens the task's payment dialog with a payment link's values
 * (`/workspace/closer/reminders/<id>?logPayment=1&amount=…`,
 * docs/plans/closer-assistant.md §6.3). Mount once on the closer's task
 * pane.
 */
export function TaskPaymentLink(props: { detail: TaskDetail; onCompleted: () => void }) {
  // useSearchParams needs a boundary of its own.
  return (
    <Suspense fallback={null}>
      <TaskPaymentLinkDialog {...props} />
    </Suspense>
  );
}

function TaskPaymentLinkDialog({
  detail,
  onCompleted,
}: {
  detail: TaskDetail;
  onCompleted: () => void;
}) {
  const { followUp, opportunity, lead } = detail;
  // As the task's outcome section decides; the mutation checks it again.
  const canPay =
    followUp.status === "pending" &&
    followUp.type === "manual_reminder" &&
    followUp.reason !== "stale_opportunity_nudge" &&
    !isReminderDealFinished(opportunity);
  const { prefill, close } = usePaymentLink(canPay);
  if (!prefill) return null;

  return (
    <ReminderPaymentDialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      onSuccess={onCompleted}
      followUpId={followUp._id}
      leadName={lead.fullName ?? lead.email ?? null}
      defaultProgramId={opportunity.firstBookingProgramId ?? null}
      prefill={prefill}
    />
  );
}
