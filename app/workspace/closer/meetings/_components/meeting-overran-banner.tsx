"use client";

import { format } from "date-fns";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  InfoIcon,
  ShieldAlertIcon,
} from "lucide-react";

import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ActiveFollowUpSummary = {
  _id: Id<"followUps">;
  type: Doc<"followUps">["type"];
  status: "pending";
  createdAt: number;
  reminderScheduledAt?: number;
};

type MeetingOverranBannerProps = {
  meeting: Doc<"meetings">;
  meetingReview: Doc<"meetingReviews">;
  /**
   * v2: The opportunity's current status. Used to detect "closer already
   * acted via status move" versus "still in meeting_overran". Paired with
   * `meetingReview.status` + `meetingReview.resolutionAction` to derive
   * one of four banner states.
   */
  opportunityStatus: Doc<"opportunities">["status"];
  /**
   * v2: Active pending follow-up (scheduling link or manual reminder) on
   * this opportunity. Follow-up mutations intentionally skip the status
   * transition when the opportunity is `meeting_overran` — so a pending
   * follow-up is evidence the closer acted even though the status didn't
   * move. Mirrors the admin review surface's `activeFollowUp` semantics.
   */
  activeFollowUp?: ActiveFollowUpSummary | null;
};

// ---------------------------------------------------------------------------
// Component
//
// v2 shift: the banner is purely informational. All actions (Save Fathom
// link, Log Payment, Schedule Follow-Up, Mark No-Show, Mark as Lost) live
// elsewhere on the page — the `FathomLinkField` card and the
// `OutcomeActionBar`. The banner's job is to communicate where the
// review sits in its lifecycle, visible from the moment the system
// flags the meeting until the admin resolves (and beyond — resolved
// state is also a distinct banner).
//
// States (in visual priority):
//   1. pending + still overran        → amber   "Flagged for Review"
//   2. pending + closer already acted → blue    "Awaiting Admin Review"
//   3. resolved + acknowledged        → emerald "Review Acknowledged"
//   4. resolved + disputed            → red     "Review Disputed"
// ---------------------------------------------------------------------------

