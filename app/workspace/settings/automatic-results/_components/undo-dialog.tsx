"use client";

import { useId, useState } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  ACTION_DIALOG,
  ActionDialogFooter,
  ActionDialogHeader,
  CancelButton,
  SubmitButton,
  SubmitError,
  WhatHappens,
} from "@/app/workspace/_components/action-dialog";
import { getErrorMessage } from "@/lib/errors";
import { kindDefinition } from "./automation-kinds";
import { panelCommandSentence } from "./automation-command-words";

export type AutomaticWrite = FunctionReturnType<typeof api.automation.undo.listAutomaticWrites>["writes"][number];

type CallAnswer = "yes" | "no";

const CALL_ANSWERS: Record<CallAnswer, { label: string; steps: string[] }> = {
  yes: {
    label: "Yes, the call happened",
    steps: [
      "The task the CRM set is removed.",
      "The meeting stays held, and the closer sets the next step.",
    ],
  },
  no: {
    label: "No, the call didn't happen",
    steps: [
      "The task the CRM set is removed.",
      "The meeting goes back to not recorded and the deal goes back to Booked.",
      "The person stops counting as having shown up.",
    ],
  },
};

/** What Undo does for a payment or a refusal, step by step. */
function fixedSteps(write: AutomaticWrite): string[] {
  if (write.kind === "payment_win") {
    return [
      "The payment stops counting. Cash, enrollments and customer status are recalculated.",
      "The deal goes back to where it was before this payment, with its tasks and first-payment date.",
      "The Whop payment returns to Billing's list to be matched again.",
    ];
  }
  if (write.kind === "additional_payment") {
    return [
      "This later payment stops counting. Cash is recalculated.",
      "The deal stays won while another payment on it still counts; with none left, it goes back to where it was before.",
      "The Whop payment returns to Billing's list to be matched again.",
    ];
  }
  return [
    "The deal reopens at Follow-up with a reminder due now for its closer.",
    "The meeting stays held, because the call happened.",
  ];
}

/** One confirmation for Undo. A task kind first asks whether the call happened. */
export default function UndoDialog({ write, onClose }: { write: AutomaticWrite; onClose: () => void }) {
  const id = useId();
  const undo = useMutation(api.automation.undo.undoAutomaticWrite);
  const definition = kindDefinition(write.kind);
  const isTask = write.kind === "call_back" || write.kind === "payment_owed";
  const [answer, setAnswer] = useState<CallAnswer | "">("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (isTask && !answer) return;
    setPending(true);
    setError(null);
    try {
      const result = await undo({
        decisionId: write.decisionId,
        ...(isTask ? { callHappened: answer === "yes" } : {}),
      });
      if (!result.ok) {
        setError(panelCommandSentence(result.code));
        return;
      }
      toast.success("Undone.");
      onClose();
    } catch (cause) {
      setError(getErrorMessage(cause, "Couldn't undo this result."));
    } finally {
      setPending(false);
    }
  };

  const title = write.kind === "refusal_loss" ? "Reopen this deal?" : "Undo this automatic result?";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className={ACTION_DIALOG} showCloseButton={!pending}>
        <ActionDialogHeader title={title} description={`${definition.recordedWords}.`} tone="danger" />
        {isTask ? (
          <div className="flex flex-col gap-2 border-b px-4 py-3">
            <p id={`${id}-question`} className="text-[13px] font-semibold">Did the call happen?</p>
            <RadioGroup
              value={answer}
              onValueChange={(value) => setAnswer(value as CallAnswer)}
              aria-labelledby={`${id}-question`}
              className="flex flex-col gap-2"
            >
              {(Object.keys(CALL_ANSWERS) as CallAnswer[]).map((value) => (
                <label key={value} className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value={value} />
                  {CALL_ANSWERS[value].label}
                </label>
              ))}
            </RadioGroup>
          </div>
        ) : null}
        {isTask ? (
          answer ? <WhatHappens steps={CALL_ANSWERS[answer].steps} /> : null
        ) : (
          <WhatHappens steps={fixedSteps(write)} />
        )}
        <SubmitError>{error}</SubmitError>
        <ActionDialogFooter aside={isTask && !answer ? "Say whether the call happened first." : null}>
          <CancelButton onClick={onClose} disabled={pending} />
          <SubmitButton
            type="button"
            danger
            pending={pending}
            pendingLabel="Undoing…"
            disabled={isTask && !answer}
            onClick={() => void run()}
          >
            {write.kind === "refusal_loss" ? "Reopen the deal" : "Undo"}
          </SubmitButton>
        </ActionDialogFooter>
      </DialogContent>
    </Dialog>
  );
}
