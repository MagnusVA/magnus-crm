"use client";

import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { PlayIcon, InfoIcon, ClockIcon, UserXIcon } from "lucide-react";
import { toast } from "sonner";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import posthog from "posthog-js";
import { EndMeetingButton } from "./end-meeting-button";

// Lazy-load dialog components that are only shown on user interaction
const MarkLostDialog = dynamic(() =>
  import("./mark-lost-dialog").then((m) => ({ default: m.MarkLostDialog })),
);
const MarkNoShowDialog = dynamic(() =>
  import("./mark-no-show-dialog").then((m) => ({
    default: m.MarkNoShowDialog,
  })),
);
const PaymentFormDialog = dynamic(() =>
  import("./payment-form-dialog").then((m) => ({ default: m.PaymentFormDialog })),
);
const FollowUpDialog = dynamic(() =>
  import("./follow-up-dialog").then((m) => ({ default: m.FollowUpDialog })),
);

type ActiveFollowUpSummary = {
  _id: Id<"followUps">;
  type: Doc<"followUps">["type"];
  status: "pending";
  createdAt: number;
  reminderScheduledAt?: number;
};

type OutcomeActionBarProps = {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  viewerRole: Doc<"users">["role"];
  payments: Doc<"paymentRecords">[];
  /**
   * v2: Meeting review record (if any). When the opportunity is
   * `meeting_overran`, outcome actions render only while
   * `review.status === "pending"`. Resolved reviews lock the action set
   * (backend also rejects — defense in depth). For non-overran
   * opportunities this prop is ignored.
   */
  meetingReview?: Doc<"meetingReviews"> | null;
  /**
   * v2: Active pending follow-up on this opportunity. Follow-up mutations
   * (`createManualReminderFollowUpPublic`, `confirmFollowUpScheduled`)
   * intentionally skip the opportunity status transition when the status
   * is `meeting_overran` — so the closer has acted even though the status
   * didn't move. When this is non-null on a still-overran opportunity we
   * hide the action bar (the banner flips to "Action Recorded — Awaiting
   * Admin Review" to confirm the action landed).
   */
  activeFollowUp?: ActiveFollowUpSummary | null;
  onStatusChanged?: () => Promise<void>;
};

const EARLY_JOIN_MINUTES = 5;
const TICK_INTERVAL_MS = 15_000; // re-check every 15 seconds

type WindowStatus = "within_window" | "too_early" | "outside_window";

type MeetingStartWindow = {
  status: WindowStatus;
  windowOpen: number;
  windowClose: number;
};

/**
 * Returns the meeting start window status:
 * - "too_early": before 5 minutes prior to scheduledAt
 * - "within_window": normal start window
 * - "outside_window": after scheduledAt + duration
 */
