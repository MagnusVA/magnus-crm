"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { CalendarPlusIcon, RefreshCwIcon, UserXIcon } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import posthog from "posthog-js";
import { getErrorMessage } from "@/lib/errors";

type NoShowActionBarProps = {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  lead: Doc<"leads">;
  onRescheduleLinkCreated?: (url: string) => void;
  /**
   * Opens the follow-up dialog, which the outcome section mounts: a link
   * moves the deal to Follow-up at once, which unmounts this bar, so a
   * dialog inside it would close before the link could be copied.
   */
  onScheduleFollowUp?: () => void;
  /** Replaces the closer's actions, as the admin view does with its own. */
  actions?: React.ReactNode;
};

// The reasons in the no-show dialog's words (mark-no-show-dialog.tsx).
const REASON_LABELS: Record<string, string> = {
  no_response: "No communication",
  late_cancel: "Messaged \u2014 can\u2019t make it",
  technical_issues: "Technical issues",
  other: "Other reason",
};

export function NoShowActionBar({
  meeting,
  opportunity,
  lead,
  onRescheduleLinkCreated,
  onScheduleFollowUp,
  actions,
}: NoShowActionBarProps) {
  const createRescheduleLink = useMutation(
    api.closer.noShowActions.createNoShowRescheduleLink,
  );
  const [isCreating, setIsCreating] = useState(false);

  const reasonLabel = meeting.noShowReason
    ? REASON_LABELS[meeting.noShowReason] ?? meeting.noShowReason
    : "No-show";

  const sourceLabel =
    meeting.noShowSource === "calendly_webhook"
      ? "Marked by Calendly"
      : meeting.noShowSource === "admin_manual"
        ? "Marked by admin"
        : undefined;

  const handleRequestReschedule = async () => {
    setIsCreating(true);
    try {
      const result = await createRescheduleLink({
        opportunityId: opportunity._id,
        meetingId: meeting._id,
      });

      posthog.capture("no_show_reschedule_link_sent", {
        meeting_id: meeting._id,
        opportunity_id: opportunity._id,
      });

      // Lift the URL to page level. NoShowActionBar will unmount due to
      // reactivity (the deal is now Follow-up with a pending reschedule
      // link), but RescheduleLinkDisplay will render the link at the page
      // level.
      onRescheduleLinkCreated?.(result.schedulingLinkUrl);

      toast.success("Reschedule link generated. Copy and send it to the lead.");
    } catch (err) {
      toast.error(
        getErrorMessage(err, "Failed to create reschedule link"),
      );
    } finally {
      setIsCreating(false);
    }
  };

  const name = lead.fullName ?? lead.email ?? "The lead";

  return (
    // A no-show is closed, not owed: a neutral ruled card, red only on the
    // status, and lime only on the next action (the reschedule link).
    <section
      aria-label="No-show"
      className="overflow-hidden rounded-xl border bg-card text-card-foreground"
    >
      <div className="flex items-start gap-3 px-4 pt-3.5 pb-3">
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-stage-lost/12 text-stage-lost-ink"
        >
          <UserXIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg leading-tight font-semibold">
            {name} didn&rsquo;t show up
            <span className="font-normal text-muted-foreground"> · {reasonLabel}</span>
          </h2>
          <p className="mt-1 text-[0.8125rem] text-muted-foreground">
            The deal closed as lost.{" "}
            {actions === undefined
              ? "Send a reschedule link to reopen it at Follow-up, or schedule a follow-up."
              : null}
          </p>
          <p className="mt-0.5 text-[0.8125rem] text-muted-foreground tabular-nums">
            {format(new Date(meeting.scheduledAt), "MMM d, h:mm a")}
            {sourceLabel && ` \u00b7 ${sourceLabel}`}
            {meeting.noShowNote && ` \u00b7 \u201c${meeting.noShowNote}\u201d`}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t bg-muted/50 px-4 py-2.5 sm:pl-[60px]">
        {actions !== undefined ? (
          actions
        ) : (
          <>
            <Button
              size="sm"
              onClick={handleRequestReschedule}
              disabled={isCreating}
            >
              {isCreating ? (
                <>
                  <Spinner data-icon="inline-start" />
                  Generating…
                </>
              ) : (
                <>
                  <RefreshCwIcon data-icon="inline-start" />
                  Send reschedule link
                </>
              )}
            </Button>

            {onScheduleFollowUp ? (
              <Button variant="outline" size="sm" onClick={onScheduleFollowUp}>
                <CalendarPlusIcon data-icon="inline-start" />
                Schedule follow-up
              </Button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
