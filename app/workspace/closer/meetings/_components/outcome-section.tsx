"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { format } from "date-fns";
import {
  BanknoteIcon,
  CalendarPlusIcon,
  CheckIcon,
  ClockIcon,
  CornerUpLeftIcon,
  XIcon,
} from "lucide-react";
import type { Doc } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/format-currency";
import {
  adminMeetingActions,
  isAwaitingOutcome,
  isClosedByNoShow,
  isDealWon,
  isWaitingOnRescheduleLink,
  missedMeetingOf,
} from "@/lib/deal-controls";
import { cn } from "@/lib/utils";
import { StageChip } from "./stage-tone";
import { NoShowActionBar } from "./no-show-action-bar";
import { RescheduleLinkDisplay } from "./reschedule-link-display";
import { UnfinishedFollowUpBanner } from "./unfinished-follow-up-banner";
import {
  firstNameOf,
  type MeetingDetail,
  type MeetingDetailMode,
} from "./meeting-detail-types";

const PaymentFormDialog = dynamic(() =>
  import("./payment-form-dialog").then((m) => ({ default: m.PaymentFormDialog })),
);
const FollowUpDialog = dynamic(() =>
  import("./follow-up-dialog").then((m) => ({ default: m.FollowUpDialog })),
);
const MarkLostDialog = dynamic(() =>
  import("./mark-lost-dialog").then((m) => ({ default: m.MarkLostDialog })),
);
const MarkNoShowDialog = dynamic(() =>
  import("./mark-no-show-dialog").then((m) => ({ default: m.MarkNoShowDialog })),
);
const AdminFollowUpDialog = dynamic(() =>
  import("@/app/workspace/pipeline/meetings/_components/admin-follow-up-dialog").then(
    (m) => ({ default: m.AdminFollowUpDialog }),
  ),
);
const AdminMarkLostDialog = dynamic(() =>
  import("@/app/workspace/pipeline/meetings/_components/admin-mark-lost-dialog").then(
    (m) => ({ default: m.AdminMarkLostDialog }),
  ),
);
const AdminRescheduleButton = dynamic(() =>
  import("@/app/workspace/pipeline/meetings/_components/admin-reschedule-button").then(
    (m) => ({ default: m.AdminRescheduleButton }),
  ),
);

type OutcomeDialog = "payment" | "follow_up" | "lost" | "no_show" | "missed_follow_up";

type OutcomeSectionProps = {
  mode: MeetingDetailMode;
  viewerRole: Doc<"users">["role"];
  detail: MeetingDetail;
  /** From `useOutcomeEligibility`: the call starts in 5 minutes or less. */
  eligible: boolean;
  onStatusChanged?: () => Promise<void>;
  onShowPayments: () => void;
};

/**
 * The page's one next action. Depending on the deal and the call it is:
 *
 * - the outcome question ("Did Ana show up?", then won, follow-up or lost),
 * - the unfinished follow-up from PR #214, which holds the question,
 * - the no-show bar with its reschedule link, on a deal a no-show closed,
 * - a note that the question opens 5 minutes before the call, or
 * - a one-line summary once the outcome is recorded.
 *
 * Eligibility is unchanged from the old action bar: a scheduled meeting on a
 * deal awaiting its outcome, no pending follow-up, and for a closer, the
 * outcome window open. The mutations check the deal again.
 */
