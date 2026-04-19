"use client";

import { useState } from "react";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DollarSignIcon,
  CalendarPlusIcon,
  UserXIcon,
  XCircleIcon,
  CheckIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { ReviewResolutionDialog } from "./review-resolution-dialog";
import { AcknowledgeWithTimesSheet } from "./acknowledge-with-times-sheet";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ResolutionAction =
  | "log_payment"
  | "schedule_follow_up"
  | "mark_no_show"
  | "mark_lost"
  | "acknowledged"
  | "disputed";

type ActiveFollowUp = {
  _id: Id<"followUps">;
  type: Doc<"followUps">["type"];
  status: "pending";
  createdAt: number;
  reminderScheduledAt?: number;
};

type CommonProps = {
  reviewId: Id<"meetingReviews">;
  closerResponse?: string;
  opportunityStatus: string;
  meetingScheduledAt: number;
  meetingDurationMinutes: number;
  fathomLink?: string;
  /**
   * v2: Active pending follow-up on the review's opportunity. Used to
   * detect "closer acted via follow-up on still-overran opportunity".
   * Null when the closer hasn't created a follow-up.
   */
  activeFollowUp: ActiveFollowUp | null;
};

// ---------------------------------------------------------------------------
// Button registry
// Acknowledge + Dispute are last so they're grouped visually.
// ---------------------------------------------------------------------------

const RESOLUTION_BUTTONS: Array<{
  action: ResolutionAction;
  label: string;
  icon: typeof DollarSignIcon;
  variant: "default" | "outline" | "destructive" | "secondary";
}> = [
  {
    action: "log_payment",
    label: "Log Payment",
    icon: DollarSignIcon,
    variant: "default",
  },
  {
    action: "schedule_follow_up",
    label: "Schedule Follow-Up",
    icon: CalendarPlusIcon,
    variant: "outline",
  },
  {
    action: "mark_no_show",
    label: "Mark No-Show",
    icon: UserXIcon,
    variant: "outline",
  },
  {
    action: "mark_lost",
    label: "Mark as Lost",
    icon: XCircleIcon,
    variant: "destructive",
  },
  {
    action: "acknowledged",
    label: "Acknowledge",
    icon: CheckIcon,
    variant: "secondary",
  },
  // v2: new dispute action — reverts closer's outcome to meeting_overran.
  {
    action: "disputed",
    label: "Dispute",
    icon: ShieldAlertIcon,
    variant: "destructive",
  },
];

function computeVisible(
  opportunityStatus: string,
  activeFollowUp: ActiveFollowUp | null,
) {
  // v2: the closer has "acted" when EITHER the opportunity has moved away
  // from `meeting_overran` (status-based action like Log Payment, Mark
  // No-Show, Mark as Lost) OR the closer created a pending follow-up
  // without transitioning the opportunity. In either case we narrow the
  // admin's action set to Acknowledge + Dispute — the backend enforces
  // the same gate, this is UX.
  const closerAlreadyActed =
    opportunityStatus !== "meeting_overran" || activeFollowUp !== null;

  const visibleButtons = closerAlreadyActed
    ? RESOLUTION_BUTTONS.filter(
        ({ action }) => action === "acknowledged" || action === "disputed",
      )
    : RESOLUTION_BUTTONS;

  return { visibleButtons, closerAlreadyActed };
}

// ---------------------------------------------------------------------------
// ReviewResolutionActions
//
// Inline button group — renders the contextually-valid action buttons
// plus the modal dialog. No card chrome, no heading. Designed to be
// embedded in the page header (desktop) or a sticky bottom bar (mobile).
// ---------------------------------------------------------------------------

type ReviewResolutionActionsProps = CommonProps & {
  /** Tailwind class applied to the button container. */
  className?: string;
  /** When true, the Acknowledge button gets a ring highlight. */
  highlightAcknowledge?: boolean;
  /** When true (default), uses size="sm" for buttons. */
  compact?: boolean;
};

