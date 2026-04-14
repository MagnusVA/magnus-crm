"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { LinkIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";
import { PaymentFormDialog } from "@/app/workspace/closer/meetings/_components/payment-form-dialog";
import { AdminFollowUpDialog } from "./admin-follow-up-dialog";
import { AdminMarkLostDialog } from "./admin-mark-lost-dialog";
import { AdminResolveMeetingDialog } from "./admin-resolve-meeting-dialog";

type AdminActionBarProps = {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  payments: Array<{ amount: number }>;
  onRescheduleLinkCreated: (url: string) => void;
};

/**
 * Admin Action Bar — contextual actions based on opportunity status.
 *
 * | Status                 | Actions                                                |
 * |------------------------|--------------------------------------------------------|
 * | scheduled              | Resolve Meeting                                        |
 * | in_progress            | Log Payment, Follow-up, Mark Lost                      |
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
  payments,
  onRescheduleLinkCreated,
}: AdminActionBarProps) {
  const status = opportunity.status;
  const isTerminal = status === "payment_received" || status === "lost";

  if (isTerminal) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-t pt-4">
      {/* Resolve Meeting — scheduled only (meeting happened but closer didn't start it) */}
      {status === "scheduled" && (
        <AdminResolveMeetingDialog
          meetingId={meeting._id}
          scheduledAt={meeting.scheduledAt}
          durationMinutes={meeting.durationMinutes}
        />
      )}

      {/* Log Payment — only in_progress */}
      {status === "in_progress" && (
        <PaymentFormDialog
          opportunityId={opportunity._id}
          meetingId={meeting._id}
        />
      )}

      {/* Schedule Follow-up — in_progress, no_show, canceled */}
      {(status === "in_progress" ||
        status === "no_show" ||
        status === "canceled") && (
        <AdminFollowUpDialog opportunityId={opportunity._id} />
      )}

      {/* Reschedule Link — no_show only */}
      {status === "no_show" && (
        <AdminRescheduleButton
          opportunityId={opportunity._id}
          meetingId={meeting._id}
          onRescheduleLinkCreated={onRescheduleLinkCreated}
        />
      )}

      {/* Mark as Lost — in_progress only */}
      {status === "in_progress" && (
        <AdminMarkLostDialog opportunityId={opportunity._id} />
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
          Generating...
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
