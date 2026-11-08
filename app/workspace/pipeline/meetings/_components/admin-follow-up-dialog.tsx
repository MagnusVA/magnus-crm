"use client";

import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { FollowUpDialogShell } from "@/app/workspace/_components/follow-up-dialog-parts";
import posthog from "@/lib/posthog-browser";

type AdminFollowUpDialogProps = {
  opportunityId: Id<"opportunities">;
  meetingId?: Id<"meetings">;
  onSuccess?: () => Promise<void>;
  /** Controlled open state. When set, the dialog renders no trigger button. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Named in the dialog so the admin knows whose deal moves. */
  leadName?: string | null;
};

/**
 * The admin's follow-up, set for the deal's closer: the same two paths as
 * the closer's dialog, on admin mutations that use the assigned closer's
 * Calendly event type.
 */
export function AdminFollowUpDialog({
  opportunityId,
  meetingId,
  onSuccess,
  open,
  onOpenChange,
  leadName,
}: AdminFollowUpDialogProps) {
  const createFollowUp = useMutation(api.admin.meetingActions.adminCreateFollowUp);
  const createReminder = useMutation(api.admin.meetingActions.adminCreateManualReminder);

  return (
    <FollowUpDialogShell
      open={open}
      onOpenChange={onOpenChange}
      triggerSize="sm"
      meetingId={meetingId}
      leadName={leadName}
      copy={{
        linkChoice: "A link on the closer’s Calendly for the lead to book.",
        reminderChoice: "A task for the closer to call or text the lead.",
        linkNote:
          "Creates a scheduling link on the assigned closer’s Calendly. A booking through it moves the deal to Booked.",
        linkReady:
          "The deal is in Follow-up. Copy the link and send it; it waits as a task for the closer until a call is booked through it.",
      }}
      createLink={async () => {
        const result = await createFollowUp({ opportunityId, meetingId });
        return result.schedulingLinkUrl;
      }}
      onLinkCreated={() => {
        // The deal moved with the link. A failing refresh isn't a failed link.
        void onSuccess?.().catch((err: unknown) =>
          console.error("[AdminFollowUpDialog] refresh after the link failed", err),
        );
        posthog.capture("admin_follow_up_scheduling_link_created", {
          opportunity_id: opportunityId,
          meeting_id: meetingId ?? null,
        });
      }}
      copyLink={async (url) => {
        await navigator.clipboard.writeText(url);
        toast.success("Scheduling link copied to clipboard");
        posthog.capture("admin_follow_up_link_copied", {
          opportunity_id: opportunityId,
        });
      }}
      createReminder={async (reminder) => {
        await createReminder({
          opportunityId,
          meetingId,
          contactMethod: reminder.contactMethod,
          reminderScheduledAt: reminder.reminderScheduledAt,
          reminderNote: reminder.reminderNote,
        });
        await onSuccess?.();
        posthog.capture("admin_follow_up_reminder_created", {
          opportunity_id: opportunityId,
          meeting_id: meetingId ?? null,
          contact_method: reminder.contactMethod,
        });
        toast.success("Reminder created");
      }}
    />
  );
}