export function ReviewResolutionActions({
  reviewId,
  closerResponse,
  opportunityStatus,
  meetingScheduledAt,
  meetingDurationMinutes,
  fathomLink,
  activeFollowUp,
  className,
  highlightAcknowledge,
  compact = true,
}: ReviewResolutionActionsProps) {
  const [activeAction, setActiveAction] = useState<ResolutionAction | null>(
    null,
  );
  const [ackSheetOpen, setAckSheetOpen] = useState(false);

  const { visibleButtons, closerAlreadyActed } = computeVisible(
    opportunityStatus,
    activeFollowUp,
  );

  // Visual hint: when the closer has acted, Acknowledge is usually the
  // default admin response — ring highlights it (unless caller overrides).
  const shouldHighlightAck =
    highlightAcknowledge !== undefined
      ? highlightAcknowledge
      : closerAlreadyActed;

  return (
    <>
      <div className={cn("flex flex-wrap gap-2", className)}>
        {visibleButtons.map(({ action, label, icon: Icon, variant }) => (
          <Button
            key={action}
            variant={variant}
            size={compact ? "sm" : "default"}
            onClick={() => {
              if (action === "acknowledged") {
                setAckSheetOpen(true);
                return;
              }
              setActiveAction(action);
            }}
            className={cn(
              shouldHighlightAck &&
                action === "acknowledged" &&
                "ring-2 ring-primary ring-offset-2",
            )}
          >
            <Icon data-icon="inline-start" />
            {label}
          </Button>
        ))}
      </div>

      {activeAction && (
        <ReviewResolutionDialog
          open={!!activeAction}
          onOpenChange={(open) => {
            if (!open) setActiveAction(null);
          }}
          reviewId={reviewId}
          resolutionAction={activeAction}
          closerResponse={closerResponse}
        />
      )}

      <AcknowledgeWithTimesSheet
        open={ackSheetOpen}
        onOpenChange={setAckSheetOpen}
        reviewId={reviewId}
        scheduledAt={meetingScheduledAt}
        durationMinutes={meetingDurationMinutes}
        fathomLink={fathomLink}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// ReviewResolutionContext
//
// Renders the contextual message explaining what happened and why the
// admin's action set is narrowed (if applicable). No buttons — just text.
// Used near the top of the page, adjacent to the action buttons.
// ---------------------------------------------------------------------------

type ReviewResolutionContextProps = {
  opportunityStatus: string;
  activeFollowUp: ActiveFollowUp | null;
  className?: string;
};

export function ReviewResolutionContext({
  opportunityStatus,
  activeFollowUp,
  className,
}: ReviewResolutionContextProps) {
  if (opportunityStatus === "meeting_overran" && !activeFollowUp) {
    // Closer hasn't acted — admin has the full override toolkit.
    return null;
  }

  const followUpTypeLabel =
    activeFollowUp?.type === "manual_reminder"
      ? "manual reminder"
      : "scheduling link";

  return (
    <div
      className={cn(
        "rounded-md border border-dashed bg-muted/40 px-3 py-2 text-sm text-muted-foreground",
        className,
      )}
    >
      {opportunityStatus !== "meeting_overran" && (
        <>
          The closer has already taken action — the opportunity is now{" "}
          <strong className="text-foreground">
            {opportunityStatus.replace(/_/g, " ")}
          </strong>
          . You may acknowledge or dispute that action.
        </>
      )}
      {opportunityStatus === "meeting_overran" && activeFollowUp && (
        <>
          The closer already created a{" "}
          <strong className="text-foreground">{followUpTypeLabel}</strong>{" "}
          while leaving the opportunity in meeting overran. You may
          acknowledge or dispute that action.
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legacy export — keeps the old card-style bar for any caller that still
// wants the stacked heading + description + buttons layout. The new page
// uses ReviewResolutionActions + ReviewResolutionContext directly, so this
// is retained only for backwards compatibility.
// ---------------------------------------------------------------------------

type ReviewResolutionBarProps = CommonProps;

export function ReviewResolutionBar({
  reviewId,
  closerResponse,
  opportunityStatus,
  meetingScheduledAt,
  meetingDurationMinutes,
  fathomLink,
  activeFollowUp,
}: ReviewResolutionBarProps) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="mb-3 font-medium">Resolve This Review</h3>
      <ReviewResolutionContext
        opportunityStatus={opportunityStatus}
        activeFollowUp={activeFollowUp}
        className="mb-3"
      />
      <ReviewResolutionActions
        reviewId={reviewId}
        closerResponse={closerResponse}
        opportunityStatus={opportunityStatus}
        meetingScheduledAt={meetingScheduledAt}
        meetingDurationMinutes={meetingDurationMinutes}
        fathomLink={fathomLink}
        activeFollowUp={activeFollowUp}
      />
    </div>
  );
}
