"use client";

import { useRef } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { FollowUpDialogShell } from "@/app/workspace/_components/follow-up-dialog-parts";
import posthog from "@/lib/posthog-browser";
import {
  useFollowUpSuggestion,
  type DialogSuggestion,
} from "@/components/call-insights/suggestion-context";

type FollowUpDialogProps = {
  opportunityId: Id<"opportunities">;
  meetingId?: Id<"meetings">;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSuccess?: () => Promise<void>;
  /** Named in the dialog so the closer knows whose deal moves. */
  leadName?: string | null;
  /** Opened from the suggested result: starts on the reminder, filled in. */
  suggestion?: DialogSuggestion;
};

/**
 * The closer's follow-up: a scheduling link from their own Calendly event
 * type (with UTM params), or an in-app reminder to call or text. The link
 * moves the deal to Follow-up as it is created; the reminder when it is set.
 */
export function FollowUpDialog({
  opportunityId,
  meetingId,
  open,
  onOpenChange,
  onSuccess,
  compact,
  leadName,
  suggestion,
}: FollowUpDialogProps & { compact?: boolean }) {
  const createFollowUp = useMutation(api.closer.followUpMutations.createSchedulingLinkFollowUp);
  const createReminder = useMutation(api.closer.followUpMutations.createManualReminderFollowUpPublic);

  const fromCall = useFollowUpSuggestion(suggestion);
  // Whether the link just created was saved from the suggestion, for its event.
  const linkFromCall = useRef(false);

  return (
    <FollowUpDialogShell
      suggestion={fromCall.shell}
      open={open}
      onOpenChange={onOpenChange}
      triggerSize={compact ? "sm" : "lg"}
      meetingId={meetingId}
      leadName={leadName}
      copy={{
        linkChoice: "A link to send. A booking moves the deal to Booked.",
        reminderChoice: "A task to call or text the lead at a time you pick.",
        linkNote:
          "Creates your personal scheduling link to share by WhatsApp, SMS or email. A booking through it moves the deal to Booked.",
        linkReady:
          "The deal is in Follow-up. Copy the link and send it; it waits as a task on Today until a call is booked through it.",
      }}
      createLink={async () => {
        const fromSuggestion = fromCall.forLink();
        linkFromCall.current = Boolean(fromSuggestion);
        const result = await createFollowUp({
          opportunityId,
          meetingId,
          ...(fromSuggestion ? { fromSuggestion } : {}),
        });
        return result.schedulingLinkUrl;
      }}
      onLinkCreated={() => {
        // The deal moved with the link. A failing refresh isn't a failed link.
        void onSuccess?.().catch((err: unknown) =>
          console.error("[FollowUpDialog] refresh after the link failed", err),
        );
        posthog.capture("follow_up_scheduling_link_created", {
          opportunity_id: opportunityId,
          meeting_id: meetingId ?? null,
          ...(linkFromCall.current ? { from_suggestion: true } : {}),
        });
      }}
      copyLink={async (url) => {
        await navigator.clipboard.writeText(url);
        toast.success("Scheduling link copied to clipboard");
        posthog.capture("follow_up_link_copied", {
          opportunity_id: opportunityId,
        });
      }}
      createReminder={async (reminder) => {
        const fromSuggestion = fromCall.forReminder(reminder);
        await createReminder({
          opportunityId,
          meetingId,
          contactMethod: reminder.contactMethod,
          reminderScheduledAt: reminder.reminderScheduledAt,
          reminderNote: reminder.reminderNote,
          ...(fromSuggestion ? { fromSuggestion } : {}),
        });
        await onSuccess?.();
        posthog.capture("follow_up_reminder_created", {
          opportunity_id: opportunityId,
          meeting_id: meetingId ?? null,
          contact_method: reminder.contactMethod,
          ...(fromSuggestion ? { from_suggestion: true } : {}),
        });
        toast.success("Reminder created");
      }}
    />
  );
}
