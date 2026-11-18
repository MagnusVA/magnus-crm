"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { reportClientError } from "@/lib/observability/report-client-error";
import { useDayTime } from "./attendance-question";
import { amountWithCode, PendingButton, QuoteFacts, ResultCard, ResultError, ResultFact, ResultFacts } from "./call-ask";
import { useLocalFormat } from "./local-time";
import { StageChip } from "./stage-tone";
import { ChangeNextStepDialog } from "./stop-refusal-dialog";
import {
  automationCodeSentence,
  CONTACT_METHOD_WORDS,
  declineWords,
  summaryByline,
  thrownSentence,
  type CallResultSummaryData,
  type ContactMethod,
} from "./call-result-words";

// What a call set on this meeting (`automation.confirmCall.getCallResultSummary`):
// the task or the loss, "Marked held", the line it rests on while the
// transcript is kept, and who recorded it. A task can be changed, an admin
// can say the call didn't happen, an automatic write can be undone while
// nobody has touched it, and a refusal can be reopened.

type Confirming = "withdraw" | "undo" | null;
type Pending = "withdraw" | "undo_held" | "undo_not_held" | "reopen" | null;

const TASK_STATUS_WORDS = {
  pending: null,
  completed: "done",
  booked: "booked",
  expired: "canceled",
} as const;