export function OutcomeSection({
  mode,
  viewerRole,
  detail,
  eligible,
  onStatusChanged,
  onShowPayments,
}: OutcomeSectionProps) {
  const { meeting, opportunity, lead, activeFollowUp } = detail;
  const [dialog, setDialog] = useState<OutcomeDialog | null>(null);
  // A dialog stays mounted once opened, so a write that changes the section
  // underneath (a follow-up link, a payment) never unmounts it mid-flow.
  const [mounted, setMounted] = useState<ReadonlySet<OutcomeDialog>>(new Set());
  const [rescheduleLinkUrl, setRescheduleLinkUrl] = useState<string | null>(null);

  const viewerIsCloser = viewerRole === "closer";
  const viewerIsAdmin =
    viewerRole === "tenant_master" || viewerRole === "tenant_admin";
  const awaiting = isAwaitingOutcome(opportunity);
  const hasActiveFollowUp = activeFollowUp !== null;
  const canRecord =
    meeting.status === "scheduled" &&
    awaiting &&
    (viewerIsCloser || viewerIsAdmin) &&
    (viewerIsAdmin || eligible) &&
    !hasActiveFollowUp;

  const leadName = lead.fullName ?? lead.email ?? null;
  const firstName = firstNameOf(lead.fullName);
  const defaultProgramId =
    meeting.bookingProgramId ?? opportunity.firstBookingProgramId ?? null;

  const openDialog = (next: OutcomeDialog) => {
    setMounted((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
    setDialog(next);
  };
  const dialogState = (key: OutcomeDialog) => ({
    open: dialog === key,
    onOpenChange: (open: boolean) => setDialog(open ? key : null),
  });

  let body: React.ReactNode;
  if (rescheduleLinkUrl) {
    body = (
      <RescheduleLinkDisplay
        url={rescheduleLinkUrl}
        leadName={firstName}
        onDismiss={() => setRescheduleLinkUrl(null)}
      />
    );
  } else if (activeFollowUp && awaiting) {
    body = (
      <UnfinishedFollowUpBanner
        meeting={meeting}
        opportunityId={opportunity._id}
        followUp={activeFollowUp}
        mode={mode === "admin" || !viewerIsCloser ? "admin" : "closer"}
        onResolved={onStatusChanged}
      />
    );
  } else if (isClosedByNoShow(opportunity)) {
    body = (
      <NoShowActionBar
        meeting={meeting}
        opportunity={opportunity}
        lead={lead}
        onStatusChanged={onStatusChanged}
        onRescheduleLinkCreated={setRescheduleLinkUrl}
        actions={
          mode === "admin" ? (
            <>
              <AdminRescheduleButton
                opportunityId={opportunity._id}
                meetingId={meeting._id}
                onRescheduleLinkCreated={setRescheduleLinkUrl}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => openDialog("missed_follow_up")}
              >
                <CalendarPlusIcon data-icon="inline-start" />
                Schedule follow-up
              </Button>
            </>
          ) : viewerIsCloser ? undefined : (
            <Button asChild variant="outline" size="sm">
              <Link href={`/workspace/pipeline/meetings/${meeting._id}`}>
                Open the admin view to send a reschedule link
              </Link>
            </Button>
          )
        }
      />
    );
  } else if (canRecord) {
    body = (
      <OutcomeQuestion
        firstName={firstName}
        mode={mode}
        onPick={openDialog}
      />
    );
  } else if (meeting.status === "scheduled" && awaiting && !hasActiveFollowUp) {
    body = <OutcomeOpensNote scheduledAt={meeting.scheduledAt} />;
  } else {
    const adminActions =
      mode === "admin" ? adminMeetingActions(opportunity, meeting.status) : null;
    body = (
      <OutcomeSummary
        detail={detail}
        firstName={firstName}
        onShowPayments={onShowPayments}
        action={
          adminActions?.scheduleFollowUp ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => openDialog("missed_follow_up")}
            >
              <CalendarPlusIcon data-icon="inline-start" />
              Schedule follow-up
            </Button>
          ) : null
        }
      />
    );
  }

  return (
    <>
      {body}

      {mounted.has("payment") ? (
        <PaymentFormDialog
          opportunityId={opportunity._id}
          meetingId={meeting._id}
          onSuccess={onStatusChanged}
          leadName={leadName}
          defaultProgramId={defaultProgramId}
          {...dialogState("payment")}
        />
      ) : null}
      {mounted.has("follow_up") ? (
        mode === "admin" ? (
          <AdminFollowUpDialog
            opportunityId={opportunity._id}
            meetingId={meeting._id}
            onSuccess={onStatusChanged}
            leadName={leadName}
            {...dialogState("follow_up")}
          />
        ) : (
          <FollowUpDialog
            opportunityId={opportunity._id}
            meetingId={meeting._id}
            onSuccess={onStatusChanged}
            leadName={leadName}
            {...dialogState("follow_up")}
          />
        )
      ) : null}
      {mounted.has("missed_follow_up") && mode === "admin" ? (
        <AdminFollowUpDialog
          opportunityId={opportunity._id}
          onSuccess={onStatusChanged}
          leadName={leadName}
          {...dialogState("missed_follow_up")}
        />
      ) : null}
      {mounted.has("lost") ? (
        mode === "admin" ? (
          <AdminMarkLostDialog
            opportunityId={opportunity._id}
            meetingId={meeting._id}
            onSuccess={onStatusChanged}
            leadName={leadName}
            {...dialogState("lost")}
          />
        ) : (
          <MarkLostDialog
            opportunityId={opportunity._id}
            meetingId={meeting._id}
            onSuccess={onStatusChanged}
            leadName={leadName}
            {...dialogState("lost")}
          />
        )
      ) : null}
      {mounted.has("no_show") ? (
        <MarkNoShowDialog
          meetingId={meeting._id}
          mode={mode}
          onSuccess={onStatusChanged}
          leadName={leadName}
          {...dialogState("no_show")}
        />
      ) : null}
    </>
  );
}

