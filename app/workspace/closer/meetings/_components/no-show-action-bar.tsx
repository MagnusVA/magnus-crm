"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import posthog from "posthog-js";

const FollowUpDialog = dynamic(() =>
  import("./follow-up-dialog").then((m) => ({ default: m.FollowUpDialog })),
);

type NoShowActionBarProps = {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  lead: Doc<"leads">;
  onStatusChanged?: () => Promise<void>;
  onRescheduleLinkCreated?: (url: string) => void;
};

const REASON_LABELS: Record<string, string> = {
  no_response: "Lead didn't show up",
  late_cancel: "Lead messaged -- couldn't make it",
  technical_issues: "Technical issues",
  other: "Other reason",
};

export function NoShowActionBar({
  meeting,
  opportunity,
  lead,
  onStatusChanged,
  onRescheduleLinkCreated,
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
      : meeting.noShowWaitDurationMs
        ? `Waited ${Math.round(meeting.noShowWaitDurationMs / 60000)} min`
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

      // Lift the URL to page level -- the NoShowActionBar will unmount due to
      // reactivity (opportunity status is now reschedule_link_sent), but
      // RescheduleLinkDisplay will render the link at the page level.
      onRescheduleLinkCreated?.(result.schedulingLinkUrl);

      toast.success("Reschedule link generated -- copy and send to the lead");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to create reschedule link",
      );
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div
      role="region"
      aria-label="No-show actions"
      className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800/40 dark:bg-amber-950/20"
    >
      <div className="flex items-start gap-3">
        <AlertTriangleIcon className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="flex-1">
          <p className="font-medium text-amber-900 dark:text-amber-100">
            {lead.fullName ?? lead.email} &mdash; {reasonLabel}
          </p>
          <p className="mt-0.5 text-sm text-amber-700 dark:text-amber-300">
            {format(new Date(meeting.scheduledAt), "MMM d, h:mm a")}
            {sourceLabel && ` \u00b7 ${sourceLabel}`}
            {meeting.noShowNote && ` \u00b7 "${meeting.noShowNote}"`}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleRequestReschedule}
          disabled={isCreating}
        >
          {isCreating ? (
            <>
              <Spinner data-icon="inline-start" />
              Generating...
            </>
          ) : (
            <>
              <RefreshCwIcon data-icon="inline-start" />
              Request Reschedule
            </>
          )}
        </Button>

        <FollowUpDialog
          opportunityId={opportunity._id}
          onSuccess={onStatusChanged}
        />
      </div>
    </div>
  );
}
