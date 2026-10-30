"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { format } from "date-fns";
import { CalendarClockIcon, CheckIcon, CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { ActiveFollowUpSummary } from "@/convex/lib/activeFollowUp";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { getErrorMessage } from "@/lib/errors";

type UnfinishedFollowUpBannerProps = {
  followUp: ActiveFollowUpSummary;
  mode: "closer" | "admin";
  onResolved?: () => Promise<void>;
};

/**
 * A pending follow-up on a deal that still waits for its call's result.
 * Generating a link or setting a task moves the deal to Follow-up at once,
 * so this is a fallback for one left behind before that change, or another
 * odd state. While it is pending it takes the outcome question's place on
 * the meeting page; cancelling it brings the question back.
 */
export function UnfinishedFollowUpBanner({
  followUp,
  mode,
  onResolved,
}: UnfinishedFollowUpBannerProps) {
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const closerCancel = useMutation(
    api.closer.followUpMutations.cancelPendingFollowUp,
  );
  const adminCancel = useMutation(
    api.admin.meetingActions.adminCancelPendingFollowUp,
  );

  const isLink = followUp.type === "scheduling_link";
  const cancelLabel = isLink ? "Cancel the link" : "Cancel the task";

  const cancel = async () => {
    setCanceling(true);
    setError(null);
    try {
      const run = mode === "admin" ? adminCancel : closerCancel;
      await run({ followUpId: followUp._id });
      toast.success(isLink ? "Link canceled" : "Task canceled");
      await onResolved?.();
    } catch (err: unknown) {
      setError(
        getErrorMessage(
          err,
          isLink ? "Couldn't cancel the link." : "Couldn't cancel the task.",
        ),
      );
    } finally {
      setCanceling(false);
    }
  };

  const handleCopy = async () => {
    if (!followUp.schedulingLinkUrl) return;
    await navigator.clipboard.writeText(followUp.schedulingLinkUrl);
    setCopied(true);
    toast.success("Scheduling link copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  const createdAt = format(new Date(followUp.createdAt), "MMM d, h:mm a");
  const what = isLink
    ? `A scheduling link from ${createdAt} is still open`
    : `A task set on ${createdAt}${
        followUp.reminderScheduledAt
          ? ` for ${format(new Date(followUp.reminderScheduledAt), "MMM d, h:mm a")}`
          : ""
      } is still open`;

  return (
    <section
      aria-labelledby="unfinished-follow-up-heading"
      className="flex flex-col gap-3 rounded-xl border-2 border-warning bg-card px-4 py-3.5"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-warning text-board"
        >
          <CalendarClockIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2
            id="unfinished-follow-up-heading"
            className="text-lg leading-tight font-semibold"
          >
            Follow-up not finished
          </h2>
          <p className="mt-1 text-muted-foreground">
            {what}, but the deal is still waiting for this call&apos;s
            outcome, so the outcome question is on hold
            {mode === "admin" ? " for the closer" : ""}. {cancelLabel} to
            record the outcome here.
          </p>
        </div>
      </div>
      {followUp.schedulingLinkUrl ? (
        <InputGroup className="sm:ml-11 sm:w-auto">
          <InputGroupInput
            value={followUp.schedulingLinkUrl}
            readOnly
            className="font-mono text-xs"
            aria-label="Scheduling link"
          />
          <InputGroupAddon align="inline-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopy}
              aria-label={
                copied ? "Link copied to clipboard" : "Copy scheduling link"
              }
            >
              {copied ? (
                <CheckIcon data-icon="inline-start" />
              ) : (
                <CopyIcon data-icon="inline-start" />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
          </InputGroupAddon>
        </InputGroup>
      ) : null}
      {error ? (
        <p role="alert" className="text-danger-ink sm:ml-11">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2 sm:ml-11">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void cancel()}
          disabled={canceling}
        >
          {canceling ? <Spinner data-icon="inline-start" /> : null}
          {cancelLabel}
        </Button>
      </div>
    </section>
  );
}
