"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useIdle } from "@/hooks/use-idle";
import {
  ArrowRightIcon,
  BanknoteIcon,
  CalendarPlusIcon,
  CheckIcon,
  CornerUpLeftIcon,
  PhoneMissedIcon,
  XIcon,
} from "lucide-react";
import { dealPositionLabel } from "@/convex/opportunities/stageLabels";
import { Button } from "@/components/ui/button";
import type { BusinessDaySetting } from "@/lib/businessDay";
import { isReminderDealFinished } from "@/lib/deal-controls";
import { formatDateTime } from "@/app/workspace/closer/_components/today-time";
import {
  ChoiceButton,
  OutcomeHeading,
} from "@/app/workspace/closer/meetings/_components/outcome-section";
import { StageChip } from "@/app/workspace/closer/meetings/_components/stage-tone";
import type { NoAnswerStep } from "./reminder-no-answer-dialog";
import type { TaskDetail, TaskDetailMode } from "./task-detail-types";

const ReminderPaymentDialog = dynamic(() =>
  import("./reminder-payment-dialog").then((m) => ({ default: m.ReminderPaymentDialog })),
);
const ReminderMarkLostDialog = dynamic(() =>
  import("./reminder-mark-lost-dialog").then((m) => ({ default: m.ReminderMarkLostDialog })),
);
const ReminderTryAgainDialog = dynamic(() =>
  import("./reminder-try-again-dialog").then((m) => ({ default: m.ReminderTryAgainDialog })),
);
const ReminderNoAnswerDialog = dynamic(() =>
  import("./reminder-no-answer-dialog").then((m) => ({ default: m.ReminderNoAnswerDialog })),
);

type OutcomeDialog = "payment" | "lost" | "try_again" | NoAnswerStep;

type TaskOutcomeSectionProps = {
  detail: TaskDetail;
  mode: TaskDetailMode;
  setting: BusinessDaySetting;
  firstName: string;
  leadName: string | null;
  /** On the admin twin, the task's closer, who the payment is credited to. */
  closerName: string | null;
  /** After an outcome closes the task: the next task, or Today. */
  onCompleted: () => void;
};

/**
 * The task's one next action. Depending on the task and its deal it is:
 *
 * - the two-step question ("Did you reach Ana?", then what happened),
 * - on the admin twin, Won · log payment only, which the backend allows
 *   admins on the closer's behalf,
 * - for a stale-deal nudge, a pointer to the deal, where it is resolved,
 * - a quiet line when the deal finished elsewhere (`isReminderDealFinished`),
 * - a one-line summary once an outcome closed the task.
 *
 * Nothing is written until a step-2 choice is confirmed in its dialog, and
 * the mutations check the task and the deal again.
 */