/** States 6 and 7: the "Set from the call" summary and the refused summary. */
export function CallResultSummary({
  summary,
  onChanged,
  onActed,
}: {
  summary: CallResultSummaryData;
  onChanged?: () => Promise<void>;
  onActed: () => void;
}) {
  const dayTime = useDayTime();
  const format = useLocalFormat();
  const withdraw = useMutation(api.automation.taskCorrections.callDidNotHappen);
  const undo = useMutation(api.automation.undo.undoAutomaticWrite);
  const reopen = useMutation(api.automation.refusal.reopenRefusal);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [changeOpen, setChangeOpen] = useState(false);

  const { decisionId, task, can } = summary;
  const isRefusal = summary.kind === "refusal_loss";

  const run = async (which: Exclude<Pending, null>, success: string) => {
    setPending(which);
    setError(null);
    try {
      const result =
        which === "withdraw"
          ? await withdraw({ decisionId })
          : which === "reopen"
            ? can.undo
              ? await undo({ decisionId })
              : await reopen({ decisionId })
            : await undo({ decisionId, callHappened: which === "undo_held" });
      if (!result.ok) {
        setError(automationCodeSentence(result.code));
        return;
      }
      setConfirming(null);
      onActed();
      toast.success(success);
      await onChanged?.();
    } catch (err) {
      reportClientError(err, { flow: `call_result_${which}`, kind: summary.kind });
      setError(thrownSentence(err));
    } finally {
      setPending(null);
    }
  };

  const byline = `${summaryByline(summary)} · ${dayTime(summary.resolvedAt)}`;
  const busy = pending !== null;

  if (isRefusal) {
    return (
      <ResultCard
        tone="plain"
        title={summary.lossReason ?? "Refused on the call"}
        chips={<StageChip position="lost" />}
      >
        <p className="text-[0.8125rem] text-muted-foreground">{byline}</p>
        <ResultFacts>
          <ResultFact label="Meeting">Marked held</ResultFact>
          <QuoteFacts quotes={summary.quotes} quotesDeleted={summary.quotesDeleted} />
        </ResultFacts>
        {can.reopen ? (
          <>
            <p className="text-[0.8125rem] leading-[1.45] text-pretty text-muted-foreground">
              Reopening moves the deal to Follow-up with a call-back reminder due now.
            </p>
            <div className="flex flex-wrap gap-2">
              <PendingButton
                pending={pending === "reopen"}
                pendingLabel="Reopening…"
                disabled={busy}
                variant="outline"
                onClick={() => void run("reopen", "Reopened. A call-back reminder is due now.")}
              >
                Reopen
              </PendingButton>
            </div>
          </>
        ) : null}
        <ResultError>{error}</ResultError>
      </ResultCard>
    );
  }

  let taskLine: string | null = null;
  if (task) {
    const method = CONTACT_METHOD_WORDS[task.contactMethod as ContactMethod];
    const status = TASK_STATUS_WORDS[task.status];
    if (task.purpose === "payment_owed") {
      const amount =
        task.expectedAmountMinor !== undefined && task.expectedCurrency
          ? amountWithCode(task.expectedAmountMinor, task.expectedCurrency)
          : null;
      const promised = task.promisedPaymentAt !== undefined ? format(task.promisedPaymentAt, "EEE MMM d") : null;
      taskLine = [
        amount ? `Payment owed: ${amount}` : "Payment owed",
        promised ? `promised ${promised}` : null,
        `reminder ${dayTime(task.reminderScheduledAt)}`,
        method,
        status,
      ]
        .filter(Boolean)
        .join(" · ");
    } else {
      taskLine = [`Call back ${dayTime(task.reminderScheduledAt)}`, method, status].filter(Boolean).join(" · ");
    }
  }

  return (
    <>
      <ResultCard tone="plain" title="Set from the call" chips={<StageChip position="follow_up" />}>
        <p className="text-[0.8125rem] text-muted-foreground">{byline}</p>
        <ResultFacts>
          {taskLine ? <ResultFact label="Task">{taskLine}</ResultFact> : null}
          {task?.declineCode ? <ResultFact label="Declined">{declineWords(task.declineCode)}</ResultFact> : null}
          <ResultFact label="Meeting">Marked held</ResultFact>
          <QuoteFacts quotes={summary.quotes} quotesDeleted={summary.quotesDeleted} />
        </ResultFacts>

        {confirming === "withdraw" ? (
          <div role="group" aria-label="This call didn't happen" className="flex flex-col gap-2 rounded-md border bg-background p-3">
            <p className="text-sm text-pretty">
              {can.changeNextStep
                ? "The task is canceled and the call no longer counts as held. A deal that was booked before the call goes back to Booked."
                : "The call no longer counts as held. The next step that was set afterwards stays, and the deal stays at Follow-up."}
            </p>
            <div className="flex flex-wrap gap-2">
              <PendingButton
                pending={pending === "withdraw"}
                pendingLabel="Saving…"
                disabled={busy}
                variant="destructive"
                className="font-semibold text-danger-ink"
                onClick={() => void run("withdraw", "The call is no longer marked held.")}
              >
                The call didn&rsquo;t happen
              </PendingButton>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirming(null)}>
                Keep it
              </Button>
            </div>
          </div>
        ) : confirming === "undo" ? (
          <div role="group" aria-label="Undo" className="flex flex-col gap-2 rounded-md border bg-background p-3">
            <p className="text-sm font-medium">Did the call happen?</p>
            <p className="text-[0.8125rem] leading-[1.45] text-pretty text-muted-foreground">
              If it did, only the task is canceled. If it didn&rsquo;t, the task is canceled and the call no
              longer counts as held.
            </p>
            <div className="flex flex-wrap gap-2">
              <PendingButton
                pending={pending === "undo_held"}
                pendingLabel="Undoing…"
                disabled={busy}
                onClick={() => void run("undo_held", "Undone. The task is canceled.")}
              >
                It happened
              </PendingButton>
              <PendingButton
                pending={pending === "undo_not_held"}
                pendingLabel="Undoing…"
                disabled={busy}
                variant="outline"
                onClick={() => void run("undo_not_held", "Undone. The call is no longer marked held.")}
              >
                It didn&rsquo;t happen
              </PendingButton>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>
                Keep it
              </Button>
            </div>
          </div>
        ) : can.changeNextStep || can.withdrawAttendance || can.undo ? (
          <div className="flex flex-wrap gap-2">
            {can.changeNextStep && task ? (
              <Button type="button" variant="outline" disabled={busy} onClick={() => setChangeOpen(true)}>
                Change the next step
              </Button>
            ) : null}
            {can.withdrawAttendance ? (
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirming("withdraw")}>
                This call didn&rsquo;t happen
              </Button>
            ) : null}
            {can.undo ? (
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirming("undo")}>
                Undo
              </Button>
            ) : null}
          </div>
        ) : null}
        <ResultError>{error}</ResultError>
      </ResultCard>
      {task ? (
        <ChangeNextStepDialog
          open={changeOpen}
          onOpenChange={setChangeOpen}
          decisionId={decisionId}
          current={{ contactMethod: task.contactMethod as ContactMethod, at: task.reminderScheduledAt }}
          onChanged={() => {
            onActed();
            void onChanged?.();
          }}
        />
      ) : null}
    </>
  );
}
