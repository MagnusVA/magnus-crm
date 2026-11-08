"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useForm, Controller, type FieldError, type UseFormRegisterReturn } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { CalendarPlusIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import { z } from "zod";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DayDefinition } from "@/app/workspace/_components/day-definition";
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
import { getErrorMessage } from "@/lib/errors";

// The pieces the follow-up dialogs share: the closer's (`FollowUpDialog`) and
// the admin's (`AdminFollowUpDialog`) run the same three steps (choose a
// scheduling link or a reminder, fill it, then copy the link), and the task
// page's Try again dialog reuses the Reach by and When rows. Each dialog keeps
// its own mutations, events and toasts and hands them in as callbacks.

// ─── Rows ────────────────────────────────────────────────────────────────────

/** One side of the segmented toggle; the chosen side lifts (DESIGN.md, Segment lift). */
const SEGMENT =
  "h-[26px] rounded-[5px]! px-3 text-[13px] text-muted-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-[0_1px_2px_rgb(20_26_40/0.12)]";

/** "Reach by": the Call / Text segmented toggle in a form row. */
export function ReachByRow({
  value,
  onChange,
  disabled,
  error,
}: {
  value: "call" | "text";
  onChange: (value: "call" | "text") => void;
  disabled?: boolean;
  error?: FieldError;
}) {
  return (
    <FormRow label="Reach by" invalid={Boolean(error)} error={error}>
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(next) => {
          // A segmented toggle always keeps one side on.
          if (next === "call" || next === "text") onChange(next);
        }}
        disabled={disabled}
        aria-label="Reach by"
        className="rounded-[7px] border bg-background p-0.5"
      >
        <ToggleGroupItem value="call" className={SEGMENT}>
          Call
        </ToggleGroupItem>
        <ToggleGroupItem value="text" className={SEGMENT}>
          Text
        </ToggleGroupItem>
      </ToggleGroup>
    </FormRow>
  );
}

/** "When": the date and the time side by side, with the time zone they follow. */
export function WhenRow({
  date,
  time,
  min,
  disabled,
  dateError,
  timeError,
}: {
  date: UseFormRegisterReturn;
  time: UseFormRegisterReturn;
  /** The first day the picker offers; the schema is the real guard. */
  min: string;
  disabled?: boolean;
  dateError?: FieldError;
  timeError?: FieldError;
}) {
  const ids = useId();
  // One error line: the date's first, then the time's.
  const error = dateError ?? timeError;
  return (
    <FormRow label="When" htmlFor={`${ids}-date`} invalid={Boolean(error)} error={error}>
      <div className="grid grid-cols-2 gap-2">
        <Input
          id={`${ids}-date`}
          type="date"
          aria-label="Date"
          aria-invalid={Boolean(dateError) || undefined}
          min={min}
          disabled={disabled}
          className="font-condensed text-[15px] tabular-nums"
          {...date}
        />
        <Input
          type="time"
          aria-label="Time"
          aria-invalid={Boolean(timeError) || undefined}
          disabled={disabled}
          className="font-condensed text-[15px] tabular-nums"
          {...time}
        />
      </div>
      <DayDefinition browser />
    </FormRow>
  );
}

/** A note row: an optional textarea. */
export function NoteRow({
  label,
  placeholder,
  rows = 2,
  disabled,
  error,
  field,
}: {
  label: string;
  placeholder: string;
  rows?: number;
  disabled?: boolean;
  error?: FieldError;
  field: UseFormRegisterReturn;
}) {
  const ids = useId();
  return (
    <FormRow label={label} htmlFor={`${ids}-note`} invalid={Boolean(error)} error={error}>
      <Textarea
        id={`${ids}-note`}
        rows={rows}
        placeholder={placeholder}
        aria-invalid={Boolean(error) || undefined}
        className="resize-none text-sm"
        disabled={disabled}
        {...field}
      />
    </FormRow>
  );
}

// ─── The follow-up dialog ────────────────────────────────────────────────────

type FollowUpPath = "selection" | "scheduling_link" | "manual_reminder";

/** The words that differ between the closer's dialog and the admin's. */
export type FollowUpCopy = {
  /** The consequence on the scheduling-link choice. */
  linkChoice: string;
  /** The consequence on the reminder choice. */
  reminderChoice: string;
  /** What creating the link does, above its button. */
  linkNote: string;
  /** Once the link exists: where it waits. */
  linkReady: string;
};

export type NewReminder = {
  contactMethod: "call" | "text";
  reminderScheduledAt: number;
  reminderNote: string | undefined;
};

/**
 * Both follow-up dialogs: choose a scheduling link or a reminder, fill it in,
 * and for a link, copy it. Back returns to the choice until a link exists;
 * once one does, the deal has moved and the dialog only offers the link.
 * Closing resets it to the choice.
 */
