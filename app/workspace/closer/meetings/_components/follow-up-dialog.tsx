"use client";
import { DayDefinition } from "@/app/workspace/_components/day-definition";

import { useState } from "react";
import { useMutation } from "convex/react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  CalendarPlusIcon,
  LinkIcon,
  BellIcon,
  ArrowLeftIcon,
  AlertCircleIcon,
  CopyIcon,
  CheckIcon,
  PhoneIcon,
  MessageSquareIcon,
} from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";
import { getErrorMessage } from "@/lib/errors";

type FollowUpDialogProps = {
  opportunityId: Id<"opportunities">;
  meetingId?: Id<"meetings">;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSuccess?: () => Promise<void>;
  /** Named in the dialog so the closer knows whose deal moves. */
  leadName?: string | null;
};

type DialogPath = "selection" | "scheduling_link" | "manual_reminder";

/**
 * Follow-Up Dialog (Phase 3)
 *
 * Two-path selection dialog:
 * - Path 1 (Send Scheduling Link): generates a URL from the closer's personal Calendly event type with UTM params
 * - Path 2 (Set a Reminder): creates an in-app reminder record
 *
 * After selecting a path, the dialog shows the appropriate form. A back button returns to selection.
 * Dialog resets to selection when closed and reopened.
 */
export function FollowUpDialog({
  opportunityId,
  meetingId,
  open: controlledOpen,
  onOpenChange,
  onSuccess,
  compact,
  leadName,
}: FollowUpDialogProps & { compact?: boolean }) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [path, setPath] = useState<DialogPath>("selection");
  // A scheduling link was generated and the deal hasn't moved to Follow-up yet.
  const [pendingFollowUpId, setPendingFollowUpId] =
    useState<Id<"followUps"> | null>(null);
  const linkPending = pendingFollowUpId !== null;
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const open = controlledOpen ?? internalOpen;

  const confirmFollowUp = useMutation(
    api.closer.followUpMutations.confirmFollowUpScheduled
  );

  const setOpen = (value: boolean) => {
    if (controlledOpen === undefined) {
      setInternalOpen(value);
    }
    onOpenChange?.(value);
    if (!value) {
      setPendingFollowUpId(null);
      setConfirmError(null);
      setTimeout(() => setPath("selection"), 200);
    }
  };

  // Moves the deal to Follow-up for the generated link, then closes. When it
  // fails, the dialog stays open with the error and a retry.
  const confirmAndClose = async () => {
    setConfirming(true);
    setConfirmError(null);
    try {
      await confirmFollowUp({
        opportunityId,
        meetingId,
        followUpId: pendingFollowUpId ?? undefined,
      });
    } catch (err: unknown) {
      console.error("[FollowUpDialog] confirmFollowUpScheduled failed", err);
      setConfirmError(
        getErrorMessage(err, "The link was generated, but the deal didn't move to Follow-up.")
      );
      setConfirming(false);
      return;
    }
    // The deal moved. A failing refresh afterwards isn't a failed confirm.
    try {
      await onSuccess?.();
    } catch (err: unknown) {
      console.error("[FollowUpDialog] refresh after confirm failed", err);
    }
    setConfirming(false);
    setOpen(false);
  };

  const handleOpenChange = (value: boolean) => {
    if (!value && confirming) {
      return;
    }
    // Closing after Generate counts as Done, so a link never stays pending on
    // a deal that didn't move. Once a confirm has failed, closing is allowed:
    // the meeting page shows the unfinished follow-up with its own retry.
    if (!value && linkPending && confirmError === null) {
      void confirmAndClose();
      return;
    }
    setOpen(value);
  };

  const handleClose = () => {
    handleOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
    >
      {controlledOpen === undefined ? (
        <DialogTrigger asChild>
          <Button variant="outline" size={compact ? "sm" : "lg"}>
            <CalendarPlusIcon data-icon="inline-start" />
            Schedule Follow-up
          </Button>
        </DialogTrigger>
      ) : null}
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {path === "selection" && "Schedule Follow-up"}
            {path === "scheduling_link" && "Send Scheduling Link"}
            {path === "manual_reminder" && "Set a Reminder"}
          </DialogTitle>
          {path === "selection" ? (
            <DialogDescription>
              {meetingId
                ? `The call is marked held and ${leadName ? `${leadName}\u2019s` : "the"} deal moves to Follow-up.`
                : `${leadName ? `${leadName}\u2019s` : "The"} deal moves to Follow-up.`}
            </DialogDescription>
          ) : null}
        </DialogHeader>

        {path !== "selection" && !linkPending && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPath("selection")}
            className="self-start"
          >
            <ArrowLeftIcon data-icon="inline-start" />
            Back
          </Button>
        )}

        {path === "selection" && (
          <PathSelectionCards onSelect={setPath} />
        )}

        {path === "scheduling_link" && (
          <SchedulingLinkForm
            opportunityId={opportunityId}
            onGenerated={setPendingFollowUpId}
            onDone={confirmAndClose}
            confirming={confirming}
            confirmError={confirmError}
            onClose={handleClose}
          />
        )}

        {path === "manual_reminder" && (
          <ManualReminderForm
            opportunityId={opportunityId}
            meetingId={meetingId}
            onSuccess={onSuccess}
            onClose={handleClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Path selection cards: two distinct options with keyboard accessibility
 */
function PathSelectionCards({
  onSelect,
}: {
  onSelect: (path: DialogPath) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Card
        className="cursor-pointer transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        onClick={() => onSelect("scheduling_link")}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect("scheduling_link");
          }
        }}
      >
        <CardHeader className="pb-2">
          <LinkIcon className="size-8 text-primary-ink" />
          <CardTitle className="text-base">Send Link</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Generate a scheduling link for the lead to book their next
            appointment.
          </p>
        </CardContent>
      </Card>

      <Card
        className="cursor-pointer transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        onClick={() => onSelect("manual_reminder")}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect("manual_reminder");
          }
        }}
      >
        <CardHeader className="pb-2">
          <BellIcon className="size-8 text-primary-ink" />
          <CardTitle className="text-base">Set Reminder</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Set a reminder to call or text the lead at a specific time.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Scheduling link form: generates a link from the closer's personal event type.
 *
 * The flow is split into two steps to avoid a Convex reactivity race condition:
 * 1. Generate: creates the follow-up record + link (does NOT move the deal)
 * 2. Done: moves the deal to Follow-up + closes the dialog
 *
 * If we moved the deal in step 1, Convex would push the new stage to the
 * client immediately, and the no-show bar (or the admin's bar) would unmount
 * this dialog before the user could see or copy the link. Closing the dialog
 * after step 1 runs step 2 too (`FollowUpDialog`), so the deal never keeps a
 * pending link without moving.
 */
function SchedulingLinkForm({
  opportunityId,
  onGenerated,
  onDone,
  confirming,
  confirmError,
  onClose,
}: {
  opportunityId: Id<"opportunities">;
  onGenerated: (followUpId: Id<"followUps">) => void;
  onDone: () => Promise<void>;
  confirming: boolean;
  confirmError: string | null;
  onClose: () => void;
}) {
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">(
    "idle"
  );
  const [schedulingLinkUrl, setSchedulingLinkUrl] = useState<string | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const createFollowUp = useMutation(
    api.closer.followUpMutations.createSchedulingLinkFollowUp
  );

  const handleGenerate = async () => {
    setState("loading");
    setError(null);
    try {
      const result = await createFollowUp({ opportunityId });
      setSchedulingLinkUrl(result.schedulingLinkUrl);
      onGenerated(result.followUpId);
      posthog.capture("follow_up_scheduling_link_created", {
        opportunity_id: opportunityId,
      });
      setState("success");
    } catch (err: unknown) {
      const message =
        getErrorMessage(err, "Failed to create scheduling link.");
      setError(message);
      setState("error");
    }
  };

  const handleCopy = async () => {
    if (schedulingLinkUrl) {
      await navigator.clipboard.writeText(schedulingLinkUrl);
      setCopied(true);
      toast.success("Scheduling link copied to clipboard");
      posthog.capture("follow_up_link_copied", {
        opportunity_id: opportunityId,
      });
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (state === "idle") {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Generate a personal scheduling link for this lead. Copy and share it
          via WhatsApp, SMS, or email.
        </p>
        <Button onClick={handleGenerate} className="w-full">
          <LinkIcon data-icon="inline-start" />
          Generate Scheduling Link
        </Button>
      </div>
    );
  }

  if (state === "loading") {
    return (
      <div className="flex flex-col items-center gap-3 py-4">
        <Spinner className="size-6" />
        <p className="text-sm text-muted-foreground">
          Creating scheduling link…
        </p>
      </div>
    );
  }

  if (state === "success" && schedulingLinkUrl) {
    return (
      <div className="flex flex-col gap-4">
        {confirmError ? (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertDescription>{confirmError}</AlertDescription>
          </Alert>
        ) : (
          <Alert>
            <CheckIcon />
            <AlertDescription>
              Scheduling link generated. Copy and send to the lead.
            </AlertDescription>
          </Alert>
        )}
        <InputGroup>
          <InputGroupInput
            value={schedulingLinkUrl}
            readOnly
            className="font-mono text-xs"
            aria-label="Scheduling link"
          />
          <InputGroupAddon align="inline-end">
            <Button
              onClick={handleCopy}
              variant="ghost"
              size="sm"
              disabled={confirming}
              aria-label={
                copied ? "Link copied to clipboard" : "Copy scheduling link"
              }
            >
              <CopyIcon data-icon="inline-start" />
              {copied ? "Copied" : "Copy"}
            </Button>
          </InputGroupAddon>
        </InputGroup>
        <Button variant="outline" onClick={() => void onDone()} disabled={confirming}>
          {confirming ? (
            <>
              <Spinner data-icon="inline-start" />
              Saving…
            </>
          ) : confirmError ? (
            "Try Again"
          ) : (
            "Done"
          )}
        </Button>
      </div>
    );
  }

  // Error state
  return (
    <div className="flex flex-col gap-4">
      <Alert variant="destructive">
        <AlertCircleIcon />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={() => setState("idle")}
          className="flex-1"
        >
          Try Again
        </Button>
        <Button variant="ghost" onClick={onClose} className="flex-1">
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Manual reminder form: RHF + Zod for creating in-app reminders
 */
const reminderSchema = z.object({
  contactMethod: z.enum(["call", "text"]),
  reminderDate: z.string().min(1, "Date is required"),
  reminderTime: z.string().min(1, "Time is required"),
  note: z.string().optional(),
});
type ReminderFormValues = z.infer<typeof reminderSchema>;

function ManualReminderForm({
  opportunityId,
  meetingId,
  onSuccess,
  onClose,
}: {
  opportunityId: Id<"opportunities">;
  meetingId?: Id<"meetings">;
  onSuccess?: () => Promise<void>;
  onClose: () => void;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const createReminder = useMutation(
    api.closer.followUpMutations.createManualReminderFollowUpPublic
  );

  const form = useForm({
    resolver: standardSchemaResolver(reminderSchema),
    defaultValues: {
      contactMethod: "call" as const,
      reminderDate: "",
      reminderTime: "",
      note: "",
    },
  });

  const onSubmit = async (values: ReminderFormValues) => {
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      // Combine date + time into Unix ms
      const reminderScheduledAt = new Date(
        `${values.reminderDate}T${values.reminderTime}`
      ).getTime();

      // eslint-disable-next-line react-hooks/purity -- runs on submit; the compiler can't see past form.handleSubmit
      if (isNaN(reminderScheduledAt) || reminderScheduledAt <= Date.now()) {
        setSubmitError("Reminder time must be in the future.");
        setIsSubmitting(false);
        return;
      }

      await createReminder({
        opportunityId,
        meetingId,
        contactMethod: values.contactMethod,
        reminderScheduledAt,
        reminderNote: values.note || undefined,
      });

      await onSuccess?.();
      posthog.capture("follow_up_reminder_created", {
        opportunity_id: opportunityId,
        meeting_id: meetingId ?? null,
        contact_method: values.contactMethod,
      });
      toast.success("Reminder created");
      onClose();
    } catch (err: unknown) {
      setSubmitError(
        getErrorMessage(err, "Failed to create reminder.")
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
        <FormField
          control={form.control}
          name="contactMethod"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Contact Method <span className="text-destructive">*</span>
              </FormLabel>
              <FormControl>
                <ToggleGroup
                  type="single"
                  value={field.value}
                  onValueChange={(value) => {
                    if (value) field.onChange(value);
                  }}
                  className="justify-start"
                >
                  <ToggleGroupItem value="call" aria-label="Call">
                    <PhoneIcon data-icon="inline-start" />
                    Call
                  </ToggleGroupItem>
                  <ToggleGroupItem value="text" aria-label="Text">
                    <MessageSquareIcon data-icon="inline-start" />
                    Text
                  </ToggleGroupItem>
                </ToggleGroup>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-3">
          <FormField
            control={form.control}
            name="reminderDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Date <span className="text-destructive">*</span>
                </FormLabel>
                <FormControl>
                  <Input
                    type="date"
                    {...field}
                    min={new Date().toISOString().split("T")[0]}
                    disabled={isSubmitting}
                  />
                </FormControl>
 <DayDefinition browser />
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="reminderTime"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Time <span className="text-destructive">*</span>
                </FormLabel>
                <FormControl>
                  <Input type="time" {...field} disabled={isSubmitting} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="note"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Note (optional)</FormLabel>
              <FormControl>
                <Textarea
                  {...field}
                  placeholder="e.g., Ask about scheduling availability…"
                  rows={3}
                  disabled={isSubmitting}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {submitError && (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" disabled={isSubmitting} className="w-full">
          {isSubmitting && <Spinner data-icon="inline-start" />}
          {isSubmitting ? "Creating…" : "Set Reminder"}
        </Button>
      </form>
    </Form>
  );
}