// ─── The question ────────────────────────────────────────────────────────────

function OutcomeQuestion({
  firstName,
  mode,
  onPick,
}: {
  firstName: string | null;
  mode: MeetingDetailMode;
  onPick: (dialog: OutcomeDialog) => void;
}) {
  // "Showed up" records nothing on its own: no mutation marks a call held
  // without its result, so it only opens step 2, whose choices each mark the
  // call held as they write the deal's result.
  const [showed, setShowed] = useState(false);
  const stepTwoHeading = useRef<HTMLHeadingElement>(null);
  const stepOneHeading = useRef<HTMLHeadingElement>(null);
  // Moving between the steps moves focus to the new question.
  const toggled = useRef(false);
  useEffect(() => {
    if (!toggled.current) return;
    (showed ? stepTwoHeading : stepOneHeading).current?.focus();
  }, [showed]);
  const who = firstName ?? "the lead";
  const whose = mode === "admin" ? "the closer’s" : "your";

  return (
    <section
      aria-labelledby="outcome-heading"
      className="@container overflow-hidden rounded-xl border-2 border-primary bg-card"
    >
      {showed ? (
        <>
          <OutcomeHeading ref={stepTwoHeading} step="Step 2 of 2">
            How did the call end?
          </OutcomeHeading>
          <p className="px-4 text-muted-foreground @md:px-5">
            {firstName ?? "The lead"} showed up. Each choice marks the call held.
          </p>
          <div className="grid gap-2.5 p-4 @md:px-5 @2xl:grid-cols-3">
            <ChoiceButton
              tone="won"
              icon={<BanknoteIcon />}
              title="Won · log payment"
              detail="Closes the deal as won with the payment."
              onClick={() => onPick("payment")}
            />
            <ChoiceButton
              tone="plain"
              icon={<CalendarPlusIcon />}
              title="Follow-up"
              detail="Moves the deal to Follow-up with a link or a reminder."
              onClick={() => onPick("follow_up")}
            />
            <ChoiceButton
              tone="lost"
              icon={<XIcon />}
              title="Lost"
              detail="Closes the deal as lost, with a reason."
              onClick={() => onPick("lost")}
            />
          </div>
          <div className="flex items-center border-t bg-background px-4 py-1.5 @md:px-5">
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 text-muted-foreground"
              onClick={() => {
                toggled.current = true;
                setShowed(false);
              }}
            >
              <CornerUpLeftIcon data-icon="inline-start" aria-hidden />
              Back to &ldquo;Did {who} show up?&rdquo;
            </Button>
          </div>
        </>
      ) : (
        <>
          <OutcomeHeading ref={stepOneHeading} step="Step 1 of 2">
            Did {who} show up?
          </OutcomeHeading>
          <p className="px-4 text-muted-foreground @md:px-5">
            Recording the outcome updates this deal, {whose} close rate and the
            team&rsquo;s reports.
          </p>
          <div className="grid gap-3 p-4 @md:px-5 @xl:grid-cols-2">
            <ChoiceButton
              tone="yes"
              icon={<CheckIcon />}
              title="Showed up"
              detail="Next: won with a payment, follow-up, or lost."
              onClick={() => {
                toggled.current = true;
                setShowed(true);
              }}
            />
            <ChoiceButton
              tone="no"
              icon={<XIcon />}
              title="No-show"
              detail="Pick a reason. The deal closes as lost; you can send a reschedule link."
              onClick={() => onPick("no_show")}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t bg-background px-4 py-2.5 text-[0.8125rem] text-muted-foreground @md:px-5">
            <span>Then pick one:</span>
            <ShortcutPill onClick={() => onPick("payment")}>Won · log payment</ShortcutPill>
            <ShortcutPill onClick={() => onPick("follow_up")}>Follow-up</ShortcutPill>
            <ShortcutPill onClick={() => onPick("lost")}>Lost</ShortcutPill>
          </div>
        </>
      )}
    </section>
  );
}