export function MeetingOverranBanner({
  meeting,
  meetingReview,
  opportunityStatus,
  activeFollowUp = null,
}: MeetingOverranBannerProps) {
  const reviewPending = meetingReview.status === "pending";
  const reviewResolved = meetingReview.status === "resolved";
  // v2: "Closer already acted" when EITHER the opportunity moved out of
  // `meeting_overran` (status-based outcomes: payment, no-show, lost) OR the
  // closer created a pending follow-up that intentionally left the status at
  // `meeting_overran` (see `convex/closer/followUpMutations.ts`). Mirrors
  // `computeVisible` in `review-resolution-bar.tsx` on the admin side.
  const closerAlreadyActed =
    opportunityStatus !== "meeting_overran" || activeFollowUp !== null;
  const isDisputed =
    reviewResolved && meetingReview.resolutionAction === "disputed";
  const isAcknowledged = reviewResolved && !isDisputed;

  const isPendingAwaitingCloser = reviewPending && !closerAlreadyActed;
  const isPendingAwaitingAdmin = reviewPending && closerAlreadyActed;

  const overranDetectedAt =
    meeting.overranDetectedAt ?? meetingReview.createdAt;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "rounded-lg border p-4",
        isPendingAwaitingCloser &&
          "border-amber-200 bg-amber-50 dark:border-amber-800/40 dark:bg-amber-950/20",
        isPendingAwaitingAdmin &&
          "border-blue-200 bg-blue-50 dark:border-blue-800/40 dark:bg-blue-950/20",
        isAcknowledged &&
          "border-emerald-200 bg-emerald-50 dark:border-emerald-800/40 dark:bg-emerald-950/20",
        isDisputed &&
          "border-red-200 bg-red-50 dark:border-red-800/40 dark:bg-red-950/20",
      )}
    >
      <div className="flex items-start gap-3">
        <StateIcon
          isPendingAwaitingCloser={isPendingAwaitingCloser}
          isPendingAwaitingAdmin={isPendingAwaitingAdmin}
          isAcknowledged={isAcknowledged}
          isDisputed={isDisputed}
        />
        <div className="flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3
              className={cn(
                "text-sm font-semibold",
                isPendingAwaitingCloser &&
                  "text-amber-900 dark:text-amber-200",
                isPendingAwaitingAdmin &&
                  "text-blue-900 dark:text-blue-200",
                isAcknowledged &&
                  "text-emerald-900 dark:text-emerald-200",
                isDisputed && "text-red-900 dark:text-red-200",
              )}
            >
              {isPendingAwaitingCloser &&
                "Meeting Overran — Flagged for Review"}
              {isPendingAwaitingAdmin &&
                "Action Recorded — Awaiting Admin Review"}
              {isAcknowledged && "Review Acknowledged"}
              {isDisputed && "Review Disputed"}
            </h3>
            {reviewPending && (
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px]",
                  isPendingAwaitingCloser &&
                    "border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300",
                  isPendingAwaitingAdmin &&
                    "border-blue-300 text-blue-700 dark:border-blue-800 dark:text-blue-300",
                )}
              >
                Needs Attention
              </Badge>
            )}
          </div>

          <p
            className={cn(
              "text-sm",
              isPendingAwaitingCloser &&
                "text-amber-800 dark:text-amber-200/90",
              isPendingAwaitingAdmin && "text-blue-800 dark:text-blue-200/90",
              isAcknowledged &&
                "text-emerald-800 dark:text-emerald-200/90",
              isDisputed && "text-red-800 dark:text-red-200/90",
            )}
          >
            {isPendingAwaitingCloser && (
              <>
                The system did not detect any activity on this meeting. Save
                your Fathom recording link below, then take the appropriate
                outcome action (Log Payment, Schedule Follow-Up, Mark
                No-Show, or Mark as Lost). An admin will validate.
              </>
            )}
            {isPendingAwaitingAdmin && (
              <>
                Your action has been recorded and is awaiting admin
                validation. If the admin disputes the outcome, it will
                revert to &ldquo;meeting overran&rdquo;.
              </>
            )}
            {isAcknowledged && (
              <>
                This review was acknowledged by an admin. The current
                outcome stands.
              </>
            )}
            {isDisputed && (
              <>
                This review was disputed by an admin. &ldquo;Meeting
                overran&rdquo; is the final outcome — any action you took
                has been reverted.
              </>
            )}
          </p>

          <p
            className={cn(
              "text-xs",
              isPendingAwaitingCloser &&
                "text-amber-700/80 dark:text-amber-300/70",
              isPendingAwaitingAdmin &&
                "text-blue-700/80 dark:text-blue-300/70",
              isAcknowledged &&
                "text-emerald-700/80 dark:text-emerald-300/70",
              isDisputed && "text-red-700/80 dark:text-red-300/70",
            )}
          >
            Flagged{" "}
            {format(new Date(overranDetectedAt), "MMM d, yyyy 'at' h:mm a")}
            {meetingReview.resolvedAt && (
              <>
                {" · "}
                Resolved{" "}
                {format(
                  new Date(meetingReview.resolvedAt),
                  "MMM d 'at' h:mm a",
                )}
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StateIcon — small helper keeps the main JSX readable
// ---------------------------------------------------------------------------

function StateIcon({
  isPendingAwaitingCloser,
  isPendingAwaitingAdmin,
  isAcknowledged,
  isDisputed,
}: {
  isPendingAwaitingCloser: boolean;
  isPendingAwaitingAdmin: boolean;
  isAcknowledged: boolean;
  isDisputed: boolean;
}) {
  if (isPendingAwaitingCloser) {
    return (
      <AlertTriangleIcon
        className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden
      />
    );
  }
  if (isPendingAwaitingAdmin) {
    return (
      <InfoIcon
        className="mt-0.5 size-5 shrink-0 text-blue-600 dark:text-blue-400"
        aria-hidden
      />
    );
  }
  if (isAcknowledged) {
    return (
      <CheckCircle2Icon
        className="mt-0.5 size-5 shrink-0 text-emerald-600 dark:text-emerald-400"
        aria-hidden
      />
    );
  }
  if (isDisputed) {
    return (
      <ShieldAlertIcon
        className="mt-0.5 size-5 shrink-0 text-red-600 dark:text-red-400"
        aria-hidden
      />
    );
  }
  return null;
}
