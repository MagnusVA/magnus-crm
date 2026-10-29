"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { format } from "date-fns";
import { AlertCircleIcon, CheckIcon, CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import type { ActiveFollowUpSummary } from "@/convex/lib/activeFollowUp";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { getErrorMessage } from "@/lib/errors";

type UnfinishedFollowUpBannerProps = {
  meeting: Pick<Doc<"meetings">, "_id" | "status">;
  opportunityId: Id<"opportunities">;
  followUp: ActiveFollowUpSummary;
  mode: "closer" | "admin";
  onResolved?: () => Promise<void>;
};

/**
 * A pending follow-up on a deal that still waits for its call's result:
 * usually a scheduling link whose dialog closed before Done. While it is
 * pending, the meeting's outcome buttons stay hidden, so this shows it and
 * either finishes it (the deal moves to Follow-up) or cancels it (the
 * buttons come back).
 */
export function UnfinishedFollowUpBanner({
  meeting,
  opportunityId,
  followUp,
  mode,
  onResolved,
}: UnfinishedFollowUpBannerProps) {
  const [pendingAction, setPendingAction] = useState<"finish" | "cancel" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const closerConfirm = useMutation(
    api.closer.followUpMutations.confirmFollowUpScheduled,
  );
  const adminConfirm = useMutation(api.admin.meetingActions.adminConfirmFollowUp);
  const closerCancel = useMutation(
    api.closer.followUpMutations.cancelPendingFollowUp,
  );
  const adminCancel = useMutation(
    api.admin.meetingActions.adminCancelPendingFollowUp,
  );

  const run = async (action: "finish" | "cancel") => {
    setPendingAction(action);
    setError(null);
    try {
      if (action === "finish") {
        const confirm = mode === "admin" ? adminConfirm : closerConfirm;
        await confirm({
          opportunityId,
          meetingId: meeting.status === "scheduled" ? meeting._id : undefined,
        });
        toast.success("Deal moved to Follow-up");
      } else {
        const cancel = mode === "admin" ? adminCancel : closerCancel;
        await cancel({ followUpId: followUp._id });
        toast.success("Follow-up canceled");
      }
      await onResolved?.();
    } catch (err: unknown) {
      setError(
        getErrorMessage(
          err,
          action === "finish"
            ? "Couldn't move the deal to Follow-up."
            : "Couldn't cancel the follow-up.",
        ),
      );
    } finally {
      setPendingAction(null);
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
  const what =
    followUp.type === "scheduling_link"
      ? `A scheduling link was generated on ${createdAt}`
      : `A reminder was set on ${createdAt}${
          followUp.reminderScheduledAt
            ? ` for ${format(new Date(followUp.reminderScheduledAt), "MMM d, h:mm a")}`
            : ""
        }`;

  return (
    <Alert>
      <AlertCircleIcon />
      <AlertTitle>Follow-up not finished</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <p>
          {what}, but the deal never moved to Follow-up, so{" "}
          {mode === "admin" ? "the closer\u2019s" : "the"} outcome buttons are
          hidden. Mark the follow-up scheduled if it was sent, or cancel it to
          record the call&apos;s outcome.
        </p>
        {followUp.schedulingLinkUrl ? (
          <InputGroup>
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
        {error ? <p className="text-destructive">{error}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => void run("finish")}
            disabled={pendingAction !== null}
          >
            {pendingAction === "finish" ? (
              <Spinner data-icon="inline-start" />
            ) : null}
            Mark follow-up scheduled
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void run("cancel")}
            disabled={pendingAction !== null}
          >
            {pendingAction === "cancel" ? (
              <Spinner data-icon="inline-start" />
            ) : null}
            Cancel follow-up
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