export function FollowUpDialogShell({
  open: controlledOpen,
  onOpenChange,
  triggerSize,
  meetingId,
  leadName,
  copy,
  createLink,
  onLinkCreated,
  copyLink,
  createReminder,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The trigger's size when the dialog isn't controlled. */
  triggerSize: "sm" | "lg";
  meetingId?: Id<"meetings">;
  leadName?: string | null;
  copy: FollowUpCopy;
  /** Runs the link mutation and returns the link. */
  createLink: () => Promise<string>;
  /** After the link exists: the refresh and the event. */
  onLinkCreated: () => void;
  /** Writes the link to the clipboard, with its toast and event. */
  copyLink: (url: string) => Promise<void>;
  /** Runs the reminder mutation, the refresh, the event and the toast. */
  createReminder: (reminder: NewReminder) => Promise<void>;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [path, setPath] = useState<FollowUpPath>("selection");
  // Once a link is generated the deal has moved; the dialog only shows the
  // link to copy, with no way back to the other path.
  const [linkGenerated, setLinkGenerated] = useState(false);
  const [pending, setPending] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = controlledOpen ?? internalOpen;

  const setOpen = (value: boolean) => {
    if (!isControlled) setInternalOpen(value);
    onOpenChange?.(value);
    if (!value) {
      setLinkGenerated(false);
      setTimeout(() => setPath("selection"), 200);
    }
  };
  const handleOpenChange = (value: boolean) => {
    if (pending) return; // don't dismiss mid-submit
    setOpen(value);
  };
  const close = () => handleOpenChange(false);
  const back = () => setPath("selection");

  const possessive = leadName ? `${leadName}’s` : null;
  const moves = meetingId
    ? `The call is marked held and ${possessive ?? "the"} deal moves to Follow-up.`
    : `${possessive ?? "The"} deal moves to Follow-up.`;
  const who = leadName ?? "the lead";

  const header =
    path === "scheduling_link" ? (
      <ActionDialogHeader
        title={linkGenerated ? `Send ${who} this link` : `Send ${who} a scheduling link`}
        description={linkGenerated ? copy.linkReady : moves}
      />
    ) : path === "manual_reminder" ? (
      <ActionDialogHeader title={`Set a reminder to reach ${who}`} description={moves} />
    ) : (
      <ActionDialogHeader title={leadName ? `Schedule a follow-up with ${leadName}` : "Schedule follow-up"} description={moves} />
    );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {isControlled ? null : (
        <DialogTrigger asChild>
          <Button variant="outline" size={triggerSize}>
            <CalendarPlusIcon data-icon="inline-start" />
            Schedule follow-up
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className={ACTION_DIALOG} showCloseButton={!pending}>
        {header}
        {path === "selection" ? (
          <>
            <ul className="divide-y border-b">
              <ChoiceRow title="Scheduling link" consequence={copy.linkChoice} onSelect={() => setPath("scheduling_link")} />
              <ChoiceRow title="Reminder" consequence={copy.reminderChoice} onSelect={() => setPath("manual_reminder")} />
            </ul>
            <ActionDialogFooter>
              <CancelButton onClick={close} />
            </ActionDialogFooter>
          </>
        ) : null}
        {path === "scheduling_link" ? (
          <LinkStep
            note={copy.linkNote}
            createLink={createLink}
            onCreated={() => {
              setLinkGenerated(true);
              onLinkCreated();
            }}
            copyLink={copyLink}
            onPendingChange={setPending}
            onBack={back}
            onClose={close}
          />
        ) : null}
        {path === "manual_reminder" ? (
          <ReminderStep
            createReminder={createReminder}
            onPendingChange={setPending}
            onBack={back}
            onDone={() => {
              setPending(false);
              setOpen(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** One choice: its name in the label column, its consequence beside it, ruled. */
function ChoiceRow({ title, consequence, onSelect }: { title: string; consequence: string; onSelect: () => void }) {
  return (
    <li className="@container">
      <button
        type="button"
        onClick={onSelect}
        className="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span className="grid min-w-0 flex-1 gap-0.5 @lg:grid-cols-[7.5rem_minmax(0,1fr)] @lg:items-baseline @lg:gap-x-3">
          <span className="text-sm font-medium">{title}</span>
          <span className="text-[13px] leading-[1.45] text-muted-foreground">{consequence}</span>
        </span>
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
    </li>
  );
}

/**
 * The scheduling link: create it, then copy it. Creating it moves the deal at
 * once, so Done only closes the dialog. The meeting page keeps the dialog
 * mounted while the deal moves underneath it.
 */
function LinkStep({
  note,
  createLink,
  onCreated,
  copyLink,
  onPendingChange,
  onBack,
  onClose,
}: {
  note: string;
  createLink: () => Promise<string>;
  onCreated: () => void;
  copyLink: (url: string) => Promise<void>;
  onPendingChange: (pending: boolean) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const ids = useId();
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  const generate = async () => {
    setState("loading");
    onPendingChange(true);
    setError(null);
    try {
      const link = await createLink();
      setUrl(link);
      onCreated();
      setState("success");
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Failed to create scheduling link."));
      setState("error");
    } finally {
      onPendingChange(false);
    }
  };

  const copy = async () => {
    if (!url) return;
    await copyLink(url);
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  if (state === "success" && url) {
    return (
      <div className={ACTION_FORM}>
        <FormRows>
          <FormRow label="Link" htmlFor={`${ids}-link`}>
            <Input
              id={`${ids}-link`}
              value={url}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
              className="font-mono text-xs"
              aria-label="Scheduling link"
            />
          </FormRow>
        </FormRows>
        <ActionDialogFooter>
          <CancelButton onClick={onClose}>Done</CancelButton>
          <SubmitButton
            type="button"
            pending={false}
            pendingLabel="Copying…"
            onClick={() => void copy()}
          >
            <CopyIcon data-icon="inline-start" aria-hidden />
            <span aria-live="polite">{copied ? "Copied" : "Copy link"}</span>
          </SubmitButton>
        </ActionDialogFooter>
      </div>
    );
  }

  const loading = state === "loading";
  return (
    <div className={ACTION_FORM}>
      <SubmitError>{state === "error" ? error : null}</SubmitError>
      <DialogNote>{note}</DialogNote>
      <ActionDialogFooter>
        <CancelButton onClick={onBack} disabled={loading}>
          Back
        </CancelButton>
        <SubmitButton type="button" pending={loading} pendingLabel="Creating link…" onClick={() => void generate()}>
          {state === "error" ? "Try again" : "Create link"}
        </SubmitButton>
      </ActionDialogFooter>
    </div>
  );
}

// The reminder form, the same for the closer and the admin.
const reminderSchema = z.object({
  contactMethod: z.enum(["call", "text"]),
  reminderDate: z.string().min(1, "Date is required"),
  reminderTime: z.string().min(1, "Time is required"),
  note: z.string().optional(),
});
type ReminderFormValues = z.infer<typeof reminderSchema>;

function ReminderStep({
  createReminder,
  onPendingChange,
  onBack,
  onDone,
}: {
  createReminder: (reminder: NewReminder) => Promise<void>;
  onPendingChange: (pending: boolean) => void;
  onBack: () => void;
  /** Closes the dialog once the reminder is set. */
  onDone: () => void;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm({
    resolver: standardSchemaResolver(reminderSchema),
    defaultValues: {
      contactMethod: "call" as const,
      reminderDate: "",
      reminderTime: "",
      note: "",
    },
  });
  const { errors } = form.formState;

  const onSubmit = async (values: ReminderFormValues) => {
    setIsSubmitting(true);
    onPendingChange(true);
    setSubmitError(null);
    try {
      const reminderScheduledAt = new Date(`${values.reminderDate}T${values.reminderTime}`).getTime();

      // eslint-disable-next-line react-hooks/purity -- runs on submit; the compiler can't see past form.handleSubmit
      if (isNaN(reminderScheduledAt) || reminderScheduledAt <= Date.now()) {
        setSubmitError("Reminder time must be in the future.");
        return;
      }

      await createReminder({
        contactMethod: values.contactMethod,
        reminderScheduledAt,
        reminderNote: values.note || undefined,
      });
      onDone();
    } catch (err: unknown) {
      setSubmitError(getErrorMessage(err, "Failed to create reminder."));
    } finally {
      setIsSubmitting(false);
      onPendingChange(false);
    }
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className={ACTION_FORM} noValidate>
      <SubmitError>{submitError}</SubmitError>
      <FormRows>
        <Controller
          control={form.control}
          name="contactMethod"
          render={({ field, fieldState }) => (
            <ReachByRow value={field.value} onChange={field.onChange} disabled={isSubmitting} error={fieldState.error} />
          )}
        />
        <WhenRow
          date={form.register("reminderDate")}
          time={form.register("reminderTime")}
          min={new Date().toISOString().split("T")[0]}
          disabled={isSubmitting}
          dateError={errors.reminderDate}
          timeError={errors.reminderTime}
        />
        <NoteRow
          label="Note (optional)"
          placeholder="e.g., Ask about scheduling availability…"
          rows={3}
          disabled={isSubmitting}
          error={errors.note}
          field={form.register("note")}
        />
      </FormRows>
      <ActionDialogFooter>
        <CancelButton onClick={onBack} disabled={isSubmitting}>
          Back
        </CancelButton>
        <SubmitButton pending={isSubmitting} pendingLabel="Creating…">
          Set reminder
        </SubmitButton>
      </ActionDialogFooter>
    </form>
  );
}

