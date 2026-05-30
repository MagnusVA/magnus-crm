"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { LinkIcon, UserXIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";
import { PaymentFormDialog } from "@/app/workspace/closer/meetings/_components/payment-form-dialog";
import { MarkNoShowDialog } from "@/app/workspace/closer/meetings/_components/mark-no-show-dialog";
import { AdminFollowUpDialog } from "./admin-follow-up-dialog";
import { AdminMarkLostDialog } from "./admin-mark-lost-dialog";

type AdminActionBarProps = {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  onRescheduleLinkCreated: (url: string) => void;
};

/**
 * Admin Action Bar — contextual actions based on opportunity status.
 *
 * | Status                 | Actions                                                |
 * |------------------------|--------------------------------------------------------|
 * | scheduled              | Log Payment, Follow-up, Mark No-Show, Mark Lost        |
 * | no_show                | Reschedule Link, Follow-up                             |
 * | canceled               | Follow-up                                              |
 * | follow_up_scheduled    | (view only)                                            |
 * | reschedule_link_sent   | (view only)                                            |
 * | payment_received       | (view only — terminal)                                 |
 * | lost                   | (view only — terminal)                                 |
 */
export function AdminActionBar({
  meeting,
  opportunity,
  onRescheduleLinkCreated,
}: AdminActionBarProps) {
  const [showNoShowDialog, setShowNoShowDialog] = useState(false);
  const status = opportunity.status;
  const isScheduledOutcome =
    meeting.status === "scheduled" && status === "scheduled";
  const isTerminal = status === "payment_received" || status === "lost";

  if (isTerminal) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-t pt-4">
      {isScheduledOutcome ? (
        <>
          <PaymentFormDialog
            opportunityId={opportunity._id}
            meetingId={meeting._id}
          />

          <AdminFollowUpDialog
            opportunityId={opportunity._id}
            meetingId={meeting._id}
          />

          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowNoShowDialog(true)}
          >
            <UserXIcon data-icon="inline-start" />
            Mark No-Show
          </Button>
          <MarkNoShowDialog
            open={showNoShowDialog}
            onOpenChange={setShowNoShowDialog}
            meetingId={meeting._id}
            mode="admin"
          />

          <AdminMarkLostDialog
            opportunityId={opportunity._id}
            meetingId={meeting._id}
          />
        </>
      ) : null}

      {(status === "no_show" || status === "canceled") && (
        <AdminFollowUpDialog opportunityId={opportunity._id} />
      )}

      {status === "no_show" && (
        <AdminRescheduleButton
          opportunityId={opportunity._id}
          meetingId={meeting._id}
          onRescheduleLinkCreated={onRescheduleLinkCreated}
        />
      )}

    </div>
  );
}

// ---------------------------------------------------------------------------
// Reschedule button — inline (not a dialog) since the closer version is also inline
// ---------------------------------------------------------------------------

function AdminRescheduleButton({
  opportunityId,
  meetingId,
  onRescheduleLinkCreated,
}: {
  opportunityId: Id<"opportunities">;
  meetingId: Id<"meetings">;
  onRescheduleLinkCreated: (url: string) => void;
}) {
  const [isLoading, setIsLoading] = useState(false);
  const createRescheduleLink = useMutation(
    api.admin.meetingActions.adminCreateRescheduleLink,
  );

  const handleClick = async () => {
    setIsLoading(true);
    try {
      const result = await createRescheduleLink({
        opportunityId,
        meetingId,
      });
      onRescheduleLinkCreated(result.schedulingLinkUrl);
      posthog.capture("admin_reschedule_link_created", {
        opportunity_id: opportunityId,
        meeting_id: meetingId,
      });
      toast.success("Reschedule link generated");
    } catch (error) {
      posthog.captureException(error);
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to generate reschedule link",
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleClick}
      disabled={isLoading}
    >
      {isLoading ? (
        <>
          <Spinner data-icon="inline-start" />
          Generating…
        </>
      ) : (
        <>
          <LinkIcon data-icon="inline-start" />
          Reschedule Link
        </>
      )}
    </Button>
  );
}
