"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { RefreshCwIcon, UserXIcon } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import posthog from "posthog-js";
import { getErrorMessage } from "@/lib/errors";

const FollowUpDialog = dynamic(() =>
  import("./follow-up-dialog").then((m) => ({ default: m.FollowUpDialog })),
);

type NoShowActionBarProps = {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  lead: Doc<"leads">;
  onStatusChanged?: () => Promise<void>;
  onRescheduleLinkCreated?: (url: string) => void;
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
  onStatusChanged,
  onRescheduleLinkCreated,
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
    <section
      aria-label="No-show"
      className="flex flex-col gap-3 rounded-xl border-2 border-warning bg-warning-surface px-4 py-3.5 text-warning-ink"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-warning text-board"
        >
          <UserXIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg leading-tight font-semibold text-foreground">
            {name} didn&rsquo;t show up
            <span className="font-normal text-warning-ink"> · {reasonLabel}</span>
          </h2>
          <p className="mt-1 text-[0.8125rem]">
            The deal closed as lost.{" "}
            {actions === undefined
              ? "Send a reschedule link to reopen it at Follow-up, or schedule a follow-up."
              : null}
          </p>
          <p className="mt-0.5 text-[0.8125rem]">
            {format(new Date(meeting.scheduledAt), "MMM d, h:mm a")}
            {sourceLabel && ` \u00b7 ${sourceLabel}`}
            {meeting.noShowNote && ` \u00b7 \u201c${meeting.noShowNote}\u201d`}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 sm:pl-11">
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

            <FollowUpDialog
              opportunityId={opportunity._id}
              onSuccess={onStatusChanged}
              leadName={lead.fullName ?? lead.email ?? null}
              compact
            />
          </>
        )}
      </div>
    </section>
  );
}
