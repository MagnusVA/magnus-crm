"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { LABEL } from "@/app/workspace/team/_components/team-ui";
import { cn } from "@/lib/utils";
import { Fact, ROW_FIGURE, formatTime, possessive, type AffectedCall } from "./redistribute-ui";

// The wizard's two confirmations, in the tenant delete dialog's pattern:
// the title names what changes, one line says what happens, dense facts,
// the numbered steps the server takes, then Cancel and the confirm.

type ConfirmProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Runs the change; resolves false when it failed (the caller toasts), which keeps the dialog open. */
  onConfirm: () => Promise<boolean>;
};

function ConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  consequence,
  danger,
  facts,
  steps,
  cancelLabel,
  confirmLabel,
  busyLabel,
}: ConfirmProps & {
  title: ReactNode;
  consequence: ReactNode;
  danger?: boolean;
  facts: Array<{ label: string; value: ReactNode }>;
  steps: string[];
  cancelLabel: string;
  confirmLabel: string;
  busyLabel: string;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      if (await onConfirm()) onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!isSubmitting) onOpenChange(next);
      }}
    >
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg" showCloseButton={!isSubmitting}>
        <DialogHeader className="border-b px-4 pt-4 pr-12 pb-3.5">
          <DialogTitle className="text-[17px] font-semibold text-balance">{title}</DialogTitle>
          <DialogDescription className={cn("text-[13px]", danger ? "text-danger-ink" : "text-muted-foreground")}>
            {consequence}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-col">
          <dl className="border-b py-1">
            {facts.map((fact) => (
              <Fact key={fact.label} label={fact.label}>
                {fact.value}
              </Fact>
            ))}
          </dl>

          <div className="pt-2.5">
            <p className={`${LABEL} px-4 pb-1.5`}>What happens</p>
            <ol className="text-[13px] leading-[1.45]">
              {steps.map((step, index) => (
                <li key={step} className="flex gap-2.5 border-t px-4 py-[7px]">
                  <span className="w-3 shrink-0 font-condensed text-[14px] font-semibold text-muted-foreground tabular-nums">
                    {index + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-background px-4 py-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              {cancelLabel}
            </Button>
            <Button
              type="submit"
              variant={danger ? "destructive" : "default"}
              disabled={isSubmitting}
              className="font-semibold"
            >
              {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
              {isSubmitting ? busyLabel : confirmLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function callsWord(count: number) {
  return count === 1 ? "call" : "calls";
}

/** Confirms autoDistributeMeetings: which calls, whose, to whom. */
export function MoveCallsDialog({
  closerName,
  day,
  calls,
  pendingCount,
  toNames,
  ...props
}: ConfirmProps & {
  closerName: string;
  /** "Thursday, Nov 5", with the hours for part of a day. */
  day: string;
  /** The selected calls, earliest first. */
  calls: AffectedCall[];
  /** How many of the closer's calls are still theirs. */
  pendingCount: number;
  toNames: string[];
}) {
  const count = calls.length;
  const first = calls[0];
  const last = calls[count - 1];
  const title =
    count === pendingCount
      ? count === 1
        ? `Move ${possessive(closerName)} call?`
        : `Move all ${count} of ${possessive(closerName)} calls?`
      : `Move ${count} of ${possessive(closerName)} calls?`;

  return (
    <ConfirmDialog
      {...props}
      title={title}
      consequence={`${count === 1 ? "It goes" : "They go"} to the closers below as soon as you confirm.`}
      facts={[
        { label: "Closer out", value: closerName },
        { label: "Day", value: day },
        {
          label: "Calls",
          value: first ? (
            <span className={ROW_FIGURE}>
              {count}
              <span className="font-sans text-sm font-normal text-muted-foreground">
                {" · "}
                {count === 1 ? formatTime(first.scheduledAt) : `${formatTime(first.scheduledAt)} to ${formatTime(last.scheduledAt)}`}
              </span>
            </span>
          ) : (
            "0"
          ),
        },
        { label: "To", value: toNames.join(", ") },
      ]}
      steps={[
        "Each call, earliest first, goes to one of these closers who is free then: not off, and no other call within 15 minutes of it.",
        "Among the free ones, fewer calls that day and more room around the call win.",
        `The deal and all its calls move to that closer, and the call notes it came from ${closerName}.`,
        `A call nobody is free for stays with ${closerName}; you assign or cancel it next.`,
        "Nobody is notified, and the Calendly booking doesn't change.",
      ]}
      cancelLabel="Cancel"
      confirmLabel={`Move ${count} ${callsWord(count)}`}
      busyLabel="Moving…"
    />
  );
}

/** Confirms manuallyResolveMeeting with action "cancel". */
export function CancelCallDialog({
  call,
  closerName,
  day,
  ...props
}: ConfirmProps & {
  call: AffectedCall;
  closerName: string;
  day: string;
}) {
  const lead = call.leadName ?? "Unknown lead";
  return (
    <ConfirmDialog
      {...props}
      danger
      title={
        <>
          Cancel the call with <span translate="no">{lead}</span>?
        </>
      }
      consequence="Calendly keeps the booking, so tell the lead yourself."
      facts={[
        { label: "Lead", value: <span translate="no">{lead}</span> },
        {
          label: "Time",
          value: (
            <>
              {day} ·{" "}
              <span className={ROW_FIGURE}>{formatTime(call.scheduledAt)}</span> · {call.durationMinutes} min
            </>
          ),
        },
        { label: "Closer", value: closerName },
      ]}
      steps={[
        "The call is marked canceled.",
        "A Booked or Call held deal closes as lost, with the reason Canceled. Any other deal stays where it is.",
      ]}
      cancelLabel="Keep call"
      confirmLabel="Cancel call"
      busyLabel="Canceling…"
    />
  );
}