function OutcomeHeading({
  ref,
  step,
  children,
}: {
  ref: React.Ref<HTMLHeadingElement>;
  step: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-4 pt-3.5 pb-1 @md:px-5">
      <span className="inline-flex h-5 items-center rounded bg-primary px-1.5 font-condensed text-[0.6875rem] font-bold tracking-[0.12em] text-primary-foreground uppercase">
        {step}
      </span>
      <h2
        id="outcome-heading"
        ref={ref}
        tabIndex={-1}
        className="text-xl leading-tight font-semibold text-balance outline-none"
      >
        {children}
      </h2>
    </div>
  );
}

const CHOICE_TONE = {
  yes: {
    box: "border-primary bg-primary/10 hover:bg-primary/15",
    mark: "bg-primary text-primary-foreground",
    title: "",
  },
  no: {
    box: "border-border bg-card hover:bg-muted/60",
    mark: "bg-destructive/10 text-danger-ink",
    title: "",
  },
  won: {
    box: "border-primary bg-primary text-primary-foreground hover:bg-primary/85",
    mark: "bg-primary-foreground/10 text-primary-foreground",
    title: "",
  },
  plain: {
    box: "border-border bg-card hover:bg-muted/60",
    mark: "bg-stage-follow-up/15 text-stage-follow-up-ink",
    title: "",
  },
  lost: {
    box: "border-border bg-card hover:bg-muted/60",
    mark: "bg-destructive/10 text-danger-ink",
    title: "text-danger-ink",
  },
} as const;

function ChoiceButton({
  tone,
  icon,
  title,
  detail,
  onClick,
}: {
  tone: keyof typeof CHOICE_TONE;
  icon: React.ReactNode;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  const styles = CHOICE_TONE[tone];
  const onFill = tone === "won";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "grid min-h-16 grid-cols-[auto_minmax(0,1fr)] content-center items-center gap-x-3 gap-y-0.5 rounded-lg border px-4 py-3 text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
        styles.box,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "row-span-2 flex size-8 items-center justify-center rounded-full [&>svg]:size-4",
          styles.mark,
        )}
      >
        {icon}
      </span>
      <span className={cn("text-[1.0625rem] font-semibold", styles.title)}>{title}</span>
      <span
        className={cn(
          "text-[0.8125rem] leading-snug",
          onFill ? "text-primary-foreground/80" : "text-muted-foreground",
        )}
      >
        {detail}
      </span>
    </button>
  );
}

function ShortcutPill({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-6 items-center rounded-full border bg-card px-2.5 text-xs font-semibold text-foreground transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/60"
    >
      {children}
    </button>
  );
}

// ─── Before the window opens ─────────────────────────────────────────────────

function OutcomeOpensNote({ scheduledAt }: { scheduledAt: number }) {
  return (
    <p className="flex items-center gap-2 rounded-xl border border-dashed bg-card px-4 py-3 text-muted-foreground">
      <ClockIcon className="size-4 shrink-0" aria-hidden />
      You can record the outcome from{" "}
      {format(scheduledAt - 5 * 60_000, "h:mm a")}, five minutes before the call.
    </p>
  );
}

// ─── After the outcome ───────────────────────────────────────────────────────

