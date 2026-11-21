"use client";

import { useId, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { format } from "date-fns";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { reportClientError } from "@/lib/observability/report-client-error";
import {
  ACTION_DIALOG,
  ACTION_FORM,
  ActionDialogFooter,
  ActionDialogHeader,
  CancelButton,
  DialogNote,
  FormRow,
  FormRows,
  SubmitButton,
  SubmitError,
} from "@/app/workspace/_components/action-dialog";
import { ReachByRow, WhenRow } from "@/app/workspace/_components/follow-up-dialog-parts";
import { automationCodeSentence, thrownSentence, type ContactMethod } from "./call-result-words";

// Two dialogs that ask for the deal's next step:
// - Stop a pending loss from a call (`automation.notice.stopNotice`): a
//   call-back time and Call / Text, or keep the deal open with a reminder due
//   now.
// - Change the next step a call set (`automation.taskCorrections.changeNextStep`):
//   a new time and Call / Text.

const schema = z
  .object({
    choice: z.enum(["call_back", "keep_open"]),
    contactMethod: z.enum(["call", "text"]),
    date: z.string(),
    time: z.string(),
  })
  .superRefine((values, ctx) => {
    if (values.choice !== "call_back") return;
    if (!values.date) ctx.addIssue({ code: "custom", path: ["date"], message: "Pick a day" });
    if (!values.time) ctx.addIssue({ code: "custom", path: ["time"], message: "Pick a time" });
  });
type Values = z.infer<typeof schema>;

export type NextStep =
  | { kind: "call_back"; contactMethod: ContactMethod; reminderScheduledAt: number }
  | { kind: "keep_open" };

type Outcome = { ok: true } | { ok: false; sentence: string };

type NextStepDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  allowKeepOpen: boolean;
  initial?: { contactMethod: ContactMethod; at: number };
  submitLabel: string;
  note?: string;
  onSubmit: (step: NextStep) => Promise<Outcome>;
};

