"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { CheckCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { BillingPaymentStatus } from "@/convex/billing/types";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export function BillingReviewActions({
  paymentRecordId,
  status,
}: {
  paymentRecordId: Id<"paymentRecords">;
  status: BillingPaymentStatus;
}) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const markReviewed = useMutation(api.billing.mutations.markReviewed);
  const next = useQuery(api.billing.queries.getNextPaymentForReview, {
    currentPaymentRecordId: paymentRecordId,
  });

  if (status !== "recorded") {
    return null;
  }

  const submit = async () => {
    setIsSubmitting(true);
    try {
      await markReviewed({ paymentRecordId });
      toast.success("Payment marked reviewed.");
      if (next?.paymentRecordId && next.paymentRecordId !== paymentRecordId) {
        router.push(`/workspace/billing/${next.paymentRecordId}`);
      } else {
        router.refresh();
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to mark reviewed.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Button disabled={isSubmitting} onClick={submit}>
      {isSubmitting ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <CheckCircleIcon aria-hidden="true" data-icon="inline-start" />
      )}
      Mark reviewed
    </Button>
  );
}