export function TaskOutcomeSection({
  detail,
  mode,
  setting,
  firstName,
  leadName,
  closerName,
  onCompleted,
}: TaskOutcomeSectionProps) {
  const { followUp, opportunity, lead } = detail;
  const [dialog, setDialog] = useState<OutcomeDialog | null>(null);
  // A dialog stays mounted once opened, so the task closing underneath never
  // unmounts it mid-flow.
  const [mounted, setMounted] = useState<ReadonlySet<OutcomeDialog>>(new Set());
  // Once the browser is idle, every outcome dialog mounts closed: a lazy
  // component suspends on its first render even with its code loaded, so
  // doing that early means a pick opens its dialog at once.
  const idle = useIdle();
  const shown = (key: OutcomeDialog) => idle || mounted.has(key);

  const openDialog = (next: OutcomeDialog) => {
    setMounted((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
    setDialog(next);
  };
  const dialogState = (key: OutcomeDialog) => ({
    open: dialog === key,
    onOpenChange: (open: boolean) => setDialog(open ? key : null),
    onSuccess: onCompleted,
  });

  let body: React.ReactNode;
  if (followUp.status !== "pending") {
    body = <TaskSummary detail={detail} setting={setting} />;
  } else if (followUp.reason === "stale_opportunity_nudge") {
    body = (
      <section
        aria-labelledby="outcome-heading"
        className="flex flex-col gap-3 rounded-xl border bg-card px-4 py-3.5 @container"
      >
        <h2 id="outcome-heading" className="text-lg leading-tight font-semibold text-balance">
          Resolve this on the deal
        </h2>
        <p className="text-muted-foreground">
          A gone-quiet deal closes from the deal itself: log a payment, mark it lost, or delete
          the empty deal there. The task closes with it.
        </p>
        <Button asChild size="lg" className="self-start px-3.5 font-semibold">
          <Link href={`/workspace/leads-customers/${lead._id}?opportunityId=${opportunity._id}`}>
            Open deal
            <ArrowRightIcon data-icon="inline-end" aria-hidden />
          </Link>
        </Button>
      </section>
    );
  } else if (isReminderDealFinished(opportunity)) {
    body = (
      <section
        aria-label="Outcome"
        className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-4 py-3"
      >
        <StageChip position={opportunity.position} systemLoss={opportunity.systemLoss} />
        <p className="min-w-0 flex-1 basis-56 font-medium">
          This deal is already{" "}
          {dealPositionLabel(opportunity.position, opportunity.systemLoss).toLowerCase()}, so
          there&rsquo;s nothing to record on this task.
        </p>
      </section>
    );
  } else if (mode === "admin") {
    body = (
      <AdminPaymentPanel
        firstName={firstName}
        closerName={closerName}
        onPick={() => openDialog("payment")}
      />
    );
  } else {
    body = (
      <TaskOutcomeQuestion
        firstName={firstName}
        method={followUp.contactMethod === "text" ? "text" : "call"}
        onPick={openDialog}
      />
    );
  }

  return (
    <>
      {body}

      {/* A dialog suspends on its first render; this boundary keeps that wait
          to the dialog instead of the page's loading skeleton. */}
      <Suspense fallback={null}>
        {shown("payment") ? (
          <ReminderPaymentDialog
            followUpId={followUp._id}
            leadName={leadName}
            defaultProgramId={opportunity.firstBookingProgramId ?? null}
            actingFor={mode === "admin" ? closerName : null}
            {...dialogState("payment")}
          />
        ) : null}
        {shown("lost") ? (
          <ReminderMarkLostDialog
            followUpId={followUp._id}
            leadName={leadName}
            {...dialogState("lost")}
          />
        ) : null}
        {shown("try_again") ? (
          <ReminderTryAgainDialog
            followUpId={followUp._id}
            firstName={firstName}
            method={followUp.contactMethod === "text" ? "text" : "call"}
            dueAt={followUp.reminderScheduledAt ?? null}
            {...dialogState("try_again")}
          />
        ) : null}
        {(["close_only", "give_up"] as const).map((step) =>
          shown(step) ? (
            <ReminderNoAnswerDialog
              key={step}
              followUpId={followUp._id}
              nextStep={step}
              firstName={firstName}
              leadName={leadName}
              dealStageLabel={dealPositionLabel(opportunity.position, opportunity.systemLoss)}
              {...dialogState(step)}
            />
          ) : null,
        )}
      </Suspense>
    </>
  );
}

// ─── The question ────────────────────────────────────────────────────────────

type Reached = "yes" | "no" | null;

function TaskOutcomeQuestion({
  firstName,
  method,
  onPick,
}: {
  firstName: string;
  method: "call" | "text";
  onPick: (dialog: OutcomeDialog) => void;
}) {
  // Step 1 records nothing: it only picks which choices step 2 offers.
  const [reached, setReached] = useState<Reached>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // Moving between the steps moves focus to the new question.
  const toggled = useRef(false);
  useEffect(() => {
    if (!toggled.current) return;
    heading.current?.focus();
  }, [reached]);
  const step = (next: Reached) => {
    toggled.current = true;
    setReached(next);
  };
  const question = `Did you reach ${firstName}?`;

  return (
    <section
      aria-labelledby="outcome-heading"
      className="@container overflow-hidden rounded-xl border-2 border-primary bg-card"
    >
      {reached === null ? (
        <>
          <OutcomeHeading ref={heading}>{question}</OutcomeHeading>
          <p className="px-4 text-muted-foreground @md:px-5">
            Record it after the {method === "text" ? "text" : "call"}. Nothing is saved until
            you pick what happens next.
          </p>
          <div className="grid gap-3 p-4 @md:px-5 @sm:grid-cols-2">
            <ChoiceButton
              tone="yes"
              icon={<CheckIcon />}
              title="Yes, we talked"
              detail="Then: Won · log payment, or Lost."
              onClick={() => step("yes")}
            />
            <ChoiceButton
              tone="no"
              icon={<PhoneMissedIcon />}
              title="No answer"
              detail="Then: try again, close this task, or mark the deal lost."
              onClick={() => step("no")}
            />
          </div>
          <p className="border-t bg-background px-4 py-2.5 text-[0.8125rem] text-muted-foreground @md:px-5">
            Every outcome closes this task. A win closes the deal as won and credits you.
          </p>
        </>
      ) : (
        <>
          {reached === "yes" ? (
            <>
              <OutcomeHeading ref={heading}>How did it end?</OutcomeHeading>
              <p className="px-4 text-muted-foreground @md:px-5">
                You reached {firstName}. Each choice closes this task.
              </p>
              <div className="grid gap-2.5 p-4 @md:px-5 @lg:grid-cols-2">
                <ChoiceButton
                  tone="won"
                  icon={<BanknoteIcon />}
                  title="Won · log payment"
                  detail="Closes the deal as won with the payment."
                  onClick={() => onPick("payment")}
                />
                <ChoiceButton
                  tone="lost"
                  icon={<XIcon />}
                  title="Lost"
                  detail="Closes the deal as lost, with a reason."
                  onClick={() => onPick("lost")}
                />
              </div>
            </>
          ) : (
            <>
              <OutcomeHeading ref={heading}>No answer. What next?</OutcomeHeading>
              <p className="px-4 text-muted-foreground @md:px-5">
                Each choice closes this task. Only the last one changes the deal.
              </p>
              <div className="grid gap-2.5 p-4 @md:px-5 @2xl:grid-cols-3">
                <ChoiceButton
                  tone="plain"
                  icon={<CalendarPlusIcon />}
                  title="Try again"
                  detail="Sets a new task to call or text, on the day and time you pick."
                  onClick={() => onPick("try_again")}
                />
                <ChoiceButton
                  tone="plain"
                  icon={<CheckIcon />}
                  title="Close this task only"
                  detail="The deal stays as it is, and nothing new is scheduled."
                  onClick={() => onPick("close_only")}
                />
                <ChoiceButton
                  tone="lost"
                  icon={<XIcon />}
                  title="Mark the deal lost"
                  detail="Closes the deal as lost for no response."
                  onClick={() => onPick("give_up")}
                />
              </div>
            </>
          )}
          <div className="flex items-center border-t bg-background px-4 py-1.5 @md:px-5">
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 text-muted-foreground"
              onClick={() => step(null)}
            >
              <CornerUpLeftIcon data-icon="inline-start" aria-hidden />
              Back to &ldquo;{question}&rdquo;
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

// ─── The admin twin ──────────────────────────────────────────────────────────

function AdminPaymentPanel({
  firstName,
  closerName,
  onPick,
}: {
  firstName: string;
  closerName: string | null;
  onPick: () => void;
}) {
  const closer = closerName ?? "the task’s closer";
  return (
    <section
      aria-labelledby="outcome-heading"
      className="@container overflow-hidden rounded-xl border-2 border-primary bg-card"
    >
      <OutcomeHeading ref={null}>Log a payment for {firstName}?</OutcomeHeading>
      <p className="px-4 text-muted-foreground @md:px-5">
        Acting for <b className="font-semibold text-foreground">{closer}</b>. The payment is
        credited to them.
      </p>
      <div className="grid gap-3 p-4 @md:px-5 @md:grid-cols-[minmax(0,22rem)]">
        <ChoiceButton
          tone="won"
          icon={<BanknoteIcon />}
          title="Won · log payment"
          detail="Closes the deal as won and closes this task."
          onClick={onPick}
        />
      </div>
      <p className="border-t bg-background px-4 py-2.5 text-[0.8125rem] text-muted-foreground @md:px-5">
        Lost and no-answer outcomes stay with {closer}.
      </p>
    </section>
  );
}

// ─── After the outcome ───────────────────────────────────────────────────────

/** What the closed task recorded, in a line, from `completionOutcome` and its note. */
function TaskSummary({ detail, setting }: { detail: TaskDetail; setting: BusinessDaySetting }) {
  const { followUp, opportunity } = detail;
  const note = followUp.completionNote?.trim();
  const quoted = note ? <>&ldquo;{note}&rdquo;</> : null;

  let headline: React.ReactNode;
  switch (followUp.completionOutcome) {
    case "payment_received":
      headline = "Won · payment logged.";
      break;
    case "lost":
      headline = quoted ? <>Closed as lost: {quoted}</> : "Closed as lost, no reason given.";
      break;
    case "no_response_rescheduled":
      headline = "No answer. A new task was set to try again.";
      break;
    case "no_response_close_only":
      headline = quoted ? (
        <>No answer. Closed this task only: {quoted}</>
      ) : (
        "No answer. Closed this task only; the deal was left as it was."
      );
      break;
    case "no_response_given_up":
      headline = quoted ? (
        <>No answer. Closed the deal as lost: {quoted}</>
      ) : (
        "No answer. Closed the deal as lost."
      );
      break;
    default:
      headline =
        followUp.status === "expired"
          ? "This task expired."
          : followUp.status === "booked"
            ? "Closed when a call was booked."
            : "This task is closed.";
  }

  return (
    <section
      aria-label="Outcome"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-4 py-3"
    >
      <StageChip position={opportunity.position} systemLoss={opportunity.systemLoss} />
      <p className="min-w-0 flex-1 basis-56 font-medium">{headline}</p>
      {followUp.completedAt ? (
        <p className="text-[0.8125rem] text-muted-foreground tabular-nums">
          Closed {formatDateTime(followUp.completedAt, setting.timeZone)}
        </p>
      ) : null}
    </section>
  );
}