const SYSTEM_LOSS_SUMMARY = {
  canceled: "The call was canceled, so the deal closed as lost.",
  stale: "The Slack qualification expired before a booking.",
  no_show: "No-show. The deal closed as lost.",
} as const;

function OutcomeSummary({
  detail,
  firstName,
  onShowPayments,
  action,
}: {
  detail: MeetingDetail;
  firstName: string | null;
  onShowPayments: () => void;
  action: React.ReactNode;
}) {
  const { meeting, opportunity, payments, assignedCloser, activeFollowUp } = detail;
  const when = (at: number) => format(at, "MMM d, h:mm a");

  let headline: React.ReactNode;
  let byline: string | null = null;
  let trailing: React.ReactNode = action;

  if (isDealWon(opportunity) && payments.length > 0) {
    // Payments arrive newest first; the oldest one won the deal.
    const first = payments[payments.length - 1];
    headline = (
      <>
        <span className="font-condensed text-lg font-semibold tabular-nums">
          {formatCurrency(first.amount, first.currency)}
        </span>
        {first.programName ? ` · ${first.programName}` : null}
        {payments.length > 1 ? (
          <span className="text-muted-foreground"> · {payments.length} payments</span>
        ) : null}
      </>
    );
    byline = [
      first.recordedByName ? `Logged by ${first.recordedByName}` : "Logged",
      when(first.recordedAt),
    ].join(" · ");
    trailing = (
      <>
        {action}
        <Button variant="outline" size="sm" onClick={onShowPayments}>
          Payment details
        </Button>
      </>
    );
  } else if (opportunity.position === "lost") {
    const missed = missedMeetingOf(opportunity);
    if (opportunity.systemLoss) {
      headline = SYSTEM_LOSS_SUMMARY[opportunity.systemLoss];
    } else {
      headline = opportunity.lostReason ? (
        <>&ldquo;{opportunity.lostReason}&rdquo;</>
      ) : (
        "Closed as lost, no reason given."
      );
    }
    const closer = assignedCloser?.fullName ?? assignedCloser?.email;
    const by =
      opportunity.lostByUserId === undefined
        ? null
        : opportunity.lostByUserId === opportunity.assignedCloserId && closer
          ? `by ${closer}`
          : "by an admin";
    const at = missed === "canceled" ? meeting.canceledAt : opportunity.lostAt;
    byline = [by ? `Closed ${by}` : "Closed", at ? when(at) : null]
      .filter(Boolean)
      .join(" · ");
  } else if (opportunity.position === "follow_up") {
    if (isWaitingOnRescheduleLink(opportunity)) {
      headline = `Reschedule link sent. Waiting for ${firstName ?? "the lead"} to book.`;
    } else if (activeFollowUp?.type === "manual_reminder") {
      headline = activeFollowUp.reminderScheduledAt
        ? `Reminder set for ${when(activeFollowUp.reminderScheduledAt)}.`
        : "Reminder set.";
    } else if (activeFollowUp) {
      headline = `Scheduling link sent ${when(activeFollowUp.createdAt)}.`;
    } else {
      headline = "Follow-up scheduled.";
    }
    byline = meeting.heldMarkedAt ? `Call recorded ${when(meeting.heldMarkedAt)}` : null;
  } else if (meeting.status === "held") {
    headline = "The call is recorded as held.";
    byline = meeting.heldMarkedAt ? when(meeting.heldMarkedAt) : null;
  } else if (meeting.status === "canceled") {
    headline = "The call was canceled.";
    byline = meeting.canceledAt ? when(meeting.canceledAt) : null;
  } else {
    headline = "No outcome to record on this call.";
  }

  return (
    <section
      aria-label="Outcome"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-4 py-3"
    >
      <StageChip position={opportunity.position} systemLoss={opportunity.systemLoss} />
      <p className="min-w-0 flex-1 basis-56 font-medium">{headline}</p>
      {byline ? (
        <p className="text-[0.8125rem] text-muted-foreground">{byline}</p>
      ) : null}
      {trailing ? <div className="flex flex-wrap gap-2">{trailing}</div> : null}
    </section>
  );
}
