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
import { reportClientError } from "@/lib/observability/report-client-error";
import { PaymentFormDialog } from "@/app/workspace/closer/meetings/_components/payment-form-dialog";
import { MarkNoShowDialog } from "@/app/workspace/closer/meetings/_components/mark-no-show-dialog";
import { AdminFollowUpDialog } from "./admin-follow-up-dialog";
import { AdminMarkLostDialog } from "./admin-mark-lost-dialog";
import { getErrorMessage } from "@/lib/errors";
import { adminMeetingActions, type DealControlFields } from "@/lib/deal-controls";

type AdminActionBarProps = {
  meeting: Doc<"meetings">;
  opportunity: Pick<Doc<"opportunities">, "_id"> & DealControlFields;
  onRescheduleLinkCreated: (url: string) => void;
};

/**
 * Admin Action Bar — contextual actions from the deal's stage and loss
 * (`adminMeetingActions` in lib/deal-controls.ts).
 *
 * | Deal                          | Actions                                                |
 * |-------------------------------|--------------------------------------------------------|
 * | Booked or Call held           | Log Payment, Follow-up, Mark No-Show, Mark Lost, while the meeting is scheduled |
 * | Closed lost by a no-show      | Reschedule Link, Follow-up                             |
 * | Closed lost by a cancellation | Follow-up                                              |
 * | Qualified, Follow-up          | (view only)                                            |
 * | Closed otherwise              | (no bar)                                               |
 */
export function AdminActionBar({
  meeting,
  opportunity,
  onRescheduleLinkCreated,
}: AdminActionBarProps) {
  const [showNoShowDialog, setShowNoShowDialog] = useState(false);
  const actions = adminMeetingActions(opportunity, meeting.status);

  if (actions === null) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-t pt-4">
      {actions.outcome ? (
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

      {actions.scheduleFollowUp && (
        <AdminFollowUpDialog opportunityId={opportunity._id} />
      )}

      {actions.rescheduleLink && (
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
      reportClientError(error, { flow: "admin_reschedule_link_create" });
      toast.error(
        getErrorMessage(error, "Failed to generate reschedule link"),
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