function NextStepDialog({ open, onOpenChange, title, description, ...form }: NextStepDialogProps) {
  // The form mounts with the dialog's content, so each opening starts from
  // the current task.
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className={ACTION_DIALOG}>
        <ActionDialogHeader title={title} description={description} />
        <NextStepForm {...form} onBusyChange={setBusy} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function NextStepForm({
  allowKeepOpen,
  initial,
  submitLabel,
  note,
  onSubmit,
  onBusyChange,
  onDone,
}: Omit<NextStepDialogProps, "open" | "onOpenChange" | "title" | "description"> & {
  onBusyChange: (busy: boolean) => void;
  onDone: () => void;
}) {
  const ids = useId();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const form = useForm<Values>({
    resolver: standardSchemaResolver(schema),
    defaultValues: {
      choice: "call_back",
      contactMethod: initial?.contactMethod ?? "call",
      date: initial ? format(initial.at, "yyyy-MM-dd") : "",
      time: initial ? format(initial.at, "HH:mm") : "",
    },
  });
  const { errors } = form.formState;
  const choice = useWatch({ control: form.control, name: "choice" });

  const submit = async (values: Values) => {
    let step: NextStep;
    if (values.choice === "keep_open") {
      step = { kind: "keep_open" };
    } else {
      const at = new Date(`${values.date}T${values.time}`).getTime();
      // eslint-disable-next-line react-hooks/purity -- runs on submit; the compiler can't see past form.handleSubmit
      if (Number.isNaN(at) || at <= Date.now()) {
        setSubmitError("Pick a time later than now.");
        return;
      }
      step = { kind: "call_back", contactMethod: values.contactMethod, reminderScheduledAt: at };
    }
    setSubmitting(true);
    onBusyChange(true);
    setSubmitError(null);
    try {
      const outcome = await onSubmit(step);
      if (outcome.ok) onDone();
      else setSubmitError(outcome.sentence);
    } finally {
      setSubmitting(false);
      onBusyChange(false);
    }
  };

  return (
    <form onSubmit={form.handleSubmit(submit)} className={ACTION_FORM} noValidate>
      <SubmitError>{submitError}</SubmitError>
      <FormRows>
        {allowKeepOpen ? (
          <FormRow label="Next step" labelHidden>
            <Controller
              control={form.control}
              name="choice"
              render={({ field }) => (
                <RadioGroup
                  value={field.value}
                  onValueChange={field.onChange}
                  disabled={submitting}
                  aria-label="Next step"
                  className="gap-3"
                >
                  <div className="flex items-center gap-2.5">
                    <RadioGroupItem value="call_back" id={`${ids}-call-back`} />
                    <Label htmlFor={`${ids}-call-back`} className="font-normal">
                      Call back at a set time
                    </Label>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <RadioGroupItem value="keep_open" id={`${ids}-keep-open`} />
                    <Label htmlFor={`${ids}-keep-open`} className="font-normal">
                      Keep it open with a reminder due now
                    </Label>
                  </div>
                </RadioGroup>
              )}
            />
          </FormRow>
        ) : null}
        {choice === "call_back" ? (
          <>
            <Controller
              control={form.control}
              name="contactMethod"
              render={({ field, fieldState }) => (
                <ReachByRow
                  value={field.value}
                  onChange={field.onChange}
                  disabled={submitting}
                  error={fieldState.error}
                />
              )}
            />
            <WhenRow
              date={form.register("date")}
              time={form.register("time")}
              min={format(new Date(), "yyyy-MM-dd")}
              disabled={submitting}
              dateError={errors.date}
              timeError={errors.time}
            />
          </>
        ) : null}
      </FormRows>
      {note ? <DialogNote>{note}</DialogNote> : null}
      <ActionDialogFooter>
        <CancelButton onClick={onDone} disabled={submitting} />
        <SubmitButton pending={submitting} pendingLabel="Saving…">
          {submitLabel}
        </SubmitButton>
      </ActionDialogFooter>
    </form>
  );
}

/** State 11: Stop a pending loss, with the next step it asks for. */
export function StopRefusalDialog({
  open,
  onOpenChange,
  decisionId,
  firstName,
  onStopped,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  decisionId: Id<"resultAutomationDecisions">;
  firstName: string | null;
  /** The stop landed; the page reloads and moves focus. */
  onStopped: () => void;
}) {
  const stop = useMutation(api.automation.notice.stopNotice);
  const who = firstName ?? "the prospect";
  return (
    <NextStepDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Stop the loss and set a next step"
      description={`The deal with ${who} stays open. Pick when to call back, or keep it open with a reminder due now.`}
      allowKeepOpen
      submitLabel="Stop and set the next step"
      note="The call is marked held. The same recording won't propose this loss again."
      onSubmit={async (nextStep) => {
        try {
          const result = await stop({ decisionId, nextStep });
          if (!result.ok) return { ok: false, sentence: automationCodeSentence(result.code) };
          toast.success("Stopped. The deal stays open.");
          onStopped();
          return { ok: true };
        } catch (error) {
          reportClientError(error, { flow: "call_notice_stop" });
          return { ok: false, sentence: thrownSentence(error) };
        }
      }}
    />
  );
}

/** "Change the next step" on a task a call set: a new time and Call / Text. */
export function ChangeNextStepDialog({
  open,
  onOpenChange,
  decisionId,
  current,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  decisionId: Id<"resultAutomationDecisions">;
  current: { contactMethod: ContactMethod; at: number };
  onChanged: () => void;
}) {
  const change = useMutation(api.automation.taskCorrections.changeNextStep);
  return (
    <NextStepDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Change the next step"
      description="The task set from the call is canceled and a new one takes its place."
      allowKeepOpen={false}
      initial={current}
      submitLabel="Save the next step"
      onSubmit={async (step) => {
        if (step.kind !== "call_back") return { ok: false, sentence: "Pick a time." };
        try {
          const result = await change({
            decisionId,
            contactMethod: step.contactMethod,
            reminderScheduledAt: step.reminderScheduledAt,
          });
          if (!result.ok) return { ok: false, sentence: automationCodeSentence(result.code) };
          toast.success("Next step changed.");
          onChanged();
          return { ok: true };
        } catch (error) {
          reportClientError(error, { flow: "call_task_change" });
          return { ok: false, sentence: thrownSentence(error) };
        }
      }}
    />
  );
}
