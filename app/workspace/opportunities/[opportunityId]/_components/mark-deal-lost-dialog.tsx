"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { XCircleIcon } from "lucide-react";
import posthog from "@/lib/posthog-browser";
import { reportClientError } from "@/lib/observability/report-client-error";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getErrorMessage } from "@/lib/errors";
import { LostDealDialog } from "@/app/workspace/_components/outcome-dialog-parts";

/**
 * Closes a deal as lost with an optional reason, from the deal modal.
 * `side_deal`: the closer (or an admin) closes an open side deal without a
 * payment (`sideDeals.markLost`). `admin`: an admin fixes any deal that can
 * close (`admin.meetingActions.adminMarkAsLost`, no call needed).
 */
export function MarkDealLostDialog({
  opportunityId,
  mode,
  leadName,
}: {
  opportunityId: Id<"opportunities">;
  mode: "side_deal" | "admin";
  /** Named in the title so the reader knows whose deal closes. */
  leadName?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const markSideDealLost = useMutation(api.sideDeals.markLost.markLost);
  const adminMarkAsLost = useMutation(api.admin.meetingActions.adminMarkAsLost);

  const onConfirm = async (reason: string | undefined) => {
    setIsSubmitting(true);
    try {
      if (mode === "admin") {
        await adminMarkAsLost({ opportunityId, reason });
        posthog.capture("admin_deal_marked_lost", {
          opportunity_id: opportunityId,
          has_reason: Boolean(reason),
        });
      } else {
        await markSideDealLost({ opportunityId, reason });
        posthog.capture("side_deal_marked_lost", {
          opportunity_id: opportunityId,
          has_reason: Boolean(reason),
        });
      }
      toast.success("Deal closed as lost");
      setOpen(false);
    } catch (error) {
      reportClientError(error, {
        flow: mode === "admin" ? "admin_deal_mark_lost" : "side_deal_mark_lost",
      });
      toast.error(getErrorMessage(error, "Couldn't close the deal as lost"));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <LostDealDialog
      open={open}
      onOpenChange={setOpen}
      pending={isSubmitting}
      leadName={leadName}
      consequence={
        mode === "admin"
          ? "The deal closes as lost for its closer, with your reason on it."
          : "The side deal closes as lost without a payment, with your reason on it."
      }
      placeholder="Why did this deal fall through? (e.g., budget, chose another program…)"
      trigger={
        <Button variant="outline" size="sm">
          <XCircleIcon aria-hidden="true" data-icon="inline-start" />
          Mark lost
        </Button>
      }
      onConfirm={onConfirm}
    />
  );
}