function useMeetingStartWindow(meeting: Doc<"meetings">): MeetingStartWindow {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const windowOpen = meeting.scheduledAt - EARLY_JOIN_MINUTES * 60 * 1000;
  const windowClose = meeting.scheduledAt + meeting.durationMinutes * 60 * 1000;

  if (now < windowOpen) {
    return { status: "too_early", windowOpen, windowClose };
  }
  if (now > windowClose) {
    return { status: "outside_window", windowOpen, windowClose };
  }
  return { status: "within_window", windowOpen, windowClose };
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Outcome Action Bar — contextual action buttons on the meeting detail page.
 *
 * Renders buttons based on meeting/opportunity status:
 * - "Start Meeting" — when scheduled & within the allowed start window
 * - "Log Payment" — when in_progress OR (meeting_overran with pending review)
 * - "Schedule Follow-Up" — when in_progress, canceled, OR
 *   (meeting_overran with pending review)
 * - "Mark No-Show" / "Mark as Lost" — when in_progress OR
 *   (meeting_overran with pending review)
 *
 * Returns null when:
 * - opportunity is in a terminal state (payment_received, lost,
 *   follow_up_scheduled, no_show)
 * - opportunity is `meeting_overran` AND the review is resolved (locked)
 * - opportunity is `meeting_overran` with no review record (unreviewed,
 *   should not be directly actionable)
 *
 * v2 shift: the banner no longer owns outcome actions; all outcomes flow
 * through this bar. While the review is pending, the closer picks the
 * real outcome. Once the admin resolves (acknowledge or dispute) the
 * review, this bar locks.
 */
export function OutcomeActionBar({
  meeting,
  opportunity,
  viewerRole,
  meetingReview,
  activeFollowUp = null,
  onStatusChanged,
}: OutcomeActionBarProps) {
  const startMeeting = useMutation(api.closer.meetingActions.startMeeting);
  const [isStarting, setIsStarting] = useState(false);
  const [showNoShowDialog, setShowNoShowDialog] = useState(false);
  const { status: windowStatus, windowOpen } = useMeetingStartWindow(meeting);

  const viewerIsCloser = viewerRole === "closer";
  const isMeetingScheduled = meeting.status === "scheduled";
  const isMeetingInProgress = meeting.status === "in_progress";
  const isInProgress = opportunity.status === "in_progress";

  /**
   * Handle meeting start within the allowed window.
   * Opens the meeting link and transitions to in_progress.
   */
  const handleStartMeeting = async () => {
    setIsStarting(true);
    try {
      const result = await startMeeting({ meetingId: meeting._id });
      if (result.meetingJoinUrl) {
        window.open(result.meetingJoinUrl, "_blank", "noopener,noreferrer");
      }
      await onStatusChanged?.();
      toast.success("Meeting started");
      posthog.capture("meeting_started", {
        meeting_id: meeting._id,
        opportunity_id: opportunity._id,
        has_meeting_url: Boolean(result.meetingJoinUrl),
        scheduled_at: meeting.scheduledAt,
        duration_minutes: meeting.durationMinutes,
      });
    } catch (error) {
      posthog.captureException(error);
      toast.error(
        error instanceof Error ? error.message : "Failed to start meeting",
      );
    } finally {
      setIsStarting(false);
    }
  };

  const isCanceled = opportunity.status === "canceled";
  const isNoShow = opportunity.status === "no_show";

  // v2: overran-review awareness. The bar stays active while the review is
  // pending so the closer can pick a real outcome. A resolved review (admin
  // acknowledged or disputed) locks the bar — backend also rejects as a
  // defense-in-depth guardrail.
  const isMeetingOverran = opportunity.status === "meeting_overran";
  const isPendingOverranReview =
    isMeetingOverran && meetingReview?.status === "pending";
  const isResolvedOverranReview =
    isMeetingOverran && meetingReview?.status === "resolved";
  // v2: A pending follow-up on a still-`meeting_overran` opportunity means
  // the closer already acted (scheduling link or manual reminder). The
  // follow-up mutations deliberately do NOT transition the opportunity in
  // that case (see `plans/Late-start-reviewv2/overhaul-v2.md` §5.4 and
  // §14.6), so we treat the pending follow-up as equivalent to a status
  // move: hide the action bar and let the banner show "Action Recorded —
  // Awaiting Admin Review".
  const hasActiveOverranFollowUp =
    isMeetingOverran && activeFollowUp !== null;

  // No-show status is handled by NoShowActionBar (Phase 3) — return null here
  if (isNoShow) return null;
  if (isResolvedOverranReview) return null;
  if (hasActiveOverranFollowUp) return null;

  const canClickStart = windowStatus === "within_window";
  const showStartButton =
    viewerIsCloser &&
    isMeetingScheduled &&
    windowStatus !== "outside_window";
  const showEndButton = isMeetingInProgress;
  const showLifecycleRow = showStartButton || showEndButton;

  const showPaymentAction =
    viewerIsCloser && (isInProgress || isPendingOverranReview);
  const showFollowUpAction =
    viewerIsCloser && (isInProgress || isCanceled || isPendingOverranReview);
  const showNoShowAction =
    viewerIsCloser && (isInProgress || isPendingOverranReview);
  const showMarkLostAction =
    viewerIsCloser && (isInProgress || isPendingOverranReview);
  const showOutcomeRow =
    showPaymentAction ||
    showFollowUpAction ||
    showNoShowAction ||
    showMarkLostAction;

  const showStartWindowHelp = viewerIsCloser && isMeetingScheduled;

  if (!showLifecycleRow && !showOutcomeRow && !showStartWindowHelp) {
    return null;
  }

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 [&_button]:w-full">
        {showLifecycleRow && (
          <div className="flex flex-col gap-2">
            {showStartButton && (
              <Button
                onClick={handleStartMeeting}
                disabled={isStarting || !canClickStart}
              >
                {isStarting ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Starting...
                  </>
                ) : (
                  <>
                    <PlayIcon data-icon="inline-start" />
                    Start Meeting
                  </>
                )}
              </Button>
            )}

            {showEndButton && (
              <EndMeetingButton
                meetingId={meeting._id}
                meetingStatus={meeting.status}
                onStopped={onStatusChanged}
              />
            )}
          </div>
        )}

        {showLifecycleRow && showOutcomeRow && <Separator />}

        {showOutcomeRow && (
          <div className="flex flex-col gap-2">
            {showPaymentAction && (
              <PaymentFormDialog
                opportunityId={opportunity._id}
                meetingId={meeting._id}
                onSuccess={onStatusChanged}
              />
            )}

            {showFollowUpAction && (
              <FollowUpDialog
                opportunityId={opportunity._id}
                onSuccess={onStatusChanged}
              />
            )}

            {(showNoShowAction || showMarkLostAction) && <Separator />}

            {showNoShowAction && (
              <>
                <Button
                  variant="outline"
                  onClick={() => setShowNoShowDialog(true)}
                >
                  <UserXIcon data-icon="inline-start" />
                  Mark No-Show
                </Button>
                <MarkNoShowDialog
                  open={showNoShowDialog}
                  onOpenChange={setShowNoShowDialog}
                  meetingId={meeting._id}
                  startedAt={meeting.startedAt}
                  onSuccess={onStatusChanged}
                />
              </>
            )}

            {showMarkLostAction && (
              <MarkLostDialog
                opportunityId={opportunity._id}
                onSuccess={onStatusChanged}
              />
            )}
          </div>
        )}

        {showStartWindowHelp && windowStatus === "within_window" && (
          <Alert className="mt-1">
            <InfoIcon />
            <AlertDescription>
              Click &ldquo;Start Meeting&rdquo; to open the meeting link and
              mark the call as in progress.
            </AlertDescription>
          </Alert>
        )}

        {showStartWindowHelp && windowStatus === "too_early" && (
          <Alert className="mt-1">
            <ClockIcon />
            <AlertDescription>
              This meeting can be started at {formatTime(windowOpen)}, 5 minutes
              before the scheduled time. The button will enable automatically.
            </AlertDescription>
          </Alert>
        )}

        {showStartWindowHelp && windowStatus === "outside_window" && (
          <Alert variant="destructive" className="mt-1">
            <ClockIcon />
            <AlertDescription>
              The scheduled time for this meeting has passed. Starting it
              directly is no longer available.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
